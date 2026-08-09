// oracle/cases/matrix_det.pine: matrix.det (C98, 아홉 번째 슬라이스 — 행렬 대수 11종의 세 번째
// 항목, 40/49 -> 41/49). pine2py det()의 n=0/1/2/n>=3(Gaussian elimination) 4분기를 A~J
// 10그룹으로 검증(singular/na-first-pivot/na-not-first-pivot/비정사각 rows<columns 포함). 비정사각
// rows>columns/m===null/m=[[]](1행0열)는 pine2py가 크래시하는 미정의 지점이라 오라클로 트리거
// 불가 — tests/unit/runtime.test.ts hand-verified로 대체(matrix.ts rt.matrix.det 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_det";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a",
  "var:__obs_b",
  "var:__obs_c",
  "var:__obs_d",
  "var:__obs_e",
  "var:__obs_f",
  "var:__obs_g",
  "var:__obs_h",
  "var:__obs_i",
  "var:__obs_j",
];

describe("oracle: matrix_det", () => {
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
