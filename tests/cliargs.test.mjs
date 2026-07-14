// The argument parser: values, =-syntax, aliases, repeatables, positionals
// and every error shape the CLI turns into exit code 2.
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, flagValue, flagValues, hasFlag } from "../dist/cliargs.js";

const SPECS = [
  { name: "maps", alias: "m", takesValue: true, repeatable: true },
  { name: "format", takesValue: true },
  { name: "stats" },
  { name: "quiet", alias: "q" },
];

test("parses flags, aliases and positionals together", () => {
  const args = parseArgs(["remap", "-m", "dist", "--stats", "log.txt"], SPECS);
  assert.equal(args.error, null);
  assert.deepEqual(args.positionals, ["remap", "log.txt"]);
  assert.deepEqual(flagValues(args, "maps"), ["dist"]);
  assert.equal(hasFlag(args, "stats"), true);
  assert.equal(hasFlag(args, "quiet"), false);
});

test("--flag=value syntax works; boolean flags reject =value", () => {
  const args = parseArgs(["--format=json"], SPECS);
  assert.equal(flagValue(args, "format"), "json");
  assert.equal(flagValue(args, "maps"), null);
  const bad = parseArgs(["--stats=yes"], SPECS);
  assert.match(bad.error, /takes no value/);
});

test("repeatable flags accumulate; non-repeatable ones error on repeat", () => {
  const ok = parseArgs(["-m", "a", "--maps", "b"], SPECS);
  assert.deepEqual(flagValues(ok, "maps"), ["a", "b"]);
  const bad = parseArgs(["--format", "a", "--format", "b"], SPECS);
  assert.match(bad.error, /given twice/);
});

test("missing values and unknown options are rejected with detail", () => {
  const missing = parseArgs(["--maps"], SPECS);
  assert.match(missing.error, /needs a value/);
  const unknown = parseArgs(["--frobnicate"], SPECS);
  assert.match(unknown.error, /--frobnicate/);
});

test("bare dash is a positional (stdin) and -- ends flag parsing", () => {
  const args = parseArgs(["-", "--", "--stats", "-m"], SPECS);
  assert.equal(args.error, null);
  assert.deepEqual(args.positionals, ["-", "--stats", "-m"]);
  assert.equal(hasFlag(args, "stats"), false);
});
