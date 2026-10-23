import { createHash } from "node:crypto";

// MIME: just enough for the formats DockClock sends: text/plain (older notices), multipart/mixed
// with a text body (older claims), and multipart/alternative (text and HTML), alone or as the first
// part of a multipart/mixed message with attachments. Base64 throughout.
export interface ParsedEmail {
  from: string;
  subject: string;
  date: string | null;
  // The plain-text part: what the console shows.
  text: string;
  // Whether the message also carried an HTML alternative. Its markup is never published.
  hasHtml: boolean;
  attachments: Array<{ name: string; contentType: string; sha256: string }>;
}

function splitHead(raw: string): { headers: Record<string, string>; body: string } {
  const at = raw.indexOf("\r\n\r\n");
  const head = at === -1 ? raw : raw.slice(0, at);
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { headers, body: at === -1 ? "" : raw.slice(at + 4) };
}

function decodeWords(value: string): string {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

function decodeBody(body: string, encoding: string | undefined): Buffer {
  return encoding?.toLowerCase() === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : Buffer.from(body, "utf8");
}

// Walks one MIME entity: multiparts recurse (multipart/related too), an inline Content-ID part is
// skipped, a named part is an attachment, and the first text/plain part without a name is the body.
function walk(headers: Record<string, string>, body: string, out: ParsedEmail): void {
  const contentType = headers["content-type"] ?? "text/plain";
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (type.startsWith("multipart/") && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const p = splitHead(part.replace(/^\r\n/, ""));
      walk(p.headers, p.body, out);
    }
    return;
  }
  // An inline part referenced by Content-ID (the brand mark in the HTML header) belongs to the HTML
  // alternative: it is neither the body nor one of the claim's attachments.
  if (headers["content-id"] && !/^\s*attachment/i.test(headers["content-disposition"] ?? "")) return;
  const bytes = decodeBody(body, headers["content-transfer-encoding"]);
  const name = /filename="?([^";]+)"?/i.exec(headers["content-disposition"] ?? "")?.[1];
  if (name) out.attachments.push({ name, contentType: type, sha256: createHash("sha256").update(bytes).digest("hex") });
  else if (type === "text/plain" && !out.text) out.text = bytes.toString("utf8");
  else if (type === "text/html") out.hasHtml = true;
}

export function parseMime(raw: string): ParsedEmail {
  const { headers, body } = splitHead(raw);
  const out: ParsedEmail = { from: headers.from ?? "", subject: decodeWords(headers.subject ?? ""), date: headers.date ?? null, text: "", hasHtml: false, attachments: [] };
  walk(headers, body, out);
  return out;
}
