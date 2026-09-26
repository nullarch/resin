// oracle/cases/e2e_mfi.pine: TV 빌트인 "Money Flow Index" 인디케이터 E2E 재현(ROADMAP P2 "TV
// 빌트인 인디케이터 15종 E2E" 세 번째 슬라이스, 3종 중 1). ta.mfi 자체의 계산은 이미
// tests/oracle/ta_mfi.test.ts(순수 __obs 미러)가 개별 검증했다 -- 이 테스트가 새로 검증하는
// 것은 indicator()/input.int/input.source/plot()을 ta.mfi와 한 스크립트로 조합했을 때 (1) __obs
// 미러 채널이 여전히 오라클과 바별로 일치하는지, (2) 단일 plot() 슬롯이 정확히 배정되는지,
// (3) plot 채널 값이 같은 바의 __obs 미러 값과 정확히 같은지(e2e_cci.test.ts와 동일한 세 축,
// 단일 plot 케이스).
//
// The expected values are the PyneCore oracle's, not the pine2py golden's: pine2py skipped the
// first bar and reported NaN on bar 2, where the manual's reference (ref_v6_ta_math.txt "ta.mfi")
// already counts the first bar's money flow in both sums (see tests/oracle/ta_mfi.test.ts; tier 1
// resin-harness suites/indicators/tv/ta_211_mfi_rsi_stoch; harness twin
// state/repros/mfi-rsi-warmup.json, channel mfi3).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_mfi";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json, ta.mfi(close, 3).
const MFI3_SAMPLE10: readonly number[] = [
  NaN, NaN, 76.9301050708086, 66.77994902293969, 68.81148630683329, 69.43322475570032, 100, 66.36212624584718,
  68.54543437257294, 69.10755148741418,
];

describe("oracle: e2e_mfi (TV built-in Money Flow Index, full script)", () => {
  it("matches the PyneCore oracle bar-by-bar for the composed script", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(MFI3_SAMPLE10.length);
    for (let i = 0; i < MFI3_SAMPLE10.length; i++) {
      const actual = result.bars[i]!["var:__obs_mfi"]!;
      expect(nearlyEqual(actual, MFI3_SAMPLE10[i]!), `bar ${i}: actual=${actual} oracle=${MFI3_SAMPLE10[i]}`).toBe(true);
    }
  });

  it("matches the PyneCore oracle final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_mfi"]).toBeCloseTo(MFI3_SAMPLE10[9]!, 9);
  });

  it("emits exactly 1 plot titled 'MFI'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["MFI"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_mfi mirror values bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < MFI3_SAMPLE10.length; i++) {
      expect(nearlyEqual(values[i]!, result.bars[i]!["var:__obs_mfi"]!), `bar ${i}`).toBe(true);
      expect(nearlyEqual(values[i]!, MFI3_SAMPLE10[i]!), `bar ${i}`).toBe(true);
    }
  });
});
