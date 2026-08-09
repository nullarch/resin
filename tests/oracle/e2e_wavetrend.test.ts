// oracle/cases/e2e_wavetrend.pine: 실전 지표 재현(ROADMAP P3, LazyBear WaveTrend Oscillator [WT]).
// Supertrend/KC/MACD류(e2e_supertrend/e2e_kc/e2e_macd.test.ts)가 검증해온 "TV 빌트인 하나 + plot
// 결선" 조합과 달리, WaveTrend는 pine2py/pine2js 어느 쪽에도 전용 빌트인이 없는 순수 커뮤니티
// 인디케이터라 개별 ta.ema/math.abs/ta.sma/ta.crossover/ta.crossunder 조각들을 사용자 스크립트가
// 직접 조합한 것 그대로 파이프라인을 통과하는지가 검증 대상이다. 특히 esa->d->ci->wt1->wt2로 이어지는
// 3단계 순차 워밍업 캐스케이드(각 단계가 이전 단계의 유효값을 전제로 함)가 개별 빌트인 테스트에는
// 없던 새 축이다. ta.ema/math.abs/ta.sma 자체엔 알려진 pine2py-vs-pine2js 워밍업 divergence가 없어
// (atr 기반 supertrend/kc와 달리) compareToGolden으로 바별 정확 일치를 기대할 수 있다 -- 단
// ci=(ap-esa)/(0.015*d) 채널만 예외(DIVERGENCES.md #84): pine2py의 ta.ema는 매 상태 갱신마다
// precision(10자리 반올림)을 적용하는데(pine2js는 이식 안 함, 기존 결정) 그 극소 잔차가 여기서
// 작은 분모로 나뉘며 증폭돼 bar7 한 지점에서 표준 오차범위(1e-9)를 근소하게 벗어난다 -- ci는
// onlyKeys에서 제외하고 별도 hand-verified 블록으로 그 한 지점만 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_wavetrend";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_wavetrend (LazyBear WaveTrend Oscillator, non-builtin composed script)", () => {
  it("matches the pine2py golden bar-by-bar for the composed esa/d/wt1/wt2/diff/co/cu channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    // __obs_ci is excluded here and verified separately below (DIVERGENCES.md #84: pine2py's
    // ta.ema applies a per-update precision(10-decimal) rounding that pine2js doesn't literal-port;
    // the resulting sub-1e-9 residual gets amplified ~145x by ci's small-denominator division and
    // exceeds the standard oracle tolerance at exactly one bar).
    compareToGolden(result.bars, golden, [
      "var:__obs_esa",
      "var:__obs_d",
      "var:__obs_wt1",
      "var:__obs_wt2",
      "var:__obs_diff",
      "var:__obs_co",
      "var:__obs_cu",
    ]);
  });

  it("__obs_ci matches golden at every bar except the documented bar7 precision-amplification gap (DIVERGENCES.md #84)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < result.bars.length; i++) {
      const actual = result.bars[i]!["var:__obs_ci"]!;
      const expected = decodeSentinel(golden.bars[i]!["var:__obs_ci"]!);
      if (i === 7) {
        // pine2js computes an exact 0 here; pine2py's golden carries a ~4.8e-9 rounding residue.
        // Both are "effectively zero" relative to ci's normal magnitude (tens to hundreds) --
        // assert the gap stays confined to this documented sub-1e-8 residue, not a real logic bug.
        expect(actual).toBe(0);
        expect(expected).toBeCloseTo(0, 8);
        expect(Math.abs(actual - expected)).toBeLessThan(1e-8);
      } else {
        expect(nearlyEqual(actual, expected)).toBe(true);
      }
    }
  });

  it("matches the pine2py golden final var state", () => {
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

    expect(result.plots.map((p) => p.title)).toEqual(["WT1", "WT2", "WT Hist"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (wt1/wt2/diff wiring)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["WT1", "var:__obs_wt1"],
      ["WT2", "var:__obs_wt2"],
      ["WT Hist", "var:__obs_diff"],
    ];

    for (const [title, obsKey] of channels) {
      const values = plotsByTitle.get(title)!;
      for (let i = 0; i < result.bars.length; i++) {
        const expected = decodeSentinel(result.bars[i]![obsKey]!);
        expect(nearlyEqual(values[i]!, expected)).toBe(true);
      }
    }
  });

  it("warms up in the expected 3-stage cascade: esa(bar2) -> d/ci(bar4) -> wt1(bar5) -> wt2/diff(bar8)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < 2; i++) expect(result.bars[i]!["var:__obs_esa"]).toBeNaN();
    expect(result.bars[2]!["var:__obs_esa"]).not.toBeNaN();

    for (let i = 0; i < 4; i++) {
      expect(result.bars[i]!["var:__obs_d"]).toBeNaN();
      expect(result.bars[i]!["var:__obs_ci"]).toBeNaN();
    }
    expect(result.bars[4]!["var:__obs_d"]).not.toBeNaN();
    expect(result.bars[4]!["var:__obs_ci"]).not.toBeNaN();

    for (let i = 0; i < 5; i++) expect(result.bars[i]!["var:__obs_wt1"]).toBeNaN();
    expect(result.bars[5]!["var:__obs_wt1"]).not.toBeNaN();

    for (let i = 0; i < 8; i++) {
      expect(result.bars[i]!["var:__obs_wt2"]).toBeNaN();
      expect(result.bars[i]!["var:__obs_diff"]).toBeNaN();
    }
    expect(result.bars[8]!["var:__obs_wt2"]).not.toBeNaN();
    expect(result.bars[8]!["var:__obs_diff"]).not.toBeNaN();
  });

  it("__obs_diff always equals wt1 - wt2 exactly wherever both are defined (composed-expression self-consistency)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      const wt1 = bar["var:__obs_wt1"]!;
      const wt2 = bar["var:__obs_wt2"]!;
      const diff = bar["var:__obs_diff"]!;
      if (!Number.isNaN(wt1) && !Number.isNaN(wt2)) {
        expect(diff).toBeCloseTo(wt1 - wt2, 9);
      } else {
        expect(diff).toBeNaN();
      }
    }
  });

  it("__obs_co/__obs_cu bool-mirror channels are always exactly 0.0 or 1.0, never na or another value", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect([0, 1]).toContain(bar["var:__obs_co"]);
      expect([0, 1]).toContain(bar["var:__obs_cu"]);
    }
  });

  it("no crossover/crossunder fires in this short monotonically-rising 10-bar window (both channels stay 0.0)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_co"]).toBe(0);
      expect(bar["var:__obs_cu"]).toBe(0);
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
