/**
 * A set of closed contours → faces filled by the **non-zero winding rule** (transpile.ts, runtime helper `_fill`).
 * Used in two places:
 *  - Glyphs of text() (tree.ts `contours`): OpenSCAD does the layout itself (FreeType + HarfBuzz); each contour is the
 *    line segments and quadratic/cubic Béziers it has
 *    **before** flattening into a polyline, with coordinates already in final model space;
 *  - The 2D kind of mesh fallback (tree.ts `rendered`, dim 2): the polygons OpenSCAD rendered, all straight segments.
 * A contour is a start point plus segments: `[x, y]` (line), `[cx, cy, x, y]` (quadratic),
 * `[c1x, c1y, c2x, c2y, x, y]` (cubic), each continuing from the previous segment's end point.
 *
 * How OpenSCAD fills: all contours together, by non-zero winding (ClipperUtils::apply, NonZero), with orientation kept
 * as-is (TrueType outer contours are clockwise,
 * holes counter-clockwise; in rendered output outer rings are counter-clockwise and holes clockwise — non-zero does not
 * care which direction is the outside). This does the same, but uses only the shapes:
 *  - For each contour, the signed area from sample points (gives the direction) and the containment relation (gives
 *    parent/child); parent = the smallest-area contour that encloses it;
 *  - The winding number of the region inside a contour and outside its child contours = its own direction + its
 *    parent's winding number; fill it if non-zero;
 *  - A piece = the contour's face minus the faces of its direct children; all pieces are unioned (same-sign contours
 *    that overlap each other — accents of composed glyphs, negative kerning — unioned together is exactly non-zero).
 * Sampling is used only for classification; faces are built from the original curves. Every contour is turned
 * counter-clockwise and the face normal points +Z (the engine's make_face takes the normal from the outer ring's
 * direction, and a clockwise face extrudes downward).
 */

type Pt = [number, number];

/** A contour as the export writes it: its start, then its segments. */
export type Contour = number[][];

export type FillPlan = {
  /** The contours to build, each counter-clockwise. */
  contours: Contour[];
  /** `[i, [k…]]`: contour i's face minus the faces of contours k — one filled region each. */
  pieces: [number, number[]][];
};

const SAMPLES = 8;

function end(seg: number[]): Pt {
  return [seg[seg.length - 2]!, seg[seg.length - 1]!];
}

/** Points along the contour (for classification only): every segment's end, and SAMPLES points inside each curve. */
function flatten(contour: Contour): Pt[] {
  const out: Pt[] = [];
  let at: Pt = [contour[0]![0]!, contour[0]![1]!];
  out.push(at);
  for (const seg of contour.slice(1)) {
    const to = end(seg);
    if (seg.length === 4) {
      for (let k = 1; k < SAMPLES; k++) {
        const t = k / SAMPLES;
        const u = 1 - t;
        out.push([u * u * at[0] + 2 * u * t * seg[0]! + t * t * to[0], u * u * at[1] + 2 * u * t * seg[1]! + t * t * to[1]]);
      }
    } else if (seg.length === 6) {
      for (let k = 1; k < SAMPLES; k++) {
        const t = k / SAMPLES;
        const u = 1 - t;
        out.push([
          u * u * u * at[0] + 3 * u * u * t * seg[0]! + 3 * u * t * t * seg[2]! + t * t * t * to[0],
          u * u * u * at[1] + 3 * u * u * t * seg[1]! + 3 * u * t * t * seg[3]! + t * t * t * to[1],
        ]);
      }
    }
    out.push(to);
    at = to;
  }
  return out;
}

function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j]![0] * poly[i]![1] - poly[i]![0] * poly[j]![1];
  return a / 2;
}

function inside(poly: Pt[], [x, y]: Pt): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** The same contour run backwards: it starts where it ended, every segment's control points in reverse order. */
function reversed(contour: Contour): Contour {
  const starts: Pt[] = [];
  let at: Pt = [contour[0]![0]!, contour[0]![1]!];
  for (const seg of contour.slice(1)) {
    starts.push(at);
    at = end(seg);
  }
  const out: Contour = [[at[0], at[1]]];
  for (let k = contour.length - 2; k >= 0; k--) {
    const seg = contour[k + 1]!;
    const to = starts[k]!;
    if (seg.length === 2) out.push([to[0], to[1]]);
    else if (seg.length === 4) out.push([seg[0]!, seg[1]!, to[0], to[1]]);
    else out.push([seg[2]!, seg[3]!, seg[0]!, seg[1]!, to[0], to[1]]);
  }
  return out;
}

/**
 * Contours → what to build. null when nothing encloses any area (OpenSCAD's empty). A contour that is not a list
 * of finite numbers of the three segment shapes is dropped: the export never writes one.
 */
export function fillPieces(raw: number[][][]): FillPlan | null {
  const shaped = raw.filter((contour): contour is Contour =>
    Array.isArray(contour) && contour.length >= 2 && contour.every((seg, k) =>
      Array.isArray(seg) && (k === 0 ? seg.length === 2 : [2, 4, 6].includes(seg.length)) && seg.every((v) => typeof v === "number" && Number.isFinite(v))));
  const polys = shaped.map(flatten);
  const areas = polys.map(signedArea);
  const extent = Math.max(1e-300, ...polys.flat().map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
  // a contour with no area (a hairline, a stray move) bounds nothing
  const live = shaped.map((_, i) => i).filter((i) => Math.abs(areas[i]!) > 1e-12 * extent * extent);
  if (!live.length) return null;

  // parent: the smallest contour that holds this one (most of a few points along it, so a touch does not decide it)
  const parent = new Map<number, number | null>();
  for (const i of live) {
    const probe = [0.25, 0.5, 0.75].map((f) => polys[i]![Math.floor(f * (polys[i]!.length - 1))]!);
    let best: number | null = null;
    for (const j of live) {
      if (j === i || Math.abs(areas[j]!) <= Math.abs(areas[i]!)) continue;
      if (probe.filter((p) => inside(polys[j]!, p)).length < 2) continue;
      if (best === null || Math.abs(areas[j]!) < Math.abs(areas[best]!)) best = j;
    }
    parent.set(i, best);
  }
  const winding = new Map<number, number>();
  const windingOf = (i: number): number => {
    const known = winding.get(i);
    if (known !== undefined) return known;
    const up = parent.get(i);
    const w = Math.sign(areas[i]!) + (up === null || up === undefined ? 0 : windingOf(up));
    winding.set(i, w);
    return w;
  };

  const index = new Map(live.map((i, k) => [i, k]));
  const contours = live.map((i) => (areas[i]! < 0 ? reversed(shaped[i]!) : shaped[i]!));
  const pieces: [number, number[]][] = live
    .filter((i) => windingOf(i) !== 0)
    .map((i) => [index.get(i)!, live.filter((k) => parent.get(k) === i).map((k) => index.get(k)!)]);
  return pieces.length ? { contours, pieces } : null;
}
