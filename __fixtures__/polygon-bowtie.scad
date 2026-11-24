// a self-crossing outline is filled even-odd: a bow tie is its two triangles (it used to build as a
// zero-volume sheet hanging below z = 0). Alone in its file: OpenSCAD's CGAL render (the oracle) DROPS a
// self-crossing polygon once it is unioned with anything else — its Manifold render keeps it.
linear_extrude(2) polygon([[0,0],[10,10],[10,0],[0,10]]);
