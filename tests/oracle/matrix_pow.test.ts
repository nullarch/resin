// oracle/cases/matrix_pow.pine: matrix.pow (C102, 열세 번째 슬라이스 — 행렬 대수 11종의 일곱
// 번째 항목, 44/49 -> 45/49). pine2py pow()의 identity 시드 + square-and-multiply + exponent<0
// 시 맨 마지막 inv() 적용 경로를 A~K 11그룹으로 검증(na-embedded 포함). 비정사각(isSquareMatrix
// 신규 가드, DIVERGENCES.md #37 확장)/singular+음수 지수(ValueError)/m===null/n=0+비0 지수
// (mult([],[]) IndexError)는 pine2py가 크래시하거나 pine2js가 의도적으로 다르게 구현했으므로
// 오라클로 트리거 불가 — tests/unit/runtime.test.ts hand-verified로 대체(matrix.ts rt.matrix.pow
// 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_pow";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_rows",
  "var:__obs_b",
  "var:__obs_c",
  "var:__obs_d",
  "var:__obs_e",
  "var:__obs_f",
  "var:__obs_g00",
  "var:__obs_g01",
  "var:__obs_g10",
  "var:__obs_g11",
  "var:__obs_h00",
  "var:__obs_h01",
  "var:__obs_h10",
  "var:__obs_h11",
  "var:__obs_i00",
  "var:__obs_i01",
  "var:__obs_i10",
  "var:__obs_i11",
  "var:__obs_j00",
  "var:__obs_j01",
  "var:__obs_j10",
  "var:__obs_j11",
  "var:__obs_k00",
  "var:__obs_k01",
  "var:__obs_k02",
  "var:__obs_k10",
  "var:__obs_k11",
  "var:__obs_k12",
  "var:__obs_k20",
  "var:__obs_k21",
  "var:__obs_k22",
];

describe("oracle: matrix_pow", () => {
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
