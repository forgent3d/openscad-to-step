// assignments inside a nested scope are block-local, evaluated before the block's statements
wall = 3;
translate([0, 0, 0]) {
    w = wall * 2;
    cube([w, w, wall]);
    h = w + wall;
    translate([0, 0, wall]) cube([wall, wall, h]);
}
module frame() {
    $fn = 6;
    difference() {
        cylinder(r = 10, h = 5);
        cylinder(r = 6, h = 5);
    }
}
translate([30, 0, 0]) frame();
