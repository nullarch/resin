// UDF 매개변수/내부 '=' 로컬/내부 var 히스토리(C364, ROADMAP 🔴🔴 (b)슬라이스) hand-verified
// 파이프라인 테스트. 오라클(udf_history_basic)이 못 덮는 축을 여기서 검증한다:
// - 콜사이트 독립성: pine2py ctx.param()은 이름 문자열 하나로 모든 콜사이트가 상태를 공유(MEMORY.md
//   C9와 동형)라 오라클 무효 — 손계산 기대값으로 대체.
// - 조건부 호출 바의 NaN 갭: ROADMAP (b) 설계("조건부 호출 바에서는 기록이 없으므로 갭") 그대로.
//   TV 압축(per-call) 히스토리와는 어긋날 수 있는 미검증 축(DIVERGENCES 참조) — 여기 assertion은
//   "설계된 갭 시맨틱"의 회귀 방지이지 TV 정합 증명이 아니다.
// - 같은 바 다중 호출(루프): Series.record 현재 바 커서 덮어쓰기 → 마지막 호출 값 승리.
// - UDF 내부 var 히스토리는 바-종료 기록이라 조건부 호출에도 이전 실행 최종값이 유지(persist ==
//   per-call 압축과 등가 — var는 호출 밖에서 값이 변하지 않으므로).

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

describe("UDF history (C364 (b) slice, hand-verified)", () => {
  it("returns the previous-bar param value via an entry record (unconditional single call site)", () => {
    const src = ["f(src) =>", "    src[1]", "var float __obs_a = na", "__obs_a := f(close)"].join("\n");
    expect(obs(src, "__obs_a")).toEqual([NaN, 10, 20, 30, 40]);
  });

  it("keeps two call sites of the same UDF fully independent (separate __histBase blocks)", () => {
    const src = [
      "f(src) =>",
      "    src[1]",
      "a = f(close)",
      "b = f(open)",
      "var float __obs_a = na",
      "__obs_a := a",
      "var float __obs_b = na",
      "__obs_b := b",
    ].join("\n");
    expect(obs(src, "__obs_a")).toEqual([NaN, 10, 20, 30, 40]);
    expect(obs(src, "__obs_b")).toEqual([NaN, 1, 2, 3, 4]);
  });

  it("records a UDF '=' local after each assignment (last write wins within one call)", () => {
    const src = ["g() =>", "    val = close * 2", "    val := val + 1", "    val[1]", "var float __obs_c = na", "__obs_c := g()"].join("\n");
    // val 최종값 = close*2+1 → [21, 41, 61, 81, 101], val[1]은 그 이전 바 최종값.
    expect(obs(src, "__obs_c")).toEqual([NaN, 21, 41, 61, 81]);
  });

  it("reads a UDF-internal var's previous-execution value via the bar-end $.fnVars record", () => {
    const src = ["h() =>", "    var float acc = 0.0", "    acc := acc + close", "    acc[1]", "var float __obs_d = na", "__obs_d := h()"].join("\n");
    // acc 누적 [10,30,60,100,150] → acc[1] = 이전 바 최종값.
    expect(obs(src, "__obs_d")).toEqual([NaN, 10, 30, 60, 100]);
  });

  it("reproduces the heikin-ashi self-referential '=' local idiom (read-before-write within the same call)", () => {
    const src = [
      "ha() =>",
      "    haC = (open + high + low + close) / 4",
      "    haO = 0.0",
      "    haO := na(haO[1]) ? (open + close) / 2 : (haO[1] + haC[1]) / 2",
      "    haO",
      "var float __obs_e = na",
      "__obs_e := ha()",
    ].join("\n");
    // bar0: (1+10)/2=5.5. bar1: (5.5 + (1+2+0+10)/4)/2 = (5.5+3.25)/2 = 4.375.
    // bar2: haC1=(2+3+1+20)/4=6.5 → (4.375+6.5)/2=5.4375. bar3: haC2=(3+4+2+30)/4=9.75 →
    // (5.4375+9.75)/2=7.59375. bar4: haC3=(4+5+3+40)/4=13 → (7.59375+13)/2=10.296875.
    const got = obs(src, "__obs_e");
    const want = [5.5, 4.375, 5.4375, 7.59375, 10.296875];
    for (let i = 0; i < want.length; i++) expect(got[i]).toBeCloseTo(want[i]!, 9);
  });

  it("leaves NaN gaps in param history on bars where a conditional call site did not execute (designed (b) semantics)", () => {
    const src = [
      "f(src) =>",
      "    src[1]",
      "var float __obs_f = na",
      "__obs_f := na",
      "if close > 25",
      "    __obs_f := f(close)",
    ].join("\n");
    // 호출 바: bar2(30)/bar3(40)/bar4(50). bar2의 src[1]은 bar1이 미호출이라 NaN 갭(설계 그대로),
    // bar3부터는 직전 바가 호출됐으므로 그 바의 param 값.
    expect(obs(src, "__obs_f")).toEqual([NaN, NaN, NaN, 30, 40]);
  });

  it("persists a UDF-internal var's history across skipped bars (bar-end record == per-call compacted history)", () => {
    const src = [
      "h() =>",
      "    var float acc = 0.0",
      "    acc := acc + close",
      "    acc[1]",
      "var float __obs_g = na",
      "__obs_g := na",
      "if close != 30",
      "    __obs_g := h()",
    ].join("\n");
    // 호출 바: 0,1,3,4. acc: 10,30,-,70,120 (bar2 스킵 — 값 유지 30). bar3의 acc[1]은 bar2의
    // 바-종료 기록(스킵됐지만 var라 30 유지) = 이전 실행(bar1) 최종값과 동일 — persist 등가 검증.
    expect(obs(src, "__obs_g")).toEqual([NaN, 10, NaN, 30, 70]);
  });

  it("keeps only the last call's value for a same-bar loop over one call site (Series.record overwrite)", () => {
    const src = [
      "f(x) =>",
      "    x[1]",
      "last = 0.0",
      "for i = 1 to 3",
      "    last := f(close + i)",
      "var float __obs_h = na",
      "__obs_h := last",
    ].join("\n");
    // 같은 콜사이트가 바마다 3회 실행 — record는 마지막 호출 인자(close+3)로 덮어써지고,
    // 다음 바의 x[1]은 그 마지막 값. bar1: close0+3=13, bar2: 23, ...
    expect(obs(src, "__obs_h")).toEqual([NaN, 13, 23, 33, 43]);
  });

  it("supports history in a method body (same __histBase mechanism as UDFs)", () => {
    const src = [
      "type Foo",
      "    float v",
      "method lag(Foo self, float s) =>",
      "    s[1]",
      "p = Foo.new(1.0)",
      "var float __obs_i = na",
      "__obs_i := p.lag(close)",
    ].join("\n");
    expect(obs(src, "__obs_i")).toEqual([NaN, 10, 20, 30, 40]);
  });

  it("supports history inside a UDF called from another UDF (nested call, compile-time per-site base)", () => {
    const src = [
      "inner(x) =>",
      "    x[1]",
      "outer() =>",
      "    inner(close * 10)",
      "var float __obs_j = na",
      "__obs_j := outer()",
    ].join("\n");
    expect(obs(src, "__obs_j")).toEqual([NaN, 100, 200, 300, 400]);
  });

  // C388: '=' 로컬이 UDF body-root가 아니라 if 블록 안에 선언돼도 히스토리를 지원한다(wild
  // top/btm류 클러스터, C387 next_hint (A) — `if cond \n max = ... \n ... \n max[1]`류). 안전성은
  // resolveFuncInternalRole의 조상-스코프 탐색이 "읽기 지점이 선언 스코프의 자손"임을 구조적으로
  // 보장하는 데서 나온다(JS let 블록 스코프 가시성과 동일 조건) — oracle/cases/udf_history_nested가
  // pine2py와 직접 대조하고, 여기서는 그 오라클이 못 덮는 축(콜사이트 무관 손계산 확인 + 동적
  // 오프셋)을 검증한다.
  it("supports history on a '=' local declared inside an if-block (not just udf-body root)", () => {
    const src = [
      "f() =>",
      "    y = 0.0",
      "    if close > open",
      "        w = close",
      "        y := w[1]",
      "    y",
      "var float __obs_k = na",
      "__obs_k := f()",
    ].join("\n");
    // close>open은 매 바 참 -> w는 매 바 기록, w[1]은 이전 바 close. body-root 버전(__obs_c)과
    // 동일한 패턴([NaN,10,20,30,40]) — 중첩 위치 자체가 값을 바꾸지 않음을 확인.
    expect(obs(src, "__obs_k")).toEqual([NaN, 10, 20, 30, 40]);
  });

  it("leaves NaN gaps in a nested '=' local's history when its enclosing if-block is skipped (declaration itself is conditional)", () => {
    const src = [
      "f() =>",
      "    y = 0.0",
      "    if close > 25",
      "        w = close",
      "        y := w[1]",
      "    y",
      "var float __obs_l = na",
      "__obs_l := f()",
    ].join("\n");
    // close: [10,20,30,40,50] -> if 조건은 bar2부터 참. bar0/1은 w 선언 자체가 스킵되므로 y=0.0
    // 유지(초기값). bar2: w=30 기록, w[1]=이전 바 미기록이라 NaN -> y=NaN. bar3: w[1]=30(bar2) ->
    // y=30. bar4: w[1]=40(bar3) -> y=40.
    expect(obs(src, "__obs_l")).toEqual([0, 0, NaN, 30, 40]);
  });

  it("supports a dynamic (loop-variable) history offset on a nested '=' local (wild `max[i]` idiom, C388)", () => {
    const src = [
      "f() =>",
      "    if close > open",
      "        w = close",
      "        total = 0.0",
      "        for i = 1 to 2",
      "            total := total + w[i]",
      "        total",
      "    else",
      "        0.0",
      "var float __obs_m = na",
      "__obs_m := f()",
    ].join("\n");
    // close>open 매 바 참. bar0: w[1]/w[2] 둘 다 미기록 NaN -> total NaN. bar1: w[1]=10(bar0),
    // w[2]=NaN(bar-1 없음) -> NaN. bar2: w[1]=20,w[2]=10 -> 30. bar3: w[1]=30,w[2]=20 -> 50.
    // bar4: w[1]=40,w[2]=30 -> 70.
    expect(obs(src, "__obs_m")).toEqual([NaN, NaN, 30, 50, 70]);
  });
});
