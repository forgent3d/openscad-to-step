// BOSL2 attachments: diff() / attach() / tags, a gear with a bore (its teeth stay OpenSCAD's facets, said in a
// warning; the bore is a true circle).
include <BOSL2/std.scad>
include <BOSL2/gears.scad>
diff() cuboid([40, 30, 10], rounding = 2, edges = "Z") {
  attach(TOP) cyl(d = 8, h = 12, anchor = CENTER, $tags = "remove");
  attach(BOT, TOP) cyl(d = 20, h = 5, rounding2 = -1);
}
right(60) spur_gear(mod = 2, teeth = 20, thickness = 5, shaft_diam = 5);
