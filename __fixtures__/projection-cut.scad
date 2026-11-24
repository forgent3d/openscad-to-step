// projection(cut = true): the slice at z = 0, re-extruded
linear_extrude(3) projection(cut = true) translate([0, 0, -5]) difference() {
    cube([24, 16, 10], center = true);
    cylinder(r = 4, h = 40, center = true, $fn = 64);
}
