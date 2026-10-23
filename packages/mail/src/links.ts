// The public places an email may link to, and the names every email signs with. Both links are
// served by the judge console on CloudFront with no login.

export const CONSOLE_URL = "https://d3djuoqhg6b8o2.cloudfront.net";

// The evidence key's public half, as the console serves it (byte for byte docs/evidence/public-key.pem).
export const PUBLIC_KEY_URL = `${CONSOLE_URL}/keys/public-key.pem`;

// The carrier DockClock files for. Fictional, as is every counterparty.
export const CARRIER_NAME = "Demo Carrier (fictional)";

// The console shows only demo-workspace loads (every judge, test and flagged operator load), so a
// link to any other load would answer 404. Callers pass the load's workspace and get null otherwise.
export function loadPageUrl(loadId: string, workspace: string | undefined | null): string | null {
  return workspace === "demo" ? `${CONSOLE_URL}/loads/${encodeURIComponent(loadId)}` : null;
}

// "DockClock Claims <claims@example.com>" -> "claims@example.com".
export function addressOf(mailbox: string): string {
  return /<([^>]+)>/.exec(mailbox)?.[1]?.trim() ?? mailbox.trim();
}

// The block every counterparty email signs with. The reply line appears only when the message
// carries a Reply-To, so it never promises a route that is not there.
export function signatureLines(from: string, replyTo: string | undefined): string[] {
  const address = addressOf(from);
  return [`DockClock Claims, on behalf of ${CARRIER_NAME}`, ...(address ? [address] : []), ...(replyTo ? ["Reply to this email to reach the carrier's dispatch desk."] : [])];
}

export const FICTIONAL_NOTE = "The carrier, the counterparty and the facility are fictional.";
