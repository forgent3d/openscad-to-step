// The OpenSCAD path (csg.ts) with a scripted runner: what it mounts, what it refuses, what the author is told
// and where. The exports below are what our OpenSCAD build writes for these cases (tree.ts); the real path is
// exercised by scripts/scad-thingiverse.mjs and scripts/scad-diff.mjs.
//   node_modules/.bin/tsx --test src/csg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { transpileViaOpenScad, type OpenScadRunner } from "./csg.ts";
import { readScadTree } from "./tree.ts";
import { runOpenScad } from "./node.mjs";

type Seen = { files?: Record<string, string | Uint8Array>; entry?: string };

/** An export as the fork writes it: `files` is the file table the `at` indices point into. */
function exported(tree: unknown[] | null, extra: { log?: unknown[]; files?: string[]; params?: unknown; aborted?: true } = {}): string {
  return JSON.stringify({ format: "forgent3d-openscad-tree", version: 1, tree, ...(extra.aborted ? { aborted: true } : {}), params: extra.params ?? null, log: extra.log ?? [], files: extra.files ?? [] });
}

function runner(tree: string | null, extra: { console?: string[]; crash?: string; seen?: Seen } = {}): OpenScadRunner {
  return async (job) => {
    if (extra.seen) Object.assign(extra.seen, job);
    return { tree, console: extra.console ?? [], ...(extra.crash ? { crash: extra.crash } : {}) };
  };
}

const node = (name: string, args: Record<string, unknown>, more: Record<string, unknown> = {}) => ({ node: name, args, ...more });

test("the project and the built-in libraries are mounted where OpenSCAD looks; diagnostics point at the .scad call", async () => {
  const seen: Seen = {};
  const tree = [
    node("multmatrix", { m: [[1, 0, 0, 5], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }, {
      call: "translate",
      at: [0, 3, 1, 3, 17],
      children: [node("group", {}, { module: "bracket", at: [0, 3, 18, 3, 28], children: [node("color", { c: [1, 0, 0, 1] }, { at: [1, 1, 20, 1, 34], children: [node("cube", { size: [2, 2, 2], center: false }, { at: [1, 1, 35, 1, 42] })] })] })],
    }),
    node("color", { c: [1, 0, 0, 1] }, { at: [0, 4, 1, 4, 13], children: [node("sphere", { $fn: 0, $fa: 12, $fs: 2, r: 1 / 3 }, { at: [0, 4, 14, 4, 30] })] }),
  ];
  const out = await transpileViaOpenScad("// Bracket\ninclude <parts/lib.scad>\ntranslate([5, 0, 0]) bracket();\ncolor(\"red\") sphere(r = 1/3);", {
    files: { "parts/lib.scad": "module bracket() color(\"red\") cube(2);" },
    entry: "main.scad",
    run: runner(
      exported(tree, {
        files: ["/project/main.scad", "/project/parts/lib.scad"],
        log: [{ group: "WARNING", text: "Ignoring unknown variable \"w\"", at: [0, 7, 5, 7, 6] }, { group: "ECHO", text: "\"hello\"", at: [0, 2, 1, 2, 14] }],
      }),
      { seen },
    ),
  });
  assert.equal(seen.entry, "/project/main.scad");
  assert.equal(seen.files?.["/project/parts/lib.scad"], "module bracket() color(\"red\") cube(2);");
  assert.ok(seen.files?.["/libraries/MCAD/2Dshapes.scad"]);
  assert.ok(out.ok);
  const { transpiled } = out as Extract<typeof out, { ok: true }>;
  // every located node starts a line of model.py that says where it came from; sourceMap is the same, for the engine's errors
  assert.match(transpiled.python, /^ +Pos\(5, 0, 0\) \*  # main\.scad:3:1$/m);
  assert.match(transpiled.python, /^ +Box\(2, 2, 2, [^\n]*  # parts\/lib\.scad:1:35 in bracket\(\)$/m);
  const boxLine = transpiled.python.split("\n").findIndex((line) => /Box\(2, 2, 2/.test(line)) + 1;
  assert.deepEqual(transpiled.sourceMap[boxLine], { file: "parts/lib.scad", line: 1, column: 35 });
  assert.match(transpiled.python, /Sphere\(0\.333333333333333\b/); // full precision (the 6-digit csg said 0.333333)
  assert.match(transpiled.python, /"""Bracket, world Z-up/); // named after the .scad
  const messages = transpiled.warnings.map((w) => `${w.file}:${w.line}:${w.column} ${w.message}`);
  // OpenSCAD's own warning at its real place; echo is not a diagnostic
  assert.ok(messages.includes("main.scad:7:5 OpenSCAD: WARNING: Ignoring unknown variable \"w\""), messages.join("\n"));
  assert.ok(!messages.some((m) => /hello/.test(m)), messages.join("\n"));
  // a translation warning points at the call that made the node — inside the included file — once, with a count
  assert.ok(messages.includes("parts/lib.scad:1:20 color() shows in the preview only — the STEP carries no colour (appearance lives on the Body in model.py, not in the geometry) (×2)"), messages.join("\n"));
});

test("an error that stops OpenSCAD's evaluation stops the build and says where, in the author's file", async () => {
  const parse = await transpileViaOpenScad("cube(;", {
    entry: "part.scad",
    run: runner(exported(null, { files: ["/project/part.scad"], log: [{ group: "ERROR", text: "Parser error: syntax error", at: [0, 1, -1, -1, -1] }, { group: "", text: "Can't parse file '/project/part.scad'!\n" }] })),
  });
  assert.equal(parse.ok, false);
  assert.equal((parse as any).reason, "openscad-error");
  assert.deepEqual((parse as any).diagnostics, [{ file: "part.scad", line: 1, column: 1, message: "OpenSCAD: ERROR: Parser error: syntax error" }]);

  // OpenSCAD renders what came before the failed assert (here the first cube) as if it were the model
  const assertion = await transpileViaOpenScad("w = 3;\ncube(1);\nassert(w > 5, \"too thin\");\ncube(w);", {
    run: runner(exported([node("cube", { size: [1, 1, 1], center: false })], {
      aborted: true,
      files: ["/project/model.scad"],
      params: { parameters: [{ group: "Parameters", initial: 3, name: "w", type: "number" }], title: "model" },
      log: [{ group: "ERROR", text: "Assertion '(w > 5)' failed: \"too thin\"", at: [0, 2, 1, 2, 26] }, { group: "TRACE", text: "called by 'assert'", at: [0, 2, 1, 2, 26] }],
    })),
  });
  assert.equal(assertion.ok, false);
  assert.deepEqual((assertion as any).diagnostics, [
    { file: "model.scad", line: 2, column: 1, message: "OpenSCAD: ERROR: Assertion '(w > 5)' failed: \"too thin\"" },
    { file: "model.scad", line: 1, column: 1, message: "OpenSCAD stopped evaluating at this error — what came before it is not the whole model, so nothing is built" },
  ]);
  // the knobs come with a failed build too: the parameter that broke it is fixed from them
  assert.deepEqual((assertion as any).parameters.map((p: any) => p.name), ["w"]);
});

test("an error raised inside a bundled library is reported at the author's line that made the call", async () => {
  // BOSL2's cuboid() asserts on the rounding it was handed: the assert's own place is a library line nobody can edit
  const source = "include <BOSL2/std.scad>\nmodule sleeve() {\n  up(3) cuboid([40, 40, 2.5], rounding = 3);\n}\nsleeve();";
  const trace = (text: string, at?: number[]) => ({ group: "TRACE", text, ...(at ? { at } : {}) });
  const failed = await transpileViaOpenScad(source, {
    run: runner(exported([], {
      aborted: true,
      files: ["/project/model.scad", "/libraries/BOSL2/shapes3d.scad", "/libraries/BOSL2/transforms.scad"],
      log: [
        { group: "ERROR", text: "Assertion '(minz <= size.z)' failed: \"Rounding or chamfering too large for cuboid size in the Z axis.\"", at: [1, 422, 17, 422, 80] },
        trace("assignment to \"check\"", [1, 419, 13, 419, 20]),
        trace("called by 'if'", [1, 394, 18, 394, 20]),
        trace("call of 'cuboid(size = [40, 40, 2.5], p1 = undef, p2 = undef, chamfer = undef, rounding = 3, anchor = [0, 0, -1])'", [1, 218, 2, 218, 8]),
        trace("called by 'cuboid'", [0, 3, 9, 3, 15]),
        trace("called by 'children'", [2, 450, 24, 450, 32]),
        trace("call of 'up(z = 3, p = undef)'", [2, 446, 18, 446, 20]),
        trace("called by 'up'", [0, 3, 3, 3, 5]),
        trace("call of 'sleeve()'", [0, 2, 1, 2, 7]),
        trace("called by 'sleeve'", [0, 5, 1, 5, 7]),
      ],
    })),
  });
  assert.equal(failed.ok, false);
  assert.deepEqual((failed as any).diagnostics[0], {
    file: "model.scad",
    line: 3,
    column: 9,
    message:
      "OpenSCAD: ERROR: Assertion '(minz <= size.z)' failed: \"Rounding or chamfering too large for cuboid size in the Z axis.\" — raised inside BOSL2/shapes3d.scad:422 by this line's call cuboid(size = [40, 40, 2.5], rounding = 3, anchor = [0, 0, -1]), in sleeve()",
  });

  // frames cut out of the trace: the module named above the cut may not be the one the line is in — left unsaid
  const cut = await transpileViaOpenScad(source, {
    run: runner(exported([], {
      aborted: true,
      files: ["/project/model.scad", "/libraries/BOSL2/utility.scad"],
      log: [
        { group: "ERROR", text: "Assertion '(count > 0)' failed: \"Module up() requires children\"", at: [1, 835, 7, 835, 20] },
        trace("call of 'up(z = 3, p = undef)'", [1, 446, 18, 446, 20]),
        trace("called by 'up'", [0, 3, 3, 3, 5]),
        trace("*** Excluding 13 frames ***"),
        trace("call of 'sleeve()'", [0, 2, 1, 2, 7]),
      ],
    })),
  });
  assert.equal((cut as any).diagnostics[0].message, "OpenSCAD: ERROR: Assertion '(count > 0)' failed: \"Module up() requires children\" — raised inside BOSL2/utility.scad:835 by this line's call up(z = 3)");
  assert.equal((cut as any).diagnostics[0].line, 3);

  // a trace with no line of the project in it: the error stays where OpenSCAD put it
  const nowhere = await transpileViaOpenScad(source, {
    run: runner(exported([], {
      aborted: true,
      files: ["/project/model.scad", "/libraries/BOSL2/utility.scad"],
      log: [{ group: "ERROR", text: "Assertion 'false' failed", at: [1, 10, 1, 10, 5] }, trace("called by 'assert'", [1, 10, 1, 10, 5])],
    })),
  });
  assert.deepEqual((nowhere as any).diagnostics[0], { file: "BOSL2/utility.scad", line: 10, column: 1, message: "OpenSCAD: ERROR: Assertion 'false' failed" });
});

test("an error OpenSCAD logs and goes on past is a warning: the build makes what OpenSCAD renders", async () => {
  // the origami template's for (i = [0:len(cut_polygons)]) runs one past the list: polygon(points = undef) is empty
  const out = await transpileViaOpenScad("cube(10);\npolygon(points = undef);\ntranslate([20, 0, 0]) cube(5);", {
    run: runner(exported([
      node("cube", { size: [10, 10, 10], center: false }),
      node("polygon", { points: [], paths: null, convexity: 1 }, { at: [0, 2, 1, 2, 24] }),
      node("multmatrix", { m: [[1, 0, 0, 20], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }, { children: [node("cube", { size: [5, 5, 5], center: false })] }),
    ], { files: ["/project/model.scad"], log: [{ group: "ERROR", text: "Unable to convert points = undef to a vector of coordinates", at: [0, 2, 1, 2, 24] }] })),
  });
  assert.equal(out.ok, true);
  // the empty polygon is no part of it, and both cubes are
  assert.match((out as any).transpiled.python, /^part = \(Box\(10, 10, 10, [^\n]*\) \+ Pos\(20, 0, 0\) \* Box\(5, 5, 5, [^\n]*\)\)$/m);
  assert.deepEqual((out as any).transpiled.warnings.filter((w: any) => /Unable to convert/.test(w.message)), [
    { file: "model.scad", line: 2, column: 1, message: "OpenSCAD: ERROR: Unable to convert points = undef to a vector of coordinates — OpenSCAD goes on past it, and so does this build" },
  ]);
});

test("a crash before the export was written is said as one, with OpenSCAD's last words", async () => {
  const out = await transpileViaOpenScad("module r(n) r(n + 1); r(0);", {
    run: runner(null, { crash: "Maximum call stack size exceeded", console: ["Could not initialize localization (application path is '/')."] }),
  });
  assert.equal((out as any).reason, "openscad-error");
  assert.match((out as any).diagnostics[0].message, /^OpenSCAD stopped: Maximum call stack size exceeded — the model recurses deeper/);
});

test("the project's data files are mounted as bytes beside the .scad files, where import()/surface() look", async () => {
  const seen: Seen = {};
  const stl = new Uint8Array([0x73, 0x6f, 0x6c, 0x69, 0x64, 0x00, 0xff]);
  await transpileViaOpenScad('import("parts/bracket.stl");', {
    files: { "lib.scad": "module m() {}" },
    assets: { "parts/bracket.stl": stl, "./maps/height.png": new Uint8Array([0x89, 0x50]) },
    run: runner(exported([]), { seen }),
  });
  const mounted = seen.files as Record<string, string | Uint8Array>;
  assert.equal(mounted["/project/parts/bracket.stl"], stl, "the bytes themselves, not text");
  assert.deepEqual(mounted["/project/maps/height.png"], new Uint8Array([0x89, 0x50]));
  assert.equal(mounted["/project/lib.scad"], "module m() {}");
  assert.equal(mounted["/project/model.scad"], 'import("parts/bracket.stl");');
});

test("a file OpenSCAD cannot open stops the build: it would render the rest and silently drop that part", async () => {
  const out = await transpileViaOpenScad("use <write/Write.scad>\nwrite(\"x\");", {
    run: runner(exported([], {
      files: ["/project/model.scad"],
      log: [{ group: "WARNING", text: "Can't open library 'write/Write.scad'.", at: [0, 1, 1, 1, 23] }, { group: "WARNING", text: "Ignoring unknown module 'write'", at: [0, 2, 1, 2, 11] }],
    })),
  });
  assert.equal((out as any).reason, "missing-file");
  assert.deepEqual((out as any).diagnostics, [{ file: "model.scad", line: 1, column: 1, message: "OpenSCAD: WARNING: Can't open library 'write/Write.scad'." }]);

  // an import() it cannot read is an ERROR that OpenSCAD goes on past — the same part dropped, the same refusal
  const blank = await transpileViaOpenScad("logo = \"\";\ncube(10);\nimport(str(logo, \".svg\"));", {
    run: runner(exported([node("cube", { size: [10, 10, 10], center: false })], {
      files: ["/project/model.scad"],
      log: [{ group: "ERROR", text: "Unsupported file format while trying to import file '\"/project/.svg\"', import() at line 3", at: [0, 3, 1, 3, 26] }],
    })),
  });
  assert.equal((blank as any).reason, "missing-file");

  // since 2026 a missing include says "Can't find" ("Can't open" is one that is there and unreadable)
  const include = await transpileViaOpenScad("include <configuration.scad>\ncube(size);", {
    run: runner(exported([], {
      files: ["/project/model.scad"],
      log: [{ group: "WARNING", text: "Can't find include file 'configuration.scad'.", at: [0, 1, 1, 1, 29] }],
    })),
  });
  assert.equal((include as any).reason, "missing-file");
});

test("our OpenSCAD build, for real: a missing include or library refuses instead of building the rest", async () => {
  for (const source of ["include <configuration.scad>\ncube(10);", "use <parts/missing.scad>\ncube(10);", 'cube(10);\nimport("bracket.stl");']) {
    const out = await transpileViaOpenScad(source, { run: runOpenScad });
    assert.equal(out.ok, false, source);
    assert.equal((out as any).reason, "missing-file", source);
    assert.match((out as any).diagnostics[0].message, /Can't (find include file 'configuration\.scad'|open library 'parts\/missing\.scad'|open import file)/, source);
  }
});

test("an experimental feature desktop OpenSCAD keeps off (vector swizzle, object()) builds as desktop does, and says so plainly", async () => {
  const source = "v = [4, 5, 6];\nfor (i = [0:2]) cube(v.zyx);\no = object(a = 1);\ncube(v);";
  const out = await transpileViaOpenScad(source, { run: runOpenScad });
  assert.ok(out.ok);
  const messages = (out as Extract<typeof out, { ok: true }>).transpiled.warnings.map((w) => `${w.file}:${w.line} ${w.message}`);
  // OpenSCAD's own words (the fork's for the swizzle), once per place with a count, then what it means
  assert.ok(messages.includes("model.scad:2 OpenSCAD: WARNING: Experimental vector swizzle '.zyx' is not enabled — an experimental OpenSCAD feature that desktop OpenSCAD also keeps off by default (Preferences → Features → vector-swizzle): without it the value is undef, in desktop OpenSCAD and here alike (×3)"), messages.join("\n"));
  assert.ok(messages.includes("model.scad:3 OpenSCAD: WARNING: Experimental builtin function 'object' is not enabled — an experimental OpenSCAD feature that desktop OpenSCAD also keeps off by default (Preferences → Features → object-function): without it the call is ignored and gives undef, in desktop OpenSCAD and here alike"), messages.join("\n"));
  // "Ignoring unknown function 'object'" says the same again: not repeated
  assert.ok(!messages.some((m) => /Ignoring unknown function 'object'/.test(m)), messages.join("\n"));
});

test("an empty render, too large a flattening, a node this build cannot make, and non-finite numbers", async () => {
  // OpenSCAD renders nothing for it either: an empty model, which the studio reports in OpenSCAD's words
  const empty = await transpileViaOpenScad("module m() cube(1);", { run: runner(exported([])) });
  assert.ok(empty.ok);
  assert.match((empty as any).transpiled.python, /^part = None$/m);
  const cubes = Array.from({ length: 20 }, () => node("cube", { size: [1, 1, 1], center: false }));
  const big = await transpileViaOpenScad("x();", { run: runner(exported(cubes)), maxNodes: 10 });
  assert.equal((big as any).reason, "too-large");
  const refused = await transpileViaOpenScad("\nsurface(\"hm.dat\");", {
    run: runner(exported([node("surface", { file: "/project/hm.dat", center: false, invert: false, convexity: 1 }, { at: [0, 2, 1, 2, 19] })], { files: ["/project/model.scad"] })),
  });
  assert.equal((refused as any).reason, "unsupported");
  assert.equal((refused as any).diagnostics[0].line, 2);
  assert.match((refused as any).diagnostics[0].message, /heightmap/);
  // a number argument written "inf" is a number (cube() of it is OpenSCAD's empty); a string argument stays text
  const [cube, text] = readScadTree(exported([node("cube", { size: ["inf", 1, "-nan"], center: false }), node("text", { text: "inf", size: 3, font: "" })])).nodes!;
  assert.deepEqual((cube!.args.get("size") as number[]).slice(0, 2), [Infinity, 1]);
  assert.ok(Number.isNaN((cube!.args.get("size") as number[])[2]));
  assert.equal(text!.args.get("text"), "inf");
  const inf = await transpileViaOpenScad("x();", { run: runner(exported([node("cube", { size: ["inf", 1, 1], center: false })])) });
  assert.ok(inf.ok);
  assert.match((inf as any).transpiled.python, /^part = None$/m);
});

test("an export the reader does not know is refused, not guessed at", async () => {
  const out = await transpileViaOpenScad("cube(1);", { run: runner('{"format":"forgent3d-openscad-tree","version":2}') });
  assert.equal((out as any).reason, "openscad-error");
  assert.match((out as any).diagnostics[0].message, /not a forgent3d-openscad-tree v1 export/);
});
