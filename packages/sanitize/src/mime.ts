import { createHash } from "node:crypto";

// MIME: just enough for the formats DockClock sends (text/plain and multipart/mixed, base64).
export interface ParsedEmail {
  from: string;
  subject: string;
  date: string | null;
  text: string;
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

export function parseMime(raw: string): ParsedEmail {
  const { headers, body } = splitHead(raw);
  const out: ParsedEmail = { from: headers.from ?? "", subject: decodeWords(headers.subject ?? ""), date: headers.date ?? null, text: "", attachments: [] };
  const boundary = /boundary="?([^";]+)"?/i.exec(headers["content-type"] ?? "")?.[1];
  if (!boundary) {
    out.text = decodeBody(body, headers["content-transfer-encoding"]).toString("utf8");
    return out;
  }
  for (const part of body.split(`--${boundary}`).slice(1)) {
    if (part.startsWith("--")) break;
    const p = splitHead(part.replace(/^\r\n/, ""));
    const bytes = decodeBody(p.body, p.headers["content-transfer-encoding"]);
    const type = (p.headers["content-type"] ?? "text/plain").split(";")[0]!.trim();
    const name = /filename="?([^";]+)"?/i.exec(p.headers["content-disposition"] ?? "")?.[1];
    if (name) out.attachments.push({ name, contentType: type, sha256: createHash("sha256").update(bytes).digest("hex") });
    else if (type === "text/plain" && !out.text) out.text = bytes.toString("utf8");
  }
  return out;
}
