// sphere(style = "octa") (OpenSCAD 2026): the subdivided octahedron, point for point — 1, 2 and 3 subdivisions
sphere(r = 10, $fn = 4, style = "octa");
translate([30, 0, 0]) sphere(r = 10, $fn = 6, style = "octa");
translate([60, 0, 0]) sphere(r = 10, $fn = 12, style = "octa");
// the ring sphere, said and unsaid
translate([0, 30, 0]) sphere(r = 10, $fn = 7, style = "orig");
translate([30, 30, 0]) sphere(r = 10, $fn = 7);
// a fractional $fn rounds up since 2026: a hexagonal prism, not a pentagonal one
translate([60, 30, 0]) cylinder(r = 10, h = 5, $fn = 5.5);
// octa spheres hulled into a low-poly capsule
translate([0, 60, 0]) hull() { sphere(r = 5, $fn = 8, style = "octa"); translate([20, 0, 0]) sphere(r = 5, $fn = 8, style = "octa"); }
