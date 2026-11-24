// hull over co-planar equal-radius spheres (the degenerate-hull path)
hull() {
    translate([0, 0, 0]) sphere(r = 3);
    translate([20, 0, 0]) sphere(r = 3);
    translate([20, 14, 0]) sphere(r = 3);
    translate([0, 14, 0]) sphere(r = 3);
}
