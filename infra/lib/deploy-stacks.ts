import type { DeskSource } from "./desk-stack.js";
import { DESK_PLACEHOLDER_CONTEXT } from "./desk-stack.js";

// Every stack buildApp() defines, in deploy order (a test keeps this list equal to the app's).
export const STACKS = ["DockClockCore", "DockClockEmail", "DockClockAgent", "DockClockMessaging", "DockClockDesk"] as const;
export const DESK_STACK = "DockClockDesk";

// Deploy every stack but the desk when the site is not built. Without it `npm run deploy` stops
// before deploying anything, so a missing build never ships a partial deploy silently.
export const ALLOW_SKIP_DESK = "--allow-skip-desk";

// The CDK CLI's boolean options (aws-cdk 2.1145, deploy and global), any --no-x, and this script's
// own --allow-skip-desk. Every other option takes a value, so the bare argument right after it (with
// no "=") is that value: --profile dockclock, --toolkit-stack-name DockClockToolkit, -O
// dockclock-outputs.json. A boolean missing here costs nothing when the stack after it is named
// exactly: an app stack name always names stacks.
const BOOLEAN_OPTIONS = new Set([
  "--all", "--exclusively", "-e", "--execute", "--import-existing-resources", "--force", "-f", "--previous-parameters", "--rollback",
  "--hotswap", "--hotswap-fallback", "--watch", "--logs", "--asset-parallelism", "--asset-prebuild", "--ignore-no-stacks", "--revert-drift",
  "--express", "--trace", "--strict", "--lookups", "--ignore-errors", "--json", "-j", "--verbose", "-v", "--debug", "--debug-app",
  "--debug-cli", "--ec2creds", "-i", "--version-reporting", "--path-metadata", "--asset-metadata", "--staging", "--notices", "--color",
  "--ci", "--yes", "-y", ALLOW_SKIP_DESK,
]);

export function booleanOption(flag: string): boolean {
  return BOOLEAN_OPTIONS.has(flag) || flag.startsWith("--no-") || /^-v+$/.test(flag);
}

// Whether a pattern selects one of the app's stacks: its exact name, or a wildcard (*, ?) that
// matches one.
export function matchesStack(arg: string): boolean {
  if (!/[*?]/.test(arg)) return (STACKS as readonly string[]).includes(arg);
  const re = new RegExp(`^${arg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return STACKS.some((stack) => re.test(stack));
}

// Whether a bare argument names stacks, given the option before it (null when there is none, or it
// carried its value after "="). One that matches an app stack always does. Otherwise the argument
// right after an option that takes a value is that value, and so is true or false after a boolean.
// Any other bare argument is a positional, which the CLI reads as a stack pattern: a mistyped name
// goes to the CLI as asked, which reports it, and is never widened to --all.
export function namesStacks(arg: string, after: string | null = null): boolean {
  if (matchesStack(arg)) return true;
  if (after === null) return true;
  return booleanOption(after) && arg !== "true" && arg !== "false";
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
    const before = i > 0 ? extra[i - 1]! : "";
    if (!arg.startsWith("-")) {
      if (namesStacks(arg, before.startsWith("-") && !before.includes("=") ? before : null)) out.named = true;
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
