// a customizer whose defaults are 0 (thing 193941): sphere(0) is empty in OpenSCAD, and so is a
// hull of nothing but them — it must not take the rest of the model down with it.
for (x = [0, 5], y = [0, 5]) hull() {
  translate([x, y, 0]) sphere(0);
  translate([x, y, 3]) sphere(0);
}
cube(5);
