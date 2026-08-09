// oracle/cases/array_stats2.pine: array.covariance/percentile_nearest_rank/
// percentile_linear_interpolation/percentrank/standardize (C83, pine2py array.py L314-370).
// 채널 A(covariance — 2 valid pairs, NaN이 두 배열의 서로 다른 위치에 있어도 정확히 짝지어
// 스킵됨), 채널 B(covariance <2 valid pairs -> na), 채널 C(percentile류/percentrank — 4-valid+
// 1-na 비정렬 배열), 채널 D(percentile 경계 0%/100%), 채널 E(standardize 정상, get() 미러로
// 원소별 검증), 채널 F(standardize sd==0 -> 전부 1.0), 채널 G(standardize <2valid -> 원본
// 그대로 복사, na 포함). 'var:arr*'/'var:sd*'(배열 자체) 채널은 array_basic/residual/stats와
// 동일한 이유로 비교 제외 — get() 미러 채널이 내용 검증을 담당.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_stats2";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_cov",
  "var:__obs_cov_na",
  "var:__obs_pnr50",
  "var:__obs_pli50",
  "var:__obs_pli25",
  "var:__obs_pr",
  "var:__obs_pnr0",
  "var:__obs_pnr100",
  "var:__obs_sd0",
  "var:__obs_sd1",
  "var:__obs_sd2",
  "var:__obs_sd3",
  "var:__obs_sd4",
  "var:__obs_sdc0",
  "var:__obs_sdc2",
  "var:__obs_sdf0",
  "var:__obs_sdf1",
];

describe("oracle: array_stats2", () => {
  it("matches the pine2py golden bar-by-bar for all seventeen numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all seventeen numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of [
      "__obs_cov",
      "__obs_pnr50",
      "__obs_pli50",
      "__obs_pli25",
      "__obs_pr",
      "__obs_pnr0",
      "__obs_pnr100",
      "__obs_sd0",
      "__obs_sd1",
      "__obs_sd3",
      "__obs_sd4",
      "__obs_sdc0",
      "__obs_sdc2",
      "__obs_sdf0",
    ]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
    // NaN 채널은 toBeCloseTo가 NaN 비교를 못 하므로 명시적으로 확인(array_stats의 전례).
    for (const key of ["__obs_cov_na", "__obs_sd2", "__obs_sdf1"]) {
      expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      expect(golden.finalVarState[key]).toBe("NaN");
    }
  });

  it("standardize() returns arr.length elements of 1.0 (not vals.length) when stdev is exactly 0", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_sdc0"]).toBe(1.0);
    expect(result.finalVarState["__obs_sdc2"]).toBe(1.0);
  });

  it("covariance() correctly pairs index-aligned elements even when each array's na sits at a different index", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(Number.isFinite(result.finalVarState["__obs_cov"] as number)).toBe(true);
    expect(Number.isNaN(result.finalVarState["__obs_cov_na"])).toBe(true);
  });
});
