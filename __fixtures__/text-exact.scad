// Exact text: OpenSCAD's own layout and outlines
linear_extrude(height = 2) text("Hello Ob®", size = 10);
translate([0, -20, 0]) linear_extrude(height = 3) text("Écrit 8%", size = 7, font = "Liberation Serif:style=Bold", halign = "center", spacing = 1.2);
difference() {
  translate([-5, -40, 0]) cube([80, 14, 2]);
  translate([0, -37, 1]) linear_extrude(height = 2) text("gjpq", size = 8, font = "Liberation Mono");
}
