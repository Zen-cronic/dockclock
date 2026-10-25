import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { matchRoutes, type RouteObject } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { routeTree, type RouteName } from "../src/routes/table.js";
import { HERO_LOAD, heroStory } from "../src/landing/story.js";
import { Storyboard } from "../src/landing/HeroPlayer.js";

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
    expect(html).toContain("The companies are fictional");
    expect(html).not.toMatch(/\+\d{7,}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b|\b\d{10,}\b/);
    expect(html).not.toMatch(/wamid/i);
    expect(html).not.toMatch(/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/);
  });
});
