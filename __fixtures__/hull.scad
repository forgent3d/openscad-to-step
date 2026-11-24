// hull(): exact 2D convex hulls (lines + arcs) and upright prisms sharing one z-range
linear_extrude(4) hull() { circle(5); translate([20, 0]) circle(2); }
translate([0, 20, 0]) linear_extrude(3) hull() { rotate(30) square([10, 4], center = true); translate([15, 5]) circle(2); }
translate([40, 0, 0]) hull() for (p = [[0, 0], [20, 0], [20, 10], [0, 10]]) translate([p[0], p[1], 1]) cylinder(r = 3, h = 5);
translate([40, 30, 0]) hull() { cube([10, 10, 4]); translate([20, 0, 0]) cube([10, 10, 4]); }
translate([0, 40, 0]) linear_extrude(2) hull() { circle(4, $fn = 6); translate([12, 0]) circle(4, $fn = 6); }
translate([80, 0, 0]) hull() { translate([-5, -5, 0]) cube([10, 10, 6]); translate([25, 0, 0]) cylinder(r = 4, h = 6); }
