// oracle/cases/str_tostring_kwargs.pine: str.tostring(value=) kwarg 신규 지원(C403, next_hint(C402)
// 1순위 -- wild kwarg 블랑켓 클러스터 최다 서브클러스터). value=만 오라클 가능(pine2py 실제 파라미터명이
// 정확히 'value') -- format=은 pine2py 내부 파라미터명이 'format_str'이라 TypeError로 크래시하는
// 오라클 구조적 불가 축(codegen.test.ts의 hand-verified 동치성 테스트가 대체).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_tostring_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = ["var:__obs_kw_value_int", "var:__obs_kw_value_float", "var:__obs_kw_value_loop"];

describe("oracle: str_tostring_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for str.tostring(value=) channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state (int/float/for-loop counter via value= keyword)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });

  it("renders the exact values pine2py produces (no decimal point on the statically-int value= channel)", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_kw_value_int).toBe("5");
    expect(result.finalVarState.__obs_kw_value_float).toBe("5.25");
    expect(result.finalVarState.__obs_kw_value_loop).toBe("2");
  });
});
