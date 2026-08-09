// oracle/cases/color_literal.pine: #RRGGBB/#RRGGBBAA 리터럴(C226) — lexer는 이미 COLOR 토큰을
// 만들지만 parser/analyzer/codegen이 소비하지 않아 지금까지 전부 ParseError였다(corpus 22건 실측,
// transpile_ok 5841->5864). pine2py도 color.py 리터럴을 순수 hex string으로 codegen하므로
// color_basic.pine(color.* 상수)과 동일하게 var string 미러로 관측한다. 삼항 분기(바 데이터 의존,
// close>104가 바마다 갈림)와 UDF 인자 전달 위치도 함께 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "color_literal";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_hex6", "var:__obs_hex8", "var:__obs_arg", "var:__obs_ternary"];

describe("oracle: color_literal", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_hex6", "__obs_hex8", "__obs_arg", "__obs_ternary"]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
