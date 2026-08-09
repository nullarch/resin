// oracle/cases/udt_field_compound_assign.pine: UDT 필드 복합 대입(`obj.field += value` 등, C261
// 신규 지원 — 파서가 `obj.field := obj.field op value`로 데슈가링). 채널 1(Acc)은 +=/*=/+=(int)
// 3종을, 채널 2(Acc2)는 -=//=/%= 3종을 매 바 갱신 러닝 값으로 검증(udt_basic.pine 채널 C와
// 동일 방식 — 필드 대입은 var 게이팅과 무관하게 매 바 실행되는 top-level 문장이라 바마다 값이
// 바뀌는 실제 동적 신호를 준다).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_field_compound_assign";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// var:a/var:a2(UDT 인스턴스 자체)는 udt_basic.test.ts와 동일한 이유로 비교 불가 영역(dataclass
// repr() vs plain JS object) — __obs_* 미러 채널만 비교한다.
const OBS_KEYS = [
  "var:__obs_sum",
  "var:__obs_prod",
  "var:__obs_count",
  "var:__obs_diff",
  "var:__obs_ratio",
  "var:__obs_rem",
];

describe("oracle: udt_field_compound_assign", () => {
  it("matches the pine2py golden bar-by-bar (+=/-=/*=//=/%= on UDT fields, __obs_* mirrors only)", () => {
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
