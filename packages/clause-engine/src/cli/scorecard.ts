import { readFileSync } from "node:fs";
import type { FixtureLoad } from "../fixtures.js";
import { headline, scorecard } from "../scorecard.js";
import { LOADS_PATH, MANIFEST_PATH } from "./paths.js";

const fixtures = JSON.parse(readFileSync(LOADS_PATH, "utf8")) as FixtureLoad[];
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { sha256: string };
const card = scorecard(fixtures);

console.log(headline(card));
console.log(JSON.stringify(card, null, 2));

if (card.fixtureSha256 !== manifest.sha256) {
  console.error(`fixture hash ${card.fixtureSha256} does not match frozen manifest ${manifest.sha256}`);
  process.exit(1);
}
if (card.mismatches.length > 0) process.exit(1);
