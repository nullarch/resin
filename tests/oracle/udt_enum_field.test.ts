// oracle/cases/udt_enum_field.pine: UDT 필드 타입이 enum인 경우(C273, corpus 258d40ea0360.pine)
// 오라클 검증. 채널 A(t1)/채널 C(t3)는 제외한다 — pine2py의 진짜 실행 모델 버그(Direction enum
// 클래스가 pine_fn(ctx) 본문 안에서 매 바 재정의돼, var로 보존된 bar-0 캡처 인스턴스와 이후 바에서
// 새로 만들어진 리터럴이 Python Enum의 identity 비교로 항상 불일치하는 문제, .pine 파일 주석 참조)
// 때문에 그 골든 값 자체가 바 1부터 잘못돼 있다. 채널 B(t2)만 매 바 재대입이라 이 버그를 피해
// 오라클 비교에 안전하다. t1/t3의 정확성은 tests/unit/codegen.test.ts의 hand-verified e2e가 대신
// 검증한다(nested UDT na 채널을 제외한 udt_nested.test.ts와 동일한 원칙).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_enum_field";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_t2_is_up", "var:__obs_t2_is_down", "var:__obs_t2_strength"];

describe("oracle: udt_enum_field", () => {
  it("matches the pine2py golden bar-by-bar (enum-typed UDT field, per-bar reassignment channel only)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state for the per-bar reassignment channel", () => {
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
