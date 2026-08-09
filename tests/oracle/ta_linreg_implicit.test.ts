// oracle/cases/ta_linreg_implicit.pine: ta.linreg(source, length) 2-인자 축약형(offset 생략,
// 기본값 0) 검증(C252). 명시 offset=0 3-인자 폼(ta.linreg(close, 4, 0))과 같은 골든에서 나란히
// 비교해 두 폼이 정확히 일치함을 확인.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_linreg_implicit";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_linreg_implicit", () => {
  it("matches the pine2py golden bar-by-bar for ta.linreg(source, length)", () => {
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

  it("implicit ta.linreg(close, 4) matches explicit ta.linreg(close, 4, 0)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_lr_implicit"]).toEqual(bar["var:__obs_lr_explicit0"]);
    }
  });
});
