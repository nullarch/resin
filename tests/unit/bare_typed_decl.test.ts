// 초기값 없는 타입 힌트 신규 로컬 선언(`float x`, var 없음, C635) hand-verified 파이프라인 테스트.
// wild "알 수 없는 식별자" 클러스터 잔여 서브버킷 조사(next_hint(C634)) 중 발견: 'then'/'return'/
// 'input'/'overlay' 서브버킷은 전량 TV-invalid(if-then 유사구문/bare return/input 선언 접두어/
// 읽을 수 없는 overlay 전역 — 실제 TV/pine2py 어디에도 없는 문법·식별자, PROGRESS.md C635 참조)로
// 확정됐으나 'string' 서브버킷 1개 파일(`string ma_type_description_text`처럼 '='도 없이 타입+이름만
// 있는 선언, 이후 `:=`로 조건부 재대입)은 실제 흔한 TV 관용구("선언 후 조건부 대입")로 판단해
// 신규 구현했다. pine2py _parse_identifier_statement(parser.py L324-334)는 ASSIGN을 항상 요구해
// 이 폼이 아예 없다(python 직접 실행 확인 결과 pine2py 자신도 "TYPE"과 "name"을 별개의 무의미한
// ExprStmt 두 개로 조용히 쪼개 실행 시 NameError로 이어지는 latent 버그) — 오라클 대조가 원천
// 불가해 이 파일은 손 계산 기대값으로 검증한다(MEMORY C9/C14/C18/C521급). DIVERGENCES에 TV 미검증
// (가설)로 등재.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [1, 2, 3, 4, 5],
  low: [1, 2, 3, 4, 5],
  close: [1, 8, 3, 9, 2],
  volume: [1, 1, 1, 1, 1],
};

function obsVals(source: string, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("bare typed local declaration with no initializer ('float x', C635, hand-verified)", () => {
  it("resets to na every bar (non-var local) unless the same bar's conditional reassigns it via ':='", () => {
    const src = [
      "float ma",
      "if close > 5",
      "    ma := close",
      "var float __obs_a = na",
      "__obs_a := ma",
    ].join("\n");
    // close: [1,8,3,9,2] -> >5: [F,T,F,T,F] -> ma per bar: [na,8,na,9,na]
    expect(obsVals(src)).toEqual([NaN, 8, NaN, 9, NaN]);
  });

  it("does not carry a value across bars (contrast with 'var', which would persist the last assignment)", () => {
    const src = [
      "float ma",
      "if bar_index == 1",
      "    ma := 100.0",
      "var float __obs_a = na",
      "__obs_a := ma",
    ].join("\n");
    // only bar_index 1 assigns; every other bar re-declares ma = na fresh (non-var reset).
    expect(obsVals(src)).toEqual([NaN, 100, NaN, NaN, NaN]);
  });

  it("supports an int-typed bare declaration reassigned in an else-branch", () => {
    const src = [
      "int n",
      "if close > 5",
      "    n := 1",
      "else",
      "    n := 0",
      "var float __obs_a = na",
      "__obs_a := n",
    ].join("\n");
    expect(obsVals(src)).toEqual([0, 1, 0, 1, 0]);
  });

  it("works when declared inside a UDF body (function-local bare declaration)", () => {
    const src = [
      "f() =>",
      "    float x",
      "    if close > 5",
      "        x := close * 2",
      "    x",
      "var float __obs_a = na",
      "__obs_a := f()",
    ].join("\n");
    expect(obsVals(src)).toEqual([NaN, 16, NaN, 18, NaN]);
  });

  it("leaves na(x) true on bars where no branch reassigns the bare declaration", () => {
    const src = [
      "float ma",
      "if close > 100",
      "    ma := close",
      "var float __obs_a = na",
      "__obs_a := na(ma) ? -1.0 : ma",
    ].join("\n");
    // close never exceeds 100, so ma stays na every bar -> na(ma) always true.
    expect(obsVals(src)).toEqual([-1, -1, -1, -1, -1]);
  });
});

// C660: 이름이 SERIES/SIMPLE 한정자 키워드와 우연히 같은 typed local 선언(`float simple = ...`)의
// 파서 lookahead 갭 수정 — wild "알 수 없는 식별자" 클러스터 실갭(next_hint(C659), 02906eab87a4.pine
// 실측). 이 실행 테스트는 이름 충돌이 순수 파서 레벨 이슈였고 codegen/runtime에는 "simple"/"series"에
// 대한 별도 예약어 리매핑이 없어(JS 예약어 아님) 값이 정상적으로 흐르는지 end-to-end로 확인한다.
describe("typed local named 'simple'/'series' executes correctly (C660, no runtime collision)", () => {
  it("computes through a UDF-local variable literally named 'simple'", () => {
    const src = [
      "f(x) =>",
      "    float simple = x * 2.0",
      "    simple + 1.0",
      "var float __obs_a = na",
      "__obs_a := f(close)",
    ].join("\n");
    // close: [1,8,3,9,2] -> simple=close*2 -> +1: [3,17,7,19,5]
    expect(obsVals(src)).toEqual([3, 17, 7, 19, 5]);
  });

  it("computes through a top-level 'var' declared as 'series' with no type hint", () => {
    const src = ["var series = 0.0", "series := series + close", "var float __obs_a = na", "__obs_a := series"].join(
      "\n",
    );
    // running sum of close: [1,8,3,9,2] -> cumulative [1,9,12,21,23]
    expect(obsVals(src)).toEqual([1, 9, 12, 21, 23]);
  });
});

// C766: 이름이 STRATEGY/TYPE 등 지시어/선언 키워드와 우연히 같은 typed local 선언(`string strategy =
// ...`)의 파서 lookahead 갭 수정 — C660과 동일 원칙(순수 파서 레벨 이슈, codegen/runtime에 별도
// 리매핑 없음), wild `string strategy = input.string(...)` 실측(next_hint(C765)) end-to-end 확인.
describe("typed local named 'strategy'/'type' executes correctly (C766, no runtime collision)", () => {
  it("computes through a top-level non-var local literally named 'strategy'", () => {
    const src = [
      `string strategy = close > 5 ? "long" : "flat"`,
      "var float __obs_a = na",
      `__obs_a := strategy == "long" ? 1.0 : 0.0`,
    ].join("\n");
    // close: [1,8,3,9,2] -> >5: [F,T,F,T,F] -> strategy=="long": [0,1,0,1,0]
    expect(obsVals(src)).toEqual([0, 1, 0, 1, 0]);
  });

  it("computes through a top-level 'var' declared as 'type' with an explicit type hint", () => {
    const src = ["var float type = 0.0", "type := type + close", "var float __obs_a = na", "__obs_a := type"].join(
      "\n",
    );
    // running sum of close: [1,8,3,9,2] -> cumulative [1,9,12,21,23]
    expect(obsVals(src)).toEqual([1, 9, 12, 21, 23]);
  });
});

// C768: "method"가 이름 자리 없이 그 자체로 UDF 이름이거나(`method(int idx) => ...`), method decl의
// 이름이 예약어("type")인 wild 관용구(scripts_v56_v2/9a881fdba297.pine, 7c4a84d1c416.pine 실측,
// tv_verdict accept) — 순수 파서 레벨 갭이라 codegen/runtime에 별도 리매핑 없음(C766와 동일 원칙)을
// end-to-end로 확인.
describe("self-named 'method(...)' UDF and reserved-word-named method execute correctly (C768, no runtime collision)", () => {
  it("calls a UDF literally named 'method' (no name slot in the decl) end-to-end", () => {
    const src = ["method(int idx) =>", "    idx + 1", "var float __obs_a = na", "__obs_a := method(bar_index)"].join(
      "\n",
    );
    // bar_index: [0,1,2,3,4] -> +1: [1,2,3,4,5]
    expect(obsVals(src)).toEqual([1, 2, 3, 4, 5]);
  });

  it("calls a method decl named 'type' (reserved word) via dot-sugar on a string receiver", () => {
    const src = [
      'method type(string s) =>',
      '    s == "long" ? 1.0 : 0.0',
      'string tag = close > 5 ? "long" : "flat"',
      "var float __obs_a = na",
      "__obs_a := tag.type()",
    ].join("\n");
    // close: [1,8,3,9,2] -> tag: [flat,long,flat,long,flat] -> type(): [0,1,0,1,0]
    expect(obsVals(src)).toEqual([0, 1, 0, 1, 0]);
  });
});
