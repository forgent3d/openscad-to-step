// offset() grows its children as one region: two squares 1 mm apart, grown 2 mm, run into each other and are one
// outline. build123d's offset grows each face on its own; unfused, the two grown faces overlapped and their extrude
// was two solids over the same space — as Thingiverse 745296's letters grown into each other, 36% short after the union
$fn = 64;
linear_extrude(height = 5) offset(r = 2) {
    square(10);
    translate([11, 0]) square(10);
}
