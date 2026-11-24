# Third-party notices

The AGPL-3.0 in `LICENSE` (with the additional permission in `LICENSE-EXCEPTION.md`) covers the converter's own code. These parts are bundled with it under their own
licenses; the full texts ship next to them (`src/libraries/` in the repo, `dist/licenses/` in the npm package).

| Component | License | Source | Text |
| --- | --- | --- | --- |
| BOSL2 (BelfrySCAD), unmodified | BSD-2-Clause | https://github.com/BelfrySCAD/BOSL2 | `BOSL2-LICENSE.txt` |
| MCAD (OpenSCAD's bundled library), unmodified | LGPL-2.1 | https://github.com/openscad/MCAD | `MCAD-COPYING.txt` |
| Write.scad by HarlanDMii, unmodified | CC BY-SA | https://github.com/rohieb/Write.scad | `WRITE-SCAD-NOTICE.txt` |
| `src/vendor/write-fonts-meta.ts`: Write.scad's font names and character sets | CC BY-SA | as above | `WRITE-SCAD-NOTICE.txt` |

Not bundled, installed as a dependency: `@forgent3d/cad-build` (the B-rep engine, with OpenSCAD compiled to
WebAssembly from https://github.com/forgent3d/openscad under GPL-2.0-or-later, and OCCT under LGPL-2.1 with the
OCCT exception). Its notices ship inside that package.
