// oracle/cases/e2e_kcw.pine: TV 빌트인 "Keltner Channels Width" 인디케이터 E2E 재현(ROADMAP P2
// "TV 빌트인 인디케이터 E2E" 여덟(마지막) 슬라이스, KCW 단독). The values are the oracle's, not the
// pine2py golden's: ta.kcw is (upper - lower) / basis, a ratio (the golden multiplies by 100), valued
// from bar 3 where kc's range ema of ta.tr(false) seeds. Evidence: harness twin
// state/repros/kc-sample10.json (kcw_t, the same length 3 / mult 2 / true on sample10);
// ref_v6_ta_math.txt ta.kcw f_kcw; pynecore lib/ta.py kcw.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_kcw";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_kcw (TV built-in Keltner Channels Width, full script)", () => {
  it("matches the oracle: a ratio, valued from bar 3 (twin state/repros/kc-sample10.json, kcw_t)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    const expected: number[] = [
      NaN,
      NaN,
      NaN,
      0.11764705882352941,
      0.11650485436893204,
      0.11538461538461539,
      0.11428571428571428,
      0.11428571428571428,
      0.11320754716981132,
      0.11214953271028037,
    ];
    expect(result.bars).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const v = expected[i]!;
      if (Number.isNaN(v)) {
        expect(result.bars[i]!["var:__obs_kcw"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_kcw"]).toBeCloseTo(v, 12);
      }
    }

    // The pine2py golden is the same series in percent (x100), its na bars the oracle's.
    for (let i = 0; i < expected.length; i++) {
      const g = golden.bars[i]!["var:__obs_kcw"];
      if (g === "NaN") expect(expected[i]).toBeNaN();
      else expect(expected[i]! * 100).toBeCloseTo(g as number, 8);
    }
  });

  it("final var state is the oracle's last kcw (the pine2py golden's 11.214953271 percent / 100)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_kcw"]).toBeCloseTo(0.11214953271028037, 12);
  });

  it("emits exactly 1 plot titled 'KCW'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["KCW"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_kcw mirror values bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < result.bars.length; i++) {
      const expected = decodeSentinel(result.bars[i]!["var:__obs_kcw"]!);
      expect(nearlyEqual(values[i]!, expected)).toBe(true);
    }
  });
});
