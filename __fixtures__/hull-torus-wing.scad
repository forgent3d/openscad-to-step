// thing 70494's wing nut: rcyl() is the hull of two coaxial tori (a rounded cylinder), and a wing
// is the hull of two of those side by side — offset(hull(cores), r), every round a real torus.
// (70494's own posts differ in height; that core has a fitted bridge face, whose offset OCCT only
// approximates, so hull() leaves it to the point tier.)
module torus(r, rnd) rotate_extrude() translate([r - rnd / 2, 0, 0]) circle(d = rnd);
module rcyl(r, h, rnd) hull() { torus(r, rnd); translate([0, 0, h - rnd]) torus(r, rnd); }
hull() {
  rcyl(4, 7, 2);
  translate([18, 0, 0]) rcyl(2.5, 7, 2);
}
