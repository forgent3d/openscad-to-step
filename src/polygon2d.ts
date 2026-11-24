/**
 * The fill rule of `polygon()`: OpenSCAD treats every ring of points / paths as a contour and fills by **even-odd**
 * (Clipper
 * `pftEvenOdd`) — not "the first is the outer boundary, the rest are holes". Two rings side by side are two islands
 * (previously the second island was subtracted as a hole and vanished entirely);
 * a self-intersecting ring (a bow tie) is its two lobes (previously make_face accepted a self-intersecting wire, with
 * volume 0, and extruded toward -Z).
 *
 * The points in the csg are all literals, so this is all worked out at **translation time**, and model.py is left with
 * only simple rings:
 *  1. Each ring gets points inserted at its self-intersections, then is split at repeated points into simple rings.
 *     Even-odd only looks at the parity of the winding number, and winding numbers add over sub-rings,
 *     so "the even-odd fill of the original ring" = "the XOR of the sub-rings' interiors".
 *  2. When the sub-rings do not touch each other, layer them by nesting depth: even layers are solid, and the odd layers
 *     they directly contain are holes. Output a list of `[outer, [holes…]]`.
 *  3. When sub-rings cross, touch or share an edge (sub-rings split from a self-intersecting ring always meet at the
 *     split points and may also cross there — a pentagram), they are not assembled here;
 *     they are left to the runtime to XOR one by one (`xor`): XOR is right for any sub-rings, just slow.
 */

export type Pt = [number, number];
export type Region = { outer: Pt[]; holes: Pt[][] };
export type EvenOdd = { regions: Region[] } | { xor: Pt[][] };

const key = (p: Pt) => `${p[0]},${p[1]}`;

function area2(loop: Pt[]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i]!;
    const [x2, y2] = loop[(i + 1) % loop.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a;
}

/** Consecutive duplicates (and a last point repeating the first) removed. */
function clean(loop: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of loop) if (!out.length || key(out[out.length - 1]!) !== key(p)) out.push(p);
  while (out.length > 1 && key(out[0]!) === key(out[out.length - 1]!)) out.pop();
  return out;
}

type Seg = { a: Pt; b: Pt; loop: number; index: number; minX: number; maxX: number };

function segmentsOf(loops: Pt[][]): Seg[] {
  const segs: Seg[] = [];
  loops.forEach((loop, l) => loop.forEach((a, index) => {
    const b = loop[(index + 1) % loop.length]!;
    segs.push({ a, b, loop: l, index, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]) });
  }));
  return segs.sort((s, t) => s.minX - t.minX);
}

/** Every pair of segments whose x-ranges overlap (a sweep over x, so a big polygon is not n²). */
function forEachCandidate(segs: Seg[], visit: (s: Seg, t: Seg) => void) {
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    for (let j = i + 1; j < segs.length && segs[j]!.minX <= s.maxX; j++) visit(s, segs[j]!);
  }
}

/** Parameters (t on s, u on t) where two segments cross, or null (parallel / apart). */
function crossing(s: Seg, t: Seg): [number, number] | null {
  const rx = s.b[0] - s.a[0], ry = s.b[1] - s.a[1];
  const qx = t.b[0] - t.a[0], qy = t.b[1] - t.a[1];
  const den = rx * qy - ry * qx;
  const scale = Math.hypot(rx, ry) * Math.hypot(qx, qy);
  if (scale === 0 || Math.abs(den) <= 1e-12 * scale) return null;
  const dx = t.a[0] - s.a[0], dy = t.a[1] - s.a[1];
  const u1 = (dx * qy - dy * qx) / den;
  const u2 = (dx * ry - dy * rx) / den;
  const eps = 1e-12;
  if (u1 < -eps || u1 > 1 + eps || u2 < -eps || u2 > 1 + eps) return null;
  return [Math.min(1, Math.max(0, u1)), Math.min(1, Math.max(0, u2))];
}

const END = 1e-9;
/** The crossing point on a segment at t, snapped onto an end it (numerically) is. */
function pointAt(s: Seg, t: number): Pt {
  if (t <= END) return s.a;
  if (t >= 1 - END) return s.b;
  return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
}

/** One loop → simple cycles: insert its self-crossings, then cut it wherever a point repeats. */
function splitLoop(loop: Pt[]): Pt[][] {
  const n = loop.length;
  const inserts: { t: number; p: Pt }[][] = loop.map(() => []);
  forEachCandidate(segmentsOf([loop]), (s, t) => {
    const hit = crossing(s, t);
    if (!hit) return;
    // one point for both segments, so the two copies share their key exactly: an end of one of them
    // if the crossing is there, else the crossing itself
    const [u1, u2] = hit;
    const p = u1 <= END || u1 >= 1 - END ? pointAt(s, u1) : u2 <= END || u2 >= 1 - END ? pointAt(t, u2) : pointAt(s, u1);
    if (u1 > END && u1 < 1 - END) inserts[s.index]!.push({ t: u1, p });
    if (u2 > END && u2 < 1 - END) inserts[t.index]!.push({ t: u2, p });
  });
  const seq: Pt[] = [];
  for (let i = 0; i < n; i++) {
    seq.push(loop[i]!);
    for (const { p } of inserts[i]!.sort((a, b) => a.t - b.t)) seq.push(p);
  }
  const cycles: Pt[][] = [];
  const stack: Pt[] = [];
  const at = new Map<string, number>();
  for (const p of seq) {
    const k = key(p);
    const seen = at.get(k);
    if (seen !== undefined) {
      const cycle = stack.splice(seen);
      for (const q of cycle) at.delete(key(q));
      cycles.push(cycle);
    }
    at.set(k, stack.length);
    stack.push(p);
  }
  cycles.push(stack);
  return cycles.map(clean).filter((cycle) => cycle.length >= 3);
}

/** Even-odd containment of a point in a loop (crossing count). */
function inside(p: Pt, loop: Pt[]): boolean {
  let hit = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i]!;
    const [xj, yj] = loop[j]!;
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** A point just inside a simple loop: off the middle of its longest edge, a hair towards the interior. */
function probe(loop: Pt[]): Pt {
  let best = 0;
  let len = -1;
  loop.forEach((a, i) => {
    const b = loop[(i + 1) % loop.length]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > len) [best, len] = [i, l];
  });
  const a = loop[best]!;
  const b = loop[(best + 1) % loop.length]!;
  const side = area2(loop) > 0 ? 1 : -1; // counter-clockwise: the interior is on the left
  const step = 1e-6 * side;
  return [(a[0] + b[0]) / 2 - (b[1] - a[1]) * step, (a[1] + b[1]) / 2 + (b[0] - a[0]) * step];
}

/**
 * True when two different cycles meet at all — cross, touch at a point, or run along each other. Nesting needs
 * cycles that are apart: the pieces of a self-crossing loop share their cut points and may cross THERE (a
 * pentagram's five tips and its centre: nesting fills the centre, even-odd empties it).
 */
function cyclesMeet(cycles: Pt[][]): boolean {
  let found = false;
  forEachCandidate(segmentsOf(cycles), (s, t) => {
    if (found || s.loop === t.loop) return;
    if (crossing(s, t)) {
      found = true;
      return;
    }
    // parallel: collinear and overlapping over a length is a shared edge — the xor handles it, nesting might not
    const rx = s.b[0] - s.a[0], ry = s.b[1] - s.a[1];
    const len2 = rx * rx + ry * ry;
    const cross = (p: Pt) => (p[0] - s.a[0]) * ry - (p[1] - s.a[1]) * rx;
    if (Math.abs(cross(t.a)) > 1e-9 * len2 || Math.abs(cross(t.b)) > 1e-9 * len2) return;
    const along = (p: Pt) => ((p[0] - s.a[0]) * rx + (p[1] - s.a[1]) * ry) / len2;
    const [lo, hi] = [along(t.a), along(t.b)].sort((x, y) => x - y) as [number, number];
    if (Math.min(1, hi) - Math.max(0, lo) > END) found = true;
  });
  return found;
}

/** OpenSCAD's even-odd fill of `loops` as simple regions (outer minus holes), or the cycles to xor at run time. */
export function evenOdd(loops: Pt[][]): EvenOdd {
  const cycles = loops.map(clean).filter((loop) => loop.length >= 3).flatMap(splitLoop);
  const live = cycles.filter((cycle) => {
    const xs = cycle.map((p) => p[0]), ys = cycle.map((p) => p[1]);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return Math.abs(area2(cycle)) > 1e-12 * size * size; // a zero-area loop (a line, a spike) encloses nothing
  });
  // every loop counter-clockwise: each becomes a face of its own, and a clockwise face extrudes towards -Z
  const ccw = (loop: Pt[]) => (area2(loop) < 0 ? loop.slice().reverse() : loop);
  if (live.length > 1 && cyclesMeet(live)) return { xor: live.map(ccw) };
  const probes = live.map(probe);
  const parents = live.map((_, i) => live.map((other, j) => j !== i && inside(probes[i]!, other)));
  const depth = parents.map((row) => row.filter(Boolean).length);
  const regions: Region[] = [];
  live.forEach((cycle, i) => {
    if (depth[i]! % 2) return;
    const holes = live.filter((_, j) => depth[j] === depth[i]! + 1 && parents[j]![i]);
    regions.push({ outer: ccw(cycle), holes: holes.map(ccw) });
  });
  return { regions };
}
