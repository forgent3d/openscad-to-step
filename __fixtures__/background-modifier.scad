// % and * subtrees stay out of the output; a module made only of them is empty
module motor_dummy() {
    translate([-22, -22, -5]) %cube([44, 44, 5]);
    translate([18, 18, -5]) %cylinder(r = 2, h = 24);
}
module bracket() {
    difference() {
        cube([44, 44, 24]);
        translate([22, 22, -1]) cylinder(r = 6, h = 26);
    }
    *translate([0, 0, 30]) cube(10);
    motor_dummy();
}
bracket();
%translate([60, 0, 0]) sphere(10);
