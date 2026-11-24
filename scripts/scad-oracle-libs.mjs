/**
 * The built-in libraries as the ORACLE sees them: OpenSCAD's render has to be handed the same set the
 * transpiler resolves against (SCAD_LIBRARIES and the lazily loaded BOSL2, at the library path `/libraries`), or a file that
 * `use`s a built-in library leaves the denominator for reasons that are not ours.
 *
 * Write.scad needs its five DXF fonts as well. In the product they live in the engine (cad-engine
 * b123d/fonts/write-*.ts, generated from the SAME pinned commit); here the oracle reads the original
 * DXFs, which is what makes a glyph-for-glyph comparison meaningful at all.
 *
 * Where to put them follows OpenSCAD's lookup for `import(file)`: relative to the file the call is in
 * (the library's Write.scad), then relative to the main file's directory. Thingiverse files spell the
 * font `"write/orbitron.dxf"`, `"Letters.dxf"`, `"write/letters.dxf"`, … and the transpiler matches the
 * basename case-insensitively (that is the Customizer setup these files were written for), so every
 * one of those landing spots gets a copy, in the DXF's own case and in lower case.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WRITE = {
  repo: "rohieb/Write.scad",
  sha: "3ba5a7069580447bb08e36bf37d41ec68eeddc77",
  fonts: ["Letters.dxf", "orbitron.dxf", "knewave.dxf", "BlackRose.dxf", "braille.dxf"],
};

async function writeFonts() {
  const cache = join(packageRoot, ".scad-corpus", "libs", "write-fonts");
  mkdirSync(cache, { recursive: true });
  const out = {};
  for (const font of WRITE.fonts) {
    const path = join(cache, font);
    if (!existsSync(path)) {
      const url = `https://raw.githubusercontent.com/${WRITE.repo}/${WRITE.sha}/${font}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fetch ${url}: ${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    out[font] = readFileSync(path);
  }
  return out;
}

let cached = null;

/** `{ "/libraries/…": Buffer }` for openscadStl's `mount`, with the fonts also under `documentDir`. */
export async function oracleLibraryMount(documentDir = "/") {
  if (!cached) {
    const { SCAD_LIBRARIES } = await import("../src/transpile.ts");
    // BOSL2 too (the product loads it only for a file that includes it; mounting it always changes no other render)
    const { BOSL2 } = await import("../src/libraries/bosl2.js");
    cached = { libraries: { ...SCAD_LIBRARIES, ...BOSL2 }, fonts: await writeFonts() };
  }
  const mount = {};
  for (const [key, source] of Object.entries(cached.libraries)) mount[`/libraries/${key}`] = Buffer.from(source);
  const libraryDirs = new Set(Object.keys(cached.libraries).filter((key) => /(^|\/)write\.scad$/i.test(key)).map((key) => dirname(`/libraries/${key}`)));
  const dirs = new Set();
  for (const base of [...libraryDirs, documentDir.replace(/\/$/, "") || "/"]) {
    for (const sub of ["", "write", "Write"]) dirs.add(join(base, sub));
  }
  for (const dir of dirs) {
    for (const [font, data] of Object.entries(cached.fonts)) {
      mount[join(dir, font)] = data;
      mount[join(dir, font.toLowerCase())] = data;
    }
  }
  return mount;
}
