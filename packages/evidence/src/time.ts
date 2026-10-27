// Paperwork times are written as wall-clock "HH:MM" at the facility. These helpers pin them to an
// exact instant using the date of the nearest server-timestamped pin, so the clause engine can
// compare them with WhatsApp's own timestamps.

// 24-hour "13:52", "1352", "13h52", "13:52:00", and 12-hour "1:52 PM", "5:18pm", "1:52 p.m.".
const CLOCK = /^(\d{1,2})[:.h]?([0-5]\d)(?::[0-5]\d)?(a|p|am|pm|a\.m\.|p\.m\.)?$/;

export function parseClock(value: string | null): { hour: number; minute: number } | null {
  if (!value) return null;
  const match = CLOCK.exec(value.trim().toLowerCase().replace(/\s+/g, ""));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.[0];
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "a" && hour === 12) hour = 0;
    if (meridiem === "p" && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

// The canonical "HH:MM" of a clock string, used to tell whether a driver changed a pre-filled time.
export function normalizeClock(value: string | null): string | null {
  const parsed = parseClock(value);
  return parsed ? `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}` : null;
}

// Shown for a stored time that does not parse, so a page or a message never throws on one record.
export const UNREADABLE_CLOCK = "--:--";

const readable = (iso: string) => Number.isFinite(Date.parse(iso));

function zoneParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

// Null when the clock does not parse, or when the pin it is pinned to does not (there is then no
// date to give it; the engine holds the load on that pin).
export function localClockToIso(clock: string | null, nearIso: string, timeZone: string): string | null {
  const parsed = parseClock(clock);
  if (!parsed || !readable(nearIso)) return null;
  const near = new Date(nearIso);
  const day = zoneParts(near, timeZone);
  const candidates = [-1, 0, 1].map((shift) => {
    const guess = Date.UTC(day.year, day.month - 1, day.day + shift, parsed.hour, parsed.minute);
    const first = guess - offsetMs(new Date(guess), timeZone);
    return first - (offsetMs(new Date(first), timeZone) - offsetMs(new Date(guess), timeZone));
  });
  // The paperwork time closest to the pin wins, which handles waits that cross midnight.
  const best = candidates.reduce((a, b) => (Math.abs(b - near.getTime()) < Math.abs(a - near.getTime()) ? b : a));
  return new Date(best).toISOString();
}

// The zone's short name at that instant (EDT, CST), so a clock time shown to someone who may be
// elsewhere says which zone it is in. The zone's own name for a time that does not parse.
export function zoneAbbreviation(iso: string, timeZone: string): string {
  if (!readable(iso)) return timeZone;
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

// A complete local date and time with its zone ("2026-10-18 20:59 EDT"), so nobody has to pair a
// local clock time with a UTC date (which differ after 20:00 Eastern).
export function isoToLocalDateTime(iso: string, timeZone: string): string {
  if (!readable(iso)) return `${UNREADABLE_CLOCK} (time not readable)`;
  const p = zoneParts(new Date(iso), timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} ${zoneAbbreviation(iso, timeZone)}`;
}

// The local "HH:MM", or null when the time does not parse. For logic: a pre-filled value to compare
// a driver's entry with, a hint sent to a form, a time to compare a reading with.
export function localClockOf(iso: string, timeZone: string): string | null {
  if (!readable(iso)) return null;
  const p = zoneParts(new Date(iso), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

// The local "HH:MM" for a person to read, with UNREADABLE_CLOCK for a time that does not parse.
// Never compared or sent as a value: localClockOf is for that.
export function isoToLocalClock(iso: string, timeZone: string): string {
  return localClockOf(iso, timeZone) ?? UNREADABLE_CLOCK;
}
