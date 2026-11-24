/**
 * Hand-written `.csg` text → node tree (`CsgNode` in tree.ts). **For tests and debugging only**: the product reads the
 * custom-built OpenSCAD's JSON export (tree.ts); csg text is OpenSCAD's own notation for the same tree, and writing a
 * small piece by hand is much more readable than hand-writing JSON
 * (transpile.test.ts feeds it directly, no wasm needed).
 *
 * csg is the result of OpenSCAD's evaluation: no variables, modules, functions, for or include — only a node tree in
 * which every argument is a
 * literal and almost all are named (`cube(size = [1, 2, 3], center = false);`). So only this small subset of syntax is
 * recognized here:
 *
 *   stmt  := modifier* name '(' [arg {',' arg}] ')' ( ';' | '{' stmt* '}' )
 *   arg   := [name '='] value
 *   value := number | inf | nan | string | true | false | undef | '[' [value {',' value}] ']'
 *
 * Two of OpenSCAD's own printing quirks are accepted as-is (so a real exported csg can be pasted in and read):
 *  - **Strings are not escaped**: `text(text = "Hi "q" \ x", size = 5, …)`. The end of a string is recognized by what
 *    follows it —
 *    `)`, `]`, or `, name =` / `, ` plus the next value — rather than by escapes. Write.scad's `"` glyph is
 *    `layer = """`.
 *  - `inf`, `-inf`, `nan`, `-nan` are bare words; `resize`'s `auto` is printed as `[1,1,1]`.
 */

import type { CsgNode, CsgValue } from "./tree.ts";

export type { CsgNode, CsgValue };

export class CsgParseError extends Error {}

export function parseCsg(text: string): CsgNode[] {
  let i = 0;
  let line = 1;
  const fail = (message: string): never => {
    throw new CsgParseError(`.csg line ${line}: ${message} (near ${JSON.stringify(text.slice(i, i + 40))})`);
  };

  const skip = () => {
    for (;;) {
      const ch = text[i];
      if (ch === "\n") {
        line++;
        i++;
      } else if (ch === " " || ch === "\t" || ch === "\r") {
        i++;
      } else if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (ch === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? text.length : end + 2;
        for (let k = i; k < stop; k++) if (text[k] === "\n") line++;
        i = stop;
      } else {
        return;
      }
    }
  };

  const name = (): string => {
    const start = i;
    if (text[i] === "$") i++;
    while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
    if (i === start) fail("expected a name");
    return text.slice(start, i);
  };

  /** What may follow a string's closing quote: the end of the call or vector, or the next argument / element. */
  const AFTER_STRING = /^[ \t]*(?:\)|\]|,[ \t]*(?:\$?[A-Za-z_][A-Za-z0-9_]*[ \t]*=[^=]|["\[\-0-9.]|true\b|false\b|undef\b|inf\b|nan\b))/;

  const string = (): string => {
    const open = i;
    for (let j = text.indexOf('"', open + 1); j !== -1; j = text.indexOf('"', j + 1)) {
      if (AFTER_STRING.test(text.slice(j + 1, j + 80))) {
        const body = text.slice(open + 1, j);
        for (const ch of body) if (ch === "\n") line++;
        i = j + 1;
        return body;
      }
    }
    return fail("unterminated string");
  };

  const value = (): CsgValue => {
    skip();
    const ch = text[i];
    if (ch === '"') return string();
    if (ch === "[") {
      i++;
      const items: CsgValue[] = [];
      skip();
      if (text[i] === "]") {
        i++;
        return items;
      }
      for (;;) {
        items.push(value());
        skip();
        // a range [a : b] or [a : s : b] never comes out of a node's arguments, but read it rather than choke
        if (text[i] === "," || text[i] === ":") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return items;
        }
        fail("expected , or ] in a vector");
      }
    }
    if (ch === "-" || ch === "+") {
      i++;
      const inner = value();
      if (typeof inner !== "number") fail("a sign before something that is not a number");
      return ch === "-" ? -(inner as number) : (inner as number);
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(i, i + 40));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const word = name();
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "undef") return null;
    if (word === "inf") return Infinity;
    if (word === "nan") return NaN;
    return fail(`unexpected word ${word}`);
  };

  const statement = (): CsgNode | null => {
    skip();
    if (i >= text.length || text[i] === "}") return null;
    if (text[i] === ";") {
      i++;
      return statement();
    }
    let modifier: CsgNode["modifier"] = "";
    while ("%#!*".includes(text[i]!)) {
      if (!modifier) modifier = text[i] as CsgNode["modifier"];
      i++;
      skip();
    }
    const node: CsgNode = { name: name(), modifier, args: new Map(), positional: [], children: [] };
    skip();
    if (text[i] !== "(") fail(`expected ( after ${node.name}`);
    i++;
    skip();
    if (text[i] !== ")") {
      for (;;) {
        skip();
        const named = /^(\$?[A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/.exec(text.slice(i, i + 80));
        if (named) {
          i += named[0].length;
          node.args.set(named[1]!, value());
        } else {
          node.positional.push(value());
        }
        skip();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === ")") break;
        fail(`expected , or ) in the arguments of ${node.name}`);
      }
    }
    i++;
    skip();
    if (text[i] === ";") {
      i++;
    } else if (text[i] === "{") {
      i++;
      for (let child = statement(); child; child = statement()) node.children.push(child);
      skip();
      if (text[i] !== "}") fail(`expected } closing ${node.name}`);
      i++;
    } else {
      // `name(…) child;` — OpenSCAD always braces a child in the .csg, but the unbraced form is the same tree
      const child = statement();
      if (!child) fail(`expected ; or { after ${node.name}(…)`);
      node.children.push(child!);
    }
    return node;
  };

  const nodes: CsgNode[] = [];
  for (let node = statement(); node; node = statement()) nodes.push(node);
  skip();
  if (i < text.length) fail("unexpected }");
  return nodes;
}
