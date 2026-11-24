// cube with a through hole
$fn = 48;
w = 30; d = 20; h = 10; bore = 8;
difference() {
  cube([w, d, h]);
  translate([w/2, d/2, -1]) cylinder(h = h + 2, d = bore);
}
