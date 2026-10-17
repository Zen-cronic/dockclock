// Paperwork times are written as wall-clock "HH:MM" at the facility. These helpers pin them to an
// exact instant using the date of the nearest server-timestamped pin, so the clause engine can
// compare them with WhatsApp's own timestamps.

const HHMM = /^([01]?\d|2[0-3])[:.h ]?([0-5]\d)$/i;

export function parseClock(value: string | null): { hour: number; minute: number } | null {
  if (!value) return null;
  const match = HHMM.exec(value.trim().replace(/\s+/g, ""));
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

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

export function localClockToIso(clock: string | null, nearIso: string, timeZone: string): string | null {
  const parsed = parseClock(clock);
  if (!parsed) return null;
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

export function isoToLocalClock(iso: string, timeZone: string): string {
  const p = zoneParts(new Date(iso), timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
