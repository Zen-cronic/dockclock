import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send, textMessage } from "../src/sender.js";

const messaging = mockClient(SocialMessagingClient);
const dynamo = mockClient(DynamoDBDocumentClient);
const allowed = { address: { kind: "phone" as const, e164: "+1 (555) 010-0001" }, driverKey: "phone:a" };
const stranger = { address: { kind: "phone" as const, e164: "+15550100002" }, driverKey: "phone:b" };
const sentTo = () => JSON.parse(Buffer.from(messaging.commandCalls(SendWhatsAppMessageCommand)[0]!.args[0].input.message as Uint8Array).toString()) as Record<string, unknown>;

describe("send", () => {
  beforeEach(() => {
    messaging.reset();
    dynamo.reset();
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-1" });
    dynamo.on(GetCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
    process.env.TABLE_NAME = "loads";
    process.env.ORIGINATION_PHONE_ID = "phone-number-id-test";
    process.env.DRIVER_ALLOWLIST = "15550100001";
  });
  afterEach(() => {
    delete process.env.DRIVER_REPLIES;
    delete process.env.DRIVER_ALLOWLIST;
  });

  it("sends nothing while driver replies are off", async () => {
    expect(await send(allowed, textMessage("hi"), "test", "L1")).toBeNull();
    expect(messaging.calls()).toHaveLength(0);
  });

  it("matches the allowlist on normalized numbers and sends to the exact address it checked", async () => {
    process.env.DRIVER_REPLIES = "on";
    expect(await send(stranger, textMessage("hi"), "test", "L1")).toBeNull();
    expect(messaging.calls()).toHaveLength(0);
    expect(await send(allowed, textMessage("hi"), "test", "L1")).toBe("out-1");
    expect(sentTo().to).toBe("+15550100001");
  });

  it("never messages a driver who replied STOP, unless confirming the STOP itself", async () => {
    process.env.DRIVER_REPLIES = "on";
    dynamo.on(GetCommand).resolves({ Item: { pk: "OPTOUT#phone:a", sk: "OPTOUT" } });
    expect(await send(allowed, textMessage("hi"), "test", "L1")).toBeNull();
    expect(await send(allowed, textMessage("stopped"), "opt_out", "-", { ignoreOptOut: true })).toBe("out-1");
  });

  it("merges the send record into the receipt instead of overwriting delivery fields", async () => {
    process.env.DRIVER_REPLIES = "on";
    await send(allowed, textMessage("hi"), "test", "L1");
    const update = dynamo.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.Key).toEqual({ pk: "MSG#out-1", sk: "RECEIPT" });
    expect(update?.UpdateExpression).toContain("if_not_exists(acceptedAt");
  });
});
