// 리터럴 obj 히스토리 인덱싱(C717, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 최다
// 서브그룹 — `0[1]`/`1[2]`류, tv_verdict_v2.jsonl accept 5건 실측). NumberLiteral/BoolLiteral/
// NaLiteral obj는 기존 (high-low)[1]류 산술식 히스토리(C522) 메커니즘을 그대로 공유한다 —
// "컴파일타임 상수라 오프셋과 무관하게 항상 자기 자신"으로 즉시 접지 않고, 매 바 record+get을
// 거쳐 다른 모든 obj kind와 동일한 워밍업(아직 N바가 지나지 않았으면 na) 규칙을 따른다. 리터럴만
// 워밍업을 건너뛴다는 가정은 TV 1차 소스로 검증된 바 없어 채택하지 않았다(index-access.ts C717
// 주석 참조). pine2py `_gen_index_access`는 이 패턴을 raw Python subscript(`1[2]`)로 그대로 방출해
// 실행 시 TypeError로 크래시하는 latent 버그(python 직접 실행 확인)라 오라클 대조 불가 —
// hand-verified.

import { describe, expect, it } from "vitest";
import { analyze } from "../../src/transpiler/analyzer";
import { parse } from "../../src/transpiler/parser";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2, 8, 3, 9, 4, 10],
  high: [3, 7, 5, 10, 6, 12, 8, 15],
  low: [0, 2, 1, 4, 2, 5, 3, 6],
  close: [2, 4, 3, 9, 2, 11, 3, 12],
  volume: [1, 1, 1, 1, 1, 1, 1, 1],
};

function analyzeSource(source: string) {
  return analyze(parse(source));
}

function obs(source: string, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("literal-obj history indexing (C717, hand-verified)", () => {
  it("registers a NumberLiteral history read into the shared arithmetic-history slot (no new mechanism)", () => {
    const prog = analyzeSource(["var float y = na", "y := 1[2]"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.historySlotCount).toBe(1);
    expect(prog.refHistorySlotCount).toBe(0);
  });

  it("evaluates NumberLiteral[N] as NaN during warmup (N bars not yet elapsed), then the literal forever after", () => {
    const src = ["var float __obs_a = na", "__obs_a := 1[2]"].join("\n");
    // offset=2: first 2 bars have no bar 2-steps-back yet -> na, then always 1.
    expect(obs(src)).toEqual([NaN, NaN, 1, 1, 1, 1, 1, 1]);
  });

  it("evaluates a negative-literal (UnaryOp over NumberLiteral)[N] the same warmup-respecting way", () => {
    const src = ["var float __obs_a = na", "__obs_a := (-5)[3]"].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, NaN, -5, -5, -5, -5, -5]);
  });

  it("evaluates BoolLiteral[N] (0/1-backed) with the same warmup rule", () => {
    const src = ["var float __obs_a = na", "__obs_a := true[1] ? 999 : -1"].join("\n");
    expect(obs(src)).toEqual([-1, 999, 999, 999, 999, 999, 999, 999]);
  });

  it("evaluates na[N] to NaN both during warmup and after (na literal has no non-na value to settle to)", () => {
    const src = ["var float __obs_a = na", "__obs_a := na[1]"].join("\n");
    expect(obs(src)).toEqual(Array(8).fill(NaN));
  });

  it("[0] on a literal is the bare literal immediately (no warmup gate, offset===0 fast path)", () => {
    const src = ["var float __obs_a = na", "__obs_a := 7[0]"].join("\n");
    expect(obs(src)).toEqual(Array(8).fill(7));
  });

  it("supports a dynamic (runtime) offset expression on a literal base, with the same warmup rule", () => {
    const src = ["var float __obs_a = na", "n = 7 - bar_index", "__obs_a := 5[n]"].join("\n");
    // n = [7,6,5,4,3,2,1,0]; bar_index-n = [-7,-5,-3,-1,1,3,5,7] -- na while negative, then 5.
    expect(obs(src)).toEqual([NaN, NaN, NaN, NaN, 5, 5, 5, 5]);
  });

  it("reproduces the wild idiom `x[1] > 0[1] ? a : na` (literal history inside a ternary condition)", () => {
    const src = [
      "var float __obs_a = na",
      "d = close - open",
      "__obs_a := d < 0 and d[1] > 0[1] ? 999 : na",
    ].join("\n");
    // d per bar: [1,-1,1,1,-1,2,-1,2]. 0[1] is na at bar0 (warmup) then 0 from bar1 on --
    // d[1]>0[1] at bar0 is d[1](na)>na => false regardless, so bar0 stays na either way.
    // bar1: d<0(T,d=-1) and d[1](=1)>0[1](=0,T) -> 999. bar4: d<0(T,d=-1) and d[1](=1)>0 -> 999.
    // bar6: d<0(T,d=-1) and d[1](=2)>0 -> 999. rest -> na.
    expect(obs(src)).toEqual([NaN, 999, NaN, NaN, 999, NaN, 999, NaN]);
  });

  it("does not affect ordinary identifier/bar-series history indexing (no cross-contamination)", () => {
    const src = ["var float __obs_a = na", "__obs_a := close[1]"].join("\n");
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([NaN, 2, 4, 3, 9, 2, 11, 3]);
  });
});
