// oracle/cases/matrix_rank.pine: matrix.rank (C101, 열두 번째 슬라이스 — 행렬 대수 11종의 여섯
// 번째 항목, 43/49 -> 44/49). pine2py rank()의 n=0/n=1(valid/zero/na)/n=2(valid/na-embedded/
// zero/deficient)/n=3(valid/deficient)/비정사각(rows<columns/rows>columns)/rows-only-0cols를
// A~M 13그룹으로 검증. m===null만 pine2py가 크래시 없이 well-defined 0을 반환하지만(det/trace/
// inv와 반대) Pine 소스로 구성하기 어려워 오라클 트리거 대상에서 제외 —
// tests/unit/runtime.test.ts hand-verified로 대체(matrix.ts rt.matrix.rank 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_rank";

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
  "var:__obs_k",
  "var:__obs_l",
  "var:__obs_m",
];

describe("oracle: matrix_rank", () => {
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
