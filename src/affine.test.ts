// multmatrix → moves (affine.ts). Each plan is rebuilt as a matrix and compared with the input, so the
// steps are proven to BE the matrix; the shapes of the plans are pinned where a simpler one exists.
//   node_modules/.bin/tsx --test src/affine.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planAffine, svd3, type AffinePlan, type Mat3, type Vec3 } from "./affine.ts";

const rad = (d: number) => (d * Math.PI) / 180;
const Rx = (a: number): Mat3 => [[1, 0, 0], [0, Math.cos(rad(a)), -Math.sin(rad(a))], [0, Math.sin(rad(a)), Math.cos(rad(a))]];
const Ry = (a: number): Mat3 => [[Math.cos(rad(a)), 0, Math.sin(rad(a))], [0, 1, 0], [-Math.sin(rad(a)), 0, Math.cos(rad(a))]];
const Rz = (a: number): Mat3 => [[Math.cos(rad(a)), -Math.sin(rad(a)), 0], [Math.sin(rad(a)), Math.cos(rad(a)), 0], [0, 0, 1]];
const D = (x: number, y: number, z: number): Mat3 => [[x, 0, 0], [0, y, 0], [0, 0, z]];
const mul = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i]![0] * b[0]![j]! + a[i]![1] * b[1]![j]! + a[i]![2] * b[2]![j]!)) as Mat3;

function rebuild(plan: AffinePlan): { A: Mat3; t: Vec3 } {
  let A = D(1, 1, 1);
  let t: Vec3 = [0, 0, 0];
  for (const step of plan!.steps) {
    if (step.kind === "mirror") A = mul([D(-1, 1, 1), D(1, -1, 1), D(1, 1, -1)][step.axis]!, A);
    if (step.kind === "rotate") A = mul(mul(Rz(step.angles[2]), mul(Ry(step.angles[1]), Rx(step.angles[0]))), A);
    if (step.kind === "scale") A = mul(typeof step.factors === "number" ? D(step.factors, step.factors, step.factors) : D(...step.factors), A);
    if (step.kind === "move") t = step.offset;
  }
  return { A, t };
}

function assertIs(A: Mat3, tolerance: number) {
  const plan = planAffine(A, [1, 2, 3]);
  assert.ok(plan);
  const back = rebuild(plan);
  const err = Math.max(...A.flat().map((v, i) => Math.abs(v - back.A.flat()[i]!)));
  assert.ok(err <= tolerance, `off by ${err}: ${JSON.stringify(plan.steps)}`);
  assert.deepEqual(back.t, [1, 2, 3]);
  return plan.steps;
}

test("a rotation comes back as its round angles; one that is not round stays exactly what it is", () => {
  assert.deepEqual(assertIs(Rz(30), 1e-12)[0], { kind: "rotate", angles: [0, 0, 30] });
  assert.deepEqual(assertIs(mul(Ry(90), Rx(35)), 1e-12)[0], { kind: "rotate", angles: [35, 90, 0] });
  assert.deepEqual(assertIs(mul(Rz(30), mul(Ry(20), Rx(10))), 1e-12)[0], { kind: "rotate", angles: [10, 20, 30] });
  const odd = assertIs(Rz(360 / 7), 1e-12)[0];
  assert.ok(odd?.kind === "rotate" && Math.abs(odd.angles[2] - 360 / 7) < 1e-12);
  // 29.99999° is a real angle now that the matrix is exact — the 6-digit csg had to round it to 30
  const near = assertIs(Rz(29.99999), 1e-12)[0];
  assert.ok(near?.kind === "rotate" && Math.abs(near.angles[2] - 29.99999) < 1e-9);
});

test("a mirror is a mirror about the plane it names, not a mirror plus a half turn", () => {
  assert.deepEqual(assertIs(D(-1, 1, 1), 1e-12), [{ kind: "mirror", axis: 0 }, { kind: "move", offset: [1, 2, 3] }]);
  assert.deepEqual(assertIs(D(1, 1, -1), 1e-12)[0], { kind: "mirror", axis: 2 });
  assert.deepEqual(assertIs(mul(Rz(20), D(1, -1, 1)), 1e-12).slice(0, 2), [{ kind: "mirror", axis: 1 }, { kind: "rotate", angles: [0, 0, 20] }]);
});

test("scales: uniform stays a scalar (a similarity), per-axis in the right order, a rotated one reads its print", () => {
  assert.deepEqual(assertIs(D(2, 2, 2), 1e-12)[0], { kind: "scale", factors: 2 });
  assert.deepEqual(assertIs(D(1.99999, 1.99999, 1.99999), 1e-12)[0], { kind: "scale", factors: 1.99999 });
  assert.deepEqual(assertIs(mul(D(2, 2, 2), Rz(45)), 1e-12).slice(0, 2), [{ kind: "scale", factors: 2 }, { kind: "rotate", angles: [0, 0, 45] }]);
  // rotate(scale(child)) scales the child's axes; scale(rotate(child)) the world's
  assert.deepEqual(assertIs(mul(Rz(30), D(2, 1, 3)), 1e-12).slice(0, 2), [{ kind: "scale", factors: [2, 1, 3] }, { kind: "rotate", angles: [0, 0, 30] }]);
  assert.deepEqual(assertIs(mul(D(2, 1, 3), Rz(30)), 1e-12).slice(0, 2), [{ kind: "rotate", angles: [0, 0, 30] }, { kind: "scale", factors: [2, 1, 3] }]);
});

test("a shear is exact (rotate · scale · rotate); a flat z is kept for a 2D child; a collapse is null", () => {
  assertIs([[1, 0, 0.5], [0, 1, 0], [0, 0, 1]], 1e-12);
  assertIs([[-1, 0.3, 0], [0, 1, 0], [0.2, 0, 1]], 1e-12);
  assert.deepEqual(assertIs(D(2, 2, 0), 1e-12)[0], { kind: "scale", factors: [2, 2, 0] });
  assert.equal(planAffine([[1, 0, 0], [0, 1, 0], [1, 1, 0]], [0, 0, 0]), null);
  const M: Mat3 = [[1, 0.5, 0.2], [0.1, 2, 0.3], [0, 0.4, 1.5]];
  const { U, S, V } = svd3(M);
  const Vt = [0, 1, 2].map((i) => [V[0][i], V[1][i], V[2][i]]) as Mat3;
  const back = mul(mul(U, D(...S)), Vt);
  assert.ok(Math.max(...M.flat().map((v, i) => Math.abs(v - back.flat()[i]!))) < 1e-12);
});
