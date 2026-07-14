# Contributing to remaptrace

Issues, discussions and pull requests are all welcome — this project aims
to stay small, zero-dependency at runtime, and honest about what it can
and cannot remap.

## Getting started

Requirements: Node.js >= 22.13 (for the stable `node:test` runner used by the suite).

```bash
git clone https://github.com/JaydenCJ/remaptrace.git
cd remaptrace
npm install            # installs typescript, the only devDependency
npm run build          # compile TypeScript to dist/
npm test               # build + 90 node:test tests
bash scripts/smoke.sh  # end-to-end CLI check against examples/
```

`scripts/smoke.sh` exercises the real CLI (batch remap, JSON log lines,
stdin piping, frame lookup with context, check on the clean and broken
examples, the stale-map fix loop, exit codes, determinism) against the
bundled fixtures and must print `SMOKE OK`.

## Before you open a pull request

1. `npx tsc -p tsconfig.json --noEmit` — the tree must type-check clean (strict mode is enforced).
2. `npm test` — all tests must pass.
3. `bash scripts/smoke.sh` — must print `SMOKE OK`.
4. Add tests for behavior changes; keep logic in pure, unit-testable
   modules (VLQ, map parsing, frame parsing and rewriting take values —
   only the CLI and resolver touch the filesystem, and only reads).
5. New `check` diagnostics need a row in `docs/check-rules.md`, a stable
   code that is never reused, and at least one test.

## Ground rules

- **No runtime dependencies.** The zero-dependency install is a core
  feature; adding one needs justification in the PR and will usually be
  declined.
- **Strictly offline.** remaptrace never opens a socket — not even for an
  `https://` bundle URL in a frame. Maps are resolved from local files
  only. This is a guarantee, not a default.
- Bytes that are not a recognized, resolvable stack frame must pass
  through unchanged: a remapped log stays diffable against the original.
- Rule codes (`E1xx`/`W2xx`/`I3xx`) are stable API: never renumber or
  repurpose an existing code; add new ones instead.
- Degrade, never guess: a position with no mapping stays minified rather
  than being rounded to a plausible-looking wrong neighbor.
- Code comments and doc comments are written in English.

## Reporting bugs

Please include: `remaptrace --version` output, the exact command line, a
minimal log excerpt with the offending frame, and (if you can share it)
the relevant `.map` — or its `remaptrace inspect` output when you cannot.
If a remapped position is wrong, say what the browser devtools show for
the same position: devtools behavior is the tiebreaker.

## Security

Do not open public issues for security problems; use GitHub private
vulnerability reporting on this repository instead.
