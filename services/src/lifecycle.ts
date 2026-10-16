import type { InboundEvent } from "@dockclock/whatsapp";
import { parseButtonPayload } from "@dockclock/whatsapp";

export type Phase = "dispatched" | "awaiting_arrival_pin" | "at_dock" | "awaiting_release_pin" | "released";
export type Step = "arrived" | "released";

export interface PinRecord {
  serverAt: string;
  messageId: string;
  lat: number;
  lon: number;
}

export interface LoadState {
  loadId: string;
  phase: Phase;
  version: number;
  arrived: PinRecord | null;
  released: PinRecord | null;
}

export type Outcome =
  | "ADVANCED"
  | "IGNORED_DUPLICATE_TAP"
  | "REJECTED_OUT_OF_ORDER"
  | "REJECTED_WRONG_LOAD"
  | "IGNORED_UNSOLICITED_PIN"
  | "RECORDED";

export type Effect =
  | { type: "request_location"; step: Step }
  | { type: "tell_driver"; text: string }
  | { type: "resume"; step: Step };

export interface Transition {
  state: LoadState;
  outcome: Outcome;
  effects: Effect[];
}

const AFTER_ARRIVAL: readonly Phase[] = ["awaiting_arrival_pin", "at_dock", "awaiting_release_pin", "released"];

function stay(state: LoadState, outcome: Outcome, effects: Effect[] = []): Transition {
  return { state, outcome, effects };
}

// The only place a driver event changes a load. SQS can redeliver and reorder, so every branch is
// safe to see twice and a tap that arrives before its prerequisite changes nothing.
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
    if (payload.action === "arrived") {
      if (state.phase !== "dispatched") return stay(state, "IGNORED_DUPLICATE_TAP");
      return next({ phase: "awaiting_arrival_pin" }, [{ type: "request_location", step: "arrived" }]);
    }
    if (payload.action === "released") {
      if (state.phase === "at_dock") return next({ phase: "awaiting_release_pin" }, [{ type: "request_location", step: "released" }]);
      if (state.phase === "awaiting_release_pin" || state.phase === "released") return stay(state, "IGNORED_DUPLICATE_TAP");
      return stay(state, "REJECTED_OUT_OF_ORDER", [{ type: "tell_driver", text: "Tap Arrived and share your location first." }]);
    }
    return stay(state, "RECORDED");
  }

  if (body.type === "location") {
    const pin: PinRecord = { serverAt: event.serverAt, messageId: event.wamid, lat: body.lat, lon: body.lon };
    if (state.phase === "awaiting_arrival_pin") return next({ phase: "at_dock", arrived: pin }, [{ type: "resume", step: "arrived" }]);
    if (state.phase === "awaiting_release_pin") return next({ phase: "released", released: pin }, [{ type: "resume", step: "released" }]);
    return stay(state, "IGNORED_UNSOLICITED_PIN");
  }

  return stay(state, "RECORDED");
}

export function stepSatisfied(state: Pick<LoadState, "arrived" | "released">, step: Step): boolean {
  return step === "arrived" ? state.arrived !== null : state.released !== null;
}

export function hasArrived(phase: Phase): boolean {
  return AFTER_ARRIVAL.includes(phase);
}
