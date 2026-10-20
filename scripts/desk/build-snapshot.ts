// Builds the judge desk's replay file (site/src/snapshot.ts, schema dockclock.replay/1) from one
// load's stored records. Pure: the CLI in scripts/desk-snapshot.ts reads AWS and passes the records
// in. Everything that leaves here is scrubbed, and findLeaks() is the gate the CLI and tests share.
import { createHash } from "node:crypto";
import { clauseById, detentionStartsAt, evaluate, type ClauseSpec, type LoadEvidence } from "@dockclock/clause-engine";
import { canonicalJson, checkGeofence, facilityById, localClockToIso, type SignedPack } from "@dockclock/evidence";
import { COPY, type Language } from "../../services/src/messages.js";
import type {
  AgentRun,
  AgentToolCall,
  ApprovalInfo,
  ChatMessage,
  ClaimInfo,
  ClauseInfo,
  EmailRecord,
  Provenance,
  ReasonCode,
  ReplaySnapshot,
  RunInfo,
  RunKind,
  ServiceTag,
  TimelineEvent,
} from "../../site/src/snapshot.js";

type Item = Record<string, unknown>;

export interface SnapshotSources {
  // Every item in the load's partition (one Query on LOAD#<id>).
  items: Item[];
  // MSG#<messageId> receipts for the load's sends, by message id.
  receipts: Record<string, Item>;
  signedPack: SignedPack;
  // Raw MIME of the stored emails, when they exist.
  emails: { notice?: string; claim?: string };
  spkiSha256: string;
  exportedAt: string;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Item => (v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {});
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// MIME: just enough for the two formats DockClock sends (text/plain and multipart/mixed, base64).
export interface ParsedEmail {
  from: string;
  subject: string;
  date: string | null;
  text: string;
  attachments: Array<{ name: string; contentType: string; sha256: string }>;
}

function splitHead(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  const head = at === -1 ? raw : raw.slice(0, at);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: at === -1 ? "" : raw.slice(at + 4) };
}

function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

function decodeBody(body: string, encoding: string | undefined): Buffer {
  return encoding?.toLowerCase() === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : Buffer.from(body, "utf8");
}

export function parseMime(raw: string): ParsedEmail {
  const { headers, body } = splitHead(raw);
  const out: ParsedEmail = { from: headers.from ?? "", subject: decodeWords(headers.subject ?? ""), date: headers.date ?? null, text: "", attachments: [] };
  const boundary = /boundary="?([^";]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
  if (!boundary) {
    out.text = decodeBody(body, headers["content-transfer-encoding"]).toString("utf8");
    return out;
  }
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const p = splitHead(part.replace(/^\r\n/, ""));
    const bytes = decodeBody(p.body, p.headers["content-transfer-encoding"]);
    const type = (p.headers["content-type"] ?? "text/plain").split(";")[0]!.trim();
    const name = /filename="?([^";]+)"?/i.exec(p.headers["content-disposition"] ?? "")?.[1];
    if (name) out.attachments.push({ name, contentType: type, sha256: sha256(bytes) });
    else if (type === "text/plain" && !out.text) out.text = bytes.toString("utf8");
  }
  return out;
}

// Scrubbing. Keys that may hold a person's contact, a place, an AWS name or a raw message id.
const DROP_KEYS = /^(pk|lat|lon|latitude|longitude|location|e164|address|bsuid|boundBsuid|driverKey|messageId|wamid|failedMessageId|dispatchMessageId|approvalMessageId|s3Key|mimeKey|keyId|executionArn|token|tokens|taskToken|nonce|mediaId|metaSha256|from|outbox)$/i;

export function scrubText(text: string): string {
  return text
    .replace(/arn:aws[a-z-]*:[^\s"')]+/g, "<AWS resource name removed>")
    .replace(/\+\d{10,15}/g, "<phone removed>")
    .replace(/\b[A-Z]{2}\.\d{10,}\b/g, "<id removed>")
    .replace(/\bwamid\.[A-Za-z0-9._=+/-]+/g, "<message id removed>")
    .replace(/\b(dc1\.[a-z_]+\.[A-Za-z0-9-]+\.)[0-9a-f]{6,}/g, "$1<nonce>")
    .replace(/s3:\/\/\S+/g, "<S3 location removed>")
    .replace(/\b(packs|rcs-inbound|media)\/[A-Za-z0-9._/-]+/g, "<S3 key removed>");
}

export function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Item).filter(([k]) => !DROP_KEYS.test(k)).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

// Everything the published file must not hold. Returns one line per finding; empty means clean.
export function findLeaks(value: unknown, accountId?: string): string[] {
  const leaks: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      const checks: Array<[string, RegExp]> = [
        ["E.164 number", /\+\d{10,15}/],
        ["BSUID", /\b[A-Z]{2}\.\d{10,}\b/],
        ["ARN", /arn:aws/],
        ["12-digit account id", /(^|[^0-9A-Za-z])\d{12}([^0-9A-Za-z]|$)/],
        ["S3 key", /\b(packs|rcs-inbound|media)\/[A-Za-z0-9._-]+\/|s3:\/\//],
        ["WhatsApp message id", /\bwamid\.(?!smoke\.)/],
        ["coordinate pair", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
      ];
      for (const [name, re] of checks) if (re.test(v)) leaks.push(`${name} at ${path}`);
      if (accountId && v.includes(accountId)) leaks.push(`account id at ${path}`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 2 && v.every((n) => typeof n === "number" && !Number.isInteger(n) && Math.abs(n) <= 180)) leaks.push(`numeric coordinate pair at ${path}`);
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Item)) {
        if (/^(lat|lon|latitude|longitude)$/i.test(k)) leaks.push(`coordinate key ${k} at ${path}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, "$");
  return leaks;
}

// Mapping helpers.
const toCents = (usd: number) => Math.round(usd * 100);
const INBOUND_SERVICES: Record<string, ServiceTag[]> = {
  whatsapp: ["EUM Social", "SNS", "SQS", "Lambda", "DynamoDB"],
  rcs: ["EUM RCS", "SNS", "SQS", "Lambda", "DynamoDB"],
};

function runKindOf(meta: Item, approval: Item | null): RunKind {
  if (meta.demo === true) return "demo";
  if (meta.synthetic !== true) return "phone";
  return approval?.approver === "dispatcher-whatsapp" ? "operator" : "integration";
}

function clauseInfo(clause: ClauseSpec): ClauseInfo {
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

function buttonAction(payload: string | null): string | null {
  return payload?.startsWith("dc1.") ? (payload.split(".")[1] ?? null) : null;
}

function tapTitle(action: string | null, language: Language): string {
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

function inboundTitle(type: string, outcome: string, action: string | null): { title: string; tone: TimelineEvent["tone"] } {
  const refused = /^(REJECTED|IGNORED)/.test(outcome);
  if (type === "button") {
    const name = action ? action[0]!.toUpperCase() + action.slice(1) : "A button";
    if (outcome === "REJECTED_OUT_OF_ORDER") return { title: `${name} tapped out of order: refused`, tone: "refused" };
    if (outcome === "REJECTED_STALE_BUTTON") return { title: `${name} tapped on an old message: refused`, tone: "refused" };
    if (outcome === "IGNORED_DUPLICATE_TAP") return { title: `${name} tapped again: ignored`, tone: "refused" };
    return { title: `Driver tapped ${name}`, tone: refused ? "refused" : "neutral" };
  }
  if (type === "location") return { title: refused ? "Location received but not used" : "Driver shared a location", tone: refused ? "refused" : "neutral" };
  if (type === "flow") return { title: refused ? "Bill of lading form not accepted" : "Bill of lading form submitted", tone: refused ? "refused" : "neutral" };
  if (type === "image") return { title: refused ? "Photo received but not used" : "Driver sent a photo", tone: refused ? "refused" : "neutral" };
  if (type === "failover") return { title: "WhatsApp delivery failed: switched to RCS", tone: "refused" };
  if (type === "text") return { title: "Driver sent a text", tone: "neutral" };
  return { title: `Driver message (${type})`, tone: refused ? "refused" : "neutral" };
}

const PURPOSE_WORDS: Record<string, string> = {
  dispatch_template: "the load dispatch",
  dispatch_card: "the load dispatch card",
  location_request: "a location request",
  checked_in: "the check-in confirmation with Released",
  release_flow: "the bill of lading form",
  notice_sent: "word that the detention notice was emailed",
  dispatch_approval: "the claim to dispatch for approval",
  approval_reply: "the approval confirmation",
  demo_intro: "the demo introduction",
};

function verdictWords(verdict: string): string {
  return verdict === "BILLABLE" ? "billable" : verdict === "NOT_BILLABLE" ? "not billable" : "needs a person";
}

function toolSummary(name: string, result: Item, status: string | null): { ok: boolean; summary: string } {
  if (typeof result.refused === "string") return { ok: false, summary: `Refused: ${result.refused}` };
  if (result.policyDenied === true) return { ok: false, summary: "Denied by the Gateway's Cedar policy." };
  if (typeof result.error === "string") return { ok: false, summary: `Error: ${result.error}` };
  if (status === "error") return { ok: false, summary: "The tool call failed." };
  if (name === "send_detention_claim" && result.sent === true) return { ok: true, summary: "Email accepted by SES; claim recorded as sent." };
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

function shortInput(input: unknown): Record<string, unknown> {
  const out = obj(scrub(input));
  if (typeof out.body === "string" && out.body.length > 240) out.body = "(the email body, shown in the mailbox)";
  return out;
}

function modelName(modelId: string | null): string {
  if (modelId?.includes("claude-sonnet-4-5")) return "Claude Sonnet 4.5 on Amazon Bedrock AgentCore";
  return modelId ? `${modelId} on Amazon Bedrock AgentCore` : "Amazon Bedrock AgentCore";
}

export function buildSnapshot(src: SnapshotSources): ReplaySnapshot {
  const bySk = (sk: string) => src.items.find((i) => i.sk === sk) ?? null;
  const meta = bySk("META");
  if (!meta) throw new Error("no META item for this load");
  const loadId = String(meta.loadId);
  const signed = src.signedPack;
  if (signed.pack.loadId !== loadId) throw new Error("the pack belongs to another load");
  const clause = clauseById(String(meta.clauseId));
  const facility = facilityById(String(meta.facilityId));
  const language = (str(meta.language) ?? "en_US") as Language;
  const channel = meta.channel === "rcs" ? "rcs" : "whatsapp";
  const approvalItem = bySk("APPROVAL");
  const request = bySk("APPROVAL_REQUEST");
  const claimItem = bySk("CLAIM");
  const kind = runKindOf(meta, approvalItem);
  const synthetic = meta.synthetic === true;
  const driverProvenance: Provenance = synthetic ? "synthetic_input" : "recorded";
  const evaluation = signed.pack.evaluation;
  const packDigest = sha256(canonicalJson(signed.pack));

  // Messages and timeline, in time order. Ids are local to this file (m1, e1, ...).
  const messages: ChatMessage[] = [];
  const timeline: Array<Omit<TimelineEvent, "id">> = [];
  const events = src.items.filter((i) => String(i.sk).startsWith("EVENT#"));
  const sends = src.items.filter((i) => String(i.sk).startsWith("SEND#"));
  type Pending = { at: string; message?: Omit<ChatMessage, "id">; event?: Omit<TimelineEvent, "id" | "messageId"> };
  const pending: Pending[] = [];

  for (const e of events) {
    const type = String(e.type ?? "other");
    const outcome = String(e.outcome ?? "");
    const at = String(e.serverAt);
    const detail = obj(e.detail);
    const action = buttonAction(str(detail.payload));
    const { title, tone } = inboundTitle(type, outcome, action);
    const isApproval = action === "approve" || action === "hold";
    const party: ChatMessage["party"] = isApproval && meta.demo !== true ? "dispatcher" : "driver";
    const services = type === "failover" ? (["EUM Social", "SNS", "Lambda", "DynamoDB"] as ServiceTag[]) : INBOUND_SERVICES[str(e.channel) === "rcs" ? "rcs" : "whatsapp"]!;
    let message: Omit<ChatMessage, "id"> | undefined;
    const base = { at, direction: "in" as const, party, channel: (str(e.channel) === "rcs" ? "rcs" : "whatsapp") as ChatMessage["channel"], bodyProvenance: driverProvenance, provenance: driverProvenance };
    let eventDetail: string | undefined;
    if (type === "button") {
      message = { ...base, purpose: `tap_${action ?? "button"}`, kind: "buttons", body: `Tapped ${tapTitle(action, language)}`, buttons: [{ title: tapTitle(action, language), tapped: true }] };
    } else if (type === "location") {
      const lat = Number(detail.lat);
      const lon = Number(detail.lon);
      let inside: boolean | null = null;
      if (Number.isFinite(lat) && Number.isFinite(lon)) inside = checkGeofence([lon, lat], facility).inside;
      const note = `${inside === null ? "Location not checked" : inside ? "Inside the facility area" : "Outside the facility area"}. Coordinates are not shown.${facility.id === "demo-yard" || meta.demo === true ? " The demo yard is a test area." : ""}`;
      message = { ...base, purpose: "location", kind: "location", body: "Location shared", location: { insideGeofence: inside, note } };
      eventDetail = `${note} Time is ${channel === "rcs" ? "RCS" : "WhatsApp"} server time.`;
    } else if (type === "flow") {
      const bol = obj(meta.bol);
      const accepted = outcome === "ADVANCED";
      message = {
        ...base,
        purpose: "flow_reply",
        kind: "flow_reply",
        body: "Bill of lading form",
        ...(accepted
          ? {
              flowReply: {
                inTime: str(bol.inTime),
                outTime: str(bol.outTime),
                receiverSigned: bol.receiverSigned === true,
                delayReason: str(bol.delayReason),
                photoStored: Array.isArray(bol.photos) && bol.photos.some((p) => typeof obj(p).sha256 === "string"),
              },
            }
          : {}),
      };
    } else if (type === "image") {
      message = { ...base, purpose: "photo", kind: "image", body: "Photo" };
    } else if (type === "text") {
      message = { ...base, purpose: "text", kind: "text", body: scrubText(String(detail.text ?? "")) };
    }
    const record = obj(scrub({ ...e, sk: `EVENT#${at}` }));
    pending.push({ at, ...(message ? { message } : {}), event: { at, title, ...(eventDetail ? { detail: eventDetail } : {}), services, outcome, tone, record, provenance: driverProvenance } });
  }

  for (const s of sends) {
    const at = String(s.sentAt);
    const m = obj(s.message);
    const receipt = src.receipts[String(s.messageId)] ?? {};
    const receipts: NonNullable<ChatMessage["receipts"]> = {};
    for (const k of ["accepted", "sent", "delivered", "read", "failed"] as const) {
      const v = str(receipt[`${k}At`]);
      if (v) receipts[`${k}At`] = v;
    }
    const status: ChatMessage["status"] = receipts.failedAt ? "failed" : receipts.readAt ? "read" : receipts.deliveredAt ? "delivered" : receipts.sentAt ? "sent" : "accepted";
    const msgKind = String(m.kind ?? "text");
    const kindOut: ChatMessage["kind"] = msgKind === "card" ? "buttons" : msgKind === "unknown" ? "text" : (msgKind as ChatMessage["kind"]);
    const purpose = String(s.purpose);
    const message: Omit<ChatMessage, "id"> = {
      at,
      direction: "out",
      party: s.audience === "dispatcher" ? "dispatcher" : "driver",
      channel: s.channel === "rcs" ? "rcs" : "whatsapp",
      purpose,
      kind: kindOut,
      ...(m.template ? { templateName: String(obj(m.template).name) } : {}),
      body: scrubText([str(m.title), str(m.text), str(m.footer)].filter(Boolean).join("\n\n")),
      bodyProvenance: "recorded",
      ...(Array.isArray(m.buttons) && m.buttons.length ? { buttons: m.buttons.map((b) => ({ title: String(b) })) } : {}),
      ...(str(m.flowCta) ? { flowCta: String(m.flowCta) } : {}),
      status,
      receipts,
      provenance: "recorded",
    };
    pending.push({
      at,
      message,
      event: {
        at,
        title: `DockClock sent ${PURPOSE_WORDS[purpose] ?? purpose.replace(/_/g, " ")}`,
        services: s.channel === "rcs" ? ["Lambda", "EUM RCS"] : ["Lambda", "EUM Social"],
        tone: purpose === "dispatch_approval" ? "money" : "neutral",
        record: obj(scrub({ sk: `SEND#${at}`, channel: s.channel, purpose, audience: s.audience, message: m, receipts })),
        provenance: "recorded",
      },
    });
  }

  pending.sort((a, b) => a.at.localeCompare(b.at));
  for (const p of pending) {
    let messageId: string | undefined;
    if (p.message) {
      messageId = `m${messages.length + 1}`;
      messages.push({ id: messageId, ...p.message });
    }
    if (p.event) timeline.push({ ...p.event, ...(messageId ? { messageId } : {}) });
  }

  // Emails.
  const emails: EmailRecord[] = [];
  const counterparty = { name: clause.counterparty, role: clause.role, note: "Delivered to our test mailbox, not to a real company." };
  const notice = obj(meta.notice);
  let noticeEmailId: string | undefined;
  if (str(notice.sentAt)) {
    noticeEmailId = `x${emails.length + 1}`;
    const parsed = src.emails.notice ? parseMime(src.emails.notice) : null;
    emails.push({
      id: noticeEmailId,
      purpose: "notice",
      sentAt: String(notice.sentAt),
      ...(str(notice.deliveredAt) ? { deliveredAt: String(notice.deliveredAt) } : {}),
      from: addressOnly(parsed?.from ?? ""),
      to: counterparty,
      subject: parsed?.subject ?? `Detention notice: load ${loadId} at ${facility.name}`,
      ...(parsed
        ? { body: scrubText(parsed.text.trimEnd()), bodyProvenance: "recorded" as const, bodyNote: "The sent email's bytes, kept with the load's packs." }
        : { bodyNote: "This load's notice email bytes were not stored (DockClock keeps them from 2026-10-20 on)." }),
      attachments: [],
      provenance: "recorded",
    });
  }
  let claimEmailId: string | undefined;
  if (claimItem && str(claimItem.sentAt)) {
    claimEmailId = `x${emails.length + 1}`;
    const parsed = src.emails.claim ? parseMime(src.emails.claim) : null;
    emails.push({
      id: claimEmailId,
      purpose: "claim",
      sentAt: String(claimItem.sentAt),
      from: addressOnly(parsed?.from ?? ""),
      to: counterparty,
      subject: parsed?.subject ?? String(claimItem.subject ?? ""),
      ...(parsed
        ? { body: scrubText(parsed.text.trimEnd()), bodyProvenance: "recorded" as const, bodyNote: "The sent email's bytes, kept with the load's packs. The AWS key name in the footer is removed here." }
        : { bodyNote: "This load's claim email bytes were not stored (DockClock keeps them from 2026-10-20 on)." }),
      attachments: (parsed?.attachments ?? []).map((a) => ({
        ...a,
        note: a.name.endsWith(".pem") ? "The public key to check the signature." : a.contentType === "application/json" ? "The signed evidence pack, exactly as sealed." : "",
      })),
      provenance: "recorded",
    });
  }

  // Agent runs.
  const sealedCents = toCents(evaluation.amountUsd);
  const agentRuns: AgentRun[] = src.items
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
        ...(claimCall
          ? {
              guard: {
                amountCentsSent: Number(input.amountCents),
                amountCentsSealed: sealedCents,
                digestSent: String(input.packDigest ?? ""),
                digestSealed: packDigest,
                match: Number(input.amountCents) === sealedCents && input.packDigest === packDigest,
              },
            }
          : {}),
        ...(str(r.finalText) ? { text: scrubText(String(r.finalText)) } : str(r.error) ? { text: `The run failed: ${scrubText(String(r.error))}` } : {}),
        provenance: "recorded",
      } satisfies AgentRun;
    });

  // Workflow and money events.
  timeline.push({
    at: signed.pack.sealedAt,
    title: `The contract decided: ${verdictWords(evaluation.verdict)}${evaluation.amountUsd > 0 ? `, $${evaluation.amountUsd.toFixed(2)}` : ""}. Evidence sealed and signed`,
    services: ["Step Functions", "Lambda", "KMS", "S3 Object Lock"],
    tone: "money",
    record: { verdict: evaluation.verdict, reasons: evaluation.reasons, amountUsd: evaluation.amountUsd, packId: signed.pack.packId, digestSha256: packDigest },
    provenance: "recorded",
  });
  const bolReading = obj(meta.bolReading);
  if (str(bolReading.readAt)) {
    timeline.push({
      at: String(bolReading.readAt),
      title: bolReading.legible === true ? "The agent's photo tool read the bill of lading" : "The agent's photo tool could not read the bill of lading",
      services: ["Step Functions", "Lambda"],
      tone: "agent",
      record: obj(scrub({ legible: bolReading.legible, inTime: bolReading.inTime, outTime: bolReading.outTime, receiverSigned: bolReading.receiverSigned, model: bolReading.model })),
      provenance: "recorded",
    });
  }
  if (noticeEmailId) {
    const arrived = str(obj(meta.arrived).serverAt);
    const endsAt = arrived ? detentionStartsAt(clause, String(meta.appointmentAt), arrived) : null;
    const when = endsAt ? (Date.parse(String(notice.sentAt)) < Date.parse(endsAt) ? " before free time ended" : " after free time ended") : "";
    timeline.push({ at: String(notice.sentAt), title: `Detention notice emailed${when}`, services: ["EventBridge Scheduler", "Lambda", "SES"], tone: "money", emailId: noticeEmailId, provenance: "recorded" });
    if (str(notice.deliveredAt)) timeline.push({ at: String(notice.deliveredAt), title: "SES reported the notice delivered", services: ["SES", "SNS", "Lambda"], tone: "ok", emailId: noticeEmailId, provenance: "recorded" });
  }
  let approval: ApprovalInfo | null = null;
  const cliApproval = approvalItem?.approver === "operator-cli-test";
  if (request) {
    approval = {
      requestedAt: String(request.requestedAt),
      decidedAt: str(request.decidedAt),
      decision: request.decision === "approve" ? "approve" : request.decision === "hold" ? "hold" : null,
      approver: meta.demo === true ? "demo_driver" : "dispatcher",
    };
  }
  if (cliApproval) timeline.push({ at: String(approvalItem.approvedAt), title: "Approval recorded from the command line (test, not a tap)", services: ["DynamoDB"], tone: "ok", provenance: "recorded" });
  for (const run of agentRuns) {
    const claimCall = run.toolCalls.find((c) => c.name === "send_detention_claim");
    const filed = claimCall?.result?.ok === true;
    const refusedText = run.toolCalls.find((c) => c.result?.ok === false)?.result?.summary;
    timeline.push({
      at: run.startedAt,
      title:
        run.task === "review"
          ? "The AI agent reviewed the load"
          : filed
            ? "The AI agent filed the claim by email"
            : `The AI agent did not file${refusedText ? `: ${refusedText}` : " (no dispatch approval)"}`,
      services: filed ? ["Bedrock AgentCore", "AgentCore Gateway", "SES"] : ["Bedrock AgentCore", "AgentCore Gateway"],
      tone: run.task === "file_claim" && !filed ? "refused" : "agent",
      agentRunId: run.id,
      ...(filed && claimEmailId ? { emailId: claimEmailId } : {}),
      provenance: "recorded",
    });
  }

  let claim: ClaimInfo | null = null;
  if (claimItem) {
    const approvedAt = str(request?.decidedAt) ?? str(approvalItem?.approvedAt);
    const sentAt = str(claimItem.sentAt);
    claim = {
      status: claimItem.status === "sent" ? "sent" : "sending",
      amountUsd: Number(claimItem.amountUsd),
      amountCents: Number(claimItem.amountCents),
      packDigest: String(claimItem.packDigest),
      sentAt,
      subject: String(claimItem.subject ?? ""),
      secondsAfterApproval: approvedAt && sentAt ? Math.round((Date.parse(sentAt) - Date.parse(approvedAt)) / 100) / 10 : null,
    };
  }

  // The clause engine's inputs, rebuilt the way sealing builds them, so the page can re-run them.
  const pinOf = (pin: Item | null, signal: string) => {
    if (!pin || !str(pin.serverAt)) return null;
    const s = signed.pack.corroboration.signals.find((x) => x.name === signal);
    return { at: String(pin.serverAt), insideGeofence: s?.ok ?? false };
  };
  const bol = obj(meta.bol);
  const metaArrived = meta.arrived ? obj(meta.arrived) : null;
  const metaReleased = meta.released ? obj(meta.released) : null;
  const packBol = signed.pack.events.bol;
  const engineInput: ReplaySnapshot["verdict"]["engineInput"] = {
    appointmentAt: String(meta.appointmentAt),
    arrived: pinOf(metaArrived, "arrived_pin_in_geofence"),
    released: pinOf(metaReleased, "released_pin_in_geofence"),
    bol: packBol
      ? {
          signed: bol.channel !== "rcs" && bol.receiverSigned === true,
          checkIn: bol.channel === "rcs" ? null : localClockToIso(str(bol.inTime), str(metaArrived?.serverAt) ?? packBol.serverAt, facility.timeZone),
          checkOut: bol.channel === "rcs" ? null : localClockToIso(str(bol.outTime), str(metaReleased?.serverAt) ?? packBol.serverAt, facility.timeZone),
        }
      : null,
    status214: false,
    noticeSentAt: signed.pack.events.notice?.sentAt ?? null,
    shipperConfirmed: false,
    evaluatedAt: signed.pack.sealedAt,
  };
  const recomputed = evaluate({ loadId, clauseId: clause.id, facility: facility.name, ...engineInput } as LoadEvidence, clause);
  if (recomputed.verdict !== evaluation.verdict || recomputed.amountUsd !== evaluation.amountUsd) {
    throw new Error(`rebuilt engine inputs give ${recomputed.verdict} $${recomputed.amountUsd}, but the pack says ${evaluation.verdict} $${evaluation.amountUsd}`);
  }

  const arrivedAt = engineInput.arrived?.at ?? null;
  const notes: string[] = [];
  if (synthetic) notes.push("Driver messages: synthetic, replayed through the deployed stack by the integration test (load id prefix SMOKE-). Their times were set earlier than the run.");
  if (synthetic && sends.length === 0) notes.push("Messages to the driver were not sent (test number), so the phone shows only the driver's replayed replies.");
  if (sends.length > 0) notes.push("Outbound messages: the text DockClock recorded for each send, without the recipient.");
  if (cliApproval) notes.push("Approval: recorded from the command line for this test, not a tap on a phone.");
  else if (approvalItem?.approver === "dispatcher-whatsapp") notes.push("Approval: a real tap on a real phone.");
  if (claimEmailId) notes.push("Claim email: sent by Amazon SES to our test mailbox; shown here from its stored bytes.");
  if (noticeEmailId) notes.push("Detention notice: sent by Amazon SES to our test mailbox; delivery is SES's delivery event.");
  if (!signed.pack.corroboration.signals.find((s) => s.name === "bol_media_hashed")?.ok) notes.push("No bill-of-lading photo was stored in this run, so evidence confidence is low.");
  const summary =
    kind === "phone"
      ? "Recorded from a real phone: every message, time and email below is what DockClock stored."
      : kind === "demo"
        ? "A judge DEMO run on a real phone: the judge drove the load and approved the claim."
        : kind === "operator"
          ? "Test run: the driver's messages were replayed test messages. The approval tap, the AI agent, the signature and the emails were real."
          : "Test run: the driver's messages were replayed test messages and the approval was recorded from the command line. The AI agent, the signature and the emails were real.";

  const snapshot: ReplaySnapshot = {
    schema: "dockclock.replay/1",
    exportedAt: src.exportedAt,
    run: { kind, summary, notes } satisfies RunInfo,
    load: {
      loadId,
      facility: { id: facility.id, name: facility.name, timeZone: facility.timeZone },
      counterparty: { name: clause.counterparty, role: clause.role },
      appointmentAt: String(meta.appointmentAt),
      channel,
      language,
      demo: meta.demo === true,
    },
    clause: clauseInfo(clause),
    clock: {
      arrivedAt,
      releasedAt: engineInput.released?.at ?? null,
      clockStartAt: evaluation.clockStartAt,
      freeTimeEndsAt: arrivedAt ? detentionStartsAt(clause, String(meta.appointmentAt), arrivedAt) : null,
      detentionMinutes: evaluation.detentionMinutes,
      billableMinutes: evaluation.billableMinutes,
      driverTimes: driverProvenance,
    },
    messages,
    timeline: timeline.sort((a, b) => a.at.localeCompare(b.at)).map((t, i) => ({ id: `e${i + 1}`, ...t })),
    verdict: {
      verdict: evaluation.verdict,
      reasons: evaluation.reasons as ReasonCode[],
      amountUsd: evaluation.amountUsd,
      confidence: signed.pack.corroboration.confidence,
      signals: signed.pack.corroboration.signals.map((s) => ({ name: s.name, ok: s.ok, ...(s.independent !== undefined ? { independent: s.independent } : {}), detail: scrubText(s.detail) })),
      engineInput,
    },
    pack: {
      packId: signed.pack.packId,
      digestSha256: packDigest,
      algorithm: "ECDSA_SHA_256",
      signatureBase64: signed.signatureBase64,
      publicKeyPath: "keys/public-key.pem",
      spkiSha256: src.spkiSha256,
      sealedAt: signed.pack.sealedAt,
      storage: "S3 Object Lock (governance mode, 30 days)",
      // The signed bytes exactly as sealed: never scrubbed, only checked (see findLeaks).
      pack: signed.pack as unknown as Record<string, unknown>,
    },
    emails,
    agentRuns,
    approval,
    claim,
  };
  return snapshot;
}

function addressOnly(from: string): string {
  return /<([^>]+)>/.exec(from)?.[1] ?? from;
}
