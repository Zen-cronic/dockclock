import { randomBytes } from "node:crypto";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById, isoToLocalDateTime } from "@dockclock/evidence";
import { buildMime, CARRIER_NAME, loadPageUrl, renderHtml, renderText, type Letter } from "@dockclock/mail";
import { scrubText } from "@dockclock/sanitize";
import { ddb, type LoadItem } from "./store.js";
import { env, log } from "./config.js";
import { keys } from "./keys.js";
import { reasonWords } from "./reasons.js";

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
    : "Driver: no phone number on file (WhatsApp shared only a business-scoped id). Use the number in your driver records; DockClock keeps messaging them in this load's chat.";
}

// The sealed pack's fields an escalation can mention: never the model's words.
export interface EscalationPack {
  confidence?: string;
  amountUsd?: number;
  reasons?: string[];
}

interface Topic {
  // After "Load X needs dispatch: " in the subject.
  subject: string;
  // The first line of the email: what happened and what to do.
  summary: string;
}

const EVIDENCE: Record<string, string> = {
  high: "the paperwork confirms the pins",
  medium: "pins only; the paperwork did not confirm them",
  low: "weak; a check failed or a pin is missing",
};
const LANGUAGE_NAMES: Record<string, string> = { en_US: "English", es_MX: "Spanish", fr_CA: "French" };

// The callers' reasons (Step Functions, the lifecycle, failover, SES) are written for logs. Dispatch
// gets a short subject and a first line that says what to do. An unknown reason is shown as is.
export function escalationTopic(reason: string, load: Pick<LoadItem, "loadId" | "clauseId">, pack: EscalationPack = {}): Topic {
  const amount = pack.amountUsd && pack.amountUsd > 0 ? `the $${pack.amountUsd.toFixed(2)} claim` : "the claim";
  const why = pack.reasons?.length ? reasonWords(pack.reasons, "en_US") : "";
  if (reason.startsWith("no approval within two days")) return { subject: "no approval in two days", summary: `Nobody approved or held ${amount} within two days, so nothing was sent. Review the load and send the claim yourself if it should still go.` };
  if (reason.startsWith("approved, but the claims agent did not file")) return { subject: "approved claim was not filed", summary: `You approved ${amount}, but the claims agent did not file it. Send it by hand.` };
  if (reason.startsWith("sealed as NEEDS_HUMAN")) return { subject: "review before any claim", summary: `The contract could not decide this load on its own${why ? `: ${why}` : ""}. Review the evidence pack before any claim.` };
  if (reason.startsWith("driver tapped Talk to dispatch")) return { subject: "driver asked for you", summary: "The driver tapped Talk to dispatch. Please contact them." };
  if (reason.startsWith("release Flow rejected")) return { subject: "paperwork not saved", summary: "The driver's bill of lading could not be saved after several tries. Get it from them another way." };
  if (reason.startsWith("some bill-of-lading pages could not be downloaded")) return { subject: "BOL pages missing", summary: "Some bill-of-lading pages could not be downloaded. Ask the driver for them." };
  if (reason.startsWith("the detention notice email bounced")) return { subject: "detention notice bounced", summary: `The detention notice email to ${clauseById(load.clauseId).counterparty} bounced. Send the notice another way before free time ends.` };
  if (reason.startsWith("RCS delivery failed") || reason.startsWith("WhatsApp delivery failed")) return { subject: "driver not reachable", summary: "DockClock can no longer message the driver, so they may not know what to do next. Call them." };
  return { subject: reason, summary: `Reason: ${reason}.` };
}

export function escalationEmail(load: LoadItem, reason: string, options: { unreachable?: boolean; pack?: EscalationPack } = {}): { subject: string; text: string; html: string } {
  const facility = facilityById(load.facilityId);
  const topic = escalationTopic(reason, load, options.pack);
  const at = (iso: string | undefined) => (iso ? isoToLocalDateTime(iso, facility.timeZone) : "not yet");
  const confidence = options.pack?.confidence;
  const amount = options.pack?.amountUsd && options.pack.amountUsd > 0 ? `$${options.pack.amountUsd.toFixed(2)}` : null;
  const capital = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
  const contact = capital(contactLine(load, options.unreachable === true).replace(/^Driver: /, ""));
  const subject = `Load ${load.loadId} needs dispatch: ${topic.subject}`;
  const link = loadPageUrl(load.loadId, load.ws);
  const letter: Letter = {
    kind: "Dispatch alert",
    summary: topic.summary,
    facts: [
      { label: "Load", value: load.loadId },
      { label: "Facility", value: facility.name },
      { label: "Arrived", value: at(load.arrived?.serverAt) },
      // When the clock stopped: the Released tap, or on older loads the release pin.
      { label: "Released", value: at(load.releasedTap?.serverAt ?? load.released?.serverAt) },
      // The amount once: in the first line when it names it, otherwise here.
      ...(amount && !topic.summary.includes(amount) ? [{ label: "Contract amount", value: amount, strong: true }] : []),
      ...(confidence ? [{ label: "Evidence", value: capital(EVIDENCE[confidence] ?? confidence) }] : []),
      { label: "Driver", value: contact },
      { label: "Driver's language", value: LANGUAGE_NAMES[load.language] ?? load.language },
    ],
    closing: "Please follow up on this load.",
    signature: [`DockClock, for the dispatch desk of ${CARRIER_NAME}`, "Sent automatically from the load's workflow."],
    links: link ? [{ label: "Open this load", href: link }] : [],
    notes: [],
  };
  return { subject, text: renderText(letter), html: renderHtml(letter, subject) };
}

// Tells a person at dispatch that a driver needs them. Email via SES, so the claim of
// "dispatch has been notified" in the driver's chat is backed by a real message. The stored reason
// is the caller's own (services/api/view.ts matches it), the email the plain version.
export async function notifyDispatch(load: LoadItem, reason: string, options: { unreachable?: boolean; pack?: EscalationPack } = {}): Promise<string | null> {
  const { subject, text, html } = escalationEmail(load, reason, options);
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
      // Raw MIME from the shared builder, like the notice and the claim: text and HTML alternatives,
      // the HTML with the brand mark as an inline part.
      Content: { Raw: { Data: Buffer.from(buildMime({ from: env.fromEmail(), to: env.dispatchEmail(), subject, text, html, date: new Date() })) } },
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
