// The replay contract: one sanitized load, as the judge desk reads it from replay/<loadId>.json.
//
// Written by `npm run desk:snapshot -- <loadId>` (exporter: scripts/desk/build-snapshot.ts) and read by
// the page. Everything here is safe to publish:
// - no coordinates, phone numbers, BSUIDs, WhatsApp message ids (they encode the sender's number),
//   S3 keys, KMS key ARN or AWS account id;
// - every company is fictional;
// - every time is an ISO-8601 UTC instant; the page shows it in `load.facility.timeZone`, labelled.
//
// Fields marked "not stored yet" are optional because the backend does not record them today. The
// exporter fills them once SEND#, AGENT# rows and the email MIME in S3 exist; until then the page
// says what is missing instead of inventing it.

export const SNAPSHOT_SCHEMA = "dockclock.replay/1" as const;

// How a value came to be in this file. The page shows this next to anything that is not "recorded".
//   recorded:               read from DynamoDB, S3, Step Functions history or SES as stored
//   rendered_from_template: text rebuilt from the same template/copy function the sender uses,
//                           because the sent body itself was not stored (older loads)
//   synthetic_input:        a driver message replayed by the integration smoke test, not a phone
//   derived:                computed from recorded values (for example a minute difference)
export type Provenance = "recorded" | "rendered_from_template" | "synthetic_input" | "derived";

// What kind of run this load was, matching FACTS.md's status key.
//   phone:       driven end to end from a real phone
//   operator:    a real person tapped on a real phone; driver messages were synthetic
//   integration: synthetic driver messages through the deployed stack; everything after is real
//   demo:        a judge's DEMO keyword run
export type RunKind = "phone" | "operator" | "integration" | "demo";

export type Channel = "whatsapp" | "rcs" | "email";

// The AWS service (and, where useful, API) behind a step, for the timeline's small tags.
export type ServiceTag =
  | "EUM Social"
  | "EUM RCS"
  | "SNS"
  | "SQS"
  | "Lambda"
  | "DynamoDB"
  | "Step Functions"
  | "EventBridge Scheduler"
  | "S3 Object Lock"
  | "KMS"
  | "Bedrock AgentCore"
  | "AgentCore Gateway"
  | "SES";

export interface ReplaySnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  exportedAt: string;
  run: RunInfo;
  load: LoadInfo;
  clause: ClauseInfo;
  clock: ClockInfo;
  // The phone frame, in send/receive order.
  messages: ChatMessage[];
  // The event list, in time order. Every phone message also appears here.
  timeline: TimelineEvent[];
  verdict: VerdictInfo;
  pack: SignedPackInfo;
  emails: EmailRecord[];
  agentRuns: AgentRun[];
  approval: ApprovalInfo | null;
  claim: ClaimInfo | null;
}

export interface RunInfo {
  kind: RunKind;
  // One plain sentence for the top bar, for example "Driver messages were replayed test messages;
  // the approval tap, the agent, the signature and the email were real."
  summary: string;
  // What was real and what was not, one line each, for the record drawer.
  notes: string[];
}

export interface LoadInfo {
  loadId: string;
  facility: { id: string; name: string; timeZone: string };
  counterparty: { name: string; role: "shipper" | "broker" };
  appointmentAt: string;
  channel: "whatsapp" | "rcs";
  language: "en_US" | "es_MX" | "fr_CA";
  demo: boolean;
}

// The clause as plain terms. No source company names: "modelled on published shipper terms" only.
export interface ClauseInfo {
  id: string;
  freeTimeMinutes: number;
  freeTimeAnchor: "appointment" | "arrival";
  requireOnTimeArrival: boolean;
  ratePerHourUsd: number;
  capUsdPerOccurrence: number | null;
  noticeLeadMinutes: number | null;
  acceptedRecords: Array<"signed_bol_times" | "status_214" | "app_gps">;
  claimWindowHours: number;
  shipperConfirmationRequired: boolean;
  // "Modelled on published shipper terms" or "DockClock judge demo clause".
  basis: string;
}

// The dock clock band. All instants; null when the step never happened.
export interface ClockInfo {
  arrivedAt: string | null;
  releasedAt: string | null;
  // When the paid clock starts (appointment or arrival, by clause).
  clockStartAt: string | null;
  freeTimeEndsAt: string | null;
  detentionMinutes: number;
  billableMinutes: number;
  // Are the driver timestamps from a phone (WhatsApp/RCS server time) or replayed test messages?
  driverTimes: Provenance;
}

export interface ChatMessage {
  id: string; // stable within the file (m1, m2, ...); never a WhatsApp message id
  at: string;
  direction: "out" | "in";
  // Who the phone frame belongs to. On non-demo loads the dispatcher is a different person.
  party: "driver" | "dispatcher";
  channel: "whatsapp" | "rcs";
  // The sender's purpose name (dispatch_template, location_request, approval_reply, ...).
  purpose: string;
  kind: "template" | "text" | "buttons" | "location_request" | "location" | "flow" | "flow_reply" | "image";
  templateName?: string;
  body: string;
  bodyProvenance: Provenance;
  buttons?: Array<{ title: string; tapped?: boolean }>;
  flowCta?: string;
  // For an inbound location: never coordinates, only the geofence result.
  location?: { insideGeofence: boolean | null; note: string };
  // For an inbound Flow reply.
  flowReply?: { inTime: string | null; outTime: string | null; receiverSigned: boolean; delayReason: string | null; photoStored: boolean };
  // Outbound only: what WhatsApp/RCS reported.
  status?: "accepted" | "sent" | "delivered" | "read" | "failed" | "not_sent";
  receipts?: { acceptedAt?: string; sentAt?: string; deliveredAt?: string; readAt?: string; failedAt?: string };
  notSentReason?: string;
  provenance: Provenance;
}

export interface TimelineEvent {
  id: string;
  at: string;
  // Plain words, no jargon: "Driver shared the arrival location".
  title: string;
  detail?: string;
  services: ServiceTag[];
  // The engine's outcome for inbound events (ADVANCED, IGNORED_DUPLICATE_TAP, ...).
  outcome?: string;
  tone: "neutral" | "money" | "agent" | "ok" | "refused";
  // Links into the other sections, so the page can open the matching record.
  messageId?: string;
  emailId?: string;
  agentRunId?: string;
  // The sanitized stored record, shown raw in the record drawer.
  record?: Record<string, unknown>;
  provenance: Provenance;
}

export type ReasonCode =
  | "MISSING_TIMESTAMP"
  | "PIN_OUTSIDE_GEOFENCE"
  | "BOL_TIMESTAMP_CONFLICT"
  | "LATE_ARRIVAL"
  | "WITHIN_FREE_TIME"
  | "NOTICE_MISSING"
  | "NOTICE_LATE"
  | "NO_STATEMENT_OF_RECORD"
  | "CLAIM_WINDOW_EXPIRED"
  | "SHIPPER_CONFIRMATION_REQUIRED"
  | "CAP_APPLIED";

export interface VerdictInfo {
  verdict: "BILLABLE" | "NOT_BILLABLE" | "NEEDS_HUMAN";
  reasons: ReasonCode[];
  amountUsd: number;
  confidence: "high" | "medium" | "low";
  // The corroboration signals from the pack, for "how sure are we".
  signals: Array<{ name: string; ok: boolean; independent?: boolean; detail: string }>;
  // The engine inputs, so tab 3 can re-run the same clause with one thing changed.
  engineInput: {
    appointmentAt: string;
    arrived: { at: string; insideGeofence: boolean } | null;
    released: { at: string; insideGeofence: boolean } | null;
    // checkIn/checkOut are ISO instants (the driver's written times on the facility's date), as the
    // clause engine compares them with the pins.
    bol: { signed: boolean; checkIn: string | null; checkOut: string | null } | null;
    status214: boolean;
    noticeSentAt: string | null;
    shipperConfirmed: boolean;
    evaluatedAt: string;
  };
}

// The signed pack exactly as sealed (the `pack` object is the signed bytes, canonical JSON), minus
// the KMS key id, which is not signed and holds the account id.
export interface SignedPackInfo {
  packId: string;
  digestSha256: string; // sha256 of canonicalJson(pack)
  algorithm: "ECDSA_SHA_256";
  signatureBase64: string; // DER, as KMS returns it
  publicKeyPath: string; // relative to the page, e.g. "keys/public-key.pem"
  spkiSha256: string;
  sealedAt: string;
  storage: string; // plain words, e.g. "S3 Object Lock (governance, 30 days)"
  pack: Record<string, unknown>;
}

export interface EmailRecord {
  id: string;
  purpose: "notice" | "claim" | "dispatch_escalation";
  sentAt: string;
  deliveredAt?: string; // SES delivery event, when recorded
  from: string;
  // Role and fictional name only; the actual test mailbox address is not published.
  to: { name: string; role: "shipper" | "broker" | "dispatch"; note: string };
  subject: string;
  // Not stored yet for older loads (MIME in S3 is new). When absent, bodyNote says why.
  body?: string;
  bodyProvenance?: Provenance;
  bodyNote?: string;
  attachments: Array<{ name: string; contentType: string; sha256?: string; note?: string }>;
  provenance: Provenance;
}

export interface AgentToolCall {
  // Tool name without the gateway target prefix.
  name: "get_load_evidence" | "read_bill_of_lading" | "send_detention_claim" | string;
  // The arguments as the model sent them; long text fields may be shortened by the exporter.
  input: Record<string, unknown>;
  // The Gateway's Cedar policy decision. Not stored yet: until AGENT# rows exist the exporter may
  // infer "permit" from the tool having run under ENFORCE, and says so in decisionSource.
  cedar?: { decision: "permit" | "deny"; policy: string; decisionSource: "recorded" | "inferred" };
  result?: { ok: boolean; summary: string };
}

export interface AgentRun {
  id: string;
  task: "review" | "file_claim" | "read_bol";
  startedAt: string;
  endedAt?: string;
  model: string; // plain name, e.g. "Claude Sonnet 4.5 on Amazon Bedrock"
  stopReason?: string;
  toolCalls: AgentToolCall[];
  // The code gate inside send_detention_claim: amount and digest must equal the sealed pack.
  guard?: { amountCentsSent: number; amountCentsSealed: number; digestSent: string; digestSealed: string; match: boolean };
  // The agent's closing text, shortened. Not stored yet in AGENT# rows; may come from history.
  text?: string;
  provenance: Provenance;
}

export interface ApprovalInfo {
  requestedAt: string;
  decidedAt: string | null;
  decision: "approve" | "hold" | null;
  approver: "dispatcher" | "demo_driver";
}

export interface ClaimInfo {
  status: "sending" | "sent";
  amountUsd: number;
  amountCents: number;
  packDigest: string;
  sentAt: string | null;
  subject: string;
  // Seconds from the approval tap to SES accepting the email.
  secondsAfterApproval: number | null;
}
