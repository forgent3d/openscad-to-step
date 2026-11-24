// rands() with a seed is OpenSCAD's own sequence, bit for bit: every value below becomes a size
cube(rands(1, 10, 3, 42));
translate([20, 0, 0]) cube(rands(2, 5, 3, 42.9));          // a fractional seed is hashed, not truncated
translate([40, 0, 0]) cube(rands(8, 3, 3, -1));            // min > max swaps; a negative seed wraps
translate([60, 0, 0]) cube(rands(1, 4, 3));                // unseeded: continues the seed -1 stream
for (i = [0 : 4]) translate([80 + i * 10, 0, 0]) cube([1, 1, rands(1, 9, 1, i)[0]]);
