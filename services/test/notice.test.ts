import { CreateScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context, SNSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stepSatisfied } from "../src/lifecycle.js";
import { handler, noticeEmail, noticeTime } from "../src/notice.js";
import type { LoadItem } from "../src/store.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const scheduler = mockClient(SchedulerClient);
const ses = mockClient(SESv2Client);
const messaging = mockClient(SocialMessagingClient);
const secrets = mockClient(SecretsManagerClient);
const context = { invokedFunctionArn: "arn:aws:lambda:us-east-1:111122223333:function:notice" } as Context;

let load: Record<string, unknown>;

function freshLoad(): Record<string, unknown> {
  return {
    pk: "LOAD#4471",
    sk: "META",
    loadId: "4471",
    nonce: "abc123",
    phase: "at_dock",
    version: 3,
    clauseId: "atlas-brokerage",
    facilityId: "lakeshore-columbus",
    appointmentAt: "2026-10-17T18:00:00.000Z",
    arrived: { serverAt: "2026-10-17T17:40:00.000Z", messageId: "wamid.pin", lat: 39.8995, lon: -82.938 },
    released: null,
    bol: null,
    driverKey: "phone:x",
    address: { kind: "phone", e164: "+15550100001" },
    channel: "whatsapp",
    language: "en_US",
    tokens: {},
    notice: { scheduledFor: "2026-10-17T19:20:00.000Z" },
  };
}

describe("detention notice", () => {
  beforeAll(() => {
    Object.assign(process.env, {
      TABLE_NAME: "loads",
      NOTICE_SCHEDULE_GROUP: "dockclock-notices",
      NOTICE_SCHEDULER_ROLE_ARN: "arn:aws:iam::111122223333:role/scheduler",
      CLAIMS_FROM_EMAIL: "claims@example.com",
      COUNTERPARTY_EMAIL_BROKER: "broker@example.com",
      COUNTERPARTY_EMAIL_SHIPPER: "shipper@example.com",
      SES_CONFIGURATION_SET: "dockclock-claims",
      DRIVER_REPLIES: "on",
      DRIVER_ALLOWLIST: "+15550100001",
      ORIGINATION_PHONE_ID: "phone-number-id-test",
      IDENTITY_SECRET_ARN: "arn:secret",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, scheduler, ses, messaging, secrets]) m.reset();
    load = freshLoad();
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    dynamo.on(GetCommand).callsFake(async (input: { Key: { pk: string; sk: string } }) => (input.Key.sk === "META" ? { Item: structuredClone(load) } : {}));
    dynamo.on(UpdateCommand).callsFake(async (input: { UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> }) => {
      const notice = (load.notice ?? {}) as Record<string, unknown>;
      const values = input.ExpressionAttributeValues ?? {};
      if (input.UpdateExpression === "SET notice.sentAt = :t") {
        if (notice.sentAt) throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
        notice.sentAt = values[":t"];
      }
      if (input.UpdateExpression === "SET notice.messageId = :m") notice.messageId = values[":m"];
      if (input.UpdateExpression.startsWith("SET notice.deliveredAt")) {
        if (notice.messageId !== values[":m"]) throw Object.assign(new Error("other"), { name: "ConditionalCheckFailedException" });
        notice.deliveredAt ??= values[":t"];
      }
      load.notice = notice;
      return {};
    });
    scheduler.on(CreateScheduleCommand).resolves({ ScheduleArn: "arn:schedule" });
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-notice-1" });
    messaging.on(SendWhatsAppMessageCommand).resolves({ messageId: "out-notice" });
  });

  it("goes out the clause's lead time plus a margin before free time ends", () => {
    // Atlas counts free time from the 18:00 appointment (the truck was early): detention at 20:00,
    // a 30-minute lead and a 10-minute margin put the notice at 19:20.
    const { sendAt, detentionStartAt } = noticeTime(load as unknown as LoadItem, "2026-10-17T17:40:00.000Z", Date.parse("2026-10-17T17:41:00.000Z"));
    expect(detentionStartAt).toBe("2026-10-17T20:00:00.000Z");
    expect(sendAt).toBe("2026-10-17T19:20:00.000Z");
  });

  it("is never scheduled in the past", () => {
    const now = Date.parse("2026-10-17T19:50:00.000Z");
    expect(noticeTime(load as unknown as LoadItem, "2026-10-17T17:40:00.000Z", now).sendAt).toBe("2026-10-17T19:51:00.000Z");
  });

  it("states the check-in, when free time ends and the clause's rate", () => {
    const { subject, text } = noticeEmail(load as unknown as LoadItem, "2026-10-17T20:00:00.000Z");
    expect(subject).toBe("Detention notice: load 4471 at Lakeshore DC, Columbus OH");
    expect(text).toContain("Atlas Brokerage (fictional broker)");
    expect(text).toContain("$50.00 per hour");
  });

  it("creates one schedule that invokes this function and deletes itself", async () => {
    await handler({ kind: "schedule", loadId: "4471" }, context);
    const input = scheduler.commandCalls(CreateScheduleCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Name: "notice-4471", GroupName: "dockclock-notices", ActionAfterCompletion: "DELETE", FlexibleTimeWindow: { Mode: "OFF" } });
    expect(input.Target).toMatchObject({ Arn: context.invokedFunctionArn, Input: JSON.stringify({ kind: "send", loadId: "4471" }) });
    expect(input.ScheduleExpression).toMatch(/^at\(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\)$/);
  });

  it("emails the counterparty once, tagged for delivery tracking, then tells the driver", async () => {
    await handler({ kind: "send", loadId: "4471" }, context);
    await handler({ kind: "send", loadId: "4471" }, context);
    const sends = ses.commandCalls(SendEmailCommand);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.args[0].input.Destination?.ToAddresses).toEqual(["broker@example.com"]);
    expect(sends[0]!.args[0].input.EmailTags).toEqual([{ Name: "purpose", Value: "detention_notice" }, { Name: "loadId", Value: "4471" }]);
    expect((load.notice as Record<string, unknown>).messageId).toBe("ses-notice-1");
    const driver = JSON.parse(Buffer.from(messaging.commandCalls(SendWhatsAppMessageCommand)[0]!.args[0].input.message as Uint8Array).toString());
    expect(driver.template.name).toBe("dockclock_notice_sent");
  });

  it("sends nothing once the truck is released", async () => {
    load.released = { serverAt: "2026-10-17T19:00:00.000Z", messageId: "wamid.rel", lat: 39.8995, lon: -82.938 };
    expect(await handler({ kind: "send", loadId: "4471" }, context)).toEqual({ sent: false });
    expect(ses.calls()).toHaveLength(0);
  });

  it("records the SES delivery time only for the notice it sent", async () => {
    (load.notice as Record<string, unknown>).messageId = "ses-notice-1";
    const sns = (messageId: string): SNSEvent => ({
      Records: [{ Sns: { Message: JSON.stringify({ eventType: "Delivery", mail: { messageId, tags: { purpose: ["detention_notice"], loadId: ["4471"] } }, delivery: { timestamp: "2026-10-17T19:20:04.000Z" } }), Timestamp: "x" } }],
    }) as unknown as SNSEvent;
    await handler(sns("someone-else"), context);
    expect((load.notice as Record<string, unknown>).deliveredAt).toBeUndefined();
    await handler(sns("ses-notice-1"), context);
    expect((load.notice as Record<string, unknown>).deliveredAt).toBe("2026-10-17T19:20:04.000Z");
  });
});

describe("photo retake step", () => {
  const bol = (messageId: string, media: "pending" | "stored") => ({ messageId, media }) as never;
  it("waits for a different, stored bill of lading", () => {
    expect(stepSatisfied({ arrived: null, released: null, bol: bol("wamid.first", "stored"), retakeOf: "wamid.first" }, "retake")).toBe(false);
    expect(stepSatisfied({ arrived: null, released: null, bol: bol("wamid.second", "pending"), retakeOf: "wamid.first" }, "retake")).toBe(false);
    expect(stepSatisfied({ arrived: null, released: null, bol: bol("wamid.second", "stored"), retakeOf: "wamid.first" }, "retake")).toBe(true);
  });
});
