// oracle/cases/udf_nested_call.pine: UDF-in-UDF 중첩 호출(C267[part2], corpus "UDF 안에서 다른
// UDF를 호출하는 것은 아직 지원하지 않음" 클러스터 18건 실측) — analyzeUserFuncCall의 blanket
// scope.func!==null 거부를 걷어내고 기존 콜사이트별(AST 노드 키) slotBase 배정 메커니즘을 그대로
// 재사용했다(codegen 변경 0줄). 채널: 3단 체인(outer -> mid -> leaf, ta.sma + var 누산 상태)과
// 실제 corpus 동형 패턴(getNormRSI -> getRSI/normalize, ta.rsi + ta.lowest/highest) 양쪽 다 함수당
// 콜사이트 1개(다중 콜사이트 독립성은 오라클 무효 — tests/unit/codegen.test.ts가 담당, 이 파일
// 상단 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_nested_call";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_result", "var:__obs_normed"];

describe("oracle: udf_nested_call", () => {
  it("matches the pine2py golden bar-by-bar (multi-level UDF-in-UDF nesting, ta + var state)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state for the __obs_* mirrors", () => {
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
