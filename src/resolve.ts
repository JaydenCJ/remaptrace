/**
 * Map resolution: given the bundle URL printed in a stack frame, find and
 * load the source map to use. Everything is local and offline — remaptrace
 * never fetches a map over the network, even when the frame URL is https.
 *
 * Resolution order (first hit wins, result cached per URL):
 *   1. Explicit `--map bundle=map` pairings — matched against the full URL,
 *      then as a path suffix, then by basename.
 *   2. `--maps` directories — a file named `<basename>.map` (e.g.
 *      `app.min.js.map`); failing that, any `.map` in the directory whose
 *      `file` field names the bundle.
 *   3. The bundle itself on disk — its `//# sourceMappingURL=` comment,
 *      including inline `data:` URIs, or an adjacent `<bundle>.map`.
 */

import fs from "node:fs";
import path from "node:path";
import { SourceMap, MapError } from "./sourcemap.js";
import { base64Decode, utf8Decode } from "./vlq.js";

/** A loaded map plus where it came from (for stats and error reporting). */
export interface ResolvedMap {
  map: SourceMap;
  /** Path or descriptor of the map that was loaded. */
  origin: string;
}

export interface ResolverOptions {
  /** Directories to index for `.map` files. */
  mapsDirs?: string[];
  /** Explicit pairings: bundle URL/path/basename -> map file path. */
  pairs?: [string, string][];
  /** Base directory for resolving relative bundle paths (default: cwd). */
  baseDir?: string;
}

/** Strip query/fragment and return the path portion of a frame URL. */
export function urlPath(url: string): string {
  let s = url.replace(/[?#].*$/, "");
  const m = /^[a-zA-Z][\w+.-]*:\/\/([^/]*)(\/.*)?$/.exec(s);
  if (m) s = m[2] ?? "/";
  return s;
}

/** Basename of a frame URL, query/fragment stripped. */
export function urlBasename(url: string): string {
  const p = urlPath(url);
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}

/** Extract the last `sourceMappingURL` comment from bundle text, if any. */
export function sourceMappingUrlOf(bundleText: string): string | null {
  const re = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$|\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\/\s*$/gm;
  let last: string | null = null;
  for (let m = re.exec(bundleText); m !== null; m = re.exec(bundleText)) {
    last = m[1] ?? m[2] ?? null;
  }
  return last;
}

/** Parse an inline `data:` source-map URI into map JSON text. */
export function dataUriToJson(uri: string): string {
  const m = /^data:([^,]*),([\s\S]*)$/.exec(uri);
  if (!m) throw new MapError("json", "malformed data: URI");
  const meta = m[1] ?? "";
  const payload = m[2] ?? "";
  if (/;base64$/i.test(meta) || /;base64;/i.test(meta)) {
    return utf8Decode(base64Decode(payload));
  }
  return decodeURIComponent(payload);
}

export class MapResolver {
  private readonly mapsDirs: string[];
  private readonly pairs: [string, string][];
  private readonly baseDir: string;
  /** URL -> resolved map (or null after a definitive miss). */
  private readonly cache = new Map<string, ResolvedMap | null>();
  /** map path -> loaded SourceMap, so shared maps parse once. */
  private readonly loaded = new Map<string, ResolvedMap | null>();
  /** Lazily built per-directory index: basename -> absolute path. */
  private dirIndex: Map<string, string> | null = null;
  /** Map files in mapsDirs whose `file` field has been read. */
  private fileFieldIndex: Map<string, string> | null = null;

  constructor(opts: ResolverOptions = {}) {
    this.mapsDirs = opts.mapsDirs ?? [];
    this.pairs = opts.pairs ?? [];
    this.baseDir = opts.baseDir ?? ".";
  }

  /** Resolve the map for a frame URL, or null when none can be found. */
  resolve(url: string): ResolvedMap | null {
    const hit = this.cache.get(url);
    if (hit !== undefined) return hit;
    const result = this.resolveUncached(url);
    this.cache.set(url, result);
    return result;
  }

  private resolveUncached(url: string): ResolvedMap | null {
    const base = urlBasename(url);
    const pathPart = urlPath(url);

    // 1. Explicit pairs.
    for (const [key, mapPath] of this.pairs) {
      if (
        key === url ||
        key === pathPart ||
        pathPart.endsWith(`/${key}`) ||
        key === base
      ) {
        return this.load(mapPath);
      }
    }

    // 2. Maps directories, by conventional name.
    if (this.mapsDirs.length > 0 && base !== "") {
      const index = this.indexDirs();
      const named = index.get(`${base}.map`);
      if (named) return this.load(named);
      // Fall back to the `file` field declared inside each map.
      const byField = this.indexFileFields().get(base);
      if (byField) return this.load(byField);
    }

    // 3. The bundle on disk (relative frame paths from Node services).
    const local = this.localBundlePath(url);
    if (local !== null) {
      const fromComment = this.mapForBundleFile(local);
      if (fromComment) return fromComment;
      const adjacent = `${local}.map`;
      if (isFile(adjacent)) return this.load(adjacent);
    }
    return null;
  }

  /**
   * Load the map referenced by a bundle file's own sourceMappingURL comment
   * (relative path, absolute path or inline data: URI).
   */
  mapForBundleFile(bundlePath: string): ResolvedMap | null {
    let text: string;
    try {
      text = fs.readFileSync(bundlePath, "utf8");
    } catch {
      return null;
    }
    const ref = sourceMappingUrlOf(text);
    if (ref === null) return null;
    if (ref.startsWith("data:")) {
      try {
        const map = SourceMap.fromJson(dataUriToJson(ref));
        return { map, origin: `${bundlePath} (inline data: URI)` };
      } catch {
        return null;
      }
    }
    const refPath = ref.replace(/[?#].*$/, "");
    const candidate = path.isAbsolute(refPath)
      ? refPath
      : path.join(path.dirname(bundlePath), refPath);
    return isFile(candidate) ? this.load(candidate) : null;
  }

  /** If the frame URL denotes a readable local file, return its path. */
  private localBundlePath(url: string): string | null {
    if (/^[a-zA-Z][\w+.-]*:\/\//.test(url)) {
      if (!url.startsWith("file://")) return null;
      const p = urlPath(url);
      return isFile(p) ? p : null;
    }
    if (url.startsWith("node:") || url.startsWith("<")) return null;
    const p = path.isAbsolute(url) ? url : path.join(this.baseDir, url);
    return isFile(p) ? p : null;
  }

  private load(mapPath: string): ResolvedMap | null {
    const known = this.loaded.get(mapPath);
    if (known !== undefined) return known;
    let result: ResolvedMap | null;
    try {
      const map = SourceMap.fromJson(fs.readFileSync(mapPath, "utf8"));
      result = { map, origin: mapPath };
    } catch {
      result = null; // unreadable or invalid map == no map; `check` explains why
    }
    this.loaded.set(mapPath, result);
    return result;
  }

  private indexDirs(): Map<string, string> {
    if (this.dirIndex) return this.dirIndex;
    const index = new Map<string, string>();
    for (const dir of this.mapsDirs) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith(".map")) continue;
        // First directory listed wins on conflicts.
        if (!index.has(e.name)) index.set(e.name, path.join(dir, e.name));
      }
    }
    this.dirIndex = index;
    return index;
  }

  private indexFileFields(): Map<string, string> {
    if (this.fileFieldIndex) return this.fileFieldIndex;
    const index = new Map<string, string>();
    for (const mapPath of this.indexDirs().values()) {
      const resolved = this.load(mapPath);
      const file = resolved?.map.file;
      if (file && !index.has(file)) index.set(file, mapPath);
    }
    this.fileFieldIndex = index;
    return index;
  }
}

export function isFile(p: string): boolean {
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() === true;
}
