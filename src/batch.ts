/**
 * Batch log processing. A production log is a mixed bag: plain text lines,
 * multi-line stack traces, and structured JSON lines whose `stack` / `err`
 * fields carry a whole trace inside one escaped string. remaptrace walks the
 * log line by line, rewrites frames in plain lines directly, and — unless
 * told not to — parses JSON object lines, rewrites frames inside every
 * string value (nested objects and arrays included), and re-serializes with
 * the original key order.
 */

import type { RemapStats } from "./types.js";
import type { MapResolver } from "./resolve.js";
import { newStats, remapText } from "./remap.js";
import { mayContainFrame } from "./stackparse.js";

export interface ProcessOptions {
  /** Rewrite stacks inside JSON log lines (default true). */
  jsonLines?: boolean;
}

export interface ProcessResult {
  output: string;
  stats: RemapStats;
}

/** Remap every frame in a whole log. Preserves the trailing newline state. */
export function processLog(
  text: string,
  resolver: MapResolver,
  opts: ProcessOptions = {}
): ProcessResult {
  const jsonLines = opts.jsonLines !== false;
  const stats = newStats();
  const endsWithNewline = text.endsWith("\n");
  const lines = (endsWithNewline ? text.slice(0, -1) : text).split("\n");
  const out: string[] = [];
  for (const line of lines) {
    stats.linesScanned += 1;
    out.push(processLine(line, resolver, stats, jsonLines));
  }
  return {
    output: out.join("\n") + (endsWithNewline ? "\n" : ""),
    stats,
  };
}

function processLine(
  line: string,
  resolver: MapResolver,
  stats: RemapStats,
  jsonLines: boolean
): string {
  if (jsonLines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("{") && mayContainFrame(line)) {
      const rewritten = tryJsonLine(line, trimmed, resolver, stats);
      if (rewritten !== null) return rewritten;
    }
  }
  return remapText(line, resolver, stats);
}

/**
 * Attempt to treat `line` as a JSON object log line. Returns the rewritten
 * line, or null when the line is not JSON (caller falls back to plain-text
 * handling). Only string values are touched; numbers, keys and formatting
 * of the payload are re-emitted by JSON.stringify, which preserves key
 * order for object keys.
 */
function tryJsonLine(
  line: string,
  trimmed: string,
  resolver: MapResolver,
  stats: RemapStats
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  let changed = false;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const next = remapText(value, resolver, stats);
      if (next !== value) changed = true;
      return next;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      const src = value as Record<string, unknown>;
      const rebuilt: Record<string, unknown> = {};
      for (const key of Object.keys(src)) rebuilt[key] = walk(src[key]);
      return rebuilt;
    }
    return value;
  };
  const result = walk(parsed);
  if (!changed) return line; // valid JSON, nothing to rewrite: emit verbatim
  stats.jsonLinesRewritten += 1;
  const indent = line.slice(0, line.length - trimmed.length);
  return indent + JSON.stringify(result);
}
