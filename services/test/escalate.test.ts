import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context, SNSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { findLeaks } from "@dockclock/sanitize";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { notifyDispatch } from "../src/escalate.js";
import { handler as noticeHandler } from "../src/notice.js";
import type { LoadItem } from "../src/store.js";

const ses = mockClient(SESv2Client);
const dynamo = mockClient(DynamoDBDocumentClient);
const load = {
  loadId: "4471",
  facilityId: "lakeshore-columbus",
  phase: "at_dock",
  language: "en_US",
  channel: "whatsapp",
  address: { kind: "phone", e164: "+15550100001" },
  arrived: { serverAt: "2026-10-17T17:40:00.000Z" },
  released: null,
} as unknown as LoadItem;

const sesEvent = (purpose: string, eventType: string, messageId: string): SNSEvent =>
  ({ Records: [{ Sns: { Timestamp: "t", Message: JSON.stringify({ eventType, mail: { messageId, tags: { purpose: [purpose], loadId: ["4471"] } }, delivery: { timestamp: "2026-10-17T18:00:01.000Z" }, bounce: { timestamp: "2026-10-17T18:00:02.000Z" } }) } }] }) as unknown as SNSEvent;

describe("dispatch escalation records", () => {
  beforeAll(() => Object.assign(process.env, { TABLE_NAME: "loads", FROM_EMAIL: "dockclock@example.com", DISPATCH_EMAIL: "dispatch@example.com", SES_CONFIGURATION_SET: "cs" }));
  beforeEach(() => {
    ses.reset();
    dynamo.reset();
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-esc-1" });
    dynamo.on(PutCommand).resolves({});
    dynamo.on(UpdateCommand).resolves({});
  });

  it("emails dispatch the driver's number, tags the load, and records the email without it", async () => {
    expect(await notifyDispatch(load, "driver asked for dispatch")).toBe("ses-esc-1");
    const sent = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(sent.Content?.Simple?.Body?.Text?.Data).toContain("+15550100001");
    expect(sent.EmailTags).toEqual([{ Name: "purpose", Value: "dispatch_escalation" }, { Name: "loadId", Value: "4471" }]);
    const item = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item as Record<string, unknown>;
    expect(item.pk).toBe("LOAD#4471");
    expect(String(item.sk)).toMatch(/^EMAIL#escalation#.+#ses-esc-1$/);
    expect(item).toMatchObject({ purpose: "dispatch_escalation", sesMessageId: "ses-esc-1" });
    expect(String(item.text)).toContain("<phone removed>");
    expect(findLeaks({ ...item, pk: undefined, sk: undefined })).toEqual([]);
  });

  it("records a test load's escalation as not sent, and emails nobody", async () => {
    expect(await notifyDispatch({ ...load, synthetic: true }, "driver asked for dispatch")).toBeNull();
    expect(ses.calls()).toHaveLength(0);
    expect(dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ status: "not_sent", notSentReason: expect.stringContaining("test loads") });
  });

  it("records delivery of the claim email and of an escalation, matched by SES message id", async () => {
    dynamo.on(QueryCommand).resolves({ Items: [{ pk: "LOAD#4471", sk: "EMAIL#escalation#t#ses-esc-1" }] });
    await noticeHandler(sesEvent("detention_claim", "Delivery", "ses-claim-1"), {} as Context);
    await noticeHandler(sesEvent("dispatch_escalation", "Bounce", "ses-esc-1"), {} as Context);
    const updates = dynamo.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates[0]).toMatchObject({ Key: { pk: "LOAD#4471", sk: "CLAIM" }, UpdateExpression: "SET deliveredAt = if_not_exists(deliveredAt, :t)", ConditionExpression: "sesMessageId = :m", ExpressionAttributeValues: { ":t": "2026-10-17T18:00:01.000Z", ":m": "ses-claim-1" } });
    expect(updates[1]).toMatchObject({ Key: { pk: "LOAD#4471", sk: "EMAIL#escalation#t#ses-esc-1" }, UpdateExpression: "SET bouncedAt = if_not_exists(bouncedAt, :t)" });
  });

  it("ignores a delivery event for a claim it did not send", async () => {
    dynamo.on(UpdateCommand).rejects(Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" }));
    await expect(noticeHandler(sesEvent("detention_claim", "Delivery", "someone-else"), {} as Context)).resolves.toBeUndefined();
  });
});
