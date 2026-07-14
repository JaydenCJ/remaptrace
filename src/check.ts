/**
 * Bundle/map consistency validation — the part of the job that bites teams
 * *after* they think symbolication is set up: a stale map from the previous
 * deploy, a map whose `file` field names a different bundle, sourcesContent
 * silently dropped by a build flag. Every rule has a stable code that is
 * never renumbered; errors mean remapping is broken now, warnings mean it
 * will be wrong or degraded, infos are worth knowing.
 *
 *   E101 map is unreadable or not valid JSON
 *   E102 unsupported `version` (only revision 3 is defined)
 *   E103 `mappings` is malformed (bad VLQ or wrong field count)
 *   E104 `sources` is missing or not an array
 *   E105 segment references a source index that does not exist
 *   E106 segment references a name index that does not exist
 *   W201 `sourcesContent` length differs from `sources`
 *   W202 no `sourcesContent` — frame context is unavailable
 *   W203 bundle carries no sourceMappingURL comment
 *   W204 sourceMappingURL points at a file that is not there
 *   W205 map `file` field names a different bundle
 *   W206 map addresses generated lines beyond the end of the bundle (stale pair)
 *   W207 segments on a generated line are out of order
 *   I301 map decodes to zero mappings
 *   I302 sources never referenced by any mapping
 */

import fs from "node:fs";
import path from "node:path";
import { SourceMap, MapError } from "./sourcemap.js";
import { sourceMappingUrlOf, dataUriToJson, isFile } from "./resolve.js";
import type { Finding, Severity } from "./types.js";

function finding(
  code: string,
  severity: Severity,
  file: string,
  message: string,
  fix: string
): Finding {
  return { code, severity, file, message, fix };
}

/** Validate one map file on its own. Returns findings plus the map if usable. */
export function checkMapFile(mapPath: string): {
  findings: Finding[];
  map: SourceMap | null;
} {
  let text: string;
  try {
    text = fs.readFileSync(mapPath, "utf8");
  } catch (e) {
    return {
      findings: [
        finding(
          "E101",
          "error",
          mapPath,
          `cannot read map: ${(e as Error).message}`,
          "point remaptrace at an existing, readable .map file"
        ),
      ],
      map: null,
    };
  }
  return checkMapText(mapPath, text);
}

/** Validate map JSON text (also used for inline data: URI maps). */
export function checkMapText(
  label: string,
  text: string
): { findings: Finding[]; map: SourceMap | null } {
  const findings: Finding[] = [];
  let map: SourceMap;
  try {
    map = SourceMap.fromJson(text);
  } catch (e) {
    if (e instanceof MapError) {
      const table: Record<MapError["code"], [string, string]> = {
        json: ["E101", "regenerate the map — the file is not source-map JSON"],
        version: ["E102", "regenerate with a tool that emits source map revision 3"],
        mappings: ["E103", "regenerate the map — the mappings string is corrupt"],
        sources: ["E104", "regenerate the map with a `sources` array"],
        sections: ["E103", "regenerate the indexed map with valid, sorted sections"],
      };
      const entry = table[e.code];
      findings.push(finding(entry[0], "error", label, e.message, entry[1]));
      return { findings, map: null };
    }
    throw e;
  }

  for (const p of map.problems) {
    if (p.kind === "source-index") {
      findings.push(
        finding(
          "E105",
          "error",
          label,
          p.detail,
          "regenerate the map — its segments and sources disagree"
        )
      );
    } else if (p.kind === "name-index") {
      findings.push(
        finding(
          "E106",
          "error",
          label,
          p.detail,
          "regenerate the map — its segments and names disagree"
        )
      );
    } else {
      findings.push(
        finding(
          "W207",
          "warning",
          label,
          p.detail,
          "regenerate the map; consumers that binary-search unsorted lines return wrong positions"
        )
      );
    }
  }

  const stats = map.stats();
  if (map.declaredSourcesContent && map.sourcesContentLength !== map.sources.length) {
    findings.push(
      finding(
        "W201",
        "warning",
        label,
        `sourcesContent has ${map.sourcesContentLength} entries but sources has ${map.sources.length}`,
        "regenerate the map so the two arrays stay parallel"
      )
    );
  } else if (!stats.hasSourcesContent && map.sources.length > 0) {
    findings.push(
      finding(
        "W202",
        "warning",
        label,
        "map embeds no sourcesContent — remapped frames cannot show source context",
        "enable embedded sources in the bundler (e.g. sourcesContent / includeSources)"
      )
    );
  }
  if (stats.mappingCount === 0) {
    findings.push(
      finding(
        "I301",
        "info",
        label,
        "map decodes to zero mappings — every lookup will miss",
        "confirm the build actually emitted mappings for this bundle"
      )
    );
  }
  if (stats.unreferencedSources.length > 0 && stats.mappingCount > 0) {
    const sample = stats.unreferencedSources
      .slice(0, 3)
      .map((i) => map.sources[i] ?? `#${i}`)
      .join(", ");
    findings.push(
      finding(
        "I302",
        "info",
        label,
        `${stats.unreferencedSources.length} source(s) are never referenced by any mapping (${sample}${stats.unreferencedSources.length > 3 ? ", …" : ""})`,
        "harmless, but a sign of tree-shaken inputs still listed in the map"
      )
    );
  }
  return { findings, map };
}

/** Validate a bundle together with the map that should describe it. */
export function checkBundle(bundlePath: string): Finding[] {
  const findings: Finding[] = [];
  let bundleText: string;
  try {
    bundleText = fs.readFileSync(bundlePath, "utf8");
  } catch (e) {
    return [
      finding(
        "E101",
        "error",
        bundlePath,
        `cannot read bundle: ${(e as Error).message}`,
        "point remaptrace at an existing, readable bundle"
      ),
    ];
  }

  const ref = sourceMappingUrlOf(bundleText);
  let map: SourceMap | null = null;
  let mapLabel = "";
  if (ref === null) {
    findings.push(
      finding(
        "W203",
        "warning",
        bundlePath,
        "bundle has no sourceMappingURL comment",
        "emit one at build time, or pass --map / --maps so remaptrace can pair it explicitly"
      )
    );
    const adjacent = `${bundlePath}.map`;
    if (isFile(adjacent)) {
      const r = checkMapFile(adjacent);
      findings.push(...r.findings);
      map = r.map;
      mapLabel = adjacent;
    }
  } else if (ref.startsWith("data:")) {
    mapLabel = `${bundlePath} (inline map)`;
    try {
      const r = checkMapText(mapLabel, dataUriToJson(ref));
      findings.push(...r.findings);
      map = r.map;
    } catch (e) {
      findings.push(
        finding(
          "E101",
          "error",
          mapLabel,
          `inline map data: URI is malformed: ${(e as Error).message}`,
          "regenerate the bundle with a valid inline map or an external .map file"
        )
      );
    }
  } else {
    const refPath = ref.replace(/[?#].*$/, "");
    const mapPath = path.isAbsolute(refPath)
      ? refPath
      : path.join(path.dirname(bundlePath), refPath);
    if (!isFile(mapPath)) {
      findings.push(
        finding(
          "W204",
          "warning",
          bundlePath,
          `sourceMappingURL points at ${ref} but ${mapPath} does not exist`,
          "deploy the .map next to the bundle, or fix the comment"
        )
      );
    } else {
      const r = checkMapFile(mapPath);
      findings.push(...r.findings);
      map = r.map;
      mapLabel = mapPath;
    }
  }

  if (map !== null) {
    const base = path.basename(bundlePath);
    if (map.file !== null && map.file !== base) {
      findings.push(
        finding(
          "W205",
          "warning",
          mapLabel,
          `map \`file\` is "${map.file}" but the bundle is "${base}" — possibly the wrong pairing`,
          "confirm the map was produced by the same build as this bundle"
        )
      );
    }
    const bundleLines = bundleText.split("\n").length;
    const maxLine = map.stats().maxGeneratedLine;
    if (maxLine > bundleLines) {
      findings.push(
        finding(
          "W206",
          "warning",
          mapLabel,
          `map addresses generated line ${maxLine} but the bundle has only ${bundleLines} line(s) — stale or mismatched pair`,
          "redeploy bundle and map from the same build"
        )
      );
    }
  }
  return findings;
}

/**
 * Validate a target path: a `.map` file, a bundle file, or a directory
 * (checks every `*.js`/`*.mjs`/`*.cjs` bundle in it, non-recursive, plus
 * orphan `.map` files no bundle references).
 */
export function checkTarget(target: string): Finding[] {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (stat === undefined) {
    return [
      finding(
        "E101",
        "error",
        target,
        "path does not exist",
        "pass a bundle, a .map file, or a directory containing them"
      ),
    ];
  }
  if (stat.isFile()) {
    return target.endsWith(".map")
      ? checkMapFile(target).findings
      : checkBundle(target);
  }
  const findings: Finding[] = [];
  const entries = fs
    .readdirSync(target, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const bundles = entries.filter((n) => /\.(m|c)?js$/.test(n));
  for (const name of bundles) {
    findings.push(...checkBundle(path.join(target, name)));
  }
  // Orphan maps: .map files whose bundle is not in the directory.
  for (const name of entries) {
    if (!name.endsWith(".map")) continue;
    const owner = name.slice(0, -4);
    if (!bundles.includes(owner)) {
      findings.push(...checkMapFile(path.join(target, name)).findings);
    }
  }
  return findings;
}
