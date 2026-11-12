// The signature table (src/transpiler/builtins/signatures.ts, generated from the oracle's library)
// and the call check built on it (builtins/check.ts).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { transpile } from "../../src";
import { BUILTIN_SIGNATURES } from "../../src/transpiler/builtins/signatures";
import { checkBuiltinCalls } from "../../src/transpiler/builtins/check";
import { parse } from "../../src/transpiler/parser";
import { TA_REGISTRY } from "../../src/transpiler/analyzer/ta";
import { ARRAY_KWARG_PARAM_NAMES, STR_KWARG_PARAM_NAMES } from "../../src/transpiler/analyzer/collections";
import { COLOR_KWARG_PARAM_NAMES, MATH_KWARG_PARAM_NAMES, TICKER_KWARG_PARAM_NAMES } from "../../src/transpiler/analyzer/call-expr";

const findings = (body: string, version = 6): string[] =>
  checkBuiltinCalls(parse(`//@version=${version}\nindicator("t")\n${body}\n`)).map((f) => `${f.kind} ${f.name}`);

describe("built-in call check", () => {
  it("accepts calls the signature allows", () => {
    expect(findings("plot(ta.sma(close, 14))")).toEqual([]);
    expect(findings("plot(ta.sma(source=close, length=14))")).toEqual([]);
    expect(findings("plot(ta.stdev(close, 14, false))")).toEqual([]);
    expect(findings("plot(ta.highest(14))")).toEqual([]); // the source-less overload
    expect(findings("l = label.new(bar_index, close, \"x\")\nplot(1)")).toEqual([]);
    expect(findings("plot(math.max(1, 2, 3, 4, 5))")).toEqual([]); // variadic
  });

  it("reports a keyword the function does not have", () => {
    expect(findings("plot(ta.sma(close, len=14))")).toEqual(["unknown-keyword ta.sma", "missing-argument ta.sma"]);
  });

  it("reports more positional arguments than any overload takes", () => {
    expect(findings("plot(ta.sma(close, 14, 3))")).toEqual(["too-many-arguments ta.sma"]);
  });

  it("reports a required parameter left out", () => {
    expect(findings("plot(ta.sma(close))")).toEqual(["missing-argument ta.sma"]);
    expect(findings("l = label.new(bar_index, close)\nlabel.set_text(l)\nplot(1)")).toEqual(["missing-argument label.set_text"]);
    expect(findings("x = ticker.new()\nplot(1)")).toEqual(["missing-argument ticker.new"]);
  });

  // v6 migration guide: "The when parameter is removed from all applicable strategy.*() functions",
  // "The transp parameter is removed from all applicable functions".
  it("takes the parameters v6 removed in a v5 script, and reports them in a v6 one", () => {
    const strat = (v: number, body: string): string[] =>
      checkBuiltinCalls(parse(`//@version=${v}\nstrategy("t")\n${body}\n`)).map((f) => `${f.kind} ${f.name}`);
    expect(strat(5, 'strategy.entry("L", strategy.long, when=close > open)')).toEqual([]);
    expect(strat(6, 'strategy.entry("L", strategy.long, when=close > open)')).toEqual(["unknown-keyword strategy.entry"]);
    expect(findings("bgcolor(color.red, transp=80)", 5)).toEqual([]);
    expect(findings("bgcolor(color.red, transp=80)", 6)).toEqual(["unknown-keyword bgcolor"]);
  });

  it("does not read a name the script declares as a built-in namespace", () => {
    expect(findings("ta = array.new<float>()\nta.push(1.0, 2.0, 3.0)\nplot(1)")).toEqual([]);
    expect(findings("nz(x, y, z) => x + y + z\nplot(nz(1, 2, 3))")).toEqual([]);
  });

  it("is a transpile warning, and an error under strict", () => {
    const src = '//@version=6\nindicator("t")\nplot(ta.sma(close, 14, 3))\n';
    const loose = transpile(src);
    // The analyzer has its own count for ta.sma and refuses first; a call only the table knows shows the warning.
    expect(loose.ok).toBe(false);
    const viaTable = '//@version=6\nindicator("t")\nx = ticker.new()\nplot(1)\n';
    const t = transpile(viaTable);
    if (!t.ok) throw new Error(t.errors.join("; "));
    expect(t.warnings.filter((w) => w.kind === "signature").map((w) => w.name)).toEqual(["ticker.new"]);
    const strict = transpile(viaTable, { strict: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.errors.join("\n")).toMatch(/'ticker\.new' needs 'prefix', 'ticker' \[signature\]/);
  });
});

describe("signature table against resin's own parameter tables", () => {
  const overloadNames = (name: string): string[][] => (BUILTIN_SIGNATURES[name] ?? []).map((o) => o.params.map((p) => p.name));
  // resin's list is a prefix of some overload's parameters, in order.
  const agrees = (name: string, mine: readonly string[]): boolean => overloadNames(name).some((o) => mine.every((m, i) => o[i] === m));

  // Where the two disagree. Each entry is a difference someone has to settle against TradingView;
  // the list may only shrink.
  const KNOWN_NAME_DIFFERENCES: Record<string, string> = {
    // resin: symbol, style, param, source, request_wicks. The oracle has request_wicks before source.
    "ticker.renko": "order of the last two parameters; the stored reference has no ticker.renko entry",
  };

  it("keyword names resin accepts are the oracle's, in order", () => {
    const tables: [string, Readonly<Record<string, readonly string[]>>][] = [
      ["str", STR_KWARG_PARAM_NAMES],
      ["array", ARRAY_KWARG_PARAM_NAMES],
      ["math", MATH_KWARG_PARAM_NAMES],
      ["ticker", TICKER_KWARG_PARAM_NAMES],
      ["color", COLOR_KWARG_PARAM_NAMES],
    ];
    const differ: string[] = [];
    for (const [ns, table] of tables) {
      for (const [method, names] of Object.entries(table)) {
        const name = `${ns}.${method}`;
        if (BUILTIN_SIGNATURES[name] !== undefined && !agrees(name, names)) differ.push(name);
      }
    }
    for (const entry of Object.values(TA_REGISTRY)) {
      if (entry.kwargParamNames !== undefined && BUILTIN_SIGNATURES[entry.displayName] !== undefined && !agrees(entry.displayName, entry.kwargParamNames)) {
        differ.push(entry.displayName);
      }
    }
    expect(differ.sort()).toEqual(Object.keys(KNOWN_NAME_DIFFERENCES).sort());
  });
});

describe("built-in call check on resin's own cases", () => {
  // Calls resin has always run that the signature table does not allow: forms taken over from
  // pine2py (map.get with a default, matrix.sum of one matrix, ta.linreg without its offset, ...).
  // TradingView's reference requires what they leave out. They stay accepted, with the warning, so
  // the goldens that use them keep replaying; the counts may only fall.
  const EXTENSIONS: Record<string, number> = {
    "missing-argument array.slice": 2,
    "missing-argument matrix.diff": 1,
    "missing-argument matrix.sum": 5,
    "missing-argument ta.linreg": 3,
    "missing-argument ta.percentile_linear_interpolation": 1,
    "missing-argument ta.percentile_nearest_rank": 2,
    "missing-argument ticker.kagi": 1,
    "missing-argument ticker.linebreak": 1,
    "missing-argument ticker.new": 2,
    "too-many-arguments map.get": 3,
    "too-many-arguments math.round_to_mintick": 3,
    "too-many-arguments matrix.concat": 1,
    "unknown-keyword request.financial": 1,
  };

  it("finds nothing in oracle/cases beyond the recorded extensions", () => {
    const dir = join(__dirname, "..", "..", "oracle", "cases");
    const seen: Record<string, number> = {};
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".pine")).sort()) {
      const src = readFileSync(join(dir, file), "utf-8");
      if (!transpile(src).ok) continue;
      for (const f of checkBuiltinCalls(parse(src))) seen[`${f.kind} ${f.name}`] = (seen[`${f.kind} ${f.name}`] ?? 0) + 1;
    }
    expect(seen).toEqual(EXTENSIONS);
  });
});
