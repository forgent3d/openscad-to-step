/**
 * An OpenSCAD project is a folder, not a file: `include <configuration.scad>` resolves relative to the file that
 * includes it, `import("part.stl")` reads a data file beside it. The folder is read whole — every .scad as text,
 * every data file OpenSCAD reads as bytes — under the same limits as the browser workbench (project.ts), so what
 * builds here builds there. Node only (node:fs): the cad-build CLI and build-service (the sandbox's rebuild_model).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_ASSET_BYTES, MAX_PROJECT_BYTES, MAX_PROJECT_FILES, isAssetFile, isScadFile, projectScadEntry } from "./project.ts";
import type { ScadProjectInput } from "./report.ts";

/** Folders that are never part of a project: tooling, caches, what the CLI derives. Dot-folders are skipped too. */
const NOT_PROJECT_DIRS = new Set(["node_modules", "__pycache__", ".cache"]);

/**
 * Read `root` as a project. `entry` (a path inside it) is exempt from the limits; without one the entry is the
 * stored-project rule (`projectScadEntry`: root model.scad, else the file nothing includes) and null comes back when
 * the folder holds no .scad at all.
 */
export function readScadFolder(root: string, entry?: string): ScadProjectInput | null {
  const files: Record<string, string> = {};
  const assets: Record<string, Uint8Array> = {};
  let count = 0;
  let scadBytes = 0;
  let assetBytes = 0;
  let skipped = 0;
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!name.startsWith(".") && !NOT_PROJECT_DIRS.has(name)) walk(path, `${prefix}${name}/`);
        continue;
      }
      if (!st.isFile()) continue;
      const scad = isScadFile(name);
      if (!scad && !isAssetFile(name)) continue;
      const key = `${prefix}${name}`;
      const over = scad ? scadBytes + st.size > MAX_PROJECT_BYTES : assetBytes + st.size > MAX_ASSET_BYTES;
      if (key !== entry && (over || count >= MAX_PROJECT_FILES)) {
        skipped++;
        continue;
      }
      count++;
      if (scad) {
        scadBytes += st.size;
        files[key] = readFileSync(path, "utf8");
      } else {
        assetBytes += st.size;
        assets[key] = new Uint8Array(readFileSync(path));
      }
    }
  };
  walk(root, "");
  const chosen = entry ?? projectScadEntry(files);
  if (!chosen) return null;
  let source = files[chosen];
  if (source === undefined) {
    try {
      source = readFileSync(join(root, chosen), "utf8");
    } catch {
      source = ""; // an entry named before it is written (the write gate checks the text about to be saved)
    }
  }
  delete files[chosen];
  return { entry: chosen, source, files, assets, skipped };
}
