#!/usr/bin/env node
/**
 * remaptrace CLI. Subcommands:
 *
 *   remap [file...]   rewrite stack traces in logs (default; stdin when no file)
 *   frame <loc>       remap one file:line:column position, with source context
 *   check <path...>   validate bundle/map pairs for consistency
 *   inspect <map>     print a source map summary
 *
 * Exit codes: 0 success, 1 findings / unmapped frames (when gated),
 * 2 usage or input error — a pipeline can tell a broken build from a
 * broken invocation.
 */

import fs from "node:fs";
import process from "node:process";
import { parseArgs, flagValue, flagValues, hasFlag, type ParsedArgs } from "./cliargs.js";
import { MapResolver } from "./resolve.js";
import { processLog } from "./batch.js";
import { checkTarget, checkMapFile } from "./check.js";
import {
  failsAt,
  renderCheckJson,
  renderCheckText,
  renderFrame,
  renderFrameJson,
  renderInspectJson,
  renderInspectText,
  renderStats,
} from "./report.js";
import { VERSION } from "./version.js";

const USAGE = `remaptrace ${VERSION} — apply source maps to minified JS stack traces, in batch, offline

Usage: remaptrace [command] [options] [args]

Commands:
  remap [file...]    rewrite stack traces in log files (default command;
                     reads stdin when no file is given, "-" also means stdin)
  frame <loc>        remap a single bundle:line:column position
  check <path...>    validate bundles and source maps for consistency
  inspect <map>      print a source map summary

Options:
  -m, --maps <dir>        directory containing .map files (repeatable)
      --map <js=map>      explicit bundle-to-map pairing (repeatable)
  -o, --output <file>     remap: write result here instead of stdout
      --stats             remap: print a summary line to stderr
      --fail-unmapped     remap: exit 1 if any frame stayed minified
      --no-json-lines     remap: do not rewrite stacks inside JSON log lines
  -c, --context <n>       frame: source context lines (default 2)
      --format <fmt>      frame/check/inspect: text or json (default text)
      --fail-on <level>   check: error|warning|info|never (default warning)
  -q, --quiet             suppress non-essential output
  -h, --help              show this help
  -V, --version           print the version

Exit codes: 0 ok · 1 findings or unmapped frames (when gated) · 2 usage error`;

const SPECS = [
  { name: "maps", alias: "m", takesValue: true, repeatable: true },
  { name: "map", takesValue: true, repeatable: true },
  { name: "output", alias: "o", takesValue: true },
  { name: "stats" },
  { name: "fail-unmapped" },
  { name: "no-json-lines" },
  { name: "context", alias: "c", takesValue: true },
  { name: "format", takesValue: true },
  { name: "fail-on", takesValue: true },
  { name: "quiet", alias: "q" },
  { name: "help", alias: "h" },
  { name: "version", alias: "V" },
];

function usageError(message: string): never {
  process.stderr.write(`remaptrace: ${message}\n`);
  process.stderr.write(`Try: remaptrace --help\n`);
  exit(2);
}

function exit(code: number): never {
  process.exitCode = code;
  // eslint-style guard: throw so `never` holds even though exitCode is async.
  throw new ExitSignal(code);
}

class ExitSignal extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function buildResolver(args: ParsedArgs): MapResolver {
  const pairs: [string, string][] = [];
  for (const raw of flagValues(args, "map")) {
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      usageError(`--map expects <bundle>=<mapfile>, got "${raw}"`);
    }
    pairs.push([raw.slice(0, eq), raw.slice(eq + 1)]);
  }
  return new MapResolver({ mapsDirs: flagValues(args, "maps"), pairs });
}

function readInput(file: string): string {
  if (file === "-") return fs.readFileSync(0, "utf8");
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    usageError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

function pickFormat(args: ParsedArgs): "text" | "json" {
  const fmt = flagValue(args, "format") ?? "text";
  if (fmt !== "text" && fmt !== "json") {
    usageError(`--format must be text or json, got "${fmt}"`);
  }
  return fmt;
}

function cmdRemap(args: ParsedArgs, files: string[]): void {
  const resolver = buildResolver(args);
  const inputs = files.length === 0 ? ["-"] : files;
  let output = "";
  for (const file of inputs) {
    const text = readInput(file);
    const { output: out, stats } = processLog(text, resolver, {
      jsonLines: !hasFlag(args, "no-json-lines"),
    });
    output += out;
    if (hasFlag(args, "stats") && !hasFlag(args, "quiet")) {
      const prefix = inputs.length > 1 ? `${file === "-" ? "(stdin)" : file}: ` : "";
      process.stderr.write(`${prefix}${renderStats(stats)}\n`);
    }
    // Runtime-internal frames (node:, <anonymous>) can never be remapped
    // and appear in almost every trace — they do not trip the gate.
    const remappable = stats.framesFound - stats.framesInternal;
    if (hasFlag(args, "fail-unmapped") && stats.framesRemapped < remappable) {
      process.exitCode = 1;
    }
  }
  const target = flagValue(args, "output");
  if (target !== null) {
    try {
      fs.writeFileSync(target, output);
    } catch (e) {
      usageError(`cannot write ${target}: ${(e as Error).message}`);
    }
    if (!hasFlag(args, "quiet") && !hasFlag(args, "stats")) {
      process.stderr.write(`remaptrace: wrote ${target}\n`);
    }
  } else {
    process.stdout.write(output);
  }
}

function cmdFrame(args: ParsedArgs, positionals: string[]): void {
  if (positionals.length !== 1) {
    usageError("frame expects exactly one <bundle:line:column> argument");
  }
  const query = positionals[0] as string;
  const m = /^(.+):(\d+):(\d+)$/.exec(query);
  if (m === null) {
    usageError(`"${query}" is not a <bundle:line:column> position`);
  }
  const url = m[1] as string;
  const line = parseInt(m[2] as string, 10);
  const column = parseInt(m[3] as string, 10);
  const resolver = buildResolver(args);
  const resolved = resolver.resolve(url);
  if (resolved === null) {
    process.stderr.write(
      `remaptrace: no source map found for ${url} (try --maps or --map)\n`
    );
    exit(1);
  }
  const pos = resolved.map.originalPositionFor(line, column);
  if (pos === null) {
    process.stderr.write(
      `remaptrace: ${resolved.origin} has no mapping at ${line}:${column}\n`
    );
    exit(1);
  }
  if (pickFormat(args) === "json") {
    process.stdout.write(renderFrameJson(query, pos) + "\n");
    return;
  }
  const rawContext = flagValue(args, "context");
  const context = rawContext === null ? 2 : parseInt(rawContext, 10);
  if (Number.isNaN(context) || context < 0) {
    usageError(`--context must be a non-negative integer, got "${rawContext}"`);
  }
  const content = resolved.map.contentFor(pos.rawSource);
  process.stdout.write(renderFrame(query, pos, content, context) + "\n");
}

function cmdCheck(args: ParsedArgs, targets: string[]): void {
  if (targets.length === 0) {
    usageError("check expects at least one bundle, map or directory");
  }
  const failOn = flagValue(args, "fail-on") ?? "warning";
  if (!["error", "warning", "info", "never"].includes(failOn)) {
    usageError(`--fail-on must be error, warning, info or never, got "${failOn}"`);
  }
  const findings = targets.flatMap((t) => checkTarget(t));
  const format = pickFormat(args);
  if (format === "json") {
    process.stdout.write(renderCheckJson(findings, failOn) + "\n");
  } else if (!hasFlag(args, "quiet") || failsAt(findings, failOn)) {
    process.stdout.write(renderCheckText(findings, failOn) + "\n");
  }
  if (failsAt(findings, failOn)) exit(1);
}

function cmdInspect(args: ParsedArgs, positionals: string[]): void {
  if (positionals.length !== 1) {
    usageError("inspect expects exactly one .map file");
  }
  const mapPath = positionals[0] as string;
  const { findings, map } = checkMapFile(mapPath);
  if (map === null) {
    const first = findings[0];
    process.stderr.write(
      `remaptrace: cannot inspect ${mapPath}: ${first ? first.message : "unreadable"}\n`
    );
    exit(2);
  }
  const stats = map.stats();
  const out =
    pickFormat(args) === "json"
      ? renderInspectJson(mapPath, stats, map.file)
      : renderInspectText(mapPath, stats, map.file);
  process.stdout.write(out + "\n");
}

export function main(argv: string[]): number {
  try {
    const args = parseArgs(argv, SPECS);
    if (args.error !== null) usageError(args.error);
    if (hasFlag(args, "help")) {
      process.stdout.write(USAGE + "\n");
      return 0;
    }
    if (hasFlag(args, "version")) {
      process.stdout.write(VERSION + "\n");
      return 0;
    }
    const [first, ...rest] = args.positionals;
    switch (first) {
      case "remap":
        cmdRemap(args, rest);
        break;
      case "frame":
        cmdFrame(args, rest);
        break;
      case "check":
        cmdCheck(args, rest);
        break;
      case "inspect":
        cmdInspect(args, rest);
        break;
      default:
        // No subcommand: everything positional is a log file for remap.
        cmdRemap(args, args.positionals);
        break;
    }
    return process.exitCode ?? 0;
  } catch (e) {
    if (e instanceof ExitSignal) return e.code;
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
