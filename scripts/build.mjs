// Bundles the converter for npm: dist/cli.mjs (the `openscad-to-step` bin) and dist/index.mjs (the library).
// The bundled OpenSCAD libraries (BOSL2 is 4.6 MB) stay separate chunks, loaded only when a file uses them.
// @forgent3d/cad-build stays a dependency: the engine and the OpenSCAD wasm come from it.
import { build } from "esbuild";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
await build({
  entryPoints: { cli: "src/cli.ts", index: "src/index.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  external: ["@forgent3d/cad-build"],
  // the shebang makes dist/cli.mjs runnable as the npm bin (without it the shell reads the file); in the library and
  // the chunks it is a comment to Node
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: "warning",
});

// the bundled libraries' license texts travel with the chunks that carry them
mkdirSync(new URL("../dist/licenses", import.meta.url), { recursive: true });
for (const name of readdirSync(new URL("../src/libraries", import.meta.url)).filter((n) => n.endsWith(".txt"))) {
  cpSync(new URL(`../src/libraries/${name}`, import.meta.url), new URL(`../dist/licenses/${name}`, import.meta.url));
}
