// Builds the judge desk's replay file (site/src/snapshot.ts, schema dockclock.replay/1) from one
// load's stored records. Pure: the CLI in scripts/desk-snapshot.ts reads AWS and passes the records
// in. Everything that leaves here is scrubbed (@dockclock/sanitize), and findLeaks() is the gate the
// CLI, the read API and the tests share.
import { clauseById, detentionStartsAt } from "@dockclock/clause-engine";
import { canonicalJson, checkGeofence, facilityById, type SignedPack } from "@dockclock/evidence";
import { parseMime, scrub, scrubText } from "@dockclock/sanitize";
import { type Language } from "../../services/src/messages.js";
import { addressOnly, agentRunsOf, attachmentNote, isSynthetic, buttonAction, checkEngineInput, engineInputOf, clauseInfo, INBOUND_SERVICES, inboundTitle, obj, purposeWords, runKindOf, sha256, str, tapTitle, toCents, verdictWords, type Item } from "../../services/api/describe.js";
import type {
  ApprovalInfo,
  ChatMessage,
  ClaimInfo,
  EmailRecord,
  Provenance,
  ReasonCode,
  ReplaySnapshot,
  RunInfo,
  ServiceTag,
  TimelineEvent,
} from "../../site/src/snapshot.js";

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
  const synthetic = isSynthetic(meta);
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
        title: `DockClock sent ${purposeWords(purpose)}`,
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
      attachments: (parsed?.attachments ?? []).map((a) => ({ ...a, note: attachmentNote(a) })),
      provenance: "recorded",
    });
  }

  // Agent runs.
  const agentRuns = agentRunsOf(src.items, { cents: toCents(evaluation.amountUsd), digest: packDigest });

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
  const engineInput = engineInputOf(meta, signed, facility.timeZone);
  checkEngineInput(engineInput, { loadId, clause, facilityName: facility.name, evaluation });

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
