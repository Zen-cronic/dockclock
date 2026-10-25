// Plain-language descriptions of stored load records, shared by the judge-desk exporter
// (scripts/desk) and the console read API, so both say the same thing about the same record.
import { createHash } from "node:crypto";
import { evaluate, releaseTimeOf, type ClauseSpec, type Evaluation, type LoadEvidence } from "@dockclock/clause-engine";
import { localClockToIso, type SignedPack } from "@dockclock/evidence";
import { scrub, scrubText } from "@dockclock/sanitize";
import { COPY, type Language } from "../src/messages.js";
import type { AgentRun, AgentToolCall, ClauseInfo, RunKind, ServiceTag, TimelineEvent, VerdictInfo } from "../../site/src/snapshot.js";

export type Item = Record<string, unknown>;

export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const obj = (v: unknown): Item => (v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {});
export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

export const toCents = (usd: number) => Math.round(usd * 100);
export const INBOUND_SERVICES: Record<string, ServiceTag[]> = {
  whatsapp: ["EUM Social", "SNS", "SQS", "Lambda", "DynamoDB"],
  rcs: ["EUM RCS", "SNS", "SQS", "Lambda", "DynamoDB"],
};

// A test load: flagged synthetic at dispatch, or a SMOKE- load from before the flag existed
// (2026-10-16 to 18), whose driver messages were synthetic all the same.
export function isSynthetic(meta: Item): boolean {
  return meta.synthetic === true || String(meta.loadId ?? "").startsWith("SMOKE-");
}

export function runKindOf(meta: Item, approval: Item | null): RunKind {
  if (meta.demo === true) return "demo";
  if (!isSynthetic(meta)) return "phone";
  return approval?.approver === "dispatcher-whatsapp" ? "operator" : "integration";
}

export function clauseInfo(clause: ClauseSpec): ClauseInfo {
  return {
    id: clause.id,
    freeTimeMinutes: clause.freeTimeMinutes,
    freeTimeAnchor: clause.freeTimeAnchor,
    requireOnTimeArrival: clause.requireOnTimeArrival,
    ratePerHourUsd: clause.ratePerHourUsd,
    capUsdPerOccurrence: clause.capUsdPerOccurrence,
    noticeLeadMinutes: clause.noticeLeadMinutes,
    acceptedRecords: [...clause.acceptedRecords],
    claimWindowHours: clause.claimWindowHours,
    shipperConfirmationRequired: clause.shipperConfirmationRequired,
    // Never the source document: it names a real company.
    basis:
      clause.id === "judge-demo"
        ? "DockClock judge demo clause, not modelled on any published terms."
        : `Modelled on published ${clause.role} terms. Values those terms do not state are DockClock assumptions.`,
  };
}

export function buttonAction(payload: string | null): string | null {
  return payload?.startsWith("dc1.") ? (payload.split(".")[1] ?? null) : null;
}

export function tapTitle(action: string | null, language: Language): string {
  const copy = COPY[language];
  switch (action) {
    case "arrived":
      return copy.rcs.arrived;
    case "released":
      return copy.released;
    case "dispatch":
      return copy.talkToDispatch;
    case "approve":
      return "Approve claim";
    case "hold":
      return "Hold";
    default:
      return "a button";
  }
}

export function inboundTitle(type: string, outcome: string, action: string | null): { title: string; tone: TimelineEvent["tone"] } {
  const refused = /^(REJECTED|IGNORED)/.test(outcome);
  if (type === "button") {
    const name = action ? action[0]!.toUpperCase() + action.slice(1) : "A button";
    if (outcome === "REJECTED_OUT_OF_ORDER") return { title: `${name} tapped out of order: refused`, tone: "refused" };
    if (outcome === "REJECTED_STALE_BUTTON") return { title: `${name} tapped on an old message: refused`, tone: "refused" };
    if (outcome === "IGNORED_DUPLICATE_TAP") return { title: `${name} tapped again: ignored`, tone: "refused" };
    if (action === "released" && outcome === "ADVANCED") return { title: "Driver tapped Released: the dock clock stopped", tone: "neutral" };
    return { title: `Driver tapped ${name}`, tone: refused ? "refused" : "neutral" };
  }
  if (type === "location") return { title: refused ? "Location received but not used" : "Driver shared a location", tone: refused ? "refused" : "neutral" };
  if (type === "flow") return { title: refused ? "Bill of lading form not accepted" : "Bill of lading form submitted", tone: refused ? "refused" : "neutral" };
  if (type === "image") return { title: refused ? "Photo received but not used" : "Driver sent a photo", tone: refused ? "refused" : "neutral" };
  if (type === "failover") return { title: "WhatsApp delivery failed: switched to RCS", tone: "refused" };
  if (type === "text") return { title: "Driver sent a text", tone: "neutral" };
  return { title: `Driver message (${type})`, tone: refused ? "refused" : "neutral" };
}

export const PURPOSE_WORDS: Record<string, string> = {
  dispatch_template: "the load dispatch",
  dispatch_card: "the load dispatch card",
  location_request: "a location request",
  checked_in: "the check-in confirmation with Released",
  release_flow: "the bill of lading form",
  notice_sent: "word that the detention notice was emailed",
  dispatch_approval: "the claim to dispatch for approval",
  approval_reply: "the approval confirmation",
  demo_intro: "the demo introduction",
  location_arrived: "a request for the arrival location",
  location_released: "a request for the release location",
  offer_release: "the check-in confirmation with Released",
  ask_retake: "a request for a clearer photo",
  outcome_verdict: "the contract's verdict to the driver",
  outcome_filed: "word that the claim was filed",
  opt_out: "the STOP confirmation",
  opt_in: "the START confirmation",
  claim_receipt: "the PDF claim summary",
};

// Plain words for a send purpose; replies to the driver (tell_<key>) read as one kind.
export function purposeWords(purpose: string): string {
  if (PURPOSE_WORDS[purpose]) return PURPOSE_WORDS[purpose]!;
  if (purpose.startsWith("tell_")) return "a reply to the driver";
  return purpose.replace(/_/g, " ");
}

export function verdictWords(verdict: string): string {
  return verdict === "BILLABLE" ? "billable" : verdict === "NOT_BILLABLE" ? "not billable" : "needs a person";
}

export function toolSummary(name: string, result: Item, status: string | null): { ok: boolean; summary: string } {
  if (typeof result.refused === "string") return { ok: false, summary: `Refused: ${result.refused}` };
  if (result.policyDenied === true) return { ok: false, summary: "Denied by the Gateway's Cedar policy." };
  if (typeof result.error === "string") return { ok: false, summary: `Error: ${result.error}` };
  if (status === "error") return { ok: false, summary: "The tool call failed." };
  // "Filed" only when the tool says the email was sent; anything else from the claim tool is not a filing.
  if (name === "send_detention_claim") return result.sent === true ? { ok: true, summary: "Email accepted by SES; claim recorded as sent." } : { ok: false, summary: "Not filed: the claim tool did not report the email sent." };
  if (name === "get_load_evidence") {
    const amount = typeof result.amountUsd === "number" ? `, $${result.amountUsd.toFixed(2)}` : "";
    const approved = result.approved === true ? "dispatch approved" : "no dispatch approval";
    return { ok: true, summary: `Sealed ${String(result.verdict ?? "unknown")}${amount}, ${approved}.` };
  }
  if (name === "read_bill_of_lading") {
    const reading = obj(result.reading);
    return { ok: true, summary: reading.legible === true ? "Photo readable." : reading.legible === false ? "Photo not readable." : "Photo read." };
  }
  return { ok: true, summary: "Done." };
}

export function shortInput(input: unknown): Record<string, unknown> {
  const out = obj(scrub(input));
  if (typeof out.body === "string" && out.body.length > 240) out.body = "(the email body, shown in the mailbox)";
  return out;
}

export function modelName(modelId: string | null): string {
  if (modelId?.includes("claude-sonnet-4-5")) return "Claude Sonnet 4.5 on Amazon Bedrock AgentCore";
  return modelId ? `${modelId} on Amazon Bedrock AgentCore` : "Amazon Bedrock AgentCore";
}

export function addressOnly(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}

// The load's claims-agent runs (AGENT# records), oldest first, as a reviewer reads them. `sealed`
// adds the amount-and-digest guard on a send_detention_claim call.
export function agentRunsOf(items: Item[], sealed: { cents: number; digest: string } | null): AgentRun[] {
  return items
    .filter((i) => String(i.sk).startsWith("AGENT#"))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
    .map((r, index) => {
      const calls = (Array.isArray(r.toolCalls) ? r.toolCalls : []).map(obj);
      const toolCalls: AgentToolCall[] = calls.map((c) => {
        const name = String(c.name ?? "").replace(/^.*___/, "");
        const result = obj(c.result);
        const denied = result.policyDenied === true;
        return {
          name,
          input: shortInput(c.input),
          cedar: {
            decision: denied ? "deny" : "permit",
            policy: name === "send_detention_claim" ? "The claim tool needs an approval id and 0 < amount ≤ $5,000.00 (in cents)." : "Read tools are always allowed.",
            decisionSource: denied ? "recorded" : "inferred",
          },
          result: toolSummary(name, result, str(c.status)),
        };
      });
      const claimCall = calls.find((c) => String(c.name).endsWith("send_detention_claim"));
      const input = obj(claimCall?.input);
      const startedAt = String(r.startedAt);
      return {
        id: `a${index + 1}`,
        task: r.task === "review" ? "review" : "file_claim",
        startedAt,
        ...(typeof r.durationMs === "number" ? { endedAt: new Date(Date.parse(startedAt) + r.durationMs).toISOString() } : {}),
        model: modelName(str(r.modelId)),
        ...(str(r.stopReason) ? { stopReason: String(r.stopReason) } : {}),
        toolCalls,
        ...(claimCall && sealed
          ? {
              guard: {
                amountCentsSent: Number(input.amountCents),
                amountCentsSealed: sealed.cents,
                digestSent: String(input.packDigest ?? ""),
                digestSealed: sealed.digest,
                match: Number(input.amountCents) === sealed.cents && input.packDigest === sealed.digest,
              },
            }
          : {}),
        ...(str(r.finalText) ? { text: scrubText(String(r.finalText)) } : str(r.error) ? { text: `The run failed: ${scrubText(String(r.error))}` } : {}),
        provenance: "recorded",
      } satisfies AgentRun;
    });
}

// The page's contract has no field for the release pin's own time yet, so it rides alongside:
// present only on packs (version 2) whose clock was stopped by the Released tap.
export type EngineInput = VerdictInfo["engineInput"] & { releasePinAt?: string };

// The Released tap's time on a version 2 pack; null on a version 1 pack (or a load recorded before
// the tap was kept), whose release is the pin.
export function releaseTapOf(signed: SignedPack): string | null {
  return signed.pack.events.releasedTap?.serverAt ?? null;
}

// The clause engine's inputs, rebuilt the way sealing builds them, so a page can re-run them. On a
// pack with a Released tap, `released.at` is the tap (when the clock stopped) and `releasePinAt` the
// pin that confirmed it, exactly as toLoadEvidence builds them; an old pack's release is its pin.
export function engineInputOf(meta: Item, signed: SignedPack, timeZone: string): EngineInput {
  const pinOf = (pin: Item | null, signal: string) => {
    if (!pin || !str(pin.serverAt)) return null;
    const s = signed.pack.corroboration.signals.find((x) => x.name === signal);
    return { at: String(pin.serverAt), insideGeofence: s?.ok ?? false };
  };
  const bol = obj(meta.bol);
  const metaArrived = meta.arrived ? obj(meta.arrived) : null;
  const metaReleased = meta.released ? obj(meta.released) : null;
  const packBol = signed.pack.events.bol;
  const tapAt = releaseTapOf(signed);
  const releasePin = pinOf(metaReleased, "released_pin_in_geofence");
  const released = releasePin && tapAt ? { ...releasePin, at: tapAt } : releasePin;
  const releaseAt = releaseTimeOf({ releasedTap: signed.pack.events.releasedTap, released: metaReleased });
  return {
    appointmentAt: String(meta.appointmentAt),
    arrived: pinOf(metaArrived, "arrived_pin_in_geofence"),
    released,
    ...(releasePin && tapAt ? { releasePinAt: releasePin.at } : {}),
    bol: packBol
      ? {
          signed: bol.channel !== "rcs" && bol.receiverSigned === true,
          checkIn: bol.channel === "rcs" ? null : localClockToIso(str(bol.inTime), str(metaArrived?.serverAt) ?? packBol.serverAt, timeZone),
          checkOut: bol.channel === "rcs" ? null : localClockToIso(str(bol.outTime), releaseAt ?? packBol.serverAt, timeZone),
        }
      : null,
    status214: false,
    noticeSentAt: signed.pack.events.notice?.sentAt ?? null,
    shipperConfirmed: false,
    evaluatedAt: signed.pack.sealedAt,
  };
}

// The rebuilt inputs must give the sealed verdict and amount, or the "change one fact" view would lie.
export function checkEngineInput(input: EngineInput, ctx: { loadId: string; clause: ClauseSpec; facilityName: string; evaluation: Evaluation }): void {
  const recomputed = evaluate({ loadId: ctx.loadId, clauseId: ctx.clause.id, facility: ctx.facilityName, ...input } as LoadEvidence, ctx.clause);
  if (recomputed.verdict !== ctx.evaluation.verdict || recomputed.amountUsd !== ctx.evaluation.amountUsd) {
    throw new Error(`rebuilt engine inputs give ${recomputed.verdict} $${recomputed.amountUsd}, but the pack says ${ctx.evaluation.verdict} $${ctx.evaluation.amountUsd}`);
  }
}

// What each claim attachment is, for the console's Emails tab.
export function attachmentNote(a: { name: string; contentType: string }): string {
  if (a.name.endsWith(".pem")) return "The public key to check the signature.";
  if (a.contentType === "application/pdf") return "The one-page claim summary, as sent.";
  if (a.contentType === "application/json") return "The signed evidence pack, exactly as sealed.";
  return "";
}

// Claims sent before 2026-10-23 named the KMS key in their footer; the console removes it.
export function claimBodyNote(rawText: string): string {
  return /arn:aws/.test(rawText) ? "The sent email's bytes, kept with the load's packs. The AWS key name in the footer is removed." : "The sent email's bytes, kept with the load's packs. Its plain-text part is shown.";
}
