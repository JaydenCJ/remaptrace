// The rewriter: in-place frame splicing, name substitution, growth of
// location-only frames, stats accounting, and the pass-through guarantee
// for unresolvable frames.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  MapResolver,
  remapText,
  newStats,
  findFrames,
  spliceFrame,
} from "../dist/index.js";
import { encodeMappings, mapJson, withTree } from "./helpers.mjs";

/** A map for bundle app.min.js: genCol 10 -> src/app.js:5:3 (name "boot"). */
function fixtureMap() {
  return mapJson({
    file: "app.min.js",
    sources: ["src/app.js"],
    names: ["boot"],
    mappings: encodeMappings([[[0, 0, 0, 0], [10, 0, 4, 2, 0]]]),
  });
}

function resolverFor(dir) {
  return new MapResolver({ mapsDirs: [dir] });
}

test("rewrites a V8 frame's location and function name in place", () => {
  withTree({ "app.min.js.map": fixtureMap() }, (dir) => {
    const stats = newStats();
    const out = remapText(
      "    at d (app.min.js:1:11)",
      resolverFor(dir),
      stats
    );
    assert.equal(out, "    at boot (src/app.js:5:3)");
    assert.equal(stats.framesRemapped, 1);
  });
});

test("log prefix bytes around the frame survive untouched", () => {
  withTree({ "app.min.js.map": fixtureMap() }, (dir) => {
    const prefix = "2026-07-12T09:14:03Z [req-1] ";
    const out = remapText(
      `${prefix}at d (app.min.js:1:11) trailing`,
      resolverFor(dir),
      newStats()
    );
    assert.equal(out, `${prefix}at boot (src/app.js:5:3) trailing`);
  });
});

test("location-only V8 frames grow a name and parentheses", () => {
  withTree({ "app.min.js.map": fixtureMap() }, (dir) => {
    const out = remapText("    at app.min.js:1:11", resolverFor(dir), newStats());
    assert.equal(out, "    at boot (src/app.js:5:3)");
  });
});

test("gecko frames are rewritten, growing a name when absent", () => {
  withTree({ "app.min.js.map": fixtureMap() }, (dir) => {
    const r = resolverFor(dir);
    assert.equal(
      remapText("d@app.min.js:1:11", r, newStats()),
      "boot@src/app.js:5:3"
    );
    assert.equal(
      remapText("@app.min.js:1:11", r, newStats()),
      "boot@src/app.js:5:3"
    );
  });
});

test("a mapped position without a name keeps the minified name", () => {
  withTree({ "app.min.js.map": fixtureMap() }, (dir) => {
    const out = remapText("    at d (app.min.js:1:1)", resolverFor(dir), newStats());
    assert.equal(out, "    at d (src/app.js:1:1)");
  });
});

test("unresolvable and internal frames pass through byte-identical", () => {
  const stats = newStats();
  const line = "    at t (vendor.min.js:1:9101)";
  assert.equal(remapText(line, new MapResolver({}), stats), line);
  assert.equal(stats.framesRemapped, 0);
  assert.equal(stats.unresolved.get("vendor.min.js"), 1);
  // Runtime-internal frames count as unmapped, not unresolved.
  const internal = "    at x (node:internal/process/task_queues:95:5)";
  assert.equal(remapText(internal, new MapResolver({}), stats), internal);
  assert.equal(stats.framesUnmapped, 1);
  assert.equal(stats.unresolved.size, 1);
});

test("multiple frames on one string all get rewritten right-to-left", () => {
  withTree({ "app.min.js.map": fixtureMap() }, (dir) => {
    const text = "at d (app.min.js:1:11)\nat d (app.min.js:1:11)";
    const out = remapText(text, resolverFor(dir), newStats());
    assert.equal(out, "at boot (src/app.js:5:3)\nat boot (src/app.js:5:3)");
  });
});

test("spliceFrame keeps offsets consistent when the location shrinks", () => {
  const line = "    at veryLongMinifiedName (https://cdn.example.test/assets/app.min.js:1:11)";
  const [frame] = findFrames(line);
  const out = spliceFrame(line, frame, {
    source: "a.js",
    rawSource: "a.js",
    line: 2,
    column: 3,
    name: "fn",
  });
  assert.equal(out, "    at fn (a.js:2:3)");
});

test("the bundled example log remaps to the documented output", () => {
  // End-to-end against the shipped fixtures — the same run the README shows.
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
  const log = fs.readFileSync(path.join(root, "examples/logs/prod.log"), "utf8");
  const resolver = new MapResolver({
    mapsDirs: [path.join(root, "examples/dist")],
  });
  const stats = newStats();
  const lines = log.split("\n");
  const out = lines.map((l) => remapText(l, resolver, stats)).join("\n");
  assert.match(out, /at applyDiscount \(src\/checkout\.js:6:5\)/);
  assert.match(out, /at computeTotal \(src\/checkout\.js:12:22\)/);
  assert.match(out, /at handleCheckout \(src\/main\.js:5:17\)/);
  assert.match(out, /handleCheckout@src\/main\.js:5:17/);
  // vendor bundle has no map: the raw frame must survive.
  assert.match(out, /vendor\.min\.js:1:9101/);
});
