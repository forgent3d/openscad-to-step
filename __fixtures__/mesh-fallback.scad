// Mesh fallback: nodes with no exact counterpart are built from OpenSCAD's own render (facets, with a warning)
// explicit $fn: the fallback embeds OpenSCAD's render as authored, and the fixture oracle's -D $fa/$fs cannot refine it
linear_extrude(height = 2) projection() rotate([40, 0, 0]) cylinder(h = 10, r = 3, $fn = 48);
translate([20, 0, 0]) linear_extrude(height = 1) offset(delta = 1, chamfer = true) square(4);
translate([40, 0, 0]) difference() {
  cube([10, 10, 3]);
  translate([5, 5, -1]) linear_extrude(height = 5) offset(delta = 0.5, chamfer = true) circle(r = 2, $fn = 8);
}
