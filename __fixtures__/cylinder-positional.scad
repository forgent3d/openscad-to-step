// cylinder's positional order is (h, r1, r2, center) and an unset radius is 1 (thing 3446199):
// cylinder(10, 5) is a cone to r = 1, cylinder(1, 2, 0) a pointed cone, (h, r, r, true) a
// centred cylinder. Radii from variables go through the runtime choice.
$fn = 96;
a = 3;
cylinder(10, 5);
translate([15, 0, 0]) cylinder(1, 2, 0);
translate([30, 0, 0]) cylinder(10, 5, 5, true);
translate([45, 0, 0]) cylinder(4, a, a);
translate([60, 0, 0]) cylinder(4, a, 1);
