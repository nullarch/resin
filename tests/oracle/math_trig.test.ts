// oracle/cases/math_trig.pine: math.sin/cos/tan/atan/todegrees/toradians(close-105.0 — no domain
// restriction)/math.asin·acos((close-104.5)/4.0 — kept inside the [-1,1] domain since Python
// math.asin/acos raise ValueError out of domain, unlike JS's NaN-returning Math.asin/acos)/
// math.atan2(close-105.0, open-102.0 — covers all four quadrants plus the x===0 on-axis case)
// against the pine2py golden.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "math_trig";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: math_trig", () => {
  it("matches the pine2py golden bar-by-bar for sin/cos/tan/asin/acos/atan/atan2/todegrees/toradians", () => {
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
});
