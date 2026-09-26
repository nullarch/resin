// oracle/cases/ta_vwap.pine: ta.vwap(source) on sample10.json (a daily chart with no time channel,
// the default calendar opening a session at 00:00 every day). The pine2py golden is NOT ground truth
// here: it accumulates from bar 0 and never resets. ref_v6_ta_math.txt ta.vwap: the default anchor
// "is equivalent to passing timeframe.change() with "1D" as its argument"; PyneCore (lib/ta.py vwap,
// `anchor = session.isfirstbar`) and TradingView's tier 1 export (resin-harness
// suites/indicators/tv/ta_301_vwap: ta.vwap(close) restarts on the first bar of each session) agree.
// On a daily chart every bar holds a session start, so every bar is its own period and the VWAP is
// the bar's source. Two call sites (close/high) also pin independent state per site.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_vwap";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_vwap", () => {
  it("the pine2py golden (not ground truth) never resets: bar 1 averages bars 0 and 1", () => {
    const golden = loadGolden(CASE_NAME);
    expect(golden.bars[1]!["var:__obs_vwap_c"]).toBeCloseTo((101 * 1000 + 102 * 1100) / 2100, 9);
  });

  it("resets on every daily bar (each one starts a session): the vwap is the bar's source", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(data.close.length);
    for (let i = 0; i < data.close.length; i++) {
      expect(result.bars[i]!["var:__obs_vwap_c"]).toBe(data.close[i]);
      expect(result.bars[i]!["var:__obs_vwap_h"]).toBe(data.high[i]);
    }
  });
});
