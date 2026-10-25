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
import { filterFeed, orderFeed, parseSort } from "../src/model/feedOrder.js";
import type { FeedRow } from "../src/model/model.js";

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
    // "real phone" is true only for a photo a real-phone run took with the phone's camera.
    const cameraShots = new Set((body.data.photos ?? []).filter((p) => p.source === "phone_camera").map((p) => p.sha256));
    for (const p of d.photos) if (!(d.run.kind === "phone" && cameraShots.has(p.sha256))) expect(p.badge).not.toMatch(/real phone/);
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

// A sealed load whose approval nobody answered: the workflow marks approval failed and the claim
// skipped. The copy and the graph must say so, not "Awaiting approval".
describe("an approval nobody answered", () => {
  const body = JSON.parse(readFileSync(new URL("SMOKE-DEMO-mvh3xsdv.json", fxDir), "utf8")) as { data: LoadView };
  const v = structuredClone(body.data);
  v.approval = { requestedAt: "2026-10-21T07:31:30.558Z", decidedAt: null, decision: null, approver: "dispatcher" } as LoadView["approval"];
  v.claim = null as LoadView["claim"];
  v.emails = v.emails.filter((e) => e.purpose !== "claim");
  v.agentRuns = [];
  v.workflow = [
    { key: "approval", label: "Dispatch approved the claim", state: "failed", at: null, services: ["Step Functions"], detail: "No answer within two days, so nothing was sent." },
    { key: "claim", label: "AI agent filed the claim by email", state: "skipped", at: null, services: ["SES"], detail: "Not filed: no approval." },
  ];
  v.timeline = [...v.timeline, { ...v.timeline[0]!, id: "timeout", at: "2026-10-23T07:31:30.966Z", title: "Approval timed out after two days; dispatch emailed, nothing filed", tone: "refused" }];
  const d = detailFromApi(v, "fixture");

  it("says nobody answered and nothing was filed", () => {
    expect(approvalWords(d).short).toBe("No answer from dispatch");
    const titles = flowNodes(d).map((n) => n.title);
    expect(titles).toContain("No answer from dispatch");
    expect(titles).toContain("Claim not filed");
    expect(titles.join(" | ")).not.toMatch(/tapped|Awaiting/i);
  });

  it("claims no bill-of-lading match when no bill of lading was checked", () => {
    const noBol = { ...d, verdict: d.verdict ? { ...d.verdict, signals: d.verdict.signals.filter((s) => !s.name.startsWith("bol_")) } : null };
    expect(provedWords(noBol).long).not.toMatch(/bill-of-lading/);
  });
});

// The judges path: one broker denial per step, and the what-ifs it shows each flip the verdict.
describe("judges path", async () => {
  const { JUDGE_STEPS } = await import("../src/routes/Judges.js");
  const { earlyRelease, recordedInput, whatIfs } = await import("../src/ui/WhatIfPanel.js");
  const { acceptsAnyLocation } = await import("../src/copy/provenance.js");
  const body = JSON.parse(readFileSync(new URL("SMOKE-DEMO-mvh3xsdv.json", fxDir), "utf8")) as { data: LoadView };
  const d = detailFromApi(body.data, "fixture");

  it("has seven steps, with notice and without the old signed step", () => {
    expect(JUDGE_STEPS).toEqual(["start", "proved", "notice", "filed", "break", "change", "phone"]);
  });

  it("never says a judge-demo pin was checked against a yard", () => {
    expect(acceptsAnyLocation(d)).toBe(true);
  });

  it("moves the early release inside free time but after the arrival", () => {
    const e = earlyRelease(d)!;
    expect(Date.parse(e.out)).toBeGreaterThan(Date.parse(d.clock.arrivedAt!));
    expect(Date.parse(e.out)).toBeLessThan(Date.parse(d.clock.freeTimeEndsAt!));
  });

  it("turns each of the three judge what-ifs into not owed", () => {
    const base = recordedInput(d)!;
    expect(run(base).verdict).toBe("BILLABLE");
    const shown = whatIfs(d).filter((w) => ["early", "noticeLate", "window"].includes(w.id) && w.applies);
    expect(shown.map((w) => w.id)).toEqual(["early", "noticeLate", "window"]);
    for (const w of shown) expect(run(w.apply(base)).verdict).toBe("NOT_BILLABLE");
  });
});

// The Released tap stops the clock; the pin confirms it within 10 minutes (RELEASE_PIN_LATE otherwise).
describe("release tap and pin", async () => {
  const { recordedInput, whatIfs } = await import("../src/ui/WhatIfPanel.js");
  const { releaseLine } = await import("../src/copy/provenance.js");
  const { REASON_WORDS, recordedEvidence } = await import("../src/engine.js");
  const body = JSON.parse(readFileSync(new URL("SMOKE-DEMO-mvh3xsdv.json", fxDir), "utf8")) as { data: LoadView };
  const tapAt = body.data.verdict!.engineInput.released!.at;
  const late = new Date(Date.parse(tapAt) + 12 * 60_000).toISOString();

  it("names the late pin in words", () => {
    expect(REASON_WORDS.RELEASE_PIN_LATE).toBe("the release location was not shared within 10 minutes of tapping Released");
  });

  it("passes the pin time to the engine, so a late pin reproduces its verdict", () => {
    const v = structuredClone(body.data);
    v.verdict!.engineInput.releasePinAt = late;
    const d = detailFromApi(v, "fixture");
    expect(run(recordedInput(d)!).reasons).toContain("RELEASE_PIN_LATE");
    const s = structuredClone(snap);
    s.verdict.engineInput.releasePinAt = new Date(Date.parse(s.verdict.engineInput.released!.at) + 12 * 60_000).toISOString();
    expect(recordedEvidence(s).releasePinAt).toBe(s.verdict.engineInput.releasePinAt);
    expect(run(recordedEvidence(s)).reasons).toContain("RELEASE_PIN_LATE");
  });

  it("offers the late-pin what-if only on a load with a tap and a pin", () => {
    const d = detailFromApi(body.data, "fixture");
    expect(whatIfs(d).find((w) => w.id === "pinLate")?.applies).toBe(Boolean(body.data.verdict!.engineInput.releasePinAt));
    const v = structuredClone(body.data);
    v.verdict!.engineInput.releasePinAt = new Date(Date.parse(tapAt) + 2 * 60_000).toISOString();
    const withPin = detailFromApi(v, "fixture");
    const pinLate = whatIfs(withPin).find((w) => w.id === "pinLate")!;
    expect(pinLate.applies).toBe(true);
    expect(run(recordedInput(withPin)!).reasons).not.toContain("RELEASE_PIN_LATE");
    expect(run(pinLate.apply(recordedInput(withPin)!)).reasons).toContain("RELEASE_PIN_LATE");
  });

  it("says the clock stopped at the tap and the pin confirmed it; an old pack shows the pin alone", () => {
    const tz = "America/New_York";
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T18:57:00.000Z" }, tz)).toBe("Clock stopped at the Released tap 2:55 PM; pin confirmed 2:57 PM");
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z" }, tz)).toBeNull();
    expect(releaseLine({ releasedAt: null, endedAt: "2026-10-26T18:55:00.000Z" }, tz)).toMatch(/ended without a release/);
  });

  it("says a late pin was late, not confirmed", () => {
    const tz = "America/New_York";
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T19:07:00.000Z" }, tz)).toBe("Clock stopped at the Released tap 2:55 PM; pin late at 3:07 PM (12 min, limit 10), so a person reviews the load");
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T19:05:00.000Z" }, tz)).toMatch(/pin confirmed 3:05 PM$/);
  });

  it("moves the release pin with an early Released tap, so the what-if turns on free time", async () => {
    const { moveRelease } = await import("../src/ui/WhatIfPanel.js");
    const v = structuredClone(body.data);
    v.verdict!.engineInput.releasePinAt = new Date(Date.parse(tapAt) + 2 * 60_000).toISOString();
    const d = detailFromApi(v, "fixture");
    const early = whatIfs(d).find((w) => w.id === "early")!;
    const moved = early.apply(recordedInput(d)!);
    expect(Date.parse(moved.releasePinAt!) - Date.parse(moved.released!.at)).toBe(2 * 60_000);
    const result = run(moved);
    expect(result.verdict).toBe("NOT_BILLABLE");
    expect(result.reasons).toContain("WITHIN_FREE_TIME");
    expect(result.reasons).not.toContain("RELEASE_PIN_LATE");
    // A recorded gap past the window is held inside it, and a load without a pin gains none.
    const base = recordedInput(d)!;
    const wide = moveRelease({ ...base, releasePinAt: new Date(Date.parse(tapAt) + 30 * 60_000).toISOString() }, tapAt);
    expect(Date.parse(wide.releasePinAt!) - Date.parse(tapAt)).toBe(10 * 60_000);
    const noPin = { ...base };
    delete noPin.releasePinAt;
    expect(moveRelease(noPin, tapAt).releasePinAt).toBeUndefined();
  });
});

// The tamper switch moves what stopped the clock: the Released tap on a version 2 pack, the pin on v1.
describe("evidence tamper", async () => {
  const { tampered } = await import("../src/ui/EvidencePanel.js");
  const at = (h: number, m: number) => `2026-10-23T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;
  const on = { amount: false, release: true, check: false };

  it("moves the Released tap, not the pin, on a pack whose clock stopped at the tap", () => {
    const pack = { events: { releasedTap: { serverAt: at(18, 55) }, released: { serverAt: at(18, 57) } } };
    const now = tampered(pack, on);
    expect(now.events?.releasedTap?.serverAt).toBe(at(19, 25));
    expect(now.events?.released?.serverAt).toBe(at(18, 57));
    expect(pack.events.releasedTap.serverAt).toBe(at(18, 55));
  });

  it("moves the release pin on an older pack without a tap", () => {
    const now = tampered({ events: { released: { serverAt: at(18, 57) } } }, on);
    expect(now.events?.released?.serverAt).toBe(at(19, 27));
  });
});

describe("message monitor order", () => {
  const row = (id: string, loadId: string, at: string, over: Partial<FeedRow> = {}): FeedRow => ({
    id, at, loadId, runKind: "integration", channel: "whatsapp", direction: "out", party: "driver", purpose: "notice", preview: "", status: "delivered", failover: false, synthetic: false, localId: id, isEmail: false, ...over,
  });
  // Load names sort the opposite way to their activity: AAA is oldest, ZZZ newest.
  const rows = [
    row("a1", "AAA-old", "2026-10-21T14:00:00.000Z"),
    row("z1", "ZZZ-new", "2026-10-23T19:37:00.000Z", { channel: "rcs", status: "not_sent" }),
    row("m1", "MMM-mid", "2026-10-22T18:30:00Z"),
    row("z2", "ZZZ-new", "2026-10-23T15:00:00.000Z", { channel: "email", status: "failed" }),
    row("a2", "AAA-old", "2026-10-23T16:00:00.000Z", { status: "received", direction: "in" }),
  ];
  const ids = (r: FeedRow[]) => r.map((m) => m.id);

  it("defaults to newest first, by time and not by load name", () => {
    expect(parseSort(null)).toBe("newest");
    expect(parseSort("nonsense")).toBe("newest");
    expect(ids(orderFeed(rows, parseSort(null)))).toEqual(["z1", "a2", "z2", "m1", "a1"]);
  });

  it("reverses to oldest first", () => {
    expect(ids(orderFeed(rows, parseSort("oldest")))).toEqual(["a1", "m1", "z2", "a2", "z1"]);
  });

  it("groups by load name, newest first inside each load", () => {
    expect(ids(orderFeed(rows, parseSort("load")))).toEqual(["a2", "a1", "m1", "z1", "z2"]);
  });

  it("keeps the channel and status filters with any sort", () => {
    expect(ids(orderFeed(filterFeed(rows, "whatsapp", "All"), "newest"))).toEqual(["a2", "m1", "a1"]);
    expect(ids(orderFeed(filterFeed(rows, "whatsapp", "Delivered"), "oldest"))).toEqual(["a1", "m1"]);
    expect(ids(orderFeed(filterFeed(rows, null, "Failed"), "newest"))).toEqual(["z2"]);
  });
});

// The 3 s poll re-renders a drawer's parent with a new inline onClose; the focus trap must not
// re-run (and reset focus) on each one. There is no DOM in these tests, so this reads the source.
describe("drawer focus", () => {
  it("runs the focus trap once per open, not on every new onClose", () => {
    const src = readFileSync(new URL("../src/ui/Drawer.tsx", import.meta.url), "utf8");
    expect(src).not.toMatch(/\[onClose\]/);
    expect(src).toMatch(/close\.current = onClose/);
    expect(src).toMatch(/\}, \[\]\);/);
  });
});

// One failed live fetch must not strand the console on recorded data.
describe("live fallback and recovery", async () => {
  const { ApiFetchError, backoffMs, failureOf, refetchMs, withFallback, POLL_MS } = await import("../src/model/fetching.js");
  const down = (status: number | null) => async () => {
    throw status === null ? new ApiFetchError("unavailable", null, "network") : failureOf(status, `HTTP ${status}`);
  };

  it("tells a real 404 from a 5xx, a 429 or a network failure", () => {
    expect(failureOf(404, "x").kind).toBe("not_found");
    for (const status of [500, 502, 503, 429, 400]) expect(failureOf(status, "x").kind).toBe("unavailable");
  });

  it("falls back to recorded data while live fails, keeps retrying with backoff, and recovers", async () => {
    let failures = 0;
    for (const expected of [1, 2, 3]) {
      const out = await withFallback({ live: down(503), fixture: () => "recorded", replay: () => "replay", failuresBefore: failures });
      expect(out).toMatchObject({ data: "recorded", source: "fixture", fallback: true, liveError: "unavailable", liveFailures: expected });
      failures = out.liveFailures;
      expect(refetchMs(out)).toBe(backoffMs(expected));
    }
    expect([1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([POLL_MS, 6000, 12000, 24000, 30000, 30000]);
    const back = await withFallback({ live: async () => ({ data: "live", pollMs: 3000 }), fixture: () => "recorded", replay: () => "replay", failuresBefore: failures });
    expect(back).toMatchObject({ data: "live", source: "live", fallback: false, liveFailures: 0 });
    expect(refetchMs(back)).toBe(POLL_MS);
  });

  it("keeps retrying a judge's own load that has no recording, so the page can say Reconnecting", async () => {
    const out = await withFallback<string, null>({ live: down(null), fixture: () => { throw new Error("no fixture"); }, replay: () => null, failuresBefore: 0 });
    expect(out).toMatchObject({ data: null, source: "replay", fallback: true, liveError: "unavailable" });
    expect(refetchMs(out, { onlyWhilePolling: true })).toBe(POLL_MS);
  });

  it("stops on a real 404 with nothing recorded: the load is not found", async () => {
    const out = await withFallback<string, null>({ live: down(404), fixture: () => { throw new Error("no fixture"); }, replay: () => null, failuresBefore: 2 });
    expect(out).toMatchObject({ data: null, fallback: false, liveError: "not_found", liveFailures: 0 });
    expect(refetchMs(out)).toBe(false);
  });

  it("stops polling a finished live load and never polls recorded-only data", () => {
    expect(refetchMs({ source: "live", fallback: false, liveFailures: 0, pollMs: null }, { onlyWhilePolling: true })).toBe(false);
    expect(refetchMs({ source: "replay", fallback: false, liveFailures: 0, pollMs: null })).toBe(false);
  });
});
