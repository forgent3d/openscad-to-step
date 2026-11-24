/**
 * Replace BOSL2 gear flanks with a smooth curve through every OpenSCAD point (transpile.ts `polygon()`, only on the
 * polygon drawn by `spur_gear2d()`).
 *
 * The tooth shape is always **BOSL2's own**: profile shift (`profile_shift = "auto"`), backlash, clearance and
 * undercut are all in the points it computes; no other library's
 * gear is swapped in (a different tip circle or tooth form would keep a pair of gears the author matched from meshing).
 * Only bd_warehouse's **approach** is borrowed: an interpolating spline through the sampled points.
 *
 * How BOSL2 produces these points (gears.scad `_gear_tooth_profile`): one tooth = root fillet (`arc(n = 8)`) + flank
 * (an involute, or the undercut
 * trochoid) + tip (external gear: points on the tip circle) + mirror; then `resample_path(n = 32, keep_corners = 30)` —
 * vertices turning >= 30° are
 * kept as-is as break points, and within each segment points are resampled **at equal arc length**. `spur_gear2d`
 * rotates the teeth around and joins them; between teeth there is a straight seam (external gear:
 * the line at the root that is tangent to the root circle).
 *
 * So segments follow BOSL2's own segments:
 *  - **Segment boundary**: two adjacent edge lengths differ by > 6% (a new segment began and the equal step changed;
 *    within one segment a chord at a bend is only <= 3% shorter than the step), or a turn >= 30° that is not
 *    "a middle point of a coarsely sampled arc" (both neighbors turn the same way, with smaller turns — a root fillet is
 *    left with only two or three points, and the middle one turns more than 40°).
 *  - **A segment of one edge**: an external gear with both ends at the maximum radius = the tooth tip, replaced by an
 *    arc around the gear center (BOSL2's tip points are taken in polar coordinates on the tip circle, there are just
 *    so few that only the two ends remain); anything else is a straight line (the root seam: BOSL2 makes it a line too).
 *  - **A segment of several edges** = one interpolating spline through every point in the segment. Where it meets a
 *    straight seam and is G1 (the turn at the joint is about half the next point's turn —
 *    how a fillet tangent to a line looks when sampled), the spline takes the line direction as its end tangent on that
 *    end, and on the other end estimates the tangent from the circle through the last three points (a true corner, not
 *    tangent to anything);
 *    if neither end is G1, both are free.
 * Not recognized (stays on the OpenSCAD facets as before) = null: a ring that is not `teeth`-fold symmetric about the
 * origin, edges too short, `hide`n teeth.
 *
 * The check happens in the kernel (transpile.ts `_exact_area_or`): the area difference between the exact face and the
 * OpenSCAD faceted face must be within the estimate of the sum of segment areas,
 * and the bounding-box difference must not exceed the largest sagitta — the estimates (`band`, `sag`) are produced here.
 */

import { cleanLoop } from "./arcs.ts";
import type { Pt } from "./polygon2d.ts";

/** The edge from a gear loop's vertex to the next one. */
export type GearEdge =
  | { kind: "line" }
  /** a tip: the arc about the gear centre through `mid` */
  | { kind: "arc"; mid: Pt }
  /** an interpolating spline through `through` (the points between the two vertices), with end tangents or free ends */
  | { kind: "spline"; through: Pt[]; tangents: [Pt, Pt] | null };

export type GearLoop = {
  vertices: Pt[];
  edges: GearEdge[];
  /** How much the loop's signed area (counter-clockwise positive) grows from the polygon's: [lo, hi] */
  band: [number, number];
  /** How far past the polygon's box the loop may reach */
  sag: number;
  splines: number;
  arcs: number;
};

/** The thresholds (gears.test.ts pins them). */
export const SPACING_BREAK = 0.06;
export const CORNER_TURN = (30 * Math.PI) / 180;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const unit = (a: Pt): Pt => {
  const l = len(a);
  return [a[0] / l, a[1] / l];
};

/** Signed curvature of the circle through a, b, c (left turn positive); 0 when they are collinear. */
function curvature(a: Pt, b: Pt, c: Pt): number {
  const ab = len(sub(b, a)), bc = len(sub(c, b)), ca = len(sub(a, c));
  const d = ab * bc * ca;
  return d > 0 ? (2 * cross(sub(b, a), sub(c, b))) / d : 0;
}

/**
 * The direction of travel, at `a` (end "first") or at `c` (end "last"), of the circle through a, b, c — the chord to
 * the neighbour turned back (first) or on (last) by half the angle the arc turns along it; the chord when collinear.
 */
export function tangentAtEnd(a: Pt, b: Pt, c: Pt, end: "first" | "last"): Pt {
  const k = curvature(a, b, c);
  const chord = end === "first" ? sub(b, a) : sub(c, b);
  const half = Math.asin(Math.max(-1, Math.min(1, (k * len(chord)) / 2))) * (end === "first" ? -1 : 1);
  const u = unit(chord);
  return [u[0] * Math.cos(half) - u[1] * Math.sin(half), u[0] * Math.sin(half) + u[1] * Math.cos(half)];
}

/**
 * Whether `loop` is `teeth` copies of one tooth turned about the origin (BOSL2 draws every tooth by `zrot`): proves
 * the centre is the origin and the points are a gear's, not some other loop of the region (the bore).
 */
function toothPeriod(loop: Pt[], teeth: number): number | null {
  const n = loop.length;
  if (!(teeth >= 3) || n % teeth !== 0) return null;
  const period = n / teeth;
  if (period < 4) return null;
  let size = 0;
  for (const p of loop) size = Math.max(size, len(p));
  const tol = 1e-9 * size;
  for (const dir of [1, -1]) {
    const a = (dir * 2 * Math.PI) / teeth;
    const c = Math.cos(a), s = Math.sin(a);
    if (loop.every((p, i) => {
      const q = loop[(i + period) % n]!;
      return Math.abs(p[0] * c - p[1] * s - q[0]) <= tol && Math.abs(p[0] * s + p[1] * c - q[1]) <= tol;
    })) return period;
  }
  return null;
}

/**
 * A loop `spur_gear2d()` drew, as lines, tip arcs and splines through every point (see the header); null when it is not
 * one (the caller keeps the polygon).
 */
export function gearLoop(input: Pt[], teeth: number, external: boolean): GearLoop | null {
  const loop = cleanLoop(input);
  const n = loop.length;
  if (n < 8 || toothPeriod(loop, teeth) === null) return null;
  const at = (i: number) => loop[((i % n) + n) % n]!;
  const edge = (i: number) => len(sub(at(i + 1), at(i)));
  let rmax = 0;
  for (const p of loop) rmax = Math.max(rmax, len(p));
  // the kernel's interpolation refuses points closer than 1e-6; BOSL2's are a resampling step (~0.15 * module) apart
  for (let i = 0; i < n; i++) if (!(edge(i) > 1e-5 * Math.max(1, rmax))) return null;
  const turn = (i: number) => {
    const u = sub(at(i), at(i - 1)), v = sub(at(i + 1), at(i));
    return Math.atan2(cross(u, v), dot(u, v));
  };
  const turns = loop.map((_, i) => turn(i));
  const t = (i: number) => turns[((i % n) + n) % n]!;

  // where BOSL2's sections meet: the resampling step changes, or a corner it kept
  const isBreak = (i: number) => {
    const a = edge(i - 1), b = edge(i);
    if (Math.abs(a - b) > SPACING_BREAK * Math.max(a, b)) return true;
    const th = t(i);
    if (Math.abs(th) < CORNER_TURN) return false;
    // the middle of a coarsely sampled arc (a root fillet of two or three points): both neighbours turn the same way, less
    const coarseArc = Math.sign(t(i - 1)) === Math.sign(th) && Math.sign(t(i + 1)) === Math.sign(th) && Math.abs(t(i - 1)) < Math.abs(th) && Math.abs(t(i + 1)) < Math.abs(th);
    return !coarseArc;
  };
  const breaks: number[] = [];
  for (let i = 0; i < n; i++) if (isBreak(i)) breaks.push(i);
  if (breaks.length < 2) return null;

  type Section = { from: number; to: number; kind: "line" | "arc" | "spline" };
  const sections: Section[] = breaks.map((from, k) => {
    const next = breaks[(k + 1) % breaks.length]!;
    const to = next > from ? next : next + n;
    return { from, to, kind: "spline" as const };
  });
  const onTip = (i: number) => Math.abs(len(at(i)) - rmax) <= 1e-9 * rmax;
  for (const s of sections) {
    if (s.to - s.from === 1) s.kind = external && onTip(s.from) && onTip(s.to) ? "arc" : "line";
    else {
      // straight after all (no turn inside): lines
      let straight = true;
      for (let i = s.from + 1; i < s.to; i++) if (Math.abs(t(i)) > 1e-9) straight = false;
      if (straight) s.kind = "line";
    }
  }

  const vertices: Pt[] = [];
  const edges: GearEdge[] = [];
  let lo = 0, hi = 0, sag = 0, splines = 0, arcs = 0;
  sections.forEach((s, k) => {
    if (s.kind === "line") {
      for (let i = s.from; i < s.to; i++) {
        vertices.push(at(i));
        edges.push({ kind: "line" });
      }
      return;
    }
    vertices.push(at(s.from));
    if (s.kind === "arc") {
      const a = at(s.from), b = at(s.to);
      const m = unit([a[0] + b[0], a[1] + b[1]]);
      edges.push({ kind: "arc", mid: [m[0] * rmax, m[1] * rmax] });
      const sweep = 2 * Math.asin(Math.min(1, len(sub(b, a)) / (2 * rmax)));
      const area = (Math.sign(cross(a, b)) * rmax * rmax * (sweep - Math.sin(sweep))) / 2;
      lo += area;
      hi += area;
      sag = Math.max(sag, rmax * (1 - Math.cos(sweep / 2)));
      arcs++;
      return;
    }
    // a spline: its end tangents where it meets a straight joint smoothly (the joint's direction), else free
    const prev = sections[(k + sections.length - 1) % sections.length]!;
    const next = sections[(k + 1) % sections.length]!;
    const g1 = (vertex: number, inner: number) => {
      const a = t(vertex), b = t(inner);
      return Math.sign(a) === Math.sign(b) && Math.abs(a) >= 0.3 * Math.abs(b) && Math.abs(a) <= 0.7 * Math.abs(b);
    };
    const startLine = prev.kind === "line" && g1(s.from, s.from + 1) ? unit(sub(at(s.from), at(s.from - 1))) : null;
    const endLine = next.kind === "line" && g1(s.to, s.to - 1) ? unit(sub(at(s.to + 1), at(s.to))) : null;
    let tangents: [Pt, Pt] | null = null;
    if (startLine || endLine) {
      tangents = [
        startLine ?? tangentAtEnd(at(s.from), at(s.from + 1), at(s.from + 2), "first"),
        endLine ?? tangentAtEnd(at(s.to - 2), at(s.to - 1), at(s.to), "last"),
      ];
    }
    const through: Pt[] = [];
    for (let i = s.from + 1; i < s.to; i++) through.push(at(i));
    edges.push({ kind: "spline", through, tangents });
    splines++;
    // the area between each chord and the curve: about κ * L³ / 12 (a circular segment), κ the mean of the circles
    // through the chord's ends and their neighbours (an end on a smooth straight joint: half the curve's)
    for (let i = s.from; i < s.to; i++) {
      const a = at(i), b = at(i + 1);
      const L = len(sub(b, a));
      const kA = i === s.from ? (startLine ? 0 : curvature(a, b, at(i + 2))) : curvature(at(i - 1), a, b);
      const kB = i + 1 === s.to ? (endLine ? 0 : curvature(at(i - 1), a, b)) : curvature(a, b, at(i + 2));
      const k = (kA + kB) / 2;
      const area = (k * L * L * L) / 12;
      // the estimate is a circle's; a spline through the same points differs from it by less than the segment itself
      lo += Math.min(0, 2 * area);
      hi += Math.max(0, 2 * area);
      sag = Math.max(sag, (Math.max(Math.abs(kA), Math.abs(kB)) * L * L) / 4);
    }
  });
  if (!splines) return null;
  return { vertices, edges, band: [lo, hi], sag, splines, arcs };
}
