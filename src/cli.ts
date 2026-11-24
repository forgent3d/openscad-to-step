import { readFileSync } from "node:fs";
import { convert, type ConvertOptions } from "./convert.ts";

const USAGE = `openscad-to-step <file.scad> [options]

Converts an OpenSCAD file to a STEP with exact geometry: circles become true cylinders, BOSL2 shapes, hull() and
minkowski() become exact surfaces where they have one, and anything that stays faceted is reported.

Options:
  -o, --out <file.step>     where to write the STEP (default: next to the .scad)
  --root <dir>              the project folder include/use/import() resolve in (default: the .scad's folder)
  -D <name>=<value>         set a Customizer parameter (OpenSCAD syntax: 10, "M3", true, [1, 2]); repeatable
  --model-py <file.py>      also write the generated build123d model.py
  --cosmetic-threads        draw BOSL2 threads as plain cylinders
  --all-warnings            also list where the STEP is MORE exact than OpenSCAD's preview
  -h, --help                this text
  -v, --version             the version
`;

function parse(argv: string[]): ConvertOptions | string {
  const options: ConvertOptions = { file: "", params: {} };
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k]!;
    const value = () => {
      const next = argv[++k];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "-o" || arg === "--out") options.out = value();
    else if (arg === "--root") options.root = value();
    else if (arg === "--model-py") options.modelPy = value();
    else if (arg === "--cosmetic-threads") options.cosmeticThreads = true;
    else if (arg === "--all-warnings") options.allWarnings = true;
    else if (arg === "-D" || arg.startsWith("-D")) {
      const pair = arg === "-D" ? value() : arg.slice(2);
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`-D ${pair}: expected name=value`);
      options.params![pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error(`one .scad file at a time (got ${options.file} and ${arg})`);
  }
  if (!options.file) return USAGE;
  return options;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  let options: ConvertOptions | string;
  try {
    options = parse(argv);
  } catch (err) {
    process.stderr.write(`openscad-to-step: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (typeof options === "string") {
    process.stderr.write(options);
    return 2;
  }
  const result = await convert(options);
  for (const warning of result.warnings) process.stderr.write(`${warning}\n`);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error}\n`);
    return 1;
  }
  process.stdout.write(`wrote ${result.out}${result.size ? ` (${result.size} mm)` : ""}\n`);
  return 0;
}

process.exitCode = await main();
