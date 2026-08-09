// oracle/cases/generic_type_var_decl.pine: `var TYPE<...> name = expr`/바 없는 `TYPE<...> name =
// expr`(제네릭 '<>' 표기의 var/varip 및 var 없는 '=' 로컬 선언) 파서 지원 신규(C214). parser.ts
// parseVarDecl/parseAssignmentOrExpr 둘 다 이전엔 `<`로 시작하는 제네릭 타입 시퀀스를 몰라
// "expected ASSIGN ... got LT"로 거부하던 파서 갭 수정 -- pine2py parser.py
// _is_generic_typed_var_decl/_parse_type_expression(L1113-1184) literal port(타입 문자열 조립은
// 기존 UDT 필드 parseFieldTypeHint를 그대로 재사용). codegen이 typeHint를 참조하지 않아 코드
// 방출은 무타입 선언과 완전히 동일 -- 이 오라클은 "새로 파싱 가능해진 구문이 기존
// array.*/map.*/matrix.* 배관과 정확히 같은 값을 낸다"를 bar-by-bar로 검증한다.
//
// var:accFloat/var:m/var:mtx(원시 컨테이너 채널)는 비교 대상에서 뺀다 -- gen_oracle.py의
// ctx._var_state 스냅샷이 참조를 담아 매 바 최종 상태를 그대로 보여주는 기존 하네스 아티팩트
// (array_type_shorthand.pine과 동일 사유, DIVERGENCES #90 인접 관찰) -- 스칼라 __obs_* 채널만이
// 진짜 per-bar 값이다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "generic_type_var_decl";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_acc_size",
  "var:__obs_map_get",
  "var:__obs_mtx_get",
  "var:__obs_local_sum",
  "var:__obs_if_local",
];

describe("oracle: generic_type_var_decl", () => {
  it("matches the pine2py golden bar-by-bar for var/varip array<float>/map<string,float>/matrix<float> and var 없는 신규 로컬 채널", () => {
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

    expect(v.__obs_acc_size).toBe(10);
    expect(v.__obs_map_get).toBe(108);
    expect(v.__obs_mtx_get).toBe(108);
    expect(v.__obs_local_sum).toBe(10.0); // array.new_float(2, 5.0) -> [5.0, 5.0], 매 바 재생성
    expect(v.__obs_if_local).toBe(108); // bar_index > 2 게이트 확정 후: 신규 로컬 map.get
  });
});
