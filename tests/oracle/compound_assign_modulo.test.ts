// oracle/cases/compound_assign_modulo.pine: 복합 대입 연산자(+=,-=,*=,/=,%=)와 modulo(%) 이항
// 연산자 검증 (C195 parser 감사 발견 -- 렉서는 PLUS_ASSIGN 등 토큰을 이미 방출했으나 파서가 전혀
// 소비하지 않아 `x += 1`/`a % b`가 ParseError였다. `x OP= v` -> `x := x OP v` 데슈가링 + PERCENT를
// */ 와 동일 우선순위 BinOp로 추가해 수정, DIVERGENCES.md 신규 항목 없음(pine2py와의 의도적 차이가
// 아니라 순수 pine2js 파서 버그 수정 -- rt.pineMod는 이미 C1부터 구현/유닛테스트돼 있었으나 파서가
// 배선하지 않아 죽어있던 코드였음).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "compound_assign_modulo";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: compound_assign_modulo", () => {
  it("matches the pine2py golden bar-by-bar for +=/-=/*=//= and %", () => {
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
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 9);
    }
  });

  it("cycles modCounter through 0/1/2 via '+= 1' then '%= 3' (exact int sequence)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    const modCounterSeries = result.bars.map((bar) => bar["var:modCounter"]);
    expect(modCounterSeries).toEqual([1, 2, 0, 1, 2, 0, 1, 2, 0, 1]);
  });

  it("halves acc4 every bar via '/= 2.0', staying strictly positive and monotonically decreasing", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    const acc4Series = result.bars.map((bar) => bar["var:acc4"] as number);
    for (let i = 1; i < acc4Series.length; i++) {
      expect(acc4Series[i]).toBeLessThan(acc4Series[i - 1]!);
      expect(acc4Series[i]).toBeGreaterThan(0);
    }
  });

  it("is deterministic across repeated runs", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const r1 = runPipeline(source, data);
    const r2 = runPipeline(source, data);

    expect(r1.finalVarState).toEqual(r2.finalVarState);
  });
});
