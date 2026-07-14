/**
 * Shared types for remaptrace. Everything here is plain data: positions,
 * frames, findings and stats flow between the pure modules (vlq, sourcemap,
 * stackparse, remap, check) and only the CLI layer touches the filesystem
 * beyond reads.
 *
 * Coordinate conventions, stated once and used everywhere:
 * - Stack traces (and this public API) use 1-based lines and 1-based columns,
 *   matching what V8, SpiderMonkey and JavaScriptCore print.
 * - The source-map wire format is 0-based for both; the conversion happens
 *   inside `SourceMap` and nowhere else.
 */

/** A decoded mapping segment on one generated line. Absent fields are -1. */
export interface Segment {
  /** 0-based generated column. */
  genCol: number;
  /** Index into `sources`, or -1 for an unmapped segment. */
  srcIdx: number;
  /** 0-based original line, or -1. */
  srcLine: number;
  /** 0-based original column, or -1. */
  srcCol: number;
  /** Index into `names`, or -1. */
  nameIdx: number;
}

/** Result of looking a generated position up in a source map. */
export interface OriginalPosition {
  /** Original source path, cleaned (sourceRoot applied, bundler prefixes stripped). */
  source: string;
  /** The source exactly as listed in the map, before cleaning. */
  rawSource: string;
  /** 1-based original line. */
  line: number;
  /** 1-based original column. */
  column: number;
  /** Original identifier at this position, if the map recorded one. */
  name: string | null;
}

/** A non-fatal defect noticed while decoding a map (surfaced by `check`). */
export interface MapProblem {
  kind: "source-index" | "name-index" | "out-of-order";
  /** 1-based generated line the problem was seen on. */
  line: number;
  detail: string;
}

/** One stack frame located inside a line of text. */
export interface Frame {
  /** "v8" for `at fn (url:l:c)` style, "gecko" for `fn@url:l:c` style. */
  style: "v8" | "gecko";
  /** Function name as printed, or null for location-only frames. */
  func: string | null;
  url: string;
  /** 1-based line from the trace. */
  line: number;
  /** 1-based column from the trace. */
  column: number;
  /** Span of the `url:line:column` substring within the input string. */
  locStart: number;
  locEnd: number;
  /** Span of the function name substring, when one was printed. */
  funcStart: number;
  funcEnd: number;
}

/** Aggregate counters for a batch remap run. */
export interface RemapStats {
  /** Lines (or JSON string values) scanned. */
  linesScanned: number;
  /** Frames recognized in the input. */
  framesFound: number;
  /** Frames rewritten to an original position. */
  framesRemapped: number;
  /** Frames with a map but no mapping at that position, plus internals. */
  framesUnmapped: number;
  /**
   * Subset of `framesUnmapped` that are runtime internals (`node:`,
   * `<anonymous>`, native frames). They can never have a source map, so
   * `--fail-unmapped` does not count them against the gate.
   */
  framesInternal: number;
  /** Frames whose bundle had no resolvable map, by bundle URL. */
  unresolved: Map<string, number>;
  /** Map files actually consulted. */
  mapsUsed: Set<string>;
  /** JSON log lines whose string fields were rewritten. */
  jsonLinesRewritten: number;
}

export type Severity = "error" | "warning" | "info";

/** One `check` finding, with a stable code and a concrete fix. */
export interface Finding {
  code: string;
  severity: Severity;
  /** File the finding is about (map or bundle path as given). */
  file: string;
  message: string;
  fix: string;
}

/** Summary counts for a set of findings. */
export interface FindingSummary {
  errors: number;
  warnings: number;
  infos: number;
}

export function summarize(findings: Finding[]): FindingSummary {
  const s: FindingSummary = { errors: 0, warnings: 0, infos: 0 };
  for (const f of findings) {
    if (f.severity === "error") s.errors += 1;
    else if (f.severity === "warning") s.warnings += 1;
    else s.infos += 1;
  }
  return s;
}
