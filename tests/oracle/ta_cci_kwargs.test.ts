// oracle/cases/ta_cci_kwargs.pine: ta.cci(source=/length=) 키워드 인자 오라클 검증(C477,
// next_hint(C476) 지시대로 wild 10c6fbc3696f.pine/257fa4fb6137.pine 세분화 결과). pine2py
// wavealgo/ta/cci.py 첫 두 파라미터 이름이 정확히 "source"/"length"라 kwarg 폼도 위치 인자 폼과
// 바별로 동일한 값을 낸다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_cci_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_cci_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for ta.cci(source=, length=)", () => {
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

  it("keyword and mixed forms match the positional form bar-by-bar (pure syntax-level normalization)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_cci_kw"]).toBe(bar["var:__obs_cci_pos"]);
      expect(bar["var:__obs_cci_mixed"]).toBe(bar["var:__obs_cci_pos"]);
    }
  });
});
