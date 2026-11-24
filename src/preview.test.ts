// Reading the preview sidecar: the layout is read correctly, out-of-range indices are rejected, and meshes are split by color into drawable pieces (translucency of `%` / `#`, 2D double-sided).
import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_COLOR, PREVIEW_COLORS, previewDraws, readScadPreview } from "./preview.ts";

type Mesh = { kind: number; dim: number; positions: number[]; indices: number[]; colors: number[]; faceColor: number[] };

/** The sidecar as export_fgjson.cc writes it. */
function sidecar(meshes: Mesh[]): ArrayBuffer {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 255);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u8(v); u8(v >> 8); u8(v >> 16); u8(v >>> 24); };
  const f32 = (v: number) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, v, true); for (let i = 0; i < 4; i++) u8(b.getUint8(i)); };
  for (const c of "FGPV") u8(c.charCodeAt(0));
  u32(1);
  u32(meshes.length);
  for (const m of meshes) {
    u8(m.kind); u8(m.dim); u16(0);
    u32(m.positions.length / 3); m.positions.forEach(f32);
    u32(m.indices.length / 3); m.indices.forEach(u32);
    u32(m.colors.length / 4); m.colors.forEach(f32);
    m.faceColor.forEach(u32);
  }
  return Uint8Array.from(out).buffer;
}

const square = { positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], indices: [0, 1, 2, 0, 2, 3] };

test("reads a coloured model, a % mesh and a # mesh, with the model's bbox only", () => {
  const preview = readScadPreview(sidecar([
    { kind: 0, dim: 3, ...square, colors: [1, 0, 0, 1], faceColor: [0, NO_COLOR] },
    { kind: 1, dim: 3, positions: [100, 100, 100, 101, 100, 100, 101, 101, 100], indices: [0, 1, 2], colors: [], faceColor: [NO_COLOR] },
    { kind: 2, dim: 2, positions: [-5, 0, 0, -4, 0, 0, -4, 1, 0], indices: [0, 1, 2], colors: [], faceColor: [NO_COLOR] },
  ]));
  assert.equal(preview.meshes.length, 3);
  assert.equal(preview.triangles, 4);
  assert.deepEqual(preview.meshes.map((m) => m.kind), ["model", "background", "highlight"]);
  assert.deepEqual(preview.meshes[2]!.dim, 2);
  assert.deepEqual(preview.bbox, { min: [0, 0, 0], max: [10, 10, 0] });
  assert.deepEqual([...preview.meshes[0]!.colors], [1, 0, 0, 1]);
});

test("an empty sidecar is a preview with nothing in it", () => {
  const preview = readScadPreview(sidecar([]));
  assert.equal(preview.meshes.length, 0);
  assert.equal(preview.bbox, null);
});

test("rejects a wrong magic, a bad index and trailing bytes", () => {
  assert.throws(() => readScadPreview(new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]).buffer), /not a preview/);
  assert.throws(() => readScadPreview(sidecar([{ kind: 0, dim: 3, ...square, indices: [0, 1, 9], colors: [], faceColor: [NO_COLOR] }])), /vertex/);
  assert.throws(() => readScadPreview(sidecar([{ kind: 0, dim: 3, ...square, colors: [], faceColor: [3, 3] }])), /colour/);
  const bytes = new Uint8Array(sidecar([]).byteLength + 1);
  bytes.set(new Uint8Array(sidecar([])));
  assert.throws(() => readScadPreview(bytes.buffer), /trailing/);
});

test("splits a model by colour and draws % and # translucent", () => {
  const preview = readScadPreview(sidecar([
    { kind: 0, dim: 3, ...square, colors: [1, 0, 0, 1, 0, 0, 1, 0.5], faceColor: [1, NO_COLOR] },
    { kind: 1, dim: 2, ...square, colors: [1, 0, 0, 1], faceColor: [0, 0] },
    { kind: 2, dim: 3, ...square, colors: [], faceColor: [NO_COLOR, NO_COLOR] },
  ]));
  const draws = previewDraws(preview);
  assert.deepEqual(draws.map((d) => d.name), ["model_0", "model_0_color_1", "background_1", "highlight_2"]);
  assert.deepEqual(draws[0]!.color, PREVIEW_COLORS.face);
  assert.deepEqual([...draws[0]!.indices], [0, 2, 3]);
  assert.deepEqual(draws[1]!.color, [0, 0, 1]);
  assert.equal(draws[1]!.opacity, 0.5);
  assert.deepEqual([...draws[1]!.indices], [0, 1, 2]);
  // a % mesh ignores its own colours and is drawn double-sided when it is 2D
  assert.deepEqual(draws[2]!.color, PREVIEW_COLORS.background);
  assert.equal(draws[2]!.opacity, PREVIEW_COLORS.backgroundOpacity);
  assert.equal(draws[2]!.doubleSided, true);
  assert.equal(draws[3]!.opacity, PREVIEW_COLORS.highlightOpacity);
  assert.equal(draws[3]!.doubleSided, false);
});
