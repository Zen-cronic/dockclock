// A real-time test load on the judge-demo clause (5 minutes free, notice before free time ends,
// $60/h, $30 cap, any location), in the demo workspace. Unlike the other smokes nothing is
// backdated: every driver message is fed at the moment it carries, so the conversation, the notice
// and the dock clock run in true order. Driver messages are synthetic and go to a 555 test number,
// so DockClock's own sends are recorded as not sent.
// Usage: npm run smoke:demo -- whatsapp|rcs [dwellMinutes=8]
//   then: npm run approve:load -- <loadId> && npm run agent:run -- <loadId> file_claim
// The RCS lane replies with a rendered fictional bill of lading (npm run bol:photos) when
// data/bol-photos/signed-24h.jpg exists; the WhatsApp lane's Flow photo cannot be downloaded from
// Meta for a synthetic message, so it records the typed, receiver-signed times without a photo.
import { existsSync, readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { isoToLocalClock, JUDGE_DEMO_FACILITY } from "@dockclock/evidence";

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
const [channel = "whatsapp", dwellArg = "8"] = process.argv.slice(2);
if (channel !== "whatsapp" && channel !== "rcs") throw new Error("usage: smoke:demo whatsapp|rcs [dwellMinutes]");
const dwellMinutes = Number(dwellArg);
if (!(dwellMinutes > 5 && dwellMinutes <= 30)) throw new Error("dwellMinutes must be over the 5 free minutes and at most 30");

const lambda = new LambdaClient({});
const sqs = new SQSClient({});
const sfn = new SFNClient({});
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const loadId = `SMOKE-DEMO-${Date.now().toString(36)}`;
const phone = channel === "rcs" ? "15550100996" : "15550100997";
// The judge-demo yard accepts any location; these are the fictional Lakeshore DC test coordinates.
const PIN = { latitude: 39.8995, longitude: -82.938 };
let seq = 0;

function whatsapp(message: Record<string, unknown>) {
  const entry = {
    id: env("DOCKCLOCK_META_WABA_ID"),
    changes: [{ field: "messages", value: { metadata: { phone_number_id: env("DOCKCLOCK_META_PHONE_ID") }, messages: [{ id: `wamid.smoke.${loadId}.${++seq}`, from: phone, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }],
  };
  return JSON.stringify({ Type: "Notification", TopicArn: env("DOCKCLOCK_WHATSAPP_TOPIC_ARN"), Message: JSON.stringify({ aws_account_id: env("DOCKCLOCK_ACCOUNT"), whatsAppWebhookEntry: JSON.stringify(entry), synthetic: true }) });
}

function rcs(messageBody: string) {
  return JSON.stringify({
    Type: "Notification",
    TopicArn: out("RcsTopicArn"),
    Timestamp: new Date().toISOString(),
    Message: JSON.stringify({ originationNumber: phone, destinationNumber: env("DOCKCLOCK_RCS_AGENT_ID"), messageBody, inboundMessageId: `smoke-${loadId}-${++seq}` }),
  });
}

async function feed(label: string, body: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: out("IngestQueueUrl"), MessageBody: body }));
  console.log(`${new Date().toISOString()}  sent ${label}`);
  await sleep(4000);
}

const dispatched = await lambda.send(
  new InvokeCommand({
    FunctionName: out("DispatchFunction"),
    Payload: Buffer.from(
      JSON.stringify({
        loadId,
        clauseId: "judge-demo",
        facilityId: JUDGE_DEMO_FACILITY.id,
        appointmentAt: new Date().toISOString(),
        channel,
        language: "en_US",
        address: { kind: "phone", e164: `+${phone}` },
        optIn: { method: "smoke_test_fixture", at: new Date().toISOString() },
        synthetic: true,
      }),
    ),
  }),
);
if (dispatched.FunctionError) throw new Error(`dispatch failed: ${Buffer.from(dispatched.Payload ?? []).toString()}`);
const { executionArn } = JSON.parse(Buffer.from(dispatched.Payload ?? []).toString()) as { executionArn: string };
console.log(`${new Date().toISOString()}  dispatched ${loadId} on ${channel} (judge-demo clause, real time, ${dwellMinutes} min at the dock)`);
const meta = (await ddb.send(new GetCommand({ TableName: out("TableName"), Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
const nonce = String(meta?.nonce);
const tap = (action: string) =>
  channel === "rcs" ? rcs(JSON.stringify({ type: "SUGGESTION", text: action, postbackData: `dc1.${action}.${loadId}.${nonce}` })) : whatsapp({ type: "button", button: { payload: `dc1.${action}.${loadId}.${nonce}`, text: action } });
const pin = () => (channel === "rcs" ? rcs(JSON.stringify({ type: "LOCATION", ...PIN })) : whatsapp({ type: "location", location: PIN }));

await sleep(3000);
await feed("Arrived", tap("arrived"));
const arrivedAt = Date.now();
await feed("arrival pin", pin());
console.log(`waiting ${dwellMinutes} minutes at the dock (the notice goes out about a minute after arrival)`);
await sleep(Math.max(0, arrivedAt + dwellMinutes * 60_000 - Date.now()));
await feed("Released", tap("released"));
const releasedAt = Date.now();
await feed("release pin", pin());
if (channel === "rcs") {
  const photoPath = "data/bol-photos/signed-24h.jpg";
  const bytes = existsSync(photoPath) ? readFileSync(photoPath) : Buffer.from(`smoke bill of lading for ${loadId}`);
  const key = `${out("RcsMediaPrefix")}/rcs/smoke-${loadId}#bol.jpg`;
  // Written just before the reply, as End User Messaging does, so the ingest guard accepts it.
  await s3.send(new PutObjectCommand({ Bucket: out("RcsMediaBucket"), Key: key, Body: bytes, ContentType: "image/jpeg" }));
  await feed("bill of lading photo", rcs(JSON.stringify({ mediaStatus: "SUCCESS", s3Bucket: out("RcsMediaBucket"), s3Key: key, mimeType: "image/jpeg", fileName: "bol.jpg", fileSizeBytes: bytes.length })));
} else {
  const zone = JUDGE_DEMO_FACILITY.timeZone;
  await feed(
    "release Flow (receiver-signed, times typed from the paper)",
    whatsapp({
      type: "interactive",
      interactive: {
        type: "nfm_reply",
        nfm_reply: {
          name: "flow",
          response_json: JSON.stringify({
            flow_token: `dc1.release.${loadId}.${nonce}`,
            bol_photo: [{ id: "smoke-missing-media", mime_type: "image/jpeg", sha256: "none" }],
            in_time: isoToLocalClock(new Date(arrivedAt + 60_000).toISOString(), zone),
            out_time: isoToLocalClock(new Date(releasedAt - 60_000).toISOString(), zone),
            receiver_signed: true,
            delay_reason: "dock_not_ready",
            consignee: "Demo Receiving Co.",
            share_consent: true,
          }),
        },
      },
    }),
  );
}

let status = "RUNNING";
for (let i = 0; i < 90 && status === "RUNNING"; i++) {
  status = (await sfn.send(new DescribeExecutionCommand({ executionArn }))).status ?? "UNKNOWN";
  if (status === "RUNNING") await sleep(2000);
}
const sealed = (await ddb.send(new GetCommand({ TableName: out("TableName"), Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
console.log(`execution ${status}; load ${loadId} phase ${String(sealed?.phase)}, verdict ${String(sealed?.verdict)}, notice sent ${String(sealed?.notice?.sentAt ?? "no")}`);
if (sealed?.verdict === "BILLABLE") console.log(`to file its claim: npm run approve:load -- ${loadId} && npm run agent:run -- ${loadId} file_claim`);
process.exit(status === "SUCCEEDED" && sealed?.verdict === "BILLABLE" ? 0 : 1);
