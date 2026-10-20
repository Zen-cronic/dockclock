// Adapter: a sanitized replay snapshot (snapshot.ts) into the console's view model.
import type { ReplaySnapshot } from "../snapshot.js";
import type { AgentRun, ConsoleEmail, ConsoleMessage, FeedRow, LoadDetail, LoadSummary, Overview, Source, TimelineItem } from "./model.js";

export function summaryFromReplay(s: ReplaySnapshot, source: Source): LoadSummary {
  return {
    id: s.load.loadId,
    facility: s.load.facility.name,
    counterparty: s.load.counterparty.name,
    channel: s.load.channel,
    phase: s.claim?.status === "sent" ? "claim_filed" : "sealed",
    verdict: s.verdict.verdict,
    amountUsd: s.verdict.amountUsd,
    runKind: s.run.kind,
    createdAt: s.clock.arrivedAt ?? s.load.appointmentAt,
    source,
    failover: s.timeline.some((e) => /failover|resent on rcs/i.test(`${e.title} ${e.outcome ?? ""}`)),
  };
}

function messagesFromReplay(s: ReplaySnapshot): ConsoleMessage[] {
  return s.messages.map((m) => {
    const status: ConsoleMessage["status"] = m.direction === "in" ? "received" : (m.status ?? "accepted");
    const out: ConsoleMessage = {
      id: `${s.load.loadId}:${m.id}`,
      loadId: s.load.loadId,
      at: m.at,
      channel: m.channel,
      direction: m.direction,
      party: m.party,
      purpose: m.purpose,
      kind: m.kind,
      body: m.body,
      status,
      synthetic: m.provenance === "synthetic_input",
      rebuilt: m.bodyProvenance === "rendered_from_template",
    };
    if (m.receipts) out.receipts = { ...m.receipts };
    if (m.buttons) out.buttons = m.buttons.map((b) => (b.tapped === undefined ? { title: b.title } : { title: b.title, tapped: b.tapped }));
    if (m.location) out.location = m.location;
    if (m.flowReply) out.flowReply = m.flowReply;
    if (m.templateName) out.title = m.templateName.replace("dockclock_", "").replace(/_/g, " ");
    return out;
  });
}

function emailsFromReplay(s: ReplaySnapshot): ConsoleEmail[] {
  return s.emails.map((e) => {
    const out: ConsoleEmail = {
      id: `${s.load.loadId}:${e.id}`,
      loadId: s.load.loadId,
      purpose: e.purpose,
      sentAt: e.sentAt,
      status: e.deliveredAt ? "delivered" : "sent",
      bodyStored: Boolean(e.body),
      from: e.from,
      to: e.to.name,
      toNote: e.to.note,
      subject: e.subject,
      attachments: e.attachments.map((a) => (a.sha256 ? { name: a.name, sha256: a.sha256 } : { name: a.name })),
    };
    if (e.deliveredAt) out.deliveredAt = e.deliveredAt;
    if (e.body) out.body = e.body;
    return out;
  });
}

function timelineFromReplay(s: ReplaySnapshot): TimelineItem[] {
  return s.timeline.map((e) => {
    const out: TimelineItem = { id: e.id, at: e.at, title: e.title, services: e.services, tone: e.tone, synthetic: e.provenance === "synthetic_input" };
    if (e.detail) out.detail = e.detail;
    if (e.outcome) out.outcome = e.outcome;
    if (e.record) out.record = e.record;
    return out;
  });
}

export function agentRunsFrom(runs: ReplaySnapshot["agentRuns"]): AgentRun[] {
  return runs.map((r) => {
    const out: AgentRun = {
      id: r.id,
      task: r.task,
      startedAt: r.startedAt,
      model: r.model,
      steps: r.toolCalls.map((t) => {
        const step: AgentRun["steps"][number] = { name: t.name, input: t.input, ok: t.result?.ok !== false, summary: t.result?.summary ?? "" };
        if (t.cedar) step.policy = { decision: t.cedar.decision, rule: t.cedar.policy, inferred: t.cedar.decisionSource === "inferred" };
        return step;
      }),
      filed: r.toolCalls.some((t) => t.name === "send_detention_claim" && t.result?.ok !== false),
    };
    if (r.endedAt) out.endedAt = r.endedAt;
    if (r.guard) out.guard = { match: r.guard.match, amountCents: r.guard.amountCentsSent, digest: r.guard.digestSent };
    if (r.text) out.text = r.text;
    return out;
  });
}

export function detailFromReplay(s: ReplaySnapshot, source: Source): LoadDetail {
  return {
    summary: summaryFromReplay(s, source),
    snapshot: s,
    run: s.run,
    timeZone: s.load.facility.timeZone,
    clock: s.clock,
    clause: s.clause,
    verdict: s.verdict,
    pack: s.pack,
    packSummary: { packId: s.pack.packId, digestSha256: s.pack.digestSha256, sealedAt: s.pack.sealedAt, storage: s.pack.storage },
    approval: s.approval,
    claim: s.claim,
    messages: messagesFromReplay(s),
    emails: emailsFromReplay(s),
    timeline: timelineFromReplay(s),
    agentRuns: agentRunsFrom(s.agentRuns),
    photos: [],
  };
}

// Messages across loads, emails included, newest first.
export function feedFromDetails(details: LoadDetail[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const d of details) {
    for (const m of d.messages)
      rows.push({ id: m.id, at: m.at, loadId: d.summary.id, runKind: d.summary.runKind, channel: m.channel, direction: m.direction, party: m.party, purpose: m.purpose, preview: m.body, status: m.status, failover: Boolean(m.failover), synthetic: m.synthetic, localId: m.id.split(":").pop() ?? m.id, isEmail: false });
    for (const e of d.emails)
      rows.push({ id: e.id, at: e.sentAt, loadId: d.summary.id, runKind: d.summary.runKind, channel: "email", direction: "out", party: "counterparty", purpose: e.purpose, preview: e.subject, status: e.status === "bounced" ? "failed" : e.status, failover: false, synthetic: false, localId: e.id.split(":").pop() ?? e.id, isEmail: true });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

export function overviewFromDetails(details: LoadDetail[], source: Source): Overview {
  const feed = feedFromDetails(details);
  const tracked = feed.filter((m) => m.direction === "out" && !m.synthetic && ["delivered", "read", "failed"].includes(m.status));
  const delivered = tracked.filter((m) => m.status === "delivered" || m.status === "read").length;
  const activity = details
    .flatMap((d) => d.timeline.map((t) => ({ id: `${d.summary.id}:${t.id}`, at: t.at, loadId: d.summary.id, title: t.title, tone: t.tone, href: `/loads/${d.summary.id}` })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
  const channels = ["whatsapp", "rcs", "email", "sms"] as const;
  return {
    source,
    generatedAt: new Date().toISOString(),
    loads: details.length,
    claimsFiled: details.filter((d) => d.claim?.status === "sent").length,
    claimedUsd: details.reduce((n, d) => n + (d.claim?.status === "sent" ? d.claim.amountUsd : 0), 0),
    messages: feed.length,
    deliveredPct: tracked.length ? Math.round((delivered / tracked.length) * 100) : null,
    deliveryTracked: tracked.length,
    failovers: details.filter((d) => d.summary.failover).length,
    byChannel: channels
      .map((channel) => ({ channel, outbound: feed.filter((m) => m.channel === channel && m.direction === "out").length, inbound: feed.filter((m) => m.channel === channel && m.direction === "in").length }))
      .filter((c) => c.channel !== "sms" || c.outbound + c.inbound > 0),
    activity,
  };
}
