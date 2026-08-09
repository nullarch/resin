// oracle/cases/matrix_basic.pine: matrix.new/get/set/rows/columns/elements_count(C90, matrix.*
// 첫 슬라이스) — var 행렬의 바-간 지속 + 비-var 행렬의 매 바 재생성 + 0x0/rows>0-columns<=0
// 축퇴 형태를 실제 bar 데이터(sample10.json)로 검증. `+ 0.0`으로 강제 스칼라 변환한 이유는
// oracle/cases/matrix_basic.pine 상단 주석 참조(pine2py matrix.py의 set()도 map_funcs.py의
// put()과 동일하게 `_scalar()` 가드가 없는 latent 버그가 있음 — DIVERGENCES.md 참조, pine2js는
// GOAL.md 아키텍처상 이 버그를 구조적으로 재현할 수 없다). get/set의 범위 밖 na 시맨틱은
// pine2py 자체가 가드 없이 크래시해 오라클로 검증 불가 — tests/unit/runtime.test.ts의
// hand-verified 테스트로 대체(matrix.ts 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a00",
  "var:__obs_a11",
  "var:__obs_a_count",
  "var:__obs_b_diag_sum",
  "var:__obs_b_offdiag",
  "var:__obs_b_rows",
  "var:__obs_b_columns",
  "var:__obs_c_untouched",
  "var:__obs_c_count",
  "var:__obs_d_rows",
  "var:__obs_d_columns",
  "var:__obs_d_count",
  "var:__obs_e_rows",
  "var:__obs_e_columns",
  "var:__obs_e_count",
];

describe("oracle: matrix_basic", () => {
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
