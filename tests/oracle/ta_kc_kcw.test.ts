// oracle/cases/ta_kc_kcw.pine: ta.kc(source,length,mult,useTrueRange)/ta.kcw(...) 검증
// (ROADMAP P2 "ta.* 44종" — kc/kcw). The expected values are the oracle's (PyneCore on the same
// sample10 bars: harness twin state/repros/kc-sample10.json, channels *_t and *_f), not the pine2py
// golden's: basis = ema(source, length), range = ema(ta.tr(false) or high - low, length), kcw =
// (upper - lower) / basis (ref_v6_ta_math.txt ta.kc/ta.kcw "the same on pine"; pynecore lib/ta.py
// kc/kcw). With useTrueRange the range ema skips bar 0's na true range, so upper/lower/kcw start
// one bar after the basis. Only __obs_basis_f is compared against the pine2py golden.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_kc_kcw";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

function assertKc(bars: Record<string, number>[], suffix: string, expected: [number, number, number, number][]): void {
  for (let i = 0; i < expected.length; i++) {
    const want = expected[i]!;
    const fields = ["basis", "upper", "lower", "kcw"];
    for (let f = 0; f < fields.length; f++) {
      const got = bars[i]![`var:__obs_${fields[f]}_${suffix}`]!;
      if (Number.isNaN(want[f]!)) expect(got).toBeNaN();
      else expect(got).toBeCloseTo(want[f]!, 9);
    }
  }
}

describe("oracle: ta_kc_kcw", () => {
  it("useTrueRange=false basis matches the pine2py golden bar-by-bar (no atr dependency, no divergence)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_basis_f"]);
  });

  it("useTrueRange=true matches the oracle: basis from bar 2, upper/lower/kcw from bar 3 (twin kc-sample10 *_t)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    const expected: [number, number, number, number][] = [
      [NaN, NaN, NaN, NaN],
      [NaN, NaN, NaN, NaN],
      [102, NaN, NaN, NaN],
      [102, 108, 96, 0.11764705882352941],
      [103, 109, 97, 0.11650485436893204],
      [104, 110, 98, 0.11538461538461539],
      [105, 111, 99, 0.11428571428571428],
      [105, 111, 99, 0.11428571428571428],
      [106, 112, 100, 0.11320754716981132],
      [107, 113, 101, 0.11214953271028037],
    ];
    assertKc(result.bars, "t", expected);
  });

  it("useTrueRange=false matches the oracle: range = ema(high - low, length), kcw a ratio (twin kc-sample10 *_f)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    const expected: [number, number, number, number][] = [
      [NaN, NaN, NaN, NaN],
      [NaN, NaN, NaN, NaN],
      [NaN, NaN, NaN, NaN],
      [102, 106.5, 97.5, 0.08823529411764706],
      [102.8, 107.3, 98.3, 0.08754863813229573],
      [103.68, 108.18, 99.18, 0.08680555555555557],
      [104.608, 109.108, 100.108, 0.08603548485775467],
      [104.7648, 109.2648, 100.2648, 0.08590671675982774],
      [105.65888, 110.15888, 101.15888, 0.08517977854771885],
      [106.595328, 111.095328, 102.095328, 0.08443146776564167],
    ];
    assertKc(result.bars, "f", expected);
  });
});
