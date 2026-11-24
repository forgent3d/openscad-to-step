// corpus 3031235 (a nut's string slots): a resize()d square ⊕ a cylinder, tipped and cut from a block.
// Its sides are straight B-splines; extruded as they came, the slot cut nothing from the block.
difference() {
  cube([30, 30, 10]);
  translate([15, 5, 5]) rotate([10, 0, 0]) minkowski() {
    cylinder(d = 1, h = 4.8, center = true);
    resize([10, 20]) rotate([0, 0, 45]) cube([10, 10, 4.8]);
  }
}
