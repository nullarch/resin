// oracle/cases/ta_kc_kcw.pine: ta.kc(source,length,mult,useTrueRange)/ta.kcw(...) 검증
// (ROADMAP P2 "ta.* 44종" — kc/kcw). Two variants, both **intentionally diverging** from the
// golden in most channels (DIVERGENCES.md #9):
//
// - useTrueRange=true (length=3, mult=2.0): kc.py's own structure returns the *entire*
//   (nan,nan,nan) triple whenever range_src (atr's output) is NaN, even if basis_val (ema's
//   output) was already valid that bar - so ta.atr's documented off-by-one warmup delay
//   (DIVERGENCES.md #8) leaks into basis too, not just upper/lower/kcw. pine2js's rt.ta.atr
//   doesn't carry that off-by-one, so all four fields come one bar earlier than golden.
// - useTrueRange=false (length=4, mult=1.5): pine2py's kc.py reads `source.get(0)` for *both*
//   "high" and "low" (a latent bug, same class as wpr/atr), making range always exactly 0.
//   pine2js instead implements the TV Script Reference formula "range = high - low" - since that
//   never goes NaN for valid source data, basis_f alone stays golden-clean while
//   upper_f/lower_f/kcw_f diverge on the range formula itself.
//
// Only __obs_basis_f is safe to compare against golden; every other channel is hand-verified
// against exact IEEE754 values computed via a direct node port of the composition (see
// runtime/ta.ts kc()/kcw() comments and scratch/probe_kc.mjs).

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

describe("oracle: ta_kc_kcw", () => {
  it("useTrueRange=false basis matches the pine2py golden bar-by-bar (no atr dependency, no divergence)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_basis_f"]);
  });

  it("useTrueRange=true diverges one bar earlier than golden (atr's off-by-one leaks through kc's shared NaN gate, DIVERGENCES.md #9)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // golden: NaN at bar0-2, valid from bar3 (kc.py's shared gate masked by atr's #8 delay).
    const golden = loadGolden(CASE_NAME);
    expect(golden.bars[2]!["var:__obs_basis_t"]).toBe("NaN");
    expect(golden.bars[3]!["var:__obs_basis_t"]).toBe(102.0);

    // pine2js: valid from bar2 (ema(3)+atr(3) both warm in parallel, no off-by-one).
    const expected: [number, number, number, number][] = [
      [NaN, NaN, NaN, NaN],
      [NaN, NaN, NaN, NaN],
      [102, 108, 96, 11.76470588235294],
      [102, 108, 96, 11.76470588235294],
      [103, 109, 97, 11.650485436893204],
      [104, 110, 98, 11.538461538461538],
      [105, 111, 99, 11.428571428571429],
      [105, 111, 99, 11.428571428571429],
      [106, 112, 100, 11.320754716981133],
      [107, 113, 101, 11.214953271028037],
    ];
    for (let i = 0; i < expected.length; i++) {
      const [basis, upper, lower, kcw] = expected[i]!;
      if (Number.isNaN(basis)) {
        expect(result.bars[i]!["var:__obs_basis_t"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_upper_t"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_lower_t"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_kcw_t"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_basis_t"]).toBeCloseTo(basis, 9);
        expect(result.bars[i]!["var:__obs_upper_t"]).toBeCloseTo(upper, 9);
        expect(result.bars[i]!["var:__obs_lower_t"]).toBeCloseTo(lower, 9);
        expect(result.bars[i]!["var:__obs_kcw_t"]).toBeCloseTo(kcw, 9);
      }
    }
  });

  it("useTrueRange=false upper/lower/kcw use real TV semantics (range=high-low), diverging from pine2py's source-source=0 bug", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // pine2js: valid from bar3 (ema(4) warmup - range=high-low never goes NaN for valid source).
    const expected: [number, number, number, number][] = [
      [NaN, NaN, NaN, NaN],
      [NaN, NaN, NaN, NaN],
      [NaN, NaN, NaN, NaN],
      [102, 106.5, 97.5, 8.823529411764707],
      [102.8, 107.3, 98.3, 8.754863813229573],
      [103.67999999999999, 108.17999999999999, 99.17999999999999, 8.680555555555557],
      [104.608, 109.108, 100.108, 8.603548485775466],
      [104.76480000000001, 109.26480000000001, 100.26480000000001, 8.590671675982772],
      [105.65888000000001, 110.15888000000001, 101.15888000000001, 8.517977854771884],
      [106.59532800000001, 111.09532800000001, 102.09532800000001, 8.443146776564166],
    ];
    for (let i = 0; i < expected.length; i++) {
      const [basis, upper, lower, kcw] = expected[i]!;
      if (Number.isNaN(basis)) {
        expect(result.bars[i]!["var:__obs_basis_f"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_upper_f"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_lower_f"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_kcw_f"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_basis_f"]).toBeCloseTo(basis, 9);
        expect(result.bars[i]!["var:__obs_upper_f"]).toBeCloseTo(upper, 9);
        expect(result.bars[i]!["var:__obs_lower_f"]).toBeCloseTo(lower, 9);
        expect(result.bars[i]!["var:__obs_kcw_f"]).toBeCloseTo(kcw, 9);
      }
    }
  });
});
