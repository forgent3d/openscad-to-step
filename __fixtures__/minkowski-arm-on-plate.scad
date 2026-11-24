// corpus 20753: a lying cylinder rounded by a thin disk (two curved convex bodies on different axes:
// the mesh route) fused onto the rounded plate it stands on — the sum's floor lies in the plate's.
union() {
  minkowski() {
    translate([0, 0, 5]) cube([15.4, 15.4, 20], center = true);
    cylinder(r = 5, h = 1);
  }
  minkowski() {
    rotate([0, 90, 0]) cylinder(h = 15, r = 5);
    cylinder(r = 2, h = 0.25);
  }
}
