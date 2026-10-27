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
//   ४१६ are 416), and invisible characters and combining marks are deleted;
// - "arn:" in any case is refused;
// - the digits are read in runs. A letter ends a run; anything else joins it, so +1 (416) 555-0143,
//   tel:416-555-0143, 416_555_0143, 416 - 555 - 0143, 4165550143,4165550199 and even a list such
//   as 416, 555, 0143 are each one run. A modifier letter (ʹ, ˈ, ー) reads as punctuation between
//   digits, so it joins a run too;
// - a run of 10 or more digits is refused unless every digit in it belongs to a known-safe token,
//   and no two of those tokens are of the same kind. The tokens: an occurrence of the load id, the
//   contract amount as the opening must state it ($1234.56), money ($80.00, $1,234.56, $30, $60/h),
//   a date (2026-10-23, 10/23/2026), a clock time with up to three fractional digits and a zone
//   offset (13:05, 13:05:00.123-04:00) and a duration (+15, +15 min, +2 hours). So
//   2026-10-23 13:05 (a date and a time), load PO-4471982: $80.00 (the load and the amount) and
//   PO-123456789012 (the load alone) file, while 416-555-01:43 (a time beside a bare group),
//   4:16 5:55 01:43 (three times) and $416 $555 $0143 (three sums) are refused.
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
type TokenKind = "load" | "amount" | "date" | "time" | "duration" | "money";
const SAFE: Array<[TokenKind, RegExp]> = (
  [
    ["date", String.raw`(?<!\d)(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)`],
    ["date", String.raw`(?<!\d)(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:\d{4}|\d{2})(?!\d)`],
    // A clock time, with seconds, up to three fractional digits and a zone offset: more digits are
    // not a time. 14:30-14:35 reads as one time with an offset, which is one token either way.
    ["time", String.raw`(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:[+-](?:0\d|1[0-4]):?[0-5]\d)?(?!\d)`],
    ["duration", String.raw`\+\d{1,3} ?(?:minutes?|mins?|hours?|hrs?|h|m)(?![A-Za-z])`],
    ["duration", String.raw`\+\d{1,3}(?!\d)`],
    // Up to seven digits, or comma groups, and cents; a run that goes on past them is not money.
    ["money", String.raw`\$ ?(?:\d{1,3}(?:,\d{3}){1,2}|\d{1,7})(?:\.\d{2})?(?![\d,.]\d)`],
  ] as const
).map(([kind, source]) => [kind, new RegExp(source, "giu")]);
const ARN = /(?<![\p{L}\d])arn:/giu;

// The ASCII digit for a decimal digit of any script. Unicode encodes each script's digits as one
// run of 0 to 9 (some runs hold several sets of ten), so the digit is its distance from the run's
// start, mod 10.
function asciiDigit(char: string): string {
  const point = char.codePointAt(0)!;
  let zero = point;
  while (DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
  return String((point - zero) % 10);
}

// The opening as it is read: ASCII digits for every decimal digit, with nothing invisible left.
function readable(text: string): string {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, asciiDigit).replace(INVISIBLE, "");
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
  // The digits and the letters, in order; everything else joins the digits around it.
  const kept: Array<{ at: number; digit: boolean }> = [];
  for (let at = 0; at < body.length; ) {
    const char = String.fromCodePoint(body.codePointAt(at)!);
    if (/\d/.test(char)) kept.push({ at, digit: true });
    else if (/\p{L}/u.test(char) && !/\p{Lm}/u.test(char)) kept.push({ at, digit: false });
    at += char.length;
  }
  const refused = (run: number[]) => {
    if (run.length < 10) return false;
    const owners = new Set(run.map((at) => owner[at]!));
    if (owners.has(-1)) return true;
    const kinds = [...owners].map((t) => tokens[t]!);
    return new Set(kinds).size !== kinds.length;
  };
  let run: number[] = [];
  for (const { at, digit } of kept) {
    if (digit) {
      run.push(at);
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
