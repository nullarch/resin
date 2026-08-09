// oracle/cases/qualified_type_var_decl.pine: `var/varip series/simple/const TYPE x = ...` 및 var
// 없는 `series/simple/const TYPE x = ...`(타입 한정자 접두 변수 선언) 파서 지원 신규(C219, C195
// parser 감사 잔여 스코프 2/3). parseVarDecl/parseAssignmentOrExpr 둘 다 이전엔 SERIES/SIMPLE/CONST
// 토큰을 몰라 "expected IDENTIFIER in var declaration"으로 거부하던 파서 갭 수정 -- pine2py
// parser.py _parse_var_decl(L220-225)/_parse_qualified_var_decl(L274-292) literal port(qualifier는
// pine2js varTypeHints 소비자와의 충돌을 피해 버리고 base type만 저장). codegen이 typeHint를
// 참조하지 않아 코드 방출은 무한정자 선언과 완전히 동일 -- 이 오라클은 "타입 한정자가 붙어도
// 기존 무한정자 선언과 정확히 같은 값을 낸다"를 bar-by-bar로 검증한다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "qualified_type_var_decl";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_acc_series",
  "var:__obs_counter",
  "var:__obs_flag",
  "var:__obs_local",
  "var:__obs_if_local",
];

describe("oracle: qualified_type_var_decl", () => {
  it("matches the pine2py golden bar-by-bar for var series/varip simple/var const 및 var 없는 qualifier 로컬 채널", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("renders the exact accumulated/if-gated values pine2py produces at the final bar", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_acc_series).toBe(1043.0); // var series float 누적 -- close 10바 합계
    expect(v.__obs_counter).toBe(10); // varip simple int 카운터 -- 매 바 +1
    expect(v.__obs_flag).toBe(1.0); // var const bool true -> 1.0
    expect(v.__obs_local).toBe(216.0); // 마지막 바 close(108) * 2.0, 매 바 재평가
    expect(v.__obs_if_local).toBe(7); // bar_index > 2 게이트 확정 후: bare qualifier 로컬(simple int)
  });
});
