// oracle/cases/ta_sma_varlen.pine: ta.sma series length 검증(배치25 (4) 두 번째, C548 —
// runtime/ta.ts smaVarLen). **length 값이 실제로 변하는 축은 오라클 불가**(pine2py sma.py가
// 첫 성공 호출 length로 윈도우를 영구 고정하는 latent 버그, DIVERGENCES #179) — 여기서는
// "series 한정자 + 값은 상수" 퇴화 케이스로 버퍼/워밍업(len1)과 NaN 오염/회복(len2 + 바 3 na
// 소스) 메커니즘만 골든 대조하고, 값이 변하는 축은 tests/unit/runtime.test.ts(smaVarLen)와
// pipeline E2E(analyzer.test.ts/codegen.test.ts)가 hand-verified로 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_sma_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_sma_varlen", () => {
  it("matches the pine2py golden bar-by-bar for series-length ta.sma", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  // 값이 실제로 변하는 length 축 — pine2py 오라클 불가(위 파일 주석)라 hand-verified: TV 문서
  // 정의("length바 동안의 source 산술평균")를 테스트 안에서 직접 재계산해 대조한다.
  it("hand-verified: computes the mean over the *current* length as it varies bar to bar (full pipeline)", () => {
    const source = [
      "//@version=5",
      'indicator("t")',
      "len = close > 105 ? 3 : 5",
      "s = ta.sma(close, len)",
      "var float __obs_s = na",
      "__obs_s := s",
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
      const actual = result.bars[i]!["var:__obs_s"] as number;
      if (i + 1 < len) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        const window = closes.slice(i - len + 1, i + 1);
        expect(actual).toBeCloseTo(window.reduce((a, b) => a + b, 0) / len, 9);
      }
    }
  });

  // wild 실사용 최다 형태(loop-body 반복 호출) E2E — 같은 바 안 3회 호출(period 3/4/5)이 버퍼를
  // 3칸 전진시키지 않고 마지막 슬롯 덮어쓰기로 유지되는지(pine2py context.param() parity, C547
  // corpus_diff 교훈)를 전체 파이프라인으로 검증.
  it("hand-verified: loop-body calls with a loop-var length do not over-advance the per-bar buffer (full pipeline)", () => {
    const source = [
      "//@version=5",
      'indicator("t")',
      "total = 0.0",
      "for period = 3 to 5",
      "    s = ta.sma(close, period)",
      "    total := total + nz(s)",
      "var float __obs_total = na",
      "__obs_total := total",
    ].join("\n");
    const closes = [10, 11, 12, 13, 14, 15];
    const data = {
      open: closes,
      high: closes,
      low: closes,
      close: closes,
      volume: closes.map(() => 1),
    };
    const result = runPipeline(source, data);
    for (let i = 0; i < closes.length; i++) {
      let expected = 0;
      for (const period of [3, 4, 5]) {
        if (i + 1 >= period) {
          const window = closes.slice(i - period + 1, i + 1);
          expected += window.reduce((a, b) => a + b, 0) / period;
        }
      }
      expect(result.bars[i]!["var:__obs_total"] as number).toBeCloseTo(expected, 9);
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
