// oracle/cases/array_stats.pine: array.sum/avg/min/max/median/mode/stdev/variance — array.*
// 통계류(C81, C79/80이 확정한 stateless builtinCalls 패턴의 기계적 확장). 채널 A(4-valid,
// median 짝수개), 채널 B(na 1개 섞인 4개 → 3-valid, median 홀수개, na-skip), 채널 C(전부 na —
// sum만 0, 나머지는 na), 채널 D(단일 valid — stdev/variance만 na, 나머지는 그 값), 채널 E(mode
// 동률 시 최초 등장값 승 — 리터럴), 채널 F(mode 동률 없음 — close가 두 번 등장). 'var:arr*'
// 채널(배열 자체)은 array_basic/array_residual.test.ts와 동일한 이유로 비교 제외.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_stats";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_a_sum",
  "var:__obs_a_avg",
  "var:__obs_a_min",
  "var:__obs_a_max",
  "var:__obs_a_median",
  "var:__obs_a_stdev",
  "var:__obs_a_variance",
  "var:__obs_b_sum",
  "var:__obs_b_avg",
  "var:__obs_b_min",
  "var:__obs_b_max",
  "var:__obs_b_median",
  "var:__obs_b_stdev",
  "var:__obs_b_variance",
  "var:__obs_c_sum",
  "var:__obs_c_avg",
  "var:__obs_c_min",
  "var:__obs_c_median",
  "var:__obs_c_stdev",
  "var:__obs_d_sum",
  "var:__obs_d_avg",
  "var:__obs_d_stdev",
  "var:__obs_d_variance",
  "var:__obs_e_mode",
  "var:__obs_f_mode",
];

describe("oracle: array_stats", () => {
  it("matches the pine2py golden bar-by-bar for all twenty-five numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all twenty-five numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of [
      "__obs_a_sum",
      "__obs_a_avg",
      "__obs_a_min",
      "__obs_a_max",
      "__obs_a_median",
      "__obs_a_stdev",
      "__obs_a_variance",
      "__obs_b_sum",
      "__obs_b_avg",
      "__obs_b_min",
      "__obs_b_max",
      "__obs_b_median",
      "__obs_b_stdev",
      "__obs_b_variance",
      "__obs_c_sum",
      "__obs_d_sum",
      "__obs_d_avg",
      "__obs_e_mode",
      "__obs_f_mode",
    ]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
    // NaN 채널은 toBeCloseTo가 NaN 비교를 못 하므로 명시적으로 확인(array_basic/residual의 전례).
    for (const key of ["__obs_c_avg", "__obs_c_min", "__obs_c_median", "__obs_c_stdev", "__obs_d_stdev", "__obs_d_variance"]) {
      expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      expect(golden.finalVarState[key]).toBe("NaN");
    }
  });

  it("array.sum returns 0 (not na) for an all-na array, unlike avg/min/max/median/stdev", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_c_sum"]).toBe(0);
    expect(Number.isNaN(result.finalVarState["__obs_c_avg"])).toBe(true);
  });
});
