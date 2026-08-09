// `for TYPE name = start to end` — 타입 명시 for-루프 변수(C689, wild 실측 4+ 파일:
// `for int i=1 to length`). pine2py도 동일 latent 파서 버그(python 직접 실행 재현: var_name =
// self._expect(IDENTIFIER) 직후 바로 ASSIGN을 기대해 타입 토큰을 못 받고 "Expected ASSIGN,
// got IDENTIFIER ('i')"로 크래시)라 오라클 골든 생성이 불가능한 케이스 — 타입 토큰은 codegen에
// 전혀 소비되지 않는 순수 파서 단계 장식이므로, 동일 소스의 타입-있음/타입-없음 두 변형이
// 바이트 단위로 같은 실행 결과를 내는지 hand-verified로 대조한다.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

function makeData(n: number): OHLCVData {
  const closes = Array.from({ length: n }, (_, i) => 100 + i);
  return { open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1) };
}

describe("typed for-loop variable (C689, hand-verified)", () => {
  it("produces identical bar-by-bar output for 'for int i = ...' and 'for i = ...'", () => {
    const data = makeData(5);
    const typed = [
      "var float __obs_a = na",
      "sum = 0.0",
      "for int i = 1 to 5",
      "    sum := sum + i",
      "__obs_a := sum",
    ].join("\n");
    const untyped = [
      "var float __obs_a = na",
      "sum = 0.0",
      "for i = 1 to 5",
      "    sum := sum + i",
      "__obs_a := sum",
    ].join("\n");

    const typedResult = runPipeline(typed, data);
    const untypedResult = runPipeline(untyped, data);
    const typedVals = typedResult.bars.map((b) => b["var:__obs_a"]);
    const untypedVals = untypedResult.bars.map((b) => b["var:__obs_a"]);

    expect(typedVals).toEqual(untypedVals);
    expect(typedVals).toEqual([15, 15, 15, 15, 15]);
  });

  it("supports an explicit 'by' step with a non-int type keyword", () => {
    const data = makeData(3);
    const src = [
      "var float __obs_a = na",
      "sum = 0.0",
      "for float i = 10 to 0 by -2",
      "    sum := sum + i",
      "__obs_a := sum",
    ].join("\n");

    const result = runPipeline(src, data);
    // 10+8+6+4+2+0 = 30
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([30, 30, 30]);
  });

  it("still executes a plain 'for x in arr' loop correctly (no regression from the type-lookahead)", () => {
    const data = makeData(2);
    const src = [
      "var float __obs_a = na",
      "arr = array.from(1, 2, 3)",
      "sum = 0.0",
      "for x in arr",
      "    sum := sum + x",
      "__obs_a := sum",
    ].join("\n");

    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([6, 6]);
  });
});
