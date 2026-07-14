# How remaptrace finds the map for a frame

A stack frame only carries a bundle URL — `https://cdn.example.test/assets/app.min.js`
— and remaptrace is strictly offline, so it never fetches that URL. Instead
it resolves a local map using the following order. The first hit wins and
the result (including a definitive miss) is cached per URL for the rest of
the run.

## 1. Explicit pairings: `--map <bundle>=<mapfile>`

The strongest signal, for when nothing else lines up (renamed artifacts,
hashed build outputs). The `<bundle>` side is matched against, in order:

| Match | Example key for `https://cdn.example.test/a/app.min.js?v=7` |
|---|---|
| full URL | `https://cdn.example.test/a/app.min.js?v=7` |
| exact path | `/a/app.min.js` |
| path suffix | `a/app.min.js` |
| basename | `app.min.js` |

Repeat the flag for multiple bundles.

## 2. Maps directories: `--maps <dir>`

Directories are indexed once per run (repeat the flag to add more; the
first directory listed wins on name conflicts). Two lookups happen:

1. **Conventional name** — a file called `<basename>.map`
   (`app.min.js.map`), which is what every bundler emits by default.
2. **`file` field** — failing that, each `.map` in the directory is parsed
   (lazily, cached) and its `file` field compared to the bundle basename.
   This rescues builds that write hashed map names like `build-7f3a.map`.

## 3. The bundle itself on disk

When the frame URL is a relative path, an absolute path, or a `file://`
URL that exists locally (typical for Node services), remaptrace reads the
bundle and follows its own trail:

1. the last `//# sourceMappingURL=` comment (also `//@` and `/*# … */`),
   resolved relative to the bundle — including inline
   `data:application/json;base64,…` URIs, decoded in-process;
2. failing that, an adjacent `<bundle>.map` file.

`http(s)` URLs are **never** fetched — if a CDN bundle's map is not
available locally through rule 1 or 2, the frame stays as it is and
`--stats` tells you which bundle had no map.

## Coordinates, for the record

Stack traces print 1-based lines and columns; the source-map wire format
is 0-based for both. remaptrace converts at exactly one place (inside
`SourceMap.originalPositionFor`) and its CLI output is 1-based, matching
what browsers print. Positions that fall before the first mapped segment
of a line, or on a 1-field "hole" segment, are reported unmapped rather
than rounded to a wrong neighbor.
