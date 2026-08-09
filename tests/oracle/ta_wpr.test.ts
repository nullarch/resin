// oracle/cases/ta_wpr.pine: ta.wpr(4) 검증(ROADMAP P2 "ta.* 44종" — wpr). length=4 워밍업
// (hh=ta.highest(high,4)/ll=ta.lowest(low,4)이 아직 안 찬 바 0~2 NaN)과 정상 구간(바 3~9)을 모두
// 커버. sample10.json엔 na가 없어 pine2py wpr.py의 skip-NaN window와 rt.ta.wpr의 poison window
// (DIVERGENCES.md #7) 차이가 이 오라클로는 드러나지 않는다 — 그 divergence는 runtime.test.ts의
// hand-verified 테스트로 별도 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_wpr";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_wpr", () => {
  it("matches the pine2py golden bar-by-bar for ta.wpr", () => {
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
