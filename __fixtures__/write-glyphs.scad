// Write.scad (Thingiverse Customizer's lettering library, built in): every glyph of its default
// font, after the author's own TestWrite.scad. Each glyph is OpenSCAD's DXF import of Letters.dxf,
// which the engine reproduces exactly (cad-engine b123d/fonts, checked glyph by glyph) — so unlike
// text(), this is text the volume diff CAN verify. center=, t=, h= all reach write() as named
// arguments it does not declare, which OpenSCAD binds as locals.
use <write/Write.scad>

translate([0, 30, 0]) write("abcdefghijklmn", t = 10.5, h = 10, center = true);
translate([0, 15, 0]) write("opqrstuvwxyz", t = 9, h = 9, center = true);
write("~!@#$%^&*()_-+=", t = 7.5, h = 8, center = true);
translate([0, -15, 0]) write(",./<>?;'`:[]{}|", t = 6, h = 7, center = true);
translate([0, -30, 0]) write("ABCDEFGHIJKLMN", t = 4.5, h = 6, center = true);
translate([0, -45, 0]) write("OPQRSTUVWXYZ", t = 3, h = 5, center = true);
translate([0, -60, 0]) write("0123456789 \"", t = 1.5, h = 4);
