// oracle/cases/udt_matrix_field.pine: matrix<T> UDT 필드(C128, array<T>/map<K,V> C126과 동일
// 메커니즘) 오라클 검증. 채널 A(rows/columns/sum)는 필드 암시 기본값(빈 0행 행렬)이 바 0~1에서 그대로
// 관측됨을, 이후는 matrix.new 재대입 + matrix.set으로 매 바 갱신되는 동적 신호를 검증한다. __obs_val00은
// pine2py matrix.get이 빈 행렬에 IndexError로 크래시하는 구간(barN<3)을 오라클 소스 자체에서
// if barN>=3으로 피해간다(GOAL.md "알려진 버그는 따르지 않는다" — C91 get/set 긍정형 가드와 동일 급).
// UDT 인스턴스 자체(var:g)는 udt_generic_field와 동일 이유로 비교 불가라 제외 -- __obs_* 스칼라
// 미러만 비교.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udt_matrix_field";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const OBS_KEYS = ["var:__obs_rows", "var:__obs_cols", "var:__obs_sum", "var:__obs_val00"];

describe("oracle: udt_matrix_field", () => {
  it("matches the pine2py golden bar-by-bar (matrix<T> UDT field, __obs_* mirrors only)", () => {
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
