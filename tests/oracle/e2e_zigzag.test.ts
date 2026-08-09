// oracle/cases/e2e_zigzag.pine: 실전 지표 재현(ROADMAP P3, TV 커뮤니티 ZigZag 인디케이터 재현).
// Supertrend/WaveTrend/Squeeze Momentum/Ichimoku(C186~C189)는 전부 그 바 하나만 보고 계산되는
// 순수 함수형 조합이라 오라클이 항상 안전했던 것과 달리, 이 스크립트는 처음으로 "상태 누적형"이다
// -- 이미 개별 검증된 ta.pivothigh/ta.pivotlow(ta_pivot.pine/ta_pivot.test.ts)의 확정 신호를 var
// (zzPrice/zzBar/zzDir/pivotCount)로 누적해 "마지막 확정 피벗 대비 deviation% 이상 반대 방향으로
// 움직여야 새 피벗을 확정한다"는 ZigZag 고유 상태 전이를 얹는다. sample10.json의 high/low 채널은
// close 채널(ta_pivot.pine이 이미 검증)과 동일한 지그재그 형태라 바3/바7에서 고점, 바4/바8에서
// 저점이 확정되고, deviation=0.5%는 이 4개 전부를 통과시켜 완전한 고점→저점→고점→저점 교대를
// bar-by-bar로 검증한다. 표준 compareToGolden으로 전 채널 정확 일치(divergence 없음 -- 이 조합은
// IIR/precision 잔차나 na-비교 재비교 관용구를 전혀 안 씀).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_zigzag";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_zigzag (community ZigZag indicator, stateful pivot-accumulation pattern)", () => {
  it("matches the pine2py golden bar-by-bar for all 4 channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, [
      "var:__obs_zzPrice",
      "var:__obs_zzBar",
      "var:__obs_zzDir",
      "var:__obs_pivotCount",
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

  it("stays at the zero-state (no pivot yet) through bars 0-2, matching the ta.pivothigh/pivotlow warmup window (left+right+1=3)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < 3; i++) {
      expect(result.bars[i]!["var:__obs_zzDir"]).toBe(0);
      expect(result.bars[i]!["var:__obs_zzPrice"]).toBe(0.0);
      expect(result.bars[i]!["var:__obs_pivotCount"]).toBe(0);
    }
  });

  it("confirms the expected alternating high/low/high/low pivot sequence at bars 3, 4, 7, 8", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // bar3: pivot high confirmed (candidate = bar2's high = 104), zzDir flips to 1.
    expect(result.bars[3]!["var:__obs_zzPrice"]).toBeCloseTo(104.0, 9);
    expect(result.bars[3]!["var:__obs_zzBar"]).toBe(2);
    expect(result.bars[3]!["var:__obs_zzDir"]).toBe(1);
    expect(result.bars[3]!["var:__obs_pivotCount"]).toBe(1);

    // bar4: pivot low confirmed (candidate = bar3's low = 100), zzDir flips to -1.
    expect(result.bars[4]!["var:__obs_zzPrice"]).toBeCloseTo(100.0, 9);
    expect(result.bars[4]!["var:__obs_zzBar"]).toBe(3);
    expect(result.bars[4]!["var:__obs_zzDir"]).toBe(-1);
    expect(result.bars[4]!["var:__obs_pivotCount"]).toBe(2);

    // bar7: pivot high confirmed (candidate = bar6's high = 107), zzDir flips back to 1.
    expect(result.bars[7]!["var:__obs_zzPrice"]).toBeCloseTo(107.0, 9);
    expect(result.bars[7]!["var:__obs_zzBar"]).toBe(6);
    expect(result.bars[7]!["var:__obs_zzDir"]).toBe(1);
    expect(result.bars[7]!["var:__obs_pivotCount"]).toBe(3);

    // bar8: pivot low confirmed (candidate = bar7's low = 103), zzDir flips to -1.
    expect(result.bars[8]!["var:__obs_zzPrice"]).toBeCloseTo(103.0, 9);
    expect(result.bars[8]!["var:__obs_zzBar"]).toBe(7);
    expect(result.bars[8]!["var:__obs_zzDir"]).toBe(-1);
    expect(result.bars[8]!["var:__obs_pivotCount"]).toBe(4);
  });

  it("holds the last confirmed pivot state on bars with no new pivot (5, 6, 9 -- var carries forward)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // bars 5-6 carry forward bar4's state (no pivot confirmed until bar7).
    for (const i of [5, 6]) {
      expect(result.bars[i]!["var:__obs_zzPrice"]).toBeCloseTo(100.0, 9);
      expect(result.bars[i]!["var:__obs_zzBar"]).toBe(3);
      expect(result.bars[i]!["var:__obs_zzDir"]).toBe(-1);
      expect(result.bars[i]!["var:__obs_pivotCount"]).toBe(2);
    }

    // bar9 (last bar) carries forward bar8's state (no further pivot in this 10-bar sample).
    expect(result.bars[9]!["var:__obs_zzPrice"]).toBeCloseTo(103.0, 9);
    expect(result.bars[9]!["var:__obs_zzBar"]).toBe(7);
    expect(result.bars[9]!["var:__obs_zzDir"]).toBe(-1);
    expect(result.bars[9]!["var:__obs_pivotCount"]).toBe(4);
  });

  it("final pivotCount is 4 (all 4 confirmed pivots pass the 0.5% deviation gate)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState.pivotCount).toBe(4);
    expect(result.finalVarState.zzDir).toBe(-1);
    expect(result.finalVarState.zzPrice).toBeCloseTo(103.0, 9);
    expect(result.finalVarState.zzBar).toBe(7);
  });

  it("emits exactly 1 plot with the declared title", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["ZigZag"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_zzPrice mirror value bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < result.bars.length; i++) {
      const expected = decodeSentinel(result.bars[i]!["var:__obs_zzPrice"]!);
      expect(nearlyEqual(values[i]!, expected)).toBe(true);
    }
  });

  it("zzDir is always exactly -1, 0, or 1 (never any other value, sanity bound)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect([-1, 0, 1]).toContain(bar["var:__obs_zzDir"]);
    }
  });

  it("pivotCount is monotonically non-decreasing bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 1; i < result.bars.length; i++) {
      expect(result.bars[i]!["var:__obs_pivotCount"]).toBeGreaterThanOrEqual(
        result.bars[i - 1]!["var:__obs_pivotCount"] as number,
      );
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
