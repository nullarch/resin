// oracle/cases/e2e_rsi.pine: TV 빌트인 "Relative Strength Index" 인디케이터 E2E 재현(ROADMAP P2
// "TV 빌트인 인디케이터 15종 E2E" 첫 슬라이스, 3종 중 2). ta.rsi 자체의 계산은 이미
// tests/oracle/ta_ema_rsi.test.ts(순수 __obs 미러)가 개별 검증했다 -- 이 테스트가 새로 검증하는
// 것은 indicator()/input.int/input.source/plot()을 ta.rsi와 한 스크립트로 조합했을 때 (1) __obs
// 미러 채널이 여전히 오라클과 바별로 일치하는지, (2) 단일 plot() 슬롯이 정확히 배정되는지,
// (3) plot 채널 값이 같은 바의 __obs 미러 값과 정확히 같은지(e2e_macd.test.ts와 동일한 세 축,
// 다중 plot 대신 단일 plot 케이스).
//
// The expected values are the PyneCore oracle's, not the pine2py golden's: pine2py counted the
// first bar (which has no x[1]) toward the rma seed and reported rsi(close, 3) on bar 2, averaging
// two changes over 3. The manual's reference (ref_v6_ta_math.txt "ta.rsi": u = math.max(x - x[1],
// 0), ta.rma ignores na) seeds on the first `length` changes, so the first value lands on bar 3
// (see tests/oracle/ta_ema_rsi.test.ts; tier 1 resin-harness suites/indicators/tv/
// ta_211_mfi_rsi_stoch; harness twin state/repros/mfi-rsi-warmup.json, channel rsi3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_rsi";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json, ta.rsi(close, 3).
const RSI3_SAMPLE10: readonly number[] = [
  NaN, NaN, NaN, 66.66666666666666, 83.33333333333333, 87.87878787878788, 91.3978494623656, 63.670411985018724,
  80.98039215686275, 85.98772119898881,
];

describe("oracle: e2e_rsi (TV built-in Relative Strength Index, full script)", () => {
  it("matches the PyneCore oracle bar-by-bar for the composed script", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(RSI3_SAMPLE10.length);
    for (let i = 0; i < RSI3_SAMPLE10.length; i++) {
      const actual = result.bars[i]!["var:__obs_rsi"]!;
      expect(nearlyEqual(actual, RSI3_SAMPLE10[i]!), `bar ${i}: actual=${actual} oracle=${RSI3_SAMPLE10[i]}`).toBe(true);
    }
  });

  it("matches the PyneCore oracle final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_rsi"]).toBeCloseTo(RSI3_SAMPLE10[9]!, 9);
  });

  it("emits exactly 1 plot titled 'RSI'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["RSI"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_rsi mirror values bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < RSI3_SAMPLE10.length; i++) {
      expect(nearlyEqual(values[i]!, result.bars[i]!["var:__obs_rsi"]!), `bar ${i}`).toBe(true);
      expect(nearlyEqual(values[i]!, RSI3_SAMPLE10[i]!), `bar ${i}`).toBe(true);
    }
  });
});
