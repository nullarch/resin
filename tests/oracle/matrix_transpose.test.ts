// oracle/cases/matrix_transpose.pine: matrix.transpose (C96, 일곱 번째 슬라이스 — 행렬 대수 11종의
// 첫 항목, 38/49 -> 39/49). pine2py `if not m: return []`는 None과 0행을 파이썬 falsy로 함께 처리해
// 둘 다 빈 배열을 반환(python 직접 실행 실측) — na(null) 전파가 아니라 literal port. D/E 그룹이
// "None과 동치인 falsy 경로"와 "columns=0이라 결과 루프 0회"라는 서로 다른 코드 경로가 동일한 []에
// 수렴함을 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_transpose";

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
  "var:__obs_b10",
  "var:__obs_b11",
  "var:__obs_c00",
  "var:__obs_d_rows",
  "var:__obs_d_columns",
  "var:__obs_e_rows",
  "var:__obs_e_columns",
];

describe("oracle: matrix_transpose", () => {
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
