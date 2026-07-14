/**
 * Rendering: check reports (text and JSON), inspect summaries, single-frame
 * lookups with source context, and remap statistics. All output is
 * deterministic — findings are grouped by file in first-seen order and
 * counters are sorted — so two runs over the same inputs are byte-identical.
 */

import type { Finding, OriginalPosition, RemapStats } from "./types.js";
import { summarize } from "./types.js";
import type { MapStats } from "./sourcemap.js";

export function renderCheckText(findings: Finding[], failOn: string): string {
  const lines: string[] = [];
  const byFile = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byFile.get(f.file) ?? [];
    list.push(f);
    byFile.set(f.file, list);
  }
  for (const [file, list] of byFile) {
    lines.push(file);
    for (const f of list) {
      lines.push(`  ${f.severity} ${f.code} ${f.message}`);
      lines.push(`      fix: ${f.fix}`);
    }
    lines.push("");
  }
  const s = summarize(findings);
  const verdict = failsAt(findings, failOn) ? "FAIL" : "OK";
  lines.push(
    `remaptrace: ${verdict} — ${s.errors} error(s), ${s.warnings} warning(s), ${s.infos} info (fail-on: ${failOn})`
  );
  return lines.join("\n");
}

export function renderCheckJson(findings: Finding[], failOn: string): string {
  const s = summarize(findings);
  return JSON.stringify(
    {
      ok: !failsAt(findings, failOn),
      summary: s,
      findings: findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        file: f.file,
        message: f.message,
        fix: f.fix,
      })),
    },
    null,
    2
  );
}

/** Does this finding set fail the gate at the given level? */
export function failsAt(findings: Finding[], failOn: string): boolean {
  if (failOn === "never") return false;
  const s = summarize(findings);
  if (failOn === "info") return s.errors + s.warnings + s.infos > 0;
  if (failOn === "warning") return s.errors + s.warnings > 0;
  return s.errors > 0; // "error"
}

export function renderInspectText(mapPath: string, stats: MapStats, file: string | null): string {
  const lines = [
    mapPath,
    `  file:            ${file ?? "(not set)"}`,
    `  sources:         ${stats.sourceCount}`,
    `  names:           ${stats.nameCount}`,
    `  mappings:        ${stats.mappingCount} segment(s) across ${stats.maxGeneratedLine} generated line(s)`,
    `  sourcesContent:  ${stats.hasSourcesContent ? "embedded" : "absent"}`,
  ];
  if (stats.unreferencedSources.length > 0) {
    lines.push(`  unreferenced:    ${stats.unreferencedSources.length} source(s)`);
  }
  return lines.join("\n");
}

export function renderInspectJson(mapPath: string, stats: MapStats, file: string | null): string {
  return JSON.stringify(
    {
      map: mapPath,
      file,
      sources: stats.sourceCount,
      names: stats.nameCount,
      mappings: stats.mappingCount,
      maxGeneratedLine: stats.maxGeneratedLine,
      sourcesContent: stats.hasSourcesContent,
      unreferencedSources: stats.unreferencedSources,
    },
    null,
    2
  );
}

/** Render a single-frame lookup, with optional source context. */
export function renderFrame(
  query: string,
  pos: OriginalPosition,
  content: string | null,
  contextLines: number
): string {
  const out = [
    query,
    `  → ${pos.source}:${pos.line}:${pos.column}${pos.name ? ` (${pos.name})` : ""}`,
  ];
  if (content !== null && contextLines > 0) {
    out.push("");
    const lines = content.split("\n");
    const from = Math.max(1, pos.line - contextLines);
    const to = Math.min(lines.length, pos.line + contextLines);
    const width = String(to).length;
    for (let n = from; n <= to; n += 1) {
      const marker = n === pos.line ? ">" : " ";
      out.push(`  ${marker} ${String(n).padStart(width)} | ${lines[n - 1] ?? ""}`);
    }
  }
  return out.join("\n");
}

export function renderFrameJson(
  query: string,
  pos: OriginalPosition
): string {
  return JSON.stringify(
    {
      query,
      source: pos.source,
      rawSource: pos.rawSource,
      line: pos.line,
      column: pos.column,
      name: pos.name,
    },
    null,
    2
  );
}

/** One-line remap summary for stderr (`--stats`). */
export function renderStats(stats: RemapStats): string {
  const parts = [
    `${stats.framesFound} frame(s) found`,
    `${stats.framesRemapped} remapped`,
    `${stats.framesUnmapped} unmapped`,
  ];
  const unresolved = [...stats.unresolved.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : 1
  );
  if (unresolved.length > 0) {
    const detail = unresolved.map(([url, n]) => `${url} ×${n}`).join(", ");
    parts.push(`${unresolved.reduce((n, [, c]) => n + c, 0)} unresolved (no map for: ${detail})`);
  }
  let line = `remaptrace: ${parts.join(", ")}`;
  if (stats.jsonLinesRewritten > 0) {
    line += `; ${stats.jsonLinesRewritten} JSON line(s) rewritten`;
  }
  return line;
}
