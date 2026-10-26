import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { DESK_PLACEHOLDER_ENV, deskSource } from "../lib/desk-stack.js";
import { deployPlan, mergeOutputs } from "../lib/deploy-stacks.js";

// npm run deploy: every stack, or the stacks named after `--` (see deploy-stacks.ts for when the desk
// is left out, and --allow-skip-desk). Other arguments go to `cdk deploy` as given.
//
// The CDK CLI runs with this shell's own environment, so its AWS profile and region are the shell's.
// ../.env is read by the CDK app alone (cdk.json's app command), as before this wrapper existed;
// here only DOCKCLOCK_DESK_PLACEHOLDER is read from it, to know whether the placeholder was asked
// for, and nothing is exported.
//
// The CLI writes its outputs to a temporary file, merged into ../.cdk-outputs.json afterwards, so
// a run that deploys some stacks keeps every other stack's outputs.
const infra = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(infra, "..");
const outputs = join(root, ".cdk-outputs.json");

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// A variable from the shell, else from ../.env, as the app sees it (the shell wins, as with --env-file).
function appEnv(name: string): string | undefined {
  if (process.env[name] !== undefined) return process.env[name];
  const file = join(root, ".env");
  if (!existsSync(file)) return undefined;
  return parseEnv(readFileSync(file, "utf8"))[name];
}

// Context the app reads from files: cdk.context.json, then cdk.json's own context on top.
function fileContext(): Record<string, unknown> {
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  return { ...obj(readJson(join(infra, "cdk.context.json"))), ...obj(obj(readJson(join(infra, "cdk.json"))).context) };
}

const plan = deployPlan(deskSource(root, appEnv(DESK_PLACEHOLDER_ENV) === "1"), process.argv.slice(2), fileContext());
if (plan.refused) {
  console.error(plan.refused);
  process.exit(1);
}
if (plan.note) console.warn(plan.note);

// The repo's own CDK CLI; DOCKCLOCK_CDK names another binary (a dry run with a stand-in).
const local = join(root, "node_modules", ".bin", "cdk");
const cdk = process.env.DOCKCLOCK_CDK ?? (existsSync(local) ? local : "cdk");
const scratch = plan.outputsFile ? null : mkdtempSync(join(tmpdir(), "dockclock-outputs-"));
const fresh = scratch ? join(scratch, "outputs.json") : null;
const run = spawnSync(cdk, ["deploy", ...plan.args, "--require-approval", "never", ...(fresh ? ["--outputs-file", fresh] : [])], { stdio: "inherit", cwd: infra });
if (run.error) console.error(`Could not run the CDK CLI (${cdk}): ${run.error.message}`);
if (run.signal) console.error(`The CDK CLI stopped on ${run.signal}.`);

// Whatever this run deployed (all of it, or the stacks that finished before a failure).
if (fresh && existsSync(fresh)) {
  const written = readJson(fresh);
  const merged = mergeOutputs(readJson(outputs), written);
  writeFileSync(`${outputs}.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(`${outputs}.tmp`, outputs);
  console.log(`Outputs of ${Object.keys(written ?? {}).join(", ") || "no stack"} merged into .cdk-outputs.json; other stacks' outputs kept.`);
}
if (scratch) rmSync(scratch, { recursive: true, force: true });
process.exit(run.status ?? 1);
