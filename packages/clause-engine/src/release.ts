// What stopped the dock clock: the driver's Released tap when one was recorded, else the release
// location pin (records from before the tap was kept, and the scored fixtures). Sealing, the claim,
// the console API and the site all read the release time here, so they cannot disagree.

// The release location pin confirms the driver's Released tap only if it comes within this many
// minutes of the tap. The clock stops at the tap either way; a later pin sends the load to a person.
export const RELEASE_PIN_WINDOW_MINUTES = 10;

export type ClockEndBy = "released_tap" | "released_pin";

export interface ClockEnd {
  by: ClockEndBy;
  at: string;
}

// Any record with the two events: a load item, an evidence pack's events, an untyped stored item.
export interface ReleaseEvents {
  releasedTap?: unknown;
  released?: unknown;
}

function serverAt(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const at = (event as { serverAt?: unknown }).serverAt;
  return typeof at === "string" && at !== "" ? at : null;
}

export function clockEndOf(record: ReleaseEvents | null | undefined): ClockEnd | null {
  if (!record) return null;
  const tap = serverAt(record.releasedTap);
  if (tap) return { by: "released_tap", at: tap };
  const pin = serverAt(record.released);
  return pin ? { by: "released_pin", at: pin } : null;
}

export function releaseTimeOf(record: ReleaseEvents | null | undefined): string | null {
  return clockEndOf(record)?.at ?? null;
}

// Signed minutes from the Released tap to the release pin (negative: the pin came first).
export function releasePinGapMinutes(tapAt: string, pinAt: string): number {
  return (Date.parse(pinAt) - Date.parse(tapAt)) / 60_000;
}

// True when the release pin came close enough to the Released tap to confirm it.
export function pinConfirmsTap(tapAt: string, pinAt: string): boolean {
  return Math.abs(releasePinGapMinutes(tapAt, pinAt)) <= RELEASE_PIN_WINDOW_MINUTES;
}

// How far the release pin was from the Released tap, in whole minutes, and on which side: "12 min
// after", "15 min before". A pin outside the window never rounds down to the limit: 10.4 minutes
// reads "10.4 min", so the words cannot show a failed pin as within it.
export function releasePinGapWords(tapAt: string, pinAt: string): string {
  const gap = releasePinGapMinutes(tapAt, pinAt);
  const size = Math.abs(gap);
  const rounded = Math.round(size);
  const shown = size > RELEASE_PIN_WINDOW_MINUTES && rounded <= RELEASE_PIN_WINDOW_MINUTES ? Math.ceil(size * 10) / 10 : rounded;
  return `${shown} min ${gap < 0 ? "before" : "after"}`;
}

// True when the release pin came too long after (or before) the Released tap: RELEASE_PIN_LATE.
// Only a gap that can be measured is late, so a time that does not parse never sends the load to a
// person. The engine, the console API and the site all decide "late" here, so they cannot disagree.
export function pinMissedWindow(tapAt: string, pinAt: string): boolean {
  return Math.abs(releasePinGapMinutes(tapAt, pinAt)) > RELEASE_PIN_WINDOW_MINUTES;
}
