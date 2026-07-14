// Shared test helpers: build real source maps from absolute segment lists
// (relative/VLQ encoding handled here via the project's own encoder), spin
// up throwaway directories, and drive the compiled CLI. Every test is
// hermetic — no network, no shared state, fresh temp dirs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { vlqEncodeSegment } from "../dist/vlq.js";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = path.join(ROOT, "dist", "cli.js");

/**
 * Encode `lines` — an array (per generated line) of absolute segments
 * `[genCol, srcIdx, srcLine, srcCol, nameIdx?]` (all 0-based) — into a
 * spec-compliant `mappings` string with the proper relative deltas.
 */
export function encodeMappings(lines) {
  let pSrc = 0, pLine = 0, pCol = 0, pName = 0;
  const encoded = [];
  for (const segments of lines) {
    let pGen = 0;
    const parts = [];
    for (const seg of segments) {
      const [genCol, srcIdx, srcLine, srcCol, nameIdx] = seg;
      if (srcIdx === undefined) {
        parts.push(vlqEncodeSegment([genCol - pGen]));
        pGen = genCol;
        continue;
      }
      const fields = [genCol - pGen, srcIdx - pSrc, srcLine - pLine, srcCol - pCol];
      pGen = genCol; pSrc = srcIdx; pLine = srcLine; pCol = srcCol;
      if (nameIdx !== undefined) {
        fields.push(nameIdx - pName);
        pName = nameIdx;
      }
      parts.push(vlqEncodeSegment(fields));
    }
    encoded.push(parts.join(","));
  }
  return encoded.join(";");
}

/** Assemble map JSON text with sensible defaults. */
export function mapJson(overrides = {}) {
  return JSON.stringify({
    version: 3,
    sources: ["a.js"],
    names: [],
    mappings: "AAAA",
    ...overrides,
  });
}

/** Create a temp dir populated from a { relPath: content } object. */
export function makeTree(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remaptrace-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

export function rmTree(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Run `fn(dir)` against a temp tree and always clean up. */
export function withTree(files, fn) {
  const dir = makeTree(files);
  try {
    return fn(dir);
  } finally {
    rmTree(dir);
  }
}

/** Run the compiled CLI; returns { status, stdout, stderr }. */
export function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    cwd: opts.cwd ?? ROOT,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
