export type RecordKind = "signed_bol_times" | "status_214" | "app_gps";

export interface SourceRef {
  label: string;
  url: string;
  fetched: string;
}

export interface ClauseSpec {
  id: string;
  counterparty: string;
  role: "shipper" | "broker";
  modelledOn: SourceRef;
  assumptions: string[];
  freeTimeMinutes: number;
  freeTimeAnchor: "appointment" | "arrival";
  requireOnTimeArrival: boolean;
  onTimeGraceMinutes: number;
  ratePerHourUsd: number;
  capUsdPerOccurrence: number | null;
  capHoursPerDay: number | null;
  noticeLeadMinutes: number | null;
  acceptedRecords: RecordKind[];
  claimWindowHours: number;
  shipperConfirmationRequired: boolean;
}

export interface Pin {
  at: string;
  insideGeofence: boolean;
}

export interface BolReading {
  signed: boolean;
  checkIn: string | null;
  checkOut: string | null;
}

export interface LoadEvidence {
  loadId: string;
  clauseId: string;
  facility: string;
  appointmentAt: string;
  arrived: Pin | null;
  released: Pin | null;
  bol: BolReading | null;
  status214: boolean;
  noticeSentAt: string | null;
  shipperConfirmed: boolean;
  evaluatedAt: string;
}

export type Verdict = "BILLABLE" | "NOT_BILLABLE" | "NEEDS_HUMAN";

export type ReasonCode =
  | "MISSING_TIMESTAMP"
  | "PIN_OUTSIDE_GEOFENCE"
  | "BOL_TIMESTAMP_CONFLICT"
  | "LATE_ARRIVAL"
  | "WITHIN_FREE_TIME"
  | "NOTICE_MISSING"
  | "NOTICE_LATE"
  | "NO_STATEMENT_OF_RECORD"
  | "CLAIM_WINDOW_EXPIRED"
  | "SHIPPER_CONFIRMATION_REQUIRED"
  | "CAP_APPLIED";

export interface Evaluation {
  loadId: string;
  verdict: Verdict;
  reasons: ReasonCode[];
  clockStartAt: string | null;
  detentionMinutes: number;
  billableMinutes: number;
  amountUsd: number;
}
