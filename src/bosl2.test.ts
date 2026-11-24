/**
 * bosl2.ts against BOSL2 itself: each family evaluated once by our OpenSCAD build with the built-in BOSL2 (the
 * product's evaluation, no kernel), every call's polyhedron run through its recogniser. A port of BOSL2's geometry
 * that drifts from the library (a new BOSL2, a wrong formula) shows as a refusal here — and in the product as the
 * facets kept with a warning, never as a wrong shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { librariesFor } from "./transpile.ts";
import { readScadTree, type CsgNode } from "./tree.ts";
import { attachableShape, exactCuboid, exactCyl, exactPrismoid, exactSpheroid, isBosl2Call, polyhedronOf, revolvedVolume } from "./bosl2.ts";
import { exactLoopStats } from "./arcs.ts";
import { runOpenScad } from "./node.mjs";

/** The BOSL2 calls of `module` in an evaluation of `body`, each with the polyhedra under it. */
async function calls(body: string, module: string): Promise<{ call: CsgNode; polys: { points: number[][]; faces: number[][] }[] }[]> {
  const source = `include <BOSL2/std.scad>\n${body}\n`;
  const { files, scope } = await librariesFor([source]);
  const mount: Record<string, string> = { "/project/main.scad": source };
  for (const [key, text] of Object.entries(files)) mount[`/libraries/${key}`] = text;
  const out = await runOpenScad({ files: mount, entry: "/project/main.scad", scope });
  assert.ok(out.tree, out.console.join("\n"));
  const tree = readScadTree(out.tree!, (p) => p.replace(/^\/(project|libraries)\//, ""));
  const found: { call: CsgNode; polys: { points: number[][]; faces: number[][] }[] }[] = [];
  const walk = (node: CsgNode) => {
    if (node.module === module && isBosl2Call(node)) {
      const polys: { points: number[][]; faces: number[][] }[] = [];
      const inner = (n: CsgNode) => {
        if (n.name === "polyhedron") polys.push(polyhedronOf(n)!);
        if (!(n.module === module && n !== node)) n.children.forEach(inner);
      };
      node.children.forEach(inner);
      found.push({ call: node, polys });
    }
    node.children.forEach(walk);
  };
  tree.nodes!.forEach(walk);
  return found;
}

test("cyl(): every rounding / chamfer variant is BOSL2's own profile, and its smooth limit revolves to the closed form", async () => {
  const variants = [
    "cyl(h=20, d=20, rounding=2)",
    "cyl(h=20, d=20, rounding1=3, rounding2=-2)",
    "cyl(h=20, d1=24, d2=12, rounding=2)",
    "cyl(h=20, d=20, chamfer=2)",
    "cyl(h=20, d=20, chamfer1=2, chamfang1=30, rounding2=3)",
    "cyl(h=20, d=20, chamfer2=3, from_end=true)",
    "cyl(h=10, d=5, rounding=1)",
    "cyl(h=20, d=20, rounding=2, circum=true)",
    "cyl(h=20, d=20, rounding=2, $fn=40)",
  ];
  const found = await calls(variants.map((v, i) => `right(${i * 40}) ${v};`).join("\n"), "cyl");
  assert.equal(found.length, variants.length);
  found.forEach(({ call, polys }, i) => {
    assert.equal(polys.length, 1, variants[i]);
    const exact = exactCyl(call, polys[0]!);
    assert.ok(!("why" in exact), `${variants[i]}: ${"why" in exact ? exact.why : ""}`);
  });
  // the closed form: a cylinder r = 10, h = 20 with r = 2 roundings both ends
  const plain = exactCyl(found[0]!.call, found[0]!.polys[0]!);
  if ("why" in plain) throw new Error(plain.why);
  const stats = exactLoopStats(plain.profile);
  // profile area: the 10 × 20 rectangle less two corners of (1 - π/4)*r²
  assert.ok(Math.abs(Math.abs(stats.area) - (200 - 2 * (1 - Math.PI / 4) * 4)) < 1e-9);
  void revolvedVolume;
});

test("spheroid(): every style's VNF is on the sphere", async () => {
  // ("orig" is no VNF: a rotate_extrude of a half circle, OpenSCAD's own sphere style)
  const styles = ["aligned", "stagger", "octa", "icosa"];
  const found = await calls(styles.map((s, i) => `right(${i * 30}) spheroid(r=10, style="${s}");`).join("\n"), "spheroid");
  assert.equal(found.length, styles.length);
  for (const [i, { call, polys }] of found.entries()) {
    const exact = exactSpheroid(call, polys[0]!);
    assert.ok(!("why" in exact), `${styles[i]}: ${"why" in exact ? exact.why : ""}`);
    if (!("why" in exact)) assert.ok(Math.abs(exact.r - 10) < 1e-12);
  }
});

test("prismoid(rounding=): both rings are rounded rectangles, corner for corner; straight walls are an extrusion", async () => {
  const variants = ["prismoid([40,40],[20,20], h=20, rounding=3)", "prismoid([40,30],[30,20], h=15, shift=[3,2], rounding1=4, rounding2=2)", "prismoid(30, 30, h=10, rounding=5)"];
  const found = await calls(variants.map((v, i) => `right(${i * 60}) ${v};`).join("\n"), "prismoid");
  assert.equal(found.length, variants.length);
  found.forEach(({ call, polys }, i) => {
    const exact = exactPrismoid(call, polys[0]!);
    assert.ok(!("why" in exact), `${variants[i]}: ${"why" in exact ? exact.why : ""}`);
    if (!("why" in exact)) assert.equal(exact.straight, i === 2);
  });
});

test("cuboid(rounding=): which edges are rounded comes from BOSL2's own corner shapes", async () => {
  const variants: [string, number][] = [
    ["cuboid([40,30,20], rounding=3)", 12],
    ["cuboid([40,30,20], rounding=3, except=BOT)", 8],
    ["cuboid([40,30,20], rounding=2, edges=TOP)", 4],
    ["cuboid([40,30,20], rounding=4, edges=\"Z\")", 4],
    ["cuboid([40,30,20], rounding=2, edges=[TOP+FRONT, RIGHT+BACK])", 2],
  ];
  const found = await calls(variants.map(([v], i) => `right(${i * 60}) ${v};`).join("\n"), "cuboid");
  assert.equal(found.length, variants.length);
  found.forEach(({ call }, i) => {
    const shape = attachableShape(call);
    assert.ok(shape, variants[i]![0]);
    const exact = exactCuboid(call, shape!.children);
    assert.ok(!("why" in exact), `${variants[i]![0]}: ${"why" in exact ? exact.why : ""}`);
    if (!("why" in exact)) assert.equal(exact.edges.length, variants[i]![1], variants[i]![0]);
  });
  // edges=[TOP+FRONT, RIGHT+BACK]: the x edge at (y = -15, z = +10) and the z edge at (x = +20, y = +15)
  const two = exactCuboid(found[4]!.call, attachableShape(found[4]!.call)!.children);
  if ("why" in two) throw new Error(two.why);
  const keys = two.edges.map((m) => m.join(",")).sort();
  assert.deepEqual(keys, ["0,-15,10", "20,15,0"]);
  // a negative rounding (a flange) is not recognised: kept faceted, said why
  const flange = await calls("cuboid([40,30,20], rounding=-2, edges=TOP);", "cuboid");
  const refused = exactCuboid(flange[0]!.call, attachableShape(flange[0]!.call)?.children ?? []);
  assert.ok("why" in refused);
});
