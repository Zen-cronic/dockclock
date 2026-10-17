import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Channel } from "@dockclock/evidence";
import type { LoadState, PinRecord, Step } from "./lifecycle.js";
import type { Language } from "./messages.js";
import { env } from "./config.js";
import { keys } from "./keys.js";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export type Address = { kind: "bsuid"; id: string } | { kind: "phone"; e164: string };

export interface LoadItem extends LoadState {
  pk: string;
  sk: string;
  clauseId: string;
  facilityId: string;
  appointmentAt: string;
  driverKey: string;
  address: Address;
  channel: Channel;
  language: Language;
  tokens: Partial<Record<Step, string>>;
  executionArn?: string;
  createdAt?: string;
}

export interface DriverItem {
  loadId: string;
  address: Address;
}

export async function getLoad(loadId: string): Promise<LoadItem | null> {
  const out = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.load(loadId), ConsistentRead: true }));
  return (out.Item as LoadItem | undefined) ?? null;
}

export async function getActiveLoadId(driverKey: string): Promise<string | null> {
  const out = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.driver(driverKey), ConsistentRead: true }));
  return (out.Item as DriverItem | undefined)?.loadId ?? null;
}

export interface DriverRecord extends DriverItem {
  key: string;
  dispatchedAt?: string;
  boundFrom?: string;
}

async function driverRecords(candidateKeys: string[]): Promise<DriverRecord[]> {
  const out: DriverRecord[] = [];
  for (const key of candidateKeys) {
    const got = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.driver(key), ConsistentRead: true }));
    const item = got.Item as (DriverItem & { dispatchedAt?: string; boundFrom?: string }) | undefined;
    if (item?.loadId) out.push({ ...item, key });
  }
  return out;
}

// Points the sender's primary key (their BSUID) at a load, so payload-less messages such as a
// location pin route to it. Written only when it would change something.
export async function bindPrimary(candidateKeys: string[], loadId: string, dispatchedFrom: string, address: Address, dispatchedAt: string): Promise<boolean> {
  const primary = candidateKeys[0];
  if (!primary || primary === dispatchedFrom) return false;
  const [current] = await driverRecords([primary]);
  if (current?.loadId === loadId) return false;
  await ddb.send(
    new PutCommand({
      TableName: env.table(),
      Item: { ...keys.driver(primary), loadId, address, dispatchedAt, boundFrom: dispatchedFrom, boundAt: new Date().toISOString() },
    }),
  );
  return true;
}

// The load a payload-less message belongs to: the most recently dispatched load across every key
// the sender is known by (their BSUID and the phone number Meta sent with it).
export async function resolveActiveLoad(candidateKeys: string[]): Promise<{ loadId: string; key: string } | null> {
  const records = await driverRecords(candidateKeys);
  const latest = records.sort((a, b) => (b.dispatchedAt ?? "").localeCompare(a.dispatchedAt ?? ""))[0];
  return latest ? { loadId: latest.loadId, key: latest.key } : null;
}

// A button or Flow names its load; the sender must be the driver it was dispatched to, either by
// the same key or through a BSUID previously bound from that key.
export async function ownsLoad(candidateKeys: string[], load: Pick<LoadItem, "driverKey">): Promise<boolean> {
  if (candidateKeys.includes(load.driverKey)) return true;
  const records = await driverRecords(candidateKeys);
  return records.some((r) => r.boundFrom === load.driverKey);
}

export function toState(item: LoadItem): LoadState {
  return { loadId: item.loadId, nonce: item.nonce, phase: item.phase, version: item.version, arrived: item.arrived, released: item.released, bol: item.bol ?? null };
}

export type { PinRecord };
