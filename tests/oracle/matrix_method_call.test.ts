// oracle/cases/matrix_method_call.pine: method-call 스타일 matrix 콜(C237, Pine v5 sugar
// `m.det()` == `matrix.det(m)`) — top-level var 수신자(matrixVars 경로)와 '=' 로컬 수신자
// (matrixKindHints 경로) 둘 다 실제 bar 데이터(sample10.json)로 검증. pine2py의 method-call
// 스타일 디스패치(_try_method_style_call)는 MATRIX_METHODS 화이트리스트(codegen.py L1261-1269)가
// set/get/new/copy/sort 등을 포함하지 않아 이 케이스는 det/rank/transpose/is_diagonal/is_identity/
// is_square만 sugar로 쓰고 행렬 채우기는 static matrix.set()으로 한다(.pine 소스 주석 참조,
// method-call 형태의 set/sort는 codegen.test.ts의 hand-verified E2E로 대체).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "matrix_method_call";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_det",
  "var:__obs_a_rank",
  "var:__obs_a_t01",
  "var:__obs_b_diag",
  "var:__obs_b_ident",
  "var:__obs_b_square",
];

describe("oracle: matrix_method_call", () => {
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
      if (Number.isNaN(expected as number)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
