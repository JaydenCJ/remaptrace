// Frame recognition: the V8 and Gecko/JSC grammars, decorations (async,
// new, [as alias]), eval frames, URLs with ports, frames buried behind log
// prefixes, and the substring spans the rewriter depends on.
import test from "node:test";
import assert from "node:assert/strict";
import { findFrames, isInternalUrl, mayContainFrame } from "../dist/index.js";

test("parses a plain V8 frame with a function name", () => {
  const line = "    at applyDiscount (app.min.js:1:44)";
  const [f] = findFrames(line);
  assert.equal(f.style, "v8");
  assert.equal(f.func, "applyDiscount");
  assert.equal(f.url, "app.min.js");
  assert.equal(f.line, 1);
  assert.equal(f.column, 44);
  assert.equal(line.slice(f.locStart, f.locEnd), "app.min.js:1:44");
  assert.equal(line.slice(f.funcStart, f.funcEnd), "applyDiscount");
});

test("parses location-only V8 frames and keeps URL ports intact", () => {
  const [f] = findFrames("    at https://cdn.example.test/a.js:3:9");
  assert.equal(f.func, null);
  assert.equal(f.funcStart, -1);
  assert.equal(f.url, "https://cdn.example.test/a.js");
  assert.deepEqual([f.line, f.column], [3, 9]);
  const [p] = findFrames("    at boot (http://127.0.0.1:8080/static/app.js:7:21)");
  assert.equal(p.url, "http://127.0.0.1:8080/static/app.js");
  assert.deepEqual([p.line, p.column], [7, 21]);
});

test("async, new and [as alias] decorations are handled", () => {
  const cases = [
    ["    at async load (app.js:2:3)", "load"],
    ["    at new Widget (app.js:4:5)", "Widget"],
    ["    at Object.fn [as run] (app.js:6:7)", "Object.fn [as run]"],
  ];
  for (const [line, func] of cases) {
    const [f] = findFrames(line);
    assert.equal(f.func, func, line);
  }
});

test("V8 eval frames remap the eval-site location", () => {
  const line =
    "    at eval (eval at runScript (app.min.js:1:88), <anonymous>:2:10)";
  const frames = findFrames(line);
  const site = frames.find((f) => f.url === "app.min.js");
  assert.ok(site, "eval-at site found");
  assert.deepEqual([site.line, site.column], [1, 88]);
});

test("frames are found behind timestamps and log prefixes", () => {
  const line =
    "2026-07-12T09:14:03.184Z [req-9f2c] at handleCheckout (app.min.js:1:204)";
  const [f] = findFrames(line);
  assert.equal(f.func, "handleCheckout");
  assert.equal(f.column, 204);
});

test("parses Gecko/JSC frames: names, empty names, spaced labels", () => {
  const [a] = findFrames("computeTotal@app.min.js:1:139");
  assert.equal(a.style, "gecko");
  assert.equal(a.func, "computeTotal");
  const [b] = findFrames("@app.min.js:1:5");
  assert.equal(b.func, null);
  assert.deepEqual([b.line, b.column], [1, 5]);
  // Safari labels like "global code" contain a space.
  const [c] = findFrames("global code@https://example.test/app.js:12:4");
  assert.equal(c.func, "global code");
  assert.equal(c.url, "https://example.test/app.js");
});

test("multiple mixed-grammar frames come back left to right, no overlap", () => {
  const text =
    "Error: x\n    at a (app.js:1:2)\n    at b (app.js:3:4)\nnext@lib.js:5:6";
  const frames = findFrames(text);
  assert.deepEqual(
    frames.map((f) => [f.url, f.line, f.column]),
    [["app.js", 1, 2], ["app.js", 3, 4], ["lib.js", 5, 6]]
  );
  assert.ok(frames[0].locStart < frames[1].locStart);
  // V8 and Gecko matchers must not double-report the same span.
  const mixed = findFrames("    at a (x.js:1:2) b@y.js:3:4");
  assert.equal(mixed.length, 2);
  const spans = mixed.map((f) => `${f.locStart}-${f.locEnd}`);
  assert.equal(new Set(spans).size, 2);
});

test("plain prose with colons and numbers is not a frame", () => {
  assert.deepEqual(findFrames("processed 12:30:45 items at warp speed"), []);
  assert.deepEqual(findFrames("GET /api/v1/items 200 15ms"), []);
  assert.deepEqual(findFrames("ratio is 3:4:5 today"), []);
  // The cheap pre-filter must never reject a line the parser would match.
  const candidates = [
    "    at a (app.js:1:2)",
    "fn@x.js:1:2",
    "ts=1 at b (https://h:1/a.js:2:3)",
    "prose without frames",
    "12:30:45 no at-sign here either",
  ];
  for (const line of candidates) {
    if (findFrames(line).length > 0) {
      assert.equal(mayContainFrame(line), true, line);
    }
  }
});

test("isInternalUrl flags runtime-internal frames", () => {
  assert.equal(isInternalUrl("node:internal/process/task_queues"), true);
  assert.equal(isInternalUrl("<anonymous>"), true);
  assert.equal(isInternalUrl("[native code]"), true);
  assert.equal(isInternalUrl("app.min.js"), false);
});

