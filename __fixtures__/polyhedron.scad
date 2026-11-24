// polyhedron: a square pyramid plus a wedge, sewn from face lists
polyhedron(
    points = [[0, 0, 0], [16, 0, 0], [16, 16, 0], [0, 16, 0], [8, 8, 12]],
    faces = [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]]
);
translate([30, 0, 0]) polyhedron(
    points = [[0, 0, 0], [10, 0, 0], [10, 8, 0], [0, 8, 0], [0, 0, 6], [10, 0, 6]],
    faces = [[0, 3, 2, 1], [0, 1, 5, 4], [1, 2, 5], [2, 3, 4, 5], [3, 0, 4]]
);
