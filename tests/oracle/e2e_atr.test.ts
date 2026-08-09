// oracle/cases/e2e_atr.pine: TV 빌트인 "Average True Range" 인디케이터 E2E 재현(ROADMAP P2 "TV
// 빌트인 인디케이터 E2E" 여섯 번째 슬라이스, ATR 단독). ta.atr 자체의 warmup divergence는 이미
// tests/oracle/ta_atr_tr.test.ts가 문서화했다(pine2py의 재스캔 구현이 golden bar3부터, pine2js는
// RMA(TR,length) O(1) 스트리밍 합성이라 bar2부터 유효값) -- 이 테스트는 그 divergence를 그대로
// 물려받아 bar-by-bar 비교를 hand-verified로 대체하고(compareToGolden 불가), finalVarState/plot
// 조합 축은 다른 e2e_*.test.ts와 동일한 순수 골든 비교를 쓴다(수렴 후에는 두 구현이 정확히 같은
// 값(3.0)을 내기 때문).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_atr";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_atr (TV built-in Average True Range, full script)", () => {
  it("diverges from golden by the documented one-bar ATR warmup shift (hand-verified, not golden-compared)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden (pine2py re-scan): NaN at bar0-2, 3.0 from bar3 (same shift as ta_atr_tr.test.ts).
    expect(golden.bars[0]!["var:__obs_atr"]).toBe("NaN");
    expect(golden.bars[1]!["var:__obs_atr"]).toBe("NaN");
    expect(golden.bars[2]!["var:__obs_atr"]).toBe("NaN");
    expect(golden.bars[3]!["var:__obs_atr"]).toBe(3.0);

    // pine2js (RMA(TR,3) streaming): NaN only at bar0-1, valid (3.0) from bar2.
    expect(result.bars[0]!["var:__obs_atr"]).toBeNaN();
    expect(result.bars[1]!["var:__obs_atr"]).toBeNaN();
    for (let i = 2; i < result.bars.length; i++) {
      expect(result.bars[i]!["var:__obs_atr"]).toBeCloseTo(3.0, 9);
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

  it("emits exactly 1 plot titled 'ATR'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["ATR"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_atr mirror values bar-by-bar", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < golden.bars.length; i++) {
      const expected = decodeSentinel(result.bars[i]!["var:__obs_atr"]!);
      expect(nearlyEqual(values[i]!, expected)).toBe(true);
    }
  });
});
