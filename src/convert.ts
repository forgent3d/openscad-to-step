/**
 * .scad → STEP in one call: OpenSCAD (our fork, compiled to wasm) evaluates the project, the converter in this package
 * reads the evaluated tree into a model.py, and the Forgent3D engine (`@forgent3d/cad-build`) builds that as exact
 * B-rep and writes the STEP. The OpenSCAD build is the one cad-build ships, so the tree's format and the engine that
 * reads the model.py always come from the same release.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { transpileViaOpenScad } from "./csg.ts";
import { runOpenScad } from "./node.mjs";
import { readScadFolder } from "./node-project.ts";
import { literalValue, setParameter } from "./params.ts";
import type { ScadDiagnostic } from "./transpile.ts";
import type { ScadSpan } from "./tree.ts";

export type ConvertOptions = {
  /** The entry .scad file. */
  file: string;
  /** Where to write the STEP. Default: next to the .scad, same name. */
  out?: string;
  /** The project folder include/use/import() resolve in. Default: the .scad's own folder. */
  root?: string;
  /** Customizer overrides, `name` → OpenSCAD literal text (`10`, `"M3"`, `true`, `[1, 2]`). Written into the entry's
   *  top-level assignment before evaluation, as the Customizer does; never passed as `-D`. */
  params?: Record<string, string>;
  /** Also keep the generated model.py here. */
  modelPy?: string;
  /** BOSL2 threads as plain cylinders (fast, smaller STEP) instead of exact helical threads. */
  cosmeticThreads?: boolean;
  /** Include the `exact` notes (the STEP has true circles where OpenSCAD's preview shows facets). */
  allWarnings?: boolean;
};

export type ConvertResult =
  | { ok: true; out: string; python: string; warnings: string[]; size?: string }
  | { ok: false; errors: string[]; warnings: string[] };

/** The installed `@forgent3d/cad-build`: its CLI and the OpenSCAD wasm it ships. */
export function cadBuild(): { bin: string; openscad: string } {
  const dir = dirname(createRequire(import.meta.url).resolve("@forgent3d/cad-build/package.json"));
  return { bin: join(dir, "bin", "cad-build.mjs"), openscad: join(dir, "dist", "assets", "openscad") };
}

const where = (d: ScadDiagnostic): string => `${d.file}:${d.line}:${d.column}`;

export async function convert(options: ConvertOptions): Promise<ConvertResult> {
  const file = resolve(options.file);
  const root = resolve(options.root ?? dirname(file));
  const entry = relative(root, file).split("\\").join("/");
  if (entry.startsWith("..")) return { ok: false, errors: [`${options.file} is not inside --root ${root}`], warnings: [] };
  const project = readScadFolder(root, entry);
  if (!project) return { ok: false, errors: [`cannot read ${options.file}`], warnings: [] };

  let source = project.source;
  for (const [name, text] of Object.entries(options.params ?? {})) {
    const value = literalValue(text);
    if (value === undefined) return { ok: false, errors: [`-D ${name}=${text}: not an OpenSCAD value (a number, "a string", true/false or [a vector])`], warnings: [] };
    const set = setParameter(source, name, value);
    if (!set.ok) return { ok: false, errors: [`-D ${name}: ${set.error}`], warnings: [] };
    source = set.source;
  }

  const engine = cadBuild();
  process.env.OPENSCAD_WASM_DIR ||= engine.openscad;
  const via = await transpileViaOpenScad(source, {
    files: project.files,
    assets: project.assets,
    entry,
    run: runOpenScad,
    ...(options.cosmeticThreads ? { cosmeticThreads: true } : {}),
  });
  if (!via.ok) {
    const why = via.diagnostics.length ? via.diagnostics.map((d) => `${where(d)}: error: ${d.message}`) : [`OpenSCAD could not evaluate ${entry} (${via.reason})`];
    return { ok: false, errors: why, warnings: [] };
  }
  const { python, sourceMap } = via.transpiled;
  const warnings = via.transpiled.warnings
    .filter((d) => options.allWarnings || d.note?.kind !== "exact")
    .map((d) => `${where(d)}: warning: ${d.message}`);
  if (project.skipped) warnings.push(`${project.skipped} file(s) in ${root} left out (over the project limits)`);

  const out = resolve(options.out ?? join(dirname(file), `${basename(file, extname(file))}.step`));
  if (options.modelPy) writeFileSync(resolve(options.modelPy), python);
  const work = mkdtempSync(join(tmpdir(), "openscad-to-step-"));
  try {
    const modelPath = join(work, "model.py");
    writeFileSync(modelPath, python);
    const run = spawnSync(process.execPath, [engine.bin, "export", modelPath, "--format", "step", "--out", out], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const lines = `${run.stdout ?? ""}\n${run.stderr ?? ""}`.split("\n").map((line) => line.trimEnd());
    // an engine error names a model.py line; every located line of model.py maps back to the .scad call that made it
    const located = (line: string) =>
      line.replace(/model\.py:(\d+)/g, (whole, n: string) => {
        const at: ScadSpan | undefined = sourceMap[Number(n)];
        return at ? `${at.file}:${at.line}:${at.column}` : whole;
      });
    const engineWarnings = lines.filter((line) => line.startsWith("warning ")).map((line) => `warning: ${line.slice("warning ".length)}`);
    if (run.status !== 0) {
      const said = lines.filter((line) => line && !/^\*+|Statistics on Transfer|Transfer Mode|Transferring Shape|^ERROR:$/.test(line.trim()));
      return { ok: false, errors: said.length ? said.map(located) : [`the engine exited with ${run.status ?? run.signal}`], warnings: [...warnings, ...engineWarnings] };
    }
    const size = lines.find((line) => line.startsWith("bbox mm:"))?.slice("bbox mm:".length).trim();
    return { ok: true, out, python, warnings: [...warnings, ...engineWarnings], ...(size ? { size } : {}) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
