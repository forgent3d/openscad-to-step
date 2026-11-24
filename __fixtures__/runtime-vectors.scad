// arguments whose scalar-vs-vector shape is only known at runtime, plus builtins with OpenSCAD semantics
function dim(p) = p == "w" ? 12 : 7;
module dim(h) { cube([dim("w"), dim("w"), h]); }
for (a = [[0, 0, 0], [10, 20, 30], [0, 90, 45]]) rotate(a) cube(dim("t"), center = true);
translate([30, 0, 0]) dim(5);
translate([0, 30, 0]) render() cube([round(2.5) * 2, lookup(5, [[0, 2], [10, 12]]), sign(-3) + 4]);
s = [4, 6];
translate([30, 30, 0]) linear_extrude(3) square(s);
