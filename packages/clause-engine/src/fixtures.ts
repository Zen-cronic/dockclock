import type { LoadEvidence, ReasonCode, Verdict } from "./types.js";

export interface ContractTruth {
  verdict: Verdict;
  reasons: ReasonCode[];
  amountUsd: number;
  note: string;
}

export interface FixtureLoad {
  evidence: LoadEvidence;
  truth: ContractTruth;
}

interface Case {
  id: string;
  clauseId: string;
  facility: string;
  arrive: number | null;
  release: number | null;
  releaseInside?: boolean;
  bol?: "match" | "unsigned" | "none" | { checkOut: number };
  status214?: boolean;
  notice?: number | null;
  confirmed?: boolean;
  evaluatedHoursAfterRelease?: number;
  truth: ContractTruth;
}

// All times are minutes relative to a 14:00 UTC appointment on 2026-10-13.
const APPOINTMENT = "2026-10-13T14:00:00.000Z";

function at(offsetMinutes: number): string {
  return new Date(Date.parse(APPOINTMENT) + offsetMinutes * 60_000).toISOString();
}

// The truth column is written by hand from each clause's text, independently of the evaluator,
// so the test compares the engine against the contract rather than against itself.
const CASES: Case[] = [
  { id: "L1", clauseId: "lakeshore-foods", facility: "Lakeshore DC, Columbus OH", arrive: -10, release: 200, bol: "match", truth: { verdict: "BILLABLE", reasons: [], amountUsd: 80, note: "Early arrival; clock from the appointment; 80 min at $1/min" } },
  { id: "L2", clauseId: "lakeshore-foods", facility: "Lakeshore DC, Columbus OH", arrive: 20, release: 260, bol: "match", truth: { verdict: "NOT_BILLABLE", reasons: ["LATE_ARRIVAL"], amountUsd: 0, note: "Arrived after the appointment; clause excludes detention" } },
  { id: "L3", clauseId: "lakeshore-foods", facility: "Lakeshore DC, Columbus OH", arrive: 0, release: 110, bol: "match", truth: { verdict: "NOT_BILLABLE", reasons: ["WITHIN_FREE_TIME"], amountUsd: 0, note: "Released inside the 2-hour free time" } },
  { id: "L4", clauseId: "lakeshore-foods", facility: "Lakeshore DC, Columbus OH", arrive: -5, release: 600, bol: "match", truth: { verdict: "BILLABLE", reasons: ["CAP_APPLIED"], amountUsd: 360, note: "480 min would be $480; capped at $360 per occurrence" } },
  { id: "L5", clauseId: "lakeshore-foods", facility: "Lakeshore DC, Columbus OH", arrive: -90, release: 150, status214: true, bol: "none", truth: { verdict: "BILLABLE", reasons: [], amountUsd: 30, note: "Arrived 90 min early; only 30 min past free time counted from the appointment; 214 is the record" } },
  { id: "R1", clauseId: "ridgeline-supply", facility: "Ridgeline Yard, Omaha NE", arrive: 0, release: 240, bol: "match", notice: 90, truth: { verdict: "BILLABLE", reasons: [], amountUsd: 100, note: "Notice emailed 30 min before detention; 120 min at $50/h" } },
  { id: "R2", clauseId: "ridgeline-supply", facility: "Ridgeline Yard, Omaha NE", arrive: 0, release: 240, bol: "match", notice: null, truth: { verdict: "NOT_BILLABLE", reasons: ["NOTICE_MISSING"], amountUsd: 0, note: "No notice before entering detention" } },
  { id: "R3", clauseId: "ridgeline-supply", facility: "Ridgeline Yard, Omaha NE", arrive: 0, release: 240, bol: "match", notice: 110, truth: { verdict: "NOT_BILLABLE", reasons: ["NOTICE_LATE"], amountUsd: 0, note: "Notice sent 10 min before detention, inside the 30-min lead" } },
  { id: "R4", clauseId: "ridgeline-supply", facility: "Ridgeline Yard, Omaha NE", arrive: 0, release: 600, bol: "match", notice: 90, truth: { verdict: "BILLABLE", reasons: ["CAP_APPLIED"], amountUsd: 300, note: "480 min of detention; paid up to 6 hours per day" } },
  { id: "R5", clauseId: "ridgeline-supply", facility: "Ridgeline Yard, Omaha NE", arrive: 0, release: 240, bol: "unsigned", notice: 90, truth: { verdict: "NOT_BILLABLE", reasons: ["NO_STATEMENT_OF_RECORD"], amountUsd: 0, note: "BOL not signed with times and no 214" } },
  { id: "A1", clauseId: "atlas-brokerage", facility: "Mesa Cold Storage, Phoenix AZ", arrive: -15, release: 215, bol: "match", notice: 90, truth: { verdict: "BILLABLE", reasons: [], amountUsd: 79.17, note: "Notice 30 min ahead; 95 min at $50/h" } },
  { id: "A2", clauseId: "atlas-brokerage", facility: "Mesa Cold Storage, Phoenix AZ", arrive: -15, release: 215, bol: "match", notice: 90, evaluatedHoursAfterRelease: 72, truth: { verdict: "NOT_BILLABLE", reasons: ["CLAIM_WINDOW_EXPIRED"], amountUsd: 0, note: "Claimed 72 h after release; window is 48 h" } },
  { id: "A3", clauseId: "atlas-brokerage", facility: "Mesa Cold Storage, Phoenix AZ", arrive: -15, release: 215, bol: { checkOut: 150 }, notice: 90, truth: { verdict: "NEEDS_HUMAN", reasons: ["BOL_TIMESTAMP_CONFLICT"], amountUsd: 0, note: "BOL out-time is 65 min before the release pin; a person must reconcile" } },
  { id: "A4", clauseId: "atlas-brokerage", facility: "Mesa Cold Storage, Phoenix AZ", arrive: 45, release: 260, bol: "match", notice: 90, truth: { verdict: "NOT_BILLABLE", reasons: ["LATE_ARRIVAL"], amountUsd: 0, note: "Arrived 45 min late" } },
  { id: "A5", clauseId: "atlas-brokerage", facility: "Mesa Cold Storage, Phoenix AZ", arrive: -15, release: 215, bol: "unsigned", status214: true, notice: 90, truth: { verdict: "NOT_BILLABLE", reasons: ["NO_STATEMENT_OF_RECORD"], amountUsd: 0, note: "Broker requires in/out times on paperwork; a 214 alone isn't accepted" } },
  { id: "F1", clauseId: "freightline-digital", facility: "Prairie Distribution, Joliet IL", arrive: -5, release: 200, bol: "none", truth: { verdict: "BILLABLE", reasons: [], amountUsd: 70.83, note: "GPS timestamps accepted as the record; 85 min at $50/h" } },
  { id: "F2", clauseId: "freightline-digital", facility: "Prairie Distribution, Joliet IL", arrive: -5, release: 200, bol: "none", evaluatedHoursAfterRelease: 30, truth: { verdict: "NOT_BILLABLE", reasons: ["CLAIM_WINDOW_EXPIRED"], amountUsd: 0, note: "Requested 30 h after delivery; window is 24 h" } },
  { id: "F3", clauseId: "freightline-digital", facility: "Prairie Distribution, Joliet IL", arrive: -5, release: 200, releaseInside: false, bol: "none", truth: { verdict: "NEEDS_HUMAN", reasons: ["PIN_OUTSIDE_GEOFENCE"], amountUsd: 0, note: "Release pin is outside the facility; the time can't be trusted" } },
  { id: "F4", clauseId: "freightline-digital", facility: "Prairie Distribution, Joliet IL", arrive: 30, release: 230, bol: "none", truth: { verdict: "NOT_BILLABLE", reasons: ["LATE_ARRIVAL"], amountUsd: 0, note: "Arrived 30 min late" } },
  { id: "F5", clauseId: "freightline-digital", facility: "Prairie Distribution, Joliet IL", arrive: 0, release: 100, bol: "none", truth: { verdict: "NOT_BILLABLE", reasons: ["WITHIN_FREE_TIME"], amountUsd: 0, note: "Released inside free time" } },
  { id: "V1", clauseId: "valley-ag", facility: "Valley Ag Terminal, Fresno CA", arrive: 0, release: 270, bol: "match", confirmed: true, truth: { verdict: "BILLABLE", reasons: [], amountUsd: 125, note: "Shipper employee confirmed the delay; 150 min at $50/h" } },
  { id: "V2", clauseId: "valley-ag", facility: "Valley Ag Terminal, Fresno CA", arrive: 0, release: 270, bol: "match", confirmed: false, truth: { verdict: "NEEDS_HUMAN", reasons: ["SHIPPER_CONFIRMATION_REQUIRED"], amountUsd: 0, note: "Clause needs a shipper employee to confirm the delay" } },
  { id: "V3", clauseId: "valley-ag", facility: "Valley Ag Terminal, Fresno CA", arrive: 0, release: null, bol: "none", confirmed: true, truth: { verdict: "NEEDS_HUMAN", reasons: ["MISSING_TIMESTAMP"], amountUsd: 0, note: "Driver never tapped Released" } },
  { id: "V4", clauseId: "valley-ag", facility: "Valley Ag Terminal, Fresno CA", arrive: 60, release: 300, bol: "match", confirmed: true, truth: { verdict: "BILLABLE", reasons: [], amountUsd: 100, note: "Clause doesn't require on-time arrival; 120 min from scale entry" } },
];

function bolFor(c: Case): LoadEvidence["bol"] {
  if (c.bol === undefined || c.bol === "none") return null;
  const checkIn = c.arrive === null ? null : at(c.arrive);
  const checkOut = c.release === null ? null : at(c.release);
  if (c.bol === "match") return { signed: true, checkIn, checkOut };
  if (c.bol === "unsigned") return { signed: false, checkIn: null, checkOut: null };
  return { signed: true, checkIn, checkOut: at(c.bol.checkOut) };
}

export function buildFixtures(): FixtureLoad[] {
  return CASES.map((c) => {
    const released = c.release === null ? null : { at: at(c.release), insideGeofence: c.releaseInside ?? true };
    const evaluatedAt = at((c.release ?? c.arrive ?? 0) + (c.evaluatedHoursAfterRelease ?? 1) * 60);
    return {
      evidence: {
        loadId: c.id,
        clauseId: c.clauseId,
        facility: c.facility,
        appointmentAt: APPOINTMENT,
        arrived: c.arrive === null ? null : { at: at(c.arrive), insideGeofence: true },
        released,
        bol: bolFor(c),
        status214: c.status214 ?? false,
        noticeSentAt: c.notice === undefined || c.notice === null ? null : at(c.notice),
        shipperConfirmed: c.confirmed ?? false,
        evaluatedAt,
      },
      truth: c.truth,
    };
  });
}
