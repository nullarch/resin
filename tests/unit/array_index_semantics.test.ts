// Element indices of array.get/set/remove/insert/fill/slice and the rank of array.min/max, read off
// TradingView exports: the head-to-head harness cases array_001_array_basic (a negative index counts
// from the end) and array_008_array_na_index (an na index: what each call does with it). Every
// expected value is a line of one of those exports unless marked as taken from the oracle's
// TradingView probe notes (PyneCore tests/t01_lib/t06_array).

import { describe, expect, it } from "vitest";
import * as parray from "../../src/runtime/array";
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


describe("negative indices (array_001_array_basic)", () => {
  it("get/set address the array from its end for a negative index in -size..-1", () => {
    const af = [0.0, 0.0, 0.0, 0.0, 0.0];
    parray.set(af, 0, 1.0);
    parray.set(af, -2, 2.0);
    expect(af).toEqual([1.0, 0.0, 0.0, 2.0, 0.0]);
    expect(parray.get(af, -2)).toBe(2.0);
    expect(parray.get(af, -5)).toBe(1.0);
  });

  it("string and color arrays (non-numeric elements) follow the same rule", () => {
    const as = ["s", "s", "s", "s", "s"];
    parray.set(as as unknown as number[], -2, "s2" as unknown as number);
    expect(as).toEqual(["s", "s", "s", "s2", "s"]);
  });

  it("an index below -size or at/above size reads na and writes nothing", () => {
    const a = [1, 2, 3];
    expect(parray.get(a, -4)).toBeNaN();
    expect(parray.get(a, 3)).toBeNaN();
    parray.set(a, -4, 9);
    parray.set(a, 3, 9);
    expect(a).toEqual([1, 2, 3]);
  });

  it("remove takes a negative index and insert takes -size..size, counting from the end", () => {
    const a = [10, 20, 30, 40];
    expect(parray.remove(a, -1)).toBe(40);
    expect(a).toEqual([10, 20, 30]);
    const b = [10, 20, 30, 40];
    parray.insert(b, -4, 77); // the oracle's probe notes: insert(a, -4, 77) is 77,10,20,30,40
    expect(b).toEqual([77, 10, 20, 30, 40]);
    const c = [10, 20, 30, 40];
    parray.insert(c, 4, 77); // the array size appends
    expect(c).toEqual([10, 20, 30, 40, 77]);
  });

  it("a script writes through a negative index end to end", () => {
    const joined = lastObs(
      src(
        "a = array.new_float(5, 0.0)",
        "array.set(a, -2, 2.0)",
        "var string __obs = na",
        '__obs := array.join(a, ",")',
      ),
    );
    expect(joined).toBe("0.0,0.0,0.0,2.0,0.0");
  });
});


describe("an na index (array_008_array_na_index)", () => {
  it("get/set/remove on an na index read na and change nothing, on a filled and an empty array", () => {
    const a = [10, 20, 30, 40];
    expect(parray.get(a, NA)).toBeNaN();
    parray.set(a, NA, 99);
    expect(parray.remove(a, NA)).toBeNaN();
    expect(a).toEqual([10, 20, 30, 40]);
    const e: number[] = [];
    expect(parray.get(e, NA)).toBeNaN();
    parray.set(e, NA, 9);
    expect(parray.remove(e, NA)).toBeNaN();
    expect(e).toEqual([]);
  });

  it("insert at an na index appends: 10,20,30,40,77 and, on an empty array, 77", () => {
    const a = [10, 20, 30, 40];
    parray.insert(a, NA, 77);
    expect(a).toEqual([10, 20, 30, 40, 77]);
    const e: number[] = [];
    parray.insert(e, NA, 77);
    expect(e).toEqual([77]);
  });

  it("slice takes an na bound as the start / the size: 10,20 | 20,30,40 | 10,20,30,40", () => {
    const a = [10, 20, 30, 40];
    expect(parray.slice(a, NA, 2)).toEqual([10, 20]);
    expect(parray.slice(a, 1, NA)).toEqual([20, 30, 40]);
    expect(parray.slice(a, NA, NA)).toEqual([10, 20, 30, 40]);
  });

  it("fill takes an na bound as the start / the size: 5,5,30,40 | 10,5,5,5", () => {
    const a = [10, 20, 30, 40];
    parray.fill(a, 5, NA, 2);
    expect(a).toEqual([5, 5, 30, 40]);
    const b = [10, 20, 30, 40];
    parray.fill(b, 5, 1, NA);
    expect(b).toEqual([10, 5, 5, 5]);
  });

  it("percentrank / max / min read an na index or rank as 0: 0, 40, 10", () => {
    const b = [10, 20, 30, 40];
    expect(parray.percentrank(b, NA)).toBe(0);
    expect(parray.max(b, NA)).toBe(40);
    expect(parray.min(b, NA)).toBe(10);
    expect(parray.max(b, 1)).toBe(30);
    expect(parray.min(b, 1)).toBe(20);
  });
});

