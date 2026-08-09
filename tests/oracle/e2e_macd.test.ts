// oracle/cases/e2e_macd.pine: TV 빌트인 "MACD" 인디케이터 E2E 재현(ROADMAP P2 "TV 빌트인
// 인디케이터 15종 E2E" 첫 슬라이스, 3종 중 1). ta.macd 자체의 계산은 이미 tests/oracle/ta_macd.test.ts
// (순수 __obs 미러)가 개별 검증했다 -- 이 테스트가 새로 검증하는 것은 indicator()/input.int/
// input.source/plot()을 ta.macd와 한 스크립트로 조합했을 때 (1) __obs 미러 채널이 여전히 pine2py
// 골든과 바별로 일치하는지(다중 input 결선이 계산 자체를 바꾸지 않는지), (2) plot() 슬롯이
// 소스 순서(Histogram/MACD/Signal)대로 정확히 배정되는지, (3) 각 plot 채널의 값이 같은 바의
// __obs 미러 값과 정확히 같은지(plot()이 실제로 같은 변수를 내보내는지의 배선 검증 -- pine2py엔
// plot 오라클 채널이 없어(MEMORY.md "다섯 번째 오라클 불가 축") 이 부분만 hand-verified 등가
// 비교로 대체한다).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_macd";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_macd (TV built-in MACD, full script)", () => {
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

  it("emits exactly 3 plots in source order with the declared titles", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["Histogram", "MACD", "Signal"]);
    for (const p of result.plots) expect(p.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs mirror values bar-by-bar (histogram/macd/signal wiring)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const plotsByTitle = new Map(result.plots.map((p) => [p.title, p.values]));
    const channels: [string, string][] = [
      ["Histogram", "var:__obs_hist"],
      ["MACD", "var:__obs_macd"],
      ["Signal", "var:__obs_signal"],
    ];

    for (const [title, goldenKey] of channels) {
      const values = plotsByTitle.get(title)!;
      for (let i = 0; i < golden.bars.length; i++) {
        const expected = decodeSentinel(golden.bars[i]![goldenKey]!);
        expect(nearlyEqual(values[i]!, expected)).toBe(true);
      }
    }
  });
});
