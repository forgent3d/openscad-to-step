// a D-shaped boss — a cylinder CUT in half — hulled with a block (things 2727786, 1006380): its
// rims are half circles whose ends are vertices, planned as arc features.
$fn = 96;
hull() {
  difference() {
    cylinder(r = 5, h = 4);
    translate([-10, -10, -1]) cube([20, 10, 6]);
  }
  translate([-1, 11, 9]) cube(2);
}
