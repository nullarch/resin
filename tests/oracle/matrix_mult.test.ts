// oracle/cases/matrix_mult.pine: matrix.mult (C97, 여덟 번째 슬라이스 — 행렬 대수 11종의 두 번째
// 항목, 39/49 -> 40/49). pine2py mult()의 3분기(스칼라/벡터/행렬)를 python 직접 실행으로 검증:
// 스칼라 분기는 Python `isinstance(nan, float)==True`라 na 스칼라도 스칼라 분기로 들어가 전 원소가
// na로 오염된다(literal port, F/G그룹). 벡터/행렬 분기는 na 원소가 dot product sum에 섞이면 그 항
// 전체가 na(IEEE754 NaN 전파, B/D그룹). G그룹은 정사각이 아닌 차원 조합(2x3 x 3x2)의 일반 행렬곱을
// 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_mult";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a00",
  "var:__obs_a01",
  "var:__obs_a10",
  "var:__obs_a11",
  "var:__obs_b00",
  "var:__obs_b01",
  "var:__obs_b10",
  "var:__obs_b11",
  "var:__obs_c0",
  "var:__obs_c1",
  "var:__obs_d0",
  "var:__obs_d1",
  "var:__obs_e00",
  "var:__obs_f00",
  "var:__obs_g00",
  "var:__obs_g01",
  "var:__obs_g10",
  "var:__obs_g11",
];

describe("oracle: matrix_mult", () => {
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
