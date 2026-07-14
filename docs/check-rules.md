# `remaptrace check` rule catalog

`check` validates that a deployed bundle and its source map actually
belong together — the failure class that makes symbolication silently
wrong rather than visibly broken. Codes are stable API: they are never
renumbered or reused. Severities: an **error** means remapping is broken
right now; a **warning** means results will be wrong or degraded; an
**info** is worth knowing but harmless.

Exit codes: `0` clean at the gate, `1` findings at or above `--fail-on`
(default `warning`), `2` usage error. `--fail-on never` always exits 0.

## Errors

| Code | Meaning |
|---|---|
| E101 | map (or bundle) file is unreadable, or the map is not valid JSON |
| E102 | `version` is not `3` — no other revision is defined |
| E103 | `mappings` is corrupt: invalid VLQ, a segment with 2 or 3 fields, or malformed `sections` |
| E104 | `sources` is missing or not an array |
| E105 | a segment references a source index that does not exist |
| E106 | a segment references a name index that does not exist |

E105/E106 usually mean the map was post-processed (concatenated, merged,
hand-edited) by something that did not re-base the indices.

## Warnings

| Code | Meaning |
|---|---|
| W201 | `sourcesContent` length differs from `sources` — the arrays must stay parallel |
| W202 | no `sourcesContent` at all — `frame` cannot show source context |
| W203 | bundle carries no `sourceMappingURL` comment (an adjacent `.map` is still validated) |
| W204 | `sourceMappingURL` points at a file that is not there |
| W205 | the map's `file` field names a different bundle — likely the wrong pairing |
| W206 | mappings address generated lines beyond the end of the bundle — the stale-map signature |
| W207 | segments on a generated line are out of order (consumers that binary-search unsorted lines return wrong positions; remaptrace re-sorts defensively) |

W206 is the one that catches the classic incident: the bundle was
redeployed, the map was not (or vice versa), and every remapped frame
points at plausible-looking but wrong source lines.

## Info

| Code | Meaning |
|---|---|
| I301 | the map decodes to zero mappings — every lookup will miss |
| I302 | sources listed in the map are never referenced by any mapping |

## What `check` accepts as a target

- a `.map` file — map-only rules;
- a bundle (`.js`/`.mjs`/`.cjs`) — the map is found via its
  `sourceMappingURL` comment (external or inline `data:` URI) or an
  adjacent `<bundle>.map`, then pair rules run;
- a directory — every bundle in it (non-recursive), plus orphan `.map`
  files no bundle claims.
