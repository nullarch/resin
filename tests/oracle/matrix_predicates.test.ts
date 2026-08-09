// oracle/cases/matrix_predicates.pine: matrix.is_square/is_symmetric/is_antisymmetric/
// is_diagonal/is_antidiagonal/is_identity/is_triangular/is_stochastic/is_binary/is_zero
// (C94, 다섯 번째 슬라이스) — 순수 read-only 술어 10종을 매 바 동일 결과가 나오는 컴파일타임
// float 리터럴로 구성한 A~J 10섹션(구조 검사라 close 기반 값 불필요, matrix_predicates.pine
// 상단 주석 참조). bool은 var float 0.0/1.0 미러로 관측(ta_crossover_crossunder.pine과 동일
// 패턴). na(null) 행렬/0행 등 크래시·경계 지점은 python 직접 실행으로 확인 후
// tests/unit/runtime.test.ts의 hand-verified로 대체(matrix_transform.pine과 동일 원칙).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_predicates";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_square",
  "var:__obs_a_nonsquare",
  "var:__obs_a_empty",
  "var:__obs_b_symmetric",
  "var:__obs_b_asymmetric",
  "var:__obs_c_antisymmetric",
  "var:__obs_c_not_antisymmetric",
  "var:__obs_d_diagonal",
  "var:__obs_d_not_diagonal",
  "var:__obs_e_antidiagonal",
  "var:__obs_e_not_antidiagonal",
  "var:__obs_f_identity",
  "var:__obs_f_not_identity",
  "var:__obs_g_upper",
  "var:__obs_g_lower",
  "var:__obs_g_neither",
  "var:__obs_h_square",
  "var:__obs_h_rect",
  "var:__obs_h_not_stochastic",
  "var:__obs_i_binary",
  "var:__obs_i_not_binary",
  "var:__obs_j_exact_zero",
  "var:__obs_j_epsilon_zero",
  "var:__obs_j_not_zero",
];

describe("oracle: matrix_predicates", () => {
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
