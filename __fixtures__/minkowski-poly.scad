// minkowski with a straight-edged convex kernel: base ∪ hull(triangle ⊕ kernel), exact here
// box ⊕ box = a (10+2) x (8+2) x (4+2) box
minkowski() { cube([10, 8, 4]); cube(2, center = true); }
// a non-convex L prism bevelled by a 4-sided pyramid, the corpus's letter-tile idiom
translate([30, 0, 0]) minkowski() {
    linear_extrude(3) polygon([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]);
    cylinder(r1 = 1.5, r2 = 0, h = 1.5, $fn = 4);
}
// a bipyramid kernel (hull of two cones), the glasses-arm idiom; the apex-down cone lofts from a point
translate([0, 30, 0]) minkowski() {
    cube([10, 10, 3]);
    hull() { cylinder(r1 = 0, r2 = 1, h = 1, $fn = 8); translate([0, 0, 1]) cylinder(r1 = 1, r2 = 0, h = 1, $fn = 8); }
}
// 2D: triangle ⊕ square, extruded so the diff can mesh it
translate([60, 0, 0]) linear_extrude(2) minkowski() { polygon([[0, 0], [8, 0], [0, 8]]); square(2, center = true); }
// three children fold left
translate([60, 30, 0]) minkowski() { cube(4); cube(1); cube([1, 1, 3]); }
