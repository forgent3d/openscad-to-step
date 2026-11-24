// linear_extrude(scale=) of a profile with a hole, and of two islands: every loop is lofted on its own
// (a loft takes a section's outer wire only; the washer used to come out as a solid frustum, 24% over)
linear_extrude(height = 10, scale = 0.5) difference() { square(20, center = true); circle(5); }
translate([40, 0, 0]) linear_extrude(height = 8, scale = [0.5, 1.5]) { translate([-8, 0]) square(6, center = true); translate([8, 0]) square(6, center = true); }
