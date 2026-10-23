import { readFileSync } from "node:fs";
import { decodePDFRawStream, PDFArray, PDFDocument, type PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { clauseById } from "@dockclock/clause-engine";
import { facilityById } from "@dockclock/evidence";
import { findLeaks, parseMime } from "@dockclock/sanitize";
import { buildClaimMime, claimFactsOf, claimSubject, type ClaimFactsInput, type SealedPackView } from "../src/claim-email.js";
import { buildClaimPdf, winAnsi } from "../src/claim-pdf.js";

// The published pack is a real sealed pack (synthetic driver messages), so the claim is built from
// the same file a recipient would get.
const docs = new URL("../../../docs/evidence/", import.meta.url);
const packJson = readFileSync(new URL("SMOKE-mve8yfv3.pack.json", docs), "utf8");
const signed = JSON.parse(packJson) as { pack: SealedPackView; keyId: string };
const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", docs), "utf8")) as { pack: { packDigestSha256: string }; publicKey: { spkiSha256: string } };
const ACCOUNT = "925432502717";
const issuedAt = new Date("2026-10-18T19:58:17.000Z");
const opening = "We claim detention of $90.99 for load SMOKE-mve8yfv3 at Lakeshore DC, Columbus OH, under the detention clause of the rate confirmation.";

const input = (change: Partial<ClaimFactsInput> = {}): ClaimFactsInput => ({
  loadId: "SMOKE-mve8yfv3",
  synthetic: true,
  clause: clauseById("lakeshore-foods"),
  facility: facilityById("lakeshore-columbus"),
  pack: signed.pack,
  packDigest: manifest.pack.packDigestSha256,
  spkiSha256: manifest.publicKey.spkiSha256,
  issuedAt,
  ...change,
});

async function claimMime(change: Partial<ClaimFactsInput> = {}) {
  const facts = claimFactsOf(input(change));
  const pdf = await buildClaimPdf(facts, { from: "DockClock Claims <claims@claims.kaungzinhein.com>", issuedAt });
  const raw = buildClaimMime({ from: "DockClock Claims <claims@claims.kaungzinhein.com>", to: "broker@example.com", replyTo: "dispatch@example.com", date: issuedAt, facts, opening, pdf, packFileName: `${signed.pack.packId}.json`, packJson }, "b1");
  return { facts, pdf, raw };
}

// The text a PDF page draws: pdf-lib writes standard-font text as hex strings shown with Tj.
async function pdfText(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents()!;
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
  const ops = streams.map((st) => Buffer.from(decodePDFRawStream(st as PDFRawStream).decode()).toString("latin1")).join("\n");
  const text = [...ops.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => Buffer.from(m[1]!, "hex").toString("latin1")).join("\n");
  return { pages: doc.getPageCount(), text };
}

// The parts of a raw message, decoded, keyed by content type.
function decodedParts(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/--b1(?:-alt|-rel)?/)) {
    const type = /Content-Type: ([^;\r\n]+)/.exec(part)?.[1];
    const body = part.split("\r\n\r\n")[1];
    if (type && body && !type.startsWith("multipart/")) out[type] = Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
  }
  return out;
}

describe("claim email", () => {
  it("has a clear subject, a text and an HTML part, and the PDF and the signed pack as attachments", async () => {
    const { raw, facts } = await claimMime();
    expect(claimSubject(facts)).toBe("Detention claim: Load SMOKE-mve8yfv3 at Lakeshore DC, Columbus OH, $90.99");
    expect(raw).toMatch(/^Subject: Detention claim: Load SMOKE-mve8yfv3 at Lakeshore DC, Columbus OH, \$90\.99\r$/m);
    expect(raw).toMatch(/^Reply-To: dispatch@example\.com\r$/m);
    expect(raw).toContain('Content-Type: multipart/mixed; boundary="b1"');
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="b1-alt"');
    const parsed = parseMime(raw);
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.attachments.map((a) => [a.name, a.contentType])).toEqual([
      ["detention-claim-SMOKE-mve8yfv3.pdf", "application/pdf"],
      [`${signed.pack.packId}.json`, "application/json"],
    ]);
    // The brand mark in the HTML header is an inline related part: the console's parser skips it,
    // so it is never listed as one of the claim's attachments.
    expect(raw).toContain("Content-ID: <brand-mark@dockclock>\r\nContent-Disposition: inline\r\n");
    expect(decodedParts(raw)["text/html"]).toContain('src="cid:brand-mark@dockclock"');
    // The public key is linked, not attached.
    expect(raw).not.toContain(".pem\"");
    // The pack goes out byte for byte as sealed.
    expect(decodedParts(raw)["application/json"]).toBe(packJson);
  });

  it("lays out the opening, the facts, one closing line, the signature and the footer", async () => {
    const text = parseMime((await claimMime()).raw).text;
    expect(text).toBe(
      [
        "Dear Lakeshore Foods (fictional shipper),",
        "",
        opening,
        "",
        "Claim number: DC-SMOKE-mve8yfv3",
        "Load: SMOKE-mve8yfv3",
        "Facility: Lakeshore DC, Columbus OH",
        "Arrived: 2026-10-18 11:50 EDT",
        "Released: 2026-10-18 15:28 EDT",
        "Detention: 90 minutes 59 seconds after 2 hours of free time, at $60.00 per hour",
        "Amount due: $90.99",
        "",
        "Please arrange payment of $90.99 under the rate confirmation. The claim summary (PDF) and the signed evidence pack (JSON) are attached.",
        "",
        "DockClock Claims, on behalf of Demo Carrier (fictional)",
        "claims@claims.kaungzinhein.com",
        "Reply to this email to reach the carrier's dispatch desk.",
        "",
        "Public key: https://d3djuoqhg6b8o2.cloudfront.net/keys/public-key.pem",
        `Evidence pack ${signed.pack.packId}, sha256 ${manifest.pack.packDigestSha256.slice(0, 16)}…`,
        "The carrier, the counterparty and the facility are fictional.",
        "",
      ].join("\n"),
    );
  });

  it("never puts the key ARN, the account id or the verification prose in the body", async () => {
    const { raw } = await claimMime();
    const parts = decodedParts(raw);
    for (const body of [parts["text/plain"]!, parts["text/html"]!]) {
      expect(body).not.toContain("arn:aws");
      expect(body).not.toContain(ACCOUNT);
      expect(body).not.toContain(signed.keyId);
      expect(body).not.toContain("canonical JSON");
      expect(body).not.toContain("verify:pack");
      expect(findLeaks(body, ACCOUNT)).toEqual([]);
      // One short fingerprint, never the full digest.
      expect(body).not.toContain(manifest.pack.packDigestSha256);
    }
    expect(parts["text/html"]).not.toMatch(/<script|<style|<link|url\(/i);
    // The one image is the brand mark, carried inline in the message.
    expect([...parts["text/html"]!.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1])).toEqual(["cid:brand-mark@dockclock"]);
  });

  it("links the console only for a demo-workspace load", async () => {
    const plain = parseMime((await claimMime()).raw).text;
    expect(plain).not.toContain("Verify this claim");
    const { raw } = await claimMime({ workspace: "demo" });
    expect(parseMime(raw).text).toContain("Verify this claim: https://d3djuoqhg6b8o2.cloudfront.net/loads/SMOKE-mve8yfv3");
    expect(decodedParts(raw)["text/html"]).toContain('href="https://d3djuoqhg6b8o2.cloudfront.net/loads/SMOKE-mve8yfv3"');
  });

  it("dates the release at the Released tap on packs whose clock stops there, and keeps the pin's time", async () => {
    const pack = { ...signed.pack, events: { ...signed.pack.events, releasedTap: { serverAt: "2026-10-18T19:26:12.000Z" } } };
    const facts = claimFactsOf(input({ pack }));
    expect(facts.released).toBe("2026-10-18 15:26 EDT");
    expect(facts.releasePin).toBe("2026-10-18 15:28 EDT");
    expect((await pdfText(await buildClaimPdf(facts, { from: "claims@example.com", issuedAt }))).text).toContain("Release pin");
    expect(claimFactsOf(input()).releasePin).toBeNull();
  });

  it("names a test load's pins as synthetic and the judge demo yard as accepting any location", async () => {
    expect(claimFactsOf(input()).source).toBe("Synthetic test pins (test load)");
    const live = claimFactsOf(input({ synthetic: false, clause: clauseById("judge-demo"), facility: facilityById("judge-demo") }));
    expect(live.source).toBe("Location pins recorded with WhatsApp server time; the demo yard accepts any location");
    expect(claimFactsOf(input({ synthetic: false })).source).toBe("Location pins inside the facility's geofence, WhatsApp server time");
    expect(claimFactsOf(input({ synthetic: false, pack: { ...signed.pack, channel: "rcs" } })).source).toContain("RCS server time");
  });
});

describe("detention minutes in formal copy", () => {
  it("shows whole minutes without decimals, the same in the text, the HTML and the PDF; the amount stays exact", async () => {
    // The live test claim: 3 minutes past 5 minutes of free time, $3.00.
    const pack = structuredClone(signed.pack);
    pack.evaluation = { ...pack.evaluation, detentionMinutes: 3, billableMinutes: 3, amountUsd: 3 };
    const { facts, pdf, raw } = await claimMime({ pack });
    expect(facts.detention).toBe("3 minutes");
    expect(facts.amount).toBe("$3.00");
    const parts = decodedParts(raw);
    expect(parts["text/plain"]).toContain("Detention: 3 minutes after 2 hours of free time");
    expect(parts["text/html"]).toContain("3 minutes after 2 hours of free time");
    expect((await pdfText(pdf)).text).toContain("3 minutes");
    for (const part of [parts["text/plain"]!, parts["text/html"]!, (await pdfText(pdf)).text]) expect(part).not.toMatch(/\d\.\d+ minutes/);
  });
});

describe("claim PDF", () => {
  it("is one page carrying the sealed amount, the full digest, the clause terms and the verification rule", async () => {
    const { pdf, facts } = await claimMime({ workspace: "demo" });
    const { pages, text } = await pdfText(pdf);
    expect(pages).toBe(1);
    expect(text).toContain("$90.99");
    expect(text).toContain(manifest.pack.packDigestSha256);
    expect(text).toContain(signed.pack.packId);
    expect(text).toContain("DC-SMOKE-mve8yfv3");
    expect(text).toContain("Lakeshore Foods (fictional shipper)");
    expect(text).toContain("2 hours from the appointment time");
    expect(text).toContain("$60.00 per hour");
    expect(text).toContain("2026-10-18 11:50 EDT");
    expect(text).toContain("Synthetic test pins (test load)");
    // Wrapped lines rejoin with a space.
    expect(text.replace(/\n/g, " ")).toContain("Signed with AWS KMS (ECDSA P-256). Verify at https://d3djuoqhg6b8o2.cloudfront.net/loads/SMOKE-mve8yfv3");
    expect(text).toContain(manifest.publicKey.spkiSha256.slice(0, 20));
    expect(text).toContain("fictional");
    expect(facts.amount).toBe("$90.99");
  });

  it("holds no key ARN, account id, phone number or coordinates", async () => {
    const { text } = await pdfText((await claimMime()).pdf);
    expect(text).not.toContain("arn:aws");
    expect(text).not.toContain(ACCOUNT);
    expect(findLeaks(text, ACCOUNT)).toEqual([]);
  });

  it("is small enough to attach without thought", async () => {
    expect((await claimMime()).pdf.length).toBeLessThan(20_000);
  });

  it("folds text the standard fonts cannot encode", () => {
    expect(winAnsi("Québec – São Paulo 東京")).toBe("Quebec – Sao Paulo ??");
  });
});
