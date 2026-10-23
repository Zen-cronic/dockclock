// The console's own view model. Every screen reads these types; adapters turn the API
// (site/src/api.ts), its fixtures and the replay snapshots (snapshot.ts) into them, so a change in
// one source never reaches the components.
import type { ReplaySnapshot } from "../snapshot.js";

export type Channel = "whatsapp" | "rcs" | "email" | "sms";
export type Source = "live" | "fixture" | "replay";
export type RunKind = ReplaySnapshot["run"]["kind"];
export type Verdict = "BILLABLE" | "NOT_BILLABLE" | "NEEDS_HUMAN";

// One delivery state per message. Inbound messages are "received". "not_sent" means DockClock
// chose not to send (for example a test driver number).
export type MessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed" | "failover" | "received" | "not_sent";

export interface Photo {
  index: number;
  url: string;
  sha256: string | null;
  // True when the photo's sha256 equals the one sealed in the evidence pack.
  matchesPack: boolean | null;
  // "Fictional BOL, photographed on a real phone" or "Rendered test document".
  badge: string;
  legible: boolean | null;
  reading?: { inTime: string | null; outTime: string | null; signed: boolean | null; note?: string };
  // Why there is no image (a judge demo's photo is kept, not shown publicly).
  note?: string;
}

export interface ConsoleMessage {
  id: string;
  loadId: string;
  at: string;
  channel: Channel;
  direction: "in" | "out";
  party: "driver" | "dispatcher" | "counterparty";
  purpose: string;
  kind: "template" | "text" | "buttons" | "location_request" | "location" | "flow" | "flow_reply" | "image" | "card" | "email";
  body: string;
  status: MessageStatus;
  receipts?: { acceptedAt?: string; sentAt?: string; deliveredAt?: string; readAt?: string; failedAt?: string };
  // A WhatsApp send that failed and was re-sent on RCS, or the RCS re-send itself.
  failover?: { from: Channel; to: Channel; note: string };
  title?: string;
  buttons?: Array<{ title: string; tapped?: boolean }>;
  location?: { insideGeofence: boolean | null; note: string };
  flowReply?: { inTime: string | null; outTime: string | null; receiverSigned: boolean; delayReason: string | null; photoStored: boolean };
  photo?: Photo;
  emailId?: string;
  subject?: string;
  notSentReason?: string;
  synthetic: boolean;
  // Text was rebuilt from a template because the sent body was not stored.
  rebuilt: boolean;
}

// One row of the channel monitor: a message or an email on any load.
export interface FeedRow {
  id: string;
  at: string;
  loadId: string;
  runKind: RunKind;
  channel: Channel;
  direction: "in" | "out";
  party: "driver" | "dispatcher" | "counterparty";
  purpose: string;
  preview: string;
  status: MessageStatus;
  failover: boolean;
  synthetic: boolean;
  // The load-local id of the message (m3) or email (claim), for opening it.
  localId: string;
  isEmail: boolean;
}

export interface ConsoleEmail {
  id: string;
  loadId: string;
  purpose: "notice" | "claim" | "dispatch_escalation";
  sentAt: string;
  status: "sent" | "delivered" | "bounced" | "not_sent";
  deliveredAt?: string;
  bouncedAt?: string;
  from: string;
  to: string;
  toNote: string;
  subject: string;
  body?: string;
  bodyStored: boolean;
  attachments: Array<{ name: string; sha256?: string }>;
}

export interface TimelineItem {
  id: string;
  at: string;
  title: string;
  detail?: string;
  services: string[];
  tone: "neutral" | "money" | "agent" | "ok" | "refused";
  outcome?: string;
  record?: Record<string, unknown>;
  synthetic: boolean;
}

export interface AgentStep {
  name: string;
  input: Record<string, unknown>;
  policy?: { decision: "permit" | "deny"; rule: string; inferred: boolean };
  ok: boolean;
  summary: string;
}

export interface AgentRun {
  id: string;
  task: string;
  startedAt: string;
  endedAt?: string;
  model: string;
  steps: AgentStep[];
  guard?: { match: boolean; amountCents: number; digest: string };
  text?: string;
  filed: boolean;
}

export interface LoadSummary {
  id: string;
  facility: string;
  counterparty: string;
  channel: "whatsapp" | "rcs";
  phase: string;
  verdict: Verdict | null;
  amountUsd: number;
  runKind: RunKind;
  createdAt: string;
  source: Source;
  failover: boolean;
}

export interface LoadDetail {
  summary: LoadSummary;
  snapshot: ReplaySnapshot | null;
  run: ReplaySnapshot["run"];
  timeZone: string;
  clock: ReplaySnapshot["clock"];
  // For a load still in progress: the moment the clock values are as of.
  asOf: string | null;
  clause: ReplaySnapshot["clause"];
  verdict: ReplaySnapshot["verdict"] | null;
  // The full signed pack when it travels with the load (replays); otherwise fetched on demand.
  pack: ReplaySnapshot["pack"] | null;
  packSummary: { packId: string; digestSha256: string; sealedAt: string; storage: string } | null;
  approval: ReplaySnapshot["approval"];
  claim: ReplaySnapshot["claim"];
  messages: ConsoleMessage[];
  emails: ConsoleEmail[];
  timeline: TimelineItem[];
  agentRuns: AgentRun[];
  photos: Photo[];
  // The workflow's own step states from the read API (replays have none). Shows steps that were
  // skipped or failed, which no record marks on its own.
  workflow?: WorkflowStep[];
}

export interface WorkflowStep {
  key: string;
  label: string;
  state: "done" | "current" | "waiting" | "skipped" | "failed";
  at: string | null;
  services: string[];
  detail?: string;
}

export interface Overview {
  source: Source;
  generatedAt: string;
  loads: number;
  claimsFiled: number;
  claimedUsd: number;
  messages: number;
  // Delivered (or read) out of real sends whose outcome is known; test sends that were never sent
  // and sends with no delivery event yet are left out, so test data cannot drag the rate down.
  deliveredPct: number | null;
  deliveryTracked: number;
  emailsDelivered: number;
  emailsSent: number;
  notSent: number;
  failovers: number;
  byChannel: Array<{ channel: Channel; outbound: number; inbound: number }>;
  activity: Array<{ id: string; at: string; loadId: string; title: string; tone: TimelineItem["tone"]; href: string }>;
}
