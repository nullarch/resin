// oracle/cases/ta_highestbars_lowestbars.pine: ta.highestbars(close,4)/ta.lowestbars(close,4) 검증
// (ROADMAP P2 "ta.* 44종" — highestbars/lowestbars). length=4 워밍업(바 0~2 NaN, 첫 유효값은 바3)과
// 정상 구간(바 3~9)을 모두 커버. sample10.json close ties at bars 1/3 and 5/7: the golden's
// lowestbars at bars 4 and 8 hold the oldest occurrence (-3), hand-edited over pine2py's newest-wins
// (tier 1 resin-harness state/repros/tv-ta_141_highest_lowest.json; see oracle/cases/*.pine).

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
