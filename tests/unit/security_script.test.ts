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

// A stateful function: outside the prepass grammar, so the requested context runs the script.
const SUM_UDF_TOP = "f(x) =>\n    var float s = 0.0\n    s := s + x\n    s";

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

  // ref_v6_lang.txt timeframe.period: "The variable's value represents the timeframe of a requested
  // dataset when used in the `expression` argument of a `request.*()` function call. Otherwise, its
  // value represents the script's main timeframe"; timeframe.main_period "does not change when used
  // in the `expression` argument". Values against the oracle: resin-harness suites/lang/probes/L41.json.
  it("timeframe.* in the slice is the requested timeframe's; timeframe.main_period and the chart's own reads stay the chart's", () => {
    const result = transpile(
      [
        "var float d = 0.0",
        "d := timeframe.isdaily ? d + close : d",
        "var float m = 0.0",
        'm := timeframe.main_period == "480" ? m + 1 : m',
        'a = request.security(syminfo.tickerid, "D", d)',
        'c = request.security(syminfo.tickerid, "D", ta.cum(close))',
        'k = request.security(syminfo.tickerid, "D", m)',
        'n = request.security(syminfo.tickerid, "D", ta.cum(1))',
        'x = request.security(syminfo.tickerid, "D", timeframe.multiplier)',
        "plot(a)",
        "plot(c)",
        "plot(d)",
        "plot(k)",
        "plot(n)",
        "plot(x)",
        "plot(timeframe.multiplier)",
      ].join("\n"),
      { chartTf: "480" },
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.code).toContain("runSecurityScript");
    const [a, c, d, k, n, x, chartM] = run(result, DATA).plots.map((p) => Array.from(p.values));
    expect(a).toEqual(c);
    expect(a!.some((v) => Number.isFinite(v))).toBe(true);
    expect(d!.every((v) => v === 0)).toBe(true);
    expect(k).toEqual(n);
    expect(k!.some((v) => Number.isFinite(v))).toBe(true);
    expect(x!.filter((v) => Number.isFinite(v)).every((v) => v === 1)).toBe(true);
    expect(chartM!.every((v) => v === 480)).toBe(true);
  });

  it("the prepass reads the timeframe.* flags of the requested timeframe too", () => {
    const result = transpile(
      ['w = request.security(syminfo.tickerid, "D", timeframe.isdaily ? close : -close)', 'c = request.security(syminfo.tickerid, "D", close)', "plot(w)", "plot(c)"].join("\n"),
      { chartTf: "480" },
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.code).not.toContain("runSecurityScript");
    const [w, c] = run(result, DATA).plots.map((p) => Array.from(p.values));
    expect(w).toEqual(c);
    expect(w!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("an empty timeframe known only when the script runs is the chart's there (input.timeframe(\"\"))", () => {
    const result = transpile(
      ['tf = input.timeframe("", "TF")', "w = request.security(syminfo.tickerid, tf, timeframe.isdaily ? close : -close)", "plot(w)"].join("\n"),
      { chartTf: "480" },
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const [w] = run(result, DATA).plots.map((p) => Array.from(p.values));
    expect(w!.filter((v) => Number.isFinite(v)).every((v) => v < 0)).toBe(true);
    expect(w!.some((v) => Number.isFinite(v))).toBe(true);
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

  it("a name a tuple declaration declares holds its element, not the tuple (resin-harness suites/lang/probes/L36.json)", () => {
    const [d, dWant, m, mWant] = plotsOf(
      [
        "f() => [close - open, str.tostring(close)]",
        "[d, s] = f()",
        "[m, sg, hist] = ta.macd(close, 2, 3, 2)",
        'a = request.security(syminfo.tickerid, "D", d[1])',
        'b = request.security(syminfo.tickerid, "D", (close - open)[1])',
        'c = request.security(syminfo.tickerid, "D", m)',
        'e = request.security(syminfo.tickerid, "D", ta.ema(close, 2) - ta.ema(close, 3))',
        "plot(a)",
        "plot(b)",
        "plot(c)",
        "plot(e)",
      ].join("\n"),
    );
    expect(d).toEqual(dWant);
    expect(d!.some((v) => Number.isFinite(v))).toBe(true);
    expect(m).toEqual(mWant);
    expect(m!.some((v) => Number.isFinite(v))).toBe(true);
  });

  // Without dynamic requests (v5's default) the child reads another request as the chart computed it,
  // paired with the requested bars (concepts_other-timeframes-and-data.txt "Nested requests";
  // checked against the oracle by resin-harness suites/lang/probes/L37.json).
  it("a nested request through a variable: each requested bar reads the inner request's last bar closed by then", () => {
    // The 8-hour request's last bar of each day closes with the day: the day's close.
    const [nested, direct, chart] = plotsOf(
      [
        SUM_UDF_TOP,
        'a = request.security(syminfo.tickerid, "480", close)',
        "b = f(a) + 0",
        'r = request.security(syminfo.tickerid, "D", b)',
        'w = request.security(syminfo.tickerid, "D", f(close) + 0)',
        "plot(r)",
        "plot(w)",
        "plot(b)",
      ].join("\n"),
    );
    expect(nested).toEqual(direct);
    expect(nested!.some((v) => Number.isFinite(v))).toBe(true);
    // The chart's own b sums the 8-hour closes: the requested context's is its own.
    expect(chart).not.toEqual(nested);
  });

  it("a nested request with gaps on is na on the requested bars where no new bar of it closed", () => {
    // A daily request read by 8-hour bars: a new day closes on every third bar only.
    const [got] = plotsOf(
      [
        SUM_UDF_TOP,
        'd = request.security(syminfo.tickerid, "D", close, barmerge.gaps_on)',
        "b = f(nz(d, 0)) + 0",
        'r = request.security(syminfo.tickerid, "480", b, lookahead = barmerge.lookahead_on)',
        "plot(r)",
      ].join("\n"),
    );
    // Day closes 103, 109, 114, 119: the running sum grows on the day's last bar only.
    expect(got).toEqual([0, 0, 103, 103, 103, 212, 212, 212, 326, 326, 326, 445]);
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

  // concepts_other-timeframes-and-data.txt "Requestable data": request.security "can retrieve values
  // of any fundamental type ( int , float , bool , color , or string )". Values against the oracle:
  // resin-harness suites/lang/probes/L42.json (var strings under if chains, a color, history on the
  // call and on its variable, requests in functions).
  it("a string value: the child records it as it is, the chart reads it with na null", () => {
    const source = [
      "s = str.tostring(close)",
      'r = request.security(syminfo.tickerid, "D", s)',
      'c = request.security(syminfo.tickerid, "D", close)',
      "p = r[1]",
      "plot(na(r) ? -1 : str.tonumber(r))",
      "plot(na(c) ? -1 : c)",
      "plot(na(p) ? -1 : str.tonumber(p))",
      "plot(na(c[1]) ? -1 : c[1])",
    ].join("\n");
    const result = transpile(source);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.code).toContain("rt.security.scriptText(");
    expect(result.code).toContain("rt.security.getTextFromArray(");
    const [r, c, p, c1] = run(result, DATA).plots.map((q) => Array.from(q.values));
    expect(r).toEqual(c);
    expect(r).toContain(-1);
    expect(r!.some((v) => v > 0)).toBe(true);
    expect(p).toEqual(c1);
  });

  it("a string element of a tuple declaration and a color", () => {
    const [s, want, k] = plotsOf(
      [
        "f() => [str.tostring(close), close]",
        "[s, x] = f()",
        "var color col = color.red",
        "if close > open",
        "    col := color.green",
        'r = request.security(syminfo.tickerid, "D", s)',
        'c = request.security(syminfo.tickerid, "D", x)',
        'k = request.security(syminfo.tickerid, "D", col)',
        "plot(na(r) ? -1 : str.tonumber(r))",
        "plot(na(c) ? -1 : c)",
        "plot(na(k) ? -1 : k == color.green ? 1 : 0)",
      ].join("\n"),
    );
    expect(s).toEqual(want);
    // On the daily bars col turns green on the first (close 103 > open 100) and, var, stays green;
    // the chart reads a day once it has closed.
    expect(k).toEqual([-1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  // One call of a function evaluates every request in its body, so the child of its first request
  // reads the second before that one's child ran: na there, and never what the child records.
  it("two requests in one function, each evaluated by its child", () => {
    const [got, want] = plotsOf(
      [
        "var float acc = 0.0",
        "acc := acc + (close - open)",
        "var float hi = 0.0",
        "hi := math.max(hi, high)",
        "g() =>",
        '    a = request.security(syminfo.tickerid, "D", acc)',
        '    b = request.security(syminfo.tickerid, "D", hi)',
        "    a - b",
        "plot(g())",
        'plot(request.security(syminfo.tickerid, "D", ta.cum(close - open)) - request.security(syminfo.tickerid, "D", ta.max(high)))',
      ].join("\n"),
    );
    expect(got).toEqual(want);
    expect(got!.some((v) => Number.isFinite(v))).toBe(true);
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

  it("a nested request that, with dynamic requests (v6), names the context it runs in (disputed, resin-harness D11)", () => {
    const errors = errorsOf(
      ["//@version=6", SUM_UDF, 'a = request.security(syminfo.tickerid, "480", close)', "b = f(a) + 0", 'r = request.security(syminfo.tickerid, "D", b)'].join("\n"),
    );
    expect(errors.some((e) => e.includes("with dynamic requests, may run in the requested context's symbol or timeframe"))).toBe(true);
  });

  it("a nested request whose timeframe is bound on its first execution", () => {
    const errors = errorsOf(
      [
        SUM_UDF,
        'tf = bar_index > 5 ? "D" : "480"',
        "a = request.security(syminfo.tickerid, tf, close)",
        "b = f(a) + 0",
        'r = request.security(syminfo.tickerid, "D", b)',
      ].join("\n"),
    );
    expect(errors.some((e) => e.includes("bound on its first execution"))).toBe(true);
  });

  it("a timeframe.*() call in the slice (timeframe.change reads the chart's timeframe)", () => {
    const errors = errorsOf([SUM_UDF, 't = timeframe.change("W") ? close : 0.0', 'r = request.security(syminfo.tickerid, "D", f(t) + 0)'].join("\n"));
    expect(errors.some((e) => e.includes("it calls timeframe.*()"))).toBe(true);
  });

  it("a bare scalar UDF call it cannot plan keeps C436's chart-bar passthrough (the status quo; not the requested context's value)", () => {
    const result = transpile(['f(x) => timeframe.change("W") ? x : 0.0', 'r = request.security(syminfo.tickerid, "D", f(close))'].join("\n"));
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

  it("an object value", () => {
    const errors = errorsOf(['a = array.from(close)', 'r = request.security(syminfo.tickerid, "D", a)'].join("\n"));
    expect(errors.some((e) => e.includes("requesting a tuple or object value is not implemented"))).toBe(true);
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

  it("a sibling request in the function reads its own data in the child, the child's own request nothing, and both read their own requests on the chart", () => {
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
    expect(result.code).toContain(
      "fast = ($.secCapture >= 0 && $.securityCache[0] === undefined ? NaN : rt.security.getFromArray($.securityExprCache[0]",
    );
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

  it("the strategy's state in the request's own expression", () => {
    const errors = errorsOf(
      ['strategy("s")', SUM_UDF, 'f(v) => request.security(syminfo.tickerid, "D", g(v) + strategy.position_size)', "a = f(close)"].join("\n"),
    );
    expect(errors.some((e) => e.includes("the function reads the strategy's state"))).toBe(true);
  });

  it("an argument that, with dynamic requests (v6), depends on a request naming the context it runs in (disputed, resin-harness D11)", () => {
    const errors = errorsOf(
      [
        "//@version=6",
        SUM_UDF,
        'a = request.security(syminfo.tickerid, "480", close)',
        'f(v) => request.security(syminfo.tickerid, "D", g(v) * 2)',
        "x = f(a)",
      ].join("\n"),
    );
    expect(errors.some((e) => e.includes("with dynamic requests, may run in the requested context's symbol or timeframe"))).toBe(true);
  });
});

describe("request.security in a user-defined function: an argument that depends on another request", () => {
  const SUM_UDF = "g(x) =>\n    var float s = 0.0\n    s := s + x\n    s";

  it("without dynamic requests the call's child reads it paired with the requested bars (resin-harness suites/lang/probes/L37.json)", () => {
    const [x, want] = plotsOf(
      [
        SUM_UDF,
        'a = request.security(syminfo.tickerid, "480", close)',
        'f(v) => request.security(syminfo.tickerid, "D", g(v) * 2)',
        "x = f(a)",
        'w = request.security(syminfo.tickerid, "D", g(close) * 2)',
        "plot(x)",
        "plot(w)",
      ].join("\n"),
    );
    expect(x).toEqual(want);
    expect(x!.some((v) => Number.isFinite(v))).toBe(true);
  });
});

// A function whose request's timeframe is known only when it runs: each call of the function binds
// its own request on its first execution (concepts_other-timeframes-and-data.txt "In local scopes";
// mig6.txt "Dynamic requests"). Values against the oracle: resin-harness suites/lang/probes/L38.json.
describe("request.security in a user-defined function: a timeframe known only when the call runs", () => {
  it("each call binds its own request: the same values as the literal timeframe's request, bare, prepass and requested-context forms", () => {
    const [b1, b2, e1, s1, wb, we, ws] = plotsOf(
      [
        'tfIn = input.timeframe("D", "tf")',
        "fb(tf) =>",
        '    t = tf == "" ? "480" : tf',
        "    request.security(syminfo.tickerid, t, close)",
        "fe(tf) =>",
        '    string t = "D"',
        '    if tf != ""',
        "        t := tf",
        "    request.security(syminfo.tickerid, t, ta.ema(close, 2))",
        "fs(tf, len) =>",
        '    safe_tf = tf == "" ? timeframe.period : tf',
        "    request.security(syminfo.tickerid, safe_tf, ta.sma(close, len) + len)",
        "b1 = fb(tfIn)",
        'b2 = fb("")',
        "e1 = fe(tfIn)",
        "s1 = fs(tfIn, 2)",
        's0 = fs("D", 3)',
        'wb = request.security(syminfo.tickerid, "480", close)',
        'we = request.security(syminfo.tickerid, "D", ta.ema(close, 2))',
        'ws = request.security(syminfo.tickerid, "D", ta.sma(close, 2) + 2)',
        "plot(b1)",
        "plot(b2)",
        "plot(e1)",
        "plot(s1)",
        "plot(wb)",
        "plot(we)",
        "plot(ws)",
      ].join("\n"),
    );
    const [lb1] = plotsOf('plot(request.security(syminfo.tickerid, "D", close))');
    expect(b1).toEqual(lb1);
    expect(b2).toEqual(wb);
    expect(e1).toEqual(we);
    expect(s1).toEqual(ws);
    expect(b1).not.toEqual(b2);
    expect(s1!.some((v) => Number.isFinite(v))).toBe(true);
  });

  it("a call whose timeframe changes on a later execution is refused at run time, as outside functions", () => {
    const result = transpile(
      ['getS(tf) =>', "    request.security(syminfo.tickerid, tf, close)", 'x = getS(bar_index < 3 ? "D" : "480")', "plot(x)"].join("\n"),
    );
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(() => run(result, DATA)).toThrow(/the timeframe of a request changed from "D" to "480"/);
  });

  it("a function no executed code calls, directly or through another such function, makes no request: the script runs", () => {
    const [c] = plotsOf(
      [
        "req(tf, source) =>",
        '    resolvedTf = tf != "" ? tf : timeframe.period',
        "    request.security(syminfo.tickerid, resolvedTf, source)",
        "wrap(tf, source) =>",
        "    req(tf, source)",
        "plot(close)",
      ].join("\n"),
    );
    expect(c).toEqual(Array.from(DATA.close));
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
