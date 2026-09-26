// A UDT is a reference type: assigning a variable that holds an instance to another variable
// copies the reference, not the object, so both names reach the same object
// (docs: language_type-system.txt "Value vs. reference types": "Assigning the reference stored by
// one variable to another does not create a new copy of an object. Instead, both variables refer
// to the same object in memory."). Expected values are the oracle's (PyneCore) on the harness
// cases lang.udt alias_and_copy (state/repros/lang.udt-seed-3.json) and the same alias in a var
// declaration and inside a function.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [2, 3, 4, 5, 6],
  low: [0, 1, 2, 3, 4],
  close: [10, 20, 30, 40, 50],
  volume: [1, 1, 1, 1, 1],
};

function obs(source: string): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b["var:__obs_a"]);
}

const P = ["type P", "    float x = 0.0"];

describe("UDT reference aliasing", () => {
  it("an '=' local initialized from a UDT variable is that instance: a field write shows through the original", () => {
    const src = [...P, "p = P.new(close)", "a = p", "a.x := a.x + 1", "var float __obs_a = na", "__obs_a := p.x"].join("\n");
    expect(obs(src)).toEqual([11, 21, 31, 41, 51]);
  });

  it("a var initialized from a var UDT is the same persistent instance", () => {
    const src = [...P, "var P q = P.new(0.0)", "var b = q", "b.x += 1.0", "var float __obs_a = na", "__obs_a := q.x"].join("\n");
    expect(obs(src)).toEqual([1, 2, 3, 4, 5]);
  });

  it("aliases inside a function body the same way", () => {
    const src = [
      ...P,
      "f(float v) =>",
      "    p = P.new(v)",
      "    a = p",
      "    a.x += 1.0",
      "    p.x",
      "var float __obs_a = na",
      "__obs_a := f(close)",
    ].join("\n");
    expect(obs(src)).toEqual([11, 21, 31, 41, 51]);
  });

  it("copy() is not an alias: a write to the copy leaves the original alone", () => {
    const src = [...P, "p = P.new(close)", "c = p.copy()", "c.x := 2.0", "var float __obs_a = na", "__obs_a := p.x"].join("\n");
    expect(obs(src)).toEqual([10, 20, 30, 40, 50]);
  });
});
