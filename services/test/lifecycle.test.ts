import type { InboundEvent } from "@dockclock/whatsapp";
import { encodeFlowToken } from "@dockclock/whatsapp";
import { describe, expect, it } from "vitest";
import { applyEvent, stepSatisfied, type LoadState } from "../src/lifecycle.js";

const start: LoadState = { loadId: "4471", nonce: "abc123", phase: "dispatched", version: 1, arrived: null, released: null, bol: null, flowSends: 0 };
let n = 0;
const sender = { kind: "phone" as const, e164: "+14165550100" };
function tap(action: string, loadId = "4471", nonce = "abc123"): InboundEvent {
  return { kind: "inbound", wamid: `w${++n}`, serverAt: "2026-10-13T13:50:00.000Z", sender, body: { type: "button", payload: `dc1.${action}.${loadId}.${nonce}` } };
}
function pin(serverAt = "2026-10-13T13:51:00.000Z"): InboundEvent {
  return { kind: "inbound", wamid: `w${++n}`, serverAt, sender, body: { type: "location", lat: 39.9, lon: -82.938 } };
}
function flow(overrides: Record<string, unknown> = {}, token = encodeFlowToken("4471", "abc123")): InboundEvent {
  const response = {
    flow_token: token,
    bol_photo: [{ id: "media-1", mime_type: "image/jpeg", sha256: "x" }],
    in_time: "13:52",
    out_time: "17:18",
    delay_reason: "dock_not_ready",
    consignee: "R. Alvarez",
    receiver_signed: true,
    share_consent: true,
    ...overrides,
  };
  return { kind: "inbound", wamid: `w${++n}`, serverAt: "2026-10-13T17:25:00.000Z", sender, body: { type: "flow", responseJson: JSON.stringify(response) } };
}
function run(events: InboundEvent[], from = start) {
  let state = from;
  const outcomes: string[] = [];
  for (const event of events) {
    const t = applyEvent(state, event);
    state = t.state;
    outcomes.push(t.outcome);
  }
  return { state, outcomes };
}
const toBol = [tap("arrived"), pin(), tap("released"), pin("2026-10-13T17:20:00.000Z")];

describe("applyEvent", () => {
  it("walks the happy path through the bill of lading", () => {
    const { state, outcomes } = run([...toBol, flow()]);
    expect(outcomes).toEqual(["ADVANCED", "ADVANCED", "ADVANCED", "ADVANCED", "ADVANCED"]);
    expect(state.phase).toBe("documented");
    expect(state.bol).toMatchObject({ inTime: "13:52", outTime: "17:18", consignee: "R. Alvarez", receiverSigned: true, media: "pending", photos: [{ mediaId: "media-1" }] });
    expect(state.version).toBe(6);
  });

  it("asks for a pin, offers Released, then sends the release Flow", () => {
    expect(applyEvent(start, tap("arrived")).effects).toEqual([{ type: "request_location", step: "arrived" }]);
    const atDock = run(toBol.slice(0, 1)).state;
    expect(applyEvent(atDock, pin()).effects).toEqual([{ type: "resume", step: "arrived" }, { type: "offer_release" }]);
    const releasing = run(toBol.slice(0, 3)).state;
    expect(applyEvent(releasing, pin()).effects).toEqual([{ type: "resume", step: "released" }, { type: "send_release_flow" }]);
  });

  it("ignores a second Arrived tap without moving the clock", () => {
    const { state, outcomes } = run([tap("arrived"), pin(), tap("arrived")]);
    expect(outcomes.at(-1)).toBe("IGNORED_DUPLICATE_TAP");
    expect(state.phase).toBe("at_dock");
  });

  it("rejects Released before Arrived and tells the driver", () => {
    const t = applyEvent(start, tap("released"));
    expect(t.outcome).toBe("REJECTED_OUT_OF_ORDER");
    expect(t.state).toBe(start);
    expect(t.effects).toEqual([{ type: "tell_driver", key: "tap_arrived_first" }]);
  });

  it("rejects buttons from another load or an old nonce", () => {
    expect(applyEvent(start, tap("arrived", "9999")).outcome).toBe("REJECTED_WRONG_LOAD");
    expect(applyEvent(start, tap("arrived", "4471", "old999")).outcome).toBe("REJECTED_STALE_BUTTON");
  });

  it("escalates Talk to dispatch without changing the load", () => {
    const t = applyEvent(start, tap("dispatch"));
    expect(t.outcome).toBe("ESCALATED");
    expect(t.state).toBe(start);
    expect(t.effects).toEqual([{ type: "escalate", reason: "driver tapped Talk to dispatch" }, { type: "tell_driver", key: "dispatch_notified" }]);
  });

  it("ignores a pin nobody asked for", () => {
    expect(applyEvent(start, pin()).outcome).toBe("IGNORED_UNSOLICITED_PIN");
  });

  it("refuses a Flow before release, from another load, or without photo and consent", () => {
    expect(applyEvent(start, flow()).outcome).toBe("REJECTED_OUT_OF_ORDER");
    const awaiting = run(toBol).state;
    expect(applyEvent(awaiting, flow({}, encodeFlowToken("9999", "abc123"))).outcome).toBe("REJECTED_WRONG_LOAD");
    const noPhoto = applyEvent(awaiting, flow({ bol_photo: [] }));
    expect(noPhoto.outcome).toBe("REJECTED_INCOMPLETE_FLOW");
    expect(noPhoto.effects).toEqual([{ type: "tell_driver", key: "bol_incomplete" }, { type: "send_release_flow" }]);
    expect(noPhoto.state.flowSends).toBe(2);
    expect(applyEvent(awaiting, flow({ share_consent: false })).outcome).toBe("REJECTED_INCOMPLETE_FLOW");
  });

  it("ignores a second Flow submission once documented", () => {
    const { outcomes } = run([...toBol, flow(), flow()]);
    expect(outcomes.at(-1)).toBe("IGNORED_DUPLICATE_TAP");
  });

  it("refuses unreadable times instead of saving a claim that silently loses them", () => {
    const awaiting = run(toBol).state;
    const t = applyEvent(awaiting, flow({ in_time: "around two", out_time: "17:18" }));
    expect(t.outcome).toBe("REJECTED_INCOMPLETE_FLOW");
    expect(t.effects[0]).toEqual({ type: "tell_driver", key: "bol_times_unreadable" });
    expect(applyEvent(awaiting, flow({ in_time: "1:52 PM", out_time: "5:18pm" })).outcome).toBe("ADVANCED");
  });

  it("stops re-sending the Flow after the limit and hands the load to dispatch", () => {
    let state = run(toBol).state;
    const outcomes: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      const t = applyEvent(state, flow({ bol_photo: [] }));
      state = t.state;
      outcomes.push(t.effects.find((e) => e.type === "send_release_flow")?.type ?? t.effects.find((e) => e.type === "escalate")?.type);
    }
    expect(outcomes).toEqual(["send_release_flow", "send_release_flow", "escalate", "escalate"]);
  });

  it("refuses every tap and Flow once the workflow has sealed or closed the load", () => {
    for (const phase of ["sealed", "closed"] as const) {
      const ended = { ...run([...toBol, flow()]).state, phase };
      for (const event of [tap("released"), flow(), tap("arrived")]) {
        const t = applyEvent(ended, event);
        expect(t.outcome).toBe("REJECTED_CLOSED_LOAD");
        expect(t.state).toBe(ended);
        expect(t.effects).toEqual([{ type: "tell_driver", key: "load_closed" }]);
      }
    }
  });

  it("points a driver who sends the BOL as a chat photo to the Flow button", () => {
    const awaiting = run(toBol).state;
    const photo: InboundEvent = { kind: "inbound", wamid: "w-img", serverAt: "2026-10-13T17:24:00.000Z", sender, body: { type: "image", mediaId: "m", mimeType: "image/jpeg", metaSha256: null } };
    expect(applyEvent(awaiting, photo)).toMatchObject({ outcome: "RECORDED", effects: [{ type: "tell_driver", key: "use_bol_button" }] });
  });

  it("treats the bill-of-lading step as done only once media is settled", () => {
    const documented = run([...toBol, flow()]).state;
    expect(stepSatisfied(documented, "bol")).toBe(false);
    expect(stepSatisfied({ ...documented, bol: { ...documented.bol!, media: "unavailable" } }, "bol")).toBe(true);
  });
});
