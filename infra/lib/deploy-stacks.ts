import type { DeskSource } from "./desk-stack.js";
import { DESK_PLACEHOLDER_CONTEXT } from "./desk-stack.js";

// Every stack buildApp() defines, in deploy order (a test keeps this list equal to the app's).
export const STACKS = ["DockClockCore", "DockClockEmail", "DockClockAgent", "DockClockMessaging", "DockClockDesk"] as const;
export const DESK_STACK = "DockClockDesk";

export interface DeployPlan {
  // What follows `cdk deploy`.
  args: string[];
  // Said before the deploy when the desk is left out.
  note: string | null;
}

// What `npm run deploy` deploys. Stacks named on the command line deploy as asked (the CLI then
// stops a named desk without a site build, as it should). With none named, every stack deploys;
// without a site build, and without the placeholder asked for, the desk is left out, so the other
// stacks still ship. The CLI refuses the whole deploy when any selected stack carries an error.
export function deployPlan(source: DeskSource, extra: string[]): DeployPlan {
  const named = extra.some((arg) => STACKS.includes(arg as (typeof STACKS)[number]) || arg === "--all");
  const placeholder = extra.some((arg) => arg === `${DESK_PLACEHOLDER_CONTEXT}=1`);
  if (named || !source.error || placeholder) return { args: named ? extra : ["--all", ...extra], note: null };
  return {
    args: [...STACKS.filter((stack) => stack !== DESK_STACK), ...extra],
    note: `Skipping ${DESK_STACK}: ${source.error}`,
  };
}
