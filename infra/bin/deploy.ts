import { spawnSync } from "node:child_process";
import { deskSource } from "../lib/desk-stack.js";
import { deployPlan } from "../lib/deploy-stacks.js";

// npm run deploy: every stack, or every stack but the desk when the site is not built (see
// deploy-stacks.ts). Extra arguments go to `cdk deploy` as given.
const plan = deployPlan(deskSource(), process.argv.slice(2));
if (plan.note) console.warn(plan.note);
const run = spawnSync("cdk", ["deploy", ...plan.args, "--require-approval", "never", "--outputs-file", "../.cdk-outputs.json"], { stdio: "inherit" });
process.exit(run.status ?? 1);
