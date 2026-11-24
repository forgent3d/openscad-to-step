// str() formats numbers the OpenSCAD way, not Python's: str(i / 10) is "7", not "7.0" — a Write.scad
// ruler (144862) drew every number two glyphs too long. Six significant digits, trailing zeros dropped,
// exponent form below 1e-5 and from 1e6 on, unpadded exponent. Each label is Write.scad glyphs, so a
// wrong format shows up as the wrong number of glyphs — in the volume and in the bounding box.
use <write/Write.scad>

for (i = [10:10:70]) translate([i, 0, 0]) write(str(i / 10), h = 5, t = 1);
translate([0, 10, 0]) write(str(1 / 3, " ", -1.5, " ", 0.1 + 0.2), h = 5, t = 1);
translate([0, 20, 0]) write(str(1234567, " ", 5e-7, " ", 0.00001, " ", 100000), h = 5, t = 1);
translate([0, 30, 0]) write(str([1, 2.5], -0), h = 5, t = 1);
