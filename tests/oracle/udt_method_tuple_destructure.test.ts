// oracle/cases/udt_method_tuple_destructure.pine: UDT method(점 호출) 콜 결과의 top-level 튜플
// 디스트럭처링([lower, upper] = bx.scaledBounds(1.5)) — C463, wild "튜플 디스트럭처링의 값은
// 튜플을 반환하는 UDF 호출이어야 함" 클러스터 재조사로 발견한 갭.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_method_tuple_destructure";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// onlyKeys: pine2py의 ctx._var_state는 top-level 'bx'를 Box UDT 인스턴스 그대로(repr 문자열)
// 스냅샷하지만, compareToGolden/nearlyEqual은 numeric 전용(golden.ts 주석 참조) — 원시 UDT var
// 채널은 비교 대상에서 제외하고 __obs_* 미러 채널만 대조한다(udt_tuple_destructure_return.test.ts와
// 동일 원칙).
const OBS_KEYS = ["var:__obs_lower", "var:__obs_upper"];

describe("oracle: udt_method_tuple_destructure", () => {
  it("matches the pine2py golden bar-by-bar (UDT method tuple return + top-level destructure)", () => {
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
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
