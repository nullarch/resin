// ta.max/ta.min 파이프라인 배선(analyzer -> codegen -> execution) hand-verified 테스트(배치25 (3),
// DIVERGENCES.md #176). 둘 다 pine2py wavealgo/ta/에 대응 구현이 전혀 없어(전수 grep 0건) 오라클
// 골든 생성(gen_oracle.py) 자체가 불가능한 신규 함수 — tests/unit/runtime.test.ts가 이미 rt.ta.cumMax/
// rt.ta.cumMin 함수 자체의 수치를 검증했으니, 이 파일은 실제 Pine 소스가 analyzer/codegen을 거쳐 그
// 함수와 정확히 같은 값을 내는지(taSlot 배선)만 확인한다.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import { cumMax, cumMin } from "../../src/runtime/ta";

function obs(source: string, data: OHLCVData, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("ta.max pipeline wiring (hand-verified, no pine2py oracle)", () => {
  it("matches rt.ta.cumMax(close) bar-by-bar through the full transpile+execute pipeline", () => {
    const closes = [10, 30, 20, 50, 40, 5, 60];
    const data: OHLCVData = {
      open: closes,
      high: closes,
      low: closes,
      close: closes,
      volume: closes.map(() => 1),
    };
    const src = ["var float __obs_a = na", "__obs_a := ta.max(close)"].join("\n");

    const state = {};
    const expected = closes.map((c) => cumMax(state, c));
    expect(obs(src, data)).toEqual(expected);
  });
});

describe("ta.min pipeline wiring (hand-verified, no pine2py oracle)", () => {
  it("matches rt.ta.cumMin(close) bar-by-bar through the full transpile+execute pipeline", () => {
    const closes = [10, 30, 20, 50, 40, 5, 60];
    const data: OHLCVData = {
      open: closes,
      high: closes,
      low: closes,
      close: closes,
      volume: closes.map(() => 1),
    };
    const src = ["var float __obs_a = na", "__obs_a := ta.min(close)"].join("\n");

    const state = {};
    const expected = closes.map((c) => cumMin(state, c));
    expect(obs(src, data)).toEqual(expected);
  });
});
