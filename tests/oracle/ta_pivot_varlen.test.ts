// oracle/cases/ta_pivot_varlen.pine: ta.pivothigh/ta.pivotlow series(가변) left/right 검증
// (배치25 (4) 계속, next_hint(C551) — runtime/ta.ts pivothighVarLen/pivotlowVarLen). pine2py
// wavealgo/ta/pivot.py도 highest.py와 동일하게 상태 없이 매 호출 source.get(0..left+right)를
// 재구축하는 무상태 재스캔이라(get_ta_state 미사용, python 직접 실행 확인) #178과 같은 축으로
// **left/right 값이 실제로 변하는 축을 골든이 직접 대조한다**(sma/wma #179 퇴화-오라클 축과 다름).
// leftV=bar_index%3(0,1,2 순환)/rightV=(bar_index+1)%3(1,2,0 순환) — 서로 다른 위상이라 워밍업
// (total>data_len)/right=0(지연 없음, 왼쪽만 검사)/left=0(왼쪽 미검사, 오른쪽만 검사) 세 분기를
// 모두 커버. 음수 left/right·NaN left/right(pine2py TypeError 크래시 축)는 오라클 불가라
// tests/unit/runtime.test.ts가 hand-verified na로 커버(DIVERGENCES 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_pivot_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_pivot_varlen", () => {
  it("matches the pine2py golden bar-by-bar for genuinely varying series-length ta.pivothigh/ta.pivotlow", () => {
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
