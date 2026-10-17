import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send, textMessage } from "../src/sender.js";

const messaging = mockClient(SocialMessagingClient);
const dynamo = mockClient(DynamoDBDocumentClient);
const allowed = { kind: "phone" as const, e164: "+15550100001" };
const stranger = { kind: "phone" as const, e164: "+15550100002" };

describe("send", () => {
  beforeEach(() => {
    messaging.reset();
    dynamo.reset();
    dynamo.on(PutCommand).resolves({});
    process.env.TABLE_NAME = "loads";
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-1" });
    process.env.ORIGINATION_PHONE_ID = "phone-number-id-test";
    process.env.DRIVER_ALLOWLIST = "+15550100001";
  });
  afterEach(() => {
    delete process.env.DRIVER_REPLIES;
    delete process.env.DRIVER_ALLOWLIST;
  });

  it("sends nothing while driver replies are off", async () => {
    expect(await send(allowed, textMessage(allowed, "hi"), "test", "L1")).toBeNull();
    expect(messaging.calls()).toHaveLength(0);
  });

  it("sends only to allowlisted recipients when on", async () => {
    process.env.DRIVER_REPLIES = "on";
    expect(await send(stranger, textMessage(stranger, "hi"), "test", "L1")).toBeNull();
    expect(messaging.calls()).toHaveLength(0);
    expect(await send(allowed, textMessage(allowed, "hi"), "test", "L1")).toBe("out-1");
    expect(messaging.calls()).toHaveLength(1);
    // The send is recorded under End User Messaging's id so receipts join back to the load.
    expect(dynamo.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({ pk: "MSG#out-1", sk: "RECEIPT", loadId: "L1", purpose: "test" });
  });
});
