// Builds the console read API's views (site/src/api.ts, dockclock.api/1) from one load's stored
// records. Pure: handler.ts reads AWS and passes the records in. Unlike the desk exporter it works
// from dispatch onwards: everything that needs the sealed pack is null until the load is sealed.
// Every string that came from a stored record is scrubbed; handler.ts still runs findLeaks on the
// whole response before it is sent.
import { clauseById, detentionStartsAt, RELEASE_PIN_WINDOW_MINUTES, releasePinCheck, releasePinGapWords, releaseTimeOf, RUN_LABELS, timeReadable, type ClauseSpec } from "@dockclock/clause-engine";
import { canonicalJson, checkGeofence, facilityById, isoToLocalClock, zoneAbbreviation, type Facility, type SignedPack } from "@dockclock/evidence";
import { parseMime, scrub, scrubText, type ParsedEmail } from "@dockclock/sanitize";
import type { Language } from "../src/messages.js";
import type {
  ApiMessage,
  ApiTimelineEvent,
  ApprovalInfo,
  ClaimInfo,
  DriverChannel,
  EmailInfo,
  EmailView,
  LiveClock,
  LoadStatus,
  LoadSummary,
  LoadView,
  MessageAction,
  MessageKind,
  MessageStatus,
  PackSummary,
  Phase,
  PhotoInfo,
  Provenance,
  RunInfo,
  RunKind,
  SignedPackInfo,
  VerdictInfo,
  WorkflowStep,
} from "../../site/src/api.js";
import {
  addressOnly,
  agentRunsOf,
  agentStartedAt,
  attachmentNote,
  claimBodyNote,
  isSynthetic,
  buttonAction,
  checkEngineInput,
  clauseInfo,
  DEMO_PHOTO_NOTE,
  engineInputOf,
  INBOUND_SERVICES,
  inboundTitle,
  isPrivateDemo,
  obj,
  purposeWords,
  runKindOf,
  sha256,
  shownInboundEvent,
  shownInboundText,
  str,
  tapTitle,
  toCents,
  verdictWords,
  type Item,
} from "./describe.js";

export interface LoadSources {
  // Every item in the load's partition (one Query on LOAD#<id>).
  items: Item[];
  // MSG#<messageId> receipts of the load's sends, by message id.
  receipts: Record<string, Item>;
  // The sealed pack file, once sealed.
  signedPack: SignedPack | null;
  // Raw MIME of the stored notice and claim emails, when kept.
  emails: { notice?: string; claim?: string };
  // What each stored photo really is, by page (from the first bytes of the object): an image type,
  // or null when the object is missing or not an image.
  photoTypes: Record<number, "image/jpeg" | "image/png" | null>;
  // SPKI sha256 of the evidence signing key (docs/evidence/MANIFEST.json).
  spkiSha256: string;
  now: string;
}

const COUNTERPARTY_NOTE = "Delivered to our test mailbox, not to a real company.";
// The DEMO privacy rule lives in describe.ts, shared with the replay exporter.
export { DEMO_PHOTO_NOTE, DEMO_TEXT_BODY } from "./describe.js";

function facilityOf(id: string): Facility & { known: boolean } {
  try {
    return { ...facilityById(id), known: true };
  } catch {
    return { id, name: id, timeZone: "America/New_York", polygon: [], known: false };
  }
}

function latest(...values: Array<string | null | undefined>): string | null {
  return values.filter((v): v is string => typeof v === "string").sort().at(-1) ?? null;
}

// The pieces of a load every view needs, read once.
interface Parts {
  meta: Item;
  loadId: string;
  clause: ClauseSpec;
  facility: Facility & { known: boolean };
  language: Language;
  runKind: RunKind;
  synthetic: boolean;
  driverProvenance: Provenance;
  events: Item[];
  sends: Item[];
  agentItems: Item[];
  escalations: Item[];
  pack: Item | null;
  approvalItem: Item | null;
  request: Item | null;
  claimItem: Item | null;
  // A judge's DEMO load: the judge's own phone. Their typed text and photo stay off the public console.
  demo: boolean;
  now: string;
}

function partsOf(items: Item[], now: string): Parts {
  const bySk = (sk: string) => items.find((i) => i.sk === sk) ?? null;
  const meta = bySk("META");
  if (!meta) throw new Error("no META item for this load");
  const approvalItem = bySk("APPROVAL");
  const synthetic = isSynthetic(meta);
  const runKind = runKindOf(meta, approvalItem);
  const sorted = (prefix: string) => items.filter((i) => String(i.sk).startsWith(prefix)).sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
  return {
    meta,
    loadId: String(meta.loadId),
    clause: clauseById(String(meta.clauseId)),
    facility: facilityOf(String(meta.facilityId)),
    language: (["en_US", "es_MX", "fr_CA"].includes(String(meta.language)) ? meta.language : "en_US") as Language,
    runKind,
    synthetic,
    driverProvenance: synthetic ? "synthetic_input" : "recorded",
    events: sorted("EVENT#"),
    sends: sorted("SEND#"),
    agentItems: sorted("AGENT#"),
    escalations: sorted("EMAIL#escalation#"),
    pack: str(meta.sealedPackId) ? bySk(`PACK#${String(meta.sealedPackId)}`) : null,
    approvalItem,
    request: bySk("APPROVAL_REQUEST"),
    claimItem: bySk("CLAIM"),
    demo: isPrivateDemo(meta, approvalItem),
    now,
  };
}

const PHASES: readonly Phase[] = ["dispatched", "awaiting_arrival_pin", "at_dock", "awaiting_release_pin", "awaiting_bol", "documented", "sealed", "closed"];

// The stored phase, with names from before the current workflow (2026-10-16/17 test loads, such as
// "released") mapped onto today's: sealed when a pack exists, otherwise closed.
function phaseOf(meta: Item): Phase {
  const phase = String(meta.phase);
  if ((PHASES as readonly string[]).includes(phase)) return phase as Phase;
  return str(meta.sealedPackId) ? "sealed" : "closed";
}

function channelsOf(p: Parts): DriverChannel[] {
  const failedOver = p.events.some((e) => e.type === "failover" && String(e.outcome ?? "").includes("RCS"));
  const now: DriverChannel = p.meta.channel === "rcs" ? "rcs" : "whatsapp";
  return failedOver ? ["whatsapp", "rcs"] : [now];
}

// The workflow emails dispatch with this reason when nobody answers the approval request in two
// days (infra/lib/messaging-stack.ts, "Tell dispatch approval timed out"). Nothing is filed after it.
const APPROVAL_TIMEOUT_REASON = "no approval within two days";
// The taskTimeout of "Ask dispatch to approve" (infra/lib/messaging-stack.ts).
export const APPROVAL_WAIT_MS = 2 * 86_400_000;

// An approval request with no decision is timed out once its two-day wait has passed, or when the
// workflow wrote decision "timed_out" on it. The escalation email's reason is a second signal: that
// record is best effort and may be missing.
function approvalTimedOut(p: Parts): boolean {
  if (!p.request || p.approvalItem) return false;
  if (p.request.decision === "timed_out") return true;
  if (p.request.decision) return false;
  const requestedAt = Date.parse(String(p.request.requestedAt));
  if (Number.isFinite(requestedAt) && Date.parse(p.now) >= requestedAt + APPROVAL_WAIT_MS) return true;
  return p.escalations.some((e) => String(e.reason ?? "").startsWith(APPROVAL_TIMEOUT_REASON));
}

// When dispatch approved: the tap on the request, or a test approval recorded from the command line.
function approvedAtOf(p: Parts): string | null {
  return str(p.request?.decidedAt) ?? str(p.approvalItem?.approvedAt);
}

function statusOf(p: Parts): LoadStatus {
  const phase = phaseOf(p.meta);
  if (phase === "closed") return "closed";
  if (phase === "dispatched" || phase === "awaiting_arrival_pin") return "waiting_for_arrival";
  if (phase === "at_dock" || phase === "awaiting_release_pin") return "at_dock";
  if (phase === "awaiting_bol") return "paperwork";
  if (phase === "documented") return "sealing";
  const verdict = str(p.meta.verdict);
  if (verdict === "NOT_BILLABLE") return "not_billable";
  if (verdict === "NEEDS_HUMAN") return "needs_human";
  if (p.claimItem?.status === "sent") return "claim_filed";
  if (p.claimItem) return "filing";
  if (p.request?.decision === "hold") return "held";
  if (p.approvalItem) {
    // Only a filing run after the approval counts; one refused before it (no approval yet) does not.
    const approvedAt = approvedAtOf(p);
    // A run with no start time cannot be placed after the approval, so it does not count.
    const finished = p.agentItems.some((a) => {
      const startedAt = agentStartedAt(a);
      return a.task === "file_claim" && startedAt !== null && (!approvedAt || startedAt >= approvedAt);
    });
    return finished ? "needs_human" : "filing";
  }
  if (approvalTimedOut(p)) return "needs_human";
  if (p.request) return "awaiting_approval";
  // A test load is never paged for approval; the workflow ends it as held.
  if (p.synthetic && p.meta.askDispatcher !== true) return "held";
  return "awaiting_approval";
}

function isLive(status: LoadStatus): boolean {
  return ["waiting_for_arrival", "at_dock", "paperwork", "sealing", "awaiting_approval", "filing"].includes(status);
}

export function summaryOf(items: Item[], now: string = new Date().toISOString()): LoadSummary {
  const p = partsOf(items, now);
  const status = statusOf(p);
  const arrived = obj(p.meta.arrived);
  const bol = obj(p.meta.bol);
  const stamps = items.flatMap((i) => [str(i.serverAt), str(i.sentAt), str(i.startedAt), str(i.requestedAt), str(i.decidedAt), str(i.approvedAt), str(i.sealedAt), str(i.createdAt)]);
  const notice = obj(p.meta.notice);
  return {
    loadId: p.loadId,
    runKind: p.runKind,
    runLabel: RUN_LABELS[p.runKind],
    createdAt: String(p.meta.createdAt ?? p.meta.appointmentAt),
    lastActivityAt: latest(...stamps, str(notice.sentAt), str(notice.deliveredAt)) ?? String(p.meta.createdAt),
    facility: { id: p.facility.id, name: p.facility.name, timeZone: p.facility.timeZone },
    counterparty: { name: p.clause.counterparty, role: p.clause.role },
    channel: p.meta.channel === "rcs" ? "rcs" : "whatsapp",
    channels: channelsOf(p),
    language: p.language,
    phase: phaseOf(p.meta),
    status,
    live: isLive(status),
    verdict: (str(p.meta.verdict) as LoadSummary["verdict"]) ?? null,
    amountUsd: typeof p.pack?.amountUsd === "number" ? p.pack.amountUsd : null,
    claimSentAt: str(p.claimItem?.sentAt),
    arrivedAt: str(arrived.serverAt),
    releasedAt: releaseTimeOf(p.meta),
    failover: p.events.some((e) => e.type === "failover"),
    photos: Array.isArray(bol.photos) ? bol.photos.length : 0,
  };
}

function runInfoOf(p: Parts, hasSends: boolean): RunInfo {
  const notes: string[] = [];
  if (p.synthetic) notes.push("Driver messages: synthetic, replayed through the deployed stack by the integration test (load id prefix SMOKE-). Their times are set earlier than the run.");
  if (p.synthetic && hasSends) notes.push("Messages to the driver were composed but not sent: the driver is a test number.");
  if (p.approvalItem?.approver === "operator-cli-test") notes.push("Approval: recorded from the command line for this test, not a tap on a phone.");
  else if (p.approvalItem?.approver === "dispatcher-whatsapp") notes.push("Approval: a real tap on a real phone.");
  if (p.meta.channel === "rcs" || p.events.some((e) => e.type === "failover")) notes.push("RCS: sent through a Google testing agent, which reaches only phones registered as testers.");
  const summary =
    p.runKind === "phone"
      ? "Recorded from a real phone: every message, time and email here is what DockClock stored."
      : p.runKind === "demo"
        ? "A judge DEMO run on a real phone: the judge drives the load and approves the claim."
        : p.runKind === "operator"
          ? "Test run: the driver's messages were replayed test messages. The approval tap, the AI agent, the signature and the emails were real."
          : "Test run: the driver's messages were replayed test messages. The workflow, the AI agent, the signature and the emails are real.";
  return { kind: p.runKind, summary, notes };
}

// Message kinds by channel and stored type.
const OUT_KIND: Record<DriverChannel, Record<string, MessageKind>> = {
  whatsapp: { template: "wa_template", text: "wa_text", buttons: "wa_reply_buttons", location_request: "wa_location_request", flow: "wa_flow", document: "wa_document", card: "wa_text", unknown: "wa_text" },
  rcs: { card: "rcs_rich_card", text: "rcs_text", location_request: "rcs_location_request", buttons: "rcs_text", unknown: "rcs_text", template: "rcs_text", flow: "rcs_text", document: "rcs_text" },
};
const IN_KIND: Record<DriverChannel, Record<string, MessageKind>> = {
  whatsapp: { button: "wa_button_reply", location: "wa_location", flow: "wa_flow_reply", image: "wa_image", text: "wa_text_reply" },
  rcs: { button: "rcs_suggestion_reply", location: "rcs_location", image: "rcs_media", text: "rcs_text_reply" },
};

function actionsOf(channel: DriverChannel, m: Item): MessageAction[] | undefined {
  if (Array.isArray(m.actions) && m.actions.length) return m.actions.map((a) => ({ type: obj(a).type as MessageAction["type"], title: String(obj(a).title ?? "") }));
  const buttons = Array.isArray(m.buttons) ? m.buttons.map(String) : [];
  if (!buttons.length) return undefined;
  if (channel === "rcs") return buttons.map((title) => ({ type: m.kind === "location_request" ? "rcs_request_location" : "rcs_reply", title }));
  if (m.kind === "location_request") return buttons.map((title) => ({ type: "send_location", title }));
  if (m.kind === "flow") return buttons.map((title) => ({ type: "flow_cta", title }));
  return buttons.map((title) => ({ type: "quick_reply", title }));
}

function failoverOf(receipt: Item): ApiMessage["failover"] | undefined {
  const at = str(receipt.failoverAt);
  if (!at) return undefined;
  return { at, action: String(receipt.failoverAction) === "ESCALATED_UNREACHABLE" ? "escalated_to_dispatch" : "rerouted_to_rcs" };
}

interface Built {
  messages: ApiMessage[];
  timeline: ApiTimelineEvent[];
}

function conversation(p: Parts, photos: PhotoInfo[], receipts: Record<string, Item>): Built {
  type Pending = { at: string; message?: Omit<ApiMessage, "id">; event?: Omit<ApiTimelineEvent, "id" | "messageId"> };
  const pending: Pending[] = [];
  const bol = obj(p.meta.bol);
  const services = (channel: DriverChannel) => INBOUND_SERVICES[channel]!;

  for (const e of p.events) {
    const type = String(e.type ?? "other");
    const outcome = String(e.outcome ?? "");
    const at = String(e.serverAt);
    const detail = obj(e.detail);
    const channel: DriverChannel = e.channel === "rcs" ? "rcs" : "whatsapp";
    // A judge's own typed text never reaches the public console, not even in the raw record.
    const record = obj(scrub({ ...shownInboundEvent(e, p.demo), sk: `EVENT#${at}` }));
    if (type === "failover") {
      const escalated = outcome === "ESCALATED_UNREACHABLE";
      pending.push({
        at,
        event: {
          at,
          title: escalated ? "Driver unreachable on both channels: dispatch told" : "WhatsApp delivery failed: switched the driver to RCS",
          services: escalated ? ["EUM Social", "Lambda", "SES"] : ["EUM Social", "SNS", "Lambda", "EUM RCS"],
          channel: escalated ? "email" : "rcs",
          outcome,
          tone: "refused",
          record,
          provenance: p.driverProvenance,
        },
      });
      continue;
    }
    const action = buttonAction(str(detail.payload));
    const { title, tone } = inboundTitle(type, outcome, action);
    const isApproval = action === "approve" || action === "hold";
    const party: ApiMessage["party"] = isApproval && p.meta.demo !== true ? "dispatcher" : "driver";
    const kind = IN_KIND[channel][type];
    const base = { at, channel, direction: "in" as const, party, kind: kind!, status: "received" as const, outcome, provenance: p.driverProvenance };
    let message: Omit<ApiMessage, "id"> | undefined;
    let eventDetail: string | undefined;
    if (kind && type === "button") {
      const label = tapTitle(action, p.language);
      message = { ...base, purpose: `tap_${action ?? "button"}`, body: `Tapped ${label}`, actions: [{ type: channel === "rcs" ? "rcs_reply" : "quick_reply", title: label, tapped: true }] };
    } else if (kind && type === "location") {
      const lat = Number(detail.lat);
      const lon = Number(detail.lon);
      const inside = p.facility.known && Number.isFinite(lat) && Number.isFinite(lon) ? checkGeofence([lon, lat], p.facility).inside : null;
      const anyLocation = p.facility.id === "judge-demo" || p.facility.id === "demo-yard";
      const note = `${inside === null ? "Location not checked" : inside ? "Inside the facility area" : "Outside the facility area"}. Coordinates are not shown.${anyLocation ? " The demo yard accepts the test area only." : ""}`;
      message = { ...base, purpose: "location", body: "Location shared", location: { insideGeofence: inside, note } };
      eventDetail = `${note} Time is ${channel === "rcs" ? "RCS" : "WhatsApp"} server time.`;
    } else if (kind && type === "flow") {
      const accepted = outcome === "ADVANCED";
      message = {
        ...base,
        purpose: "flow_reply",
        body: "Bill of lading form",
        ...(accepted ? { flowReply: { inTime: str(bol.inTime), outTime: str(bol.outTime), receiverSigned: bol.receiverSigned === true, delayReason: str(bol.delayReason) } } : {}),
        ...(accepted && photos[0] ? { photoId: photos[0].id } : {}),
      };
    } else if (kind && type === "image") {
      const isBol = str(e.messageId) !== null && e.messageId === bol.messageId;
      message = { ...base, purpose: "photo", body: isBol ? "Bill of lading photo" : "Photo", ...(isBol && photos[0] ? { photoId: photos[0].id } : {}) };
    } else if (kind && type === "text") {
      message = { ...base, purpose: "text", body: shownInboundText(e, p.demo) };
    }
    const photoId = message?.photoId;
    pending.push({
      at,
      ...(message ? { message } : {}),
      event: { at, title, ...(eventDetail ? { detail: eventDetail } : {}), services: services(channel), channel, outcome, tone, ...(photoId ? { photoId } : {}), record, provenance: p.driverProvenance },
    });
  }

  for (const s of p.sends) {
    const at = String(s.sentAt);
    const m = obj(s.message);
    const channel: DriverChannel = s.channel === "rcs" ? "rcs" : "whatsapp";
    const notSent = s.status === "not_sent";
    const receipt = notSent ? {} : (receipts[String(s.messageId)] ?? {});
    const receiptTimes: NonNullable<ApiMessage["receipts"]> = {};
    for (const k of ["accepted", "sent", "delivered", "read", "failed"] as const) {
      const v = str(receipt[`${k}At`]);
      if (v) receiptTimes[`${k}At`] = v;
    }
    const status: MessageStatus = notSent ? "not_sent" : receiptTimes.failedAt ? "failed" : receiptTimes.readAt ? "read" : receiptTimes.deliveredAt ? "delivered" : receiptTimes.sentAt ? "sent" : "accepted";
    const purpose = String(s.purpose);
    const actions = actionsOf(channel, m);
    const failover = failoverOf(receipt);
    const provenance: Provenance = s.synthetic === true ? "synthetic_input" : "recorded";
    const template = obj(m.template);
    const doc = obj(m.document);
    const message: Omit<ApiMessage, "id"> = {
      at,
      channel,
      direction: "out",
      party: s.audience === "dispatcher" ? "dispatcher" : "driver",
      purpose,
      kind: OUT_KIND[channel][String(m.kind ?? "text")] ?? (channel === "rcs" ? "rcs_text" : "wa_text"),
      ...(str(m.title) ? { title: scrubText(String(m.title)) } : {}),
      body: scrubText(String(m.text ?? "")),
      ...(str(m.footer) ? { footer: String(m.footer) } : {}),
      ...(str(template.name) ? { template: { name: String(template.name), language: String(template.language ?? "") } } : {}),
      ...(actions ? { actions } : {}),
      ...(m.kind === "document" && str(doc.filename) ? { document: { filename: scrubText(String(doc.filename)), caption: scrubText(String(m.text ?? "")), sha256: /^[0-9a-f]{64}$/.test(String(doc.sha256)) ? String(doc.sha256) : null } } : {}),
      status,
      ...(notSent ? { notSentReason: String(s.notSentReason ?? "Not sent.") } : {}),
      ...(Object.keys(receiptTimes).length ? { receipts: receiptTimes } : {}),
      ...(failover ? { failover } : {}),
      provenance,
    };
    pending.push({
      at,
      message,
      event: {
        at,
        title: `${notSent ? "DockClock composed" : "DockClock sent"} ${purposeWords(purpose)}${notSent ? " (not sent)" : ""}`,
        services: channel === "rcs" ? ["Lambda", "EUM RCS"] : ["Lambda", "EUM Social"],
        channel,
        tone: purpose === "dispatch_approval" ? "money" : status === "failed" ? "refused" : "neutral",
        record: obj(scrub({ sk: `SEND#${at}`, channel, purpose, audience: s.audience, status, message: m, receipts: receiptTimes })),
        provenance,
      },
    });
  }

  pending.sort((a, b) => a.at.localeCompare(b.at));
  const messages: ApiMessage[] = [];
  const timeline: ApiTimelineEvent[] = [];
  for (const item of pending) {
    let messageId: string | undefined;
    if (item.message) {
      messageId = `m${messages.length + 1}`;
      messages.push({ id: messageId, ...item.message });
    }
    if (item.event) timeline.push({ id: "", ...item.event, ...(messageId ? { messageId } : {}) });
  }
  return { messages, timeline };
}

function photosOf(p: Parts, sources: LoadSources): PhotoInfo[] {
  const bol = obj(p.meta.bol);
  const list = Array.isArray(bol.photos) ? bol.photos.map(obj) : [];
  const channel: DriverChannel = bol.channel === "rcs" ? "rcs" : "whatsapp";
  const packHashes = sources.signedPack?.pack.events.bol?.pageSha256s ?? null;
  const reading = obj(p.meta.bolReading);
  return list.map((photo, index) => {
    const page = index + 1;
    const type = sources.photoTypes[page] ?? null;
    const hash = str(photo.sha256);
    // Only a photo the evidence path accepted (stored and hashed) is shown; one it refused, such
    // as an RCS object not written with its message, counts as not stored.
    const stored = str(photo.s3Key) !== null && hash !== null;
    const source: PhotoInfo["source"] = !stored ? "not_stored" : type === null ? "test_bytes" : p.synthetic ? "rendered_fictional_document" : "phone_camera";
    const readThisPage = Number(reading.page ?? 1) === page && typeof reading.legible === "boolean";
    return {
      id: `p${page}`,
      page,
      channel,
      takenAt: String(bol.serverAt),
      mimeType: type ?? String(photo.mimeType ?? "application/octet-stream"),
      sha256: hash,
      matchesPack: packHashes && hash ? packHashes[index] === hash : null,
      url: stored && type && !p.demo ? `/api/loads/${p.loadId}/photos/${page}` : null,
      ...(stored && p.demo ? { note: DEMO_PHOTO_NOTE } : {}),
      servedBytes: "metadata_stripped",
      source,
      usedInEvidence: true,
      ...(readThisPage ? { legible: reading.legible === true } : {}),
      ...(readThisPage
        ? { reading: { inTime: str(reading.inTime), outTime: str(reading.outTime), receiverSigned: reading.receiverSigned === true, model: String(reading.model ?? ""), readAt: String(reading.readAt ?? "") } }
        : {}),
      provenance: p.driverProvenance,
    };
  });
}

function emailStatus(item: Item): EmailInfo["status"] {
  if (item.status === "not_sent") return "not_sent";
  return str(item.bouncedAt) ? "bounced" : str(item.deliveredAt) ? "delivered" : "sent";
}

function emailsOf(p: Parts, mime: { notice?: ParsedEmail; claim?: ParsedEmail }): EmailInfo[] {
  const out: EmailInfo[] = [];
  const counterparty = { name: p.clause.counterparty, role: p.clause.role, note: COUNTERPARTY_NOTE };
  const notice = obj(p.meta.notice);
  if (str(notice.sentAt)) {
    out.push({
      id: "notice",
      purpose: "notice",
      sentAt: String(notice.sentAt),
      status: emailStatus(notice),
      ...(str(notice.deliveredAt) ? { deliveredAt: String(notice.deliveredAt) } : {}),
      ...(str(notice.bouncedAt) ? { bouncedAt: String(notice.bouncedAt) } : {}),
      from: addressOnly(mime.notice?.from ?? ""),
      to: counterparty,
      subject: scrubText(mime.notice?.subject ?? `Detention notice: Load ${p.loadId} at ${p.facility.name}`),
      attachments: [],
      bodyStored: mime.notice !== undefined,
      provenance: "recorded",
    });
  }
  const claim = p.claimItem;
  if (claim && str(claim.sentAt)) {
    out.push({
      id: "claim",
      purpose: "claim",
      sentAt: String(claim.sentAt),
      status: emailStatus(claim),
      ...(str(claim.deliveredAt) ? { deliveredAt: String(claim.deliveredAt) } : {}),
      ...(str(claim.bouncedAt) ? { bouncedAt: String(claim.bouncedAt) } : {}),
      from: addressOnly(mime.claim?.from ?? ""),
      to: counterparty,
      subject: scrubText(mime.claim?.subject ?? String(claim.subject ?? "")),
      attachments: (mime.claim?.attachments ?? []).map((a) => ({ ...a, note: attachmentNote(a) })),
      bodyStored: mime.claim !== undefined,
      provenance: "recorded",
    });
  }
  p.escalations.forEach((e, index) => {
    out.push({
      id: `escalation-${index + 1}`,
      purpose: "dispatch_escalation",
      sentAt: String(e.sentAt),
      status: emailStatus(e),
      ...(e.status === "not_sent" ? { notSentReason: String(e.notSentReason ?? "Not sent.") } : {}),
      ...(str(e.deliveredAt) ? { deliveredAt: String(e.deliveredAt) } : {}),
      ...(str(e.bouncedAt) ? { bouncedAt: String(e.bouncedAt) } : {}),
      from: "DockClock dispatch alerts",
      to: { name: "The carrier's dispatch desk", role: "dispatch", note: "Our test mailbox for dispatch." },
      subject: scrubText(String(e.subject ?? "")),
      attachments: [],
      bodyStored: typeof e.text === "string",
      provenance: "recorded",
    });
  });
  return out;
}

// The workflow's wait for the Released tap ("Await released", infra/lib/messaging-stack.ts).
const RELEASE_WAIT_MS = 3 * 86_400_000;

// When a closed load that arrived and was never released stopped: the close time the workflow
// wrote, or on loads closed before it was kept, the end of the release wait for a timed-out load
// and the last record otherwise. Never later than now.
function endedAtOf(p: Parts, arrivedAt: string | null, releasedAt: string | null): string | null {
  if (!arrivedAt || releasedAt || phaseOf(p.meta) !== "closed") return null;
  const closedAt = str(p.meta.closedAt);
  const waitEnd = p.meta.outcome === "TIMED_OUT_NEEDS_HUMAN" && timeReadable(arrivedAt) ? new Date(Date.parse(arrivedAt) + RELEASE_WAIT_MS).toISOString() : null;
  const lastRecord = latest(...p.events.map((e) => str(e.serverAt)), ...p.sends.map((s) => str(s.sentAt)), arrivedAt);
  const end = closedAt ?? waitEnd ?? lastRecord ?? arrivedAt;
  return end < p.now ? end : p.now;
}

function clockOf(p: Parts, now: string, signed: SignedPack | null): LiveClock {
  const arrivedAt = str(obj(p.meta.arrived).serverAt);
  const releasedAt = releaseTimeOf(p.meta);
  const tapAt = str(obj(p.meta.releasedTap).serverAt);
  const releasePinAt = tapAt ? str(obj(p.meta.released).serverAt) : null;
  const endedAt = endedAtOf(p, arrivedAt, releasedAt);
  const appointmentAt = String(p.meta.appointmentAt);
  // An arrival time that does not parse starts no clock: free time and detention are left unknown
  // (the engine holds such a load), never thrown on.
  const startable = arrivedAt !== null && timeReadable(arrivedAt);
  const freeTimeEndsAt = startable ? detentionStartsAt(p.clause, appointmentAt, arrivedAt) : null;
  const clockStartAt = startable ? (p.clause.freeTimeAnchor === "appointment" && Date.parse(arrivedAt) < Date.parse(appointmentAt) ? appointmentAt : arrivedAt) : null;
  const evaluation = signed?.pack.evaluation;
  let detention = 0;
  let billable = 0;
  if (evaluation) {
    detention = evaluation.detentionMinutes;
    billable = evaluation.billableMinutes;
  } else if (freeTimeEndsAt) {
    const end = Date.parse(releasedAt ?? endedAt ?? now);
    detention = Number.isFinite(end) ? Math.max(0, (end - Date.parse(freeTimeEndsAt)) / 60_000) : 0;
    billable = p.clause.capHoursPerDay ? Math.min(detention, p.clause.capHoursPerDay * 60) : detention;
  }
  return { asOf: now, arrivedAt, releasedAt, releasePinAt, endedAt, clockStartAt: evaluation?.clockStartAt ?? clockStartAt, freeTimeEndsAt, detentionMinutes: detention, billableMinutes: billable, amountUsd: evaluation?.amountUsd ?? null, driverTimes: p.driverProvenance };
}

function workflowOf(p: Parts, status: LoadStatus, photos: PhotoInfo[]): WorkflowStep[] {
  const m = p.meta;
  const phase = phaseOf(m);
  const channelTag = m.channel === "rcs" ? "EUM RCS" : "EUM Social";
  const arrivedAt = str(obj(m.arrived).serverAt);
  const tapAt = str(obj(m.releasedTap).serverAt);
  const pinAt = str(obj(m.released).serverAt);
  const releasedAt = releaseTimeOf(m);
  const bolAt = str(obj(m.bol).serverAt);
  const reading = obj(m.bolReading);
  const notice = obj(m.notice);
  const sealedAt = str(m.sealedAt) ?? str(p.pack?.sealedAt);
  const closed = phase === "closed";
  const verdict = str(m.verdict);
  const step = (key: WorkflowStep["key"], label: string, services: WorkflowStep["services"], at: string | null, current: boolean, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({
    key,
    label,
    state: at ? "done" : current ? (closed ? "failed" : "current") : closed || phase === "sealed" ? "skipped" : "waiting",
    at,
    services,
    ...extra,
  });
  const steps: WorkflowStep[] = [
    step("dispatched", "Load dispatched to the driver", ["Lambda", "Step Functions", channelTag], String(m.createdAt ?? m.appointmentAt), false),
    step("arrived", "Arrival confirmed by a location pin", [channelTag, "SQS", "Lambda", "DynamoDB"], arrivedAt, phase === "dispatched" || phase === "awaiting_arrival_pin"),
  ];
  const noticeStep = step("notice", "Detention notice emailed before free time ends", ["EventBridge Scheduler", "Lambda", "SES"], str(notice.sentAt), Boolean(arrivedAt) && !releasedAt);
  if (str(notice.skipped) && !str(notice.sentAt)) Object.assign(noticeStep, { state: "skipped", detail: scrubText(String(notice.skipped)) });
  else if (!str(notice.sentAt) && str(notice.scheduledFor) && !closed && phase !== "sealed") Object.assign(noticeStep, { state: "waiting", detail: `Scheduled for ${String(notice.scheduledFor)}` });
  else if (!str(notice.sentAt) && p.clause.noticeLeadMinutes === null) Object.assign(noticeStep, { detail: "This contract does not require notice." });
  steps.push(noticeStep);
  steps.push(releaseStep(p, tapAt, pinAt, step, [channelTag, "SQS", "Lambda", "DynamoDB"], phase, closed));
  const paperworkStep = step("paperwork", "Bill of lading received", [channelTag, "SQS", "Lambda", "S3 Object Lock"], bolAt, phase === "awaiting_bol");
  if (!bolAt && phase === "sealed") Object.assign(paperworkStep, { detail: "No photo came within six hours, so the contract was decided on the pins alone." });
  steps.push(paperworkStep);
  const photoStep = step("photo_read", "Photo read by the agent's tool", ["Step Functions", "Lambda"], str(reading.readAt), phase === "documented" && photos.length > 0);
  if (!str(reading.readAt) && (photos.length === 0 || photos.every((x) => x.url === null && x.note === undefined)) && (phase === "sealed" || closed)) Object.assign(photoStep, { state: "skipped", detail: "No readable photo was stored." });
  steps.push(photoStep);
  const sealStep = step("sealed", verdict ? `Contract decided: ${verdictWords(verdict)}; evidence sealed and signed` : "Evidence sealed and signed", ["Lambda", "KMS", "S3 Object Lock"], sealedAt, phase === "documented");
  if (m.outcome === "SEAL_FAILED") Object.assign(sealStep, { state: "failed", detail: "Sealing failed after retries." });
  steps.push(sealStep);
  const billable = verdict === "BILLABLE";
  const approvedAt = str(p.request?.decidedAt) ?? str(p.approvalItem?.approvedAt);
  const approval = step("approval", "Dispatch approved the claim", ["Step Functions", channelTag, "Lambda"], p.request?.decision === "hold" ? null : approvedAt, status === "awaiting_approval");
  if (verdict && !billable) Object.assign(approval, { state: "skipped", detail: "Nothing is owed, so nothing is claimed." });
  else if (p.request?.decision === "hold") Object.assign(approval, { state: "failed", at: str(p.request.decidedAt), detail: "Dispatch tapped Hold." });
  else if (billable && !p.request && p.synthetic && p.meta.askDispatcher !== true && !approvedAt) Object.assign(approval, { state: "skipped", detail: "Test load: dispatch is not paged; a test approval can be recorded from the command line." });
  else if (approvalTimedOut(p)) Object.assign(approval, { state: "failed", detail: "No answer within two days, so nothing was sent. Dispatch was emailed." });
  if (p.approvalItem?.approver === "operator-cli-test") Object.assign(approval, { detail: "Recorded from the command line for this test, not a tap." });
  steps.push(approval);
  const claim = step("claim", "AI agent filed the claim by email", ["Bedrock AgentCore", "AgentCore Gateway", "SES"], str(p.claimItem?.sentAt), status === "filing");
  if (verdict && !billable) Object.assign(claim, { state: "skipped" });
  else if (approvalTimedOut(p)) Object.assign(claim, { state: "skipped", detail: "Not filed: no approval." });
  else if (status === "needs_human" && billable) Object.assign(claim, { state: "failed", detail: "The agent did not file; a person takes over." });
  steps.push(claim);
  return steps;
}

// The release step. On a load with a Released tap the clock stopped at the tap and the step is done
// once the location pin confirms it; the detail says when the pin came, or that it is awaited. An
// older load's release is the pin alone, as before.
function releaseStep(
  p: Parts,
  tapAt: string | null,
  pinAt: string | null,
  step: (key: WorkflowStep["key"], label: string, services: WorkflowStep["services"], at: string | null, current: boolean, extra?: Partial<WorkflowStep>) => WorkflowStep,
  services: WorkflowStep["services"],
  phase: Phase,
  closed: boolean,
): WorkflowStep {
  if (!tapAt) return step("released", "Release confirmed by a location pin", services, pinAt, phase === "at_dock" || phase === "awaiting_release_pin");
  const tz = p.facility.timeZone;
  const label = "Driver tapped Released: the dock clock stopped";
  const stopped = timeReadable(tapAt) ? `Clock stopped at ${isoToLocalClock(tapAt, tz)} ${zoneAbbreviation(tapAt, tz)}.` : "The Released tap's time could not be read.";
  if (!pinAt) {
    const waiting = closed || phase === "sealed" ? "No location pin came to confirm it." : `Waiting for the location pin that confirms it (within ${RELEASE_PIN_WINDOW_MINUTES} minutes).`;
    return step("released", label, services, null, phase === "awaiting_release_pin", { detail: `${stopped} ${waiting}` });
  }
  // The engine's own check (releasePinCheck): a time that does not parse confirms nothing, and the
  // engine sends the load to a person (TIMESTAMP_UNREADABLE), so the step fails and says so.
  const check = releasePinCheck(tapAt, pinAt);
  if (check === "unreadable") {
    const which = timeReadable(pinAt) ? "" : " The location pin's time could not be read.";
    return step("released", label, services, timeReadable(tapAt) ? tapAt : null, false, { detail: `${stopped}${which} A person reviews the load.`, state: "failed" });
  }
  const gap = releasePinGapWords(tapAt, pinAt);
  const pin = obj(p.meta.released);
  const inside = p.facility.known && typeof pin.lat === "number" && typeof pin.lon === "number" ? checkGeofence([pin.lon, pin.lat], p.facility).inside : null;
  const where = inside === null ? "" : inside ? ", inside the facility" : ", outside the facility";
  const pinAtWords = `${isoToLocalClock(pinAt, tz)} ${zoneAbbreviation(pinAt, tz)}`;
  const late = check === "late";
  const confirm = late
    ? `The location pin came at ${pinAtWords}, ${gap} the tap (limit ${RELEASE_PIN_WINDOW_MINUTES}), so a person reviews the load.`
    : `Confirmed by the location pin at ${pinAtWords}, ${gap} the tap${where}.`;
  return step("released", label, services, tapAt, false, { detail: `${stopped} ${confirm}`, ...(late ? { state: "failed" as const } : {}) });
}

export const WHAT_IF_OFF_NOTE = "What-if is off for this load: its rebuilt inputs do not give the sealed decision. The sealed evaluation is shown.";

function verdictOf(p: Parts, signed: SignedPack): VerdictInfo {
  const evaluation = signed.pack.evaluation;
  const engineInput = engineInputOf(p.meta, signed, p.facility.timeZone);
  let mismatch = false;
  try {
    checkEngineInput(engineInput, { loadId: p.loadId, clause: p.clause, facilityName: p.facility.name, evaluation });
  } catch (error) {
    mismatch = true;
    console.log(JSON.stringify({ kind: "api_engine_mismatch", loadId: p.loadId, error: (error as Error).message }));
  }
  return {
    // The rebuilt inputs must reproduce the sealed verdict and amount, or the What-if's
    // "Recorded" card could contradict the signed pack. The site hides the What-if then.
    ...(mismatch ? { whatIfAvailable: false, whatIfNote: WHAT_IF_OFF_NOTE } : {}),
    verdict: evaluation.verdict,
    reasons: evaluation.reasons as VerdictInfo["reasons"],
    amountUsd: evaluation.amountUsd,
    confidence: signed.pack.corroboration.confidence,
    signals: signed.pack.corroboration.signals.map((s) => ({ name: s.name, ok: s.ok, ...(s.independent !== undefined ? { independent: s.independent } : {}), detail: scrubText(s.detail) })),
    engineInput,
  };
}

export function packDigestOf(signed: SignedPack): string {
  return sha256(canonicalJson(signed.pack));
}

export function buildLoadView(sources: LoadSources): LoadView {
  const p = partsOf(sources.items, sources.now);
  const summary = summaryOf(sources.items, sources.now);
  const signed = sources.signedPack;
  const parsed = { ...(sources.emails.notice ? { notice: parseMime(sources.emails.notice) } : {}), ...(sources.emails.claim ? { claim: parseMime(sources.emails.claim) } : {}) };
  const photos = photosOf(p, sources);
  const { messages, timeline } = conversation(p, photos, sources.receipts);
  const emails = emailsOf(p, parsed);
  const digest = signed ? packDigestOf(signed) : null;
  const agentRuns = agentRunsOf(sources.items, signed && digest ? { cents: toCents(signed.pack.evaluation.amountUsd), digest } : null);

  // Workflow, email and money events join the message events.
  const add = (e: Omit<ApiTimelineEvent, "id">) => timeline.push({ id: "", ...e });
  if (signed && digest) {
    const ev = signed.pack.evaluation;
    add({
      at: signed.pack.sealedAt,
      title: `The contract decided: ${verdictWords(ev.verdict)}${ev.amountUsd > 0 ? `, $${ev.amountUsd.toFixed(2)}` : ""}. Evidence sealed and signed`,
      services: ["Step Functions", "Lambda", "KMS", "S3 Object Lock"],
      tone: "money",
      record: { verdict: ev.verdict, reasons: ev.reasons, amountUsd: ev.amountUsd, packId: signed.pack.packId, digestSha256: digest },
      provenance: "recorded",
    });
  } else if (p.meta.outcome) {
    add({ at: summary.lastActivityAt, title: `The load was closed without a pack (${scrubText(String(p.meta.outcome)).toLowerCase().replace(/_/g, " ")})`, services: ["Step Functions", "DynamoDB"], tone: "refused", provenance: "recorded" });
  }
  const reading = obj(p.meta.bolReading);
  if (str(reading.readAt)) {
    add({
      at: String(reading.readAt),
      title: reading.legible === true ? "The agent's photo tool read the bill of lading" : "The agent's photo tool could not read the bill of lading",
      services: ["Step Functions", "Lambda"],
      tone: "agent",
      ...(photos[0] ? { photoId: photos[0].id } : {}),
      record: obj(scrub({ legible: reading.legible, inTime: reading.inTime, outTime: reading.outTime, receiverSigned: reading.receiverSigned, model: reading.model })),
      provenance: "recorded",
    });
  }
  const notice = obj(p.meta.notice);
  const freeEnds = summary.arrivedAt && timeReadable(summary.arrivedAt) ? detentionStartsAt(p.clause, String(p.meta.appointmentAt), summary.arrivedAt) : null;
  if (str(notice.sentAt)) {
    const when = freeEnds ? (Date.parse(String(notice.sentAt)) < Date.parse(freeEnds) ? " before free time ended" : " after free time ended") : "";
    add({ at: String(notice.sentAt), title: `Detention notice emailed${when}`, services: ["EventBridge Scheduler", "Lambda", "SES"], channel: "email", tone: "money", emailId: "notice", provenance: "recorded" });
    if (str(notice.deliveredAt)) add({ at: String(notice.deliveredAt), title: "SES reported the notice delivered", services: ["SES", "SNS", "Lambda"], channel: "email", tone: "ok", emailId: "notice", provenance: "recorded" });
  }
  for (const email of emails.filter((x) => x.purpose === "dispatch_escalation")) {
    add({
      at: email.sentAt,
      title: email.status === "not_sent" ? "Dispatch escalation composed (not sent: test load)" : String(p.escalations[Number(email.id.split("-")[1]) - 1]?.reason ?? "").startsWith(APPROVAL_TIMEOUT_REASON) ? "Approval timed out after two days; dispatch emailed, nothing filed" : "Dispatch emailed: the driver needs a person",
      services: ["Lambda", "SES"],
      channel: "email",
      tone: "refused",
      emailId: email.id,
      provenance: "recorded",
    });
  }
  let approval: ApprovalInfo | null = null;
  if (p.request) {
    approval = {
      requestedAt: String(p.request.requestedAt),
      decidedAt: str(p.request.decidedAt),
      decision: p.request.decision === "approve" ? "approve" : p.request.decision === "hold" ? "hold" : null,
      approver: p.meta.demo === true ? "demo_driver" : "dispatcher",
    };
  }
  if (p.approvalItem?.approver === "operator-cli-test") {
    add({ at: String(p.approvalItem.approvedAt), title: "Approval recorded from the command line (test, not a tap)", services: ["DynamoDB"], tone: "ok", provenance: "recorded" });
  }
  for (const run of agentRuns) {
    const filed = run.toolCalls.find((c) => c.name === "send_detention_claim")?.result?.ok === true;
    const refusal = run.toolCalls.find((c) => c.result?.ok === false)?.result?.summary;
    add({
      at: run.startedAt,
      title: run.task === "review" ? "The AI agent reviewed the load" : filed ? "The AI agent filed the claim by email" : `The AI agent did not file${refusal ? `: ${refusal}` : " (no dispatch approval)"}`,
      services: filed ? ["Bedrock AgentCore", "AgentCore Gateway", "SES"] : ["Bedrock AgentCore", "AgentCore Gateway"],
      tone: run.task === "file_claim" && !filed ? "refused" : "agent",
      agentRunId: run.id,
      ...(filed && p.claimItem ? { emailId: "claim" } : {}),
      provenance: "recorded",
    });
  }
  const claimItem = p.claimItem;
  if (claimItem && str(claimItem.deliveredAt)) add({ at: String(claimItem.deliveredAt), title: "SES reported the claim email delivered", services: ["SES", "SNS", "Lambda"], channel: "email", tone: "ok", emailId: "claim", provenance: "recorded" });
  let claim: ClaimInfo | null = null;
  if (claimItem) {
    const approvedAt = str(p.request?.decidedAt) ?? str(p.approvalItem?.approvedAt);
    const sentAt = str(claimItem.sentAt);
    claim = {
      status: claimItem.status === "sent" ? "sent" : "sending",
      amountUsd: Number(claimItem.amountUsd),
      amountCents: Number(claimItem.amountCents),
      packDigest: String(claimItem.packDigest),
      sentAt,
      subject: scrubText(String(claimItem.subject ?? "")),
      secondsAfterApproval: approvedAt && sentAt ? Math.round((Date.parse(sentAt) - Date.parse(approvedAt)) / 100) / 10 : null,
    };
  }

  const pack: PackSummary | null =
    signed && digest
      ? { packId: signed.pack.packId, digestSha256: digest, sealedAt: signed.pack.sealedAt, storage: "S3 Object Lock (governance mode, 30 days)", confidence: signed.pack.corroboration.confidence, href: `/api/loads/${p.loadId}/pack` }
      : null;

  return {
    summary,
    run: runInfoOf(p, p.sends.length > 0),
    clause: clauseInfo(p.clause),
    clock: clockOf(p, sources.now, signed),
    workflow: workflowOf(p, summary.status, photos),
    messages,
    timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)).map((t, i) => ({ ...t, id: `e${i + 1}` })),
    photos,
    emails,
    agentRuns,
    approval,
    claim,
    verdict: signed ? verdictOf(p, signed) : null,
    pack,
  };
}

// GET /api/loads/:id/pack: the signed object exactly as sealed, minus the KMS key id (not signed;
// it holds the account id).
export function packInfoOf(signed: SignedPack, spkiSha256: string): SignedPackInfo {
  return {
    packId: signed.pack.packId,
    digestSha256: packDigestOf(signed),
    algorithm: "ECDSA_SHA_256",
    signatureBase64: signed.signatureBase64,
    publicKeyPath: "keys/public-key.pem",
    spkiSha256,
    sealedAt: signed.pack.sealedAt,
    storage: "S3 Object Lock (governance mode, 30 days)",
    pack: signed.pack as unknown as Record<string, unknown>,
  };
}

// GET /api/loads/:id/emails/:emailId: one email with its body.
export function emailViewOf(sources: LoadSources, emailId: string): EmailView | null {
  const p = partsOf(sources.items, sources.now);
  const parsed = { ...(sources.emails.notice ? { notice: parseMime(sources.emails.notice) } : {}), ...(sources.emails.claim ? { claim: parseMime(sources.emails.claim) } : {}) };
  const info = emailsOf(p, parsed).find((e) => e.id === emailId);
  if (!info) return null;
  if (info.purpose === "dispatch_escalation") {
    const item = p.escalations[Number(emailId.split("-")[1]) - 1];
    const text = str(item?.text);
    return { ...info, body: text ? scrubText(text) : null, bodyNote: "The text DockClock composed for dispatch, with the driver's contact removed (dispatch's own copy has it)." };
  }
  const mime = info.purpose === "notice" ? parsed.notice : parsed.claim;
  return mime
    ? { ...info, body: scrubText(mime.text.trimEnd()), bodyNote: info.purpose === "claim" ? claimBodyNote(mime.text) : "The sent email's bytes, kept with the load's packs." }
    : { ...info, body: null, bodyNote: "This email's bytes were not stored (DockClock keeps them from 2026-10-20 on)." };
}
