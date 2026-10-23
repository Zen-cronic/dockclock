import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineClaim,
  buildFixtures,
  clauseById,
  CLAUSES,
  JUDGE_DEMO_CLAUSE,
  BOL_TOLERANCE_MINUTES,
  evaluate,
  RELEASE_PIN_WINDOW_MINUTES,
  scorecard,
  type FixtureLoad,
} from "../src/index.js";
import { LOADS_PATH, MANIFEST_PATH } from "../src/cli/paths.js";

const fixtures = buildFixtures();

describe("clause engine against each contract", () => {
  it.each(fixtures.map((f) => [f.evidence.loadId, f] as const))("%s", (_id, { evidence, truth }) => {
    const result = evaluate(evidence, clauseById(evidence.clauseId));
    expect(result.verdict).toBe(truth.verdict);
    expect(result.reasons).toEqual(truth.reasons);
    expect(result.amountUsd).toBe(truth.amountUsd);
  });
});

describe("fixtures", () => {
  it("covers every counterparty and every verdict", () => {
    const clauses = new Set(fixtures.map((f) => f.evidence.clauseId));
    expect(clauses.size).toBe(CLAUSES.length);
    const verdicts = new Set(fixtures.map((f) => f.truth.verdict));
    expect([...verdicts].sort()).toEqual(["BILLABLE", "NEEDS_HUMAN", "NOT_BILLABLE"]);
  });

  it("matches the frozen file and manifest", () => {
    const frozen = JSON.parse(readFileSync(LOADS_PATH, "utf8")) as FixtureLoad[];
    expect(frozen).toEqual(fixtures);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { sha256: string };
    expect(scorecard(frozen).fixtureSha256).toBe(manifest.sha256);
  });

  it("documents a source for every clause", () => {
    for (const clause of CLAUSES) {
      expect(clause.modelledOn.url).toMatch(/^https:\/\//);
      expect(clause.counterparty).toMatch(/fictional/);
    }
  });
});

describe("baseline", () => {
  it("bills any stop over two hours and nothing else", () => {
    const short = fixtures.find((f) => f.evidence.loadId === "L3");
    const long = fixtures.find((f) => f.evidence.loadId === "L2");
    expect(short && baselineClaim(short.evidence).filed).toBe(false);
    expect(long && baselineClaim(long.evidence).amountUsd).toBe(100);
  });
});

describe("scorecard", () => {
  const card = scorecard(fixtures);

  it("has no false holds and no mismatches", () => {
    expect(card.mismatches).toEqual([]);
    expect(card.dockclock.falseHolds).toBe(0);
    expect(card.dockclock.filed).toBe(card.dockclock.filedValid);
  });

  it("files exactly the contract-payable amount", () => {
    expect(card.dockclock.claimedUsd).toBe(card.contractPayableUsd);
  });

  it("shows the baseline filing claims the contract denies", () => {
    expect(card.baseline.deniableUnderContract).toBeGreaterThan(0);
  });
});

describe("daily cap", () => {
  it("caps each 24 hours of detention separately", () => {
    const clause = { ...clauseById("ridgeline-supply"), capHoursPerDay: 6, capUsdPerOccurrence: null, noticeLeadMinutes: null, requireOnTimeArrival: false };
    const start = "2026-10-13T08:00:00.000Z";
    const releasedAt = new Date(Date.parse(start) + (clause.freeTimeMinutes + 30 * 60) * 60_000).toISOString();
    const load = {
      loadId: "cap",
      clauseId: clause.id,
      facility: "x",
      appointmentAt: start,
      arrived: { at: start, insideGeofence: true },
      released: { at: releasedAt, insideGeofence: true },
      bol: { signed: true, checkIn: start, checkOut: releasedAt },
      status214: true,
      noticeSentAt: start,
      shipperConfirmed: true,
      evaluatedAt: releasedAt,
    };
    // 30 h of detention: 6 h on day one, 6 h of the remaining 6 h on day two.
    const result = evaluate(load, clause);
    expect(result.billableMinutes).toBe(12 * 60);
    expect(result.amountUsd).toBe(12 * clause.ratePerHourUsd);
    expect(result.reasons).toContain("CAP_APPLIED");
  });
});


// The judge try-it path's clause: a positive case, the ordinary early-release control, one changed
// condition (a typed time that disagrees with the pins) and the cap. Amounts are computed here from
// the clause, not hard-coded, so the README's numbers are checked separately against the same clause.
describe("judge demo clause", () => {
  const clause = clauseById(JUDGE_DEMO_CLAUSE.id);
  const at = (minutes: number) => new Date(Date.parse("2026-10-18T21:00:00.000Z") + minutes * 60_000).toISOString();
  const demoLoad = (releasedAfter: number, typedOutShift = 0) => ({
    loadId: "DEMO-test",
    clauseId: clause.id,
    facility: "judge-demo",
    appointmentAt: at(0),
    arrived: { at: at(0), insideGeofence: true },
    released: { at: at(releasedAfter), insideGeofence: true },
    bol: { signed: false, checkIn: at(0), checkOut: at(releasedAfter + typedOutShift) },
    status214: false,
    noticeSentAt: at(1),
    shipperConfirmed: false,
    evaluatedAt: at(releasedAfter + 2),
  });

  it("bills the minutes past free time at the clause's rate", () => {
    const result = evaluate(demoLoad(15), clause);
    expect(result.verdict).toBe("BILLABLE");
    expect(result.billableMinutes).toBe(15 - clause.freeTimeMinutes);
    expect(result.amountUsd).toBe(((15 - clause.freeTimeMinutes) / 60) * clause.ratePerHourUsd);
  });

  it("explains an early release instead of repairing it", () => {
    const result = evaluate(demoLoad(clause.freeTimeMinutes - 1), clause);
    expect(result).toMatchObject({ verdict: "NOT_BILLABLE", reasons: ["WITHIN_FREE_TIME"], amountUsd: 0 });
  });

  it("holds the load for a person when a typed time disagrees with the pins", () => {
    const result = evaluate(demoLoad(15, 20), clause);
    expect(result).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["BOL_TIMESTAMP_CONFLICT"] });
  });

  it("needs the notice, as clauses that require one do", () => {
    expect(evaluate({ ...demoLoad(15), noticeSentAt: null }, clause)).toMatchObject({ verdict: "NOT_BILLABLE", reasons: ["NOTICE_MISSING"] });
    expect(evaluate({ ...demoLoad(15), noticeSentAt: at(clause.freeTimeMinutes + 1) }, clause)).toMatchObject({ verdict: "NOT_BILLABLE", reasons: ["NOTICE_LATE"] });
  });

  it("stops at the cap", () => {
    const result = evaluate(demoLoad(120), clause);
    expect(result).toMatchObject({ verdict: "BILLABLE", amountUsd: clause.capUsdPerOccurrence, reasons: ["CAP_APPLIED"] });
  });

  it("is not one of the scored clauses", () => {
    expect(CLAUSES.map((c) => c.id)).not.toContain(JUDGE_DEMO_CLAUSE.id);
  });
});

// The dock clock stops at the driver's Released tap. The release pin only confirms it, and only
// within RELEASE_PIN_WINDOW_MINUTES; the paper's out time is compared with the tap.
describe("release: the Released tap ends the clock, the pin confirms it", () => {
  const clause = clauseById(JUDGE_DEMO_CLAUSE.id);
  const at = (minutes: number) => new Date(Date.parse("2026-10-23T18:00:00.000Z") + minutes * 60_000).toISOString();
  const tapped = (tapAfter: number, pinAfter: number, typedOut = tapAfter) => ({
    loadId: "TAP-test",
    clauseId: clause.id,
    facility: "judge-demo",
    appointmentAt: at(0),
    arrived: { at: at(0), insideGeofence: true },
    released: { at: at(tapAfter), insideGeofence: true },
    releasePinAt: at(pinAfter),
    bol: { signed: false, checkIn: at(0), checkOut: at(typedOut) },
    status214: false,
    noticeSentAt: at(1),
    shipperConfirmed: false,
    evaluatedAt: at(pinAfter + 2),
  });

  it("bills to the tap when the pin comes 3 minutes later", () => {
    const result = evaluate(tapped(15, 18), clause);
    expect(result.verdict).toBe("BILLABLE");
    expect(result.detentionMinutes).toBe(15 - clause.freeTimeMinutes);
    expect(result.amountUsd).toBe(((15 - clause.freeTimeMinutes) / 60) * clause.ratePerHourUsd);
  });

  it("accepts a pin exactly at the window's end", () => {
    expect(evaluate(tapped(15, 15 + RELEASE_PIN_WINDOW_MINUTES), clause).verdict).toBe("BILLABLE");
  });

  it("sends the load to a person when the pin comes 12 minutes after the tap", () => {
    expect(RELEASE_PIN_WINDOW_MINUTES).toBe(10);
    const result = evaluate(tapped(15, 27), clause);
    expect(result).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["RELEASE_PIN_LATE"], amountUsd: 0 });
  });

  it("keeps the geofence check on the confirming pin", () => {
    const result = evaluate({ ...tapped(15, 27), released: { at: at(15), insideGeofence: false } }, clause);
    expect(result.reasons).toEqual(["PIN_OUTSIDE_GEOFENCE", "RELEASE_PIN_LATE"]);
  });

  it("checks the paper's out time against the tap, not the pin", () => {
    // Pin 9 minutes after the tap; the paper says 8 minutes after the pin: 17 minutes from the tap.
    expect(evaluate(tapped(15, 24, 24 + 8), clause)).toMatchObject({ verdict: "NEEDS_HUMAN", reasons: ["BOL_TIMESTAMP_CONFLICT"] });
    // The paper matches the tap to the minute; the pin 9 minutes later does not matter.
    expect(evaluate(tapped(15, 24, 15), clause).verdict).toBe("BILLABLE");
    expect(evaluate(tapped(15, 24, 15 + BOL_TOLERANCE_MINUTES), clause).verdict).toBe("BILLABLE");
  });

  it("treats a record without a tap as before: release is the pin", () => {
    const pinOnly: Partial<ReturnType<typeof tapped>> = tapped(15, 15);
    delete pinOnly.releasePinAt;
    expect(evaluate(pinOnly as ReturnType<typeof tapped>, clause)).toMatchObject({ verdict: "BILLABLE", detentionMinutes: 15 - clause.freeTimeMinutes });
  });
});
