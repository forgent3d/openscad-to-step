/**
 * OpenSCAD evaluation result (node tree, tree.ts) → build123d dialect (model.py). No variables, no scopes — every
 * dimension is a known number at translation time.
 * **The source of truth is the .scad; model.py is a derived product** (deletable, rebuildable, never hand-edited).
 * Geometric semantics live only here:
 *
 *  - `$fn` does not facet: a circle is a **true circle**; only `$fn <= 12` is treated as a real polygon / prism /
 *    polyhedron.
 *    Consequence: for the same source, the volume here is a few thousandths larger than OpenSCAD's. The differential
 *    tests set their tolerance accordingly.
 *  - `hull()` / `minkowski()`: engine operators; exact families first, otherwise facets plus a `hull-faceted` /
 *    `minkowski-faceted` warning — approximation is allowed, silence is not.
 *  - **Mesh fallback**: `import()` / `surface()` / `roof()` / `projection(cut = false)` / `offset(chamfer = true)` are
 *    sewn into a polyhedron from OpenSCAD's rendering.
 *    Write.scad's 5 DXF fonts are the exception: the engine ships them, exact.
 *  - `text()`: OpenSCAD does the layout, and the exported Béziers are filled into faces by the non-zero rule (fill.ts).
 *  - Empties known at translation time are simply dropped; empties known only at runtime use **None**, and
 *    RUNTIME_HELPERS are swapped in only on those operands.
 *
 * Numbers keep full precision; matrix decomposition absorbs only floating-point noise (affine.ts). Nodes with a position
 * start on their own line, and `sourceMap` translates kernel errors back to the .scad.
 */

import { parseCsg, CsgParseError } from "./csg-parse.ts";
import type { CsgNode, CsgValue, ScadRender, ScadSpan } from "./tree.ts";
import { affineOfRows, planAffine, type AffineStep } from "./affine.ts";
import { evenOdd, type Pt } from "./polygon2d.ts";
import { fillPieces } from "./fill.ts";
import { recognizeLoop, exactLoopStats, MIN_FULL_CIRCLE, type ArcPolicy, type ExactLoop } from "./arcs.ts";
import { gearLoop, type GearLoop } from "./gears.ts";
import { drawsThreads, plainThread, THREAD_SCOPED, type PlainThread } from "./threads.ts";
import {
  attachableShape,
  BOSL2_SCOPED,
  bosl2Segs,
  exactCuboid,
  exactCyl,
  exactPrismoid,
  exactSpheroid,
  isBosl2Call,
  isBosl2File,
  madeByBosl2,
  polyhedronOf,
  smoothIntent,
} from "./bosl2.ts";
import { MCAD } from "./libraries/mcad.js";
import { WRITE } from "./libraries/write.js";
import { WRITE_FONTS } from "./vendor/write-fonts-meta.ts";
import { BOOLEAN_GUARD_PRAGMA } from "./vendor/pragmas.ts";

/**
 * What a translation warning is about, for whoever shows it (the message stays the English sentence the CLI, the agent
 * and the logs read):
 * - `exact`: the STEP is MORE exact than the preview (a true circle for `$fn` facets, smooth gear teeth) — no problem,
 *   nothing to show an author;
 * - `step`: the STEP falls short of an exact model, or leaves something out (flat facets, no colour) — said when a STEP
 *   is exported, not over the preview;
 * - `model`: the model itself builds nothing there (a size ≤ 0, an empty child) — the preview shows it missing too.
 * `code` names the sentence, `call` the call it is about (`cuboid()`), for a translated text.
 */
export type ScadNote = {
  kind: "exact" | "step" | "model";
  code:
    | "exact"
    | "color" | "facets" | "thread-facets" | "thread-kept" | "twist" | "polyhedron-repaired" | "polyhedron-big"
    | "zero-size" | "empty-child" | "flat-matrix" | "no-area" | "no-faces" | "open-dropped" | "no-font" | "mixed-dims";
  call?: string;
};

/** A diagnostic, attached to a real position in the .scad: translation-time ones hang on the call that produced the node
 *  (tree.ts `at`); ones without a position hang on line 1 of the entry file.
 *  `note`: which kind of translation-time warning it is (ScadNote); OpenSCAD's own messages have none. */
export type ScadDiagnostic = { file: string; line: number; column: number; message: string; note?: ScadNote };

/** Multi-file input: path → source. Paths are `/`-separated, relative to the root the user dragged in. */
export type ScadFiles = Record<string, string>;
export { pickScadEntry } from "./project.ts";

export type ScadTranspileResult = {
  ok: boolean;
  /** The generated model.py. Empty string when ok=false. */
  python: string;
  errors: ScadDiagnostic[];
  /** Semantic deviations and ignored items (true circles instead of facets, color dropped…). May be non-empty when ok=true too. */
  warnings: ScadDiagnostic[];
  /**
   * model.py line number → the .scad call that produced that line (1-based). Every node with a position in model.py
   * starts on a new line, and the trailing comment holds its
   * `file:line:col`; kernel build errors report only `model.py:N` (cad-engine pyerrors.ts), and this maps them back to the .scad. Empty when there are no positions.
   */
  sourceMap: Record<number, ScadSpan>;
  /**
   * model.py line → the author's own call that line came from: the node's own position when it is in the project, else
   * the innermost call outside the bundled libraries that led into them (a top-level `cuboid(...)` for every line of
   * BOSL2's hull). What a face of the model traces back to (parts.ts, cloud's point-and-edit).
   */
  callers: Record<number, ScadSpan>;
  /**
   * The threads drawn as plain cylinders (`cosmeticThreads`, threads.ts), each with the call from the author's code
   * that made it — the build report lists them. Empty with the option off.
   */
  threads: ScadThread[];
  /** The tree draws a thread, option on or off (threads.ts `drawsThreads`): /scad offers the option only then. */
  threaded: boolean;
};

/** A thread drawn plain, for the build report: its spec and where the author asked for it. */
export type ScadThread = Omit<PlainThread, "profile"> & { call: string; at?: ScadSpan };

/** How the transpile reads the tree. `cosmeticThreads`: BOSL2's threads as plain cylinders (threads.ts), off by default. */
export type ScadTranspileOptions = { entry?: string; name?: string; cosmeticThreads?: boolean };

/** A located node's code starts with MARK + its index in `spans` + MARK_END; run() turns each into a new line. */
const MARK = "\u0001";
const MARK_END = "\u0002";

/** Only these may enter the import list (names that really exist in the dialect whitelist). */
const B123D_NAMES = new Set([
  "Align", "Axis", "Box", "Circle", "Compound", "Cone", "Cylinder", "twist_extrude", "Plane", "Polygon",
  "Pos", "Rectangle", "RegularPolygon", "Rot", "Sphere", "Text", "extrude", "mirror", "revolve", "make_face",
  "Kind", "Polyline", "Shell", "Solid", "Vertex", "loft", "offset", "scale", "section", "hull", "minkowski", "TextAlign",
  "Bezier", "Line", "Wire", "Face", "ThreePointArc", "fillet", "GeomType", "Spline",
]);

/** Python code for a piece of geometry, plus whether it can be None (empty) at **runtime**. */
type Geo = { code: string; maybe: boolean };
const solid = (code: string): Geo => ({ code, maybe: false });

/**
 * Runtime helpers: None means empty geometry (see the file header). Only the ones used are emitted; each short-circuits
 * on None,
 * and otherwise behaves exactly like the bare operator. `deps`: the dialect names it needs; `math` / `note`: need `import math` / cadkit's `_note`.
 */
const RUNTIME_HELPERS: Record<string, { code: string; deps?: string[]; helpers?: string[]; math?: boolean; note?: boolean }> = {
  // A running `total + part` re-fuses the whole growing total every step: O(n²), the first cause
  // of corpus timeouts (53916: 300 stadiums, the union alone > 100 s; 3.5 s as n-ary booleans).
  // Sixteen at a time, each group ONE boolean (`first + Compound(rest)` is a single fuse with the
  // rest as tools), groups of groups until one is left — exact, and bounded per boolean.
  _union: {
    deps: ["Compound"],
    code: [
      "def _union(parts):",
      '    """OpenSCAD unions a group\'s children implicitly; None (empty) children are skipped."""',
      "    live = [part for part in parts if part is not None]",
      "    if not live:",
      "        return None",
      "    while len(live) > 1:",
      "        live = [g[0] + Compound(g[1:]) if len(g) > 1 else g[0] for g in (live[k:k + 16] for k in range(0, len(live), 16))]",
      "    return live[0]",
    ].join("\n"),
  },
  // difference() is the first child minus the union of the rest: one cut with all of them as tools
  _diff: {
    deps: ["Compound"],
    code: [
      "def _diff(base, tools):",
      "    if base is None:",
      "        return None",
      "    live = [tool for tool in tools if tool is not None]",
      "    if not live:",
      "        return base",
      "    return base - (live[0] if len(live) == 1 else Compound(live))",
    ].join("\n"),
  },
  _inter: {
    code: [
      "def _inter(parts):",
      "    total = None",
      "    for part in parts:",
      "        if part is None:",
      "            return None",
      "        total = part if total is None else total & part",
      "    return total",
    ].join("\n"),
  },
  // hull() / minkowski() of children that all came out empty return an EMPTY shape, not None;
  // OpenSCAD's empty flows on silently through difference/translate/union, so turn it into the None
  // every helper here already handles (corpus 193941, 1019136, 1363149 raised "cannot cut from an empty shape").
  // Truth, not `.wrapped`: bd 0.13 asserts on an empty shape's wrapped (`__bool__` is `_wrapped is not None`);
  // the engine follows since 10-20 and 714444, 2627327, 3350495, 4898403 died here with a bare AssertionError
  _nz: { code: "def _nz(shape):\n    return shape if shape else None" },
  _move: { code: "def _move(loc, shape):\n    return None if shape is None else loc * shape" },
  _mirror: { deps: ["mirror"], code: "def _mirror(shape, plane):\n    return None if shape is None else mirror(shape, about=plane)" },
  // A 2D mirror(). OpenSCAD's 2D has no up or down; build123d's has: a bare Face mirrored turns over (its normal
  // follows the reflection; a Sketch's faces, inside their compound, keep theirs), and a face turned over joins no
  // face up — their union is two faces side by side, and an offset() of it shrank each on its own (5353030: a
  // mirrored hull() foot, 280 mm² lost along its seam with the body). Every face back up +Z, as every other 2D
  // shape here faces (polygon2d: each loop counter-clockwise).
  _mirror_flat: {
    deps: ["Compound", "mirror"],
    code: [
      "def _mirror_flat(shape, plane):",
      "    if shape is None:",
      "        return None",
      "    out = mirror(shape, about=plane)",
      "    faces = out.faces()",
      "    if all(face.normal_at().Z > 0 for face in faces):",
      "        return out",
      "    return Compound([face if face.normal_at().Z > 0 else -face for face in faces])",
    ].join("\n"),
  },
  _extrude: { deps: ["extrude"], code: "def _extrude(profile, amount):\n    return None if profile is None else extrude(profile, amount, dir=(0, 0, 1))" },
  // rotate_extrude() of a profile on both sides of the axis: OpenSCAD reports an ERROR and renders
  // nothing for it — the rest of the model still renders (oracle-checked). The dialect's revolve
  // refuses such a profile outright, which failed the whole build (corpus 330253); here it is
  // OpenSCAD's empty, with the error said as a build warning.
  _revolve: {
    deps: ["revolve", "Plane", "Axis"],
    note: true,
    code: [
      "def _revolve(profile, arc):",
      "    if profile is None:",
      "        return None",
      "    b = profile.bounding_box()",
      "    tol = 1e-6 * max(1.0, b.max.X - b.min.X)",
      "    if b.min.X < -tol and b.max.X > tol:",
      "        _note(\"rotate-extrude-both-sides\", \"rotate_extrude(): the profile lies on both sides of the axis (x from \" + str(round(b.min.X, 3)) + \" to \" + str(round(b.max.X, 3)) + \"). OpenSCAD reports this as an error and renders nothing for it; so does this build. Keep the profile on one side of the Y axis.\")",
      "        return None",
      "    return revolve(Plane.XZ * profile, axis=Axis.Z, revolution_arc=arc)",
    ].join("\n"),
  },
  // rotate_extrude($fn 3..12): OpenSCAD's facets, on purpose (the same reading as a $fn <= 12 cylinder).
  // One facet, with its bisector on +X and half-angle h, is exactly the points (X, Y, z) with (X / cos h, z)
  // in the profile and |Y| <= X*tan h: the profile squeezed by cos h along x, stood up, run through Y both
  // ways, and cut down to that wedge. Every facet is that piece turned. A loft between turned copies of the
  // profile would say the same, but the kernel refuses it wherever the profile touches the axis.
  _revolve_facets: {
    deps: ["Plane", "Pos", "Rot", "Polygon", "extrude", "scale"],
    helpers: ["_union"],
    math: true,
    note: true,
    code: [
      "def _revolve_facets(profile, arc, start, n):",
      "    if profile is None:",
      "        return None",
      "    b = profile.bounding_box()",
      "    tol = 1e-6 * max(1.0, b.max.X - b.min.X)",
      "    if b.min.X < -tol and b.max.X > tol:",
      "        _note(\"rotate-extrude-both-sides\", \"rotate_extrude(): the profile lies on both sides of the axis (x from \" + str(round(b.min.X, 3)) + \" to \" + str(round(b.max.X, 3)) + \"). OpenSCAD reports this as an error and renders nothing for it; so does this build. Keep the profile on one side of the Y axis.\")",
      "        return None",
      "    side = -1 if b.max.X <= tol else 1",
      "    step = arc / n",
      "    h = math.radians(abs(step) / 2)",
      "    R = max(abs(b.min.X), abs(b.max.X))",
      "    flat = scale(profile, [side * math.cos(h), 1, 1])",
      "    slab = extrude(Plane.XZ * flat, R * math.sin(h) + 1, both=True)",
      "    reach = R + 1",
      "    wedge = Pos(0, 0, b.min.Y - 1) * extrude(Polygon([(0, 0), (reach, -reach * math.tan(h)), (reach, reach * math.tan(h))]), b.max.Y - b.min.Y + 2)",
      "    piece = slab & wedge",
      "    # a profile on the -x side reaches out the opposite way: its facets are turned half a turn",
      "    turn = 180 if side < 0 else 0",
      "    return _union([Rot(0, 0, start + turn + (k + 0.5) * step) * piece for k in range(n)])",
    ].join("\n"),
  },
  // offset() of a shape that may be empty. OpenSCAD offsets its children as one region and gets one back; build123d's
  // offset grows each face on its own and leaves the grown faces as they are, overlapping where they meet — two solids
  // over the same space once extruded, which no boolean takes (745296: letters grown 4.48 mm into each other, its
  // union 36% short). Fused back into one region; only growing can make faces meet.
  _offset: {
    deps: ["offset"],
    helpers: ["_union"],
    code: [
      "def _offset(shape, amount, kind):",
      "    if shape is None:",
      "        return None",
      "    grown = offset(shape, amount, kind=kind)",
      "    faces = grown.faces()",
      "    return _union(list(faces)) if amount > 0 and len(faces) > 1 else grown",
    ].join("\n"),
  },
  // scale() of a shape that may be empty, or by [sx, sy, 0]: a 0 factor is OpenSCAD's empty for a solid
  // (it flattens to no volume), while a 2D profile ignores z and is left alone (oracle)
  _scale: {
    deps: ["scale"],
    note: true,
    code: [
      "def _scale(shape, f):",
      "    if shape is None:",
      "        return None",
      "    if isinstance(f, list) and f[2] == 0:",
      "        if shape.bounding_box().size.Z >= 1e-9:",
      "            _note(\"scale-zero\", \"scale(\" + str(f) + \"): a 0 factor flattens the object to nothing; OpenSCAD removes it, and so does this build.\")",
      "            return None",
      "        f = [f[0], f[1], 1]",
      "    return scale(shape, f)",
    ].join("\n"),
  },
  _section: { deps: ["section", "Plane"], code: "def _section(shape):\n    return None if shape is None else section(shape, section_by=Plane.XY)" },
  // polygon(): OpenSCAD fills every path even-odd (polygon2d.ts). Worked out at translate time into simple
  // regions — an outline minus the loops directly inside it —, fused here. "Outline minus hole faces" rather
  // than `make_face(outer, inners)`: OCCT tells holes from material by winding, which OpenSCAD does not ask for.
  _polygon_regions: {
    deps: ["Polyline", "make_face", "Compound"],
    helpers: ["_union"],
    code: [
      "def _polygon_regions(regions):",
      "    faces = []",
      "    for outer, holes in regions:",
      "        face = make_face(Polyline(outer, close=True))",
      "        cuts = [make_face(Polyline(hole, close=True)) for hole in holes]",
      "        if cuts:",
      "            face = face - (cuts[0] if len(cuts) == 1 else Compound(cuts))",
      "        faces.append(face)",
      "    return _union(faces)",
    ].join("\n"),
  },
  // polygon() whose loops cross one another: the even-odd fill is their symmetric difference, one at a time
  _polygon_xor: {
    deps: ["Polyline", "make_face"],
    code: [
      "def _polygon_xor(loops):",
      "    face = None",
      "    for loop in loops:",
      "        f = make_face(Polyline(loop, close=True))",
      "        face = f if face is None else (face - f) + (f - face)",
      "    return face",
    ].join("\n"),
  },
  // Closed contours of lines and quadratic / cubic Béziers, filled nonzero (fill.ts): text()'s glyphs, exact, and the
  // 2D outlines of OpenSCAD's render (the mesh fallback). Each contour comes counter-clockwise (a +Z face, so
  // extrude() rises off the plane); a piece is a filled contour minus the contours directly inside it; the pieces
  // are fused.
  _fill: {
    deps: ["Bezier", "Line", "Wire", "make_face", "Compound"],
    helpers: ["_union"],
    code: [
      "def _fill(contours, pieces):",
      "    def face(contour):",
      "        edges = []",
      "        at = contour[0]",
      "        for seg in contour[1:]:",
      "            end = (seg[-2], seg[-1])",
      "            if len(seg) == 2:",
      "                edges.append(Line(at, end))",
      "            elif len(seg) == 4:",
      "                edges.append(Bezier(at, (seg[0], seg[1]), end))",
      "            else:",
      "                edges.append(Bezier(at, (seg[0], seg[1]), (seg[2], seg[3]), end))",
      "            at = end",
      "        return make_face(Wire(edges))",
      "    faces = [face(contour) for contour in contours]",
      "    return _union([faces[i] - Compound([faces[k] for k in holes]) if holes else faces[i] for i, holes in pieces])",
    ].join("\n"),
  },
  // polyhedron(points, faces) — a bag of polygons sewn into a solid (K_Sew/K_MakeSolid).
  // A face OpenSCAD would triangulate because it is not planar is triangulated here too, as a
  // fan, but only after the single-face attempt fails: keeping planar faces WHOLE is what makes
  // the STEP readable. `Face(wire)`, not `make_face`: make_face turns a down-facing face up (a 2D
  // sketch's rule, as build123d's), and a solid's bottom has to keep facing down.
  // Faces that do not sew into ONE solid as written get what OpenSCAD's mesh repair does before a
  // boolean, said as a build note: faces with no area dropped (zero-area slivers in STLs), a face and
  // its exact reverse cancelled (back-to-back walls), and the rest split where only a vertex or an
  // edge of more than two faces joins them — two cubes touching at a corner are two closed pieces,
  // each a solid, unioned (OpenSCAD's tests/data/scad 3D/misc, bugs/issue1580*, issue945*, issue802:
  // 13 files that failed the whole build, now OpenSCAD's volume exactly). Still open after that is an
  // error, the piece's own — where it does not close — not the first attempt's, which may be about a
  // face the repair dropped: a surface with a hole is not a solid in either program.
  _polyhedron: {
    deps: ["Polyline", "Shell", "Solid", "Face"],
    note: true,
    code: [
      "def _polyhedron(points, faces):",
      "    def sew(fs):",
      "        tris = []",
      "        for f in fs:",
      "            pts = [points[i] for i in f]",
      "            if len(pts) < 3:",
      "                raise ValueError(\"polyhedron(): a face needs at least three points, got \" + str(len(pts)))",
      "            try:",
      "                tris.append(Face(Polyline(pts, close=True)))",
      "            except Exception:",
      "                for k in range(1, len(pts) - 1):",
      "                    tris.append(Face(Polyline([pts[0], pts[k], pts[k + 1]], close=True)))",
      "        return Solid(Shell(tris))",
      "    try:",
      "        return sew(faces)",
      "    except Exception as err:",
      "        first = err",
      "    def area(f):",
      "        a = points[f[0]]",
      "        n = [0.0, 0.0, 0.0]",
      "        for k in range(1, len(f) - 1):",
      "            u = [points[f[k]][j] - a[j] for j in range(3)]",
      "            v = [points[f[k + 1]][j] - a[j] for j in range(3)]",
      "            n = [n[0] + u[1] * v[2] - u[2] * v[1], n[1] + u[2] * v[0] - u[0] * v[2], n[2] + u[0] * v[1] - u[1] * v[0]]",
      "        return (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5",
      "    kept = []",
      "    for f in faces:",
      "        g = [i for k, i in enumerate(f) if k == 0 or i != f[k - 1]]",
      "        if len(g) > 1 and g[0] == g[-1]:",
      "            g.pop()",
      "        if len(set(g)) >= 3 and area(g) > 1e-12:",
      "            kept.append(g)",
      "    flat = len(faces) - len(kept)",
      "    def cycle(f):",
      "        k = f.index(min(f))",
      "        return tuple(f[k:] + f[:k])",
      "    alive = {}",
      "    for n, f in enumerate(kept):",
      "        alive.setdefault(cycle(f), []).append(n)",
      "    dead = set()",
      "    for n, f in enumerate(kept):",
      "        if n in dead:",
      "            continue",
      "        twin = [m for m in alive.get(cycle(f[::-1]), []) if m != n and m not in dead]",
      "        if twin:",
      "            dead.update((n, twin[0]))",
      "    kept = [f for n, f in enumerate(kept) if n not in dead]",
      "    if not kept:",
      "        raise first",
      "    users = {}",
      "    for n, f in enumerate(kept):",
      "        for k in range(len(f)):",
      "            users.setdefault(frozenset((f[k], f[(k + 1) % len(f)])), []).append(n)",
      "    root = list(range(len(kept)))",
      "    def find(n):",
      "        while root[n] != n:",
      "            root[n] = root[root[n]]",
      "            n = root[n]",
      "        return n",
      "    for us in users.values():",
      "        if len(us) == 2:",
      "            root[find(us[0])] = find(us[1])",
      "    pieces = {}",
      "    for n, f in enumerate(kept):",
      "        pieces.setdefault(find(n), []).append(f)",
      "    solids = [sew(fs) for fs in pieces.values()]",
      "    _note(\"polyhedron-repaired\", \"polyhedron(): its faces do not close into one solid as written; built the way OpenSCAD repairs a mesh — \" + str(flat) + \" face(s) with no area dropped, \" + str(len(dead) // 2) + \" pair(s) of back-to-back faces cancelled, \" + str(len(solids)) + \" closed piece(s) joined where they only touch.\")",
      "    out = solids[0]",
      "    for piece in solids[1:]:",
      "        out = out + piece",
      "    return out",
    ].join("\n"),
  },
  // offset() with OpenSCAD's own result beside it (export_fgjson renders every offset): the exact offset first;
  // where OCCT's MakeOffset gives up — it does on outlines Clipper takes (31 Thingiverse files, all of which
  // OpenSCAD renders) — OpenSCAD's polygons, straight edges, said as a build warning. The fallback is built only
  // when it is used.
  _offset_or: {
    helpers: ["_offset"],
    note: true,
    code: [
      "def _offset_or(shape, amount, kind, fallback, edges):",
      "    if shape is None:",
      "        return None",
      "    try:",
      "        return _offset(shape, amount, kind)",
      "    except Exception:",
      "        _note(\"offset-faceted\", \"offset(): the exact offset gave up on this outline; built from OpenSCAD's own offset instead (\" + str(edges) + \" straight edges, not exact curves).\")",
      "        return fallback()",
    ].join("\n"),
  },
  // A polyhedron whose only use is to give hull() its points (CsgToModel `hullPoints`): the hull of
  // its points, never sewn. Exact there — hull(A, B) is the hull of A's points and B's — and it
  // takes what OpenSCAD's hull takes: corpus 1291337 hulls "tetrahedra" whose faces repeat an index,
  // 1707429 a soup of loose triangles; sewn into solids, both failed the whole build. A flat one has
  // no hull of its own (4500340: 992 sheets), so its points go to the outer hull as they are.
  _polyhedron_hull: {
    deps: ["Compound", "Vertex", "hull"],
    code: [
      "def _polyhedron_hull(points):",
      "    cloud = Compound([Vertex(*p) for p in points])",
      "    o = points[0]",
      "    d = [[p[k] - o[k] for k in range(3)] for p in points[1:]]",
      "    u = max(d, key=lambda v: v[0] * v[0] + v[1] * v[1] + v[2] * v[2])",
      "    n = max([[u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]] for v in d], key=lambda c: c[0] * c[0] + c[1] * c[1] + c[2] * c[2])",
      "    size = max(abs(c) for v in d for c in v) or 1",
      "    if max(abs(n[0] * v[0] + n[1] * v[1] + n[2] * v[2]) for v in d) <= 1e-9 * size ** 3:",
      "        return cloud  # flat: no hull of its own; the outer hull takes the points",
      "    return hull([cloud])",
    ].join("\n"),
  },
  // A closed 2D loop with exact arcs (arcs.ts): `[cx, cy, r]` is a whole circle; otherwise a list of vertices, each
  // `[x, y]` (a straight edge to the next one) or `[x, y, mx, my]` (the arc through (mx, my) to the next one). A whole
  // circle's wire is two half arcs, so a loft pairs it edge for edge with another circle.
  _arc_wire: {
    deps: ["Line", "ThreePointArc", "Wire"],
    code: [
      "def _arc_wire(loop):",
      "    if not isinstance(loop[0], list):",
      "        cx, cy, r = loop[0], loop[1], loop[2]",
      "        return Wire([ThreePointArc((cx + r, cy), (cx, cy + r), (cx - r, cy)), ThreePointArc((cx - r, cy), (cx, cy - r), (cx + r, cy))])",
      "    edges = []",
      "    n = len(loop)",
      "    for i in range(n):",
      "        a = loop[i]",
      "        b = loop[(i + 1) % n]",
      "        if len(a) == 4:",
      "            edges.append(ThreePointArc((a[0], a[1]), (a[2], a[3]), (b[0], b[1])))",
      "        else:",
      "            edges.append(Line((a[0], a[1]), (b[0], b[1])))",
      "    return Wire(edges)",
    ].join("\n"),
  },
  // A BOSL2 gear's loops (gears.ts): `_arc_wire`'s, plus its flanks — `[x, y, [[px, py], …]]` is the interpolating
  // spline through those points to the next vertex, `[x, y, [[px, py], …], [tx, ty], [ux, uy]]` the same with its end
  // tangents. Unit vectors, taken as they are (`tangent_scalars`): the interpolation is by chord length, so a unit
  // tangent is the curve's own speed, where OCCT's rescaling of them put a cusp into a flank (curvature 4*10⁵ by the tip).
  _gear_regions: {
    deps: ["Line", "ThreePointArc", "Spline", "Wire", "Compound", "make_face"],
    helpers: ["_arc_wire", "_union"],
    code: [
      "def _gear_wire(loop):",
      "    if not isinstance(loop[0], list):",
      "        return _arc_wire(loop)",
      "    edges = []",
      "    n = len(loop)",
      "    for i in range(n):",
      "        a = loop[i]",
      "        b = loop[(i + 1) % n]",
      "        if len(a) == 4:",
      "            edges.append(ThreePointArc((a[0], a[1]), (a[2], a[3]), (b[0], b[1])))",
      "        elif len(a) == 3 or len(a) == 5:",
      "            pts = [(a[0], a[1])] + [(p[0], p[1]) for p in a[2]] + [(b[0], b[1])]",
      "            if len(a) == 5:",
      "                edges.append(Spline(pts, tangents=[(a[3][0], a[3][1]), (a[4][0], a[4][1])], tangent_scalars=[1, 1]))",
      "            else:",
      "                edges.append(Spline(pts))",
      "        else:",
      "            edges.append(Line((a[0], a[1]), (b[0], b[1])))",
      "    return Wire(edges)",
      "",
      "def _gear_regions(regions):",
      "    faces = []",
      "    for outer, holes in regions:",
      "        face = make_face(_gear_wire(outer))",
      "        cuts = [make_face(_gear_wire(hole)) for hole in holes]",
      "        if cuts:",
      "            face = face - (cuts[0] if len(cuts) == 1 else Compound(cuts))",
      "        faces.append(face)",
      "    return _union(faces)",
    ].join("\n"),
  },
  _arc_face: {
    deps: ["Pos", "Circle", "make_face"],
    helpers: ["_arc_wire"],
    code: [
      "def _arc_face(loop):",
      "    if not isinstance(loop[0], list):",
      "        return Pos(loop[0], loop[1], 0) * Circle(loop[2])",
      "    return make_face(_arc_wire(loop))",
    ].join("\n"),
  },
  // polygon() with arcs recognised (arcs.ts): the regions of polygon2d.ts, each loop exact
  _arc_regions: {
    deps: ["Compound"],
    helpers: ["_arc_face", "_union"],
    code: [
      "def _arc_regions(regions):",
      "    faces = []",
      "    for outer, holes in regions:",
      "        face = _arc_face(outer)",
      "        cuts = [_arc_face(hole) for hole in holes]",
      "        if cuts:",
      "            face = face - (cuts[0] if len(cuts) == 1 else Compound(cuts))",
      "        faces.append(face)",
      "    return _union(faces)",
    ].join("\n"),
  },
  // BOSL2 cyl(rounding= | chamfer=) exactly (bosl2.ts exactCyl): its (r, z) profile, closed along the axis, revolved
  _revolve_loop: {
    deps: ["revolve", "Plane", "Axis"],
    helpers: ["_arc_face"],
    code: "def _revolve_loop(loop):\n    return revolve(Plane.XZ * _arc_face(loop), axis=Axis.Z)",
  },
  // BOSL2 prismoid(rounding=) exactly (bosl2.ts exactPrismoid): the ruled loft between its two rounded rings. A ruled
  // loft makes every side a B-spline, the flat ones too: a side bounded by four straight edges is rebuilt as the plane
  // it is, and the faces sewn back into the solid — the corners stay the (rational, exact) ruled surfaces between arcs.
  _loft_rings: {
    deps: ["Pos", "loft", "GeomType", "Shell", "Solid", "Face", "Polyline"],
    helpers: ["_arc_wire"],
    code: [
      "def _loft_rings(z0, loop0, z1, loop1):",
      "    lofted = loft([Pos(0, 0, z0) * _arc_wire(loop0), Pos(0, 0, z1) * _arc_wire(loop1)], ruled=True)",
      "    if not isinstance(loop0[0], list):",
      "        return lofted",
      "    n = len(loop0)",
      "    sides = []",
      "    for i in range(n):",
      "        if len(loop0[i]) == 2:",
      "            a0, b0, a1, b1 = loop0[i], loop0[(i + 1) % n], loop1[i], loop1[(i + 1) % n]",
      "            sides.append(Face(Polyline([(a0[0], a0[1], z0), (b0[0], b0[1], z0), (b1[0], b1[1], z1), (a1[0], a1[1], z1)], close=True)))",
      "    if not sides:",
      "        return lofted",
      "    def straight(e):",
      "        # a ruled loft's rulings are straight B-splines, not lines; a box carries the edge's tolerance",
      "        b = e.bounding_box()",
      "        return abs(e.length - (b.size.X ** 2 + b.size.Y ** 2 + b.size.Z ** 2) ** 0.5) <= 1e-5 * max(1.0, e.length)",
      "    try:",
      "        keep = [f for f in lofted.faces() if f.geom_type == GeomType.PLANE or not all(straight(e) for e in f.edges())]",
      "        if len(keep) + len(sides) != len(lofted.faces()):",
      "            return lofted",
      "        return Solid(Shell(keep + sides))",
      "    except Exception:",
      "        return lofted",
    ].join("\n"),
  },
  // BOSL2 cuboid(rounding=, edges=…) exactly (bosl2.ts exactCuboid): a centred box with the edges whose midpoints
  // are `picks` filleted
  _box_fillet: {
    deps: ["Box", "fillet"],
    code: [
      "def _box_fillet(sx, sy, sz, r, picks):",
      "    box = Box(sx, sy, sz)",
      "    tol = 1e-6 * max(sx, sy, sz)",
      "    chosen = []",
      "    for e in box.edges():",
      "        b = e.bounding_box()",
      "        c = [(b.min.X + b.max.X) / 2, (b.min.Y + b.max.Y) / 2, (b.min.Z + b.max.Z) / 2]",
      "        for p in picks:",
      "            if abs(c[0] - p[0]) <= tol and abs(c[1] - p[1]) <= tol and abs(c[2] - p[2]) <= tol:",
      "                chosen.append(e)",
      "    if len(chosen) != len(picks):",
      "        raise ValueError(\"found \" + str(len(chosen)) + \" of the \" + str(len(picks)) + \" edges to round\")",
      "    return fillet(chosen, radius=r)",
    ].join("\n"),
  },
  // An exact construction in place of what OpenSCAD built from facets (bosl2.ts), compared with OpenSCAD's own facets
  // of the same subtree before it is used: the exact one contains the faceted one (the facets are inscribed), so its
  // volume is larger by no more than `deficit`, its box the same up to `sag`, and the first moment of the difference
  // no more than its volume times the half size. Once per key — the same call with the same arguments reuses the shape.
  _exact_or: {
    note: true,
    code: [
      "_EXACT = {}",
      "",
      "def _exact_or(key, exact, faceted, what, deficit, sag):",
      "    if key in _EXACT:",
      "        return _EXACT[key]",
      "    ref = faceted()",
      "    shape = None",
      "    why = None",
      "    try:",
      "        shape = exact()",
      "    except Exception as err:",
      "        why = \"the exact construction failed (\" + str(err) + \")\"",
      "    if shape is not None and ref is not None:",
      "        rb = ref.bounding_box()",
      "        eb = shape.bounding_box()",
      "        half = [(rb.max.X - rb.min.X) / 2, (rb.max.Y - rb.min.Y) / 2, (rb.max.Z - rb.min.Z) / 2]",
      "        size = 2 * max(half)",
      "        tol = 1e-6 * size ** 3",
      "        dv = shape.volume - ref.volume",
      "        if dv < -tol or dv > deficit * 1.05 + tol:",
      "            why = \"its volume differs from OpenSCAD's facets by \" + str(round(dv, 6)) + \" (allowed 0..\" + str(round(deficit * 1.05, 6)) + \")\"",
      "        elif max(abs(eb.min.X - rb.min.X), abs(eb.min.Y - rb.min.Y), abs(eb.min.Z - rb.min.Z), abs(eb.max.X - rb.max.X), abs(eb.max.Y - rb.max.Y), abs(eb.max.Z - rb.max.Z)) > sag + 1e-6 * size:",
      "            why = \"its bounding box differs from OpenSCAD's facets\"",
      "        else:",
      "            ce = shape.center()",
      "            cr = ref.center()",
      "            mid = [(rb.min.X + rb.max.X) / 2, (rb.min.Y + rb.max.Y) / 2, (rb.min.Z + rb.max.Z) / 2]",
      "            moment = [shape.volume * (ce.X - mid[0]) - ref.volume * (cr.X - mid[0]), shape.volume * (ce.Y - mid[1]) - ref.volume * (cr.Y - mid[1]), shape.volume * (ce.Z - mid[2]) - ref.volume * (cr.Z - mid[2])]",
      "            for k in range(3):",
      "                if abs(moment[k]) > (max(dv, 0) + tol) * half[k] + tol:",
      "                    why = \"its centre of mass is not where OpenSCAD's facets put it\"",
      "    if why is not None:",
      "        _note(\"bosl2-faceted\", what + \": kept OpenSCAD's facets — \" + why)",
      "        shape = ref",
      "    _EXACT[key] = shape",
      "    return shape",
    ].join("\n"),

  },
  // The same check for a 2D piece (a BOSL2 gear's outline, gears.ts): a curve through every point of the polygon is
  // neither inside nor outside it, so the area may move either way — by no more than the band the arcs and splines
  // allow (`lo`..`hi`, the face's area minus the polygon's); the box by no more than `sag`. The face's area is right
  // to the band's needs: the kernel takes a face bounded by splines of several spans span by span (OCCT's default rule
  // read a ring gear's cutter 0.05% small, more than the whole facet error being checked).
  _exact_area_or: {
    note: true,
    code: [
      "_EXACT_AREA = {}",
      "",
      "def _exact_area_or(key, exact, faceted, what, lo, hi, sag):",
      "    if key in _EXACT_AREA:",
      "        return _EXACT_AREA[key]",
      "    ref = faceted()",
      "    shape = None",
      "    why = None",
      "    try:",
      "        shape = exact()",
      "    except Exception as err:",
      "        why = \"the exact construction failed (\" + str(err) + \")\"",
      "    if shape is not None and ref is not None:",
      "        rb = ref.bounding_box()",
      "        eb = shape.bounding_box()",
      "        size = max(rb.max.X - rb.min.X, rb.max.Y - rb.min.Y)",
      "        tol = 1e-9 * size ** 2",
      "        da = shape.area - ref.area",
      "        if da < lo - tol or da > hi + tol:",
      "            why = \"its area differs from OpenSCAD's facets by \" + str(round(da, 6)) + \" (allowed \" + str(round(lo, 6)) + \"..\" + str(round(hi, 6)) + \")\"",
      "        elif max(abs(eb.min.X - rb.min.X), abs(eb.min.Y - rb.min.Y), abs(eb.max.X - rb.max.X), abs(eb.max.Y - rb.max.Y)) > sag + 1e-6 * size:",
      "            why = \"its bounding box differs from OpenSCAD's facets\"",
      "    if why is not None:",
      "        _note(\"bosl2-faceted\", what + \": kept OpenSCAD's facets — \" + why)",
      "        shape = ref",
      "    _EXACT_AREA[key] = shape",
      "    return shape",
    ].join("\n"),
  },
  // resize(newsize, auto): OpenSCAD rescales the built shape to the given bbox. A 0 component means
  // "leave this axis alone", unless auto is set for it — then it takes the factor of the axis with the
  // LARGEST new size, the first on a tie (OpenSCAD's `maxdim`; oracle: resize([0, 20, 40], auto = true)
  // scales x by z's factor, resize([0, 40, 20], auto = true) by y's).
  _resize: {
    deps: ["scale"],
    code: [
      "def _resize(shape, newsize, auto):",
      "    if shape is None:",
      "        return None",
      "    box = shape.bounding_box()",
      "    cur = [box.size.X, box.size.Y, box.size.Z]",
      "    want = [newsize[i] if i < len(newsize) else 0 for i in range(3)]",
      "    factors = [1.0, 1.0, 1.0]",
      "    ref = None",
      "    top = 0",
      "    for i in range(3):",
      "        if want[i] > 0 and cur[i] > 1e-12:",
      "            factors[i] = want[i] / cur[i]",
      "            if want[i] > top:",
      "                top = want[i]",
      "                ref = factors[i]",
      "    for i in range(3):",
      "        if (want[i] <= 0 or cur[i] <= 1e-12) and ref is not None and i < len(auto) and auto[i]:",
      "            factors[i] = ref",
      "    return scale(shape, factors)",
    ].join("\n"),
  },
  // linear_extrude(twist=/scale=). `scale` alone is a ruled loft between two similar sections and is
  // EXACT. `twist` has no exact BREP form at all — OpenSCAD itself builds it from `slices` flat rings,
  // so the same slicing is reproduced here rather than invented: matching the oracle's own
  // discretisation is the only honest reading of "correct" for this operator.
  // A loft takes each section's OUTER wire only (build123d's own rule), so a profile with holes or
  // several islands is lofted loop by loop: every face's outer wire, minus its holes lofted the same
  // way (a tapered washer used to come out as a solid frustum, 24% over).
  _twist_extrude: {
    deps: ["twist_extrude", "Pos", "Rot", "Vertex", "loft", "scale", "Compound"],
    helpers: ["_union"],
    code: [
      "def _taper_loop(loop, height, twist, sc, slices):",
      "    sections = []",
      "    for k in range(slices + 1):",
      "        t = k / float(slices)",
      "        fx = 1.0 + (sc[0] - 1.0) * t",
      "        fy = 1.0 + (sc[1] - 1.0) * t",
      "        if abs(fx) < 1e-12 and abs(fy) < 1e-12:",
      "            # scale=0 tapers to a POINT (the manual's own linear_extrude example is a pyramid).",
      "            # A zero-size section is not a section; loft takes a Vertex for exactly this.",
      "            sections.append(Vertex(0, 0, height * t))",
      "            continue",
      "        s = loop",
      "        if abs(fx - fy) < 1e-12:",
      "            # in-plane uniform: a similarity, so circles stay circles (the profile sits on z=0,",
      "            # so scaling z with it moves nothing)",
      "            if abs(fx - 1.0) > 1e-12:",
      "                s = scale(s, fx)",
      "        else:",
      "            s = scale(s, [fx, fy, 1.0])",
      "        if abs(twist) > 1e-12:",
      "            s = Rot(0, 0, -twist * t) * s",
      "        sections.append(Pos(0, 0, height * t) * s)",
      "    return loft(sections, ruled=True)",
      "",
      "def _twist_extrude(profile, height, twist, sc, slices):",
      "    if profile is None or not profile.faces():",
      "        return None",
      "    if abs(twist) > 1e-12 and sc[0] > 0 and sc[1] > 0:",
      "        # a twist: the polyhedron OpenSCAD builds, straight from the slice rings (no loft)",
      "        return twist_extrude(profile, height, twist, sc, slices)",
      "    parts = []",
      "    for face in profile.faces():",
      "        body = _taper_loop(face.outer_wire(), height, twist, sc, slices)",
      "        holes = [_taper_loop(wire, height, twist, sc, slices) for wire in face.inner_wires()]",
      "        if holes:",
      "            body = body - (holes[0] if len(holes) == 1 else Compound(holes))",
      "        parts.append(body)",
      "    return _union(parts)",
    ].join("\n"),
  },
  // cylinder(r1, r2, $fn<=12): a pyramid / frustum, the same "this is a prism, not a circle" reading
  // the plain cylinder gets. Sewn from its planar faces (as OpenSCAD builds it) rather than lofted:
  // a ruled loft to a point leaves BSpline edges, which hull()'s straight-edge check then refuses.
  _cone_poly: {
    math: true,
    helpers: ["_polyhedron"],
    code: [
      "def _cone_poly(r1, r2, h, n):",
      "    def ring(r, z):",
      "        return [(r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), z) for k in range(n)]",
      "    if r2 == 0:",
      "        pts = ring(r1, 0) + [(0, 0, h)]",
      "        faces = [list(range(n))] + [[k, (k + 1) % n, n] for k in range(n)]",
      "    elif r1 == 0:",
      "        pts = [(0, 0, 0)] + ring(r2, h)",
      "        faces = [list(range(1, n + 1))] + [[0, 1 + (k + 1) % n, 1 + k] for k in range(n)]",
      "    else:",
      "        pts = ring(r1, 0) + ring(r2, h)",
      "        faces = [list(range(n)), list(range(n, 2 * n))] + [[k, (k + 1) % n, n + (k + 1) % n, n + k] for k in range(n)]",
      "    return _polyhedron(pts, faces)",
    ].join("\n"),
  },
  // sphere() at $fn 3..12 is OpenSCAD's own polyhedron, on purpose (3563883's low-poly ship is
  // hulls of $fn = 6 spheres, 15% under a true sphere's volume): (n + 1) // 2 rings of n points at
  // polar angles (i + ½)*180° / rings, flat caps top and bottom — OpenSCAD's construction
  _sphere_poly: {
    math: true,
    helpers: ["_polyhedron"],
    code: [
      "def _sphere_poly(r, n):",
      "    rings = (n + 1) // 2",
      "    pts = []",
      "    for i in range(rings):",
      "        phi = math.pi * (i + 0.5) / rings",
      "        for j in range(n):",
      "            a = 2 * math.pi * j / n",
      "            pts.append((r * math.sin(phi) * math.cos(a), r * math.sin(phi) * math.sin(a), r * math.cos(phi)))",
      "    faces = [list(range(n))]",
      "    for i in range(rings - 1):",
      "        for j in range(n):",
      "            faces.append([i * n + j, i * n + (j + 1) % n, (i + 1) * n + (j + 1) % n, (i + 1) * n + j])",
      "    faces.append([(rings - 1) * n + j for j in range(n)])",
      "    return _polyhedron(pts, faces)",
    ].join("\n"),
  },
  // sphere(style = "octa") at $fn 3..12 (OpenSCAD 2026, SphereNode::createGeometryOcta, point for point): an
  // octahedron whose faces are cut into k² triangles, k = max(1, (n + 3) // 4); the equator and the xz / yz
  // meridians are circle()'s 4k points, each face's inner points where Bram Cohen's three great-circle arcs meet
  // (the three pairwise intersections averaged, back on the sphere). Rings around z, pole to pole; angles through
  // OpenSCAD's own sin/cos in degrees (exact at the axes), so the shared points are its bits.
  _sphere_octa: {
    math: true,
    helpers: ["_polyhedron"],
    code: [
      "def _sphere_octa(r, num_fragments):",
      "    def sind(x):",
      "        x = x - 360.0 * math.floor(x / 360.0) if not (0.0 <= x < 360.0) else x",
      "        oppose = x >= 180.0",
      "        if oppose:",
      "            x -= 180.0",
      "        if x > 90.0:",
      "            x = 180.0 - x",
      "        if x < 45.0:",
      "            v = 0.5 if x == 30.0 else math.sin(math.radians(x))",
      "        elif x == 45.0:",
      "            v = math.sqrt(0.5)",
      "        elif x == 60.0:",
      "            v = math.sqrt(0.75)",
      "        else:",
      "            v = math.cos(math.radians(90.0 - x))",
      "        return -v if oppose else v",
      "    def cosd(x):",
      "        x = x - 360.0 * math.floor(x / 360.0) if not (0.0 <= x < 360.0) else x",
      "        oppose = x >= 180.0",
      "        if oppose:",
      "            x -= 180.0",
      "        if x > 90.0:",
      "            x = 180.0 - x",
      "            oppose = not oppose",
      "        if x > 45.0:",
      "            v = 0.5 if x == 60.0 else math.sin(math.radians(90.0 - x))",
      "        elif x == 45.0:",
      "            v = math.sqrt(0.5)",
      "        elif x == 30.0:",
      "            v = math.sqrt(0.75)",
      "        else:",
      "            v = math.cos(math.radians(x))",
      "        return -v if oppose else v",
      "    def cross(a, b):",
      "        return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])",
      "    def unit(a):",
      "        l = math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])",
      "        return (a[0] / l, a[1] / l, a[2] / l)",
      "    def meet(a, b, c, d):",
      "        return unit(cross(cross(a, b), cross(c, d)))",
      "    n = max(1, (num_fragments + 3) // 4)",
      "    fragments = 4 * n",
      "    ct = [cosd((360.0 * m) / fragments) for m in range(n + 1)]",
      "    st = [sind((360.0 * m) / fragments) for m in range(n + 1)]",
      "    octant = [[None] * t for t in range(n)]",
      "    for t in range(2, n):",
      "        k = n - t",
      "        for s in range(1, t):",
      "            i, j = t - s, s",
      "            xz_k, yz_k = (ct[k], 0.0, st[k]), (0.0, ct[k], st[k])",
      "            xy_j, yz_j = (ct[j], st[j], 0.0), (0.0, ct[n - j], st[n - j])",
      "            xy_i, xz_i = (ct[n - i], st[n - i], 0.0), (ct[n - i], 0.0, st[n - i])",
      "            a, b, c = meet(xz_k, yz_k, xy_j, yz_j), meet(xz_k, yz_k, xy_i, xz_i), meet(xy_j, yz_j, xy_i, xz_i)",
      "            octant[t][s] = unit((a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]))",
      "    pts = []",
      "    start = []",
      "    for ring in range(2 * n + 1):",
      "        start.append(len(pts))",
      "        top = ring <= n",
      "        t = ring if top else 2 * n - ring",
      "        k = n - t",
      "        if t == 0:",
      "            pts.append((0.0, 0.0, r if top else -r))",
      "            continue",
      "        for q in range(4):",
      "            for s in range(t):",
      "                if t == n:",
      "                    phi = (360.0 * (q * n + s)) / fragments",
      "                    pts.append((r * cosd(phi), r * sind(phi), 0.0))",
      "                elif s == 0:",
      "                    idx = (k if q < 2 else 2 * n - k) if top else (4 * n - k if q < 2 else 2 * n + k)",
      "                    phi = (360.0 * idx) / fragments",
      "                    c, z = r * cosd(phi), r * sind(phi)",
      "                    pts.append((c, 0.0, z) if q % 2 == 0 else (0.0, c, z))",
      "                else:",
      "                    p = octant[t][s]",
      "                    z = p[2] if top else -p[2]",
      "                    pts.append(((r * p[0], r * p[1], r * z), (-r * p[1], r * p[0], r * z), (-r * p[0], -r * p[1], r * z), (r * p[1], -r * p[0], r * z))[q])",
      "    faces = []",
      "    def stitch(inner, outer, t, mirrored):",
      "        ic, oc = 4 * t, 4 * (t + 1)",
      "        ii = lambda i: start[inner] if t == 0 else start[inner] + i % ic",
      "        oi = lambda i: start[outer] + i % oc",
      "        add = lambda a, b, c: faces.append([a, c, b] if mirrored else [a, b, c])",
      "        for q in range(4):",
      "            for s in range(t + 1):",
      "                i, o = q * t + s, q * (t + 1) + s",
      "                add(ii(i), oi(o), oi(o + 1))",
      "                if s < t:",
      "                    add(ii(i), oi(o + 1), ii(i + 1))",
      "    for t in range(n):",
      "        stitch(t, t + 1, t, False)",
      "        stitch(2 * n - t, 2 * n - t - 1, t, True)",
      "    return _polyhedron(pts, faces)",
    ].join("\n"),
  },
};

/** A Write.scad font's DXF basename (lower case) → its meta, for `import(file = …)`. */
const WRITE_FONT_FILES = new Map(WRITE_FONTS.map((font) => [font.file.toLowerCase(), font]));

/** One of Write.scad's DXF fonts, which this build draws exactly (§ text) — OpenSCAD never needs to read it. */
export const isWriteFontFile = (file: string): boolean => WRITE_FONT_FILES.has(dxfBasename(file));
const dxfBasename = (file: string) => file.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
/** The layers of a Write.scad font that have ink: one per glyph, a lower-case letter's layer is `a_`. */
const inkedLayers = (chars: string) => new Set([...chars].map((ch) => (/^[a-z]$/.test(ch) ? `${ch}_` : ch)));

/** A number as Python: integers as they are, the rest to 15 significant digits (drops folding noise, keeps 1e-15). */
function num(value: number): string {
  if (Number.isNaN(value)) return "math.nan";
  if (!Number.isFinite(value)) return value > 0 ? "math.inf" : "-math.inf";
  if (Number.isInteger(value)) return String(value === 0 ? 0 : value);
  return String(Number(value.toPrecision(15)));
}

/** A csg value as a Python literal. */
function literal(value: CsgValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return num(value);
  if (typeof value === "string") return JSON.stringify(value);
  return `[${value.map(literal).join(", ")}]`;
}

/** A 2D loop for `_arc_wire` / `_arc_face`: a plain polygon, or one with its arcs recognised (arcs.ts). */
function loopLiteral(loop: ExactLoop | Pt[]): string {
  const pt = (p: Pt) => `${num(p[0])}, ${num(p[1])}`;
  if (!Array.isArray(loop) && loop.kind === "circle") return `[${pt(loop.center)}, ${num(loop.r)}]`;
  const entries = Array.isArray(loop)
    ? loop.map((p) => ({ at: pt(p), mid: null as string | null }))
    : loop.vertices.map((v, i) => ({ at: pt(v), mid: loop.arcs[i] ? pt(loop.arcs[i]!.mid) : null }));
  // a straight edge to a point that prints the same (equal to the last bits, 15 digits written) has no length:
  // the kernel refuses such a Line
  const kept = entries.filter((e, i) => e.mid !== null || e.at !== entries[(i + 1) % entries.length]!.at || entries.length < 2);
  return `[${kept.map((e) => (e.mid ? `[${e.at}, ${e.mid}]` : `[${e.at}]`)).join(", ")}]`;
}

/** A BOSL2 gear's loop for `_gear_regions` (gears.ts): lines, tip arcs (`[x, y, mx, my]`), splines (`[x, y, [points], t0, t1]`). */
function gearLiteral(loop: GearLoop): string {
  const pt = (p: Pt) => `${num(p[0])}, ${num(p[1])}`;
  return `[${loop.vertices.map((v, i) => {
    const e = loop.edges[i]!;
    if (e.kind === "line") return `[${pt(v)}]`;
    if (e.kind === "arc") return `[${pt(v)}, ${pt(e.mid)}]`;
    const through = `[${e.through.map((p) => `[${pt(p)}]`).join(", ")}]`;
    return e.tangents ? `[${pt(v)}, ${through}, [${pt(e.tangents[0])}], [${pt(e.tangents[1])}]]` : `[${pt(v)}, ${through}]`;
  }).join(", ")}]`;
}

/** A short key for a piece of model.py, without its source marks (two copies of one call are one key). */
function codeKey(code: string): string {
  const text = code.replace(new RegExp(`${MARK}\\d+${MARK_END}`, "g"), "");
  let a = 0x811c9dc5, b = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + c) >>> 0;
  }
  return `${a.toString(16)}${b.toString(16)}${text.length.toString(16)}`;
}

const isNum = (value: CsgValue | undefined): value is number => typeof value === "number";
/** Past this many facets a rendered mesh is refused: sewing costs ~1.5 ms a face (docs/scad-transpile.md §5). */
export const MESH_MAX_FACES = 8_000;
/** Polyhedron points closer than this (mm, each axis) are one (weldPolyhedron): the sewing joins them anyway (cad-engine sewShell). */
const WELD = 1e-6;
/** A size OpenSCAD builds something for: positive and finite (oracle: 0, negative, inf and nan are all empty). */
const buildable = (value: number) => value > 0 && value < 1e300;

/** A translation-time diagnostic and where in the .scad it points (the nearest node being translated that has a location). */
type Said = { message: string; at?: ScadSpan; note?: ScadNote };

const live = (nodes: CsgNode[]) => nodes.filter((n) => n.modifier !== "%" && n.modifier !== "*");
const BOOLEAN_OPS = new Set(["difference", "intersection", "minkowski", "hull"]);

/** Nodes between hull() and a polyhedron that keep it a mere source of points: moves and the implicit unions. */
const HULL_TRANSPARENT = new Set(["multmatrix", "group", "union", "render", "color", "polyhedron"]);

class CsgToModel {
  errors: Said[] = [];
  warnings: Said[] = [];
  /** The nodes being translated, outermost first: a warning points at the innermost one with a location. */
  private stack: CsgNode[] = [];
  /** Where each marked line of model.py comes from (MARK): the call, and the user module it was made in. */
  private spans: { at: ScadSpan; module?: string; caller?: ScadSpan }[] = [];
  private used = new Set<string>();
  private helpers = new Set<string>();
  private needsMath = false;
  private needsNote = false;
  /** Inside hull(), reached through nothing but moves, colours and groups: a polyhedron there only
   *  gives the hull its points, so it is not sewn into a solid (`_polyhedron_hull`). */
  private hullPoints = false;
  /** Inside a boolean — an explicit one, or the implicit union of a node with several children: where OpenSCAD
   *  turns a polyhedron into a manifold, and drops one it cannot close. On its own it exports the faces as they are. */
  private inBoolean = false;
  /** Translating OpenSCAD's own facets of a subtree, as the reference an exact construction is checked against
   *  (bosl2.ts, `_exact_or`): every `$fn` is a polygon, no arc or BOSL2 shape is recognised. */
  private forceFacets = false;
  /** Nodes whose translation is replaced (a BOSL2 cuboid's shape, registered when its call is reached). */
  private overrides = new Map<CsgNode, () => Geo | null>();
  /** The threads drawn plain (with `cosmeticThreads`), for the build report. */
  threads: ScadThread[] = [];
  private readonly modelName: string;
  private readonly cosmeticThreads: boolean;

  constructor(modelName: string, options: { cosmeticThreads?: boolean } = {}) {
    this.modelName = modelName;
    this.cosmeticThreads = options.cosmeticThreads === true;
  }

  private where(node?: CsgNode): ScadSpan | undefined {
    if (node?.at) return node.at;
    for (let k = this.stack.length - 1; k >= 0; k--) if (this.stack[k]!.at) return this.stack[k]!.at;
    return undefined;
  }

  /**
   * A warning points at the author's own call: inside a bundled library (BOSL2's builtins) it is the innermost call
   * outside them that led there — a line the author can act on, not `BOSL2/builtins.scad:34`.
   */
  warn(note: ScadNote, message: string, node?: CsgNode) {
    const own = (at?: ScadSpan) => (at && !isBundledLibraryFile(at.file) ? at : undefined);
    const at = own(node?.at) ?? own([...this.stack].reverse().find((n) => own(n.at))?.at) ?? this.where(node);
    this.warnings.push({ message, at, note });
  }

  ignoreColor(node?: CsgNode) {
    this.warn({ kind: "step", code: "color" }, "color() shows in the preview only — the STEP carries no colour (appearance lives on the Body in model.py, not in the geometry)", node);
  }

  error(node: CsgNode, message: string) {
    this.errors.push({ message: `${node.call && node.name === "multmatrix" ? node.call : node.name}(): ${message}`, at: this.where(node) });
  }

  use(name: string): string {
    if (B123D_NAMES.has(name)) this.used.add(name);
    return name;
  }

  helper(name: string): string {
    if (this.helpers.has(name)) return name;
    const spec = RUNTIME_HELPERS[name]!;
    this.helpers.add(name);
    for (const dep of spec.deps ?? []) this.use(dep);
    for (const dep of spec.helpers ?? []) this.helper(dep);
    if (spec.math) this.needsMath = true;
    if (spec.note) this.needsNote = true;
    return name;
  }

  // ------------------------------------------------------------------ Structure

  /** A node's geometry; null = it builds nothing (a background `%` subtree, a size <= 0, an empty group). */
  geom(node: CsgNode): Geo | null {
    if (node.modifier === "%" || node.modifier === "*") return null;
    this.prepare(node);
    const override = this.overrides.get(node);
    if (override) return this.translating(node, override);
    const outside = this.hullPoints;
    const outsideBoolean = this.inBoolean;
    if (!HULL_TRANSPARENT.has(node.name)) this.hullPoints = false;
    if (BOOLEAN_OPS.has(node.name) || live(node.children).length > 1) this.inBoolean = true;
    this.stack.push(node);
    try {
      const geo = this.geomOf(node);
      if (!geo || !node.at) return geo;
      const module = [...this.stack].reverse().find((n) => n.module)?.module;
      // the author's own call this node came from: itself, or the innermost call outside the bundled libraries
      const caller = [...this.stack].reverse().find((n) => n.at && !isBundledLibraryFile(n.at.file))?.at;
      const id = this.spans.push({ at: node.at, ...(module ? { module } : {}), ...(caller ? { caller } : {}) }) - 1;
      return { ...geo, code: `${MARK}${id}${MARK_END}${geo.code}` };
    } finally {
      this.stack.pop();
      this.hullPoints = outside;
      this.inBoolean = outsideBoolean;
    }
  }

  private geomOf(node: CsgNode): Geo | null {
    switch (node.name) {
      case "group":
      case "union":
      case "render": // render() only affects the preview cache: geometrically a group
        return this.union(this.items(this.kids(node)));
      case "color":
        this.ignoreColor(node);
        return this.union(this.items(this.kids(node)));
      case "difference":
        return this.difference(node);
      case "intersection":
        return this.intersection(node);
      case "hull":
        return this.hull(node);
      case "minkowski":
        return this.minkowski(node);
      case "multmatrix":
        return this.multmatrix(node);
      case "resize":
        return this.resize(node);
      case "offset":
        return this.offset(node);
      case "projection":
        return this.projection(node);
      case "linear_extrude":
        return this.linearExtrude(node);
      case "rotate_extrude":
        return this.rotateExtrude(node);
      case "cube":
        return this.cube(node);
      case "sphere":
        return this.sphere(node);
      case "cylinder":
        return this.cylinder(node);
      case "square":
        return this.square(node);
      case "circle":
        return this.circle(node);
      case "polygon":
        return this.polygon(node);
      case "polyhedron":
        return this.polyhedron(node);
      case "text":
        return this.text(node);
      case "import":
        return this.importFile(node);
      case "surface":
        return this.fallback(node, "reads a heightmap file");
      case "roof":
        return this.fallback(node, "has no exact counterpart here");
      default:
        this.error(node, "OpenSCAD produced a node this build has no counterpart for");
        return null;
    }
  }

  /**
   * The children of a node as a flat list of operands: a transparent wrapper (group — every module call and
   * `for` loop comes out as one —, union, render, color) is spliced in rather than fused first. For a union
   * that is one n-ary boolean instead of nested ones; for hull() it hands the engine whole circles instead of
   * the trimmed arcs a fuse leaves behind.
   */
  items(nodes: CsgNode[]): Geo[] {
    const out: Geo[] = [];
    for (const node of nodes) {
      if (node.modifier === "%" || node.modifier === "*") continue;
      this.prepare(node);
      const override = this.overrides.get(node);
      if (override) {
        const geo = this.translating(node, override);
        if (geo) out.push(geo);
        continue;
      }
      if (["group", "union", "render", "color"].includes(node.name)) {
        if (node.name === "color") this.ignoreColor(node);
        const outside = this.inBoolean;
        if (live(node.children).length > 1) this.inBoolean = true;
        this.stack.push(node);
        try {
          out.push(...this.items(this.kids(node)));
        } finally {
          this.stack.pop();
          this.inBoolean = outside;
        }
        continue;
      }
      const geo = this.geom(node);
      if (geo) out.push(geo);
    }
    return out;
  }

  // ------------------------------------------------------------------ BOSL2 (bosl2.ts)

  /** `node` translated by `how`, with it on the stack (warnings point at it, BOSL2 calls above it are seen). */
  private translating(node: CsgNode, how: () => Geo | null): Geo | null {
    this.stack.push(node);
    try {
      return how();
    } finally {
      this.stack.pop();
    }
  }

  /**
   * Whether a BOSL2 call is meant smooth (bosl2.ts smoothIntent): the author's `$fn` at the call, or — for a call
   * BOSL2 makes itself inside a `cuboid(rounding=)` the author meant smooth — the `$fn = quantup(segs(r), 4)` cuboid
   * sets for its rounding (its negative rounding's masks are `cyl()`s), which is BOSL2's choice, not the author's.
   */
  private smoothCall(call: CsgNode): boolean {
    if (smoothIntent(call)) return true;
    if (!madeByBosl2(call)) return false;
    for (let k = this.stack.lastIndexOf(call) - 1; k >= 0; k--) {
      const outer = this.stack[k]!;
      if (!isBosl2Call(outer)) continue;
      return outer.module === "cuboid" && typeof outer.scope?.get("rounding") === "number" && outer.scope.get("rounding") !== 0 && this.smoothCall(outer);
    }
    return false;
  }

  /** The innermost BOSL2 call being translated (a group with its scope), if any. */
  private bosl2Owner(): CsgNode | undefined {
    for (let k = this.stack.length - 1; k >= 0; k--) if (isBosl2Call(this.stack[k]!)) return this.stack[k];
    return undefined;
  }

  /**
   * Before translating `node`: a BOSL2 cuboid() call puts its exact shape in place of the nodes it draws; with
   * `cosmeticThreads`, a BOSL2 thread its plain stand-in (threadShape).
   */
  private prepare(node: CsgNode) {
    if (this.cosmeticThreads && !this.forceFacets && THREAD_SCOPED.includes(node.module!) && isBosl2Call(node)) {
      const shape = attachableShape(node);
      if (shape && !this.overrides.has(shape)) {
        const plan = plainThread(node);
        const asked = this.bosl2Call() ?? node;
        if ("why" in plan) this.warn({ kind: "step", code: "thread-kept", call: `${asked.module ?? node.module}()` }, `${asked.module ?? node.module}(): kept the modeled thread — ${plan.why}`, asked);
        else this.overrides.set(shape, () => this.threadShape(node, plan));
      }
      return;
    }
    if (this.forceFacets || node.module !== "cuboid" || !isBosl2Call(node)) return;
    const rounding = node.scope?.get("rounding");
    // a plain box (cube) or a chamfer: already exact. A negative rounding (a flange) is a box and masks built from
    // cyl()s, which come out true cylinders as they are (smoothCall)
    if (typeof rounding !== "number" || rounding <= 0) return;
    const shape = attachableShape(node);
    if (!shape || this.overrides.has(shape)) return;
    this.overrides.set(shape, () => this.cuboidShape(node, shape));
  }

  /**
   * A BOSL2 thread drawn plain (threads.ts): a rod at its major diameter, a hole's cutter at its minor, end chamfers
   * kept — the solid of revolution of its (r, z) profile, in the module's own frame (the anchor moves stay around it).
   * Recorded for the build report with the call from the author's code that asked for it.
   */
  private threadShape(call: CsgNode, plan: PlainThread): Geo {
    const asked = this.bosl2Call() ?? call;
    const { profile, ...spec } = plan;
    this.threads.push({ ...spec, call: asked.module ?? call.module!, ...(asked.at ? { at: asked.at } : {}) });
    return solid(`${this.helper("_revolve_loop")}(${loopLiteral(profile)})`);
  }

  /**
   * BOSL2 `cuboid(rounding=)` (bosl2.ts exactCuboid): a box with its rounded edges filleted, compared once per set of
   * arguments with OpenSCAD's own facets of the same subtree (`_exact_or`). Not recognised → the facets, said why.
   */
  private cuboidShape(call: CsgNode, shape: CsgNode): Geo | null {
    const faceted = () => this.union(this.items(shape.children));
    if (!smoothIntent(call)) return faceted();
    const plan = exactCuboid(call, shape.children);
    // cloud is strict: false — `ok` does not narrow the union, `in` does
    if ("why" in plan) {
      this.warn({ kind: "step", code: "facets", call: "cuboid()" }, `cuboid(): kept OpenSCAD's facets — ${plan.why}`, call);
      return faceted();
    }
    const outside = this.forceFacets;
    this.forceFacets = true;
    let ref: Geo | null;
    try {
      ref = faceted();
    } finally {
      this.forceFacets = outside;
    }
    if (!ref) return null;
    const [sx, sy, sz] = plan.size.map(num);
    const exact = `${this.helper("_box_fillet")}(${sx}, ${sy}, ${sz}, ${num(plan.r)}, ${literal(plan.edges)})`;
    const sides = Math.max(4, Math.ceil(bosl2Segs(plan.r, call.specials ?? {}) / 4) * 4);
    const sag = plan.r * (1 - Math.cos(Math.PI / sides));
    const key = codeKey(`${exact}|${ref.code}`);
    return {
      code: `${this.helper("_exact_or")}("${key}", lambda: ${exact}, lambda: ${ref.code}, "cuboid()", ${num(plan.deficit)}, ${num(sag)})`,
      maybe: ref.maybe,
    };
  }

  /**
   * A polyhedron BOSL2 computed for one of its smooth shapes (spheroid, cyl with roundings or chamfers, prismoid with
   * roundings), as the exact solid — checked against the polyhedron itself (bosl2.ts). null: not one of those; the
   * caller goes on with the facets (and a warning says why, when it was one of those and the check failed).
   */
  private bosl2Polyhedron(node: CsgNode): Geo | null {
    if (this.forceFacets || !madeByBosl2(node)) return null;
    const owner = this.bosl2Owner();
    if (!owner || !["spheroid", "cyl", "prismoid"].includes(owner.module!)) return null;
    if (owner.module !== "prismoid" && !this.smoothCall(owner)) return null;
    const poly = polyhedronOf(node);
    if (!poly) return null;
    if (owner.module === "spheroid") {
      const s = exactSpheroid(owner, poly);
      if (!("why" in s)) return solid(`${this.use("Pos")}(${s.center.map(num).join(", ")}) * ${this.use("Sphere")}(${num(s.r)})`);
      this.warn({ kind: "step", code: "facets", call: "spheroid()" }, `spheroid(): kept OpenSCAD's facets — ${s.why}`, owner);
      return null;
    }
    if (owner.module === "cyl") {
      const c = exactCyl(owner, poly);
      if (!("why" in c)) return solid(`${this.helper("_revolve_loop")}(${loopLiteral(c.profile)})`);
      this.warn({ kind: "step", code: "facets", call: "cyl()" }, `cyl(): kept OpenSCAD's facets — ${c.why}`, owner);
      return null;
    }
    const p = exactPrismoid(owner, poly, this.arcPolicy(node));
    if (!("why" in p) && p.straight) {
      // straight walls: an extrusion, its rounded corners true cylinders
      const prism = `${this.use("extrude")}(${this.helper("_arc_face")}(${loopLiteral(p.loop0)}), ${num(p.z1 - p.z0)}, dir=(0, 0, 1))`;
      return solid(p.z0 ? `${this.use("Pos")}(0, 0, ${num(p.z0)}) * ${prism}` : prism);
    }
    if (!("why" in p)) return solid(`${this.helper("_loft_rings")}(${num(p.z0)}, ${loopLiteral(p.loop0)}, ${num(p.z1)}, ${loopLiteral(p.loop1)})`);
    // a prismoid without roundings is all flat faces already: nothing to say
    if (p.why !== "no arcs in its rings") this.warn({ kind: "step", code: "facets", call: "prismoid()" }, `prismoid(): kept OpenSCAD's facets — ${p.why}`, owner);
    return null;
  }

  /**
   * The facets of a builtin BOSL2 drew for one of its smooth shapes are BOSL2's, not the author's: `cyl()` without
   * roundings is `cylinder($fn = segs(r))`, an octagon for r = 2.5 at the default `$fs`. When the author asked for a
   * smooth shape (smoothIntent), it is a circle. `circum = true` scaled the radius so the polygon circumscribes it:
   * the circle is the nominal radius (scope `_r1`, `_r2`).
   */
  private bosl2Circle(node: CsgNode): { r1: number; r2: number } | null {
    if (this.forceFacets || !madeByBosl2(node)) return null;
    const owner = this.bosl2Owner();
    if (!owner || !this.smoothCall(owner)) return null;
    // ellipse(): circle(r, $fn = segs(max r)) scaled along one axis — the circle, scaled, is the ellipse
    if (owner.module === "ellipse" && node.name === "circle") {
      if (owner.scope!.get("circum") === true || owner.scope!.get("uniform") === true) return null;
      const r = node.args.get("r");
      return isNum(r) ? { r1: r, r2: r } : null;
    }
    if (owner.module !== "cyl" || node.name !== "cylinder") return null;
    const scope = owner.scope!;
    for (const key of ["chamfer", "chamfer1", "chamfer2", "rounding", "rounding1", "rounding2", "texture"]) {
      const v = scope.get(key);
      if (v !== null && v !== undefined) return null;
    }
    const r1 = node.args.get("r1"), r2 = node.args.get("r2");
    if (!isNum(r1) || !isNum(r2)) return null;
    if (scope.get("circum") !== true) return { r1, r2 };
    const sc = scope.get("sc"), n1 = scope.get("_r1"), n2 = scope.get("_r2");
    if (typeof sc !== "number" || typeof n1 !== "number" || typeof n2 !== "number") return null;
    if (Math.abs(n1 * sc - r1) > 1e-9 * Math.max(1, r1) || Math.abs(n2 * sc - r2) > 1e-9 * Math.max(1, r2)) return null;
    return { r1: n1, r2: n2 };
  }

  /**
   * How polygon() reads a loop that is one whole circle: from 13 sides up (the `$fn <= 12` reading); for a polygon
   * BOSL2 drew for a smooth shape the author asked for, also when its side count is BOSL2's own `segs(r)`.
   */
  private arcPolicy(node: CsgNode): ArcPolicy {
    const owner = madeByBosl2(node) ? this.bosl2Owner() : undefined;
    if (!owner || !this.smoothCall(owner)) return {};
    const specials = owner.specials ?? {};
    return {
      fullCircle: (n, r) => {
        if (n >= MIN_FULL_CIRCLE) return true;
        const segs = bosl2Segs(r, { ...specials, $fn: 0 });
        return n === segs || n === Math.ceil(segs / 4) * 4;
      },
    };
  }

  /** The children of an operator, fused into one operand (the implicit union OpenSCAD applies). */
  body(node: CsgNode): Geo | null {
    return this.union(this.items(this.kids(node)));
  }

  /**
   * A node's children as OpenSCAD's evaluation takes them: one dimension per operation. A 2D operation (extrudes,
   * offset, roof) ignores 3D children, a 3D one (projection) 2D children; any other takes the dimension of its first
   * child that has one and ignores the rest ("Mixing 2D and 3D objects is not supported", GeometryEvaluator
   * applyToChildren). BOSL2's debug drawings put spheres into 2D scenes; the kernel refused the mix outright.
   */
  kids(node: CsgNode, want?: 2 | 3): CsgNode[] {
    const fixed = want ?? (["linear_extrude", "rotate_extrude", "offset", "roof"].includes(node.name) ? 2 : node.name === "projection" ? 3 : undefined);
    return this.sameDimension(node.children, fixed);
  }

  sameDimension(children: CsgNode[], want?: 2 | 3): CsgNode[] {
    let dim = want;
    const out: CsgNode[] = [];
    for (const child of children) {
      const d = child.modifier === "%" || child.modifier === "*" ? null : dimOf(child);
      if (d && !dim) dim = d;
      if (d && dim && d !== dim) {
        this.warn({ kind: "model", code: "mixed-dims" }, want
          ? `ignoring a ${d}D child of a ${want}D operation, as OpenSCAD does`
          : `mixing 2D and 3D objects is not supported: the ${d}D one is ignored, as OpenSCAD ignores it`, child);
        continue;
      }
      out.push(child);
    }
    return out;
  }

  union(parts: Geo[]): Geo | null {
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0]!;
    if (parts.some((part) => part.maybe) || parts.length > 2) {
      return { code: `${this.helper("_union")}([${parts.map((part) => part.code).join(", ")}])`, maybe: parts.every((part) => part.maybe) };
    }
    return solid(`(${parts[0]!.code} + ${parts[1]!.code})`);
  }

  /** The first child minus every other: one cut with all of them as tools (a group of tools is spliced in). */
  difference(node: CsgNode): Geo | null {
    const kids = this.kids(node).filter((child) => child.modifier !== "%" && child.modifier !== "*");
    if (!kids.length) return null;
    const base = this.geom(kids[0]!);
    const tools = this.items(kids.slice(1));
    if (!base) return null;
    if (!tools.length) return base;
    if (base.maybe || tools.some((tool) => tool.maybe)) {
      return { code: `${this.helper("_diff")}(${base.code}, [${tools.map((tool) => tool.code).join(", ")}])`, maybe: base.maybe };
    }
    if (tools.length === 1) return solid(`(${base.code} - ${tools[0]!.code})`);
    return solid(`(${base.code} - ${this.use("Compound")}([${tools.map((tool) => tool.code).join(", ")}]))`);
  }

  /** Every child is one operand, and an empty one (`group();`, a cube(0)) empties the whole intersection, as in OpenSCAD. */
  intersection(node: CsgNode): Geo | null {
    const operands: Geo[] = [];
    const kids = this.kids(node);
    // a child of the other dimension is OpenSCAD's empty operand here, which empties the intersection
    if (kids.length < node.children.length) return null;
    for (const child of kids) {
      if (child.modifier === "%" || child.modifier === "*") continue;
      const geo = this.geom(child);
      if (!geo) return null;
      operands.push(geo);
    }
    if (!operands.length) return null;
    if (operands.length === 1) return operands[0]!;
    if (operands.some((part) => part.maybe)) {
      return { code: `${this.helper("_inter")}([${operands.map((part) => part.code).join(", ")}])`, maybe: true };
    }
    return solid(`(${operands.map((part) => part.code).join(" & ")})`);
  }

  /** `loc * child`, through the helper when the child may be empty at run time. */
  move(loc: string, child: Geo): Geo {
    return child.maybe ? { code: `${this.helper("_move")}(${loc}, ${child.code})`, maybe: true } : solid(`${loc} * ${child.code}`);
  }

  /**
   * hull() is an ENGINE operator (b123d/hull.ts): exact families first — 2D profiles, equal-radius spheres,
   * upright prisms sharing one z-range, coaxial solids of revolution, straight-edged solids — and a
   * point-cloud fallback under them, so no hull() fails to build. A fallback that had to tessellate a
   * curved child raises a `hull-faceted` build WARNING naming the facet count; it is never silent.
   */
  hull(node: CsgNode): Geo | null {
    const outside = this.hullPoints;
    this.hullPoints = true;
    let children: Geo[];
    try {
      children = this.items(this.kids(node));
    } finally {
      this.hullPoints = outside;
    }
    if (!children.length) return null;
    return { code: `${this.helper("_nz")}(${this.use("hull")}([${children.map((child) => child.code).join(", ")}]))`, maybe: true };
  }

  /**
   * `minkowski()` — folded left like OpenSCAD's n-ary form (⊕ is associative), every pair through the
   * ENGINE operator `minkowski(a, b)` (b123d/minkowski.ts: ball → offset, prisms along a shared direction →
   * 2D sums extruded, convex parts → hulls, and a mesh sum that never gives up). The engine op drops an
   * empty side itself; only the final result is turned from an empty shape into None.
   * Every direct child is ONE operand — a group or union child is fused first, never spliced in as hull()'s
   * are: A ⊕ (B ∪ C) is not (A ⊕ B) ⊕ C.
   */
  minkowski(node: CsgNode): Geo | null {
    const children = this.kids(node).map((child) => this.geom(child)).filter((geo): geo is Geo => !!geo);
    if (children.length < 2) return children[0] ?? null;
    let code = children[0]!.code;
    for (const child of children.slice(1)) code = `${this.use("minkowski")}(${code}, ${child.code})`;
    return { code: `${this.helper("_nz")}(${code})`, maybe: true };
  }

  // ------------------------------------------------------------------ Transforms

  /**
   * `multmatrix(m)` — the ONLY transform in the .csg: every translate / rotate / scale / mirror comes as one.
   * Split into mirror / rotation / scale / translation (affine.ts), so model.py reads as the moves it is
   * (`Pos(…) * Rot(…) * part`) and planes stay planes.
   */
  multmatrix(node: CsgNode): Geo | null {
    let rows = matrixOf(node.args.get("m") ?? node.positional[0]);
    if (!rows) {
      this.error(node, "the matrix is not a list of number rows");
      return null;
    }
    // a 2D object takes only the matrix's 2D part (GeometryEvaluator: rows 0, 1, 3 × columns 0, 1, 3): `up(0.1)` does
    // not lift it, `rotate([90, 0, 0])` squashes it — it used to tilt off the plane and extrude out of place
    if (dimOf(node) === 2 && rows.length >= 2) {
      const at = (r: number, c: number) => rows![r]?.[c] ?? (r === c ? 1 : 0);
      // z of a flat object is free: scaled like the plane (√|det|), a uniform 2D scale is a similarity and circles stay
      // circles instead of turning into B-spline ellipses of the same shape
      const k = Math.sqrt(Math.abs(at(0, 0) * at(1, 1) - at(0, 1) * at(1, 0))) || 1;
      rows = [[at(0, 0), at(0, 1), 0, at(0, 3)], [at(1, 0), at(1, 1), 0, at(1, 3)], [0, 0, k, 0], [0, 0, 0, 1]];
    }
    // rotate(a = [nan, …]), scale(1/0): OpenSCAD warns "Transformation matrix contains Not-a-Number and/or
    // Infinity - removing object" and renders the rest (oracle; corpus 260861, 1015605 failed the whole build)
    if (rows.some((row) => row.some((v) => !Number.isFinite(v)))) {
      this.warn({ kind: "model", code: "flat-matrix", call: "multmatrix()" }, "multmatrix(): the matrix contains nan or inf — OpenSCAD removes the object, and so does this build");
      return null;
    }
    const { A, t } = affineOfRows(rows);
    const plan = planAffine(A, t);
    if (!plan) {
      this.warn({ kind: "model", code: "flat-matrix", call: "multmatrix()" }, "multmatrix(): the matrix flattens the object onto a plane or a line — OpenSCAD removes it, and so does this build");
      return null;
    }
    // scale([s, s, sz]) over a linear_extrude — every Write.scad glyph — folds into the extrusion (foldExtrusion)
    const [first, ...rest] = plan.steps;
    if (first?.kind === "scale" && Array.isArray(first.factors) && first.factors[0] === first.factors[1]
      && first.factors[0] > 0 && first.factors[2] > 0 && rest.every((step) => step.kind === "move")) {
      const folded = this.foldExtrusion(node, first.factors[0], first.factors[2]);
      if (folded !== undefined) return folded && rest.length ? this.applyAffine(rest, folded) : folded;
    }
    const child = this.body(node);
    return child ? this.applyAffine(plan.steps, child, dimOf(node) === 2) : null;
  }

  /** `flat`: the child is 2D, and a mirror keeps it face up (`_mirror_flat`). */
  applyAffine(steps: AffineStep[], child: Geo, flat = false): Geo {
    let geo = child;
    for (const step of steps) {
      if (step.kind === "move") {
        geo = this.move(`${this.use("Pos")}(${step.offset.map(num).join(", ")})`, geo);
      } else if (step.kind === "rotate") {
        // OpenSCAD's rotate([x, y, z]) is EXTRINSIC (Rz*Ry*Rx); build123d's Rot(x, y, z) is intrinsic. With
        // two or more non-zero axes those are different poses (09-10 corpus: 21-28% volume off, the bbox
        // identical), so the rotation is three single-axis Rots, the rightmost applied first.
        const [x, y, z] = step.angles;
        const R = this.use("Rot");
        const parts = [z ? `${R}(0, 0, ${num(z)})` : null, y ? `${R}(0, ${num(y)}, 0)` : null, x ? `${R}(${num(x)}, 0, 0)` : null];
        geo = this.move(parts.filter((part): part is string => !!part).join(" * "), geo);
      } else if (step.kind === "mirror") {
        const plane = `${this.use("Plane")}.${["YZ", "XZ", "XY"][step.axis]}`;
        geo = flat
          ? { code: `${this.helper("_mirror_flat")}(${geo.code}, ${plane})`, maybe: geo.maybe }
          : geo.maybe
            ? { code: `${this.helper("_mirror")}(${geo.code}, ${plane})`, maybe: true }
            : solid(`${this.use("mirror")}(${geo.code}, about=${plane})`);
      } else {
        const factors = step.factors;
        const flat = Array.isArray(factors) && factors[2] === 0;
        if (Array.isArray(factors) && !flat) {
          this.warn({ kind: "exact", code: "exact" }, "scale([x, y, z]) with unequal factors: curved faces become BSpline surfaces — the shape is exact (a scaled cylinder is an elliptic cylinder), but in an exported STEP they are not analytic cylinders/spheres.");
        }
        const f = Array.isArray(factors) ? `[${factors.map(num).join(", ")}]` : num(factors);
        geo = geo.maybe || flat
          ? { code: `${this.helper("_scale")}(${geo.code}, ${f})`, maybe: true }
          : solid(`${this.use("scale")}(${geo.code}, ${f})`);
      }
    }
    return geo;
  }

  /**
   * `multmatrix(scale [s, s, sz]) { multmatrix(translate t)… { linear_extrude(height = h, center = c) <2D> } }` —
   * every Write.scad glyph and a common shape elsewhere. As written it scales a finished prism per axis, which
   * OCCT can only do by turning every plane into a BSpline: exact, but every later boolean pays for it (20
   * glyphs cut from a plate: 7.8 s against 2.8 s) and the STEP gets BSpline flats. The same solid is
   * `translate(s*t, sz*t) linear_extrude(h*sz) scale(s) <2D>`: a uniform 2D scale — a similarity, planes stay
   * planes — and a taller extrude. Only for exactly that chain (one child each, no modifiers, no twist/taper).
   * `undefined` = not this shape, carry on.
   */
  foldExtrusion(node: CsgNode, s: number, sz: number): Geo | null | undefined {
    const only = (parent: CsgNode): CsgNode | null => {
      const [child, ...more] = parent.children;
      return child && !more.length && (child.modifier === "" || child.modifier === "#") ? child : null;
    };
    const offset = [0, 0, 0];
    let at = only(node);
    while (at?.name === "multmatrix") {
      const rows = matrixOf(at.args.get("m") ?? at.positional[0]);
      const affine = rows && rows.every((row) => row.every(Number.isFinite)) ? affineOfRows(rows) : null;
      const plan = affine ? planAffine(affine.A, affine.t) : null;
      if (!plan || plan.steps.some((step) => step.kind !== "move")) return undefined;
      const move = plan.steps[0];
      if (move?.kind === "move") move.offset.forEach((v, i) => (offset[i]! += v));
      at = only(at);
    }
    if (at?.name !== "linear_extrude" || ["twist", "scale", "slices"].some((key) => at!.args.has(key))) return undefined;
    const h = at.args.get("height");
    const height = isNum(h) ? h : 100;
    if (!buildable(height)) return null;
    const profile = this.body(at);
    if (!profile) {
      this.warn({ kind: "model", code: "empty-child", call: "linear_extrude()" }, "linear_extrude(): its child builds nothing, so neither does it — as in OpenSCAD");
      return null;
    }
    const lift = at.args.get("center") === true ? -(height * sz) / 2 : 0;
    const scaled = s === 1 ? profile : this.scaleProfile(profile, s);
    const prism = scaled.maybe
      ? { code: `${this.helper("_extrude")}(${scaled.code}, ${num(height * sz)})`, maybe: true }
      : solid(`${this.use("extrude")}(${scaled.code}, ${num(height * sz)})`);
    const [x, y, z] = [offset[0]! * s, offset[1]! * s, offset[2]! * sz + lift];
    return x || y || z ? this.move(`${this.use("Pos")}(${num(x)}, ${num(y)}, ${num(z)})`, prism) : prism;
  }

  scaleProfile(profile: Geo, s: number): Geo {
    return profile.maybe ? { code: `${this.helper("_scale")}(${profile.code}, ${num(s)})`, maybe: true } : solid(`${this.use("scale")}(${profile.code}, ${num(s)})`);
  }

  resize(node: CsgNode): Geo | null {
    const child = this.body(node);
    if (!child) return null;
    const newsize = node.args.get("newsize");
    if (!Array.isArray(newsize)) {
      this.error(node, "needs a newsize vector");
      return null;
    }
    const auto = node.args.get("auto");
    const autos = Array.isArray(auto) ? auto : [auto ?? false, auto ?? false, auto ?? false];
    return {
      code: `${this.helper("_resize")}(${child.code}, ${literal(newsize)}, ${literal(autos.map((a) => a === true || (isNum(a) && a !== 0)))})`,
      maybe: child.maybe,
    };
  }

  // ------------------------------------------------------------------ 2D operators and extrusion

  offset(node: CsgNode): Geo | null {
    if (node.args.get("chamfer") === true) {
      // ChFi2d can chamfer a face's VERTICES, but not "offset with chamfered corners" — the corner
      // to chamfer does not exist until the offset has run, and its size follows delta. OpenSCAD's render of it is
      // straight-edged anyway (a chamfer is), so the mesh fallback is exact here.
      return this.fallback(node, "with chamfer = true has no kernel op");
    }
    const child = this.body(node);
    if (!child) return null;
    const r = node.args.get("r");
    const delta = node.args.get("delta");
    const amount = isNum(r) ? r : isNum(delta) ? delta : 0;
    if (Math.abs(amount) < 1e-12) return child; // OpenSCAD's identity; the dialect refuses a zero amount
    const kind = `${this.use("Kind")}.${isNum(r) ? "ARC" : "INTERSECTION"}`;
    const render = node.rendered;
    if (render !== undefined && render?.dim !== 3) {
      const backup = render ? this.fill(contoursOf(render)) : null;
      const edges = render ? render.points.length : 0;
      return { code: `${this.helper("_offset_or")}(${child.code}, ${num(amount)}, ${kind}, lambda: ${backup ? backup.code : "None"}, ${edges})`, maybe: true };
    }
    return { code: `${this.helper("_offset")}(${child.code}, ${num(amount)}, ${kind})`, maybe: child.maybe };
  }

  projection(node: CsgNode): Geo | null {
    if (node.args.get("cut") !== true) {
      // the OUTLINE of the whole solid seen from +Z: OCC needs HLR for that and the kernel does not expose it
      return this.fallback(node, "with cut = false (the outline seen from +Z) has no kernel op");
    }
    const child = this.body(node);
    if (!child) return null;
    return child.maybe
      ? { code: `${this.helper("_section")}(${child.code})`, maybe: true }
      : solid(`${this.use("section")}(${child.code}, section_by=${this.use("Plane")}.XY)`);
  }

  linearExtrude(node: CsgNode): Geo | null {
    const h = node.args.get("height");
    const height = isNum(h) ? h : 100;
    // OpenSCAD renders a height <= 0 as nothing — not a downward prism, not a zero-height sheet
    // (1363149's first layer is 2.5*sin(0) tall, and its sheet wrecked the union of the rest)
    if (!buildable(height)) return null;
    const profile = this.body(node);
    if (!profile) {
      this.warn({ kind: "model", code: "empty-child", call: "linear_extrude()" }, "linear_extrude(): its child builds nothing, so neither does it — as in OpenSCAD");
      return null;
    }
    const twist = node.args.get("twist");
    const taper = node.args.get("scale");
    const slices = node.args.get("slices");
    let built: Geo;
    if (isNum(twist) || taper !== undefined) {
      const tw = isNum(twist) ? twist : 0;
      // OpenSCAD clamps a negative scale to 0 (1363149 divides by cos(90°) and asks for -1e15)
      const pair = Array.isArray(taper) ? [taper[0], taper[1] ?? taper[0]] : [taper ?? 1, taper ?? 1];
      const sc = pair.map((f) => (isNum(f) ? Math.max(f, 0) : 1));
      let steps: number;
      if (isNum(slices)) {
        steps = Math.max(1, Math.floor(slices));
      } else if (tw === 0) {
        steps = 1; // a pure taper is a ruled loft between two similar sections: ONE step, and exact
      } else {
        this.warn({ kind: "step", code: "twist", call: "linear_extrude()" }, "linear_extrude(twist=...): a twisted extrusion has no exact BREP form — it is built from flat slices, exactly as OpenSCAD builds it. Pass slices= to control the count (default: one every 15°).");
        steps = Math.max(2, Math.ceil(Math.abs(tw) / 15));
      }
      built = {
        code: `${this.helper("_twist_extrude")}(${profile.code}, ${num(height)}, ${num(tw)}, [${sc.map(num).join(", ")}], ${steps})`,
        // a profile with no faces left (text cut to nothing by an intersection) lofts to None
        maybe: true,
      };
    } else {
      // Always up +Z, as OpenSCAD extrudes: build123d's extrude follows the face's normal, and a 2D child turned
      // over (rotate([180, 0, 0])) faces -Z — it grew downwards, a mirror image of the model, and where some of its
      // outlines came from OpenSCAD's own render (an offset fallback, which faces +Z) the parts missed each other
      // (corpus 4415499: the pockets cut into the empty space above the box).
      built = profile.maybe
        ? { code: `${this.helper("_extrude")}(${profile.code}, ${num(height)})`, maybe: true }
        : solid(`${this.use("extrude")}(${profile.code}, ${num(height)}, dir=(0, 0, 1))`);
    }
    return node.args.get("center") === true ? this.move(`${this.use("Pos")}(0, 0, ${num(-height / 2)})`, built) : built;
  }

  rotateExtrude(node: CsgNode): Geo | null {
    const profile = this.body(node);
    if (!profile) {
      this.warn({ kind: "model", code: "empty-child", call: "rotate_extrude()" }, "rotate_extrude(): its child builds nothing, so neither does it — as in OpenSCAD");
      return null;
    }
    const a = node.args.get("angle");
    const angle = isNum(a) ? a : 360;
    // OpenSCAD revolves a 2D profile in the XY plane about Z (x is the radius); build123d's revolve wants the
    // profile in a plane containing the axis, so _revolve stands it up on XZ first. A profile across the
    // axis is OpenSCAD's empty, so the result is always maybe.
    const start = node.args.get("start");
    // $fn 3..12: the facets are the shape (OpenSCAD: fragments = ceil(max($fn * |angle| / 360, 1)))
    const n = this.facets(node);
    if (n !== null) {
      const fragments = Math.ceil(Math.max((n * Math.abs(angle)) / 360, 1));
      return { code: `${this.helper("_revolve_facets")}(${profile.code}, ${num(angle)}, ${num(isNum(start) ? start : 0)}, ${fragments})`, maybe: true };
    }
    const revolved: Geo = { code: `${this.helper("_revolve")}(${profile.code}, ${num(angle)})`, maybe: true };
    // `start=` (OpenSCAD 2025; the .csg export always writes it): where a PARTIAL sweep begins. A full turn's
    // start only moves the seam (the export writes 180 for a plain rotate_extrude()), so it is left alone.
    if (!isNum(start) || start === 0 || Math.abs(angle) >= 360) return revolved;
    return this.move(`${this.use("Rot")}(0, 0, ${num(start)})`, revolved);
  }

  // ------------------------------------------------------------------ Primitives

  /** A primitive OpenSCAD builds nothing for: it says nothing, this build says why. */
  empty(what: string): null {
    this.warn({ kind: "model", code: "zero-size", call: what }, `${what}: a size <= 0 builds nothing — OpenSCAD renders it as empty, and so does this build`);
    return null;
  }

  /**
   * `$fn` 3..12 is a polygon on purpose (hex heads, square posts); below 3 it is OpenSCAD's triangle. Else null.
   * A fractional `$fn` rounds UP, as OpenSCAD counts it since 2026 (CurveDiscretizer: `ceil(max($fn, 3))`; 2025
   * truncated): `$fn = 5.5` is a hexagon.
   */
  facets(node: CsgNode): number | null {
    const fn = node.args.get("$fn");
    if (!isNum(fn) || !(fn > 0) || !Number.isFinite(fn)) return null;
    const n = Math.ceil(Math.max(fn, 3));
    // the reference for an exact construction is OpenSCAD's facets, all of them (`_exact_or`)
    if (this.forceFacets) return n;
    // BOSL2's own segs(r) for a smooth shape the author asked for: a circle, said nowhere (bosl2Circle)
    if (this.bosl2Circle(node)) return null;
    if (n > 12) {
      this.warn({ kind: "exact", code: "exact" }, `$fn=${fn}: the preview shows OpenSCAD's ${n} facets; the STEP has EXACT curved faces (a true circle) — volumes differ from OpenSCAD by ~0.1%`);
      return null;
    }
    return n;
  }

  cube(node: CsgNode): Geo | null {
    const size = node.args.get("size");
    const [x, y, z] = Array.isArray(size) ? [0, 1, 2].map((i) => size[i]) : [size, size, size];
    if (![x, y, z].every((v) => isNum(v) && buildable(v))) return this.empty("cube()");
    // OpenSCAD's cube grows from the origin into +XYZ; build123d's Box is centred
    const align = node.args.get("center") === true ? "" : `, align=(${this.use("Align")}.MIN, Align.MIN, Align.MIN)`;
    return solid(`${this.use("Box")}(${num(x as number)}, ${num(y as number)}, ${num(z as number)}${align})`);
  }

  square(node: CsgNode): Geo | null {
    const size = node.args.get("size");
    const [x, y] = Array.isArray(size) ? [size[0], size[1]] : [size, size];
    if (![x, y].every((v) => isNum(v) && buildable(v))) return this.empty("square()");
    const align = node.args.get("center") === true ? "" : `, align=(${this.use("Align")}.MIN, Align.MIN)`;
    return solid(`${this.use("Rectangle")}(${num(x as number)}, ${num(y as number)}${align})`);
  }

  sphere(node: CsgNode): Geo | null {
    const r = node.args.get("r");
    if (!isNum(r) || !buildable(r)) return this.empty("sphere()");
    const n = this.facets(node);
    // style = "octa" (OpenSCAD 2026): the octahedron subdivided, its equator and two meridians the circle()'s points
    if (n !== null) return solid(node.args.get("style") === "octa" ? `${this.helper("_sphere_octa")}(${num(r)}, ${n})` : `${this.helper("_sphere_poly")}(${num(r)}, ${n})`);
    return solid(`${this.use("Sphere")}(${num(r)})`);
  }

  circle(node: CsgNode): Geo | null {
    const r = node.args.get("r");
    if (!isNum(r) || !buildable(r)) return this.empty("circle()");
    const n = this.facets(node);
    if (n !== null) return solid(`${this.use("RegularPolygon")}(${num(r)}, ${n})`);
    return solid(`${this.use("Circle")}(${num(r)})`);
  }

  /** The .csg writes every cylinder as `h, r1, r2, center`. Empty: h <= 0, a negative radius, both radii 0 (oracle); one zero radius is a cone. */
  cylinder(node: CsgNode): Geo | null {
    const h = node.args.get("h");
    const radii = [node.args.get("r1"), node.args.get("r2")];
    if (!isNum(h) || !buildable(h) || !radii.every((r) => isNum(r) && r >= 0 && r < 1e300)) return this.empty("cylinder()");
    // BOSL2 cyl(circum = true) drew the polygon around the circle the author asked for: that circle (bosl2Circle)
    const nominal = this.bosl2Circle(node);
    // a radius a rounding error from zero (r * cos(90°)) is an apex: the kernel refuses 1.5e-15 (112367)
    const [r1, r2] = (nominal ? [nominal.r1, nominal.r2] : (radii as number[])).map((r) => (r < 1e-9 ? 0 : r)) as [number, number];
    if (r1 === 0 && r2 === 0) return this.empty("cylinder()");
    const centred = node.args.get("center") === true;
    const n = this.facets(node);
    if (n !== null) {
      // $fn <= 12: a prism (hex head), or a pyramid / frustum (the corpus bevels text with cylinder(r1 = x, r2 = 0, $fn = 4))
      const prism = r1 === r2
        ? solid(`${this.use("extrude")}(${this.use("RegularPolygon")}(${num(r1)}, ${n}), ${num(h)})`)
        : solid(`${this.helper("_cone_poly")}(${num(r1)}, ${num(r2)}, ${num(h)}, ${n})`);
      return centred ? this.move(`${this.use("Pos")}(0, 0, ${num(-h / 2)})`, prism) : prism;
    }
    const align = centred ? "" : `, align=(${this.use("Align")}.CENTER, Align.CENTER, Align.MIN)`;
    // Cone refuses equal radii, as build123d does
    if (r1 === r2) return solid(`${this.use("Cylinder")}(${num(r1)}, ${num(h)}${align})`);
    return solid(`${this.use("Cone")}(${num(r1)}, ${num(r2)}, ${num(h)}${align})`);
  }

  /** OpenSCAD fills a polygon's loops even-odd: islands side by side, holes, a self-crossing outline (polygon2d.ts). */
  polygon(node: CsgNode): Geo | null {
    const points = node.args.get("points");
    const paths = node.args.get("paths");
    if (!Array.isArray(points)) return this.empty("polygon()");
    const pt = (p: CsgValue | undefined): Pt | null => {
      if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1]) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      return [p[0], p[1]];
    };
    const loopOf = (indices: CsgValue[]) => indices.map((i) => (isNum(i) ? pt(points[i]) : null)).filter((p): p is Pt => !!p);
    const loops = Array.isArray(paths)
      ? paths.filter(Array.isArray).map((path) => loopOf(path as CsgValue[]))
      : [points.map(pt).filter((p): p is Pt => !!p)];
    const fill = evenOdd(loops);
    const tuple = (p: Pt) => `(${num(p[0])}, ${num(p[1])})`;
    const list = (loop: Pt[]) => `[${loop.map(tuple).join(", ")}]`;
    if ("xor" in fill) return solid(`${this.helper("_polygon_xor")}([${fill.xor.map(list).join(", ")}])`);
    if (!fill.regions.length) {
      this.warn({ kind: "model", code: "no-area", call: "polygon()" }, "polygon(): its points enclose no area — OpenSCAD renders it as empty, and so does this build");
      return null;
    }
    const faceted = () => {
      const [only] = fill.regions;
      if (fill.regions.length === 1 && !only!.holes.length) return `${this.use("Polygon")}(${list(only!.outer)})`;
      return `${this.helper("_polygon_regions")}([${fill.regions.map((region) => `[${list(region.outer)}, [${region.holes.map(list).join(", ")}]]`).join(", ")}])`;
    };
    // a BOSL2 gear's outline: its flanks as splines through every point (gears.ts), checked against the polygon
    const gear = this.gearOutline(node, fill.regions, faceted);
    if (gear) return gear;
    this.bosl2FacetNote(node);
    // runs of points on a circle → exact arcs (arcs.ts); a loop with none stays a polyline
    if (!this.forceFacets) {
      const policy = this.arcPolicy(node);
      const exact = fill.regions.map((region) => ({ outer: recognizeLoop(region.outer, policy), holes: region.holes.map((hole) => recognizeLoop(hole, policy)) }));
      if (exact.some((region) => region.outer || region.holes.some((hole) => hole))) {
        this.warn({ kind: "exact", code: "exact" }, "polygon(): points on a circle are built as exact arcs and circles — OpenSCAD keeps them as straight edges, so volumes differ from OpenSCAD's by its facet error", node);
        const regions = fill.regions.map((region, i) => {
          const holes = region.holes.map((hole, k) => loopLiteral(exact[i]!.holes[k] ?? hole));
          return `[${loopLiteral(exact[i]!.outer ?? region.outer)}, [${holes.join(", ")}]]`;
        });
        return solid(`${this.helper("_arc_regions")}([${regions.join(", ")}])`);
      }
    }
    return solid(faceted());
  }

  /**
   * The polygon `spur_gear2d()` drew (every BOSL2 spur and ring gear is one), its tooth loop as tip arcs and splines
   * through all of OpenSCAD's points (gears.ts), its bore as the circle — compared in the kernel with the polygon itself
   * (`_exact_area_or`). null: not a gear's polygon, or one drawn for a twisted extrusion (helical, herringbone), which
   * OpenSCAD builds from its own slices and so does this build.
   */
  private gearOutline(node: CsgNode, regions: { outer: Pt[]; holes: Pt[][] }[], faceted: () => string): Geo | null {
    const gear = this.gearCall(node);
    if (!gear) return null;
    const policy = this.arcPolicy(node);
    let lo = 0, hi = 0, sag = 0, gears = 0;
    const area2 = (loop: Pt[]) => loop.reduce((a, p, i) => a + p[0] * loop[(i + 1) % loop.length]![1] - loop[(i + 1) % loop.length]![0] * p[1], 0);
    const box = (pts: Pt[]) => [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
    const one = (loop: Pt[], hole: boolean): string => {
      // the face's area: outer loops add theirs, holes take theirs away; a loop's own area grows by its band
      const side = (hole ? -1 : 1) * Math.sign(area2(loop));
      const g = gearLoop(loop, gear.teeth, gear.external);
      if (g) {
        gears++;
        lo += side > 0 ? g.band[0] : -g.band[1];
        hi += side > 0 ? g.band[1] : -g.band[0];
        sag = Math.max(sag, g.sag);
        return gearLiteral(g);
      }
      const arcs = recognizeLoop(loop, policy);
      if (!arcs) return loopLiteral(loop);
      const stats = exactLoopStats(arcs);
      const d = (hole ? -1 : 1) * (Math.abs(stats.area) - Math.abs(area2(loop)) / 2);
      lo += d;
      hi += d;
      const b = box(loop);
      sag = Math.max(sag, b[0]! - stats.min[0], b[1]! - stats.min[1], stats.max[0] - b[2]!, stats.max[1] - b[3]!);
      return loopLiteral(arcs);
    };
    const exact = regions.map((region) => `[${one(region.outer, false)}, [${region.holes.map((hole) => one(hole, true)).join(", ")}]]`);
    // not the teeth spur_gear2d() draws: the polygon as it is, said by bosl2FacetNote
    if (!gears) return null;
    this.warn({ kind: "exact", code: "exact" }, `${gear.module}(): gear teeth are built as smooth curves through OpenSCAD's points (tip arcs, spline flanks) — OpenSCAD keeps them as straight edges, so areas differ from OpenSCAD's by its facet error`, gear.call);
    const exactCode = `${this.helper("_gear_regions")}([${exact.join(", ")}])`;
    const ref = faceted();
    const key = codeKey(`${exactCode}|${ref}`);
    return {
      code: `${this.helper("_exact_area_or")}("${key}", lambda: ${exactCode}, lambda: ${ref}, "${gear.module}()", ${num(lo)}, ${num(hi)}, ${num(sag)})`,
      maybe: false,
    };
  }

  /**
   * The `spur_gear2d()` call a polygon BOSL2 made belongs to, with its tooth count and whether it is an external gear
   * (`internal = true` is a ring gear's cutter). null outside one, with `hide` (a pie of teeth is no longer symmetric),
   * inside a twisted extrusion, or while translating OpenSCAD's own facets (the reference of an exact construction).
   */
  private gearCall(node: CsgNode): { call: CsgNode; module: string; teeth: number; external: boolean } | null {
    if (this.forceFacets || node.name !== "polygon" || !madeByBosl2(node)) return null;
    const owner = this.bosl2Owner();
    if (!owner || owner.module !== "spur_gear2d") return null;
    const teeth = owner.scope!.get("teeth"), hide = owner.scope!.get("hide"), internal = owner.scope!.get("internal");
    if (typeof teeth !== "number" || !Number.isInteger(teeth) || (hide !== 0 && hide !== null && hide !== undefined)) return null;
    if (this.twisted()) return null;
    // hull() and minkowski() of an outline: OpenSCAD's result is exactly the one of its points (a hull of the polygon,
    // a sum of polygons); of splines the kernel has no exact construction and would tessellate
    if (this.stack.some((n) => n.name === "hull" || n.name === "minkowski")) return null;
    // the author's call that leads here (spur_gear, ring_gear, spur_gear2d…) names the warning
    const call = this.bosl2Call() ?? owner;
    return { call, module: call.module ?? "spur_gear2d", teeth, external: internal !== true };
  }

  /** Inside a `linear_extrude(twist ≠ 0)`: the profile is turned slice by slice (`_twist_extrude`). */
  private twisted(): boolean {
    return this.stack.some((n) => n.name === "linear_extrude" && isNum(n.args.get("twist")) && n.args.get("twist") !== 0);
  }

  polyhedron(node: CsgNode): Geo | null {
    const points = node.args.get("points");
    const faces = node.args.get("faces") ?? node.args.get("triangles");
    if (!Array.isArray(points) || !Array.isArray(faces)) {
      this.error(node, "needs points= and faces=");
      return null;
    }
    // no faces (BOSL2's debug_vnf of a bare path): OpenSCAD builds nothing for it
    if (!faces.length) {
      this.warn({ kind: "model", code: "no-faces", call: "polyhedron()" }, "polyhedron(): it has no faces — OpenSCAD builds nothing for it, and neither does this build", node);
      return null;
    }
    // a VNF BOSL2 computed for a sphere, a rounded cylinder or prismoid: the exact solid (also as a hull's operand)
    const exact = this.bosl2Polyhedron(node);
    if (exact) return exact;
    if (this.hullPoints) return { code: `${this.helper("_polyhedron_hull")}(${literal(points)})`, maybe: true };
    // Not a closed surface as written (closedAsWritten): OpenSCAD's own answer, which export_fgjson renders the way a
    // boolean meets it — repaired into a manifold, or dropped (null) when it cannot be closed.
    const render = node.rendered;
    if (render === null && this.inBoolean) {
      this.warn({ kind: "model", code: "open-dropped", call: "polyhedron()" }, "polyhedron(): its faces do not close into a solid, and OpenSCAD's repair could not close them — in a boolean OpenSCAD drops it, and so does this build", node);
      return null;
    }
    // On its own OpenSCAD exports the open faces as they are, which is no solid: sewn below, and the build says
    // what does not close (6114843, 288157).
    this.bosl2FacetNote(node);
    // A repair past the cap gives way to the faces as written when all that kept them open was points written twice
    // (weldPolyhedron): a long BOSL2 threaded rod (8596 faces) built that way, slowly, where it used to be refused.
    const bigRepair = render?.dim === 3 && render.faces.length > MESH_MAX_FACES;
    if (render?.dim === 3 && !(bigRepair && closedAsWritten(points, faces, true))) {
      if (bigRepair) {
        this.error(node, `OpenSCAD's repair of it has ${render.faces.length.toLocaleString("en-US")} faces — more than the in-browser build sews (${MESH_MAX_FACES.toLocaleString("en-US")})`);
        return null;
      }
      this.warn({ kind: "step", code: "polyhedron-repaired", call: "polyhedron()" }, `polyhedron(): its faces do not close into a solid as written; built from OpenSCAD's repair of it (${render.faces.length} faces)`, node);
      return solid(`${this.helper("_polyhedron")}(${literal(render.points)}, ${literal(render.faces)})`);
    }
    if (bigRepair) this.warn({ kind: "step", code: "polyhedron-big", call: "polyhedron()" }, `polyhedron(): ${faces.length.toLocaleString("en-US")} faces, more than the in-browser build sews from OpenSCAD's repair (${MESH_MAX_FACES.toLocaleString("en-US")}); built from its own faces (its repeated points joined) — slow`, node);
    // points written twice are one (BOSL2's seams, 1011192's slice()): sewn as the closed surface they are; a face
    // whose corners are not on one plane is triangles (OpenSCAD tessellates it too — a face made from it took some
    // plane, and a BOSL2 bezier sheet came out 1.5% off)
    const welded = weldPolyhedron(points, faces);
    return solid(`${this.helper("_polyhedron")}(${literal(welded.points)}, ${literal(fanNonPlanar(welded.points, welded.faces))})`);
  }

  /**
   * BOSL2 shapes with no exact form here, said rather than built silently from facets: threads (helical, threading.scad)
   * and gear teeth (involute flanks, gears.scad) — the node is BOSL2's and a call above it is in that file.
   */
  private bosl2FacetNote(node: CsgNode) {
    if (this.forceFacets || !madeByBosl2(node)) return;
    const from = (file: string) => this.stack.some((n) => n.at?.file.endsWith(file));
    // with the threads drawn plain, what threading.scad still builds from facets is not a thread (a nut's hexagon, also
    // when the nut is attached to a rod) — unless a thread was kept (threadShape's refusals, said there): the BOSL2 call
    // that drew it is a thread module
    const helical = !this.cosmeticThreads || THREAD_SCOPED.includes(this.bosl2Owner()?.module ?? "");
    if (node.name === "polyhedron" && from("BOSL2/threading.scad") && helical) {
      this.warn({ kind: "step", code: "thread-facets" }, "BOSL2 threads are built from OpenSCAD's facets: a helical thread has no exact form in this build, so the STEP has flat facets there", this.bosl2Call() ?? node);
    } else if (node.name === "polygon" && from("BOSL2/gears.scad")) {
      // the spur and ring gears' outlines are splines (gearOutline); what is left: a twisted extrusion's slices, hulls
      // and Minkowski sums, and outlines that are not whole rings of identical teeth (hide=, racks, bevel gears)
      const why = this.twisted()
        ? "a helical or herringbone gear is OpenSCAD's twisted extrusion, built from its own slices"
        : this.stack.some((n) => n.name === "hull" || n.name === "minkowski")
          ? "hull() and minkowski() combine the polygon's own points"
          : "this outline is not one this build reads as gear teeth";
      this.warn({ kind: "step", code: "facets", call: "gear" }, `BOSL2 gear teeth are built from OpenSCAD's facets: ${why}, so the STEP has flat facets there (bores and rims are exact)`, this.bosl2Call() ?? node);
    }
  }

  /** The call from the author's own code that led into BOSL2 here (the innermost module call made outside BOSL2), for a warning to point at. */
  private bosl2Call(): CsgNode | undefined {
    for (let k = this.stack.length - 1; k >= 0; k--) {
      const n = this.stack[k]!;
      if (n.module && n.at && !isBosl2File(n.at.file)) return n;
    }
    return undefined;
  }

  /** Closed contours of lines and Béziers → the face they fill, nonzero (fill.ts); null when they enclose nothing. */
  fill(contours: number[][][]): Geo | null {
    const plan = fillPieces(contours);
    if (!plan) return null;
    return solid(`${this.helper("_fill")}(${literal(plan.contours)}, ${literal(plan.pieces as CsgValue)})`);
  }

  /**
   * The mesh fallback (docs/scad-endgame.md route step 5): a node with no exact counterpart here is built from
   * OpenSCAD's own render of it (tree.ts `rendered`, which the evaluation carries only when csg.ts asked for it —
   * the tree had such a node). Facets, not exact surfaces, and a build warning says so; never silent. No render
   * attached: `why` is the error. A render past MESH_MAX_FACES is refused — sewing costs ~1.5 ms a face in the browser.
   */
  fallback(node: CsgNode, why: string): Geo | null {
    const render: ScadRender | null | undefined = node.rendered;
    if (render === undefined) {
      this.error(node, why);
      return null;
    }
    if (render === null) return null; // OpenSCAD renders nothing for it either
    const name = `${node.name === "multmatrix" && node.call ? node.call : node.name}()`;
    if (render.dim === 2) {
      const contours = contoursOf(render);
      this.warn({ kind: "step", code: "facets", call: name }, `${name}: built from OpenSCAD's own render (mesh fallback) — ${render.points.length} straight edges, not exact curves`, node);
      return this.fill(contours);
    }
    if (render.faces.length > MESH_MAX_FACES) {
      this.error(node, `OpenSCAD's render of it has ${render.faces.length.toLocaleString("en-US")} faces — more than the in-browser build sews (${MESH_MAX_FACES.toLocaleString("en-US")})`);
      return null;
    }
    this.warn({ kind: "step", code: "facets", call: name }, `${name}: built from OpenSCAD's own render (mesh fallback) — ${render.faces.length} flat facets, not exact surfaces`, node);
    return solid(`${this.helper("_polyhedron")}(${literal(render.points)}, ${literal(render.faces)})`);
  }

  /**
   * text() → OpenSCAD's own glyph outlines, exact. OpenSCAD lays the text out (FreeType + HarfBuzz: font, size,
   * spacing, direction, script, halign/valign) and our build of it exports each outline before flattening it
   * (tree.ts `contours`); here they become faces bounded by the very lines and Béziers of the font. No contours:
   * OpenSCAD found no font to shape it with — it renders nothing then (and says so in its log), and so does this.
   * Empty or blank text is OpenSCAD's empty.
   */
  text(node: CsgNode): Geo | null {
    const contours = node.args.get("contours");
    if (!Array.isArray(contours)) {
      const txt = node.args.get("text");
      if (typeof txt === "string" && txt.trim() !== "") {
        this.warn({ kind: "model", code: "no-font", call: "text()" }, "text(): OpenSCAD could not shape this text (no font it can use) — it renders nothing, and neither does this build", node);
      }
      return null;
    }
    return this.fill(contours as number[][][]);
  }

  /**
   * `import(file, layer)` — Write.scad's five DXF fonts exactly, which the engine carries (cad-engine
   * b123d/fonts: OpenSCAD's own DXF import reproduced glyph for glyph). A layer is one glyph, drawn as
   * `Text(ch, 8, font="Write/…", text_align=(LEFT, BOTTOM))`, which lands on the DXF's own coordinates (em = 8 DXF
   * units). The font is the file's basename, case-insensitively. A layer with no ink — missing, blank, write()'s
   * one-past-the-end "undef" — is OpenSCAD's empty. Any other file (an STL, an SVG, the author's own DXF) is built
   * from OpenSCAD's render of it (the mesh fallback: facets, with a warning); without a render it is an error —
   * an empty stand-in would be a silently wrong part.
   */
  importFile(node: CsgNode): Geo | null {
    const file = node.args.get("file") ?? node.positional[0];
    const layer = node.args.get("layer");
    const noFile = "reads a mesh/DXF/SVG file: only OpenSCAD's render of it can stand in here (the mesh fallback), and none came with it";
    const font = typeof file === "string" ? WRITE_FONT_FILES.get(dxfBasename(file)) : undefined;
    if (!font) return this.fallback(node, `${typeof file === "string" ? `${JSON.stringify(file.replace(/^\/project\//, ""))} ` : ""}${noFile}`);
    if (typeof layer !== "string" || layer === "") {
      this.error(node, "a Write.scad font needs layer = (one glyph per layer); the whole font sheet is not supported");
      return null;
    }
    // the .csg writes `origin = [0, 0], scale = 1, center = false` on every import(): those are no-ops
    const origin = node.args.get("origin");
    const scaled = node.args.get("scale");
    if ((Array.isArray(origin) && origin.some((v) => v !== 0)) || (isNum(scaled) && scaled !== 1) || node.args.get("center") === true) {
      this.error(node, "origin= / scale= / center= are not supported for a font layer");
      return null;
    }
    if (!inkedLayers(font.chars).has(layer)) return null;
    const glyph = layer.length === 2 ? layer[0]! : layer;
    this.use("TextAlign");
    return solid(`${this.use("Text")}(${JSON.stringify(glyph)}, 8, font=${JSON.stringify(font.name)}, text_align=(TextAlign.LEFT, TextAlign.BOTTOM))`);
  }

  // ------------------------------------------------------------------ Top level

  /**
   * `part = <code>`, with every located node on a line of its own (MARK): one parenthesized expression, indented by
   * its nesting, each such line ending in `# file:line:col` (and the user module it was called in). The engine
   * reports a build error as `model.py:N` — the line of the innermost call that failed — so a node that starts its
   * own line is a node sourceMap can name. Code without locations (a hand-written .csg) stays one line.
   */
  private layOut(code: string, lines: string[]) {
    if (!code.includes(MARK)) {
      lines.push(`part = ${code}`);
      return;
    }
    lines.push("part = (");
    let depth = 1;
    let quoted = false;
    let text = "";
    let span: (typeof this.spans)[number] | null = null;
    const flush = () => {
      const body = text.trim();
      if (body) {
        const where = span ? `  # ${span.at.file}:${span.at.line}:${span.at.column}${span.module ? ` in ${span.module}()` : ""}`.replace(/[\u0000-\u001f]/g, " ") : "";
        if (span) this.sourceMap[lines.length + 1] = span.at;
        if (span?.caller) this.callers[lines.length + 1] = span.caller;
        // indented by nesting, up to a point: a recursive module nests hundreds deep
        lines.push(`${"    ".repeat(Math.min(lineDepth, 16))}${body}${where}`);
      }
      text = "";
    };
    let lineDepth = depth;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i]!;
      if (!quoted && ch === MARK) {
        const close = code.indexOf(MARK_END, i);
        flush();
        span = this.spans[Number(code.slice(i + 1, close))]!;
        lineDepth = depth;
        i = close;
        continue;
      }
      text += ch;
      if (quoted) {
        if (ch === "\\") text += code[++i] ?? "";
        else if (ch === '"') quoted = false;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === "(" || ch === "[") {
        depth++;
      } else if (ch === ")" || ch === "]") {
        depth--;
      }
    }
    flush();
    lines.push(")");
  }

  /** model.py's line → the .scad call it comes from, filled by run(). */
  sourceMap: Record<number, ScadSpan> = {};
  callers: Record<number, ScadSpan> = {};

  run(nodes: CsgNode[]): string {
    this.inBoolean = live(nodes).length > 1;
    const part = this.union(this.items(this.sameDimension(nodes)));
    const lines: string[] = [
      `"""${this.modelName}, world Z-up, mm. Built from OpenSCAD's evaluation of the .scad — do not edit; edit the .scad."""`,
      // OpenSCAD's geometry lands exactly on itself, where OCCT's booleans can come back wrong in
      // silence: this build checks each one
      BOOLEAN_GUARD_PRAGMA,
    ];
    // num() writes a non-finite number as math.inf / math.nan
    if (this.needsMath || /\bmath\.(inf|nan)\b/.test(part?.code ?? "")) lines.push("import math");
    const imports = [...this.used].sort();
    if (imports.length) lines.push("from build123d import (", ...imports.map((name) => `    ${name},`), ")");
    lines.push(`from cadkit import Appearance, Body, Model${this.needsNote ? ", _note" : ""}`);
    const helpers = Object.keys(RUNTIME_HELPERS).filter((name) => this.helpers.has(name));
    if (helpers.length) {
      lines.push("", "# None is the empty solid (OpenSCAD's empty); these short-circuit it before the operator.");
      // a line each: sourceMap counts model.py's lines by this array (a helper pushed whole put every line after it off)
      for (const name of helpers) lines.push(...RUNTIME_HELPERS[name]!.code.split("\n"));
    }
    lines.push("");
    this.layOut(part?.code ?? "None", lines);
    // an empty top level (every object came out empty: a size parameter left at 0, corpus 193941) is
    // OpenSCAD's "Current top level object is empty." — an empty scene, not a failed build
    const body = `Body("${this.modelName.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase() || "part"}", geometry=part, appearance=Appearance(color="#B0B4BA"))`;
    lines.push("", `model = Model(bodies=[] if part is None else [${body}])`, "");
    return lines.join("\n");
  }
}

const DIMS = new WeakMap<CsgNode, 2 | 3 | null>();
const DIM_2D = new Set(["square", "circle", "polygon", "text", "projection", "offset"]);
const DIM_3D = new Set(["cube", "sphere", "cylinder", "polyhedron", "linear_extrude", "rotate_extrude", "surface", "roof"]);

/**
 * The dimension OpenSCAD's evaluation gives a node: 2 or 3 by what it is, an operator or group its first child's that
 * has one (CsgToModel.sameDimension), null when nothing in it says (empty). `import()` by its render, else by its file.
 */
function dimOf(node: CsgNode): 2 | 3 | null {
  if (DIMS.has(node)) return DIMS.get(node)!;
  let dim: 2 | 3 | null = null;
  if (DIM_2D.has(node.name)) dim = 2;
  else if (DIM_3D.has(node.name)) dim = 3;
  else if (node.name === "import") {
    const file = node.args.get("file") ?? node.positional[0];
    dim = node.rendered ? node.rendered.dim : typeof file === "string" && /\.(dxf|svg)$/i.test(file) ? 2 : typeof file === "string" ? 3 : null;
  } else {
    for (const child of node.children) {
      if (child.modifier === "%" || child.modifier === "*") continue;
      dim = dimOf(child);
      if (dim) break;
    }
  }
  DIMS.set(node, dim);
  return dim;
}

/** `m` as rows of numbers (OpenSCAD reads a 3×3, 3×4 or 4×4); anything else → null. */
function matrixOf(m: CsgValue | undefined): number[][] | null {
  if (!Array.isArray(m) || m.length > 4) return null;
  const rows: number[][] = [];
  for (const row of m) {
    if (!Array.isArray(row) || row.length > 4 || !row.every(isNum)) return null;
    rows.push(row as number[]);
  }
  return rows;
}

/** A 2D render's paths as closed contours (each repeats its first point at the end), the shape fill() takes. */
function contoursOf(render: Extract<ScadRender, { dim: 2 }>): number[][][] {
  return render.paths.map((path) => [...path.map((i) => render.points[i]!), render.points[path[0]!]!].map(([x, y]) => [x!, y!]));
}

/**
 * The same polyhedron with points that are written twice made one: BOSL2's VNFs repeat a seam's points
 * (rotate_sweep the axis point on every meridian, threads every turn's start), which is no opening — OpenSCAD's
 * Manifold conversion merges them too. Twice is closer than the sewing tolerance (WELD), not only the very same
 * coordinates: a point computed two ways differs in its last bits (slice() in Thingiverse 1011192, 1e-14 apart),
 * model.py prints both the same (num(): 15 digits), and the zero-area faces between them sewed into no valid
 * solid. Faces lose the repeats this leaves (a corner written twice in a row) and drop to nothing below three
 * corners. Unchanged (the same arrays) when no point repeats.
 */
export function weldPolyhedron(points: CsgValue[], faces: CsgValue[]): { points: CsgValue[]; faces: CsgValue[] } {
  // a grid of WELD-sized cells: a point within WELD of an earlier one is in that one's cell or a neighbour
  const cells = new Map<string, number[]>();
  const remap: number[] = [];
  const kept: CsgValue[] = [];
  points.forEach((p, i) => {
    const xyz = Array.isArray(p) && p.length === 3 && p.every((v) => typeof v === "number" && Number.isFinite(v)) ? (p as number[]) : null;
    const cell = xyz?.map((v) => Math.round(v / WELD));
    let seen: number | undefined;
    if (xyz && cell) {
      near: for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            for (const k of cells.get(`${cell[0]! + dx},${cell[1]! + dy},${cell[2]! + dz}`) ?? []) {
              const q = kept[k] as number[];
              if (q.every((v, axis) => Math.abs(v - xyz[axis]!) <= WELD)) {
                seen = k;
                break near;
              }
            }
          }
        }
      }
    }
    if (seen !== undefined) remap[i] = seen;
    else {
      if (cell) {
        const key = cell.join(",");
        const here = cells.get(key);
        if (here) here.push(kept.length);
        else cells.set(key, [kept.length]);
      }
      remap[i] = kept.length;
      kept.push(p);
    }
  });
  if (kept.length === points.length) return { points, faces };
  const out: CsgValue[] = [];
  for (const face of faces) {
    if (!Array.isArray(face)) {
      out.push(face);
      continue;
    }
    const f: number[] = [];
    for (const i of face) {
      const j = typeof i === "number" && Number.isInteger(i) && i >= 0 && i < remap.length ? remap[i]! : -1;
      if (f[f.length - 1] !== j) f.push(j);
    }
    if (f.length > 1 && f[0] === f[f.length - 1]) f.pop();
    if (f.length >= 3) out.push(f);
  }
  return { points: kept, faces: out };
}

/**
 * Faces of four or more corners that are not on one plane (farther off their mean plane than 1e-9 of the
 * polyhedron's size), as a fan of triangles from their first corner; the rest as they are.
 */
export function fanNonPlanar(points: CsgValue[], faces: CsgValue[]): CsgValue[] {
  const p = (i: CsgValue) => (Array.isArray(points[i as number]) ? (points[i as number] as number[]) : null);
  let size = 0;
  for (const q of points) if (Array.isArray(q)) for (const v of q) if (typeof v === "number") size = Math.max(size, Math.abs(v));
  const tol = 1e-9 * Math.max(size, 1e-9);
  const out: CsgValue[] = [];
  for (const face of faces) {
    if (!Array.isArray(face) || face.length < 4 || !face.every((i) => p(i))) {
      out.push(face);
      continue;
    }
    const corners = face.map((i) => p(i)!);
    // Newell's normal and the mean point
    const n = [0, 0, 0];
    const c = [0, 0, 0];
    corners.forEach((a, k) => {
      const b = corners[(k + 1) % corners.length]!;
      n[0] += (a[1]! - b[1]!) * (a[2]! + b[2]!);
      n[1] += (a[2]! - b[2]!) * (a[0]! + b[0]!);
      n[2] += (a[0]! - b[0]!) * (a[1]! + b[1]!);
      for (let j = 0; j < 3; j++) c[j]! += a[j]! / corners.length;
    });
    const len = Math.hypot(n[0]!, n[1]!, n[2]!);
    const off = len > 0 ? Math.max(...corners.map((a) => Math.abs(((a[0]! - c[0]!) * n[0]! + (a[1]! - c[1]!) * n[1]! + (a[2]! - c[2]!) * n[2]!) / len))) : Infinity;
    if (off <= tol) out.push(face);
    else for (let k = 1; k + 1 < face.length; k++) out.push([face[0]!, face[k]!, face[k + 1]!]);
  }
  return out;
}

/**
 * Every face has three distinct corners and every edge is used once each way: a closed, consistently wound
 * surface, which _polyhedron sews as written. The same test as export_fgjson.cc `closedAsWritten`, which renders
 * the polyhedra that fail it — this one decides whether to ask for renders at all. `weld`: once points written twice
 * are one (weldPolyhedron) — what decides whether a render too big to sew can give way to the faces as written.
 */
export function closedAsWritten(points: CsgValue | undefined, faces: CsgValue | undefined, weld = false): boolean {
  if (!Array.isArray(points) || !Array.isArray(faces)) return true; // polyhedron() reports the missing argument
  if (weld) ({ points, faces } = weldPolyhedron(points, faces));
  const used = new Map<string, number>();
  for (const face of faces) {
    if (!Array.isArray(face)) return false;
    const f: number[] = [];
    for (const i of face) {
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= points.length) return false;
      if (f[f.length - 1] !== i) f.push(i);
    }
    if (f.length > 1 && f[0] === f[f.length - 1]) f.pop();
    if (f.length < 3) return false;
    for (let k = 0; k < f.length; k++) {
      const key = `${f[k]},${f[(k + 1) % f.length]}`;
      const n = (used.get(key) ?? 0) + 1;
      if (n > 1) return false;
      used.set(key, n);
    }
  }
  for (const key of used.keys()) {
    const [a, b] = key.split(",");
    if (!used.has(`${b},${a}`)) return false;
  }
  return true;
}

/**
 * Whether the tree has a node that only OpenSCAD's render can stand in for (CsgToModel.fallback): an import() of
 * anything but a Write.scad font, surface(), roof(), projection(cut = false), any offset() (its fallback where the
 * exact offset gives up), a polyhedron that is not closed as written (OpenSCAD's repair of it). csg.ts then
 * evaluates once more with the full OpenSCAD build, asking for those renders. A background (`%`) subtree builds
 * nothing and asks for nothing.
 */
export function needsRender(nodes: CsgNode[], options: { cosmeticThreads?: boolean } = {}): boolean {
  const wants = (node: CsgNode, owner?: CsgNode): boolean => {
    if (node.modifier === "%" || node.modifier === "*") return false;
    if (node.name === "surface" || node.name === "roof") return true;
    if (node.name === "projection" && node.args.get("cut") !== true) return true;
    if (node.name === "offset") return true;
    if (node.name === "polyhedron") {
      // a VNF BOSL2 drew for a sphere / rounded cylinder / prismoid is built exactly (bosl2.ts) or, failing that, sewn
      // as written: what keeps it from being closed as written is only repeated vertices (rotate_sweep repeats the
      // axis point on every meridian), which sewing closes — no render to ask for
      if (owner && madeByBosl2(node) && ["spheroid", "cyl", "prismoid"].includes(owner.module!)) return false;
      return !closedAsWritten(node.args.get("points"), node.args.get("faces") ?? node.args.get("triangles"));
    }
    if (node.name === "import") {
      const file = node.args.get("file") ?? node.positional[0];
      return !(typeof file === "string" && WRITE_FONT_FILES.has(dxfBasename(file)));
    }
    // a thread drawn plain (cosmeticThreads): its helix is never built — the same plan threadShape takes
    if (options.cosmeticThreads && THREAD_SCOPED.includes(node.module!) && isBosl2Call(node) && !("why" in plainThread(node))) {
      const shape = attachableShape(node);
      if (shape) return node.children.some((child) => without(child, shape, node));
    }
    const inside = isBosl2Call(node) ? node : owner;
    return node.children.some((child) => wants(child, inside));
  };
  // a thread module's subtree without the shape it no longer builds (what is left: its attachments, children(1))
  const holds = (node: CsgNode, target: CsgNode): boolean => node === target || node.children.some((child) => holds(child, target));
  const without = (node: CsgNode, shape: CsgNode, owner: CsgNode): boolean => {
    if (node === shape) return false;
    if (holds(node, shape)) return node.children.some((child) => without(child, shape, owner));
    return wants(node, owner);
  };
  return nodes.some((node) => wants(node));
}

/**
 * OpenSCAD's evaluated node tree (tree.ts) → model.py. A diagnostic points at the .scad call that made the node
 * it is about; one without a location (a hand-written csg in a test) points at `entry`, line 1. `name` becomes the
 * model's name.
 */
export function transpileTree(nodes: CsgNode[], options: ScadTranspileOptions = {}): ScadTranspileResult {
  const entry = options.entry || "model.scad";
  const place = ({ message, at, note }: Said): ScadDiagnostic => ({ ...(at ?? { file: entry, line: 1, column: 1 }), message, ...(note ? { note } : {}) });
  const converter = new CsgToModel(options.name || "OpenSCAD part", { cosmeticThreads: options.cosmeticThreads });
  const python = converter.run(nodes);
  const errors = converter.errors.map(place);
  return {
    ok: errors.length === 0,
    python: errors.length ? "" : python,
    errors,
    warnings: converter.warnings.map(place),
    sourceMap: errors.length ? {} : converter.sourceMap,
    callers: errors.length ? {} : converter.callers,
    threads: errors.length ? [] : converter.threads,
    threaded: drawsThreads(nodes),
  };
}

/** The same from `.csg` text — OpenSCAD's own notation for the tree, for tests and for pasting a tree in by hand (csg-parse.ts). */
export function transpileCsg(csg: string, options: ScadTranspileOptions = {}): ScadTranspileResult {
  try {
    return transpileTree(parseCsg(csg), options);
  } catch (err) {
    if (!(err instanceof CsgParseError)) throw err;
    return { ok: false, python: "", errors: [{ file: options.entry || "model.scad", line: 1, column: 1, message: `could not read the .csg: ${err.message}` }], warnings: [], sourceMap: {}, callers: {}, threads: [], threaded: false };
  }
}

/** The first line comment is the model name (the same rule by which the first-line docstring of model.py is parsed into the model name). */
export function modelNameFrom(source: string): string {
  const match = source.match(/^\s*\/\/\s*(.+)$/m);
  const raw = (match?.[1] || "OpenSCAD part").trim();
  return raw.slice(0, 60).replace(/["\\]/g, "");
}

// ------------------------------------------------------------------ Project: bundled libraries and entry

/**
 * Bundled libraries: files OpenSCAD users **have by default** and which are therefore never shipped with a project,
 * mounted under OpenSCAD's library path (csg.ts).
 *
 *  - **MCAD**: ships with the OpenSCAD installation, and `include <MCAD/…>` goes through the library path. Included
 *    as-is, with the commit pinned
 *    (generated by scripts/scad-libraries.mjs, LGPL-2.1) — change one character and it is no longer the file the user
 *    thinks they are using.
 *  - **Write.scad**: the lettering library of Thingiverse Customizer (CC-BY-SA), with 6 ways of spelling the path; its 5
 *    DXF fonts are in the engine.
 *  - **`utils/build_plate.scad`**: the print-bed illustration that ships with Thingiverse Customizer; it draws only `%`
 *    background pieces,
 *    which OpenSCAD's render/export never includes anyway. An empty module has **exactly the same output** as the
 *    original, so the original is not included.
 */
/** A file of the bundled libraries (BOSL2, MCAD, Write.scad), as OpenSCAD's positions name it — not the author's. */
function isBundledLibraryFile(file: string): boolean {
  return isBosl2File(file) || SCAD_LIBRARIES[file] !== undefined;
}

export const SCAD_LIBRARIES: ScadFiles = {
  ...MCAD,
  ...WRITE,
  "utils/build_plate.scad": "// Thingiverse Customizer's build plate: %-background plates only, never part of a render.\nmodule build_plate(bp, manX, manY) {}\n",
};

/**
 * Bundled libraries too large for the default bundle: they are `import()`ed only when the source includes/uses them
 * (in the browser, a separate chunk, downloaded once).
 *  - **BOSL2** (BelfrySCAD, BSD-2-Clause, 4.6 MB, generated by scripts/scad-libraries.mjs, included as-is with the
 *    commit pinned): when it is mounted, the scopes of its
 *    shapes (bosl2.ts `BOSL2_SCOPED`) are requested too, so rounded corners can be recognized back as exact geometry.
 */
const LAZY_LIBRARIES: { dir: string; load: () => Promise<ScadFiles>; scope: string[] }[] = [
  { dir: "BOSL2", load: async () => (await import("./libraries/bosl2.js")).BOSL2 as ScadFiles, scope: BOSL2_SCOPED },
];

/** Whether any of `sources` includes or uses a file under `dir/` (`include <BOSL2/std.scad>`). */
export const usesLibrary = (sources: string[], dir: string): boolean =>
  sources.some((text) => new RegExp(`\\b(?:include|use)\\s*<\\s*${dir}/`).test(text));

/**
 * The built-in libraries a project needs (csg.ts mounts them at OpenSCAD's library path): SCAD_LIBRARIES always,
 * a lazy one when a source includes/uses it — with the module names whose scope the evaluation should export.
 */
export async function librariesFor(sources: string[]): Promise<{ files: ScadFiles; scope: string[] }> {
  let files: ScadFiles = SCAD_LIBRARIES;
  const scope: string[] = [];
  for (const lib of LAZY_LIBRARIES) {
    if (!usesLibrary(sources, lib.dir)) continue;
    files = { ...files, ...(await lib.load()) };
    scope.push(...lib.scope);
  }
  return { files, scope };
}

