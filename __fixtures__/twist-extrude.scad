// linear_extrude(twist=) is built as OpenSCAD builds it: a polyhedron through the slice rings, two
// triangles per side quad — a twisted square and a twisted non-convex L. (A cap with a hole and a
// twist + scale are pinned in cad-engine's extrude tests: this openscad-wasm's CGAL refuses both.)
linear_extrude(height = 20, twist = 90, slices = 20) square(10, center = true);
translate([20, 0, 0]) linear_extrude(height = 12, twist = 60, slices = 10)
  polygon([[0, 0], [8, 0], [8, 3], [3, 3], [3, 8], [0, 8]]);
