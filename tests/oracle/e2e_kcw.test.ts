// oracle/cases/e2e_kcw.pine: TV 빌트인 "Keltner Channels Width" 인디케이터 E2E 재현(ROADMAP P2
// "TV 빌트인 인디케이터 E2E" 여덟(마지막) 슬라이스, KCW 단독). ta.kcw는 내부적으로 ta.kc를 호출해
// (upper-lower)/basis*100을 계산하므로 e2e_kc.pine과 동일한 divergence(DIVERGENCES.md #9)를 그대로
// 물려받는다 -- 이 테스트도 bar-by-bar 비교를 hand-verified로 대체하고(compareToGolden 불가),
// finalVarState/plot 조합 축은 순수 골든 비교를 쓴다(마지막 바(bar9)는 두 구현이 수렴한 구간).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_kcw";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_kcw (TV built-in Keltner Channels Width, full script)", () => {
  it("diverges from golden by the documented one-bar ATR-seeded warmup shift (hand-verified, not golden-compared)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden: NaN through bar2, valid from bar3.
    for (let i = 0; i < 3; i++) {
      expect(golden.bars[i]!["var:__obs_kcw"]).toBe("NaN");
    }
    expect(golden.bars[3]!["var:__obs_kcw"]).toBe(11.7647058824);

    // pine2js: valid one bar earlier (bar2), matching golden bar-for-bar from bar3.
    const expected: number[] = [
      NaN,
      NaN,
      11.76470588235294,
      11.76470588235294,
      11.650485436893204,
      11.538461538461538,
      11.428571428571429,
      11.428571428571429,
      11.320754716981133,
      11.214953271028037,
    ];
    expect(result.bars).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i++) {
      const v = expected[i]!;
      if (Number.isNaN(v)) {
        expect(result.bars[i]!["var:__obs_kcw"]).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_kcw"]).toBeCloseTo(v, 9);
      }
    }

    // bar3부터는 golden과 실제로 일치함을 명시적으로 재확인(이 짧은 샘플에 한정된 우연 -- 일반 보장 아님).
    for (let i = 3; i < expected.length; i++) {
      expect(result.bars[i]!["var:__obs_kcw"]).toBeCloseTo(golden.bars[i]!["var:__obs_kcw"] as number, 9);
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

  it("emits exactly 1 plot titled 'KCW'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["KCW"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_kcw mirror values bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < result.bars.length; i++) {
      const expected = decodeSentinel(result.bars[i]!["var:__obs_kcw"]!);
      expect(nearlyEqual(values[i]!, expected)).toBe(true);
    }
  });
});
