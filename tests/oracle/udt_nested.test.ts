// oracle/cases/udt_nested.pine: 중첩 UDT 필드(analyzer UDT_SCALAR_FIELD_TYPES 확장, C123) 오라클
// 검증. 채널 A(인자 없는 .new() 체인)는 중첩 필드의 명시 기본값(factory 호출)을, 채널 B는 중첩
// UDT 인스턴스를 위치 인자로 직접 전달하는 경로를, 채널 C는 체이닝 필드 대입(':=')을 매 바
// 갱신하는 러닝 합계로 동적 신호까지 검증한다. na 중첩 필드 채널은 pine2py가 na를 타입 무관
// float('nan')으로 컴파일해 오라클 비교가 구조적으로 불가능한 영역이라(C107/C110급, udt_basic.pine
// 관례와 동일) 제외했다 — tests/unit/codegen.test.ts의 hand-verified e2e가 그 채널을 대신 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_nested";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// udt_basic.test.ts와 동일한 이유로 "var:<name>" 채널 중 UDT 인스턴스 자체(var:o1/o2/acc)는 두
// 런타임의 표현 형식이 근본적으로 달라(dataclass repr() 문자열 vs plain object) 비교 불가 —
// __obs_* 스칼라 미러 채널만 골라 비교한다.
const OBS_KEYS = [
  "var:__obs_o1_inner_x",
  "var:__obs_o1_inner_y",
  "var:__obs_o2_inner_x",
  "var:__obs_o2_inner_y",
  "var:__obs_acc_inner_x",
  "var:__obs_acc_label",
];

describe("oracle: udt_nested", () => {
  it("matches the pine2py golden bar-by-bar (nested UDT field construction + chained read/write, __obs_* mirrors only)", () => {
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
