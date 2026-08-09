// oracle/cases/ta_wma_varlen.pine: ta.wma series length 검증(배치25 (4) 묶음, C550 —
// runtime/ta.ts wmaVarLen). **length 값이 실제로 변하는 축은 오라클 불가**(pine2py wma.py가
// 첫 성공 호출 length로 state["window"]를 영구 고정 + last_idx 미검사 같은-바 다중 전진 —
// sma.py #179와 완전 동일 패턴, DIVERGENCES #181) — 여기서는 "series 한정자 + 값은 상수" 퇴화
// 케이스로 버퍼/워밍업(len1)과 NaN 오염/회복(len2 + 바 3 na 소스) 메커니즘만 골든 대조하고,
// 값이 변하는 축은 tests/unit/runtime.test.ts(wmaVarLen)와 아래 파이프라인 hand-verified가
// 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_wma_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_wma_varlen", () => {
  it("matches the pine2py golden bar-by-bar for series-length ta.wma (degenerate constant-value length)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  // 값이 실제로 변하는 length 축 — pine2py 오라클 불가(위 파일 주석)라 hand-verified: TV 문서
  // 정의(선형 가중 이동평균, weight(oldest)=1..weight(newest)=len)를 테스트 안에서 직접 재계산해
  // 전체 파이프라인으로 대조한다(ta_sma_varlen.test.ts C548과 동일 패턴).
  it("hand-verified: computes the linearly-weighted mean over the *current* length as it varies bar to bar (full pipeline)", () => {
    const source = [
      "//@version=5",
      'indicator("t")',
      "len = close > 105 ? 3 : 5",
      "w = ta.wma(close, len)",
      "var float __obs_w = na",
      "__obs_w := w",
    ].join("\n");
    const closes = [100.5, 101.5, 102.5, 103.5, 104.5, 105.5, 106.5, 107.5];
    const data = {
      open: closes.map((c) => c - 0.5),
      high: closes.map((c) => c + 0.5),
      low: closes.map((c) => c - 1),
      close: closes,
      volume: closes.map(() => 10),
    };
    const result = runPipeline(source, data);
    for (let i = 0; i < closes.length; i++) {
      const len = closes[i]! > 105 ? 3 : 5;
      const actual = result.bars[i]!["var:__obs_w"] as number;
      if (i + 1 < len) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        let weighted = 0;
        for (let k = 0; k < len; k++) weighted += closes[i - len + 1 + k]! * (k + 1);
        expect(actual).toBeCloseTo(weighted / ((len * (len + 1)) / 2), 9);
      }
    }
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      const exp = expected === "NaN" ? NaN : (expected as number);
      if (Number.isNaN(exp)) {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(exp, 6);
      }
    }
  });
});
