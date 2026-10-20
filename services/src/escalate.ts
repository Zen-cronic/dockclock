import { randomBytes } from "node:crypto";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { facilityById } from "@dockclock/evidence";
import { scrubText } from "@dockclock/sanitize";
import { ddb, type LoadItem } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";

const ses = new SESv2Client({ maxAttempts: 3 });

// How dispatch can reach the driver. The dispatcher works for the carrier, so the driver's own number
// is given. "unreachable" comes from the failover path (messages to the driver are failing), never
// from reading the reason's wording, so the email does not point dispatch back at a failing channel.
export function contactLine(load: Pick<LoadItem, "address" | "channel">, unreachable: boolean): string {
  const channel = load.channel === "rcs" ? "RCS" : "WhatsApp";
  if (load.address.kind === "phone") {
    return unreachable ? `Driver: ${load.address.e164}. Messages are not getting through on ${channel}; call them.` : `Driver: ${load.address.e164}, on ${channel}. Message them there or call them.`;
  }
  // WhatsApp shared only a business-scoped id, so DockClock has no number to give.
  return unreachable
    ? "Driver: no phone number on file (WhatsApp shared only a business-scoped id), and messages are not getting through. Use the number in your driver records."
    : "Driver: no phone number on file (WhatsApp shared only a business-scoped id). DockClock keeps messaging them in this load's thread; to talk to them directly, use the number in your driver records.";
}

// Tells a person at dispatch that a driver needs them. Email via SES, so the claim of
// "dispatch has been notified" in the driver's chat is backed by a real message.
export async function notifyDispatch(load: LoadItem, reason: string, options: { unreachable?: boolean } = {}): Promise<string | null> {
  const facility = facilityById(load.facilityId);
  const subject = `DockClock: load ${load.loadId} needs dispatch (${reason})`;
  const text = [
    `Load ${load.loadId} at ${facility.name} needs a person.`,
    `Reason: ${reason}.`,
    `Phase: ${load.phase}. Driver language: ${load.language}.`,
    `Arrived pin: ${load.arrived?.serverAt ?? "none"}. Released pin: ${load.released?.serverAt ?? "none"}.`,
    contactLine(load, options.unreachable === true),
  ].join("\n");
  if (load.synthetic) {
    log("dispatch_notify_skipped", { loadId: load.loadId, reason, why: "synthetic test load" });
    await recordEscalation(load.loadId, { subject, text, reason, notSentReason: "Not sent: test loads never email dispatch." });
    return null;
  }
  const out = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: env.fromEmail(),
      Destination: { ToAddresses: [env.dispatchEmail()] },
      ConfigurationSetName: env.configurationSet(),
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      EmailTags: [
        { Name: "purpose", Value: "dispatch_escalation" },
        { Name: "loadId", Value: load.loadId },
      ],
    }),
  );
  log("dispatch_notified", { loadId: load.loadId, reason, sesMessageId: out.MessageId });
  await recordEscalation(load.loadId, { subject, text, reason, ...(out.MessageId ? { sesMessageId: out.MessageId } : {}) });
  return out.MessageId ?? null;
}

// The escalation as a record on its load, for the console: the subject and text DockClock composed
// with the driver's contact removed (dispatch's copy keeps it; dispatch works for the carrier). SES
// delivery events later add deliveredAt or bouncedAt. Best effort: the email is what matters.
async function recordEscalation(loadId: string, email: { subject: string; text: string; reason: string; sesMessageId?: string; notSentReason?: string }): Promise<void> {
  const sentAt = new Date().toISOString();
  const id = email.sesMessageId ?? `not-sent-${randomBytes(6).toString("hex")}`;
  try {
    await ddb.send(
      new PutCommand({
        TableName: env.table(),
        Item: {
          ...keys.escalationEmail(loadId, sentAt, id),
          kind: "email",
          purpose: "dispatch_escalation",
          sentAt,
          subject: scrubText(email.subject),
          text: scrubText(email.text),
          reason: scrubText(email.reason),
          ...(email.sesMessageId ? { sesMessageId: email.sesMessageId } : { status: "not_sent", notSentReason: email.notSentReason }),
        },
      }),
    );
  } catch (error) {
    log("escalation_unrecorded", { loadId, error: (error as Error).name });
  }
}
