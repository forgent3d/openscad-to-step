// cone and mirrored sphere
$fn = 48;
cylinder(h = 20, r1 = 12, r2 = 4);
translate([30, 0, 6]) sphere(d = 12);
mirror([1, 0, 0]) translate([30, 0, 6]) sphere(d = 12);
