import { test } from "node:test";
import assert from "node:assert/strict";
import { projectScadEntry, scadReachable } from "./project.ts";

test("a stored project's entry: root model.scad first, else the file nothing includes", () => {
  assert.equal(projectScadEntry({ "model.scad": "include <a.scad>\n", "a.scad": "", "b.scad": "" }), "model.scad");
  assert.equal(projectScadEntry({ "lib/part.scad": "module p() cube(1);\n", "box.scad": "use <lib/part.scad>\np();\n" }), "box.scad");
  assert.equal(projectScadEntry({}), null);
});

test("what a render reads: the entry and what it includes or uses, transitively, resolved beside the file first", () => {
  const files = {
    "model.scad": "include <inc/size.scad>\nuse <parts/arm.scad>\narm();\n",
    "inc/size.scad": "W = 20;\n",
    "parts/arm.scad": "include <common.scad>\nmodule arm() cube(W);\n",
    "parts/common.scad": "R = 1;\n",
    "common.scad": "R = 2; // shadowed by parts/common.scad for arm.scad\n",
    "old.scad": "cube(5);\n",
  };
  assert.deepEqual([...scadReachable(files, "model.scad")].sort(), ["inc/size.scad", "model.scad", "parts/arm.scad", "parts/common.scad"]);
  // a cycle ends; a name with no file is not a file the render reads
  assert.deepEqual([...scadReachable({ "a.scad": "include <b.scad>\ninclude <gone.scad>\n", "b.scad": "use <a.scad>\n" }, "a.scad")].sort(), ["a.scad", "b.scad"]);
});
