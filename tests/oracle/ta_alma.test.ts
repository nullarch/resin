// oracle/cases/ta_alma.pine: ta.alma(close,3,0.85,6.0) 검증(ROADMAP P2 "ta.* 44종" — alma). length=3
// 이라 sample10.json 10바 안에서 워밍업 구간(NaN, 바 0~1)과 정상 구간(바 2~9)을 모두 커버한다.
// GOAL.md "incremental O(1)/bar" 원칙의 첫 명시적 예외(runtime/ta.ts alma() 주석 참조 — 가중치
// 배열은 캐시하되 가중합은 매 바 O(length) 재계산)가 정확히 이식됐는지 바이트 단위로 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_alma";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_alma", () => {
  it("matches the pine2py golden bar-by-bar for ta.alma", () => {
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
