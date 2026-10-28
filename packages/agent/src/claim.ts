// The deterministic gate in front of the one tool that moves money. The agent supplies wording;
// everything that decides whether and how much is checked here against the signed, sealed pack.

export interface SealedClaimBasis {
  loadId: string;
  phase: string;
  verdict: string;
  amountCents: number;
  packDigest: string;
  packId: string;
  approvalId: string | null;
  alreadySentAt: string | null;
}

export interface ClaimRequest {
  loadId: string;
  // The agent's one- or two-sentence opening. Every other line of the email, the subject and the
  // PDF come from the sealed pack through the template in claim-email.ts.
  body: string;
  // Integer cents, so policy and code compare exact whole numbers.
  amountCents: number;
  packDigest: string;
  approvalId: string;
}

// The agent's opening must fit the template: one or two sentences, never a whole letter.
export const SUMMARY_MIN = 80;
export const SUMMARY_MAX = 600;

export type ClaimDecision = { ok: true } | { ok: false; reason: string };

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function toCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

// An AWS resource name, a phone number or an account id in the opening, written any way at all.
// The opening is read the way a person reads a number in it, whatever sits between its groups:
// - it is normalised to NFKC, every decimal digit of any script is read as its ASCII digit (٤١٦ and
//   ४१६ are 416), any other numeral left (❹, ⓸, 〇) counts as a digit too, and invisible characters
//   and combining marks are deleted;
// - "arn:" in any case is refused, and so is "arn" then up to three other characters then "aws"
//   (arn∶aws, arn :aws), unless an ASCII letter comes right before it (warn, barn);
// - the digits are read in runs. Only an ASCII word ends a run. Punctuation, spaces, symbols,
//   letters of other scripts (ǀ, ㅡ, 一) and a single ASCII letter set tight between two digits
//   (416x555x0143) all join it. Such an ASCII letter that looks like a digit (416-555-O143) counts
//   as one, and so does any letter of another script set tight between two digits, since many look
//   like a digit (416-555-О143 with a Cyrillic О, 416-555-Ο143 with a Greek Ο, 4І6 with a
//   Cyrillic І). So +1 (416) 555-0143, tel:416-555-0143, 416_555_0143, 416 - 555 - 0143,
//   4165550143,4165550199 and a list such as 416, 555, 0143 are each one run;
// - a run of 10 or more digits is refused unless every digit in it belongs to a known-safe token,
//   and no two of those tokens state the same thing, but for the load id or the amount said twice.
//   The tokens: an occurrence of the load id, the contract amount as the opening must state it
//   ($1234.56), money up to $99999.99 ($80.00, $1,234.56, $30, $60/h), a date (2026-10-23,
//   10/23/2026, October 23, 2026, 23 Oct 2026), a clock time with up to three fractional digits
//   (13:05, 13:05:00.123), a zone offset after a time (the -04:00 of 13:05:00-04:00), a time
//   range, which states one time (14:05–14:40, 2:05–2:40 PM, and after a date,
//   2026-10-27 14:05–14:40, which states a date and a time) and a duration (+15, +15 min,
//   +2 hours). So 2026-10-23 13:05 (a date and a time), $30.00 (14:05–14:40) (the amount and a
//   range), load PO-4471982: $80.00 (the load and the amount), load 4471982 (4471982) (the load
//   twice) and PO-123456789012 (the load alone) file, while 416-555-01:43 (a time beside a bare
//   group), 4:16 5:55 01:43 (three times), 4:16–5:55 01:43 (a range and a time),
//   0143 0143 0143 (the load three times) and $416 $555 $0143 (three sums) are refused;
// - no token holds 10 digits unless it holds a date, and a run with no date in it must hold fewer
//   than 10 digits besides the load id and the amount, so $41,655,501.43, 4:16:55.5-01:43 (a time
//   and a zone) and 12:34:56.789 +012 (a time and a duration) are refused too.
// A freight reference gets no exemption, labelled or not: PRO 1234567890, PO 4165550143 and order
// 111122223333 are refused, since a number that long can be a phone number or an account id
// whatever word comes before it. A reference of up to 9 digits passes like any short number. The
// opening the agent writes names the load, the facility and the amount, never a reference number.
// An occurrence of the load id inside a longer run is only one of its tokens: Account 999901439999
// on load 0143 still holds the bare groups 9999 and 9999, so it is refused.
const DIGIT = /^\p{Nd}$/u;
// Deleted before anything is read: format characters (zero-width joiners, direction marks,
// invisible operators), combining marks and the other default-ignorable characters (variation
// selectors, Hangul fillers), none of which a reader sees between two digits.
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]/gu;
type TokenKind = "load" | "amount" | "date" | "time" | "zone" | "range" | "dated range" | "duration" | "money";
// What each kind of token states. A run may state each of these once, so a time range, which is one
// statement of when, cannot sit beside another time.
const STATES: Record<TokenKind, readonly string[]> = {
  load: ["load"],
  amount: ["amount"],
  date: ["date"],
  time: ["time"],
  zone: ["zone"],
  range: ["time"],
  "dated range": ["date", "time"],
  duration: ["duration"],
  money: ["money"],
};
// The load id and the contract amount are exact values from the sealed pack, so saying one again
// adds no digit of the opening's own: load 4471982 (4471982) and $30.00 ($30.00) are each one
// statement. A third time is not a restatement.
const SAID_AGAIN = new Set(["load", "amount"]);
const ISO_DATE = String.raw`(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])`;
const US_DATE = String.raw`(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:\d{4}|\d{2})`;
// A month by name, whole or cut short (October, Oct, Oct., Sept), and a day of the month.
const MONTH = String.raw`(?<![A-Za-z])(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\.?`;
const DAY = String.raw`(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?`;
// One end of a time range: hours and minutes, and AM or PM. Seconds make it two times.
const RANGE_END = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d(?![:.]?\d)(?:\s?[AP]\.?M\.?)?`;
// A hyphen, an en or em dash, or a minus sign, with up to two spaces on each side.
const RANGE_DASH = String.raw`\s{0,2}[-\u2013\u2014\u2212]\s{0,2}`;
const SAFE: Array<[TokenKind, RegExp]> = (
  [
    ["date", String.raw`(?<!\d)${ISO_DATE}(?!\d)`],
    ["date", String.raw`(?<!\d)${US_DATE}(?!\d)`],
    // October 27, 2026, Oct 27 2026, Oct. 27, 2026 and 27 October 2026.
    ["date", String.raw`${MONTH}\s${DAY},?\s(?:19|20)\d\d(?!\d)`],
    ["date", String.raw`(?<!\d)${DAY}\s${MONTH},?\s(?:19|20)\d\d(?!\d)`],
    // A clock time, with seconds and up to three fractional digits, so at most 9 digits: more
    // digits are not a time. A zone offset right after one is a token of its own.
    ["time", String.raw`(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?!\d)`],
    ["duration", String.raw`\+\d{1,3} ?(?:minutes?|mins?|hours?|hrs?|h|m)(?![A-Za-z])`],
    ["duration", String.raw`\+\d{1,3}(?!\d)`],
    // No more than formatUsd writes ($99999.99) or one comma group ($99,999.99), so at most 8
    // digits; a run that goes on past them is not money.
    ["money", String.raw`\$ ?(?:\d{1,3}(?:,\d{3})?|\d{1,5})(?:\.\d{2})?(?![\d,.]\d)`],
    ["zone", String.raw`(?<=\d:[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?)[+-](?:0\d|1[0-4]):?[0-5]\d(?!\d)`],
    // A time range is one token, marked over the two times in it: 14:05-15:40, 14:05 - 14:40,
    // 14:05–14:40, 14:05−14:40 and 2:05–2:40 PM. So is a range after a date, with the date said
    // again or not (2026-10-27 14:05–14:40, 2026-10-27 14:05–2026-10-27 14:40); a second date that
    // differs is a second date.
    ["range", String.raw`(?<!\d[:.]?)${RANGE_END}${RANGE_DASH}${RANGE_END}`],
    ["dated range", String.raw`(?<!\d)(?<day>${ISO_DATE}|${US_DATE})[T ]${RANGE_END}${RANGE_DASH}(?:\k<day>[T ])?${RANGE_END}`],
  ] as const
).map(([kind, source]) => [kind, new RegExp(source, "giu")]);
const ARN = /(?<![A-Za-z])arn(?::|[^A-Za-z\d]{1,3}aws(?![A-Za-z]))/giu;

// The ASCII digit for a decimal digit of any script. Unicode encodes each script's digits as one
// run of 0 to 9 (some runs hold several sets of ten), so the digit is its distance from the run's
// start, mod 10.
function asciiDigit(char: string): string {
  const point = char.codePointAt(0)!;
  let zero = point;
  while (DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
  return String((point - zero) % 10);
}

// The opening as it is read: ASCII digits for every numeral (its value does not matter, only that
// it is a digit), with nothing invisible left.
function readable(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Nd}/gu, asciiDigit)
    .replace(/[\p{No}\p{Nl}]/gu, "0")
    .replace(INVISIBLE, "");
}

function occurrences(body: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = body.indexOf(needle); needle && at !== -1; at = body.indexOf(needle, at + 1)) out.push([at, at + needle.length]);
  return out;
}

function leaks(opening: string, id: string, amount: string): boolean {
  const body = readable(opening);
  const named = occurrences(body, readable(id));
  const inName = (start: number, end: number) => named.some(([from, to]) => from <= start && end <= to);
  for (const match of body.matchAll(ARN)) if (!inName(match.index, match.index + match[0].length)) return true;
  // The safe token each character belongs to, if any. The load id and the amount are marked last,
  // so money or a date inside them counts as part of them.
  const tokens: TokenKind[] = [];
  const owner = new Int32Array(body.length).fill(-1);
  const mark = (kind: TokenKind, from: number, to: number) => owner.fill(tokens.push(kind) - 1, from, to);
  for (const [kind, re] of SAFE) for (const m of body.matchAll(re)) mark(kind, m.index, m.index + m[0].length);
  for (const [from, to] of occurrences(body, readable(amount))) mark("amount", from, to);
  for (const [from, to] of named) mark("load", from, to);
  // The digits and the letters, in order; everything else joins the digits around it. A letter of
  // another script (other) never ends a run, and the ASCII letters and digits around it are read as
  // if it were not there.
  const kept: Array<{ at: number; digit: boolean; other: boolean }> = [];
  for (const m of body.matchAll(/(\d)|([A-Za-z])|\p{L}/gu)) kept.push({ at: m.index, digit: m[1] !== undefined, other: !m[1] && !m[2] });
  const near = (i: number, step: 1 | -1) => {
    for (let j = i + step; j >= 0 && j < kept.length; j += step) if (!kept[j]!.other) return kept[j];
    return undefined;
  };
  const refused = (run: number[]) => {
    if (run.length < 10) return false;
    const owners = new Set(run.map((at) => owner[at]!));
    if (owners.has(-1)) return true;
    const times = new Map<string, number>();
    for (const t of owners) for (const what of STATES[tokens[t]!]) times.set(what, (times.get(what) ?? 0) + 1);
    if ([...times].some(([what, n]) => n > (SAID_AGAIN.has(what) ? 2 : 1))) return true;
    // Without a date, the tokens of different kinds beside each other still hold no 10 digits of
    // the opening's own: 12:34:56.789 +012 is a time and a duration, and reads as an account id.
    if (times.has("date")) return false;
    return run.filter((at) => !SAID_AGAIN.has(tokens[owner[at]!]!)).length >= 10;
  };
  let run: number[] = [];
  for (let i = 0; i < kept.length; i++) {
    const { at, digit, other } = kept[i]!;
    if (digit) {
      run.push(at);
      continue;
    }
    // A single letter set tight between two digits, with no space on either side (416x555x0143,
    // 416-555-O143, the T of 2026-10-23T13:05), joins them, and one that looks like a digit (O, o,
    // I, l) counts as one. A word, or a letter set off by a space (2 h 13 m), ends the run. A
    // letter of another script set tight between two digits counts as a digit whatever it looks
    // like (416-555-О143 with a Cyrillic О, 4І6 with a Cyrillic І); set anywhere else it joins.
    const before = near(i, -1);
    const after = near(i, 1);
    const tight = before?.digit && after?.digit && !/\s/.test(body.slice(before.at + 1, after.at));
    if (other) {
      if (tight) run.push(at);
      continue;
    }
    if (tight) {
      if (/[OoIl]/.test(body[at]!)) run.push(at);
      continue;
    }
    if (refused(run)) return true;
    run = [];
  }
  return refused(run);
}

export function checkClaim(request: ClaimRequest, basis: SealedClaimBasis): ClaimDecision {
  const refuse = (reason: string): ClaimDecision => ({ ok: false, reason });
  if (request.loadId !== basis.loadId) return refuse("load id does not match the sealed load");
  if (basis.phase !== "sealed") return refuse("the load's evidence is not sealed yet");
  if (basis.verdict !== "BILLABLE") return refuse(`the clause engine's verdict is ${basis.verdict}, not BILLABLE`);
  if (basis.alreadySentAt) return refuse(`a claim for this load was already sent at ${basis.alreadySentAt}`);
  if (!basis.approvalId || request.approvalId !== basis.approvalId) return refuse("dispatch has not approved this claim");
  if (request.packDigest !== basis.packDigest) return refuse("evidence pack digest does not match the sealed pack");
  const amount = formatUsd(basis.amountCents / 100);
  if (!Number.isInteger(request.amountCents) || request.amountCents !== basis.amountCents) {
    return refuse(`amount ${request.amountCents} cents differs from the contract amount ${basis.amountCents} cents (${amount})`);
  }
  if (!request.body.includes(amount)) return refuse(`the email must state the contract amount ${amount}`);
  if (!request.body.includes(basis.loadId)) return refuse("the email must name the load id");
  // The cheap length check first, so an over-long opening is never normalised and scanned.
  if (request.body.length < SUMMARY_MIN || request.body.length > SUMMARY_MAX) return refuse(`the opening must be ${SUMMARY_MIN}-${SUMMARY_MAX} characters (one or two sentences)`);
  if (leaks(request.body, basis.loadId, amount)) return refuse("the opening may not hold an AWS resource name, account id or phone number");
  return { ok: true };
}
