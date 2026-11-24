/**
 * Recover exact geometry from BOSL2 shapes (called from transpile.ts). BOSL2 computes its rounded corners, spheres
 * and cylinders into polygons / VNF polyhedra itself before handing them to OpenSCAD: `cuboid(rounding=)` is a
 * minkowski / hull, `cyl(rounding=)` is a revolved VNF, `spheroid()` is a VNF,
 * `prismoid(rounding=)` is the hull of two rings of rounded rectangles. Translated as-is they are all planar facets,
 * while STEP needs true cylinders and true spheres.
 *
 * **How they are recognized**: with `-O fgjson/scope=<BOSL2_SCOPED>` the custom-built OpenSCAD attaches to the groups
 * of these modules a `scope` (the values after parameters take their defaults and are then overwritten by top-level
 * assignments in the body), `specials` (the `$fn/$fa/$fs` at the call) and `defined` (the file that defines it).
 * Only modules defined in `BOSL2/*.scad` count; a `cuboid()` written in the project itself is not one.
 *
 * **Intent**: BOSL2's `$fn` is almost always computed by BOSL2 itself from `$fa/$fs` (`segs(r)`), not written by the
 * author; only when the author's call has `$fn` of 0 (or > 12) is the shape taken as a true circle.
 * A call-site `$fn` in 1..12 means the author wants facets (a hex nut), so it is kept as-is (`smoothIntent`).
 *
 * **Never silently wrong**: every replacement is first checked against what OpenSCAD itself produced for that piece;
 * if they do not agree, it falls back to facets and emits a warning:
 *  - Leaf VNFs (spheroid / cyl / prismoid): checked in TS directly against the polyhedron itself — every vertex lies
 *    on the exact surface (using BOSL2's sampling convention), and the difference between the polyhedron's volume and
 *    the exact volume is within the facet error (solid of revolution: the volume identity
 *    V_mesh = k_n * V_rev(polyline profile));
 *  - cuboid (composite: a subtree of hull / minkowski): which edges are rounded is read from the scope of the
 *    `corner_shape` that BOSL2 computed itself;
 *    the geometry is checked in the kernel — the exact solid is compared with the faceted version of the same OpenSCAD
 *    subtree (`$fn` built as-is as a polygon) on volume / bounding box / centroid,
 *    once per distinct set of parameters (transpile.ts `_exact_or`).
 * Parameters not understood (texture, teardrop, clip_angle, trimcorners = false…) = stay as before (facets), with an
 * explanation of why. A cuboid with negative rounding is not handled here: it is a block
 * plus a mask of `cyl()`s, and by intent a cyl is a true cylinder (transpile.ts `smoothCall`), with booleans as usual.
 * The same goes for `circle($fn = segs)` in `ellipse()`.
 */

import type { CsgNode, ScopeValue } from "./tree.ts";
import { recognizeLoop, type ArcEdge, type ArcPolicy, type ExactLoop } from "./arcs.ts";
import type { Pt } from "./polygon2d.ts";

/** The modules csg.ts asks the scope of (`-O fgjson/scope=…`) when a source uses BOSL2. */
export const BOSL2_SCOPED = ["cuboid", "corner_shape", "cyl", "spheroid", "prismoid", "ellipse", "spur_gear2d"];

/** A BOSL2 library file, wherever it is mounted: `/libraries/BOSL2/x.scad` reads as `BOSL2/x.scad`, a project's copy `libs/BOSL2/x.scad`. */
export const isBosl2File = (file: string | undefined): boolean => !!file && /(^|\/)BOSL2\/[^/]+\.scad$/.test(file);

/** A group that is a call of one of BOSL2's own modules, with its scope. */
export const isBosl2Call = (node: CsgNode): boolean => !!node.module && !!node.scope && isBosl2File(node.defined?.file);

/** Made by BOSL2's code (the call that produced the node is in a BOSL2 file), not by the author's children. */
export const madeByBosl2 = (node: CsgNode): boolean => isBosl2File(node.at?.file);

type Specials = NonNullable<CsgNode["specials"]>;

/** The author meant a smooth shape: `$fn` at the call is 0 (BOSL2 computes the facets) or above 12. */
export function smoothIntent(call: CsgNode): boolean {
  const fn = call.specials?.$fn ?? 0;
  return !(fn > 0 && fn <= 12);
}

/** BOSL2's `segs(r)` (utility.scad). */
export function bosl2Segs(r: number, s: Specials): number {
  const fn = s.$fn ?? 0;
  if (fn > 0) return fn > 3 ? fn : 3;
  return Math.ceil(Math.max(5, Math.min(360 / (s.$fa ?? 12), (Math.abs(r) * 2 * Math.PI) / (s.$fs ?? 2))));
}

// ------------------------------------------------------------------ scope values

const num = (v: ScopeValue | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isUndef = (v: ScopeValue | undefined) => v === null || v === undefined;
const vec = (v: ScopeValue | undefined, n: number): number[] | undefined =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : undefined;
const get = (call: CsgNode, key: string) => call.scope?.get(key);

// ------------------------------------------------------------------ polyhedra

/** Signed volume (outward faces positive) and box of a polyhedron's faces, fanned from each face's first corner. */
export function polyhedronStats(points: number[][], faces: number[][]): { volume: number; min: number[]; max: number[] } {
  let volume = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k]!, p[k]!);
    max[k] = Math.max(max[k]!, p[k]!);
  }
  for (const f of faces) {
    const a = points[f[0]!]!;
    for (let i = 1; i + 1 < f.length; i++) {
      const b = points[f[i]!]!, c = points[f[i + 1]!]!;
      volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    }
  }
  return { volume, min, max };
}

/** A polyhedron's points and faces as numbers, or null. */
export function polyhedronOf(node: CsgNode): { points: number[][]; faces: number[][] } | null {
  const points = node.args.get("points");
  const faces = node.args.get("faces") ?? node.args.get("triangles");
  if (!Array.isArray(points) || !Array.isArray(faces)) return null;
  if (!points.every((p) => Array.isArray(p) && p.length === 3 && p.every((x) => typeof x === "number" && Number.isFinite(x)))) return null;
  if (!faces.every((f) => Array.isArray(f) && f.every((i) => typeof i === "number" && Number.isInteger(i) && i >= 0 && i < points.length))) return null;
  return { points: points as number[][], faces: faces as number[][] };
}

export type Exact<T> = ({ ok: true } & T) | { ok: false; why: string };

// ------------------------------------------------------------------ spheroid

/**
 * `spheroid(r)`: every style's VNF has its vertices on the sphere (circum = false). The exact sphere is where the
 * VNF's points are equidistant from their centre, and the VNF's volume is under the sphere's by no more than its
 * facets can take away.
 */
export function exactSpheroid(call: CsgNode, poly: { points: number[][]; faces: number[][] }): Exact<{ center: number[]; r: number }> {
  if (get(call, "circum") === true) return { ok: false, why: "circum = true (the facets circumscribe the sphere)" };
  const r = num(get(call, "r"));
  if (!r || r <= 0) return { ok: false, why: "no radius in its scope" };
  const stats = polyhedronStats(poly.points, poly.faces);
  const { min, max } = stats;
  const volume = Math.abs(stats.volume); // VNF faces may wind either way; OpenSCAD orients them
  const center = [0, 1, 2].map((k) => (min[k]! + max[k]!) / 2);
  let worst = 0;
  for (const p of poly.points) worst = Math.max(worst, Math.abs(Math.hypot(p[0]! - center[0]!, p[1]! - center[1]!, p[2]! - center[2]!) - r));
  if (worst > 1e-7 * r) return { ok: false, why: `its points are not all on the sphere r = ${r} (off by ${worst.toPrecision(3)})` };
  // an inscribed polyhedron: its volume is under the sphere's by the caps its faces cut off — at most what a face's
  // circumcircle cuts (the longest edge bounds it)
  let edge = 0;
  for (const f of poly.faces) for (let i = 0; i < f.length; i++) {
    const a = poly.points[f[i]!]!, b = poly.points[f[(i + 1) % f.length]!]!;
    edge = Math.max(edge, Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
  }
  const sphere = (4 / 3) * Math.PI * r ** 3;
  const cap = r - Math.sqrt(Math.max(0, r * r - (edge * edge) / 3)); // a face's circumradius is at most edge/√3
  const deficit = 4 * Math.PI * r * r * cap;
  if (!(volume <= sphere * (1 + 1e-9)) || sphere - volume > deficit * 1.01 + 1e-9 * sphere) {
    return { ok: false, why: `its volume ${volume.toPrecision(6)} is not a sphere's ${sphere.toPrecision(6)} less its facets` };
  }
  return { ok: true, center, r };
}

// ------------------------------------------------------------------ cyl

/** A piece of a cyl() profile between two of its corner points: a line, or a fillet arc (centre, radius in BOSL2's scaled space). */
type ProfilePiece = { kind: "line" } | { kind: "arc"; center: Pt; r: number };
type Profile = { points: Pt[]; pieces: ProfilePiece[]; scale: number };

const rad = Math.PI / 180;
const sind = (a: number) => Math.sin(a * rad);
const cosd = (a: number) => Math.cos(a * rad);
const tand = (a: number) => Math.tan(a * rad);
const atan2d = (y: number, x: number) => Math.atan2(y, x) / rad;
const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);
const first = (...values: (number | undefined)[]) => values.find((v) => v !== undefined);

/**
 * The fillet of radius r in the corner p0 → p1 → p2: the circle tangent to both lines, and its tangent points (BOSL2
 * `circle_2tangents`, which `arc(r, corner=…)` draws between).
 */
function fillet(r: number, p0: Pt, p1: Pt, p2: Pt): { center: Pt; t1: Pt; t2: Pt } | null {
  const u = [p0[0] - p1[0], p0[1] - p1[1]], v = [p2[0] - p1[0], p2[1] - p1[1]];
  const lu = Math.hypot(u[0]!, u[1]!), lv = Math.hypot(v[0]!, v[1]!);
  if (!(lu > 0 && lv > 0)) return null;
  const uu = [u[0]! / lu, u[1]! / lu], vv = [v[0]! / lv, v[1]! / lv];
  const angle = Math.acos(Math.max(-1, Math.min(1, uu[0]! * vv[0]! + uu[1]! * vv[1]!)));
  if (!(angle > 1e-9 && angle < Math.PI - 1e-9)) return null;
  const d = r / Math.tan(angle / 2);
  const bis = [uu[0]! + vv[0]!, uu[1]! + vv[1]!];
  const lb = Math.hypot(bis[0]!, bis[1]!);
  const h = r / Math.sin(angle / 2);
  return {
    center: [p1[0] + (bis[0]! / lb) * h, p1[1] + (bis[1]! / lb) * h],
    t1: [p1[0] + uu[0]! * d, p1[1] + uu[1]! * d],
    t2: [p1[0] + vv[0]! * d, p1[1] + vv[1]! * d],
  };
}

/**
 * BOSL2's `_cyl_path()` (shapes3d.scad) for the profile options this supports — chamfers (with chamfang, from_end),
 * roundings (either sign) — at `n` facets (`n` undefined: the smooth shape, scale 1). Corner points in vertex space
 * (BOSL2 divides x by cos(180/n) so the FACES of the n-gon carry the profile), arcs in scaled space.
 */
function cylPath(o: CylOptions, n: number | undefined, noscale: boolean): Profile | string {
  const { r1, r2, l } = o;
  const scale = n !== undefined ? cosd(180 / n) : 1;
  const vang = atan2d(scale * (r1 - r2), l);
  const chamf1 = first(o.chamfer1, o.rounding1 === undefined ? o.chamfer : undefined, 0)!;
  const chamf2 = first(o.chamfer2, o.rounding2 === undefined ? o.chamfer : undefined, 0)!;
  const fromend1 = o.from_end1 ?? o.from_end ?? false;
  const fromend2 = o.from_end2 ?? o.from_end ?? false;
  const chang1 = first(o.chamfang1, o.chamfang, 45 + (sign(chamf1) * vang) / 2)!;
  const chang2 = first(o.chamfang2, o.chamfang, 45 - (sign(chamf2) * vang) / 2)!;
  const round1 = first(o.rounding1, o.chamfer1 === undefined ? o.rounding : undefined, 0)!;
  const round2 = first(o.rounding2, o.chamfer2 === undefined ? o.rounding : undefined, 0)!;
  const unscale = noscale ? scale : 1;
  const lawB = (a: number, A: number, B: number) => (a / sind(A)) * sind(B);
  const chamf1r = !chamf1 ? 0 : !fromend1 ? unscale * chamf1 : unscale * lawB(chamf1, chang1, 180 - chang1 - (90 - sign(chamf2) * vang));
  const chamf2r = !chamf2 ? 0 : !fromend2 ? unscale * chamf2 : unscale * lawB(chamf2, chang2, 180 - chang2 - (90 + sign(chamf2) * vang));
  const chamf1l = !chamf1 ? 0 : fromend1 ? Math.abs(chamf1) : Math.abs(lawB(chamf1, 180 - chang1 - (90 - sign(chamf1) * vang), chang1));
  const chamf2l = !chamf2 ? 0 : fromend2 ? Math.abs(chamf2) : Math.abs(lawB(chamf2, 180 - chang2 - (90 + sign(chamf2) * vang), chang2));
  const roundlen1 = round1 >= 0 ? round1 / tand(45 - vang / 2) : round1 / tand(45 + vang / 2);
  const roundlen2 = round2 >= 0 ? round2 / tand(45 + vang / 2) : round2 / tand(45 - vang / 2);
  const near0 = (x: number) => Math.abs(x) < 1e-9;
  const points: Pt[] = [];
  const pieces: ProfilePiece[] = [];
  const unscaled = (p: Pt): Pt => [p[0] / scale, p[1]];
  // bottom
  if (!near0(chamf1r)) {
    points.push([r1 - chamf1r / scale, -l / 2], [r1 + (chamf1l * cosd(90 + vang)) / scale, -l / 2 + chamf1l * sind(90 + vang)]);
    pieces.push({ kind: "line" });
  } else if (!near0(round1)) {
    const f = fillet(Math.abs(round1 * unscale), [r1 * scale - 2 * roundlen1, -l / 2], [r1 * scale, -l / 2], [r2 * scale, l / 2]);
    if (!f) return "rounding1 has no fillet in that corner";
    points.push(unscaled(f.t1), unscaled(f.t2));
    pieces.push({ kind: "arc", center: f.center, r: Math.abs(round1 * unscale) });
  } else {
    points.push([r1, -l / 2]);
  }
  pieces.push({ kind: "line" }); // the side, from the bottom's last point to the top's first
  // top
  if (!near0(chamf2r)) {
    points.push([r2 + (chamf2l * cosd(270 + vang)) / scale, l / 2 + chamf2l * sind(270 + vang)], [r2 - chamf2r / scale, l / 2]);
    pieces.push({ kind: "line" });
  } else if (!near0(round2)) {
    const f = fillet(Math.abs(round2 * unscale), [r1 * scale, -l / 2], [r2 * scale, l / 2], [r2 * scale - 2 * roundlen2, l / 2]);
    if (!f) return "rounding2 has no fillet in that corner";
    points.push(unscaled(f.t1), unscaled(f.t2));
    pieces.push({ kind: "arc", center: f.center, r: Math.abs(round2 * unscale) });
  } else {
    points.push([r2, l / 2]);
  }
  // BOSL2 deduplicates: a side of zero length leaves the bottom's last point equal to the top's first
  for (let i = points.length - 1; i > 0; i--) {
    if (Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]) <= 1e-12 * Math.max(1, l)) {
      points.splice(i, 1);
      pieces.splice(i - 1, 1);
    }
  }
  if (points.some((p) => p[0] < -1e-9)) return "a rounding or chamfer is wider than the radius";
  return { points, pieces, scale };
}

type CylOptions = {
  r1: number; r2: number; l: number;
  chamfer?: number; chamfer1?: number; chamfer2?: number;
  chamfang?: number; chamfang1?: number; chamfang2?: number;
  rounding?: number; rounding1?: number; rounding2?: number;
  from_end?: boolean; from_end1?: boolean; from_end2?: boolean;
};

/** Distance from p (vertex space) to a profile's piece i, measured in BOSL2's scaled space for an arc. */
function pieceDistance(profile: Profile, i: number, p: Pt): number {
  const a = profile.points[i]!, b = profile.points[i + 1]!;
  const piece = profile.pieces[i]!;
  if (piece.kind === "line") {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  const s: Pt = [p[0] * profile.scale, p[1]];
  const onCircle = Math.abs(Math.hypot(s[0] - piece.center[0], s[1] - piece.center[1]) - piece.r);
  // and between the arc's ends (the short way round: a fillet is under 180°)
  const as: Pt = [a[0] * profile.scale, a[1]], bs: Pt = [b[0] * profile.scale, b[1]];
  const ang = (q: Pt) => Math.atan2(q[1] - piece.center[1], q[0] - piece.center[0]);
  let span = ang(bs) - ang(as);
  while (span > Math.PI) span -= 2 * Math.PI;
  while (span < -Math.PI) span += 2 * Math.PI;
  let at = ang(s) - ang(as);
  while (at > Math.PI) at -= 2 * Math.PI;
  while (at < -Math.PI) at += 2 * Math.PI;
  const inside = span >= 0 ? at >= -1e-9 && at <= span + 1e-9 : at <= 1e-9 && at >= span - 1e-9;
  return inside ? onCircle : Infinity;
}

/**
 * `cyl(rounding= | chamfer=)`: a rotate_sweep VNF. The VNF's rings, read back as a profile, must be BOSL2's own
 * `_cyl_path` at its facet count (each vertex on it, each of its corners present, the same count on every ring) and
 * its volume must be the n-gon revolution of that profile exactly (V = n*sin(2π/n)/2π * V_rev). Then the exact shape
 * is the same path at scale 1 — BOSL2's smooth limit — revolved.
 */
export function exactCyl(call: CsgNode, poly: { points: number[][]; faces: number[][] }): Exact<{ profile: ExactLoop }> {
  if (!isUndef(get(call, "texture"))) return { ok: false, why: "texture=" };
  const teardrop = get(call, "teardrop");
  if (teardrop !== false && teardrop !== null && teardrop !== undefined) return { ok: false, why: "teardrop=" };
  if ((num(get(call, "clip_angle")) ?? 90) !== 90) return { ok: false, why: "clip_angle=" };
  const extra = num(get(call, "extra")), extra1 = num(get(call, "extra1")), extra2 = num(get(call, "extra2"));
  const ex1 = first(extra1, extra, 0)!, ex2 = first(extra2, extra, 0)!;
  const l = num(get(call, "l"));
  const nominal1 = num(get(call, "_r1")), nominal2 = num(get(call, "_r2"));
  const sides = num(get(call, "sides"));
  const sc = num(get(call, "sc")) ?? 1;
  const circum = get(call, "circum") === true;
  if (l === undefined || nominal1 === undefined || nominal2 === undefined || sides === undefined) return { ok: false, why: "its scope lacks l / _r1 / _r2 / sides" };
  const opt = (key: string) => num(get(call, key));
  const flag = (key: string) => (get(call, key) === true ? true : get(call, key) === false ? false : undefined);
  const options = {
    chamfer: opt("chamfer"), chamfer1: opt("chamfer1"), chamfer2: opt("chamfer2"),
    chamfang: opt("chamfang"), chamfang1: opt("chamfang1"), chamfang2: opt("chamfang2"),
    rounding: opt("rounding"), rounding1: opt("rounding1"), rounding2: opt("rounding2"),
    from_end: flag("from_end"), from_end1: flag("from_end1"), from_end2: flag("from_end2"),
  };
  const faceted = cylPath({ ...options, r1: nominal1 * sc, r2: nominal2 * sc, l }, sides, !circum);
  const smooth = cylPath({ ...options, r1: nominal1, r2: nominal2, l }, undefined, false);
  if (typeof faceted === "string") return { ok: false, why: faceted };
  if (typeof smooth === "string") return { ok: false, why: smooth };
  // the full sweep path: from the axis, through the profile (with the extensions), back to the axis
  const withExtra = (profile: Profile): Profile => {
    const points = [...profile.points];
    const pieces = [...profile.pieces];
    if (ex1 > 0) {
      points.unshift([points[0]![0], points[0]![1] - ex1]);
      pieces.unshift({ kind: "line" });
    }
    if (ex2 > 0) {
      points.push([points[points.length - 1]![0], points[points.length - 1]![1] + ex2]);
      pieces.push({ kind: "line" });
    }
    points.unshift([0, -l / 2 - ex1]);
    pieces.unshift({ kind: "line" });
    points.push([0, l / 2 + ex2]);
    pieces.push({ kind: "line" });
    return { points, pieces, scale: profile.scale };
  };
  const want = withExtra(faceted);
  const size = Math.max(l + ex1 + ex2, 2 * Math.max(...want.points.map((p) => p[0])));
  const tol = 1e-7 * size;

  // the VNF's rings: (ρ, z) → the angles it has there
  const rings = new Map<string, { rho: number; z: number; count: number }>();
  const keyOf = (rho: number, z: number) => `${Math.round(rho / tol)},${Math.round(z / tol)}`;
  for (const p of poly.points) {
    const rho = Math.hypot(p[0]!, p[1]!), z = p[2]!;
    const key = keyOf(rho, z);
    const ring = rings.get(key);
    if (ring) ring.count++;
    else rings.set(key, { rho, z, count: 1 });
  }
  const off = [...rings.values()].map((ring) => ({ ring, d: Math.min(...want.pieces.map((_, i) => pieceDistance(want, i, [ring.rho, ring.z]))) })).filter(({ d }) => d > tol);
  if (off.length) return { ok: false, why: `a ring at (r ${off[0]!.ring.rho.toPrecision(5)}, z ${off[0]!.ring.z.toPrecision(5)}) is not on BOSL2's profile` };
  for (const corner of want.points) {
    const found = [...rings.values()].some((ring) => Math.hypot(ring.rho - corner[0], ring.z - corner[1]) <= tol);
    if (!found) return { ok: false, why: `the profile point (${corner[0].toPrecision(5)}, ${corner[1].toPrecision(5)}) is missing from the VNF` };
  }
  // the n-gon revolution: the same number of distinct angles on every ring off the axis
  const angleCounts = new Map<string, Set<string>>();
  for (const p of poly.points) {
    const rho = Math.hypot(p[0]!, p[1]!);
    if (rho <= tol) continue;
    const key = keyOf(rho, p[2]!);
    if (!angleCounts.has(key)) angleCounts.set(key, new Set());
    angleCounts.get(key)!.add(String(Math.round(Math.atan2(p[1]!, p[0]!) * 1e7)));
  }
  const counts = new Set([...angleCounts.values()].map((set) => set.size));
  if (counts.size !== 1) return { ok: false, why: "its rings do not all have the same number of facets" };
  const n = [...counts][0]!;
  if (n < 3) return { ok: false, why: "fewer than three facets a ring" };
  // V_mesh = k_n * V_rev(the polygonal profile through the rings, in profile order)
  const ordered = [...rings.values()].map((ring) => ({ ring, t: profileParameter(want, [ring.rho, ring.z]) })).sort((a, b) => a.t - b.t).map(({ ring }) => [ring.rho, ring.z] as Pt);
  const vRev = revolvedVolume(ordered);
  const vMesh = Math.abs(polyhedronStats(poly.points, poly.faces).volume);
  const kn = (n * Math.sin((2 * Math.PI) / n)) / (2 * Math.PI);
  if (Math.abs(vMesh - kn * vRev) > 1e-7 * Math.max(vMesh, 1e-12)) {
    return { ok: false, why: `its volume ${vMesh.toPrecision(7)} is not the ${n}-gon revolution of its profile (${(kn * vRev).toPrecision(7)})` };
  }
  return { ok: true, profile: profileLoop(withExtra(smooth)) };
}

/** Where along a profile a point is: the index of its nearest piece plus how far along it. */
function profileParameter(profile: Profile, p: Pt): number {
  let best = Infinity, at = 0;
  profile.pieces.forEach((_, i) => {
    const d = pieceDistance(profile, i, p);
    if (d < best) {
      best = d;
      const a = profile.points[i]!, b = profile.points[i + 1]!;
      const t = Math.hypot(p[0] - a[0], p[1] - a[1]) / (Math.hypot(p[0] - a[0], p[1] - a[1]) + Math.hypot(p[0] - b[0], p[1] - b[1]) || 1);
      at = i + t;
    }
  });
  return at;
}

/** The volume a closed polygonal (ρ, z) profile sweeps about the z axis (Pappus, in closed form per edge). */
export function revolvedVolume(profile: Pt[]): number {
  let v = 0;
  for (let i = 0; i < profile.length; i++) {
    const [r1, z1] = profile[i]!, [r2, z2] = profile[(i + 1) % profile.length]!;
    // ∮ π ρ² dz along the edge
    v += (Math.PI * (z2 - z1) * (r1 * r1 + r1 * r2 + r2 * r2)) / 3;
  }
  return Math.abs(v);
}

/** A smooth profile (scale 1) as a closed loop in (ρ, z): its arcs as ArcEdges, closed along the axis. */
function profileLoop(profile: Profile): ExactLoop {
  const vertices = profile.points;
  const arcs: (ArcEdge | null)[] = profile.pieces.map((piece, i) => {
    if (piece.kind === "line") return null;
    const a = vertices[i]!, b = vertices[i + 1]!;
    const c = piece.center;
    const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    let sweep = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const m = a0 + sweep / 2;
    return { center: c, r: piece.r, mid: [c[0] + piece.r * Math.cos(m), c[1] + piece.r * Math.sin(m)], turn: sign(sweep), sweep: Math.abs(sweep), chords: 1 };
  });
  arcs.push(null); // the axis, from the top back to the bottom
  return { kind: "path", vertices, arcs, recognised: arcs.filter((a) => a).length };
}

// ------------------------------------------------------------------ prismoid

/**
 * `prismoid(rounding=)`: the VNF is the convex hull of two rounded rectangles (BOSL2 `rect()`), one at each end. Both
 * rings recognised as arcs (arcs.ts) with the same structure, the exact solid is the ruled loft between them — the
 * hull's sides pair up points of equal normal, which is what a ruled loft between edges of equal sweep does.
 */
export function exactPrismoid(_call: CsgNode, poly: { points: number[][]; faces: number[][] }, policy: ArcPolicy = {}): Exact<{ z0: number; z1: number; loop0: ExactLoop; loop1: ExactLoop; straight: boolean }> {
  const zs = [...new Set(poly.points.map((p) => p[2]!))];
  const lo = Math.min(...zs), hi = Math.max(...zs);
  const size = Math.max(hi - lo, ...poly.points.map((p) => Math.abs(p[0]!)), ...poly.points.map((p) => Math.abs(p[1]!)), 1e-9);
  const tol = 1e-9 * size;
  const bottom = poly.points.filter((p) => Math.abs(p[2]! - lo) <= tol);
  const top = poly.points.filter((p) => Math.abs(p[2]! - hi) <= tol);
  if (bottom.length + top.length !== poly.points.length || hi - lo <= tol) return { ok: false, why: "its points are not on two levels" };
  // BOSL2 lists the bottom ring, then the top ring, each in path order
  const ring0 = poly.points.slice(0, bottom.length), ring1 = poly.points.slice(bottom.length);
  if (!ring0.every((p) => Math.abs(p[2]! - lo) <= tol) || !ring1.every((p) => Math.abs(p[2]! - hi) <= tol)) return { ok: false, why: "its rings are not listed bottom then top" };
  const flat = (ring: number[][]) => ring.map((p) => [p[0]!, p[1]!] as Pt);
  const loop0 = recognizeLoop(flat(ring0), policy);
  const loop1 = recognizeLoop(flat(ring1), policy);
  if (!loop0 || !loop1) return { ok: false, why: "no arcs in its rings" };
  const shape = (loop: ExactLoop) => (loop.kind === "circle" ? "c" : loop.arcs.map((a) => (a ? "a" : "l")).join(""));
  if (loop0.kind !== loop1.kind || shape(loop0) !== shape(loop1)) return { ok: false, why: "its two rings are not rounded alike (a loft needs edge for edge)" };
  if (loop0.kind === "path" && loop1.kind === "path") {
    // arcs pair up by equal sweep and turn, and start at corresponding points (same direction from their centres)
    for (let i = 0; i < loop0.arcs.length; i++) {
      const a = loop0.arcs[i], b = loop1.arcs[i];
      if (!a || !b) continue;
      if (a.turn !== b.turn || Math.abs(a.sweep - b.sweep) > 1e-7) return { ok: false, why: "its corner arcs differ in angle" };
      const da = Math.atan2(loop0.vertices[i]![1] - a.center[1], loop0.vertices[i]![0] - a.center[0]);
      const db = Math.atan2(loop1.vertices[i]![1] - b.center[1], loop1.vertices[i]![0] - b.center[0]);
      if (Math.abs(Math.sin(da - db)) > 1e-7 || Math.cos(da - db) < 0) return { ok: false, why: "its corner arcs do not start at corresponding points" };
    }
  }
  // the same ring at both ends (straight walls, rect_tube's usual case): an extrusion, whose corners are true cylinders
  const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
  const straight = loop0.kind === "circle" && loop1.kind === "circle"
    ? same(loop0.center, loop1.center) && Math.abs(loop0.r - loop1.r) <= tol
    : loop0.kind === "path" && loop1.kind === "path" && loop0.vertices.every((v, i) => same(v, loop1.vertices[i]!)) && loop0.arcs.every((a, i) => !a || same(a.mid, loop1.arcs[i]!.mid));
  return { ok: true, z0: lo, z1: hi, loop0, loop1, straight };
}

// ------------------------------------------------------------------ cuboid

/**
 * `cuboid(rounding=)` with any `edges` / `except`: the box with those edges filleted. Which edges, BOSL2 says itself:
 * all of them when it takes the minkowski path (`edges` is all ones), else each `corner_shape` call under the hull says
 * which of its three edges it rounds (`e`), and both corners of an edge must agree. `trimcorners = false` (a corner of
 * three cylinders, not a sphere), teardrop, clip_angle, a negative rounding: not here.
 */
export function exactCuboid(call: CsgNode, shape: CsgNode[]): Exact<{ size: number[]; r: number; edges: number[][]; deficit: number }> {
  const size = vec(get(call, "size"), 3);
  const r = num(get(call, "rounding"));
  if (!size) return { ok: false, why: "no size in its scope" };
  if (r === undefined) return { ok: false, why: "no rounding" };
  if (r < 0) return { ok: false, why: "a negative rounding (a flange)" };
  if (!isUndef(get(call, "chamfer"))) return { ok: false, why: "a chamfer" };
  if (get(call, "teardrop") !== false) return { ok: false, why: "teardrop=" };
  if (!isUndef(get(call, "clip_angle"))) return { ok: false, why: "clip_angle=" };
  const trim = get(call, "trimcorners") !== false;
  const edges = get(call, "edges");
  if (!Array.isArray(edges) || edges.length !== 3 || !edges.every((row) => vec(row, 4))) return { ok: false, why: "its edges are not a 3×4 mask" };
  const mask = edges as number[][];
  const all = mask.every((row) => row.every((v) => v === 1));
  // the rounded edges, by their midpoints: an X edge at (0, ±y, ±z) and so on
  const half = size.map((s) => s / 2);
  const rounded = new Set<string>();
  const edgeKey = (axis: number, v: number[]) => `${axis}:${v.map((x, k) => (k === axis ? 0 : sign(x))).join(",")}`;
  if (all) {
    for (let axis = 0; axis < 3; axis++) for (const a of [-1, 1]) for (const b of [-1, 1]) {
      const v = [0, 0, 0];
      v[(axis + 1) % 3] = a;
      v[(axis + 2) % 3] = b;
      rounded.add(edgeKey(axis, v));
    }
  } else {
    const corners = collect(shape, (node) => node.module === "corner_shape" && isBosl2Call(node));
    if (corners.length !== 8) return { ok: false, why: `${corners.length} corner shapes under its hull, not 8` };
    const votes = new Map<string, number[]>();
    for (const corner of corners) {
      const v = vec(get(corner, "corner"), 3);
      const e = vec(get(corner, "e"), 3);
      if (!v || !e) return { ok: false, why: "a corner shape without corner / e in its scope" };
      for (let axis = 0; axis < 3; axis++) {
        const key = edgeKey(axis, v);
        votes.set(key, [...(votes.get(key) ?? []), e[axis]!]);
      }
    }
    for (const [key, vs] of votes) {
      if (vs.length !== 2 || vs[0] !== vs[1]) return { ok: false, why: "the two corners of an edge disagree about rounding it" };
      if (vs[0]) rounded.add(key);
    }
    if (!trim) {
      for (const corner of corners) {
        const e = vec(get(corner, "e"), 3)!;
        if (e[0]! + e[1]! + e[2]! === 3) return { ok: false, why: "trimcorners = false at a corner of three rounded edges" };
      }
    }
  }
  if (!rounded.size) return { ok: false, why: "no rounded edge" };
  const midpoints: number[][] = [...rounded].map((key) => {
    const [axis, rest] = key.split(":");
    return rest!.split(",").map((s, k) => Number(s) * half[k]! * (k === Number(axis) ? 0 : 1));
  });
  // the facets' deficit, for the kernel's comparison: per rounded edge, its straight run times the area between a
  // quarter circle and BOSL2's inscribed polygon of sides/4 chords; the corners are bounded by an octant of the ball
  const sides = Math.max(4, Math.ceil(bosl2Segs(r, call.specials ?? {}) / 4) * 4);
  const k = sides / 4;
  const perLength = r * r * (Math.PI / 4 - (k / 2) * Math.sin(Math.PI / (2 * k)));
  let deficit = 0;
  for (const m of midpoints) {
    const axis = m.findIndex((x) => x === 0);
    deficit += perLength * Math.max(0, size[axis]! - 2 * r);
  }
  deficit += 8 * (Math.PI / 6) * r ** 3;
  return { ok: true, size, r, edges: midpoints, deficit };
}

/** Every node under `nodes` (depth first) that `test` accepts, not looking inside the ones it accepts. */
export function collect(nodes: CsgNode[], test: (node: CsgNode) => boolean): CsgNode[] {
  const out: CsgNode[] = [];
  const walk = (node: CsgNode) => {
    if (test(node)) out.push(node);
    else node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/**
 * The nodes a BOSL2 attachable shape module draws itself, as opposed to the children attached to it: under the
 * module's own `attachable()`, the anchor multmatrix's `_color` → `_show_ghost` → `_show_highlight` group (children(0)
 * of attachable). Returns that group, or null when the structure is not the expected one (a hidden shape in a diff()).
 */
export function attachableShape(call: CsgNode): CsgNode | null {
  // the module's own attachable(), through the anonymous groups its `if`s leave (not into another module's call)
  const attachable = findThrough(call.children, (node) => node.module === "attachable", () => false);
  if (!attachable) return null;
  // attachable → BOSL2's multmatrix() module → _multmatrix → the builtin multmatrix → _color → _show_ghost → _show_highlight,
  // with the groups `children()` and `if` leave in between; attachments (children(1)) are other modules' calls
  return findThrough(attachable.children, (node) => node.module === "_show_highlight", (node) => node.name === "multmatrix" || node.name === "color" || SHAPE_WRAPPERS.has(node.module!));
}

/** The modules between an attachable() and the shape it draws. */
const SHAPE_WRAPPERS = new Set(["multmatrix", "_multmatrix", "_color", "_show_ghost"]);

/** The first node (depth first) `test` accepts, descending only through anonymous groups and what `through` accepts. */
function findThrough(nodes: CsgNode[], test: (node: CsgNode) => boolean, through: (node: CsgNode) => boolean): CsgNode | null {
  for (const node of nodes) {
    if (test(node)) return node;
    if ((node.name === "group" && !node.module) || through(node)) {
      const found = findThrough(node.children, test, through);
      if (found) return found;
    }
  }
  return null;
}
