/**
 * The custom-built OpenSCAD's `-o out.fgjson` (fork `src/io/export_fgjson.cc`) → node tree. Argument names are the same
 * as in .csg.
 * Full precision; every node carries file:line:col; strings are JSON; non-finite numbers in numeric arguments are
 * `"inf"`/`"nan"`;
 * the same evaluation carries the Customizer `params` and a `log` with positions. ListNodes and the root are already
 * flattened into the parent list at export time.
 */

export type CsgValue = number | string | boolean | null | CsgValue[];

/** A value in a module scope (tree.ts `CsgNode.scope`): OpenSCAD's range / function / oversized list each get a marker. */
export type ScopeValue = number | string | boolean | null | ScopeValue[] | { range: [number, number, number] } | { omitted: number } | { opaque: "function" | "object" };

/** A .scad source location: a path relative to the project (for bundled libraries, the path within the library), 1-based line and column. */
export type ScadSpan = { file: string; line: number; column: number };

export type CsgNode = {
  name: string;
  /** `%` background (not rendered), `#` highlight (built as usual); `!` and `*` are already handled by OpenSCAD during evaluation. */
  modifier: "" | "%" | "#" | "!" | "*";
  args: Map<string, CsgValue>;
  /** Only hand-written csg text (csg-parse.ts, for tests) has positional arguments; exported trees are always named. */
  positional: CsgValue[];
  children: CsgNode[];
  /** Where in the .scad the call that produced this node was made; hand-written csg text has none. */
  at?: ScadSpan;
  /** Which user module this group is a call of. */
  module?: string;
  /**
   * Modules whose scope was requested (`-O fgjson/scope=…`; csg.ts requests it only when BOSL2 is mounted, bosl2.ts
   * `BOSL2_SCOPED`): where the module is defined
   * (`defined`; a same-named module written in the project is not BOSL2's), the variables it sees (`scope`: after the
   * parameter defaults are substituted and then overwritten by top-level
   * assignments in the body — where BOSL2 normalizes `edges` / `size`), and the `$fn/$fa/$fs` at the call (`specials`: the call's arguments take priority over the caller's).
   * In scope, undef is null, non-finite numbers are ±Infinity/NaN, a range is `{ range: [start, step, stop] }`, and an oversized list is `{ omitted: length }`.
   */
  defined?: ScadSpan;
  scope?: Map<string, ScopeValue>;
  specials?: { $fn?: number; $fa?: number; $fs?: number };
  /** The built-in call that produced it, present only when it differs from the node name (multmatrix ← translate/rotate/scale/mirror, group ← for/if/children…). */
  call?: string;
  /**
   * Mesh fallback (`-O fgjson/mesh=true`, full build): OpenSCAD's own rendering of this node — points and faces in 3D,
   * points and paths in 2D.
   * null = it rendered empty; no such field = no rendering was requested. Only nodes that cannot be built exactly carry
   * it (import, surface, roof,
   * projection(cut = false), offset(chamfer = true)).
   */
  rendered?: ScadRender | null;
};

export type ScadRender = { dim: 3; points: number[][]; faces: number[][] } | { dim: 2; points: number[][]; paths: number[][] };

/** One entry from the OpenSCAD console: `group` is OpenSCAD's group name (WARNING, ERROR, PARSER-ERROR, ECHO, TRACE, DEPRECATED…). */
export type ScadLogEntry = { group: string; text: string; at?: ScadSpan };

export type ScadTree = {
  /** null: OpenSCAD stopped before evaluation (syntax error, entry file could not be opened); `log` says why. */
  nodes: CsgNode[] | null;
  /** Evaluation was interrupted midway by an exception (assert() failed, recursion…): `nodes` is only what came before. Without it, every ERROR in the log
   *  is one OpenSCAD noted and kept evaluating past (`polygon(points = undef)` is an empty polygon). */
  aborted: boolean;
  /** Customizer parameters (OpenSCAD's param JSON); null when it stopped before evaluation. */
  params: unknown;
  log: ScadLogEntry[];
  /** With `-O fgjson/csg=true`: the .csg text of the same evaluation (full precision), so the oracle can render the same tree. */
  csg?: string;
  /** Total node count (the size after flattening). */
  count: number;
};

export class ScadTreeError extends Error {}

/** A scope value as the fork writes it (export_fgjson.cc `scopeValue`) → ScopeValue. Unknown shapes read as null. */
function scopeValue(v: unknown): ScopeValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(scopeValue);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.nonfinite === "string") return NON_FINITE[o.nonfinite] ?? NaN;
    if (Array.isArray(o.range) && o.range.length === 3 && o.range.every((x) => typeof x === "number")) return { range: o.range as [number, number, number] };
    if (typeof o.omitted === "number") return { omitted: o.omitted };
    if (o.function === true) return { opaque: "function" };
    if (o.object === true) return { opaque: "object" };
  }
  return null;
}

/** Only these arguments are strings to begin with; in the other arguments "inf"/"-inf"/"nan" are non-finite numbers. */
const STRING_ARGS = new Set(["text", "font", "direction", "language", "script", "halign", "valign", "file", "id", "layer", "method"]);
const NON_FINITE: Record<string, number> = { inf: Infinity, "-inf": -Infinity, nan: NaN, "-nan": NaN };

/**
 * `.fgjson` text → node tree. `place` turns the absolute paths in the OpenSCAD file system (`/project/a.scad`,
 * `/libraries/MCAD/x.scad`)
 * into paths that are readable in diagnostics; unrecognized paths are left as they are.
 */
export function readScadTree(text: string, place: (path: string) => string = (path) => path): ScadTree {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch (err: any) {
    throw new ScadTreeError(`OpenSCAD's export is not JSON: ${err?.message || String(err)}`);
  }
  if (raw?.format !== "forgent3d-openscad-tree" || raw?.version !== 1) {
    throw new ScadTreeError(`not a forgent3d-openscad-tree v1 export (format ${JSON.stringify(raw?.format)}, version ${JSON.stringify(raw?.version)})`);
  }
  const files: string[] = Array.isArray(raw.files) ? raw.files.map((path: unknown) => place(String(path))) : [];
  const span = (at: unknown): ScadSpan | undefined => {
    if (!Array.isArray(at) || at.length < 3) return undefined;
    const file = files[Number(at[0])];
    // a parser error knows its line but not its column (OpenSCAD writes -1)
    return file === undefined ? undefined : { file, line: Math.max(1, Number(at[1]) || 1), column: Math.max(1, Number(at[2]) || 1) };
  };
  const value = (v: unknown, numeric: boolean): CsgValue => {
    if (Array.isArray(v)) return v.map((item) => value(item, numeric));
    if (numeric && typeof v === "string" && v in NON_FINITE) return NON_FINITE[v]!;
    if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean") return v as CsgValue;
    throw new ScadTreeError(`unexpected value in OpenSCAD's export: ${JSON.stringify(v)}`);
  };
  let count = 0;
  const node = (n: any): CsgNode => {
    if (typeof n?.node !== "string") throw new ScadTreeError(`a node without a name in OpenSCAD's export: ${JSON.stringify(n)?.slice(0, 80)}`);
    count++;
    const args = new Map<string, CsgValue>();
    for (const [key, v] of Object.entries(n.args ?? {})) args.set(key, value(v, !STRING_ARGS.has(key)));
    const out: CsgNode = {
      name: n.node,
      modifier: n.modifier === "%" || n.modifier === "#" ? n.modifier : "",
      args,
      positional: [],
      children: Array.isArray(n.children) ? n.children.map(node) : [],
    };
    const at = span(n.at);
    if (at) out.at = at;
    if (typeof n.module === "string") out.module = n.module;
    const defined = span(n.defined);
    if (defined) out.defined = defined;
    if (n.scope && typeof n.scope === "object") out.scope = new Map(Object.entries(n.scope).map(([key, v]) => [key, scopeValue(v)]));
    if (n.specials && typeof n.specials === "object") {
      const specials: NonNullable<CsgNode["specials"]> = {};
      for (const key of ["$fn", "$fa", "$fs"] as const) {
        const v = scopeValue(n.specials[key]);
        if (typeof v === "number") specials[key] = v;
      }
      out.specials = specials;
    }
    if (typeof n.call === "string") out.call = n.call;
    if (n.rendered === null) out.rendered = null;
    else if (n.rendered && (n.rendered.dim === 2 || n.rendered.dim === 3)) out.rendered = n.rendered as ScadRender;
    return out;
  };
  const nodes = Array.isArray(raw.tree) ? raw.tree.map(node) : null;
  const log: ScadLogEntry[] = (Array.isArray(raw.log) ? raw.log : []).map((entry: any) => {
    const out: ScadLogEntry = { group: String(entry?.group ?? ""), text: String(entry?.text ?? "").trim() };
    const at = span(entry?.at);
    if (at) out.at = at;
    return out;
  });
  return { nodes, aborted: raw.aborted === true, params: raw.params ?? null, log, ...(typeof raw.csg === "string" ? { csg: raw.csg } : {}), count };
}
