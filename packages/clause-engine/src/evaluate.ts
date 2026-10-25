import { pinMissedWindow } from "./release.js";
import type { ClauseSpec, Evaluation, LoadEvidence, ReasonCode, RecordKind } from "./types.js";

export const BOL_TOLERANCE_MINUTES = 15;

const MINUTE = 60_000;

function minutesBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / MINUTE;
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * MINUTE).toISOString();
}

function roundCents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

function hasRecord(load: LoadEvidence, accepted: readonly RecordKind[]): boolean {
  const bol = load.bol;
  const signedBol = Boolean(bol?.signed && bol.checkIn && bol.checkOut);
  return accepted.some((kind) => {
    if (kind === "signed_bol_times") return signedBol;
    if (kind === "status_214") return load.status214;
    return load.arrived !== null && load.released !== null;
  });
}

// True when the release pin came too long after (or before) the Released tap to confirm it.
export function releasePinLate(load: Pick<LoadEvidence, "released" | "releasePinAt">): boolean {
  const { released, releasePinAt } = load;
  if (!released || !releasePinAt) return false;
  return pinMissedWindow(released.at, releasePinAt);
}

// Paper against phone: the written in time against the arrival pin, the written out time against
// the release (the Released tap where one was recorded).
function bolConflicts(load: LoadEvidence): boolean {
  const { bol, arrived, released } = load;
  if (!bol || !arrived || !released) return false;
  const pairs: Array<[string | null, string]> = [
    [bol.checkIn, arrived.at],
    [bol.checkOut, released.at],
  ];
  return pairs.some(
    ([written, pinned]) =>
      written !== null && Math.abs(minutesBetween(pinned, written)) > BOL_TOLERANCE_MINUTES,
  );
}

function held(load: LoadEvidence, verdict: Evaluation["verdict"], reasons: ReasonCode[]): Evaluation {
  return {
    loadId: load.loadId,
    verdict,
    reasons,
    clockStartAt: null,
    detentionMinutes: 0,
    billableMinutes: 0,
    amountUsd: 0,
  };
}

// When the detention clock starts: free time counted from the appointment (if the truck was early)
// or from arrival. The notice timer and the verdict both use this, so they cannot disagree.
export function detentionStartsAt(clause: Pick<ClauseSpec, "freeTimeAnchor" | "freeTimeMinutes">, appointmentAt: string, arrivedAt: string): string {
  const clockStartAt = clause.freeTimeAnchor === "appointment" && Date.parse(arrivedAt) < Date.parse(appointmentAt) ? appointmentAt : arrivedAt;
  return addMinutes(clockStartAt, clause.freeTimeMinutes);
}

// Decides whether a detention claim is owed under one counterparty's clause. The model never
// reaches this function: its inputs are server timestamps, geofence results and structured fields.
export function evaluate(load: LoadEvidence, clause: ClauseSpec): Evaluation {
  const { arrived, released } = load;
  if (!arrived || !released) return held(load, "NEEDS_HUMAN", ["MISSING_TIMESTAMP"]);

  const integrity: ReasonCode[] = [];
  if (!arrived.insideGeofence || !released.insideGeofence) integrity.push("PIN_OUTSIDE_GEOFENCE");
  if (releasePinLate(load)) integrity.push("RELEASE_PIN_LATE");
  if (bolConflicts(load)) integrity.push("BOL_TIMESTAMP_CONFLICT");
  if (integrity.length > 0) return held(load, "NEEDS_HUMAN", integrity);

  const clockStartAt =
    clause.freeTimeAnchor === "appointment" && Date.parse(arrived.at) < Date.parse(load.appointmentAt)
      ? load.appointmentAt
      : arrived.at;
  const detentionStartAt = detentionStartsAt(clause, load.appointmentAt, arrived.at);
  const detentionMinutes = Math.max(0, minutesBetween(detentionStartAt, released.at));

  const denied: ReasonCode[] = [];
  const lateBy = minutesBetween(load.appointmentAt, arrived.at);
  if (clause.requireOnTimeArrival && lateBy > clause.onTimeGraceMinutes) denied.push("LATE_ARRIVAL");
  if (detentionMinutes <= 0) denied.push("WITHIN_FREE_TIME");
  if (clause.noticeLeadMinutes !== null && detentionMinutes > 0) {
    const deadline = addMinutes(detentionStartAt, -clause.noticeLeadMinutes);
    if (load.noticeSentAt === null) denied.push("NOTICE_MISSING");
    else if (Date.parse(load.noticeSentAt) > Date.parse(deadline)) denied.push("NOTICE_LATE");
  }
  if (!hasRecord(load, clause.acceptedRecords)) denied.push("NO_STATEMENT_OF_RECORD");
  if (minutesBetween(released.at, load.evaluatedAt) > clause.claimWindowHours * 60) {
    denied.push("CLAIM_WINDOW_EXPIRED");
  }

  const base = { loadId: load.loadId, clockStartAt, detentionMinutes };
  if (denied.length > 0) {
    return { ...base, verdict: "NOT_BILLABLE", reasons: denied, billableMinutes: 0, amountUsd: 0 };
  }
  if (clause.shipperConfirmationRequired && !load.shipperConfirmed) {
    return {
      ...base,
      verdict: "NEEDS_HUMAN",
      reasons: ["SHIPPER_CONFIRMATION_REQUIRED"],
      billableMinutes: 0,
      amountUsd: 0,
    };
  }

  const reasons: ReasonCode[] = [];
  // A daily cap limits each 24 hours of detention, not the whole stay.
  let billableMinutes = detentionMinutes;
  if (clause.capHoursPerDay !== null) {
    const perDay = clause.capHoursPerDay * 60;
    const fullDays = Math.floor(detentionMinutes / 1440);
    const capped = fullDays * Math.min(1440, perDay) + Math.min(detentionMinutes - fullDays * 1440, perDay);
    if (capped < detentionMinutes) {
      billableMinutes = capped;
      reasons.push("CAP_APPLIED");
    }
  }
  let amountUsd = (billableMinutes / 60) * clause.ratePerHourUsd;
  if (clause.capUsdPerOccurrence !== null && amountUsd > clause.capUsdPerOccurrence) {
    amountUsd = clause.capUsdPerOccurrence;
    if (!reasons.includes("CAP_APPLIED")) reasons.push("CAP_APPLIED");
  }
  return { ...base, verdict: "BILLABLE", reasons, billableMinutes, amountUsd: roundCents(amountUsd) };
}
