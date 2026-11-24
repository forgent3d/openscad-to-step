/**
 * Customizer parameters of a .scad: **OpenSCAD itself says which ones count as parameters** (exported from the same
 * evaluation as the node tree, tree.ts `params`),
 * so its rules are not reimplemented here — top-level literal assignments, before the first module, not after
 * `/* [Hidden] *\/`, the comment on the line above is the description,
 * and a trailing `// [10:100]` / `// [a, b]` / `// [2:Two, 4:Four]` gives a range or a dropdown; OpenSCAD recognizes all
 * of that.
 *
 * Changing a parameter = **writing back to the .scad source** (the `.scad` is the source of truth, model.py is a
 * derived product): only the literal of that one assignment is replaced, the trailing annotation and
 * all other text stay byte for byte, then the model is evaluated again as usual. `-D name=value` is not used: the
 * source and the part on screen would no longer be the same thing.
 */

export type ScadParameterValue = number | string | boolean | number[];

/** One parameter as OpenSCAD's `param` export writes it. */
export type ScadParameter = {
  name: string;
  type: "number" | "string" | "boolean";
  /** The value in the source (a vector of numbers comes as `type: "number"` with an array here). */
  initial: ScadParameterValue;
  /** The comment line above the assignment. */
  caption?: string;
  /** From `/* [Group] *\/`; OpenSCAD calls the unnamed one "Parameters". */
  group: string;
  min?: number;
  max?: number;
  step?: number;
  /** A dropdown: `// [a, b]` or `// [2:Two, 4:Four]` (value:label). */
  options?: { name: string; value: number | string }[];
};

/** OpenSCAD's parameter export (the `param` JSON, already parsed) → parameters; anything unreadable is no parameters, never an error. */
export function readParameters(parsed: any): ScadParameter[] {
  if (!Array.isArray(parsed?.parameters)) return [];
  return parsed.parameters.filter(
    (p: any) => typeof p?.name === "string" && ["number", "string", "boolean"].includes(p?.type) && p.initial !== undefined,
  ).map((p: any) => {
    const parameter = { ...p, group: typeof p.group === "string" ? p.group : "Parameters" };
    // Since 2026 (upstream 4a0c31593) a plain number's export says `step: 1` when no step was written too — the
    // desktop spin box then steps by the value's last decimal, not by 1. That 1 says nothing: the box takes any number.
    if (parameter.step === 1 && parameter.max === undefined && parameter.min === undefined) delete parameter.step;
    return parameter;
  });
}

/**
 * `source` with the top-level assignment of `name` set to `value`. Only the value's text changes: the name,
 * the `;`, the Customizer comment after it and every other line stay byte for byte. When the name is assigned
 * twice at the top level the LAST one is the one OpenSCAD uses, so that one is rewritten.
 *
 * Never a guess: the text being replaced must be a plain value (OpenSCAD only makes a parameter of one), and — with
 * `expected`, the value the knob was built from — that very value. The editor may hold text that was never built:
 * an expression typed over it, or a `;` deleted so the scanner's span runs into the next line. Rewriting that
 * would edit what the author did not point at; they are told to build first.
 */
export function setParameter(
  source: string,
  name: string,
  value: ScadParameterValue,
  step?: number,
  expected?: ScadParameterValue,
): { ok: true; source: string } | { ok: false; error: string } {
  const target = topLevelAssignments(source).filter((a) => a.name === name).pop();
  if (!target) return { ok: false, error: `no top-level assignment of ${name} in this file` };
  const current = literalValue(source.slice(target.start, target.end));
  if (current === undefined) {
    return { ok: false, error: `${name} is not a plain value in the source now (an expression, or a missing ";") — build first, or edit it by hand` };
  }
  if (expected !== undefined && !sameValue(current, expected)) {
    return { ok: false, error: `${name} changed in the source since the last build — build first, then use the knob` };
  }
  const text = formatScadValue(value, step);
  if (text === null) return { ok: false, error: `${name}: ${JSON.stringify(value)} is not a value OpenSCAD can hold` };
  return { ok: true, source: source.slice(0, target.start) + text + source.slice(target.end) };
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = { "\\": "\\", '"': '"', n: "\n", t: "\t", r: "\r" };

/**
 * What a value's source text holds when it is a plain value OpenSCAD makes a parameter of — a number, a string,
 * true/false, a vector of numbers — else undefined. A string with an escape other than \\ \" \n \t \r is undefined
 * too: a refusal, never a wrong match.
 */
export function literalValue(text: string): ScadParameterValue | undefined {
  const t = text.trim();
  if (NUMBER.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(t);
  if (quoted) {
    let plain = true;
    const value = quoted[1]!.replace(/\\(.)/g, (_, c: string) => {
      if (ESCAPES[c] === undefined) plain = false;
      return ESCAPES[c] ?? "";
    });
    return plain ? value : undefined;
  }
  const vector = /^\[([^\]]*)\]$/.exec(t);
  if (vector) {
    const items = vector[1]!.trim() === "" ? [] : vector[1]!.split(",").map((item) => item.trim());
    return items.every((item) => NUMBER.test(item)) ? items.map(Number) : undefined;
  }
  return undefined;
}

/** Numbers equal up to slack far below any decimal an author writes (OpenSCAD's export reads back exactly anyway). */
function sameValue(a: ScadParameterValue, b: ScadParameterValue): boolean {
  const near = (x: number, y: number) => x === y || Math.abs(x - y) <= 1e-12 * Math.max(Math.abs(x), Math.abs(y));
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => near(x, b[i]!));
  }
  if (typeof a === "number" && typeof b === "number") return near(a, b);
  return a === b;
}

/** A value as OpenSCAD source. A number keeps the step's decimals (0.2 steps: 2.4, not 2.4000000000000004). */
export function formatScadValue(value: ScadParameterValue, step?: number): string | null {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  }
  if (Array.isArray(value)) {
    const items = value.map((v) => formatNumber(v, step));
    return items.some((v) => v === null) ? null : `[${items.join(", ")}]`;
  }
  return formatNumber(value, step);
}

function formatNumber(value: number, step?: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const decimals = step && !Number.isInteger(step) ? (String(step).split(".")[1]?.length ?? 0) : null;
  const rounded = decimals === null ? Number(value.toPrecision(12)) : Number(value.toFixed(decimals));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/**
 * The top-level assignments of a .scad (`name = value;` at brace depth 0), with the span of each value's text.
 * A small scanner, not a parser: it only has to know what is a comment, a string, a nesting bracket and the
 * start of a statement — `include <…>` / `use <…>` lines end without a `;`, a module body is at depth 1.
 */
export function topLevelAssignments(source: string): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  const n = source.length;
  /** Past whitespace and comments from `i`. */
  const skip = (i: number): number => {
    for (;;) {
      while (i < n && /\s/.test(source[i]!)) i++;
      if (source[i] === "/" && source[i + 1] === "/") {
        while (i < n && source[i] !== "\n") i++;
      } else if (source[i] === "/" && source[i + 1] === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
      } else {
        return i;
      }
    }
  };
  /** Past a string literal whose opening quote is at `i`. */
  const pastString = (i: number): number => {
    for (i++; i < n; i++) {
      if (source[i] === "\\") i++;
      else if (source[i] === '"') return i + 1;
    }
    return n;
  };
  let depth = 0;
  let atStart = true;
  let i = 0;
  while ((i = skip(i)) < n) {
    const ch = source[i]!;
    if (ch === '"') {
      i = pastString(i);
      atStart = false;
      continue;
    }
    if (depth === 0 && atStart && /[A-Za-z_$]/.test(ch)) {
      let k = i;
      while (k < n && /[A-Za-z0-9_$]/.test(source[k]!)) k++;
      const word = source.slice(i, k);
      const next = skip(k);
      if ((word === "include" || word === "use") && source[next] === "<") {
        const close = source.indexOf(">", next);
        i = close === -1 ? n : close + 1;
        continue; // still at a statement start
      }
      if (source[next] === "=" && source[next + 1] !== "=") {
        // the value runs to the `;` at its own depth 0
        const start = skip(next + 1);
        let j = start;
        let inner = 0;
        while (j < n) {
          const c = source[j]!;
          if (c === '"') { j = pastString(j); continue; }
          if (c === "/" && (source[j + 1] === "/" || source[j + 1] === "*")) { j = skip(j); continue; }
          if ("([{".includes(c)) inner++;
          else if (")]}".includes(c)) inner--;
          else if (c === ";" && inner <= 0) break;
          j++;
        }
        let end = j;
        while (end > start && /\s/.test(source[end - 1]!)) end--;
        out.push({ name: word, start, end });
        i = j + 1;
        continue;
      }
      atStart = false;
      i = k;
      continue;
    }
    if ("([{".includes(ch)) {
      depth++;
    } else if (")]}".includes(ch)) {
      depth = Math.max(0, depth - 1);
      if (ch === "}" && depth === 0) {
        atStart = true;
        i++;
        continue;
      }
    } else if (ch === ";" && depth === 0) {
      atStart = true;
      i++;
      continue;
    }
    atStart = false;
    i++;
  }
  return out;
}
