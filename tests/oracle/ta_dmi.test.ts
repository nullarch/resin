// oracle/cases/ta_dmi.pine: ta.dmi(3, 2) 검증(ROADMAP P2 "ta.* 44종"). sample10.json 10바 전 구간
// 관측 — diLength=3/adxSmoothing=2라 10바 안에서 워밍업(na), DI-only, DI+ADX 세 구간을 전부 커버.
//
// The expected values are the PyneCore oracle's, not the pine2py golden's: pine2py gated the first
// diLength bars and then seeded its smoothing on one raw value, so its +DI/-DI started on bar 4.
// TradingView's built-in DMI script (runtime/ta.ts dmi()) enters every rma on every bar and seeds
// it like ta.rma; ta.tr and the directional movements are na on bar 0, so the rmas seed over bars
// 1..3 and +DI/-DI start on bar 3, ADX on bar 4. Tier 1 agrees (resin-harness suites/indicators/tv/
// ta_121_dmi: dmi(17, 14) first valued on bar 17), and so does the PyneCore oracle on the harness
// twin of this case (state/repros/dmi-warmup.json, channels a.plus/a.minus/a.adx), whose values are
// asserted below.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_dmi";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json, ta.dmi(3, 2).
const DMI_3_2_SAMPLE10: Readonly<Record<string, readonly number[]>> = {
  __obs_plus_di: [
    NaN, NaN, NaN, 22.222222222222218, 37.03703703703703, 35.80246913580246, 34.97942386831276, 23.319615912208505,
    37.76863283036123, 36.29019966468526,
  ],
  __obs_minus_di: [
    NaN, NaN, NaN, 11.111111111111109, 7.407407407407407, 4.938271604938271, 3.2921810699588474, 13.305898491083676,
    8.870598994055785, 5.913732662703857,
  ],
  __obs_adx: [
    NaN, NaN, NaN, NaN, 50, 62.87878787878787, 72.83724340175952, 50.089033685898485, 56.024908999811984,
    64.00017569889481,
  ],
};

describe("oracle: ta_dmi", () => {
  it("the pine2py golden (not ground truth) starts +DI on bar 4, one bar after the rmas are seeded", () => {
    const golden = loadGolden(CASE_NAME);
    expect(decodeSentinel(golden.bars[3]!["var:__obs_plus_di"]!)).toBeNaN();
    expect(decodeSentinel(golden.bars[4]!["var:__obs_plus_di"]!)).toBeCloseTo(22.2222222222, 9);
    expect(DMI_3_2_SAMPLE10.__obs_plus_di![3]).toBeCloseTo(22.2222222222, 9);
  });

  it("matches the PyneCore oracle bar-by-bar for ta.dmi", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(DMI_3_2_SAMPLE10)) {
      expect(result.bars).toHaveLength(expected.length);
      for (let i = 0; i < expected.length; i++) {
        const actual = result.bars[i]![`var:${key}`]!;
        expect(nearlyEqual(actual, expected[i]!), `bar ${i} ${key}: actual=${actual} oracle=${expected[i]}`).toBe(true);
      }
    }
  });

  it("matches the PyneCore oracle's final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(DMI_3_2_SAMPLE10)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected[9]!, 9);
    }
  });
});
