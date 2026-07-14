// Map resolution: explicit pairs, maps-directory lookup by name and by
// `file` field, sourceMappingURL comments (relative paths and data: URIs),
// URL path helpers, and result caching.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  MapResolver,
  urlPath,
  urlBasename,
  sourceMappingUrlOf,
  dataUriToJson,
} from "../dist/index.js";
import { mapJson, withTree } from "./helpers.mjs";

test("urlPath/urlBasename strip scheme, host, query and fragment", () => {
  assert.equal(urlPath("https://cdn.example.test/assets/app.js?v=9#x"), "/assets/app.js");
  assert.equal(urlPath("http://127.0.0.1:8080/a/b.js"), "/a/b.js");
  assert.equal(urlPath("/srv/dist/app.js"), "/srv/dist/app.js");
  assert.equal(urlPath("app.min.js"), "app.min.js");
  assert.equal(urlBasename("https://cdn.example.test/a/app.min.js?v=1"), "app.min.js");
  assert.equal(urlBasename("app.min.js"), "app.min.js");
  assert.equal(urlBasename("/x/y/z.js"), "z.js");
});

test("resolves via a maps directory by conventional <bundle>.map name", () => {
  withTree({ "app.min.js.map": mapJson() }, (dir) => {
    const r = new MapResolver({ mapsDirs: [dir] });
    const hit = r.resolve("https://cdn.example.test/assets/app.min.js");
    assert.ok(hit);
    assert.equal(hit.origin, path.join(dir, "app.min.js.map"));
  });
});

test("falls back to the map's `file` field when names do not line up", () => {
  withTree(
    { "build-7f3a.map": mapJson({ file: "app.min.js" }) },
    (dir) => {
      const r = new MapResolver({ mapsDirs: [dir] });
      const hit = r.resolve("https://cdn.example.test/app.min.js");
      assert.ok(hit);
      assert.equal(hit.origin, path.join(dir, "build-7f3a.map"));
    }
  );
});

test("explicit --map pairs win over directory lookup and match flexibly", () => {
  withTree(
    {
      "app.min.js.map": mapJson({ file: "wrong.js" }),
      "pinned.map": mapJson({ file: "app.min.js" }),
    },
    (dir) => {
      const r = new MapResolver({
        mapsDirs: [dir],
        pairs: [["app.min.js", path.join(dir, "pinned.map")]],
      });
      const hit = r.resolve("https://cdn.example.test/x/app.min.js");
      assert.equal(hit.origin, path.join(dir, "pinned.map"));
      // Pairs also match by full URL and by path suffix.
      const full = new MapResolver({
        pairs: [["https://cdn.example.test/a/b.js", path.join(dir, "pinned.map")]],
      });
      assert.ok(full.resolve("https://cdn.example.test/a/b.js"));
      const suffix = new MapResolver({
        pairs: [["a/b.js", path.join(dir, "pinned.map")]],
      });
      assert.ok(suffix.resolve("https://cdn.example.test/x/a/b.js"));
    }
  );
});

test("local bundles resolve through their sourceMappingURL comment", () => {
  withTree(
    {
      "out/bundle.js": "x;\n//# sourceMappingURL=maps/bundle.js.map\n",
      "out/maps/bundle.js.map": mapJson(),
    },
    (dir) => {
      const r = new MapResolver({ baseDir: dir });
      const hit = r.resolve("out/bundle.js");
      assert.ok(hit);
      assert.equal(hit.origin, path.join(dir, "out/maps/bundle.js.map"));
    }
  );
});

test("adjacent <bundle>.map is used when no comment exists", () => {
  withTree(
    { "b.js": "x;\n", "b.js.map": mapJson() },
    (dir) => {
      const r = new MapResolver({ baseDir: dir });
      const hit = r.resolve("b.js");
      assert.equal(hit.origin, path.join(dir, "b.js.map"));
    }
  );
});

test("inline data: URI maps are decoded from the bundle comment", () => {
  const uri =
    "data:application/json;base64," +
    Buffer.from(mapJson({ file: "b.js" })).toString("base64");
  withTree({ "b.js": `x;\n//# sourceMappingURL=${uri}\n` }, (dir) => {
    const r = new MapResolver({ baseDir: dir });
    const hit = r.resolve("b.js");
    assert.ok(hit);
    assert.equal(hit.map.file, "b.js");
    assert.match(hit.origin, /inline data: URI/);
  });
});

test("sourceMappingUrlOf and dataUriToJson cover the comment dialects", () => {
  assert.equal(sourceMappingUrlOf("x;\n//# sourceMappingURL=a.map\n"), "a.map");
  assert.equal(sourceMappingUrlOf("x;\n//@ sourceMappingURL=b.map"), "b.map");
  assert.equal(sourceMappingUrlOf("x;\n/*# sourceMappingURL=c.map */"), "c.map");
  assert.equal(
    sourceMappingUrlOf("//# sourceMappingURL=old.map\ny;\n//# sourceMappingURL=new.map\n"),
    "new.map" // the last comment wins, matching browser behavior
  );
  assert.equal(sourceMappingUrlOf("no comment here"), null);
  const json = '{"version":3}';
  const b64 = "data:application/json;base64," + Buffer.from(json).toString("base64");
  assert.equal(dataUriToJson(b64), json);
  const pct = "data:application/json," + encodeURIComponent(json);
  assert.equal(dataUriToJson(pct), json);
  assert.throws(() => dataUriToJson("not-a-data-uri"));
});

test("misses are cached, remote URLs never fetched, bad maps never crash", () => {
  const r = new MapResolver({});
  // https URL with no local counterpart: definitive miss, twice (cache path).
  assert.equal(r.resolve("https://cdn.example.test/gone.js"), null);
  assert.equal(r.resolve("https://cdn.example.test/gone.js"), null);
  // A map that exists but does not parse resolves to null (check explains why).
  withTree({ "app.min.js.map": "{ not json" }, (dir) => {
    const bad = new MapResolver({ mapsDirs: [dir] });
    assert.equal(bad.resolve("app.min.js"), null);
  });
});
