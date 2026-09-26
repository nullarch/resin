// oracle/cases/e2e_kc.pine: TV 빌트인 "Keltner Channels" 인디케이터 E2E 재현(ROADMAP P2 "TV 빌트인
// 인디케이터 E2E" 여덟(마지막) 슬라이스, KC 단독). The bar-by-bar values are the oracle's, not the
// pine2py golden's: ta.kc's range is ema(ta.tr(false), length), so the basis is valued from bar 2 and
// upper/lower from bar 3 (the pine2py golden has all three from bar 3). Evidence: harness twin
// state/repros/kc-sample10.json (basis_t/upper_t/lower_t, the same length 3 / mult 2 / true on
// sample10); ref_v6_ta_math.txt ta.kc f_kc; pynecore lib/ta.py kc. finalVarState/plot 조합 축은 다른
// e2e_*.test.ts와 동일한 골든 비교를 쓴다(bar9는 golden과 오라클이 같은 값).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_kc";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_kc (TV built-in Keltner Channels, full script)", () => {
  it("matches the oracle: basis from bar 2, upper/lower from bar 3 (twin state/repros/kc-sample10.json)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // The range ema of ta.tr(false) skips bar 0's na, so it seeds one bar after the basis ema.
    const expected: [number, number, number][] = [
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [102, NaN, NaN],
      [102, 108, 96],
      [103, 109, 97],
      [104, 110, 98],
      [105, 111, 99],
      [105, 111, 99],
      [106, 112, 100],
      [107, 113, 101],
    ];
    expect(result.bars).toHaveLength(expected.length);
    const check = (got: number, want: number) => (Number.isNaN(want) ? expect(got).toBeNaN() : expect(got).toBeCloseTo(want, 9));
    for (let i = 0; i < expected.length; i++) {
      const [basis, upper, lower] = expected[i]!;
      check(result.bars[i]!["var:__obs_basis"]!, basis);
      check(result.bars[i]!["var:__obs_upper"]!, upper);
      check(result.bars[i]!["var:__obs_lower"]!, lower);
    }

    // bar3부터는 golden과 실제로 일치함을 명시적으로 재확인(이 짧은 샘플에 한정된 우연 -- 일반 보장 아님).
    for (let i = 3; i < expected.length; i++) {
      expect(result.bars[i]!["var:__obs_basis"]).toBeCloseTo(golden.bars[i]!["var:__obs_basis"] as number, 9);
      expect(result.bars[i]!["var:__obs_upper"]).toBeCloseTo(golden.bars[i]!["var:__obs_upper"] as number, 9);
      expect(result.bars[i]!["var:__obs_lower"]).toBeCloseTo(golden.bars[i]!["var:__obs_lower"] as number, 9);
    }
  });

  it("matches the pine2py golden final var state (both converge to the same value)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });

  it("emits exactly 3 plots in source order with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["Basis", "Upper", "Lower"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (basis/upper/lower wiring)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["Basis", "var:__obs_basis"],
      ["Upper", "var:__obs_upper"],
      ["Lower", "var:__obs_lower"],
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
