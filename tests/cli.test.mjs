// End-to-end CLI integration: real process, real files, every subcommand,
// exit codes, stdin, --output, --stats, --fail-unmapped, JSON output and
// determinism. Uses the shipped examples/ fixtures plus fresh temp trees.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli, ROOT, mapJson, encodeMappings, makeTree, rmTree } from "./helpers.mjs";

const EX = (p) => path.join(ROOT, "examples", p);

test("--version matches package.json; --help documents the surface", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const v = runCli(["--version"]);
  assert.equal(v.status, 0);
  assert.equal(v.stdout.trim(), pkg.version);
  const h = runCli(["--help"]);
  assert.equal(h.status, 0);
  for (const word of ["remap", "frame", "check", "inspect", "--maps", "--fail-on", "Exit codes"]) {
    assert.match(h.stdout, new RegExp(word), word);
  }
});

test("unknown flags and bad values exit 2 with guidance on stderr", () => {
  assert.equal(runCli(["--frobnicate"]).status, 2);
  assert.equal(runCli(["check", EX("dist"), "--fail-on", "sometimes"]).status, 2);
  assert.equal(runCli(["frame", "not-a-position"]).status, 2);
  assert.equal(runCli(["--map", "novalue"]).status, 2);
  const r = runCli(["--frobnicate"]);
  assert.match(r.stderr, /--frobnicate/);
  assert.match(r.stderr, /--help/);
});

test("remap rewrites the example log end to end", () => {
  const r = runCli(["remap", EX("logs/prod.log"), "--maps", EX("dist"), "--stats"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /at applyDiscount \(src\/checkout\.js:6:5\)/);
  assert.match(r.stdout, /at computeTotal \(src\/checkout\.js:12:22\)/);
  assert.match(r.stdout, /handleCheckout@src\/main\.js:5:17/);
  // JSON log line got rewritten too and is still valid JSON.
  const jsonLine = r.stdout.split("\n").find((l) => l.startsWith("{"));
  assert.match(JSON.parse(jsonLine).stack, /applyDiscount \(src\/checkout\.js:6:5\)/);
  // The unmapped vendor frame survives; stats explain why.
  assert.match(r.stdout, /vendor\.min\.js:1:9101/);
  assert.match(r.stderr, /9 frame\(s\) found, 7 remapped/);
  assert.match(r.stderr, /no map for: .*vendor\.min\.js/);
});

test("remap is the default command and reads stdin", () => {
  const input = "    at d (https://cdn.example.test/assets/app.min.js:1:36)\n";
  const r = runCli(["--maps", EX("dist")], { input });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "    at applyDiscount (src/checkout.js:6:5)\n");
});

test("remap --output writes a file instead of stdout", () => {
  const dir = makeTree({});
  try {
    const out = path.join(dir, "clean.log");
    const r = runCli(["remap", EX("logs/prod.log"), "--maps", EX("dist"), "-o", out]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(fs.readFileSync(out, "utf8"), /applyDiscount/);
  } finally {
    rmTree(dir);
  }
});

test("remap --fail-unmapped exits 1 when frames stay minified", () => {
  const ok = runCli(
    ["remap", "--fail-unmapped", "--maps", EX("dist")],
    { input: "at d (app.min.js:1:36)\n" }
  );
  assert.equal(ok.status, 0);
  const bad = runCli(
    ["remap", "--fail-unmapped", "--maps", EX("dist")],
    { input: "at t (vendor.min.js:1:9)\n" }
  );
  assert.equal(bad.status, 1);
  // Output is still produced — the gate only affects the exit code.
  assert.match(bad.stdout, /vendor\.min\.js:1:9/);
});

test("remap --fail-unmapped excuses runtime-internal frames", () => {
  // node:internal frames appear in almost every Node trace and can never
  // have a source map — a fully remapped trace must still pass the gate.
  const input =
    "at d (app.min.js:1:36)\n" +
    "at processTicksAndRejections (node:internal/process/task_queues:95:5)\n";
  const r = runCli(["remap", "--fail-unmapped", "--maps", EX("dist")], { input });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /applyDiscount/);
});

test("frame resolves a single position with source context", () => {
  const r = runCli(["frame", "app.min.js:1:36", "--maps", EX("dist")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /→ src\/checkout\.js:6:5 \(applyDiscount\)/);
  assert.match(r.stdout, /> 6 \|\s+throw new Error/);
  const noCtx = runCli(["frame", "app.min.js:1:36", "--maps", EX("dist"), "-c", "0"]);
  assert.doesNotMatch(noCtx.stdout, /throw new Error/);
});

test("frame --format json emits the stable machine shape", () => {
  const r = runCli(["frame", "app.min.js:1:36", "--maps", EX("dist"), "--format", "json"]);
  assert.equal(r.status, 0);
  const j = JSON.parse(r.stdout);
  assert.equal(j.source, "src/checkout.js");
  assert.equal(j.line, 6);
  assert.equal(j.column, 5);
  assert.equal(j.name, "applyDiscount");
});

test("frame exits 1 for unresolvable bundles or unmapped positions", () => {
  const noMap = runCli(["frame", "ghost.js:1:1"]);
  assert.equal(noMap.status, 1);
  assert.match(noMap.stderr, /no source map found/);
  const noMapping = runCli(["frame", "app.min.js:99:1", "--maps", EX("dist")]);
  assert.equal(noMapping.status, 1);
  assert.match(noMapping.stderr, /no mapping at 99:1/);
});

test("check passes the clean example and fails the broken one", () => {
  const clean = runCli(["check", EX("dist")]);
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /OK — 0 error\(s\), 0 warning\(s\), 0 info/);
  const broken = runCli(["check", EX("broken")]);
  assert.equal(broken.status, 1);
  for (const code of ["E105", "W202", "W205", "W206"]) {
    assert.match(broken.stdout, new RegExp(code), code);
  }
  assert.match(broken.stdout, /FAIL — 1 error\(s\), 3 warning\(s\)/);
});

test("check --fail-on moves the gate; --format json is parseable", () => {
  const never = runCli(["check", EX("broken"), "--fail-on", "never"]);
  assert.equal(never.status, 0);
  const errOnly = runCli(["check", EX("broken"), "--fail-on", "error"]);
  assert.equal(errOnly.status, 1); // E105 is an error
  const json = runCli(["check", EX("broken"), "--format", "json"]);
  assert.equal(json.status, 1);
  const j = JSON.parse(json.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.summary.errors, 1);
  assert.equal(j.summary.warnings, 3);
  assert.ok(j.findings.every((f) => f.code && f.severity && f.fix));
});

test("inspect summarizes a map in text and JSON", () => {
  const r = runCli(["inspect", EX("dist/app.min.js.map")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sources:\s+2/);
  assert.match(r.stdout, /names:\s+3/);
  assert.match(r.stdout, /12 segment\(s\)/);
  assert.match(r.stdout, /sourcesContent:\s+embedded/);
  const j = JSON.parse(
    runCli(["inspect", EX("dist/app.min.js.map"), "--format", "json"]).stdout
  );
  assert.equal(j.file, "app.min.js");
  assert.equal(j.mappings, 12);
  const bad = runCli(["inspect", "/no/such.map"]);
  assert.equal(bad.status, 2);
});

test("--map pins a bundle to a map without any directory scan", () => {
  const dir = makeTree({
    "renamed.map": mapJson({
      sources: ["src/x.js"],
      names: ["go"],
      mappings: encodeMappings([[[0, 0, 0, 0, 0]]]),
    }),
  });
  try {
    const r = runCli(
      ["remap", "--map", `widget.js=${path.join(dir, "renamed.map")}`],
      { input: "at w (https://cdn.example.test/widget.js:1:1)\n" }
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "at go (src/x.js:1:1)\n");
  } finally {
    rmTree(dir);
  }
});

test("remap output is deterministic across runs", () => {
  const a = runCli(["remap", EX("logs/prod.log"), "--maps", EX("dist")]);
  const b = runCli(["remap", EX("logs/prod.log"), "--maps", EX("dist")]);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.status, 0);
});
