// thing 1007491's key tag: an elliptic eye (a cylinder squashed by scale) hulled with a straight
// tag. The eye's faces are B-splines; hull() undoes the squash, hulls exactly, and stretches back.
hull() {
  scale([1, 0.6, 1]) cylinder(r = 10, h = 2);
  translate([-45, -120, 0]) cube([90, 20, 2]);
}
