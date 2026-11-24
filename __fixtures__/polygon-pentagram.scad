// a pentagram is filled even-odd: the centre is hollow (splitting it at the crossings and filling by nesting
// would fill it). Alone in its file for the same CGAL reason as polygon-bowtie.scad.
linear_extrude(2) polygon([for (i = [0:4]) 10 * [cos(90 + i * 144), sin(90 + i * 144)]]);
