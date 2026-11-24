# openscad-to-step

Convert OpenSCAD files to STEP with real curved surfaces, not triangles.

```sh
npx openscad-to-step bracket.scad            # writes bracket.step
npx openscad-to-step box.scad -D wall=2.4 -o box-thick.step
```

OpenSCAD itself only exports meshes. A STEP made from a mesh is thousands of flat facets, which CAD tools,
CAM and machine shops can't measure or edit properly. This tool gives you a cylinder where you wrote `cylinder()`.

## How it works

1. **The real OpenSCAD evaluates your file.** It's compiled to WebAssembly from a small fork
   ([forgent3d/openscad](https://github.com/forgent3d/openscad), GPL), so modules, loops, `include`/`use`, functions
   and the Customizer behave as on the desktop. The fork exports the evaluated tree at full precision (the stock
   `.csg` export keeps 6 significant digits).
2. **The converter in this repo reads that tree** and writes it as a Python [build123d](https://github.com/gumyr/build123d)
   model: every primitive, transform and boolean, with a comment on each line pointing back to the `.scad` call
   that made it.
3. **An OCCT-based engine builds the model as exact B-rep** and writes the STEP. The engine comes from the
   [`@forgent3d/cad-build`](https://www.npmjs.com/package/@forgent3d/cad-build) npm package (WebAssembly, runs
   locally, nothing is uploaded). It's free to use but not open source; see [What's open](#whats-open).

## What comes out exact, and what doesn't

- **Circles are true circles** whatever `$fn` says: cylinders, spheres, cones, `rotate_extrude`, round holes.
  `$fn` of 12 or less is read as a polygon you asked for (a hex nut stays a hex).
- **`hull()` and `minkowski()`** are exact for the common cases: rounded boxes, slots, spheres and cylinders hulled
  together, a shape grown by a sphere or a circle. Other combinations still build, with flat facets.
- **`text()`** uses OpenSCAD's own glyph outlines, curves included. Write.scad's fonts are built in.
- **BOSL2** is built in. `cuboid()`, `cyl()`, `spheroid()`, `prismoid()` with roundings and spur gears are rebuilt
  as exact surfaces, checked against BOSL2's own polygons first. Threads keep BOSL2's facets;
  `--cosmetic-threads` draws them as plain cylinders, as CAD tools draw cosmetic threads.
- **Faceted:** twisted `linear_extrude`, `import()`ed STL/OFF/3MF, `surface()`, `roof()`, `projection(cut=false)`.

Whenever the STEP is less exact than your source, the tool prints a warning with the `.scad` line. It never
substitutes facets silently.

## Usage

```
openscad-to-step <file.scad> [options]

  -o, --out <file.step>     where to write the STEP (default: next to the .scad)
  --root <dir>              the project folder include/use/import() resolve in (default: the .scad's folder)
  -D <name>=<value>         set a Customizer parameter (OpenSCAD syntax: 10, "M3", true, [1, 2]); repeatable
  --model-py <file.py>      also write the generated build123d model.py
  --cosmetic-threads        draw BOSL2 threads as plain cylinders
  --all-warnings            also list where the STEP is MORE exact than OpenSCAD's preview
```

Requires Node.js 20 or later. The first run downloads about 30 MB (60 MB installed): the engine, Python and OpenSCAD,
all as WebAssembly.

**Projects.** The `.scad` file's folder is the project. Files it includes or uses, and data files read by `import()`
or `surface()`, are found at their relative paths. MCAD, BOSL2 and Write.scad are built in, so you don't need
them in the folder. Fonts other than Liberation must be in the folder.

**Parameters.** `-D` changes the value in the file's top-level assignment before OpenSCAD runs, the way the
Customizer does. Your file on disk isn't touched.

### As a library

```js
import { convert } from "openscad-to-step";

const result = await convert({ file: "bracket.scad", out: "bracket.step", params: { holes: "4" } });
if (!result.ok) console.error(result.errors.join("\n"));
for (const warning of result.warnings) console.warn(warning);
```

`transpileViaOpenScad`, `transpileTree` and `runOpenScad` are exported too, if you want the model.py without
building it.

## Online

The same conversion runs in the browser at [forgent3d.com/openscad-to-step](https://www.forgent3d.com/openscad-to-step),
with a 3D preview and the Customizer's parameters as sliders.

## Testing

```sh
npm install
npm test               # unit tests
npm run test:fixtures  # every file in __fixtures__ against OpenSCAD's own render: volume and bounding box
```

The fixture run renders each file with OpenSCAD at fine facets and compares volume and bounding box with the
STEP's (1% tolerance; circles are exact on our side and faceted on OpenSCAD's). It takes a while, because CGAL
renders slowly at fine facets.

## What's open

| Part | License | Where |
| --- | --- | --- |
| The converter (this repo) | AGPL-3.0, or a commercial license | here |
| The OpenSCAD fork | GPL-2.0-or-later | [forgent3d/openscad](https://github.com/forgent3d/openscad), branch `forgent3d` |
| Bundled libraries: BOSL2, MCAD, Write.scad | BSD-2-Clause, LGPL-2.1, CC BY-SA | `src/libraries/`, with their license files |
| The B-rep engine | free to use, closed source | [`@forgent3d/cad-build`](https://www.npmjs.com/package/@forgent3d/cad-build) (OCCT under LGPL-2.1, see its notices) |

## License

The converter is licensed under the [GNU AGPL-3.0](LICENSE): you can use, change and share it, and if you distribute
it, or run a changed version as a service others use, you publish the source of your whole project under the same
license. [`LICENSE-EXCEPTION.md`](LICENSE-EXCEPTION.md) lets you combine it with the engine package without that
package's source.

If the AGPL doesn't work for your company, a commercial license is available: support@forgent3d.com.

## Contributing

This repo is exported from Forgent3D's main repository, where the converter also runs the website. Issues and pull
requests are welcome here; see [CONTRIBUTING.md](CONTRIBUTING.md). Accepted changes are applied upstream and come
back in the next export.

Most useful of all: `.scad` files that break it. Please open an issue with the file attached.
