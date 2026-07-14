/**
 * Source Map revision 3 reader: parses map JSON (flat maps and indexed maps
 * with `sections`), decodes the VLQ `mappings` into per-line segment arrays,
 * and answers `originalPositionFor` lookups with binary search.
 *
 * Decoding is strict about structure (bad VLQ, wrong field counts and
 * malformed JSON throw `MapError`) but tolerant about semantics: segments
 * pointing at out-of-range source/name indices are dropped and recorded as
 * `problems`, and out-of-order lines are re-sorted and recorded — `check`
 * turns those records into findings while `remap` keeps working.
 */

import { vlqDecode, VlqError } from "./vlq.js";
import type { MapProblem, OriginalPosition, Segment } from "./types.js";

/** Fatal map defect. `code` is stable and mirrored by `check` findings. */
export class MapError extends Error {
  code: "json" | "version" | "mappings" | "sources" | "sections";

  constructor(code: MapError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface RawSection {
  offset?: { line?: number; column?: number };
  map?: unknown;
}

/** Summary counters used by `inspect` and `check`. */
export interface MapStats {
  mappingCount: number;
  /** Highest 1-based generated line any segment addresses (0 if none). */
  maxGeneratedLine: number;
  sourceCount: number;
  nameCount: number;
  hasSourcesContent: boolean;
  /** Indices into `sources` that no segment references. */
  unreferencedSources: number[];
}

export class SourceMap {
  readonly file: string | null;
  readonly sources: string[];
  readonly names: string[];
  readonly sourcesContent: (string | null)[];
  /** True when the raw map carried a `sourcesContent` key at all. */
  readonly declaredSourcesContent: boolean;
  /** Raw length of the declared sourcesContent array (for W201). */
  readonly sourcesContentLength: number;
  /** Decoded segments, indexed by 0-based generated line. */
  readonly lines: Segment[][];
  /** Non-fatal defects noticed while decoding. */
  readonly problems: MapProblem[];
  private readonly sourceRoot: string;

  private constructor(init: {
    file: string | null;
    sources: string[];
    names: string[];
    sourcesContent: (string | null)[];
    declaredSourcesContent: boolean;
    sourcesContentLength: number;
    sourceRoot: string;
    lines: Segment[][];
    problems: MapProblem[];
  }) {
    this.file = init.file;
    this.sources = init.sources;
    this.names = init.names;
    this.sourcesContent = init.sourcesContent;
    this.declaredSourcesContent = init.declaredSourcesContent;
    this.sourcesContentLength = init.sourcesContentLength;
    this.sourceRoot = init.sourceRoot;
    this.lines = init.lines;
    this.problems = init.problems;
  }

  /** Parse map JSON text (flat or indexed). Throws `MapError` when fatal. */
  static fromJson(text: string): SourceMap {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new MapError("json", `not valid JSON: ${(e as Error).message}`);
    }
    return SourceMap.fromObject(raw);
  }

  static fromObject(raw: unknown): SourceMap {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new MapError("json", "top level is not a JSON object");
    }
    const obj = raw as Record<string, unknown>;
    if (obj["version"] !== 3) {
      throw new MapError(
        "version",
        `unsupported source map version ${JSON.stringify(obj["version"])} (expected 3)`
      );
    }
    if (Array.isArray(obj["sections"])) {
      return SourceMap.fromSections(obj);
    }
    return SourceMap.fromFlat(obj);
  }

  private static fromFlat(obj: Record<string, unknown>): SourceMap {
    const sourcesRaw = obj["sources"];
    if (!Array.isArray(sourcesRaw)) {
      throw new MapError("sources", "`sources` is missing or not an array");
    }
    const sources = sourcesRaw.map((s) => (typeof s === "string" ? s : ""));
    const names = Array.isArray(obj["names"])
      ? obj["names"].map((n) => (typeof n === "string" ? n : ""))
      : [];
    const declaredSourcesContent = Array.isArray(obj["sourcesContent"]);
    const contentRaw = declaredSourcesContent
      ? (obj["sourcesContent"] as unknown[])
      : [];
    const sourcesContent = sources.map((_, i) => {
      const c = contentRaw[i];
      return typeof c === "string" ? c : null;
    });
    const mappingsRaw = obj["mappings"];
    if (typeof mappingsRaw !== "string") {
      throw new MapError("mappings", "`mappings` is missing or not a string");
    }
    const problems: MapProblem[] = [];
    const lines = decodeMappings(mappingsRaw, sources.length, names.length, problems);
    return new SourceMap({
      file: typeof obj["file"] === "string" ? obj["file"] : null,
      sources,
      names,
      sourcesContent,
      declaredSourcesContent,
      sourcesContentLength: contentRaw.length,
      sourceRoot: typeof obj["sourceRoot"] === "string" ? obj["sourceRoot"] : "",
      lines,
      problems,
    });
  }

  /** Flatten an indexed map: merge every section, offsetting positions. */
  private static fromSections(obj: Record<string, unknown>): SourceMap {
    const sections = obj["sections"] as RawSection[];
    const sources: string[] = [];
    const names: string[] = [];
    const sourcesContent: (string | null)[] = [];
    const lines: Segment[][] = [];
    const problems: MapProblem[] = [];
    let declaredContent = false;
    let lastOffsetLine = -1;

    for (let s = 0; s < sections.length; s += 1) {
      const section = sections[s];
      if (typeof section !== "object" || section === null) {
        throw new MapError("sections", `section ${s} is not an object`);
      }
      const offLine = section.offset?.line ?? -1;
      const offCol = section.offset?.column ?? -1;
      if (offLine < 0 || offCol < 0) {
        throw new MapError("sections", `section ${s} has no valid offset`);
      }
      if (offLine < lastOffsetLine) {
        throw new MapError("sections", `section ${s} offsets are not sorted`);
      }
      lastOffsetLine = offLine;
      let sub: SourceMap;
      try {
        sub = SourceMap.fromObject(section.map);
      } catch (e) {
        if (e instanceof MapError) {
          throw new MapError(e.code, `section ${s}: ${e.message}`);
        }
        throw e;
      }
      const srcBase = sources.length;
      const nameBase = names.length;
      sources.push(...sub.sources);
      sourcesContent.push(...sub.sourcesContent);
      names.push(...sub.names);
      declaredContent = declaredContent || sub.declaredSourcesContent;
      for (const p of sub.problems) {
        problems.push({ ...p, detail: `section ${s}: ${p.detail}` });
      }
      for (let l = 0; l < sub.lines.length; l += 1) {
        const segs = sub.lines[l] ?? [];
        if (segs.length === 0) continue;
        const genLine = offLine + l;
        // The column offset applies only to the section's first line.
        const colShift = l === 0 ? offCol : 0;
        const target = lines[genLine] ?? (lines[genLine] = []);
        for (const seg of segs) {
          target.push({
            ...seg,
            genCol: seg.genCol + colShift,
            srcIdx: seg.srcIdx === -1 ? -1 : seg.srcIdx + srcBase,
            nameIdx: seg.nameIdx === -1 ? -1 : seg.nameIdx + nameBase,
          });
        }
      }
    }
    for (const segs of lines) {
      if (segs) segs.sort((a, b) => a.genCol - b.genCol);
    }
    return new SourceMap({
      file: typeof obj["file"] === "string" ? obj["file"] : null,
      sources,
      names,
      sourcesContent,
      declaredSourcesContent: declaredContent,
      sourcesContentLength: sourcesContent.length,
      sourceRoot: "",
      lines,
      problems,
    });
  }

  /**
   * Look up a generated position (1-based line and column, as printed in a
   * stack trace) and return the original position, or null when no segment
   * with a source covers it.
   */
  originalPositionFor(line: number, column: number): OriginalPosition | null {
    if (line < 1 || column < 1) return null;
    const segs = this.lines[line - 1];
    if (!segs || segs.length === 0) return null;
    const col0 = column - 1;
    // Binary search: greatest segment whose genCol <= col0.
    let lo = 0;
    let hi = segs.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid] as Segment;
      if (seg.genCol <= col0) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best === -1) return null;
    const seg = segs[best] as Segment;
    if (seg.srcIdx === -1) return null;
    const rawSource = this.sources[seg.srcIdx] ?? "";
    return {
      source: cleanSourcePath(this.applyRoot(rawSource)),
      rawSource,
      line: seg.srcLine + 1,
      column: seg.srcCol + 1,
      name: seg.nameIdx === -1 ? null : (this.names[seg.nameIdx] ?? null),
    };
  }

  /** Content of an original source by cleaned or raw path, if embedded. */
  contentFor(source: string): string | null {
    for (let i = 0; i < this.sources.length; i += 1) {
      const raw = this.sources[i] ?? "";
      if (raw === source || cleanSourcePath(this.applyRoot(raw)) === source) {
        return this.sourcesContent[i] ?? null;
      }
    }
    return null;
  }

  private applyRoot(source: string): string {
    if (!this.sourceRoot) return source;
    const root = this.sourceRoot.endsWith("/")
      ? this.sourceRoot
      : `${this.sourceRoot}/`;
    return hasScheme(source) || source.startsWith("/") ? source : root + source;
  }

  stats(): MapStats {
    let mappingCount = 0;
    let maxGeneratedLine = 0;
    const referenced = new Set<number>();
    for (let l = 0; l < this.lines.length; l += 1) {
      const segs = this.lines[l];
      if (!segs || segs.length === 0) continue;
      mappingCount += segs.length;
      maxGeneratedLine = l + 1;
      for (const seg of segs) {
        if (seg.srcIdx !== -1) referenced.add(seg.srcIdx);
      }
    }
    const unreferencedSources: number[] = [];
    for (let i = 0; i < this.sources.length; i += 1) {
      if (!referenced.has(i)) unreferencedSources.push(i);
    }
    return {
      mappingCount,
      maxGeneratedLine,
      sourceCount: this.sources.length,
      nameCount: this.names.length,
      hasSourcesContent: this.sourcesContent.some((c) => c !== null),
      unreferencedSources,
    };
  }
}

/** Decode the `mappings` string into per-line, column-sorted segments. */
function decodeMappings(
  mappings: string,
  sourceCount: number,
  nameCount: number,
  problems: MapProblem[]
): Segment[][] {
  const lines: Segment[][] = [];
  let current: Segment[] = [];
  // Source/line/column/name accumulators persist across generated lines;
  // only the generated column resets at each `;`.
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;
  let genCol = 0;
  let lineNo = 0;
  let outOfOrder = false;
  let i = 0;

  const finishLine = () => {
    if (outOfOrder) {
      problems.push({
        kind: "out-of-order",
        line: lineNo + 1,
        detail: `segments on generated line ${lineNo + 1} are not sorted by column`,
      });
      current.sort((a, b) => a.genCol - b.genCol);
    }
    lines.push(current);
    current = [];
    genCol = 0;
    outOfOrder = false;
    lineNo += 1;
  };

  while (i <= mappings.length) {
    const ch = i < mappings.length ? mappings[i] : ";";
    if (ch === ";") {
      finishLine();
      i += 1;
      if (i > mappings.length) break;
      continue;
    }
    if (ch === ",") {
      i += 1;
      continue;
    }
    // Decode one segment: 1, 4 or 5 VLQ fields.
    const fields: number[] = [];
    let pos = i;
    try {
      while (
        pos < mappings.length &&
        mappings[pos] !== "," &&
        mappings[pos] !== ";"
      ) {
        const { value, next } = vlqDecode(mappings, pos);
        fields.push(value);
        pos = next;
        if (fields.length > 5) break;
      }
    } catch (e) {
      if (e instanceof VlqError) {
        throw new MapError(
          "mappings",
          `generated line ${lineNo + 1}: ${e.message}`
        );
      }
      throw e;
    }
    if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) {
      throw new MapError(
        "mappings",
        `generated line ${lineNo + 1}: segment has ${fields.length} fields (expected 1, 4 or 5)`
      );
    }
    i = pos;
    const prevGenCol = genCol;
    genCol += fields[0] as number;
    if (current.length > 0 && genCol < prevGenCol) outOfOrder = true;
    let seg: Segment;
    if (fields.length === 1) {
      seg = { genCol, srcIdx: -1, srcLine: -1, srcCol: -1, nameIdx: -1 };
    } else {
      srcIdx += fields[1] as number;
      srcLine += fields[2] as number;
      srcCol += fields[3] as number;
      let segName = -1;
      if (fields.length === 5) {
        nameIdx += fields[4] as number;
        segName = nameIdx;
      }
      if (srcIdx < 0 || srcIdx >= sourceCount) {
        problems.push({
          kind: "source-index",
          line: lineNo + 1,
          detail: `segment references source index ${srcIdx} (map has ${sourceCount} sources)`,
        });
        continue; // drop the segment; remap must not invent a source
      }
      if (segName !== -1 && (segName < 0 || segName >= nameCount)) {
        problems.push({
          kind: "name-index",
          line: lineNo + 1,
          detail: `segment references name index ${segName} (map has ${nameCount} names)`,
        });
        segName = -1; // keep the position, drop only the bogus name
      }
      seg = { genCol, srcIdx, srcLine, srcCol, nameIdx: segName };
    }
    current.push(seg);
  }
  return lines;
}

function hasScheme(s: string): boolean {
  return /^[a-zA-Z][\w+.-]*:\/\//.test(s);
}

/**
 * Clean a source path for display: strip bundler pseudo-scheme prefixes
 * (`webpack://ns/`, `rollup://`, …), a leading `./`, and query/fragment
 * suffixes. The raw path stays available as `rawSource`.
 */
export function cleanSourcePath(source: string): string {
  let s = source;
  const scheme = /^([a-zA-Z][\w+.-]*):\/\//.exec(s);
  if (scheme && scheme[1] !== "http" && scheme[1] !== "https" && scheme[1] !== "file") {
    s = s.slice(scheme[0].length);
    // webpack://<namespace>/./src/x.js — drop the namespace segment when a
    // path follows it.
    const slash = s.indexOf("/");
    if (slash > 0 && slash < s.length - 1) s = s.slice(slash + 1);
  }
  s = s.replace(/[?#].*$/, "");
  while (s.startsWith("./")) s = s.slice(2);
  return s === "" ? source : s;
}
