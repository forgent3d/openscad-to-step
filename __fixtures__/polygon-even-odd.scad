// polygon(): every loop is filled even-odd (Clipper pftEvenOdd), not "first path = boundary, rest = holes"
// two paths side by side are two islands (the second used to be cut away)
linear_extrude(5) polygon(points = [[0,0],[10,0],[10,10],[0,10],[20,0],[30,0],[30,10],[20,10],[2,2],[8,2],[8,8],[2,8]],
    paths = [[0,1,2,3],[4,5,6,7],[8,9,10,11]]);
// a hole listed first, the outline clockwise
translate([40, 0, 0]) linear_extrude(2) polygon(points = [[2,2],[8,2],[8,8],[2,8],[0,0],[0,10],[10,10],[10,0]], paths = [[0,1,2,3],[4,5,6,7]]);
// square, hole, island in the hole
translate([0, 20, 0]) linear_extrude(2) polygon(points = [[0,0],[20,0],[20,20],[0,20],[4,4],[16,4],[16,16],[4,16],[8,8],[12,8],[12,12],[8,12]],
    paths = [[0,1,2,3],[4,5,6,7],[8,9,10,11]]);
