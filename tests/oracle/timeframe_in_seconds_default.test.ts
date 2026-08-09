// oracle/cases/timeframe_in_seconds_default.pine: timeframe.in_seconds() 0-인자 오버로드(C269) —
// pine2py timeframe_in_seconds(timeframe: str = "")의 기본값 인자 경로. timeframe_basic.pine의
// __obs_in_seconds_empty(명시적 "" 인자, 이미 CONFIRMED 86400)와 반드시 같은 값이어야 한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "timeframe_in_seconds_default";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMBER_CHANNELS = ["var:__obs_in_seconds_omitted"];

describe("oracle: timeframe_in_seconds_default", () => {
  it("matches the pine2py golden bar-by-bar", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMBER_CHANNELS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of NUMBER_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBeCloseTo(golden.finalVarState[name] as number, 6);
    }
  });

  it("matches timeframe_basic.pine's explicit-\"\" channel (same 86400 value via a different call form)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    expect(result.finalVarState.__obs_in_seconds_omitted).toBe(86400);
  });
});
