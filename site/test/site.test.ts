import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildFixtures, fixtureHash } from "@dockclock/clause-engine";
import { canonicalJson as evidenceCanonical } from "@dockclock/evidence";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalWords, provedWords, runLabel, testStrip } from "../src/copy/provenance.js";
import { detailFromReplay } from "../src/model/fromReplay.js";
import { flowNodes } from "../src/model/flow.js";
import { detailFromApi } from "../src/model/fromApi.js";
import type { LoadView } from "../src/api.js";
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

  it("uses one brand mark everywhere", () => {
    const master = readFileSync(new URL("../public/brand-mark.svg", import.meta.url), "utf8");
    expect(readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8")).toBe(master);
    const pub = readdirSync(new URL("../public/", import.meta.url));
    expect(pub.filter((f) => f.endsWith(".svg")).sort()).toEqual(["brand-mark.svg", "favicon.svg", "logo.svg"]);
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

const replayDir = new URL("../replay/", import.meta.url);
const replays = readdirSync(replayDir).filter((f) => f.endsWith(".json"));

describe.each(replays)("replay %s", (file) => {
  const text = readFileSync(new URL(file, replayDir), "utf8");
  const s = JSON.parse(text) as ReplaySnapshot;
  const d = detailFromReplay(s, "replay");

  it("verifies its signed pack against the published key", async () => {
    expect((await verifyPack(s.pack.pack, s.pack.signatureBase64, pem)).valid).toBe(true);
  });

  it("gets its recorded verdict back from the clause engine", () => {
    const result = run(recordedEvidence(s));
    expect(result.verdict).toBe(s.verdict.verdict);
    expect(result.amountUsd).toBe(s.verdict.amountUsd);
  });

  it("publishes nothing private", () => {
    expect(text).not.toMatch(/"(lat|lon)"\s*:/);
    expect(text).not.toMatch(/wamid\.HB/);
    expect(text).not.toMatch(/arn:aws|s3:\/\/|"s3Key"|"keyId"/);
    expect(text).not.toMatch(/\+1\d{10}\b/);
  });

  it("never claims phone proof or a tap the records do not show", () => {
    const words = [runLabel(d), testStrip(d) ?? "", provedWords(d).short, provedWords(d).long, approvalWords(d).short, approvalWords(d).long, ...flowNodes(d).map((n) => n.title)].join(" | ");
    if (s.run.kind !== "phone" && s.run.kind !== "demo") expect(words).not.toMatch(/WhatsApp server times|RCS server times/);
    if (!(s.approval?.decision === "approve" && s.approval.approver === "dispatcher")) expect(words).not.toMatch(/tapped/i);
  });

  it("puts every agent run in the workflow graph, refusals included", () => {
    const nodes = flowNodes(d);
    expect(nodes.filter((n) => n.icon === "agent" || n.icon === "stop")).toHaveLength(s.agentRuns.length);
  });
});

// The API fixtures (site/fixtures/api) through the same adapters and copy rules.
const fxDir = new URL("../fixtures/api/loads/", import.meta.url);
const fxLoads = readdirSync(fxDir).filter((f) => /^[A-Za-z0-9-]+\.json$/.test(f));

describe.each(fxLoads)("API fixture %s", (file) => {
  const body = JSON.parse(readFileSync(new URL(file, fxDir), "utf8")) as { data?: LoadView; error?: unknown };
  const id = file.replace(/\.json$/, "");

  it("adapts to the console model and keeps copy honest", () => {
    if (!body.data) return;
    const d = detailFromApi(body.data, "fixture");
    expect(d.summary.id).toBe(id);
    const words = [runLabel(d), testStrip(d) ?? "", provedWords(d).short, provedWords(d).long, approvalWords(d).short, approvalWords(d).long, ...flowNodes(d).map((n) => n.title)].join(" | ");
    if (d.run.kind !== "phone" && d.run.kind !== "demo") expect(words).not.toMatch(/WhatsApp server times|RCS server times/);
    if (!(d.approval?.decision === "approve" && d.approval.approver === "dispatcher")) expect(words).not.toMatch(/tapped/i);
    for (const p of d.photos) expect(p.badge).not.toMatch(/real phone/);
  });

  it("verifies its signed pack when one is published", async () => {
    let raw: string;
    try {
      raw = readFileSync(new URL(`${id}.pack.json`, fxDir), "utf8");
    } catch {
      return;
    }
    const r = JSON.parse(raw) as { data?: { pack: unknown; signatureBase64: string } };
    if (!r.data) return;
    expect((await verifyPack(r.data.pack, r.data.signatureBase64, pem)).valid).toBe(true);
  });
});
