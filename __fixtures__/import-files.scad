// The project's own data files (assets/, mounted beside this file): import() of a binary STL and an SVG, surface()
// of a height map — no exact counterpart, so each is built from OpenSCAD's render of it (mesh fallback, a warning)
import("assets/wedge.stl");
translate([20, 0, 0]) linear_extrude(height = 2) import("assets/tab.svg");
translate([0, 20, 0]) surface(file = "assets/bump.dat");
