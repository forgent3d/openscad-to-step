// mirror about any plane, rotate about any axis: rotating/mirroring keeps the volume, so each result is
// clipped by a box that is lopsided on every axis, and the CLIPPED volume depends on the orientation
module block() translate([-2, 1, -1]) cube([8, 3, 6]);
module clip(at) translate([at, 0, 0]) intersection() { children(); translate([-4, -6, -3]) cube([9, 9, 7]); }
clip(0) mirror([1, 1, 0]) block();
clip(30) mirror([0, 1, 1]) block();
clip(60) rotate(a = 30, v = [1, 1, 1]) block();
clip(90) rotate(45, [0, -1, 0]) block();                  // a negative axis turns the other way
clip(120) rotate(a = 90, v = [1, 0, 1]) block();
n = [0.3, -1, 0.5];
clip(150) mirror(n) rotate(20, n) block();                // runtime vectors
clip(180) rotate(a = [0, 0, 30], v = [1, 0, 0]) block();  // a vector `a` ignores v
clip(210) mirror([0, 0, 1]) block();                      // coordinate planes stay the plain form
