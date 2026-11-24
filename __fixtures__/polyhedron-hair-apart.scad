// points written twice a hair apart are one point (one object per fixture, as polyhedron-touching.scad):
// a cube whose top corners 5 and 6 are written again 1e-14 off (8, 9) — the same point computed two ways, as
// slice() in Thingiverse 1011192 writes them — one top triangle on the copies and a zero-area face across each
// seam. Closed as written; sewn without welding, the zero-area faces make no valid solid. 1000 mm^3
t = 10 + 1e-14;
polyhedron(
    points = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
              [t, 0, 10], [t, 10, 10]],
    faces = [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 6, 7],
             [4, 8, 9], [8, 4, 5], [4, 9, 6], [9, 8, 5], [5, 6, 9]]
);
