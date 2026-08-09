// oracle/cases/matrix_stats.pine: matrix.sum/avg/min/max/median/mode (C95, 여섯 번째 슬라이스 —
// 38/49 완료, 분모 정정은 matrix.ts 헤더 주석 참조). pine2py matrix.py의 `_flat_valid` 위에서
// array.py `_valid_nums` 통계(array_stats.pine, C81)와 로직이 완전히 동일함을 확인해 그 오라클
// 설계(all-valid/na-embedded/all-na/single-valid/mode 동률/mode 무동률 6그룹)를 2D로 그대로
// 옮김. na(null) 행렬 인자는 pine2py가 크래시하는 미정의 지점 — tests/unit/runtime.test.ts의
// hand-verified로 대체(matrix_basic.pine 등과 동일 원칙).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_stats";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_sum",
  "var:__obs_a_avg",
  "var:__obs_a_min",
  "var:__obs_a_max",
  "var:__obs_a_median",
  "var:__obs_b_sum",
  "var:__obs_b_avg",
  "var:__obs_b_min",
  "var:__obs_b_max",
  "var:__obs_b_median",
  "var:__obs_c_sum",
  "var:__obs_c_avg",
  "var:__obs_c_min",
  "var:__obs_c_max",
  "var:__obs_c_median",
  "var:__obs_d_sum",
  "var:__obs_d_avg",
  "var:__obs_d_min",
  "var:__obs_d_max",
  "var:__obs_d_median",
  "var:__obs_e_mode",
  "var:__obs_f_mode",
];

describe("oracle: matrix_stats", () => {
  it("matches the pine2py golden bar-by-bar for numeric channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state for the observed channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMERIC_CHANNELS) {
      const name = key.slice("var:".length);
      const expected = decodeSentinel(golden.finalVarState[name]!);
      const actual = result.finalVarState[name];
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
