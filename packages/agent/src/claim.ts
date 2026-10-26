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

// An AWS resource name, a phone number or an account id in the opening, written any common way:
// - an ARN, in any case (arn:aws, ARN:aws, arn:aws-us-gov);
// - a phone number with a + and 10 to 15 digits, spaced, dashed, dotted or bracketed
//   (+1 416-555-0143, +1 (416) 555-0143);
// - a North American number without a +: (416) 555-0143, 416-555-0143, 416.555.0143, 1-416-555-0143;
// - a run of 10 to 15 digits (an unformatted phone number or a 12-digit account id);
// - a 12-digit account id in groups of four (1111-2222-3333, 1111 2222 3333).
// Money ($1,234.56), dates (2026-10-23, 10/23/2026) and clock times (13:05) match none of these.
// The load id is required, so a match that lies wholly inside one of its occurrences is allowed: a
// load id with a 12-digit run (PO-123456789012) is not an account id. A match that only overlaps the
// load id (Account 999901439999 on load 0143) still counts.
const LEAK = new RegExp(
  [
    String.raw`\barn:`,
    String.raw`\+\d[\d\s().-]{8,}\d`,
    String.raw`(?<![\w.,$/:-])(?:1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\w-]|[.,:]\d)`,
    String.raw`(?<![\d.,])\d{10,15}(?!\d|[.,]\d)`,
    String.raw`(?<![\d-])\d{4}[\s-]\d{4}[\s-]\d{4}(?![\d-])`,
  ].join("|"),
  "gi",
);
const digits = (text: string) => text.replace(/\D/g, "").length;

function leaks(body: string, loadId: string): boolean {
  const named: Array<[number, number]> = [];
  for (let at = body.indexOf(loadId); loadId && at !== -1; at = body.indexOf(loadId, at + 1)) named.push([at, at + loadId.length]);
  for (const match of body.matchAll(LEAK)) {
    // A + followed by fewer than 10 digits is not a phone number (+15 min, +2 hours).
    if (match[0].startsWith("+") && digits(match[0]) < 10) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (!named.some(([from, to]) => from <= start && end <= to)) return true;
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
