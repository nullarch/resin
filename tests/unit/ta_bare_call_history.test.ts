// 괄호 없는 ta.* 암묵 호출의 히스토리 인덱싱 `ta.tr[1]`류(C524, wild "히스토리 인덱스는
// 식별자에만 지원" 클러스터 identonly 서브그룹 잔여 — 04e9d87246af.pine/f1c7f5b22641.pine).
// parsePostfix의 bare-call desugar가 예전엔 postfix 루프 종료 후에만 적용돼, 그 직후 '['가 오면
// desugar 전 DotAccess가 그대로 IndexAccess.obj로 잡혀 analyzer가 "히스토리 인덱스는 식별자에만
// 지원"으로 오분류했다(parser.test.ts가 AST 형태 자체를 검증). 이 파일은 파이프라인 전체(analyzer+
// codegen+runtime)가 desugar된 형태를 명시 호출형과 완전히 동일하게 처리하는지 실행값으로 확인한다
// — ta.tr()[N] 자체의 산식은 taCallHistorySlots(C340) 범용 메커니즘이라 이미 다른 곳에서 검증됨,
// 여기는 "괄호 없는 형태 == 괄호 있는 형태" 동치성(parity)만 증명하면 충분.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2, 8, 3, 9, 4, 10],
  high: [3, 7, 5, 10, 6, 12, 8, 15],
  low: [0, 2, 1, 4, 2, 5, 3, 6],
  close: [2, 4, 3, 9, 2, 11, 3, 12],
  volume: [10, 20, 15, 25, 12, 30, 18, 22],
};

function obs(source: string, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

describe("bare (no-parens) ta.* implicit-call history indexing (C524, hand-verified parity)", () => {
  it.each(["tr", "accdist", "wad", "wvad", "iii", "obv", "pvt", "nvi", "pvi"])(
    "'ta.%s[1]' (bare) matches 'ta.%s()[1]' (explicit) bar-by-bar",
    (attr) => {
      const bareSrc = ["var float __obs_bare = na", `__obs_bare := ta.${attr}[1]`].join("\n");
      const explicitSrc = ["var float __obs_explicit = na", `__obs_explicit := ta.${attr}()[1]`].join("\n");
      expect(obs(bareSrc, "__obs_bare")).toEqual(obs(explicitSrc, "__obs_explicit"));
    },
  );

  it("'ta.tr[1]' shifts the bare (unindexed) ta.tr value by exactly one bar", () => {
    const src = [
      "var float __obs_bare = na",
      "var float __obs_shifted = na",
      "__obs_bare := ta.tr",
      "__obs_shifted := ta.tr[1]",
    ].join("\n");
    const bare = obs(src, "__obs_bare");
    const shifted = obs(src, "__obs_shifted");
    expect(shifted).toEqual([NaN, ...bare.slice(0, -1)]);
  });

  it("'ta.vwap[1]' (bare, hlc3 default source) matches 'ta.vwap(hlc3)[1]' (explicit) bar-by-bar", () => {
    const bareSrc = ["var float __obs_bare = na", "__obs_bare := ta.vwap[1]"].join("\n");
    const explicitSrc = ["var float __obs_explicit = na", "__obs_explicit := ta.vwap(hlc3)[1]"].join("\n");
    expect(obs(bareSrc, "__obs_bare")).toEqual(obs(explicitSrc, "__obs_explicit"));
  });

  it("treats [0] the same as the bare (unindexed) call for a bare implicit ta.obv", () => {
    const src = ["var float __obs_bare = na", "var float __obs_zero = na", "__obs_bare := ta.obv", "__obs_zero := ta.obv[0]"].join(
      "\n",
    );
    expect(obs(src, "__obs_zero")).toEqual(obs(src, "__obs_bare"));
  });
});
