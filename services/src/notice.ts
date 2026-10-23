import { ConflictException, CreateScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context, SNSEvent } from "aws-lambda";
import { clauseById, detentionStartsAt } from "@dockclock/clause-engine";
import { acceptsAnyLocation, checkGeofence, facilityById, isoToLocalClock, isoToLocalDateTime, zoneAbbreviation } from "@dockclock/evidence";
import { buildMime, FICTIONAL_NOTE, loadPageUrl, pinSource, renderHtml, renderText, signatureLines, type Letter } from "@dockclock/mail";
import { ddb, getLoad, type LoadItem } from "./store.js";
import { send, sendRcs, type Body } from "./sender.js";
import { rcsText } from "./rcs.js";
import { COPY, type Language } from "./messages.js";
import { notifyDispatch } from "./escalate.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";
import { emailKey } from "./mime.js";

const scheduler = new SchedulerClient({ maxAttempts: 3 });
const ses = new SESv2Client({ maxAttempts: 3 });
const s3 = new S3Client({ maxAttempts: 3 });

export const TEMPLATE_NOTICE_SENT = "dockclock_notice_sent";
// Sent this long before the clause's own lead time, so a slow delivery still meets the deadline.
export const NOTICE_MARGIN_MINUTES = 10;
const MINUTE = 60_000;

// When the notice goes out: the clause's lead time (none means "before detention starts") plus the
// margin, before the detention clock starts. Never in the past.
export function noticeTime(load: Pick<LoadItem, "clauseId" | "appointmentAt">, arrivedAt: string, now = Date.now()): { sendAt: string; detentionStartAt: string } {
  const clause = clauseById(load.clauseId);
  const detentionStartAt = detentionStartsAt(clause, load.appointmentAt, arrivedAt);
  const lead = (clause.noticeLeadMinutes ?? 0) + NOTICE_MARGIN_MINUTES;
  const sendAt = Math.max(Date.parse(detentionStartAt) - lead * MINUTE, now + MINUTE);
  return { sendAt: new Date(sendAt).toISOString(), detentionStartAt };
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html: string;
}

export function noticeEmail(load: LoadItem, detentionStartAt: string, from = process.env.CLAIMS_FROM_EMAIL ?? "", replyTo = process.env.DISPATCH_EMAIL): ComposedEmail {
  const clause = clauseById(load.clauseId);
  const facility = facilityById(load.facilityId);
  // A full local date, time and zone in the body: the notice is evidence, and after 20:00 Eastern
  // the UTC date has already turned. The subject carries the clock time and zone only.
  const at = (iso: string) => isoToLocalDateTime(iso, facility.timeZone);
  const ends = `${isoToLocalClock(detentionStartAt, facility.timeZone)} ${zoneAbbreviation(detentionStartAt, facility.timeZone)}`;
  const anyLocation = acceptsAnyLocation(facility);
  const pin = load.arrived!;
  // Checked here, not assumed: the notice goes out before sealing, so a pin outside the fence is
  // still possible. A test load's pins are synthetic, so it never claims a platform's server time.
  const inside = typeof pin.lat === "number" && typeof pin.lon === "number" ? checkGeofence([pin.lon, pin.lat], facility).inside : null;
  const source = pinSource({ synthetic: load.synthetic === true, channel: load.channel, anyLocation, insideGeofence: inside, pins: 1 });
  const subject = `Detention notice: Load ${load.loadId} at ${facility.name}, free time ends ${ends}`;
  const link = loadPageUrl(load.loadId, load.ws);
  const letter: Letter = {
    kind: "Detention notice",
    salutation: `Dear ${clause.counterparty},`,
    summary: `This is notice that load ${load.loadId} is still at the dock at ${facility.name}. When free time ends, detention accrues under your terms.`,
    facts: [
      { label: "Load", value: load.loadId },
      { label: "Facility", value: facility.name },
      { label: "Checked in", value: at(pin.serverAt) },
      { label: "Source", value: source },
      { label: "Free time ends", value: at(detentionStartAt), strong: true },
      { label: "Detention rate", value: `$${clause.ratePerHourUsd.toFixed(2)} per hour` },
    ],
    closing: "Please release the truck, or tell us why the clock should not run.",
    signature: signatureLines(from, replyTo),
    links: link ? [{ label: "View this load", href: link }] : [],
    notes: ["Any claim will include the signed evidence pack.", FICTIONAL_NOTE],
  };
  return { subject, text: renderText(letter), html: renderHtml(letter, subject) };
}

function noticeSentTemplate(language: Language, loadId: string, freeTimeEnds: string, counterparty: string): Body {
  return {
    type: "template",
    template: {
      name: TEMPLATE_NOTICE_SENT,
      language: { code: language },
      components: [{ type: "body", parameters: [loadId, freeTimeEnds, counterparty].map((text) => ({ type: "text", text })) }],
    },
  };
}

// Step Functions, right after the Arrived pin: one schedule per load, deleted after it runs.
async function schedule(loadId: string, functionArn: string): Promise<{ scheduledFor: string | null }> {
  const load = await getLoad(loadId);
  if (!load?.arrived) return { scheduledFor: null };
  const { sendAt } = noticeTime(load, load.arrived.serverAt);
  try {
    await scheduler.send(
      new CreateScheduleCommand({
        Name: `notice-${loadId}`,
        GroupName: env.scheduleGroup(),
        ScheduleExpression: `at(${sendAt.slice(0, 19)})`,
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        ActionAfterCompletion: "DELETE",
        Target: { Arn: functionArn, RoleArn: env.schedulerRoleArn(), Input: JSON.stringify({ kind: "send", loadId }) },
      }),
    );
  } catch (error) {
    // A retried workflow step: the schedule already exists.
    if (!(error instanceof ConflictException)) throw error;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: env.table(),
      Key: keys.load(loadId),
      UpdateExpression: "SET notice = if_not_exists(notice, :n)",
      ExpressionAttributeValues: { ":n": { scheduledFor: sendAt } },
    }),
  );
  log("notice_scheduled", { loadId, sendAt });
  return { scheduledFor: sendAt };
}

// EventBridge Scheduler, before free time ends: email the counterparty, then tell the driver.
async function sendNotice(loadId: string): Promise<{ sent: boolean }> {
  const load = await getLoad(loadId);
  if (!load?.arrived) return { sent: false };
  const skip = async (why: string) => {
    await ddb.send(new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "SET notice.skipped = :w", ConditionExpression: "attribute_exists(notice)", ExpressionAttributeValues: { ":w": why } }));
    log("notice_skipped", { loadId, why });
    return { sent: false };
  };
  // The clock stops at the Released tap, so no notice goes out after it, even before the pin comes.
  if (load.releasedTap || load.released) return skip("The driver tapped Released before the notice was due.");
  if (load.phase === "sealed" || load.phase === "closed") return skip(`load ${load.phase}`);
  if (load.notice?.sentAt) return { sent: false };
  const clause = clauseById(load.clauseId);
  const { detentionStartAt } = noticeTime(load, load.arrived.serverAt);
  const replyTo = process.env.DISPATCH_EMAIL;
  const { subject, text, html } = noticeEmail(load, detentionStartAt, env.claimsFromEmail(), replyTo);
  const sentAt = new Date().toISOString();
  // Reserve first, so a redelivered schedule cannot email twice.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: keys.load(loadId),
        UpdateExpression: "SET notice.sentAt = :t",
        ConditionExpression: "attribute_exists(notice) AND attribute_not_exists(notice.sentAt)",
        ExpressionAttributeValues: { ":t": sentAt },
      }),
    );
  } catch (error) {
    if ((error as Error).name === "ConditionalCheckFailedException") return { sent: false };
    throw error;
  }
  // Raw MIME built here rather than by SES, so the stored copy is byte-for-byte what was sent.
  const to = env.counterpartyEmail(clause.role);
  const raw = buildMime({ from: env.claimsFromEmail(), to, replyTo, subject, text, html, date: new Date(sentAt) });
  let messageId: string | undefined;
  try {
    const out = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: env.claimsFromEmail(),
        Destination: { ToAddresses: [to] },
        ConfigurationSetName: env.configurationSet(),
        Content: { Raw: { Data: Buffer.from(raw, "utf8") } },
        EmailTags: [
          { Name: "purpose", Value: "detention_notice" },
          { Name: "loadId", Value: loadId },
        ],
      }),
    );
    messageId = out.MessageId;
  } catch (error) {
    await ddb.send(new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "REMOVE notice.sentAt" }));
    throw error;
  }
  await ddb.send(new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "SET notice.messageId = :m", ExpressionAttributeValues: { ":m": messageId } }));
  log("notice_sent", { loadId, messageId, detentionStartAt });
  await storeNoticeEmail(loadId, raw);

  const facility = facilityById(load.facilityId);
  const language: Language = load.language ?? "en_US";
  const ends = `${isoToLocalClock(detentionStartAt, facility.timeZone)} ${zoneAbbreviation(detentionStartAt, facility.timeZone)}`;
  const target = { address: load.address, driverKey: load.driverKey };
  if (load.channel === "rcs") await sendRcs(target, rcsText(COPY[language].noticeSent(load.loadId, ends, clause.counterparty)), "notice_sent", loadId);
  else await send(target, noticeSentTemplate(language, load.loadId, ends, clause.counterparty), "notice_sent", loadId);
  return { sent: true };
}

// The sent notice's bytes, kept with the load's packs. The email is already out, so a failure to
// keep the copy is logged and does not fail the step (a retry would find the notice sent).
async function storeNoticeEmail(loadId: string, raw: string): Promise<void> {
  const key = emailKey(loadId, "notice");
  try {
    await s3.send(new PutObjectCommand({ Bucket: env.bucket(), Key: key, Body: raw, ContentType: "message/rfc822" }));
    await ddb.send(new UpdateCommand({ TableName: env.table(), Key: keys.load(loadId), UpdateExpression: "SET notice.mimeKey = :k", ExpressionAttributeValues: { ":k": key } }));
  } catch (error) {
    log("notice_email_unstored", { loadId, error: (error as Error).name });
  }
}

interface SesEvent {
  eventType: "Delivery" | "Bounce" | "Complaint" | "Reject" | string;
  mail: { messageId: string; tags?: Record<string, string[]> };
  delivery?: { timestamp: string };
  bounce?: { timestamp: string };
}

// SES delivery events. A delivered notice becomes evidence; a bounced one goes to a person. The
// claim and dispatch escalation emails get their delivery or bounce time recorded too, matched by
// SES message id so a stray event never marks the wrong email.
async function onSesEvents(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const ses = JSON.parse(record.Sns.Message) as SesEvent;
    const purpose = ses.mail.tags?.purpose?.[0];
    const loadId = ses.mail.tags?.loadId?.[0];
    if (!loadId) continue;
    const field = ses.eventType === "Delivery" ? "deliveredAt" : ses.eventType === "Bounce" ? "bouncedAt" : null;
    if (!field) continue;
    const at = ses.delivery?.timestamp ?? ses.bounce?.timestamp ?? record.Sns.Timestamp;
    if (purpose === "detention_claim") {
      if (await markDelivery(keys.claim(loadId), field, at, "sesMessageId", ses.mail.messageId)) log(`claim_email_${field === "deliveredAt" ? "delivered" : "bounced"}`, { loadId, messageId: ses.mail.messageId });
      continue;
    }
    if (purpose === "dispatch_escalation") {
      const found = await ddb.send(
        new QueryCommand({
          TableName: env.table(),
          KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
          FilterExpression: "sesMessageId = :m",
          ExpressionAttributeValues: { ":p": `LOAD#${loadId}`, ":s": "EMAIL#escalation#", ":m": ses.mail.messageId },
        }),
      );
      const item = found.Items?.[0] as { pk: string; sk: string } | undefined;
      if (item && (await markDelivery({ pk: item.pk, sk: item.sk }, field, at, "sesMessageId", ses.mail.messageId))) log(`escalation_${field === "deliveredAt" ? "delivered" : "bounced"}`, { loadId, messageId: ses.mail.messageId });
      continue;
    }
    if (purpose !== "detention_notice") continue;
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: env.table(),
          Key: keys.load(loadId),
          UpdateExpression: `SET notice.${field} = if_not_exists(notice.${field}, :t)`,
          ConditionExpression: "notice.messageId = :m",
          ExpressionAttributeValues: { ":t": at, ":m": ses.mail.messageId },
        }),
      );
    } catch (error) {
      if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
      continue;
    }
    log(`notice_${field === "deliveredAt" ? "delivered" : "bounced"}`, { loadId, messageId: ses.mail.messageId });
    if (field === "bouncedAt") {
      const load = await getLoad(loadId);
      if (load) await notifyDispatch(load, "the detention notice email bounced; send notice another way");
    }
  }
}

// Sets deliveredAt or bouncedAt once on the record whose message id matches. False when it does not.
async function markDelivery(key: { pk: string; sk: string }, field: "deliveredAt" | "bouncedAt", at: string, idField: string, messageId: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: env.table(),
        Key: key,
        UpdateExpression: `SET ${field} = if_not_exists(${field}, :t)`,
        ConditionExpression: `${idField} = :m`,
        ExpressionAttributeValues: { ":t": at, ":m": messageId },
      }),
    );
    return true;
  } catch (error) {
    if ((error as Error).name !== "ConditionalCheckFailedException") throw error;
    return false;
  }
}

type NoticeInput = { kind: "schedule"; loadId: string } | { kind: "send"; loadId: string } | SNSEvent;

export async function handler(input: NoticeInput, context: Context): Promise<unknown> {
  if ("Records" in input) return onSesEvents(input);
  if (input.kind === "schedule") return schedule(input.loadId, context.invokedFunctionArn);
  return sendNotice(input.loadId);
}
