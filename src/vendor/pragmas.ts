// Copied from Forgent3D's engine (@forgent3d/cad-engine/pragmas): the converter writes these into model.py.
// model.py lines the engine reads before it runs the file. Its own subpath export
// (`@forgent3d/cad-engine/pragmas`): the SCAD transpiler writes them in the browser, without the engine.

/**
 * Turns the boolean guard on for this build (kernel.ts `setBooleanGuard`). The SCAD transpiler writes
 * it; agent models leave it out. It lives in the file, not in a build option, so the browser and node
 * read the same answer from the same source.
 */
export const BOOLEAN_GUARD_PRAGMA = "# forgent3d: boolean-guard";

export function wantsBooleanGuard(source: string): boolean {
  return source.split("\n").some((line) => line.trimEnd() === BOOLEAN_GUARD_PRAGMA);
}

/**
 * The file is a plain build123d script, not a Forgent3D model.py: a build123d preview writes it
 * at the end of the pasted script. When the script leaves no `model`, the engine makes one from what
 * the script built (python/forgent3d/_script.py `picks`), and its booleans are checked
 * (b123d/kernel.ts `setScriptBooleans`). Agent models never carry it — model.py's contract is
 * unchanged; a script SAVED as a model loses the line and gains an explicit model export instead
 * (project/script-model.ts).
 */
export const SCRIPT_MODE_PRAGMA = "# forgent3d: script";

export function wantsScriptMode(source: string): boolean {
  return source.split("\n").some((line) => line.trimEnd() === SCRIPT_MODE_PRAGMA);
}
