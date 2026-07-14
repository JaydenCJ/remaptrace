// Bundle/map consistency validation: one test per rule code, plus directory
// scanning and the clean-pair baseline. Codes are stable API — these tests
// pin them.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { checkTarget, checkBundle, checkMapText, summarize } from "../dist/index.js";
import { encodeMappings, mapJson, withTree } from "./helpers.mjs";

const codes = (findings) => findings.map((f) => f.code).sort();

/** A bundle + map pair with nothing wrong. */
function cleanPair() {
  return {
    "app.min.js": "function a(){}\n//# sourceMappingURL=app.min.js.map\n",
    "app.min.js.map": mapJson({
      file: "app.min.js",
      sources: ["src/a.js"],
      sourcesContent: ["function a() {}\n"],
      mappings: encodeMappings([[[0, 0, 0, 0]]]),
    }),
  };
}

test("a clean pair produces zero findings", () => {
  withTree(cleanPair(), (dir) => {
    assert.deepEqual(checkBundle(path.join(dir, "app.min.js")), []);
  });
});

test("E101: unreadable or non-JSON map", () => {
  withTree({ "x.map": "{oops" }, (dir) => {
    assert.deepEqual(codes(checkTarget(path.join(dir, "x.map"))), ["E101"]);
  });
  assert.deepEqual(codes(checkTarget("/no/such/path/anywhere")), ["E101"]);
});

test("E102/E103: wrong version and corrupt mappings", () => {
  const version = checkMapText("m", mapJson({ version: 7 }));
  assert.deepEqual(codes(version.findings), ["E102"]);
  const bad = checkMapText("m", mapJson({ mappings: "?" }));
  assert.deepEqual(codes(bad.findings), ["E103"]);
  const twoFields = checkMapText("m", mapJson({ mappings: "AA" }));
  assert.deepEqual(codes(twoFields.findings), ["E103"]);
});

test("E104: sources missing", () => {
  const { findings } = checkMapText(
    "m",
    JSON.stringify({ version: 3, names: [], mappings: "AAAA" })
  );
  assert.deepEqual(codes(findings), ["E104"]);
});

test("E105: segment source index out of range", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({
      sources: ["a.js"],
      sourcesContent: ["x"],
      mappings: encodeMappings([[[0, 5, 0, 0]]]),
    })
  );
  assert.ok(codes(findings).includes("E105"));
});

test("E106: segment name index out of range", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({
      sources: ["a.js"],
      sourcesContent: ["x"],
      names: [],
      mappings: encodeMappings([[[0, 0, 0, 0, 3]]]),
    })
  );
  assert.ok(codes(findings).includes("E106"));
});

test("W201: sourcesContent length mismatch", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({
      sources: ["a.js", "b.js"],
      sourcesContent: ["only one"],
      mappings: encodeMappings([[[0, 0, 0, 0], [1, 1, 0, 0]]]),
    })
  );
  assert.ok(codes(findings).includes("W201"));
});

test("W202: no sourcesContent at all", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({ sources: ["a.js"], mappings: encodeMappings([[[0, 0, 0, 0]]]) })
  );
  assert.deepEqual(codes(findings), ["W202"]);
});

test("W203: bundle without a sourceMappingURL comment", () => {
  withTree({ "b.js": "x;\n" }, (dir) => {
    assert.deepEqual(codes(checkBundle(path.join(dir, "b.js"))), ["W203"]);
  });
  // An adjacent map is still validated even without the comment.
  withTree(
    {
      "b.js": "x;\n",
      "b.js.map": mapJson({
        file: "b.js",
        sources: ["s.js"],
        sourcesContent: ["x"],
        mappings: encodeMappings([[[0, 0, 0, 0]]]),
      }),
    },
    (dir) => {
      assert.deepEqual(codes(checkBundle(path.join(dir, "b.js"))), ["W203"]);
    }
  );
});

test("W204: sourceMappingURL points at a missing file", () => {
  withTree(
    { "b.js": "x;\n//# sourceMappingURL=gone.map\n" },
    (dir) => {
      assert.deepEqual(codes(checkBundle(path.join(dir, "b.js"))), ["W204"]);
    }
  );
});

test("W205: map file field names a different bundle", () => {
  withTree(
    {
      "b.js": "x;\n//# sourceMappingURL=b.js.map\n",
      "b.js.map": mapJson({
        file: "other.js",
        sources: ["s.js"],
        sourcesContent: ["x"],
        mappings: encodeMappings([[[0, 0, 0, 0]]]),
      }),
    },
    (dir) => {
      assert.deepEqual(codes(checkBundle(path.join(dir, "b.js"))), ["W205"]);
    }
  );
});

test("W206: map addresses lines beyond the bundle (stale pair)", () => {
  withTree(
    {
      "b.js": "x;\n//# sourceMappingURL=b.js.map\n",
      "b.js.map": mapJson({
        file: "b.js",
        sources: ["s.js"],
        sourcesContent: ["x"],
        // Segments on generated lines 1 and 9; the bundle has 3 lines.
        mappings: encodeMappings([[[0, 0, 0, 0]], [], [], [], [], [], [], [], [[0, 0, 1, 0]]]),
      }),
    },
    (dir) => {
      assert.deepEqual(codes(checkBundle(path.join(dir, "b.js"))), ["W206"]);
    }
  );
});

test("W207: out-of-order segments on a generated line", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({
      sources: ["a.js"],
      sourcesContent: ["x"],
      mappings: encodeMappings([[[9, 0, 0, 0], [2, 0, 1, 0]]]),
    })
  );
  assert.deepEqual(codes(findings), ["W207"]);
});

test("I301: zero mappings", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({ sources: [], sourcesContent: [], mappings: "" })
  );
  assert.deepEqual(codes(findings), ["I301"]);
});

test("I302: sources never referenced by any mapping", () => {
  const { findings } = checkMapText(
    "m",
    mapJson({
      sources: ["used.js", "dead.js"],
      sourcesContent: ["x", "y"],
      mappings: encodeMappings([[[0, 0, 0, 0]]]),
    })
  );
  assert.deepEqual(codes(findings), ["I302"]);
});

test("inline data: URI maps are validated through the bundle", () => {
  const inline = Buffer.from(
    mapJson({ sources: ["s.js"], mappings: encodeMappings([[[0, 0, 0, 0]]]) })
  ).toString("base64");
  withTree(
    { "b.js": `x;\n//# sourceMappingURL=data:application/json;base64,${inline}\n` },
    (dir) => {
      const findings = checkBundle(path.join(dir, "b.js"));
      assert.deepEqual(codes(findings), ["W202"]); // no sourcesContent inline
    }
  );
});

test("directory targets check every bundle plus orphan maps", () => {
  withTree(
    {
      ...cleanPair(),
      "old.js.map": mapJson({ version: 1 }), // orphan, wrong version
      "notes.txt": "not a bundle",
    },
    (dir) => {
      const findings = checkTarget(dir);
      assert.deepEqual(codes(findings), ["E102"]);
    }
  );
});

test("summarize buckets severities for the gate", () => {
  const s = summarize([
    { code: "E101", severity: "error", file: "f", message: "", fix: "" },
    { code: "W201", severity: "warning", file: "f", message: "", fix: "" },
    { code: "W202", severity: "warning", file: "f", message: "", fix: "" },
    { code: "I301", severity: "info", file: "f", message: "", fix: "" },
  ]);
  assert.deepEqual(s, { errors: 1, warnings: 2, infos: 1 });
});
