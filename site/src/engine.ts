import { baselineClaim, BOL_TOLERANCE_MINUTES, buildFixtures, clauseById, evaluate, RELEASE_PIN_WINDOW_MINUTES, scorecard, type Evaluation, type LoadEvidence, type ReasonCode } from "@dockclock/clause-engine";
import type { ReplaySnapshot } from "./snapshot.js";

// The real clause engine (packages/clause-engine), compiled into this page.

export const REASON_WORDS: Record<ReasonCode, string> = {
  MISSING_TIMESTAMP: "an arrival or release location is missing",
  PIN_OUTSIDE_GEOFENCE: "a location was outside the facility",
  BOL_TIMESTAMP_CONFLICT: `the times written on the bill of lading differ from the locations by more than ${BOL_TOLERANCE_MINUTES} minutes`,
  LATE_ARRIVAL: "the truck arrived after the appointment",
  WITHIN_FREE_TIME: "the wait stayed within the free time",
  NOTICE_MISSING: "the contract needs a notice before detention starts and none was sent",
  NOTICE_LATE: "the notice went out after the contract's deadline",
  NO_STATEMENT_OF_RECORD: "the contract needs a signed bill of lading with both times",
  CLAIM_WINDOW_EXPIRED: "the claim was filed after the contract's claim window closed",
  SHIPPER_CONFIRMATION_REQUIRED: "the contract needs the shipper's confirmation",
  CAP_APPLIED: "the contract's cap applies",
  RELEASE_PIN_LATE: `the release location was not shared within ${RELEASE_PIN_WINDOW_MINUTES} minutes of tapping Released`,
};

export function recordedEvidence(snap: ReplaySnapshot): LoadEvidence {
  const i = snap.verdict.engineInput;
  return {
    loadId: snap.load.loadId,
    clauseId: snap.clause.id,
    facility: snap.load.facility.id,
    appointmentAt: i.appointmentAt,
    arrived: i.arrived,
    released: i.released,
    ...(i.releasePinAt ? { releasePinAt: i.releasePinAt } : {}),
    bol: i.bol,
    status214: i.status214,
    noticeSentAt: i.noticeSentAt,
    shipperConfirmed: i.shipperConfirmed,
    evaluatedAt: i.evaluatedAt,
  };
}

export function run(evidence: LoadEvidence): Evaluation {
  return evaluate(evidence, clauseById(evidence.clauseId));
}

export function baseline(evidence: LoadEvidence) {
  return baselineClaim(evidence);
}

export function clauseSpec(id: string) {
  return clauseById(id);
}

export interface Headline {
  loads: number;
  owedUsd: number;
  dockclockClaimedUsd: number;
  filed: number;
  filedValid: number;
  falseHolds: number;
  baselineAskUsd: number;
  baselineRefusableUsd: number;
  baselineRefusablePct: number;
  fixtureSha256: string;
}

// The README headline, recomputed from the 24 test loads in the page itself.
export function headline(): Headline {
  const card = scorecard(buildFixtures());
  const d = card.dockclock;
  const claimedOfOwed = d.claimedUsd - Math.max(0, d.claimedUsd - (card.contractPayableUsd - d.unclaimedPayableUsd));
  return {
    loads: card.loads,
    owedUsd: card.contractPayableUsd,
    dockclockClaimedUsd: claimedOfOwed,
    filed: d.filed,
    filedValid: d.filedValid,
    falseHolds: d.falseHolds,
    baselineAskUsd: card.baseline.claimedUsd,
    baselineRefusableUsd: card.baseline.uncollectibleUsd,
    baselineRefusablePct: card.baseline.claimedUsd === 0 ? 0 : Math.round((card.baseline.uncollectibleUsd / card.baseline.claimedUsd) * 100),
    fixtureSha256: card.fixtureSha256,
  };
}
