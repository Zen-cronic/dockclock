// The cross-load views of the read API: the message feed and the overview, built from load views.
import type { ActivityItem, Channel, FeedItem, LoadView, MessageFeed, MessageStatus, Overview } from "../../site/src/api.js";

export interface FeedFilters {
  channel?: Channel;
  status?: MessageStatus;
  direction?: "in" | "out";
  loadId?: string;
}

function preview(...parts: Array<string | undefined>): string {
  const line = parts.filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

export function feedItemsOf(view: LoadView): FeedItem[] {
  const { loadId, runKind } = view.summary;
  const messages: FeedItem[] = view.messages.map((m) => ({
    id: `${loadId}:${m.id}`,
    at: m.at,
    loadId,
    runKind,
    channel: m.channel,
    direction: m.direction,
    party: m.party,
    purpose: m.purpose,
    kind: m.kind,
    preview: preview(m.title, m.body),
    status: m.status,
    ...(m.failover ? { failover: m.failover } : {}),
    provenance: m.provenance,
    href: `/loads/${loadId}?tab=conversation#${m.id}`,
  }));
  const emails: FeedItem[] = view.emails.map((e) => ({
    id: `${loadId}:${e.id}`,
    at: e.sentAt,
    loadId,
    runKind,
    channel: "email",
    direction: "out",
    party: e.purpose === "dispatch_escalation" ? "dispatcher" : "counterparty",
    purpose: e.purpose,
    kind: "email",
    preview: preview(e.subject),
    status: e.status,
    provenance: e.provenance,
    href: `/loads/${loadId}?tab=emails#${e.id}`,
  }));
  return [...messages, ...emails];
}

// Newest first; a cursor is the (at, id) of the last item already returned.
export function feedOf(views: LoadView[], filters: FeedFilters, limit: number, after: { at: string; id: string } | null): MessageFeed {
  const all = views.flatMap(feedItemsOf).sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
  const channelsWithRecords = [...new Set(all.map((i) => i.channel))].sort() as Channel[];
  const matching = all.filter(
    (i) =>
      (!filters.channel || i.channel === filters.channel) &&
      (!filters.status || i.status === filters.status) &&
      (!filters.direction || i.direction === filters.direction) &&
      (!filters.loadId || i.loadId === filters.loadId),
  );
  const start = after ? matching.findIndex((i) => i.at < after.at || (i.at === after.at && i.id < after.id)) : 0;
  const page = start === -1 ? [] : matching.slice(start, start + limit);
  const last = page.at(-1);
  const more = start !== -1 && start + limit < matching.length;
  return {
    items: page,
    nextCursor: more && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url") : null,
    filters,
    channelsWithRecords,
  };
}

function activityKind(e: LoadView["timeline"][number]): ActivityItem["kind"] {
  if (e.agentRunId) return "agent";
  if (e.outcome && /RCS|ESCALATED/.test(e.outcome) && !e.messageId) return "failover";
  if (e.emailId) return e.emailId === "claim" ? "claim" : "email";
  if (e.messageId) return "message";
  if (/approv/i.test(e.title)) return "approval";
  return "workflow";
}

export function overviewOf(views: LoadView[], now: string): Overview {
  const byChannel: Overview["messages"]["byChannel"] = { whatsapp: { outbound: 0, inbound: 0 }, rcs: { outbound: 0, inbound: 0 }, sms: { outbound: 0, inbound: 0 }, email: { outbound: 0, inbound: 0 } };
  const byStatus: Overview["messages"]["byStatus"] = {};
  const delivery = { outbound: 0, delivered: 0, read: 0, failed: 0 };
  const emails = { sent: 0, delivered: 0, bounced: 0 };
  const loads: Overview["loads"] = { total: views.length, live: 0, byStatus: {}, byVerdict: {} };
  let filed = 0;
  let amountUsd = 0;
  let refusedAgentRuns = 0;
  let failovers = 0;
  for (const view of views) {
    const s = view.summary;
    if (s.live) loads.live += 1;
    loads.byStatus[s.status] = (loads.byStatus[s.status] ?? 0) + 1;
    if (s.verdict) loads.byVerdict[s.verdict] = (loads.byVerdict[s.verdict] ?? 0) + 1;
    if (s.failover) failovers += 1;
    if (view.claim?.status === "sent") {
      filed += 1;
      amountUsd += view.claim.amountUsd;
    }
    refusedAgentRuns += view.agentRuns.filter((r) => r.task === "file_claim" && !r.toolCalls.some((c) => c.name === "send_detention_claim" && c.result?.ok)).length;
    for (const m of view.messages) {
      byChannel[m.channel][m.direction === "out" ? "outbound" : "inbound"] += 1;
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      if (m.direction === "out" && m.status !== "not_sent") {
        delivery.outbound += 1;
        if (m.status === "delivered" || m.status === "read") delivery.delivered += 1;
        if (m.status === "read") delivery.read += 1;
        if (m.status === "failed") delivery.failed += 1;
      }
    }
    for (const e of view.emails) {
      byChannel.email.outbound += 1;
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      if (e.status !== "not_sent") emails.sent += 1;
      if (e.status === "delivered") emails.delivered += 1;
      if (e.status === "bounced") emails.bounced += 1;
    }
  }
  const activity: ActivityItem[] = views
    .flatMap((view) =>
      view.timeline.map((e) => ({
        id: `${view.summary.loadId}:${e.id}`,
        at: e.at,
        loadId: view.summary.loadId,
        runKind: view.summary.runKind,
        kind: activityKind(e),
        ...(e.channel ? { channel: e.channel } : {}),
        title: e.title,
        tone: e.tone,
        href: `/loads/${view.summary.loadId}?tab=timeline#${e.id}`,
      })),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 20);
  const created = views.map((v) => v.summary.createdAt).sort();
  return {
    window: { loads: views.length, from: created[0] ?? null, to: now },
    loads,
    claims: { filed, amountUsd: Math.round(amountUsd * 100) / 100, refusedAgentRuns },
    messages: { byChannel, byStatus },
    delivery: {
      ...delivery,
      deliveryRate: delivery.outbound ? delivery.delivered / delivery.outbound : null,
      failovers,
      failoverRate: views.length ? failovers / views.length : null,
    },
    emails,
    activity,
  };
}
