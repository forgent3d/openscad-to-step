// case 06: a standing and a lying cylinder — skew rims, fitted smooth bridges.
hull() { cylinder(r = 5, h = 3); translate([20, 0, 5]) rotate([90, 0, 0]) cylinder(r = 3, h = 8, center = true); }
