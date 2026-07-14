// SourceMap parsing and position lookup: flat maps, indexed maps with
// sections, sourceRoot handling, tolerant decoding of semantically broken
// maps, and the display-path cleaning applied to bundler pseudo-schemes.
import test from "node:test";
import assert from "node:assert/strict";
import { SourceMap, MapError, cleanSourcePath } from "../dist/index.js";
import { encodeMappings, mapJson } from "./helpers.mjs";

test("looks up an exact segment position", () => {
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["src/app.js"],
      names: ["boot"],
      mappings: encodeMappings([[[0, 0, 0, 0], [10, 0, 4, 2, 0]]]),
    })
  );
  // Stack-trace coordinates are 1-based; column 11 sits on genCol 10.
  const pos = map.originalPositionFor(1, 11);
  assert.deepEqual(pos, {
    source: "src/app.js",
    rawSource: "src/app.js",
    line: 5,
    column: 3,
    name: "boot",
  });
});

test("binary search picks the nearest segment at or before the column", () => {
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["a.js"],
      mappings: encodeMappings([[[0, 0, 0, 0], [20, 0, 1, 0], [40, 0, 2, 0]]]),
    })
  );
  assert.equal(map.originalPositionFor(1, 25).line, 2); // between 20 and 40
  assert.equal(map.originalPositionFor(1, 21).line, 2); // exactly on 20
  assert.equal(map.originalPositionFor(1, 999).line, 3); // past the last
});

test("returns null for unmapped positions and source-less holes", () => {
  const map = SourceMap.fromJson(
    mapJson({ mappings: encodeMappings([[[5, 0, 0, 0]]]) })
  );
  assert.equal(map.originalPositionFor(1, 3), null); // column before genCol 5
  assert.equal(map.originalPositionFor(2, 1), null); // no such generated line
  assert.equal(map.originalPositionFor(0, 0), null); // nonsense coordinates
  // 1-field segments are unmapped holes: null inside, mapped after.
  const holes = SourceMap.fromJson(
    mapJson({ mappings: encodeMappings([[[0], [10, 0, 0, 0]]]) })
  );
  assert.equal(holes.originalPositionFor(1, 5), null);
  assert.equal(holes.originalPositionFor(1, 11).line, 1);
});

test("second generated line carries source state across the semicolon", () => {
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["a.js", "b.js"],
      mappings: encodeMappings([
        [[0, 1, 9, 0]], // line 1 -> b.js:10
        [[4, 1, 11, 2]], // line 2 -> b.js:12 (deltas relative to line 1)
      ]),
    })
  );
  const pos = map.originalPositionFor(2, 5);
  assert.equal(pos.source, "b.js");
  assert.equal(pos.line, 12);
  assert.equal(pos.column, 3);
});

test("sourceRoot prefixes relative sources; cleaning strips bundler noise", () => {
  assert.equal(cleanSourcePath("webpack://my-app/./src/x.js"), "src/x.js");
  assert.equal(cleanSourcePath("webpack://ns/src/y.js?abcd"), "src/y.js");
  assert.equal(cleanSourcePath("./src/z.js"), "src/z.js");
  assert.equal(cleanSourcePath("https://example.test/a.js"), "https://example.test/a.js");
  assert.equal(cleanSourcePath("plain/path.js"), "plain/path.js");
  const map = SourceMap.fromJson(
    mapJson({
      sourceRoot: "https://example.test/app",
      sources: ["src/x.js", "/abs/y.js"],
      mappings: encodeMappings([[[0, 0, 0, 0], [5, 1, 0, 0]]]),
    })
  );
  assert.equal(map.originalPositionFor(1, 1).rawSource, "src/x.js");
  // http(s) roots are kept verbatim — only bundler pseudo-schemes are cleaned.
  assert.equal(
    map.originalPositionFor(1, 1).source,
    "https://example.test/app/src/x.js"
  );
  assert.equal(map.originalPositionFor(1, 6).source, "/abs/y.js");
});

test("indexed maps: sections merge with line and first-line column offsets", () => {
  const section = (sources, names, mappings) => ({
    version: 3,
    sources,
    names,
    mappings,
  });
  const map = SourceMap.fromJson(
    JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: section(["one.js"], [], encodeMappings([[[0, 0, 0, 0]]])),
        },
        {
          offset: { line: 2, column: 10 },
          map: section(["two.js"], ["fn"], encodeMappings([
            [[3, 0, 0, 0, 0]], // section line 1: column offset applies (3+10)
            [[7, 0, 1, 0]], // section line 2: no column offset
          ])),
        },
      ],
    })
  );
  assert.equal(map.originalPositionFor(1, 1).source, "one.js");
  const shifted = map.originalPositionFor(3, 14); // genCol 13 = 3 + offset 10
  assert.equal(shifted.source, "two.js");
  assert.equal(shifted.name, "fn");
  assert.equal(map.originalPositionFor(4, 8).source, "two.js");
  assert.equal(map.originalPositionFor(4, 8).line, 2);
});

test("indexed maps reject unsorted or offset-less sections", () => {
  const mk = (sections) =>
    SourceMap.fromJson(JSON.stringify({ version: 3, sections }));
  const sub = { version: 3, sources: ["a.js"], names: [], mappings: "AAAA" };
  assert.throws(
    () => mk([{ offset: { line: 5, column: 0 }, map: sub }, { offset: { line: 1, column: 0 }, map: sub }]),
    (e) => e instanceof MapError && e.code === "sections"
  );
  assert.throws(
    () => mk([{ map: sub }]),
    (e) => e instanceof MapError && e.code === "sections"
  );
});

test("fatal defects throw MapError with a stable code", () => {
  assert.throws(() => SourceMap.fromJson("not json"), (e) => e.code === "json");
  assert.throws(
    () => SourceMap.fromJson(mapJson({ version: 2 })),
    (e) => e.code === "version"
  );
  assert.throws(
    () => SourceMap.fromJson(JSON.stringify({ version: 3, names: [], mappings: "" })),
    (e) => e.code === "sources"
  );
  assert.throws(
    () => SourceMap.fromJson(mapJson({ mappings: "AA" })), // 2 fields: invalid
    (e) => e.code === "mappings"
  );
  assert.throws(
    () => SourceMap.fromJson(mapJson({ mappings: "!!!" })),
    (e) => e.code === "mappings"
  );
});

test("out-of-range indices degrade gracefully and are recorded", () => {
  // A bogus source index drops the whole segment (never invent a source)…
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["a.js"],
      mappings: encodeMappings([[[0, 0, 0, 0], [10, 3, 0, 0]]]), // idx 3 of 1
    })
  );
  assert.equal(map.originalPositionFor(1, 11).line, 1); // falls back to seg 1
  assert.equal(map.problems.length, 1);
  assert.equal(map.problems[0].kind, "source-index");
  // …while a bogus name index keeps the position and drops only the name.
  const names = SourceMap.fromJson(
    mapJson({
      sources: ["a.js"],
      names: [],
      mappings: encodeMappings([[[0, 0, 0, 0, 9]]]), // name idx 9 of 0
    })
  );
  const pos = names.originalPositionFor(1, 1);
  assert.equal(pos.line, 1);
  assert.equal(pos.name, null);
  assert.equal(names.problems[0].kind, "name-index");
});

test("out-of-order lines are re-sorted so lookup still works", () => {
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["a.js"],
      // genCols 30 then 10: encoded delta for the second segment is negative.
      mappings: encodeMappings([[[30, 0, 2, 0], [10, 0, 1, 0]]]),
    })
  );
  assert.equal(map.problems[0].kind, "out-of-order");
  assert.equal(map.originalPositionFor(1, 11).line, 2);
  assert.equal(map.originalPositionFor(1, 31).line, 3);
});

test("contentFor finds embedded sources by raw or cleaned path", () => {
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["webpack://ns/src/app.js"],
      sourcesContent: ["line1\nline2\n"],
    })
  );
  assert.equal(map.contentFor("webpack://ns/src/app.js"), "line1\nline2\n");
  assert.equal(map.contentFor("src/app.js"), "line1\nline2\n");
  assert.equal(map.contentFor("missing.js"), null);
});


test("stats counts mappings, extent and unreferenced sources", () => {
  const map = SourceMap.fromJson(
    mapJson({
      sources: ["used.js", "dead.js"],
      names: ["n"],
      mappings: encodeMappings([[[0, 0, 0, 0, 0]], [], [[2, 0, 1, 0]]]),
    })
  );
  const s = map.stats();
  assert.equal(s.mappingCount, 2);
  assert.equal(s.maxGeneratedLine, 3);
  assert.equal(s.sourceCount, 2);
  assert.equal(s.nameCount, 1);
  assert.deepEqual(s.unreferencedSources, [1]);
});


