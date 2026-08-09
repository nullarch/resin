// ta.rci 파이프라인 배선(analyzer -> codegen -> execution) hand-verified 테스트(배치25 (3),
// DIVERGENCES.md #177). pine2py wavealgo/ta/에 대응 구현이 전혀 없어(전수 grep 0건) 오라클 골든
// 생성(gen_oracle.py) 자체가 불가능한 신규 함수 — tests/unit/runtime.test.ts가 이미 rt.ta.rci
// 함수 자체의 수치를 검증했으니, 이 파일은 실제 Pine 소스가 analyzer/codegen을 거쳐 그 함수와
// 정확히 같은 값을 내는지(taSlot 배선)만 확인한다.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import { rci } from "../../src/runtime/ta";

function obs(source: string, data: OHLCVData, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("ta.rci pipeline wiring (hand-verified, no pine2py oracle)", () => {
  it("matches rt.ta.rci(close, 9) bar-by-bar through the full transpile+execute pipeline", () => {
    const closes = [10, 30, 20, 50, 40, 5, 60, 70, 65, 80, 75, 90];
    const data: OHLCVData = {
      open: closes,
      high: closes,
      low: closes,
      close: closes,
      volume: closes.map(() => 1),
    };
    const src = ["var float __obs_a = na", "__obs_a := ta.rci(close, 9)"].join("\n");

    const state = {};
    const expected = closes.map((c) => rci(state, c, 9));
    expect(obs(src, data)).toEqual(expected);
  });

  it("keeps independent taSlots per call site (two ta.rci calls with different lengths)", () => {
    const closes = [10, 30, 20, 50, 40, 5, 60];
    const data: OHLCVData = {
      open: closes,
      high: closes,
      low: closes,
      close: closes,
      volume: closes.map(() => 1),
    };
    const src = [
      "var float __obs_a = na",
      "var float __obs_b = na",
      "__obs_a := ta.rci(close, 3)",
      "__obs_b := ta.rci(close, 5)",
    ].join("\n");

    const stateA = {};
    const stateB = {};
    const expectedA = closes.map((c) => rci(stateA, c, 3));
    const expectedB = closes.map((c) => rci(stateB, c, 5));
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual(expectedA);
    expect(result.bars.map((b) => b["var:__obs_b"])).toEqual(expectedB);
  });
});
