// Batch log processing: JSON log lines (nested values, key order, indent),
// the --no-json-lines escape hatch, trailing-newline preservation and the
// aggregate stats a pipeline gates on.
import test from "node:test";
import assert from "node:assert/strict";
import { MapResolver, processLog } from "../dist/index.js";
import { encodeMappings, mapJson, withTree } from "./helpers.mjs";

function fixture(fn) {
  withTree(
    {
      "app.min.js.map": mapJson({
        file: "app.min.js",
        sources: ["src/app.js"],
        names: ["boot"],
        mappings: encodeMappings([[[0, 0, 0, 0], [10, 0, 4, 2, 0]]]),
      }),
    },
    (dir) => fn(new MapResolver({ mapsDirs: [dir] }))
  );
}

test("plain-text traces are rewritten line by line", () => {
  fixture((resolver) => {
    const log = "boot failed\n    at d (app.min.js:1:11)\ndone\n";
    const { output, stats } = processLog(log, resolver);
    assert.equal(output, "boot failed\n    at boot (src/app.js:5:3)\ndone\n");
    assert.equal(stats.linesScanned, 3);
    assert.equal(stats.framesRemapped, 1);
  });
});

test("stacks inside JSON log lines are rewritten in place", () => {
  fixture((resolver) => {
    const line = JSON.stringify({
      level: "error",
      stack: "Error: x\n    at d (app.min.js:1:11)",
      count: 3,
    });
    const { output, stats } = processLog(line + "\n", resolver);
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.stack, "Error: x\n    at boot (src/app.js:5:3)");
    assert.equal(parsed.level, "error");
    assert.equal(parsed.count, 3);
    assert.equal(stats.jsonLinesRewritten, 1);
  });
});

test("JSON rewriting preserves key order and nested structures", () => {
  fixture((resolver) => {
    const line = JSON.stringify({
      z: 1,
      err: { frames: ["at d (app.min.js:1:11)"], code: "E" },
      a: 2,
    });
    const { output } = processLog(line + "\n", resolver);
    assert.equal(
      output.trim(),
      JSON.stringify({
        z: 1,
        err: { frames: ["at boot (src/app.js:5:3)"], code: "E" },
        a: 2,
      })
    );
  });
});

test("JSON lines: no-op lines stay verbatim, indented ones keep indent", () => {
  fixture((resolver) => {
    // Whitespace quirks must survive when no rewrite happens.
    const line = '{ "msg" :  "all good", "n": 7 }';
    const { output, stats } = processLog(line + "\n", resolver);
    assert.equal(output, line + "\n");
    assert.equal(stats.jsonLinesRewritten, 0);
    // Leading indentation survives a rewrite.
    const indented = '   {"stack":"at d (app.min.js:1:11)"}';
    const { output: out2 } = processLog(indented + "\n", resolver);
    assert.equal(out2, '   {"stack":"at boot (src/app.js:5:3)"}\n');
  });
});

test("raw-text fallback: --no-json-lines and lines that only look like JSON", () => {
  fixture((resolver) => {
    const line = '{"stack":"at d (app.min.js:1:11)"}';
    const { output, stats } = processLog(line + "\n", resolver, {
      jsonLines: false,
    });
    // The frame is still found in the raw bytes; JSON accounting stays 0.
    assert.equal(stats.jsonLinesRewritten, 0);
    assert.match(output, /src\/app\.js:5:3/);
    // Malformed near-JSON falls back to plain-text rewriting too.
    const broken = '{broken json at d (app.min.js:1:11)';
    const { output: out2 } = processLog(broken + "\n", resolver);
    assert.equal(out2, "{broken json at boot (src/app.js:5:3)\n");
  });
});

test("input without a trailing newline stays without one", () => {
  fixture((resolver) => {
    const { output } = processLog("at d (app.min.js:1:11)", resolver);
    assert.equal(output, "at boot (src/app.js:5:3)");
    const { output: nl } = processLog("x\n", resolver);
    assert.equal(nl, "x\n");
  });
});

test("stats aggregate across mixed lines", () => {
  fixture((resolver) => {
    const log = [
      "    at d (app.min.js:1:11)",
      "    at t (vendor.min.js:1:9)",
      "    at q (node:internal/timers:1:1)",
      "prose line",
      "",
    ].join("\n");
    const { stats } = processLog(log, resolver);
    assert.equal(stats.framesFound, 3);
    assert.equal(stats.framesRemapped, 1);
    assert.equal(stats.framesUnmapped, 1); // the node: internal frame
    assert.deepEqual([...stats.unresolved.keys()], ["vendor.min.js"]);
    assert.equal(stats.linesScanned, 4); // trailing newline ends line 4

  });
});
