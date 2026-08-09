// oracle/cases/ta_vwap.pine: ta.vwap(source) 검증(ROADMAP P2 "ta.* 44종" — vwap). Pine 문법상
// volume 인자가 없어 내장 bar series volume을 암묵 사용(vwma/mfi와 동일). 세션/anchor 리셋 없는
// 바0부터 전체 누적(pine2py vwap.py 동일 시맨틱 — LIMITATIONS.md "ta.vwap 세션 리셋" 참조).
// 워밍업 NaN 구간이 없어 바0부터 전 구간이 골든과 대조된다. 콜사이트 2개(close/high)로 상태
// 슬롯 독립도 함께 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_vwap";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_vwap", () => {
  it("matches the pine2py golden bar-by-bar for ta.vwap", () => {
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
