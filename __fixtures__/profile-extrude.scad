// extruded L profile
$fn = 32;
linear_extrude(height = 12, center = true)
  polygon(points = [[0,0], [40,0], [40,8], [8,8], [8,30], [0,30]]);
translate([20, 20, 0]) linear_extrude(height = 5) square([10, 6], center = true);
