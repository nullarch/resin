// oracle/cases/matrix_pinv.pine: matrix.pinv (C104, 열다섯 번째 슬라이스 — 행렬 대수 11종의 아홉
// 번째 항목, 46/49 -> 47/49). pine2py pinv()의 mult(mt, inv(mult(m,mt))) 기본 공식 + inv가 null을
// 반환하면 mult(inv(mult(mt,m)), mt) 폴백 공식을 A~F 6그룹으로 검증(와이드/톨/정사각/na-embedded/
// 1x1/명시적 폴백 트리거). m===null/m=[]/m=[[]] 및 정사각 특이/랭크 결핍(두 공식 모두 실패)은
// 오라클로 트리거 불가 — tests/unit/runtime.test.ts hand-verified로 대체(matrix.ts rt.matrix.pinv
// 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_pinv";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a00",
  "var:__obs_a01",
  "var:__obs_a10",
  "var:__obs_a11",
  "var:__obs_a20",
  "var:__obs_a21",
  "var:__obs_b00",
  "var:__obs_b01",
  "var:__obs_b02",
  "var:__obs_b10",
  "var:__obs_b11",
  "var:__obs_b12",
  "var:__obs_c00",
  "var:__obs_c01",
  "var:__obs_c10",
  "var:__obs_c11",
  "var:__obs_d00",
  "var:__obs_d21",
  "var:__obs_e00",
  "var:__obs_f00",
  "var:__obs_f01",
  "var:__obs_f02",
  "var:__obs_f10",
  "var:__obs_f11",
  "var:__obs_f12",
];

describe("oracle: matrix_pinv", () => {
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
