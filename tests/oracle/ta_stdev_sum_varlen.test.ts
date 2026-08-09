// oracle/cases/ta_stdev_sum_varlen.pine: ta.stdev/math.sum series length 검증(배치25 (4) 다섯
// 번째 묶음, C551 — runtime/ta.ts stdevVarLen/sumVarLen). 둘 다 pine2py가 상태 없이 매 호출
// 현재 length로 창을 재구축하는 무상태 재스캔이라(stdev.py/math.__init__.sum, get_ta_state
// 미사용) **length 값이 실제로 변하는 축을 골든이 직접 대조한다**(highest/lowest C547·median/
// linreg C550과 동일 축 — sma/wma #179 퇴화-오라클 축과 다름). lenA(5,4,3,2,1 순환)로 워밍업/
// stdev 2-인자 폼(biased 기본 true)/math.sum 정상 구간을, lenB(-1/2 교대)로 pine2py stdev의
// length<0 크래시 없는 0.0 literal port를, lenC(bar_index+3, 항상 워밍업 초과)로 math.sum 고유의
// "워밍업 NaN 게이트 없음"(min(length, dataLen)로 있는 만큼만 합산) 시맨틱을 커버.
// length=0(pine2py ZeroDivisionError 크래시 축)과 biased=false(pine2py stdev.py에 없는 파라미터,
// hand-verified 확장)은 오라클 불가라 tests/unit/runtime.test.ts가 hand-verified na/값으로
// 커버(DIVERGENCES #182).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_stdev_sum_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_stdev_sum_varlen", () => {
  it("matches the pine2py golden bar-by-bar for genuinely varying series-length ta.stdev/math.sum", () => {
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
      const exp = expected === "NaN" ? NaN : (expected as number);
      if (Number.isNaN(exp)) {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(exp, 6);
      }
    }
  });
});
