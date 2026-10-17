import { describe, expect, it } from "vitest";
import { isoToLocalClock, localClockToIso, parseClock } from "../src/index.js";

describe("paperwork times", () => {
  it("parses common clock spellings", () => {
    for (const v of ["13:52", "1352", "13.52", "13h52", " 13 : 52 "]) expect(parseClock(v)).toEqual({ hour: 13, minute: 52 });
    for (const v of ["25:00", "abc", "", null]) expect(parseClock(v)).toBeNull();
  });

  it("pins a facility clock time to the pin's day in that zone", () => {
    // 13:52 EDT on 2026-10-13 is 17:52 UTC.
    expect(localClockToIso("13:52", "2026-10-13T17:50:00.000Z", "America/New_York")).toBe("2026-10-13T17:52:00.000Z");
    expect(localClockToIso("13:52", "2026-10-13T18:50:00.000Z", "America/Chicago")).toBe("2026-10-13T18:52:00.000Z");
  });

  it("chooses the neighbouring day when the wait crosses midnight", () => {
    // Pin at 00:10 EDT on Oct 14; paperwork says 23:55, which means Oct 13.
    expect(localClockToIso("23:55", "2026-10-14T04:10:00.000Z", "America/New_York")).toBe("2026-10-14T03:55:00.000Z");
  });

  it("handles the EST side of daylight saving", () => {
    expect(localClockToIso("09:00", "2026-12-01T14:05:00.000Z", "America/New_York")).toBe("2026-12-01T14:00:00.000Z");
    expect(isoToLocalClock("2026-12-01T14:00:00.000Z", "America/New_York")).toBe("09:00");
  });
});
