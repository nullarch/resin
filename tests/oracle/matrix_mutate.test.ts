// oracle/cases/matrix_mutate.pine: matrix.add_row/add_col/remove_row/remove_col/swap_rows/
// swap_columns(C92, matrix.* 세 번째 슬라이스) — 6종 전부 매 바 재생성(비-var) 행렬 + close
// 기반 초기값으로 구조 변경 연산 자체의 정확성(삽입/제거 위치, 밀려난 원소, 반환값)을 실제 bar
// 데이터(sample10.json)로 검증. 전 채널이 컴파일타임 int 리터럴 인덱스만 사용 — 음수/범위밖/na
// 인덱스는 pine2py가 크래시하거나(remove_row/remove_col/swap_rows/swap_columns) 유효 범위
// 안에서도 latent TypeError를 내(add_row/add_col, DIVERGENCES.md #32) 오라클 비교가 불가능해
// tests/unit/runtime.test.ts의 hand-verified로 대체(matrix.ts 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_mutate";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_rows",
  "var:__obs_a_new_row_0",
  "var:__obs_a_new_row_1",
  "var:__obs_a_shifted_row_0",
  "var:__obs_a2_rows",
  "var:__obs_a2_new_row_isnan",
  "var:__obs_b_columns",
  "var:__obs_b_new_col_0",
  "var:__obs_b_new_col_1",
  "var:__obs_b_shifted_col_0",
  "var:__obs_c_removed",
  "var:__obs_c_rows_after",
  "var:__obs_c_row1_after",
  "var:__obs_d_removed",
  "var:__obs_d_columns_after",
  "var:__obs_d_col1_after",
  "var:__obs_e_row0",
  "var:__obs_e_row1",
  "var:__obs_f_col0",
  "var:__obs_f_col1",
];

describe("oracle: matrix_mutate", () => {
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
