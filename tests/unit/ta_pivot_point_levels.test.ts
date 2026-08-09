// ta.pivot_point_levels(type, anchor, developing=false) — hand-verified 테스트(C653, 배치25 (3)
// 트랙). pine2py wavealgo/ta/·codegen.py 전수 grep 0건이라 오라클 골든 생성 자체가 불가능한 신규
// 함수 — 공식/반환 계약 근거는 runtime/ta.ts pivotPointLevels() 주석 + DIVERGENCES.md 참조.
// 기대 리터럴은 전부 node로 사전 검산(MEMORY C12): H=110/L=90/C=100/Ocur=105/Oprev=95 기준.

import { describe, expect, it } from "vitest";
import { parse } from "../../src/transpiler/parser";
import { analyze } from "../../src/transpiler/analyzer";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import { pivotPointLevels, type PivotPointLevelsState } from "../../src/runtime/ta";

function analyzeSource(source: string) {
  return analyze(parse(source));
}

// 구간 1(바 0..2): H=110, L=90, C=100(close[2]), O=95(open[0]). anchor는 바 3 —
// 바 3의 open=105가 Woodie curOpen. 구간 2(바 3..5): H=111, L=100, C=104, O=105.
const DATA: OHLCVData = {
  open: [95, 96, 97, 105, 106, 107, 108, 109],
  high: [105, 110, 108, 107, 109, 111, 112, 113],
  low: [95, 90, 92, 100, 101, 102, 103, 104],
  close: [100, 99, 100, 102, 103, 104, 105, 106],
  volume: [1, 1, 1, 1, 1, 1, 1, 1],
};

// 직접 런타임 구동 헬퍼 — 바 b에 anchorBars 포함 여부로 anchor를 결정하며 마지막 바의 반환
// 배열 사본을 돌려준다.
function runDirect(type: string, anchorBars: number[], bars: number, developing = false): number[] {
  const state: PivotPointLevelsState = {};
  let out: number[] = [];
  for (let b = 0; b < bars; b++) {
    out = pivotPointLevels(
      state,
      type,
      anchorBars.includes(b),
      developing,
      DATA.open[b]!,
      DATA.high[b]!,
      DATA.low[b]!,
      DATA.close[b]!,
    );
  }
  return [...out];
}

describe("rt.ta.pivotPointLevels — 공식(hand-verified 리터럴)", () => {
  it("Traditional: 11레벨 전부 채움 [P,R1,S1,R2,S2,R3,S3,R4,S4,R5,S5]", () => {
    expect(runDirect("Traditional", [3], 4)).toEqual([100, 110, 90, 120, 80, 130, 70, 140, 60, 150, 50]);
  });

  it("Fibonacci: 7레벨(P~R3/S3), R4/S4/R5/S5는 na", () => {
    const got = runDirect("Fibonacci", [3], 4);
    expect(got.slice(0, 7)).toEqual([100, 107.64, 92.36, 112.36, 87.64, 120, 80]);
    expect(got.slice(7)).toEqual([NaN, NaN, NaN, NaN]);
  });

  it("Woodie: 새 구간 첫 바 open(anchor 바 open=105)을 P에 사용, 9레벨", () => {
    const got = runDirect("Woodie", [3], 4);
    expect(got.slice(0, 9)).toEqual([102.5, 115, 95, 122.5, 82.5, 135, 75, 155, 55]);
    expect(got.slice(9)).toEqual([NaN, NaN]);
  });

  it("Classic: R3/R4가 range 배수 사다리, 9레벨", () => {
    const got = runDirect("Classic", [3], 4);
    expect(got.slice(0, 9)).toEqual([100, 110, 90, 120, 80, 140, 60, 160, 40]);
    expect(got.slice(9)).toEqual([NaN, NaN]);
  });

  it("DM: close>prevOpen 분기(X=2H+L+C), 3레벨만", () => {
    // 구간 1: prevOpen=95(open[0]) < close=100 -> X=2*110+90+100=410.
    const got = runDirect("DM", [3], 4);
    expect(got.slice(0, 3)).toEqual([102.5, 115, 95]);
    expect(got.slice(3)).toEqual([NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN]);
  });

  it("DM: close<prevOpen과 close==prevOpen 분기", () => {
    // 최소 구동: 바0(open=105,H=110,L=90) -> anchor 바1. close[0]=100 < 105 -> X=2L+H+C=390.
    const st1: PivotPointLevelsState = {};
    pivotPointLevels(st1, "DM", false, false, 105, 110, 90, 100);
    const lt = [...pivotPointLevels(st1, "DM", true, false, 0, NaN, NaN, NaN)];
    expect(lt.slice(0, 3)).toEqual([97.5, 105, 85]);
    // close[0]=100 == prevOpen=100 -> X=H+L+2C=400.
    const st2: PivotPointLevelsState = {};
    pivotPointLevels(st2, "DM", false, false, 100, 110, 90, 100);
    const eq = [...pivotPointLevels(st2, "DM", true, false, 0, NaN, NaN, NaN)];
    expect(eq.slice(0, 3)).toEqual([100, 110, 90]);
  });

  it("Camarilla: 11레벨, R5/S5는 1.168 사다리(가설 — DIVERGENCES 참조)", () => {
    const got = runDirect("Camarilla", [3], 4);
    expect(got[0]).toBe(100);
    expect(got[1]).toBeCloseTo(101.83333333333333, 12);
    expect(got[2]).toBeCloseTo(98.16666666666667, 12);
    expect(got[3]).toBeCloseTo(103.66666666666667, 12);
    expect(got[4]).toBeCloseTo(96.33333333333333, 12);
    expect(got[5]).toBe(105.5);
    expect(got[6]).toBe(94.5);
    expect(got[7]).toBe(111);
    expect(got[8]).toBe(89);
    expect(got[9]).toBeCloseTo(117.424, 12);
    expect(got[10]).toBeCloseTo(82.576, 12);
  });

  it("첫 anchor 이전 바는 전부 na, anchor 사이 값 고정, 둘째 anchor에서 재계산", () => {
    const state: PivotPointLevelsState = {};
    const perBar: number[][] = [];
    for (let b = 0; b < 8; b++) {
      perBar.push([
        ...pivotPointLevels(state, "Traditional", b === 3 || b === 6, false, DATA.open[b]!, DATA.high[b]!, DATA.low[b]!, DATA.close[b]!),
      ]);
    }
    for (let b = 0; b <= 2; b++) expect(perBar[b]).toEqual(new Array(11).fill(NaN));
    const period1 = [100, 110, 90, 120, 80, 130, 70, 140, 60, 150, 50];
    expect(perBar[3]).toEqual(period1);
    expect(perBar[5]).toEqual(period1);
    // 구간 2(바 3..5): H=111, L=100, C=104 — node 검산 리터럴.
    const period2 = [105, 110, 99, 116, 94, 121, 88, 126, 82, 131, 76];
    expect(perBar[6]).toEqual(period2);
    expect(perBar[7]).toEqual(period2);
  });

  it("developing=true: 매 바 bar0부터의 누적치+현재 close로 재계산(첫 anchor 전에도 값 존재)", () => {
    // 바 0: H=105, L=95, C=100 -> P=100, R1=105, S1=95, R2=110, S2=90, R3=115, S3=85,
    // R4=120, S4=80, R5=125, S5=75 (node 검산).
    const state: PivotPointLevelsState = {};
    const bar0 = [...pivotPointLevels(state, "Traditional", false, true, 95, 105, 95, 100)];
    expect(bar0).toEqual([100, 105, 95, 110, 90, 115, 85, 120, 80, 125, 75]);
    // 바 1: H=110, L=90, C=99 -> 값이 바뀐다(고정 아님).
    const bar1 = [...pivotPointLevels(state, "Traditional", false, true, 96, 110, 90, 99)];
    expect(bar1[0]).toBeCloseTo((110 + 90 + 99) / 3, 12);
  });

  it("developing=true는 Woodie/DM에서 runtime.error와 동일한 예외", () => {
    const st: PivotPointLevelsState = {};
    expect(() => pivotPointLevels(st, "Woodie", false, true, 95, 105, 95, 100)).toThrow(/developing/);
    const st2: PivotPointLevelsState = {};
    expect(() => pivotPointLevels(st2, "DM", false, true, 95, 105, 95, 100)).toThrow(/developing/);
  });

  it("미지의 type 문자열/na는 전부 na(크래시 없음)", () => {
    expect(runDirect("Nonsense", [3], 4)).toEqual(new Array(11).fill(NaN));
  });

  it("na 바 NaN-skip: 구간 안 NaN high/low가 극값을 오염시키지 않음", () => {
    const state: PivotPointLevelsState = {};
    pivotPointLevels(state, "Traditional", false, false, 95, 105, 95, 100);
    pivotPointLevels(state, "Traditional", false, false, NaN, NaN, NaN, NaN); // na 바
    pivotPointLevels(state, "Traditional", false, false, 97, 110, 90, 100);
    const got = [...pivotPointLevels(state, "Traditional", true, false, 105, 107, 100, 102)];
    // H=110, L=90, C=100(직전 유효 close) -> Traditional 리터럴과 동일.
    expect(got).toEqual([100, 110, 90, 120, 80, 130, 70, 140, 60, 150, 50]);
  });

  it("반환 핸들 재사용 + 사용자 push 오염 방어(length 11 재고정)", () => {
    const state: PivotPointLevelsState = {};
    const a = pivotPointLevels(state, "Traditional", false, false, 95, 105, 95, 100);
    a.push(999);
    const b = pivotPointLevels(state, "Traditional", true, false, 105, 107, 100, 102);
    expect(b).toBe(a); // 같은 핸들(GOAL.md bar loop 할당 제로)
    expect(b.length).toBe(11);
  });
});

describe("ta.pivot_point_levels 파이프라인 배선(analyzer -> codegen -> execution)", () => {
  it("'=' 로컬 + array.get 소비가 직접 런타임 구동과 바별로 일치", () => {
    const src = [
      'pivots = ta.pivot_point_levels("Traditional", bar_index == 3)',
      "var float __obs_p = na",
      "var float __obs_r5 = na",
      "__obs_p := array.get(pivots, 0)",
      "__obs_r5 := array.get(pivots, 9)",
    ].join("\n");
    const result = runPipeline(src, DATA);
    const ps = result.bars.map((b) => b["var:__obs_p"]);
    const r5s = result.bars.map((b) => b["var:__obs_r5"]);
    expect(ps).toEqual([NaN, NaN, NaN, 100, 100, 100, 100, 100]);
    expect(r5s).toEqual([NaN, NaN, NaN, 150, 150, 150, 150, 150]);
  });

  it("method-call sugar(.get/.size)와 for-in 튜플 순회가 array 컨테이너로 인식된다", () => {
    const src = [
      'pivots = ta.pivot_point_levels("Classic", bar_index == 3)',
      "var float __obs_size = na",
      "var float __obs_r4 = na",
      "var float __obs_cnt = na",
      "__obs_size := pivots.size()",
      "__obs_r4 := pivots.get(7)",
      "cnt = 0",
      "for [i, p] in pivots",
      "    cnt := cnt + (na(p) ? 0 : 1)",
      "__obs_cnt := cnt",
    ].join("\n");
    const result = runPipeline(src, DATA);
    expect(result.bars.map((b) => b["var:__obs_size"])).toEqual([11, 11, 11, 11, 11, 11, 11, 11]);
    expect(result.bars.map((b) => b["var:__obs_r4"])).toEqual([NaN, NaN, NaN, 160, 160, 160, 160, 160]);
    // Classic은 9레벨만 유효(R5/S5 na) — anchor 후 유효 원소 9개.
    expect(result.bars.map((b) => b["var:__obs_cnt"])).toEqual([0, 0, 0, 9, 9, 9, 9, 9]);
  });

  it("콜사이트 2개(타입 상이)가 독립 taSlots 상태를 가진다", () => {
    const src = [
      'trad = ta.pivot_point_levels("Traditional", bar_index == 3)',
      'dm = ta.pivot_point_levels("DM", bar_index == 3)',
      "var float __obs_a = na",
      "var float __obs_b = na",
      "__obs_a := array.get(trad, 1)",
      "__obs_b := array.get(dm, 1)",
    ].join("\n");
    const result = runPipeline(src, DATA);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([NaN, NaN, NaN, 110, 110, 110, 110, 110]);
    expect(result.bars.map((b) => b["var:__obs_b"])).toEqual([NaN, NaN, NaN, 115, 115, 115, 115, 115]);
  });

  it("type이 '=' 로컬 문자열 변수로 흘러도 동작(input.string 관용구 대응)", () => {
    const src = [
      'pivotTypeInput = "Camarilla"',
      "pivots = ta.pivot_point_levels(pivotTypeInput, bar_index == 3)",
      "var float __obs_r4 = na",
      "__obs_r4 := array.get(pivots, 7)",
    ].join("\n");
    const result = runPipeline(src, DATA);
    expect(result.bars.map((b) => b["var:__obs_r4"])).toEqual([NaN, NaN, NaN, 111, 111, 111, 111, 111]);
  });

  it("developing=true 3-인자 폼도 파이프라인으로 직접 런타임 구동과 일치", () => {
    const src = [
      'pivots = ta.pivot_point_levels("Traditional", bar_index == 3, true)',
      "var float __obs_p = na",
      "__obs_p := array.get(pivots, 0)",
    ].join("\n");
    const result = runPipeline(src, DATA);
    const state: PivotPointLevelsState = {};
    const expected: number[] = [];
    for (let b = 0; b < 8; b++) {
      const arr = pivotPointLevels(state, "Traditional", b === 3, true, DATA.open[b]!, DATA.high[b]!, DATA.low[b]!, DATA.close[b]!);
      expected.push(arr[0]!);
    }
    expect(result.bars.map((b) => b["var:__obs_p"])).toEqual(expected);
  });

  it("인자 개수 검증: 1개/4개는 거부, 2~3개는 수용", () => {
    expect(analyzeSource('x = ta.pivot_point_levels("Traditional")').errors[0]).toContain("인자 개수 불일치");
    expect(analyzeSource('x = ta.pivot_point_levels("Traditional", true, false, 1)').errors[0]).toContain(
      "인자 개수 불일치",
    );
    expect(analyzeSource('x = ta.pivot_point_levels("Traditional", true)').errors).toEqual([]);
    expect(analyzeSource('x = ta.pivot_point_levels("Traditional", true, false)').errors).toEqual([]);
  });

  it("request.security expression 위치에서는 거부된다(array 핸들이 Float64Array 버퍼로 새는 것 방지)", () => {
    const prog = analyzeSource(
      'x = request.security(syminfo.tickerid, "60", ta.pivot_point_levels("Traditional", true))',
    );
    expect(prog.errors.length).toBeGreaterThan(0);
  });
});
