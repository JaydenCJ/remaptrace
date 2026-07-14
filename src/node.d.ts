/**
 * Minimal ambient declarations for the handful of Node.js built-ins this
 * project uses. Declaring them in-repo keeps `typescript` the only
 * devDependency (no `@types/node`); the surface below is intentionally
 * restricted to exactly what `src/` calls, so a typo against a real Node
 * API still fails to compile.
 */

declare module "node:fs" {
  export interface Stats {
    isFile(): boolean;
  }
  export interface Dirent {
    name: string;
    isFile(): boolean;
  }
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true }
  ): Dirent[];
  export function statSync(
    path: string,
    options: { throwIfNoEntry: false }
  ): Stats | undefined;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string): string;
  export function isAbsolute(p: string): boolean;
}

declare module "node:process" {
  interface WritableLike {
    write(chunk: string): boolean;
  }
  const process: {
    argv: string[];
    exitCode: number | undefined;
    stdout: WritableLike;
    stderr: WritableLike;
  };
  export default process;
}
