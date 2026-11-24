// case 03: the rounded-top box — corner cylinders + corner balls. Exact: 6 planes, 8 cylinders,
// 4 sphere patches.
hull() for (x = [3, 27], y = [3, 17]) { translate([x, y, 0]) cylinder(r = 3, h = 7); translate([x, y, 7]) sphere(3); }
