#!/usr/bin/env bash
# Smoke test for remaptrace: exercises the real CLI end to end against the
# bundled example bundle/map/log and a freshly seeded temp tree. No network,
# idempotent, runs from a clean checkout (after `npm install`).
# Prints "SMOKE OK" on success.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "SMOKE FAIL: $1" >&2
  exit 1
}

# 1. Build (idempotent).
npm run build >/dev/null 2>&1 || fail "npm run build failed"
CLI="node $ROOT/dist/cli.js"
echo "[smoke] build ok"

# 2. --version matches package.json; --help documents the surface.
PKG_VERSION="$(node -p "require('$ROOT/package.json').version")"
CLI_VERSION="$($CLI --version)"
[ "$CLI_VERSION" = "$PKG_VERSION" ] || fail "--version mismatch: $CLI_VERSION != $PKG_VERSION"
HELP="$($CLI --help)"
for word in remap frame check inspect --maps --fail-on --fail-unmapped "Exit codes"; do
  echo "$HELP" | grep -q -- "$word" || fail "--help missing $word"
done
echo "[smoke] --help/--version ok ($CLI_VERSION)"

# 3. Usage errors exit 2 (distinct from findings' exit 1).
set +e
$CLI --frobnicate </dev/null >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "unknown flag should exit 2"; }
$CLI frame not-a-position >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "bad frame arg should exit 2"; }
$CLI check examples/dist --fail-on sometimes >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "bad --fail-on should exit 2"; }
$CLI inspect "$WORKDIR/nope.map" >/dev/null 2>&1; [ $? -eq 2 ] || { set -e; fail "missing map should exit 2"; }
set -e
echo "[smoke] error handling ok (exit 2)"

# 4. Batch remap of the example log: minified frames become original ones.
OUT="$($CLI remap examples/logs/prod.log --maps examples/dist --stats 2>"$WORKDIR/stats.txt")"
echo "$OUT" | grep -q 'at applyDiscount (src/checkout.js:6:5)' || fail "V8 frame not remapped"
echo "$OUT" | grep -q 'at computeTotal (src/checkout.js:12:22)' || fail "caller frame not remapped"
echo "$OUT" | grep -q 'handleCheckout@src/main.js:5:17' || fail "gecko frame not remapped"
echo "$OUT" | grep -q 'vendor.min.js:1:9101' || fail "unmapped vendor frame must pass through"
echo "$OUT" | grep -q 'node:internal/process/task_queues' || fail "internal frame must pass through"
grep -q '9 frame(s) found, 7 remapped' "$WORKDIR/stats.txt" || fail "stats line wrong"
grep -q 'no map for: .*vendor.min.js' "$WORKDIR/stats.txt" || fail "stats must name the unresolved bundle"
echo "[smoke] batch remap ok (7 of 9 frames)"

# 5. JSON log lines are rewritten and remain valid JSON.
echo "$OUT" | grep '^{' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!/applyDiscount \(src\/checkout\.js:6:5\)/.test(j.stack))throw new Error('json stack not remapped')})" \
  || fail "JSON log line handling wrong"
echo "[smoke] JSON log lines ok"

# 6. stdin -> stdout piping is the default command.
PIPED="$(printf 'at d (https://cdn.example.test/assets/app.min.js:1:36)\n' | $CLI --maps examples/dist)"
[ "$PIPED" = "at applyDiscount (src/checkout.js:6:5)" ] || fail "stdin remap wrong: $PIPED"
echo "[smoke] stdin/stdout ok"

# 7. frame: single position with source context from sourcesContent.
FRAME="$($CLI frame app.min.js:1:36 --maps examples/dist)"
echo "$FRAME" | grep -q 'src/checkout.js:6:5 (applyDiscount)' || fail "frame lookup wrong"
echo "$FRAME" | grep -q 'throw new Error' || fail "frame context missing"
$CLI frame app.min.js:99:1 --maps examples/dist >/dev/null 2>&1 && fail "unmapped frame should exit 1"
echo "[smoke] frame ok"

# 8. check: the clean pair passes, the broken pair fails with seeded findings.
$CLI check examples/dist >/dev/null || fail "examples/dist should exit 0"
set +e
BROKEN_OUT="$($CLI check examples/broken)"; BROKEN_CODE=$?
set -e
[ "$BROKEN_CODE" -eq 1 ] || fail "examples/broken should exit 1, got $BROKEN_CODE"
for needle in E105 W202 W205 W206 "1 error(s), 3 warning(s)"; do
  echo "$BROKEN_OUT" | grep -q "$needle" || fail "broken report missing $needle"
done
set +e
$CLI check examples/broken --fail-on never >/dev/null 2>&1; [ $? -eq 0 ] || { set -e; fail "--fail-on never should exit 0"; }
set -e
echo "[smoke] check ok (clean passes, broken fails)"

# 9. check --format json has the stable shape.
set +e
JSON_OUT="$($CLI check examples/broken --format json)"; JSON_CODE=$?
set -e
[ "$JSON_CODE" -eq 1 ] || fail "json check should still exit 1"
echo "$JSON_OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.ok!==false||j.summary.errors!==1||j.summary.warnings!==3)throw new Error('bad shape')})" \
  || fail "--format json shape wrong"
echo "[smoke] JSON check ok"

# 10. inspect summarizes the example map.
$CLI inspect examples/dist/app.min.js.map | grep -q '12 segment(s)' || fail "inspect wrong"
echo "[smoke] inspect ok"

# 11. Fix loop on a fresh temp tree: stale map -> W206 -> rebuild -> clean.
mkdir -p "$WORKDIR/deploy"
printf 'function a(){}\n//# sourceMappingURL=app.js.map\n' > "$WORKDIR/deploy/app.js"
node --input-type=module -e "
import { vlqEncodeSegment } from '$ROOT/dist/vlq.js';
import fs from 'node:fs';
const stale = { version: 3, file: 'app.js', sources: ['src/a.js'], sourcesContent: ['function a() {}'], names: [], mappings: ';;;;' + vlqEncodeSegment([0,0,0,0]) };
fs.writeFileSync('$WORKDIR/deploy/app.js.map', JSON.stringify(stale));
"
set +e
STALE_OUT="$($CLI check "$WORKDIR/deploy")"; STALE_CODE=$?
set -e
[ "$STALE_CODE" -eq 1 ] || fail "stale deploy should exit 1"
echo "$STALE_OUT" | grep -q 'W206' || fail "stale deploy should report W206"
node --input-type=module -e "
import { vlqEncodeSegment } from '$ROOT/dist/vlq.js';
import fs from 'node:fs';
const fresh = { version: 3, file: 'app.js', sources: ['src/a.js'], sourcesContent: ['function a() {}'], names: [], mappings: vlqEncodeSegment([0,0,0,0]) };
fs.writeFileSync('$WORKDIR/deploy/app.js.map', JSON.stringify(fresh));
"
$CLI check "$WORKDIR/deploy" >/dev/null || fail "rebuilt deploy should be clean"
echo "[smoke] fix loop ok (stale W206 -> rebuild -> clean)"

# 12. --output writes a file; --fail-unmapped gates the exit code.
$CLI remap examples/logs/prod.log --maps examples/dist -o "$WORKDIR/clean.log" --quiet
grep -q 'applyDiscount' "$WORKDIR/clean.log" || fail "--output file wrong"
set +e
printf 'at t (ghost.js:1:1)\n' | $CLI --fail-unmapped >/dev/null 2>&1; [ $? -eq 1 ] || { set -e; fail "--fail-unmapped should exit 1"; }
set -e
echo "[smoke] --output / --fail-unmapped ok"

# 13. Determinism: two runs over the same log are byte-identical.
$CLI remap examples/logs/prod.log --maps examples/dist > "$WORKDIR/run1.txt"
$CLI remap examples/logs/prod.log --maps examples/dist > "$WORKDIR/run2.txt"
cmp -s "$WORKDIR/run1.txt" "$WORKDIR/run2.txt" || fail "repeat runs differ"
echo "[smoke] determinism ok"

echo "SMOKE OK"
