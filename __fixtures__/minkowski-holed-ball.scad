// case 07: a non-convex, curved base with a ball — still the offset. $fn pins the ORACLE's facets:
// OpenSCAD's own minkowski of a non-convex base goes through CGAL and does not finish at the
// harness's $fs=0.05 (the transpiler keeps true circles for $fn > 12 either way).
minkowski() { difference() { cube([30, 20, 4]); translate([15, 10, -1]) cylinder(r = 5, h = 6, $fn = 64); } sphere(1, $fn = 24); }
