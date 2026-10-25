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
    // Money the contracts owe that DockClock did not claim.
    unclaimedPayableUsd: number;
  };
  baseline: {
    filed: number;
    deniableUnderContract: number;
    unsupportable: number;
    claimedUsd: number;
    deniableUsd: number;
    overbilledUsd: number;
    unsupportableUsd: number;
    // Denied, more than the clause pays, or unprovable: the part of the ask a broker can refuse.
    uncollectibleUsd: number;
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
    dockclock: { filed: 0, filedValid: 0, held: 0, routedToHuman: 0, falseHolds: 0, claimedUsd: 0, unclaimedPayableUsd: 0 },
    baseline: { filed: 0, deniableUnderContract: 0, unsupportable: 0, claimedUsd: 0, deniableUsd: 0, overbilledUsd: 0, unsupportableUsd: 0, uncollectibleUsd: 0 },
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
    if (truth.verdict === "BILLABLE") {
      const claimed = result.verdict === "BILLABLE" ? Math.min(result.amountUsd, truth.amountUsd) : 0;
      card.dockclock.unclaimedPayableUsd += truth.amountUsd - claimed;
    }
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
        card.baseline.unsupportableUsd += base.amountUsd;
      } else if (base.amountUsd > truth.amountUsd) {
        card.baseline.overbilledUsd += base.amountUsd - truth.amountUsd;
      }
    }
  }
  card.dockclock.claimedUsd = cents(card.dockclock.claimedUsd);
  card.baseline.claimedUsd = cents(card.baseline.claimedUsd);
  card.baseline.deniableUsd = cents(card.baseline.deniableUsd);
  card.baseline.overbilledUsd = cents(card.baseline.overbilledUsd);
  card.baseline.unsupportableUsd = cents(card.baseline.unsupportableUsd);
  card.baseline.uncollectibleUsd = cents(card.baseline.deniableUsd + card.baseline.overbilledUsd + card.baseline.unsupportableUsd);
  card.dockclock.unclaimedPayableUsd = cents(card.dockclock.unclaimedPayableUsd);
  card.contractPayableUsd = cents(card.contractPayableUsd);
  return card;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

// README line one. Leads with money owed, not with how many claims were filed, and never says
// "all" or "nothing a contract denies", or leaves out a held-back owed claim, unless the numbers say so.
export function headline(card: Scorecard): string {
  const d = card.dockclock;
  const b = card.baseline;
  const claimedOfOwed = d.claimedUsd - Math.max(0, d.claimedUsd - (card.contractPayableUsd - d.unclaimedPayableUsd));
  const allValid = d.filedValid === d.filed;
  const valid = allValid ? `all ${d.filed} valid` : `${d.filedValid} of ${d.filed} valid`;
  const held = d.falseHolds === 0 ? "" : `, holding back ${d.falseHolds} owed claim${d.falseHolds === 1 ? "" : "s"}`;
  return (
    `On ${card.loads} test loads, the contracts owe ${usd(card.contractPayableUsd)} in detention. ` +
    `DockClock would claim ${usd(claimedOfOwed)} of it (${percent(claimedOfOwed, card.contractPayableUsd)}) in ${d.filed} claims, ${valid}${held}` +
    `${allValid ? ", and nothing a contract denies" : ""}. ` +
    `The common "bill every stop over 2 hours" rule asks for ${usd(b.claimedUsd)}, and ${usd(b.uncollectibleUsd)} of that ` +
    `(${percent(b.uncollectibleUsd, b.claimedUsd)}) would not be paid: the contract denies it, pays less than was asked, or the carrier can't prove it.`
  );
}
