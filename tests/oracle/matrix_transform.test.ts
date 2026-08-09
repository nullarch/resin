// oracle/cases/matrix_transform.pine: matrix.copy/fill/concat/submatrix/reshape/reverse/sort/
// diff(C93, matrix.* 네 번째 슬라이스) — 8종 전부 매 바 재생성(비-var) 행렬 + close 기반
// 초기값으로 변형 연산 자체의 정확성을 실제 bar 데이터(sample10.json)로 검증. 모든 인덱스/범위
// 인자는 컴파일타임 int 리터럴만 사용 — 음수/범위밖/na 인덱스는 pine2py가 크래시해 오라클 비교가
// 불가능한 지점은 tests/unit/runtime.test.ts의 hand-verified로 대체(matrix.ts 주석 참조).
//
// __obs_h_asc_top은 NUMERIC_CHANNELS에서 의도적으로 제외한다: pine2py의 matrix.sort는
// order.ascending/order.descending(IDENTIFIER_MAP이 Python bool True/False로 치환)을
// `order != "ascending"`(문자열 비교)으로 판정해 bool과 str이 항상 달라 오름차순 요청도 항상
// 내림차순으로 귀결되는 latent 버그를 갖고 있다(DIVERGENCES.md #33) — 이 채널의 pine2py 골든
// 값 자체가 틀렸으므로 tests/unit/runtime.test.ts(ascending 직접 검증)와
// tests/unit/codegen.test.ts(transpile e2e)의 hand-verified로 대체했다. __obs_h_desc_top은
// pine2py의 버그가 "우연히" 내림차순 의도와 일치해 그대로 오라클 채널로 유지한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_transform";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_copy_val",
  "var:__obs_a_orig_val",
  "var:__obs_b_filled",
  "var:__obs_b_untouched",
  "var:__obs_c_rows",
  "var:__obs_c_row1_col0",
  "var:__obs_d_columns",
  "var:__obs_d_row1_col1",
  "var:__obs_e_00",
  "var:__obs_e_11",
  "var:__obs_f_10",
  "var:__obs_f_21",
  "var:__obs_g_top",
  "var:__obs_g_bottom",
  "var:__obs_h_desc_top",
  "var:__obs_i_diff0_0",
  "var:__obs_i_diff1_1",
];

describe("oracle: matrix_transform", () => {
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

  it("sorts ascending correctly despite pine2py's order.ascending/descending latent bug (DIVERGENCES.md #33) — hand-verified against the same bar-0 data as the golden", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    // Section H uses [close+2, close+0, close+1] as the initial (unsorted) column-0 values;
    // a correct ascending sort must put close+0 (the smallest) first, unlike pine2py's buggy
    // golden which always returns the descending top (close+2) here.
    const close0 = data.close[0]!;
    expect(result.bars[0]!["var:__obs_h_asc_top"]).toBe(close0 + 0.0);
  });
});
