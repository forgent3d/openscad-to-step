/**
 * `multmatrix(m)` → moves the kernel keeps exact.
 *
 * A literal 4×4 is split into the steps the dialect already has, applied to the child in order:
 * a mirror about a coordinate plane (only when det < 0), rotations (a `Location`: rigid, every
 * surface keeps its type), a scale — uniform is a similarity (K_Transform, a cylinder stays a
 * cylinder), per-axis goes through K_GTransform and turns curved faces into BSplines — and a final
 * translation. Handing the whole matrix to K_GTransform instead would turn every PLANE into a
 * BSpline too, and every later boolean pays for that.
 *
 * OpenSCAD's evaluation (csg.ts) writes every translate / rotate / scale / mirror as a `multmatrix`, at
 * full precision (tree.ts) — what is left is the floating-point noise of OpenSCAD's own arithmetic
 * (rotations composed, 2*cos 45° squared and summed), ~1e-16 relative. The tolerances are sized for that,
 * not for a print: an angle within 1e-9° of a multiple of 0.001° snaps to it (cos 30° as a double gives
 * 30.000000000000004°), a scale factor read off a rotated axis snaps to the shortest decimal within 1e-12
 * (2*cos 45° measures 2.0000000000000004). Anything further off is a real value and stays what it is —
 * the 6-digit .csg this once read needed tolerances a million times wider, wide enough to swallow a
 * genuine 29.99999°.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export type AffineStep =
  /** about the plane through the origin normal to that axis: 0 → YZ, 1 → XZ, 2 → XY */
  | { kind: "mirror"; axis: 0 | 1 | 2 }
  /** extrinsic X, then Y, then Z — the order OpenSCAD's rotate([x, y, z]) uses */
  | { kind: "rotate"; angles: Vec3 }
  | { kind: "scale"; factors: Vec3 | number }
  | { kind: "move"; offset: Vec3 };

/** `null` = the matrix flattens a solid onto a plane or line; OpenSCAD removes such an object. */
export type AffinePlan = { steps: AffineStep[] } | null;

/** Floating-point noise of OpenSCAD's own matrix arithmetic, relative (see the header) — with a wide margin. */
const ORTHO_TOL = 1e-9;
const NOISE_TOL = 1e-12;
const ANGLE_TOL = 1e-9;
const IDENTITY_TOL = 1e-12;

/** OpenSCAD reads a 3×3, 3×4 or 4×4 `m`; missing entries are the identity's. The bottom row is ignored. */
export function affineOfRows(rows: number[][]): { A: Mat3; t: Vec3 } {
  const at = (i: number, j: number) => rows[i]?.[j] ?? (i === j ? 1 : 0);
  const A: Mat3 = [
    [at(0, 0), at(0, 1), at(0, 2)],
    [at(1, 0), at(1, 1), at(1, 2)],
    [at(2, 0), at(2, 1), at(2, 2)],
  ];
  return { A, t: [rows[0]?.[3] ?? 0, rows[1]?.[3] ?? 0, rows[2]?.[3] ?? 0] };
}

export function planAffine(A: Mat3, t: Vec3): AffinePlan {
  let M = A.map((row) => [...row]) as Mat3;
  let flatZ = false;
  if (singular(M)) {
    // scale([sx, sy, 0]) and friends: a 2D child ignores z (the `_scale` helper keeps a flat shape and
    // drops a solid, as OpenSCAD does), so only a z that is decoupled from x and y is recoverable
    if (M[2][2] !== 0 || M[0][2] !== 0 || M[1][2] !== 0 || M[2][0] !== 0 || M[2][1] !== 0) return null;
    M = [M[0], M[1], [0, 0, 1]];
    if (singular(M)) return null;
    flatZ = true;
  }
  let steps: AffineStep[];
  if (det(M) < 0) {
    // A = M' * F_k (F_k negates axis k): mirror first, then the proper part M' = A * F_k. Of the three
    // equally valid choices take the one whose remainder is simplest — mirror([1, 0, 0]) is a mirror
    // about YZ, not a mirror about XY followed by a half turn.
    const tries = ([0, 1, 2] as const).map((axis) => {
      const flipped = M.map((row) => row.map((v, j) => (j === axis ? -v : v))) as Mat3;
      return [{ kind: "mirror", axis } as AffineStep, ...properSteps(flipped, flatZ)];
    });
    steps = tries.reduce((best, next) => (cost(next) < cost(best) ? next : best));
  } else {
    steps = properSteps(M, flatZ);
  }
  if (t.some((v) => v !== 0)) steps.push({ kind: "move", offset: t });
  return { steps };
}

/** The steps of a matrix with det > 0. */
function properSteps(M: Mat3, flatZ: boolean): AffineStep[] {
  const steps: AffineStep[] = [];
  const cols = [0, 1, 2].map((j) => [M[0][j], M[1][j], M[2][j]] as Vec3);
  const rows = M.map((row) => [...row] as Vec3);
  if (orthogonal(cols)) {
    // M = R * S: scale along the child's own axes, then rotate (a pure rotation, a similarity, …)
    const s = cols.map(factorOf) as Vec3;
    const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => M[i][j] / len(cols[j]!))) as Mat3;
    pushScale(steps, s, flatZ);
    pushRotation(steps, R);
  } else if (orthogonal(rows)) {
    // M = S * R: rotate, then scale along the world axes (`scale([..]) rotate([..]) child`)
    const s = rows.map(factorOf) as Vec3;
    const R = M.map((row, i) => row.map((v) => v / len(rows[i]!))) as Mat3;
    pushRotation(steps, R);
    pushScale(steps, s, flatZ);
  } else {
    // a shear: M = U * Σ * Vᵀ — rotate by Vᵀ, scale by Σ, rotate by U. Σ is derived, never "nice".
    const { U, S, V } = svd3(M);
    pushRotation(steps, transpose(V));
    pushScale(steps, S, flatZ);
    pushRotation(steps, U);
  }
  return steps;
}

/** Fewer steps and axes first; on a tie the smaller turn (mirror Y + 20° over mirror X + 160°). */
function cost(steps: AffineStep[]): number {
  return steps.reduce(
    (sum, step) =>
      sum + (step.kind === "rotate" ? 1 + step.angles.filter((a) => a !== 0).length + step.angles.reduce((s, a) => s + Math.abs(a), 0) / 1e6 : 1),
    0,
  );
}

/** An axis's scale factor. Read straight off the matrix when the axis is not rotated (the entry IS the
 *  value); measured off a rotated axis it snaps to the shortest decimal within the arithmetic's noise. */
function factorOf(v: Vec3): number {
  const nonzero = v.filter((x) => x !== 0);
  if (nonzero.length === 1) return Math.abs(nonzero[0]!);
  const raw = len(v);
  for (let digits = 1; digits <= 15; digits++) {
    const short = Number(raw.toPrecision(digits));
    if (Math.abs(raw - short) <= NOISE_TOL * raw) return short;
  }
  return raw;
}

function pushScale(steps: AffineStep[], factors: Vec3, flatZ: boolean) {
  const f = [...factors] as Vec3;
  if (flatZ) f[2] = 0;
  if (Math.abs(f[0] - f[1]) <= NOISE_TOL * Math.abs(f[0]) && Math.abs(f[1] - f[2]) <= NOISE_TOL * Math.abs(f[1])) {
    if (Math.abs(f[0] - 1) > NOISE_TOL) steps.push({ kind: "scale", factors: f[0] });
    return;
  }
  steps.push({ kind: "scale", factors: f });
}

function pushRotation(steps: AffineStep[], R: Mat3) {
  if (isIdentity(R)) return;
  const angles = eulerXYZ(R);
  if (angles.every((a) => a === 0)) return;
  steps.push({ kind: "rotate", angles });
}

/** R = Rz(z) * Ry(y) * Rx(x), in degrees (the split _rot_axis uses too). */
export function eulerXYZ(R: Mat3): Vec3 {
  const r20 = Math.max(-1, Math.min(1, R[2][0]));
  const y = deg(Math.asin(-r20));
  let x: number;
  let z: number;
  if (Math.abs(r20) < 1 - 1e-12) {
    x = deg(Math.atan2(R[2][1], R[2][2]));
    z = deg(Math.atan2(R[1][0], R[0][0]));
  } else {
    x = deg(Math.atan2(-R[1][2], R[1][1]));
    z = 0;
  }
  return [snapAngle(x), snapAngle(y), snapAngle(z)];
}

function snapAngle(a: number): number {
  const snapped = Math.round(a * 1000) / 1000;
  const out = Math.abs(a - snapped) < ANGLE_TOL ? snapped : a;
  return out === 0 ? 0 : out; // no -0 in model.py
}

function singular(M: Mat3): boolean {
  return Math.abs(det(M)) < 1e-12 * Math.max(1, norm(M) ** 3);
}

function orthogonal(vs: Vec3[]): boolean {
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(dot(vs[i]!, vs[j]!)) > ORTHO_TOL * len(vs[i]!) * len(vs[j]!)) return false;
    }
  }
  return true;
}

function isIdentity(R: Mat3): boolean {
  return R.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < IDENTITY_TOL));
}

/** Jacobi on MᵀM: M = U*diag(S)*Vᵀ with U, V proper rotations and S > 0 (for det M > 0). */
export function svd3(M: Mat3): { U: Mat3; S: Vec3; V: Mat3 } {
  const B = mul(transpose(M), M).map((row) => [...row]) as number[][];
  const V: number[][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += B[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(B[p]![q]!) < 1e-300) continue;
        const theta = (B[q]![q]! - B[p]![p]!) / (2 * B[p]![q]!);
        const tn = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(tn * tn + 1);
        const s = tn * c;
        for (let k = 0; k < 3; k++) {
          const bkp = B[k]![p]!;
          const bkq = B[k]![q]!;
          B[k]![p] = c * bkp - s * bkq;
          B[k]![q] = s * bkp + c * bkq;
        }
        for (let k = 0; k < 3; k++) {
          const bpk = B[p]![k]!;
          const bqk = B[q]![k]!;
          B[p]![k] = c * bpk - s * bqk;
          B[q]![k] = s * bpk + c * bqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k]![p]!;
          const vkq = V[k]![q]!;
          V[k]![p] = c * vkp - s * vkq;
          V[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  if (det(V as Mat3) < 0) for (let k = 0; k < 3; k++) V[k]![2] = -V[k]![2]!;
  const S = [0, 1, 2].map((i) => Math.sqrt(Math.max(B[i]![i]!, 0))) as Vec3;
  const MV = mul(M, V as Mat3);
  const U = MV.map((row) => row.map((v, j) => v / S[j]!)) as Mat3;
  return { U, S, V: V as Mat3 };
}

function det(m: Mat3): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

function mul(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j])) as Mat3;
}

function transpose(m: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]) as Mat3;
}

function norm(m: Mat3): number {
  return Math.sqrt(m.flat().reduce((sum, v) => sum + v * v, 0));
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));
const deg = (rad: number) => (rad * 180) / Math.PI;
