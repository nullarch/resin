// oracle/cases/bar_index_dynamic_offset.pine: bar_index[동적 오프셋] 검증(C305, ROADMAP P4
// next_hint 3위). 모듈로 순환 오프셋(정상 범위)/고정 변수 오프셋(워밍업 NaN->정상값 전환)/음수
// 오프셋(항상 NaN)까지 pine2py 골든과 대조.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "bar_index_dynamic_offset";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: bar_index_dynamic_offset", () => {
  it("matches the pine2py golden bar-by-bar for bar_index[dynamic offset]", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  // __obs_var/__obs_neg는 NaN으로 끝나(__obs_var은 이 케이스 마지막 바가 워밍업 안이라 na는 아니지만
  // __obs_neg는 항상 na) toBeCloseTo 대신 ta_pivot 선례와 동일하게 nearlyEqual(NaN===NaN PASS)을 쓴다.
  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(nearlyEqual(result.finalVarState[key]!, decodeSentinel(expected))).toBe(true);
    }
  });
});
