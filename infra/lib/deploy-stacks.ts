import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DeskSource } from "./desk-stack.js";
import { DESK_PLACEHOLDER_CONTEXT } from "./desk-stack.js";

// Every stack buildApp() defines, in deploy order (a test keeps this list equal to the app's).
export const STACKS = ["DockClockCore", "DockClockEmail", "DockClockAgent", "DockClockMessaging", "DockClockDesk"] as const;
export const DESK_STACK = "DockClockDesk";

// Deploy every stack but the desk when the site is not built. Without it `npm run deploy` stops
// before deploying anything, so a missing build never ships a partial deploy silently.
export const ALLOW_SKIP_DESK = "--allow-skip-desk";

// What an option does with the bare argument after it, when it carries no "=value": a boolean takes
// none (bar a literal true or false), a value option takes exactly that one (an array option such as
// --parameters takes one value each time it is given).
export type OptionKind = "boolean" | "value";
export type CliOptions = ReadonlyMap<string, OptionKind>;

// Options this script reads itself, known whatever the installed CLI says: -R is the CLI parser's
// hidden alias of --no-rollback, which its option table leaves out.
const OWN_OPTIONS: CliOptions = new Map([
  ["--all", "boolean"],
  ["-R", "boolean"],
  ["-c", "value"],
  ["--context", "value"],
  ["-O", "value"],
  ["--outputs-file", "value"],
]);

function registryPath(): string | null {
  try {
    return join(dirname(createRequire(import.meta.url).resolve("aws-cdk/package.json")), "lib", "cli", "cli-type-registry.json");
  } catch {
    return null;
  }
}

// The installed CDK CLI's own options for `cdk deploy`, its global options and deploy's, read from
// aws-cdk's cli-type-registry.json (the table its argument parser is generated from), so a CLI
// upgrade cannot leave a copied table behind: every name and alias by kind (boolean and count
// options are booleans; string, number and array options take a value). Null when the file is
// missing or not that shape: every option but this script's own is then unknown, and a run that
// would deploy every stack with a bare argument after an unknown option is refused (deployPlan).
export function cliOptions(file: string | null = registryPath()): CliOptions | null {
  let registry: { globalOptions?: unknown; commands?: { deploy?: { options?: unknown } } };
  try {
    registry = file ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
  const tables = [registry?.globalOptions, registry?.commands?.deploy?.options];
  if (!tables.every((t) => t && typeof t === "object")) return null;
  const kinds = new Map<string, OptionKind>();
  for (const table of tables as Array<Record<string, { type?: unknown; alias?: unknown }>>) {
    for (const [name, spec] of Object.entries(table)) {
      const kind: OptionKind = spec?.type === "boolean" ? "boolean" : "value";
      const aliases = Array.isArray(spec?.alias) ? spec.alias : spec?.alias === undefined ? [] : [spec.alias];
      for (const alias of [name, ...aliases].filter((a): a is string => typeof a === "string" && a.length > 0)) kinds.set(alias.length === 1 ? `-${alias}` : `--${alias}`, kind);
    }
  }
  if (kinds.get("--all") !== "boolean" || kinds.get("--profile") !== "value") return null;
  for (const [flag, kind] of OWN_OPTIONS) kinds.set(flag, kind);
  return kinds;
}

// An option's kind, or null when neither this script nor the CLI's table knows it. --no-x is always
// a boolean (the parser negates any option that way). A group of short flags (-fR) is read as the
// parser reads it: each but the last is a boolean, and the last decides.
export function optionKind(flag: string, options: CliOptions | null): OptionKind | null {
  if (flag.startsWith("--no-")) return "boolean";
  const known = (f: string) => OWN_OPTIONS.get(f) ?? options?.get(f) ?? null;
  if (known(flag)) return known(flag);
  if (!/^-[A-Za-z]{2,}$/.test(flag)) return null;
  const kinds = [...flag.slice(1)].map((letter) => known(`-${letter}`));
  return kinds.slice(0, -1).every((k) => k === "boolean") ? kinds.at(-1)! : null;
}

export interface DeployArgs {
  // What goes to `cdk deploy`, as given, without --allow-skip-desk.
  pass: string[];
  // Stacks were chosen on the command line: --all, or a bare argument that is no option's value
  // (a name or a wildcard pattern, whether or not it matches a stack). Anything after -- counts too,
  // so it is never widened to every stack, though the CLI reads none of it as a stack: it goes to
  // the parser's leftover arguments, and with no stack named the CLI stops before deploying.
  named: boolean;
  // Bare arguments right after an option neither this script nor the CLI's table knows: the CLI
  // reads each as that option's value, but it may have been meant as a stack.
  unsure: Array<{ option: string; arg: string }>;
  // Context given on the command line (-c k=v, --context k=v, --context=k=v), by key.
  context: Record<string, string>;
  allowSkipDesk: boolean;
  // The caller chose their own --outputs-file.
  outputsFile: boolean;
}

// The CLI's parser reads --outputsFile as --outputs-file, so an option is looked up in that form.
const kebab = (flag: string) => (flag.startsWith("--") ? `--${flag.slice(2).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}` : flag);

// Reads the command line as the CDK CLI's parser does, the option-value rule first: the bare
// argument right after an option that takes a value is that value, even when it looks like a stack
// (--build-exclude 'DockClock*'), and true or false right after a boolean is its value. Every other
// bare argument is a stack pattern. Everything after -- is read as naming stacks, so nothing after
// it is widened to every stack; the CLI itself reads no stack there (see DeployArgs.named).
export function readArgs(extra: string[], options: CliOptions | null = cliOptions()): DeployArgs {
  const out: DeployArgs = { pass: [], named: false, unsure: [], context: {}, allowSkipDesk: false, outputsFile: false };
  const addContext = (pair: string | undefined) => {
    const at = pair?.indexOf("=") ?? -1;
    if (pair && at > 0) out.context[pair.slice(0, at)] = pair.slice(at + 1);
  };
  let positional = false;
  for (let i = 0; i < extra.length; i++) {
    const arg = extra[i]!;
    if (!positional && arg === ALLOW_SKIP_DESK) {
      out.allowSkipDesk = true;
      continue;
    }
    out.pass.push(arg);
    if (positional || !arg.startsWith("-") || arg === "-") {
      out.named = true;
      continue;
    }
    if (arg === "--") {
      positional = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = kebab(eq > 0 ? arg.slice(0, eq) : arg);
    const isContext = flag === "-c" || flag === "--context";
    if (flag === "--all") out.named = true;
    if (flag === "-O" || flag === "--outputs-file") out.outputsFile = true;
    if (eq > 0) {
      if (isContext) addContext(arg.slice(eq + 1));
      continue;
    }
    const next = extra[i + 1];
    if (next === undefined || (next.startsWith("-") && next !== "-")) continue;
    const kind = optionKind(flag, options);
    if (kind === "boolean" && next !== "true" && next !== "false") continue;
    out.pass.push(next);
    i++;
    if (kind === null) out.unsure.push({ option: flag, arg: next });
    if (isContext) addContext(next);
  }
  return out;
}

// The `cdk deploy` command line, with this script's own options before any --: the CLI reads no
// option after it.
export function deployCommand(args: string[], own: string[]): string[] {
  const end = args.indexOf("--");
  return end === -1 ? ["deploy", ...args, ...own] : ["deploy", ...args.slice(0, end), ...own, ...args.slice(end)];
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
// --all) deploy as asked: the CLI then stops a named desk without a site build, as it should, and
// reports a name that matches no stack. With none named, every stack deploys, unless the site is not
// built and the placeholder was not asked for (DOCKCLOCK_DESK_PLACEHOLDER=1 in the shell or ../.env,
// or the dockclock:deskPlaceholder context on the command line, in cdk.json or in cdk.context.json):
// the CLI refuses a whole deploy when any selected stack carries an error, so then nothing deploys
// and the run fails, unless --allow-skip-desk asks for every other stack without the desk.
// A bare argument is never widened to every stack: when none is named and one follows an option
// this script cannot place (readArgs' unsure), nothing deploys and the run fails.
export function deployPlan(source: DeskSource, extra: string[], fileContext: Record<string, unknown> = {}, options: CliOptions | null = cliOptions()): DeployPlan {
  const a = readArgs(extra, options);
  const asked = DESK_PLACEHOLDER_CONTEXT in a.context ? a.context[DESK_PLACEHOLDER_CONTEXT] : fileContext[DESK_PLACEHOLDER_CONTEXT];
  const placeholder = asked !== undefined && String(asked) === "1";
  const base = { outputsFile: a.outputsFile };
  if (a.named) return { ...base, args: a.pass, note: null, refused: null };
  const unsure = a.unsure[0];
  if (unsure) {
    const why = options ? "an option the installed CDK CLI does not list" : "an option this script cannot check, since node_modules/aws-cdk/lib/cli/cli-type-registry.json could not be read";
    return {
      ...base,
      args: [],
      note: null,
      refused: `Not deploying anything: "${unsure.arg}" follows ${unsure.option}, ${why}, so the CLI may read it as that option's value rather than a stack, and this run would deploy every stack. Write ${unsure.option}=${unsure.arg} for a value, or name the stacks to deploy.`,
    };
  }
  if (!source.error || placeholder) return { ...base, args: ["--all", ...a.pass], note: null, refused: null };
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
