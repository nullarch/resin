// oracle/cases/matrix_row_col.pine: matrix.row/matrix.col(C91, matrix.* 두 번째 슬라이스) — var
// 행렬의 바-간 지속 row/col 조회 + 비-var 행렬의 매 바 재생성 + rows>0/columns=0 축퇴(row는 빈
// 배열) + 0x0 축퇴(col은 index와 무관하게 항상 빈 배열)를 실제 bar 데이터(sample10.json)로 검증.
// row/col 반환값은 array라 array.get/array.size 미러로 관측(map.keys/values(C89, map_basic.pine)와
// 동일 패턴). `+ 0.0` 강제 스칼라 변환 이유는 matrix_basic.pine 상단 주석 참조(matrix.set의
// latent Series 버그 우회, pine2js는 GOAL.md 아키텍처상 이 버그를 구조적으로 재현할 수 없음).
// row/col의 음수/범위밖 인덱스 na 시맨틱(matrix.get/set(C90)과의 일관성을 위해 pine2py의 우연한
// Python negative-wraparound를 literal port하지 않기로 한 결정)과 0행 행렬에서 row()가 항상
// 크래시하는 케이스는 오라클로 검증 불가 — tests/unit/runtime.test.ts의 hand-verified 테스트로
// 대체(matrix.ts 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_row_col";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_r0_0",
  "var:__obs_a_r0_2",
  "var:__obs_a_r1_1",
  "var:__obs_a_c0_size",
  "var:__obs_a_c0_0",
  "var:__obs_a_c0_1",
  "var:__obs_a_c2_1",
  "var:__obs_b_row1_0",
  "var:__obs_b_col0_1",
  "var:__obs_c_row_size",
  "var:__obs_d_col0_size",
  "var:__obs_d_col5_size",
  "var:__obs_d_colneg_size",
];

describe("oracle: matrix_row_col", () => {
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
