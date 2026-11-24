// writecube() on all six faces of a box, after the author's TestWriteCube.scad: each face is a
// different translate/rotate chain into write(), plus up/down/left/right/rotate on the face. Half
// of each letter sits inside the box (t is centred on the face), so this is a union with the box;
// the engraved label on the side is a difference.
use <write/Write.scad>

difference() {
  union() {
    translate([30, 30, 30]) cube([10, 15, 30], center = true);
    writecube("front", [30, 30, 30], [10, 15, 30], h = 3, rotate = -90);
    writecube("back", [30, 30, 30], size = [10, 15, 30], h = 3, face = "back", rotate = 90, t = 2);
    writecube("left", [30, 30, 30], [10, 15, 30], h = 3, face = "left", up = 5);
    writecube("top", where = [30, 30, 30], size = [10, 15, 30], h = 3, face = "top", rotate = 90);
    writecube("btm", where = [30, 30, 30], size = [10, 15, 30], h = 3, face = "bottom", left = 1);
  }
  writecube("R", [30, 30, 30], [10, 15, 30], h = 6, face = "right", t = 2, down = 4, rotate = 30);
}
