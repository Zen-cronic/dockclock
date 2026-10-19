import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { PinpointSMSVoiceV2Client, SendRcsMessageCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { driverKeyWith } from "../src/identity.js";
import { handler } from "../src/ingest.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const messaging = mockClient(SocialMessagingClient);
const sms = mockClient(PinpointSMSVoiceV2Client);
const secrets = mockClient(SecretsManagerClient);
const sfn = mockClient(SFNClient);
const ses = mockClient(SESv2Client);

const config = { account: "111122223333", topicArn: "arn:aws:sns:us-east-1:111122223333:events", waba: "waba-1", phone: "phone-1" };
const rcsTopic = "arn:aws:sns:us-east-1:111122223333:dockclock-rcs-events";
const agentId = "rcs-0123456789abcdef";

type Item = Record<string, unknown> & { outbox?: Record<string, unknown> };
let load: Item;
let receipts: Record<string, Item>;
let timeline: Item[];

function freshLoad(): Item {
  return {
    pk: "LOAD#4471",
    sk: "META",
    loadId: "4471",
    nonce: "abc123",
    phase: "at_dock",
    version: 3,
    arrived: { serverAt: "2026-10-17T18:01:03.000Z", messageId: "wamid.pin", lat: 39.8995, lon: -82.938 },
    released: null,
    bol: null,
    flowSends: 0,
    clauseId: "lakeshore-foods",
    facilityId: "lakeshore-columbus",
    appointmentAt: "2026-10-17T18:00:00.000Z",
    driverKey: "phone:x",
    address: { kind: "phone", e164: "+15550100001" },
    channel: "whatsapp",
    language: "en_US",
    tokens: {},
    outbox: {},
    synthetic: true,
  };
}

// A WhatsApp "failed" status for the Released offer we sent as EUM message out-1.
function whatsappFailed(eumMessageId: string, wamid = "wamid.out1"): SQSEvent {
  const entry = {
    id: config.waba,
    changes: [{ field: "messages", value: { metadata: { phone_number_id: config.phone }, statuses: [{ id: wamid, status: "failed", timestamp: "1792186300", errors: [{ code: 131026 }] }] } }],
  };
  const body = JSON.stringify({ Type: "Notification", TopicArn: config.topicArn, Message: JSON.stringify({ aws_account_id: config.account, messageId: eumMessageId, whatsAppWebhookEntry: JSON.stringify(entry) }) });
  return { Records: [{ messageId: "sqs-1", body } as SQSEvent["Records"][number]] };
}

function rcsFailed(messageId: string): SQSEvent {
  const event = { eventType: "RCS_FAILED", eventTimestamp: 1792186400000, originationPhoneNumber: agentId, messageId, messageStatus: "UNDELIVERABLE", messageStatusDescription: "device does not support RCS" };
  const body = JSON.stringify({ Type: "Notification", TopicArn: rcsTopic, Timestamp: "2026-10-17T19:00:00.000Z", Message: JSON.stringify(event) });
  return { Records: [{ messageId: "sqs-2", body } as SQSEvent["Records"][number]] };
}

function cancelled(): TransactionCanceledException {
  return new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] });
}

describe("WhatsApp to RCS failover", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      ACCOUNT_ID: config.account,
      TOPIC_ARN: config.topicArn,
      META_WABA_ID: config.waba,
      META_PHONE_ID: config.phone,
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      IDENTITY_SECRET_ARN: "arn:secret",
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: "+15550100001",
      MEDIA_BUCKET: "media",
      RELEASE_FLOW_ID: "1",
      RCS_AGENT_ID: agentId,
      RCS_TOPIC_ARN: rcsTopic,
      RCS_CONFIGURATION_SET: "dockclock-rcs",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, messaging, sms, secrets, sfn, ses]) m.reset();
    load = freshLoad();
    receipts = { "out-1": { pk: "MSG#out-1", sk: "RECEIPT", loadId: "4471", purpose: "offer_release", channel: "whatsapp" } };
    timeline = [];
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    sfn.on(SendTaskSuccessCommand).resolves({});
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-1" });
    sms.on(SendRcsMessageCommand).resolves({ MessageId: "rcs-out-1" });
    dynamo.on(GetCommand).callsFake(async (input: { Key: { pk: string } }) => (input.Key.pk === "LOAD#4471" ? { Item: structuredClone(load) } : {}));
    dynamo.on(PutCommand).resolves({});
    // Receipt writes merge into the fake table and return the merged item, like ReturnValues ALL_NEW.
    dynamo.on(UpdateCommand).callsFake(async (input: { Key: { pk: string }; UpdateExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }) => {
      if (input.Key.pk.startsWith("MSG#")) {
        const id = input.Key.pk.slice(4);
        const values = input.ExpressionAttributeValues ?? {};
        receipts[id] = { ...receipts[id], loadId: receipts[id]?.loadId ?? values[":l"], purpose: receipts[id]?.purpose ?? values[":p"], channel: receipts[id]?.channel ?? values[":c"] };
        return { Attributes: receipts[id] };
      }
      if (input.UpdateExpression.startsWith("REMOVE outbox")) delete load.outbox?.[input.ExpressionAttributeNames?.["#k"] ?? ""];
      return {};
    });
    dynamo.on(TransactWriteCommand).callsFake(async (input: { TransactItems: Array<Record<string, { Key?: { pk: string }; Item?: Item; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> }>> }) => {
      const [receipt, loadUpdate, event] = input.TransactItems;
      const id = receipt?.Update?.Key?.pk.slice(4) ?? "";
      if (receipts[id]?.failoverAt) throw cancelled();
      receipts[id] = { ...receipts[id], failoverAt: "now" };
      const values = loadUpdate?.Update?.ExpressionAttributeValues ?? {};
      if (values[":rcs"]) load.channel = "rcs";
      const key = loadUpdate?.Update?.ExpressionAttributeNames?.["#k"];
      if (key) load.outbox = { ...load.outbox, [key]: values[":o"] };
      if (event?.Put?.Item) timeline.push(event.Put.Item);
      return {};
    });
  });

  it("re-sends a failed WhatsApp prompt once over RCS and keeps the load on RCS", async () => {
    const result = await handler(whatsappFailed("out-1"));
    expect(result.batchItemFailures).toHaveLength(0);
    const sends = sms.commandCalls(SendRcsMessageCommand);
    expect(sends).toHaveLength(1);
    const input = sends[0]!.args[0].input;
    expect(input.OriginationIdentity).toBe(agentId);
    expect(input.DestinationPhoneNumber).toBe("+15550100001");
    expect(input.ConfigurationSetName).toBe("dockclock-rcs");
    expect(input.Context).toEqual({ loadId: "4471", purpose: "offer_release" });
    expect(JSON.stringify(input.RcsMessageContent)).toContain("dc1.released.4471.abc123");
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(0);
    expect(load.channel).toBe("rcs");
    expect(load.outbox).toEqual({});
    expect(timeline).toEqual([expect.objectContaining({ type: "failover", outcome: "RESENT_OVER_RCS", channel: "rcs", detail: expect.objectContaining({ from: "whatsapp", purpose: "offer_release", errorCode: 131026 }) })]);
    expect(receipts["rcs-out-1"]).toMatchObject({ loadId: "4471", purpose: "offer_release", channel: "rcs" });
  });

  it("never re-sends twice when the failure is reported again", async () => {
    await handler(whatsappFailed("out-1"));
    await handler(whatsappFailed("out-1"));
    expect(sms.commandCalls(SendRcsMessageCommand)).toHaveLength(1);
    expect(timeline).toHaveLength(1);
  });

  it("retries a queued RCS re-send when the failed status is redelivered", async () => {
    sms.on(SendRcsMessageCommand).rejectsOnce(Object.assign(new Error("slow down"), { name: "ThrottlingException" })).resolves({ MessageId: "rcs-out-1" });
    const first = await handler(whatsappFailed("out-1"));
    expect(first.batchItemFailures).toHaveLength(1);
    expect(Object.keys(load.outbox ?? {})).toHaveLength(1);
    // SQS redelivers the same record: the failover is already recorded, but the outbox still drains.
    const second = await handler(whatsappFailed("out-1"));
    expect(second.batchItemFailures).toHaveLength(0);
    expect(sms.commandCalls(SendRcsMessageCommand)).toHaveLength(2);
    expect(load.outbox).toEqual({});
    expect(timeline).toHaveLength(1);
  });

  it("sends nothing more over RCS when the RCS re-send fails too, and tells dispatch instead", async () => {
    load.synthetic = false;
    process.env.DISPATCH_EMAIL = "dispatch@example.com";
    process.env.FROM_EMAIL = "dockclock@example.com";
    process.env.SES_CONFIGURATION_SET = "dockclock-claims";
    await handler(whatsappFailed("out-1"));
    await handler(rcsFailed("rcs-out-1"));
    await handler(rcsFailed("rcs-out-1"));
    expect(sms.commandCalls(SendRcsMessageCommand)).toHaveLength(1);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    const email = ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content?.Simple;
    expect(String(email?.Subject?.Data)).toContain("RCS delivery failed (");
    // Failover marks the driver unreachable, so dispatch is told to call rather than message them.
    expect(String(email?.Body?.Text?.Data)).toContain("Messages are not getting through on RCS; call them.");
    expect(timeline.map((e) => e.outcome)).toEqual(["RESENT_OVER_RCS", "ESCALATED_UNREACHABLE"]);
  });

  it("does not rewind a driver when the failed prompt is already behind the load", async () => {
    load.phase = "awaiting_bol";
    await handler(whatsappFailed("out-1"));
    expect(sms.commandCalls(SendRcsMessageCommand)).toHaveLength(0);
    expect(load.channel).toBe("rcs");
    expect(timeline[0]).toMatchObject({ outcome: "SWITCHED_TO_RCS" });
  });

  it("routes an RCS suggested-reply tap through the same lifecycle as a WhatsApp button", async () => {
    load.channel = "rcs";
    // The sender must own the load: same HMAC key as the dispatched phone number.
    load.driverKey = driverKeyWith("k", { kind: "phone", e164: "+15550100001" });
    dynamo.on(GetCommand).callsFake(async (input: { Key: { pk: string } }) => {
      if (input.Key.pk.startsWith("DRIVER#")) return { Item: { loadId: "4471", dispatchedAt: "t", address: load.address } };
      return input.Key.pk === "LOAD#4471" ? { Item: structuredClone(load) } : {};
    });
    dynamo.on(TransactWriteCommand).resolves({});
    const tap = { originationNumber: "15550100001", destinationNumber: agentId, messageBody: JSON.stringify({ type: "SUGGESTION", text: "Released", postbackData: "dc1.released.4471.abc123" }), inboundMessageId: "in-1" };
    const body = JSON.stringify({ Type: "Notification", TopicArn: rcsTopic, Timestamp: "2026-10-17T19:30:00.000Z", Message: JSON.stringify(tap) });
    const result = await handler({ Records: [{ messageId: "sqs-3", body } as SQSEvent["Records"][number]] });
    expect(result.batchItemFailures).toHaveLength(0);
    const transaction = dynamo.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems;
    expect(transaction?.[0]?.Put?.Item?.pk).toBe("WAMID#rcs.in-1");
    expect(transaction?.[2]?.Update?.ExpressionAttributeValues?.[":p"]).toBe("awaiting_release_pin");
  });
});
