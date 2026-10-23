import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JUDGE_DEMO_CLAUSE, RELEASE_PIN_WINDOW_MINUTES } from "@dockclock/clause-engine";
import { JUDGE_DEMO_FACILITY } from "@dockclock/evidence";
import { DEMO_MINUTES, PER_SENDER_PER_DAY } from "../src/demo.js";
import { RETAKE_WAIT_SECONDS } from "../src/retake.js";

// The README and FACTS are claims about this code. These checks fail the build when the words and
// the code drift apart.
const root = new URL("../../", import.meta.url);
const readme = readFileSync(new URL("README.md", root), "utf8");
const facts = readFileSync(new URL("FACTS.md", root), "utf8");
const STATUS = /^(live \((phone|operator|integration|eval)\)|tested|sourced|derived|planned|stated limit)$/;

// Every table row, whether it has an evidence column (claim | evidence | status) or not (claim | status).
function factRows(): Array<{ claim: string; evidence: string; status: string }> {
  return facts
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*(Claim|---)/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 2 || cells.length === 3)
    .map((cells) => ({ claim: cells[0]!, evidence: cells.length === 3 ? cells[1]! : "", status: cells.at(-1)! }));
}

describe("README and FACTS match the code", () => {
  it("states the judge demo's numbers as the code has them", () => {
    const { freeTimeMinutes, ratePerHourUsd, capUsdPerOccurrence } = JUDGE_DEMO_CLAUSE;
    expect(readme).toContain(`Free time is ${freeTimeMinutes} minutes`);
    expect(readme).toContain(`(${freeTimeMinutes} minutes free, $${ratePerHourUsd} an hour, $${capUsdPerOccurrence} cap`);
    expect(readme).toContain(`Each number gets ${PER_SENDER_PER_DAY} demos a day`);
    expect(JUDGE_DEMO_CLAUSE.noticeLeadMinutes).not.toBeNull();
    expect(readme).toContain("notice required before free time ends");
    expect(readme).toContain(`if none comes within ${RETAKE_WAIT_SECONDS.demo / 60} minutes`);
    expect(readme).toContain(`Share your location again within ${RELEASE_PIN_WINDOW_MINUTES} minutes`);
    expect(readme).toContain(`Wait more than ${RELEASE_PIN_WINDOW_MINUTES} minutes after Released`);
    expect(facts).toContain(`within ${RETAKE_WAIT_SECONDS.demo / 60} minutes on a demo load (an hour otherwise)`);
    expect(RETAKE_WAIT_SECONDS.standard).toBe(3600);
    expect(readme).toContain(`It takes about ${DEMO_MINUTES} minutes, most of it the real wait (${RETAKE_WAIT_SECONDS.demo / 60} more if a photo has to be retaken)`);
    // The README and the intro name the demo yard's zone in words.
    expect(JUDGE_DEMO_FACILITY.timeZone).toBe("America/New_York");
    expect(readme).toContain("US Eastern time in the demo");
  });

  it("labels every FACTS row with a known status, live rows by kind", () => {
    const rows = factRows();
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.some((row) => row.evidence === "")).toBe(true);
    for (const row of rows) {
      for (const part of row.status.split(/\s\+\s/)) expect(part, row.claim).toMatch(STATUS);
    }
  });

  it("backs every load id the README cites with a FACTS row", () => {
    const cited = new Set(readme.match(/\b(?:LIVE|SMOKE|DEMO)-[a-z0-9]{6,}\b/g) ?? []);
    expect(cited.size).toBeGreaterThan(0);
    for (const loadId of cited) expect(facts, loadId).toContain(loadId);
  });

  it("cites only files that exist", () => {
    const paths = new Set(facts.match(/`((?:packages|services|infra|scripts|fixtures|docs)\/[^`\s]+)`/g)?.map((p) => p.slice(1, -1)) ?? []);
    expect(paths.size).toBeGreaterThan(10);
    for (const path of paths) expect(existsSync(new URL(path, root)), path).toBe(true);
  });
});
