// vector arithmetic is OpenSCAD's, not Python's: every result below becomes a SIZE, so the volume sees it
p = [1, 2, 3];
cube(p + [10, 10, 10]);                                        // element-wise: 11 x 12 x 13, not a 6-list
translate([20, 0, 0]) cube(-p + [5, 5, 5]);                    // negation: 4 x 3 x 2
translate([30, 0, 0]) cube(p * 2);                             // scaling: 2 x 4 x 6
translate([40, 0, 0]) cube([8, 6, 4] / 2);                     // vector / number: 4 x 3 x 2
translate([50, 0, 0]) cube(12 / [2, 3, 4]);                    // number / vector: 6 x 4 x 3
m = [[0, -1, 0], [1, 0, 0], [0, 0, 1]];
translate([60, 0, 0]) cube(m * [3, 5, 7] + [10, 0, 0]);        // matrix x vector: [-5, 3, 7] + ... = 5 x 3 x 7
translate([70, 0, 0]) cube([1, 2, 3] * m + [5, 5, 0]);         // vector x matrix: [2, -1, 3] + ... = 7 x 4 x 3
mm = [[1, 2], [3, 4]] * [[0, 1], [1, 0]];                      // matrix x matrix: [[2, 1], [4, 3]]
translate([80, 0, 0]) cube([mm[0][0], mm[1][1], mm[1][0]]);    // 2 x 3 x 4
n = [[1, 2], [3, 4]] * 2;                                      // nested scaling: [[2, 4], [6, 8]]
translate([90, 0, 0]) cube([n[1][0], n[1][1], n[0][1]]);       // 6 x 8 x 4
d = [1, 2, 3] * [1, 1, 1];                                     // dot product: 6
translate([100, 0, 0]) cube([d, 1, 1]);
h = min(5 / 0, 3);                                             // 5 / 0 is inf, not an error
translate([110, 0, 0]) cube(h);
k = -7 % 3;                                                    // fmod: -1 (Python's % says 2)
translate([120, 0, 0]) cube([k + 3, 1, 1]);
k2 = 7 % -3;                                                   // fmod: 1 (Python's % says -2)
translate([125, 0, 0]) cube([k2 + 1, 1, 1]);
short = [1, 2, 3] + [4, 4];                                    // different lengths: truncated to [5, 6]
translate([130, 0, 0]) cube([short[0], short[1], len(short)]);
