// oracle/cases/ta_highestbars_lowestbars_varlen.pine: ta.highestbars/ta.lowestbars series(가변)
// length 검증(배치25 (4) 세 번째, C549 — runtime/ta.ts highestbarsVarLen/lowestbarsVarLen).
// len1(1~5 순환, close 소스 — 실제 오프셋 -1/-2/-3 변화)과 len2(0~2 순환, high-low 인라인
// 표현식 — sample10에서 high-low가 상수라 전 바 동률이 되어 "동률은 가장 최근 바(0)" 정책과
// length<1일 때 pine2py의 빈 루프 0 반환까지 골든으로 직접 검증) 둘 다 커버.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_highestbars_lowestbars_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_highestbars_lowestbars_varlen", () => {
  it("matches the pine2py golden bar-by-bar for series-length ta.highestbars/ta.lowestbars", () => {
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
      const exp = expected === "NaN" ? NaN : expected === "Infinity" ? Infinity : expected === "-Infinity" ? -Infinity : (expected as number);
      if (Number.isNaN(exp)) {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      } else if (!Number.isFinite(exp)) {
        expect(result.finalVarState[key]).toBe(exp);
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(exp, 6);
      }
    }
  });
});
