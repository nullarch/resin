// oracle/cases/e2e_supertrend.pine: TV 빌트인 "Supertrend" 인디케이터 E2E 재현(ROADMAP P2 "TV
// 빌트인 인디케이터 E2E" 일곱 번째 슬라이스, SuperTrend 단독). ta.supertrend의 warmup divergence는
// 이미 tests/oracle/ta_supertrend.test.ts가 문서화했다(내부 ta.atr가 pine2py atr.py 재스캔보다 한
// 바 일찍 유효값을 내고, 그 시드가 band/direction 상태 전이를 통해 전체 궤적으로 전파 -- pine2js는
// bar2부터 유효값(96.5), golden은 bar3부터(95.5), bar4부터는 두 구현이 정확히 일치) -- 이 테스트는
// 그 divergence를 그대로 물려받아 bar-by-bar 비교를 hand-verified로 대체하고(compareToGolden 불가),
// finalVarState/plot 조합 축은 다른 e2e_*.test.ts와 동일한 순수 골든 비교를 쓴다(마지막 바(bar9)는
// 이미 두 구현이 수렴한 구간이라 golden과 정확히 같은 값을 내기 때문).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_supertrend";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_supertrend (TV built-in Supertrend, full script)", () => {
  it("diverges from golden by the documented one-bar ATR-seeded warmup shift (hand-verified, not golden-compared)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden (pine2py re-scan atr warmup): NaN through bar2, valid (95.5, dir 1) from bar3.
    for (let i = 0; i < 3; i++) {
      expect(golden.bars[i]!["var:__obs_value"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_direction"]).toBe(0);
    }
    expect(golden.bars[3]!["var:__obs_value"]).toBe(95.5);
    expect(golden.bars[3]!["var:__obs_direction"]).toBe(1);

    // pine2js (RMA-streamed atr warmup): NaN through bar1, valid one bar earlier (bar2) with a
    // different transient value (96.5 vs golden's bar3=95.5), matching golden bar-for-bar from bar4.
    const expected: [number, number][] = [
      [NaN, 0],
      [NaN, 0],
      [96.5, 1],
      [96.5, 1],
      [97.5, 1],
      [98.5, 1],
      [99.5, 1],
      [99.5, 1],
      [100.5, 1],
      [101.5, 1],
    ];
    expect(result.bars).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const [value, direction] = expected[i]!;
      if (Number.isNaN(value)) {
        expect(result.bars[i]!["var:__obs_value"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_value"]).toBeCloseTo(value, 9);
      }
      expect(result.bars[i]!["var:__obs_direction"]).toBe(direction);
    }

    // bar4부터는 golden과 실제로 일치함을 명시적으로 재확인(이 짧은 샘플에 한정된 우연 -- 일반 보장 아님).
    for (let i = 4; i < expected.length; i++) {
      expect(result.bars[i]!["var:__obs_value"]).toBeCloseTo(golden.bars[i]!["var:__obs_value"] as number, 9);
      expect(result.bars[i]!["var:__obs_direction"]).toBe(golden.bars[i]!["var:__obs_direction"]);
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

  it("emits exactly 2 plots in source order with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["SuperTrend", "Direction"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (value/direction wiring)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["SuperTrend", "var:__obs_value"],
      ["Direction", "var:__obs_direction"],
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
