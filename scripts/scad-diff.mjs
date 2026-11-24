#!/usr/bin/env node
/**
 * Differential test: the same .scad, as the mesh OpenSCAD renders itself vs the B-rep OCC builds after OpenSCAD
 * evaluates it and it is translated to model.py
 * (src/csg.ts, the same path the product takes), comparing volume and bounding box.
 * Evaluation uses the product's slim build (packages/openscad-wasm); rendering uses the full build or the native one
 * OPENSCAD_BIN points to
 * (scripts/openscad-run.mjs, built from the same fork's source).
 *
 * This is the **only** way this pipeline can be verified — generated Python that looks right does not mean the geometry
 * is right (an anchor off by half a height,
 * rotate_extrude missing one plane, rotate([35,90,0]) rotating in the wrong order: none of these can be seen by eye,
 * and all show up once volume and bbox are compared;
 * the wrong rotation order even has an identical bbox, and only the volume catches it). So OpenSCAD's rendering is the
 * oracle, used the same way as the real
 * build123d on this machine.
 *
 * Tolerance: on our side a circle is a **true circle**, on OpenSCAD's side it is a faceted polygon. By default
 * OpenSCAD's `$fs=2` draws a hole of r=1.8
 * as a hexagon, a 17% volume difference, and a 1% tolerance is entirely eaten by facet noise — so the oracle always
 * passes `-D $fa=1 -D $fs=0.05`
 * (this only affects calls without `$fn`; where `$fn` is written it takes priority, which does not conflict with the
 * transpiler's rule "`$fn<=12` is a prism").
 * The direction of the remaining difference is still predictable: facets are inscribed in the circle, so the OCC volume
 * should be >= the wasm volume.
 *
 *   node --experimental-strip-types scripts/scad-diff.mjs [fixture.scad ...]
 *
 * The exported meshStats/openscadStl/occStl/compare are reused by scad-corpus.mjs (the real-corpus batch run);
 * fixtures run only when this file is executed directly.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { oracleLibraryMount } from "./scad-oracle-libs.mjs";
import { transpileViaOpenScad } from "../src/csg.ts";
import { renderStl, runOpenScad } from "../src/node.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = dirname(here);
export const fixturesDir = join(packageRoot, "__fixtures__");
// CAD_BUILD_BIN: an installed cad-build (the open-source repo runs the published package); default the workspace's
export const cadBuild = process.env.CAD_BUILD_BIN || join(packageRoot, "../cad-build-cli/bin/cad-build.mjs");

/**
 * The fixtures' data files (`__fixtures__/assets/`: what import()/surface() read), as bytes by path relative to a
 * fixture — the product mounts a project's data files beside its .scad files the same way (csg.ts `assets`).
 */
function fixtureAssets() {
  const dir = join(fixturesDir, "assets");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).map((name) => [`assets/${name}`, new Uint8Array(readFileSync(join(dir, name)))]));
}

export const VOLUME_TOLERANCE = 0.01; // 1%: facets of an explicit $fn vs a true circle + meshing error
export const BBOX_TOLERANCE = 0.01;
/** The oracle's facet density (see the header comment). */
export const ORACLE_DEFS = ["-D", "$fa=1", "-D", "$fs=0.05"];

/**
 * Reference for the corpus batch run (scad-thingiverse.mjs): have OpenSCAD render **the csg it exported itself** — our
 * model.py is translated from exactly that tree,
 * so both sides are the same part. Rendering the .scad directly does not work: the `-D` of ORACLE_DEFS rewrites the
 * evaluation result of models that read `$fa`/`$fs`
 * (1568970: rendering the .scad gives 57.5, rendering its csg gives 29764, ours is 29856).
 *
 * Every csg node writes `$fn/$fa/$fs` as its own arguments, which `-D` cannot override, so it is rewritten in place:
 * `$fa`/`$fs` are replaced with ORACLE_DEFS's fine facets;
 * `$fn` 13..63 is raised to 64 — we deliberately build these surfaces exact (transpile.ts), and a 64-segment circle is
 * only 0.16% off in area, within the 1% tolerance; 64 and above is left as-is
 * (setting it to 0 and leaving it to fine facets would turn a `$fn = 128` big sphere into 360 segments, heavier than
 * what the author wrote, and the render of 10428 timed out because of it). `$fn` 1..12 is left as-is:
 * that polygon is intended on both sides. Only the facet density changes, not the geometry.
 */
export function oracleCsg(csg) {
  return csg
    .replace(/\$fn = (\d+(?:\.\d+)?)/g, (whole, n) => (Number(n) > 12 && Number(n) < 64 ? "$fn = 64" : whole))
    .replace(/\$fa = [^,)]+/g, "$fa = 1")
    .replace(/\$fs = [^,)]+/g, "$fs = 0.05");
}

/** Binary STL → { volume, bbox:[min,max], triangles } (divergence theorem). */
export function meshStats(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const isAscii = buffer.length > 5 && String.fromCharCode(...buffer.slice(0, 5)) === "solid" && buffer.length < 84;
  if (isAscii) throw new Error("ASCII STL not supported by the diff harness");
  const count = view.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (let i = 0; i < count; i++) {
    const at = 84 + i * 50 + 12;
    const p = [];
    for (let v = 0; v < 3; v++) {
      const x = view.getFloat32(at + v * 12, true);
      const y = view.getFloat32(at + v * 12 + 4, true);
      const z = view.getFloat32(at + v * 12 + 8, true);
      p.push([x, y, z]);
      for (let axis = 0; axis < 3; axis++) {
        const value = [x, y, z][axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    const [a, b, c] = p;
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { volume: Math.abs(volume), bbox: [min, max], triangles: count };
}

/**
 * OpenSCAD renders a source into an STL (openscad-run.mjs renderStl: the full wasm build, or the native one from OPENSCAD_BIN). `mount` mounts a
 * directory tree into its file system (so include/use can resolve), shaped like { "/repo/x.scad": Buffer }. When no STL is produced, stats is null (the reason is in the log).
 */
export async function openscadStl(source, { mount = {}, defs = ORACLE_DEFS, entry = "/in.scad" } = {}) {
  const { data, log } = await renderStl({ files: mount, entry, source, defs });
  const stats = data && data.length >= 84 ? meshStats(data) : null;
  return { stats: stats && stats.triangles > 0 ? stats : null, log: log.filter((l) => /ERROR|WARNING/.test(l)) };
}

/**
 * Rebuild first when the cad-build bundle (dist/, gitignored) lags behind the engine source or the wasm. It does not
 * update itself: if cad-engine was changed
 * but `pnpm run build` was forgotten, the differential run uses the old engine — new dialect names (hull/minkowski/Shell)
 * fail outright with an
 * ImportError, and worse, the old engine produces numbers as usual that quietly do not match.
 */
export function ensureFreshCadBuild() {
  if (process.env.CAD_BUILD_BIN) return; // a published package: nothing to rebuild
  const cliDir = join(packageRoot, "../cad-build-cli");
  const bundle = join(cliDir, "dist/cli.mjs");
  const newest = (dir) => {
    let t = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__" && entry.name !== "node_modules") t = Math.max(t, newest(path));
      } else {
        t = Math.max(t, statSync(path).mtimeMs);
      }
    }
    return t;
  };
  // the bundle also carries this package (the transpiler) and OpenSCAD's wasm: a change to either is a stale cad-build too
  const sources = Math.max(newest(join(packageRoot, "../cad-engine/src")), newest(join(packageRoot, "../occt-read/dist")), newest(join(packageRoot, "src")), newest(join(packageRoot, "../openscad-wasm/dist")));
  if (existsSync(bundle) && statSync(bundle).mtimeMs >= sources) return;
  process.stderr.write("cad-build bundle is older than cad-engine/occt — rebuilding it first\n");
  execFileSync("node", [join(cliDir, "scripts/build.mjs")], { cwd: cliDir, stdio: ["ignore", "ignore", "inherit"] });
}

/**
 * Transpile output → cad-build build → **the B-rep's own** volume and bounding box. The directory is isolated by name.
 *
 * It used to measure the mesh of `export stl`: the export meshes at 0.1 mm / 0.5 rad, and the volume it shaves off true
 * spheres and true cones
 * can reach 1% (the exact hull of three spheres of unequal radius reads 4573.6, the B-rep is 4625.3, the oracle 4625.1)
 * — the more exact
 * the surface is made, the more the differential fails to "match". The oracle's mesh is inscribed, so comparing against the exact volume gives the direction the header comment calls "OCC >= wasm".
 * `warnings` also returns the build warnings (the `[cad-engine] warning code: …` lines).
 */
export const MEASURE_PROBE = `if part is None:
    print("OCCMEASURE empty")
else:
    _b = part.bounding_box()
    print("OCCMEASURE", part.volume, _b.min.X, _b.min.Y, _b.min.Z, _b.max.X, _b.max.Y, _b.max.Z)
`;

export function occMeasure(python, name, workDir, { cadBuildPath = cadBuild, timeout = 180000, env = process.env } = {}) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const modelPath = join(dir, "model.py");
  writeFileSync(modelPath, python);
  const log = execFileSync("node", [cadBuildPath, "check", modelPath, "--code-stdin"], {
    input: MEASURE_PROBE, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout, env,
  });
  const line = log.split("\n").find((l) => l.startsWith("OCCMEASURE"));
  if (!line) throw Object.assign(new Error("cad-build check printed no measurement"), { stdout: log });
  const warnings = [...log.matchAll(/warning ([a-z-]+):/g)].map((m) => m[1]);
  // an empty top level (every object came out empty) is OpenSCAD's empty render, not a failure
  if (line.trim() === "OCCMEASURE empty") return { empty: true, volume: 0, bbox: null, warnings, log };
  const [volume, ...box] = line.split(/\s+/).slice(1).map(Number);
  return {
    volume: Math.abs(volume),
    bbox: [box.slice(0, 3), box.slice(3, 6)],
    warnings,
    log,
  };
}

/** The old name kept for scad-corpus.mjs: it measures the B-rep, no longer the STL (see occMeasure). */
export const occStl = occMeasure;

const rel = (a, b) => (b === 0 ? (a === 0 ? 0 : 1) : Math.abs(a - b) / Math.abs(b));

/** The difference between two mesh stats: relative volume difference, relative per-axis size difference, origin offset; ok is judged by tolerance. */
export function compare(occ, scad) {
  if (occ.empty) {
    const scadSize = scad.bbox[1].map((high, axis) => high - scad.bbox[0][axis]);
    return { ok: false, dv: 1, dSize: [1, 1, 1], dOrigin: [0, 0, 0], occSize: [0, 0, 0], scadSize };
  }
  const dv = rel(occ.volume, scad.volume);
  const sizeOf = (stats) => stats.bbox[1].map((high, axis) => high - stats.bbox[0][axis]);
  const [scadSize, occSize] = [sizeOf(scad), sizeOf(occ)];
  const dSize = occSize.map((value, axis) => rel(value, scadSize[axis]));
  const dOrigin = occ.bbox[0].map((value, axis) => Math.abs(value - scad.bbox[0][axis]));
  const ok = dv <= VOLUME_TOLERANCE && dSize.every((d) => d <= BBOX_TOLERANCE) && dOrigin.every((d) => d < 0.05);
  return { ok, dv, dSize, dOrigin, occSize, scadSize };
}

async function main() {
  const workDir = join(packageRoot, ".scad-diff");
  const fmt = (n) => Number(n).toFixed(2);
  const files = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(fixturesDir).filter((name) => name.endsWith(".scad")).sort().map((name) => join(fixturesDir, name));

  rmSync(workDir, { recursive: true, force: true });
  ensureFreshCadBuild();
  const assets = fixtureAssets();
  // the oracle renders /in.scad: its data files at the same relative paths from there
  const assetMount = Object.fromEntries(Object.entries(assets).map(([path, bytes]) => [`/${path}`, bytes]));
  let failures = 0;
  for (const file of files) {
    const name = basename(file, ".scad");
    const source = readFileSync(file, "utf8");
    process.stdout.write(`\n── ${name}\n`);
    const via = await transpileViaOpenScad(source, { assets, run: runOpenScad });
    if (!via.ok) {
      for (const error of via.diagnostics) process.stdout.write(`   ERROR ${error.line}:${error.column} ${error.message}\n`);
      failures++;
      continue;
    }
    const result = via.transpiled;
    for (const warning of result.warnings) process.stdout.write(`   warn  ${warning.line}:${warning.column} ${warning.message}\n`);
    let scad;
    let occ;
    // BOSL2 at the oracle's facets ($fa = 1: 360 a circle) is a minkowski of a box and a 64800-point ball: CGAL takes
    // minutes, Manifold (both sides convex) a second
    const backend = process.env.ORACLE_BACKEND;
    if (/\bBOSL2\//.test(source)) process.env.ORACLE_BACKEND ||= "manifold";
    try {
      scad = await openscadStl(source, { mount: { ...(await oracleLibraryMount()), ...assetMount } });
    } finally {
      if (backend === undefined) delete process.env.ORACLE_BACKEND;
      else process.env.ORACLE_BACKEND = backend;
    }
    if (!scad.stats) {
      process.stdout.write(`   ERROR OpenSCAD's render produced no geometry: ${scad.log.join(" | ").slice(0, 300)}\n`);
      failures++;
      continue;
    }
    try {
      occ = occStl(result.python, name, workDir);
    } catch (err) {
      process.stdout.write(`   ERROR cad-build failed: ${String(err.stderr || err.stdout || err.message).slice(-600)}\n`);
      writeFileSync(join(workDir, `${name}.py`), result.python);
      failures++;
      continue;
    }
    const diff = compare(occ, scad.stats);
    if (!diff.ok) failures++;
    process.stdout.write(
      `   ${diff.ok ? "OK   " : "FAIL "} volume ${fmt(occ.volume)} vs ${fmt(scad.stats.volume)} (${(diff.dv * 100).toFixed(2)}%)\n` +
        `         size  [${diff.occSize.map(fmt).join(", ")}] vs [${diff.scadSize.map(fmt).join(", ")}]\n` +
        `         min   [${(occ.bbox?.[0] ?? []).map(fmt).join(", ")}] vs [${scad.stats.bbox[0].map(fmt).join(", ")}]\n`,
    );
    if (!diff.ok) writeFileSync(join(workDir, `${name}.py`), result.python);
  }
  process.stdout.write(`\n${failures ? `${failures} fixture(s) FAILED` : "all fixtures match"}\n`);
  process.exit(failures ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
