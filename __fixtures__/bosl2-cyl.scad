// BOSL2 cyl(): roundings and chamfers are a rotate_sweep VNF in BOSL2, revolved here from BOSL2's own profile at
// scale 1 (bosl2.ts exactCyl); a small plain cyl() is cylinder($fn = segs(r)) — an octagon at r = 2.5 — read as the
// circle the author asked for; circum = true is the nominal radius.
include <BOSL2/std.scad>
cyl(h = 20, d = 20, rounding = 2);
right(30) cyl(h = 20, d1 = 24, d2 = 12, chamfer1 = 2, rounding2 = 3);
right(60) cyl(h = 10, d = 5);
right(80) cyl(h = 10, d = 8, circum = true);
right(100) cyl(h = 20, d = 20, rounding1 = 3, rounding2 = -2);
