// oracle/cases/fixnan_basic.pine: fixnan(value) bare(비-namespace) stateful 빌트인 콜 검증.
// sample10.json의 close는 na가 없어 이 케이스는 "이전 non-na 값 회상" 분기를 exercise하지
// 못한다(dispatch 배선 smoke 검증 성격) — 회상 로직 자체는 tests/unit/codegen.test.ts의
// hand-verified 테스트로 별도 검증한다(MEMORY.md "오라클 제외" 패턴 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "fixnan_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: fixnan_basic", () => {
  it("matches the pine2py golden bar-by-bar for fixnan(close) pass-through", () => {
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
