// OpenSCAD's 2D has no up or down. A mirrored hull() was a face turned over (-Z) in build123d; its union with the
// square, face up, stayed two faces side by side, and offset(r = -2) shrank each on its own — the strip along their
// seam lost, as Thingiverse 5353030's mirrored foot (3.1% short)
$fn = 64;
linear_extrude(height = 5) offset(r = -2) offset(r = 2) {
    square([20, 10]);
    mirror([1, 0]) hull() {
        translate([2, 5]) circle(4);
        translate([12, 5]) circle(4);
    }
}
