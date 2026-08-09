// oracle/cases/ta_highest_lowest_implicit.pine: ta.highest(4)/ta.lowest(4) 1-인자 축약형(source
// 생략, 암묵 high/low) 검증(C250). 명시 source 채널(ta.highest(high,4)/ta.lowest(low,4))과 같은
// 골든에서 나란히 비교해 두 폼이 정확히 일치함을 확인.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_highest_lowest_implicit";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_highest_lowest_implicit", () => {
  it("matches the pine2py golden bar-by-bar for ta.highest(length)/ta.lowest(length)", () => {
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

  it("implicit ta.highest(4)/ta.lowest(4) matches explicit ta.highest(high,4)/ta.lowest(low,4)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_hi_implicit"]).toEqual(bar["var:__obs_hi_explicit_high"]);
      expect(bar["var:__obs_lo_implicit"]).toEqual(bar["var:__obs_lo_explicit_low"]);
    }
  });
});
