// BOSL2 (built in) cuboid(): rounding on every edge (minkowski in BOSL2), on all but the bottom and on the top
// only (hulls of corner shapes), a chamfer. Exact: a box with the edges filleted (bosl2.ts exactCuboid),
// checked against OpenSCAD's facets of the same subtree before it is used (_exact_or).
include <BOSL2/std.scad>
cuboid([40, 30, 20], rounding = 3);
right(50) cuboid([40, 30, 20], rounding = 3, except = BOT);
right(100) cuboid([40, 30, 20], rounding = 2, edges = TOP);
right(150) cuboid([30, 30, 10], chamfer = 2);
