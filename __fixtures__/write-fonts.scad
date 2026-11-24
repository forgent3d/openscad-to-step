// Write.scad's other four fonts, spelled the ways Thingiverse files spell them (a Customizer
// choice is usually "write/<font>.dxf"; some drop the folder or change the case). orbitron and
// knewave glyphs overlap their neighbours at space < 1, BlackRose `$ & 4 B I N R X q` start with an
// overshoot (a bow-tie: both lobes filled), braille `'` is a dot traced twice (even-odd: nothing).
use <write/Write.scad>

font = "write/orbitron.dxf"; // [write/Letters.dxf:Basic, write/orbitron.dxf:Futuristic, write/BlackRose.dxf:Fancy]
write("Orbitron 2026", t = 2, h = 8, font = font);
translate([0, 12, 0]) write("Knewave!", t = 2, h = 8, font = "knewave.dxf", space = 0.9);
translate([0, 24, 0]) write("$&4BINRXq", t = 2, h = 8, font = "write/BlackRose.dxf", rotate = 10);
translate([0, 40, 0]) write("braille;'", t = 2, h = 8, font = "write/braille.dxf", center = true);
translate([0, 52, 0]) write("letters", t = 1, h = 6, font = "write/letters.dxf", space = 1.3);
