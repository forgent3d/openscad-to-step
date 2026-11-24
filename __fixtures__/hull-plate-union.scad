// hull of two rounded plates built the corpus's way — crossed slabs plus four corner cylinders,
// UNIONED (things 4813293, 813330, 1828460 …): each rim survives only as a quarter arc, the rest
// runs through the slabs. The whole circles lie in the child, so they are the hull's features.
$fn = 96;
module plate() {
  union() {
    translate([0, 3, 0]) cube([30, 14, 4]);
    translate([3, 0, 0]) cube([24, 20, 4]);
    for (x = [3, 27], y = [3, 17]) translate([x, y, 0]) cylinder(r = 3, h = 4);
  }
}
hull() {
  plate();
  translate([0, 0, 10]) plate();
}
