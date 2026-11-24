// case 10: a slab and a tipped cylinder — oblique cones from the slab corners to the rims.
hull() { cube([10, 10, 2]); translate([5, 5, 15]) rotate([30, 0, 0]) cylinder(r = 4, h = 2); }
