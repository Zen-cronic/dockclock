// Every time on the page is shown in the facility's time zone, with the zone named.

export function clock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function clockSeconds(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

export function zoneName(iso: string, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(new Date(iso)).find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

export function dateLong(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
}

export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// 218 -> "3 h 38 min"; 45 -> "45 min".
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

// 218 -> "3:38"
export function hmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

export function minutesBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 60_000;
}

// "Judge demo yard (any location counts)" -> "Judge demo yard"; "Lakeshore DC, Columbus OH" -> "Lakeshore DC".
export function placeName(facility: string): string {
  return facility.split(/[,(]/)[0]!.trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// "Oct 23" in the facility's zone.
export function dayShort(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(new Date(iso));
}

// The time alone when it falls on the same local day as `ref`, else "Oct 23, 3:31 AM".
export function clockOn(iso: string, timeZone: string, ref: string): string {
  return dayShort(iso, timeZone) === dayShort(ref, timeZone) ? clock(iso, timeZone) : `${dayShort(iso, timeZone)}, ${clock(iso, timeZone)}`;
}

// A day-separator label: "Today" for the viewer's current local day in that zone, else "Oct 22".
export function dayLabel(iso: string, timeZone: string, now: string = new Date().toISOString()): string {
  const day = dayShort(iso, timeZone);
  return day === dayShort(now, timeZone) ? "Today" : day;
}
