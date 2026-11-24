// hull over trimmed arcs and co-planar spheres: every form here used to be a hard error
// a) the corpus's `hull() for(...) circle()` idiom — the for-children are spliced, no pre-fuse
linear_extrude(2) hull() for (p = [[0, 0], [8, 0], [0, 8], [8, 8]]) translate(p) circle(3);
// b) an explicit union() inside hull(): the fuse leaves trimmed arcs, handled exactly
translate([20, 0, 0]) linear_extrude(2) hull() { union() { circle(3); translate([4, 0]) circle(3); } translate([12, 6]) circle(1); }
// c) offset() round corners + a circle
translate([40, 0, 0]) linear_extrude(2) hull() { offset(r = 1.5) square([8, 5]); translate([14, 2]) circle(2); }
// d) nine co-planar equal spheres (the old exact construction stopped at 8)
translate([0, 30, 0]) hull() for (i = [0 : 2], j = [0 : 2]) translate([5 * i, 5 * j, 0]) sphere(r = 2, $fn = 48);
// e) a row of equal spheres — the collinear case
translate([30, 30, 0]) hull() for (i = [0 : 4]) translate([4 * i, 0, 0]) sphere(r = 1.5, $fn = 48);
