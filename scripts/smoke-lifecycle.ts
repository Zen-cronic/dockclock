// Live smoke test for the deployed driver loop. Dispatches a SMOKE- load, feeds synthetic WhatsApp
// webhook envelopes straight into the ingest queue (never the shared SNS topic), waits for the
// lifecycle workflow, then verifies the sealed pack against the KMS public key.
import { readFileSync } from "node:fs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { DescribeExecutionCommand, SFNClient } from "@aws-sdk/client-sfn";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { facilityById, isoToLocalClock, KmsSigner, verifyPack, type SignedPack } from "@dockclock/evidence";

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

const loadId = `SMOKE-${Date.now().toString(36)}`;
const phone = "15550100999";
const now = Date.now();
const appointment = new Date(now - 4 * 3600_000).toISOString();
const INSIDE = { latitude: 39.8995, longitude: -82.938 };
let seq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envelope(message: Record<string, unknown>, atMs: number, wamid = `wamid.smoke.${loadId}.${++seq}`) {
  const entry = {
    id: env("DOCKCLOCK_META_WABA_ID"),
    changes: [
      {
        field: "messages",
        value: {
          metadata: { phone_number_id: env("DOCKCLOCK_META_PHONE_ID") },
          messages: [{ id: wamid, from: phone, timestamp: String(Math.floor(atMs / 1000)), ...message }],
        },
      },
    ],
  };
  return JSON.stringify({
    Type: "Notification",
    TopicArn: env("DOCKCLOCK_WHATSAPP_TOPIC_ARN"),
    Message: JSON.stringify({ aws_account_id: env("DOCKCLOCK_ACCOUNT"), whatsAppWebhookEntry: JSON.stringify(entry), synthetic: true }),
  });
}

async function feed(label: string, body: string) {
  await sqs.send(new SendMessageCommand({ QueueUrl: out("IngestQueueUrl"), MessageBody: body }));
  console.log(`  sent ${label}`);
  await sleep(2500);
}

const pin = { type: "location", location: INSIDE };

const dispatched = await lambda.send(
  new InvokeCommand({
    FunctionName: out("DispatchFunction"),
    Payload: Buffer.from(
      JSON.stringify({
        loadId,
        clauseId: "lakeshore-foods",
        facilityId: "lakeshore-columbus",
        appointmentAt: appointment,
        channel: "whatsapp",
        language: "en_US",
        address: { kind: "phone", e164: `+${phone}` },
        optIn: { method: "smoke_test_fixture", at: new Date(now).toISOString() },
        synthetic: true,
        // SMOKE_APPROVAL=1 sends the real dispatcher the approval template for this test load.
        ...(process.env.SMOKE_APPROVAL === "1" ? { askDispatcher: true } : {}),
      }),
    ),
  }),
);
if (dispatched.FunctionError) throw new Error(`dispatch failed: ${Buffer.from(dispatched.Payload ?? []).toString()}`);
const { executionArn } = JSON.parse(Buffer.from(dispatched.Payload ?? []).toString()) as { executionArn: string };
console.log(`dispatched ${loadId}`);
const meta = (await ddb.send(new GetCommand({ TableName: out("TableName"), Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
const nonce = String(meta?.nonce);
const button = (action: string, n = nonce) => ({ type: "button", button: { payload: `dc1.${action}.${loadId}.${n}`, text: action } });
const zone = facilityById("lakeshore-columbus").timeZone;
const signedBol = process.env.SMOKE_SIGNED === "1";
const flowReply = {
  type: "interactive",
  interactive: {
    type: "nfm_reply",
    nfm_reply: {
      name: "flow",
      // A media id that does not exist: exercises the "photo unavailable" path honestly.
      response_json: JSON.stringify({
        flow_token: `dc1.release.${loadId}.${nonce}`,
        bol_photo: [{ id: "smoke-missing-media", mime_type: "image/jpeg", sha256: "none" }],
        // SMOKE_SIGNED=1 models a receiver-signed BOL whose times the driver typed from the paper
        // (a couple of minutes off the pins), which the clause engine can bill.
        in_time: isoToLocalClock(new Date(now - (signedBol ? 245 : 247) * 60_000).toISOString(), zone),
        out_time: isoToLocalClock(new Date(now - (signedBol ? 31 : 29) * 60_000).toISOString(), zone),
        ...(signedBol ? { receiver_signed: true } : {}),
        delay_reason: "dock_not_ready",
        consignee: "Smoke Receiver",
        share_consent: true,
      }),
    },
  },
};

const t = (minutesBeforeNow: number) => now - minutesBeforeNow * 60_000;
await feed("Released before Arrived (should be rejected)", envelope(button("released"), t(250)));
const arrivedWamid = `wamid.smoke.${loadId}.arrived`;
await feed("Arrived", envelope(button("arrived"), t(248), arrivedWamid));
await feed("Arrived again, same message id (SQS redelivery)", envelope(button("arrived"), t(248), arrivedWamid));
await feed("arrival pin", envelope(pin, t(247)));
if (process.env.SMOKE_NOTICE === "1") await checkNotice();
await feed("second Arrived tap (should be ignored)", envelope(button("arrived"), t(200)));
await feed("Released with a stale nonce (should be rejected)", envelope(button("released", "stale000"), t(31)));
await feed("Released", envelope(button("released"), t(30)));
await feed("release pin", envelope(pin, t(29)));
await feed("release Flow with BOL photo and times", envelope(flowReply, t(25)));

// SMOKE_NOTICE=1: the arrival must create the notice schedule; the notice is then sent now (the
// schedule's timing is unit-tested) and SES must report it delivered before the load is released.
async function checkNotice(): Promise<void> {
  const scheduler = new SchedulerClient({});
  let expression: string | undefined;
  for (let i = 0; i < 20 && !expression; i++) {
    expression = await scheduler
      .send(new GetScheduleCommand({ Name: `notice-${loadId}`, GroupName: "dockclock-notices" }))
      .then((s) => s.ScheduleExpression)
      .catch(() => undefined);
    if (!expression) await sleep(2000);
  }
  if (!expression) throw new Error("no notice schedule was created after the arrival pin");
  console.log(`notice schedule ${expression} UTC`);
  await lambda.send(new InvokeCommand({ FunctionName: out("NoticeFunction"), Payload: Buffer.from(JSON.stringify({ kind: "send", loadId })) }));
  for (let i = 0; i < 45; i++) {
    const notice = (await ddb.send(new GetCommand({ TableName: out("TableName"), Key: { pk: `LOAD#${loadId}`, sk: "META" }, ConsistentRead: true }))).Item?.notice;
    if (notice?.deliveredAt) {
      console.log(`notice sent ${notice.sentAt} (SES ${notice.messageId}), delivered ${notice.deliveredAt}`);
      return;
    }
    await sleep(2000);
  }
  throw new Error("the detention notice was not reported delivered by SES");
}

let status = "RUNNING";
for (let i = 0; i < 45 && status === "RUNNING"; i++) {
  status = (await sfn.send(new DescribeExecutionCommand({ executionArn }))).status ?? "UNKNOWN";
  if (status === "RUNNING") await sleep(2000);
}
console.log(`execution ${status}`);

const timeline = await ddb.send(
  new QueryCommand({ TableName: out("TableName"), KeyConditionExpression: "pk = :pk AND begins_with(sk, :e)", ExpressionAttributeValues: { ":pk": `LOAD#${loadId}`, ":e": "EVENT#" } }),
);
console.log("timeline:");
for (const item of timeline.Items ?? []) console.log(`  ${item.serverAt}  ${String(item.type).padEnd(8)} ${String(item.outcome).padEnd(24)} ${item.phaseBefore} -> ${item.phaseAfter}`);

const load = (await ddb.send(new GetCommand({ TableName: out("TableName"), Key: { pk: `LOAD#${loadId}`, sk: "META" } }))).Item;
if (!load?.sealedPackId) throw new Error("load was not sealed");
const key = `packs/${loadId}/${load.sealedPackId}.json`;
const object = await s3.send(new GetObjectCommand({ Bucket: out("EvidenceBucket"), Key: key }));
const signed = JSON.parse(await object.Body!.transformToString()) as SignedPack;
const head = await s3.send(new HeadObjectCommand({ Bucket: out("EvidenceBucket"), Key: key }));
const publicKey = await new KmsSigner(out("EvidenceKeyArn")).publicKeyDer();
const tampered: SignedPack = { ...signed, pack: { ...signed.pack, evaluation: { ...signed.pack.evaluation, amountUsd: 9999 } } };

console.log(`pack ${key}`);
console.log(`  verdict ${signed.pack.evaluation.verdict} (${signed.pack.evaluation.reasons.join(", ") || "no reasons"}), amount $${signed.pack.evaluation.amountUsd}, confidence ${signed.pack.corroboration.confidence}`);
console.log(`  object lock ${head.ObjectLockMode} until ${head.ObjectLockRetainUntilDate?.toISOString()}`);
console.log(`  signature verifies with KMS public key: ${verifyPack(signed, publicKey)}`);
console.log(`  tampered copy verifies: ${verifyPack(tampered, publicKey)}`);

const outcomes = (timeline.Items ?? []).map((i) => i.outcome);
const ok =
  status === "SUCCEEDED" &&
  verifyPack(signed, publicKey) &&
  !verifyPack(tampered, publicKey) &&
  head.ObjectLockMode === "GOVERNANCE" &&
  outcomes.includes("REJECTED_OUT_OF_ORDER") &&
  outcomes.includes("IGNORED_DUPLICATE_TAP") &&
  outcomes.includes("REJECTED_STALE_BUTTON") &&
  outcomes.filter((o) => o === "ADVANCED").length === 5 &&
  (timeline.Items ?? []).length === 8 &&
  load.bol?.media === "unavailable" &&
  signed.pack.corroboration.confidence === "low" &&
  signed.pack.corroboration.signals.some((s) => s.name === "bol_media_hashed" && !s.ok);
console.log(`  bol media ${load.bol?.media}; signals failing: ${signed.pack.corroboration.signals.filter((s) => !s.ok).map((s) => s.name).join(", ")}`);
console.log(`load ${loadId}: verdict ${signed.pack.evaluation.verdict} $${signed.pack.evaluation.amountUsd}`);
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(ok ? 0 : 1);
