// One canonical form for every phone number DockClock compares: "+" and digits only. Dispatch,
// the allowlist and inbound senders all pass through here, so formatting never splits a driver.
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!trimmed.startsWith("+") && digits.length === 10) digits = `1${digits}`;
  // WhatsApp still reports Mexican mobiles with the retired "1" after the country code.
  if (digits.length === 13 && digits.startsWith("521")) digits = `52${digits.slice(3)}`;
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}
