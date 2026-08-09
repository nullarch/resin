// oracle/cases/matrix_eigenvectors.pine: matrix.eigenvectors (C106, 열일곱 번째이자 마지막
// 슬라이스 — 행렬 대수 11종의 열한 번째 항목, matrix.* 48/49 -> 49/49 완주). pine2py
// eigenvectors()의 n=2 두 분기(비율/폴백)와 n=3(고정 벡터 반복) 정상 경로를 A~G 7그룹으로
// 검증한다. m===null/m=[[]](eigenvalues 내부 크래시를 하위에서 흡수)/rows>columns는 오라클로
// 트리거 불가(pine2py 크래시) — tests/unit/runtime.test.ts hand-verified로 대체(matrix.ts
// rt.matrix.eigenvectors 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_eigenvectors";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a0",
  "var:__obs_b00",
  "var:__obs_b01",
  "var:__obs_b10",
  "var:__obs_b11",
  "var:__obs_c00",
  "var:__obs_c01",
  "var:__obs_c10",
  "var:__obs_c11",
  "var:__obs_d00",
  "var:__obs_d01",
  "var:__obs_d10",
  "var:__obs_d11",
  "var:__obs_e00",
  "var:__obs_e01",
  "var:__obs_e02",
  "var:__obs_e10",
  "var:__obs_e20",
  "var:__obs_f00",
  "var:__obs_f01",
  "var:__obs_f10",
  "var:__obs_f11",
  "var:__obs_g00",
  "var:__obs_g01",
  "var:__obs_g10",
  "var:__obs_g11",
];

describe("oracle: matrix_eigenvectors", () => {
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
