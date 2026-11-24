// corpus 3376352: a stadium plate chamfered by a double cone — the plate is the hull of two upright
// cylinders, each summed with the cone as a coaxial solid of revolution, and their hull is exact.
minkowski() {
  linear_extrude(3) hull() {
    translate([-15, 0]) circle(11);
    translate([15, 0]) circle(11);
  }
  union() {
    cylinder(r1 = 1, r2 = 0, h = 1);
    mirror([0, 0, 1]) cylinder(r1 = 1, r2 = 0, h = 1);
  }
}
