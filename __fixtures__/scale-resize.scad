// scale and resize
scale(2) cube([5, 4, 3]);
translate([0, 20, 0]) scale([2, 1, 3]) cube([5, 4, 3]);
translate([0, 40, 0]) resize([20, 0, 0], auto = true) cube([5, 4, 3]);
// auto follows the axis with the LARGEST new size (OpenSCAD's maxdim), not the first one given
translate([40, 0, 0]) resize([0, 20, 40], auto = true) cube([10, 10, 10]);
translate([40, 60, 0]) resize([0, 40, 20], auto = true) cube([10, 10, 10]);
