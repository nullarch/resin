// 단독(체인 없는) 자기참조 var 히스토리(`var float x=na \n x := f(x[1])`) hand-verified 테스트
// (C589, wild 5809ac4be31e "Laguerre 자기참조 필터" mismatch 원인 규명). DIVERGENCES.md #6의
// "재대입보다 먼저 히스토리를 읽는" 발산은 이 최소 케이스에서도 그대로 발동한다: pine2py
// ctx.param(key)는 같은 바 안에서 그 key로 다시 호출돼야(다운스트림이 x[1]을 또 읽어야) 재대입 후
// 값으로 덮어써진다 — 자기 자신만 읽는 단독 var는 그 두 번째 호출이 없어 채널이 영구히 1바 더
// 지연된 값(x[n-2])을 보관한다(pine2py 직접 실행 확인: close=[2,4,3,9,2,11,3,12]에서 골든이
// [2,4,5,13,7,24,10,36] = close[n]+x[n-2]). pine2js는 바 끝 1회 record라 TV 정합(x[n]=x[n-1]+close[n]).
// → 이 패턴은 오라클 대조 불가(pine2py 골든 자체가 틀림), hand-verified로 대체.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2, 8, 3, 9, 4, 10],
  high: [3, 7, 5, 10, 6, 12, 8, 15],
  low: [0, 2, 1, 4, 2, 5, 3, 6],
  close: [2, 4, 3, 9, 2, 11, 3, 12],
  volume: [1, 1, 1, 1, 1, 1, 1, 1],
};

describe("standalone self-referential var history: x := f(x[1]) with no downstream re-read (C589, hand-verified)", () => {
  it("computes a running cumulative sum correctly (pine2py oracle-invalid for this exact pattern)", () => {
    const source = ["var float x = na", "x := nz(x[1]) + close", "var float __obs_x = na", "__obs_x := x"].join("\n");
    const result = runPipeline(source, data);
    // TV-correct: x[n] = x[n-1] + close[n] (running total). pine2py's ctx.param() would instead
    // yield close[n] + x[n-2] here (confirmed via direct python execution, see comment above).
    expect(result.bars.map((b) => b["var:__obs_x"])).toEqual([2, 6, 9, 18, 20, 31, 34, 46]);
  });

  it("a chained var (self-ref history read AND downstream-read by a later var) is unaffected -- the downstream read self-heals the channel", () => {
    // Mirrors the Laguerre lagL0/lagL1 shape: lagA is read by itself ([1]) AND by lagB's formula
    // ([1] again, after lagA's reassignment) -- the second same-key read overwrites the channel
    // with the settled value, so lagA (unlike a standalone var) matches the naive expected formula.
    const source = [
      "var float lagA = na",
      "var float lagB = na",
      "lagA := nz(lagA[1]) + close",
      "lagB := lagA + nz(lagA[1])",
      "var float __obs_a = na",
      "__obs_a := lagA",
    ].join("\n");
    const result = runPipeline(source, data);
    // lagA is the same running-sum recurrence as the standalone case above -- and matches here too,
    // since pine2js records once at bar-end regardless of how many times it's read within the bar.
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([2, 6, 9, 18, 20, 31, 34, 46]);
  });
});
