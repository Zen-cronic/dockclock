import type { InboundEvent } from "@dockclock/whatsapp";
import { describe, expect, it } from "vitest";
import { applyEvent, type LoadState } from "../src/lifecycle.js";

const start: LoadState = { loadId: "4471", phase: "dispatched", version: 1, arrived: null, released: null };
let n = 0;
function tap(action: string, loadId = "4471"): InboundEvent {
  return { kind: "inbound", wamid: `w${++n}`, serverAt: "2026-10-13T13:50:00.000Z", sender: { kind: "phone", e164: "+14165550100" }, body: { type: "button", payload: `dc1.${action}.${loadId}.abc123` } };
}
function pin(serverAt = "2026-10-13T13:51:00.000Z"): InboundEvent {
  return { kind: "inbound", wamid: `w${++n}`, serverAt, sender: { kind: "phone", e164: "+14165550100" }, body: { type: "location", lat: 39.9, lon: -82.938 } };
}
function run(events: InboundEvent[]) {
  let state = start;
  const outcomes: string[] = [];
  for (const event of events) {
    const t = applyEvent(state, event);
    state = t.state;
    outcomes.push(t.outcome);
  }
  return { state, outcomes };
}

describe("applyEvent", () => {
  it("walks the happy path and asks for a pin at each step", () => {
    const t1 = applyEvent(start, tap("arrived"));
    expect(t1.effects).toEqual([{ type: "request_location", step: "arrived" }]);
    const { state, outcomes } = run([tap("arrived"), pin(), tap("released"), pin("2026-10-13T17:20:00.000Z")]);
    expect(outcomes).toEqual(["ADVANCED", "ADVANCED", "ADVANCED", "ADVANCED"]);
    expect(state.phase).toBe("released");
    expect(state.arrived?.serverAt).toBe("2026-10-13T13:51:00.000Z");
    expect(state.released?.serverAt).toBe("2026-10-13T17:20:00.000Z");
    expect(state.version).toBe(5);
  });

  it("ignores a second Arrived tap without moving the clock", () => {
    const { state, outcomes } = run([tap("arrived"), pin(), tap("arrived")]);
    expect(outcomes.at(-1)).toBe("IGNORED_DUPLICATE_TAP");
    expect(state.phase).toBe("at_dock");
    expect(state.version).toBe(3);
  });

  it("rejects Released before Arrived and tells the driver", () => {
    const t = applyEvent(start, tap("released"));
    expect(t.outcome).toBe("REJECTED_OUT_OF_ORDER");
    expect(t.state).toBe(start);
    expect(t.effects[0]?.type).toBe("tell_driver");
  });

  it("rejects a button bound to another load", () => {
    expect(applyEvent(start, tap("arrived", "9999")).outcome).toBe("REJECTED_WRONG_LOAD");
  });

  it("ignores a pin nobody asked for", () => {
    expect(applyEvent(start, pin()).outcome).toBe("IGNORED_UNSOLICITED_PIN");
    const { outcomes } = run([tap("arrived"), pin(), pin()]);
    expect(outcomes.at(-1)).toBe("IGNORED_UNSOLICITED_PIN");
  });

  it("records free text without changing state", () => {
    const text: InboundEvent = { ...tap("arrived"), body: { type: "text", text: "stuck at gate" } };
    expect(applyEvent(start, text)).toMatchObject({ outcome: "RECORDED", state: start });
  });
});
