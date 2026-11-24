// Node tree → model.py semantic pins: the trees are written as .csg text (OpenSCAD's own notation for the tree,
// csg-parse.ts; identical to what our build of OpenSCAD prints with
// `-o x.csg`, full precision), and these pin what the emitted
// Python looks like. Proof at the geometry level is in the fixtures of scripts/scad-diff.mjs (needs wasm, runs real OpenSCAD); this one runs fast and
// does not depend on the kernel. Most pins are pitfalls caught by differential runs on the real corpus, each of which once made the volume off by 15-28% with an identical bounding box. Run from packages/cloud:
//   node_modules/.bin/tsx --test src/transpile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MESH_MAX_FACES, closedAsWritten, needsRender, transpileCsg, transpileTree, pickScadEntry } from "./transpile";
import { parseCsg } from "./csg-parse";
import { BOOLEAN_GUARD_PRAGMA } from "./vendor/pragmas.ts";

function py(csg: string): string {
  const result = transpileCsg(csg);
  assert.deepEqual(result.errors, [], `unexpected errors for:\n${csg}`);
  return result.python;
}

const warnings = (csg: string) => transpileCsg(csg).warnings.map((w) => w.message);
const errors = (csg: string) => transpileCsg(csg).errors.map((e) => e.message);

// ── the .csg as OpenSCAD prints it ────────────────────────────────────────────

test("the parser reads OpenSCAD's own print: named args, modifiers, blocks, bare inf / nan", () => {
  const [node, other] = parseCsg("%multmatrix([[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {\n\tcube(size = [inf, 1, -nan], center = false);\n}\ncolor([1, 0, 0, 1]) group();\n");
  assert.equal(node!.name, "multmatrix");
  assert.equal(node!.modifier, "%");
  // the .csg prints the matrix positionally
  assert.deepEqual(node!.positional[0], [[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
  const size = node!.children[0]!.args.get("size") as number[];
  assert.equal(size[0], Infinity);
  assert.ok(Number.isNaN(size[2]));
  assert.deepEqual(other!.positional, [[1, 0, 0, 1]]);
  assert.equal(other!.children[0]!.name, "group");
});

test("strings come out of the .csg unescaped: the end of one is found by what follows it", () => {
  const [text] = parseCsg('text(text = "Hi "q" \\ x", size = 5, font = "");');
  assert.equal(text!.args.get("text"), 'Hi "q" \\ x');
  assert.equal(text!.args.get("size"), 5);
  // Write.scad's `"` glyph is `layer = """`
  const [glyph] = parseCsg('import(file = "/libraries/write/Letters.dxf", layer = """, origin = [0, 0], scale = 1);');
  assert.equal(glyph!.args.get("layer"), '"');
});

// ── structure ────────────────────────────────────────────────────────────────

test("% subtrees are excluded, # is built, and an empty top level is an empty scene", () => {
  const out = py("cube(size = [1, 1, 1], center = false);\n%sphere($fn = 0, $fa = 12, $fs = 2, r = 5);\n#multmatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 2], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }");
  assert.doesNotMatch(out, /Sphere/);
  assert.match(out, /Pos\(0, 0, 2\) \* Box/);
  // every object empty is OpenSCAD's "Current top level object is empty" — an empty scene, not a failed build
  assert.match(py("group();\ncube(size = [0, 1, 1], center = false);"), /^part = None$/m);
  assert.match(py("group();"), /^model = Model\(bodies=\[\] if part is None else \[Body\(/m);
});

test("every model.py turns the engine's boolean guard on, on the line after its name", () => {
  // OpenSCAD's coincident geometry is what the guard is for; agent models build without it
  const lines = py("cube(size = [1, 1, 1], center = false);").split("\n");
  assert.match(lines[0]!, /^"""/);
  assert.equal(lines[1], BOOLEAN_GUARD_PRAGMA);
});

test("a group (every module call and for loop) is spliced into its parent: one n-ary union, not nested ones", () => {
  const out = py("group() { cube(size = [1, 1, 1], center = false); group() { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); sphere($fn = 0, $fa = 12, $fs = 2, r = 2); } }");
  assert.match(out, /^part = _union\(\[Box\([^\n]*\), Sphere\(1\), Sphere\(2\)\]\)$/m);
  // sixteen at a time, each group one boolean
  assert.match(out, /g\[0\] \+ Compound\(g\[1:\]\)/);
  assert.match(py("union() { cube(size = [1, 1, 1], center = false); sphere($fn = 0, $fa = 12, $fs = 2, r = 1); }"), /^part = \(Box\([^\n]*\) \+ Sphere\(1\)\)$/m);
});

test("difference is ONE cut: the first child minus every other, a group of tools spliced in", () => {
  const out = py("difference() { cube(size = [10, 10, 10], center = false); group() { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); sphere($fn = 0, $fa = 12, $fs = 2, r = 2); } %cube(size = [3, 3, 3], center = false); }");
  assert.match(out, /^part = \(Box\(10, 10, 10, [^\n]*\) - Compound\(\[Sphere\(1\), Sphere\(2\)\]\)\)$/m);
  // an empty base empties it; an empty tool drops out
  assert.match(py("difference() { cube(size = [0, 1, 1], center = false); sphere($fn = 0, $fa = 12, $fs = 2, r = 1); }"), /^part = None$/m);
  assert.match(py("difference() { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); group(); }"), /^part = Sphere\(1\)$/m);
});

test("intersection: every child is one operand, and an empty one (group(); a cube(0)) empties it — as in OpenSCAD", () => {
  assert.match(py("intersection() { cube(size = [10, 10, 10], center = false); sphere($fn = 0, $fa = 12, $fs = 2, r = 8); }"), /^part = \(Box\([^\n]*\) & Sphere\(8\)\)$/m);
  assert.match(py("cube(size = [1, 1, 1], center = false);\nintersection() { cube(size = [10, 10, 10], center = false); group(); }"), /^part = Box\(1, 1, 1,/m);
});

test("color() and render() are transparent; color says it was dropped", () => {
  const out = transpileCsg("color([1, 0, 0, 1]) { render(convexity = 2) { cube(size = [2, 2, 2], center = true); } }");
  assert.match(out.python, /^part = Box\(2, 2, 2\)$/m);
  assert.ok(out.warnings.some((w) => /color\(\) shows in the preview only/.test(w.message)));
});

// ── transforms ───────────────────────────────────────────────────────────────

test("multmatrix splits into the moves it is — translation, extrinsic rotation, mirror, scale", () => {
  assert.match(py("multmatrix([[1, 0, 0, 5], [0, 1, 0, -2], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }"), /Pos\(5, -2, 0\) \* Box/);
  assert.match(py("multmatrix([[0.8660254037844386, -0.5, 0, 0], [0.5, 0.8660254037844386, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }"), /Rot\(0, 0, 30\) \* Box/);
  // rotate([35, 90, 0]) is extrinsic Rz*Ry*Rx: never build123d's intrinsic Rot(35, 90, 0)
  const tilted = py("multmatrix([[0, 0.573576436351046, 0.8191520442889918, 0], [0, 0.8191520442889918, -0.573576436351046, 0], [-1, 0, 0, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }");
  assert.doesNotMatch(tilted, /Rot\(35, 90, 0\)/);
  assert.match(py("multmatrix([[-1, -0, -0, 0], [-0, 1, -0, 0], [-0, -0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }"), /mirror\(Box\([^)]*\)\), about=Plane\.YZ\)/);
  assert.match(py("multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]) { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); }"), /scale\(Sphere\(1\), 2\)/);
  // a rotated uniform scale measures 2.0000000000000004 off the rotated axes: it is 2
  assert.match(py("multmatrix([[1.4142135623730951, -1.4142135623730951, 0, 0], [1.4142135623730951, 1.4142135623730951, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]) { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); }"), /Rot\(0, 0, 45\) \* scale\(Sphere\(1\), 2\)/);
  const stretched = transpileCsg("multmatrix([[2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); }");
  assert.match(stretched.python, /scale\(Sphere\(1\), \[2, 1, 1\]\)/);
  assert.ok(stretched.warnings.some((w) => /BSpline/.test(w.message)));
  // a shear is exact too: rotate, per-axis scale, rotate
  assert.match(py("multmatrix([[1, 0, 0.5, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }"), /Rot\(0, [-\d.]+, 0\) \* scale\(Rot\(0, [-\d.]+, 0\) \* Box/);
  // a matrix that flattens a solid removes it (scale([1, 1, 0]) keeps a flat child, at run time)
  assert.ok(warnings("multmatrix([[1, 0, 0, 0], [0, 1, 0, 0], [1, 1, 0, 0], [0, 0, 0, 1]]) { sphere($fn = 0, $fa = 12, $fs = 2, r = 1); }").some((w) => /flattens the object/.test(w)));
  // a flat object takes only the 2D part of its matrix (OpenSCAD's Transform2d): z is free, and a uniform 2D scale is a
  // similarity; a z offset does not lift it
  assert.match(py("multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]) { square(size = [1, 1], center = false); }"), /scale\(Rectangle\([^\n]*\), 2\)/);
  assert.match(py("multmatrix([[1, 0, 0, 3], [0, 1, 0, 0], [0, 0, 1, 0.1], [0, 0, 0, 1]]) { square(size = [1, 1], center = false); }"), /Pos\(3, 0, 0\) \* Rectangle/);
});

test("scale([s, s, sz]) over translate / linear_extrude folds into a uniform 2D scale, so the prism keeps its planes", () => {
  // every Write.scad glyph is this shape; a per-axis scale of the finished prism turns each plane into a BSpline
  const folded = transpileCsg("multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 3, 0], [0, 0, 0, 1]]) { multmatrix([[1, 0, 0, 4], [0, 1, 0, 2], [0, 0, 1, 1], [0, 0, 0, 1]]) { linear_extrude(height = 2, center = true, $fn = 0, $fa = 12, $fs = 2) { square(size = [3, 2], center = false); } } }");
  assert.match(folded.python, /^part = Pos\(8, 4, 0\) \* extrude\(scale\(Rectangle\(3, 2, [^\n]*\), 2\), 6\)$/m);
  assert.ok(!folded.warnings.some((w) => /BSpline/.test(w.message)));
  // not folded: x and y differ, a twisted extrude
  assert.match(py("multmatrix([[2, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1.5, 0], [0, 0, 0, 1]]) { linear_extrude(height = 2) { circle($fn = 0, $fa = 12, $fs = 2, r = 3); } }"), /scale\(extrude\(Circle\(3\), 2, dir=\(0, 0, 1\)\), \[2, 1, 1\.5\]\)/);
  assert.doesNotMatch(py("multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { linear_extrude(height = 4, twist = 90, slices = 8) { square(size = [3, 3], center = false); } }"), /extrude\(scale\(/);
});

test("resize(newsize, auto) rescales the built shape at run time; auto comes out of the .csg as numbers", () => {
  const out = py("resize(newsize = [10,0,0], auto = [1,1,1], convexity = 0) { sphere($fn = 0, $fa = 12, $fs = 2, r = 2); }");
  assert.match(out, /^part = _resize\(Sphere\(2\), \[10, 0, 0\], \[True, True, True\]\)$/m);
  // an auto axis takes the factor of the axis with the largest new size (OpenSCAD's maxdim)
  assert.match(out, /if want\[i\] > top:/);
});

test("a matrix with nan / inf removes its object, as OpenSCAD does; the rest still builds", () => {
  const out = transpileCsg("cube(size = [5, 5, 5], center = false);\nmultmatrix([[1, nan, nan, 0], [0, nan, nan, 0], [0, nan, nan, 0], [0, 0, 0, 1]]) { cube(size = [3, 3, 3], center = false); }\nmultmatrix([[inf, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [3, 3, 3], center = false); }");
  assert.ok(out.ok);
  assert.match(out.python, /^part = Box\(5, 5, 5, align=[^\n]*\)$/m);
  assert.ok(out.warnings.some((w) => /contains nan or inf/.test(w.message)));
});

// ── primitives ───────────────────────────────────────────────────────────────

test("a size <= 0 or not finite is OpenSCAD's empty, said once — the rest of the model builds", () => {
  const out = transpileCsg([
    "cube(size = [0, 42, 1.6], center = false);",
    "circle($fn = 0, $fa = 12, $fs = 2, r = 0);",
    "cylinder($fn = 0, $fa = 12, $fs = 2, h = 0, r1 = 3, r2 = 3, center = false);",
    "cylinder($fn = 0, $fa = 12, $fs = 2, h = 1, r1 = 0, r2 = 0, center = false);",
    "cylinder($fn = 0, $fa = 12, $fs = 2, h = -nan, r1 = 1, r2 = 1, center = false);",
    "sphere($fn = 0, $fa = 12, $fs = 2, r = -2);",
    "cube(size = [inf, 1, 1], center = false);",
    'text(text = "", size = 10);',
    "polygon(points = [[0, 0], [1, 1]], paths = undef, convexity = 1);",
    "linear_extrude(height = 0) { square(size = [10, 10], center = false); }",
    "multmatrix([[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }",
  ].join("\n"));
  assert.deepEqual(out.errors, []);
  assert.match(out.python, /^part = Pos\(5, 0, 0\) \* Box\(1, 1, 1,/m);
  assert.ok(out.warnings.some((w) => /cube\(\): a size <= 0 builds nothing/.test(w.message)));
  // one zero radius is a cone, not empty; a radius a rounding error from 0 is an apex
  assert.match(py("cylinder($fn = 0, $fa = 12, $fs = 2, h = 2, r1 = 0, r2 = 3, center = false);"), /Cone\(0, 3, 2,/);
  assert.match(py("cylinder($fn = 0, $fa = 12, $fs = 2, h = 2, r1 = 1.5e-15, r2 = 3, center = false);"), /Cone\(0, 3, 2,/);
});

test("cube / square grow from the origin unless centred; r1 = r2 is a Cylinder, otherwise a Cone", () => {
  assert.match(py("cube(size = [1, 2, 3], center = false);"), /Box\(1, 2, 3, align=\(Align\.MIN, Align\.MIN, Align\.MIN\)\)/);
  assert.match(py("cube(size = [1, 2, 3], center = true);"), /Box\(1, 2, 3\)$/m);
  assert.match(py("square(size = [4, 5], center = false);"), /Rectangle\(4, 5, align=\(Align\.MIN, Align\.MIN\)\)/);
  assert.match(py("cylinder($fn = 0, $fa = 12, $fs = 2, h = 8, r1 = 3, r2 = 3, center = false);"), /Cylinder\(3, 8, align=\(Align\.CENTER, Align\.CENTER, Align\.MIN\)\)/);
  assert.match(py("cylinder($fn = 0, $fa = 12, $fs = 2, h = 8, r1 = 3, r2 = 3, center = true);"), /Cylinder\(3, 8\)$/m);
  assert.match(py("cylinder($fn = 0, $fa = 12, $fs = 2, h = 3, r1 = 2, r2 = 1, center = false);"), /Cone\(2, 1, 3, align=/);
});

test("$fn 3..12 is a polygon / prism / polyhedron on purpose; above it the curve is exact and says so", () => {
  assert.match(py("circle($fn = 6, $fa = 12, $fs = 2, r = 3);"), /RegularPolygon\(3, 6\)/);
  assert.match(py("cylinder($fn = 6, $fa = 12, $fs = 2, h = 3, r1 = 2, r2 = 2, center = false);"), /extrude\(RegularPolygon\(2, 6\), 3\)/);
  // a cone at $fn <= 12 is a pyramid / frustum sewn from planar faces
  assert.match(py("cylinder($fn = 4, $fa = 12, $fs = 2, h = 1.5, r1 = 1.5, r2 = 0, center = false);"), /^part = _cone_poly\(1\.5, 0, 1\.5, 4\)$/m);
  assert.match(py("cylinder($fn = 6, $fa = 12, $fs = 2, h = 3, r1 = 2, r2 = 1, center = true);"), /Pos\(0, 0, -1\.5\) \* _cone_poly\(2, 1, 3, 6\)/);
  // the oracle reads sphere(r = 10, $fn = 6) as 2625.000 and so does this build (3563883: hulls of them)
  assert.match(py("sphere($fn = 6, $fa = 12, $fs = 2, r = 10);"), /^part = _sphere_poly\(10, 6\)$/m);
  const exact = transpileCsg("sphere($fn = 48, $fa = 12, $fs = 2, r = 10);");
  assert.match(exact.python, /^part = Sphere\(10\)$/m);
  assert.ok(exact.warnings.some((w) => /\$fn=48: the preview shows/.test(w.message)));
});

test("warnings say what they are about: a STEP more exact than the preview, a STEP short of it, a model that builds nothing", () => {
  const note = (csg: string) => transpileCsg(csg).warnings.map((w) => w.note);
  assert.deepEqual(note("sphere($fn = 48, $fa = 12, $fs = 2, r = 10);"), [{ kind: "exact", code: "exact" }]);
  assert.deepEqual(note("cube(size = [0, 1, 1], center = false);"), [{ kind: "model", code: "zero-size", call: "cube()" }]);
  assert.deepEqual(note("color([1, 0, 0, 1]) { cube(size = [1, 1, 1], center = false); }"), [{ kind: "step", code: "color" }]);
  // every warning the transpiler gives carries one
  assert.ok(transpileCsg("linear_extrude(height = 5, center = false, convexity = 1, twist = 90, slices = 6, scale = [1, 1]) { square(size = [2, 2], center = true); }").warnings.every((w) => w.note));
});

test("a warning inside a bundled library points at the author's call that led there, not at the library's line", () => {
  const nodes = parseCsg("group() { sphere($fn = 48, $fa = 12, $fs = 2, r = 10); }");
  nodes[0]!.at = { file: "model.scad", line: 7, column: 3 };
  nodes[0]!.children[0]!.at = { file: "BOSL2/builtins.scad", line: 34, column: 5 };
  const [w] = transpileTree(nodes).warnings;
  assert.equal(`${w!.file}:${w!.line}`, "model.scad:7");
});

test("sphere(style = \"octa\") at $fn <= 12 is OpenSCAD 2026's subdivided octahedron; \"orig\" stays the ring sphere", () => {
  assert.match(py('sphere($fn = 8, $fa = 12, $fs = 2, r = 10, style = "octa");'), /^part = _sphere_octa\(10, 8\)$/m);
  assert.match(py('sphere($fn = 8, $fa = 12, $fs = 2, r = 10, style = "orig");'), /^part = _sphere_poly\(10, 8\)$/m);
  // the helper is OpenSCAD's construction: 4k² + 2 points and 8k² triangles for k = (n + 3) // 4 subdivisions
  const helper = py('sphere($fn = 12, $fa = 12, $fs = 2, r = 10, style = "octa");');
  assert.match(helper, /def _sphere_octa\(r, num_fragments\):/);
  assert.match(helper, /n = max\(1, \(num_fragments \+ 3\) \/\/ 4\)/);
  // above 12 the sphere is exact, whatever its style
  assert.match(py('sphere($fn = 32, $fa = 12, $fs = 2, r = 10, style = "octa");'), /^part = Sphere\(10\)$/m);
});

test("a fractional $fn rounds up, as OpenSCAD 2026 counts it (2025 truncated); anything above 0 and below 3 is a triangle", () => {
  assert.match(py("circle($fn = 5.5, $fa = 12, $fs = 2, r = 3);"), /RegularPolygon\(3, 6\)/);
  assert.match(py("circle($fn = 0.5, $fa = 12, $fs = 2, r = 3);"), /RegularPolygon\(3, 3\)/);
  assert.match(py("circle($fn = 12.5, $fa = 12, $fs = 2, r = 3);"), /Circle\(3\)/);
  // rotate_extrude's sections: ceil(ceil($fn) * angle / 360)
  assert.match(py("rotate_extrude($fn = 5.5, $fa = 12, $fs = 2, angle = 90, start = 0, convexity = 1) { square(size = [1, 1], center = false); }"), /_revolve_facets\([^\n]*, 90, 0, 2\)/);
});

test("polygon() fills its loops even-odd: holes, side-by-side islands, a self-crossing outline; polyhedron sews its face list", () => {
  const holed = py("polygon(points = [[0, 0], [9, 0], [9, 9], [0, 9], [3, 3], [6, 3], [6, 6], [3, 6]], paths = [[0, 1, 2, 3], [4, 5, 6, 7]], convexity = 1);");
  assert.match(holed, /^part = _polygon_regions\(\[\[\[\(0, 0\), \(9, 0\), \(9, 9\), \(0, 9\)\], \[\[\(3, 3\), \(6, 3\), \(6, 6\), \(3, 6\)\]\]\]\]\)$/m);
  // two paths side by side are two islands, not a boundary and a hole outside it
  const islands = py("polygon(points = [[0, 0], [1, 0], [1, 1], [0, 1], [2, 0], [3, 0], [3, 1], [2, 1]], paths = [[0, 1, 2, 3], [4, 5, 6, 7]], convexity = 1);");
  assert.match(islands, /_polygon_regions\(\[\[\[\(0, 0\), \(1, 0\), \(1, 1\), \(0, 1\)\], \[\]\], \[\[\(2, 0\), \(3, 0\), \(3, 1\), \(2, 1\)\], \[\]\]\]\)/);
  // a bow tie is its two triangles, cut at the crossing; they touch there, so they are xor-ed at run time
  const bowtie = py("polygon(points = [[0, 0], [10, 10], [10, 0], [0, 10]], paths = undef, convexity = 1);");
  assert.match(bowtie, /^part = _polygon_xor\(\[\[\(10, 0\), \(10, 10\), \(5, 5\)\], \[\(0, 0\), \(5, 5\), \(0, 10\)\]\]\)$/m);
  // rotate_extrude($fn <= 12) is its facets
  assert.match(py("rotate_extrude(angle = 360, start = 180, convexity = 2, $fn = 6, $fa = 12, $fs = 2) { multmatrix([[1, 0, 0, 10], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { circle($fn = 6, $fa = 12, $fs = 2, r = 2); } }"), /^part = _revolve_facets\(Pos\(10, 0, 0\) \* RegularPolygon\(2, 6\), 360, 180, 6\)$/m);
  assert.match(py("rotate_extrude(angle = 100, start = 0, convexity = 2, $fn = 8, $fa = 12, $fs = 2) { square(size = [2, 2], center = false); }"), /_revolve_facets\([^\n]*, 100, 0, 3\)$/m);
  // loops crossing each other are xor-ed at run time
  assert.match(py("polygon(points = [[0, 0], [4, 0], [4, 4], [0, 4], [2, 2], [6, 2], [6, 6], [2, 6]], paths = [[0, 1, 2, 3], [4, 5, 6, 7]], convexity = 1);"), /^part = _polygon_xor\(/m);
  assert.match(py("polygon(points = [[0, 0], [9, 0], [0, 9]], paths = undef, convexity = 1);"), /Polygon\(\[\(0, 0\), \(9, 0\), \(0, 9\)\]\)/);
  const out = py("polyhedron(points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]], convexity = 1);");
  assert.match(out, /^part = _polyhedron\(\[\[0, 0, 0\], \[1, 0, 0\], \[0, 1, 0\], \[0, 0, 1\]\], \[\[0, 2, 1\]/m);
  assert.match(out, /Solid\(Shell\(tris\)\)/);
});

test("a polyhedron that only gives hull() its points is not sewn: through moves and groups yes, through a boolean no", () => {
  // corpus 1291337 hulls "tetrahedra" whose faces repeat an index ([0, 0, 1]), 1707429 a soup of loose
  // triangles: OpenSCAD's hull takes their points, and sewing them into solids failed the whole build
  const tet = "polyhedron(points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces = [[0, 0, 1], [0, 0, 2], [0, 0, 3], [1, 2, 3]], convexity = 1);";
  const moved = py(`hull() { group() { multmatrix([[2, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { ${tet} } } sphere(r = 1); }`);
  assert.match(moved, /_polyhedron_hull\(\[\[0, 0, 0\], \[1, 0, 0\], \[0, 1, 0\], \[0, 0, 1\]\]\)/);
  assert.doesNotMatch(moved, /_polyhedron\(/);
  assert.match(moved, /^def _polyhedron_hull\(points\):\n    cloud = Compound\(\[Vertex\(\*p\) for p in points\]\)$/m);
  // a flat one has no hull of its own: its points go to the outer hull as they are
  assert.match(moved, /^        return cloud {2}# flat/m);
  assert.match(moved, /^    return hull\(\[cloud\]\)$/m);
  // a difference inside the hull needs the solid itself
  const cut = py(`hull() { difference() { ${tet} cube(size = [0.1, 0.1, 0.1], center = false); } }`);
  assert.match(cut, /_polyhedron\(\[\[0, 0, 0\]/);
  assert.doesNotMatch(cut, /_polyhedron_hull/);
  // and outside hull() it is sewn as before
  assert.doesNotMatch(py(tet.replace("[[0, 0, 1], [0, 0, 2], [0, 0, 3], [1, 2, 3]]", "[[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]]")), /_polyhedron_hull/);
});

test("text() is OpenSCAD's own glyph outlines, exact: nonzero fill, faces counter-clockwise, curves kept", () => {
  // TrueType winding: outer contours clockwise, holes counter-clockwise; a square "o" with a quadratic top edge
  const o = "[[0, 0], [0, 10], [5, 12, 10, 10], [10, 0], [0, 0]], [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]";
  const out = py(`text(text = "o", size = 10, contours = [${o}]);`);
  // the curve stays a curve; the outer contour comes out reversed (counter-clockwise), control point and all
  assert.match(out, /^part = _fill\(\[\[\[0, 0\], \[10, 0\], \[10, 10\], \[5, 12, 0, 10\], \[0, 0\]\], \[\[2, 2\], \[8, 2\], \[8, 8\], \[2, 8\], \[2, 2\]\]\], \[\[0, \[1\]\]\]\)$/m);
  assert.match(out, /Bezier\(at, \(seg\[0\], seg\[1\]\), end\)/);
  // "®": a ring, and inside its hole a filled R with its own hole — four contours, two filled pieces
  const ring = "[[0, 0], [0, 20], [20, 20], [20, 0], [0, 0]], [[2, 2], [18, 2], [18, 18], [2, 18], [2, 2]]";
  const r = "[[5, 5], [5, 15], [15, 15], [15, 5], [5, 5]], [[7, 7], [13, 7], [13, 13], [7, 13], [7, 7]]";
  assert.match(py(`text(text = "R", size = 10, contours = [${ring}, ${r}]);`), /, \[\[0, \[1\]\], \[2, \[3\]\]\]\)$/m);
  // an accent over its letter (both clockwise, overlapping, neither inside the other): both filled, fused
  const overlap = "[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]], [[5, 8], [5, 14], [9, 14], [9, 8], [5, 8]]";
  assert.match(py(`text(text = "é", size = 10, contours = [${overlap}]);`), /, \[\[0, \[\]\], \[1, \[\]\]\]\)$/m);
  // OpenSCAD had no font to shape it with: it renders nothing, and says so; blank text is plain empty
  assert.ok(warnings('text(text = "Hi", size = 5);').some((w) => /could not shape this text/.test(w)));
  assert.match(py('text(text = "Hi", size = 5);'), /^part = None$/m);
  assert.deepEqual(warnings('text(text = "  ", size = 5, contours = []);'), []);
});

test("import() of a Write.scad font layer draws the engine's copy of that glyph; anything else is an error", () => {
  const glyph = py('import(file = "/libraries/write/orbitron.dxf", layer = "a_", origin = [0, 0], scale = 1, center = false, convexity = 1, $fn = 0, $fa = 12, $fs = 2, timestamp = 0);');
  // one glyph per layer, at the DXF's own coordinates: em = 8 DXF units; the font named literally so the engine preloads it
  assert.match(glyph, /^part = Text\("a", 8, font="Write\/orbitron", text_align=\(TextAlign\.LEFT, TextAlign\.BOTTOM\)\)$/m);
  assert.match(py('import(file = "/project/Letters.dxf", layer = """, origin = [0, 0], scale = 1);'), /Text\("\\"", 8, font="Write\/Letters"/);
  // a layer with no ink (a blank, write()'s one-past-the-end "undef") is OpenSCAD's empty
  assert.match(py('import(file = "/libraries/write/Letters.dxf", layer = " ", origin = [0, 0], scale = 1);'), /^part = None$/m);
  assert.match(py('import(file = "/libraries/write/Letters.dxf", layer = "undef", origin = [0, 0], scale = 1);'), /^part = None$/m);
  for (const file of ["/project/part.stl", "/project/logo.dxf", "/project/shape.svg"]) {
    assert.ok(errors(`import(file = "${file}", layer = "", origin = [0, 0], scale = 1);`).some((e) => /only OpenSCAD's render of it can stand in here/.test(e)), file);
  }
  assert.ok(errors('import(file = "/libraries/write/Letters.dxf", layer = "", origin = [0, 0], scale = 1);').some((e) => /needs layer =/.test(e)));
  assert.ok(errors('import(file = "/libraries/write/Letters.dxf", layer = "A", origin = [0, 0], scale = 2);').some((e) => /not supported for a font layer/.test(e)));
  assert.ok(errors('surface(file = "/project/hm.dat", center = false, invert = false, timestamp = 0);').some((e) => /heightmap/.test(e)));
});

// ── operators ────────────────────────────────────────────────────────────────

test("hull() is the ENGINE operator, and a group child (a for loop) goes in as its raw items — no pre-fuse", () => {
  const out = py("hull() { group() { multmatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { circle($fn = 0, $fa = 12, $fs = 2, r = 3); } multmatrix([[1, 0, 0, 8], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { circle($fn = 0, $fa = 12, $fs = 2, r = 3); } } }");
  assert.match(out, /^part = _nz\(hull\(\[Circle\(3\), Pos\(8, 0, 0\) \* Circle\(3\)\]\)\)$/m);
  assert.match(out, /^\s+hull,$/m, "hull must be imported from the dialect");
  assert.doesNotMatch(out, /def _hull|ThreePointArc/, "the hull construction is the engine's job");
});

test("minkowski folds left through the engine operator; a lone child is itself", () => {
  const out = py("minkowski(convexity = 0) { cube(size = [10, 8, 4], center = false); sphere($fn = 0, $fa = 12, $fs = 2, r = 2); cube(size = [1, 1, 3], center = false); }");
  assert.match(out, /^part = _nz\(minkowski\(minkowski\(Box\(10, 8, 4, [^\n]*\), Sphere\(2\)\), Box\(1, 1, 3, [^\n]*\)\)\)$/m);
  assert.doesNotMatch(out, /_offset|_note/);
  assert.match(py("minkowski(convexity = 0) { cube(size = [10, 10, 10], center = false); %cube(size = [2, 2, 2], center = false); }"), /^part = Box\(10, 10, 10,/m);
  // a union child is ONE operand, fused first: A ⊕ (B ∪ C) is not (A ⊕ B) ⊕ C (a fixture was 80% off)
  const fused = py("minkowski(convexity = 0) { union() { cube(size = [10, 10, 3], center = false); sphere($fn = 0, $fa = 12, $fs = 2, r = 1); } cube(size = [2, 2, 2], center = true); }");
  assert.match(fused, /^part = _nz\(minkowski\(\(Box\(10, 10, 3, [^\n]*\) \+ Sphere\(1\)\), Box\(2, 2, 2\)\)\)$/m);
});

test("offset(r)/offset(delta) are the dialect's 2D offset with the right Kind; chamfer has no kernel op", () => {
  assert.match(py("offset(r = 3, $fn = 0, $fa = 12, $fs = 2) { square(size = [10, 10], center = false); }"), /^part = _offset\(Rectangle\([^\n]*\), 3, Kind\.ARC\)$/m);
  assert.match(py("offset(delta = -1, chamfer = false, $fn = 0, $fa = 12, $fs = 2) { square(size = [10, 10], center = false); }"), /^part = _offset\(Rectangle\([^\n]*\), -1, Kind\.INTERSECTION\)$/m);
  assert.match(py("offset(delta = 0, chamfer = false) { square(size = [10, 10], center = false); }"), /^part = Rectangle\(10, 10,/m);
  assert.ok(errors("offset(delta = 1, chamfer = true, $fn = 0, $fa = 12, $fs = 2) { square(size = [3, 3], center = false); }").some((e) => /chamfer = true/.test(e)));
});

test("an offset grown into one region is one region: the faces build123d grows one by one are fused back (745296)", () => {
  // OpenSCAD offsets two squares 1 mm apart, grown 2 mm, as one region; build123d leaves two overlapping faces
  const out = py("offset(r = 2, $fn = 0, $fa = 12, $fs = 2) { square(size = [10, 10], center = false); multmatrix([[1, 0, 0, 11], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { square(size = [10, 10], center = false); } }");
  assert.match(out, /^def _offset\(shape, amount, kind\):$/m);
  assert.match(out, /^    return _union\(list\(faces\)\) if amount > 0 and len\(faces\) > 1 else grown$/m, "only growing makes faces meet");
  assert.match(out, /^def _union\(parts\):$/m, "_offset brings _union with it");
});

test("a 2D mirror stays face up: a face it turned over (-Z) is turned back, a 3D mirror is build123d's own (5353030)", () => {
  // mirror([1, 0]) hull() { … }: a bare Face mirrored turns over in build123d, and joins no face up
  const flat = py("multmatrix([[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { hull() { circle($fn = 0, $fa = 12, $fs = 2, r = 4); multmatrix([[1, 0, 0, 10], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { circle($fn = 0, $fa = 12, $fs = 2, r = 4); } } }");
  assert.match(flat, /^part = _mirror_flat\([^\n]*, Plane\.YZ\)$/m);
  assert.match(flat, /^    if all\(face\.normal_at\(\)\.Z > 0 for face in faces\):$/m, "a mirror that kept every face up is left as it is");
  assert.match(flat, /^    return Compound\(\[face if face\.normal_at\(\)\.Z > 0 else -face for face in faces\]\)$/m);
  const solid = py("multmatrix([[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) { cube(size = [1, 1, 1], center = false); }");
  assert.doesNotMatch(solid, /_mirror_flat/);
});

test("projection(cut = true) is the z = 0 section; cut = false needs OpenSCAD's render", () => {
  assert.match(py("linear_extrude(height = 1) { projection(cut = true, convexity = 0) { cube(size = [4, 4, 4], center = true); } }"), /extrude\(section\(Box\(4, 4, 4\), section_by=Plane\.XY\), 1, dir=\(0, 0, 1\)\)/);
  assert.ok(errors("projection(cut = false, convexity = 0) { cube(size = [4, 4, 4], center = true); }").some((e) => /cut = false \(the outline seen from \+Z\) has no kernel op/.test(e)));
});

test("linear_extrude: height <= 0 is empty, centre moves it down, scale= is a one-step loft, twist slices and says so", () => {
  assert.match(py("linear_extrude(height = 2, center = true, $fn = 0, $fa = 12, $fs = 2) { square(size = [4, 4], center = false); }"), /^part = Pos\(0, 0, -1\) \* extrude\(Rectangle\(4, 4, [^\n]*\), 2, dir=\(0, 0, 1\)\)$/m);
  assert.match(py("linear_extrude(height = 10, scale = 0.5, $fn = 0, $fa = 12, $fs = 2) { square(size = [4, 4], center = false); }"), /_twist_extrude\(Rectangle\([^\n]*\), 10, 0, \[0\.5, 0\.5\], 1\)/);
  // scale=0 is the manual's pyramid (a Vertex tip); a negative scale is OpenSCAD's 0
  assert.match(py("linear_extrude(height = 8, scale = -2) { square(size = [4, 4], center = false); }"), /, 8, 0, \[0, 0\], 1\)/);
  assert.match(py("linear_extrude(height = 8, scale = 0) { square(size = [4, 4], center = false); }"), /sections\.append\(Vertex\(0, 0, height \* t\)\)/);
  const twisted = transpileCsg("linear_extrude(height = 10, twist = 90, $fn = 0, $fa = 12, $fs = 2) { square(size = [4, 4], center = false); }");
  assert.match(twisted.python, /_twist_extrude\(Rectangle\([^\n]*\), 10, 90, \[1, 1\], 6\)/);
  assert.ok(twisted.warnings.some((w) => /no exact BREP form/.test(w.message)));
  assert.match(py("linear_extrude(height = 10, twist = 90, slices = 5) { square(size = [4, 4], center = false); }"), /, 10, 90, \[1, 1\], 5\)/);
  // an extrude of a child that builds nothing is nothing
  assert.match(py("linear_extrude(height = 1) { circle($fn = 0, $fa = 12, $fs = 2, r = 0); }"), /^part = None$/m);
});

test("rotate_extrude: the profile is stood up by _revolve; start= turns a partial sweep, a full turn's start only moves the seam", () => {
  assert.match(py("rotate_extrude(angle = 90, start = 45, convexity = 2) { square(size = [1, 1], center = false); }"), /^part = _move\(Rot\(0, 0, 45\), _revolve\(Rectangle\([^\n]*\), 90\)\)$/m);
  const full = py("rotate_extrude(angle = 360, start = 180, convexity = 2) { square(size = [1, 1], center = false); }");
  assert.match(full, /^part = _revolve\(Rectangle\([^\n]*\), 360\)$/m);
  assert.match(full, /revolve\(Plane\.XZ \* profile, axis=Axis\.Z, revolution_arc=arc\)/);
});

test("model.py imports what it uses and nothing of the old language layer", () => {
  const out = py("cube(size = [10, 10, 10], center = false);");
  assert.match(out, /^from cadkit import Appearance, Body, Model$/m);
  assert.doesNotMatch(out, /def _|import math/);
  assert.match(py("cube(size = [inf, 1, 1], center = false);\npolyhedron(points = [[0, 0, nan], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]]);"), /^import math$/m);
});

test("a node OpenSCAD has but this build does not is an error, not a silent gap", () => {
  assert.ok(errors("roof(method = \"straight\") { square(size = [4, 4], center = false); }").some((e) => /roof\(\): has no exact counterpart here/.test(e)));
  assert.ok(errors("minkowski_sum() { cube(size = [1, 1, 1], center = false); }").some((e) => /no counterpart/.test(e)));
  assert.ok(errors("cube(size = [1, 1, 1]").some((e) => /could not read the \.csg/.test(e)));
});

test("the mesh fallback: a node only OpenSCAD's render can stand in for is built from that render, and says so", () => {
  const tree = (rendered: unknown) => {
    const [node] = parseCsg('surface(file = "/project/hm.dat", center = false, invert = false);');
    node!.rendered = rendered as any;
    return transpileTree([node!]);
  };
  // 3D: OpenSCAD's facets sewn into a solid
  const solidOut = tree({ dim: 3, points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] });
  assert.deepEqual(solidOut.errors, []);
  assert.match(solidOut.python, /^part = _polyhedron\(\[\[0, 0, 0\], \[1, 0, 0\], \[0, 1, 0\], \[0, 0, 1\]\], \[\[0, 2, 1\]/m);
  assert.ok(solidOut.warnings.some((w) => /surface\(\): built from OpenSCAD's own render \(mesh fallback\) — 4 flat facets/.test(w.message)));
  // 2D: its outlines, filled nonzero (a square with a square hole, as Polygon2d orients them)
  const flat = tree({ dim: 2, points: [[0, 0], [4, 0], [4, 4], [0, 4], [1, 1], [1, 3], [3, 3], [3, 1]], paths: [[0, 1, 2, 3], [4, 5, 6, 7]] });
  assert.match(flat.python, /^part = _fill\(\[\[\[0, 0\], \[4, 0\], \[4, 4\], \[0, 4\], \[0, 0\]\], \[\[1, 1\], \[3, 1\], \[3, 3\], \[1, 3\], \[1, 1\]\]\], \[\[0, \[1\]\]\]\)$/m);
  // rendered to nothing is OpenSCAD's empty; a render too big to sew in the browser is refused
  assert.match(tree(null).python, /^part = None$/m);
  const faces = Array.from({ length: MESH_MAX_FACES + 1 }, () => [0, 1, 2]);
  assert.ok(tree({ dim: 3, points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces }).errors.some((e) => /faces — more than the in-browser build sews/.test(e.message)));
  // which trees ask for a render at all: not a Write.scad font, not a background part, not a cut projection
  assert.ok(needsRender(parseCsg('group() { import(file = "/project/part.stl", layer = "", origin = [0, 0], scale = 1); }')));
  assert.ok(needsRender(parseCsg("offset(delta = 1, chamfer = true) { square(size = [1, 1]); }")));
  assert.ok(!needsRender(parseCsg('import(file = "/libraries/write/Letters.dxf", layer = "A", origin = [0, 0], scale = 1);')));
  assert.ok(!needsRender(parseCsg('%surface(file = "/project/hm.dat");\nprojection(cut = true) { cube(size = [1, 1, 1]); }')));
});

// ── the project around the .scad ─────────────────────────────────────────────

test("pickScadEntry picks the file nobody includes, resolving includes as OpenSCAD does", () => {
  const files = {
    "box_frame/configuration.scad": "WALL = 3;\n",
    "single_frame/configuration.scad": "WALL = 99;\n",
    "box_frame/part.scad": "include <configuration.scad>\ncube(WALL);\n",
  };
  // box_frame/configuration.scad is included relative to part.scad, so it is not a root
  assert.equal(pickScadEntry(files), "box_frame/part.scad");
  assert.equal(pickScadEntry({ "a.scad": "cube(1);\n", "inc/helper.scad": "module h() { cube(2); }\n" }), "a.scad");
  assert.equal(pickScadEntry({}), null);
});

test("every offset asks for OpenSCAD's render and keeps it as the fallback for where the exact offset gives up", () => {
  const csg = "offset(r = -1.5, $fn = 0, $fa = 12, $fs = 2) { square(size = [10, 10], center = false); }";
  assert.equal(needsRender(parseCsg(csg)), true);
  const [node] = parseCsg(csg);
  // OCCT's MakeOffset refused 31 Thingiverse outlines that Clipper takes; OpenSCAD's polygons stand behind it
  node!.rendered = { dim: 2, points: [[1.5, 1.5], [8.5, 1.5], [8.5, 8.5], [1.5, 8.5]], paths: [[0, 1, 2, 3]] };
  const result = transpileTree([node!]);
  assert.deepEqual(result.errors, []);
  assert.match(result.python, /^part = _offset_or\(Rectangle\(10, 10[^\n]*\), -1\.5, Kind\.ARC, lambda: _fill\(\[\[\[1\.5, 1\.5\], \[8\.5, 1\.5\], \[8\.5, 8\.5\], \[1\.5, 8\.5\], \[1\.5, 1\.5\]\]\], \[\[0, \[\]\]\]\), 4\)$/m);
  assert.match(result.python, /^def _offset_or\(shape, amount, kind, fallback, edges\):$/m);
  assert.match(result.python, /^        return _offset\(shape, amount, kind\)$/m, "the exact offset is fused as _offset fuses it");
  assert.match(result.python, /_note\("offset-faceted"/);
  // OpenSCAD's offset left nothing: so does the fallback
  node!.rendered = null;
  assert.match(transpileTree([node!]).python, /lambda: None, 0\)$/m);
});

test("a polyhedron that does not close as written takes OpenSCAD's repair of it, or is dropped as OpenSCAD drops it", () => {
  const closed = { points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]] };
  assert.equal(closedAsWritten(closed.points, closed.faces), true);
  assert.equal(closedAsWritten(closed.points, closed.faces.slice(1)), false, "a face missing");
  assert.equal(closedAsWritten(closed.points, [[0, 1, 2], ...closed.faces.slice(1)]), false, "a face wound against its neighbours");
  assert.equal(closedAsWritten(closed.points, [[0, 0, 1], ...closed.faces.slice(1)]), false, "a face repeating a corner");
  const sheet = "polyhedron(points = [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces = [[0, 1, 2]], convexity = 1);";
  assert.equal(needsRender(parseCsg(sheet)), true);
  assert.equal(needsRender(parseCsg(`polyhedron(points = ${JSON.stringify(closed.points)}, faces = ${JSON.stringify(closed.faces)}, convexity = 1);`)), false);
  // in a boolean OpenSCAD turns it into a manifold and drops it when that fails (export_fgjson renders null)
  const [cut] = parseCsg(`difference() { cube(size = [2, 2, 2], center = false); ${sheet} }`);
  cut!.children[1]!.rendered = null;
  const dropped = transpileTree([cut!]);
  assert.match(dropped.warnings.map((w) => w.message).join("\n"), /in a boolean OpenSCAD drops it, and so does this build/);
  assert.doesNotMatch(dropped.python, /_polyhedron\(/);
  // on its own it exports the open faces as they are — no solid: sewn as written, and the build says what does not close
  const [node] = parseCsg(sheet);
  node!.rendered = null;
  const alone = transpileTree([node!]);
  assert.match(alone.python, /^part = _polyhedron\(\[\[0, 0, 0\], \[1, 0, 0\], \[0, 1, 0\]\], \[\[0, 1, 2\]\]\)$/m);
  node!.rendered = { dim: 3, points: closed.points, faces: closed.faces };
  const repaired = transpileTree([node!]);
  assert.match(repaired.python, /^part = _polyhedron\(\[\[0, 0, 0\], \[1, 0, 0\], \[0, 1, 0\], \[0, 0, 1\]\], \[\[0, 2, 1\]/m);
  assert.match(repaired.warnings.map((w) => w.message).join("\n"), /built from OpenSCAD's repair of it \(4 faces\)/);
});

test("points written twice are one when sewn as written; past the cap a repair gives way to them (a long BOSL2 thread)", () => {
  // a tetrahedron whose apex is written twice, each face using one copy
  const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]];
  const faces = [[0, 2, 1], [0, 1, 3], [1, 2, 4], [2, 0, 4]];
  assert.equal(closedAsWritten(points, faces), false, "as written (the fork's test): OpenSCAD's repair is asked for");
  assert.equal(closedAsWritten(points, faces, true), true, "welded: closed");
  const csg = `polyhedron(points = ${JSON.stringify(points)}, faces = ${JSON.stringify(faces)}, convexity = 1);`;
  assert.equal(needsRender(parseCsg(csg)), true);
  const welded = /_polyhedron\(\[\[0, 0, 0\], \[1, 0, 0\], \[0, 1, 0\], \[0, 0, 1\]\], \[\[0, 2, 1\], \[0, 1, 3\], \[1, 2, 3\], \[2, 0, 3\]\]\)/;
  assert.match(py(csg), welded, "no render to hand: sewn welded");
  // a repair past MESH_MAX_FACES: the faces as written, welded, rather than no part at all
  const [node] = parseCsg(csg);
  node!.rendered = { dim: 3, points, faces: Array.from({ length: MESH_MAX_FACES + 1 }, () => [0, 1, 2]) };
  const big = transpileTree([node!]);
  assert.deepEqual(big.errors, []);
  assert.match(big.python, welded);
  assert.match(big.warnings.map((w) => w.message).join("\n"), /built from its own faces/);
});

test("points a hair apart are one too (1011192's slice()), and the zero-area faces between them go", () => {
  // a cube whose top corners 5 and 6 are written again 1e-14 off (8, 9), one top triangle on the copies and a
  // zero-area face across each seam: closed as written, but model.py prints the copies as the same points
  const t = 10 + 1e-14;
  const points = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10], [t, 0, 10], [t, 10, 10]];
  const faces = [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 6, 7], [4, 8, 9], [8, 4, 5], [4, 9, 6], [9, 8, 5], [5, 6, 9]];
  assert.equal(closedAsWritten(points, faces), true, "no render asked for");
  const out = py(`polyhedron(points = ${JSON.stringify(points)}, faces = ${JSON.stringify(faces)}, convexity = 1);`);
  assert.match(out, /_polyhedron\(\[\[0, 0, 0\], \[10, 0, 0\], \[10, 10, 0\], \[0, 10, 0\], \[0, 0, 10\], \[10, 0, 10\], \[10, 10, 10\], \[0, 10, 10\]\], \[\[0, 3, 2, 1\], \[0, 1, 5, 4\], \[1, 2, 6, 5\], \[2, 3, 7, 6\], \[3, 0, 4, 7\], \[4, 6, 7\], \[4, 5, 6\]\]\)/);
});

test("polygon(): runs of points on a circle are exact arcs (a rounded rectangle), a regular polygon is not", () => {
  const corner = (cx: number, cy: number, a0: number) => [0, 1, 2].map((k) => [cx + 3 * Math.cos(((a0 + 45 * k) * Math.PI) / 180), cy + 3 * Math.sin(((a0 + 45 * k) * Math.PI) / 180)]);
  const rounded = [...corner(12, 7, 0), ...corner(-12, 7, 90), ...corner(-12, -7, 180), ...corner(12, -7, 270)];
  const csg = `polygon(points = ${JSON.stringify(rounded)}, paths = undef, convexity = 1);`;
  const out = py(`linear_extrude(height = 5) { ${csg} }`);
  assert.match(out, /_arc_regions\(/);
  assert.match(out, /ThreePointArc/);
  assert.match(warnings(csg).join("\n"), /built as exact arcs/);
  const octagon = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [10 * Math.cos((k * Math.PI) / 4), 10 * Math.sin((k * Math.PI) / 4)]);
  assert.doesNotMatch(py(`polygon(points = ${JSON.stringify(octagon)}, paths = undef, convexity = 1);`), /_arc_regions/);
});

test("BOSL2: a call's scope and $fn say what is a circle — BOSL2's own segs() is, the author's $fn = 6 is not; a project's own cyl() is not BOSL2's", () => {
  const cylTree = (fn: number, defined = "BOSL2/shapes3d.scad") => {
    const [cylinder] = parseCsg("cylinder($fn = 8, $fa = 12, $fs = 2, h = 10, r1 = 2.5, r2 = 2.5, center = true);");
    cylinder!.at = { file: "BOSL2/builtins.scad", line: 34, column: 1 };
    const call = {
      name: "group", modifier: "" as const, args: new Map(), positional: [], children: [cylinder!], module: "cyl",
      at: { file: "main.scad", line: 2, column: 1 }, defined: { file: defined, line: 2513, column: 1 },
      scope: new Map<string, any>([["circum", false], ["texture", null], ["rounding", null]]), specials: { $fn: fn, $fa: 12, $fs: 2 },
    };
    return transpileTree([call]).python;
  };
  assert.match(cylTree(0), /Cylinder\(2\.5, 10\)/);
  assert.match(cylTree(6), /RegularPolygon\(2\.5, 8\)/, "the author's $fn = 6 at the call: BOSL2's facets stay");
  assert.match(cylTree(0, "lib/my-cyl.scad"), /RegularPolygon\(2\.5, 8\)/, "not BOSL2's cyl()");
});
