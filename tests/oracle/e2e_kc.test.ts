// oracle/cases/e2e_kc.pine: TV 빌트인 "Keltner Channels" 인디케이터 E2E 재현(ROADMAP P2 "TV 빌트인
// 인디케이터 E2E" 여덟(마지막) 슬라이스, KC 단독). ta.kc의 warmup divergence는 이미
// tests/oracle/ta_kc_kcw.test.ts가 문서화했다(pine2py kc.py가 basis_val이 이미 유효해도
// range_src(atr)가 NaN이면 튜플 전체를 NaN으로 묶어 반환 -- ta.atr의 워밍업 divergence가 basis까지
// 전파돼 pine2js가 golden보다 한 바 일찍(bar2) 유효값을 냄, bar3부터는 두 구현이 정확히 일치) -- 이
// 테스트는 그 divergence를 그대로 물려받아 bar-by-bar 비교를 hand-verified로 대체하고
// (compareToGolden 불가), finalVarState/plot 조합 축은 다른 e2e_*.test.ts와 동일한 순수 골든 비교를
// 쓴다(마지막 바(bar9)는 이미 두 구현이 수렴한 구간이라 golden과 정확히 같은 값을 내기 때문).

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
  it("diverges from golden by the documented one-bar ATR-seeded warmup shift (hand-verified, not golden-compared)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden (pine2py kc.py shared NaN gate masked by atr's warmup delay): NaN through bar2, valid from bar3.
    for (let i = 0; i < 3; i++) {
      expect(golden.bars[i]!["var:__obs_basis"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_upper"]).toBe("NaN");
      expect(golden.bars[i]!["var:__obs_lower"]).toBe("NaN");
    }
    expect(golden.bars[3]!["var:__obs_basis"]).toBe(102.0);

    // pine2js (ema(3)+atr(3) both warm in parallel, no shared gate): valid one bar earlier (bar2).
    const expected: [number, number, number][] = [
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [102, 108, 96],
      [102, 108, 96],
      [103, 109, 97],
      [104, 110, 98],
      [105, 111, 99],
      [105, 111, 99],
      [106, 112, 100],
      [107, 113, 101],
    ];
    expect(result.bars).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const [basis, upper, lower] = expected[i]!;
      if (Number.isNaN(basis)) {
        expect(result.bars[i]!["var:__obs_basis"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_upper"]).toBeNaN();
        expect(result.bars[i]!["var:__obs_lower"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_basis"]).toBeCloseTo(basis, 9);
        expect(result.bars[i]!["var:__obs_upper"]).toBeCloseTo(upper, 9);
        expect(result.bars[i]!["var:__obs_lower"]).toBeCloseTo(lower, 9);
      }
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
