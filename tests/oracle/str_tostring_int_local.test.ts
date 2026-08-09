// oracle/cases/str_tostring_int_local.pine: str.tostring() int/float 갭의 잔여 스코프 (4) --
// '=' 로컬로의 int 타입 힌트 전파(C201/LIMITATIONS.md, C205 next_hint 1순위). analyzeAssignment의
// '=' 신규 로컬 선언 지점에서 isStaticIntExpr가 true면 scope.numTypeHints에 "int"를 등록해,
// 정수 리터럴/for 루프 카운터를 경유한 '=' 로컬(다단계 체이닝 포함)까지 int 포맷으로 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_tostring_int_local";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = [
  "var:__obs_lit_local",
  "var:__obs_loop_local",
  "var:__obs_chain_local",
  "var:__obs_float_local_control",
];

describe("oracle: str_tostring_int_local", () => {
  it("matches the pine2py golden bar-by-bar for '=' local int/float channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state (literal-assigned local, loop-counter-assigned local, chained local, float control)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });

  it("renders int format for '=' locals fed by int literals or loop counters (incl. chained), float format for the float control", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_lit_local).toBe("5");
    expect(result.finalVarState.__obs_loop_local).toBe("2");
    expect(result.finalVarState.__obs_chain_local).toBe("2");
    expect(result.finalVarState.__obs_float_local_control).toBe("5.0");
  });
});
