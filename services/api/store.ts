// The read API's only access to AWS: read-only queries on the load table and its byWorkspace index,
// and object reads of packs, kept emails and driver photos. Nothing here writes.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { BatchGetCommand, DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { SignedPack } from "@dockclock/evidence";
import { sniffImage } from "@dockclock/sanitize";
import type { LoadSources } from "./view.js";
import { obj, str, type Item } from "./describe.js";

export const WORKSPACE = "demo";
export const WORKSPACE_INDEX = "byWorkspace";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ maxAttempts: 3 }));
const s3 = new S3Client({ maxAttempts: 3 });

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing env ${name}`);
  return value;
}

// Demo-workspace loads, newest first, one page at a time.
export async function listWorkspace(limit: number, cursor: Record<string, unknown> | null): Promise<{ metas: Item[]; next: Record<string, unknown> | null }> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: env("TABLE_NAME"),
      IndexName: WORKSPACE_INDEX,
      KeyConditionExpression: "ws = :w",
      ExpressionAttributeValues: { ":w": WORKSPACE },
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }),
  );
  return { metas: (out.Items ?? []) as Item[], next: (out.LastEvaluatedKey as Record<string, unknown> | undefined) ?? null };
}

// Every item of one load, or null when the load does not exist or is not in the demo workspace.
export async function partition(loadId: string): Promise<Item[] | null> {
  const items: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({ TableName: env("TABLE_NAME"), KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": `LOAD#${loadId}` }, ExclusiveStartKey: start }),
    );
    items.push(...((page.Items ?? []) as Item[]));
    start = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start);
  const meta = items.find((i) => i.sk === "META");
  return meta && meta.ws === WORKSPACE ? items : null;
}

// Delivery receipts (MSG#<id>) of the load's accepted sends.
export async function receiptsFor(items: Item[]): Promise<Record<string, Item>> {
  const ids = [...new Set(items.filter((i) => String(i.sk).startsWith("SEND#") && i.status !== "not_sent").map((i) => String(i.messageId)))];
  const out: Record<string, Item> = {};
  for (let i = 0; i < ids.length; i += 100) {
    const keys = ids.slice(i, i + 100).map((id) => ({ pk: `MSG#${id}`, sk: "RECEIPT" }));
    const got = await ddb.send(new BatchGetCommand({ RequestItems: { [env("TABLE_NAME")]: { Keys: keys } } }));
    for (const item of (got.Responses?.[env("TABLE_NAME")] ?? []) as Item[]) out[String(item.pk).slice(4)] = item;
  }
  return out;
}

async function object(bucket: string, key: string, range?: string): Promise<Uint8Array | null> {
  try {
    const got = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, ...(range ? { Range: range } : {}) }));
    return await got.Body!.transformToByteArray();
  } catch (error) {
    if (error instanceof NoSuchKey || (error as Error).name === "NoSuchKey" || (error as Error).name === "AccessDenied") return null;
    throw error;
  }
}

const text = async (bucket: string, key: unknown): Promise<string | undefined> => {
  if (typeof key !== "string" || !key.startsWith("packs/")) return undefined;
  const bytes = await object(bucket, key);
  return bytes ? Buffer.from(bytes).toString("utf8") : undefined;
};

// A driver photo's original bytes: the media bucket copy while it lasts (90 days), then the copy
// sealing put under the evidence lock. Only keys under the load's own media prefixes are read.
export async function photoBytes(items: Item[], page: number, range?: string): Promise<Uint8Array | null> {
  const meta = items.find((i) => i.sk === "META");
  const bol = obj(meta?.bol);
  const photos = Array.isArray(bol.photos) ? bol.photos.map(obj) : [];
  const photo = photos[page - 1];
  if (!meta || !photo) return null;
  const loadId = String(meta.loadId);
  const key = str(photo.s3Key);
  if (key && (key.startsWith(`media/${loadId}/`) || key.startsWith("rcs-inbound/rcs/"))) {
    const original = await object(env("MEDIA_BUCKET"), key, range);
    if (original) return original;
  }
  const sealedCopy = `packs/${loadId}/bol-${page}-${str(photo.sha256)?.slice(0, 12) ?? "unhashed"}`;
  return object(env("EVIDENCE_BUCKET"), sealedCopy, range);
}

// Everything buildLoadView needs. `light` skips the object reads (pack, emails, photos), for lists
// and feeds that only need the records.
export async function sourcesFor(items: Item[], options: { light?: boolean; now: string; spkiSha256: string }): Promise<LoadSources> {
  const meta = items.find((i) => i.sk === "META")!;
  const receipts = await receiptsFor(items);
  if (options.light) return { items, receipts, signedPack: null, emails: {}, photoTypes: {}, spkiSha256: options.spkiSha256, now: options.now };
  const bucket = env("EVIDENCE_BUCKET");
  const packItem = str(meta.sealedPackId) ? items.find((i) => i.sk === `PACK#${String(meta.sealedPackId)}`) : undefined;
  const packText = await text(bucket, packItem?.s3Key);
  const notice = await text(bucket, obj(meta.notice).mimeKey);
  const claim = await text(bucket, items.find((i) => i.sk === "CLAIM")?.mimeKey);
  const photos = Array.isArray(obj(meta.bol).photos) ? (obj(meta.bol).photos as unknown[]) : [];
  const photoTypes: LoadSources["photoTypes"] = {};
  for (let page = 1; page <= photos.length; page++) {
    const head = await photoBytes(items, page, "bytes=0-15");
    photoTypes[page] = head ? sniffImage(head) : null;
  }
  return {
    items,
    receipts,
    signedPack: packText ? (JSON.parse(packText) as SignedPack) : null,
    emails: { ...(notice ? { notice } : {}), ...(claim ? { claim } : {}) },
    photoTypes,
    spkiSha256: options.spkiSha256,
    now: options.now,
  };
}
