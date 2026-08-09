// oracle/cases/ta_range_percentile_varlen.pine: ta.range/ta.percentile_nearest_rank/
// ta.percentile_linear_interpolation series length 검증(배치25 (4) 계속, next_hint(C552) 잔여
// 싱글턴 3종 묶음, C553 — runtime/ta.ts rangeVarLen/percentileNearestRankVarLen/
// percentileLinearInterpolationVarLen). 셋 다 pine2py가 상태 없이 매 호출 현재 length로
// source.get(0..length-1)을 재구축하는 무상태 재스캔이라(range_func.py/percentrank.py,
// get_ta_state 미사용) **length 값이 실제로 변하는 축을 골든이 직접 대조한다**(highest/lowest
// C547·median C550과 동일 축). lenA(5,4,3,2,1 순환)로 워밍업/정상 구간을, range만 lenB(-1/0/2
// 3-way 순환)로 pine2py range_func의 length<=0 크래시 없는 -inf literal port를 함께 검증.
// percentile 2종의 length<1(크래시 축, IndexError)은 오라클 불가라 tests/unit/runtime.test.ts가
// hand-verified na로 커버.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_range_percentile_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_range_percentile_varlen", () => {
  it("matches the pine2py golden bar-by-bar for genuinely varying series-length ta.range/percentile_*", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      const exp = expected === "NaN" ? NaN : expected === "-Infinity" ? -Infinity : (expected as number);
      if (Number.isNaN(exp)) {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      } else if (exp === -Infinity) {
        expect(result.finalVarState[key]).toBe(-Infinity);
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(exp, 6);
      }
    }
  });
});
