// The literal type check (src/transpiler/types/check.ts): type errors that need no inference.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transpile } from "../../src";
import { parse } from "../../src/transpiler/parser";
import { checkTypes } from "../../src/transpiler/types/check";

const messages = (body: string, version = 6): string[] => checkTypes(parse(`//@version=${version}\nindicator("t")\n${body}\nplot(1)\n`)).map((f) => f.message);

describe("literal type check", () => {
  it("says nothing about well-typed code, or about what it cannot see", () => {
    expect(messages('int a = 1\nfloat b = 2\nstring s = "x"\nbool c = true\ncolor k = #ff0000\nfloat n = na')).toEqual([]);
    expect(messages('x = 1\nx := 2\ns = "a" + "b"\ny = close > open ? 1 : 2\nz = ta.sma(close, 14)')).toEqual([]);
    // No inference: a call's result, a parameter and a twice-introduced name are unknown.
    expect(messages('f(v) => v + 1\nq = f("a")\nint w = f(2)')).toEqual([]);
    expect(messages('x = 1\nif close > open\n    x = "a"\n    x := "b"')).toEqual([]);
    // v5 casts a number to bool.
    expect(messages("bool b = 1\nif 1\n    b := true", 5)).toEqual([]);
  });

  it("reports a declared type against a literal of another type", () => {
    expect(messages('int x = "a"')).toEqual(["'x' is declared int and initialized with a string"]);
    expect(messages("string s = 1")).toEqual(["'s' is declared string and initialized with a number"]);
    expect(messages('series float f = "a"')).toEqual(["'f' is declared float and initialized with a string"]);
  });

  it("reports := changing a settled variable's type", () => {
    expect(messages('x = 1\nx := "a"')).toEqual(["':=' cannot give 'x', a number, a string"]);
    expect(messages('var string s = na\ns := 1')).toEqual(["':=' cannot give 's', a string, a number"]);
  });

  it("reports a string where a bool or a number is taken", () => {
    expect(messages('if "a"\n    x = 1')).toEqual(["an `if` condition takes a bool, not a string"]);
    expect(messages('x = "a" ? 1 : 2')).toEqual(["a `?:` condition takes a bool, not a string"]);
    expect(messages('x = not "a"')).toEqual(["`not` takes a bool, not a string"]);
    expect(messages('x = "a" and true')).toEqual(["`and` takes a bool, not a string"]);
    expect(messages('x = "a" - "b"')).toEqual(["`-` takes a number, not a string", "`-` takes a number, not a string"]);
    expect(messages('x = "a" * 2')).toEqual(["`*` takes a number, not a string"]);
    expect(messages('x = close["a"]')).toEqual(["a history offset is a number, not a string"]);
    expect(messages('for i = "a" to 5\n    x = i')).toEqual(["a `for` bound takes a number, not a string"]);
  });

  it("reports a built-in argument of the other kind", () => {
    expect(messages('x = ta.sma(close, "5")')).toEqual(["'ta.sma' takes a number for 'length', not a string"]);
    expect(messages('x = ta.sma(close, length="5")')).toEqual(["'ta.sma' takes a number for 'length', not a string"]);
    expect(messages("x = str.length(1)")).toEqual(["'str.length' takes a string for 'string', not a number"]);
  });

  // The type record (types/infer.ts) gives the same rules more to read than literals.
  it("reads inferred types: built-in variables, operators, built-in calls and settled variables", () => {
    expect(messages('s = str.tostring(close)\nx = s * 2')).toEqual(["`*` takes a number, not a string"]);
    expect(messages('msg = "Price: " + close')).toEqual(["`+` adds two numbers or joins two strings, not a number and a string"]);
    expect(messages("up = close > open\nx = up * 2")).toEqual(["`*` takes a number, not a bool"]);
    expect(messages("var bool m = na\nm := syminfo.ticker")).toEqual(["':=' cannot give 'm', a bool, a string"]);
    expect(messages("x = ta.sma(close, syminfo.ticker)")).toEqual(["'ta.sma' takes a number for 'length', not a string"]);
    expect(messages("if syminfo.ticker\n    x = 1")).toEqual(["an `if` condition takes a bool, not a string"]);
    // Well-typed uses of the same things stay silent.
    expect(messages('s = str.tostring(close) + " USD"\nn = close * 2 + ta.sma(close, 14)\nb = close > open and barstate.islast\nc = b ? color.red : color.green')).toEqual([]);
  });

  it("is a transpile warning, and an error under strict", () => {
    const src = '//@version=6\nindicator("t")\nx = 1\nx := "a"\nplot(1)\n';
    const strict = transpile(src, { strict: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.errors.join("\n")).toMatch(/':=' cannot give 'x', a number, a string \[type\]/);
  });
});

describe("literal type check against the recorded false accepts", () => {
  // tests/negative/false_accepts.json, category static-type: scripts TradingView refuses for a type
  // error and resin accepts. The ones this check sees are refused under strict; the rest need
  // inferred types (docs/design/typed-ir.md). The list of unseen ones may only shrink.
  const UNSEEN = ["fa_input_int_default_is_string", "fa_plot_series_is_string", "fa_str_format_pattern_is_number"];

  it("sees every static-type false accept except the listed ones", () => {
    const all = JSON.parse(readFileSync(join(__dirname, "..", "negative", "false_accepts.json"), "utf-8"));
    const rows: { id: string; category: string; source: string }[] = Array.isArray(all) ? all : all.cases ?? all.scripts;
    const unseen: string[] = [];
    for (const row of rows.filter((r) => r.category === "static-type")) {
      let found = 0;
      try {
        found = checkTypes(parse(row.source)).length;
      } catch {
        found = 0;
      }
      if (found === 0) unseen.push(row.id);
    }
    expect(unseen.sort()).toEqual([...UNSEEN].sort());
  });
});

describe("literal type check on resin's own cases", () => {
  // Cases written against pine2py, which kept a color as its hex text and str.match as a bool: they
  // assign a color to a `var string` (color_*) or the string str.match returns to a `var bool`
  // (str_match). TradingView refuses both; the cases keep replaying, with the warning. The counts
  // may only fall.
  const EXTENSIONS: Record<string, number> = {
    "color_basic.pine": 27,
    "color_from_gradient_kwargs.pine": 3,
    "color_literal.pine": 3,
    "color_new_kwarg.pine": 3,
    "str_match.pine": 14,
  };

  it("finds nothing in oracle/cases beyond the recorded extension", () => {
    const dir = join(__dirname, "..", "..", "oracle", "cases");
    const seen: Record<string, number> = {};
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".pine")).sort()) {
      const src = readFileSync(join(dir, file), "utf-8");
      if (!transpile(src).ok) continue;
      const n = checkTypes(parse(src)).length;
      if (n > 0) seen[file] = n;
    }
    expect(seen).toEqual(EXTENSIONS);
  });
});
