// BOSL2 prismoid(rounding=) is the hull of two rounded rectangles: a ruled loft between them (planes + ruled
// corners); rect_tube() with straight walls is an extrusion with true cylinder corners; spheroid() is a sphere.
include <BOSL2/std.scad>
prismoid([40, 40], [20, 20], h = 20, rounding = 3);
right(60) rect_tube(size = 40, wall = 3, h = 20, rounding = 5);
right(110) spheroid(r = 10);
