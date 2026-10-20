// Adapter: a sanitized replay snapshot (snapshot.ts) into the console's view model.
import type { ReplaySnapshot } from "../snapshot.js";
import type { AgentRun, ConsoleEmail, ConsoleMessage, LoadDetail, LoadSummary, Overview, Source, TimelineItem } from "./model.js";

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

function agentRunsFromReplay(s: ReplaySnapshot): AgentRun[] {
  return s.agentRuns.map((r) => {
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
    approval: s.approval,
    claim: s.claim,
    messages: messagesFromReplay(s),
    emails: emailsFromReplay(s),
    timeline: timelineFromReplay(s),
    agentRuns: agentRunsFromReplay(s),
    photos: [],
  };
}

// Messages across loads, emails included, newest first.
export function feedFromDetails(details: LoadDetail[]): ConsoleMessage[] {
  const all: ConsoleMessage[] = [];
  for (const d of details) {
    all.push(...d.messages);
    for (const e of d.emails)
      all.push({
        id: e.id,
        loadId: e.loadId,
        at: e.sentAt,
        channel: "email",
        direction: "out",
        party: "counterparty",
        purpose: e.purpose,
        kind: "email",
        body: e.subject,
        subject: e.subject,
        emailId: e.id,
        status: e.bouncedAt ? "failed" : e.deliveredAt ? "delivered" : "sent",
        synthetic: false,
        rebuilt: false,
      });
  }
  return all.sort((a, b) => b.at.localeCompare(a.at));
}

export function overviewFromDetails(details: LoadDetail[], source: Source): Overview {
  const feed = feedFromDetails(details);
  const channels = ["whatsapp", "rcs", "email", "sms"] as const;
  const outbound = feed.filter((m) => m.direction === "out" && m.status !== "not_sent");
  const delivered = outbound.filter((m) => m.status === "delivered" || m.status === "read").length;
  const activity = details
    .flatMap((d) =>
      d.timeline.map((t) => ({
        id: `${d.summary.id}:${t.id}`,
        at: t.at,
        loadId: d.summary.id,
        channel: (t.services.includes("SES") ? "email" : t.services.includes("EUM RCS") ? "rcs" : t.services.includes("EUM Social") ? "whatsapp" : "system") as Overview["activity"][number]["channel"],
        title: t.title,
        tone: t.tone,
      })),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
  return {
    source,
    generatedAt: new Date().toISOString(),
    loads: details.length,
    claimsFiled: details.filter((d) => d.claim?.status === "sent").length,
    claimedUsd: details.reduce((n, d) => n + (d.claim?.status === "sent" ? d.claim.amountUsd : 0), 0),
    messages: feed.length,
    deliveredPct: outbound.length ? Math.round((delivered / outbound.length) * 100) : null,
    failovers: feed.filter((m) => m.failover).length,
    byChannel: channels
      .map((channel) => {
        const ms = feed.filter((m) => m.channel === channel);
        return {
          channel,
          sent: ms.filter((m) => m.direction === "out" && m.status !== "not_sent").length,
          received: ms.filter((m) => m.direction === "in").length,
          delivered: ms.filter((m) => m.status === "delivered" || m.status === "read").length,
          failed: ms.filter((m) => m.status === "failed").length,
        };
      })
      .filter((c) => c.channel !== "sms" || c.sent + c.received > 0),
    activity,
  };
}
