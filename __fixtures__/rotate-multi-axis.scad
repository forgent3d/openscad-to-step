// multi-axis rotate is extrinsic (Rz*Ry*Rx), not build123d's intrinsic Rot(x,y,z)
rotate([35, 90, 0]) cube([10, 20, 30]);
translate([40, 0, 0]) rotate([45, 45, 0]) cylinder(h = 20, r = 5, $fn = 30);
translate([0, 50, 0]) rotate([0, -48, 90]) cube([5, 10, 15]);
translate([-40, 0, 0]) rotate([90, 0, 0]) rotate([0, 0, 30]) cylinder(h = 12, r = 4);
