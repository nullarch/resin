// oracle/cases/ta_median_linreg_varlen.pine: ta.median/ta.linreg series length 검증(배치25 (4)
// 묶음, C550 — runtime/ta.ts medianVarLen/linregVarLen). 두 함수 모두 pine2py가 상태 없이 매 호출
// 현재 length로 창을 재구축하는 무상태 재스캔이라(median.py/linreg.py, get_ta_state 미사용)
// **length 값이 실제로 변하는 축을 골든이 직접 대조한다**(highest/lowest C547과 동일 축 —
// sma/wma #179 퇴화-오라클 축과 다름). lenA(5,4,3,2,1 순환)로 워밍업/홀짝 median/2·3-인자 linreg
// (offset 0 패딩/2 투영)를, lenB(-1/2 교대)로 pine2py의 length<0 크래시 없는 +0.0 literal port를
// 커버. length=0(pine2py ZeroDivisionError/IndexError 크래시 축)은 오라클 불가라
// tests/unit/runtime.test.ts가 hand-verified na로 커버(DIVERGENCES #181).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_median_linreg_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_median_linreg_varlen", () => {
  it("matches the pine2py golden bar-by-bar for genuinely varying series-length ta.median/ta.linreg", () => {
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
