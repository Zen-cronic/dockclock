import { describe, expect, it } from "vitest";
import { isoToLocalClock, isoToLocalDateTime, localClockToIso, normalizeClock, parseClock, UNREADABLE_CLOCK, zoneAbbreviation } from "../src/index.js";

describe("paperwork times", () => {
  it("parses 24-hour and 12-hour clock spellings drivers actually type", () => {
    for (const v of ["13:52", "1352", "13.52", "13h52", " 13 : 52 ", "13:52:00", "1:52 PM", "1:52pm", "1:52 p.m.", "1:52P"]) {
      expect(parseClock(v), v).toEqual({ hour: 13, minute: 52 });
    }
    expect(parseClock("12:05 AM")).toEqual({ hour: 0, minute: 5 });
    expect(parseClock("12:05 PM")).toEqual({ hour: 12, minute: 5 });
    expect(parseClock("9:07")).toEqual({ hour: 9, minute: 7 });
    for (const v of ["25:00", "13:52 PM", "0:30 am", "abc", "", null]) expect(parseClock(v), String(v)).toBeNull();
    expect(normalizeClock("1:52 PM")).toBe("13:52");
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

  it("never throws on a stored time that does not parse", () => {
    for (const bad of ["not a time", "garbage", "", "undefined"]) {
      expect(isoToLocalClock(bad, "America/New_York"), bad).toBe(UNREADABLE_CLOCK);
      expect(zoneAbbreviation(bad, "America/New_York"), bad).toBe("America/New_York");
      expect(isoToLocalDateTime(bad, "America/New_York"), bad).toMatch(/^--:-- \(time not readable\)$/);
      // No date to pin the paper's time to.
      expect(localClockToIso("13:52", bad, "America/New_York"), bad).toBeNull();
    }
  });
});
