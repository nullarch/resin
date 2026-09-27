// request.security whose expression the script itself computes in the requested context
// (transpiler/analyzer/security-script.ts, Context.runSecurityScript): concepts_other-timeframes-and-data.txt
// "Declared variables": "the function call duplicates all preceding code that determines the
// assigned value or reference". The values are checked against the oracle by resin-harness
// state/repros/security-script-*.json; these cases pin what resin does with the construct: the
// child's slice runs on the requested bars with state of its own, the chart reads its result as it
// reads a prepass's, and what the child cannot reproduce is refused.
import { describe, it, expect } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { compile, run } from "../../src/runtime/engine";
import { Context, type OHLCVData } from "../../src/runtime/context";
import { rt } from "../../src/runtime/rt";

// 8-hour bars from 2024-01-01 00:00 UTC: three per day, so "D" aggregates them.
const DATA: OHLCVData = {
  open: [100, 102, 101, 105, 108, 106, 110, 113, 111, 115, 114, 118],
  high: [103, 105, 102, 108, 110, 108, 112, 115, 113, 117, 116, 120],
  low: [99, 100, 100, 103, 106, 104, 108, 111, 109, 113, 112, 116],
  close: [102, 101, 103, 106, 107, 109, 111, 112, 114, 116, 115, 119],
  volume: [1000, 1100, 1050, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450, 1600],
  time: Array.from({ length: 12 }, (_, i) => 1704067200000 + i * 8 * 3600_000),
};

function plotsOf(source: string, data: OHLCVData = DATA): number[][] {
  const result = transpile(source);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return run(result, data).plots.map((p) => Array.from(p.values));
}

function errorsOf(source: string): string[] {
  const result = transpile(source);
  return result.ok ? [] : result.errors;
}

describe("request.security evaluated in the requested context", () => {
  it("a 'var' accumulator runs on the requested bars: equals ta.cum of the same term there", () => {
    const [acc, cum] = plotsOf(
      [
        "var float acc = 0.0",
        "acc := acc + (close - open)",
        'a = request.security(syminfo.tickerid, "D", acc)',
        'c = request.security(syminfo.tickerid, "D", ta.cum(close - open))',
        "plot(a)",
        "plot(c)",
      ].join("\n"),
    );
    expect(acc).toEqual(cum);
    expect(acc!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("the chart's own state is untouched by the requested context's run", () => {
    const [chartAcc] = plotsOf(
      ["var float acc = 0.0", "acc := acc + 1", 'a = request.security(syminfo.tickerid, "D", acc)', "plot(acc)"].join("\n"),
    );
    expect(chartAcc).toEqual(Array.from(DATA.close, (_, i) => i + 1));
  });

  it("a stateful call under a condition advances only on the requested bars where the condition holds there", () => {
    // ta.sma(close, 2) runs on the daily bars whose close is above their open, and is held otherwise.
    const [got, want] = plotsOf(
      [
        "float v = na",
        "if close > open",
        "    v := ta.sma(close, 2)",
        'g = request.security(syminfo.tickerid, "D", v)',
        'w = request.security(syminfo.tickerid, "D", close > open ? ta.sma(close, 2) : na)',
        "plot(g)",
        "plot(w)",
      ].join("\n"),
    );
    expect(got).toEqual(want);
  });

  it("a call in a local block is hoisted: it reads what the same call at the top level reads", () => {
    const [inBlock, top] = plotsOf(
      [
        "f(x) => ta.ema(x, 2)",
        "float b = na",
        "if bar_index % 2 == 0",
        '    b := request.security(syminfo.tickerid, "D", f(close))',
        "else",
        '    b := request.security(syminfo.tickerid, "D", f(close))',
        't = request.security(syminfo.tickerid, "D", f(close))',
        "plot(b)",
        "plot(t)",
      ].join("\n"),
    );
    expect(inBlock).toEqual(top);
  });

  it("time_close in the requested context is the requested bar's close", () => {
    const [got, want] = plotsOf(
      ['tc = time_close', 'g = request.security(syminfo.tickerid, "D", tc)', 'w = request.security(syminfo.tickerid, "D", time_close)', "plot(g)", "plot(w)"].join("\n"),
    );
    expect(got).toEqual(want);
    expect(got!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("the requested context's log output is silent: only the chart's bars log", () => {
    const source = [
      "var float v = 0.0",
      "if close > open",
      '    log.info("up")',
      "    v := close",
      'r = request.security(syminfo.tickerid, "D", v)',
    ].join("\n");
    const result = transpile(source);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const saved = rt.logInfo;
    let calls = 0;
    rt.logInfo = (...args: unknown[]) => {
      calls++;
      return saved(...args);
    };
    try {
      run(result, DATA);
    } finally {
      rt.logInfo = saved;
    }
    expect(calls).toBe(Array.from(DATA.close).filter((c, i) => c > DATA.open[i]!).length);
  });

  it("a module instantiated without engine.compile cannot run a requested context, and says so", () => {
    const result = transpile(['f(x) => x + 1', 'r = request.security(syminfo.tickerid, "D", f(close))'].join("\n"));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const ctx = Context.from(result, DATA);
    const factory = new Function("$", "rt", result.code) as (c: Context, r: typeof rt) => () => void;
    expect(() => factory(ctx, rt)).toThrow(/engine\.compile/);
    // Through compile() it runs.
    expect(() => compile(result.code)(Context.from(result, DATA))).not.toThrow();
  });
});

describe("request.security in the requested context: what is refused", () => {
  // A stateful function: outside the prepass grammar, so the requested context runs the script.
  const SUM_UDF = "f(x) =>\n    var float s = 0.0\n    s := s + x\n    s";

  it("a variable the script changes after the call, whose value reaches later bars (disputed, resin-harness D9)", () => {
    const errors = errorsOf(["var int counter = 0", 'r = request.security(syminfo.tickerid, "D", counter)', "counter += 1"].join("\n"));
    expect(errors.some((e) => e.includes("the script changes 'counter', which the expression reads, after the call"))).toBe(true);
  });

  it("but not a change no later bar can see (a '=' variable read without history)", () => {
    expect(errorsOf(["x = close", 'r = request.security(syminfo.tickerid, "D", x)', "x := open"].join("\n"))).toEqual([]);
  });

  it("a history read turns that change into one a later bar sees", () => {
    const errors = errorsOf(["x = close", 'r = request.security(syminfo.tickerid, "D", x[1])', "x := open"].join("\n"));
    expect(errors.some((e) => e.includes("the script changes 'x'"))).toBe(true);
  });

  it("x := request.security(..., x) itself", () => {
    const errors = errorsOf(["var float x = 0.0", 'x := request.security(syminfo.tickerid, "D", x + 1)'].join("\n"));
    expect(errors.some((e) => e.includes("the script changes 'x'"))).toBe(true);
  });

  it("a nested request through a variable", () => {
    const errors = errorsOf(
      [SUM_UDF, 'a = request.security(syminfo.tickerid, "W", close)', "b = f(a) + 0", 'r = request.security(syminfo.tickerid, "D", b)'].join("\n"),
    );
    expect(errors.some((e) => e.includes("it depends on another request.*() call"))).toBe(true);
  });

  it("timeframe.* in the slice (the requested context's timeframe is not implemented)", () => {
    const errors = errorsOf([SUM_UDF, "t = timeframe.isdaily ? close : 0.0", 'r = request.security(syminfo.tickerid, "D", f(t) + 0)'].join("\n"));
    expect(errors.some((e) => e.includes("it reads timeframe.*"))).toBe(true);
  });

  it("a bare scalar UDF call it cannot plan keeps C436's chart-bar passthrough (the status quo; not the requested context's value)", () => {
    const result = transpile(["f(x) => timeframe.isdaily ? x : 0.0", 'r = request.security(syminfo.tickerid, "D", f(close))'].join("\n"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).not.toContain("runSecurityScript");
  });

  it("the strategy's state in the slice", () => {
    const errors = errorsOf(
      [
        'strategy("s")',
        "var float s = 0.0",
        "s := s + strategy.position_size",
        'r = request.security(syminfo.tickerid, "D", s)',
      ].join("\n"),
    );
    expect(errors.some((e) => e.includes("it reads the strategy's state"))).toBe(true);
  });

  it("a string value", () => {
    const errors = errorsOf(['s = str.tostring(close)', 'r = request.security(syminfo.tickerid, "D", s)'].join("\n"));
    expect(errors.some((e) => e.includes("requesting a string value is not implemented"))).toBe(true);
  });

  it("a block whose own statement changes what the expression reads", () => {
    const errors = errorsOf(["x = close", "if close > open", "    x := open", '    r = request.security(syminfo.tickerid, "D", x)'].join("\n"));
    expect(errors.some((e) => e.includes("the call is in a local block whose statement also changes 'x'"))).toBe(true);
  });

  it("an object the script changes after the call through another name (aliasing)", () => {
    const errors = errorsOf(
      [
        "var a = array.new_float(0)",
        "b = a",
        "if array.size(a) < 3",
        "    array.push(a, close)",
        'r = request.security(syminfo.tickerid, "D", array.size(a))',
        "array.push(b, 1.0)",
      ].join("\n"),
    );
    expect(errors.some((e) => e.includes("after the call"))).toBe(true);
  });
});

// A request in a user-defined function (analyzer/security-script.ts planSecurityScriptInFunction):
// concepts_other-timeframes-and-data.txt "In local scopes": "the Pine Script compiler extracts such
// calls into the global scope during translation". Every call of the function is a request of its
// own: its child evaluates the call where the call's statement begins, and the function records the
// expression for it. Checked against the oracle by resin-harness suites/lang/probes/L34.json.
describe("request.security in a user-defined function, evaluated in the requested context", () => {
  const SUM_UDF = "g(x) =>\n    var float s = 0.0\n    s := s + x\n    s";

  it("each call is its own request of its argument: equal to the top-level request of that argument", () => {
    const [a, b, ta, tb] = plotsOf(
      [
        SUM_UDF,
        'f(v) => request.security(syminfo.tickerid, "D", v)',
        "a = f(g(close))",
        "b = f(g(open))",
        'ta = request.security(syminfo.tickerid, "D", g(close))',
        'tb = request.security(syminfo.tickerid, "D", g(open))',
        "plot(a)",
        "plot(b)",
        "plot(ta)",
        "plot(tb)",
      ].join("\n"),
    );
    expect(a).toEqual(ta);
    expect(b).toEqual(tb);
    expect(a).not.toEqual(b);
    expect(a!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("the function's code before the request runs there with the call's own state (a var accumulator)", () => {
    const [got, want] = plotsOf(
      [
        "f(x) =>\n    var float s = 0.0\n    s := s + x\n    request.security(syminfo.tickerid, \"D\", s)",
        "var float acc = 0.0",
        "acc := acc + (close - open)",
        "a = f(close - open)",
        'w = request.security(syminfo.tickerid, "D", acc)',
        "plot(a)",
        "plot(w)",
      ].join("\n"),
    );
    expect(got).toEqual(want);
    expect(got!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("a sibling request in the function reads nothing in the child, and both read their own requests on the chart", () => {
    const source = [
      SUM_UDF,
      "trend() =>",
      '    fast = request.security(syminfo.tickerid, "D", ta.ema(close, 2))',
      "    e = g(close - open)",
      '    d = request.security(syminfo.tickerid, "D", e)',
      "    [fast, d]",
      "[a, b] = trend()",
      'ta = request.security(syminfo.tickerid, "D", ta.ema(close, 2))',
      'tb = request.security(syminfo.tickerid, "D", g(close - open))',
      "plot(a)",
      "plot(b)",
      "plot(ta)",
      "plot(tb)",
    ].join("\n");
    const result = transpile(source);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.code).toContain("fast = ($.secCapture >= 0 ? NaN : rt.security.getFromArray($.securityExprCache[0]");
    const [a, b, ta, tb] = plotsOf(source);
    expect(a).toEqual(ta);
    expect(b).toEqual(tb);
    expect(b!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("the function's own state on the chart is untouched by the children's runs", () => {
    const [chartSum] = plotsOf(
      ["f(x) =>\n    var float s = 0.0\n    s := s + x\n    r = request.security(syminfo.tickerid, \"D\", s)\n    s", "plot(f(1.0))"].join("\n"),
    );
    expect(chartSum).toEqual(Array.from(DATA.close, (_, i) => i + 1));
  });
});

// The expressions below are no bare function call, which C436's chart-bar passthrough would take
// instead (the status quo where the requested context is refused).
describe("request.security in a user-defined function: what the requested context refuses", () => {
  const SUM_UDF = "g(x) =>\n    var float s = 0.0\n    s := s + x\n    s";

  it("a call of the function from another function", () => {
    const errors = errorsOf([SUM_UDF, 'f(v) => request.security(syminfo.tickerid, "D", v)', "w() => f(g(close))", "x = w()"].join("\n"));
    expect(errors.some((e) => e.includes("the function is called from another function"))).toBe(true);
  });

  it("a variable the function changes after the request, which its next call sees (disputed, resin-harness D9)", () => {
    const errors = errorsOf(
      ["f(x) =>\n    var float s = 0.0\n    r = request.security(syminfo.tickerid, \"D\", s)\n    s := s + x\n    r", "a = f(close)"].join("\n"),
    );
    expect(errors.some((e) => e.includes("the function changes 's', which the expression reads, after the call"))).toBe(true);
  });

  it("the strategy's state anywhere in the function (the child runs all of it)", () => {
    const errors = errorsOf(
      [
        'strategy("s")',
        SUM_UDF,
        "f(v) =>\n    p = strategy.position_size\n    request.security(syminfo.tickerid, \"D\", g(v) * 2) + p * 0",
        "a = f(close)",
      ].join("\n"),
    );
    expect(errors.some((e) => e.includes("the function reads the strategy's state"))).toBe(true);
  });

  it("an argument that depends on another request (a nested request)", () => {
    const errors = errorsOf(
      [SUM_UDF, 'a = request.security(syminfo.tickerid, "W", close)', 'f(v) => request.security(syminfo.tickerid, "D", g(v) * 2)', "x = f(a)"].join("\n"),
    );
    expect(errors.some((e) => e.includes("it depends on another request.*() call"))).toBe(true);
  });
});

describe("rt.security.scriptValue", () => {
  it("numbers as they are, bools as 1/0, na as NaN, anything else stops the run", () => {
    expect(rt.security.scriptValue(1.5)).toBe(1.5);
    expect(rt.security.scriptValue(true)).toBe(1);
    expect(rt.security.scriptValue(false)).toBe(0);
    expect(rt.security.scriptValue(null)).toBeNaN();
    expect(() => rt.security.scriptValue("x")).toThrow(/not a number or a bool/);
  });
});
