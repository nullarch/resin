// oracle/cases/enum_basic.pine: enum 선언(리터럴 멤버만) + 멤버 접근(Direction.long) 등가/부등가
// 비교 + switch 분기(UDT ROADMAP 두 번째 슬라이스). pine2py는 enum을 실제 Python Enum 클래스로
// codegen하고 gen_oracle.py의 enc()가 멤버를 bare 이름 문자열(v.value, 예: "long")로 인코딩하는
// 반면, pine2js는 멤버 접근을 "EnumName.MemberName" qualified 문자열로 접는다(서로 다른 enum의
// 동명 멤버를 구분하기 위해) — 두 표현이 문자열 레벨에서 다르므로 enum 값 자체("var:d")는
// 오라클 비교 대상에서 제외하고, 표현 방식과 무관하게 항상 일치해야 하는 등가/부등가 비교 결과
// (boolean)와 switch 분기 결과만 비교한다(udt_basic.test.ts가 dataclass repr()을 제외한 것과
// 동일 원칙).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "enum_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = [
  "var:__obs_is_long",
  "var:__obs_is_short",
  "var:__obs_is_flat",
  "var:__obs_not_long",
  "var:__obs_switch_val",
];

describe("oracle: enum_basic", () => {
  it("matches the pine2py golden bar-by-bar (enum member equality/inequality + switch dispatch, __obs_* mirrors only)", () => {
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
