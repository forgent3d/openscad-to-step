/**
 * OpenSCAD for scripts: our build (packages/openscad-wasm), in this process, a fresh instance per call (callMain
 * leaves global state behind). The browser's runner is components/scad/openscad-client.ts, which does the same
 * in a worker it can kill; here the caller owns the timeout (the corpus harness runs each file in a child process).
 *
 *  - runOpenScad — src/csg.ts `OpenScadRunner`: the slim build (evaluation only), `-o /out.fgjson`;
 *    with `mesh` the full build, rendering the nodes only a render can stand in for (Manifold: the mesh fallback
 *    wants an answer, fast; CGAL's exact numbers buy nothing for facets).
 *  - renderStl — the oracle: OpenSCAD's own render of a file, as binary STL. The full build (CGAL + Manifold), or
 *    a native OpenSCAD of the same fork when OPENSCAD_BIN points at one (same source). The backend is CGAL, as every
 *    recorded run so far — said explicitly since OpenSCAD 2026 made Manifold its default (a projection(cut = true)
 *    exactly at a face is the slice under CGAL, empty under Manifold); ORACLE_BACKEND=manifold renders with Manifold instead — often
 *    tens of times faster at the oracle's fine facets (a cube minus a sphere: 23 s against 0.4 s), but its minkowski
 *    blows up there (a cube ⊕ a sphere at $fs = 0.1: minutes), while CGAL drops a self-intersecting polygon from a
 *    union. A different reference either way, so the cache keys on it (scad-corpus-cache.mjs oracleIdentity).
 */

/** `--backend=…` for the oracle's render: CGAL unless ORACLE_BACKEND asks for another. */
export const oracleBackendArgs = () => [`--backend=${process.env.ORACLE_BACKEND || "cgal"}`];

import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Where OpenSCAD's wasm comes from: `OPENSCAD_WASM_DIR` names a directory holding openscad.mjs / openscad-full.mjs
 * and their .wasm + fonts/ (the cad-build CLI ships one in its assets); otherwise the workspace package.
 */
export function openScadGlueUrl(mesh = false) {
  const dir = process.env.OPENSCAD_WASM_DIR;
  // a directory may ship the full build alone (the cad-build CLI: rendering always renders): it evaluates as well,
  // so an evaluation-only run (a scad_part's transpile) uses it there
  if (dir) return pathToFileURL(join(dir, mesh || !existsSync(join(dir, "openscad.mjs")) ? "openscad-full.mjs" : "openscad.mjs")).href;
  return import.meta.resolve(mesh ? "@forgent3d/openscad-wasm/full" : "@forgent3d/openscad-wasm");
}

/**
 * text()'s fonts (packages/openscad-wasm/dist/fonts: OpenSCAD's own Liberation set), as OpenSCAD's filesystem wants
 * them: /fonts is where it looks (resourcePath("fonts")), 10-liberation.conf maps sans-serif/serif/monospace.
 */
function fontFiles() {
  const dir = join(dirname(fileURLToPath(openScadGlueUrl(false))), "fonts");
  return Object.fromEntries(readdirSync(dir).filter((name) => /\.(ttf|conf)$/.test(name)).map((name) => [`/fonts/${name}`, readFileSync(join(dir, name))]));
}

/** Whether the project draws text: only then are the fonts mounted for an evaluation (the export shapes the glyphs). */
export const drawsText = (files) => Object.entries(files).some(([path, text]) => path.startsWith("/project/") && typeof text === "string" && /\b(?:text|text3d|path_text)\s*\(/.test(text));

/** Module options for a run: the console captured, the built-in libraries' path set before main() reads the environment. */
const moduleOptions = (log) => ({
  noInitialRun: true,
  print: (l) => log.push(l),
  printErr: (l) => log.push(l),
  preRun: [(module) => { module.ENV.OPENSCADPATH = "/libraries"; }],
});

function mount(instance, files) {
  const mkdirp = (path) => {
    let current = "";
    for (const part of path.split("/").filter(Boolean)) {
      current += `/${part}`;
      try { instance.FS.mkdir(current); } catch { /* exists */ }
    }
  };
  for (const [path, data] of Object.entries(files)) {
    mkdirp(dirname(path));
    instance.FS.writeFile(path, data);
  }
}

function read(instance, path, binary = false) {
  try {
    const data = instance.FS.readFile(path);
    return binary ? data : new TextDecoder().decode(data);
  } catch {
    return null; // no output: the console says why
  }
}

/**
 * `defs` (`["-D", "$fa=1", …]`) only for the corpus harness's precision check, which evaluates under the oracle's defs.
 * @type {(job: { files: Record<string, string | Uint8Array>; entry: string; csg?: boolean; mesh?: boolean; preview?: boolean; scope?: string[]; fonts?: boolean; defs?: string[] }) => ReturnType<import("./csg.ts").OpenScadRunner>}
 */
export async function runOpenScad({ files, entry, csg = false, mesh = false, preview = false, scope = [], fonts = false, defs = [] }) {
  // the preview (OpenSCAD's own render of the whole model, the sidecar preview.ts reads) needs the full build too
  const full = mesh || preview;
  const { default: OpenSCAD } = await import(openScadGlueUrl(full));
  const printed = [];
  const instance = await OpenSCAD(moduleOptions(printed));
  mount(instance, fonts || drawsText(files) ? { ...fontFiles(), ...files } : files);
  let crash;
  // OpenSCAD's own exit status (a model with an error exits 1) is the run's answer, not this process's: emscripten
  // writes it to process.exitCode, which would fail whatever host called in — a test file, the CLI, a daemon
  const exitCode = process.exitCode;
  try {
    instance.callMain([
      ...defs, entry, "-o", "/out.fgjson",
      ...(csg ? ["-O", "fgjson/csg=true"] : []),
      ...(scope.length ? ["-O", `fgjson/scope=${scope.join(",")}`] : []),
      ...(mesh ? ["-O", "fgjson/mesh=true"] : []),
      ...(preview ? ["-O", "fgjson/preview=true"] : []),
      ...(full ? ["--backend=manifold"] : []),
    ]);
  } catch (err) {
    crash = err?.message || String(err);
  } finally {
    process.exitCode = exitCode;
  }
  // the sidecar sits beside the export (the browser worker reads the same path); none written = OpenSCAD says why
  const previewBytes = preview ? read(instance, "/out.fgjson.preview", true) : undefined;
  return {
    tree: read(instance, "/out.fgjson"),
    console: printed,
    ...(crash ? { crash } : {}),
    ...(preview ? { preview: previewBytes ? previewBytes.slice().buffer : null } : {}),
  };
}

/** Which renderer the oracle uses: the cache keys on it (scad-corpus-cache.mjs). */
export function oracleRenderer() {
  return process.env.OPENSCAD_BIN ? { kind: "native", path: process.env.OPENSCAD_BIN } : { kind: "wasm", module: openScadGlueUrl(true) };
}

/**
 * OpenSCAD's render of `entry` (mounted from `files`, `source` written over it when given) as binary STL bytes, or
 * null (the log says why). `defs` are `-D` pairs.
 */
export async function renderStl({ files = {}, entry = "/in.scad", source = null, defs = [], timeout = undefined }) {
  const renderer = oracleRenderer();
  if (renderer.kind === "native") {
    const dir = mkdtempSync(join(tmpdir(), "scad-oracle-"));
    try {
      const at = (path) => join(dir, path);
      const mounted = { ...fontFiles(), ...files, ...(source !== null ? { [entry]: source } : {}) };
      // A .csg names the files its import()/surface() read by the absolute path they had in the wasm's filesystem
      // ("/libraries/write/Letters.dxf"): here that path is under `dir`. Unmapped, the native render silently left
      // every Write.scad glyph out (256837: 31680 against the wasm's 32622.85 — and the frozen reference).
      const quoted = Object.keys(mounted).filter((path) => path.startsWith("/")).sort((a, b) => b.length - a.length);
      const relocate = (text) => quoted.reduce((out, path) => out.split(JSON.stringify(path)).join(JSON.stringify(at(path))), text);
      for (const [path, data] of Object.entries(mounted)) {
        mkdirSync(dirname(at(path)), { recursive: true });
        writeFileSync(at(path), typeof data === "string" && /\.(scad|csg)$/i.test(path) ? relocate(data) : data);
      }
      // the same fonts the wasm sees, and none of this machine's
      writeFileSync(at("/fonts.conf"), `<?xml version="1.0"?><fontconfig><dir>${at("/fonts")}</dir><cachedir>${at("/fontcache")}</cachedir><include ignore_missing="yes">${at("/fonts/10-liberation.conf")}</include></fontconfig>`);
      // OpenSCAD prints its warnings on stderr: kept on success too, as the wasm's log keeps them
      const run = spawnSync(renderer.path, [...defs, at(entry), "-o", at("/out.stl"), "--export-format=binstl", ...oracleBackendArgs()], {
        env: { ...process.env, OPENSCADPATH: at("/libraries"), FONTCONFIG_FILE: at("/fonts.conf") },
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 << 20,
        ...(timeout ? { timeout, killSignal: "SIGKILL" } : {}),
      });
      const log = `${run.stdout ?? ""}${run.stderr ?? ""}${run.error ? `\nERROR: ${run.error.message}` : ""}`;
      let data = null;
      try { data = readFileSync(at("/out.stl")); } catch { /* no output */ }
      return { data, log: log.split("\n") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const { default: OpenSCAD } = await import(renderer.module);
  const log = [];
  const instance = await OpenSCAD(moduleOptions(log));
  mount(instance, { ...fontFiles(), ...files });
  if (source !== null) instance.FS.writeFile(entry, source);
  try {
    instance.callMain([...defs, entry, "-o", "/out.stl", "--export-format=binstl", ...oracleBackendArgs()]);
  } catch (err) {
    log.push(`ERROR: ${err?.message || String(err)}`);
  }
  return { data: read(instance, "/out.stl", true), log };
}
