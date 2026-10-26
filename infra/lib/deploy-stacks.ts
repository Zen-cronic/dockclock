import type { DeskSource } from "./desk-stack.js";
import { DESK_PLACEHOLDER_CONTEXT } from "./desk-stack.js";

// Every stack buildApp() defines, in deploy order (a test keeps this list equal to the app's).
export const STACKS = ["DockClockCore", "DockClockEmail", "DockClockAgent", "DockClockMessaging", "DockClockDesk"] as const;
export const DESK_STACK = "DockClockDesk";

// Deploy every stack but the desk when the site is not built. Without it `npm run deploy` stops
// before deploying anything, so a missing build never ships a partial deploy silently.
export const ALLOW_SKIP_DESK = "--allow-skip-desk";

// Whether a bare argument names stacks: one of STACKS, anything with the app's DockClock prefix (a
// mistyped name goes to the CLI as asked, which reports it, rather than being widened to --all), or
// a wildcard pattern (DockClock*, *Messaging). Any other bare argument is an option's value
// (`--region us-east-1`, `--profile example`), so no table of the CLI's value options has to be
// kept in step with each CDK release. A value that has a wildcard in it (--build-exclude 'x*')
// counts as a stack pattern: the CLI then asks for the stacks to deploy, and nothing deploys.
export function namesStacks(arg: string): boolean {
  return (STACKS as readonly string[]).includes(arg) || /^dockclock/i.test(arg) || /[*?]/.test(arg);
}

export interface DeployArgs {
  // What goes to `cdk deploy`, as given, without --allow-skip-desk.
  pass: string[];
  // Stacks were chosen on the command line: a name, a wildcard pattern, or --all.
  named: boolean;
  // Context given on the command line (-c k=v, --context k=v, --context=k=v), by key.
  context: Record<string, string>;
  allowSkipDesk: boolean;
  // The caller chose their own --outputs-file.
  outputsFile: boolean;
}

export function readArgs(extra: string[]): DeployArgs {
  const out: DeployArgs = { pass: [], named: false, context: {}, allowSkipDesk: false, outputsFile: false };
  const addContext = (pair: string | undefined) => {
    const at = pair?.indexOf("=") ?? -1;
    if (pair && at > 0) out.context[pair.slice(0, at)] = pair.slice(at + 1);
  };
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i]!;
    if (arg === ALLOW_SKIP_DESK) {
      out.allowSkipDesk = true;
      continue;
    }
    out.pass.push(arg);
    if (!arg.startsWith("-")) {
      if (namesStacks(arg)) out.named = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (flag === "--all") out.named = true;
    if (flag === "-O" || flag === "--outputs-file") out.outputsFile = true;
    if (flag !== "-c" && flag !== "--context") continue;
    if (eq > 0) addContext(arg.slice(eq + 1));
    else if (i + 1 < extra.length) {
      const value = extra[++i]!;
      out.pass.push(value);
      addContext(value);
    }
  }
  return out;
}

export interface DeployPlan {
  // What follows `cdk deploy`.
  args: string[];
  // Said before the deploy when the desk is left out.
  note: string | null;
  // Why nothing is deployed (exit non-zero), when the desk would be left out without asking.
  refused: string | null;
  // The caller chose their own --outputs-file, so the shared outputs file is not touched.
  outputsFile: boolean;
}

// What `npm run deploy` deploys. Stacks named on the command line (names, wildcard patterns or
// --all) deploy as asked: the CLI then stops a named desk without a site build, as it should. With
// none named, every stack deploys, unless the site is not built and the placeholder was not asked
// for (DOCKCLOCK_DESK_PLACEHOLDER=1 in the shell or ../.env, or the dockclock:deskPlaceholder
// context on the command line, in cdk.json or in cdk.context.json): the CLI refuses a whole deploy
// when any selected stack carries an error, so then nothing deploys and the run fails, unless
// --allow-skip-desk asks for every other stack without the desk.
export function deployPlan(source: DeskSource, extra: string[], fileContext: Record<string, unknown> = {}): DeployPlan {
  const a = readArgs(extra);
  const asked = DESK_PLACEHOLDER_CONTEXT in a.context ? a.context[DESK_PLACEHOLDER_CONTEXT] : fileContext[DESK_PLACEHOLDER_CONTEXT];
  const placeholder = asked !== undefined && String(asked) === "1";
  const base = { outputsFile: a.outputsFile };
  if (a.named || !source.error || placeholder) return { ...base, args: a.named ? a.pass : ["--all", ...a.pass], note: null, refused: null };
  if (!a.allowSkipDesk) {
    return {
      ...base,
      args: [],
      note: null,
      refused: `Not deploying anything: ${DESK_STACK} cannot deploy. ${source.error} To deploy every other stack without it, run: npm run deploy -- ${ALLOW_SKIP_DESK}`,
    };
  }
  return {
    ...base,
    args: [...STACKS.filter((stack) => stack !== DESK_STACK), ...a.pass],
    note: `Warning: skipping ${DESK_STACK} (${ALLOW_SKIP_DESK}). ${source.error}`,
    refused: null,
  };
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// `cdk deploy --outputs-file` writes only the stacks that run deployed and replaces the file. The
// stacks this run wrote replace their own entries; every other stack's outputs are kept.
export function mergeOutputs(previous: unknown, fresh: unknown): Record<string, unknown> {
  return { ...record(previous), ...record(fresh) };
}
