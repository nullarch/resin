// array<int> prints without a fraction and array<float> with one, in array.join and in a logged
// array: tier 1 array_008_array_na_index ("get: NaN arr: 10,20,30,40"), array_001_array_basic
// ("ai: [1, 0, 0, 2, 0]" against "af: [1.0, 0.0, 0.0, 2.0, 0.0]") and array_003_array_functions_float
// ("array.join(a, ', '): 0.0, 1.1, 2.2, ...").

import { describe, expect, it } from "vitest";
import * as parray from "../../src/runtime/array";
import { format } from "../../src/runtime/str";
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


describe("the na-index case end to end (array_008_array_na_index)", () => {
  it("the whole case end to end: the joins print ints and every line matches the export", () => {
    const run = (body: string[]): unknown =>
      lastObs(src("nai = int(ta.sma(close, 4000))", ...body));
    expect(
      run([
        "a5 = array.from(10, 20, 30, 40)",
        "sl1 = array.slice(a5, nai, 2)",
        "var string __obs = na",
        '__obs := array.join(sl1, ",") + " size: " + str.tostring(array.size(sl1))',
      ]),
    ).toBe("10,20 size: 2");
    expect(
      run([
        "a8 = array.from(10, 20, 30, 40)",
        "array.fill(a8, 5, nai, 2)",
        "var string __obs = na",
        '__obs := array.join(a8, ",")',
      ]),
    ).toBe("5,5,30,40");
    expect(
      run([
        "a4 = array.from(10, 20, 30, 40)",
        "array.insert(a4, nai, 77)",
        "var string __obs = na",
        '__obs := array.join(a4, ",")',
      ]),
    ).toBe("10,20,30,40,77");
    expect(
      run([
        "e4 = array.new_int()",
        "array.insert(e4, nai, 77)",
        "var string __obs = na",
        '__obs := array.join(e4, ",")',
      ]),
    ).toBe("77");
  });
});

describe("int arrays print without a fraction, float arrays with one", () => {
  it("array.join: array.from of int literals and array.new_int print ints", () => {
    expect(lastObs(src("a = array.from(10, 20, 30, 40)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe(
      "10,20,30,40",
    );
    expect(lastObs(src("a = array.from(-1, -2)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe("-1,-2");
    expect(lastObs(src("a = array.new_int(3, 7)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe("7,7,7");
    expect(lastObs(src("a = array.new<int>(2, 5)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe("5,5");
  });

  it("array.join: float arrays keep the .0 (array_003_array_functions_float: '0.0, 1.1, 2.2')", () => {
    expect(lastObs(src("a = array.from(0.0, 1.1, 2.2)", "var string __obs = na", '__obs := array.join(a, ", ")'))).toBe(
      "0.0, 1.1, 2.2",
    );
    expect(lastObs(src("a = array.new_float(2, 3.0)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe("3.0,3.0");
    // an int literal among floats makes the array a float one
    expect(lastObs(src("a = array.from(1, 2.5)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe("1.0,2.5");
  });

  it("an argument the analyzer cannot prove int leaves the array a float one", () => {
    expect(lastObs(src("a = array.from(1, close)", "var string __obs = na", '__obs := array.join(a, ",")'))).toBe("1.0,5.0");
  });

  it("copy, slice, abs and sort_indices keep or give the int kind", () => {
    const join = (body: string): unknown =>
      lastObs(src("a = array.from(3, -1, 2)", body, "var string __obs = na", "__obs := array.join(r, \",\")"));
    expect(join("r = array.copy(a)")).toBe("3,-1,2");
    expect(join("r = array.slice(a, 0, 2)")).toBe("3,-1");
    expect(join("r = array.abs(a)")).toBe("3,1,2");
    expect(join("r = array.sort_indices(array.from(30.0, 10.0, 20.0))")).toBe("1,2,0");
  });

  it("the log/str.format rendering of an array prints [1, 0] for ints and [1.0, 0.0] for floats", () => {
    const run = (body: string): unknown =>
      lastObs(src(body, "var string __obs = na", '__obs := str.format("{0}", r)'));
    expect(run("r = array.new_int(2, 1)")).toBe("[1, 1]");
    expect(run("r = array.new_float(2, 1.0)")).toBe("[1.0, 1.0]");
    expect(format("{0}", parray.from_int(1, 0, 0, 2, 0))).toBe("[1, 0, 0, 2, 0]");
    expect(format("{0}", [1.0, 0.0])).toBe("[1.0, 0.0]");
  });

  it("the analyzer marks array.from only when every argument is a proven int", () => {
    const code = (body: string): string => {
      const r = transpile(body);
      if (!r.ok) throw new Error(r.errors.join("; "));
      return r.code;
    };
    expect(code("a = array.from(1, 2, 3)")).toContain("rt.array.from_int(1, 2, 3)");
    expect(code("a = array.from(1.0, 2.0)")).not.toContain("from_int");
    expect(code("a = array.from(1, 2.5)")).not.toContain("from_int");
    expect(code("a = array.from(1, close)")).not.toContain("from_int");
  });

  it("an na element in an int array prints as NaN and a non-integral value keeps its fraction", () => {
    expect(format("{0}", parray.from_int(1, NA))).toBe("[1, NaN]");
    expect(parray.join(parray.from_int(1, 2), ",")).toBe("1,2");
  });
});
