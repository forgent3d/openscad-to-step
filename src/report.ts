/**
 * OpenSCAD renders a project, its mesh is read back, and it is written up as a report for the author — shared by the
 * cad-build CLI (`rebuild` / `snapshot` / `export`) and
 * the in-product agent's `rebuild_model` / `screenshot` (build-service scad.ts, run in the sandbox), so both sides say
 * the same thing.
 *
 * Does not produce model.py and does not enter the kernel: every number in the report is OpenSCAD's own rendering (the
 * GUI's F5). It does not touch the file system: reading the folder is in
 * node-project.ts, and the runner that runs OpenSCAD is injected by the caller (node.mjs `runOpenScad`).
 */

import { renderViaOpenScad, type OpenScadRunner, type ScadAssets } from "./csg.ts";
import { MAX_ASSET_BYTES, MAX_PROJECT_BYTES, MAX_PROJECT_FILES } from "./project.ts";
import { previewDraws, previewVolume, readScadPreview, ScadPreviewError, type ScadPreview } from "./preview.ts";
import type { ScadParameter } from "./params.ts";
import type { ScadDiagnostic, ScadFiles } from "./transpile.ts";

/** A project as OpenSCAD is handed it: the entry's text apart, every other .scad and data file by project path. */
export type ScadProjectInput = {
  /** The entry's path inside the project, as OpenSCAD sees it. */
  entry: string;
  source: string;
  files: ScadFiles;
  assets: ScadAssets;
  /** Files left out for the project limits (project.ts) — said in the report, never silently. */
  skipped?: number;
};

/** What OpenSCAD's render of a project came to: the mesh, and what to tell the author with it. */
export type ScadRender = {
  preview: ScadPreview;
  parameters: ScadParameter[];
  nodes: number;
  warnings: ScadDiagnostic[];
  /** What the model echo()ed — the author's readout, since nothing else can probe a .scad. */
  echo: string[];
};

/** `file:line:col`, or just the file for a diagnostic about the file as a whole. */
export const scadWhere = (d: ScadDiagnostic): string => (d.line > 1 || d.column > 1 ? `${d.file}:${d.line}:${d.column}` : d.file);

const FAILURE_LEAD: Record<string, string> = {
  "openscad-error": "OpenSCAD could not evaluate the model",
  "missing-file": "a file the model includes, uses or imports is missing — nothing is rendered, because OpenSCAD would silently leave that part out",
  "too-large": "the model is too large for this build",
  unsupported: "OpenSCAD could not render the model",
};

/**
 * The real OpenSCAD renders the project — modules, loops, include/use, the bundled MCAD / BOSL2 / Write.scad — and
 * the mesh it draws is what every reader takes. `options.source` stands in for the entry's text (a Customizer
 * parameter moved); `options.hints` closes a failure with the caller's own advice (the CLI's `--root`).
 */
export async function renderScadProject(
  project: ScadProjectInput,
  run: OpenScadRunner,
  options: { source?: string; hints?: Partial<Record<string, string>> } = {},
): Promise<({ ok: true } & ScadRender) | { ok: false; text: string }> {
  const via = await renderViaOpenScad(options.source ?? project.source, { files: project.files, assets: project.assets, entry: project.entry, run });
  if (!via.ok) {
    const hint = options.hints?.[via.reason];
    const text = [`openscad: ${FAILURE_LEAD[via.reason] ?? via.reason}`, ...via.diagnostics.map((d) => `  ${scadWhere(d)}: ${d.message}`), ...(hint ? [hint] : [])].join("\n");
    return { ok: false, text };
  }
  if (!via.preview) return { ok: false, text: ["openscad: OpenSCAD produced no render", ...via.warnings.map((d) => `  ${scadWhere(d)}: ${d.message}`)].join("\n") };
  let preview: ScadPreview;
  try {
    preview = readScadPreview(via.preview);
  } catch (err) {
    if (!(err instanceof ScadPreviewError)) throw err;
    return { ok: false, text: `openscad: OpenSCAD's render could not be read: ${err.message}` };
  }
  return { ok: true, preview, parameters: via.parameters, nodes: via.nodes, warnings: via.warnings, echo: via.echo };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The model mesh's extent, as the workbench reports it; null for an empty render. */
export function scadSizeOf(preview: ScadPreview): number[] | null {
  if (!preview.bbox) return null;
  return [0, 1, 2].map((axis) => round2(preview.bbox!.max[axis]! - preview.bbox!.min[axis]!));
}

/** The lines of a .scad report: OpenSCAD's render read back, then what it printed and what it warned about. */
export function scadRenderReport(project: ScadProjectInput, r: ScadRender): string[] {
  const { preview } = r;
  const lines = ["ok"];
  if (preview.bbox) {
    lines.push(`bbox: size [${scadSizeOf(preview)!.join(" x ")}] min [${preview.bbox.min.map(round2).join(", ")}]`);
    lines.push(`volume: ${round2(previewVolume(preview))} mm³ (OpenSCAD's render: $fn facets, so a curved part reads a little under its true volume)`);
  } else {
    lines.push("empty: Current top level object is empty — every object came out with no volume (OpenSCAD's own words; a size left at 0, a difference() that ate everything)");
  }
  const model = preview.meshes.filter((m) => m.kind === "model");
  const flat = model.filter((m) => m.dim === 2).length;
  const background = preview.meshes.filter((m) => m.kind === "background").length;
  const highlight = preview.meshes.filter((m) => m.kind === "highlight").length;
  lines.push(
    `render: ${preview.triangles} triangles in ${model.length} mesh(es)${flat ? `, ${flat} of them 2D` : ""}${background ? `; ${background} %-background mesh(es), not part of the model` : ""}${highlight ? `; ${highlight} #-highlight mesh(es)` : ""} — OpenSCAD's own render (what F5 shows), facets and all`,
  );
  lines.push(`openscad: ${project.entry} → ${r.nodes} nodes`);
  if (project.skipped) lines.push(`  ${project.skipped} file(s) in the folder skipped: over the project limits (${MAX_PROJECT_FILES} files, ${MAX_PROJECT_BYTES >> 20} MB of .scad, ${MAX_ASSET_BYTES >> 20} MB of data files)`);
  if (r.echo.length) {
    lines.push("echo:");
    for (const line of r.echo.slice(0, 40)) lines.push(`  ECHO: ${line}`);
    if (r.echo.length > 40) lines.push(`  …${r.echo.length - 40} more`);
  }
  if (r.warnings.length) {
    lines.push(`warnings (${r.warnings.length}):`);
    for (const w of r.warnings.slice(0, 24)) lines.push(`  ${scadWhere(w)}: ${w.message}`);
    if (r.warnings.length > 24) lines.push(`  …${r.warnings.length - 24} more`);
  }
  return lines;
}

/** One solid of the render as the renderers and mesh encoders take it: one per colour, as the workbench draws them. */
export type ScadSolidBody = {
  name: string;
  positions: Float64Array;
  indices: Uint32Array;
  /** null = the scheme's face colour (the renderer's clay); a color() keeps its colour. */
  rgba: [number, number, number, number] | null;
};

/** The model's solid triangles: %-background, #-highlight and 2D (double-sided) draws are not the part. */
export function scadSolidBodies(preview: ScadPreview): ScadSolidBody[] {
  return previewDraws(preview)
    .filter((d) => d.name.startsWith("model_") && !d.doubleSided)
    .map((d) => ({
      name: d.name,
      positions: Float64Array.from(d.positions),
      indices: d.indices,
      rgba: d.name.includes("_color_") ? ([d.color[0], d.color[1], d.color[2], d.opacity] as [number, number, number, number]) : null,
    }));
}
