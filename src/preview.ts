/**
 * The /scad preview mesh: the result of OpenSCAD's own rendering (the fork's `-O fgjson/preview=true`, export_fgjson.cc
 * `writePreview`),
 * drawn the way the GUI shows it on F5 — `color()` passes through Manifold's boolean operations onto the faces, an
 * uncolored face gets the color scheme's face color,
 * and faces left by a subtracted object get its back-face color; a `%` subtree is a separate mesh (it is not in the
 * render), and so is a `#` subtree (it is in the render, drawn once more on top).
 * The kernel (B-rep) does not take part in the preview and is loaded only when exporting STEP.
 *
 * Binary layout of the sidecar (little-endian): `FGPV`, u32 version 1, u32 mesh count; each mesh has u8 kind (0 model /
 * 1 `%` / 2 `#`), u8 dim (2|3),
 * u16 0, u32 vertex count, f32 xyz × vertex count, u32 triangle count, u32 abc × triangle count, u32 color count,
 * f32 rgba × color count, u32 color index × triangle count
 * (0xFFFFFFFF = none, use the face color).
 */

export type ScadPreviewKind = "model" | "background" | "highlight";

export type ScadPreviewMesh = {
  kind: ScadPreviewKind;
  /** 2: a 2D model, a triangulation at z = 0, drawn double-sided. */
  dim: 2 | 3;
  positions: Float32Array;
  indices: Uint32Array;
  /** rgba, 0–1. */
  colors: Float32Array;
  /** One per triangle: an index into `colors`, or NO_COLOR. */
  faceColor: Uint32Array;
};

export type ScadPreview = {
  meshes: ScadPreviewMesh[];
  triangles: number;
  /** World bounding box of the model mesh (excluding `%` / `#`); null when there is no model geometry. */
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
};

export const NO_COLOR = 0xffffffff;

const MAGIC = 0x56504746; // "FGPV" little-endian

export class ScadPreviewError extends Error {}

export function readScadPreview(buffer: ArrayBuffer): ScadPreview {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== MAGIC) throw new ScadPreviewError("not a preview sidecar");
  const version = view.getUint32(4, true);
  if (version !== 1) throw new ScadPreviewError(`preview sidecar version ${version} is not 1`);
  const count = view.getUint32(8, true);
  let offset = 12;
  const need = (bytes: number) => {
    if (offset + bytes > buffer.byteLength) throw new ScadPreviewError("preview sidecar is truncated");
  };
  // the arrays are copied out: the sidecar's offsets are not 4-aligned once a u8/u16 header sits in front
  const f32 = (n: number) => { need(n * 4); const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = view.getFloat32(offset + i * 4, true); offset += n * 4; return out; };
  const u32 = (n: number) => { need(n * 4); const out = new Uint32Array(n); for (let i = 0; i < n; i++) out[i] = view.getUint32(offset + i * 4, true); offset += n * 4; return out; };
  const meshes: ScadPreviewMesh[] = [];
  let triangles = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let m = 0; m < count; m++) {
    need(4);
    const kindCode = view.getUint8(offset);
    const dim = view.getUint8(offset + 1);
    offset += 4;
    const kind: ScadPreviewKind = kindCode === 1 ? "background" : kindCode === 2 ? "highlight" : "model";
    need(4);
    const nv = view.getUint32(offset, true); offset += 4;
    const positions = f32(nv * 3);
    need(4);
    const nt = view.getUint32(offset, true); offset += 4;
    const indices = u32(nt * 3);
    need(4);
    const nc = view.getUint32(offset, true); offset += 4;
    const colors = f32(nc * 4);
    const faceColor = u32(nt);
    for (let i = 0; i < nt * 3; i++) {
      if (indices[i]! >= nv) throw new ScadPreviewError("preview sidecar indexes a vertex it does not have");
    }
    for (let i = 0; i < nt; i++) {
      const c = faceColor[i]!;
      if (c !== NO_COLOR && c >= nc) throw new ScadPreviewError("preview sidecar indexes a colour it does not have");
    }
    if (kind === "model") {
      for (let i = 0; i < nv; i++) {
        for (let axis = 0; axis < 3; axis++) {
          const v = positions[i * 3 + axis]!;
          if (v < min[axis]!) min[axis] = v;
          if (v > max[axis]!) max[axis] = v;
        }
      }
    }
    triangles += nt;
    meshes.push({ kind, dim: dim === 2 ? 2 : 3, positions, indices, colors, faceColor });
  }
  if (offset !== buffer.byteLength) throw new ScadPreviewError("preview sidecar has trailing bytes");
  return { meshes, triangles, bbox: Number.isFinite(min[0]) ? { min, max } : null };
}

/**
 * The solid model's volume in mm³, from its triangles: OpenSCAD's render is closed and wound outward, so the signed
 * tetrahedra (origin, triangle) sum to it. `%` / `#` meshes and 2D models are not counted. It is the facets' volume —
 * a cylinder at $fn = 30 reads 0.7% under the true one — which is what OpenSCAD itself would report.
 */
export function previewVolume(preview: ScadPreview): number {
  let volume = 0;
  for (const mesh of preview.meshes) {
    if (mesh.kind !== "model" || mesh.dim !== 3) continue;
    const p = mesh.positions;
    const idx = mesh.indices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i]! * 3;
      const b = idx[i + 1]! * 3;
      const c = idx[i + 2]! * 3;
      volume +=
        (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
          p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
          p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
        6;
    }
  }
  return Math.abs(volume);
}

/** OpenSCAD's Cornfield scheme, as the GUI shows a model: the face colour, and how `%` / `#` are drawn over it. */
export const PREVIEW_COLORS = {
  face: [0xf9 / 255, 0xd7 / 255, 0x2c / 255] as [number, number, number],
  /** What OpenSCAD paints the faces an uncoloured subtracted object leaves (ManifoldGeometry::toPolySet); the sidecar carries it as a colour. */
  cut: [0x9d / 255, 0xcb / 255, 0x51 / 255] as [number, number, number],
  background: [0.7, 0.7, 0.7] as [number, number, number],
  highlight: [1, 0.32, 0.5] as [number, number, number],
  backgroundOpacity: 0.4,
  highlightOpacity: 0.5,
};

/** One thing to draw: a colour, its opacity, and the triangles that wear it (positions shared with the mesh they came from). */
export type ScadPreviewDraw = {
  name: string;
  color: [number, number, number];
  opacity: number;
  doubleSided: boolean;
  positions: Float32Array;
  indices: Uint32Array;
};

/**
 * The preview split into one draw per colour per mesh (a viewer draws one material per mesh). A `%` mesh is the
 * scheme's translucent grey whatever its colours, a `#` mesh its translucent pink; a `color()` with alpha < 1 is
 * that translucent.
 */
export function previewDraws(preview: ScadPreview): ScadPreviewDraw[] {
  const draws: ScadPreviewDraw[] = [];
  preview.meshes.forEach((mesh, meshIndex) => {
    const doubleSided = mesh.dim === 2;
    if (mesh.kind !== "model") {
      const background = mesh.kind === "background";
      draws.push({
        name: `${mesh.kind}_${meshIndex}`,
        color: background ? PREVIEW_COLORS.background : PREVIEW_COLORS.highlight,
        opacity: background ? PREVIEW_COLORS.backgroundOpacity : PREVIEW_COLORS.highlightOpacity,
        doubleSided,
        positions: mesh.positions,
        indices: mesh.indices,
      });
      return;
    }
    const groups = new Map<number, number[]>();
    const nt = mesh.faceColor.length;
    for (let t = 0; t < nt; t++) {
      const key = mesh.faceColor[t]!;
      let list = groups.get(key);
      if (!list) groups.set(key, (list = []));
      list.push(mesh.indices[t * 3]!, mesh.indices[t * 3 + 1]!, mesh.indices[t * 3 + 2]!);
    }
    // the scheme's face colour first, then the colours in the order the sidecar lists them: stable across rebuilds
    const keys = [...groups.keys()].sort((a, b) => (a === NO_COLOR ? -1 : b === NO_COLOR ? 1 : a - b));
    for (const key of keys) {
      const list = groups.get(key)!;
      const color: [number, number, number] = key === NO_COLOR
        ? PREVIEW_COLORS.face
        : [mesh.colors[key * 4]!, mesh.colors[key * 4 + 1]!, mesh.colors[key * 4 + 2]!];
      const alpha = key === NO_COLOR ? 1 : mesh.colors[key * 4 + 3]!;
      draws.push({
        name: key === NO_COLOR ? `model_${meshIndex}` : `model_${meshIndex}_color_${key}`,
        color,
        opacity: Math.min(1, Math.max(0, alpha)),
        doubleSided,
        positions: mesh.positions,
        indices: Uint32Array.from(list),
      });
    }
  });
  return draws;
}
