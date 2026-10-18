import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headline, scorecard } from "../src/index.js";
import type { FixtureLoad } from "../src/fixtures.js";
import { LOADS_PATH } from "../src/cli/paths.js";

// README line one is a claim; this keeps it equal to what the frozen fixtures actually produce.
describe("README headline", () => {
  it("matches the scorecard recomputed from the frozen fixtures", () => {
    const fixtures = JSON.parse(readFileSync(LOADS_PATH, "utf8")) as FixtureLoad[];
    const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
    expect(readme).toContain(headline(scorecard(fixtures)));
  });
});
