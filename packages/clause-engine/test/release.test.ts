import { describe, expect, it } from "vitest";
import { clockEndOf, RELEASE_PIN_WINDOW_MINUTES, releasePinCheck, releasePinGapMinutes, releasePinGapWords, releaseTimeOf, shiftTime, timeReadable } from "../src/index.js";

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
    expect(releasePinCheck(TAP, at(RELEASE_PIN_WINDOW_MINUTES))).toBe("confirmed");
    expect(releasePinCheck(TAP, at(-RELEASE_PIN_WINDOW_MINUTES))).toBe("confirmed");
    expect(releasePinCheck(TAP, at(RELEASE_PIN_WINDOW_MINUTES + 0.5))).toBe("late");
    expect(releasePinCheck(TAP, at(-RELEASE_PIN_WINDOW_MINUTES - 0.5))).toBe("late");
  });

  it("words the gap by its side of the tap and never rounds a missed window onto the limit", () => {
    const at = (seconds: number) => new Date(Date.parse(TAP) + seconds * 1000).toISOString();
    expect(releasePinGapWords(TAP, PIN)).toBe("7 min after");
    expect(releasePinGapWords(TAP, at(-15 * 60))).toBe("15 min before");
    expect(releasePinGapWords(TAP, at(10 * 60 + 25))).toBe("10.5 min after");
    expect(releasePinGapWords(TAP, at(10 * 60 + 1))).toBe("10.1 min after");
    expect(releasePinGapWords(TAP, at(-(10 * 60 + 25)))).toBe("10.5 min before");
    // Inside the window, whole minutes as before.
    expect(releasePinGapWords(TAP, at(9 * 60 + 40))).toBe("10 min after");
  });

  it("calls a time that does not parse unreadable: neither confirmed nor late", () => {
    for (const [tap, pin] of [[TAP, "not a time"], ["", PIN], [TAP, ""], ["garbage", "garbage"]] as const) {
      expect(releasePinCheck(tap, pin), `${tap} / ${pin}`).toBe("unreadable");
    }
    expect(timeReadable(TAP)).toBe(true);
    expect(timeReadable("not a time")).toBe(false);
    expect(timeReadable(undefined)).toBe(false);
    // The words never print NaN.
    expect(releasePinGapWords(TAP, "not a time")).not.toMatch(/NaN/);
  });

  it("shifts a readable time and gives null for one that does not parse, never a RangeError", () => {
    expect(shiftTime(TAP, 30 * 60_000)).toBe("2026-10-23T19:02:59.000Z");
    expect(shiftTime(TAP, -1)).toBe("2026-10-23T18:32:58.999Z");
    for (const bad of ["not a time", "", undefined, null, 42]) expect(shiftTime(bad, 1), String(bad)).toBeNull();
    expect(shiftTime("+275760-09-13T00:00:00.000Z", 1)).toBeNull();
  });
});
