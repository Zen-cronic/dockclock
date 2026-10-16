import { writeFileSync } from "node:fs";
import { buildFixtures } from "../fixtures.js";
import { fixtureHash } from "../scorecard.js";
import { LOADS_PATH, MANIFEST_PATH } from "./paths.js";

const fixtures = buildFixtures();
writeFileSync(LOADS_PATH, `${JSON.stringify(fixtures, null, 2)}\n`);
writeFileSync(
  MANIFEST_PATH,
  `${JSON.stringify({ file: "loads.json", loads: fixtures.length, sha256: fixtureHash(fixtures) }, null, 2)}\n`,
);
console.log(`wrote ${fixtures.length} loads`);
