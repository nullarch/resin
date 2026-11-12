// The series-length machines (runtime/ta.ts "Series lengths: the oracle's machines"): every builtin
// whose length the v6 reference types `series int` computes each bar with that bar's length. The
// expected values are the tier-2 oracle's (PyneCore) on the twin resin-harness
// state/repros/serieslen-machines.json: these ten bars, `sna = bar_index == 2 ? na : close`, a
// length A = math.min(bar_index + 1, 4) that grows, and B = bar_index % 3 + 2 that moves every bar.
import { describe, expect, it } from "vitest";
import {
  bbVarLen,
  bbwVarLen,
  cciVarLen,
  changeVarLen,
  cmoVarLen,
  correlationVarLen,
  devVarLen,
  mfiVarLen,
  modeVarLen,
  percentrankVarLen,
  rocVarLen,
  stdevVarLen,
  stochVarLen,
  varianceVarLen,
  wprVarLen,
} from "../../src/runtime/ta";

// o, h, l, c, v
const BARS = [
  [10, 11, 9, 10, 100],
  [10, 12, 9.5, 11, 200],
  [11, 11.5, 10, 10.5, 0],
  [10.5, 13, 10, 12.5, 150],
  [12.5, 12.8, 11, 11.2, 300],
  [11.2, 12, 10.9, 11.9, 250],
  [11.9, 14, 11.5, 13.5, 100],
  [13.5, 13.6, 12, 12.2, 50],
  [12.2, 12.5, 11, 11.5, 80],
  [11.5, 12, 10, 10.4, 120],
] as const;
const N = BARS.length;
const high = (i: number) => BARS[i]![1];
const low = (i: number) => BARS[i]![2];
const close = (i: number) => BARS[i]![3];
const volume = (i: number) => BARS[i]![4];
const sna = (i: number) => (i === 2 ? NaN : close(i));
const A = (i: number) => Math.min(i + 1, 4);
const B = (i: number) => (i % 3) + 2;

function run(step: (i: number) => number): (number | null)[] {
  return BARS.map((_, i) => {
    const v = step(i);
    return Number.isFinite(v) ? v : null;
  });
}

function expectSeries(actual: (number | null)[], expected: (number | null)[]): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((e, i) => {
    const a = actual[i]!;
    if (e === null) {
      expect(a, `bar ${i}`).toBeNull();
    } else {
      expect(a, `bar ${i}`).not.toBeNull();
      expect(Math.abs(a - e), `bar ${i}: ${a} vs ${e}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(e)));
    }
  });
}

describe("series-length machines (oracle twin serieslen-machines)", () => {
  it("ta.change reads source[length] of its own bar history", () => {
    const s = {};
    expectSeries(run((i) => changeVarLen(s, sna(i), B(i), N, i)), [
      null, null, null, 1.5, 0.1999999999999993, 0.9000000000000004, 2.3000000000000007, 1, 0.3000000000000007, -1.799999999999999,
    ]);
  });

  // The manual's formula with one past value in both places: 100 * (src - src[length]) / src[length],
  // na when either is na (ref_v6_ta_math.txt ta.roc; resin-harness dispute D12, settled for the
  // manual). The oracle's own roc takes the difference over non-na bars only, which this test
  // pinned before: bar 3 (length 2) was 100 * (12.5 - 10) / 11, the difference reaching past the na
  // bar 2 to bar 0, and is now 100 * (12.5 - 11) / 11.
  it("ta.roc is 100 * (src - src[length]) / src[length], na values included", () => {
    const s = {};
    const expected = Array.from({ length: N }, (_, i) => {
      const len = B(i);
      if (i < len) return null;
      const cur = sna(i);
      const old = sna(i - len);
      return Number.isNaN(cur) || Number.isNaN(old) ? null : (100 * (cur - old)) / old;
    });
    expect(expected[3]).toBeCloseTo(13.636363636363637, 12);
    expectSeries(run((i) => rocVarLen(s, sna(i), B(i), N, i)), expected);
  });

  it("ta.cmo sums the rising and falling momenta over windows that follow the length", () => {
    const s = {};
    expectSeries(run((i) => cmoVarLen(s, sna(i), B(i), N, i)), [
      null, null, null, null, null, null, 100, 27.777777777777768, 6.976744186046527, -100,
    ]);
  });

  it("ta.dev is 0 at length 1 without running its sma, which then misses that bar", () => {
    const s = {};
    expectSeries(run((i) => devVarLen(s, sna(i), A(i), N, i)), [
      0, null, null, null, null, null, 0.7250000000000001, 0.6499999999999999, 0.6125000000000003, 0.9499999999999997,
    ]);
  });

  it("ta.cci runs its sma every bar and divides by 0.015 * the deviation", () => {
    const s = {};
    expectSeries(run((i) => cciVarLen(s, sna(i), A(i), N, i)), [
      null, 66.66666666666667, null, null, null, null, 112.64367816091949, 0, -84.35374149659864, -105.26315789473688,
    ]);
  });

  it("ta.variance (unbiased), ta.stdev and ta.bbw skip na and follow the length", () => {
    const v = {};
    expectSeries(run((i) => varianceVarLen(v, sna(i), B(i), false, N, i)), [
      null, null, null, 1.125, 0.6633333333332985, 0.46999999999997044, 1.2800000000000296, 0.7233333333333292, 0.7491666666666674, 0.6050000000000466,
    ]);
    const s = {};
    expectSeries(run((i) => stdevVarLen(s, sna(i), B(i), true, N, i)), [
      null, null, null, 0.75, 0.6649979114419613, 0.5937171043518892, 0.8000000000000093, 0.6944222218666533, 0.7495832175282574, 0.5500000000000211,
    ]);
    const w = {};
    expectSeries(run((i) => bbwVarLen(w, sna(i), B(i), 2, N, i)), [
      null, null, null, 25.53191489361702, 22.997045928828637, 20.385136630107798, 25.19685039370109, 22.16241133616979, 24.42633702739738, 20.091324200914016,
    ]);
  });

  it("ta.bb is the length's sma with mult * stdev around it", () => {
    const s = {};
    const scratch = new Float64Array(3);
    bbVarLen(s, 10, 1, 2, scratch, N, 0);
    expect([...scratch]).toEqual([10, 10, 10]);
    bbVarLen(s, 12, 2, 2, scratch, N, 1);
    expect([...scratch]).toEqual([11, 13, 9]); // mean 11, stdev 1
    bbVarLen(s, NaN, 3, 2, scratch, N, 2);
    expect(scratch.every((x) => Number.isNaN(x))).toBe(true); // only two non-na values yet
  });

  it("ta.mfi does not run on an na source and sums the money flow over windows that follow the length", () => {
    const s = {};
    expectSeries(run((i) => mfiVarLen(s, sna(i), volume(i), B(i), N, i)), [
      null, null, null, 100, 54.80833893745797, 67.72334293948126, 100, 87.63931104356637, 73.86848847139197, 0,
    ]);
  });

  it("ta.stoch and ta.wpr read ta.highest/ta.lowest's bar-addressed ring, rescanned when the length grows", () => {
    const s = {};
    expectSeries(run((i) => stochVarLen(s, close(i), high(i), low(i), B(i), N, i)), [
      null, null, null, 83.33333333333333, 39.99999999999998, 63.33333333333334, 83.87096774193547, 41.93548387096771, 19.35483870967741, 16.000000000000014,
    ]);
    const w = {};
    expectSeries(run((i) => wprVarLen(w, close(i), high(i), low(i), A(i), N, i)), [
      10, -40, -60, -14.285714285714286, -51.428571428571445, -36.66666666666666, -12.5, -58.064516129032285, -80.64516129032259, -89.99999999999999,
    ]);
  });

  it("ta.percentrank ranks the current value among the length previous ones", () => {
    const s = {};
    expectSeries(run((i) => percentrankVarLen(s, sna(i), B(i), N, i)), [
      null, null, null, 50, 33.333333333333336, 50, 100, 66.66666666666667, 25, 0,
    ]);
  });

  it("ta.mode takes the smallest most frequent of the last length non-na values", () => {
    const s = {};
    expectSeries(run((i) => modeVarLen(s, sna(i), B(i), N, i)), [null, null, null, 11, 11, 11, 11.9, 11.9, 11.5, 10.4]);
  });

  it("ta.correlation keeps one na-skipping window per sum, which can put it outside [-1, 1]", () => {
    const s = {};
    expectSeries(run((i) => correlationVarLen(s, sna(i), high(i), B(i), N, i)), [
      null, null, null, 5.888888888888889, 4.841708542713676, 4.390103342519848, 1.0000000000000027, 0.7777137710478376, 0.8024149632673186, 1.0000000000000855,
    ]);
  });

  it("a same-bar re-execution (a loop call site) replaces the bar's entry instead of advancing", () => {
    const s = {};
    changeVarLen(s, 10, 1, N, 0);
    changeVarLen(s, 99, 1, N, 1);
    expect(changeVarLen(s, 11, 1, N, 1)).toBe(1);
    expect(changeVarLen(s, 15, 2, N, 2)).toBe(5);
  });

  it("a length below 1 or na is na", () => {
    expect(changeVarLen({}, 10, 0, N, 0)).toBeNaN();
    expect(varianceVarLen({}, 10, NaN, true, N, 0)).toBeNaN();
    expect(percentrankVarLen({}, 10, -1, N, 0)).toBeNaN();
  });
});
