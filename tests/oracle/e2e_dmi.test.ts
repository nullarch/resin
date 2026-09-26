// oracle/cases/e2e_dmi.pine: TV 빌트인 "Directional Movement Index" 인디케이터 E2E 재현(ROADMAP
// P2 "TV 빌트인 인디케이터 15종 E2E" 두 번째 슬라이스, 3종 중 3). ta.dmi 자체의 계산은 이미
// tests/oracle/ta_dmi.test.ts(순수 __obs 미러)가 개별 검증했다 -- 이 테스트가 새로 검증하는 것은
// indicator()/input.int/plot()을 ta.dmi(다중 반환 튜플)와 한 스크립트로 조합했을 때 (1) __obs
// 미러 채널이 여전히 오라클과 바별로 일치하는지, (2) plot() 3슬롯이 소스 순서(+DI/-DI/ADX)
// 대로 정확히 배정되는지, (3) plot 채널 값이 같은 바의 __obs 미러 값과 정확히 같은지(e2e_macd.
// test.ts/e2e_bb.test.ts와 동일한 세 축).
//
// The expected values are the PyneCore oracle's, not the pine2py golden's: pine2py seeded its
// smoothing on one raw value one bar after a diLength-bar gate, so its +DI/-DI started on bar 4.
// The built-in DMI script seeds every rma like ta.rma over bars 1..3 (ta.tr and the directional
// movements are na on bar 0), so +DI/-DI start on bar 3 and ADX on bar 4 (see
// tests/oracle/ta_dmi.test.ts; tier 1 resin-harness suites/indicators/tv/ta_121_dmi; harness twin
// state/repros/dmi-warmup.json, channels a.plus/a.minus/a.adx).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_dmi";

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

describe("oracle: e2e_dmi (TV built-in Directional Movement Index, full script)", () => {
  it("matches the PyneCore oracle bar-by-bar for the composed script", () => {
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

  it("matches the PyneCore oracle final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(DMI_3_2_SAMPLE10)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected[9]!, 9);
    }
  });

  it("emits exactly 3 plots in source order with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["+DI", "-DI", "ADX"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (+di/-di/adx wiring)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["+DI", "__obs_plus_di"],
      ["-DI", "__obs_minus_di"],
      ["ADX", "__obs_adx"],
    ];

    for (const [title, key] of channels) {
      const values = plotsByTitle.get(title)!;
      const expected = DMI_3_2_SAMPLE10[key]!;
      for (let i = 0; i < expected.length; i++) {
        expect(nearlyEqual(values[i]!, result.bars[i]![`var:${key}`]!), `bar ${i} ${title}`).toBe(true);
        expect(nearlyEqual(values[i]!, expected[i]!), `bar ${i} ${title}`).toBe(true);
      }
    }
  });
});
