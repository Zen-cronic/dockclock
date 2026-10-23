// The one-page claim summary attached to the claim email, drawn with pdf-lib (pure JavaScript, the
// PDF standard Helvetica and Courier fonts, nothing embedded, no native code). Every value comes
// from ClaimFacts, the same object the email renders, so the PDF and the email cannot disagree.

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { addressOf, CARRIER_NAME, FICTIONAL_NOTE, PUBLIC_KEY_URL } from "@dockclock/mail";
import type { ClaimFacts } from "./claim-email.js";

const hex = (value: string) => {
  const n = Number.parseInt(value.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};
// Console palette: ink, two greys, the rule, a light panel and the one accent (safety yellow).
const INK = hex("#15171c");
const INK_2 = hex("#454b57");
const INK_3 = hex("#5e6573");
const RULE = hex("#d5d9de");
const PANEL = hex("#f6f7f6");
const ACCENT = hex("#ffc400");

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
const LABEL_WIDTH = 150;

// The standard fonts encode WinAnsi only. Accents fold to their base letter; anything else becomes "?".
export function winAnsi(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7e\xa0-\xff–—‘’“”…•]/g, "?");
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of winAnsi(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

class Cursor {
  y = PAGE.height - MARGIN;
  constructor(
    private readonly page: PDFPage,
    private readonly fonts: Fonts,
  ) {}

  text(value: string, x: number, y: number, size: number, font: PDFFont = this.fonts.regular, color = INK): void {
    this.page.drawText(winAnsi(value), { x, y, size, font, color });
  }

  right(value: string, y: number, size: number, font: PDFFont = this.fonts.regular, color = INK): void {
    this.text(value, PAGE.width - MARGIN - font.widthOfTextAtSize(winAnsi(value), size), y, size, font, color);
  }

  rule(y: number): void {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness: 0.75, color: RULE });
  }

  heading(title: string): void {
    this.y -= 20;
    this.text(title.toUpperCase(), MARGIN, this.y, 8.5, this.fonts.bold, INK_3);
    this.y -= 6;
    this.rule(this.y);
  }

  // A label in the left column, the value wrapped in the right one.
  row(label: string, value: string, font: PDFFont = this.fonts.regular, size = 10): void {
    const width = PAGE.width - 2 * MARGIN - LABEL_WIDTH;
    const lines = wrap(value, font, size, width);
    this.y -= 14;
    this.text(label, MARGIN, this.y, 9, this.fonts.regular, INK_3);
    lines.forEach((line, i) => {
      if (i) this.y -= 12.5;
      this.text(line, MARGIN + LABEL_WIDTH, this.y, size, font, INK);
    });
  }

  paragraph(value: string, size: number, color = INK_2, font: PDFFont = this.fonts.regular): void {
    for (const line of wrap(value, font, size, PAGE.width - 2 * MARGIN)) {
      this.y -= size + 3;
      this.text(line, MARGIN, this.y, size, font, color);
    }
  }
}

export interface ClaimPdfOptions {
  from: string;
  issuedAt: Date;
}

export async function buildClaimPdf(facts: ClaimFacts, options: ClaimPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const title = `Detention claim ${facts.claimNumber}`;
  doc.setTitle(title);
  doc.setSubject(`Detention claim for load ${facts.loadId}, ${facts.amount}`);
  doc.setAuthor("DockClock Claims");
  doc.setCreator("DockClock");
  doc.setProducer("DockClock (pdf-lib)");
  doc.setCreationDate(options.issuedAt);
  doc.setModificationDate(options.issuedAt);
  const fonts: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), mono: await doc.embedFont(StandardFonts.Courier) };
  const page = doc.addPage([PAGE.width, PAGE.height]);
  const c = new Cursor(page, fonts);

  // Header: the accent bar, the wordmark, and the claim's number and date on the right.
  page.drawRectangle({ x: 0, y: PAGE.height - 8, width: PAGE.width, height: 8, color: ACCENT });
  c.y = PAGE.height - MARGIN;
  c.text("DockClock", MARGIN, c.y - 6, 22, fonts.bold);
  c.right("DETENTION CLAIM", c.y, 9, fonts.bold, INK_3);
  c.right(facts.claimNumber, c.y - 14, 10, fonts.bold);
  c.right(`Issued ${facts.issued}`, c.y - 27, 9, fonts.regular, INK_2);
  c.y -= 42;
  c.rule(c.y);

  // Parties, side by side.
  const col = MARGIN + (PAGE.width - 2 * MARGIN) / 2;
  c.y -= 16;
  c.text("CLAIM TO", MARGIN, c.y, 8.5, fonts.bold, INK_3);
  c.text("FROM", col, c.y, 8.5, fonts.bold, INK_3);
  c.y -= 14;
  c.text(facts.counterparty, MARGIN, c.y, 10.5, fonts.bold);
  c.text("DockClock Claims", col, c.y, 10.5, fonts.bold);
  c.text("Detention under the rate confirmation", MARGIN, c.y - 13, 9, fonts.regular, INK_2);
  c.text(`on behalf of ${CARRIER_NAME}`, col, c.y - 13, 9, fonts.regular, INK_2);
  c.text(addressOf(options.from), col, c.y - 26, 9, fonts.regular, INK_2);
  c.y -= 30;

  c.heading("Load");
  c.row("Load", facts.loadId);
  c.row("Facility", facts.facilityName);

  c.heading("Clause terms");
  c.row("Free time", facts.freeTime);
  c.row("Rate", facts.rate);
  c.row("Cap", facts.cap);
  c.row("Notice", facts.notice);

  c.heading("Recorded times");
  c.row("Arrived", facts.arrived);
  c.row("Released", facts.released);
  if (facts.releasePin) c.row("Release pin", facts.releasePin);
  c.row("Source", facts.source);
  if (facts.noticeRecord) c.row("Detention notice", facts.noticeRecord);

  c.heading("Detention");
  c.row("Past free time", facts.detention);
  if (facts.billable) c.row("Billable", facts.billable);

  // The amount, in a panel of its own.
  c.y -= 16;
  page.drawRectangle({ x: MARGIN, y: c.y - 30, width: PAGE.width - 2 * MARGIN, height: 36, color: PANEL, borderColor: RULE, borderWidth: 0.75 });
  c.text("Amount due", MARGIN + 12, c.y - 17, 11, fonts.bold);
  c.text(facts.amount, PAGE.width - MARGIN - 12 - fonts.bold.widthOfTextAtSize(winAnsi(facts.amount), 18), c.y - 19, 18, fonts.bold);
  page.drawRectangle({ x: MARGIN, y: c.y - 30, width: 4, height: 36, color: ACCENT });
  c.y -= 32;

  c.heading("Evidence");
  c.row("Evidence pack", facts.packId);
  c.row("SHA-256", facts.packDigest, fonts.mono, 8.6);
  c.row("Signature", `Signed with AWS KMS (ECDSA P-256). Verify at ${facts.loadPage ?? PUBLIC_KEY_URL}`);

  c.heading("Appendix: how to verify");
  c.paragraph(
    `The attached ${facts.packId}.json holds the sealed pack and its signature. Write the file's "pack" field as canonical JSON (object keys sorted at every level, no spaces) and take its SHA-256: it equals the SHA-256 above. signatureBase64 is an ECDSA P-256 signature (DER) over that hash, made by AWS KMS. Check it with the public key at ${PUBLIC_KEY_URL} (SPKI SHA-256 ${facts.spkiSha256}). The signature covers the pack's fields, not the file's bytes. DockClock's verifier (npm run verify:pack) applies exactly this rule.`,
    8.5,
  );

  // Footer.
  c.rule(MARGIN + 22);
  const footer = wrap(`${FICTIONAL_NOTE} Produced by DockClock from the sealed evidence pack. The amount is computed by the contract's clause engine, not by the AI agent.`, fonts.regular, 7.5, PAGE.width - 2 * MARGIN - 60);
  footer.forEach((line, i) => c.text(line, MARGIN, MARGIN + 10 - i * 10, 7.5, fonts.regular, INK_3));
  c.right("Page 1 of 1", MARGIN + 10, 7.5, fonts.regular, INK_3);

  return doc.save();
}
