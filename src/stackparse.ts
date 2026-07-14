/**
 * Stack-frame recognition inside arbitrary text. Handles the two frame
 * grammars found in the wild:
 *
 * - V8 (Chrome, Node, Edge):    `at fn (url:line:col)` / `at url:line:col`,
 *   with `async`, `new`, `Object.fn [as alias]` decorations and eval frames
 *   (`at eval (eval at run (url:line:col), <anonymous>:1:1)` — the eval-site
 *   location is the one that gets remapped).
 * - Gecko / JavaScriptCore (Firefox, Safari): `fn@url:line:col`, including
 *   empty function names (`@url:1:2`) and Safari's `global code@…`.
 *
 * Frames are matched *anywhere* in a line, not only at the start, because
 * production logs prefix frames with timestamps, levels and request ids.
 * Matches carry exact substring spans so the rewriter can edit in place and
 * leave every other byte of the log untouched.
 */

import type { Frame } from "./types.js";

// url:line:col — the URL part is greedy, so `https://h:8443/a.js:1:2` keeps
// the port on the URL and still yields line 1, column 2 (the regex engine
// gives back only the final two `:digits` groups).
const V8_RE =
  /(?<=^|[\s'"(])at (async )?(new )?(?:([^\s()]+(?: \[as [^\]]+\])?) )?\(?([^\s()]+):(\d+):(\d+)\)?(?=[\s,'")]|$)/dg;

const GECKO_RE =
  /(?<=^|[\s'"(])((?:[^\s@()]| (?=[^\s@()]*@))*)@([^\s()]+):(\d+):(\d+)(?=[\s,'")]|$)/dg;

/** True when the URL of a frame can never have a source map (noise frames). */
export function isInternalUrl(url: string): boolean {
  return (
    url.startsWith("node:") ||
    url === "<anonymous>" ||
    url === "[native code]" ||
    url === "native"
  );
}

type Indices = ([number, number] | undefined)[];

/**
 * Find every stack frame in one line (or one multi-line string — offsets are
 * absolute within the input). Returned frames are ordered left to right and
 * never overlap; when the V8 and Gecko grammars both claim a span, V8 wins
 * because its `at ` anchor is the stronger signal.
 */
export function findFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  V8_RE.lastIndex = 0;
  for (let m = V8_RE.exec(text); m !== null; m = V8_RE.exec(text)) {
    const indices = (m as unknown as { indices: Indices }).indices;
    const loc = spanOf(indices, 4, 6);
    const funcSpan = indices[3];
    frames.push({
      style: "v8",
      func: m[3] ?? null,
      url: m[4] ?? "",
      line: parseInt(m[5] ?? "0", 10),
      column: parseInt(m[6] ?? "0", 10),
      locStart: loc[0],
      locEnd: loc[1],
      funcStart: funcSpan ? funcSpan[0] : -1,
      funcEnd: funcSpan ? funcSpan[1] : -1,
    });
  }
  GECKO_RE.lastIndex = 0;
  for (let m = GECKO_RE.exec(text); m !== null; m = GECKO_RE.exec(text)) {
    const indices = (m as unknown as { indices: Indices }).indices;
    const loc = spanOf(indices, 2, 4);
    const start = indices[1] ? indices[1][0] : loc[0];
    if (frames.some((f) => overlaps(f, start, loc[1]))) continue;
    const func = m[1] ?? "";
    const funcSpan = indices[1];
    frames.push({
      style: "gecko",
      func: func === "" ? null : func,
      url: m[2] ?? "",
      line: parseInt(m[3] ?? "0", 10),
      column: parseInt(m[4] ?? "0", 10),
      locStart: loc[0],
      locEnd: loc[1],
      funcStart: func === "" ? -1 : funcSpan ? funcSpan[0] : -1,
      funcEnd: func === "" ? -1 : funcSpan ? funcSpan[1] : -1,
    });
  }
  frames.sort((a, b) => a.locStart - b.locStart);
  return frames;
}

function spanOf(indices: Indices, from: number, to: number): [number, number] {
  const a = indices[from];
  const b = indices[to];
  return [a ? a[0] : 0, b ? b[1] : 0];
}

function overlaps(f: Frame, start: number, end: number): boolean {
  const fStart = f.funcStart !== -1 ? f.funcStart : f.locStart;
  return fStart < end && start < f.locEnd;
}

/**
 * Cheap pre-filter: does this line plausibly contain a frame? Used to skip
 * regex work on the bulk of a log. Never returns false for a line
 * `findFrames` would match.
 */
export function mayContainFrame(line: string): boolean {
  if (!/:\d+:\d+/.test(line)) return false;
  return /\bat |@/.test(line);
}
