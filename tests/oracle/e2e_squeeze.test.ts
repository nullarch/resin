// oracle/cases/e2e_squeeze.pine: 실전 지표 재현(ROADMAP P3, LazyBear Squeeze Momentum Indicator
// [SQZMOM_LB]). WaveTrend(C187)와 달리 이 스크립트는 이미 개별 검증된 다중 반환 빌트인(ta.bb/
// ta.kc)을 재사용해 sqzOn/sqzOff/noSqz를 조합하고, 그 위에 별개로 ta.highest/ta.lowest/ta.sma/
// math.avg/ta.linreg를 조합한 val(모멘텀 히스토그램)을 계산한다. val/basisBB/upperBB/lowerBB는
// bb에 alt atr 워밍업 divergence가 없어 표준 compareToGolden으로 바별 정확 일치를 기대할 수 있다.
// The KC channels and the squeeze flags are checked against the oracle (PyneCore on sample10):
// ta.kc's basis is valued from bar 2, its upper/lower from bar 3 (range = ema(ta.tr(false), 3); harness
// twin state/repros/kc-sample10.json basis_sqz/upper_sqz/lower_sqz), and sqzOn/sqzOff follow the
// oracle on every bar (twin state/repros/squeeze-na-compare.json). Open: on bars 0-2 the oracle's
// noSqz is 1 (a v5 comparison with an na operand is false, so `sqzOn == false` holds) where resin
// reports 0; that is the na-comparison rule, not ta.kc, and is not asserted here.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_squeeze";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_squeeze (LazyBear Squeeze Momentum Oscillator, non-builtin composed script)", () => {
  it("matches the pine2py golden bar-by-bar for val/basisBB/upperBB/lowerBB (independent of the KC one-bar shift)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    // basisKC/upperKC/lowerKC/sqzOn/sqzOff/noSqz excluded here (DIVERGENCES.md #9/#85 -- ta.kc's
    // atr-seeded warmup shift bleeds into the squeeze booleans) and verified separately below.
    compareToGolden(result.bars, golden, [
      "var:__obs_val",
      "var:__obs_basisBB",
      "var:__obs_upperBB",
      "var:__obs_lowerBB",
    ]);
  });

  it("__obs_val stays within the standard 1e-9 tolerance at bar7 (no ci-style precision amplification here, unlike WaveTrend/DIVERGENCES #84)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    const expected = decodeSentinel(golden.bars[7]!["var:__obs_val"]!);
    const actual = result.bars[7]!["var:__obs_val"]!;
    expect(expected).toBe(0);
    // pine2js's linreg-of-a-difference composition leaves a tiny float residue near zero here too,
    // but unlike ci's small-denominator division (DIVERGENCES #84) it stays many orders of magnitude
    // under the 1e-9 oracle tolerance -- documented explicitly so a future regression stands out.
    expect(Math.abs(actual)).toBeLessThan(1e-10);
    expect(nearlyEqual(actual, expected)).toBe(true);
  });

  it("basisKC/upperKC/lowerKC match the oracle: basis from bar 2, upper/lower from bar 3 (twin kc-sample10 *_sqz)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    const expected: [number, number, number][] = [
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [102, NaN, NaN],
      [102, 106.5, 97.5],
      [103, 107.5, 98.5],
      [104, 108.5, 99.5],
      [105, 109.5, 100.5],
      [105, 109.5, 100.5],
      [106, 110.5, 101.5],
      [107, 111.5, 102.5],
    ];
    expect(result.bars).toHaveLength(expected.length);
    const check = (got: number, want: number) => (Number.isNaN(want) ? expect(got).toBeNaN() : expect(got).toBeCloseTo(want, 9));
    for (let i = 0; i < expected.length; i++) {
      const [basis, upper, lower] = expected[i]!;
      check(result.bars[i]!["var:__obs_basisKC"]!, basis);
      check(result.bars[i]!["var:__obs_upperKC"]!, upper);
      check(result.bars[i]!["var:__obs_lowerKC"]!, lower);
    }

    // bar3부터는 golden과 실제로 일치함을 재확인(이 짧은 샘플에 한정된 우연 -- 일반 보장 아님).
    for (let i = 3; i < expected.length; i++) {
      expect(result.bars[i]!["var:__obs_basisKC"]).toBeCloseTo(golden.bars[i]!["var:__obs_basisKC"] as number, 9);
      expect(result.bars[i]!["var:__obs_upperKC"]).toBeCloseTo(golden.bars[i]!["var:__obs_upperKC"] as number, 9);
      expect(result.bars[i]!["var:__obs_lowerKC"]).toBeCloseTo(golden.bars[i]!["var:__obs_lowerKC"] as number, 9);
    }
  });

  it("sqzOn/sqzOff match the oracle on every bar, noSqz from bar 3 (twin state/repros/squeeze-na-compare.json)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // The oracle's flags (the pine2py golden has the same): KC's upper/lower are na through bar 2,
    // so sqzOn is 1 from bar 3. noSqz on bars 0-2 is the open na-comparison rule (header comment).
    const sqzOn = [0, 0, 0, 1, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < sqzOn.length; i++) {
      expect(result.bars[i]!["var:__obs_sqzOn"]).toBe(sqzOn[i]);
      expect(result.bars[i]!["var:__obs_sqzOff"]).toBe(0);
      expect(golden.bars[i]!["var:__obs_sqzOn"]).toBe(sqzOn[i]);
      expect(golden.bars[i]!["var:__obs_sqzOff"]).toBe(0);
      if (i >= 3) expect(result.bars[i]!["var:__obs_noSqz"]).toBe(0);
    }
  });

  it("matches the pine2py golden final var state (all channels have converged by the last bar)", () => {
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

    expect(result.plots.map((p) => p.title)).toEqual(["Val", "BB Basis", "KC Basis"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (val/basisBB/basisKC wiring)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["Val", "var:__obs_val"],
      ["BB Basis", "var:__obs_basisBB"],
      ["KC Basis", "var:__obs_basisKC"],
    ];

    for (const [title, obsKey] of channels) {
      const values = plotsByTitle.get(title)!;
      for (let i = 0; i < result.bars.length; i++) {
        const expected = decodeSentinel(result.bars[i]![obsKey]!);
        expect(nearlyEqual(values[i]!, expected)).toBe(true);
      }
    }
  });

  it("warms up in the expected order: BB valid bar2, KC valid bar2(pine2js), val valid bar4", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < 2; i++) expect(result.bars[i]!["var:__obs_basisBB"]).toBeNaN();
    expect(result.bars[2]!["var:__obs_basisBB"]).not.toBeNaN();

    for (let i = 0; i < 2; i++) expect(result.bars[i]!["var:__obs_basisKC"]).toBeNaN();
    expect(result.bars[2]!["var:__obs_basisKC"]).not.toBeNaN();

    for (let i = 0; i < 4; i++) expect(result.bars[i]!["var:__obs_val"]).toBeNaN();
    expect(result.bars[4]!["var:__obs_val"]).not.toBeNaN();
  });

  it("sqzOn/sqzOff/noSqz are 0-or-1 valued, at most one is 1.0, exactly one once KC's range is valued (bar 3)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < result.bars.length; i++) {
      const bar = result.bars[i]!;
      const flags = [bar["var:__obs_sqzOn"]!, bar["var:__obs_sqzOff"]!, bar["var:__obs_noSqz"]!];
      for (const f of flags) expect([0, 1]).toContain(f);
      const sum = flags.reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(1);
      if (i >= 3) expect(sum).toBe(1);
    }
  });

  it("is deterministic across repeated runs of the same composed pipeline", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const first = runPipeline(source, data);
    const second = runPipeline(source, data);

    expect(second.bars).toEqual(first.bars);
    expect(second.finalVarState).toEqual(first.finalVarState);
  });
});
