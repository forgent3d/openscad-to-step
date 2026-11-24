// hull of two thin disks, the small one overhanging the big one far above it — OpenSCAD's way to
// loft between two circles (thing 54029, a pump splitter). Its vertical tangent planes each touch
// four circles, with the bridges crossing the equator at a shallow angle.
$fn = 96;
hull() {
  cylinder(r = 9.5, h = 0.01);
  translate([0, 6.5, 25]) cylinder(r = 4, h = 0.01);
}
