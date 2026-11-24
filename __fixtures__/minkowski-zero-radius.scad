// corpus 4629984: `cylinder(r = 0)` renders as nothing in OpenSCAD, and an empty child drops out of a
// minkowski — the cube stands (the mesh route died on "fewer than 4 triangles").
minkowski() {
  cube([52, 72, 40], center = true);
  cylinder(r = 0, h = 0.01);
}
