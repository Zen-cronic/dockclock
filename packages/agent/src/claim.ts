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
// - known-safe tokens are blanked with letters: money ($80.00, $1,234.56, $30, $60/h: up to three
//   digits, at most two comma groups and cents, with no digit group joined on either side, so
//   $416-555-0143 and $4,165,550,143 are not money), dates (2026-10-23, 10/23/2026), clock times
//   with up to three fractional digits (13:05, 1:05 PM, 13:05:00.123) and durations (+15, +15 min,
//   +2 hours, none joined to a digit group before it);
// - then every character that is not a letter or a digit is removed, and any remaining run of 10 or
//   more digits is refused. A letter ends a run; anything else joins it, so +1 (416) 555-0143,
//   tel:416-555-0143, 416_555_0143, 416 - 555 - 0143, 4165550143,4165550199 and even a list such
//   as 416, 555, 0143 are each one run.
// A freight reference gets no exemption, labelled or not: PRO 1234567890, PO 4165550143 and order
// 111122223333 are refused, since a number that long can be a phone number or an account id
// whatever word comes before it. A reference of up to 9 digits passes like any short number. The
// opening the agent writes names the load, the facility and the amount, never a reference number.
// A run that lies wholly inside an occurrence of the load id is allowed (PO-123456789012 is not an
// account id); one that only overlaps it (Account 999901439999 on load 0143) still counts.
const DIGIT = /^\p{Nd}$/u;
// Deleted before anything is read: format characters (zero-width joiners, direction marks,
// invisible operators), combining marks and the other default-ignorable characters (variation
// selectors, Hangul fillers), none of which a reader sees between two digits.
const INVISIBLE = /[\p{Cf}\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]/gu;
// Removed before runs are read: everything but a letter or a digit. A modifier letter (ʹ, ˈ, ー)
// reads as punctuation between digits, so it joins a run too.
const JOINS = /[^\p{L}\d]|\p{Lm}/u;
// Nothing but separators between a token and a digit: the token continues a digit group.
const AFTER_DIGIT = String.raw`(?<!\d[^\p{L}\d]*)`;
const BEFORE_DIGIT = String.raw`(?![^\p{L}\d]*\d)`;
const SAFE = [
  String.raw`(?<!\d)(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)`,
  String.raw`(?<!\d)(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:\d{4}|\d{2})(?!\d)`,
  // A clock time, with seconds and up to three fractional digits: more digits are not a time.
  String.raw`(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?!\d)`,
  // A duration with its unit, or a bare +N that no digit group follows (+1 416-555-0143 is a phone).
  String.raw`${AFTER_DIGIT}\+\d{1,3} ?(?:minutes?|mins?|hours?|hrs?|h|m)(?!\p{L})`,
  String.raw`${AFTER_DIGIT}\+\d{1,3}${BEFORE_DIGIT}`,
  // Money last, so a date or time beside it is already blanked and does not count as a digit group.
  String.raw`${AFTER_DIGIT}\$ ?\d{1,3}(?:,\d{3}){0,2}(?:\.\d{2})?${BEFORE_DIGIT}`,
].map((source) => new RegExp(source, "giu"));
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

function readable(text: string): string {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, asciiDigit).replace(INVISIBLE, "");
}

function leaks(opening: string, id: string): boolean {
  const body = readable(opening);
  const loadId = readable(id);
  const named: Array<[number, number]> = [];
  for (let at = body.indexOf(loadId); loadId && at !== -1; at = body.indexOf(loadId, at + 1)) named.push([at, at + loadId.length]);
  const inName = (start: number, end: number) => named.some(([from, to]) => from <= start && end <= to);
  for (const match of body.matchAll(ARN)) if (!inName(match.index, match.index + match[0].length)) return true;
  // Blanked with a letter of the same length, so a safe token ends a run and positions still
  // line up with the load id's occurrences.
  let left = body;
  for (const re of SAFE) left = left.replace(re, (match) => "x".repeat(match.length));
  // The letters and digits alone, each with its position in the opening.
  let kept = "";
  const from: number[] = [];
  for (let at = 0; at < left.length; ) {
    const char = String.fromCodePoint(left.codePointAt(at)!);
    if (!JOINS.test(char)) {
      kept += char;
      for (let i = 0; i < char.length; i++) from.push(at);
    }
    at += char.length;
  }
  for (const match of kept.matchAll(/\d{10,}/g)) {
    if (!inName(from[match.index]!, from[match.index + match[0].length - 1]! + 1)) return true;
  }
  return false;
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
  if (leaks(request.body, basis.loadId)) return refuse("the opening may not hold an AWS resource name, account id or phone number");
  return { ok: true };
}
