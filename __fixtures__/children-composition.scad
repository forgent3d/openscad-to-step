// module composition: children(), children(i), $children, empty children, if without else
module lift(h) { translate([0, 0, h]) children(); }
module ring_of(n, r) {
    for (i = [0 : n - 1]) rotate([0, 0, i * 360 / n]) translate([r, 0, 0]) children();
}
module bracket(w = 30) {
    difference() {
        cube([w, 20, 8]);
        if (w > 20) translate([w / 2, 10, -1]) cylinder(r = 3, h = 10, $fn = 24);
        children();
    }
    if ($children == 0) translate([0, 0, 8]) cube([5, 5, 5]);
}
lift(5) cube(10);
translate([40, 0, 0]) ring_of(4, 12) cylinder(r = 3, h = 6, $fn = 24);
translate([0, 40, 0]) bracket(30) translate([5, 10, -1]) cylinder(r = 2, h = 10, $fn = 24);
translate([0, 80, 0]) bracket(30);
translate([50, 80, 0]) bracket(15);
