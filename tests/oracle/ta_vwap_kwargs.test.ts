// oracle/cases/ta_vwap_kwargs.pine: ta.vwap(source=close) 키워드 인자 오라클 검증(C471, next_hint
// (C470) 지시대로 wild 재스캔 후 신규 "키워드 인자" 잔여 클러스터 최다빈도 6건 해소 — 전량
// `ta.vwap(source = close)` 1-인자 폼). pine2py wavealgo/ta/vwap.py 첫 파라미터 이름이 정확히
// "source"라 kwarg 폼도 위치 인자 폼(oracle/cases/ta_vwap.pine)과 바별로 동일한 값을 낸다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_vwap_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_vwap_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for ta.vwap(source=close)", () => {
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

  it("keyword form matches the positional form bar-by-bar (kwarg is a pure syntax-level normalization)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      expect(bar["var:__obs_vwap_kw"]).toBe(bar["var:__obs_vwap_pos"]);
    }
  });
});
