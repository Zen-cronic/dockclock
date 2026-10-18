import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baselineClaim,
  buildFixtures,
  clauseById,
  CLAUSES,
  evaluate,
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

