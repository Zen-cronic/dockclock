// Raw MIME for DockClock's emails, built here rather than by SES so the stored copy is byte for byte
// what was sent. Always multipart/alternative (plain text, then HTML); with attachments, that sits
// first inside a multipart/mixed message. When the HTML shows the brand mark (cid:brand-mark@...),
// the HTML alternative becomes a multipart/related holding the HTML and the mark's PNG: inline, with
// a Content-ID and no file name, so mail clients draw it in the header and do not list it as an
// attachment.

import { BRAND_MARK_CID, BRAND_MARK_PNG_BASE64 } from "./brand.js";

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer | string;
}

export interface MailParts {
  from: string;
  to: string;
  // Where a reply goes: the carrier's dispatch desk.
  replyTo?: string | undefined;
  subject: string;
  date: Date;
  text: string;
  html: string;
  attachments?: Attachment[];
}

export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const base64Lines = (content: Buffer | string) => (typeof content === "string" ? Buffer.from(content, "utf8") : content).toString("base64").replace(/.{1,76}/g, "$&\r\n");

// `boundary` is a seed: the alternative and mixed boundaries derive from it, so tests can fix both.
export function buildMime(parts: MailParts, boundary = `dockclock-${Date.now().toString(36)}`): string {
  const alt = `${boundary}-alt`;
  const rel = `${boundary}-rel`;
  const html = ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(`${parts.html}\n`)];
  const htmlPart = parts.html.includes(`cid:${BRAND_MARK_CID}`)
    ? [
        `Content-Type: multipart/related; type="text/html"; boundary="${rel}"`,
        "",
        `--${rel}`,
        ...html,
        `--${rel}`,
        "Content-Type: image/png",
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${BRAND_MARK_CID}>`,
        "Content-Disposition: inline",
        "",
        base64Lines(Buffer.from(BRAND_MARK_PNG_BASE64, "base64")),
        `--${rel}--`,
        "",
      ]
    : html;
  const alternative = [
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(`${parts.text}\n`),
    `--${alt}`,
    ...htmlPart,
    `--${alt}--`,
    "",
  ];
  const headers = [
    `From: ${parts.from}`,
    `To: ${parts.to}`,
    ...(parts.replyTo ? [`Reply-To: ${parts.replyTo}`] : []),
    `Subject: ${encodeHeader(parts.subject)}`,
    `Date: ${parts.date.toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  const attachments = parts.attachments ?? [];
  if (attachments.length === 0) return [...headers, `Content-Type: multipart/alternative; boundary="${alt}"`, "", ...alternative].join("\r\n");
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    ...alternative,
    ...attachments.flatMap((a) => [
      `--${boundary}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(a.content),
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
