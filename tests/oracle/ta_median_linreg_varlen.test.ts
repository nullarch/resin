// oracle/cases/ta_median_linreg_varlen.pine: ta.median/ta.linreg series length 검증(배치25 (4)
// 묶음, C550 — runtime/ta.ts medianVarLen/linregVarLen). lenA(5,4,3,2,1 순환)로 워밍업/홀짝
// median/2·3-인자 linreg(offset 0 패딩/2)를, lenB(-1/2 교대)로 length<1을 커버.
//
// The golden in oracle/golden/ta_median_linreg_varlen.json is pine2py's. Its median channel stands.
// Its linreg channels do not: pine2py projected the line forward (n - 1 + offset, against
// ref_v6_ta_math.txt "linreg = intercept + slope * (length - 1 - offset)"), re-read the last `length`
// bars on every call, and returned +0.0 for a negative length. The PyneCore oracle (lib/ta.py linreg,
// TradingView-measured; tier 1 resin-harness suites/indicators/tv/ta_181_linreg) keeps a window of
// stored sources whose warm-up counter steps one source at a time while below the CURRENT length, and
// a length-1 bar returns the source without storing it — so bar 5 (length 5, four stored sources) is
// na again. __obs_lr1/__obs_lr2 below are the oracle's values on the harness twin
// (resin-harness state/repros/linreg-offset-na.json, channels lr_var/lr_var2). The oracle rejects a
// length below 1 (assertion); resin reads it as na and stores nothing, so __obs_lr3 follows from the
// length-2 bars alone.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_median_linreg_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const EXPECTED: Readonly<Record<string, readonly number[]>> = {
  // PyneCore, sample10.json, ta.linreg(close, 5 - bar_index % 5).
  "var:__obs_lr1": [NaN, NaN, 103, 102, 104, NaN, 105.8, 316 / 3, 107, 108],
  // PyneCore, sample10.json, ta.linreg(high + close, 5 - bar_index % 5, 2).
  "var:__obs_lr2": [NaN, NaN, 203, 209, 209, NaN, 207.8, 635 / 3, 207, 217],
  // Length -1 on even bars (na, nothing stored), 2 on odd bars: bars 1/3 store 102 and 102, bar 5
  // 105, bar 7 105, bar 9 108.
  "var:__obs_lr3": [NaN, NaN, NaN, 102, NaN, 105, NaN, 105, NaN, 108],
};

describe("oracle: ta_median_linreg_varlen", () => {
  it("matches the pine2py golden bar-by-bar for series-length ta.median", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_med1"]);
  });

  it("matches the PyneCore oracle bar-by-bar for series-length ta.linreg", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, values] of Object.entries(EXPECTED)) {
      expect(result.bars).toHaveLength(values.length);
      for (let i = 0; i < values.length; i++) {
        const actual = result.bars[i]![key]!;
        expect(nearlyEqual(actual, values[i]!), `bar ${i} ${key}: actual=${actual} expected=${values[i]}`).toBe(true);
      }
    }
  });

  it("matches the final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_med1"]).toBeCloseTo(golden.finalVarState["__obs_med1"] as number, 6);
    for (const [key, values] of Object.entries(EXPECTED)) {
      expect(result.finalVarState[key.slice("var:".length)]).toBeCloseTo(values[9]!, 9);
    }
  });
});
