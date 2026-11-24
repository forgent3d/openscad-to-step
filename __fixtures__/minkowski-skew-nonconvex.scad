// case 09: two non-convex solids, neither a prism along a shared direction. Each is split into
// convex prisms along its own direction; every pair is one polytope hull. Exact (manifold's
// mesh sum over the same polyhedra lands on the same volume).
minkowski() { rotate([20, 0, 0]) difference() { cube(20); translate([5, 5, 5]) cube(20); } rotate([0, 30, 0]) linear_extrude(2) polygon([[0,0],[3,0],[3,1],[1,1],[1,3],[0,3]]); }
