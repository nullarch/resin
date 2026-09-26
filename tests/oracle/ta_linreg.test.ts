// oracle/cases/ta_linreg.pine: ta.linreg(close, 4, offset) on sample10.json, covering the warm-up
// (na on bars 0-2, first value on bar 3) and offset 0 / offset 2.
//
// The golden in oracle/golden/ta_linreg.json is pine2py's, and pine2py projected the line FORWARD
// (intercept + slope * (n - 1 + offset)), so its offset-2 channel is not ground truth. The manual
// reads it the other way (ref_v6_ta_math.txt "ta.linreg": "linreg = intercept + slope * (length - 1 -
// offset)"), TradingView agrees (tier 1 resin-harness suites/indicators/tv/ta_181_linreg:
// linreg(close, 20, 10) is 1.06784563158 on bar 19), and so does the PyneCore oracle on the harness
// twin of this case (resin-harness state/repros/linreg-offset-na.json, channel lr2), whose values are
// asserted below. The offset-0 channel reads the newest bar either way and stays on the golden.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_linreg";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json, ta.linreg(close, 4, 2).
const LINREG2_SAMPLE10: readonly number[] = [NaN, NaN, NaN, 101.8, 102.5, 103.1, 103.6, 104.8, 105.5, 106.1];

describe("oracle: ta_linreg", () => {
  it("matches the pine2py golden bar-by-bar for ta.linreg(close, 4, 0)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_linreg0"]);
  });

  it("matches the PyneCore oracle bar-by-bar for ta.linreg(close, 4, 2)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(LINREG2_SAMPLE10.length);
    for (let i = 0; i < LINREG2_SAMPLE10.length; i++) {
      const actual = result.bars[i]!["var:__obs_linreg2"]!;
      expect(nearlyEqual(actual, LINREG2_SAMPLE10[i]!), `bar ${i}: actual=${actual} oracle=${LINREG2_SAMPLE10[i]}`).toBe(true);
    }
  });

  it("matches the final var state (golden for offset 0, the oracle for offset 2)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_linreg0"]).toBeCloseTo(golden.finalVarState["__obs_linreg0"] as number, 6);
    expect(result.finalVarState["__obs_linreg2"]).toBeCloseTo(LINREG2_SAMPLE10[9]!, 9);
  });
});
