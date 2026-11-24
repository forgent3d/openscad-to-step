/**
 * gears.ts against BOSL2's own gears: each outline evaluated by our OpenSCAD build with the built-in BOSL2 (the
 * product's evaluation, no kernel) and split into BOSL2's sections. A BOSL2 that draws its teeth differently shows
 * here as a different split — and in the product as the facets kept with a warning, never as a wrong shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { librariesFor } from "./transpile.ts";
import { readScadTree, type CsgNode } from "./tree.ts";
import { gearLoop, tangentAtEnd, type GearLoop } from "./gears.ts";
import type { Pt } from "./polygon2d.ts";
import { runOpenScad } from "./node.mjs";

/** The loops of every polygon spur_gear2d() draws in an evaluation of `body`. */
async function outlines(body: string): Promise<Pt[][][]> {
  const source = `include <BOSL2/std.scad>\ninclude <BOSL2/gears.scad>\n${body}\n`;
  const { files, scope } = await librariesFor([source]);
  const mount: Record<string, string> = { "/project/main.scad": source };
  for (const [key, text] of Object.entries(files)) mount[`/libraries/${key}`] = text;
  const out = await runOpenScad({ files: mount, entry: "/project/main.scad", scope });
  assert.ok(out.tree, out.console.join("\n"));
  const tree = readScadTree(out.tree!, (p) => p.replace(/^\/(project|libraries)\//, ""));
  const found: Pt[][][] = [];
  const walk = (node: CsgNode) => {
    if (node.name === "polygon") {
      const pts = node.args.get("points") as number[][];
      const paths = node.args.get("paths") as number[][] | undefined;
      found.push((paths ?? [pts.map((_, i) => i)]).map((path) => path.map((i) => [pts[i]![0]!, pts[i]![1]!] as Pt)));
    }
    node.children.forEach(walk);
  };
  tree.nodes!.forEach(walk);
  return found;
}

/** One tooth's edge kinds, from the first vertex of the loop. */
const tooth = (g: GearLoop, teeth: number) => g.edges.slice(0, g.edges.length / teeth).map((e) => e.kind + (e.kind === "spline" && e.tangents ? "+t" : ""));

test("spur gears: per tooth a flank spline, the tip arc, the other flank, the straight root — every point kept", async () => {
  for (const [body, teeth] of [
    ["spur_gear2d(mod=2, teeth=20, shaft_diam=5);", 20],
    // few teeth: BOSL2's automatic profile shift
    ["spur_gear2d(mod=2, teeth=8);", 8],
    // no shift: the trochoid undercut is part of the flank's points
    ["spur_gear2d(mod=2, teeth=8, profile_shift=0);", 8],
    ["spur_gear2d(mod=1, teeth=60, pressure_angle=25, backlash=0.1);", 60],
  ] as const) {
    const [loops] = await outlines(body);
    const g = gearLoop(loops![0]!, teeth, true);
    assert.ok(g, body);
    assert.equal(g.vertices.length, 4 * teeth, body);
    // the flanks start where the root fillet leaves the straight root (G1: its direction is the spline's tangent)
    const kinds = tooth(g, teeth);
    assert.equal(kinds.filter((k) => k === "arc").length, 1, `${body}: ${kinds}`);
    assert.equal(kinds.filter((k) => k === "line").length, 1, `${body}: ${kinds}`);
    assert.equal(kinds.filter((k) => k === "spline+t").length, 2, `${body}: ${kinds}`);
    assert.equal(g.splines, 2 * teeth);
    assert.equal(g.arcs, teeth);
    // every point of OpenSCAD's outline is a vertex or a spline's interpolation point
    const kept = g.vertices.length + g.edges.reduce((n, e) => n + (e.kind === "spline" ? e.through.length : 0), 0);
    assert.equal(kept, loops![0]!.length, body);
    assert.ok(g.band[0] <= 0 && g.band[1] >= 0 && g.band[1] - g.band[0] > 0, body);
    // the bore is no gear loop
    if (loops!.length > 1) assert.equal(gearLoop(loops![1]!, teeth, true), null);
  }
});

test("without a fillet (clearance = 0) the root corners stay sharp: straight land, straight flank starts, then the splines", async () => {
  const [loops] = await outlines("spur_gear2d(mod=2, teeth=20, clearance=0);");
  const g = gearLoop(loops![0]!, 20, true)!;
  assert.deepEqual(tooth(g, 20).sort(), ["arc", "line", "line", "line", "spline+t", "spline+t"]);
});

test("a ring gear's cutter: one spline per gap, its tooth tips straight (no arcs: the cutter is no external gear)", async () => {
  const [loops] = await outlines("spur_gear2d(mod=2, teeth=30, internal=true);");
  const g = gearLoop(loops![0]!, 30, false)!;
  assert.ok(g);
  assert.deepEqual(tooth(g, 30), ["spline", "line"]);
});

test("not a ring of identical teeth: hide=, the wrong tooth count, a plain circle", async () => {
  const [hidden] = await outlines("spur_gear2d(mod=2, teeth=20, hide=5);");
  assert.equal(gearLoop(hidden![0]!, 20, true), null);
  const [loops] = await outlines("spur_gear2d(mod=2, teeth=20);");
  assert.equal(gearLoop(loops![0]!, 19, true), null);
  const circle: Pt[] = Array.from({ length: 40 }, (_, i) => [Math.cos((i * Math.PI) / 20), Math.sin((i * Math.PI) / 20)]);
  assert.equal(gearLoop(circle, 20, true), null);
});

test("end tangents: the circle through the last three points", () => {
  const c = (t: number): Pt => [Math.cos(t), Math.sin(t)];
  const close = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-12;
  assert.ok(close(tangentAtEnd(c(0), c(0.3), c(0.6), "first"), [0, 1]));
  assert.ok(close(tangentAtEnd(c(0), c(0.3), c(0.6), "last"), [-Math.sin(0.6), Math.cos(0.6)]));
  assert.ok(close(tangentAtEnd(c(0.6), c(0.3), c(0), "last"), [0, -1]));
  assert.ok(close(tangentAtEnd([0, 0], [1, 0], [2, 0], "first"), [1, 0]));
});
