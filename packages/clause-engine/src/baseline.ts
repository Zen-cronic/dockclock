import type { LoadEvidence } from "./types.js";

export const BASELINE_FREE_MINUTES = 120;
export const BASELINE_RATE_PER_HOUR_USD = 50;

export interface BaselineClaim {
  loadId: string;
  filed: boolean;
  amountUsd: number;
}

// The industry's default: bill every stop whose dwell exceeds two hours. ATRI (2024) found 67% of
// carriers that charge detention start at the two-hour mark; $50/h is ATRI's truckload median.
export function baselineClaim(load: LoadEvidence): BaselineClaim {
  if (!load.arrived || !load.released) return { loadId: load.loadId, filed: false, amountUsd: 0 };
  const dwell = (Date.parse(load.released.at) - Date.parse(load.arrived.at)) / 60_000;
  const over = dwell - BASELINE_FREE_MINUTES;
  // A time that does not parse gives no dwell to bill (NaN is not <= 0).
  if (!Number.isFinite(over) || over <= 0) return { loadId: load.loadId, filed: false, amountUsd: 0 };
  const amountUsd = Math.round(((over / 60) * BASELINE_RATE_PER_HOUR_USD) * 100) / 100;
  return { loadId: load.loadId, filed: true, amountUsd };
}
