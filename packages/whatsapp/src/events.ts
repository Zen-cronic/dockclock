import type { ChannelConfig, RawMessage, WebhookEntry } from "./decode.js";

// BSUID first: once a user has a business-scoped user ID, the phone number is never used to
// identify them, and an unknown BSUID cannot borrow a known phone's identity.
export type Sender = { kind: "bsuid"; id: string } | { kind: "phone"; e164: string };

export type InboundBody =
  | { type: "button"; payload: string }
  | { type: "location"; lat: number; lon: number }
  | { type: "image"; mediaId: string; mimeType: string; metaSha256: string | null }
  | { type: "audio"; mediaId: string; mimeType: string }
  | { type: "flow"; responseJson: string }
  | { type: "text"; text: string }
  | { type: "other"; rawType: string };

export interface InboundEvent {
  kind: "inbound";
  wamid: string;
  serverAt: string;
  sender: Sender;
  body: InboundBody;
}

export type DeliveryState = "accepted" | "sent" | "delivered" | "read" | "failed";

export interface StatusEvent {
  kind: "status";
  wamid: string;
  eumMessageId: string | null;
  serverAt: string;
  state: DeliveryState;
  errorCode: number | null;
}

export type ChannelEvent = InboundEvent | StatusEvent;

function isoFromUnixSeconds(value: string | undefined): string | null {
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function senderOf(message: RawMessage): Sender | null {
  if (typeof message.from_user_id === "string" && message.from_user_id.length > 0) {
    return { kind: "bsuid", id: message.from_user_id };
  }
  const digits = String(message.from ?? "").replace(/^\+/, "");
  return /^\d{7,15}$/.test(digits) ? { kind: "phone", e164: `+${digits}` } : null;
}

function bodyOf(message: RawMessage): InboundBody {
  switch (message.type) {
    case "button":
      return typeof message.button?.payload === "string"
        ? { type: "button", payload: message.button.payload }
        : { type: "other", rawType: "button" };
    case "interactive": {
      const interactive = message.interactive;
      if (interactive?.type === "button_reply" && typeof interactive.button_reply?.id === "string") {
        return { type: "button", payload: interactive.button_reply.id };
      }
      const response = interactive?.nfm_reply?.response_json;
      if (interactive?.type === "nfm_reply" && response !== undefined) {
        return { type: "flow", responseJson: typeof response === "string" ? response : JSON.stringify(response) };
      }
      return { type: "other", rawType: `interactive:${interactive?.type ?? "unknown"}` };
    }
    case "location": {
      const lat = message.location?.latitude;
      const lon = message.location?.longitude;
      return typeof lat === "number" && typeof lon === "number" ? { type: "location", lat, lon } : { type: "other", rawType: "location" };
    }
    case "image":
      return typeof message.image?.id === "string"
        ? { type: "image", mediaId: message.image.id, mimeType: message.image.mime_type ?? "image/jpeg", metaSha256: message.image.sha256 ?? null }
        : { type: "other", rawType: "image" };
    case "audio":
      return typeof message.audio?.id === "string"
        ? { type: "audio", mediaId: message.audio.id, mimeType: message.audio.mime_type ?? "audio/ogg" }
        : { type: "other", rawType: "audio" };
    case "text":
      return typeof message.text?.body === "string" ? { type: "text", text: message.text.body } : { type: "other", rawType: "text" };
    default:
      return { type: "other", rawType: String(message.type ?? "unknown") };
  }
}

const DELIVERY_STATES = new Set<DeliveryState>(["accepted", "sent", "delivered", "read", "failed"]);

export function extractEvents(entry: WebhookEntry, config: ChannelConfig, eumMessageId: string | null = null): ChannelEvent[] {
  const out: ChannelEvent[] = [];
  for (const change of entry.changes ?? []) {
    if (change.field !== "messages") continue;
    const value = change.value ?? {};
    if (value.metadata?.phone_number_id !== config.metaPhoneId) continue;
    for (const message of value.messages ?? []) {
      const serverAt = isoFromUnixSeconds(message.timestamp);
      const sender = senderOf(message);
      if (!message.id || !serverAt || !sender) continue;
      out.push({ kind: "inbound", wamid: message.id, serverAt, sender, body: bodyOf(message) });
    }
    for (const status of value.statuses ?? []) {
      const serverAt = isoFromUnixSeconds(status.timestamp);
      const state = status.status as DeliveryState;
      if (!status.id || !serverAt || !DELIVERY_STATES.has(state)) continue;
      out.push({ kind: "status", wamid: status.id, eumMessageId, serverAt, state, errorCode: status.errors?.[0]?.code ?? null });
    }
  }
  return out;
}
