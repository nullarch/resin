// oracle/cases/udt_udf_return.pine: UDF 반환값이 UDT 인스턴스일 때 그 반환값을 받는 '=' 로컬의
// 필드 접근 지원(C253) -- 채널 A(마지막 문장이 직접 생성자 콜인 UDF), 채널 B(마지막 문장이 UDF
// 자신의 body 안 '=' 로컬 UDT 변수를 그대로 반환), 채널 C('=' 로컬 대입 자체가 삼항 양쪽 분기 모두
// 같은 UDT 생성자)를 각각 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_udf_return";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = [
  "var:__obs_a_value",
  "var:__obs_a_direction",
  "var:__obs_b_value",
  "var:__obs_b_direction",
  "var:__obs_c_value",
  "var:__obs_c_direction",
];

describe("oracle: udt_udf_return", () => {
  it("matches the pine2py golden bar-by-bar (UDF-returned UDT field access, 3 channels)", () => {
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
