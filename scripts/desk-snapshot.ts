// Writes the judge desk's replay of one load: npm run desk:snapshot -- <loadId>
// Reads the load's partition, its signed pack, its stored emails and the receipts of its sends,
// builds site/replay/<loadId>.json (schema dockclock.replay/1) and refuses to write it if anything
// that must not be published is still in it. Read-only against AWS.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { KmsSigner, registerFacility, sha256Hex, type Facility, type SignedPack } from "@dockclock/evidence";
import { buildSnapshot, findLeaks } from "./desk/build-snapshot.js";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const loadId = process.argv[2];
if (!loadId || !/^[A-Za-z0-9-]{1,40}$/.test(loadId)) throw new Error("usage: desk:snapshot <loadId>");
// The private demo yard is registered from .env so pins can be checked against it; it is never written out.
if (process.env.DOCKCLOCK_DEMO_FACILITY) registerFacility(JSON.parse(process.env.DOCKCLOCK_DEMO_FACILITY) as Facility);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const table = outputs.TableName!;
const bucket = outputs.EvidenceBucket!;

const items: Array<Record<string, unknown>> = [];
let start: Record<string, unknown> | undefined;
do {
  const page = await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": `LOAD#${loadId}` }, ExclusiveStartKey: start, ConsistentRead: true }));
  items.push(...((page.Items ?? []) as Array<Record<string, unknown>>));
  start = page.LastEvaluatedKey;
} while (start);
const meta = items.find((i) => i.sk === "META");
if (!meta) throw new Error(`no load ${loadId}`);
if (typeof meta.sealedPackId !== "string") throw new Error(`load ${loadId} is not sealed yet`);

const text = async (key: unknown): Promise<string | undefined> => {
  if (typeof key !== "string") return undefined;
  try {
    return await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToString("utf8");
  } catch (error) {
    if (error instanceof NoSuchKey) return undefined;
    throw error;
  }
};
const packItem = items.find((i) => i.sk === `PACK#${meta.sealedPackId}`);
const signedPack = JSON.parse((await text(packItem?.s3Key))!) as SignedPack;
const receipts: Record<string, Record<string, unknown>> = {};
for (const send of items.filter((i) => String(i.sk).startsWith("SEND#"))) {
  const out = await ddb.send(new GetCommand({ TableName: table, Key: { pk: `MSG#${String(send.messageId)}`, sk: "RECEIPT" } }));
  if (out.Item) receipts[String(send.messageId)] = out.Item;
}
const notice = await text((meta.notice as { mimeKey?: string } | undefined)?.mimeKey);
const claim = await text(items.find((i) => i.sk === "CLAIM")?.mimeKey);
const spkiSha256 = sha256Hex(await new KmsSigner(signedPack.keyId).publicKeyDer());

const snapshot = buildSnapshot({ items, receipts, signedPack, emails: { ...(notice ? { notice } : {}), ...(claim ? { claim } : {}) }, spkiSha256, exportedAt: new Date().toISOString() });
const leaks = findLeaks(snapshot, process.env.DOCKCLOCK_ACCOUNT);
if (leaks.length) {
  console.error(`refusing to write: ${leaks.length} finding(s)\n  ${leaks.slice(0, 20).join("\n  ")}`);
  process.exit(1);
}
mkdirSync(new URL("../site/replay/", import.meta.url), { recursive: true });
const file = new URL(`../site/replay/${loadId}.json`, import.meta.url);
writeFileSync(file, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(`wrote site/replay/${loadId}.json: ${snapshot.messages.length} messages, ${snapshot.timeline.length} timeline events, ${snapshot.emails.length} emails, ${snapshot.agentRuns.length} agent runs; verdict ${snapshot.verdict.verdict} $${snapshot.verdict.amountUsd.toFixed(2)}`);
