// oracle/cases/ctrlflow_selfref_assign.pine: 제어문-식 대입 자기참조(C266 수정 검증) --
// `x := if cond \n x + 1.0 \n else \n x - 0.5`처럼 분기 값 표현식이 대입 대상 자신을 읽는 조합.
// C265가 발견한 "target = NaN 선대입이 자기참조 읽기를 먼저 덮어써 항상 NaN" 버그의 수정
// (`let __cfrN` 임시변수 + 최종 1회 대입)을 pine2py 삼항 패스트패스(단일 표현식 if/else)와
// 바별 대조한다. 3채널: top-level var ':=' / UDT 필드 / UDF 내부 var ':='(funcCtx 슬롯).
// var:p(UDT 인스턴스)는 udt_basic과 동일하게 비교 불가, var:acc(UDF 내부 var)는 pine2js가
// $.fnVars로 격리해 top-level 채널에 없음(udf_single_var와 동일) -- 그 외 채널만 비교.
// elif/switch/for/while 자기참조는 pine2py가 크래시해 오라클 불가 -- codegen.test.ts의
// hand-verified 실행 테스트가 담당(DIVERGENCES.md 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ctrlflow_selfref_assign";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:x", "var:__obs_x", "var:__obs_energy", "var:__obs_f"];

describe("oracle: ctrlflow_selfref_assign", () => {
  it("matches the pine2py golden bar-by-bar (self-referential if/else-expr ':=' on var, UDT field, UDF-local var)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state for the comparable channels", () => {
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
