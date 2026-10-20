import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildFixtures, fixtureHash } from "@dockclock/clause-engine";
import { canonicalJson as evidenceCanonical } from "@dockclock/evidence";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { headline, recordedEvidence, run } from "../src/engine.js";
import { createHash as shimHash } from "../src/shims/node-crypto.js";
import type { ReplaySnapshot } from "../src/snapshot.js";
import { derToRaw, verifyPack } from "../src/verify.js";

const raw = readFileSync(new URL("../replay/example.json", import.meta.url), "utf8");
const snap = JSON.parse(raw) as ReplaySnapshot;
const pem = readFileSync(new URL("../public/keys/public-key.pem", import.meta.url), "utf8");

describe("judge desk", () => {
  it("rebuilds the signed bytes exactly as packages/evidence does", () => {
    expect(canonicalJson(snap.pack.pack)).toBe(evidenceCanonical(snap.pack.pack));
    expect(createHash("sha256").update(canonicalJson(snap.pack.pack)).digest("hex")).toBe(snap.pack.digestSha256);
  });

  it("verifies the example pack with WebCrypto and fails a changed copy", async () => {
    expect((await verifyPack(snap.pack.pack, snap.pack.signatureBase64, pem)).valid).toBe(true);
    const changed = structuredClone(snap.pack.pack) as { evaluation: { amountUsd: number } };
    changed.evaluation.amountUsd = 9999;
    expect((await verifyPack(changed, snap.pack.signatureBase64, pem)).valid).toBe(false);
  });

  it("serves the same public key the repository publishes", () => {
    expect(pem).toBe(readFileSync(new URL("../../docs/evidence/public-key.pem", import.meta.url), "utf8"));
  });

  it("converts DER signatures with short integers", () => {
    const der = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0x81, 0x02, 0x02, 0x01, 0x02]);
    const out = derToRaw(der, 4);
    expect(Array.from(out)).toEqual([0, 0, 0, 0x81, 0, 0, 1, 2]);
  });

  it("hashes like node:crypto in the browser shim, so the fixture hash matches the README", () => {
    const fixtures = buildFixtures();
    expect(shimHash("sha256").update(JSON.stringify(fixtures)).digest("hex")).toBe(fixtureHash(fixtures));
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(fixtureHash(fixtures).slice(0, 8));
  });

  it("shows the README headline numbers, computed by the clause engine", () => {
    const hl = headline();
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
    for (const n of [hl.owedUsd, hl.dockclockClaimedUsd, hl.baselineAskUsd, hl.baselineRefusableUsd]) expect(readme).toContain(usd(n));
    expect(readme).toContain(`${hl.loads} test loads`);
  });

  it("gets the recorded verdict back from the engine inputs in the snapshot", () => {
    const result = run(recordedEvidence(snap));
    expect(result.verdict).toBe(snap.verdict.verdict);
    expect(result.amountUsd).toBe(snap.verdict.amountUsd);
  });

  it("publishes nothing private", () => {
    expect(raw).not.toMatch(/"(lat|lon)"\s*:/);
    expect(raw).not.toMatch(/wamid\.HB/); // real WhatsApp ids encode the sender's number
    expect(raw).not.toMatch(/arn:aws|:\d{12}:|s3:\/\/|"s3Key"|packs\//);
    expect(raw).not.toMatch(/\+?1?\d{10,}\b/); // no phone-number-like digit runs
    expect(raw).not.toMatch(/"keyId"/);
    for (const m of snap.messages) expect(m.id).toMatch(/^m\d+$/);
  });
});
