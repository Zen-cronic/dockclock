import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { matchRoutes, type RouteObject } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { routeTree, type RouteName } from "../src/routes/table.js";
import { readFileSync } from "node:fs";
import type { LoadView } from "../src/api.js";
import { HERO_LOAD, buildStory, heroStory } from "../src/landing/story.js";
import { Provenance, StaticHero, Storyboard } from "../src/landing/HeroPlayer.js";
import { WaitScene } from "../src/landing/WaitScene.js";
import { stayProofWords } from "../src/copy/provenance.js";

const names: RouteName[] = ["landing", "shell", "overview", "messages", "loads", "load", "judges", "fallback"];
const tree = routeTree(Object.fromEntries(names.map((n) => [n, n])) as Record<RouteName, string>);
// typed loosely: RouteObject and the matcher's route type disagree under exactOptionalPropertyTypes
const match = (path: string) => matchRoutes(tree as never[], path) as Array<{ route: RouteObject }> | null;
const leaf = (path: string) => match(path)?.at(-1)?.route.element;

describe("routes", () => {
  it("puts the landing page at / and the console overview at /overview", () => {
    expect(leaf("/")).toBe("landing");
    expect(leaf("/overview")).toBe("overview");
  });

  it("keeps every published console path where it was", () => {
    expect(leaf("/judges")).toBe("judges");
    expect(leaf("/judges/proved")).toBe("judges");
    expect(leaf("/judges/signed")).toBe("judges");
    expect(leaf("/messages")).toBe("messages");
    expect(leaf("/loads")).toBe("loads");
    expect(leaf("/loads/LIVE-mvlb0qzq")).toBe("load");
    expect(leaf("/loads/LIVE-mvlb0qzq/evidence")).toBe("load");
    expect(match("/judges")?.[0]?.route.element).toBe("shell");
  });

  it("sends an unknown path to the fallback inside the shell", () => {
    expect(leaf("/nope")).toBe("fallback");
  });
});

describe("landing hero", () => {
  const story = heroStory();

  it("builds six chapters from the featured load's recorded responses", () => {
    expect(story).not.toBeNull();
    expect(story!.load.summary.id).toBe(HERO_LOAD);
    expect(story!.chapters.map((c) => c.key)).toEqual(["dispatched", "arrived", "notice", "released", "approved", "filed"]);
  });

  it("dates every chapter with a recorded time, in order", () => {
    const s = story!;
    const recorded = new Set([...s.load.messages.map((m) => m.at), ...s.load.emails.map((e) => e.sentAt), s.load.approval?.decidedAt]);
    for (const c of s.chapters) expect(recorded.has(c.at)).toBe(true);
    const times = s.chapters.map((c) => Date.parse(c.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("shows every recorded driver and dispatcher message once, and nothing else", () => {
    const s = story!;
    const shown = s.chapters.flatMap((c) => c.beats.flatMap((b) => (b.message ? [b.message.id] : [])));
    const recorded = [...s.thread.driver, ...s.thread.dispatcher].filter((m) => Date.parse(m.at) <= Date.parse(s.chapters.at(-1)!.at)).map((m) => m.id);
    expect([...shown].sort()).toEqual([...recorded].sort());
  });

  it("renders the storyboard with its provenance and no phone numbers, message ids or coordinates", () => {
    const html = renderToStaticMarkup(createElement(Storyboard, { story: story! }));
    expect(html).toContain("Recorded from a real load on a real phone");
    expect(html).toContain("the companies are fictional");
    expect(html).not.toMatch(/\+\d{7,}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{10,}\b/);
    expect(html).not.toMatch(/wamid/i);
    expect(html).not.toMatch(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/);
  });
});

// Monday's take replaces the hero load: a load whose Released tap ends the clock and whose photo is
// readable must build the same story. SMOKE-DEMO-mvh3xsdv stands in (a test load on the demo clause).
describe("landing hero on another load", () => {
  const raw = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/api/loads/${name}.json`, import.meta.url), "utf8")) as { data: LoadView };
  const base = () => structuredClone(raw("SMOKE-DEMO-mvh3xsdv").data);

  it("builds its chapters from a load with a Released tap (approved by a test command, so no dispatcher phone)", () => {
    const s = buildStory(base(), {})!;
    expect(s.chapters.map((c) => c.key)).toEqual(["dispatched", "arrived", "notice", "released", "filed"]);
    expect(s.chapters.find((c) => c.key === "released")!.at).toBe(s.load.clock.releasedAt);
  });

  it("dates Released at the tap when the tap ended the clock", () => {
    const v = base();
    const tap = v.messages.filter((m) => m.purpose === "tap_released").at(-1)!;
    v.clock.releasedAt = tap.at;
    const s = buildStory(v, {})!;
    const released = s.chapters.find((c) => c.key === "released")!;
    expect(released.at).toBe(tap.at);
    expect(released.caption).toMatch(/Released tap stops the clock/);
  });

  it("leaves out chapters the load does not have", () => {
    const v = base();
    v.emails = v.emails.filter((e) => e.purpose !== "notice");
    v.messages = v.messages.filter((m) => m.party !== "dispatcher");
    const s = buildStory(v, {})!;
    expect(s.chapters.map((c) => c.key)).toEqual(["dispatched", "arrived", "released", "filed"]);
    const shown = s.chapters.flatMap((c) => c.beats.flatMap((b) => (b.message ? [b.message.id] : [])));
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("states real-phone provenance from the records, not from the run kind alone", () => {
    const line = (kind: "phone" | "demo" | "integration", times: "recorded" | "synthetic_input") => {
      const v = base();
      v.summary.runKind = kind;
      v.run.kind = kind;
      v.clock.driverTimes = times;
      return renderToStaticMarkup(createElement(Provenance, { story: buildStory(v, {})! }));
    };
    // A DEMO run recorded on a real phone carries WhatsApp's server times.
    expect(line("demo", "recorded")).toMatch(/real phone.*WhatsApp server times/);
    // A phone run whose driver times were synthetic does not.
    expect(line("phone", "synthetic_input")).toContain("test load with synthetic driver messages");
    expect(line("phone", "synthetic_input")).not.toContain("WhatsApp server times");
    expect(line("integration", "synthetic_input")).not.toMatch(/real phone|WhatsApp server times/);
  });

  it("shows the bill-of-lading photo only when it was readable", () => {
    const v = base();
    expect(buildStory(v, {})!.bolPhoto).toBeNull();
    v.photos = [{ ...(raw("LIVE-mvlb0qzq").data.photos[0]!), legible: true, url: "photos/LIVE-mvlb0qzq-1.jpg" }];
    expect(buildStory(v, {}, (u) => `/x/${u}`)!.bolPhoto).toBe("/x/photos/LIVE-mvlb0qzq-1.jpg");
    expect(heroStory()!.bolPhoto).toBeNull();
  });
});

// The landing's claims about pins, times and the contract come from the load, never from the hero's.
describe("landing claims follow the load", () => {
  const raw = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/api/loads/${name}.json`, import.meta.url), "utf8")) as { data: LoadView };
  const wait = (v: LoadView) => renderToStaticMarkup(createElement(WaitScene, { story: buildStory(v, {})!, reduced: true }));

  it("keeps the hero's own wording for the hero load", () => {
    const s = heroStory()!;
    expect(wait(raw(HERO_LOAD).data)).toContain("Demo contract: 5 minutes free, $60 an hour. The clock runs on WhatsApp&#x27;s own timestamps.");
    expect(stayProofWords(s.load, s.endedBy)).toBe("Two location pins, each with WhatsApp's server time.");
  });

  it("says a test load's times were replayed, and names the Released tap when it ended the clock", () => {
    const v = structuredClone(raw("SMOKE-DEMO-mvh3xsdv").data);
    const html = wait(v);
    expect(html).not.toMatch(/WhatsApp&#x27;s own timestamps|server time/);
    expect(html).toContain("The clock runs on the replayed test times.");
    const tap = v.messages.filter((m) => m.purpose === "tap_released").at(-1)!;
    v.clock.releasedAt = tap.at;
    const s = buildStory(v, {})!;
    expect(s.endedBy).toBe("released_tap");
    expect(stayProofWords(s.load, s.endedBy)).toBe("The arrival pin and the Released tap, replayed as test messages with set times.");
  });

  it("names a contract that is not the demo clause, and leaves out a rate the record lacks", () => {
    const v = structuredClone(raw("SMOKE-mvh1bmmu").data);
    expect(wait(v)).toContain("Contract: 120 minutes free, $60 an hour.");
    expect(wait(v)).not.toContain("Demo contract");
    delete (v.clause as Partial<typeof v.clause>).ratePerHourUsd;
    const html = wait(v);
    expect(html).toContain("Contract: 120 minutes free.");
    expect(html).not.toMatch(/\$\d+ an hour/);
  });
});

// The wait scene draws only a finished stay, and its heading follows the record.
describe("wait scene on other loads", () => {
  const raw = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/api/loads/${name}.json`, import.meta.url), "utf8")) as { data: LoadView };
  const wait = (v: LoadView) => renderToStaticMarkup(createElement(WaitScene, { story: buildStory(v, {})!, reduced: true }));
  const widths = (html: string) => [...html.matchAll(/(?:width|left):\s*([-\d.]+)%/g)].map((m) => Number(m[1]));

  it("draws nothing for a load that was never released", () => {
    const v = structuredClone(raw(HERO_LOAD).data);
    v.clock.releasedAt = null;
    expect(buildStory(v, {})).not.toBeNull();
    expect(wait(v)).toBe("");
  });

  it("keeps a load released inside free time on the track and does not call it owed", () => {
    const v = structuredClone(raw(HERO_LOAD).data);
    v.clock.releasedAt = new Date(Date.parse(v.clock.arrivedAt!) + 3 * 60_000).toISOString();
    v.verdict!.verdict = "NOT_BILLABLE";
    const html = wait(v);
    expect(html).not.toMatch(/NaN|Invalid/);
    expect(html).toContain("3 minutes at the door, inside 5 minutes of free time. Nothing was owed.");
    expect(html).not.toContain("were owed");
    for (const w of widths(html)) expect(w).toBeLessThanOrEqual(100);
    expect(html).not.toContain("Free time ends");
  });

  it("says the contract owed nothing past free time on a load it does not pay", () => {
    const html = wait(raw("SMOKE-RCS-mvh338l2").data);
    expect(html).toContain("The contract owed nothing for the rest.");
    expect(html).not.toContain("were owed");
  });

  it("says the rest were owed on the hero load", () => {
    expect(wait(raw(HERO_LOAD).data)).toMatch(/minutes at the door\. 5 were free\. The rest were owed\./);
  });
});

// Reduced motion shows one still frame: the filed claim, or the last chapter on its own device.
describe("static hero", () => {
  const raw = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/api/loads/${name}.json`, import.meta.url), "utf8")) as { data: LoadView };
  const still = (v: LoadView) => {
    const story = buildStory(v, {})!;
    return { story, html: renderToStaticMarkup(createElement(StaticHero, { story, onPlay: () => {} })) };
  };

  it("shows the filed claim in the receiver's inbox", () => {
    const { html } = still(raw(HERO_LOAD).data);
    expect(html).toContain("Receiver&#x27;s inbox");
  });

  it("labels and draws the last chapter's phone when no claim was emailed", () => {
    const v = structuredClone(raw("SMOKE-DEMO-mvh3xsdv").data);
    v.emails = v.emails.filter((e) => e.purpose !== "claim");
    const { story, html } = still(v);
    const last = story.chapters.at(-1)!;
    expect(last.screen).toEqual({ kind: "phone", party: "driver" });
    expect(html).toContain("Driver&#x27;s phone");
    expect(html).not.toContain("Receiver&#x27;s inbox");
    // The phone holds the driver's messages up to that chapter's end, not an empty plate.
    const driverShown = new Set(story.chapters.flatMap((c) => c.beats.flatMap((b) => (b.message?.party === "driver" ? [b.message.id] : []))));
    expect(driverShown.size).toBeGreaterThan(0);
    expect(html.match(/class="bub /g)?.length).toBe(driverShown.size);
  });
});
