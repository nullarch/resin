// barstate.*/session.* 히스토리(C521, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 서브그룹
// 바레 네임스페이스 변수 10건) hand-verified 파이프라인 테스트. BARSTATE_PROPS/SESSION_PROPS
// (analyzer.ts)의 값은 $.idx/$.barCount만의 순수 식/상수(배치 리플레이 고정 가정)라 pine2py 자신은
// 이 속성을 Series가 아니라 매 바 재계산되는 plain bool property로 구현해 `[]` subscript 자체가
// 런타임 크래시한다(`'bool' object is not subscriptable'`, gen_oracle.py 실측 확인) — 오라클 대조가
// 원천 불가한 pine2py 자체 latent 버그(MEMORY C9/C14/C18과 동일 패턴)라 이 파일은 손 계산 기대값으로
// 검증한다. barCount=8(idx 0..7, lastIndex=7)로 고정 — 아래 각 케이스의 기대 배열은 BARSTATE_PROPS/
// SESSION_PROPS 원본 식을 ($.idx - N)으로 직접 치환해 손으로 계산한 것. session.isfirstbar/islastbar
// read the bar's time on the symbol's session schedule instead, so their cases run on timed bars
// (sessionObs).

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5, 6, 7, 8],
  high: [2, 3, 4, 5, 6, 7, 8, 9],
  low: [0, 1, 2, 3, 4, 5, 6, 7],
  close: [10, 20, 30, 40, 50, 60, 70, 80],
  volume: [1, 1, 1, 1, 1, 1, 1, 1],
};

function obs(source: string, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

// session.isfirstbar/islastbar read the bar's time on the symbol's session schedule: eight hourly
// bars from 2025-01-03 21:00 UTC on resin's default schedule (open around the clock, sessions from
// 00:00 to 23:59:59 UTC). Bar 2 (23:00) is the day's last bar and bar 3 (00:00) the next day's first.
const hourly: OHLCVData = { ...data, time: Array.from({ length: 8 }, (_, i) => Date.UTC(2025, 0, 3, 21 + i)) };

function sessionObs(source: string): unknown[] {
  const result = runPipeline(source, hourly, {}, { chartTf: "60" });
  return result.bars.map((b) => b["var:__obs_a"]);
}

describe("barstate/session-builtin history (C521, hand-verified)", () => {
  it("computes barstate.isfirst[1] with NaN warmup, true exactly at idx=1", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.isfirst[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, true, false, false, false, false, false, false]);
  });

  it("computes barstate.isfirst[3] with NaN warmup, true exactly at idx=3", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.isfirst[3]"].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, NaN, true, false, false, false, false]);
  });

  it("computes barstate.islastconfirmedhistory[1] (idx===barCount-2 shifted), true exactly at idx=7", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.islastconfirmedhistory[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, false, false, false, false, false, false, true]);
  });

  // Every bar of a closed dataset is historical (resin-harness suites/lang/probes/L32), so
  // ishistory[N] is the constant true once N bars exist.
  it("keeps barstate.ishistory[N>=1] always true after warmup", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.ishistory[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, true, true, true, true, true, true, true]);
  });

  // 구조적 항등식: islast[N>=1] = ((idx-N) === barCount-1). idx<=barCount-1인 한 idx-N<barCount-1이라
  // 절대 참이 될 수 없다(과거 바가 "미래의 마지막 바"일 수 없음) — 워밍업 이후 항상 false.
  it("keeps barstate.islast[N>=1] always false after warmup (structural invariant — a past bar can't be the future last bar)", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.islast[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, false, false, false, false, false, false, false]);
  });

  it("computes barstate.isrealtime[1] as a warmup-guarded constant false (no bar of a closed dataset is realtime)", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.isrealtime[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, false, false, false, false, false, false, false]);
  });

  it("computes barstate.isconfirmed[1] as a warmup-guarded constant (always true once available)", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.isconfirmed[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, true, true, true, true, true, true, true]);
  });

  it("computes barstate.isnew[2] as a warmup-guarded constant with a 2-bar warmup window", () => {
    const src = ["var bool __obs_a = na", "__obs_a := barstate.isnew[2]"].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, true, true, true, true, true, true]);
  });

  it("computes session.ispremarket[1] as a warmup-guarded constant false", () => {
    const src = ["var bool __obs_a = na", "__obs_a := session.ispremarket[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, false, false, false, false, false, false, false]);
  });

  it("computes session.ispostmarket[3] as a warmup-guarded constant false", () => {
    const src = ["var bool __obs_a = na", "__obs_a := session.ispostmarket[3]"].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, NaN, false, false, false, false, false]);
  });

  it("computes session.ismarket[1] as a warmup-guarded constant true", () => {
    const src = ["var bool __obs_a = na", "__obs_a := session.ismarket[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, true, true, true, true, true, true, true]);
  });

  it("computes session.isfirstbar[2] from the bar two back, true two bars after the 00:00 bar", () => {
    const src = ["var bool __obs_a = na", "__obs_a := session.isfirstbar[2]"].join("\n");
    expect(sessionObs(src)).toEqual([NaN, NaN, false, false, false, true, false, false]);
  });

  it("computes session.islastbar_regular[1] from the previous bar, true the bar after the 23:00 bar", () => {
    const src = ["var bool __obs_a = na", "__obs_a := session.islastbar_regular[1]"].join("\n");
    expect(sessionObs(src)).toEqual([NaN, false, false, true, false, false, false, false]);
  });

  it("treats [0] as an identity read equal to the bare (unindexed) value, no warmup gap", () => {
    const src = ["var bool __obs_bare = na", "var bool __obs_zero = na", "__obs_bare := barstate.ishistory", "__obs_zero := barstate.ishistory[0]"].join(
      "\n",
    );
    const bare = obs(src, "__obs_bare");
    const zero = obs(src, "__obs_zero");
    expect(zero).toEqual(bare);
    // Every bar of a closed dataset, the last one included, is historical (resin-harness
    // suites/lang/probes/L32, oracle-certified).
    expect(bare).toEqual([true, true, true, true, true, true, true, true]);
  });

  it("keeps exact values inside a conditional branch (stateless derivation — no record-gap axis)", () => {
    // close>45는 idx>=4에서만 참 — isfirst[4]는 idx=4에서만 true(shifted=0), 이후 false.
    const src = ["var bool __obs_a = na", "if close > 45", "    __obs_a := barstate.isfirst[4]"].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, NaN, NaN, true, false, false, false]);
  });

  it("keeps exact values inside a UDF body without any func-local hist slots", () => {
    const src = ["f() =>", "    barstate.isfirst[2]", "var bool __obs_a = na", "__obs_a := f()"].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, true, false, false, false, false, false]);
  });
});
