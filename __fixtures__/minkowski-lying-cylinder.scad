// case 08: the cylinder lies along Y; the cube is a prism along Y too — the shared direction
// need not be Z.
minkowski() { cube([30, 20, 4]); rotate([90, 0, 0]) cylinder(r = 2, h = 1, center = true); }
