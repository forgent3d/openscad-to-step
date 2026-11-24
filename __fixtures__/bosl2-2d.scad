// BOSL2 2D: rect(rounding=), round_corners(), offset(r=) and a circle written as points — polygons whose
// co-circular runs are exact arcs here (arcs.ts), then extruded: true cylinder faces.
include <BOSL2/std.scad>
linear_extrude(5) rect([30, 20], rounding = 3);
right(40) linear_extrude(5) polygon(round_corners(square(20), radius = 4));
right(70) linear_extrude(5) polygon(offset(hexagon(r = 8), r = 2));
right(100) linear_extrude(5) polygon([for (a = [0 : 10 : 359]) 8 * [cos(a), sin(a)]]);
