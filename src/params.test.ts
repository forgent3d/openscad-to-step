// Customizer parameters: read OpenSCAD's param export, write a new value back into the .scad (replace only the literal). Run from packages/cloud:
//   node_modules/.bin/tsx --test src/params.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatScadValue, literalValue, readParameters, setParameter, topLevelAssignments } from "./params";

// what OpenSCAD's parameter export holds for a Customizer file (groups, ranges, dropdowns, captions)
const EXPORT = {
  parameters: [
    { caption: "outer width of the box", group: "Size", initial: 40, max: 100, min: 10, name: "width", step: 1, type: "number" },
    { group: "Size", initial: 2, max: 5, min: 0.8, name: "wall", step: 0.2, type: "number" },
    { group: "Options", initial: "snap", name: "lid", options: [{ name: "snap", value: "snap" }, { name: "none", value: "none" }], type: "string" },
    { group: "Options", initial: true, name: "rounded", type: "boolean" },
    { group: "Options", initial: [1, 2, 3], name: "offsets", type: "number" },
  ],
  title: "box",
};

test("readParameters takes OpenSCAD's export as it is; anything unreadable is no parameters", () => {
  const params = readParameters(EXPORT);
  assert.deepEqual(params.map((p) => p.name), ["width", "wall", "lid", "rounded", "offsets"]);
  assert.equal(params[0]!.caption, "outer width of the box");
  assert.deepEqual(params[4]!.initial, [1, 2, 3]);
  assert.deepEqual(readParameters(null), []);
  assert.deepEqual(readParameters("not an export"), []);
  assert.deepEqual(readParameters({ parameters: [{ name: 3 }] }), []);
});

test("a plain number's step: 1 (OpenSCAD 2026 exports it whether or not one was written) leaves the box free; a written step stays", () => {
  const params = readParameters({
    parameters: [
      { group: "Parameters", initial: 3.5, name: "plain", step: 1, type: "number" },
      { group: "Parameters", initial: 2.4, name: "spin", step: 0.2, type: "number" },
      { group: "Parameters", initial: 10, max: 50, min: 5, name: "slider", step: 1, type: "number" },
    ],
  });
  assert.equal(params[0]!.step, undefined);
  assert.equal(params[1]!.step, 0.2);
  assert.equal(params[2]!.step, 1);
});

const SOURCE = `// Parametric box
include <MCAD/units.scad>
/* [Size] */
// outer width of the box
width = 40; // [10:1:100]
wall = 2.0;   // [0.8:0.2:5]
/* [Options] */
lid = "snap"; // [snap, none]
rounded = true;
offsets = [1, 2, 3];
label = "a; b = \\"c\\"";
module box(width = 3) {
  wall = 9;
  cube([width, wall, 10]);
}
box();
`;

test("only the value's text changes: the Customizer comment and every other byte stay", () => {
  const out = setParameter(SOURCE, "width", 55);
  assert.ok(out.ok);
  assert.equal(out.source, SOURCE.replace("width = 40; // [10:1:100]", "width = 55; // [10:1:100]"));
  const lid = setParameter(SOURCE, "lid", "none");
  assert.ok(lid.ok && lid.source.includes('lid = "none"; // [snap, none]'));
  const flag = setParameter(SOURCE, "rounded", false);
  assert.ok(flag.ok && flag.source.includes("rounded = false;"));
  const vector = setParameter(SOURCE, "offsets", [1, 2.5, 3]);
  assert.ok(vector.ok && vector.source.includes("offsets = [1, 2.5, 3];"));
});

test("a step keeps its decimals, strings are escaped as OpenSCAD reads them", () => {
  const out = setParameter(SOURCE, "wall", 0.8 + 0.2 * 8, 0.2);
  assert.ok("source" in out && out.source.includes("wall = 2.4;   // [0.8:0.2:5]"), JSON.stringify(out));
  assert.equal(formatScadValue('say "hi" \\ now'), '"say \\"hi\\" \\\\ now"');
  assert.equal(formatScadValue(-0), "0");
  assert.equal(formatScadValue(Number.NaN), null);
});

test("module bodies, strings with ; and =, and include lines do not confuse the scanner", () => {
  const names = topLevelAssignments(SOURCE).map((a) => a.name);
  assert.deepEqual(names, ["width", "wall", "lid", "rounded", "offsets", "label"]);
  const label = setParameter(SOURCE, "label", "x");
  assert.ok(label.ok && label.source.includes('label = "x";\nmodule box'));
  // the module's own `wall = 9` and its parameter default are untouched
  const wall = setParameter(SOURCE, "wall", 3, 0.2);
  assert.ok(wall.ok && wall.source.includes("  wall = 9;") && wall.source.includes("module box(width = 3)"));
});

test("the LAST top-level assignment is the one OpenSCAD uses, so it is the one rewritten; a missing one says so", () => {
  const twice = "h = 1;\ncube(h);\nh = 2; // wins\n";
  const out = setParameter(twice, "h", 5);
  assert.ok(out.ok);
  assert.equal(out.source, "h = 1;\ncube(h);\nh = 5; // wins\n");
  const missing = setParameter(twice, "nope", 1);
  assert.equal(missing.ok, false);
});

test("never a guess: the text replaced must be the plain value the knob was built from", () => {
  // what was built: the knob reads width = 40
  const ok = setParameter(SOURCE, "width", 55, 1, 40);
  assert.ok(ok.ok && ok.source.includes("width = 55; // [10:1:100]"));
  // the author typed over it without building: the knob would overwrite what they just wrote
  const edited = setParameter(SOURCE.replace("width = 40;", "width = 42;"), "width", 55, 1, 40);
  assert.ok("error" in edited && /changed in the source since the last build/.test(edited.error), JSON.stringify(edited));
  // a deleted ";" runs the span into the next line: never rewritten, with or without the built value
  const runOn = SOURCE.replace("width = 40; // [10:1:100]", "width = 40 // [10:1:100]");
  for (const expected of [40, undefined]) {
    const out = setParameter(runOn, "width", 55, 1, expected);
    assert.ok("error" in out && /not a plain value/.test(out.error), JSON.stringify(out));
  }
  // an expression is not a parameter OpenSCAD made: left to the author
  assert.equal(setParameter("h = 2 * 3;\n", "h", 5).ok, false);
  // every kind of value the Customizer has, matched
  assert.ok(setParameter(SOURCE, "wall", 3, 0.2, 2).ok);
  assert.ok(setParameter(SOURCE, "lid", "none", undefined, "snap").ok);
  assert.ok(setParameter(SOURCE, "rounded", false, undefined, true).ok);
  assert.ok(setParameter(SOURCE, "offsets", [4, 5, 6], undefined, [1, 2, 3]).ok);
  assert.ok(setParameter(SOURCE, "label", "x", undefined, 'a; b = "c"').ok);
  assert.equal(setParameter(SOURCE, "offsets", [4, 5, 6], undefined, [1, 2]).ok, false);
});

test("literalValue reads what OpenSCAD makes a parameter of, and nothing else", () => {
  assert.equal(literalValue(" -1.5e2 "), -150);
  assert.equal(literalValue(".5"), 0.5);
  assert.equal(literalValue("true"), true);
  assert.equal(literalValue('"say \\"hi\\"\\n"'), 'say "hi"\n');
  assert.deepEqual(literalValue("[1, 2.5, -3]"), [1, 2.5, -3]);
  assert.deepEqual(literalValue("[]"), []);
  for (const text of ["2 * 3", "PI", "[1, a]", '"\\x41"', "40\nb = 6", "1..2", ""]) assert.equal(literalValue(text), undefined, text);
});
