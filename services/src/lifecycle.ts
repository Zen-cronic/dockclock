import type { InboundEvent } from "@dockclock/whatsapp";
import { parseButtonPayload, parseFlowToken, parseReleaseFlow } from "@dockclock/whatsapp";

export type Phase = "dispatched" | "awaiting_arrival_pin" | "at_dock" | "awaiting_release_pin" | "awaiting_bol" | "documented";
export type Step = "arrived" | "released" | "bol";
export type MessageKey = "tap_arrived_first" | "dispatch_notified" | "bol_received" | "bol_incomplete";

export interface PinRecord {
  serverAt: string;
  messageId: string;
  lat: number;
  lon: number;
}

export interface BolPhoto {
  mediaId: string;
  mimeType: string;
  metaSha256: string | null;
  s3Key?: string;
  sha256?: string;
}

export interface BolRecord {
  serverAt: string;
  messageId: string;
  photos: BolPhoto[];
  inTime: string | null;
  outTime: string | null;
  delayReason: string | null;
  consignee: string | null;
  shareConsent: boolean;
  // "pending" until every photo is stored and hashed, or found to be unavailable.
  media: "pending" | "hashed" | "unavailable";
}

export interface LoadState {
  loadId: string;
  nonce: string;
  phase: Phase;
  version: number;
  arrived: PinRecord | null;
  released: PinRecord | null;
  bol: BolRecord | null;
}

export type Outcome =
  | "ADVANCED"
  | "IGNORED_DUPLICATE_TAP"
  | "REJECTED_OUT_OF_ORDER"
  | "REJECTED_WRONG_LOAD"
  | "REJECTED_STALE_BUTTON"
  | "REJECTED_INCOMPLETE_FLOW"
  | "IGNORED_UNSOLICITED_PIN"
  | "ESCALATED"
  | "RECORDED";

export type Effect =
  | { type: "request_location"; step: "arrived" | "released" }
  | { type: "offer_release" }
  | { type: "send_release_flow" }
  | { type: "download_media" }
  | { type: "tell_driver"; key: MessageKey }
  | { type: "escalate" }
  | { type: "resume"; step: Step };

export interface Transition {
  state: LoadState;
  outcome: Outcome;
  effects: Effect[];
}

function stay(state: LoadState, outcome: Outcome, effects: Effect[] = []): Transition {
  return { state, outcome, effects };
}

// The only place a driver event changes a load. SQS can redeliver and reorder, so every branch is
// safe to see twice, and a tap that arrives before its prerequisite changes nothing. Buttons and
// Flow tokens carry the load id and a per-load nonce, so a tap from another load or an old message
// is refused rather than applied.
export function applyEvent(state: LoadState, event: InboundEvent): Transition {
  const next = (patch: Partial<LoadState>, effects: Effect[]): Transition => ({
    state: { ...state, ...patch, version: state.version + 1 },
    outcome: "ADVANCED",
    effects,
  });
  const body = event.body;

  if (body.type === "button") {
    const payload = parseButtonPayload(body.payload);
    if (!payload) return stay(state, "RECORDED");
    if (payload.loadId !== state.loadId) return stay(state, "REJECTED_WRONG_LOAD");
    if (payload.nonce !== state.nonce) return stay(state, "REJECTED_STALE_BUTTON");
    if (payload.action === "dispatch") return stay(state, "ESCALATED", [{ type: "escalate" }, { type: "tell_driver", key: "dispatch_notified" }]);
    if (payload.action === "arrived") {
      if (state.phase !== "dispatched") return stay(state, "IGNORED_DUPLICATE_TAP");
      return next({ phase: "awaiting_arrival_pin" }, [{ type: "request_location", step: "arrived" }]);
    }
    if (payload.action === "released") {
      if (state.phase === "at_dock") return next({ phase: "awaiting_release_pin" }, [{ type: "request_location", step: "released" }]);
      if (state.phase === "dispatched" || state.phase === "awaiting_arrival_pin") {
        return stay(state, "REJECTED_OUT_OF_ORDER", [{ type: "tell_driver", key: "tap_arrived_first" }]);
      }
      return stay(state, "IGNORED_DUPLICATE_TAP");
    }
    return stay(state, "RECORDED");
  }

  if (body.type === "location") {
    const pin: PinRecord = { serverAt: event.serverAt, messageId: event.wamid, lat: body.lat, lon: body.lon };
    if (state.phase === "awaiting_arrival_pin") {
      return next({ phase: "at_dock", arrived: pin }, [{ type: "resume", step: "arrived" }, { type: "offer_release" }]);
    }
    if (state.phase === "awaiting_release_pin") {
      return next({ phase: "awaiting_bol", released: pin }, [{ type: "resume", step: "released" }, { type: "send_release_flow" }]);
    }
    return stay(state, "IGNORED_UNSOLICITED_PIN");
  }

  if (body.type === "flow") {
    const response = parseReleaseFlow(body.responseJson);
    const token = response && parseFlowToken(response.flowToken);
    if (!response || !token) return stay(state, "RECORDED");
    if (token.loadId !== state.loadId) return stay(state, "REJECTED_WRONG_LOAD");
    if (token.nonce !== state.nonce) return stay(state, "REJECTED_STALE_BUTTON");
    if (state.phase !== "awaiting_bol") return stay(state, state.phase === "documented" ? "IGNORED_DUPLICATE_TAP" : "REJECTED_OUT_OF_ORDER");
    if (response.photos.length === 0 || !response.shareConsent) {
      return stay(state, "REJECTED_INCOMPLETE_FLOW", [{ type: "tell_driver", key: "bol_incomplete" }, { type: "send_release_flow" }]);
    }
    const bol: BolRecord = {
      serverAt: event.serverAt,
      messageId: event.wamid,
      photos: response.photos.map((p) => ({ mediaId: p.mediaId, mimeType: p.mimeType, metaSha256: p.metaSha256 })),
      inTime: response.inTime,
      outTime: response.outTime,
      delayReason: response.delayReason,
      consignee: response.consignee,
      shareConsent: response.shareConsent,
      media: "pending",
    };
    return next({ phase: "documented", bol }, [{ type: "download_media" }, { type: "tell_driver", key: "bol_received" }, { type: "resume", step: "bol" }]);
  }

  return stay(state, "RECORDED");
}

export function stepSatisfied(state: Pick<LoadState, "arrived" | "released" | "bol">, step: Step): boolean {
  if (step === "arrived") return state.arrived !== null;
  if (step === "released") return state.released !== null;
  return state.bol !== null && state.bol.media !== "pending";
}
