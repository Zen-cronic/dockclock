import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Channel } from "@dockclock/evidence";
import type { Effect, LoadState, Step } from "./lifecycle.js";
import type { Language } from "./messages.js";
import { env } from "./config.js";
import { keys } from "./keys.js";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export type Address = { kind: "bsuid"; id: string } | { kind: "phone"; e164: string };

// A side effect committed with the state change that caused it, removed only once it has run.
export interface OutboxEntry {
  seq: string;
  effect: Effect;
}

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
  outbox?: Record<string, OutboxEntry>;
  executionArn?: string;
  createdAt?: string;
  sealedPackId?: string;
  outcome?: string;
  synthetic?: boolean;
  askDispatcher?: boolean;
  // A judge try-it load: the driver is also the dispatcher who approves the claim.
  demo?: boolean;
  notice?: NoticeItem;
  // Set when the workflow asked for a clearer photo: the message id of the unreadable one.
  retakeOf?: string;
  retakeRequestedAt?: string;
}

// The detention notice: scheduled after the Arrived pin, sent by SES before free time ends, and
// marked delivered from the SES delivery event.
export interface NoticeItem {
  scheduledFor: string;
  sentAt?: string;
  messageId?: string;
  deliveredAt?: string;
  bouncedAt?: string;
  skipped?: string;
}

// One record per key a driver is known by. The dispatched key's record is the driver's live load;
// a BSUID record bound from it follows that load so payload-less messages (pins) route correctly.
export interface DriverItem {
  loadId: string;
  address: Address;
  dispatchedAt?: string;
  boundFrom?: string;
  boundBsuid?: string;
  language?: Language;
}

export interface DriverRecord extends DriverItem {
  key: string;
}

export async function getLoad(loadId: string): Promise<LoadItem | null> {
  const out = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.load(loadId), ConsistentRead: true }));
  return (out.Item as LoadItem | undefined) ?? null;
}

export async function getDriver(key: string): Promise<DriverRecord | null> {
  const out = await ddb.send(new GetCommand({ TableName: env.table(), Key: keys.driver(key), ConsistentRead: true }));
  const item = out.Item as DriverItem | undefined;
  return item?.loadId ? { ...item, key } : null;
}

async function driverRecords(candidateKeys: string[]): Promise<DriverRecord[]> {
  const out: DriverRecord[] = [];
  for (const key of candidateKeys) {
    const record = await getDriver(key);
    if (record) out.push(record);
  }
  return out;
}

// The load a payload-less message belongs to: the most recently dispatched load across every key
// the sender is known by. Dispatch supersedes a driver's previous load, so this is their live one.
export async function resolveActiveLoad(candidateKeys: string[]): Promise<{ loadId: string; key: string } | null> {
  const records = await driverRecords(candidateKeys);
  const latest = records.sort((a, b) => (b.dispatchedAt ?? "").localeCompare(a.dispatchedAt ?? ""))[0];
  return latest ? { loadId: latest.loadId, key: latest.key } : null;
}

// A button or Flow names its load; the sender must be the driver it was dispatched to, either by
// the same key or through a BSUID bound from that key.
export async function ownsLoad(candidateKeys: string[], load: Pick<LoadItem, "driverKey">): Promise<boolean> {
  if (candidateKeys.includes(load.driverKey)) return true;
  const records = await driverRecords(candidateKeys);
  return records.some((r) => r.boundFrom === load.driverKey);
}

// Points the sender's BSUID at a load, but only the driver's live load: a tap on an older
// message never re-routes their pins. Returns true when it wrote something.
export async function bindPrimary(candidateKeys: string[], load: Pick<LoadItem, "loadId" | "driverKey">): Promise<boolean> {
  const primary = candidateKeys[0];
  if (!primary || primary === load.driverKey) return false;
  const dispatched = await getDriver(load.driverKey);
  if (!dispatched || dispatched.loadId !== load.loadId) return false;
  const current = await getDriver(primary);
  if (current?.loadId === load.loadId && current.boundFrom === load.driverKey) return false;
  await ddb.send(
    new PutCommand({
      TableName: env.table(),
      Item: {
        ...keys.driver(primary),
        loadId: load.loadId,
        address: dispatched.address,
        dispatchedAt: dispatched.dispatchedAt,
        language: dispatched.language,
        boundFrom: load.driverKey,
        boundAt: new Date().toISOString(),
      },
    }),
  );
  await ddb.send(
    new UpdateCommand({ TableName: env.table(), Key: keys.driver(load.driverKey), UpdateExpression: "SET boundBsuid = :b", ExpressionAttributeValues: { ":b": primary } }),
  );
  return true;
}

export async function setOptOut(driverKeys: string[], optedOut: boolean): Promise<void> {
  for (const key of driverKeys) {
    if (optedOut) {
      await ddb.send(new PutCommand({ TableName: env.table(), Item: { ...keys.optOut(key), at: new Date().toISOString() } }));
    } else {
      await ddb.send(new DeleteCommand({ TableName: env.table(), Key: keys.optOut(key) }));
    }
  }
}

export function toState(item: LoadItem): LoadState {
  return {
    loadId: item.loadId,
    nonce: item.nonce,
    phase: item.phase,
    version: item.version,
    arrived: item.arrived,
    released: item.released,
    bol: item.bol ?? null,
    flowSends: item.flowSends ?? 0,
  };
}
