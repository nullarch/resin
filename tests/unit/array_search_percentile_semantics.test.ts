// array.percentile_*, array.percentrank, the array searches and array.concat, read off TradingView
// exports: the head-to-head harness cases array_006_array_na_percentile (percentiles with na
// elements), array_007_tolerant_search (tolerant indexof/includes against exact binary_search) and
// the expected logs of array_002_array_functions / array_003_array_functions_float (concat in place,
// the binary searches, percentrank, the nearest-rank rounding). Marked where a value is taken from
// the oracle's TradingView probe notes (PyneCore tests/t01_lib/t06_array) instead.

import { describe, expect, it } from "vitest";
import * as parray from "../../src/runtime/array";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const NA = NaN;

const data: OHLCVData = {
  open: [1, 5, 2, 4],
  high: [3, 7, 5, 6],
  low: [0, 2, 1, 3],
  close: [2, 4, 3, 5],
  volume: [10, 20, 30, 40],
};

const src = (...lines: string[]): string => lines.join("\n");

/** The last bar's value of the string channel `__obs`. */
function lastObs(source: string): unknown {
  const bars = runPipeline(source, data).bars;
  return bars[bars.length - 1]!["var:__obs"];
}


describe("percentiles keep their na elements (array_006_array_na_percentile)", () => {
  // real [10, 20, 30, 40], na at slots 1 and 4, size 6
  const a = [10.0, NA, 20.0, 30.0, NA, 40.0];

  it("percentile_nearest_rank: the full length drives the rank and a rank in the na tail is na", () => {
    const got = [0, 25, 50, 60, 75, 100].map((p) => parray.percentile_nearest_rank(a, p));
    expect(got).toEqual([10, 20, 30, 40, NA, NA]);
  });

  it("percentrank ranks the element at the index; an na element is na", () => {
    expect(parray.percentrank(a, 0)).toBe(0);
    expect(parray.percentrank(a, 1)).toBeNaN();
    expect(parray.percentrank(a, 2)).toBe(20);
    expect(parray.percentrank(a, 5)).toBe(60);
  });

  it("percentile_linear_interpolation with na: only the low clamp and an exact rank give a value", () => {
    const got = [0, 10, 25, 50, 75, 100].map((p) => parray.percentile_linear_interpolation(a, p));
    expect(got).toEqual([10, NA, 20, NA, NA, NA]);
  });

  it("percentile_linear_interpolation without na: the position is n * p / 100 + 0.5", () => {
    const b = [0.0, 1.1, 2.2, 4.4, 5.5, 6.6, 7.7, 8.8, 9.9, 10.1];
    const got = [10, 15, 25, 50, 75, 90].map((p) => parray.percentile_linear_interpolation(b, p));
    expect(got[0]).toBeCloseTo(0.55, 12);
    expect(got[1]).toBe(1.1);
    expect(got[2]).toBe(2.2);
    expect(got[3]).toBeCloseTo(6.05, 12);
    expect(got[4]).toBe(8.8);
    expect(got[5]).toBeCloseTo(10, 12);
  });

  it("nearest rank is not thrown off by (p / 100) * n rounding up: the 70th percentile of 0..10 is rank 7", () => {
    // array_002_array_functions: array.percentile_nearest_rank(a, 70) is 7 on [0, 1, 2, 4, 5, 6, 7, 8, 9, 10].
    const b = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10];
    expect(parray.percentile_nearest_rank(b, 70)).toBe(7);
    expect(parray.percentile_nearest_rank(b, 50)).toBe(5);
    expect(parray.percentile_nearest_rank(b, 0.5)).toBe(0);
    expect(parray.percentile_linear_interpolation(b, 70)).toBe(7.5);
    expect(parray.percentile_linear_interpolation(b, 50)).toBe(5.5);
  });

  it("percentrank of the element at an index on arrays without na (array_002 / array_003)", () => {
    // [0, 1, 2, 4, 5, ...] index 4: 5 elements <= 5, (5 - 1) * 100 / 9 = 44.444...
    expect(parray.percentrank([0, 1, 2, 4, 5, 6, 7, 8, 9, 10], 4)).toBeCloseTo(44.444, 3);
    // [0.0, 1.1, 2.2, ...] index 1: 2 elements <= 1.1, (2 - 1) * 100 / 9 = 11.111...
    expect(parray.percentrank([0.0, 1.1, 2.2, 4.4, 5.5, 6.6, 7.7, 8.8, 9.9, 10.1], 1)).toBeCloseTo(11.111, 3);
  });

  it("an na percentage is rank 0 for the nearest rank and na for the interpolation", () => {
    expect(parray.percentile_nearest_rank([4, 3, 2, 1], NA)).toBe(1);
    expect(parray.percentile_linear_interpolation([4, 3, 2, 1], NA)).toBeNaN();
  });

  it("an empty array and an all-na array are na", () => {
    expect(parray.percentile_nearest_rank([], 50)).toBeNaN();
    expect(parray.percentile_linear_interpolation([], 50)).toBeNaN();
    expect(parray.percentile_nearest_rank([NA, NA], 50)).toBeNaN();
    expect(parray.percentile_linear_interpolation([NA, NA], 50)).toBeNaN();
    expect(parray.percentrank([], 0)).toBeNaN();
    expect(parray.percentrank([5], 0)).toBeNaN(); // one element has no (n - 1) denominator
  });

  it("median and mode keep ignoring na elements (array_005_array_na_functions)", () => {
    expect(parray.median([1.0, NA, 3.0, NA, 5.0])).toBe(3);
    expect(parray.mode([4.0, NA, 4.0, 7.0, NA])).toBe(4);
  });
});


describe("tolerant searches (array_007_tolerant_search)", () => {
  const base = 100.0;
  const dsub = 1e-12;
  const dsup = 1e-8;

  it("indexof, lastindexof and includes match within 1e-10; 1e-8 is outside", () => {
    const dup = [base, base + 1.0, base, base + 2.0];
    expect(parray.indexof(dup, base + dsub)).toBe(0);
    expect(parray.lastindexof(dup, base + dsub)).toBe(2);
    expect(parray.lastindexof(dup, base + dsup)).toBe(-1);
    expect(parray.includes(dup, base + dsub)).toBe(true);
    expect(parray.includes(dup, base + dsup)).toBe(false);
  });

  it("the tolerance belongs to equality at its boundary and never matches na", () => {
    expect(parray.indexof([0.0], 1e-10)).toBe(0); // a difference of exactly 1e-10 is equal
    expect(parray.indexof([0.0], 1.1e-10)).toBe(-1);
    expect(parray.indexof([NA, 1.0], NA)).toBe(-1);
    expect(parray.includes([NA], NA)).toBe(false);
    expect(parray.indexof([Infinity], Infinity)).toBe(0);
  });

  it("strings compare exactly", () => {
    const s = ["a", "b"] as unknown as number[];
    expect(parray.indexof(s, "b" as unknown as number)).toBe(1);
    expect(parray.indexof(s, "c" as unknown as number)).toBe(-1);
  });

  it("binary_search and the percentile reductions stay bit-exact on the same values", () => {
    const sorted = [base, base + 1.0, base + 2.0];
    expect(parray.binary_search(sorted, base + dsub)).toBe(-1);
    const pct = [base, base + dsub, base + 5.0];
    expect((parray.percentile_nearest_rank(pct, 50) - base) * 1e12).toBeCloseTo(0.995, 3);
  });
});


describe("array.concat appends in place (array_002_array_functions)", () => {
  it("returns the first array itself, merged; the second is untouched", () => {
    const a = [1, 2, 4, 5, 6];
    const b = [7, 8, 9, 10];
    const c = parray.concat(a, b);
    expect(c).toBe(a);
    expect(a).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);
    expect(b).toEqual([7, 8, 9, 10]);
  });

  it("concat(a, a) doubles a", () => {
    const a = [1, 2];
    parray.concat(a, a);
    expect(a).toEqual([1, 2, 1, 2]);
  });

  it("a script sees the merged first array through every name", () => {
    const joined = lastObs(
      src(
        "a = array.from(1.0, 2.0)",
        "b = array.from(3.0)",
        "c = array.concat(a, b)",
        "array.push(c, 4.0)",
        "var string __obs = na",
        '__obs := array.join(a, ",") + "|" + array.join(b, ",")',
      ),
    );
    expect(joined).toBe("1.0,2.0,3.0,4.0|3.0");
  });

  it("is a mutating call: a concat in a lazy position is hoisted like push", () => {
    const result = transpile(
      src("var a = array.new_float(0)", "var b = array.new_float(1)", "x = close > open ? array.concat(a, b) : array.copy(a)"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.code).not.toContain("__lazy");
  });
});


describe("binary searches", () => {
  // array_002_array_functions: on [1, 2, 4, 5, ...] the value 3 is absent.
  it("a miss: leftmost is the next smaller element, rightmost the next greater (array_002)", () => {
    const a = [1, 2, 4, 5, 6, 7, 8, 9, 10];
    expect(parray.binary_search(a, 4)).toBe(2);
    expect(parray.binary_search(a, 3)).toBe(-1);
    expect(parray.binary_search_leftmost(a, 3)).toBe(1);
    expect(parray.binary_search_rightmost(a, 3)).toBe(2);
  });

  // The oracle's TradingView probe notes, tests/t01_lib/t06_array/test_014_binary_search_bounds.py
  // (no export of the corpus covers a duplicate or an array end).
  it("the oracle's probe table on [10, 20, 20, 20, 30, 40]", () => {
    const arr = [10, 20, 20, 20, 30, 40];
    const probes: Record<number, [number, number, number]> = {
      5: [-1, 0, 0],
      10: [0, 0, 0],
      15: [-1, 0, 1],
      20: [2, 1, 3],
      25: [-1, 3, 4],
      30: [4, 4, 4],
      40: [5, 5, 5],
      45: [-1, 5, 6],
    };
    for (const [val, [search, left, right]] of Object.entries(probes)) {
      const v = Number(val);
      expect(parray.binary_search(arr, v), `search ${v}`).toBe(search);
      expect(parray.binary_search_leftmost(arr, v), `leftmost ${v}`).toBe(left);
      expect(parray.binary_search_rightmost(arr, v), `rightmost ${v}`).toBe(right);
    }
  });

  it("leftmost never answers -1 for a value below the whole array", () => {
    expect(parray.binary_search_leftmost([10, 20, 30], 5)).toBe(0);
  });
});

