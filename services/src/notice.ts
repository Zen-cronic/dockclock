import { ConflictException, CreateScheduleCommand, SchedulerClient } from "@aws-sdk/client-scheduler";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { Context, SNSEvent } from "aws-lambda";
import { clauseById, detentionStartsAt } from "@dockclock/clause-engine";
import { facilityById, isoToLocalClock, isoToLocalDateTime, zoneAbbreviation } from "@dockclock/evidence";
import { ddb, getLoad, type LoadItem } from "./store.js";
import { send, sendRcs, type Body } from "./sender.js";
import { rcsText } from "./rcs.js";
import { COPY, type Language } from "./messages.js";
import { notifyDispatch } from "./escalate.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const scheduler = new SchedulerClient({ maxAttempts: 3 });
const ses = new SESv2Client({ maxAttempts: 3 });

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

export function noticeEmail(load: LoadItem, detentionStartAt: string): { subject: string; text: string } {
  const clause = clauseById(load.clauseId);
  const facility = facilityById(load.facilityId);
  // A full local date, time and zone: the notice is evidence, and after 20:00 Eastern the UTC date
  // has already turned.
  const at = (iso: string) => isoToLocalDateTime(iso, facility.timeZone);
  const subject = `Detention notice: load ${load.loadId} at ${facility.name}`;
  const text = [
    `To ${clause.counterparty},`,
    "",
    `This is notice that load ${load.loadId} is still waiting at ${facility.name}.`,
    `The truck checked in at ${at(load.arrived!.serverAt)}, recorded by a location pin with a WhatsApp server timestamp inside the facility's geofence.`,
    `Free time under the rate confirmation ends at ${at(detentionStartAt)}. From then, detention accrues at $${clause.ratePerHourUsd.toFixed(2)} per hour under your terms.`,
    "Please release the truck or tell us of any reason the clock should not run.",
    "",
    "Sent automatically by DockClock for the carrier. The signed evidence pack follows with any claim.",
  ].join("\n");
  return { subject, text };
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
  if (load.released) return skip("released before free time ended");
  if (load.phase === "sealed" || load.phase === "closed") return skip(`load ${load.phase}`);
  if (load.notice?.sentAt) return { sent: false };
  const clause = clauseById(load.clauseId);
  const { detentionStartAt } = noticeTime(load, load.arrived.serverAt);
  const { subject, text } = noticeEmail(load, detentionStartAt);
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
  let messageId: string | undefined;
  try {
    const out = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: env.claimsFromEmail(),
        Destination: { ToAddresses: [env.counterpartyEmail(clause.role)] },
        ConfigurationSetName: env.configurationSet(),
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
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

  const facility = facilityById(load.facilityId);
  const language: Language = load.language ?? "en_US";
  const ends = `${isoToLocalClock(detentionStartAt, facility.timeZone)} ${zoneAbbreviation(detentionStartAt, facility.timeZone)}`;
  const target = { address: load.address, driverKey: load.driverKey };
  if (load.channel === "rcs") await sendRcs(target, rcsText(COPY[language].noticeSent(load.loadId, ends, clause.counterparty)), "notice_sent", loadId);
  else await send(target, noticeSentTemplate(language, load.loadId, ends, clause.counterparty), "notice_sent", loadId);
  return { sent: true };
}

interface SesEvent {
  eventType: "Delivery" | "Bounce" | "Complaint" | "Reject" | string;
  mail: { messageId: string; tags?: Record<string, string[]> };
  delivery?: { timestamp: string };
  bounce?: { timestamp: string };
}

// SES delivery events: a delivered notice becomes evidence; a bounced one goes to a person.
async function onSesEvents(event: SNSEvent): Promise<void> {
  for (const record of event.Records) {
    const ses = JSON.parse(record.Sns.Message) as SesEvent;
    if (ses.mail.tags?.purpose?.[0] !== "detention_notice") continue;
    const loadId = ses.mail.tags.loadId?.[0];
    if (!loadId) continue;
    const field = ses.eventType === "Delivery" ? "deliveredAt" : ses.eventType === "Bounce" ? "bouncedAt" : null;
    if (!field) continue;
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: env.table(),
          Key: keys.load(loadId),
          UpdateExpression: `SET notice.${field} = if_not_exists(notice.${field}, :t)`,
          ConditionExpression: "notice.messageId = :m",
          ExpressionAttributeValues: { ":t": ses.delivery?.timestamp ?? ses.bounce?.timestamp ?? record.Sns.Timestamp, ":m": ses.mail.messageId },
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

type NoticeInput = { kind: "schedule"; loadId: string } | { kind: "send"; loadId: string } | SNSEvent;

export async function handler(input: NoticeInput, context: Context): Promise<unknown> {
  if ("Records" in input) return onSesEvents(input);
  if (input.kind === "schedule") return schedule(input.loadId, context.invokedFunctionArn);
  return sendNotice(input.loadId);
}
