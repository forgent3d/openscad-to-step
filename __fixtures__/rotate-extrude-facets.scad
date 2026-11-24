// rotate_extrude($fn 3..12) is OpenSCAD's facets, on purpose — a hexagonal ring, not a torus (it was 21% over)
rotate_extrude($fn = 6) translate([10, 0]) circle(r = 2);
// a profile touching the axis: a pentagonal cone
translate([40, 0, 0]) rotate_extrude($fn = 5) polygon([[0, 0], [10, 0], [10, 5], [0, 8]]);
// a partial sweep of a profile with a hole, and one swept the other way
translate([0, 40, 0]) rotate_extrude(angle = 100, $fn = 8) translate([5, 0]) difference() { square([6, 4]); translate([2, 1]) square([2, 2]); }
translate([40, 40, 0]) rotate_extrude(angle = -150, $fn = 7) translate([5, 0]) square([3, 3]);
// a profile on the -x side
translate([0, 80, 0]) rotate_extrude($fn = 5) translate([-12, 0]) square([4, 3]);
