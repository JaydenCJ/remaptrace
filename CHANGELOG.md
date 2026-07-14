# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-13

### Added

- `remaptrace remap` (default command): batch-rewrites minified stack
  traces in whole log files — or stdin — back to original sources, in
  place: timestamps, request ids and every byte that is not a resolvable
  frame pass through untouched. Multiple input files, `--output`,
  `--stats`, and a `--fail-unmapped` CI gate.
- Frame recognition for both grammars found in the wild: V8/Chrome/Node
  (`at fn (url:line:col)`, `async`, `new`, `[as alias]`, eval-site
  frames, location-only frames) and Firefox/Safari (`fn@url:line:col`,
  empty names, spaced labels like `global code`), matched anywhere in a
  line, with URLs keeping their ports.
- JSON log line support: object lines are parsed, stacks inside string
  values (nested objects and arrays included) are rewritten, and the
  line is re-emitted with key order preserved; `--no-json-lines` opts
  out.
- Source Map revision 3 reader implemented from the spec: base64 VLQ
  decoding, flat and indexed (`sections`) maps, `sourceRoot`, embedded
  `sourcesContent`, binary-search position lookup, original-name
  substitution, and display cleaning of bundler pseudo-schemes
  (`webpack://ns/...` → `src/...`).
- Offline map resolution with caching: explicit `--map bundle=map`
  pairings, `--maps` directory indexing by conventional name and by the
  map's `file` field, bundle `sourceMappingURL` comments (external,
  absolute, and inline base64 `data:` URIs) — `http(s)` URLs are never
  fetched.
- `remaptrace frame`: single-position lookup with surrounding source
  context rendered from `sourcesContent` (`--context N`).
- `remaptrace check`: bundle/map consistency validation with a 15-rule
  catalog of stable codes (E101–E106, W201–W207, I301–I302), including
  the stale-map signature (mappings past the end of the bundle), wrong
  pairings, index corruption and out-of-order segments; `--fail-on`
  gate and `--format json` for CI.
- `remaptrace inspect`: source map summary (sources, names, segment
  count, generated-line extent, embedded content, unreferenced sources).
- Public programmatic API (`processLog`, `remapText`, `MapResolver`,
  `SourceMap`, `findFrames`, `checkTarget`, VLQ codec) with type
  declarations.
- Test suite: 90 node:test tests (unit + CLI integration in fresh temp
  dirs) and an end-to-end `scripts/smoke.sh` against the bundled
  example bundle, map, production log and broken deploy.

[0.1.0]: https://github.com/JaydenCJ/remaptrace/releases/tag/v0.1.0
