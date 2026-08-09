// oracle/cases/e2e_wpr.pine: TV 빌트인 "Williams %R" 인디케이터 E2E 재현(ROADMAP P2 "TV 빌트인
// 인디케이터 15종 E2E" 세 번째 슬라이스, 3종 중 2). ta.wpr 자체의 계산은 이미
// tests/oracle/ta_wpr.test.ts(순수 __obs 미러)가 개별 검증했다 -- 이 테스트가 새로 검증하는
// 것은 indicator()/input.int/plot()을 ta.wpr와 한 스크립트로 조합했을 때 (1) __obs 미러 채널이
// 여전히 pine2py 골든과 바별로 일치하는지, (2) 단일 plot() 슬롯이 정확히 배정되는지, (3) plot
// 채널 값이 같은 바의 __obs 미러 값과 정확히 같은지(e2e_stoch.test.ts와 동일한 세 축, 단일 plot
// 케이스).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_wpr";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_wpr (TV built-in Williams %R, full script)", () => {
  it("matches the pine2py golden bar-by-bar for the composed script", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
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

  it("emits exactly 1 plot titled '%R'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["%R"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_r mirror values bar-by-bar", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < golden.bars.length; i++) {
      const expected = decodeSentinel(golden.bars[i]!["var:__obs_r"]!);
      expect(nearlyEqual(values[i]!, expected)).toBe(true);
    }
  });
});
