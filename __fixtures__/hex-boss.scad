// hex boss on a plate
plate = 24;
difference() {
  union() {
    cube([plate, plate, 4], center = true);
    translate([0, 0, 2]) cylinder(h = 6, r = 8, $fn = 6);
  }
  cylinder(h = 40, d = 5, center = true, $fn = 48);
}
