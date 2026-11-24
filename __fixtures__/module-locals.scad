// module-scope assignments are locals, evaluated from the parameters
size = 50;
module logo(size = 50, $fn = 100) {
    hole = size / 2;
    cylinderHeight = size * 1.25;
    difference() {
        sphere(d = size);
        cylinder(d = hole, h = cylinderHeight, center = true);
        #rotate([90, 0, 0]) cylinder(d = hole, h = cylinderHeight, center = true);
        rotate([0, 90, 0]) cylinder(d = hole, h = cylinderHeight, center = true);
    }
}
logo(size);
