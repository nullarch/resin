// oracle/cases/ta_change_mom.pine: ta.change(close, 3)/ta.mom(close, 3) 검증(ROADMAP P2
// "ta.* 44종" — change/mom). pine2py wavealgo/ta/change.py 소스 대조로 mom()이 change()의 완전한
// 별칭임을 확인했으므로 같은 케이스에서 둘 다 함께 관측한다. 워밍업(바 0~2, data_len<=3 -> NaN)과
// 정상 구간(바 3~9)을 모두 커버.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_change_mom";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_change_mom", () => {
  it("matches the pine2py golden bar-by-bar for ta.change/ta.mom", () => {
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
