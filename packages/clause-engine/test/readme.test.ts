import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headline, scorecard } from "../src/index.js";
import type { FixtureLoad } from "../src/fixtures.js";
import { LOADS_PATH } from "../src/cli/paths.js";

// The README quotes the scorecard twice: the lead (its first blockquote) in its own words, and the
// summary `npm run scorecard` prints. Both are claims; these keep them equal to what the frozen
// fixtures actually produce.
describe("README headline", () => {
  const fixtures = () => JSON.parse(readFileSync(LOADS_PATH, "utf8")) as FixtureLoad[];
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  it("quotes the summary the scorecard prints from the frozen fixtures", () => {
    expect(readme).toContain(headline(scorecard(fixtures())));
  });

  it("states the scorecard's numbers in the lead, the README's first blockquote", () => {
    const card = scorecard(fixtures());
    const lead = readme.split("\n").find((line) => line.startsWith("> "));
    expect(lead).toBeDefined();
    const { baseline, dockclock } = card;
    expect(lead).toContain(`On ${card.loads} test loads`);
    expect(lead).toContain(`that rule asks for ${usd(baseline.claimedUsd)}, and ${usd(baseline.uncollectibleUsd)} of it (${Math.round((baseline.uncollectibleUsd / baseline.claimedUsd) * 100)}%)`);
    expect(lead).toContain(`DockClock files the ${usd(card.contractPayableUsd)} those contracts owe, in ${dockclock.filed} claims, and nothing they deny.`);
    // Everything it files is owed and valid, which is what "files what the contracts owe" says.
    expect(dockclock.claimedUsd).toBe(card.contractPayableUsd);
    expect(dockclock.filedValid).toBe(dockclock.filed);
    expect(dockclock.falseHolds).toBe(0);
    // The one number the lead takes from outside the fixtures is sourced in FACTS.
    expect(lead).toContain("(55%) of the detention bills they send");
    expect(readFileSync(new URL("../../../FACTS.md", import.meta.url), "utf8")).toMatch(/\| US truckload carriers are paid on 55% of detention invoices \| ATRI[^|]*\| sourced \|/);
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
