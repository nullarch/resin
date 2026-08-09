// oracle/cases/str_format_time_kwargs.pine: str.format_time(timezone=) kwarg 신규 지원(C478,
// next_hint(C477) 1순위 -- wild 잔여 '키워드 인자' 블랑켓 최다빈도). timezone=만 오라클 가능
// (pine2py 실제 파라미터명이 정확히 'timezone', no-op 인자지만 이름은 일치) -- time=/format=은
// pine2py 내부 파라미터명이 time_ms/format_str이라 TypeError로 크래시하는 오라클 구조적 불가 축
// (codegen.test.ts의 hand-verified 동치성 테스트가 대체).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_format_time_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = ["var:__obs_kw_tz_positional_format", "var:__obs_kw_tz_default_format"];

describe("oracle: str_format_time_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for str.format_time(timezone=) channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state (positional time/format + timezone= keyword, and time + timezone= only)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });

  it("renders the exact values pine2py produces (timezone kwarg is a no-op, matches positional-arg equivalent)", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_kw_tz_positional_format).toBe("2024-01-15");
    expect(result.finalVarState.__obs_kw_tz_default_format).toBe("2024-01-15T14:30:45+0000");
  });
});
