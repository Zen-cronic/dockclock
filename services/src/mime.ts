// A plain-text email as raw MIME, so the exact bytes SES sends can also be stored as evidence.
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function textMime(parts: { from: string; to: string; subject: string; text: string; date: Date }): string {
  const wrap = (b64: string) => b64.replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${parts.from}`,
    `To: ${parts.to}`,
    `Subject: ${encodeHeader(parts.subject)}`,
    `Date: ${parts.date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(Buffer.from(`${parts.text}\n`, "utf8").toString("base64")),
  ].join("\r\n");
}

// Where a load's emails are kept: next to its signed packs, under the same Object Lock retention.
export function emailKey(loadId: string, kind: "notice" | "claim"): string {
  return `packs/${loadId}/${kind}.eml`;
}
