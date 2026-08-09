// ta.dema/ta.ao 파이프라인 배선(analyzer -> codegen -> execution) hand-verified 테스트(배치25 (3),
// DIVERGENCES.md #175). 둘 다 pine2py wavealgo/ta/에 대응 구현이 전혀 없어(전수 grep 0건) 오라클
// 골든 생성(gen_oracle.py) 자체가 불가능한 신규 함수 — tests/unit/runtime.test.ts가 이미 rt.ta.dema/
// rt.ta.ao 함수 자체의 수치를 손 계산으로 검증했으니, 이 파일은 실제 Pine 소스가 analyzer/codegen을
// 거쳐 그 함수와 정확히 같은 값을 내는지(taSlot 배선, ta.ao()의 암묵 hl2 주입 포함)만 확인한다.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import { dema, ao } from "../../src/runtime/ta";

function obs(source: string, data: OHLCVData, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("ta.dema pipeline wiring (hand-verified, no pine2py oracle)", () => {
  it("matches rt.ta.dema(close, 2) bar-by-bar through the full transpile+execute pipeline", () => {
    const closes = [10, 20, 30, 40, 50];
    const data: OHLCVData = {
      open: closes,
      high: closes,
      low: closes,
      close: closes,
      volume: [1, 1, 1, 1, 1],
    };
    const src = ["var float __obs_a = na", "__obs_a := ta.dema(close, 2)"].join("\n");

    const state = {};
    const expected = closes.map((c) => dema(state, c, 2));
    expect(obs(src, data)).toEqual(expected);
  });
});

describe("ta.ao pipeline wiring (hand-verified, no pine2py oracle)", () => {
  it("matches rt.ta.ao(hl2) bar-by-bar through the full transpile+execute pipeline, including the implicit hl2 injection", () => {
    const n = 40;
    const highs = Array.from({ length: n }, (_, i) => 105 + 10 * Math.sin(i * 0.5));
    const lows = Array.from({ length: n }, (_, i) => 95 + 10 * Math.sin(i * 0.5));
    const data: OHLCVData = {
      open: highs,
      high: highs,
      low: lows,
      close: highs,
      volume: highs.map(() => 1),
    };
    const src = ["var float __obs_a = na", "__obs_a := ta.ao()"].join("\n");

    const state = {};
    const expected = highs.map((h, i) => ao(state, (h + lows[i]!) / 2));
    const actual = obs(src, data);
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const e = expected[i]!;
      const a = actual[i] as number;
      if (Number.isNaN(e)) expect(a).toBeNaN();
      else expect(a).toBeCloseTo(e, 9);
    }
  });
});
