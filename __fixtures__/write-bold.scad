// write(bold=…) is a minkowski() of the lettering with a flat cube([bold*.1*h, bold*.1*h, 1e-5]);
// bold = 0 (the default) makes that cube empty, which OpenSCAD's minkowski drops.
use <write/Write.scad>

write("Ab", t = 2, h = 10, bold = 1);
translate([0, 15, 0]) write("Ab", t = 2, h = 10, bold = 0);
