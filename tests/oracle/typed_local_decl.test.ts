// oracle/cases/typed_local_decl.pine: `TYPE name = expr`(var/varip 없는 신규 로컬 선언에 타입
// 힌트가 붙은 형태, 예: `float x = 1.0`) 파서 지원 신규(C212). parser.ts parseAssignmentOrExpr가
// 이 패턴을 처리하지 못해 TYPE 토큰이 별개의 미해결 ExprStmt(Identifier)로 떨어져 나가
// analyzer가 "알 수 없는 식별자"로 거부하던 파서 갭 수정 -- pine2py parser.py
// _parse_identifier_statement(L324-332)의 "타입 힌트 + 변수 선언" 분기 literal port.
// codegen._gen_var_decl(L436)이 var_type=None이면 type_hint를 전혀 참조하지 않고
// `name = value`만 방출함(소스 대조 확인, 순수 장식)이라 파서가 타입 토큰을 소비만 하고 버려도
// 오라클과 100% 동일 시맨틱 -- 기존 무타입 '=' 로컬(Assignment)과 완전히 같은 노드로 낙착.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "typed_local_decl";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_float",
  "var:__obs_int",
  "var:__obs_bool",
  "var:__obs_chained",
  "var:__obs_close_local",
  "var:__obs_if_local",
  "var:__obs_loop_local",
];

const STRING_CHANNELS = ["var:__obs_str"];

describe("oracle: typed_local_decl", () => {
  it("matches the pine2py golden bar-by-bar for float/int/bool/chained/close-dependent/if-block/for-loop channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for the string() channel", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("renders the exact literal/chained/if-gated/loop values pine2py produces", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_float).toBe(1.5);
    expect(v.__obs_int).toBe(3);
    expect(v.__obs_bool).toBe(true);
    expect(v.__obs_str).toBe("hi");
    expect(v.__obs_chained).toBe(4.5); // scalarFloat(1.5) + scalarInt(3)
    // if bar_index > 2 게이트: sample10.json은 10바라 마지막 바(bar_index=9)에서 확정된 값
    expect(v.__obs_if_local).not.toBeNaN();
    expect(v.__obs_loop_local).toBe(4.0); // for i=0 to 2: 마지막 i=2 -> 2*2.0
  });
});
