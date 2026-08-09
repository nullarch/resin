// oracle/cases/matrix_inv.pine: matrix.inv (C100, 열한 번째 슬라이스 — 행렬 대수 11종의 다섯
// 번째 항목, 42/49 -> 43/49). pine2py inv()의 n=0/n=1/n=2/n=3(Gauss-Jordan) 경로를 A~F 6그룹으로
// 검증(na-embedded 포함). singular/비정사각(rows<columns/rows>columns)/m===null/m=[[]]는 pine2py가
// 크래시하거나(singular/rows>columns/null/[[]]) pine2js가 의도적으로 na(null)를 반환하도록 다르게
// 구현했으므로(비정사각, DIVERGENCES.md #37) 오라클로 트리거 불가 — tests/unit/runtime.test.ts
// hand-verified로 대체(matrix.ts rt.matrix.inv 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_inv";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_rows",
  "var:__obs_b",
  "var:__obs_c",
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
  "var:__obs_f02",
  "var:__obs_f10",
  "var:__obs_f11",
  "var:__obs_f12",
  "var:__obs_f20",
  "var:__obs_f21",
  "var:__obs_f22",
];

describe("oracle: matrix_inv", () => {
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
