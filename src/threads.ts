/**
 * Draw threads as plain cylinders (the "cosmetic thread" export option, off by default; transpile.ts `threadShape`).
 * When on, BOSL2's thread modules no longer build the helix:
 * an external thread = a cylinder of the major diameter, an internal thread (nuts, the tool that cuts a threaded hole)
 * = a hole of the minor diameter (the tap drill) — the same convention as Fusion 360 / SolidWorks "cosmetic threads":
 * the geometry keeps only the cylindrical face the thread sits on, and the thread specification is noted separately
 * (here: the build report lists each one).
 * This deliberately differs from OpenSCAD's rendering, so it does not go through the OpenSCAD volume gate; what is
 * checked is the simplified shape it should have (threads.test.ts).
 *
 * Two low-level modules are recognized, and every BOSL2 thread family goes through them:
 *  - `generic_threaded_rod()`:threaded_rod / trapezoidal / acme / buttress / square / ball_screw / npt / bspp /
 *    the shaft of garden_hose; the `*_threaded_nut()` modules, and the `internal = true` tool that cuts the hole in
 *    screws.scad's screw() / nut() / screw_hole(), are also it.
 *    Radius, thread depth and chamfer are all read from the scope computed at the top level of its body (`r1`,
 *    `profmin`, `bevel_size1`…).
 *  - `thread_helix()`: bottle necks and caps (bottlecaps.scad) — only the helix itself, attached to the author's
 *    cylinder. It is replaced by a solid ring that the helix
 *    occupies (root to crest diameter, axially to both ends of the thread profile): an external thread merged into the
 *    neck = a major-diameter cylinder; an internal thread filled into the cap = a minor-diameter hole.
 *
 * End chamfers: BOSL2's `bevel` / `ibevel` (nuts have it by default) is real geometry the author asked for, so it is
 * kept: from the diameter BOSL2 gives for the end face (shaft: root diameter
 * minus the chamfer; hole: major diameter plus the chamfer) it meets the plain cylinder at 45° — consistent with the
 * chamfer at the end of a standard thread (down below the minor diameter) and the countersink at a threaded-hole mouth.
 * Lead-in (blunt_start / lead_in) only changes the tooth height at the end of the thread, which has no counterpart on a
 * plain cylinder, so it is dropped.
 *
 * Not recognized (the helix is built as before, with an explanation): a tapered thread_helix, `teardrop` holes, a
 * reverse chamfer (`bevel = "reverse"`), a chamfer so large that the two ends meet.
 */

import type { CsgNode, ScopeValue } from "./tree.ts";
import type { Pt } from "./polygon2d.ts";

/** The BOSL2 modules whose scope the transpile asks for when threads are drawn plain (csg.ts). */
export const THREAD_SCOPED = ["generic_threaded_rod", "thread_helix"];

/**
 * Whether the tree draws a thread at all — what makes the option worth offering. By the module's name alone: with the
 * option off the evaluation asks for none of these scopes (csg.ts), and the scope is what tells BOSL2's own module
 * from a namesake in the author's project (bosl2.ts `isBosl2Call`). A background (`%`) subtree draws nothing.
 */
export function drawsThreads(nodes: CsgNode[]): boolean {
  const draws = (node: CsgNode): boolean =>
    node.modifier !== "%" && node.modifier !== "*" && (THREAD_SCOPED.includes(node.module!) || node.children.some(draws));
  return nodes.some(draws);
}

/** One thread drawn plain: its spec for the build report, and the solid that stands in for it. */
export type PlainThread = {
  module: "generic_threaded_rod" | "thread_helix";
  /** a hole (nut, threaded hole: the cutter is drawn at the minor diameter) or a rod / neck (at the major) */
  internal: boolean;
  /** nominal (major) diameter at the bottom and the top (they differ on a tapered thread: NPT) */
  d1: number;
  d2: number;
  pitch: number;
  starts: number;
  leftHanded: boolean;
  /** along the axis */
  length: number;
  /** the stand-in solid: its (r, z) profile, revolved about Z (`_revolve_loop`), in the module's own frame */
  profile: Pt[];
};

const num = (v: ScopeValue | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const get = (call: CsgNode, key: string) => call.scope?.get(key);

/** The thread a BOSL2 call draws, as its plain stand-in; why not, when it is not one this handles. */
export function plainThread(call: CsgNode): PlainThread | { why: string } {
  if (call.module === "generic_threaded_rod") return plainRod(call);
  if (call.module === "thread_helix") return plainHelix(call);
  return { why: "not a BOSL2 thread module" };
}

function plainRod(call: CsgNode): PlainThread | { why: string } {
  const internal = get(call, "internal");
  const [r1, r2, len, pitch, profmin, pmax] = ["r1", "r2", "len", "pitch", "profmin", "pmax"].map((k) => num(get(call, k)));
  const islop = num(get(call, "islop")) ?? 0;
  if (typeof internal !== "boolean" || r1 === undefined || r2 === undefined || len === undefined || pitch === undefined || profmin === undefined || pmax === undefined) {
    return { why: "its sizes are not the ones this build reads" };
  }
  const teardrop = get(call, "teardrop");
  if (teardrop !== false && teardrop !== null && teardrop !== undefined) return { why: "a teardrop hole keeps its thread" };
  // a bevel is built into the thread (blunt start: bevel_size) or cut off it afterwards (clip_bev): one of them
  const bevel = (end: 1 | 2) => {
    const built = num(get(call, `bevel_size${end}`)) || 0;
    return built ? { b: built, built: true } : { b: num(get(call, `clip_bev${end}`)) || 0, built: false };
  };
  const end1 = bevel(1), end2 = bevel(2);
  const b1 = end1.b, b2 = end2.b;
  // a rod's bevels cut in (> 0), a hole's flare out (< 0); the other way round is "reverse"
  if ((internal && (b1 > 0 || b2 > 0)) || (!internal && (b1 < 0 || b2 < 0))) return { why: "a reversed bevel keeps its thread" };
  // the plain diameter: a rod's crests (major), a hole's crests (minor) — at the nominal radius, without the widening
  // BOSL2 gives a faceted hole (rsc) but with the clearance the author set ($slop: islop)
  const plain = (r: number) => (internal ? r + islop + profmin : r + pmax);
  // the end face, as BOSL2 draws it: built into a blunt-start thread, below the root by the bevel on a rod and past the
  // major by it on a hole; cut off a thread that runs out, below the major on a rod and past the minor on a hole
  const face = (r: number, b: number, built: boolean) =>
    built ? (internal ? r + islop + pmax - b : r + profmin - b) : (internal ? r + islop + profmin - b : r + pmax - b);
  const p1 = plain(r1), p2 = plain(r2);
  if (!(p1 > 0 && p2 > 0)) return { why: "its minor diameter is not positive" };
  const z0 = -len / 2, z1 = len / 2;
  // the plain surface is p1 + slope * (z - z0) (a cone on a tapered thread); a 45° chamfer from the end face e meets
  // it c along the axis: a rod's chamfer widens towards the middle, a hole's narrows
  const slope = (p2 - p1) / len;
  const bottom: Pt[] = [], top: Pt[] = [];
  let c1 = 0, c2 = 0;
  if (b1 !== 0) {
    const e1 = face(r1, b1, end1.built);
    c1 = internal ? (e1 - p1) / (1 + slope) : (p1 - e1) / (1 - slope);
    if (!(e1 > 0 && c1 > 0)) return { why: "its bevel does not fit" };
    bottom.push([e1, z0], [p1 + slope * c1, z0 + c1]);
  } else bottom.push([p1, z0]);
  if (b2 !== 0) {
    const e2 = face(r2, b2, end2.built);
    c2 = internal ? (e2 - p2) / (1 - slope) : (p2 - e2) / (1 + slope);
    if (!(e2 > 0 && c2 > 0)) return { why: "its bevel does not fit" };
    top.push([p2 - slope * c2, z1 - c2], [e2, z1]);
  } else top.push([p2, z1]);
  if (c1 + c2 >= len) return { why: "its bevels meet" };
  const profile: Pt[] = [[0, z0], ...bottom, ...top, [0, z1]];
  return {
    module: "generic_threaded_rod",
    internal,
    d1: 2 * r1,
    d2: 2 * r2,
    pitch,
    starts: num(get(call, "starts")) ?? 1,
    leftHanded: get(call, "left_handed") === true,
    length: len,
    profile,
  };
}

function plainHelix(call: CsgNode): PlainThread | { why: string } {
  const [h, r1, r2, pitch] = ["h", "r1", "r2", "pitch"].map((k) => num(get(call, k)));
  const profile = get(call, "profile");
  if (h === undefined || r1 === undefined || r2 === undefined || pitch === undefined || !Array.isArray(profile) || profile.length < 2) {
    return { why: "its sizes are not the ones this build reads" };
  }
  if (Math.abs(r1 - r2) > 1e-9 * Math.max(r1, r2)) return { why: "a tapered helix keeps its thread" };
  const pts = profile.filter((p): p is number[] => Array.isArray(p) && p.length >= 2 && p.every((x) => typeof x === "number" && Number.isFinite(x)));
  if (pts.length !== profile.length) return { why: "its profile is not the one this build reads" };
  const ys = pts.map((p) => p[1]!), xs = pts.map((p) => Math.abs(p[0]!));
  // the helix sweeps the profile at r1 + pitch * y (both ways round: an internal helix's crest is at y = 0 too)
  const rIn = r1 + pitch * Math.min(...ys), rOut = r1 + pitch * Math.max(...ys);
  const half = h / 2 + pitch * Math.max(...xs);
  if (!(rIn > 0 && rOut > rIn && half > 0)) return { why: "its thread has no depth" };
  return {
    module: "thread_helix",
    internal: get(call, "internal") === true,
    d1: 2 * rOut,
    d2: 2 * rOut,
    pitch,
    starts: num(get(call, "starts")) ?? 1,
    leftHanded: get(call, "left_handed") === true,
    length: h,
    profile: [[rIn, -half], [rOut, -half], [rOut, half], [rIn, half]],
  };
}
