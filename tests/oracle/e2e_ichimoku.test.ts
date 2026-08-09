// oracle/cases/e2e_ichimoku.pine: 실전 지표 재현(ROADMAP P3, TV 내장 Ichimoku Cloud 스크립트
// 이식). WaveTrend(C187)/Squeeze Momentum(C188)과 달리 이 스크립트는 ta.ema/ta.kc 같은 IIR
// 체인이나 na-비교 재비교 관용구를 전혀 쓰지 않고 순수 ta.highest/ta.lowest(monotonic deque, O(1))
// + math.avg(na-skip 평균)만 조합한다 -- 그래서 DIVERGENCES #84(precision 잔차 증폭)나 #85(Kleene
// na 비교)급 divergence가 애초에 발현할 조각이 없어, 5개 채널 전부 표준 compareToGolden으로 바별
// 정확 일치를 기대할 수 있다. TV 원본 스크립트의 `donchian(len) => math.avg(ta.lowest(len),
// ta.highest(len))` 1-인자 축약형(source 생략, 암묵 high/low)은 pine2js TA_REGISTRY.argCount 고정
// 제약(highest/lowest 2-인자 전용, LIMITATIONS.md)으로 미지원이라 명시 2-인자 형태로 재작성했다
// (동일 시맨틱, 오라클 비교에는 영향 없음). leadLine1(=math.avg(tenkanSen, kijunSen))의 bar1은
// kijunSen이 아직 na인데 math.avg가 na 인자를 건너뛰고 남은 유효값(tenkanSen)만으로 평균을 내는
// na-skip 시맨틱(math_avg.pine이 이미 확립)을 노출하는 첫 실전 지표 재현 사례 -- 아래 전용 테스트로
// 명시 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_ichimoku";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_ichimoku (TV built-in Ichimoku Cloud script, non-builtin composed indicator)", () => {
  it("matches the pine2py golden bar-by-bar for all 5 channels (pure highest/lowest+avg composition, no IIR/na-comparison divergence sources)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, [
      "var:__obs_tenkanSen",
      "var:__obs_kijunSen",
      "var:__obs_leadLine1",
      "var:__obs_leadLine2",
      "var:__obs_chikouSpan",
    ]);
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

  it("warms up in the expected order: tenkanSen(len=2) valid bar1, kijunSen(len=3) valid bar2, leadLine2(len=5) valid bar4, chikouSpan never na", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars[0]!["var:__obs_tenkanSen"]).toBeNaN();
    expect(result.bars[1]!["var:__obs_tenkanSen"]).not.toBeNaN();

    for (let i = 0; i < 2; i++) expect(result.bars[i]!["var:__obs_kijunSen"]).toBeNaN();
    expect(result.bars[2]!["var:__obs_kijunSen"]).not.toBeNaN();

    for (let i = 0; i < 4; i++) expect(result.bars[i]!["var:__obs_leadLine2"]).toBeNaN();
    expect(result.bars[4]!["var:__obs_leadLine2"]).not.toBeNaN();

    for (const bar of result.bars) expect(bar["var:__obs_chikouSpan"]).not.toBeNaN();
  });

  it("leadLine1 at bar1 exposes math.avg's na-skip semantics: kijunSen is still na, so leadLine1 equals tenkanSen alone (not na)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars[1]!["var:__obs_kijunSen"]).toBeNaN();
    expect(result.bars[1]!["var:__obs_tenkanSen"]).not.toBeNaN();
    expect(result.bars[1]!["var:__obs_leadLine1"]).toBeCloseTo(result.bars[1]!["var:__obs_tenkanSen"]!, 9);
    expect(result.bars[1]!["var:__obs_leadLine1"]).toBeCloseTo(101.0, 9);

    // bar0: both tenkanSen and kijunSen are na -- math.avg has zero valid args, so leadLine1 is na too.
    expect(result.bars[0]!["var:__obs_tenkanSen"]).toBeNaN();
    expect(result.bars[0]!["var:__obs_kijunSen"]).toBeNaN();
    expect(result.bars[0]!["var:__obs_leadLine1"]).toBeNaN();

    // bar2 onward: both valid, leadLine1 is the true average of the two (not a na-skip case).
    expect(result.bars[2]!["var:__obs_leadLine1"]).toBeCloseTo(
      (result.bars[2]!["var:__obs_tenkanSen"]! + result.bars[2]!["var:__obs_kijunSen"]!) / 2,
      9,
    );
  });

  it("tenkanSen/kijunSen/leadLine2 are computed by independent donchian() call sites (different length -> different warmup bar, not shared state)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // hand-verified against sample10.json: tenkanSen(len=2) bar1 = avg(lowest(low,2), highest(high,2))
    // over bars 0-1 = avg(min(99,100), max(102,103)) = avg(99,103) = 101.
    expect(result.bars[1]!["var:__obs_tenkanSen"]).toBeCloseTo(101.0, 9);
    // kijunSen(len=3) bar2 = avg(lowest(low,3), highest(high,3)) over bars 0-2 = avg(min(99,100,101),
    // max(102,103,104)) = avg(99,104) = 101.5.
    expect(result.bars[2]!["var:__obs_kijunSen"]).toBeCloseTo(101.5, 9);
    // leadLine2(len=5) bar4 = avg(lowest(low,5), highest(high,5)) over bars 0-4 = avg(min(99..102),
    // max(102..105)) = avg(99,105) = 102.0.
    expect(result.bars[4]!["var:__obs_leadLine2"]).toBeCloseTo(102.0, 9);
  });

  it("emits exactly 5 plots in source order with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual([
      "Conversion Line",
      "Base Line",
      "Lagging Span",
      "Leading Span A",
      "Leading Span B",
    ]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (offset= kwarg is a no-op, raw un-shifted values flow through)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["Conversion Line", "var:__obs_tenkanSen"],
      ["Base Line", "var:__obs_kijunSen"],
      ["Lagging Span", "var:__obs_chikouSpan"],
      ["Leading Span A", "var:__obs_leadLine1"],
      ["Leading Span B", "var:__obs_leadLine2"],
    ];

    for (const [title, obsKey] of channels) {
      const values = plotsByTitle.get(title)!;
      for (let i = 0; i < result.bars.length; i++) {
        const expected = decodeSentinel(result.bars[i]![obsKey]!);
        expect(nearlyEqual(values[i]!, expected)).toBe(true);
      }
    }
  });

  it("chikouSpan mirrors close exactly, bar-by-bar (no offset applied to the computed value, only to the plot's rendering position)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < data.close.length; i++) {
      expect(result.bars[i]!["var:__obs_chikouSpan"]).toBe(data.close[i]);
    }
  });

  it("tenkanSen/kijunSen/leadLine1 are non-decreasing-ish sane values within the high/low band of their respective windows (sanity bound, not just golden-copy)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 1; i < result.bars.length; i++) {
      const tenkan = result.bars[i]!["var:__obs_tenkanSen"]!;
      if (!Number.isNaN(tenkan)) {
        const lowWin = Math.min(data.low[i - 1]!, data.low[i]!);
        const highWin = Math.max(data.high[i - 1]!, data.high[i]!);
        expect(tenkan).toBeGreaterThanOrEqual(lowWin);
        expect(tenkan).toBeLessThanOrEqual(highWin);
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
