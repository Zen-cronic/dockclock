// The deterministic gate in front of the one tool that moves money. The agent supplies wording;
// everything that decides whether and how much is checked here against the signed, sealed pack.

export interface SealedClaimBasis {
  loadId: string;
  phase: string;
  verdict: string;
  amountUsd: number;
  packDigest: string;
  packId: string;
  approvalId: string | null;
  alreadySentAt: string | null;
}

export interface ClaimRequest {
  loadId: string;
  subject: string;
  body: string;
  amountUsd: number;
  packDigest: string;
  approvalId: string;
}

export type ClaimDecision = { ok: true } | { ok: false; reason: string };

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function checkClaim(request: ClaimRequest, basis: SealedClaimBasis): ClaimDecision {
  const refuse = (reason: string): ClaimDecision => ({ ok: false, reason });
  if (request.loadId !== basis.loadId) return refuse("load id does not match the sealed load");
  if (basis.phase !== "sealed") return refuse("the load's evidence is not sealed yet");
  if (basis.verdict !== "BILLABLE") return refuse(`the clause engine's verdict is ${basis.verdict}, not BILLABLE`);
  if (basis.alreadySentAt) return refuse(`a claim for this load was already sent at ${basis.alreadySentAt}`);
  if (!basis.approvalId || request.approvalId !== basis.approvalId) return refuse("dispatch has not approved this claim");
  if (request.packDigest !== basis.packDigest) return refuse("evidence pack digest does not match the sealed pack");
  if (Math.round(request.amountUsd * 100) !== Math.round(basis.amountUsd * 100)) {
    return refuse(`amount ${formatUsd(request.amountUsd)} differs from the contract amount ${formatUsd(basis.amountUsd)}`);
  }
  if (!request.body.includes(formatUsd(basis.amountUsd))) return refuse(`the email must state the contract amount ${formatUsd(basis.amountUsd)}`);
  if (!request.body.includes(basis.loadId)) return refuse("the email must name the load id");
  if (request.subject.length === 0 || request.subject.length > 160) return refuse("subject must be 1-160 characters");
  if (request.body.length < 80 || request.body.length > 6000) return refuse("body must be 80-6000 characters");
  return { ok: true };
}

export interface ClaimEmailParts {
  from: string;
  to: string;
  subject: string;
  body: string;
  packFileName: string;
  packJson: string;
  footer: string;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// A multipart message: the agent's text plus a fixed verification footer, and the signed pack.
export function buildClaimMime(parts: ClaimEmailParts, boundary = `dockclock-${Date.now().toString(36)}`): string {
  const wrap = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${parts.from}`,
    `To: ${parts.to}`,
    `Subject: ${encodeHeader(parts.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(`${parts.body}\n\n${parts.footer}\n`, "utf8").toString("base64")),
    `--${boundary}`,
    `Content-Type: application/json; name="${parts.packFileName}"`,
    `Content-Disposition: attachment; filename="${parts.packFileName}"`,
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(parts.packJson, "utf8").toString("base64")),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
