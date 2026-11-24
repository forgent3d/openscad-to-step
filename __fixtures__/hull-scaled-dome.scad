// thing 261118's lamp: a cone under a squashed dome. The cone's circles stay round when the squash
// is undone, so the pre-image is a solid of revolution — built exactly, stretched back.
hull() {
  cylinder(r1 = 11, r2 = 22, h = 30);
  scale([1, 1, 0.3]) sphere(r = 15);
}
