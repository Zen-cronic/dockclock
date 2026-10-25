// The console read API contract (schema dockclock.api/1). The backend Lambda behind CloudFront
// /api/* returns exactly these shapes; the fixtures in site/fixtures/api/ are examples of them.
//
// What every response promises:
// - Only the public demo workspace: demo (DEMO keyword), judge and test (SMOKE-) loads, plus
//   operator loads dispatched with --workspace demo. Any other load id answers 404.
// - Sanitized and checked: no coordinates, phone numbers, BSUIDs, WhatsApp message ids, S3 keys,
//   ARNs or AWS account id. A response that fails the check is never sent (the API answers 500).
// - Every company is fictional. Every time is an ISO-8601 UTC instant; show it in the facility's
//   time zone (load.facility.timeZone), labelled.
// - Ids inside a load (m1, e1, a1, p1) are stable while the load's records grow in time order.
// - Read only. Nothing here sends a message or changes a load.
//
// Routes (all GET):
//   /api/overview                              Overview
//   /api/loads?limit=&cursor=                  LoadsPage
//   /api/loads/:id                             LoadView (works while the load is in progress)
//   /api/messages?channel=&status=&direction=&loadId=&limit=&cursor=   MessageFeed
//   /api/loads/:id/pack                        SignedPackInfo (the exact signed object)
//   /api/loads/:id/emails/:emailId             EmailView (emailId: notice | claim | escalation-<n>)
//   /api/loads/:id/photos/:n                   image/jpeg or image/png bytes, metadata stripped;
//                                              header x-dockclock-original-sha256 is the pack's hash
//
// SMS is in the channel enum so filters and badges have a slot for it, but DockClock does not send
// or receive SMS today; no record will carry it. Show the SMS filter only when a record exists.

import type { AgentRun, ApprovalInfo, ClaimInfo, ClauseInfo, Provenance, RunInfo, RunKind, ServiceTag, SignedPackInfo, VerdictInfo } from "./snapshot.js";

export type { AgentRun, ApprovalInfo, ClaimInfo, ClauseInfo, Provenance, RunInfo, RunKind, ServiceTag, SignedPackInfo, VerdictInfo } from "./snapshot.js";

export const API_SCHEMA = "dockclock.api/1" as const;

// Every successful response.
export interface ApiResponse<T> {
  schema: typeof API_SCHEMA;
  generatedAt: string;
  workspace: "demo";
  // Poll again after this many ms while something can still change (an in-progress load); null when
  // the data is final. CloudFront caches each response for about 3 s.
  pollMs: number | null;
  data: T;
}

// Every error response: 404 for an unknown or non-demo load (or a missing pack, email or photo),
// 400 for a bad parameter, 415 for a stored photo that is not a JPEG or PNG, and 500 when a read
// failed or the response failed its sanitization check.
export interface ApiError {
  schema: typeof API_SCHEMA;
  error: { status: 400 | 404 | 415 | 500; code: "bad_request" | "not_found" | "unsupported_media" | "internal"; message: string };
}

export type Channel = "whatsapp" | "rcs" | "sms" | "email";
export type DriverChannel = "whatsapp" | "rcs";

// Delivery state of one message. Outbound: accepted -> sent -> delivered -> read, or failed.
// Inbound: received. Email: sent -> delivered, or bounced. not_sent: DockClock composed the message
// but its send gate stopped it (a test number, replies off, or the driver replied STOP); the
// reason is in notSentReason. Test loads show their whole conversation this way.
export type MessageStatus = "accepted" | "sent" | "delivered" | "read" | "failed" | "received" | "bounced" | "not_sent";

// The workflow phase as stored on the load.
export type Phase = "dispatched" | "awaiting_arrival_pin" | "at_dock" | "awaiting_release_pin" | "awaiting_bol" | "documented" | "sealed" | "closed";

// One plain status for lists and pills, derived from the phase and the records after sealing.
//   waiting_for_arrival  dispatched, Arrived not yet confirmed by a location pin
//   at_dock              arrived; the dock clock is running
//   paperwork            released; waiting for the bill of lading
//   sealing              paperwork in; the workflow is reading the photo and sealing
//   awaiting_approval    sealed BILLABLE; dispatch has been asked to approve
//   filing               approved; the agent is filing
//   claim_filed          the claim email was accepted by SES
//   held                 dispatch tapped Hold
//   not_billable         sealed; the contract owes nothing
//   needs_human          sealed NEEDS_HUMAN, or the agent did not file; a person takes over
//   closed               ended without a pack (timed out, superseded, seal failed)
export type LoadStatus =
  | "waiting_for_arrival"
  | "at_dock"
  | "paperwork"
  | "sealing"
  | "awaiting_approval"
  | "filing"
  | "claim_filed"
  | "held"
  | "not_billable"
  | "needs_human"
  | "closed";

export type Verdict = "BILLABLE" | "NOT_BILLABLE" | "NEEDS_HUMAN";

// Overview: GET /api/overview. Computed over the most recent demo-workspace loads (window.loads).
export interface Overview {
  window: { loads: number; from: string | null; to: string };
  loads: { total: number; live: number; byStatus: Partial<Record<LoadStatus, number>>; byVerdict: Partial<Record<Verdict, number>> };
  claims: { filed: number; amountUsd: number; refusedAgentRuns: number };
  messages: {
    // Counts per channel and direction. Email counts are emails DockClock sent.
    byChannel: Record<Channel, { outbound: number; inbound: number }>;
    byStatus: Partial<Record<MessageStatus, number>>;
  };
  delivery: {
    outbound: number;
    delivered: number;
    read: number;
    failed: number;
    // delivered (or read) / outbound, null with no outbound messages.
    deliveryRate: number | null;
    // Loads where a failed WhatsApp send switched the driver to RCS.
    failovers: number;
    failoverRate: number | null;
  };
  emails: { sent: number; delivered: number; bounced: number };
  // The latest 20 things that happened, newest first.
  activity: ActivityItem[];
}

export interface ActivityItem {
  id: string; // "<loadId>:<local id>", e.g. "SMOKE-mvh1bmmu:e12"
  at: string;
  loadId: string;
  runKind: RunKind;
  kind: "message" | "email" | "workflow" | "agent" | "approval" | "claim" | "failover";
  channel?: Channel;
  title: string; // plain words, as on the load's timeline
  tone: "neutral" | "money" | "agent" | "ok" | "refused";
  // Console route that shows it, e.g. "/loads/SMOKE-mvh1bmmu?tab=timeline#e12".
  href: string;
}

// Loads list: GET /api/loads, newest first.
export interface LoadsPage {
  loads: LoadSummary[];
  nextCursor: string | null;
}

export interface LoadSummary {
  loadId: string;
  runKind: RunKind;
  // A short label for the run kind badge: "Test run", "Judge demo", "Real phone", "Test load ∙ real tap" (RUN_LABELS).
  runLabel: string;
  createdAt: string;
  lastActivityAt: string;
  facility: { id: string; name: string; timeZone: string };
  counterparty: { name: string; role: "shipper" | "broker" };
  // The channel the driver is on now, and every channel the load used in order.
  channel: DriverChannel;
  channels: DriverChannel[];
  language: "en_US" | "es_MX" | "fr_CA";
  phase: Phase;
  status: LoadStatus;
  live: boolean; // still in progress
  verdict: Verdict | null;
  amountUsd: number | null; // the sealed contract amount; null before sealing
  claimSentAt: string | null;
  arrivedAt: string | null;
  releasedAt: string | null;
  failover: boolean;
  photos: number;
}

// One load: GET /api/loads/:id. Works from dispatch onwards; sealed-only parts are null until then.
export interface LoadView {
  summary: LoadSummary;
  run: RunInfo;
  clause: ClauseInfo;
  clock: LiveClock;
  workflow: WorkflowStep[];
  // The driver's (and, on approval, the dispatcher's) conversation in send/receive order.
  messages: ApiMessage[];
  // Everything that happened, in time order; every message and email also appears here.
  timeline: ApiTimelineEvent[];
  photos: PhotoInfo[];
  emails: EmailInfo[];
  agentRuns: AgentRun[];
  approval: ApprovalInfo | null;
  claim: ClaimInfo | null;
  // Present once sealed.
  verdict: VerdictInfo | null;
  pack: PackSummary | null;
}

// The dock clock band while a load is live: elapsed values are as of `asOf`.
export interface LiveClock {
  asOf: string;
  arrivedAt: string | null;
  // When the clock stopped: the Released tap, or on loads before the tap was kept, the release pin.
  releasedAt: string | null;
  // The release location pin that confirms the tap; null when there was no tap or no pin yet.
  releasePinAt?: string | null;
  // A closed load that arrived but was never released: when the clock stopped (the close). Null
  // otherwise. Nothing past it is billed.
  endedAt?: string | null;
  clockStartAt: string | null; // when free time starts counting, by clause
  freeTimeEndsAt: string | null;
  // Minutes so far (live) or final (sealed); billable is past free time.
  detentionMinutes: number;
  billableMinutes: number;
  // Final once sealed; null while live.
  amountUsd: number | null;
  driverTimes: Provenance; // recorded (a phone's server times) or synthetic_input (test messages)
}

export interface WorkflowStep {
  key: "dispatched" | "arrived" | "notice" | "released" | "paperwork" | "photo_read" | "sealed" | "approval" | "claim";
  label: string;
  state: "done" | "current" | "waiting" | "skipped" | "failed";
  at: string | null;
  services: ServiceTag[];
  detail?: string;
}

// Message kinds are channel-specific, so a WhatsApp frame and an RCS frame can be drawn apart.
export type MessageKind =
  // WhatsApp, outbound
  | "wa_template" // an approved Meta template (dispatch, notice sent, approval request)
  | "wa_text"
  | "wa_reply_buttons" // interactive message with quick-reply buttons
  | "wa_location_request" // interactive "Send location" request
  | "wa_flow" // a WhatsApp Flow opened by a call-to-action button (the BOL camera form)
  | "wa_document" // a file with a caption (the one-page PDF claim summary, sent after filing)
  // WhatsApp, inbound
  | "wa_button_reply"
  | "wa_location"
  | "wa_flow_reply"
  | "wa_image"
  | "wa_text_reply"
  // RCS, outbound
  | "rcs_rich_card" // standalone rich card: title, description, suggestion chips
  | "rcs_text" // text, optionally with suggestion chips
  | "rcs_location_request" // text with a "Share location" suggested action
  // RCS, inbound
  | "rcs_suggestion_reply" // the driver tapped a suggestion chip
  | "rcs_location"
  | "rcs_media" // a photo or file the driver sent
  | "rcs_text_reply"
  // SMS (not implemented; never present today)
  | "sms_text";

// A button, chip or call to action on a message, by what it does.
export interface MessageAction {
  type: "quick_reply" | "flow_cta" | "send_location" | "rcs_reply" | "rcs_request_location" | "rcs_open_url" | "rcs_dial";
  title: string;
  tapped?: boolean; // on an inbound reply: the one the driver chose
}

export interface ApiMessage {
  id: string; // m1, m2, ...
  at: string;
  channel: DriverChannel;
  direction: "out" | "in";
  // Whose phone the frame shows. On a non-demo load the dispatcher is a different person.
  party: "driver" | "dispatcher";
  purpose: string; // the sender's purpose name (dispatch_template, location_request, ...)
  kind: MessageKind;
  title?: string; // RCS rich card title
  body: string;
  footer?: string; // WhatsApp template footer
  template?: { name: string; language: string };
  actions?: MessageAction[];
  // Inbound location: the geofence result only, never coordinates.
  location?: { insideGeofence: boolean | null; note: string };
  // Inbound WhatsApp Flow reply: what the driver entered.
  flowReply?: { inTime: string | null; outTime: string | null; receiverSigned: boolean; delayReason: string | null };
  // Inbound photo: links into LoadView.photos.
  photoId?: string;
  // Outbound document: the file name the recipient saw, its caption (also the body) and the
  // SHA-256 of the file's bytes, which matches the claim email's PDF attachment.
  document?: { filename: string; caption: string; sha256: string | null };
  status: MessageStatus;
  notSentReason?: string;
  receipts?: { acceptedAt?: string; sentAt?: string; deliveredAt?: string; readAt?: string; failedAt?: string };
  // On a failed WhatsApp send that switched the load to RCS (or, failing twice, to dispatch).
  failover?: { at: string; action: "rerouted_to_rcs" | "escalated_to_dispatch" };
  // The engine's outcome for an inbound message (ADVANCED, IGNORED_DUPLICATE_TAP, ...).
  outcome?: string;
  provenance: Provenance;
}

export interface ApiTimelineEvent {
  id: string; // e1, e2, ...
  at: string;
  title: string;
  detail?: string;
  services: ServiceTag[];
  channel?: Channel;
  outcome?: string;
  tone: "neutral" | "money" | "agent" | "ok" | "refused";
  messageId?: string;
  emailId?: string;
  agentRunId?: string;
  photoId?: string;
  // The stored record, sanitized, for a record drawer.
  record?: Record<string, unknown>;
  provenance: Provenance;
}

// What an image is, separately from whether its record is real.
//   phone_camera                 taken on the driver's phone (a real-phone load)
//   rendered_fictional_document  a generated bill of lading (scripts/bol-photos.ts, footer says
//                                fictional) fed in by a test or a demo; not a phone photo
//   test_bytes                   a stand-in object that is not an image; it has no url
//   not_stored                   the photo was received but could not be downloaded; no url, no hash
export type PhotoSource = "phone_camera" | "rendered_fictional_document" | "test_bytes" | "not_stored";

export interface PhotoInfo {
  id: string; // p1, p2, ...
  page: number;
  channel: DriverChannel;
  takenAt: string; // the platform's server time for the photo message
  mimeType: string;
  // sha256 of the stored original, the value in the signed pack (pack.events.bol.pageSha256s).
  sha256: string | null;
  matchesPack: boolean | null; // null before sealing, or with no stored photo
  // GET /api/loads/:id/photos/:n. Null when the object is missing or is not an image. In fixtures,
  // a path relative to site/fixtures/api/.
  url: string | null;
  // Why a stored photo has no url: on a judge DEMO load (the judge's own phone) the photo is kept
  // with the load but not served publicly. Its hash and reading are still shown.
  note?: string;
  // The served bytes have all metadata (EXIF, including any GPS) removed, so they hash differently
  // from sha256. Say so next to the hash.
  servedBytes: "metadata_stripped";
  source: PhotoSource;
  // Whether this photo is the one the evidence used (a retake replaces an unreadable one).
  usedInEvidence: boolean;
  // The photo tool's reading, when it ran.
  legible?: boolean;
  reading?: { inTime: string | null; outTime: string | null; receiverSigned: boolean; model: string; readAt: string };
  provenance: Provenance;
}

// An email as listed on a load. GET /api/loads/:id/emails/:emailId adds the body (EmailView).
export interface EmailInfo {
  id: string; // notice | claim | escalation-1, escalation-2, ...
  purpose: "notice" | "claim" | "dispatch_escalation";
  sentAt: string;
  // not_sent: composed but not emailed (a test load never emails dispatch); see notSentReason.
  status: "sent" | "delivered" | "bounced" | "not_sent";
  notSentReason?: string;
  deliveredAt?: string;
  bouncedAt?: string;
  from: string;
  // Role and fictional name only; the actual test mailbox is not published.
  to: { name: string; role: "shipper" | "broker" | "dispatch"; note: string };
  subject: string;
  attachments: Array<{ name: string; contentType: string; sha256?: string; note?: string }>;
  // Whether the body can be shown: the sent bytes (notice, claim; kept from 2026-10-20 on) or, for
  // a dispatch escalation, the composed text with the driver's contact removed.
  bodyStored: boolean;
  provenance: Provenance;
}

export interface EmailView extends EmailInfo {
  body: string | null;
  bodyNote: string;
}

export interface PackSummary {
  packId: string;
  digestSha256: string;
  sealedAt: string;
  storage: string;
  confidence: "high" | "medium" | "low";
  href: string; // "/api/loads/<id>/pack"
}

// One feed across channels: GET /api/messages, newest first.
export interface MessageFeed {
  items: FeedItem[];
  nextCursor: string | null;
  filters: { channel?: Channel; status?: MessageStatus; direction?: "in" | "out"; loadId?: string };
  // Channels with at least one record in the window, for showing filters.
  channelsWithRecords: Channel[];
}

export interface FeedItem {
  id: string; // "<loadId>:<m3 | notice | claim | escalation-1>"
  at: string;
  loadId: string;
  runKind: RunKind;
  channel: Channel;
  direction: "out" | "in";
  party: "driver" | "dispatcher" | "counterparty";
  purpose: string;
  kind: MessageKind | "email";
  // One line, at most 140 characters.
  preview: string;
  status: MessageStatus;
  failover?: ApiMessage["failover"];
  provenance: Provenance;
  // Console route, e.g. "/loads/SMOKE-mvh1bmmu?tab=conversation#m3".
  href: string;
}

// Route-to-type map, for a typed fetch helper.
export interface ApiRoutes {
  "/api/overview": Overview;
  "/api/loads": LoadsPage;
  "/api/loads/:id": LoadView;
  "/api/messages": MessageFeed;
  "/api/loads/:id/pack": SignedPackInfo;
  "/api/loads/:id/emails/:emailId": EmailView;
}
