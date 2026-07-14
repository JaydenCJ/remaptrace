/**
 * The rewriter: takes text containing stack frames, resolves each frame's
 * bundle to a source map, and splices the original position (and original
 * function name, when the map recorded one) back into the text in place.
 * Bytes that are not a recognized, resolvable frame pass through untouched —
 * a remapped log stays diffable against the original.
 */

import type { Frame, OriginalPosition, RemapStats } from "./types.js";
import { findFrames, isInternalUrl, mayContainFrame } from "./stackparse.js";
import type { MapResolver } from "./resolve.js";

export function newStats(): RemapStats {
  return {
    linesScanned: 0,
    framesFound: 0,
    framesRemapped: 0,
    framesUnmapped: 0,
    framesInternal: 0,
    unresolved: new Map(),
    mapsUsed: new Set(),
    jsonLinesRewritten: 0,
  };
}

/**
 * Rewrite every resolvable frame in `text` (single- or multi-line).
 * Mutates `stats` counters as it goes.
 */
export function remapText(
  text: string,
  resolver: MapResolver,
  stats: RemapStats
): string {
  if (!mayContainFrame(text)) return text;
  const frames = findFrames(text);
  if (frames.length === 0) return text;
  // Rewrite right-to-left so earlier spans stay valid.
  let out = text;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i] as Frame;
    stats.framesFound += 1;
    if (isInternalUrl(frame.url)) {
      stats.framesUnmapped += 1;
      stats.framesInternal += 1;
      continue;
    }
    const resolved = resolver.resolve(frame.url);
    if (resolved === null) {
      stats.unresolved.set(
        frame.url,
        (stats.unresolved.get(frame.url) ?? 0) + 1
      );
      continue;
    }
    stats.mapsUsed.add(resolved.origin);
    const pos = resolved.map.originalPositionFor(frame.line, frame.column);
    if (pos === null) {
      stats.framesUnmapped += 1;
      continue;
    }
    out = spliceFrame(out, frame, pos);
    stats.framesRemapped += 1;
  }
  return out;
}

/** Replace one frame's location (and name) inside `text` with `pos`. */
export function spliceFrame(
  text: string,
  frame: Frame,
  pos: OriginalPosition
): string {
  const loc = `${pos.source}:${pos.line}:${pos.column}`;
  const name = pos.name;
  // Location first (it sits to the right of the name in both grammars).
  let out = text.slice(0, frame.locStart) + loc + text.slice(frame.locEnd);
  if (name === null) return out;
  if (frame.funcStart !== -1) {
    return out.slice(0, frame.funcStart) + name + out.slice(frame.funcEnd);
  }
  // Location-only frames grow a name: `at url:l:c` -> `at name (src:l:c)`,
  // `@url:l:c` -> `name@src:l:c`.
  if (frame.style === "v8") {
    return (
      out.slice(0, frame.locStart) +
      `${name} (${loc})` +
      out.slice(frame.locStart + loc.length)
    );
  }
  return out.slice(0, frame.locStart - 1) + `${name}@${loc}` +
    out.slice(frame.locStart + loc.length);
}
