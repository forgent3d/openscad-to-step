// minkowski with a ball is exactly a 3D offset
minkowski() {
    cube([20, 14, 8]);
    sphere(r = 3, $fn = 64);
}
translate([0, 40, 0]) linear_extrude(5) minkowski() {
    square([20, 12]);
    circle(r = 4, $fn = 64);
}
