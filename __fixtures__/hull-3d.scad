// hull over straight-edged solids, and over equal-radius spheres
hull() {
    cube([20, 14, 4]);
    translate([6, 4, 18]) rotate([0, 0, 30]) cube([8, 6, 4]);
}
translate([0, 40, 0]) hull() {
    translate([0, 0, 0]) sphere(r = 4, $fn = 64);
    translate([24, 0, 0]) sphere(r = 4, $fn = 64);
    translate([12, 18, 0]) sphere(r = 4, $fn = 64);
    translate([12, 6, 14]) sphere(r = 4, $fn = 64);
}
