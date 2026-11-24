// OpenSCAD builds NOTHING for a size <= 0 or one that is not finite, and renders the rest: every bad
// part below is empty there, so only the good row counts. The sizes come in as module parameters, so
// they are decided at RUN time (the _box / _cyl / … guards); the literals at the end at transpile time.
module parts(w, r, h, s) {
  cube([w, 4, 2]);
  translate([10, 0, 0]) cylinder(r = r, h = h);
  translate([20, 0, 0]) cylinder(r1 = r, r2 = 0, h = h);   // one zero radius is a cone, not empty
  translate([30, 0, 0]) sphere(r);
  translate([40, 0, 0]) scale([1, 1, s]) cube(3);           // a 0 factor flattens a solid to nothing
  translate([50, 0, 0]) linear_extrude(2) circle(r);
  translate([60, 0, 0]) linear_extrude(2) square([w, 3]);
  translate([70, 0, 0]) cylinder(r = r, h = h, $fn = 6);
}
parts(0, 0, 0, 0);
translate([0, 20, 0]) parts(-1, -2, -3, 0);
translate([0, 40, 0]) parts(1 / 0, 1 / 0, 1 / 0, 1);       // only the scaled cube is real here
translate([0, 60, 0]) parts(3, 2, 4, 1);                   // the real ones
cube([0, 42, 1.6]);
cylinder(r1 = 0, r2 = 0, h = 5);
translate([0, -20, 0]) linear_extrude(1) scale([1, 1, 0]) square(4);   // a 2D profile ignores z = 0
translate([10, -20, 0]) linear_extrude(1) scale([0, 1]) square(4);     // … but not x = 0
