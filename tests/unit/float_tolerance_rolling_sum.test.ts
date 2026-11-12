// TradingView's float arithmetic on the rolling sum and on the comparison operators.
//
// - math.sum / ta.sma / ta.variance run TradingView's rolling compensated sum (fused two-round
//   evict-and-add of the realized entry, re-baselined to the plain newest-first window sum when
//   the compensation would be lost), not a plain `sum - oldest + value` (PyneCore
//   lib/_math_stateful.py sum, core/rolling_sum.py sum_fires; runtime/ta.ts naSkipSum).
// - `<`, `>`, `<=`, `>=`, `==`, `!=` treat float operands at most 1e-10 apart as equal
//   (language_type-system.txt: "comparison operators automatically round “float” operands to nine
//   fractional digits"; PyneCore core/pine_compare.py; runtime/numeric.ts pineLt & co.).
//
// Tier 1 resin-harness suites/indicators/tv/math_004_sum_flat_exact pins both at once: after a
// window of 100s gives way to 0s, TradingView's sum keeps rounding dust, and its own `==` still
// reports the flat windows equal.
import { describe, expect, it } from "vitest";
import { pineEq, pineGe, pineGt, pineLe, pineLt, pineNeq } from "../../src/runtime/numeric";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

describe("tolerant comparison operators", () => {
  it("float operands at most 1e-10 apart are equal, the boundary included", () => {
    expect(pineEq(100, 100 + 1e-12)).toBe(true);
    expect(pineEq(0.6000000000000001, 0.6)).toBe(true);
    expect(pineEq(0, 1e-10)).toBe(true);
    expect(pineEq(0, 1.1e-10)).toBe(false);
    expect(pineNeq(100, 100 + 1e-12)).toBe(false);
    expect(pineNeq(100, 100 + 1e-8)).toBe(true);
  });

  it("orderings see through the same band", () => {
    expect(pineGt(0.6000000000000001, 0.6)).toBe(false);
    expect(pineLt(0.6, 0.6000000000000001)).toBe(false);
    expect(pineGe(0.6, 0.6000000000000001)).toBe(true);
    expect(pineLe(0.6000000000000001, 0.6)).toBe(true);
    expect(pineGt(100 + 1e-8, 100)).toBe(true);
    expect(pineLt(100, 100 + 1e-8)).toBe(true);
    expect(pineGe(100, 100 + 1e-8)).toBe(false);
  });

  // A na operand makes every comparison false (language_type-system.txt; harness lang probes L17/L19).
  it("ints stay exact, equal infinities stay equal, a comparison with na is false", () => {
    expect(pineGt(2, 1)).toBe(true);
    expect(pineEq(2, 1)).toBe(false);
    expect(pineEq(Infinity, Infinity)).toBe(true);
    expect(pineGe(Infinity, Infinity)).toBe(true);
    expect(pineLe(-Infinity, -Infinity)).toBe(true);
    expect(pineGt(Infinity, Infinity)).toBe(false);
    expect(pineLt(-Infinity, Infinity)).toBe(true);
    expect(pineGt(NaN, 1)).toBe(false);
    expect(pineLe(1, NaN)).toBe(false);
    expect(pineNeq(NaN, 1)).toBe(false);
    expect(pineEq(NaN, NaN)).toBe(false);
    expect(pineEq(NaN, 1)).toBe(false);
  });
});

describe("tier 1 math_004_sum_flat_exact", () => {
  const n = 30;
  const data: OHLCVData = {
    open: new Array(n).fill(1),
    high: new Array(n).fill(2),
    low: new Array(n).fill(0.5),
    close: new Array(n).fill(1.1),
    volume: new Array(n).fill(10),
  };
  const source = [
    "//@version=6",
    'indicator("Math Sum Flat Exact")',
    "var float v = 0.0",
    "if bar_index < 10",
    "    v := float(bar_index) * 7.3 + 0.1",
    "else if bar_index < 20",
    "    v := 100.0",
    "else",
    "    v := 0.0",
    "k = ta.sma(v, 3)",
    "d = ta.sma(k, 3)",
    "s = math.sum(v, 3)",
    "var float __kd = na",
    "var float __se = na",
    "var float __s = na",
    "__kd := k == d ? 1 : 0",
    "__se := s == v * 3 ? 1 : 0",
    "__s := s",
  ].join("\n");

  it("reproduces TradingView's logged k == d and s == v * 3 on bars 16..29", () => {
    const bars = runPipeline(source, data).bars;
    // TradingView Pine Logs (PyneSys/pynecore tests/t01_lib/t04_math/test_004_math_sum_flat_exact).
    const tvKd = [1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    const tvSe = [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(bars.slice(16).map((b) => b["var:__kd"])).toEqual(tvKd);
    expect(bars.slice(16).map((b) => b["var:__se"])).toEqual(tvSe);
  });

  // Under TradingView's previous rolling-sum machine (fused Kahan with a re-baseline rule) this
  // window of zeros kept rounding dust that only `==`'s tolerance hid. The Neumaier machine it has
  // run since 2026-10 (oracle pynecore core/rolling_sum.py) reports fl(s + c), and here that is 0.
  it("the window of zeros sums to 0 on the Neumaier machine", () => {
    const s = runPipeline(source, data).bars[22]!["var:__s"] as number;
    expect(s).toBe(0);
  });
});
