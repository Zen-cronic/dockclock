import { parseClock, type Channel } from "@dockclock/evidence";
import type { InboundEvent } from "@dockclock/whatsapp";
import { parseButtonPayload, parseFlowToken, parseReleaseFlow } from "@dockclock/whatsapp";

export type Phase =
  | "dispatched"
  | "awaiting_arrival_pin"
  | "at_dock"
  | "awaiting_release_pin"
  | "awaiting_bol"
  | "documented"
  // Terminal: the workflow sealed the pack, or ended the load (timeout, superseded, seal failure).
  | "sealed"
  | "closed";
// "retake" waits for a second bill of lading after an unreadable first photo.
export type Step = "arrived" | "released" | "bol" | "retake";


export const MAX_FLOW_SENDS = 3;
// One list, and the type derives from it, so a new key cannot be missing from failover.
const MESSAGE_KEYS = [
  "tap_arrived_first",
  "dispatch_notified",
  "bol_received",
  "bol_partial",
  "bol_incomplete",
  "bol_times_unreadable",
  "flow_limit",
  "load_closed",
  "use_bol_button",
  "bol_photo_received",
] as const;
export type MessageKey = (typeof MESSAGE_KEYS)[number];
const TERMINAL: readonly Phase[] = ["sealed", "closed"];

export interface PinRecord {
  channel?: Channel;
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
  // "rcs" means a photo reply: no driver-entered times, no signed box, camera use unknown.
  channel?: Channel;
  serverAt: string;
  messageId: string;
  photos: BolPhoto[];
  inTime: string | null;
  outTime: string | null;
  delayReason: string | null;
  consignee: string | null;
  receiverSigned: boolean;
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
  flowSends: number;
}

export type Outcome =
  | "ADVANCED"
  | "IGNORED_DUPLICATE_TAP"
  | "REJECTED_OUT_OF_ORDER"
  | "REJECTED_WRONG_LOAD"
  | "REJECTED_STALE_BUTTON"
  | "REJECTED_CLOSED_LOAD"
  | "REJECTED_INCOMPLETE_FLOW"
  | "IGNORED_UNSOLICITED_PIN"
  | "ESCALATED"
  | "RECORDED";

export type Effect =
  | { type: "request_location"; step: "arrived" | "released" }
  | { type: "offer_release" }
  | { type: "send_release_flow" }
  // Only queued by a failover: re-sends the dispatch prompt over the load's current channel.
  | { type: "send_dispatch" }
  | { type: "download_media" }
  | { type: "tell_driver"; key: MessageKey }
  | { type: "ask_retake" }
  // unreachable: messages to the driver are failing, so dispatch must not be pointed back at them.
  | { type: "escalate"; reason: string; unreachable?: boolean }
  | { type: "resume"; step: Step };

export interface Transition {
  state: LoadState;
  outcome: Outcome;
  effects: Effect[];
}

export function isTerminal(phase: Phase): boolean {
  return TERMINAL.includes(phase);
}

function stay(state: LoadState, outcome: Outcome, effects: Effect[] = []): Transition {
  return { state, outcome, effects };
}

// The only place a driver event changes a load. SQS can redeliver and reorder, so every branch is
// safe to see twice, and a tap that arrives before its prerequisite changes nothing. Buttons and
// Flow tokens carry the load id and a per-load nonce, so a tap from another load or an old message
// is refused rather than applied. Once the workflow has ended a load, nothing reopens it.
export function applyEvent(state: LoadState, event: InboundEvent): Transition {
  const next = (patch: Partial<LoadState>, effects: Effect[], outcome: Outcome = "ADVANCED"): Transition => ({
    state: { ...state, ...patch, version: state.version + 1 },
    outcome,
    effects,
  });
  // Re-sends the release Flow, up to a limit, so a persistent problem cannot loop messages.
  const resendFlow = (key: MessageKey): Transition =>
    state.flowSends < MAX_FLOW_SENDS
      ? next({ flowSends: state.flowSends + 1 }, [{ type: "tell_driver", key }, { type: "send_release_flow" }], "REJECTED_INCOMPLETE_FLOW")
      : stay(state, "REJECTED_INCOMPLETE_FLOW", [{ type: "tell_driver", key: "flow_limit" }, { type: "escalate", reason: "release Flow rejected after the re-send limit" }]);
  const body = event.body;

  if (isTerminal(state.phase)) {
    const owned = body.type === "button" || body.type === "flow";
    return stay(state, "REJECTED_CLOSED_LOAD", owned ? [{ type: "tell_driver", key: "load_closed" }] : []);
  }

  if (body.type === "button") {
    const payload = parseButtonPayload(body.payload);
    if (!payload) return stay(state, "RECORDED");
    if (payload.loadId !== state.loadId) return stay(state, "REJECTED_WRONG_LOAD");
    if (payload.nonce !== state.nonce) return stay(state, "REJECTED_STALE_BUTTON");
    if (payload.action === "dispatch") {
      return stay(state, "ESCALATED", [{ type: "escalate", reason: "driver tapped Talk to dispatch" }, { type: "tell_driver", key: "dispatch_notified" }]);
    }
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
    const pin: PinRecord = { channel: event.channel ?? "whatsapp", serverAt: event.serverAt, messageId: event.wamid, lat: body.lat, lon: body.lon };
    if (state.phase === "awaiting_arrival_pin") {
      return next({ phase: "at_dock", arrived: pin }, [{ type: "resume", step: "arrived" }, { type: "offer_release" }]);
    }
    if (state.phase === "awaiting_release_pin") {
      return next({ phase: "awaiting_bol", released: pin, flowSends: 1 }, [{ type: "resume", step: "released" }, { type: "send_release_flow" }]);
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
    if (response.photos.length === 0 || !response.shareConsent) return resendFlow("bol_incomplete");
    if (!parseClock(response.inTime) || !parseClock(response.outTime)) return resendFlow("bol_times_unreadable");
    const bol: BolRecord = {
      channel: "whatsapp",
      serverAt: event.serverAt,
      messageId: event.wamid,
      photos: response.photos.map((p) => ({ mediaId: p.mediaId, mimeType: p.mimeType, metaSha256: p.metaSha256 })),
      inTime: response.inTime,
      outTime: response.outTime,
      delayReason: response.delayReason,
      consignee: response.consignee,
      receiverSigned: response.receiverSigned,
      shareConsent: response.shareConsent,
      media: "pending",
    };
    // download_media tells the driver what was saved once it knows, then the bol step resumes.
    return next({ phase: "documented", bol }, [{ type: "download_media" }, { type: "resume", step: "bol" }]);
  }

  if (body.type === "image" && state.phase === "awaiting_bol") {
    if (event.channel !== "rcs") return stay(state, "RECORDED", [{ type: "tell_driver", key: "use_bol_button" }]);
    // RCS has no Flow, so the photo reply is the bill of lading. Sending it after a prompt that says
    // it is shared with the broker is the consent; times and the signed box stay unknown.
    const bol: BolRecord = {
      channel: "rcs",
      serverAt: event.serverAt,
      messageId: event.wamid,
      photos: [{ mediaId: body.mediaId, mimeType: body.mimeType, metaSha256: null, ...(body.s3Key ? { s3Key: body.s3Key } : {}) }],
      inTime: null,
      outTime: null,
      delayReason: null,
      consignee: null,
      receiverSigned: false,
      shareConsent: true,
      media: "pending",
    };
    return next({ phase: "documented", bol }, [{ type: "download_media" }, { type: "resume", step: "bol" }]);
  }

  return stay(state, "RECORDED");
}

type StepView = Pick<LoadState, "arrived" | "released" | "bol"> & { retakeOf?: string };

export function stepSatisfied(state: StepView, step: Step): boolean {
  switch (step) {
    case "retake":
      return state.bol !== null && state.bol.messageId !== state.retakeOf && state.bol.media !== "pending";
    case "arrived":
      return state.arrived !== null;
    case "released":
      return state.released !== null;
    case "bol":
      return state.bol !== null && state.bol.media !== "pending";
  }
}

export function stepAt(state: StepView, step: Step): string | undefined {
  switch (step) {
    case "arrived":
      return state.arrived?.serverAt;
    case "released":
      return state.released?.serverAt;
    case "bol":
    case "retake":
      return state.bol?.serverAt;
  }
}

// The phase a driver prompt belongs to. A queued prompt replayed after the load has left that phase
// (or closed) is out of date and is dropped rather than sent.
export function promptPhase(effect: Effect): Phase | null {
  switch (effect.type) {
    case "send_dispatch":
      return "dispatched";
    case "request_location":
      return effect.step === "arrived" ? "awaiting_arrival_pin" : "awaiting_release_pin";
    case "offer_release":
      return "at_dock";
    case "send_release_flow":
    case "ask_retake":
      return "awaiting_bol";
    default:
      return null;
  }
}

// What to re-send over RCS when a WhatsApp message failed, named by the purpose its send recorded.
// A prompt the load has moved past is not re-sent (null), so a late failure cannot rewind the driver.
export function failoverEffect(purpose: string, phase: Phase): Effect | null {
  if (isTerminal(phase)) return null;
  if (purpose.startsWith("tell_")) {
    const key = purpose.slice("tell_".length) as MessageKey;
    return MESSAGE_KEYS.includes(key) ? { type: "tell_driver", key } : null;
  }
  const prompts: Record<string, [Effect, Phase]> = {
    dispatch_template: [{ type: "send_dispatch" }, "dispatched"],
    location_arrived: [{ type: "request_location", step: "arrived" }, "awaiting_arrival_pin"],
    offer_release: [{ type: "offer_release" }, "at_dock"],
    location_released: [{ type: "request_location", step: "released" }, "awaiting_release_pin"],
    release_flow: [{ type: "send_release_flow" }, "awaiting_bol"],
    // The retake deadline lives on the load, so a re-send over RCS can still state it.
    ask_retake: [{ type: "ask_retake" }, "awaiting_bol"],
  };
  const prompt = prompts[purpose];
  return prompt && prompt[1] === phase ? prompt[0] : null;
}
