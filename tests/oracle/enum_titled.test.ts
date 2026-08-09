// oracle/cases/enum_titled.pine: enum 멤버 title 문자열 할당(C136, ROADMAP 'enum' 잔여 슬라이스)
// 오라클 검증. enum_basic.test.ts와 동일한 원칙(enum 값 자체의 런타임 표현은 pine2py/pine2js가
// 항상 다르므로 "var:d"는 비교 대상에서 제외 — DIVERGENCES.md #55) 위에, 멤버 중 일부(long/short)
// 에만 title을 붙이고 하나(flat)는 bare로 남겨, title 유무가 등가/부등가 비교와 switch 분기 결과에
// 아무 영향도 주지 않음을 golden 대조로 확인한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "enum_titled";

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

describe("oracle: enum_titled", () => {
  it("matches the pine2py golden bar-by-bar (titled + bare members mixed, __obs_* mirrors only)", () => {
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
