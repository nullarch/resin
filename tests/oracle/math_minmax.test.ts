// oracle/cases/math_minmax.pine: math.abs(1-인자)/math.max/math.min(2-인자, 양쪽 피연산자가
// 바마다 번갈아 이기도록 구성)/math.max(3-인자 가변) 검증. na 전파(rt.max/min이 pine2py의
// Python max()/min() 순서-의존 버그와 갈리는 지점, MEMORY.md Pitfalls 참조)는 이 오라클이 아니라
// tests/unit/runtime.test.ts에서 hand-verified로 검증한다 — 이 케이스는 na를 전혀 발생시키지 않는다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "math_minmax";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: math_minmax", () => {
  it("matches the pine2py golden bar-by-bar for abs/max/min (2-arg and 3-arg variadic)", () => {
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
