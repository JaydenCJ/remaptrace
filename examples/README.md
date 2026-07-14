# remaptrace examples

A miniature production incident, end to end. The layout mirrors a real
deploy: original sources, the minified bundle with its map, a mixed log
captured from that bundle, and a second deploy where the map went stale.

| Path | What it is |
|---|---|
| `src/checkout.js`, `src/main.js` | the original application sources |
| `dist/app.min.js` | the single-line minified bundle served to browsers |
| `dist/app.min.js.map` | its source map (sourcesContent embedded) |
| `logs/prod.log` | a production log: V8 trace, JSON log line, Firefox trace, a third-party frame with no map |
| `broken/` | a bundle whose map is wrong four different ways — `check` fodder |

## Remap the whole log

```bash
node dist/cli.js remap examples/logs/prod.log --maps examples/dist --stats
```

Every frame from `app.min.js` is rewritten to `src/checkout.js` /
`src/main.js` positions with original function names — including the stack
inside the JSON log line. The `vendor.min.js` frame has no map and passes
through untouched; `--stats` names it on stderr so you know what is missing.

## Inspect a single position

```bash
node dist/cli.js frame app.min.js:1:36 --maps examples/dist
```

Prints the original position plus the surrounding source lines pulled from
`sourcesContent` — no checkout of the original repository needed.

## Validate a deploy before you need it

```bash
node dist/cli.js check examples/dist     # exit 0, clean
node dist/cli.js check examples/broken   # exit 1: E105, W202, W205, W206
```

`examples/broken` seeds the classic failure modes: a segment pointing at a
source that does not exist (E105), no embedded sources (W202), a map built
from a different bundle (W205), and mappings addressing lines past the end
of the deployed file — the stale-map signature (W206).

## CI gate

```bash
node dist/cli.js check dist/ --fail-on warning || exit 1
```

Run it in the deploy pipeline: a broken bundle/map pair fails the deploy
instead of failing the on-call engineer three weeks later.
