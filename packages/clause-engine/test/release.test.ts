import { describe, expect, it } from "vitest";
import { clockEndOf, pinConfirmsTap, RELEASE_PIN_WINDOW_MINUTES, releasePinGapMinutes, releaseTimeOf } from "../src/index.js";

const TAP = "2026-10-23T18:32:59.000Z";
const PIN = "2026-10-23T18:40:00.000Z";

// One rule for what stopped the dock clock, read by sealing, the claim, the console API and the site.
describe("the release time", () => {
  it("is the Released tap when one was recorded, else the release pin", () => {
    expect(clockEndOf({ releasedTap: { serverAt: TAP }, released: { serverAt: PIN } })).toEqual({ by: "released_tap", at: TAP });
    expect(clockEndOf({ releasedTap: null, released: { serverAt: PIN } })).toEqual({ by: "released_pin", at: PIN });
    expect(releaseTimeOf({ releasedTap: { serverAt: TAP } })).toBe(TAP);
    expect(releaseTimeOf({ released: { serverAt: PIN } })).toBe(PIN);
  });

  it("reads untyped stored records safely", () => {
    expect(releaseTimeOf(null)).toBeNull();
    expect(releaseTimeOf({})).toBeNull();
    expect(releaseTimeOf({ releasedTap: {}, released: { serverAt: PIN } })).toBe(PIN);
    expect(releaseTimeOf({ releasedTap: { serverAt: 5 }, released: "x" })).toBeNull();
  });

  it("confirms the tap only with a pin inside the window, before or after", () => {
    expect(releasePinGapMinutes(TAP, PIN)).toBeCloseTo(7.02, 2);
    const at = (minutes: number) => new Date(Date.parse(TAP) + minutes * 60_000).toISOString();
    expect(pinConfirmsTap(TAP, at(RELEASE_PIN_WINDOW_MINUTES))).toBe(true);
    expect(pinConfirmsTap(TAP, at(-RELEASE_PIN_WINDOW_MINUTES))).toBe(true);
    expect(pinConfirmsTap(TAP, at(RELEASE_PIN_WINDOW_MINUTES + 0.5))).toBe(false);
  });
});
