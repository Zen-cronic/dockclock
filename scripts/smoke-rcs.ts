// Live smoke test for the RCS lane, at no messaging cost: dispatches a SMOKE- load on RCS to a 555
// test number (every send is blocked by the allowlist), feeds synthetic RCS notifications and a
// synthetic WhatsApp failure straight into the ingest queue (never the shared topics), then checks
// the failover ran once and the sealed pack records an RCS photo BOL honestly.
//
// Options (environment):
//   SMOKE_RCS_CLAUSE=freightline-digital  a clause that accepts app GPS records, so an RCS load can be
//                                         BILLABLE (then npm run approve:load and agent:run file it)
//   SMOKE_RCS_PHOTO=data/bol-photos/signed-24h.jpg  reply with this image (a rendered fictional bill
//                                         of lading from npm run bol:photos) instead of stand-in bytes;
//                                         an unreadable one (blurry.jpg) leaves the load waiting for a
//                                         retake, which the run reports and does not wait for
//   SMOKE_RCS_START=whatsapp              dispatch on WhatsApp and fail that dispatch, so the whole
//                                         load fails over to RCS (the WhatsApp to RCS case)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { KmsSigner, verifyPack, type SignedPack } from "@dockclock/evidence";
import { renderWhatsApp } from "../services/src/outbound.js";
import { dispatchTemplate } from "../services/src/sender.js";

const outputs = JSON.parse(readFileSync(new URL("../.cdk-outputs.json", import.meta.url), "utf8")).DockClockMessaging as Record<string, string>;
const out = (key: string) => {
  const value = outputs[key];
  if (!value) throw new Error(`missing output ${key}`);
  return value;
};
const env = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`missing env ${key}`);
  return value;
};

const lambda = new LambdaClient({});
const sqs = new SQSClient({});
const sfn = new SFNClient({});
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const loadId = `SMOKE-RCS-${Date.now().toString(36)}`;
const clauseId = process.env.SMOKE_RCS_CLAUSE ?? "lakeshore-foods";
const photoPath = process.env.SMOKE_RCS_PHOTO;
const startOnWhatsApp = process.env.SMOKE_RCS_START === "whatsapp";
const phone = "15550100998";
const now = Date.now();
const agentId = env("DOCKCLOCK_RCS_AGENT_ID");
let seq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The documented inbound shape; SNS's Timestamp is the event's server time.
function rcs(messageBody: string, atMs: number, id = `smoke-${loadId}-${++seq}`) {
  return JSON.stringify({
    Type: "Notification",
    TopicArn: out("RcsTopicArn"),
    Timestamp: new Date(atMs).toISOString(),
    Message: JSON.stringify({ originationNumber: phone, destinationNumber: agentId, messageBody, inboundMessageId: id }),
  });
}

function whatsappFailed(eumMessageId: string, atMs: number) {
  const entry = {
    id: env("DOCKCLOCK_META_WABA_ID"),
    changes: [{ field: "messages", value: { metadata: { phone_number_id: env("DOCKCLOCK_META_PHONE_ID") }, statuses: [{ id: `wamid.${eumMessageId}`, status: "failed", timestamp: String(Math.floor(atMs / 1000)), errors: [{ code: 131026 }] }] } }],
  };
  return JSON.stringify({
    Type: "Notification",
    TopicArn: env("DOCKCLOCK_WHATSAPP_TOPIC_ARN"),
    Message: JSON.stringify({ aws_account_id: env("DOCKCLOCK_ACCOUNT"), messageId: eumMessageId, whatsAppWebhookEntry: JSON.stringify(entry), synthetic: true }),
  });
}

async function feed(label: string, body: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: out("IngestQueueUrl"), MessageBody: body }));
  console.log(`  sent ${label}`);
  await sleep(2500);
}

const dispatched = await lambda.send(
  new InvokeCommand({
    FunctionName: out("DispatchFunction"),
    Payload: Buffer.from(
      JSON.stringify({
        loadId,
        clauseId,
        facilityId: "lakeshore-columbus",
        appointmentAt: new Date(now - 4 * 3600_000).toISOString(),
        channel: startOnWhatsApp ? "whatsapp" : "rcs",
        language: "en_US",
        address: { kind: "phone", e164: `+${phone}` },
        optIn: { method: "smoke_test_fixture", at: new Date(now).toISOString() },
        synthetic: true,
      }),
    ),
  }),
);
if (dispatched.FunctionError) throw new Error(`dispatch failed: ${Buffer.from(dispatched.Payload ?? []).toString()}`);
const { executionArn } = JSON.parse(Buffer.from(dispatched.Payload ?? []).toString()) as { executionArn: string };
console.log(`dispatched ${loadId} on ${startOnWhatsApp ? "WhatsApp (to fail over)" : "RCS"} (${clauseId})`);
const table = out("TableName");
const meta = (await ddb.send(new GetCommand({ TableName: table, Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
const nonce = String(meta?.nonce);
const tap = (action: string) => JSON.stringify({ type: "SUGGESTION", text: action, postbackData: `dc1.${action}.${loadId}.${nonce}` });
const pin = JSON.stringify({ type: "LOCATION", latitude: 39.8995, longitude: -82.938 });

// A stand-in for a photo End User Messaging stored, under the prefix the agent is configured with.
const photoKey = `${out("RcsMediaPrefix")}/rcs/smoke-${loadId}#bol.jpg`;
const photoBytes = photoPath ? readFileSync(photoPath) : Buffer.from(`smoke bill of lading for ${loadId}`);
const media = JSON.stringify({ mediaStatus: "SUCCESS", s3Bucket: out("RcsMediaBucket"), s3Key: photoKey, mimeType: "image/jpeg", fileName: "bol.jpg", fileSizeBytes: photoBytes.length });

// A WhatsApp message this load "sent" that then failed: the failover must run exactly once. On an
// RCS load it is a Released offer; starting on WhatsApp it is the dispatch itself, recorded the way
// the sender records an accepted send (marked synthetic), so the conversation shows what failed.
const t = (minutesBeforeNow: number) => now - minutesBeforeNow * 60_000;
const failedId = `smoke-wa-${loadId}`;
const failedPurpose = startOnWhatsApp ? "dispatch_template" : "offer_release";
await ddb.send(new PutCommand({ TableName: table, Item: { pk: `MSG#${failedId}`, sk: "RECEIPT", loadId, purpose: failedPurpose, channel: "whatsapp", acceptedAt: new Date(t(251)).toISOString() } }));
if (startOnWhatsApp) {
  const sentAt = new Date(t(251)).toISOString();
  const message = renderWhatsApp(dispatchTemplate("en_US", loadId, nonce, "Lakeshore DC, Columbus OH", "the appointment"));
  await ddb.send(new PutCommand({ TableName: table, Item: { pk: `LOAD#${loadId}`, sk: `SEND#${sentAt}#${failedId}`, kind: "send", messageId: failedId, channel: "whatsapp", purpose: failedPurpose, audience: "driver", sentAt, message, synthetic: true } }));
  await feed("WhatsApp failure of the dispatch template", whatsappFailed(failedId, t(250)));
}

const arrivedId = `smoke-${loadId}-arrived`;
await feed("Arrived (suggested reply)", rcs(tap("arrived"), t(248), arrivedId));
await feed("Arrived again, same inbound id (redelivery)", rcs(tap("arrived"), t(248), arrivedId));
await feed("typing notice (ignored)", rcs(JSON.stringify({ type: "RCS_TYPING", receivedAt: new Date(t(247)).toISOString() }), t(247), `smoke-${loadId}-typing`));
await feed("arrival pin", rcs(pin, t(247)));
if (!startOnWhatsApp) await feed("WhatsApp failure of the Released offer", whatsappFailed(failedId, t(246)));
await feed("the same failure reported again", whatsappFailed(failedId, startOnWhatsApp ? t(250) : t(246)));
await feed("Released (suggested reply)", rcs(tap("released"), t(30)));
await feed("release pin", rcs(pin, t(29)));
// The ingest guard accepts a stored RCS photo only if it was written with its message, so the
// object goes up just before the reply, and the reply carries the time it is sent.
await s3.send(new PutObjectCommand({ Bucket: out("RcsMediaBucket"), Key: photoKey, Body: photoBytes, ContentType: "image/jpeg" }));
await feed("BOL photo reply", rcs(media, Date.now()));

let status = "RUNNING";
for (let i = 0; i < 45 && status === "RUNNING"; i++) {
  status = (await sfn.send(new DescribeExecutionCommand({ executionArn }))).status ?? "UNKNOWN";
  if (status === "RUNNING") await sleep(2000);
}
console.log(`execution ${status}`);

const items =
  (await ddb.send(new QueryCommand({ TableName: table, KeyConditionExpression: "pk = :pk AND begins_with(sk, :e)", ExpressionAttributeValues: { ":pk": `LOAD#${loadId}`, ":e": "EVENT#" } }))).Items ?? [];
console.log("timeline:");
for (const item of items) console.log(`  ${item.serverAt}  ${String(item.channel).padEnd(8)} ${String(item.type).padEnd(8)} ${String(item.outcome).padEnd(24)} ${item.phaseBefore} -> ${item.phaseAfter}`);

const load = (await ddb.send(new GetCommand({ TableName: table, Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
// An unreadable photo makes the workflow ask once for a clearer one and wait (an hour on a test load).
if (status === "RUNNING" && load?.retakeOf) {
  console.log(`load ${loadId} is waiting for a clearer photo (retake requested ${String(load.retakeRequestedAt)}; the first photo seals at ${String(load.retakeUntil)})`);
  console.log("RCS SMOKE PASS (retake pending)");
  process.exit(0);
}
if (!load?.sealedPackId) throw new Error("load was not sealed");
const key = `packs/${loadId}/${load.sealedPackId}.json`;
const signed = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: out("EvidenceBucket"), Key: key }))).Body!.transformToString()) as SignedPack;
const publicKey = await new KmsSigner(out("EvidenceKeyArn")).publicKeyDer();
const receipt = (await ddb.send(new GetCommand({ TableName: table, Key: { pk: `MSG#${failedId}`, sk: "RECEIPT" } }))).Item;
const expectedSha = createHash("sha256").update(photoBytes).digest("hex");
const failovers = items.filter((i) => i.type === "failover");
const bol = signed.pack.events.bol;

console.log(`pack ${key}`);
console.log(`  channel ${signed.pack.channel}; verdict ${signed.pack.evaluation.verdict} (${signed.pack.evaluation.reasons.join(", ") || "no reasons"}); confidence ${signed.pack.corroboration.confidence}`);
console.log(`  bol camera-only ${bol?.cameraOnly}; page hashes match the stored photo: ${bol?.pageSha256s[0] === expectedSha}`);
console.log(`  failover events ${failovers.length} (${failovers.map((f) => f.outcome).join(", ")}); receipt action ${receipt?.failoverAction}`);
console.log(`  signature verifies with KMS public key: ${verifyPack(signed, publicKey)}`);

const outcomes = items.map((i) => i.outcome);
const ok =
  status === "SUCCEEDED" &&
  verifyPack(signed, publicKey) &&
  signed.pack.channel === "rcs" &&
  outcomes.filter((o) => o === "ADVANCED").length === 5 &&
  !items.some((i) => i.messageId === `rcs.smoke-${loadId}-typing`) &&
  failovers.length === 1 &&
  receipt?.failoverAt !== undefined &&
  load.bol?.channel === "rcs" &&
  load.bol?.media === "hashed" &&
  bol?.pageSha256s[0] === expectedSha &&
  bol?.cameraOnly === false &&
  // Only a clause that accepts app GPS records can make an RCS photo load billable.
  (clauseId === "freightline-digital" ? signed.pack.evaluation.verdict === "BILLABLE" : signed.pack.evaluation.verdict !== "BILLABLE");
if (ok && signed.pack.evaluation.verdict === "BILLABLE") console.log(`to file its claim: npm run approve:load -- ${loadId} && npm run agent:run -- ${loadId} file_claim`);
console.log(ok ? "RCS SMOKE PASS" : "RCS SMOKE FAIL");
process.exit(ok ? 0 : 1);
