// oracle/cases/ta_valuewhen_kwargs.pine: ta.valuewhen(condition=/source=/occurrence=) 키워드
// 인자 오라클 검증(C557, next_hint(C556) 지시로 재조사한 argcount 클러스터 재스캔 결과 발견한
// 신규 kwargParamNames 후보). pine2py wavealgo/ta/barssince.py valuewhen()의 파라미터명이
// 정확히 condition/source/occurrence라 kwarg 폼도 위치 인자 폼과 바별로 동일한 값을 낸다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_valuewhen_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_valuewhen_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for ta.valuewhen(condition=, source=, occurrence=)", () => {
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
      expect(bar["var:__obs_kw"]).toBe(bar["var:__obs_pos"]);
      expect(bar["var:__obs_mixed"]).toBe(bar["var:__obs_pos"]);
    }
  });
});
