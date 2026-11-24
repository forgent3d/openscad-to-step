import type { OpenScadRunner } from "./csg.ts";

/** Where OpenSCAD's wasm glue comes from: `OPENSCAD_WASM_DIR` when set, else the workspace package. A file: URL. */
export function openScadGlueUrl(mesh?: boolean): string;

/** `--backend=…` for the oracle's render, when ORACLE_BACKEND asks for one. */
export function oracleBackendArgs(): string[];

/** Whether the project draws text: only then are the fonts mounted for an evaluation. */
export function drawsText(files: Record<string, string | Uint8Array>): boolean;

/** csg.ts's `OpenScadRunner` for node: our build, in this process, a fresh instance per call. `defs` are `-D` pairs (the corpus harness's precision check). */
export function runOpenScad(job: Parameters<OpenScadRunner>[0] & { defs?: string[] }): ReturnType<OpenScadRunner>;

export function oracleRenderer(): { kind: "native"; path: string } | { kind: "wasm"; module: string };

/** OpenSCAD's own render of `entry` as binary STL bytes, or null (the log says why). */
export function renderStl(job: {
  files?: Record<string, string | Uint8Array>;
  entry?: string;
  source?: string | null;
  defs?: string[];
  timeout?: number;
}): Promise<{ data: Uint8Array | Buffer | null; log: string[] }>;
