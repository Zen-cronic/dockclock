// Scores the agent's bill-of-lading reader against the ground truth of the generated photo set.
// Run `npm run bol:photos` first. Prints one line per photo and "N of M fields correct".
import { readFileSync } from "node:fs";
import { normalizeClock } from "@dockclock/evidence";
import { readBol } from "@dockclock/agent";

interface Case {
  id: string;
  file: string;
  mimeType: string;
  truth: { inTime: string | null; outTime: string | null; receiverSigned: boolean; legible: boolean };
}

const dir = new URL("../data/bol-photos/", import.meta.url);
const cases = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as Case[];
const model = process.env.DOCKCLOCK_AGENT_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const same = (a: string | null, b: string | null) => normalizeClock(a) === normalizeClock(b);

let correct = 0;
let total = 0;
for (const c of cases) {
  const r = await readBol(readFileSync(new URL(c.file, dir)), c.mimeType, model);
  // An unreadable photo is scored on legibility alone: a reader must say so, not guess times.
  const checks: Array<[string, boolean]> = c.truth.legible
    ? [
        ["legible", r.legible === true],
        ["in", same(r.inTime, c.truth.inTime)],
        ["out", same(r.outTime, c.truth.outTime)],
        ["signed", r.receiverSigned === c.truth.receiverSigned],
      ]
    : [
        ["legible", r.legible === false],
        ["no guessed times", r.inTime === null && r.outTime === null],
      ];
  const ok = checks.filter(([, pass]) => pass).length;
  correct += ok;
  total += checks.length;
  const misses = checks.filter(([, pass]) => !pass).map(([name]) => name);
  console.log(`${c.id.padEnd(12)} ${ok}/${checks.length}  read in=${r.inTime} out=${r.outTime} signed=${r.receiverSigned} legible=${r.legible}${misses.length ? `  MISSED: ${misses.join(", ")}` : ""}`);
}
console.log(`\n${correct} of ${total} fields correct (${model}, ${cases.length} fictional photos)`);
process.exit(correct === total ? 0 : 1);
