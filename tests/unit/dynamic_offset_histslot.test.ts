// histSlot 대상 동적(런타임) 히스토리 오프셋(C365, ROADMAP P4 🔴🔴 (c) 게이트 완화) hand-verified
// 파이프라인 테스트. 오라클(dynamic_offset_histslot)이 못 덮는 축을 여기서 검증한다:
// - 콜사이트 독립성: pine2py ctx.param()은 이름 문자열 하나로 모든 콜사이트가 상태를 공유(MEMORY.md
//   C9)라 오라클 무효 — 손계산 기대값으로 대체(udf_history.test.ts와 동일 원칙).
// - 조건부 호출 바의 NaN 갭 + 동적 오프셋 조합.
// - ta.*(...)[동적]: pine2py가 이 문법 자체에서 크래시(C340 오라클 구조적 불가)라 hand-verified 전용.
// - 런타임에 0으로 떨어지는 오프셋(rt.histGet의 "0 → 현재 값" 분기)과 음수/워밍업 NaN 가드.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [2, 3, 4, 5, 6],
  low: [0, 1, 2, 3, 4],
  close: [10, 20, 30, 40, 50],
  volume: [1, 1, 1, 1, 1],
  time: [0, 60000, 120000, 180000, 240000],
};

function obs(source: string, key: string): number[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`] as number);
}

describe("dynamic history offset on histSlot targets (C365 (c) gate relaxation, hand-verified)", () => {
  it("reads a top-level var history with a modulo-cycling offset (runtime 0 → current value branch)", () => {
    const src = [
      "var float acc = 0.0",
      "acc := acc + close",
      "n = bar_index % 2",
      "var float __obs = na",
      "__obs := acc[n]",
    ].join("\n");
    // acc = [10, 30, 60, 100, 150]; n = [0,1,0,1,0] → [현재, 이전바, 현재, 이전바, 현재].
    expect(obs(src, "__obs")).toEqual([10, 10, 60, 60, 150]);
  });

  it("returns NaN during warmup when the dynamic offset exceeds recorded history", () => {
    const src = [
      "var float acc = 0.0",
      "acc := acc + close",
      "k = 3",
      "var float __obs = na",
      "__obs := acc[k]",
    ].join("\n");
    // 고정 k=3이지만 리터럴이 아닌 식별자라 동적 경로 — bar 3부터 acc의 bar 0 값(10)이 보인다.
    expect(obs(src, "__obs")).toEqual([NaN, NaN, NaN, 10, 30]);
  });

  it("returns NaN for a negative dynamic offset on a top-level var (no lookahead)", () => {
    const src = [
      "var float acc = 0.0",
      "acc := acc + close",
      "k = -1",
      "var float __obs = na",
      "__obs := acc[k]",
    ].join("\n");
    expect(obs(src, "__obs")).toEqual([NaN, NaN, NaN, NaN, NaN]);
  });

  it("reads a top-level '=' local history with a dynamic offset (bar-final value semantics)", () => {
    const src = [
      "x = close * 2",
      "n = bar_index % 2",
      "var float __obs = na",
      "__obs := x[n]",
    ].join("\n");
    // x = [20, 40, 60, 80, 100]; n=[0,1,0,1,0] → [20, 20, 60, 60, 100].
    expect(obs(src, "__obs")).toEqual([20, 20, 60, 60, 100]);
  });

  it("keeps two call sites independent when a UDF param history uses a dynamic offset", () => {
    const src = [
      "f(src, k) =>",
      "    src[k]",
      "n = 1",
      "a = f(close, n)",
      "b = f(open, n)",
      "var float __obs_a = na",
      "__obs_a := a",
      "var float __obs_b = na",
      "__obs_b := b",
    ].join("\n");
    expect(obs(src, "__obs_a")).toEqual([NaN, 10, 20, 30, 40]);
    expect(obs(src, "__obs_b")).toEqual([NaN, 1, 2, 3, 4]);
  });

  it("leaves NaN gaps on skipped bars for a conditionally-called UDF param history with dynamic offset", () => {
    const src = [
      "f(src, k) =>",
      "    src[k]",
      "var float __obs = na",
      "n = 1",
      "if bar_index % 2 == 0",
      "    __obs := f(close, n)",
    ].join("\n");
    // 짝수 바에만 호출: record는 bar 0/2/4 커서 위치에만. bar 2의 src[1]은 bar 1 커서(미기록 NaN),
    // 홀수 바 __obs는 직전 짝수 바 값이 var로 유지(대입 없음).
    expect(obs(src, "__obs")).toEqual([NaN, NaN, NaN, NaN, NaN]);
  });

  it("reads a UDF-internal '=' local history with a dynamic offset", () => {
    const src = [
      "g(k) =>",
      "    lv = close + open",
      "    lv[k]",
      "n = 1",
      "var float __obs = na",
      "__obs := g(n)",
    ].join("\n");
    // lv = [11, 22, 33, 44, 55] → lv[1] = 이전 바 값.
    expect(obs(src, "__obs")).toEqual([NaN, 11, 22, 33, 44]);
  });

  it("reads a UDF-internal var history with a dynamic offset (bar-end record semantics)", () => {
    const src = [
      "h(k) =>",
      "    var float vac = 0.0",
      "    vac := vac + close",
      "    vac[k]",
      "n = bar_index % 2",
      "var float __obs = na",
      "__obs := h(n)",
    ].join("\n");
    // vac = [10, 30, 60, 100, 150]; n=[0,1,0,1,0] → [현재, 이전바, ...] = [10, 10, 60, 60, 150].
    expect(obs(src, "__obs")).toEqual([10, 10, 60, 60, 150]);
  });

  it("reads a stateful TA call result history with a dynamic offset (inline record + runtime get)", () => {
    const src = [
      "n = bar_index % 2",
      "var float __obs = na",
      "__obs := ta.sma(close, 2)[n]",
    ].join("\n");
    // sma2 = [NaN, 15, 25, 35, 45]; n=[0,1,0,1,0]. 인라인 record 직후 get이라 n=0은 현재 콜 값.
    expect(obs(src, "__obs")).toEqual([NaN, NaN, 25, 25, 45]);
  });

  it("returns the current call value when a TA-call dynamic offset evaluates to 0 every bar", () => {
    const src = ["k = 0", "var float __obs = na", "__obs := ta.sma(close, 2)[k]"].join("\n");
    expect(obs(src, "__obs")).toEqual([NaN, 15, 25, 35, 45]);
  });
});
