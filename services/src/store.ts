import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Channel } from "@dockclock/evidence";
import type { LoadState, PinRecord, Step } from "./lifecycle.js";
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
  tokens: Partial<Record<Step, string>>;
  executionArn?: string;
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

export function toState(item: LoadItem): LoadState {
  return { loadId: item.loadId, phase: item.phase, version: item.version, arrived: item.arrived, released: item.released };
}

export type { PinRecord };
