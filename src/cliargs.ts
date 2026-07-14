/**
 * Tiny argument parser — flags with or without values, repeatable flags,
 * aliases, `--flag=value` syntax and positional collection. Errors are
 * returned, not thrown, so the CLI can print usage and exit 2 uniformly.
 */

export interface FlagSpec {
  name: string;
  alias?: string;
  /** Flag takes a value (default: boolean). */
  takesValue?: boolean;
  /** Flag may repeat; values accumulate. */
  repeatable?: boolean;
}

export interface ParsedArgs {
  /** Flag name -> collected values ("" entries for boolean flags). */
  flags: Map<string, string[]>;
  positionals: string[];
  error: string | null;
}

export function parseArgs(argv: string[], specs: FlagSpec[]): ParsedArgs {
  const byName = new Map<string, FlagSpec>();
  for (const s of specs) {
    byName.set(`--${s.name}`, s);
    if (s.alias) byName.set(`-${s.alias}`, s);
  }
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      i += 1;
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const spec = byName.get(key);
    if (spec === undefined) {
      return { flags, positionals, error: `unknown option ${key}` };
    }
    let value = "";
    if (spec.takesValue) {
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          return { flags, positionals, error: `option --${spec.name} needs a value` };
        }
        value = next;
        i += 1;
      }
    } else if (eq !== -1) {
      return { flags, positionals, error: `option --${spec.name} takes no value` };
    }
    const existing = flags.get(spec.name);
    if (existing !== undefined && !spec.repeatable) {
      return { flags, positionals, error: `option --${spec.name} given twice` };
    }
    (existing ?? flags.set(spec.name, []).get(spec.name)!).push(value);
    i += 1;
  }
  return { flags, positionals, error: null };
}

/** Last value of a flag, or null. */
export function flagValue(args: ParsedArgs, name: string): string | null {
  const v = args.flags.get(name);
  return v === undefined ? null : (v[v.length - 1] ?? null);
}

export function flagValues(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? [];
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}
