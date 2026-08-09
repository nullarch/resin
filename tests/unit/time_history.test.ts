// time 계열 빌트인 히스토리(C368, wild 1위 클러스터 슬라이스 (i)) hand-verified 파이프라인
// 테스트. 오라클(time_history_basic)이 못 덮는 축을 여기서 검증한다:
// - time_close[n]: pine2py ctx.time_close는 항상 0인 dead 프로퍼티(C342)라 오라클 무효 —
//   pine2js는 "다음 바 open 시각" 근사(timeCloseAt)를 손계산 기대값으로 검증.
// - timenow[n]: pine2py는 실제 벽시계라 비결정적 — 배치 리플레이 상수(lastBarTimeMs) 시맨틱을
//   손계산으로 검증.
// - 조건부/UDF 위치: 상태 없는 파생이라 record 타이밍 갭이 원천적으로 없음 — histSlot 축과 달리
//   조건부 바에서도 정확한 값이 나와야 한다(이게 이 슬라이스의 구조적 이점).
// - time 채널 부재 폴백: barTimeMs와 동일한 0 폴백 + 워밍업 NaN 가드는 채널 유무와 무관.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

// 60초 간격 5바 — time[n] 기대값을 손으로 직접 짚을 수 있는 최소 배열.
const T = [1700000000000, 1700000060000, 1700000120000, 1700000180000, 1700000240000];
const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [2, 3, 4, 5, 6],
  low: [0, 1, 2, 3, 4],
  close: [10, 20, 30, 40, 50],
  volume: [1, 1, 1, 1, 1],
  time: T,
};

function obs(source: string, key: string, d: OHLCVData = data): number[] {
  const result = runPipeline(source, d);
  return result.bars.map((b) => b[`var:${key}`] as number);
}

describe("time-builtin history (C368 slice (i), hand-verified)", () => {
  it("returns the previous bar's open time for time[1] with NaN warmup", () => {
    const src = ["var float __obs_a = na", "__obs_a := time[1]"].join("\n");
    expect(obs(src, "__obs_a")).toEqual([NaN, T[0]!, T[1]!, T[2]!, T[3]!]);
  });

  it("computes time_close[1] as the previous bar's close time == the current bar's open time", () => {
    const src = ["var float __obs_a = na", "__obs_a := time_close[1]"].join("\n");
    // bar i(>=1)에서 직전 바의 close 시각 = 이번 바의 open 시각(gapless 근사, timeCloseMs와 동일 설계).
    expect(obs(src, "__obs_a")).toEqual([NaN, T[1]!, T[2]!, T[3]!, T[4]!]);
  });

  it("treats timenow[n] as the replay constant with a warmup guard", () => {
    const src = ["var float __obs_a = na", "__obs_a := timenow[2]"].join("\n");
    const last = T[4]!;
    expect(obs(src, "__obs_a")).toEqual([NaN, NaN, last, last, last]);
  });

  it("keeps exact values inside a conditional branch (stateless derivation — no record-gap axis)", () => {
    const src = ["var float __obs_a = na", "if close > 15", "    __obs_a := time[1]"].join("\n");
    // bar0은 조건 미충족이라 var가 이전 값(na) 유지 — 조건 충족 바에서는 항상 정확한 직전 바 시각.
    expect(obs(src, "__obs_a")).toEqual([NaN, T[0]!, T[1]!, T[2]!, T[3]!]);
  });

  it("keeps exact values inside a UDF body without any func-local hist slots", () => {
    const src = ["f(x) =>", "    x + time[1] - time[1]", "var float __obs_a = na", "__obs_a := f(close) == close ? time[2] : na"].join("\n");
    expect(obs(src, "__obs_a")).toEqual([NaN, NaN, T[0]!, T[1]!, T[2]!]);
  });

  it("supports a dynamic (runtime) offset with out-of-range values collapsing to NaN", () => {
    const src = ["var float __obs_a = na", "n = 5 - bar_index", "__obs_a := time[n]"].join("\n");
    // n = [5,4,3,2,1] — idx < n인 바(0~1)는 NaN, 이후는 time[idx-n] = 항상 T[2*idx-5].
    expect(obs(src, "__obs_a")).toEqual([NaN, NaN, NaN, T[1]!, T[3]!]);
  });

  it("falls back to 0 (barTimeMs parity) for valid offsets when the time channel is absent, NaN during warmup", () => {
    const noTime: OHLCVData = { ...data };
    delete (noTime as { time?: ArrayLike<number> }).time;
    const src = ["var float __obs_a = na", "var float __obs_b = na", "__obs_a := time[1]", "__obs_b := hour[1]"].join("\n");
    expect(obs(src, "__obs_a", noTime)).toEqual([NaN, 0, 0, 0, 0]);
    expect(obs(src, "__obs_b", noTime)).toEqual([NaN, 0, 0, 0, 0]);
  });

  it("propagates warmup NaN through time_tradingday[n] (tradingDayStart NaN guard)", () => {
    const src = ["var float __obs_a = na", "__obs_a := time_tradingday[3]"].join("\n");
    const out = obs(src, "__obs_a");
    expect(out.slice(0, 3)).toEqual([NaN, NaN, NaN]);
    expect(out[3]).toBe(Math.floor(T[0]! / 86400000) * 86400000);
    expect(out[4]).toBe(Math.floor(T[1]! / 86400000) * 86400000);
  });

  it("keeps hour[n]/dayofweek[n] equal to recomputing the component from time[n] (composition identity)", () => {
    const src = [
      "var float __obs_h = na",
      "var float __obs_hf = na",
      "var float __obs_d = na",
      "var float __obs_df = na",
      "__obs_h := hour[1]",
      "__obs_hf := hour(time[1])",
      "__obs_d := dayofweek[1]",
      "__obs_df := dayofweek(time[1])",
    ].join("\n");
    const result = runPipeline(src, data);
    for (const bar of result.bars) {
      expect(bar["var:__obs_h"]).toEqual(bar["var:__obs_hf"]);
      expect(bar["var:__obs_d"]).toEqual(bar["var:__obs_df"]);
    }
  });

  it("resolves last_bar_time[1] to the replay-constant last time with warmup NaN", () => {
    const src = ["var float __obs_a = na", "__obs_a := last_bar_time[1]"].join("\n");
    const last = T[4]!;
    expect(obs(src, "__obs_a")).toEqual([NaN, last, last, last, last]);
  });
});
