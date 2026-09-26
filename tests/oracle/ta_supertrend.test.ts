// oracle/cases/ta_supertrend.pine: ta.supertrend(factor, atrPeriod) on sample10.json (factor=2,
// atrPeriod=3). The pine2py golden is NOT ground truth here: it reports direction +1 for an uptrend,
// (NaN, 0) during warm-up, and judges a flip against the previous bar's bands. TradingView's tier 1
// export of the built-in Supertrend Strategy (resin-harness suites/strategy/tv/supertrend, long on
// ta.change(direction) < 0, 601/601 trades) and the PyneCore oracle (lib/ta.py supertrend) both
// contradict it: direction is 1 in a downtrend (line on the upper band) and -1 in an uptrend, the
// first bar is (0, 1), warm-up bars are (NaN, 1). The expectations below are the oracle's values for
// these bars (harness repro state/repros/supertrend-direction.json covers the same rule).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_supertrend";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore oracle, sample10.json, ta.supertrend(2.0, 3).
const SUPERTREND_SAMPLE10: [number, number][] = [
  [0, 1],
  [NaN, 1],
  [108.5, 1],
  [107.5, 1],
  [107.5, 1],
  [107.5, 1],
  [107.5, 1],
  [107.5, 1],
  [107.5, 1],
  [101.5, -1],
];

describe("oracle: ta_supertrend", () => {
  it("the pine2py golden (not ground truth) is NaN/0 through bar2 and reads an uptrend as +1", () => {
    const golden = loadGolden(CASE_NAME);
    for (let i = 0; i < 3; i++) {
      expect(golden.bars[i]!["var:__obs_value"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_direction"]).toBe(0);
    }
    expect(golden.bars[3]!["var:__obs_value"]).toBe(95.5);
    expect(golden.bars[3]!["var:__obs_direction"]).toBe(1);
  });

  it("matches the PyneCore oracle bar for bar: (0, 1) on bar 0, (NaN, 1) in warm-up, the upper band with direction 1 until the close crosses it on bar 9", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(SUPERTREND_SAMPLE10.length);
    for (let i = 0; i < SUPERTREND_SAMPLE10.length; i++) {
      const [value, direction] = SUPERTREND_SAMPLE10[i]!;
      if (Number.isNaN(value)) {
        expect(result.bars[i]!["var:__obs_value"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_value"]).toBeCloseTo(value, 9);
      }
      expect(result.bars[i]!["var:__obs_direction"]).toBe(direction);
    }
  });
});
