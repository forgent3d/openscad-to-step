// A kernel nowhere near the origin, on the mesh route (a ring and a tipped cube share no exact
// construction): the sum moves with the kernel. manifold's own sum kept the untranslated ring in the
// result. ($fn keeps OpenSCAD's own decomposition of the ring quick.)
minkowski() {
  rotate_extrude($fn = 48) translate([6, 0]) square([2, 3]);
  translate([50, 0, 0]) rotate([25, 10, 0]) cube(3);
}
