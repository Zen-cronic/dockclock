import { normalizeE164, UntrustedEventError, type DeliveryState, type InboundBody, type InboundEvent, type StatusEvent } from "@dockclock/whatsapp";

export interface RcsConfig {
  // The SNS topic the agent's two-way channel and the RCS configuration set publish to.
  topicArn: string;
  // The AWS RCS agent id (rcs-...), as End User Messaging names it in every event.
  agentId: string;
  // Inbound media is accepted only from our own bucket.
  mediaBucket: string;
}

// A delivery receipt for a message sent with SendRcsMessage. The send's Context travels with the
// event, so a receipt can name its load even if it arrives before our own send record.
export interface RcsStatusEvent extends StatusEvent {
  channel: "rcs";
  loadId: string | null;
  purpose: string | null;
  description: string | null;
}

export type RcsEvent = InboundEvent | RcsStatusEvent;

interface Envelope {
  Type?: string;
  TopicArn?: string;
  Message?: string;
  Timestamp?: string;
}

interface InboundPayload {
  originationNumber?: string;
  destinationNumber?: string;
  messageBody?: string;
  inboundMessageId?: string;
}

interface StatusPayload {
  eventType?: string;
  eventTimestamp?: number;
  originationPhoneNumber?: string;
  messageId?: string;
  messageStatus?: string;
  messageStatusDescription?: string;
  context?: Record<string, string>;
}

// Platform notices that are not a driver message: they never touch a load.
const SYSTEM_TYPES = new Set(["RCS_TYPING", "CONVERSATION_STARTED"]);

const BY_EVENT_TYPE: Record<string, DeliveryState> = {
  RCS_QUEUED: "accepted",
  RCS_SENT: "sent",
  RCS_DELIVERED: "delivered",
  RCS_READ: "read",
  RCS_FAILED: "failed",
  RCS_TTL_EXPIRED: "failed",
  RCS_PROTECT_BLOCKED: "failed",
};

// The documented status values carried inside a status event take precedence over its type.
const BY_MESSAGE_STATUS: Record<string, DeliveryState> = {
  PENDING: "sent",
  DELIVERED: "delivered",
  READ: "read",
  UNDELIVERABLE: "failed",
  REJECTED: "failed",
  FAILED: "failed",
};

function numberOf(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// AWS documents that a shared location arrives in the notification body but not its field names,
// so the common spellings are accepted and anything else is reported by its keys, never guessed.
export function coordinatesOf(body: Record<string, unknown>): { lat: number; lon: number } | null {
  const nested = typeof body.location === "object" && body.location !== null ? (body.location as Record<string, unknown>) : null;
  for (const source of [body, nested]) {
    if (!source) continue;
    const lat = numberOf(source.latitude ?? source.lat);
    const lon = numberOf(source.longitude ?? source.lon ?? source.lng ?? source.long);
    if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text.trimStart().startsWith("{")) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mediaBody(id: string, media: Record<string, unknown>, config: RcsConfig): InboundBody {
  const mimeType = typeof media.mimeType === "string" ? media.mimeType.toLowerCase() : "application/octet-stream";
  const stored = media.mediaStatus === "SUCCESS" && typeof media.s3Key === "string";
  if (stored && media.s3Bucket !== config.mediaBucket) return { type: "other", rawType: "rcs:media_foreign_bucket" };
  if (mimeType.startsWith("image/")) {
    // A photo the service could not store still counts as sent, so the load can say so honestly.
    return { type: "image", mediaId: id, mimeType, metaSha256: null, ...(stored ? { s3Key: media.s3Key as string } : {}) };
  }
  if (mimeType.startsWith("audio/")) return { type: "audio", mediaId: id, mimeType };
  return { type: "other", rawType: `rcs:media:${mimeType}` };
}

// Text arrives as the plain body; suggestion taps, locations and media as a JSON document in it.
// Returns null for platform notices (typing, conversation start) that are not driver messages.
export function bodyOf(id: string, messageBody: string, config: RcsConfig): InboundBody | null {
  const json = parseJsonObject(messageBody);
  if (!json) return { type: "text", text: messageBody };
  if (typeof json.mediaStatus === "string") return mediaBody(id, json, config);
  const type = typeof json.type === "string" ? json.type.toUpperCase() : null;
  if (type === null) return { type: "text", text: messageBody };
  if (SYSTEM_TYPES.has(type)) return null;
  if (type === "SUGGESTION") {
    return typeof json.postbackData === "string" ? { type: "button", payload: json.postbackData } : { type: "other", rawType: "rcs:suggestion" };
  }
  if (type === "LOCATION") {
    const point = coordinatesOf(json);
    return point ? { type: "location", ...point } : { type: "other", rawType: `rcs:location_unparsed:${Object.keys(json).sort().join("+")}` };
  }
  return { type: "other", rawType: `rcs:${type.toLowerCase()}` };
}

function inbound(payload: InboundPayload, serverAt: string, config: RcsConfig): InboundEvent[] {
  if (payload.destinationNumber !== config.agentId) throw new UntrustedEventError("WRONG_AGENT");
  const id = payload.inboundMessageId;
  const raw = payload.originationNumber ?? "";
  const e164 = normalizeE164(raw.startsWith("+") ? raw : `+${raw}`);
  if (!id || !e164 || typeof payload.messageBody !== "string") return [];
  const body = bodyOf(id, payload.messageBody, config);
  if (!body) return [];
  // Prefixed so an RCS id can never collide with a WhatsApp message id in the dedupe claim.
  return [{ kind: "inbound", channel: "rcs", wamid: `rcs.${id}`, serverAt, sender: { kind: "phone", e164 }, body }];
}

function status(payload: StatusPayload, fallbackAt: string, config: RcsConfig): RcsStatusEvent[] {
  if (payload.originationPhoneNumber !== config.agentId) throw new UntrustedEventError("WRONG_AGENT");
  const state = BY_MESSAGE_STATUS[payload.messageStatus ?? ""] ?? BY_EVENT_TYPE[payload.eventType ?? ""];
  if (!payload.messageId || !state) return [];
  const at = numberOf(payload.eventTimestamp);
  return [
    {
      kind: "status",
      channel: "rcs",
      wamid: `rcs.${payload.messageId}`,
      eumMessageId: payload.messageId,
      serverAt: at !== null && at > 0 ? new Date(at).toISOString() : fallbackAt,
      state,
      errorCode: null,
      loadId: payload.context?.loadId ?? null,
      purpose: payload.context?.purpose ?? null,
      description: payload.messageStatusDescription ?? null,
    },
  ];
}

// Unwraps an SNS notification from the RCS topic into the same events the WhatsApp decoder yields.
// Refuses anything not published to our topic or not naming our agent. Inbound payloads carry no
// timestamp, so their server time is SNS's own publish time, never a time the driver supplied.
export function decodeRcsEvent(body: string, config: RcsConfig): RcsEvent[] {
  const envelope = JSON.parse(body) as Envelope;
  if (envelope.Type !== "Notification" || envelope.TopicArn !== config.topicArn || typeof envelope.Message !== "string") {
    throw new UntrustedEventError("UNTRUSTED_TOPIC");
  }
  const serverAt = envelope.Timestamp && !Number.isNaN(Date.parse(envelope.Timestamp)) ? new Date(envelope.Timestamp).toISOString() : null;
  if (!serverAt) return [];
  const message = JSON.parse(envelope.Message) as InboundPayload & StatusPayload;
  if (typeof message.eventType === "string" && message.eventType.startsWith("RCS_")) return status(message, serverAt, config);
  if (typeof message.inboundMessageId === "string") return inbound(message, serverAt, config);
  return [];
}

// Routes an SQS body to the right decoder without trusting it: only the topic ARN is read here.
export function isFromTopic(body: string, topicArn: string): boolean {
  try {
    return (JSON.parse(body) as Envelope).TopicArn === topicArn;
  } catch {
    return false;
  }
}
