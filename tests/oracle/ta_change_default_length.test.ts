// oracle/cases/ta_change_default_length.pine: ta.change(close) 1-인자 생략형 검증(C227, ROADMAP P3
// next_hint 1순위 — TA_REGISTRY.change에 minArgCount:1 신설, corpus 10건 실측 `ta.change(close)`
// 관용구). length 생략형과 명시형(length=1)이 pine2py 골든 기준으로도, pine2js 산출값 기준으로도
// 바이트 단위 동일함을 함께 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_change_default_length";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_change_default_length", () => {
  it("matches the pine2py golden bar-by-bar for both the 1-arg and explicit-length(1) call", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("the 1-arg omitted-length call is bar-by-bar identical to the explicit length=1 call", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      const defaultVal = bar["var:__obs_change_default"];
      const explicitVal = bar["var:__obs_change_explicit1"];
      if (typeof defaultVal === "number" && Number.isNaN(defaultVal)) {
        expect(explicitVal).toBeNaN();
      } else {
        expect(defaultVal).toBe(explicitVal);
      }
    }
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
});
