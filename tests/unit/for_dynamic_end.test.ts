// A `for` loop's `to` bound: fixed on entry up to Pine v5, re-evaluated before every iteration from
// v6 on (mig6.txt "Dynamic for loop boundaries": "In Pine v5, a for loop statement establishes its
// final counter value strictly before starting its iterations" ... "In Pine v6, all for loops
// dynamically evaluate their stopping criteria before each iteration"). Evidence: resin-harness
// suites/lang/probes/L21.json (dyn_end 4 on every bar, the oracle's pynecore core/pine_range.py
// PineLoop, "MEASURED on TradingView").
import { describe, it, expect } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { run } from "../../src/runtime/engine";
import { type OHLCVData } from "../../src/runtime/context";

function runBars(source: string, close: number[]): Record<string, number>[] {
  const result = transpile(source);
  expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  const data: OHLCVData = { open: close, high: close, low: close, close, volume: close };
  const { bars } = run(
    result.code,
    result.varSlots,
    result.taSlotCount,
    data,
    result.fnVarSlotCount,
    result.historySlotCount,
    result.taScratchSize,
  );
  return bars as Record<string, number>[];
}

function observe(version: number, body: string[], close: number[]): number[] {
  const source = [`//@version=${version}`, "var float __obs = na", ...body, "__obs := cnt"].join("\n");
  return runBars(source, close).map((b) => b["var:__obs"]!);
}

// harness lang.probes L21: the body grows the array the bound is read from.
const GROWING = [
  "var arr = array.new<float>()",
  "cnt = 0",
  "arr.clear()",
  "arr.push(1)",
  "for i = 0 to arr.size() - 1",
  "    if arr.size() < 4",
  "        arr.push(1)",
  "    cnt += 1",
];

describe("for loop `to` bound (v5 fixed, v6 dynamic)", () => {
  it("v6 re-reads the bound before every iteration: a body that grows it keeps iterating", () => {
    expect(observe(6, GROWING, [1, 2, 3])).toEqual([4, 4, 4]);
  });

  it("v5 fixes the bound on entry: the same body runs once", () => {
    expect(observe(5, GROWING, [1, 2, 3])).toEqual([1, 1, 1]);
  });

  it("v6: a body that lowers a variable bound ends the loop early, `continue` included", () => {
    // Every iteration ends in `continue`, which re-evaluates the header (language_loops.txt).
    const body = ["n = 10", "cnt = 0", "for i = 0 to n", "    cnt += 1", "    n := 3", "    if true", "        continue", "    cnt += 100"];
    expect(observe(6, body, [1, 2])).toEqual([4, 4]);
    expect(observe(5, body, [1, 2])).toEqual([11, 11]);
  });

  it("v6: the direction stays the one the entry values set", () => {
    // Entry: 0 <= 2, ascending; the bound then drops below the counter and the loop stops, it does
    // not turn around (language_loops.txt: the direction follows "the initial to_num value").
    const body = ["n = 2", "cnt = 0", "for i = 0 to n", "    cnt += 1", "    n := -5"];
    expect(observe(6, body, [1])).toEqual([1]);
  });

  it("v6: a stateful call in the bound is a loop call site, each execution re-derived from the bar start", () => {
    // ta.sma(close, 2): na on bar 0 (no iteration), 3 on bar 1, 5 on bar 2. Were the state advanced
    // once per execution, the second execution on bar 1 would already see a window of [4, 4].
    const body = ["cnt = 0", "for i = 1 to ta.sma(close, 2)", "    cnt += 1"];
    expect(observe(6, body, [2, 4, 6])).toEqual([0, 3, 5]);
    const result = transpile(["//@version=6", "cnt = 0", "for i = 1 to ta.sma(close, 2)", "    cnt += 1"].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).toContain("i += __forDelta, __forEnd = rt.ta.sma(rt.ta.loopState($.taSlots[0], $.idx), $.close.get(0), 2)");
  });
});
