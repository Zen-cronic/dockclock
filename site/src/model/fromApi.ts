// Adapter: the read API (site/src/api.ts, schema dockclock.api/1) into the console's view model.
import type * as Api from "../api.js";
import { agentRunsFrom } from "./fromReplay.js";
import type { ConsoleEmail, ConsoleMessage, FeedRow, LoadDetail, LoadSummary, MessageStatus, Overview, Photo, Source, TimelineItem } from "./model.js";

const KIND: Record<string, ConsoleMessage["kind"]> = {
  wa_template: "template",
  wa_text: "text",
  wa_reply_buttons: "buttons",
  wa_location_request: "location_request",
  wa_flow: "flow",
  wa_button_reply: "buttons",
  wa_location: "location",
  wa_flow_reply: "flow_reply",
  wa_image: "image",
  wa_text_reply: "text",
  rcs_rich_card: "card",
  rcs_text: "text",
  rcs_location_request: "location_request",
  rcs_suggestion_reply: "buttons",
  rcs_location: "location",
  rcs_media: "image",
  rcs_text_reply: "text",
  sms_text: "text",
};

// The API's "bounced" is an email that failed; the console shows both as failed.
function status(s: string): MessageStatus {
  if (s === "bounced") return "failed";
  return s as MessageStatus;
}

export function summaryFromApi(l: Api.LoadSummary, source: Source): LoadSummary {
  return {
    id: l.loadId,
    facility: l.facility.name,
    counterparty: l.counterparty.name,
    channel: l.channel,
    phase: l.status,
    verdict: l.verdict,
    amountUsd: l.amountUsd ?? 0,
    runKind: l.runKind,
    createdAt: l.createdAt,
    source,
    failover: l.failover,
  };
}

// Photo provenance in words, from what the image is, not from whether the record is real.
export function photoBadge(source: Api.PhotoSource): string {
  if (source === "phone_camera") return "Fictional BOL, photographed on a real phone";
  if (source === "rendered_fictional_document") return "Rendered test document";
  return "Test stand-in";
}

function photosFromApi(v: Api.LoadView, resolveUrl: (u: string) => string): Photo[] {
  return v.photos.map((p) => {
    const out: Photo = {
      index: p.page,
      url: p.url ? resolveUrl(p.url) : "",
      sha256: p.sha256,
      matchesPack: p.matchesPack,
      badge: photoBadge(p.source),
      legible: p.legible ?? null,
    };
    if (p.reading) out.reading = { inTime: p.reading.inTime, outTime: p.reading.outTime, signed: p.reading.receiverSigned };
    return out;
  });
}

function messagesFromApi(v: Api.LoadView, photos: Photo[]): ConsoleMessage[] {
  const byId = new Map(v.photos.map((p, i) => [p.id, photos[i]]));
  return v.messages.map((m) => {
    const out: ConsoleMessage = {
      id: `${v.summary.loadId}:${m.id}`,
      loadId: v.summary.loadId,
      at: m.at,
      channel: m.channel,
      direction: m.direction,
      party: m.party,
      purpose: m.purpose,
      kind: KIND[m.kind] ?? "text",
      body: m.body,
      status: status(m.status),
      synthetic: m.provenance === "synthetic_input",
      rebuilt: m.provenance === "rendered_from_template",
    };
    if (m.title) out.title = m.title;
    if (m.receipts) out.receipts = { ...m.receipts };
    if (m.actions) out.buttons = m.actions.map((a) => (a.tapped === undefined ? { title: a.title } : { title: a.title, tapped: a.tapped }));
    if (m.location) out.location = m.location;
    if (m.flowReply) out.flowReply = { ...m.flowReply, photoStored: v.photos.length > 0 };
    if (m.failover?.action === "rerouted_to_rcs") out.failover = { from: "whatsapp", to: "rcs", note: "WhatsApp failed; resent on RCS" };
    const photo = m.photoId ? byId.get(m.photoId) : undefined;
    if (photo) out.photo = photo;
    const reason = (m as { notSentReason?: string }).notSentReason;
    if (reason) out.notSentReason = reason;
    return out;
  });
}

function emailsFromApi(v: Api.LoadView): ConsoleEmail[] {
  return v.emails.map((e) => {
    const out: ConsoleEmail = {
      id: `${v.summary.loadId}:${e.id}`,
      loadId: v.summary.loadId,
      purpose: e.purpose,
      sentAt: e.sentAt,
      status: e.status as ConsoleEmail["status"],
      from: e.from,
      to: e.to.name,
      toNote: e.to.note,
      subject: e.subject,
      bodyStored: e.bodyStored,
      attachments: e.attachments.map((a) => (a.sha256 ? { name: a.name, sha256: a.sha256 } : { name: a.name })),
    };
    if (e.deliveredAt) out.deliveredAt = e.deliveredAt;
    if (e.bouncedAt) out.bouncedAt = e.bouncedAt;
    return out;
  });
}

function timelineFromApi(v: Api.LoadView): TimelineItem[] {
  return v.timeline.map((e) => {
    const out: TimelineItem = { id: e.id, at: e.at, title: e.title, services: e.services, tone: e.tone, synthetic: e.provenance === "synthetic_input" };
    if (e.detail) out.detail = e.detail;
    if (e.outcome) out.outcome = e.outcome;
    if (e.record) out.record = e.record;
    return out;
  });
}

export function detailFromApi(v: Api.LoadView, source: Source, resolveUrl: (u: string) => string = (u) => u): LoadDetail {
  const photos = photosFromApi(v, resolveUrl);
  return {
    summary: summaryFromApi(v.summary, source),
    snapshot: null,
    run: v.run,
    timeZone: v.summary.facility.timeZone,
    clock: {
      arrivedAt: v.clock.arrivedAt,
      releasedAt: v.clock.releasedAt,
      clockStartAt: v.clock.clockStartAt,
      freeTimeEndsAt: v.clock.freeTimeEndsAt,
      detentionMinutes: v.clock.detentionMinutes,
      billableMinutes: v.clock.billableMinutes,
      driverTimes: v.clock.driverTimes,
    },
    asOf: v.summary.live ? v.clock.asOf : null,
    clause: v.clause,
    verdict: v.verdict,
    pack: null,
    packSummary: v.pack ? { packId: v.pack.packId, digestSha256: v.pack.digestSha256, sealedAt: v.pack.sealedAt, storage: v.pack.storage } : null,
    approval: v.approval,
    claim: v.claim,
    messages: messagesFromApi(v, photos),
    emails: emailsFromApi(v),
    timeline: timelineFromApi(v),
    agentRuns: agentRunsFrom(v.agentRuns),
    photos,
    workflow: (v.workflow ?? []).map((w) => ({ key: w.key, label: w.label, state: w.state, at: w.at, services: [...w.services], ...(w.detail ? { detail: w.detail } : {}) })),
  };
}

export function feedFromApi(f: Api.MessageFeed): FeedRow[] {
  return f.items.map((i) => ({
    id: i.id,
    at: i.at,
    loadId: i.loadId,
    runKind: i.runKind,
    channel: i.channel,
    direction: i.direction,
    party: i.party,
    purpose: i.purpose,
    preview: i.preview,
    status: status(i.status),
    failover: Boolean(i.failover),
    synthetic: i.provenance === "synthetic_input",
    localId: i.id.split(":").pop() ?? i.id,
    isEmail: i.channel === "email",
  }));
}

export function overviewFromApi(o: Api.Overview, source: Source, generatedAt: string): Overview {
  const d = o.delivery;
  // Delivered out of sends with a known outcome; the API counts test sends that were never sent
  // as not_sent, not as outbound.
  const tracked = d.delivered + d.failed;
  return {
    source,
    generatedAt,
    loads: o.loads.total,
    claimsFiled: o.claims.filed,
    claimedUsd: o.claims.amountUsd,
    messages: Object.values(o.messages.byChannel).reduce((n, c) => n + c.outbound + c.inbound, 0),
    deliveredPct: tracked ? Math.round((d.delivered / tracked) * 100) : null,
    deliveryTracked: tracked,
    emailsDelivered: o.emails.delivered,
    emailsSent: o.emails.sent,
    notSent: o.messages.byStatus.not_sent ?? 0,
    failovers: d.failovers,
    byChannel: (Object.entries(o.messages.byChannel) as Array<[Api.Channel, { outbound: number; inbound: number }]>)
      .map(([channel, c]) => ({ channel, outbound: c.outbound, inbound: c.inbound }))
      .filter((c) => c.channel !== "sms" || c.outbound + c.inbound > 0),
    activity: o.activity.filter((a) => !/\(not sent\b/i.test(a.title)).map((a) => ({ id: a.id, at: a.at, loadId: a.loadId, title: a.title, tone: a.tone, href: a.href.replace(/\?tab=([a-z]+)/, "/$1") })),
  };
}
