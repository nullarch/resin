// oracle/cases/matrix_eigenvalues.pine: matrix.eigenvalues (C105, 열여섯 번째 슬라이스 — 행렬 대수
// 11종의 열 번째 항목, 47/49 -> 48/49). pine2py eigenvalues()의 n=1/n=2(disc>=0/disc<0/disc==0)/n=3
// closed-form 분기 + 비정사각(rows<columns) 자연 literal port를 A~G 7그룹으로 검증. m===null/
// m=[[]](n=1 undefined-leak)/rows>columns(부분 NaN 오염)는 오라클로 트리거 불가(pine2py 크래시) —
// tests/unit/runtime.test.ts hand-verified로 대체(matrix.ts rt.matrix.eigenvalues 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_eigenvalues";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a0",
  "var:__obs_b0",
  "var:__obs_b1",
  "var:__obs_c0",
  "var:__obs_c1",
  "var:__obs_d0",
  "var:__obs_d1",
  "var:__obs_e0",
  "var:__obs_e1",
  "var:__obs_e2",
  "var:__obs_f0",
  "var:__obs_f1",
  "var:__obs_g0",
  "var:__obs_g1",
];

describe("oracle: matrix_eigenvalues", () => {
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
