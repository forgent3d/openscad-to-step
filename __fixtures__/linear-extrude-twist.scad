// linear_extrude(twist=): no exact BREP form — built from the same flat slices OpenSCAD uses
linear_extrude(height = 30, twist = 90, slices = 30) square([16, 10], center = true);
