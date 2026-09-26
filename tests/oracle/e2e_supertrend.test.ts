// oracle/cases/e2e_supertrend.pine: the TradingView built-in "Supertrend" indicator end to end
// (factor=2.0, atrPeriod=3, sample10.json). The pine2py golden is NOT ground truth for the line or the
// direction (see tests/oracle/ta_supertrend.test.ts): TradingView's tier 1 export of the built-in
// Supertrend Strategy (resin-harness suites/strategy/tv/supertrend, 601/601 trades) and the PyneCore
// oracle (lib/ta.py supertrend) give direction 1 in a downtrend, -1 in an uptrend, (0, 1) on the first
// bar and (NaN, 1) in warm-up. The bar-by-bar and final-state expectations below are the oracle's
// values (harness repro state/repros/supertrend-direction.json covers the same rule); the plot tests
// only check wiring.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_supertrend";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore oracle, sample10.json, ta.supertrend(2.0, 3).
const ORACLE: [number, number][] = [
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

describe("oracle: e2e_supertrend (TV built-in Supertrend, full script)", () => {
  it("matches the PyneCore oracle bar for bar (direction 1 on the upper band, -1 once the close crosses it)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(ORACLE.length);
    for (let i = 0; i < ORACLE.length; i++) {
      const [value, direction] = ORACLE[i]!;
      if (Number.isNaN(value)) {
        expect(result.bars[i]!["var:__obs_value"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_value"]).toBeCloseTo(value, 9);
      }
      expect(result.bars[i]!["var:__obs_direction"]).toBe(direction);
    }
  });

  it("ends on the oracle's final state (101.5, -1)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_value"]).toBeCloseTo(101.5, 9);
    expect(result.finalVarState["__obs_direction"]).toBe(-1);
  });

  it("emits exactly 2 plots in source order with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["SuperTrend", "Direction"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (value/direction wiring)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["SuperTrend", "var:__obs_value"],
      ["Direction", "var:__obs_direction"],
    ];

    for (const [title, obsKey] of channels) {
      const values = plotsByTitle.get(title)!;
      for (let i = 0; i < result.bars.length; i++) {
        const expected = decodeSentinel(result.bars[i]![obsKey]!);
        expect(nearlyEqual(values[i]!, expected)).toBe(true);
      }
    }
  });
});
