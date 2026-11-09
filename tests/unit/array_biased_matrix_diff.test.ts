// array.stdev / array.variance / array.covariance 'biased' argument and the 2-argument matrix.diff
// (hand-verified against the TradingView Pine Logs of the h2h cases array_002_array_functions,
// array_003_array_functions_float, array_005_array_na_functions and matrix_001_matrix_basic; the
// pine2py oracle has neither the biased argument nor a 2-argument matrix.diff, so there is no golden).
// The runtime numerics are in runtime.test.ts; this file checks the whole pipeline: the call is
// accepted (positional, keyword, method-call sugar), lowered to the right runtime call and gives the
// TradingView numbers.

import { describe, expect, it } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const ONE_BAR: OHLCVData = { open: [1], high: [1], low: [1], close: [1], volume: [1] };

function errorsOf(source: string): string[] {
  const r = transpile(source);
  return r.ok ? [] : r.errors;
}

describe("array.variance / array.stdev / array.covariance biased argument", () => {
  it("accepts the optional biased argument positionally and as a keyword, and emits it in the TradingView slot order", () => {
    for (const src of [
      "a = array.from(1.0, 2.0, 4.0)\nx = array.stdev(a, false)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.stdev(a, biased = false)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.stdev(id = a, biased = false)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.variance(a, false)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.variance(id = a, biased = true)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.covariance(a, a, false)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.covariance(a, a, biased = false)",
      "a = array.from(1.0, 2.0, 4.0)\nx = array.covariance(id1 = a, id2 = a, biased = false)",
    ]) {
      expect(errorsOf(src), src).toEqual([]);
    }
    const r = transpile("a = array.from(1.0, 2.0, 4.0)\nx = array.covariance(id1 = a, id2 = a, biased = false)");
    expect(r.ok && r.code).toContain("rt.array.covariance(a, a, false)");
  });

  it("still rejects a third argument to stdev/variance, a fourth to covariance, and unknown keyword names", () => {
    expect(errorsOf("a = array.from(1.0)\nx = array.stdev(a, true, 1)").join("\n")).toContain("array.stdev");
    expect(errorsOf("a = array.from(1.0)\nx = array.variance(a, true, 1)").join("\n")).toContain("array.variance");
    expect(errorsOf("a = array.from(1.0)\nx = array.covariance(a, a, true, 1)").join("\n")).toContain("array.covariance");
    expect(errorsOf("a = array.from(1.0)\nx = array.stdev(a, unbiased = true)").join("\n")).toContain("unbiased");
    expect(errorsOf("a = array.from(1.0)\nx = array.covariance(a, a, bias = true)").join("\n")).toContain("bias");
  });

  it("matches the TradingView logs: [1, 3, 5] among na (array_005)", () => {
    const r = runPipeline(
      [
        "var float __obs_x1 = na",
        "var float __obs_x2 = na",
        "var float __obs_x3 = na",
        "var float __obs_x4 = na",
        "var float __obs_x5 = na",
        "var float __obs_x6 = na",
        "var float __obs_x7 = na",
        "a = array.from(1.0, na, 3.0, na, 5.0)",
        "__obs_x1 := array.variance(a)",
        "__obs_x2 := array.variance(a, false)",
        "__obs_x3 := array.stdev(a)",
        "__obs_x4 := array.stdev(a, false)",
        "__obs_x5 := array.stdev(a, biased = false)",
        "c1 = array.from(1.0, na, 3.0, 5.0)",
        "c2 = array.from(2.0, 4.0, na, 6.0)",
        "__obs_x6 := array.covariance(c1, c2)",
        "__obs_x7 := array.covariance(c1, c2, false)",
      ].join("\n"),
      ONE_BAR,
    );
    const f = r.finalVarState;
    expect(f["__obs_x1"]).toBeCloseTo(2.666666666667, 11); // variance: 2.666666666667
    expect(f["__obs_x2"]).toBeCloseTo(4, 12); // variance_unbiased: 4
    expect(f["__obs_x3"]).toBeCloseTo(1.632993161855, 11); // stdev: 1.632993161855
    expect(f["__obs_x4"]).toBeCloseTo(2, 12); // stdev_unbiased: 2
    expect(f["__obs_x5"]).toBeCloseTo(2, 12);
    expect(f["__obs_x6"]).toBeCloseTo(4, 12); // cov: 4
    expect(f["__obs_x7"]).toBeCloseTo(8, 12); // cov_unbiased: 8
  });

  it("a single valid value: stdev/variance are 0 (TradingView s_stdev/s_variance), unbiased na", () => {
    const r = runPipeline(
      [
        "var float __obs_s1 = na",
        "var float __obs_s2 = na",
        "var float __obs_s3 = na",
        "var float __obs_s4 = na",
        "s = array.from(na, 6.0, na)",
        "__obs_s1 := array.stdev(s)",
        "__obs_s2 := array.variance(s)",
        "__obs_s3 := array.stdev(s, false)",
        "__obs_s4 := array.variance(s, false)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_s1"]).toBe(0);
    expect(r.finalVarState["__obs_s2"]).toBe(0);
    expect(r.finalVarState["__obs_s3"]).toBeNaN();
    expect(r.finalVarState["__obs_s4"]).toBeNaN();
  });

  it("works through the method-call sugar (a.stdev(false), a.variance(false), a.covariance(b, false))", () => {
    const src = [
      "var float __obs_a = na",
      "var float __obs_b = na",
      "var float __obs_c = na",
      "a = array.from(1.0, 3.0, 5.0)",
      "b = array.from(2.0, 4.0, 9.0)",
      "__obs_a := a.stdev(false)",
      "__obs_b := a.variance(false)",
      "__obs_c := a.covariance(b, false)",
    ].join("\n");
    const r = runPipeline(src, ONE_BAR);
    expect(r.finalVarState["__obs_a"]).toBeCloseTo(2, 12);
    expect(r.finalVarState["__obs_b"]).toBeCloseTo(4, 12);
    // pairs (1,2),(3,4),(5,9): means 3 and 5, sum of products (-2)(-3)+0+(2)(4) = 14, unbiased /2
    expect(r.finalVarState["__obs_c"]).toBeCloseTo(7, 12);
  });
});

describe("array.concat / array.sort_indices / array.sum TradingView semantics through the pipeline", () => {
  it("array.concat appends to the first array in place and returns it (array_002)", () => {
    const r = runPipeline(
      [
        "var float __obs_size_a = na",
        "var float __obs_ret_size = na",
        "var float __obs_size_b = na",
        "a = array.from(1.0, 2.0)",
        "b = array.from(3.0, 4.0, 5.0)",
        "c = array.concat(a, b)",
        "__obs_size_a := array.size(a)",
        "__obs_ret_size := array.size(c)",
        "__obs_size_b := array.size(b)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_size_a"]).toBe(5);
    expect(r.finalVarState["__obs_ret_size"]).toBe(5);
    expect(r.finalVarState["__obs_size_b"]).toBe(3);
  });

  it("array.concat is a mutator: hoisted out of an 'and' lazy right operand like array.push", () => {
    const r = transpile("var a = array.new_float(0)\nvar b = array.new_float(0)\nx = close > open and array.concat(a, b)");
    expect(r.ok && r.code).toContain("let __lazy0 = rt.array.concat($.vars[0], $.vars[1]);");
  });

  it("array.sum of an all-na array is na (array_005)", () => {
    const r = runPipeline(
      ["var float __obs_z = na", "z = array.from(float(na), float(na))", "__obs_z := array.sum(z)"].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_z"]).toBeNaN();
  });
});

describe("matrix.diff 2-argument form", () => {
  const prelude = [
    "var float __obs_a = na",
    "var float __obs_b = na",
    "var float __obs_c = na",
    "var float __obs_rows = na",
    "var float __obs_cols = na",
    "m1 = matrix.new<float>(2, 3, 3.0)",
    "m2 = matrix.new<float>(2, 3, 1.0)",
    "matrix.set(m1, 1, 2, 10.0)",
  ];

  it("is accepted as matrix.diff(a, b), a.diff(b), and with a scalar second argument", () => {
    for (const src of [
      "m1 = matrix.new<float>(2, 2, 3.0)\nm2 = matrix.new<float>(2, 2, 1.0)\nd = matrix.diff(m1, m2)\nx = matrix.get(d, 0, 0)",
      "m1 = matrix.new<float>(2, 2, 3.0)\nm2 = matrix.new<float>(2, 2, 1.0)\nd = m1.diff(m2)\nx = matrix.get(d, 0, 0)",
      "m1 = matrix.new<float>(2, 2, 3.0)\nd = matrix.diff(m1, 1.0)\nx = matrix.get(d, 0, 0)",
    ]) {
      expect(errorsOf(src), src).toEqual([]);
    }
    expect(errorsOf("m1 = matrix.new<float>(2, 2, 3.0)\nd = matrix.diff(m1, m1, m1)").join("\n")).toContain("matrix.diff");
  });

  it("subtracts element-wise into a new matrix (matrix_001 Test 23b: 3 - 1 = 2) and leaves the inputs untouched", () => {
    const r = runPipeline(
      [
        ...prelude,
        "d = matrix.diff(m1, m2)",
        "__obs_a := matrix.get(d, 0, 0)",
        "__obs_b := matrix.get(d, 1, 2)",
        "__obs_c := matrix.get(m1, 1, 2)",
        "__obs_rows := matrix.rows(d)",
        "__obs_cols := matrix.columns(d)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_a"]).toBe(2);
    expect(r.finalVarState["__obs_b"]).toBe(9);
    expect(r.finalVarState["__obs_c"]).toBe(10);
    expect(r.finalVarState["__obs_rows"]).toBe(2);
    expect(r.finalVarState["__obs_cols"]).toBe(3);
  });

  it("works with a scalar second argument and through the method-call sugar", () => {
    const r = runPipeline(
      [
        ...prelude,
        "d1 = matrix.diff(m1, 0.5)",
        "d2 = m1.diff(m2)",
        "__obs_a := matrix.get(d1, 0, 0)",
        "__obs_b := matrix.get(d2, 1, 2)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_a"]).toBe(2.5);
    expect(r.finalVarState["__obs_b"]).toBe(9);
  });

  it("the 1-argument adjacent-row form (pre-existing extension) is unchanged", () => {
    const r = runPipeline(
      [
        "var float __obs_a = na",
        "m = matrix.new<float>(2, 2, 0.0)",
        "matrix.set(m, 0, 0, 1.0)",
        "matrix.set(m, 1, 0, 4.0)",
        "d = matrix.diff(m)",
        "__obs_a := matrix.get(d, 0, 0)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_a"]).toBe(3);
  });
});

describe("matrix.reshape / matrix.reverse / matrix.concat in place (matrix_001)", () => {
  it("reshape rebuilds the matrix in place (Test 13), reverse flips rows and columns (Test 18)", () => {
    const r = runPipeline(
      [
        "var float __obs_rows = na",
        "var float __obs_cols = na",
        "var float __obs_r00 = na",
        "var float __obs_r12 = na",
        "m = matrix.new<float>(2, 3, 0.0)",
        "for i = 0 to 1",
        "    for j = 0 to 2",
        "        matrix.set(m, i, j, i * 3 + j + 1.0)",
        "matrix.reshape(m, 3, 2)",
        "__obs_rows := matrix.rows(m)",
        "__obs_cols := matrix.columns(m)",
        "n = matrix.new<float>(2, 3, 0.0)",
        "for i = 0 to 1",
        "    for j = 0 to 2",
        "        matrix.set(n, i, j, i * 3 + j + 1.0)",
        "matrix.reverse(n)",
        "__obs_r00 := matrix.get(n, 0, 0)",
        "__obs_r12 := matrix.get(n, 1, 2)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_rows"]).toBe(3);
    expect(r.finalVarState["__obs_cols"]).toBe(2);
    expect(r.finalVarState["__obs_r00"]).toBe(6);
    expect(r.finalVarState["__obs_r12"]).toBe(1);
  });

  it("concat appends id2's rows to id1 in place and returns id1", () => {
    const r = runPipeline(
      [
        "var float __obs_rows1 = na",
        "var float __obs_rows_ret = na",
        "var float __obs_rows2 = na",
        "m1 = matrix.new<float>(2, 2, 1.0)",
        "m2 = matrix.new<float>(2, 2, 2.0)",
        "m = matrix.concat(m1, m2)",
        "__obs_rows1 := matrix.rows(m1)",
        "__obs_rows_ret := matrix.rows(m)",
        "__obs_rows2 := matrix.rows(m2)",
      ].join("\n"),
      ONE_BAR,
    );
    expect(r.finalVarState["__obs_rows1"]).toBe(4);
    expect(r.finalVarState["__obs_rows_ret"]).toBe(4);
    expect(r.finalVarState["__obs_rows2"]).toBe(2);
  });
});
