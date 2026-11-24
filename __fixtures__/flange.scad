// flange with six bolt holes
$fn = 64;
od = 40; id = 24; thk = 8; bolt_d = 4.2; bolt_circle = 32;
module flange(outer, inner, t) {
  difference() {
    cylinder(h = t, d = outer);
    translate([0, 0, -1]) cylinder(h = t + 2, d = inner);
    for (i = [0 : 5])
      rotate([0, 0, i * 60])
        translate([bolt_circle / 2, 0, -1])
          cylinder(h = t + 2, d = bolt_d);
  }
}
flange(od, id, thk);
