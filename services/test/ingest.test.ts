import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendTaskSuccessCommand, SFNClient } from "@aws-sdk/client-sfn";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handler } from "../src/ingest.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const messaging = mockClient(SocialMessagingClient);
const secrets = mockClient(SecretsManagerClient);
const sfn = mockClient(SFNClient);

const config = { account: "111122223333", topicArn: "arn:aws:sns:us-east-1:111122223333:events", waba: "waba-1", phone: "phone-1" };

function sqsEvent(message: Record<string, unknown>, wamid: string): SQSEvent {
  const entry = { id: config.waba, changes: [{ field: "messages", value: { metadata: { phone_number_id: config.phone }, messages: [{ id: wamid, from: "15550100001", timestamp: "1792186263", ...message }] } }] };
  const body = JSON.stringify({ Type: "Notification", TopicArn: config.topicArn, Message: JSON.stringify({ aws_account_id: config.account, whatsAppWebhookEntry: JSON.stringify(entry) }) });
  return { Records: [{ messageId: "sqs-1", body } as SQSEvent["Records"][number]] };
}

const load = {
  pk: "LOAD#4471",
  sk: "META",
  loadId: "4471",
  nonce: "abc123",
  phase: "awaiting_arrival_pin",
  version: 2,
  arrived: null,
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
  // What the transaction for the arrival pin committed: the Released button is owed to the driver.
  outbox: { "2026-10-17T18:01:03.000Z#wamid.pin#00": { seq: "2026-10-17T18:01:03.000Z#wamid.pin#00", effect: { type: "offer_release" } } },
};

describe("ingest outbox", () => {
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
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, messaging, secrets, sfn]) m.reset();
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    sfn.on(SendTaskSuccessCommand).resolves({});
    dynamo.on(GetCommand).callsFake((input: { Key: { pk: string } }) => {
      if (input.Key.pk.startsWith("DRIVER#")) return { Item: { loadId: "4471", dispatchedAt: "t", address: load.address } };
      if (input.Key.pk === "LOAD#4471") return { Item: load };
      return {};
    });
    dynamo.on(UpdateCommand).resolves({});
    dynamo.on(PutCommand).resolves({});
  });

  it("replays a send that failed on the first delivery instead of stranding the load", async () => {
    const pin = sqsEvent({ type: "location", location: { latitude: 39.8995, longitude: -82.938 } }, "wamid.pin");

    // First delivery: the transaction commits, then the Released-button send throws. From then on the
    // stored load is the committed one: at the dock, with the Released offer owed.
    dynamo.on(TransactWriteCommand).callsFake(async () => {
      dynamo.on(GetCommand, { Key: { pk: "LOAD#4471", sk: "META" } }).resolves({ Item: { ...load, phase: "at_dock", arrived: { serverAt: "2026-10-17T18:01:03.000Z", messageId: "wamid.pin" } } });
      return {};
    });
    messaging.on(SendWhatsAppMessageCommand).rejects(Object.assign(new Error("throttled"), { name: "ThrottlingException" }));
    const first = await handler(pin);
    expect(first.batchItemFailures).toHaveLength(1);
    expect(dynamo.commandCalls(UpdateCommand).filter((c) => String(c.args[0].input.UpdateExpression).startsWith("REMOVE outbox"))).toHaveLength(0);

    // Redelivery: the wamid claim fails (duplicate), and the owed send is replayed from the outbox.
    dynamo.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: "cancelled", $metadata: {}, CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] }),
    );
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-2" });
    const second = await handler(pin);
    expect(second.batchItemFailures).toHaveLength(0);
    const body = JSON.parse(Buffer.from(messaging.commandCalls(SendWhatsAppMessageCommand).at(-1)!.args[0].input.message as Uint8Array).toString());
    expect(body.interactive.type).toBe("button");
    expect(JSON.stringify(body)).toContain("dc1.released.4471.abc123");
    const removes = dynamo.commandCalls(UpdateCommand).filter((c) => String(c.args[0].input.UpdateExpression).startsWith("REMOVE outbox"));
    expect(removes).toHaveLength(1);
  });

  it("commits every side effect in the same transaction as the state change", async () => {
    dynamo.on(TransactWriteCommand).resolves({});
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-3" });
    await handler(sqsEvent({ type: "location", location: { latitude: 39.8995, longitude: -82.938 } }, "wamid.pin2"));
    const update = dynamo.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[2]?.Update;
    expect(update?.UpdateExpression).toContain("phase = :p");
    expect(update?.UpdateExpression).toContain("outbox.#o0 = :o0");
    expect(Object.values(update?.ExpressionAttributeValues ?? {})).toContainEqual(expect.objectContaining({ effect: { type: "offer_release" } }));
  });

  it("drops a malformed body instead of retrying it into the dead-letter queue", async () => {
    const result = await handler({ Records: [{ messageId: "sqs-x", body: "not json" } as SQSEvent["Records"][number]] });
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("honours STOP for the driver before any load routing", async () => {
    dynamo.on(TransactWriteCommand).resolves({});
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-4" });
    await handler(sqsEvent({ type: "text", text: { body: "STOP" } }, "wamid.stop"));
    expect(dynamo.commandCalls(PutCommand).some((c) => String(c.args[0].input.Item?.pk).startsWith("OPTOUT#"))).toBe(true);
    expect(dynamo.commandCalls(TransactWriteCommand)).toHaveLength(0);
    const body = JSON.parse(Buffer.from(messaging.commandCalls(SendWhatsAppMessageCommand)[0]!.args[0].input.message as Uint8Array).toString());
    expect(body.text.body).toContain("Reply START");
  });
});
