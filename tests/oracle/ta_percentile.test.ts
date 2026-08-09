// oracle/cases/ta_percentile.pine: ta.percentile_nearest_rank(close, 5, 75)/(close, 5)(default
// percentage=50)/ta.percentile_linear_interpolation(close, 5, 25) 검증(C233 next_hint — corpus 3건
// 실측 ta.percentile_nearest_rank(close, len, pct)). 워밍업(바 0~3, data_len<length라 NaN)과 정상
// 구간(바 4~9)을 모두 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_percentile";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_percentile", () => {
  it("matches the pine2py golden bar-by-bar for ta.percentile_nearest_rank/ta.percentile_linear_interpolation", () => {
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
