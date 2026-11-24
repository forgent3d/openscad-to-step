// list comprehensions feeding polygon(), multi-variable for, let, intersection_for
n = 8;
star = [for (i = [0 : 2 * n - 1]) let(a = i * 180 / n, r = (i % 2 == 0) ? 20 : 9) [r * cos(a), r * sin(a)]];
linear_extrude(4) polygon(star);
for (i = [0 : 2], j = [0 : 1]) translate([i * 8, 30 + j * 8, 0]) cube(5);
let (w = 6, h = w * 2) translate([-30, 0, 0]) cube([w, w, h]);
translate([-30, 30, 0]) intersection_for (k = [0 : 2]) rotate([0, 0, k * 30]) cube([20, 8, 6], center = true);
