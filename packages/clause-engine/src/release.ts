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

// Shown for a stored time that does not parse, so a page or a message never throws on one record.
export const UNREADABLE_CLOCK = "--:--";

// Whether a stored time can be used at all: a string Date.parse reads.
export function timeReadable(at: unknown): at is string {
  return typeof at === "string" && Number.isFinite(Date.parse(at));
}

// The time `ms` later (earlier when negative), or null when the stored time does not parse: date
// arithmetic on an unreadable time would throw a RangeError on toISOString().
export function shiftTime(at: unknown, ms: number): string | null {
  if (!timeReadable(at)) return null;
  const shifted = new Date(Date.parse(at) + ms);
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString() : null;
}

// How the release pin stands against the Released tap: "confirmed" within the window (either
// side), "late" outside it, "unreadable" when either time does not parse. An unreadable time is
// never read as confirmed or as late: the engine sends the load to a person (TIMESTAMP_UNREADABLE).
// The engine, the evidence pack's signals, the console API and the site all decide here, so they
// cannot disagree.
export type ReleasePinCheck = "confirmed" | "late" | "unreadable";

export function releasePinCheck(tapAt: string, pinAt: string): ReleasePinCheck {
  if (!timeReadable(tapAt) || !timeReadable(pinAt)) return "unreadable";
  return Math.abs(releasePinGapMinutes(tapAt, pinAt)) <= RELEASE_PIN_WINDOW_MINUTES ? "confirmed" : "late";
}

// How far the release pin was from the Released tap, in whole minutes, and on which side: "12 min
// after", "15 min before". A pin outside the window never rounds down to the limit: 10.4 minutes
// reads "10.4 min", so the words cannot show a failed pin as within it. Only for readable times
// (releasePinCheck is not "unreadable"); otherwise it says the gap is unknown, never "NaN".
export function releasePinGapWords(tapAt: string, pinAt: string): string {
  const gap = releasePinGapMinutes(tapAt, pinAt);
  if (!Number.isFinite(gap)) return "an unknown time from";
  const size = Math.abs(gap);
  const rounded = Math.round(size);
  const shown = size > RELEASE_PIN_WINDOW_MINUTES && rounded <= RELEASE_PIN_WINDOW_MINUTES ? Math.ceil(size * 10) / 10 : rounded;
  return `${shown} min ${gap < 0 ? "before" : "after"}`;
}
