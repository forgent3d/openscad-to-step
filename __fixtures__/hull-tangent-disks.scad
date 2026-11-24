// two thin disks whose rims touch in plan at x = 60 (thing 3061872, a funnel): one tangential
// corner, every bridge a loop from it back to it.
$fn = 96;
hull() {
  cylinder(r = 60, h = 0.001);
  translate([40, 0, 56]) cylinder(r = 20, h = 0.001);
}
