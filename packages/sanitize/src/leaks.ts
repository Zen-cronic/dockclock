// What DockClock may publish about a load: the scrubbers that remove contacts, places, AWS names and
// raw message ids from stored records, and findLeaks, the check every published response must pass.
// Used by the judge-desk exporter and the console read API alike.

type Item = Record<string, unknown>;

// Sender domains that may appear in published email records. Any other address is removed.
export const PUBLISHABLE_EMAIL_DOMAINS = ["claims.kaungzinhein.com", "example.com"];

// Keys that may hold a person's contact, a place, an AWS name or a raw message id.
const DROP_KEYS =
  /^(pk|lat|lon|latitude|longitude|location|e164|address|bsuid|boundBsuid|boundFrom|driverKey|messageId|wamid|failedMessageId|dispatchMessageId|approvalMessageId|inboundMessageId|s3Key|s3Bucket|mimeKey|keyId|executionArn|token|tokens|taskToken|nonce|mediaId|metaSha256|from|to|replyTo|outbox|originationNumber|destinationNumber)$/i;

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;

export function scrubText(text: string): string {
  return text
    .replace(/arn:aws[a-z-]*:[^\s"')]+/g, "<AWS resource name removed>")
    .replace(/\+\d{10,15}/g, "<phone removed>")
    .replace(/\b[A-Z]{2}\.\d{10,}\b/g, "<id removed>")
    .replace(/\bwamid\.[A-Za-z0-9._=+/-]+/g, "<message id removed>")
    .replace(/\b(dc1\.[a-z_]+\.[A-Za-z0-9-]+\.)[0-9a-f]{6,}/g, "$1<nonce>")
    .replace(/s3:\/\/\S+/g, "<S3 location removed>")
    .replace(/\b(packs|rcs-inbound|media)\/[A-Za-z0-9._/#-]+/g, "<S3 key removed>")
    .replace(EMAIL, (address: string, domain: string) => (PUBLISHABLE_EMAIL_DOMAINS.includes(domain.toLowerCase()) ? address : "<email removed>"));
}

export function scrub(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Item)
        .filter(([k]) => !DROP_KEYS.test(k))
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

// Everything a published response must not hold. Returns one line per finding; empty means clean.
// accountId adds an exact check for the AWS account id on top of the generic 12-digit one.
export function findLeaks(value: unknown, accountId?: string): string[] {
  const leaks: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["E.164 number", /\+\d{10,15}/],
    ["BSUID", /\b[A-Z]{2}\.\d{10,}\b/],
    ["ARN", /arn:aws/],
    ["12-digit account id", /(^|[^0-9A-Za-z])\d{12}([^0-9A-Za-z]|$)/],
    ["S3 key", /\b(packs|rcs-inbound|media)\/[A-Za-z0-9._#-]+\/|s3:\/\//],
    ["WhatsApp message id", /\bwamid\.(?!smoke\.)/],
    ["coordinate pair", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
  ];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const [name, re] of checks) if (re.test(v)) leaks.push(`${name} at ${path}`);
      for (const match of v.matchAll(EMAIL)) {
        if (!PUBLISHABLE_EMAIL_DOMAINS.includes(match[1]!.toLowerCase())) leaks.push(`email address at ${path}`);
      }
      if (accountId && v.includes(accountId)) leaks.push(`account id at ${path}`);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 2 && v.every((n) => typeof n === "number" && !Number.isInteger(n) && Math.abs(n) <= 180)) leaks.push(`numeric coordinate pair at ${path}`);
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v as Item)) {
        if (/^(lat|lon|latitude|longitude)$/i.test(k)) leaks.push(`coordinate key ${k} at ${path}`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, "$");
  return leaks;
}
