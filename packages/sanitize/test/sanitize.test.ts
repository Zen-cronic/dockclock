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

  it("refuses anything that is not a JPEG or PNG", () => {
    expect(sniffImage(new TextEncoder().encode("smoke bill of lading"))).toBeNull();
    expect(stripImageMetadata(new TextEncoder().encode("<svg/>"))).toBeNull();
    expect(stripImageMetadata(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull();
  });
});
