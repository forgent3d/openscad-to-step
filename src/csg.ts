/**
 * The single entry point for .scad: **OpenSCAD itself** executes the language. This file touches no environment API
 * (the browser worker / scripts/openscad-run.mjs injects the `OpenScadRunner`).
 *
 * Does not produce model.py when: OpenSCAD reported an ERROR; it **cannot open** an include/use (it only warns and
 * renders the rest, so a part silently goes missing — this must never count as success);
 * the flattened node count is too large; the tree has a node that transpile.ts cannot build and that has no mesh
 * fallback.
 * An empty model (OpenSCAD renders nothing either) is not a failure.
 */

import {
  modelNameFrom,
  isWriteFontFile,
  librariesFor,
  needsRender,
  transpileTree,
  type ScadDiagnostic,
  type ScadFiles,
  type ScadTranspileResult,
} from "./transpile.ts";
import { readParameters, type ScadParameter } from "./params.ts";
import { THREAD_SCOPED } from "./threads.ts";
import { readScadTree, ScadTreeError, type CsgNode, type ScadLogEntry } from "./tree.ts";

/**
 * Data files OpenSCAD reads itself in the project (STL/SVG/DXF… for `import()`, DAT/PNG for `surface()`, fonts for
 * `use <x.ttf>`):
 * path → bytes, under the same root as the .scad. They are only mounted into OpenSCAD's file system and never parsed
 * on this side — they reach model.py through the mesh fallback (transpile.ts
 * `fallback`).
 */
export type ScadAssets = Record<string, Uint8Array>;

/**
 * Mount `files` (absolute paths) in OpenSCAD's filesystem and run `openscad <entry> -o /out.fgjson` (with
 * `-O fgjson/csg=true` when `csg` is asked for). `mesh`: run the FULL build (CGAL + Manifold) with
 * `-O fgjson/mesh=true`, so the nodes only a render can stand in for carry OpenSCAD's render (tree.ts `rendered`);
 * otherwise the slim build, which only evaluates. `preview`: the full build with `-O fgjson/preview=true` — OpenSCAD's
 * render of the whole model, as the GUI shows it, in the `preview` sidecar (lib/scad-preview.ts; null when none was
 * written). `scope`: `-O fgjson/scope=<names>` — those modules' groups carry their
 * evaluated scope (tree.ts `scope`; bosl2.ts reads BOSL2's). `fonts`: mount text()'s fonts even though no project file
 * spells `text(` (a library draws the text). `tree` is the export's text — null when OpenSCAD crashed before
 * writing it, and then `crash` says how (the wasm ran out of stack, …); `console` is everything it printed.
 */
export type OpenScadRunner = (job: { files: Record<string, string | Uint8Array>; entry: string; csg?: boolean; mesh?: boolean; preview?: boolean; scope?: string[]; fonts?: boolean }) => Promise<{ tree: string | null; console: string[]; crash?: string; preview?: ArrayBuffer | null }>;

/** OpenSCAD's library path (OPENSCADPATH): the built-in libraries go here. */
const LIBRARY_ROOT = "/libraries";
const PROJECT_ROOT = "/project";

/** Beyond this many nodes (a loop unrolled into a million of them) the in-browser build is hopeless. */
export const TREE_MAX_NODES = 150_000;

/** `parameters` come with a failed build too: a parameter set to a value the model cannot take is fixed from the knobs. */
/**
 * `preview` (asked for with the `preview` option): the sidecar's bytes, there whenever OpenSCAD rendered — with a
 * model that transpiles, and with one it does not (`unsupported`: the preview shows it all the same, only the
 * STEP is out of reach); null when OpenSCAD wrote none.
 */
export type ScadViaOpenScadResult =
  | { ok: true; transpiled: ScadTranspileResult; nodes: number; parameters: ScadParameter[]; csg?: string; rendered?: true; preview?: ArrayBuffer | null }
  | { ok: false; reason: "openscad-error" | "missing-file" | "too-large" | "unsupported"; diagnostics: ScadDiagnostic[]; parameters: ScadParameter[]; nodes?: number; csg?: string; preview?: ArrayBuffer | null };

type Failure = Extract<ScadViaOpenScadResult, { ok: false }>;

/** A project in OpenSCAD's filesystem: the built-in libraries under their path, the files and data under /project, the entry last. */
async function mountProject(source: string, options: { files?: ScadFiles; assets?: ScadAssets; entry?: string }) {
  const entry = normalize(options.entry || "model.scad");
  const mount: Record<string, string | Uint8Array> = {};
  // the built-in libraries; BOSL2 (4.6 MB) only when a source includes/uses it — and then its shapes' scopes too
  const { files: libraries, scope: shapes } = await librariesFor([source, ...Object.values(options.files || {})]);
  for (const [key, text] of Object.entries(libraries)) mount[`${LIBRARY_ROOT}/${key}`] = text;
  // the data files import()/surface() read sit beside the .scad files, at the same relative paths
  for (const [key, bytes] of Object.entries(options.assets || {})) mount[`${PROJECT_ROOT}/${normalize(key)}`] = bytes;
  for (const [key, text] of Object.entries(options.files || {})) mount[`${PROJECT_ROOT}/${normalize(key)}`] = text;
  mount[`${PROJECT_ROOT}/${entry}`] = source;
  return { entry, mount, shapes, isLibrary: (file: string) => libraries[file] !== undefined };
}

export async function transpileViaOpenScad(
  source: string,
  options: {
    files?: ScadFiles;
    assets?: ScadAssets;
    entry?: string;
    run: OpenScadRunner;
    maxNodes?: number;
    csg?: boolean;
    /** BOSL2's threads as plain cylinders (threads.ts). Off: the evaluation and the model.py are exactly what they were. */
    cosmeticThreads?: boolean;
    /** OpenSCAD's render of the whole model too (the full build, one evaluation: the preview and the tree come together). */
    preview?: boolean;
  },
): Promise<ScadViaOpenScadResult> {
  const { entry, mount, shapes, isLibrary } = await mountProject(source, options);
  // the thread modules' scope only when their threads are drawn plain, and only where BOSL2 is in (it asked for scopes)
  const cosmeticThreads = options.cosmeticThreads === true;
  const scope = cosmeticThreads && shapes.length ? [...shapes, ...THREAD_SCOPED] : shapes;
  // with a preview the full build renders anyway: the mesh fallback's renders come in the same run, not a second one
  const preview = options.preview === true;
  const job = { files: mount, entry: `${PROJECT_ROOT}/${entry}`, csg: options.csg, ...(scope.length ? { scope } : {}), ...(preview ? { mesh: true, preview: true } : {}) };

  let evaluated = await evaluate(options.run, job, entry, isLibrary, options.maxNodes);
  if (evaluated.ok === false) return evaluated;
  // text() the runner did not see coming (it mounts the fonts only for a project that spells `text(`): a library drew
  // it — BOSL2's labels, text3d() — and OpenSCAD found no font to shape it with. Once more, with the fonts.
  const fonts = unshapedText(evaluated.nodes);
  // a node only OpenSCAD's render can stand in for (the mesh fallback): once more, with the full build, asking for it
  const rendered = needsRender(evaluated.nodes, { cosmeticThreads });
  if ((rendered && !preview) || fonts) {
    evaluated = await evaluate(options.run, { ...job, ...(rendered ? { mesh: true } : {}), ...(fonts ? { fonts: true } : {}) }, entry, isLibrary, options.maxNodes);
    if (evaluated.ok === false) return evaluated;
  }
  const { nodes, parameters, said, extra } = evaluated;
  const result = transpileTree(nodes, { entry, name: modelNameFrom(source), ...(cosmeticThreads ? { cosmeticThreads } : {}) });
  if (!result.ok) return { ok: false, reason: "unsupported", diagnostics: dedupe(result.errors), parameters, ...extra };
  // a node repeats its warning for every copy the evaluation made of it: once each, with a count
  return { ok: true, transpiled: { ...result, warnings: [...said.warnings, ...dedupe(result.warnings)] }, parameters, ...extra, ...(rendered ? { rendered: true as const } : {}) };
}

/**
 * OpenSCAD's own render of a project and nothing else — what the GUI's F5 shows, and what the cad-build CLI
 * reports, draws and exports for a .scad: the full build evaluates and renders in one run (`-O fgjson/preview=true`),
 * the sidecar is the mesh (preview.ts), and no model.py is made. The failures are the evaluation's: an ERROR that
 * stops OpenSCAD, a file it cannot open (OpenSCAD would render the rest and silently leave that part out). An empty
 * top level is a render with no geometry, not a failure. `echo` is what the model printed — the author's readout.
 */
export type ScadRenderResult =
  | { ok: true; preview: ArrayBuffer | null; nodes: number; parameters: ScadParameter[]; warnings: ScadDiagnostic[]; echo: string[] }
  | { ok: false; reason: Failure["reason"]; diagnostics: ScadDiagnostic[]; parameters: ScadParameter[] };

export async function renderViaOpenScad(
  source: string,
  options: { files?: ScadFiles; assets?: ScadAssets; entry?: string; run: OpenScadRunner },
): Promise<ScadRenderResult> {
  const { entry, mount, isLibrary } = await mountProject(source, options);
  const job = { files: mount, entry: `${PROJECT_ROOT}/${entry}`, mesh: true, preview: true };
  let evaluated = await evaluate(options.run, job, entry, isLibrary, Infinity);
  if (evaluated.ok === false) return evaluated;
  // a library drew text (BOSL2's labels, text3d()) and OpenSCAD found no font: once more, with the fonts
  if (unshapedText(evaluated.nodes)) {
    evaluated = await evaluate(options.run, { ...job, fonts: true }, entry, isLibrary, Infinity);
    if (evaluated.ok === false) return evaluated;
  }
  const { said, extra, parameters } = evaluated;
  // the transpile draws Write.scad's DXF glyphs itself (the engine carries the fonts); a render cannot, so say so
  const fonts = said.fonts.map((d) => ({ ...d, message: `${d.message} — Write.scad's DXF fonts are not bundled, so that lettering is missing from the render` }));
  return { ok: true, preview: extra.preview ?? null, nodes: extra.nodes, parameters, warnings: [...said.warnings, ...fonts], echo: said.echo };
}

/**
 * The agent's write gate for a .scad about to be saved (build-service `/lint` ← cloud cloud-workspace-tools.ts): does
 * OpenSCAD's own parser take the file? `path` is evaluated as the entry with `source` as its text, the rest of the
 * project mounted beside it (the slim build: nothing rendered), so its include/use resolve as they will. Only a
 * "Parser error" IN THAT FILE refuses the write — OpenSCAD's own words, nothing of ours: an unknown module, a missing
 * include (the agent may write it next) or a parse error in another file are the rebuild's to report.
 */
export async function scadParseErrors(
  source: string,
  options: { files?: ScadFiles; assets?: ScadAssets; path: string; run: OpenScadRunner },
): Promise<ScadDiagnostic[]> {
  const { entry, mount, isLibrary } = await mountProject(source, { files: options.files, assets: options.assets, entry: options.path });
  const evaluated = await evaluate(options.run, { files: mount, entry: `${PROJECT_ROOT}/${entry}` }, entry, isLibrary, Infinity);
  if (evaluated.ok !== false) return [];
  return evaluated.diagnostics.filter((d) => d.file === entry && /Parser error/.test(d.message));
}

/** A text() with something to say and no glyphs: OpenSCAD had no font to shape it with (tree.ts `contours`). */
function unshapedText(nodes: CsgNode[]): boolean {
  const walk = (node: CsgNode): boolean => {
    if (node.name === "text") {
      const text = node.args.get("text");
      if (typeof text === "string" && text.trim() !== "" && !Array.isArray(node.args.get("contours"))) return true;
    }
    return node.children.some(walk);
  };
  return nodes.some(walk);
}

/** One run of OpenSCAD, read and checked: the tree to translate, or why there is none. */
async function evaluate(
  run: OpenScadRunner,
  job: Parameters<OpenScadRunner>[0],
  entry: string,
  isLibrary: (file: string) => boolean,
  maxNodes = TREE_MAX_NODES,
): Promise<Failure | { ok: true; nodes: CsgNode[]; parameters: ScadParameter[]; said: ReturnType<typeof readLog>; extra: { csg?: string; nodes: number; preview?: ArrayBuffer | null } }> {
  const { tree: text, console: printed, crash, preview } = await run(job);
  if (text === null) {
    const said = printed.filter((line) => /^(ERROR|WARNING):/.test(String(line).trim())).map((line) => at(entry, `OpenSCAD: ${String(line).trim()}`));
    const why = crash ? [at(entry, `OpenSCAD stopped: ${crash}${/call stack|out of bounds|recursion/i.test(crash) ? " — the model recurses deeper than the in-browser OpenSCAD's stack allows" : ""}`)] : [];
    return { ok: false, reason: "openscad-error", diagnostics: [...why, ...said].length ? [...why, ...said] : [at(entry, "OpenSCAD produced no output")], parameters: [] };
  }
  let tree;
  try {
    tree = readScadTree(text, place);
  } catch (err) {
    if (!(err instanceof ScadTreeError)) throw err;
    return { ok: false, reason: "openscad-error", diagnostics: [at(entry, err.message)], parameters: [] };
  }
  const parameters = readParameters(tree.params);
  const said = readLog(tree.log, entry, isLibrary);
  const extra = { ...(tree.csg !== undefined ? { csg: tree.csg } : {}), nodes: tree.count, ...(job.preview ? { preview: preview ?? null } : {}) };
  if (tree.nodes === null || tree.aborted || crash) {
    const errors = [
      ...(crash ? [at(entry, `OpenSCAD stopped: ${crash}`)] : []),
      ...said.errors,
      // OpenSCAD renders the part before the error as if it were the model; this build does not
      ...(tree.aborted ? [at(entry, "OpenSCAD stopped evaluating at this error — what came before it is not the whole model, so nothing is built")] : []),
    ];
    return { ok: false, reason: "openscad-error", diagnostics: errors.length ? errors : [at(entry, "OpenSCAD produced no output")], parameters, ...extra };
  }
  if (said.missing.length) return { ok: false, reason: "missing-file", diagnostics: said.missing, parameters, ...extra };
  if (tree.count > maxNodes) {
    return {
      ok: false,
      reason: "too-large",
      diagnostics: [at(entry, `OpenSCAD flattens this model into ${tree.count.toLocaleString("en-US")} nodes (loops unrolled) — more than the in-browser build handles (${maxNodes.toLocaleString("en-US")})`)],
      parameters,
      ...extra,
    };
  }
  // Every ERROR left is one OpenSCAD logs and goes on past — polygon(points = undef) is an empty polygon: 128
  // Thingiverse files (91 of one origami template that indexes one past its list) failed on what OpenSCAD renders.
  const wentOn = said.errors.map((d) => ({ ...d, message: `${d.message} — OpenSCAD goes on past it, and so does this build` }));
  return { ok: true, nodes: tree.nodes, parameters, said: { ...said, errors: [], warnings: [...wentOn, ...said.warnings] }, extra };
}

/** OpenSCAD's filesystem path → the path a person knows: relative to the project, or to the library root for a built-in library. */
function place(path: string): string {
  if (path.startsWith(`${PROJECT_ROOT}/`)) return path.slice(PROJECT_ROOT.length + 1);
  if (path.startsWith(`${LIBRARY_ROOT}/`)) return path.slice(LIBRARY_ROOT.length + 1);
  return path;
}

/**
 * OpenSCAD's messages → diagnostics at the real file and line. Warnings inside a bundled library are the library's
 * business (it is shipped unmodified): one line per file. An ERROR raised inside one is the author's business — it is
 * moved to the line of their file that made the call (`projectCallSite`, read off the TRACE entries that follow it).
 * ECHO is the model's readout; TRACE is read only for that, and the rest of the chatter is dropped.
 */
function readLog(
  log: ScadLogEntry[],
  entry: string,
  isLibrary: (file: string) => boolean,
): { errors: ScadDiagnostic[]; warnings: ScadDiagnostic[]; missing: ScadDiagnostic[]; fonts: ScadDiagnostic[]; echo: string[] } {
  const errors: ScadDiagnostic[] = [];
  const warnings: ScadDiagnostic[] = [];
  const missing: ScadDiagnostic[] = [];
  const fonts: ScadDiagnostic[] = [];
  const echo: string[] = [];
  const libraryCounts = new Map<string, number>();
  // "Ignoring unknown function 'object'" right after "Experimental builtin function 'object' is not enabled": said once
  const offExperimental = new Set<string>();
  const experimentalSeen = new Map<string, { diagnostic: ScadDiagnostic; count: number }>();
  for (const [index, { group, text, at: where }] of log.entries()) {
    // what the model printed: the author's readout (the render path shows it; the transpile has the kernel's numbers)
    if (group === "ECHO") {
      echo.push(text);
      continue;
    }
    const severity = /ERROR/.test(group) ? "error" : group === "WARNING" ? "warning" : null;
    if (!severity) continue;
    // BOSL2's assert on a size it was handed sits at BOSL2/shapes3d.scad:422 — a line nobody can edit. The call
    // that handed it over is in the author's file, and OpenSCAD said which one in the trace.
    const site = severity === "error" && where && isLibrary(where.file) ? projectCallSite(log, index, isLibrary) : null;
    const diagnostic: ScadDiagnostic = site
      ? { ...site.at, message: `OpenSCAD: ${group}: ${text} — raised inside ${where!.file}:${where!.line} by this line's ${site.call}${site.within ? `, in ${site.within}` : ""}` }
      : { ...(where ?? { file: entry, line: 1, column: 1 }), message: `OpenSCAD: ${group}: ${text}` };
    // the full build renders every import(), Write.scad's fonts too, which are not mounted: the transpile draws them
    // itself (358933 failed on knewave.dxf once its offset() asked for that render), a plain render cannot (`fonts`)
    const font = /Can't open DXF file '([^']+)'/.exec(text);
    if (font && isWriteFontFile(font[1]!)) {
      fonts.push(diagnostic);
      continue;
    }
    // An experimental feature this build leaves off, as desktop OpenSCAD does by default (no --enable: the /scad
    // promise is desktop's behaviour): the value is undef / the call ignored, there and here — said plainly, even
    // inside a library, since a part may be missing for it. OpenSCAD's own words for a builtin; the fork adds the
    // swizzle's (upstream returns undef without a word since 2026's #6307, and v.xy was everyday OpenSCAD before).
    const experimental = experimentalOff(text);
    if (experimental) {
      offExperimental.add(experimental.name);
      // said again for every pass through a loop: once per place
      const key = `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${text}`;
      const seen = experimentalSeen.get(key);
      if (seen) seen.count += 1;
      else {
        const said = { diagnostic: { ...diagnostic, message: `${diagnostic.message} — ${experimental.explain}` }, count: 1 };
        experimentalSeen.set(key, said);
        warnings.push(said.diagnostic);
      }
      continue;
    }
    const unknown = /^Ignoring unknown (?:function|module) '([^']+)'/.exec(text);
    if (unknown && offExperimental.has(unknown[1]!)) continue;
    // include/use, and (in the render that the mesh fallback asks for) import()/surface() files; an import() of a
    // file it cannot read is an ERROR that OpenSCAD goes on past, dropping that part all the same (2865160 imports
    // "/project/.svg", a Customizer field left blank). A missing include says "Can't find" since 2026 ("Can't open"
    // is left for one that is there and unreadable); a 3MF import that fails says "Could not read file", and the
    // wasm builds leave lib3mf out ("Import from 3MF format was not enabled when building the application").
    if (/Can't (open (include file|library|input file|file|import file|DXF file|DAT file)|find include file|read PNG image)|Could not read file '|Unsupported file format while trying to import|format was not enabled when building the application, import\(\)/i.test(text)) missing.push(diagnostic);
    else if (severity === "error") errors.push(diagnostic);
    else if (where && isLibrary(where.file)) libraryCounts.set(where.file, (libraryCounts.get(where.file) ?? 0) + 1);
    else warnings.push(diagnostic);
  }
  for (const { diagnostic, count } of experimentalSeen.values()) if (count > 1) diagnostic.message += ` (×${count})`;
  for (const [file, count] of libraryCounts) {
    warnings.push({ file, line: 1, column: 1, message: `OpenSCAD: ${count} warning${count === 1 ? "" : "s"} inside the bundled library ${file} — not about your file` });
  }
  return { errors, warnings, missing, fonts, echo };
}

/**
 * Where the author's own file made the call an error was raised under, read off the TRACE entries OpenSCAD prints
 * right after the error (innermost frame first). A call leaves two frames: `call of 'cuboid(size = …)'` at the
 * callee's definition — its arguments as evaluated — then `called by 'cuboid'` at the call site. The first call
 * site in a project file is the line to fix; the next module call above it in the project is where that line lives.
 * null when the trace names no project line (the error then stays where OpenSCAD put it).
 */
function projectCallSite(
  log: ScadLogEntry[],
  errorIndex: number,
  isLibrary: (file: string) => boolean,
): { at: NonNullable<ScadLogEntry["at"]>; call: string; within: string } | null {
  const frames: ScadLogEntry[] = [];
  for (let i = errorIndex + 1; i < log.length && log[i]!.group === "TRACE"; i++) frames.push(log[i]!);
  const own = (frame: ScadLogEntry) => frame.at !== undefined && !isLibrary(frame.at.file);
  const siteIndex = frames.findIndex((frame) => own(frame) && /^called by '/.test(frame.text));
  if (siteIndex < 0) return null;
  const site = frames[siteIndex]!;
  const name = /^called by '(.*)'$/.exec(site.text)?.[1] ?? "";
  const evaluated = /^call of '([\s\S]*)'$/.exec(frames[siteIndex - 1]?.text ?? "")?.[1] ?? "";
  const call = evaluated.startsWith(`${name}(`) ? `call ${givenArguments(evaluated)}` : `call of ${name}()`;
  // the module that line lives in: the next project call above it — unless OpenSCAD cut frames out in between
  // ("*** Excluding 13 frames ***"), where the next one it kept may be further out
  const above = frames.slice(siteIndex + 1);
  const outerIndex = above.findIndex((frame) => own(frame) && /^call of '/.test(frame.text));
  const cut = above.slice(0, Math.max(outerIndex, 0)).some((frame) => /Excluding \d+ frames/.test(frame.text));
  const within = outerIndex >= 0 && !cut ? /^call of '([^(']*)/.exec(above[outerIndex]!.text)?.[1] ?? "" : "";
  return { at: site.at!, call, within: within ? `${within}()` : "" };
}

/** `cuboid(size = [40, 40, 2.5], p1 = undef, rounding = 3, …)` → the arguments that were given a value, clipped. */
function givenArguments(call: string, max = 160): string {
  const open = call.indexOf("(");
  if (open < 0) return call;
  const close = call.lastIndexOf(")");
  const body = call.slice(open + 1, close > open ? close : undefined);
  const args: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '"' && body[i - 1] !== "\\") quoted = !quoted;
    else if (quoted) continue;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      args.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(body.slice(start).trim());
  const given = args.filter((arg) => arg !== "" && !/=\s*undef$/.test(arg)).join(", ");
  return `${call.slice(0, open)}(${given.length > max ? `${given.slice(0, max)}…` : given})`;
}

/**
 * OpenSCAD's experimental builtins and the switch that turns each on (src/Feature.cc; Preferences → Features in
 * the desktop app, `--enable=<name>` on its command line). textmetrics()/fontmetrics() are no longer experimental.
 */
const EXPERIMENTAL_FEATURE: Record<string, string> = {
  object: "object-function",
  has_key: "object-function",
  import: "import-function",
  roof: "roof",
};

/**
 * "Experimental builtin function 'object' is not enabled" (OpenSCAD's BuiltinContext) and "Experimental vector
 * swizzle '.zyx' is not enabled" (the fork, where upstream says nothing): which name, and what that means here.
 */
export function experimentalOff(text: string): { name: string; explain: string } | null {
  const builtin = /^Experimental builtin (function|module) '([^']+)' is not enabled/.exec(text);
  const swizzle = /^Experimental vector swizzle '\.([^']+)' is not enabled/.exec(text);
  if (!builtin && !swizzle) return null;
  const feature = swizzle ? "vector-swizzle" : EXPERIMENTAL_FEATURE[builtin![2]!];
  const what = swizzle ? "the value is undef" : builtin![1] === "module" ? "the module is ignored and draws nothing" : "the call is ignored and gives undef";
  return {
    name: swizzle ? `.${swizzle[1]}` : builtin![2]!,
    explain: `an experimental OpenSCAD feature that desktop OpenSCAD also keeps off by default (Preferences → Features${feature ? ` → ${feature}` : ""}): without it ${what}, in desktop OpenSCAD and here alike`,
  };
}

/** Identical messages once, at the first place said, with a count — the evaluation repeats a node's warning for every copy of it. */
function dedupe(list: ScadDiagnostic[]): ScadDiagnostic[] {
  const counts = new Map<string, { diagnostic: ScadDiagnostic; count: number }>();
  for (const diagnostic of list) {
    const seen = counts.get(diagnostic.message);
    if (seen) seen.count += 1;
    else counts.set(diagnostic.message, { diagnostic, count: 1 });
  }
  return [...counts.values()].map(({ diagnostic, count }) => (count > 1 ? { ...diagnostic, message: `${diagnostic.message} (×${count})` } : diagnostic));
}

function at(file: string, message: string): ScadDiagnostic {
  return { file, line: 1, column: 1, message };
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\/+/, "");
}
