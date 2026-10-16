import { createHash } from "node:crypto";
import { baselineClaim } from "./baseline.js";
import { clauseById } from "./clauses.js";
import { evaluate } from "./evaluate.js";
import type { FixtureLoad } from "./fixtures.js";

export interface Scorecard {
  fixtureSha256: string;
  loads: number;
  dockclock: {
    filed: number;
    filedValid: number;
    held: number;
    routedToHuman: number;
    falseHolds: number;
    claimedUsd: number;
  };
  baseline: {
    filed: number;
    deniableUnderContract: number;
    unsupportable: number;
    claimedUsd: number;
    deniableUsd: number;
    overbilledUsd: number;
  };
  contractPayableUsd: number;
  mismatches: string[];
}

function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fixtureHash(fixtures: FixtureLoad[]): string {
  return createHash("sha256").update(JSON.stringify(fixtures)).digest("hex");
}

export function scorecard(fixtures: FixtureLoad[]): Scorecard {
  const card: Scorecard = {
    fixtureSha256: fixtureHash(fixtures),
    loads: fixtures.length,
    dockclock: { filed: 0, filedValid: 0, held: 0, routedToHuman: 0, falseHolds: 0, claimedUsd: 0 },
    baseline: { filed: 0, deniableUnderContract: 0, unsupportable: 0, claimedUsd: 0, deniableUsd: 0, overbilledUsd: 0 },
    contractPayableUsd: 0,
    mismatches: [],
  };
  for (const { evidence, truth } of fixtures) {
    const result = evaluate(evidence, clauseById(evidence.clauseId));
    const base = baselineClaim(evidence);
    if (truth.verdict === "BILLABLE") card.contractPayableUsd += truth.amountUsd;

    if (result.verdict === "BILLABLE") {
      card.dockclock.filed += 1;
      card.dockclock.claimedUsd += result.amountUsd;
      if (truth.verdict === "BILLABLE") card.dockclock.filedValid += 1;
    } else if (result.verdict === "NOT_BILLABLE") {
      card.dockclock.held += 1;
    } else {
      card.dockclock.routedToHuman += 1;
    }
    if (truth.verdict === "BILLABLE" && result.verdict !== "BILLABLE") card.dockclock.falseHolds += 1;
    if (result.verdict !== truth.verdict || result.amountUsd !== truth.amountUsd) {
      card.mismatches.push(`${evidence.loadId}: engine ${result.verdict} $${result.amountUsd}, contract ${truth.verdict} $${truth.amountUsd}`);
    }

    if (base.filed) {
      card.baseline.filed += 1;
      card.baseline.claimedUsd += base.amountUsd;
      if (truth.verdict === "NOT_BILLABLE") {
        card.baseline.deniableUnderContract += 1;
        card.baseline.deniableUsd += base.amountUsd;
      } else if (truth.verdict === "NEEDS_HUMAN") {
        card.baseline.unsupportable += 1;
      } else if (base.amountUsd > truth.amountUsd) {
        card.baseline.overbilledUsd += base.amountUsd - truth.amountUsd;
      }
    }
  }
  card.dockclock.claimedUsd = cents(card.dockclock.claimedUsd);
  card.baseline.claimedUsd = cents(card.baseline.claimedUsd);
  card.baseline.deniableUsd = cents(card.baseline.deniableUsd);
  card.baseline.overbilledUsd = cents(card.baseline.overbilledUsd);
  card.contractPayableUsd = cents(card.contractPayableUsd);
  return card;
}

export function headline(card: Scorecard): string {
  const d = card.dockclock;
  const b = card.baseline;
  return (
    `On ${card.loads} test loads, DockClock filed ${d.filed} claims, all ${d.filedValid} contract-valid ` +
    `(${d.falseHolds} false holds), held ${d.held} with the clause reason and sent ${d.routedToHuman} to a person. ` +
    `The industry's 2-hour rule would have filed ${b.filed}: ${b.deniableUnderContract} the contract denies ` +
    `($${b.deniableUsd.toFixed(2)}) and ${b.unsupportable} the evidence can't support.`
  );
}
