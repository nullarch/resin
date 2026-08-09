// oracle/cases/ta_kwargs2.pine: ta.rma/ta.wma/ta.vwma/ta.stdev(source=/length=) 키워드 인자 오라클
// 검증(C473, next_hint(C472) 지시대로 재노출된 wild "SMMA" 클러스터 9528a6345fa3.pine 세분화 결과).
// pine2py wavealgo/ta/rma.py·wma.py·vwma.py·stdev.py 첫 두 파라미터 이름이 정확히 "source"/
// "length"라 kwarg 폼도 위치 인자 폼과 바별로 동일한 값을 낸다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_kwargs2";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_kwargs2", () => {
  it("matches the pine2py golden bar-by-bar for ta.rma/ta.wma/ta.vwma/ta.stdev(source=, length=)", () => {
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

  it("keyword form matches the positional form bar-by-bar for all 4 functions (pure syntax-level normalization)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_rma_kw"]).toBe(bar["var:__obs_rma_pos"]);
      expect(bar["var:__obs_wma_kw"]).toBe(bar["var:__obs_wma_pos"]);
      expect(bar["var:__obs_vwma_kw"]).toBe(bar["var:__obs_vwma_pos"]);
      expect(bar["var:__obs_stdev_kw"]).toBe(bar["var:__obs_stdev_pos"]);
    }
  });
});
