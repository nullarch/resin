// oracle/cases/ta_highestbars_lowestbars.pine: ta.highestbars(close,4)/ta.lowestbars(close,4) 검증
// (ROADMAP P2 "ta.* 44종" — highestbars/lowestbars). length=4 워밍업(바 0~2 NaN, 첫 유효값은 바3)과
// 정상 구간(바 3~9)을 모두 커버. sample10.json close에는 동률이 없어 tie-break 방향(가장 최근 바가
// 이김)은 이 오라클로 드러나지 않음 — 그 검증은 runtime.test.ts hand-verified로 별도 커버.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_highestbars_lowestbars";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_highestbars_lowestbars", () => {
  it("matches the pine2py golden bar-by-bar for ta.highestbars/ta.lowestbars", () => {
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
