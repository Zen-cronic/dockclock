import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findLeaks, parseMime, scrub, scrubText, sniffImage, stripImageMetadata } from "../src/index.js";

const ACCOUNT = "925432502717";

describe("scrubText and scrub", () => {
  it("removes contacts, AWS names, message ids, nonces, S3 keys and private addresses", () => {
    const text = scrubText(
      `call +15550100001 or US.13491208655302741918; arn:aws:kms:us-east-1:${ACCOUNT}:key/x; wamid.HBgLMTU1; dc1.arrived.L1.68220ac1613f; s3://b/k; packs/L1/notice.eml; someone+dc-broker@gmail.com; claims@claims.kaungzinhein.com`,
    );
    expect(findLeaks(text, ACCOUNT)).toEqual([]);
    expect(text).toContain("dc1.arrived.L1.<nonce>");
    expect(text).toContain("<email removed>");
    expect(text).toContain("claims@claims.kaungzinhein.com");
  });

  it("drops keys that carry places, people and AWS names", () => {
    const out = scrub({ lat: 39.9, lon: -82.9, address: { e164: "+15550100001" }, executionArn: "arn:aws:states:x", messageId: "wamid.x", s3Key: "packs/a/b", keep: "ok", detail: { lat: 1.5 } });
    expect(out).toEqual({ keep: "ok", detail: {} });
  });
});

describe("findLeaks", () => {
  it.each([
    ["an E.164 number", { a: "+15550100001" }],
    ["a BSUID", { a: "US.13491208655302741918" }],
    ["an ARN", { a: "arn:aws:s3:::bucket" }],
    ["a 12-digit account id", { a: `account ${ACCOUNT}` }],
    ["an S3 key", { a: "rcs-inbound/rcs/x.jpg" }],
    ["a WhatsApp message id", { a: "wamid.HBgLMTU1" }],
    ["a coordinate pair in text", { a: "39.8995, -82.9380" }],
    ["a coordinate key", { lat: 39.8995 }],
    ["a numeric coordinate pair", { location: [-82.938, 39.8995] }],
    ["a private email address", { a: "someone@gmail.com" }],
  ])("finds %s", (_name, value) => {
    expect(findLeaks(value, ACCOUNT).length).toBeGreaterThan(0);
  });

  it("passes clean values and synthetic smoke ids", () => {
    expect(findLeaks({ a: "wamid.smoke.SMOKE-x.1", at: "2026-10-20T18:47:00.887Z", digest: "891e5d6e28b248fad06b91b2768644d8bb6fa88eeb05d9ff54159900dd3333e2", from: "claims@claims.kaungzinhein.com" }, ACCOUNT)).toEqual([]);
  });
});

describe("parseMime", () => {
  it("reads a base64 text/plain message", () => {
    const raw = ["From: a@example.com", "Subject: =?UTF-8?B?" + Buffer.from("Notice – ü").toString("base64") + "?=", "Content-Transfer-Encoding: base64", "", Buffer.from("Hello\n").toString("base64")].join("\r\n");
    expect(parseMime(raw)).toMatchObject({ subject: "Notice – ü", text: "Hello\n", attachments: [] });
  });

  it("reads the text part of multipart/alternative, alone or inside multipart/mixed with attachments", () => {
    const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64");
    const alternative = (b: string) => [`--${b}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64("Plain body\n"), `--${b}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64("<p>HTML body</p>"), `--${b}--`, ""];
    const alone = ["From: a@example.com", "Subject: Notice", 'Content-Type: multipart/alternative; boundary="x-alt"', "", ...alternative("x-alt")].join("\r\n");
    expect(parseMime(alone)).toMatchObject({ text: "Plain body\n", hasHtml: true, attachments: [] });
    const pdf = Buffer.from("%PDF-1.7 fake");
    const mixed = [
      "From: a@example.com",
      "Subject: Claim",
      'Content-Type: multipart/mixed; boundary="x"',
      "",
      "--x",
      'Content-Type: multipart/alternative; boundary="x-alt"',
      "",
      ...alternative("x-alt"),
      "--x",
      'Content-Type: application/pdf; name="claim.pdf"',
      'Content-Disposition: attachment; filename="claim.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      b64(pdf),
      "--x",
      'Content-Type: application/json; name="p.json"',
      'Content-Disposition: attachment; filename="p.json"',
      "Content-Transfer-Encoding: base64",
      "",
      b64("{}"),
      "--x--",
      "",
    ].join("\r\n");
    const parsed = parseMime(mixed);
    expect(parsed.text).toBe("Plain body\n");
    expect(parsed.hasHtml).toBe(true);
    expect(parsed.attachments).toEqual([
      { name: "claim.pdf", contentType: "application/pdf", sha256: createHash("sha256").update(pdf).digest("hex") },
      { name: "p.json", contentType: "application/json", sha256: createHash("sha256").update("{}").digest("hex") },
    ]);
  });
});

describe("driver photos", () => {
  const withGps = new Uint8Array(readFileSync(new URL("fixtures/gps-exif.jpg", import.meta.url)));
  const ascii = (b: Uint8Array) => Buffer.from(b).toString("latin1");

  it("removes EXIF (with its GPS block) and comments from a JPEG without touching the picture", () => {
    expect(ascii(withGps)).toContain("Exif");
    expect(ascii(withGps)).toContain("fake GPS");
    const out = stripImageMetadata(withGps)!;
    expect(out.type).toBe("image/jpeg");
    expect(ascii(out.bytes)).not.toContain("Exif");
    expect(ascii(out.bytes)).not.toContain("fake GPS");
    // No APP1 marker before the start of scan.
    const header = (b: Uint8Array) => Buffer.from(b.subarray(0, Buffer.from(b).indexOf(Buffer.from([0xff, 0xda]))));
    expect(header(withGps).includes(Buffer.from([0xff, 0xe1]))).toBe(true);
    expect(header(out.bytes).includes(Buffer.from([0xff, 0xe1]))).toBe(false);
    // The scan data, from the start-of-scan marker on, is byte for byte the same.
    const scan = (b: Uint8Array) => Buffer.from(b.subarray(Buffer.from(b).indexOf(Buffer.from([0xff, 0xda]))));
    expect(scan(out.bytes).equals(scan(withGps))).toBe(true);
    expect(stripImageMetadata(out.bytes)!.bytes).toEqual(out.bytes);
  });

  it("removes text and EXIF chunks from a PNG", () => {
    const chunk = (type: string, data: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length, 0);
      head.write(type, 4, "ascii");
      return Buffer.concat([head, data, Buffer.alloc(4)]);
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", Buffer.alloc(13)), chunk("tEXt", Buffer.from("GPS\u000012.3,45.6")), chunk("eXIf", Buffer.from("II*")), chunk("IDAT", Buffer.from([1, 2, 3])), chunk("IEND", Buffer.alloc(0))]);
    const out = stripImageMetadata(new Uint8Array(png))!;
    expect(out.type).toBe("image/png");
    expect(ascii(out.bytes)).not.toContain("tEXt");
    expect(ascii(out.bytes)).not.toContain("eXIf");
    expect(ascii(out.bytes)).toContain("IDAT");
  });

  it("ends a JPEG at its end-of-image marker, dropping a motion-photo MP4 or MPF images after it", () => {
    // A secondary MPF image carrying its own EXIF with GPS, then a motion photo's MP4 box.
    const secondary = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x12]), Buffer.from("Exif\u0000\u0000second GPS"), Buffer.from([0xff, 0xd9])]);
    const mp4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from("ftypmp42 motion photo GPS")]);
    const trailed = new Uint8Array(Buffer.concat([Buffer.from(withGps), secondary, mp4]));
    const out = stripImageMetadata(trailed)!;
    expect(ascii(out.bytes)).not.toContain("second GPS");
    expect(ascii(out.bytes)).not.toContain("ftypmp42");
    expect(ascii(out.bytes)).not.toContain("Exif");
    expect(out.bytes).toEqual(stripImageMetadata(withGps)!.bytes);
    expect([...out.bytes.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("keeps stuffed bytes and restart markers inside the scan", () => {
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    const data = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xff, 0xd9]);
    const jpeg = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xd8]), sos, data, Buffer.from("after")]));
    expect(Buffer.from(stripImageMetadata(jpeg)!.bytes).equals(Buffer.concat([Buffer.from([0xff, 0xd8]), sos, data]))).toBe(true);
  });

  it("refuses a truncated JPEG or PNG instead of serving part of it", () => {
    expect(() => stripImageMetadata(withGps.subarray(0, withGps.length - 40))).toThrow(/malformed JPEG/);
    expect(() => stripImageMetadata(withGps.subarray(0, 30))).toThrow(/malformed JPEG/);
    expect(() => stripImageMetadata(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]))).toThrow(/malformed PNG/);
  });

  it("refuses anything that is not a JPEG or PNG", () => {
    expect(sniffImage(new TextEncoder().encode("smoke bill of lading"))).toBeNull();
    expect(stripImageMetadata(new TextEncoder().encode("<svg/>"))).toBeNull();
    expect(stripImageMetadata(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });
});
