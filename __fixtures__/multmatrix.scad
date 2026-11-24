// multmatrix(m) of plain numbers (affine.ts): each result is clipped by a box lopsided on every axis, so the
// clipped volume depends on the orientation, the handedness and the scale — not just the size
module block() translate([-2, 1, -1]) cube([8, 3, 6]);
module clip(at) translate([at, 0, 0]) intersection() { children(); translate([-4, -6, -3]) cube([9, 9, 7]); }
clip(0) multmatrix([[1, 0, 0, 1.5], [0, 1, 0, -2], [0, 0, 1, 0.5], [0, 0, 0, 1]]) block();       // a move
clip(30) multmatrix([[0.866025, -0.5, 0, 0], [0.5, 0.866025, 0, 0], [0, 0, 1, 0]]) block();      // rotate z 30 (as .csg prints it)
clip(60) multmatrix([[-1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]) block();                        // mirror x
clip(90) multmatrix([[0, 1, 0, 0], [1, 0, 0, 0], [0, 0, 1, 0]]) block();                         // swap x and y: a mirror
clip(120) multmatrix([[1.5, 0, 0, 0], [0, 1.5, 0, 0], [0, 0, 1.5, 0]]) block();                  // uniform scale
clip(150) multmatrix([[1.29904, -0.5, 0, 0], [0.75, 0.866025, 0, 0], [0, 0, 1.2, 0]]) block();   // rotate · per-axis scale
clip(180) multmatrix([[1, 0, 0.6, 0], [0, 1, 0, 0], [0, 0, 1, 0]]) block();                      // shear x by z
clip(210) multmatrix([[1, 0.4, 0, 0], [0, -1, 0, 0], [0.2, 0, 1, 0]]) cylinder(h = 5, r = 2);    // shear + mirror, a curved child
clip(240) multmatrix([[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 3, 0]]) translate([0.5, 0, 0]) linear_extrude(height = 1, center = true) square([2, 1]); // Write.scad's fold
