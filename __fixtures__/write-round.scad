// The curved writers: writecylinder() around the side (with rotate/east) and on the top face
// (writecircle, cw and ccw, middle=), and writesphere(). Each letter is its own write() call,
// placed by angles the library computes from h, space and the radius. The cylinder and sphere the
// text wraps are left out: they only slow the oracle down and say nothing about the placement.
use <write/Write.scad>

writecylinder("CYLINDER", [0, 0, 0], 20, 40, h = 6, t = 2, center = true);
writecylinder("rotate", [0, 0, 0], 20, 40, h = 4, t = 2, center = true, rotate = 30, east = 120);
writecylinder("top ring", [0, 0, 0], 20, 40, h = 4, t = 2, center = true, face = "top");
writecylinder("ccw", [0, 0, 0], 20, 40, h = 4, t = 2, center = true, face = "top", ccw = true, middle = 6);
translate([0, 60, 0]) writesphere("SPHERE", [0, 0, 0], 15, h = 5, t = 2);
