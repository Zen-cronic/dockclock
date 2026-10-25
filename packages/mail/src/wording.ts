// Where a pin's time came from, worded so an email never claims more than the record shows: a test
// load's pins are synthetic (no platform server time), the judge demo yard accepts any location (no
// geofence claim), and "inside the geofence" is said only when the pin was checked and was inside.

export interface PinSourceInput {
  synthetic: boolean;
  channel: "whatsapp" | "rcs";
  // The facility accepts any location (the judge demo yard).
  anyLocation: boolean;
  // The geofence check on the pin(s): null when not checked.
  insideGeofence: boolean | null;
  pins: 1 | 2;
  // Set when the dock clock stopped at the driver's Released tap: the channel the tap came on.
  releasedTap?: { channel: "whatsapp" | "rcs" } | null;
}

const CHANNEL_NAME = { whatsapp: "WhatsApp", rcs: "RCS" } as const;

export function pinSource(input: PinSourceInput): string {
  const noun = input.pins === 1 ? "pin" : "pins";
  const tap = input.releasedTap ?? null;
  const demoYard = input.anyLocation ? "; the demo yard accepts any location" : "";
  if (input.synthetic) return `Synthetic test ${noun}${tap ? " and Released tap" : ""} (test load)${demoYard}`;
  const channels = [...new Set([input.channel, ...(tap ? [tap.channel] : [])])].map((c) => CHANNEL_NAME[c]);
  const clock = `${channels.join(" and ")} server time`;
  const andTap = tap ? " and the Released tap" : "";
  if (input.anyLocation) return `Location ${noun}${andTap} recorded with ${clock}${demoYard}`;
  return input.insideGeofence ? `Location ${noun} inside the facility's geofence${andTap}, ${clock}` : `Location ${noun}${andTap} recorded with ${clock}`;
}

// The clause's notice rule in words: null means the clause requires no notice.
export function noticeTerms(noticeLeadMinutes: number | null): string {
  if (noticeLeadMinutes === null) return "Not required";
  if (noticeLeadMinutes === 0) return "Before free time ends";
  return `${noticeLeadMinutes} minutes before free time ends`;
}

// Minutes in formal copy: whole minutes without decimals ("3 minutes", "1 minute"), and minutes
// and seconds when there is a fraction ("90 minutes 59 seconds"). Amounts never come from this.
export function minutesText(minutes: number): string {
  const totalSeconds = Math.round(minutes * 60);
  const whole = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const m = `${whole} minute${whole === 1 ? "" : "s"}`;
  if (seconds === 0) return m;
  const s = `${seconds} second${seconds === 1 ? "" : "s"}`;
  return whole === 0 ? s : `${m} ${s}`;
}
