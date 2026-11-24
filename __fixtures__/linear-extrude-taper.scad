// linear_extrude(scale=) is a ruled loft between two similar sections — exact
linear_extrude(height = 20, scale = 0.4) square([16, 10], center = true);
translate([40, 0, 0]) linear_extrude(height = 18, scale = [0.5, 1.5]) square([12, 8], center = true);
translate([-40, 0, 0]) linear_extrude(height = 20, scale = 0) square([16, 12], center = true);
