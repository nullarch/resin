// C362: ta.vwap 다중 인자 오버로드(2-인자 anchor 스칼라 / 3-인자 [vwap, upper, lower] 밴드 튜플)의
// 전체 파이프라인(transpile → compile → bar 루프) 검증. pine2py에 anchor 개념 자체가 없어
// (wavealgo/ta/vwap.py는 (source, volume) 2-파라미터 전체 누적뿐) 오라클 골든 구조적 불가 —
// 여기서는 hand-computed 기대값으로 검증한다(TV 미검증(가설), DIVERGENCES 참조). 순수 런타임
// 단위 검증은 tests/unit/runtime.test.ts "ta.vwap (multi-arg overloads, C362)"가, analyzer/codegen
// 방출 검증은 analyzer.test.ts/codegen.test.ts C362 블록이 담당 — 이 파일은 wild 실사용 패턴
// (`[vwap, upper, lower] = ta.vwap(src, new_session, mult)` 튜플 디스트럭처 + input/plot 조합)이
// 파이프라인을 관통해 실행까지 되는지를 회귀 고정한다(야생 원본 인용 없음 — 합성 스크립트).

import { describe, expect, it } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";

// close < open이 bar 2에서만 true가 되도록 설계된 5-바 합성 데이터 — anchor 리셋 경로 검증용.
const DATA = {
  open: [90, 100, 60, 50, 60],
  high: [105, 115, 65, 65, 75],
  low: [85, 95, 45, 45, 55],
  close: [100, 110, 50, 60, 70],
  volume: [1000, 1000, 500, 1500, 1000],
};

// 손계산 기대값(source=close, anchor=close<open → bar 2 리셋):
// bar0: 100 / bar1: (100·1000+110·1000)/2000 = 105 / bar2(리셋): 50 /
// bar3: (50·500+60·1500)/2000 = 57.5 / bar4: (25000+90000+70·1000)/3000 = 61.666…
const EXPECTED_VWAP = [100, 105, 50, 57.5, 185000 / 3000];

describe("ta.vwap multi-arg overloads through the full pipeline (C362)", () => {
  it("2-arg scalar form resets the accumulation on the anchor bar (hand-computed)", () => {
    const source = [
      "var float obs = na",
      "v = ta.vwap(close, close < open)",
      "obs := v",
    ].join("\n");
    const result = runPipeline(source, DATA);
    for (let i = 0; i < EXPECTED_VWAP.length; i++) {
      expect(result.bars[i]!["var:obs"]).toBeCloseTo(EXPECTED_VWAP[i]!, 9);
    }
  });

  it("3-arg tuple form yields [vwap, upper, lower] with volume-weighted stdev bands (hand-computed)", () => {
    const source = [
      "var float obs_v = na",
      "var float obs_u = na",
      "var float obs_l = na",
      "[v, u, l] = ta.vwap(close, close < open, 2.0)",
      "obs_v := v",
      "obs_u := u",
      "obs_l := l",
    ].join("\n");
    const result = runPipeline(source, DATA);
    // bar4(리셋 후 3바째): cumPv2 = 500·50² + 1500·60² + 1000·70² = 11,550,000,
    // Var = 11550000/3000 − (185000/3000)² = 3850 − 3802.777… = 47.222…, sd = √Var.
    const v4 = 185000 / 3000;
    const sd4 = Math.sqrt(11550000 / 3000 - v4 * v4);
    for (let i = 0; i < EXPECTED_VWAP.length; i++) {
      expect(result.bars[i]!["var:obs_v"]).toBeCloseTo(EXPECTED_VWAP[i]!, 9);
    }
    expect(result.bars[4]!["var:obs_u"]).toBeCloseTo(v4 + 2.0 * sd4, 9);
    expect(result.bars[4]!["var:obs_l"]).toBeCloseTo(v4 - 2.0 * sd4, 9);
    // 리셋 바(bar 2)는 단일-원소 기간이라 sd=0 — 세 채널이 전부 그 바 종가와 일치
    expect(result.bars[2]!["var:obs_v"]).toBe(50);
    expect(result.bars[2]!["var:obs_u"]).toBe(50);
    expect(result.bars[2]!["var:obs_l"]).toBe(50);
  });

  it("2-arg form with a never-true anchor matches the 1-arg full accumulation form bar-by-bar", () => {
    const oneArg = runPipeline(["var float obs = na", "obs := ta.vwap(close)"].join("\n"), DATA);
    const twoArg = runPipeline(["var float obs = na", "obs := ta.vwap(close, false)"].join("\n"), DATA);
    for (let i = 0; i < DATA.close.length; i++) {
      expect(twoArg.bars[i]!["var:obs"]).toBe(oneArg.bars[i]!["var:obs"]);
    }
  });

  it("transpiles and runs the wild-shaped usage pattern (input source + timeframe.change anchor + plots)", () => {
    // 야생 코퍼스 지배 패턴의 합성 재현: `ta.vwap(src_input, new_session, sd_mult)` 3-인자 튜플
    // 디스트럭처 + plot 3개. timeframe.change는 pine2py 스텁 동일하게 항상 false(C235)라 리셋
    // 없는 전체 누적과 동치 — 여기서는 배선(transpile→실행) 관통만 고정한다.
    const source = [
      'src_input = input.source(close, "Source")',
      'sd_mult = input.float(2.0, "StdDev mult")',
      'new_session = timeframe.change("D")',
      "[vwapValue, upperBand, lowerBand] = ta.vwap(src_input, new_session, sd_mult)",
      "plot(vwapValue)",
      "plot(upperBand)",
      "plot(lowerBand)",
    ].join("\n");
    const result = runPipeline(source, DATA);
    expect(result.plots).toHaveLength(3);
    // anchor가 항상 false → 1-인자 전체 누적과 동일한 vwap 채널
    const expectedNoReset = [100, 105, (210000 + 25000) / 2500, (235000 + 90000) / 4000, (325000 + 70000) / 5000];
    for (let i = 0; i < expectedNoReset.length; i++) {
      expect(result.plots[0]!.values[i]!).toBeCloseTo(expectedNoReset[i]!, 9);
    }
    // upper ≥ vwap ≥ lower 불변식(같은 바, sd ≥ 0 · mult=2.0 ≥ 0)
    for (let i = 0; i < DATA.close.length; i++) {
      expect(result.plots[1]!.values[i]!).toBeGreaterThanOrEqual(result.plots[0]!.values[i]!);
      expect(result.plots[2]!.values[i]!).toBeLessThanOrEqual(result.plots[0]!.values[i]!);
    }
  });

  it("still transpiles the 1-arg form to the exact pre-C362 output (volume splice(1,·) === push for a trailing source)", () => {
    const result = transpile("x = ta.vwap(close)");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.ta.vwap($.taSlots[0], $.close.get(0), $.volume.get(0))");
    }
  });

  it("rejects the 3-arg form outside tuple destructuring at transpile time", () => {
    const result = transpile("x = ta.vwap(close, close < open, 2.0)");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("'ta.vwap'") && e.includes("returns 3 values"))).toBe(true);
    }
  });

  // C466: 괄호 없는 ta.vwap(단일, wild 33건) — parser.ts가 hlc3를 명시적 1-인자로 desugar하므로
  // 이 블록 아래는 전부 기존 오라클 검증된 1-인자 폼(oracle/cases/ta_vwap.pine)과 완전히 동일한
  // analyzer/runtime 경로를 탄다. pine2py 자신은 이 괄호 없는 폼을 desugar하지 않아(codegen.py
  // TA_IMPLICIT_CALL에 vwap 미등재) `v = ta.vwap`을 문자 그대로 방출하는 실제 버그를 갖고 있어
  // (미정의 이름 참조 NameError) 오라클 골든 생성 자체가 불가 — hand-verified로 대체.
  it("transpiles the bare (no-parens) form to the exact same output as the explicit hlc3 1-arg form", () => {
    const bare = transpile("x = ta.vwap");
    const explicit = transpile("x = ta.vwap(hlc3)");
    expect(bare.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (bare.ok && explicit.ok) {
      expect(bare.code).toBe(explicit.code);
    }
  });

  it("runs the bare form through the full pipeline matching the explicit ta.vwap(hlc3) form bar-by-bar", () => {
    const bareResult = runPipeline(["var float obs = na", "obs := ta.vwap"].join("\n"), DATA);
    const explicitResult = runPipeline(["var float obs = na", "obs := ta.vwap(hlc3)"].join("\n"), DATA);
    for (let i = 0; i < DATA.close.length; i++) {
      expect(bareResult.bars[i]!["var:obs"]).toBe(explicitResult.bars[i]!["var:obs"]);
    }
  });

  it("keeps two bare ta.vwap call sites independently stateful (separate slots, same as explicit calls)", () => {
    const source = [
      "var float obsClose = na",
      "var float obsBare = na",
      "obsClose := ta.vwap(close)",
      "obsBare := ta.vwap",
    ].join("\n");
    const result = runPipeline(source, DATA);
    const expectedHlc3 = runPipeline(["var float obs = na", "obs := ta.vwap(hlc3)"].join("\n"), DATA);
    for (let i = 0; i < DATA.close.length; i++) {
      expect(result.bars[i]!["var:obsBare"]).toBe(expectedHlc3.bars[i]!["var:obs"]);
    }
    // 콜사이트 2개(close 소스/bare hlc3 소스)가 서로 다른 상태 슬롯을 써 값이 달라야 함(둘 다
    // source=close였다면 우연히 같아질 수 있으나, 여기선 소스 자체가 달라 항상 구분됨).
    expect(result.bars[1]!["var:obsClose"]).not.toBe(result.bars[1]!["var:obsBare"]);
  });

  it("desugars bare ta.vwap used as a wild-shaped request.security expression argument (synthetic, no verbatim wild source)", () => {
    // wild 실사용 패턴 재현(예: `request.security(syminfo.tickerid, tf, ta.vwap)`) — 합성 스크립트로
    // 재작성(원본 미인용). buildSecurityExpr의 "확장 좁은 표현식" 화이트리스트가 이미 ta.* CallExpr
    // 0~N개를 허용하므로, 파서 desugar가 만든 ta.vwap(hlc3) CallExpr도 그대로 통과해야 한다.
    const source = [
      'htf = request.security(syminfo.tickerid, "D", ta.vwap)',
      "plot(htf)",
    ].join("\n");
    const result = transpile(source);
    expect(result.ok).toBe(true);
  });
});
