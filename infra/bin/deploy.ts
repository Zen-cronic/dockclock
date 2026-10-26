import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deskSource } from "../lib/desk-stack.js";
import { deployPlan } from "../lib/deploy-stacks.js";

// npm run deploy: every stack, or the stacks named after `--` (see deploy-stacks.ts for when the desk
// is left out, and --allow-skip-desk). Other arguments go to `cdk deploy` as given.
const infra = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// Context the app reads from files: cdk.context.json, then cdk.json's own context on top.
function fileContext(): Record<string, unknown> {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  return { ...obj(readJson(join(infra, "cdk.context.json"))), ...obj(obj(readJson(join(infra, "cdk.json"))).context) };
}

const plan = deployPlan(deskSource(), process.argv.slice(2), fileContext());
if (plan.refused) {
  console.error(plan.refused);
  process.exit(1);
}
if (plan.note) console.warn(plan.note);
const run = spawnSync("cdk", ["deploy", ...plan.args, "--require-approval", "never", "--outputs-file", "../.cdk-outputs.json"], { stdio: "inherit" });
process.exit(run.status ?? 1);
