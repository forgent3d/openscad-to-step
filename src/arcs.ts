/**
 * Recover true circular arcs from the points of a polygon (transpile.ts `polygon()`). OpenSCAD's 2D has only polylines:
 * in the points of a `polygon()`, rounded corners, `round_corners()`, the paths BOSL2 `offset(r=)` produces,
 * `rect(rounding=)` and hand-written `[for (a = …) r * [cos(a), sin(a)]]` all arrive here as a run of concyclic points.
 * Runs that are recognized become exact arcs: a cylindrical face after extrusion, a torus after revolution — the same
 * convention `circle()` follows.
 *
 * What is recognized (all thresholds are pinned in arcs.test.ts):
 *  - **Concyclic, equal-step, same-direction** consecutive points: each point's distance to the center differs by
 *    <= 1e-7*r, and adjacent chord lengths differ by <= 1e-7*chord. Floating-point noise (1e-15) is far below that;
 *    curves with changing curvature (involutes, Béziers) are far above it; so are hand-typed three-decimal coordinates
 *    (they stay a polyline, no guessing).
 *  - Each step turns <= 45° (BOSL2's default `$fs = 2` gives a fillet of r = 1 eight segments per full turn).
 *  - **Full circle**: the whole ring lies on one circle. By default it needs >= 13 segments, the same rule as
 *    `circle($fn <= 12)` being a polygon, so a hex nut stays a hexagon;
 *    callers may relax this (the segment count BOSL2 computes itself from `$fa/$fs`, bosl2.ts).
 *  - **A single arc** (not a full circle): three points are always concyclic, so being concyclic is no evidence by
 *    itself. Accept it when both ends are **tangent** to the neighboring edges (a straight neighbor: the direction
 *    follows the tangent; an arc neighbor: the two circles share a tangent at the joint), even with only 2 segments;
 *    with one end tangent it needs >= 3 segments; with neither end tangent it needs >= 3 segments and each step
 *    <= 30° (a sector's arc).
 *    This keeps out regular polygons (neighbors are chords of the same circumscribed circle, not tangent) and
 *    chamfers (1 segment).
 *
 * Every recognized shape goes through the same check (`checkLoop`): the area difference between the exact ring and the
 * original polygon must equal the sum of the segment areas (signed by bulge direction), and
 * the bounding-box difference must not exceed the largest sagitta. A wrong center or a segment bulging the wrong way
 * shows up here; if the check fails, the whole ring stays a polyline.
 */

import type { Pt } from "./polygon2d.ts";

/**
 * An arc from a loop's vertex to the next one: on the circle (center, r), through `mid`, turning `turn` (+1
 * counter-clockwise) through `sweep` radians; it replaces `chords` equal chords of the polygon.
 */
export type ArcEdge = { center: Pt; r: number; mid: Pt; turn: number; sweep: number; chords: number };

/**
 * A loop with its arcs recognised: the whole loop one circle, or the vertices that remain (the arcs' end points)
 * with, for the edge from `vertices[i]` to `vertices[i + 1]` (cyclically), the arc it is — or null, a straight edge.
 */
export type ExactLoop =
  | { kind: "circle"; center: Pt; r: number; segments: number }
  | { kind: "path"; vertices: Pt[]; arcs: (ArcEdge | null)[]; recognised: number };

export type ArcPolicy = {
  /** Whether a loop that is one whole circle of `segments` sides is meant as a circle (default: ≥ 13 sides). */
  fullCircle?: (segments: number, r: number) => boolean;
};

/** The thresholds (arcs.test.ts pins them). */
export const ARC_TOLERANCE = 1e-7;
export const TANGENT_TOLERANCE = 1e-6;
export const MAX_STEP = Math.PI / 4 + 1e-9;
export const LOOSE_STEP = Math.PI / 6 + 1e-9;
/** Below 0.25° a step is no arc (no OpenSCAD or BOSL2 default facets that finely). */
export const MIN_STEP = (0.25 * Math.PI) / 180;
export const MIN_FULL_CIRCLE = 13;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const len = (a: Pt) => Math.hypot(a[0], a[1]);

/** The circle through three points, or null when they are (nearly) collinear. */
export function circleThrough(a: Pt, b: Pt, c: Pt): { center: Pt; r: number } | null {
  const ax = a[0] - c[0], ay = a[1] - c[1];
  const bx = b[0] - c[0], by = b[1] - c[1];
  const d = 2 * (ax * by - ay * bx);
  const scale = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by));
  if (!(Math.abs(d) > 1e-12 * scale * scale)) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by;
  const ux = (by * a2 - ay * b2) / d;
  const uy = (ax * b2 - bx * a2) / d;
  return { center: [c[0] + ux, c[1] + uy], r: Math.hypot(ux, uy) };
}

const near = (x: number, y: number, scale: number) => Math.abs(x - y) <= ARC_TOLERANCE * scale;

/**
 * Consecutive repeats (and a closing repeat of the first point) removed — within 1e-9 of the loop's size: BOSL2 joins
 * pieces at points equal up to the last bit (1.8e-15 against -1.8e-15), which print as the same number in model.py and
 * would leave an edge of no length.
 */
export function cleanLoop(loop: Pt[]): Pt[] {
  let size = 0;
  for (const p of loop) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]));
  const tol = 1e-9 * Math.max(size, 1e-9);
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const out: Pt[] = [];
  for (const p of loop) {
    const last = out[out.length - 1];
    if (!last || !same(last, p)) out.push(p);
  }
  while (out.length > 1 && same(out[0]!, out[out.length - 1]!)) out.pop();
  return out;
}

/** Whether every point of `pts` is on (center, r) and the chords between neighbours are all `chord` long. */
function onCircle(pts: Pt[], center: Pt, r: number, chord: number, closed: boolean): boolean {
  for (const p of pts) if (!near(len(sub(p, center)), r, r)) return false;
  const edges = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < edges; i++) if (!near(len(sub(pts[(i + 1) % pts.length]!, pts[i]!)), chord, chord)) return false;
  return true;
}

/** The point of the arc from `a` to `b` (on center, r, turning `turn` = ±1) halfway along it. */
function arcMid(a: Pt, b: Pt, center: Pt, r: number, turn: number): Pt {
  const a0 = Math.atan2(a[1] - center[1], a[0] - center[0]);
  let sweep = Math.atan2(b[1] - center[1], b[0] - center[0]) - a0;
  if (turn > 0) while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  const m = a0 + sweep / 2;
  return [center[0] + r * Math.cos(m), center[1] + r * Math.sin(m)];
}

/**
 * The loop's arcs, or null when there is nothing to recognise (the loop stays a polygon). `loop` is a simple closed
 * loop (a repeat of the first point at the end is fine), either orientation.
 */
export function recognizeLoop(input: Pt[], policy: ArcPolicy = {}): ExactLoop | null {
  const loop = cleanLoop(input);
  const n = loop.length;
  if (n < 4) return null;

  // the whole loop one circle: OpenSCAD's circle(), BOSL2's circle(), [for (a = …) r * [cos(a), sin(a)]]
  const whole = circleThrough(loop[0]!, loop[Math.floor(n / 3)]!, loop[Math.floor((2 * n) / 3)]!);
  if (whole && onCircle(loop, whole.center, whole.r, len(sub(loop[1]!, loop[0]!)), true)) {
    const step = 2 * Math.asin(Math.min(1, len(sub(loop[1]!, loop[0]!)) / (2 * whole.r)));
    // the same turn at every vertex (a star of equal chords on one circle is not a circle)
    const turns = loop.map((p, i) => Math.sign(cross(sub(p, loop[(i + n - 1) % n]!), sub(loop[(i + 1) % n]!, p))));
    // and fine enough to be a circle at all: a square's corners are on one circle too (8 sides is the coarsest)
    if (Math.abs(step * n - 2 * Math.PI) <= 1e-6 && step <= MAX_STEP && turns.every((t) => t === turns[0] && t !== 0)) {
      const wanted = policy.fullCircle ? policy.fullCircle(n, whole.r) : n >= MIN_FULL_CIRCLE;
      return wanted ? { kind: "circle", center: whole.center, r: whole.r, segments: n } : null;
    }
  }

  // runs of vertices that are each the middle of three points on one circle, with equal chords either side
  const at = (i: number) => loop[((i % n) + n) % n]!;
  type Run = { first: number; last: number; center: Pt; r: number; chord: number; turn: number };
  const circleAt = (i: number) => {
    const c = circleThrough(at(i - 1), at(i), at(i + 1));
    if (!c) return null;
    const chord = len(sub(at(i), at(i - 1)));
    if (!near(len(sub(at(i + 1), at(i))), chord, chord)) return null;
    const step = 2 * Math.asin(Math.min(1, chord / (2 * c.r)));
    // too coarse to be an arc, or so fine it is a straight run: a nearly straight polyline fits some huge circle, and
    // a tolerance relative to that radius lets anything through (a superformula's flank once came out as an arc)
    if (step > MAX_STEP || step < MIN_STEP) return null;
    return { ...c, chord, turn: Math.sign(cross(sub(at(i), at(i - 1)), sub(at(i + 1), at(i)))) };
  };
  const circles = loop.map((_, i) => circleAt(i));
  const same = (i: number, j: number) => {
    const a = circles[((i % n) + n) % n], b = circles[((j % n) + n) % n];
    return !!a && !!b && a.turn === b.turn && near(a.r, b.r, a.r) && len(sub(a.center, b.center)) <= ARC_TOLERANCE * a.r && near(a.chord, b.chord, a.chord);
  };
  // start the scan at a vertex that does not continue the run before it, so no run wraps past index 0
  let start = circles.findIndex((c, i) => !c || !same(i - 1, i));
  if (start < 0) return null; // every vertex alike but not one whole circle (handled above): leave it
  const runs: Run[] = [];
  for (let k = 0; k < n; ) {
    const i = (start + k) % n;
    const c = circles[i];
    if (!c) {
      k++;
      continue;
    }
    let len_ = 1;
    while (k + len_ < n && same(i + len_ - 1, i + len_)) len_++;
    runs.push({ first: start + k, last: start + k + len_ - 1, center: c.center, r: c.r, chord: c.chord, turn: c.turn });
    k += len_;
  }
  // overlapping candidates: a vertex between two arcs is the middle of a mixed circle, which `same` keeps out of both;
  // a lone vertex whose two chords happen to be equal is a candidate run of one — the acceptance rules sort it out
  type Arc = { from: number; to: number; center: Pt; r: number; turn: number; step: number };
  const candidates: Arc[] = runs.map((run) => ({
    from: run.first - 1,
    to: run.last + 1,
    center: run.center,
    r: run.r,
    turn: run.turn,
    step: 2 * Math.asin(Math.min(1, run.chord / (2 * run.r))),
  }));
  // keep candidates that do not share an edge with a longer one (two candidates may share an end vertex)
  candidates.sort((a, b) => b.to - b.from - (a.to - a.from));
  const used = new Set<number>();
  const kept: Arc[] = [];
  for (const arc of candidates) {
    let free = true;
    for (let e = arc.from; e < arc.to; e++) if (used.has(((e % n) + n) % n)) free = false;
    if (!free) continue;
    for (let e = arc.from; e < arc.to; e++) used.add(((e % n) + n) % n);
    kept.push(arc);
  }
  if (!kept.length) return null;

  // tangency at an end: the neighbouring edge (a line, or another arc) leaves the end point along the arc's tangent
  const arcByEdge = new Map<number, Arc>();
  for (const arc of kept) for (let e = arc.from; e < arc.to; e++) arcByEdge.set(((e % n) + n) % n, arc);
  const tangentAt = (arc: Arc, p: Pt) => {
    const radial = sub(p, arc.center);
    return [(-radial[1] * arc.turn) / arc.r, (radial[0] * arc.turn) / arc.r] as Pt; // direction of travel
  };
  const smooth = (arc: Arc, end: "from" | "to"): boolean => {
    const vertex = end === "from" ? arc.from : arc.to;
    const p = at(vertex);
    const edge = end === "from" ? vertex - 1 : vertex; // the neighbouring edge, by its first vertex
    const other = arcByEdge.get(((edge % n) + n) % n);
    const t = tangentAt(arc, p);
    let d: Pt;
    if (other && other !== arc) d = tangentAt(other, p);
    else {
      const q = end === "from" ? at(vertex - 1) : at(vertex + 1);
      const v = end === "from" ? sub(p, q) : sub(q, p);
      const l = len(v);
      if (!(l > 0)) return false;
      d = [v[0] / l, v[1] / l];
    }
    return Math.abs(cross(t, d)) <= TANGENT_TOLERANCE && dot(t, d) > 0;
  };
  const accepted = kept.filter((arc) => {
    const edges = arc.to - arc.from;
    if (edges < 2 || edges * arc.step > 2 * Math.PI - arc.step / 2) return false;
    const tangent = Number(smooth(arc, "from")) + Number(smooth(arc, "to"));
    if (tangent === 2) return true;
    if (tangent === 1) return edges >= 3;
    return edges >= 3 && arc.step <= LOOSE_STEP;
  });
  if (!accepted.length) return null;

  // the loop as vertices + arcs, starting at a vertex no arc passes through
  const inside = new Set<number>();
  const arcStarting = new Map<number, Arc>();
  for (const arc of accepted) {
    for (let v = arc.from + 1; v < arc.to; v++) inside.add(((v % n) + n) % n);
    arcStarting.set(((arc.from % n) + n) % n, arc);
  }
  const first = loop.findIndex((_, i) => !inside.has(i));
  const vertices: Pt[] = [];
  const arcs: (ArcEdge | null)[] = [];
  for (let k = 0; k < n; ) {
    const i = (first + k) % n;
    const arc = arcStarting.get(i);
    vertices.push(at(i));
    if (arc) {
      const end = at(arc.to);
      const chords = arc.to - arc.from;
      arcs.push({ center: arc.center, r: arc.r, mid: arcMid(at(i), end, arc.center, arc.r, arc.turn), turn: arc.turn, sweep: chords * arc.step, chords });
      k += arc.to - arc.from;
    } else {
      arcs.push(null);
      k += 1;
    }
  }
  const out: ExactLoop = { kind: "path", vertices, arcs, recognised: accepted.length };
  return checkLoop(loop, out) ? out : null;
}

/** Twice the signed area of a polygon. */
function area2(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) a += cross(loop[i]!, loop[(i + 1) % loop.length]!);
  return a;
}


/** The points where an arc reaches past its end points' box: where it crosses the axis directions. */
function arcExtremes(a: Pt, arc: ArcEdge): Pt[] {
  const a0 = Math.atan2(a[1] - arc.center[1], a[0] - arc.center[0]);
  const out: Pt[] = [];
  for (const q of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    let d = arc.turn * (q - a0);
    d -= 2 * Math.PI * Math.floor(d / (2 * Math.PI));
    if (d > 0 && d < arc.sweep) out.push([arc.center[0] + arc.r * Math.cos(q), arc.center[1] + arc.r * Math.sin(q)]);
  }
  return out;
}

/**
 * Signed area (counter-clockwise positive) and bounding box of a recognised loop, exactly: the polygon of its
 * vertices plus, for each arc, the signed segment between it and its chord (turn * r²/2 * (sweep − sin sweep)).
 */
export function exactLoopStats(loop: ExactLoop): { area: number; min: Pt; max: Pt } {
  if (loop.kind === "circle") {
    const { center: c, r } = loop;
    return { area: Math.PI * r * r, min: [c[0] - r, c[1] - r], max: [c[0] + r, c[1] + r] };
  }
  const n = loop.vertices.length;
  let area = area2(loop.vertices) / 2;
  const min: Pt = [Infinity, Infinity];
  const max: Pt = [-Infinity, -Infinity];
  const grow = (p: Pt) => {
    min[0] = Math.min(min[0], p[0]);
    min[1] = Math.min(min[1], p[1]);
    max[0] = Math.max(max[0], p[0]);
    max[1] = Math.max(max[1], p[1]);
  };
  for (const p of loop.vertices) grow(p);
  loop.arcs.forEach((arc, i) => {
    if (!arc) return;
    area += (arc.turn * arc.r * arc.r * (arc.sweep - Math.sin(arc.sweep))) / 2;
    for (const p of arcExtremes(loop.vertices[i]!, arc)) grow(p);
  });
  return { area, min, max };
}

/**
 * The check every recognised loop passes. Its exact area exceeds the polygon's by exactly the circular segments
 * between each replaced chord and its arc (turn * r²/2 * (step − sin step) a chord); its box contains the polygon's
 * and reaches past it by no more than a chord's sagitta. A wrong centre, a bulge on the wrong side, an arc that
 * skipped a vertex show here.
 */
function checkLoop(polygon: Pt[], exact: ExactLoop): boolean {
  if (exact.kind !== "path") return true;
  const { area, min, max } = exactLoopStats(exact);
  let expected = area2(polygon) / 2;
  let sagitta = 0;
  for (const arc of exact.arcs) {
    if (!arc) continue;
    const step = arc.sweep / arc.chords;
    expected += (arc.chords * arc.turn * arc.r * arc.r * (step - Math.sin(step))) / 2;
    sagitta = Math.max(sagitta, arc.r * (1 - Math.cos(step / 2)));
  }
  const scale = Math.max(max[0] - min[0], max[1] - min[1], 1e-9);
  if (Math.abs(area - expected) > 1e-9 * scale * scale) return false;
  // the polygon's vertices are all on the exact boundary: its box is inside the exact one, by at most a sagitta
  const pmin: Pt = [Infinity, Infinity];
  const pmax: Pt = [-Infinity, -Infinity];
  for (const p of polygon) {
    pmin[0] = Math.min(pmin[0], p[0]);
    pmin[1] = Math.min(pmin[1], p[1]);
    pmax[0] = Math.max(pmax[0], p[0]);
    pmax[1] = Math.max(pmax[1], p[1]);
  }
  const slack = 1e-9 * scale;
  for (const k of [0, 1]) {
    if (min[k]! > pmin[k]! + slack || max[k]! < pmax[k]! - slack) return false;
    if (pmin[k]! - min[k]! > sagitta + slack || max[k]! - pmax[k]! > sagitta + slack) return false;
  }
  return true;
}
