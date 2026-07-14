/**
 * Public programmatic API. Everything the CLI does is reachable as a
 * library call, so a log pipeline can embed remaptrace without shelling out:
 *
 *   import { MapResolver, processLog } from "remaptrace";
 *   const resolver = new MapResolver({ mapsDirs: ["./dist"] });
 *   const { output, stats } = processLog(logText, resolver);
 */

export { SourceMap, MapError, cleanSourcePath } from "./sourcemap.js";
export type { MapStats } from "./sourcemap.js";
export {
  MapResolver,
  urlPath,
  urlBasename,
  sourceMappingUrlOf,
  dataUriToJson,
} from "./resolve.js";
export type { ResolvedMap, ResolverOptions } from "./resolve.js";
export { findFrames, mayContainFrame, isInternalUrl } from "./stackparse.js";
export { remapText, spliceFrame, newStats } from "./remap.js";
export { processLog } from "./batch.js";
export type { ProcessOptions, ProcessResult } from "./batch.js";
export { checkTarget, checkBundle, checkMapFile, checkMapText } from "./check.js";
export {
  vlqDecode,
  vlqEncode,
  vlqEncodeSegment,
  base64Decode,
  utf8Decode,
  VlqError,
} from "./vlq.js";
export { summarize } from "./types.js";
export type {
  Segment,
  OriginalPosition,
  MapProblem,
  Frame,
  RemapStats,
  Severity,
  Finding,
  FindingSummary,
} from "./types.js";
export { VERSION } from "./version.js";
