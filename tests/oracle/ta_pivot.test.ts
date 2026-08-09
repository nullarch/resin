// oracle/cases/ta_pivot.pine: ta.pivothigh(close,1,1)/ta.pivotlow(close,1,1) 검증(ROADMAP P2
// "ta.* 44종" — pivothigh/pivotlow). right=1바 지연이 있는 첫 TA라 마지막 바(9)의 결과가 NaN일 수
// 있어(right>=1이면 "다음" 바가 없으면 우측 검사가 불가능) finalVarState 검증도 다른 오라클
// 테스트와 달리 toBeCloseTo 대신 nearlyEqual(NaN===NaN을 PASS로 취급)을 쓴다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_pivot";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_pivot", () => {
  it("matches the pine2py golden bar-by-bar for ta.pivothigh/ta.pivotlow", () => {
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
      expect(nearlyEqual(result.finalVarState[key]!, decodeSentinel(expected))).toBe(true);
    }
  });
});
