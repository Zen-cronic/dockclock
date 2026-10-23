// One layout for every email DockClock sends: a wordmark, a one-line summary, a short facts block,
// one closing line, a signature and a footer of public links. Rendered twice, as plain text and as
// simple HTML (inline CSS, table layout, no images, no tracking), from the same values, so the two
// parts of a multipart/alternative message can never disagree.

export interface Fact {
  label: string;
  value: string;
  // Set in bold in the HTML part (the amount).
  strong?: boolean;
}

export interface FooterLink {
  label: string;
  href: string;
}

export interface Letter {
  // What kind of email this is, shown next to the wordmark ("Detention claim").
  kind: string;
  salutation?: string;
  summary: string;
  facts: Fact[];
  closing: string;
  // First line is the signer, then the address and the reply line.
  signature: string[];
  links: FooterLink[];
  // Small print under the links: a fingerprint, a note that the parties are fictional.
  notes: string[];
}

// Colours from the console palette (site/src/styles/tokens.css). The safety yellow is the one accent.
const INK = "#15171c";
const INK_2 = "#454b57";
const INK_3 = "#5e6573";
const RULE = "#d5d9de";
const GROUND = "#eef0ee";
const ACCENT = "#ffc400";
const FONT = "Arial, Helvetica, sans-serif";

export function renderText(letter: Letter): string {
  return [
    ...(letter.salutation ? [letter.salutation, ""] : []),
    letter.summary,
    "",
    ...letter.facts.map((f) => `${f.label}: ${f.value}`),
    "",
    letter.closing,
    "",
    ...letter.signature,
    ...(letter.links.length || letter.notes.length ? ["", ...letter.links.map((l) => `${l.label}: ${l.href}`), ...letter.notes] : []),
  ].join("\n");
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const text = (size: number, color: string, extra = "") => `font-family:${FONT};font-size:${size}px;line-height:${Math.round(size * 1.5)}px;color:${color};${extra}`;

export function renderHtml(letter: Letter, subject: string): string {
  const e = escapeHtml;
  const row = (content: string, padding: string, style = "") => `<tr><td style="padding:${padding};${style}">${content}</td></tr>`;
  const facts = letter.facts
    .map(
      (f, i) =>
        `<tr><td width="130" valign="top" style="${text(13, INK_3, `padding:8px 12px 8px 0;${i ? `border-top:1px solid ${RULE};` : ""}`)}">${e(f.label)}</td>` +
        `<td valign="top" style="${text(14, INK, `padding:8px 0;${i ? `border-top:1px solid ${RULE};` : ""}${f.strong ? "font-weight:bold;" : ""}word-break:break-word;`)}">${e(f.value)}</td></tr>`,
    )
    .join("");
  const signature = letter.signature.map((line, i) => (i === 0 ? `<strong style="color:${INK};">${e(line)}</strong>` : e(line))).join("<br>");
  const links = letter.links.map((l) => `<a href="${e(l.href)}" style="color:${INK};text-decoration:underline;">${e(l.label)}</a>`).join(`<span style="color:${INK_3};">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`);
  const footer = [...(links ? [links] : []), ...letter.notes.map(e)].join("<br>");
  return [
    "<!DOCTYPE html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${e(subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${GROUND};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${GROUND}" style="background:${GROUND};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ${RULE};">`,
    `<tr><td height="4" bgcolor="${ACCENT}" style="height:4px;background:${ACCENT};font-size:0;line-height:0;">&nbsp;</td></tr>`,
    row(`<span style="${text(18, INK, "font-weight:bold;letter-spacing:0.2px;")}">DockClock</span><span style="${text(13, INK_3)}">&nbsp;&nbsp;${e(letter.kind)}</span>`, "20px 32px 0"),
    ...(letter.salutation ? [row(e(letter.salutation), "24px 32px 0", text(15, INK))] : []),
    row(e(letter.summary), `${letter.salutation ? 12 : 24}px 32px 0`, text(15, INK)),
    row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid ${RULE};border-bottom:1px solid ${RULE};">${facts}</table>`, "20px 32px 0"),
    row(e(letter.closing), "20px 32px 0", text(15, INK)),
    row(signature, "20px 32px 24px", text(14, INK_2)),
    ...(footer ? [row(footer, "16px 32px 20px", `${text(12, INK_3)}border-top:1px solid ${RULE};word-break:break-word;`)] : []),
    "</table>",
    "</td></tr></table>",
    "</body></html>",
  ].join("\n");
}
