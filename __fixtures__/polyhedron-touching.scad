// a polyhedron that does not sew into one solid as written, built the way OpenSCAD repairs a mesh
// (one object per fixture: OpenSCAD's CGAL render refuses to union a non-manifold mesh with anything)
// two cubes meeting at one corner, each written with its own points: welded, they share that vertex
// and nothing else — two closed pieces, 2 x 1000 mm^3
polyhedron(
    points = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
              [10, 10, 10], [20, 10, 10], [20, 20, 10], [10, 20, 10], [10, 10, 20], [20, 10, 20], [20, 20, 20], [10, 20, 20]],
    faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
             [8, 11, 10, 9], [12, 13, 14, 15], [8, 9, 13, 12], [9, 10, 14, 13], [10, 11, 15, 14], [11, 8, 12, 15]]
);
