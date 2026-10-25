import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headline, scorecard } from "../src/index.js";
import type { FixtureLoad } from "../src/fixtures.js";
import { LOADS_PATH } from "../src/cli/paths.js";

// README line one is a claim; this keeps it equal to what the frozen fixtures actually produce.
describe("README headline", () => {
  it("matches the scorecard recomputed from the frozen fixtures", () => {
    const fixtures = JSON.parse(readFileSync(LOADS_PATH, "utf8")) as FixtureLoad[];
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(headline(scorecard(fixtures)));
  });
});

describe("headline wording", () => {
  const card = () => scorecard(JSON.parse(readFileSync(LOADS_PATH, "utf8")) as FixtureLoad[]);
  const withDockclock = (over: Partial<ReturnType<typeof card>["dockclock"]>) => {
    const c = card();
    return { ...c, dockclock: { ...c.dockclock, ...over } };
  };

  it("says one claim, not one claims", () => {
    const line = headline(withDockclock({ filed: 1, filedValid: 1, falseHolds: 1 }));
    expect(line).toContain("in 1 claim, valid, holding back 1 owed claim, and nothing a contract denies.");
    expect(line).not.toMatch(/1 claims|all 1 valid/);
    expect(headline(withDockclock({ filed: 1, filedValid: 0, falseHolds: 0 }))).toContain("in 1 claim, not valid.");
  });

  it("says nothing was filed, without calling nothing valid", () => {
    const line = headline(withDockclock({ filed: 0, filedValid: 0, falseHolds: 2, claimedUsd: 0 }));
    expect(line).toContain("DockClock would file no claims, holding back 2 owed claims.");
    expect(line).not.toMatch(/0 claims|all 0 valid|nothing a contract denies/);
  });
});
