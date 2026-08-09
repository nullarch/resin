// s[N] — string 타입 top-level var의 히스토리 인덱스(C675, wild "string-hist" 클러스터, wild2
// tv_verdict_v2.jsonl accept 35건). udt_var_ref_history.test.ts(C637)/drawing_var_ref_history.test.ts
// (C652)의 거울상 — 물리 메커니즘(varRefHistorySlots, $.refHistSlots RefSeries)은 완전히 동일, 값
// 종류만 UDT 인스턴스/drawing 핸들 대신 plain string이다. RefSeries.data는 Float64Array가 아니라
// plain unknown[]라 string도 그대로 왕복 가능 — "참조형 3종 가드"(array/map/matrix)가 string까지
// 넓게 잡아 막고 있었을 뿐, 물리적 제약(Float64Array가 문자열을 못 담음)은 array/map/matrix에만
// 실제로 해당했다.

import { describe, expect, it } from "vitest";
import { analyze } from "../../src/transpiler/analyzer";
import { parse } from "../../src/transpiler/parser";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [2, 3, 4, 5, 6],
  low: [0, 1, 2, 3, 4],
  close: [10, 20, 30, 40, 50],
  volume: [1, 1, 1, 1, 1],
};

function analyzeSource(source: string) {
  return analyze(parse(source));
}

describe("string var reference history (s[N]) — analyzer gates (C675)", () => {
  it("allows history indexing on a top-level var holding a string and allocates a slot-keyed ref-hist slot", () => {
    const prog = analyzeSource(["var string s = na", "y = s[1]"].join("\n"));
    expect(prog.errors).toEqual([]);
    const slot = prog.varIndex.get("s")!;
    expect(prog.varRefHistorySlots.has(slot)).toBe(true);
    expect(prog.refHistorySlotCount).toBe(1);
    expect(prog.historySlotCount).toBe(0);
  });

  it("supports a dynamic (runtime) offset on the string var", () => {
    const prog = analyzeSource(["var string s = na", "n = 1", "y = s[n]"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.dynamicHistoryOffsets.size).toBe(1);
  });

  it("shares the ref-hist slot counter with drawing/UDT var history (same physical array)", () => {
    const prog = analyzeSource(
      ["var label lab = na", "var string s = na", "x = lab[1]", "y = s[1]"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.refHistorySlotCount).toBe(2);
  });

  it("still rejects map/matrix typed top-level vars (physical Float64Array constraint unchanged, C675 scope boundary)", () => {
    const mapProg = analyzeSource(["var mp = map.new<string,float>()", "y = mp[1]"].join("\n"));
    expect(mapProg.errors.some((e) => e.includes("map 타입 top-level var"))).toBe(true);
    const matProg = analyzeSource(["var m = matrix.new<float>(1, 1, 0.0)", "y = m[1]"].join("\n"));
    expect(matProg.errors.some((e) => e.includes("matrix 타입 top-level var"))).toBe(true);
  });
});

describe("string var reference history — codegen output (C675)", () => {
  it("emits a slot-keyed bar-end record line for the var receiver into $.refHistSlots", () => {
    const src = ["var string s = na", "s := \"even\"", "x = s[1]"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[0].record($.vars[0]);");
    }
  });

  it("routes a dynamic-offset read through rt.refHistGet", () => {
    const src = ["var string s = na", "s := \"even\"", "n = 1", "x = s[n]"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.refHistGet($.vars[0], $.refHistSlots[0], n)");
    }
  });
});

describe("string var reference history — execution semantics (C675)", () => {
  it("returns the prior bar's reassigned string value (true history)", () => {
    const src = [
      "var string s = na",
      "s := close > 25 ? \"hi\" : \"lo\"",
      "var float __obs_a = na",
      "var string __obs_b = na",
      "__obs_b := s[1]",
    ].join("\n");
    const result = runPipeline(src, data);
    const vals = result.bars.map((b) => b["var:__obs_b"]);
    expect(vals).toEqual([null, "lo", "lo", "hi", "hi"]);
  });

  it("does not crash on bar 0 (no history yet) and yields GOAL.md na=null, not NaN or a TypeError", () => {
    const src = ["var string s = na", "s := \"x\"", "var string __obs_a = na", "__obs_a := s[1]"].join("\n");
    expect(() => runPipeline(src, data)).not.toThrow();
    const result = runPipeline(src, data);
    expect(result.bars[0]!["var:__obs_a"]).toBeNull();
  });

  it("treats [0] as an identity read equal to the bare variable's current value", () => {
    const src = ["var string s = na", "s := \"x\"", "var string __obs_a = na", "__obs_a := s[0]"].join("\n");
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual(["x", "x", "x", "x", "x"]);
  });
});
