/**
 * What an OpenSCAD *project* is made of, for whoever reads one off a disk or a drop: the browser workbench
 * (cloud components/scad/scad-project.ts) and the cad-build CLI take in the same files under the same limits,
 * so a project that builds in one builds in the other.
 *
 * OpenSCAD projects are multi-file by nature (`include <configuration.scad>`, `use <inc/bearing.scad>`), and the
 * data files `import("part.stl")` / `surface("height.png")` read sit beside the .scad files. Everything is
 * mounted at its project-relative path; OpenSCAD itself resolves include/use.
 */

/** At most this many files / bytes of .scad per project: a guard against "the whole home directory", not a budget for a real project. */
export const MAX_PROJECT_FILES = 400;
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
/** Data files are counted apart: one STL can be several MB; the mesh fallback itself sews at most 8000 faces (transpile.ts MESH_MAX_FACES). */
export const MAX_ASSET_BYTES = 32 * 1024 * 1024;

/**
 * The data files OpenSCAD reads: import()'s meshes and 2D drawings, surface()'s height maps, `use <x.ttf>` fonts.
 * 3MF is taken too: this OpenSCAD build has no lib3mf and says so itself, which beats "file not found".
 */
export const ASSET_EXTENSIONS = ["stl", "off", "obj", "amf", "3mf", "dxf", "svg", "dat", "png", "ttf", "otf"] as const;

export const extensionOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
export const isScadFile = (name: string): boolean => extensionOf(name) === "scad";
export const isAssetFile = (name: string): boolean => (ASSET_EXTENSIONS as readonly string[]).includes(extensionOf(name));

/** `a\b/./c` → `a/b/c`: project paths use `/`, no leading `./`. */
export const normalizeProjectPath = (path: string): string => path.replace(/\\/g, "/").replace(/^\.?\//, "");

/** `a/b/../c.scad` → `a/c.scad`; keys of the file table always use `/` and have no leading `./`. */
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** The project files `path` includes or uses, resolved the way OpenSCAD looks: beside it first, then from the root. */
function namedFiles(files: Record<string, string>, path: string): string[] {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const out: string[] = [];
  for (const match of (files[path] ?? "").matchAll(/^[ \t]*(?:include|use)[ \t]*<([^>]+)>/gm)) {
    const here = normalizePath(`${dir}/${match[1]!.trim()}`);
    const fromRoot = normalizePath(match[1]!);
    if (files[here] !== undefined) out.push(here);
    else if (files[fromRoot] !== undefined) out.push(fromRoot);
  }
  return out;
}

/**
 * The .scad files a render of `entry` reads: the entry and everything it includes or uses, transitively. A file
 * outside it changes nothing about the model — what the agent is told each turn (cloud chat-context.ts).
 */
export function scadReachable(files: Record<string, string>, entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path) || files[path] === undefined) continue;
    seen.add(path);
    queue.push(...namedFiles(files, path));
  }
  return seen;
}

/**
 * The entry of a **stored** project: `model.scad` at the root, otherwise `pickScadEntry`. cloud (lib/source-language.ts
 * `openscadEntryPath`) and the sandbox build (build-service scad.ts) use this same function, so both sides build the
 * same file.
 */
export function projectScadEntry(files: Record<string, string>): string | null {
  if (files["model.scad"] !== undefined) return "model.scad";
  return pickScadEntry(files);
}

/**
 * Guess a project's entry file: the one that **no other file includes/uses**. Includes are resolved in OpenSCAD's lookup
 * order: first relative to the file that
 * contains it, then as a path under the project root.
 *
 * This is only a default and the user must be able to change it — a wrong entry does not cause an error but makes
 * **every relative path wrong**:
 * the `include <configuration.scad>` in `box_frame/part.scad` wants `box_frame/configuration.scad`,
 * and if the entry is taken to be a file at the root, the same statement looks in the root, finds nothing (or, worse,
 * finds a same-named file in another directory).
 * Returns null when the set of files is empty.
 */
export function pickScadEntry(files: Record<string, string>): string | null {
  const paths = Object.keys(files).sort();
  if (!paths.length) return null;
  const referenced = new Set<string>();
  for (const path of paths) for (const target of namedFiles(files, path)) referenced.add(target);
  const roots = paths.filter((path) => !referenced.has(path));
  if (roots.length === 1) return roots[0]!;
  // Several candidates: pick the shallowest (a part file at the project root looks more like the entry than one in
  // inc/); ties are broken in lexicographic order.
  const sorted = (roots.length ? roots : paths).slice().sort((a, b) => {
    const depth = a.split("/").length - b.split("/").length;
    return depth !== 0 ? depth : a.localeCompare(b);
  });
  return sorted[0] ?? null;
}
