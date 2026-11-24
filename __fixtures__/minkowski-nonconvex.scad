// minkowski beyond "a convex second child"
// a) the convex child written FIRST: the sum is commutative, the convex one is the kernel
minkowski() { cube(2, center = true); linear_extrude(3) polygon([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]); }
// b) both non-convex, both upright extrusions: an L plus a small L
translate([30, 0, 0]) minkowski() {
    linear_extrude(3) polygon([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]);
    linear_extrude(1) polygon([[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]);
}
// c) a stacked base (two cubes, different footprints) with a cube kernel
translate([0, 30, 0]) minkowski() { union() { cube([10, 10, 3]); translate([2, 2, 3]) cube([6, 6, 4]); } cube(2, center = true); }
// d) 2D, both non-convex
translate([30, 30, 0]) linear_extrude(2) minkowski() {
    polygon([[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]]);
    polygon([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]);
}
// e) 2D, the circle written first
translate([60, 30, 0]) linear_extrude(2) minkowski() { circle(r = 2, $fn = 64); square([10, 6]); }
