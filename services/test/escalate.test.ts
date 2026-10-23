import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context, SNSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { findLeaks, parseMime } from "@dockclock/sanitize";
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

// The raw MIME of the nth SES send: its plain-text part (as the console reads it) and its HTML part.
function sentMail(n = 0) {
  const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[n]!.args[0].input.Content?.Raw?.Data ?? new Uint8Array()).toString("utf8");
  const html = /Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)?.[1] ?? "";
  return { raw, parsed: parseMime(raw), html: Buffer.from(html.replace(/\s+/g, ""), "base64").toString("utf8") };
}

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
    const { raw, parsed, html } = sentMail();
    expect(raw).toContain("To: dispatch@example.com");
    expect(parsed.text).toContain("+15550100001");
    // A plain-text part and a simple HTML part with the same facts, as multipart/alternative; the HTML's
    // one image is the brand mark, carried inline in the message, and no part is an attachment.
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.attachments).toEqual([]);
    expect(html).toContain("Dispatch alert");
    expect(html).toContain("Lakeshore DC, Columbus OH");
    expect(html).not.toMatch(/<script|<style/i);
    expect([...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual(["cid:brand-mark@dockclock"]);
    expect(raw).toContain("Content-ID: <brand-mark@dockclock>");
    expect(parsed.text).toContain("DockClock, for the dispatch desk of Demo Carrier (fictional)");
    // Not a demo-workspace load: no console link.
    expect(parsed.text).not.toContain("cloudfront.net");
    expect(sent.EmailTags).toEqual([{ Name: "purpose", Value: "dispatch_escalation" }, { Name: "loadId", Value: "4471" }]);
    const item = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item as Record<string, unknown>;
    expect(item.pk).toBe("LOAD#4471");
    expect(String(item.sk)).toMatch(/^EMAIL#escalation#.+#ses-esc-1$/);
    expect(item).toMatchObject({ purpose: "dispatch_escalation", sesMessageId: "ses-esc-1" });
    expect(String(item.text)).toContain("<phone removed>");
    expect(findLeaks({ ...item, pk: undefined, sk: undefined })).toEqual([]);
  });

  it("links a demo-workspace load to its console page, and the stored record stays leak-free", async () => {
    await notifyDispatch({ ...load, ws: "demo" }, "driver tapped Talk to dispatch");
    const { text } = sentMail().parsed;
    expect(text).toContain("Open this load: https://d3djuoqhg6b8o2.cloudfront.net/loads/4471");
    const item = dynamo.commandCalls(PutCommand)[0]!.args[0].input.Item as Record<string, unknown>;
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
    expect(updates[0]).toMatchObject({ Key: { pk: "LOAD#4471", sk: "CLAIM" }, UpdateExpression: "SET deliveredAt = if_not_exists(deliveredAt, :t)", ConditionExpression: "sesMessageId = :m AND attribute_not_exists(deliveredAt)", ExpressionAttributeValues: { ":t": "2026-10-17T18:00:01.000Z", ":m": "ses-claim-1" } });
    expect(updates[1]).toMatchObject({ Key: { pk: "LOAD#4471", sk: "EMAIL#escalation#t#ses-esc-1" }, UpdateExpression: "SET bouncedAt = if_not_exists(bouncedAt, :t)" });
  });

  it("ignores a delivery event for a claim it did not send", async () => {
    dynamo.on(UpdateCommand).rejects(Object.assign(new Error("no"), { name: "ConditionalCheckFailedException" }));
    await expect(noticeHandler(sesEvent("detention_claim", "Delivery", "someone-else"), {} as Context)).resolves.toBeUndefined();
  });
});
