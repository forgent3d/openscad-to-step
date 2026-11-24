// a cylinder lying along X beside a block of the same length (thing 3143289): the prism tier on
// its side, where the Gauss plan lost a ruling.
$fn = 96;
hull() {
  translate([8, 9.1, 2.1]) rotate([0, 90, 0]) cylinder(r = 1, h = 5);
  translate([8, 3.1, -1]) cube([5, 1, 4.1]);
}
