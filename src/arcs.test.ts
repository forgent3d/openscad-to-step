import test from "node:test";
import assert from "node:assert/strict";
import { recognizeLoop, exactLoopStats, MIN_FULL_CIRCLE, type ExactLoop } from "./arcs.ts";
import type { Pt } from "./polygon2d.ts";

const deg = Math.PI / 180;
/** OpenSCAD's circle(r, $fn = n): vertex k at 360*k/n. */
const ngon = (r: number, n: number, c: Pt = [0, 0]): Pt[] => Array.from({ length: n }, (_, k) => [c[0] + r * Math.cos((2 * Math.PI * k) / n), c[1] + r * Math.sin((2 * Math.PI * k) / n)]);
/** BOSL2's rect(size, rounding = r) at `perQuarter` chords a corner, counter-clockwise. */
function roundedRect(w: number, h: number, r: number, perQuarter: number): Pt[] {
  const out: Pt[] = [];
  const corners: [Pt, number][] = [[[w / 2 - r, h / 2 - r], 0], [[-w / 2 + r, h / 2 - r], 90], [[-w / 2 + r, -h / 2 + r], 180], [[w / 2 - r, -h / 2 + r], 270]];
  for (const [c, a0] of corners) {
    for (let k = 0; k <= perQuarter; k++) {
      const a = (a0 + (90 * k) / perQuarter) * deg;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
  }
  return out;
}
const arcsOf = (loop: ExactLoop | null) => (loop?.kind === "path" ? loop.arcs.filter((a) => a).length : loop?.kind === "circle" ? -1 : 0);

test("a polygon that is one whole circle is a circle from 13 sides up, a polygon below (the $fn <= 12 reading)", () => {
  const sixteen = recognizeLoop(ngon(5, 16, [3, 4]));
  assert.equal(sixteen?.kind, "circle");
  if (sixteen?.kind === "circle") {
    assert.ok(Math.abs(sixteen.r - 5) < 1e-12 && Math.abs(sixteen.center[0] - 3) < 1e-12 && Math.abs(sixteen.center[1] - 4) < 1e-12);
  }
  assert.equal(recognizeLoop(ngon(5, MIN_FULL_CIRCLE))?.kind, "circle");
  for (const n of [3, 4, 6, 8, 12]) assert.equal(recognizeLoop(ngon(5, n)), null, `${n}-gon stays a polygon`);
  // the caller can say a small circle is a circle (BOSL2's own segs(), bosl2.ts)
  assert.equal(recognizeLoop(ngon(1, 8), { fullCircle: (n) => n === 8 })?.kind, "circle");
  // but never a square or a hexagon, whatever it says: a step over 45° is no circle (prismoid([30,30],[0,5]) once read as one)
  for (const n of [4, 6]) assert.equal(recognizeLoop(ngon(5, n), { fullCircle: () => true }), null);
  assert.equal(recognizeLoop([[-15, -15], [15, -15], [15, 15], [-15, 15]], { fullCircle: () => true }), null);
  // clockwise works too
  assert.equal(recognizeLoop(ngon(5, 20).reverse())?.kind, "circle");
});

test("rounded corners tangent to their sides are arcs, down to two chords a corner", () => {
  for (const per of [1, 2, 3, 8]) {
    const loop = recognizeLoop(roundedRect(30, 20, 3, per));
    if (per === 1) {
      assert.equal(loop, null, "one chord a corner is a chamfer");
      continue;
    }
    assert.equal(arcsOf(loop), 4, `${per} chords a corner`);
    const { area, min, max } = exactLoopStats(loop!);
    assert.ok(Math.abs(area - (30 * 20 - (4 - Math.PI) * 9)) < 1e-9, `area ${area}`);
    assert.deepEqual([min, max].map((p) => p.map((v) => Math.round(v * 1e9) / 1e9)), [[-15, -10], [15, 10]]);
  }
});

test("a regular polygon's corners are not arcs: its sides are chords of the same circle, not tangents", () => {
  assert.equal(recognizeLoop(ngon(10, 8)), null);
  assert.equal(recognizeLoop(ngon(10, 10)), null);
  assert.equal(recognizeLoop([[0, 0], [10, 0], [10, 10], [0, 10]]), null);
});

test("arcs need exact co-circularity: a hand-typed circle (three decimals) and an involute stay polygons", () => {
  const typed = ngon(7, 24).map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as Pt);
  assert.equal(recognizeLoop(typed), null);
  // an involute of a base circle r = 10, sampled every 4°, closed through the origin
  const inv: Pt[] = [[0, 0]];
  for (let t = 0; t <= 60; t += 4) {
    const a = t * deg;
    inv.push([10 * (Math.cos(a) + a * Math.sin(a)), 10 * (Math.sin(a) - a * Math.cos(a))]);
  }
  assert.equal(recognizeLoop(inv), null);
});

test("a nearly straight run is no arc: steps under 0.25° fit some huge circle, and that proves nothing", () => {
  // a very flat arc (r = 1000, 0.05° a chord) closed by a straight base: a supershape's flank once came out as an arc
  const flat: Pt[] = Array.from({ length: 9 }, (_, k) => [1000 * Math.sin(((k - 4) * 0.05 * Math.PI) / 180), 1000 * Math.cos(((k - 4) * 0.05 * Math.PI) / 180) - 1000]);
  flat.push([3.5, -10], [-3.5, -10]);
  assert.equal(arcsOf(recognizeLoop(flat)), 0);
});

test("a long arc with no tangent neighbours is an arc (a pie slice), a short one is not", () => {
  const slice = (n: number, span: number): Pt[] => [[0, 0], ...Array.from({ length: n + 1 }, (_, k) => [10 * Math.cos((span * k * deg) / n), 10 * Math.sin((span * k * deg) / n)] as Pt)];
  assert.equal(arcsOf(recognizeLoop(slice(8, 120))), 1);
  assert.equal(arcsOf(recognizeLoop(slice(3, 60))), 1, "a 60° wedge of three chords (BOSL2 arc(wedge = true))");
  assert.equal(arcsOf(recognizeLoop(slice(2, 40))), 0, "two chords and no tangent: could be any polyline");
});

test("two arcs meeting tangentially (an S-bend, BOSL2's offset paths) are both arcs", () => {
  // a stadium: two half circles joined by straight sides
  const stadium: Pt[] = [];
  for (let k = 0; k <= 6; k++) stadium.push([10 + 5 * Math.cos((-90 + 30 * k) * deg), 5 * Math.sin((-90 + 30 * k) * deg)]);
  for (let k = 0; k <= 6; k++) stadium.push([-10 + 5 * Math.cos((90 + 30 * k) * deg), 5 * Math.sin((90 + 30 * k) * deg)]);
  const loop = recognizeLoop(stadium);
  assert.equal(arcsOf(loop), 2);
  assert.ok(Math.abs(exactLoopStats(loop!).area - (20 * 10 + Math.PI * 25)) < 1e-9);
});
