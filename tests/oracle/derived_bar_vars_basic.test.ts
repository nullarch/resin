// oracle/cases/derived_bar_vars_basic.pine: hl2/hlc3/ohlc4/hlcc4/bar_index bare 식별자 검증
// (ROADMAP "hl2/hlc3/ohlc4/hlcc4/bar_index bare 식별자 이식", DIVERGENCES.md #15). sample10.json
// 10바 전 구간 + hl2[1]/bar_index[1] 히스토리 인덱싱까지 pine2py 골든과 대조.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "derived_bar_vars_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: derived_bar_vars_basic", () => {
  it("matches the pine2py golden bar-by-bar for hl2/hlc3/ohlc4/hlcc4/bar_index (+ history indexing)", () => {
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
