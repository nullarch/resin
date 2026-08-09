// oracle/cases/udt_udf_if_else_return.pine: UDF 마지막 문장이 if/else 제어문-식(암묵 반환)이고
// 각 분기가 모두 같은 UDT 생성자일 때, 그 반환값을 받는 '=' 로컬의 필드 접근 지원(C264, corpus
// 540460278459.pine 패턴 해소 -- udt_udf_return(C253)의 세 채널(직접 생성자 콜/자기 '=' 로컬 반환/
// 삼항)에 이은 네 번째 채널로 별도 오라클 케이스 신설).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_udf_if_else_return";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_value", "var:__obs_direction"];

describe("oracle: udt_udf_if_else_return", () => {
  it("matches the pine2py golden bar-by-bar (UDF if/else implicit-return UDT field access)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const prefixed of OBS_KEYS) {
      const key = prefixed.slice("var:".length);
      const expected = golden.finalVarState[key];
      if (expected === undefined) continue;
      const actual = result.finalVarState[key];
      if (typeof expected === "number" && typeof actual === "number") {
        expect(actual).toBeCloseTo(expected, 6);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
