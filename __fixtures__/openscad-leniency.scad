// OpenSCAD's scoping and calling rules that Python does not share — each failed real files' builds
PAD = 1;
x = half(20);                                     // a function used above its declaration
function half(v, extra = PAD) = v / 2 + extra;    // a default that is not a constant: read at call time
cube([x, 2, 2]);                                  // 11 x 2 x 2

module slab(t = T) translate([0, 5, 0]) cube([4, 4, t]);   // a module default sees an assignment below it
T = 3;
slab();

slots = 3;                                        // a variable, a module and a function, one name
module slots(n) for (i = [0 : n - 1]) translate([i * 3, 12, 0]) cube(2);
function slots(k) = k + 1;
slots(slots(slots));                              // four cubes

module plate(w) translate([0, 20, 0]) cube([w, w, 1]);
plate(5, 99, 100);                                // extra unnamed arguments are ignored
module bare() translate([10, 20, 0]) cube(2);
bare(7);                                          // … even by a module with no parameters

module ring(r) translate([0, 30, 0]) cylinder(r = r, h = 1);
ring(3, $fn = 360);                               // $fn on a call to a user module

module assembly() translate([0, 40, 0]) cube(2);  // model.py's own export name
assembly();

translate([0, 50, 0]) minkowski() { w = 6 - 2; cube([w, w, 1]); cylinder(r = 1, h = 1); }

module holder() { d = size(3); translate([0, 60, 0]) cube([d, d, d]); function size(k) = k * 2; }
holder();                                         // a module-local function used above its declaration

module tag() translate([0, 70, 0]) cube([w, 2, 2]);   // w is no parameter: a caller's `w =` binds inside
w = 3;
tag(w = 6);
translate([0, 5, 0]) tag();                           // … and the global w when nobody passes one
function scaled(v) = v * k;                           // the same for a function
k = 2;
translate([0, 80, 0]) cube([scaled(2, k = 3), 1, 1]);
translate([0, 85, 0]) cube([scaled(2), 1, 1]);
module sized(size) translate([0, 90, 0]) cube(size);
sized(size = 2, sizee = 3);                           // a misspelled parameter: warned, no effect
