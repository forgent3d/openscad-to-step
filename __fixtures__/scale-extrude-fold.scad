// scale([s, s, sz]) over translate() linear_extrude() is folded into a uniform 2D scale and a taller
// extrude, so the prism keeps its planes (a per-axis scale of a finished solid turns every one into a
// BSpline). Fast path: positive factors, the same x and y expression. Everything else must come out
// exactly as the unfolded chain: a negative factor mirrors, a zero removes the part (OpenSCAD's empty),
// unequal x/y and a twisted extrude are not folded at all.
k = 1.5;
t = 3;
scale([k, k, t]) translate([4, 2, 1]) linear_extrude(height = 2, center = true) square([3, 2]);
translate([20, 0, 0]) scale([k, k, t]) { translate([1, 0, 0]) translate([0, 1, 0]) linear_extrude(2) circle(2); }
m = -1;
translate([40, 0, 0]) scale([m, m, 2]) linear_extrude(3) polygon([[0, 0], [4, 0], [0, 3]]);
z = 0;
translate([60, 0, 0]) scale([2, 2, z]) linear_extrude(3) square(2);
translate([80, 0, 0]) scale([2, 1, 1.5]) linear_extrude(2) circle(3);
translate([100, 0, 0]) scale([k, k, 1]) linear_extrude(4, twist = 90, slices = 8) square(3, center = true);
