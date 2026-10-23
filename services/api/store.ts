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

// BatchGetItem may return part of a batch as UnprocessedKeys (throttling, the 16 MB limit). They
// are retried with bounded backoff; keys still unread after that fail the request (500) rather
// than show a sent message without its receipt.
export const RECEIPT_RETRIES = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Delivery receipts (MSG#<id>) of the load's accepted sends.
export async function receiptsFor(items: Item[], wait: (ms: number) => Promise<unknown> = sleep): Promise<Record<string, Item>> {
  const ids = [...new Set(items.filter((i) => String(i.sk).startsWith("SEND#") && i.status !== "not_sent").map((i) => String(i.messageId)))];
  const out: Record<string, Item> = {};
  const table = env("TABLE_NAME");
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Array<Record<string, unknown>> = ids.slice(i, i + 100).map((id) => ({ pk: `MSG#${id}`, sk: "RECEIPT" }));
    for (let attempt = 0; keys.length > 0; attempt++) {
      if (attempt > RECEIPT_RETRIES) throw new Error(`${keys.length} receipts unread after ${RECEIPT_RETRIES} retries`);
      if (attempt > 0) await wait(Math.min(1000, 50 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2));
      const got = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
      for (const item of (got.Responses?.[table] ?? []) as Item[]) out[String(item.pk).slice(4)] = item;
      keys = (got.UnprocessedKeys?.[table]?.Keys ?? []) as Array<Record<string, unknown>>;
    }
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
  // Never a photo the evidence path refused: it has no hash.
  if (!meta || !photo || !str(photo.sha256)) return null;
  const loadId = String(meta.loadId);
  const key = str(photo.s3Key);
  if (key && (key.startsWith(`media/${loadId}/`) || key.startsWith("rcs-inbound/rcs/"))) {
    const original = await object(env("MEDIA_BUCKET"), key, range);
    if (original) return original;
  }
  const sealedCopy = `packs/${loadId}/bol-${page}-${str(photo.sha256)?.slice(0, 12) ?? "unhashed"}`;
  return object(env("EVIDENCE_BUCKET"), sealedCopy, range);
}

// Runs `work` over `inputs` with at most `limit` in flight, keeping the input order.
export async function mapLimit<T, R>(inputs: T[], limit: number, work: (input: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(inputs.length);
  let next = 0;
  const lane = async () => {
    while (next < inputs.length) {
      const i = next++;
      out[i] = await work(inputs[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, lane));
  return out;
}

// Everything buildLoadView needs. `light` skips the object reads (pack, emails, photos), for lists
// and feeds that only need the records; `only` reads just what one route needs.
export async function sourcesFor(items: Item[], options: { light?: boolean; only?: "pack" | "emails"; now: string; spkiSha256: string }): Promise<LoadSources> {
  const meta = items.find((i) => i.sk === "META")!;
  const receipts = await receiptsFor(items);
  if (options.light) return { items, receipts, signedPack: null, emails: {}, photoTypes: {}, spkiSha256: options.spkiSha256, now: options.now };
  const bucket = env("EVIDENCE_BUCKET");
  const want = (part: "pack" | "emails" | "photos") => !options.only || options.only === part;
  const packItem = str(meta.sealedPackId) ? items.find((i) => i.sk === `PACK#${String(meta.sealedPackId)}`) : undefined;
  const photos = Array.isArray(obj(meta.bol).photos) ? (obj(meta.bol).photos as unknown[]) : [];
  const [packText, notice, claim, heads] = await Promise.all([
    want("pack") ? text(bucket, packItem?.s3Key) : undefined,
    want("emails") ? text(bucket, obj(meta.notice).mimeKey) : undefined,
    want("emails") ? text(bucket, items.find((i) => i.sk === "CLAIM")?.mimeKey) : undefined,
    want("photos") ? Promise.all(photos.map((_, i) => photoBytes(items, i + 1, "bytes=0-15"))) : [],
  ]);
  const photoTypes: LoadSources["photoTypes"] = {};
  heads.forEach((head, i) => (photoTypes[i + 1] = head ? sniffImage(head) : null));
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
