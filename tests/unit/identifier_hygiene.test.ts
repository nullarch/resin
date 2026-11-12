// A Pine identifier becomes a JavaScript binding, so a name the generated code relies on (a reserved
// word, `Math`, `__forStart`) must never reach it unchanged. The expected value of every case is the
// same script with a plain name: if renaming a variable changes the numbers, the renaming is wrong.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, transpile } from "../../src/index";
import { makeSyntheticOHLCV } from "../helpers/synthetic";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const data = makeSyntheticOHLCV(12, 5);

// Each role puts the name where a different part of the generator binds it. Template locals are
// named so they cannot collide with the name under test.
const ROLES: Record<string, (n: string) => string> = {
  var_top: (n) => `${n} = close * 2 + 1\nplot(${n}, "a")`,
  var_persist: (n) => `var float ${n} = 0.0\n${n} := ${n} + close\nplot(${n}, "a")`,
  param: (n) => `f(${n}) =>\n    ${n} * 2 + 1\nplot(f(close), "a")`,
  param_slot: (n) => `f(${n}) =>\n    ta.sma(${n}, 3) + 1\nplot(f(close), "a")`,
  func_name: (n) => `${n}(zq1) =>\n    zq1 * 2 + 1\nplot(${n}(close), "a")`,
  udt_field: (n) => `type TT\n    float ${n}\n    float zq2\nobj = TT.new(close, 2.0)\nobj.${n} := obj.${n} + 1\nplot(obj.${n} + obj.zq2, "a")`,
  method_param: (n) => `type TT\n    float zq3\nmethod mm(TT ${n}, float zq4) =>\n    ${n}.zq3 * zq4\nobj = TT.new(close)\nplot(obj.mm(2.0), "a")`,
  loop_var: (n) => `zq5 = 0.0\nfor ${n} = 0 to 4\n    zq5 += ${n} * close\nplot(zq5, "a")`,
  loop_var_nested: (n) => `zq6 = 0.0\nfor ${n} = 0 to 4\n    for zq7 = ${n} to 3\n        zq6 += ${n} + zq7\nplot(zq6 + close, "a")`,
  forin_var: (n) => `zq8 = array.new_float(0)\narray.push(zq8, close)\narray.push(zq8, close * 2)\nzq9 = 0.0\nfor ${n} in zq8\n    zq9 += ${n}\nplot(zq9, "a")`,
  for_in_idx: (n) => `zqa = array.from(1.0, 2.0, 3.0)\nzqb = 0.0\nfor [${n}, zqc] in zqa\n    zqb += ${n} * zqc\nplot(zqb + close, "a")`,
  tuple: (n) => `[${n}, zqd, zqe] = ta.macd(close, 12, 26, 9)\nplot(${n}, "a")`,
  local_in_func: (n) => `f(zqf) =>\n    ${n} = zqf * 2\n    ${n} + 1\nplot(f(close), "a")`,
  local_in_if: (n) => `zqg = 0.0\nif close > open\n    ${n} = close - open\n    zqg := ${n} * 2\nplot(zqg, "a")`,
  while_local: (n) => `${n} = 0\nwhile ${n} < 3\n    ${n} += 1\nplot(${n} + close, "a")`,
  switch_local: (n) => `${n} = 2\nzqh = switch ${n}\n    1 => 10.0\n    2 => 20.0\n    => 30.0\nplot(zqh + close, "a")`,
  named_arg: (n) => `f(${n}, zqi = 3) =>\n    ${n} + zqi\nplot(f(${n} = close, zqi = 2), "a")`,
};

// The JS words and globals the generator cannot give a binding, plus its own `__` namespace. The
// original reserved set is spelled out too, so a regression in it shows up here and not only in the
// codegen text tests.
const NAMES = [
  "let", "static", "yield", "await", "arguments", "eval", "implements", "interface", "package", "private", "protected", "public",
  "Math", "Number", "String", "Boolean", "Array", "Object", "Map", "Set", "Symbol", "JSON", "Date", "Error",
  "Float64Array", "Infinity", "NaN", "undefined", "isNaN", "parseFloat", "globalThis",
  "__forStart", "__forEnd", "__forStep", "__forFwd", "__forDelta", "__forInArr", "__forInIdx", "__forInMap",
  "__slotBase", "__taBase", "__switchSubject", "__cfr0", "__whileLimit", "__forLimit", "__x",
  "case", "catch", "class", "debugger", "default", "delete", "do", "extends", "finally", "function", "in",
  "instanceof", "new", "null", "return", "rt", "super", "this", "throw", "try", "typeof", "void", "with",
];

function plots(body: string): string {
  const r = transpile(`//@version=6\nindicator("t")\n${body}\n`);
  if (!r.ok) return `transpile: ${r.errors[0]}`;
  try {
    return JSON.stringify(run(r, data).plots.map((p) => Array.from(p.values)));
  } catch (e) {
    return `run: ${(e as Error).message}`;
  }
}

describe("identifier hygiene: renaming a variable never changes the numbers", () => {
  for (const [role, make] of Object.entries(ROLES)) {
    it(`role ${role}`, () => {
      const want = plots(make("zzq"));
      expect(want.startsWith("["), `the plain-name script must run: ${want}`).toBe(true);
      const bad: string[] = [];
      for (const name of NAMES) {
        const got = plots(make(name));
        // A Pine keyword may be refused (loud, and correct); what must not happen is an accepted
        // script that is not the plain-name script.
        if (got.startsWith("transpile:") && /unexpected|expected|keyword|reserved/i.test(got)) continue;
        if (got !== want) bad.push(`${name}: ${got.slice(0, 120)}`);
      }
      expect(bad, bad.join("\n")).toEqual([]);
    });
  }
});

describe("identifier hygiene: the reserved set is derived from the generated code", () => {
  // Every identifier the generated code mentions that is also a property of globalThis (Math,
  // Number, Map, ...) is something a user local of that name would hide. Collect them from the code
  // generated for the oracle cases, then check a local of each name is not emitted under that name.
  function globalsMentioned(code: string): string[] {
    const noStrings = code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    const out = new Set<string>();
    for (const m of noStrings.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
      const name = m[1]!;
      if (name in globalThis) out.add(name);
    }
    return [...out];
  }

  it("a user local never takes the name of a global the generated code reads", () => {
    const used = new Set<string>();
    for (const f of readdirSync(join(ROOT, "oracle", "cases")).filter((x) => x.endsWith(".pine"))) {
      const r = transpile(readFileSync(join(ROOT, "oracle", "cases", f), "utf-8"));
      if (r.ok) for (const g of globalsMentioned(r.code)) used.add(g);
    }
    expect(used.size, "the scan found no globals at all: the check is vacuous").toBeGreaterThanOrEqual(4);
    expect([...used]).toContain("Math");
    const unrenamed: string[] = [];
    for (const g of used) {
      const probe = transpile(`//@version=6\nindicator("t")\n${g} = close\nplot(${g})\n`);
      if (!probe.ok) continue; // refused outright is safe
      const esc = g.replace(/\$/g, "\\$");
      if (new RegExp(`\\b(?:let|const|var)\\s+${esc}(?![\\w$])`).test(probe.code)) unrenamed.push(g);
    }
    expect(unrenamed, "generated code reads these globals, yet a user local of the same name is emitted as is").toEqual([]);
  });
});
