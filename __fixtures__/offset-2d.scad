// offset: rounded (r) and sharp (delta) corners on a profile with a hole
linear_extrude(4) offset(r = 2) square([30, 18], center = true);
translate([0, 40, 0]) linear_extrude(4) offset(delta = 3) square([30, 18], center = true);
translate([0, -40, 0]) linear_extrude(4) difference() {
    offset(r = -2) square([30, 18], center = true);
    circle(r = 4);
}
