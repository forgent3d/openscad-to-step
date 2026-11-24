// polygon(paths=): OpenSCAD fills every path even-odd — here a boundary and two holes
linear_extrude(4) polygon(
    points = [[0,0],[40,0],[40,25],[0,25], [6,6],[16,6],[16,16],[6,16], [24,10],[34,10],[34,20],[24,20]],
    paths = [[0,1,2,3], [4,5,6,7], [8,9,10,11]]
);
