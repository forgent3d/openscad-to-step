// scad-hull-minkowski.md case 01: the rounded-corner plate. Both children are prisms along Z,
// so the sum is the 2D sum of the sections extruded: 6 planes + 4 true r=3 cylinders.
minkowski() { cube([30, 20, 4]); cylinder(r = 3, h = 1); }
