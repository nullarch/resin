// oracle/cases/ta_highest_lowest_varlen.pine: ta.highest/ta.lowest series(가변) length 검증
// (배치25 (4) 첫 착수, runtime/ta.ts highestVarLen/lowestVarLen). len1(1~5 순환, named local
// source)과 len2(0~2 순환, inline expression source — length<1일 때 pine2py highest.py의 실측
// 버그인 -Infinity/+Infinity까지 포함) 둘 다 커버.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_highest_lowest_varlen";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_highest_lowest_varlen", () => {
  it("matches the pine2py golden bar-by-bar for series-length ta.highest/ta.lowest", () => {
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
      const exp = expected === "NaN" ? NaN : expected === "Infinity" ? Infinity : expected === "-Infinity" ? -Infinity : (expected as number);
      if (Number.isNaN(exp)) {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
      } else if (!Number.isFinite(exp)) {
        expect(result.finalVarState[key]).toBe(exp);
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(exp, 6);
      }
    }
  });
});
