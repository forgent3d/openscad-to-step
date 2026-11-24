// Runs a command with OPENSCAD_WASM_DIR pointing at the OpenSCAD build @forgent3d/cad-build ships (the tests and the
// fixture diff run OpenSCAD directly, without going through convert()).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const dir = dirname(createRequire(import.meta.url).resolve("@forgent3d/cad-build/package.json"));
const env = { ...process.env, OPENSCAD_WASM_DIR: process.env.OPENSCAD_WASM_DIR || join(dir, "dist", "assets", "openscad"), CAD_BUILD_BIN: process.env.CAD_BUILD_BIN || join(dir, "bin", "cad-build.mjs") };
const [command, ...args] = process.argv.slice(2);
const run = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(run.status ?? 1);
