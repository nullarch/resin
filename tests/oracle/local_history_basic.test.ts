// oracle/cases/local_history_basic.pine: top-level '=' 로컬 히스토리(x[1]/x[2], C363 — ROADMAP P4
// "wild 최우선 [hard]: 로컬 히스토리" (a)슬라이스) 검증. x는 '='로 매 바 정확히 한 번만 재계산되는
// 로컬(재대입/':=' 없음)이라 pine2py ctx.param()의 "읽는 시점 값 inline push"와 pine2js의 "바
// 종료 후 최종값 1회 record" 사이의 순서 모호성(DIVERGENCES #6)이 애초에 발생하지 않는 케이스로
// 구성했다(history_basic.test.ts가 var acc에 대해 쓴 것과 동일한 회피 원칙).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "local_history_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: local_history_basic", () => {
  it("matches the pine2py golden bar-by-bar for a top-level '=' local's [1]/[2] history", () => {
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
