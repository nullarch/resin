// (high-low)[1]류 산술식(BinOp/UnaryOp) 히스토리(C522, wild "히스토리 인덱스는 식별자에만 지원"
// 클러스터 paren-expr 서브그룹, next_hint(C521)) hand-verified 파이프라인 테스트. pine2py 자신의
// `_gen_index_access`(codegen.py)는 obj가 Identifier(history_vars 등록분)일 때만 ctx.param()으로
// Series 승격하고, 그 외(BinOp 등)는 `f"{obj}[{idx}]"`를 그대로 방출한다 — `(high - low)`가 plain
// Python int/float로 평가된 뒤 `[1]` subscript를 걸어 실제로 크래시한다(gen_oracle.py 실측:
// "RuntimeError(\"Error executing bar 0: 'int' object is not subscriptable\")") — 오라클 대조가
// 원천 불가한 pine2py 자체 한계(MEMORY C9/C14/C18/C521과 동일 패턴)라 이 파일은 손 계산 기대값으로
// 검증한다.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2, 8, 3, 9, 4, 10],
  high: [3, 7, 5, 10, 6, 12, 8, 15],
  low: [0, 2, 1, 4, 2, 5, 3, 6],
  close: [2, 4, 3, 9, 2, 11, 3, 12],
  volume: [1, 1, 1, 1, 1, 1, 1, 1],
};

function obs(source: string, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("arithmetic-expression history: (high-low)[1] etc. (C522, hand-verified)", () => {
  it("computes (high-low)[1] shifted by one bar with NaN warmup", () => {
    const src = ["var float __obs_a = na", "__obs_a := (high - low)[1]"].join("\n");
    // high-low per bar: [3,5,4,6,4,7,5,9] -> shifted by 1.
    expect(obs(src)).toEqual([NaN, 3, 5, 4, 6, 4, 7, 5]);
  });

  it("computes (-close)[1] (UnaryOp) shifted by one bar with NaN warmup", () => {
    const src = ["var float __obs_a = na", "__obs_a := (-close)[1]"].join("\n");
    // -close per bar: [-2,-4,-3,-9,-2,-11,-3,-12] -> shifted by 1.
    expect(obs(src)).toEqual([NaN, -2, -4, -3, -9, -2, -11, -3]);
  });

  it("computes (close > open)[1] (comparison BinOp, bool-safe scalar) shifted by one bar", () => {
    const src = ["var float __obs_a = na", "__obs_a := (close > open)[1]"].join("\n");
    // close>open per bar (as 0/1 through the Float64Array histSlot): [1,0,1,1,0,1,0,1] -> shifted.
    expect(obs(src)).toEqual([NaN, 1, 0, 1, 1, 0, 1, 0]);
  });

  it("treats [0] as an identity read equal to the bare (unindexed) arithmetic expression", () => {
    const src = ["var float __obs_bare = na", "var float __obs_zero = na", "__obs_bare := (high - low)", "__obs_zero := (high - low)[0]"].join(
      "\n",
    );
    const bare = obs(src, "__obs_bare");
    const zero = obs(src, "__obs_zero");
    expect(zero).toEqual(bare);
    expect(bare).toEqual([3, 5, 4, 6, 4, 7, 5, 9]);
  });

  // 핵심 회귀 축(C468 eager-hoist 일반화): 삼항 lazy 분기에 있는 산술식 히스토리는 그 분기가
  // "선택되지 않은" 바에도 record가 무조건 실행돼야 한다(TV는 삼항 양쪽을 항상 평가) — 인라인
  // record가 원 표현식 위치에 그대로 남으면(호이스팅 누락) 분기가 스킵된 바의 histSlot이 NaN으로
  // 비어 다음 읽기에서 조용히 틀린 값(또는 stale NaN)을 낸다.
  it("eager-hoists a lazy-branch arithmetic history to record every bar regardless of branch selection", () => {
    const lazyData: OHLCVData = {
      open: [0, 0, 0, 0, 0],
      high: [10, 20, 30, 40, 50],
      low: [0, 0, 0, 0, 0],
      close: [3, 7, 3, 7, 3],
      volume: [1, 1, 1, 1, 1],
    };
    const source = ["var float __obs_a = na", "__obs_a := close > 5 ? (high - low)[1] : na"].join("\n");
    const result = runPipeline(source, lazyData);
    // condition (close>5): [F,T,F,T,F]. high-low: [10,20,30,40,50].
    // idx3 reads idx2's (high-low)=30 -- idx2's branch was NOT selected (F), proving the record
    // fired unconditionally (a non-hoisted inline record would leave idx2's slot at NaN instead).
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([NaN, 10, NaN, 30, NaN]);
  });
});
