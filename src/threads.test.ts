/**
 * threads.ts against BOSL2's own threads: each call evaluated by our OpenSCAD build with the built-in BOSL2 and its
 * scope read the way the transpile reads it. The plain stand-in is checked against the simplified form it should be
 * (major diameter for a rod, minor for a hole, 45° chamfers from BOSL2's end faces) — not against OpenSCAD's render,
 * which it deliberately is not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { librariesFor } from "./transpile.ts";
import { transpileViaOpenScad } from "./csg.ts";
import { readScadTree, type CsgNode } from "./tree.ts";
import { isBosl2Call } from "./bosl2.ts";
import { plainThread, THREAD_SCOPED, type PlainThread } from "./threads.ts";
import { runOpenScad } from "./node.mjs";

const HEADER = "include <BOSL2/std.scad>\ninclude <BOSL2/threading.scad>\ninclude <BOSL2/screws.scad>\ninclude <BOSL2/bottlecaps.scad>\n";

/** The plain stand-ins of every BOSL2 thread module call in an evaluation of `body`. */
async function plans(body: string): Promise<(PlainThread | { why: string })[]> {
  const source = HEADER + body + "\n";
  const { files, scope } = await librariesFor([source]);
  const mount: Record<string, string> = { "/project/main.scad": source };
  for (const [key, text] of Object.entries(files)) mount[`/libraries/${key}`] = text;
  const out = await runOpenScad({ files: mount, entry: "/project/main.scad", scope: [...scope, ...THREAD_SCOPED] });
  assert.ok(out.tree, out.console.join("\n"));
  const tree = readScadTree(out.tree!, (p) => p.replace(/^\/(project|libraries)\//, ""));
  const found: (PlainThread | { why: string })[] = [];
  const walk = (node: CsgNode) => {
    if (THREAD_SCOPED.includes(node.module!) && isBosl2Call(node)) found.push(plainThread(node));
    node.children.forEach(walk);
  };
  tree.nodes!.forEach(walk);
  return found;
}

const only = async (body: string): Promise<PlainThread> => {
  const found = await plans(body);
  assert.equal(found.length, 1, body);
  assert.ok(!("why" in found[0]!), `${body}: ${"why" in found[0]! ? found[0].why : ""}`);
  return found[0] as PlainThread;
};
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
/** ISO metric thread depth BOSL2 uses: 5/8 of the fundamental triangle, 0.5413 * P. */
const isoDepth = (pitch: number) => (5 / 8) * (Math.sqrt(3) / 2) * pitch;

test("threaded_rod(): a cylinder at the major diameter, the whole length", async () => {
  const t = await only("threaded_rod(d=10, l=20, pitch=1.5);");
  assert.equal(t.internal, false);
  assert.deepEqual([t.d1, t.d2, t.pitch, t.length], [10, 10, 1.5, 20]);
  assert.deepEqual(t.profile, [[0, -10], [5, -10], [5, 10], [0, 10]]);
});

test("bevel=true: 45° chamfers from BOSL2's end face (the root diameter less the bevel) up to the major diameter", async () => {
  const t = await only("threaded_rod(d=10, l=20, pitch=1.5, bevel=true);");
  const root = 5 - isoDepth(1.5);
  const face = root - root / 6; // BOSL2: (r + profmin) / 6 on a blunt-start rod
  const [axis0, end, body] = t.profile;
  near(end![0], face, "end face radius");
  near(end![1], -10, "end face z");
  near(body![0], 5, "chamfer meets the major diameter");
  near(body![1] - end![1], body![0] - end![0], "45°");
  assert.deepEqual(axis0, [0, -10]);
  // a thread that runs out (blunt_start = false) is cut by a chamfer from the major diameter less the bevel (the depth)
  const cut = await only("threaded_rod(d=10, l=20, pitch=1.5, bevel=true, blunt_start=false);");
  near(cut.profile[1]![0], 5 - isoDepth(1.5), "end face: the root");
  near(cut.profile[2]![0], 5, "chamfer meets the major diameter");
});

test("threaded_nut(): the cutter is a hole at the minor diameter with BOSL2's countersinks (ibevel) at 45°", async () => {
  const t = await only("threaded_nut(nutwidth=16, id=10, h=8, pitch=1.5);");
  assert.equal(t.internal, true);
  assert.deepEqual([t.d1, t.pitch], [10, 1.5]);
  const minor = 5 - isoDepth(1.5);
  const [, face, body] = t.profile;
  near(face![0], 5 + 5 / 6, "countersink: the major diameter plus the bevel (r / 6)");
  near(body![0], minor, "the hole: the minor diameter");
  near(body![1] - face![1], face![0] - body![0], "45°");
  // ibevel = false: no countersink
  const plain = await only("threaded_nut(nutwidth=16, id=10, h=8, pitch=1.5, ibevel=false);");
  assert.equal(plain.profile.length, 4);
  near(plain.profile[1]![0], minor, "plain hole");
});

test("npt_threaded_rod(): tapered — the major diameter follows the taper end to end", async () => {
  const t = await only("npt_threaded_rod(size=1/4);");
  assert.ok(t.d1 > t.d2);
  const [, bottom, top] = t.profile;
  near(bottom![0], t.d1 / 2, "bottom");
  near(top![0], t.d2 / 2, "top");
});

test("every BOSL2 family goes through one of the two modules", async () => {
  for (const body of [
    "trapezoidal_threaded_rod(d=12, l=30, pitch=3);",
    "acme_threaded_rod(d=12.7, l=25, tpi=10);",
    "buttress_threaded_rod(d=16, l=20, pitch=2);",
    "square_threaded_rod(d=16, l=20, pitch=3);",
    "ball_screw_rod(d=16, l=30, pitch=5, ball_diam=3);",
    "trapezoidal_threaded_nut(nutwidth=24, id=12, h=10, pitch=3);",
    "screw(\"M6\", length=16, thread=true);",
    "nut(\"M6\", thread=true);",
    "screw_hole(\"M6\", length=10, thread=true);",
  ]) {
    const found = await plans(body);
    assert.ok(found.length >= 1, body);
    for (const plan of found) assert.ok(!("why" in plan), `${body}: ${"why" in plan ? plan.why : ""}`);
  }
});

test("thread_helix() (bottle necks and caps): the ring the helix fills, root to crest, end to end of its profile", async () => {
  const t = await only("thread_helix(d=20, pitch=2, thread_depth=1, turns=3);");
  assert.equal(t.module, "thread_helix");
  // measured on BOSL2's own VNF: r 10..11, z ±3.634
  const [a, b, c] = t.profile;
  near(a![0], 10, "root");
  near(b![0], 11, "crest");
  near(c![1], 3 + 2 * 0.3169872981077807, "axial half extent");
  const inside = await only("thread_helix(d=20, pitch=2, thread_depth=1, turns=3, internal=true);");
  assert.equal(inside.internal, true);
  near(inside.profile[0]![0], 10, "an internal helix's crest is d too");
});

test("what keeps its thread: a teardrop hole, a reversed bevel", async () => {
  const [tear] = await plans("generic_threaded_rod(d=10, l=20, pitch=1.5, profile=[[-1/2,-0.5],[-1/6,0],[1/6,0],[1/2,-0.5]], internal=true, teardrop=true);");
  assert.ok(tear && "why" in tear && /teardrop/.test(tear.why));
  const [reversed] = await plans("threaded_rod(d=10, l=20, pitch=1.5, bevel=\"reverse\");");
  assert.ok(reversed && "why" in reversed && /reverse/.test(reversed.why));
});

test("the transpile: off, the threads are what they were (no scope asked, nothing listed); on, plain solids, listed", async () => {
  const source = HEADER + "threaded_rod(d=10, l=20, pitch=1.5);\ntranslate([20, 0, 0]) threaded_nut(nutwidth=16, id=10, h=8, pitch=1.5);\n";
  const asked: string[][] = [];
  const run: typeof runOpenScad = (job) => {
    asked.push(job.scope ?? []);
    return runOpenScad(job);
  };
  const off = await transpileViaOpenScad(source, { entry: "main.scad", run });
  assert.ok(off.ok);
  assert.deepEqual(off.transpiled.threads, []);
  assert.equal(off.transpiled.threaded, true, "the option is offered with it off too");
  assert.ok(asked.every((scope) => !scope.some((m) => THREAD_SCOPED.includes(m))));
  assert.match(off.transpiled.python, /_polyhedron\(/);
  const on = await transpileViaOpenScad(source, { entry: "main.scad", run, cosmeticThreads: true });
  assert.ok(on.ok);
  assert.equal(on.rendered, undefined, "no render asked for: the helices are never built");
  // the helices' thousands of faces are gone (what is left of the polyhedra: the nut's hexagon)
  assert.ok(on.transpiled.python.length * 10 < off.transpiled.python.length, `${on.transpiled.python.length} vs ${off.transpiled.python.length}`);
  assert.deepEqual(on.transpiled.threads.map((t) => [t.call, t.internal, t.at?.line]), [["threaded_rod", false, 5], ["threaded_nut", true, 6]]);
  const rod = await transpileViaOpenScad(HEADER + "threaded_rod(d=10, l=20, pitch=1.5);\n", { entry: "main.scad", run, cosmeticThreads: true });
  assert.ok(rod.ok);
  assert.doesNotMatch(rod.transpiled.python, /_polyhedron\(/);
  assert.match(rod.transpiled.python, /_revolve_loop\(\[\[0, -10\], \[5, -10\], \[5, 10\], \[0, 10\]\]\)/);
  // BOSL2 in, no thread drawn (one only in the background): nothing to offer
  const none = await transpileViaOpenScad(HEADER + "cuboid(10);\n%threaded_rod(d=10, l=20, pitch=1.5);\n", { entry: "main.scad", run });
  assert.ok(none.ok);
  assert.equal(none.transpiled.threaded, false);
});
