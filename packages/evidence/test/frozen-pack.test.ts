import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packBytes, sha256Hex, verifyPack, type SignedPack } from "../src/index.js";

// The pack in docs/evidence was sealed by the deployed stack with the real KMS key. CI checks it
// still verifies against the published public key, so the repository's offline check stays honest.
const docs = new URL("../../../docs/evidence/", import.meta.url);
const signed = JSON.parse(readFileSync(new URL("SMOKE-mve8yfv3.pack.json", docs), "utf8")) as SignedPack;
const manifest = JSON.parse(readFileSync(new URL("MANIFEST.json", docs), "utf8")) as { pack: { packDigestSha256: string; amountUsd: number } };
const key = createPublicKey(readFileSync(new URL("public-key.pem", docs), "utf8")).export({ format: "der", type: "spki" });

describe("published evidence pack", () => {
  it("verifies against the published KMS public key", () => {
    expect(verifyPack(signed, key)).toBe(true);
  });

  it("matches its manifest", () => {
    expect(sha256Hex(packBytes(signed.pack))).toBe(manifest.pack.packDigestSha256);
    expect(signed.pack.evaluation.amountUsd).toBe(manifest.pack.amountUsd);
  });

  it("fails once anything in it changes", () => {
    expect(verifyPack({ ...signed, pack: { ...signed.pack, evaluation: { ...signed.pack.evaluation, amountUsd: 91.99 } } }, key)).toBe(false);
    expect(verifyPack({ ...signed, pack: { ...signed.pack, sealedAt: "2026-10-19T00:00:00.000Z" } }, key)).toBe(false);
  });

  it("holds no coordinates, phone numbers or email addresses", () => {
    const text = JSON.stringify(signed.pack);
    expect(text).not.toMatch(/"(lat|lon|latitude|longitude)"/);
    expect(text).not.toMatch(/\+\d{10,}/);
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });
});
