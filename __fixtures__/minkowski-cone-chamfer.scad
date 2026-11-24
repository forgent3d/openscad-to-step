// corpus 1485673: a cone rounding off a cylinder's rim — two solids of revolution on one axis sum as
// the revolution of their meridian sections (planes, a cylinder and a cone; the mesh route took 27 s).
minkowski() {
  cylinder(r = 24.5, h = 7);
  cylinder(r1 = 1.5, r2 = 0, h = 1.5);
}
