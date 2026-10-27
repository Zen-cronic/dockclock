import { CreateScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { SendWhatsAppMessageCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context, SNSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stepSatisfied } from "../src/lifecycle.js";
import { findLeaks, parseMime } from "@dockclock/sanitize";
import { handler, noticeEmail, noticeTime } from "../src/notice.js";
import type { LoadItem } from "../src/store.js";

const dynamo = mockClient(DynamoDBDocumentClient);
const scheduler = mockClient(SchedulerClient);
const ses = mockClient(SESv2Client);
const messaging = mockClient(SocialMessagingClient);
const secrets = mockClient(SecretsManagerClient);
const s3 = mockClient(S3Client);
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
      EVIDENCE_BUCKET: "evidence",
      DISPATCH_EMAIL: "dispatch@example.com",
    });
  });

  beforeEach(() => {
    for (const m of [dynamo, scheduler, ses, messaging, secrets, s3]) m.reset();
    s3.on(PutObjectCommand).resolves({});
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
      if (input.UpdateExpression === "SET notice.mimeKey = :k") notice.mimeKey = values[":k"];
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
    const { sendAt, detentionStartAt } = noticeTime(load as unknown as LoadItem, "2026-10-17T17:40:00.000Z", Date.parse("2026-10-17T17:41:00.000Z"))!;
    expect(detentionStartAt).toBe("2026-10-17T20:00:00.000Z");
    expect(sendAt).toBe("2026-10-17T19:20:00.000Z");
  });

  it("goes out within a minute of arrival on the judge demo, before its 5 minutes of free time end", () => {
    const arrivedAt = "2026-10-18T21:00:00.000Z";
    const { sendAt, detentionStartAt } = noticeTime({ clauseId: "judge-demo", appointmentAt: arrivedAt }, arrivedAt, Date.parse(arrivedAt))!;
    expect(sendAt).toBe("2026-10-18T21:01:00.000Z");
    expect(Date.parse(sendAt)).toBeLessThan(Date.parse(detentionStartAt));
  });

  it("is never scheduled in the past", () => {
    const now = Date.parse("2026-10-17T19:50:00.000Z");
    expect(noticeTime(load as unknown as LoadItem, "2026-10-17T17:40:00.000Z", now)?.sendAt).toBe("2026-10-17T19:51:00.000Z");
  });

  // detentionStartsAt() threw a RangeError on an arrival time that does not parse, failing the step.
  it("schedules nothing for an arrival time that does not parse, and sends nothing from an old schedule", async () => {
    expect(noticeTime(load as unknown as LoadItem, "garbage")).toBeNull();
    load = { ...freshLoad(), arrived: { serverAt: "garbage", messageId: "wamid.pin" } };
    expect(await handler({ kind: "schedule", loadId: "4471" }, context)).toEqual({ scheduledFor: null });
    expect(scheduler.commandCalls(CreateScheduleCommand)).toHaveLength(0);
    expect(await handler({ kind: "send", loadId: "4471" }, context)).toEqual({ sent: false });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    const skipped = dynamo.commandCalls(UpdateCommand).find((c) => c.args[0].input.UpdateExpression === "SET notice.skipped = :w");
    expect(skipped?.args[0].input.ExpressionAttributeValues?.[":w"]).toMatch(/arrival time could not be read/);
  });

  it("states the check-in, when free time ends and the clause's rate", () => {
    const { subject, text } = noticeEmail(load as unknown as LoadItem, "2026-10-17T20:00:00.000Z", "DockClock Claims <claims@example.com>", "dispatch@example.com");
    expect(subject).toBe("Detention notice: Load 4471 at Lakeshore DC, Columbus OH, free time ends 16:00 EDT");
    expect(text.split("\n")[0]).toBe("Dear Atlas Brokerage (fictional broker),");
    expect(text).toContain("Detention rate: $50.00 per hour");
    // Dated in full, so an evening check-in does not read as the next UTC day.
    expect(text).toContain("Checked in: 2026-10-17 13:40 EDT");
    expect(text).toContain("Free time ends: 2026-10-17 16:00 EDT");
    // The time appears once in the body, in the facts.
    expect(text.split("2026-10-17 16:00 EDT")).toHaveLength(2);
    // The pin was checked against the fence, not assumed.
    expect(text).toContain("Source: Location pin inside the facility's geofence, WhatsApp server time");
    // Signed by DockClock Claims for the carrier, with the reply route the Reply-To header gives.
    expect(text).toContain("DockClock Claims, on behalf of Demo Carrier (fictional)\nclaims@example.com\nReply to this email to reach the carrier's dispatch desk.");
    // Not a demo-workspace load: no console link (it would answer 404).
    expect(text).not.toContain("cloudfront.net");
  });

  it("never claims a geofence the record does not show", () => {
    const outside = { ...load, arrived: { ...(load.arrived as object), lat: 40.5, lon: -83.5 } };
    const text = noticeEmail(outside as unknown as LoadItem, "2026-10-17T20:00:00.000Z").text;
    expect(text).toContain("Source: Location pin recorded with WhatsApp server time");
    expect(text).not.toContain("geofence");
    // The judge demo yard accepts any location and says so.
    const demo = { ...load, clauseId: "judge-demo", facilityId: "judge-demo", ws: "demo", demo: true };
    const demoText = noticeEmail(demo as unknown as LoadItem, "2026-10-17T20:00:00.000Z").text;
    expect(demoText).toContain("Source: Location pin recorded with WhatsApp server time; the demo yard accepts any location");
    expect(demoText).not.toContain("geofence");
    expect(demoText).toContain("View this load: https://d3djuoqhg6b8o2.cloudfront.net/loads/4471");
  });

  it("never gives a test load's synthetic pin a platform server time", () => {
    const { text, html } = noticeEmail({ ...load, synthetic: true } as unknown as LoadItem, "2026-10-17T20:00:00.000Z");
    for (const part of [text, html]) {
      expect(part).not.toContain("server time");
      expect(part).not.toMatch(/tapped/i);
      expect(part).toContain("Synthetic test pin (test load)");
    }
    expect(noticeEmail({ ...load, channel: "rcs" } as unknown as LoadItem, "2026-10-17T20:00:00.000Z").text).toContain("RCS server time");
    const demoTest = noticeEmail({ ...load, synthetic: true, clauseId: "judge-demo", facilityId: "judge-demo" } as unknown as LoadItem, "2026-10-17T20:00:00.000Z").text;
    expect(demoTest).toContain("Synthetic test pin (test load); the demo yard accepts any location");
    expect(demoTest).not.toContain("geofence");
  });

  it("renders the same facts as simple HTML with no remote images, scripts or tracking", () => {
    const { text, html } = noticeEmail(load as unknown as LoadItem, "2026-10-17T20:00:00.000Z", "claims@example.com", "dispatch@example.com");
    expect(html).toContain("DockClock");
    expect(html).toContain("2026-10-17 16:00 EDT");
    expect(html).toContain("Location pin inside the facility&#39;s geofence, WhatsApp server time");
    expect(html).not.toMatch(/<script|<link|<style|url\(/i);
    // The one image is the brand mark, carried inline in the message (cid:), never fetched.
    expect([...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual(["cid:brand-mark@dockclock"]);
    expect(findLeaks({ text, html })).toEqual([]);
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

  it("sends the notice as raw MIME and keeps those exact bytes with the load's packs", async () => {
    await handler({ kind: "send", loadId: "4471" }, context);
    const raw = Buffer.from(ses.commandCalls(SendEmailCommand)[0]!.args[0].input.Content!.Raw!.Data!).toString("utf8");
    expect(raw).toContain("Subject: Detention notice: Load 4471 at Lakeshore DC, Columbus OH, free time ends 16:00 EDT");
    expect(raw).toContain("To: broker@example.com");
    // Replies go to the carrier's dispatch desk, as the signature says.
    expect(raw).toMatch(/^Reply-To: dispatch@example\.com\r$/m);
    expect(raw).toContain("Content-Type: multipart/alternative;");
    const parsed = parseMime(raw);
    expect(parsed.text).toContain("Free time ends: 2026-10-17 16:00 EDT");
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.attachments).toEqual([]);
    const put = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Bucket: "evidence", Key: "packs/4471/notice.eml", ContentType: "message/rfc822" });
    expect(put.Body).toBe(raw);
    expect((load.notice as Record<string, unknown>).mimeKey).toBe("packs/4471/notice.eml");
  });

  it("still tells the driver when keeping the copy fails", async () => {
    s3.on(PutObjectCommand).rejects(new Error("denied"));
    expect(await handler({ kind: "send", loadId: "4471" }, context)).toEqual({ sent: true });
    expect(messaging.commandCalls(SendWhatsAppMessageCommand)).toHaveLength(1);
  });

  it("sends nothing once the truck is released", async () => {
    load.released = { serverAt: "2026-10-17T19:00:00.000Z", messageId: "wamid.rel", lat: 39.8995, lon: -82.938 };
    expect(await handler({ kind: "send", loadId: "4471" }, context)).toEqual({ sent: false });
    expect(ses.calls()).toHaveLength(0);
  });

  it("sends nothing once the driver taps Released, before the release pin comes", async () => {
    load.releasedTap = { channel: "whatsapp", serverAt: "2026-10-17T18:58:00.000Z", messageId: "wamid.tap" };
    expect(load.released).toBeNull();
    expect(await handler({ kind: "send", loadId: "4471" }, context)).toEqual({ sent: false });
    expect(ses.calls()).toHaveLength(0);
    expect(messaging.calls()).toHaveLength(0);
    const skip = dynamo.commandCalls(UpdateCommand).find((c) => c.args[0].input.UpdateExpression === "SET notice.skipped = :w");
    expect(skip?.args[0].input.ExpressionAttributeValues).toEqual({ ":w": "The driver tapped Released before the notice was due." });
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

// SES events can arrive before the record they belong to (the SES message id is written just
// after SES accepts the email). Those are retried; a redelivered event changes nothing twice.
describe("SES events that beat their record", () => {
  let table: Record<string, Record<string, unknown>>;
  const k = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
  const event = (purpose: string, eventType: "Delivery" | "Bounce", messageId: string, sentAt: string): SNSEvent =>
    ({
      Records: [{ Sns: { Timestamp: sentAt, Message: JSON.stringify({ eventType, mail: { messageId, timestamp: sentAt, tags: { purpose: [purpose], loadId: ["4471"] } }, delivery: { timestamp: sentAt }, bounce: { timestamp: sentAt } }) } }],
    }) as unknown as SNSEvent;

  beforeAll(() => Object.assign(process.env, { FROM_EMAIL: "dockclock@example.com" }));
  beforeEach(() => {
    for (const m of [dynamo, ses, messaging, secrets, s3]) m.reset();
    secrets.on(GetSecretValueCommand).resolves({ SecretString: "k" });
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-esc" });
    table = { "LOAD#4471|META": { ...freshLoad(), notice: { sentAt: "x" } } };
    dynamo.on(GetCommand).callsFake(async (q: { Key: { pk: string; sk: string } }) => ({ Item: structuredClone(table[k(q.Key)]) }));
    dynamo.on(PutCommand).resolves({});
    // A small DynamoDB: SET <path> = if_not_exists(<path>, :t) under "<id> = :m AND attribute_not_exists(<path>)".
    dynamo.on(UpdateCommand).callsFake(async (q: { Key: { pk: string; sk: string }; UpdateExpression: string; ConditionExpression?: string; ExpressionAttributeValues: Record<string, unknown> }) => {
      const m = /^(\S+) = :m AND attribute_not_exists\((\S+)\)$/.exec(q.ConditionExpression ?? "");
      const item = table[k(q.Key)];
      if (!m) return {};
      const get = (path: string) => path.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], item);
      if (!item || get(m[1]!) !== q.ExpressionAttributeValues[":m"] || get(m[2]!) !== undefined) throw Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
      const parts = m[2]!.split(".");
      const holder = parts.length === 2 ? (item[parts[0]!] as Record<string, unknown>) : item;
      holder[parts.at(-1)!] = q.ExpressionAttributeValues[":t"];
      return {};
    });
  });

  it("retries a fresh claim delivery event that came before the claim record, then records it once", async () => {
    const now = new Date().toISOString();
    // The claim is reserved, but SES's id is not written yet.
    table["LOAD#4471|CLAIM"] = { pk: "LOAD#4471", sk: "CLAIM", status: "sending" };
    await expect(handler(event("detention_claim", "Delivery", "ses-claim-9", now), context)).rejects.toThrow(/before their email's record/);
    table["LOAD#4471|CLAIM"]!.sesMessageId = "ses-claim-9";
    await expect(handler(event("detention_claim", "Delivery", "ses-claim-9", now), context)).resolves.toBeUndefined();
    expect(table["LOAD#4471|CLAIM"]!.deliveredAt).toBe(now);
    // Redelivered again: nothing changes and nothing throws.
    await expect(handler(event("detention_claim", "Delivery", "ses-claim-9", now), context)).resolves.toBeUndefined();
  });

  it("retries an escalation event until its record exists, and drops a stale stray event", async () => {
    const now = new Date().toISOString();
    dynamo.on(QueryCommand).resolves({ Items: [] });
    await expect(handler(event("dispatch_escalation", "Bounce", "ses-esc-2", now), context)).rejects.toThrow(/retrying/);
    const old = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await expect(handler(event("dispatch_escalation", "Bounce", "ses-esc-3", old), context)).resolves.toBeUndefined();
    // A claim event for another email's id is not retried.
    table["LOAD#4471|CLAIM"] = { pk: "LOAD#4471", sk: "CLAIM", sesMessageId: "ses-claim-other" };
    await expect(handler(event("detention_claim", "Delivery", "ses-claim-9", now), context)).resolves.toBeUndefined();
  });

  it("emails dispatch once about a bounced notice, however often SES redelivers it", async () => {
    const now = new Date().toISOString();
    await expect(handler(event("detention_notice", "Bounce", "ses-notice-7", now), context)).rejects.toThrow(/retrying/);
    (table["LOAD#4471|META"]!.notice as Record<string, unknown>).messageId = "ses-notice-7";
    await handler(event("detention_notice", "Bounce", "ses-notice-7", now), context);
    await handler(event("detention_notice", "Bounce", "ses-notice-7", now), context);
    expect((table["LOAD#4471|META"]!.notice as Record<string, unknown>).bouncedAt).toBe(now);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
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

describe("dispatch escalation contact line", () => {
  it("gives the number and never suggests the channel that is failing", async () => {
    const { contactLine } = await import("../src/escalate.js");
    const phone = { address: { kind: "phone" as const, e164: "+15550100001" }, channel: "whatsapp" as const };
    expect(contactLine(phone, false)).toBe("Driver: +15550100001, on WhatsApp. Message them there or call them.");
    expect(contactLine(phone, true)).toBe("Driver: +15550100001. Messages are not getting through on WhatsApp; call them.");
    const bsuid = { address: { kind: "bsuid" as const, id: "US.1" }, channel: "whatsapp" as const };
    expect(contactLine(bsuid, true)).toBe("Driver: no phone number on file (WhatsApp shared only a business-scoped id), and messages are not getting through. Use the number in your driver records.");
    expect(contactLine(bsuid, false)).not.toContain("Message them on WhatsApp");
  });
});
