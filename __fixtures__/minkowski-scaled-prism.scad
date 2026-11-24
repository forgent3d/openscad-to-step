// corpus 1447730 / 932409: a non-uniform scale() leaves every plane a flat B-spline — still a prism,
// still summed as 2D sections extruded, not tessellated.
minkowski() {
  scale([1, 1, 2]) union() {
    cube([7, 5, 4]);
    translate([3.5, 6.5, 0]) cylinder(d = 5, h = 4);
    translate([-2.5, 0, 0]) cube([5, 5, 4]);
  }
  cylinder(d = 0.5, h = 1);
}
