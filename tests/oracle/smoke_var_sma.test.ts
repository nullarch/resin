// P0 최소 수직 슬라이스: oracle/cases/smoke_var_sma.pine을 transpile->실행하여
// oracle/golden/smoke_var_sma.json(pine2py 산출)과 바별로 일치하는지 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "smoke_var_sma";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: smoke_var_sma", () => {
  it("matches the pine2py golden bar-by-bar", () => {
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
      const expectedValue = decodeSentinel(expected);
      const actualValue = result.finalVarState[key];
      if (Number.isNaN(expectedValue)) {
        expect(actualValue).toBeNaN();
      } else {
        expect(actualValue).toBeCloseTo(expectedValue, 6);
      }
    }
  });

  it("produces NaN for ta.sma during its warmup period (first 2 bars)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.bars[0]!["var:__obs_sma3"]).toBeNaN();
    expect(result.bars[1]!["var:__obs_sma3"]).toBeNaN();
    expect(result.bars[2]!["var:__obs_sma3"]).not.toBeNaN();
  });

  it("accumulates 'var acc' across bars (persistent state survives across the whole run)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    const accSeries = result.bars.map((b) => b["var:acc"]);
    for (let i = 1; i < accSeries.length; i++) {
      expect(accSeries[i]!).toBeGreaterThan(accSeries[i - 1]!);
    }
  });
});
