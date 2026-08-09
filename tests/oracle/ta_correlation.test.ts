// oracle/cases/ta_correlation.pine: ta.correlation(close,volume,3) 검증(ROADMAP P2 "ta.* 44종" —
// correlation). length=3이라 sample10.json 10바 안에서 워밍업 구간(NaN, 바 0~1)과 정상 구간(바
// 2~9)을 모두 커버한다. close vs volume은 sample10.json에서 서로 독립적인 두 시리즈라 close vs
// open/high/low(상수 오프셋이라 상관계수가 항상 1.0인 퇴화 케이스)와 달리 numerator/denominator
// 산식이 실제로 변동하는 값을 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_correlation";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_correlation", () => {
  it("matches the pine2py golden bar-by-bar for ta.correlation", () => {
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
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
