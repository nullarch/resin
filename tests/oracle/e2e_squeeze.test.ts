// oracle/cases/e2e_squeeze.pine: 실전 지표 재현(ROADMAP P3, LazyBear Squeeze Momentum Indicator
// [SQZMOM_LB]). WaveTrend(C187)와 달리 이 스크립트는 이미 개별 검증된 다중 반환 빌트인(ta.bb/
// ta.kc)을 재사용해 sqzOn/sqzOff/noSqz를 조합하고, 그 위에 별개로 ta.highest/ta.lowest/ta.sma/
// math.avg/ta.linreg를 조합한 val(모멘텀 히스토그램)을 계산한다. val/basisBB/upperBB/lowerBB는
// bb에 alt atr 워밍업 divergence가 없어 표준 compareToGolden으로 바별 정확 일치를 기대할 수 있다.
// 단 ta.kc(useTrueRange=true)는 DIVERGENCES.md #9(ta.atr 워밍업이 basis까지 전파돼 pine2js가
// golden보다 한 바 먼저 유효값을 냄, e2e_kc.test.ts가 이미 문서화)를 그대로 물려받으므로
// basisKC/upperKC/lowerKC와 그로부터 파생되는 sqzOn/sqzOff/noSqz는 hand-verified로 분리 검증한다.

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

  it("basisKC/upperKC/lowerKC diverge from golden by the documented one-bar ATR-seeded warmup shift (hand-verified, DIVERGENCES #9)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden: NaN through bar2, valid from bar3.
    for (let i = 0; i < 3; i++) {
      expect(golden.bars[i]!["var:__obs_basisKC"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_upperKC"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_lowerKC"]).toBe("NaN");
    }
    expect(golden.bars[3]!["var:__obs_basisKC"]).toBe(102.0);

    // pine2js: valid one bar earlier (bar2), same shape as e2e_kc.test.ts.
    const expected: [number, number, number][] = [
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [102, 106.5, 97.5],
      [102, 106.5, 97.5],
      [103, 107.5, 98.5],
      [104, 108.5, 99.5],
      [105, 109.5, 100.5],
      [105, 109.5, 100.5],
      [106, 110.5, 101.5],
      [107, 111.5, 102.5],
    ];
    expect(result.bars).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const [basis, upper, lower] = expected[i]!;
      if (Number.isNaN(basis)) {
        expect(result.bars[i]!["var:__obs_basisKC"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_upperKC"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_lowerKC"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_basisKC"]).toBeCloseTo(basis, 9);
        expect(result.bars[i]!["var:__obs_upperKC"]).toBeCloseTo(upper, 9);
        expect(result.bars[i]!["var:__obs_lowerKC"]).toBeCloseTo(lower, 9);
      }
    }

    // bar3부터는 golden과 실제로 일치함을 재확인(이 짧은 샘플에 한정된 우연 -- 일반 보장 아님).
    for (let i = 3; i < expected.length; i++) {
      expect(result.bars[i]!["var:__obs_basisKC"]).toBeCloseTo(golden.bars[i]!["var:__obs_basisKC"] as number, 9);
      expect(result.bars[i]!["var:__obs_upperKC"]).toBeCloseTo(golden.bars[i]!["var:__obs_upperKC"] as number, 9);
      expect(result.bars[i]!["var:__obs_lowerKC"]).toBeCloseTo(golden.bars[i]!["var:__obs_lowerKC"] as number, 9);
    }
  });

  it("sqzOn/sqzOff/noSqz diverge from golden at bars 0-2 (na-comparison-semantics gap composes with the KC warmup shift, DIVERGENCES #85)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden (pine2py native Python `and`/comparisons: nan-comparisons fall through to concrete
    // False, so noSqz=(False==False) and (False==False)=True while both bb/kc are still na):
    // bars 0-2 forced noSqz=1, sqzOn from bar3 (when kc's own warmup finishes, see next test).
    const goldenExpected = [
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
    for (let i = 0; i < goldenExpected.length; i++) {
      const [sqzOn, sqzOff, noSqz] = goldenExpected[i]!;
      expect(golden.bars[i]!["var:__obs_sqzOn"]).toBe(sqzOn);
      expect(golden.bars[i]!["var:__obs_sqzOff"]).toBe(sqzOff);
      expect(golden.bars[i]!["var:__obs_noSqz"]).toBe(noSqz);
    }

    // pine2js (VERIFIED_SEMANTICS.md OPEN "비교/and-or na 시맨틱" hypothesis, C67/pineAnd): pineGt/
    // pineLt propagate na for na operands (sqzOn/sqzOff become genuine na, not concrete false), and
    // `sqzOn == false` is a plain `===` (genEquality only special-cases a literal `na` operand, not
    // `true`/`false`) -- so na !== false, and noSqz's pineAnd short-circuits to concrete false via
    // its first false-ish operand. Net effect: at bars 0-1 (both bb/kc still na) all three flags read
    // 0/0/0 -- a genuine "unknown" state that golden's Python-native nan-is-falsy comparisons cannot
    // represent (it collapses straight to noSqz=1). At bar2, kc is already valid for pine2js (#9's
    // one-bar-earlier warmup) so sqzOn flips to 1 while golden (kc still na) stays at noSqz=1.
    const resultExpected = [
      [0, 0, 0],
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ];
    for (let i = 0; i < resultExpected.length; i++) {
      const [sqzOn, sqzOff, noSqz] = resultExpected[i]!;
      expect(result.bars[i]!["var:__obs_sqzOn"]).toBe(sqzOn);
      expect(result.bars[i]!["var:__obs_sqzOff"]).toBe(sqzOff);
      expect(result.bars[i]!["var:__obs_noSqz"]).toBe(noSqz);
    }

    // explicit divergence marker: bars 0-2 disagree, 3-9 agree exactly.
    for (const i of [0, 1, 2]) {
      expect(goldenExpected[i]).not.toEqual(resultExpected[i]);
    }
    for (const i of [3, 4, 5, 6, 7, 8, 9]) {
      expect(goldenExpected[i]).toEqual(resultExpected[i]);
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

  it("sqzOn/sqzOff/noSqz are 0-or-1 valued, and at most one is 1.0 (bars 0-1 are all-zero: a genuine na state golden cannot represent, see divergence test above)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < result.bars.length; i++) {
      const bar = result.bars[i]!;
      const flags = [bar["var:__obs_sqzOn"]!, bar["var:__obs_sqzOff"]!, bar["var:__obs_noSqz"]!];
      for (const f of flags) expect([0, 1]).toContain(f);
      const sum = flags.reduce((a, b) => a + b, 0);
      if (i < 2) {
        expect(sum).toBe(0);
      } else {
        expect(sum).toBe(1);
      }
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
