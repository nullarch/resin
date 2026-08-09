// oracle/cases/matrix_kron.pine: matrix.kron (C103, 열네 번째 슬라이스 — 행렬 대수 11종의 여덟
// 번째 항목, 45/49 -> 46/49). pine2py kron()의 4중 루프(result[i*r2+p][j*c2+q]=m1[i][j]*m2[p][q])를
// A~G 7그룹으로 검증(na-embedded/비대칭 차원/0열 포함). m1/m2===null 및 0행 행렬(len(m1[0])
// IndexError, python/JS 둘 다 크래시)은 오라클로 트리거 불가 — tests/unit/runtime.test.ts
// hand-verified로 대체(matrix.ts rt.matrix.kron 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_kron";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a0",
  "var:__obs_a1",
  "var:__obs_a2",
  "var:__obs_a3",
  "var:__obs_b0",
  "var:__obs_b1",
  "var:__obs_b2",
  "var:__obs_b3",
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
  "var:__obs_e10",
  "var:__obs_e11",
  "var:__obs_f00",
  "var:__obs_f01",
  "var:__obs_f10",
  "var:__obs_f11",
  "var:__obs_f20",
  "var:__obs_f21",
  "var:__obs_f30",
  "var:__obs_f31",
  "var:__obs_g_rows",
  "var:__obs_g_cols",
];

describe("oracle: matrix_kron", () => {
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
