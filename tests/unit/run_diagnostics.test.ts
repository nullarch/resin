// RunResult.warnings: what the data and options did that did not stop the run but changes what it
// means. Each of these used to produce a normal-looking result and no signal.
import { describe, expect, it } from "vitest";
import { run, transpile, type AnalyzeOptions } from "../../src/index";
import type { ContextOptions } from "../../src/runtime/context";
import { makeSyntheticOHLCV } from "../helpers/synthetic";

function go(source: string, opts: ContextOptions = {}, data = makeSyntheticOHLCV(40, 3), tpOpts: AnalyzeOptions = { chartTf: "60" }) {
  const r = transpile(`//@version=6\nindicator("t")\n${source}\n`, tpOpts);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return run(r, data, opts);
}

describe("RunResult.warnings", () => {
  it("is empty for a clean run (hourly bars compiled for chartTf 60)", () => {
    expect(go("plot(close)").warnings).toEqual([]);
  });

  it("flags bars that are not the timeframe the script was compiled for", () => {
    // Hourly bars, default chartTf 'D': every timeframe.* value is computed for the wrong chart.
    const w = go("plot(close)", {}, undefined, {}).warnings;
    expect(w.some((m) => /3600 s apart.*chartTf 'D'/.test(m)), w.join("\n")).toBe(true);
  });

  it("flags time given in seconds, out of order, and an inverted high/low", () => {
    const base = makeSyntheticOHLCV(10, 1);
    const seconds = { ...base, time: base.time.map((t) => t / 1000) };
    expect(go("plot(close)", {}, seconds).warnings.join("\n")).toMatch(/looks like seconds/);

    const shuffled = { ...base, time: base.time.slice() };
    [shuffled.time[3], shuffled.time[4]] = [shuffled.time[4]!, shuffled.time[3]!];
    expect(go("plot(close)", {}, shuffled).warnings.join("\n")).toMatch(/not strictly increasing at bar 4/);

    const inverted = { ...base, high: base.high.slice() };
    inverted.high[2] = inverted.low[2]! - 1;
    expect(go("plot(close)", {}, inverted).warnings.join("\n")).toMatch(/bar 2 has high < low/);
  });

  it("refuses arrays of different lengths instead of reading past the short one", () => {
    const base = makeSyntheticOHLCV(10, 1);
    expect(() => go("plot(close)", {}, { ...base, volume: base.volume.slice(0, 9) })).toThrow(/differ in length: close has 10 bars, volume has 9/);
    expect(() => go("plot(close)", {}, { ...base, time: base.time.slice(0, 5) })).toThrow(/time has 5/);
  });

  it("flags an input override that matches no input title, and one of the wrong type", () => {
    const src = 'len = input.int(5, "Length")\nplot(ta.sma(close, len))';
    expect(go(src, { inputs: { Length: 3 } }).warnings).toEqual([]);
    expect(go(src, { inputs: { Lenght: 3 } }).warnings.join("\n")).toMatch(/'Lenght' matched no input/);
    expect(go(src, { inputs: { Length: "3" } }).warnings.join("\n")).toMatch(/'Length' is a string, but this input takes a number/);
  });

  it("flags a security request for a named symbol that has no feed", () => {
    const src = 'x = request.security("NYSE:SPY", "60", close)\nplot(x)';
    expect(go(src).warnings.join("\n")).toMatch(/reads 'NYSE:SPY' but .* no feed/);
    const bars = makeSyntheticOHLCV(40, 3);
    const feed = { ...bars, timeframe: "60" };
    expect(go(src, { security: { "NYSE:SPY": feed } }).warnings.join("\n")).not.toMatch(/NYSE:SPY/);
  });

  it("flags a ContextOptions key it does not read", () => {
    expect(go("plot(close)", { inptus: {} } as never).warnings).toEqual(["option 'inptus' is not read by resin and was ignored"]);
  });

  it("reports each message once however many bars repeat it", () => {
    const src = 'len = input.int(5, "Length")\nplot(ta.sma(close, len))';
    const w = go(src, { inputs: { Length: "3" } }).warnings;
    expect(w.filter((m) => m.includes("'Length' is a string"))).toHaveLength(1);
  });
});
