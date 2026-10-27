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
import { RUN_LABELS, type ReplaySnapshot } from "../src/snapshot.js";
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
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T19:07:00.000Z" }, tz)).toBe("Clock stopped at the Released tap 2:55 PM; pin late at 3:07 PM (12 min after the tap, limit 10), so a person reviews the load");
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T19:05:25.000Z" }, tz)).toBe("Clock stopped at the Released tap 2:55 PM; pin late at 3:05 PM (10.5 min after the tap, limit 10), so a person reviews the load");
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T18:40:00.000Z" }, tz)).toBe("Clock stopped at the Released tap 2:55 PM; pin early at 2:40 PM (15 min before the tap, limit 10), so a person reviews the load");
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "2026-10-23T19:05:00.000Z" }, tz)).toMatch(/pin confirmed 3:05 PM$/);
  });

  it("says a person reviews a load whose pin time does not parse, as the engine does", () => {
    const tz = "America/New_York";
    expect(releaseLine({ releasedAt: "2026-10-23T18:55:00.000Z", releasePinAt: "not a time" }, tz)).toBe("Clock stopped at the Released tap 2:55 PM; the pin's time could not be read, so a person reviews the load");
    expect(releaseLine({ releasedAt: "not a time", releasePinAt: "2026-10-23T18:57:00.000Z" }, tz)).toBe("The Released tap's time could not be read, so a person reviews the load");
    expect(REASON_WORDS.TIMESTAMP_UNREADABLE).toBe("an arrival or release time could not be read");
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

  it("never throws on a pin time that does not parse, and turns the switches off with a reason", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { moveRelease, UNREADABLE_NOTE, WhatIfPanel, QuickWhatIf } = await import("../src/ui/WhatIfPanel.js");
    const v = structuredClone(body.data);
    v.verdict!.engineInput.releasePinAt = "not a time";
    const d = detailFromApi(v, "fixture");
    const base = recordedInput(d)!;
    expect(() => moveRelease(base, tapAt)).not.toThrow();
    for (const w of whatIfs(d)) {
      const changed = w.apply(base);
      expect(run(changed), w.id).toMatchObject({ verdict: "NEEDS_HUMAN" });
    }
    const html = renderToStaticMarkup(createElement(WhatIfPanel, { load: d, initial: ["early"] }));
    expect(html).toContain(UNREADABLE_NOTE.replace("can't", "can&#x27;t"));
    expect(html).toMatch(/disabled=""/);
    expect(() => renderToStaticMarkup(createElement(QuickWhatIf, { load: d, ids: ["early", "pinLate"] }))).not.toThrow();
  });

  // The early release would put a readable release time in place of the unreadable one and show a
  // verdict beside the note that none can be given: a locked panel applies no switch at all.
  it("applies no preset switch while a recorded time does not parse", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { UNREADABLE_NOTE, WhatIfPanel } = await import("../src/ui/WhatIfPanel.js");
    const v = structuredClone(body.data);
    v.verdict!.engineInput.released!.at = "not a time";
    delete v.verdict!.engineInput.releasePinAt;
    const d = detailFromApi(v, "fixture");
    expect(whatIfs(d).find((w) => w.id === "early")?.applies).toBe(true);
    const html = renderToStaticMarkup(createElement(WhatIfPanel, { load: d, initial: ["early"] }));
    expect(html).toContain(UNREADABLE_NOTE.replace("can't", "can&#x27;t"));
    expect(html).toContain("Flip a switch to see what the contract decides.");
    expect(html).not.toMatch(/checked=""/);
  });
});

// Every time on a load set to one that does not parse, on every recorded API load and replay: the
// site model and the load page's parts must still build and draw, so a caller added later that
// does date arithmetic or formatting on a stored time without a guard fails here first.
describe("a load whose every time does not parse", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DockClockBand } = await import("../src/ui/DockClockBand.js");
  const { SignedFields } = await import("../src/routes/Judges.js");
  const { LoadHeader } = await import("../src/routes/LoadDetail.js");
  const { Timeline } = await import("../src/ui/Timeline.js");
  const { AgentFlow } = await import("../src/ui/AgentFlow.js");
  const { ConversationView } = await import("../src/ui/ConversationView.js");
  const { EmailView } = await import("../src/ui/EmailView.js");
  const { WhatIfPanel } = await import("../src/ui/WhatIfPanel.js");
  const { EvidencePanel } = await import("../src/ui/EvidencePanel.js");
  const ISO = /^\d{4}-\d{2}-\d{2}T/;
  const unreadable = <T,>(value: T): T => {
    if (typeof value === "string") return (ISO.test(value) ? "not a time" : value) as T;
    if (Array.isArray(value)) return value.map(unreadable) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unreadable(v)])) as T;
    return value;
  };
  const draw = (d: ReturnType<typeof detailFromApi>) => {
    const tz = d.timeZone;
    const parts = [
      createElement(DockClockBand, { load: d }),
      createElement(DockClockBand, { load: d, cursor: "not a time", compact: true }),
      createElement(SignedFields, { load: d }),
      createElement(LoadHeader, { load: d }),
      createElement(Timeline, { items: d.timeline, timeZone: tz, onOpen: () => undefined }),
      createElement(AgentFlow, { nodes: flowNodes(d), timeZone: tz }),
      createElement(ConversationView, { messages: d.messages, timeZone: tz, party: "driver" }),
      createElement(ConversationView, { messages: d.messages, timeZone: tz, party: "dispatcher" }),
      createElement(WhatIfPanel, { load: d }),
      ...d.emails.map((email) => createElement(EmailView, { email, timeZone: tz })),
      ...(d.pack ? [createElement(EvidencePanel, { pack: d.pack, timeZone: tz, photos: d.photos })] : []),
    ];
    for (const el of parts) expect(renderToStaticMarkup(el)).not.toMatch(/NaN|Invalid Date/);
  };

  it.each(fxLoads)("builds and draws %s", (file) => {
    const body = JSON.parse(readFileSync(new URL(file, fxDir), "utf8")) as { data?: LoadView };
    if (!body.data) return;
    const d = detailFromApi(unreadable(body.data), "fixture");
    expect(() => flowNodes(d)).not.toThrow();
    draw(d);
  });

  it.each(readdirSync(new URL("../replay/", import.meta.url)).filter((f) => f.endsWith(".json")))("builds and draws the replay %s", (file) => {
    const replay = JSON.parse(readFileSync(new URL(`../replay/${file}`, import.meta.url), "utf8")) as ReplaySnapshot;
    draw(detailFromReplay(unreadable(replay), "replay"));
  });
});

// The tamper switch moves what stopped the clock: the Released tap on a version 2 pack, the pin on v1.
describe("evidence tamper", async () => {
  const { EvidencePanel, releaseLocked, releaseMovable, tampered } = await import("../src/ui/EvidencePanel.js");
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

  // Moving an unreadable time threw a RangeError while the panel rendered, and the error boundary
  // replaced the console.
  it("leaves a release time that does not parse where it is, and turns the switch off", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    for (const events of [{ releasedTap: { serverAt: "garbage" }, released: { serverAt: at(18, 57) } }, { released: { serverAt: "not a time" } }]) {
      expect(tampered({ events }, on).events).toEqual(events);
      expect(releaseMovable({ events })).toBe(false);
      const pack = { ...snap.pack, pack: { ...snap.pack.pack, events: { ...(snap.pack.pack.events as object), releasedTap: null, ...events } } };
      const html = renderToStaticMarkup(createElement(EvidencePanel, { pack, timeZone: "America/New_York", photos: [] }));
      expect(html).toContain("time not readable");
      expect(html).not.toMatch(/NaN|Invalid/);
    }
    expect(releaseMovable({ events: { released: { serverAt: at(18, 57) } } })).toBe(true);
  });

  // A pack with no release time at all said "time not readable" too.
  it("says no release time was recorded when the pack has none", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    // Left out rather than set to undefined, which exactOptionalPropertyTypes does not allow.
    const events = Object.fromEntries(Object.entries(snap.pack.pack.events as object).filter(([key]) => key !== "released"));
    const pack = { ...snap.pack, pack: { ...snap.pack.pack, events: { ...events, releasedTap: null } } };
    expect(releaseLocked(pack.pack)).toBe("no release time recorded");
    const html = renderToStaticMarkup(createElement(EvidencePanel, { pack, timeZone: "America/New_York", photos: [] }));
    expect(html).toContain("no release time recorded");
    expect(html).not.toContain("time not readable");
    expect(releaseLocked({ events: { released: { serverAt: "garbage" } } })).toBe("time not readable");
    expect(releaseLocked({ events: { released: { serverAt: at(18, 57) } } })).toBeNull();
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

// The console API's runLabel and the Loads table's fallback read the same words.
describe("run labels", () => {
  it("gives a recorded API list the labels the site would fall back to", () => {
    const list = JSON.parse(readFileSync(new URL("../fixtures/api/loads.json", import.meta.url), "utf8")) as { data: { loads: Array<{ runKind: keyof typeof RUN_LABELS; runLabel?: string }> } };
    for (const l of list.data.loads) if (l.runLabel !== undefined) expect(l.runLabel).toBe(RUN_LABELS[l.runKind]);
    expect(RUN_LABELS.operator).toBe("Test load ∙ real tap");
  });

  it("gives the load page's badge the same words for every run kind", () => {
    const d = detailFromReplay(snap, "replay");
    for (const kind of Object.keys(RUN_LABELS) as Array<keyof typeof RUN_LABELS>) expect(runLabel({ run: { ...d.run, kind } })).toBe(RUN_LABELS[kind]);
    expect(runLabel({ run: { ...d.run, kind: "integration" } })).toBe("Test run");
  });
});

// A stored time that does not parse is shown as unreadable: formatting it would throw a RangeError,
// and the error boundary would replace the whole console.
describe("a load with a time that does not parse", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { DockClockBand, UNREADABLE_BAND_NOTE } = await import("../src/ui/DockClockBand.js");
  const { SignedFields } = await import("../src/routes/Judges.js");
  const { LoadHeader } = await import("../src/routes/LoadDetail.js");
  const { clock, clockSeconds, dateLong, dayLabel, zoneName } = await import("../src/format.js");
  const { UNREADABLE_CLOCK } = await import("@dockclock/clause-engine");
  const body = JSON.parse(readFileSync(new URL("SMOKE-DEMO-mvh3xsdv.json", fxDir), "utf8")) as { data: LoadView };

  it("formats it as unreadable instead of throwing", () => {
    for (const bad of ["not a time", "garbage", ""]) {
      expect(clock(bad, "America/New_York")).toBe(UNREADABLE_CLOCK);
      expect(clockSeconds(bad, "America/New_York")).toBe(UNREADABLE_CLOCK);
      expect(zoneName(bad, "America/New_York")).toBe("America/New_York");
      expect(() => dateLong(bad, "America/New_York")).not.toThrow();
      expect(() => dayLabel(bad, "America/New_York")).not.toThrow();
    }
  });

  it("draws the dock clock, the signed fields and the header with the time left off", () => {
    const v = structuredClone(body.data);
    Object.assign(v.clock, { arrivedAt: "garbage", releasedAt: "not a time", releasePinAt: "not a time" });
    v.timeline[0]!.at = "garbage";
    const d = detailFromApi(v, "fixture");
    for (const el of [createElement(DockClockBand, { load: d }), createElement(DockClockBand, { load: d, cursor: "garbage", compact: true }), createElement(SignedFields, { load: d }), createElement(LoadHeader, { load: d })]) {
      const html = renderToStaticMarkup(el);
      expect(html).not.toMatch(/NaN|Invalid/);
    }
    expect(renderToStaticMarkup(createElement(DockClockBand, { load: d }))).toContain("The Released tap&#x27;s time could not be read");
    // Only the arrival unreadable: the release line has nothing to say, the band note does.
    const arrival = structuredClone(body.data);
    Object.assign(arrival.clock, { arrivedAt: "garbage" });
    expect(renderToStaticMarkup(createElement(DockClockBand, { load: detailFromApi(arrival, "fixture") }))).toContain(UNREADABLE_BAND_NOTE);
  });

  // A load that left the dock but whose release (or close) time does not parse was drawn as still at
  // the dock, its clock running to "as of".
  it("never runs the clock to as of for a load past the dock whose stop time does not parse", () => {
    const asOf = "2026-10-30T12:00:00.000Z";
    const live = (clock: Partial<LoadView["clock"]>, status: LoadView["summary"]["status"]) => {
      const v = structuredClone(body.data);
      Object.assign(v.summary, { live: true, status });
      Object.assign(v.clock, { asOf, releasePinAt: null, endedAt: null, ...clock });
      return renderToStaticMarkup(createElement(DockClockBand, { load: detailFromApi(v, "fixture") }));
    };
    for (const [clock, status] of [
      [{ releasedAt: "not a time" }, "awaiting_approval"],
      [{ releasedAt: "not a time" }, "at_dock"],
      [{ releasedAt: null, endedAt: "garbage" }, "closed"],
      [{ releasedAt: null }, "sealing"],
    ] as const) {
      const html = live(clock, status);
      expect(html, JSON.stringify(clock)).not.toContain("cursor live");
      expect(html, JSON.stringify(clock)).not.toMatch(/NaN|Invalid|ended without a release/);
      if (clock.releasedAt !== null || "endedAt" in clock) expect(html, JSON.stringify(clock)).toContain(UNREADABLE_BAND_NOTE);
    }
    // Still at the dock with nothing stopped: the clock runs to as of.
    expect(live({ releasedAt: null }, "at_dock")).toContain("cursor live");
  });

  // An older load that ended with no release time ends its clock at its last record. Sorted as
  // strings, 19:00Z came after 16:30-04:00 (20:30Z), and the clock ended an hour and a half early.
  it("ends a stopped load's clock at its latest record compared as instants, not as strings", () => {
    const v = structuredClone(body.data);
    Object.assign(v.summary, { live: false, status: "closed" });
    Object.assign(v.clock, { arrivedAt: "2026-10-23T18:00:00.000Z", releasedAt: null, releasePinAt: null, endedAt: null, clockStartAt: null, freeTimeEndsAt: null });
    v.timeline = [
      { ...v.timeline[0]!, id: "a", at: "2026-10-23T19:00:00Z" },
      { ...v.timeline[0]!, id: "b", at: "2026-10-23T16:30:00-04:00" },
    ];
    const html = renderToStaticMarkup(createElement(DockClockBand, { load: detailFromApi(v, "fixture") }));
    expect(html).toContain('aria-label="2:30 hours and minutes at the dock"');
  });

  // As the read API does (endedAtOf), the arrival counts as a record: a clock never ends before it.
  it("never ends a stopped load's clock before its arrival", () => {
    const v = structuredClone(body.data);
    Object.assign(v.summary, { live: false, status: "closed" });
    Object.assign(v.clock, { arrivedAt: "2026-10-23T18:00:00.000Z", releasedAt: null, releasePinAt: null, endedAt: null, clockStartAt: null, freeTimeEndsAt: null });
    v.timeline = [{ ...v.timeline[0]!, id: "a", at: "2026-10-23T17:00:00Z" }];
    const html = renderToStaticMarkup(createElement(DockClockBand, { load: detailFromApi(v, "fixture") }));
    expect(html).toContain('aria-label="0:00 hours and minutes at the dock"');
  });
});
