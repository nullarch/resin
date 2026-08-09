// oracle/cases/ctrl_flow_expr.pine: 제어문-식(if/for/while/switch as expression, GOAL.md 임시변수
// 방식) 검증 — if-expr(신규 로컬 '=', 기존 var 재대입 ':=' + elif), switch-expr(subject 없음 '=',
// subject 있음 ':='), for-expr('='), while-expr('=' + 데이터 의존 반복). oracle/data/ctrl_flow_expr.json은
// if_basic과 동일하게 close>open/close<open/close==open 세 경우를 모두 지나가도록 구성해 if-expr의
// then/elif/else 세 분기, switch-expr의 세 case를 모두 대조한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ctrl_flow_expr";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ctrl_flow_expr", () => {
  it("matches the pine2py golden bar-by-bar (if/switch/for/while as expression)", () => {
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
