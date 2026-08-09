// oracle/cases/str_tostring_int.pine: str.tostring() 기본(format_str 없음) 포맷의 int/float 갭
// 회귀 재현(C201, LIMITATIONS.md "str.tostring int/float 갭" 근본 수정). isStaticIntExpr가 정적으로
// int로 확정하는 두 범위(정수 리터럴 + for 루프 카운터)를 커버 -- corpus 스크립트 079ae781480a에서
// 실제 발견된 `for i=0 to 4: s+=str.tostring(i)` 패턴을 그대로 재현(__obs_loop_concat).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_tostring_int";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = [
  "var:__obs_lit_pos",
  "var:__obs_lit_neg",
  "var:__obs_lit_float",
  "var:__obs_loop_direct",
  "var:__obs_loop_concat",
];

describe("oracle: str_tostring_int", () => {
  it("matches the pine2py golden bar-by-bar for str.tostring int/float channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state (positive/negative int literal, control float literal, for-loop counter direct + accumulated)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });

  it("renders the exact values pine2py produces (no decimal point on statically-int channels, decimal point preserved on the float control channel)", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_lit_pos).toBe("5");
    expect(result.finalVarState.__obs_lit_neg).toBe("-7");
    expect(result.finalVarState.__obs_lit_float).toBe("5.0");
    expect(result.finalVarState.__obs_loop_direct).toBe("2");
    expect(result.finalVarState.__obs_loop_concat).toBe("01234");
  });
});
