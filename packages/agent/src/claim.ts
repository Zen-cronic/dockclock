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

// An AWS resource name, a phone number or an account id in the opening, written any common way.
// Known-safe tokens are taken out first, then anything left that could be one is refused:
// - safe: money ($80.00, $1,234.56), dates (2026-10-23, 10/23/2026), clock times (13:05, 1:05 PM,
//   13:05:00.123) and durations (+15, +15 min, +2 hours);
// - refused: "arn:" in any case, and any remaining run of 10 or more digits, however its groups are
//   joined: any run of separators between two digit groups joins them (any Unicode space, a tab or
//   a line break, dots, dashes, slashes, brackets, a comma with no space after it), so +1 (416)
//   555-0143, tel:416-555-0143, 416 - 555 - 0143, 1111.2222.3333 and 4165550143,4165550199 are each
//   one run. A comma followed by a space ends a run, as in a list.
// A freight reference gets no exemption, labelled or not: PRO 1234567890, PO 4165550143 and order
// 111122223333 are refused, since a number that long can be a phone number or an account id
// whatever word comes before it. A reference of up to 9 digits passes like any short number. The
// opening the agent writes names the load, the facility and the amount, never a reference number.
// A safe token is blanked, never deleted, so the digits on either side of it are not joined. A run
// that lies wholly inside an occurrence of the load id is allowed (PO-123456789012 is not an account
// id); one that only overlaps it (Account 999901439999 on load 0143) still counts. The check reads
// the opening in NFKC form, so full-width or styled digits count as digits.
const SEPARATOR = String.raw`[\s.\-/()\[\]\u00ad\u00b7\u200b-\u200d\u2010-\u2015\u2022\u2027\u2060\u2212\u2219\ufe58\ufe63\uff0d]`;
const JOIN = String.raw`(?:${SEPARATOR}|,(?=\d))+`;
const SAFE = [
  // Money: $80, $80.00, $1,234.56. A run that continues past the cents or the groups is not money.
  String.raw`\$ ?(?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?(?!,?\d|\.\d)`,
  String.raw`(?<!\d)(?:19|20)\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?!\d)`,
  String.raw`(?<!\d)(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:\d{4}|\d{2})(?!\d)`,
  // A clock time, with seconds and up to three fractional digits: more digits are not a time.
  String.raw`(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?!\d)`,
].map((source) => new RegExp(source, "g"));
// A duration with its unit, or a bare +N that no further digits follow (+1 416-555-0143 is a phone).
const DURATION = new RegExp(String.raw`\+\d{1,3} ?(?:minutes?|mins?|hours?|hrs?|h|m)(?![A-Za-z])|\+\d{1,3}(?!\d|${JOIN}\d)`, "gi");
const RUN = new RegExp(String.raw`\d(?:(?:${JOIN})?\d)*`, "g");
const ARN = /(?<![A-Za-z0-9])arn:/gi;

function blank(text: string, re: RegExp): string {
  return text.replace(re, (match) => "_".repeat(match.length));
}

function leaks(opening: string, id: string): boolean {
  const body = opening.normalize("NFKC");
  const loadId = id.normalize("NFKC");
  const named: Array<[number, number]> = [];
  for (let at = body.indexOf(loadId); loadId && at !== -1; at = body.indexOf(loadId, at + 1)) named.push([at, at + loadId.length]);
  const inName = (start: number, end: number) => named.some(([from, to]) => from <= start && end <= to);
  let left = body;
  for (const re of SAFE) left = blank(left, re);
  left = blank(left, DURATION);
  for (const match of left.matchAll(ARN)) if (!inName(match.index, match.index + match[0].length)) return true;
  for (const match of left.matchAll(RUN)) {
    if (match[0].replace(/\D/g, "").length < 10) continue;
    if (!inName(match.index, match.index + match[0].length)) return true;
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
  if (leaks(request.body, basis.loadId)) return refuse("the opening may not hold an AWS resource name, account id or phone number");
  if (request.body.length < SUMMARY_MIN || request.body.length > SUMMARY_MAX) return refuse(`the opening must be ${SUMMARY_MIN}-${SUMMARY_MAX} characters (one or two sentences)`);
  return { ok: true };
}
