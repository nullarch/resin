// oracle/cases/array_type_shorthand.pine: `TYPE[] name = expr` 대괄호-접미 배열 타입
// shorthand(`array<float>`의 대체 표기, 예: `float[] arr = array.new_float(0)`) 파서 지원
// 신규(C213). parser.ts parseVarDecl/parseAssignmentOrExpr 둘 다 이 4-토큰 패턴(IDENTIFIER
// LBRACKET RBRACKET IDENTIFIER)을 몰라 "expected ASSIGN ... got LBRACKET"로 거부하던 파서 갭
// 수정 -- pine2py parser.py _is_array_type_shorthand/_consume_array_type_shorthand(L1003-1017)
// literal port. codegen이 typeHint를 참조하지 않아(genValueCode는 string/UDT/enum만 검사) 코드
// 방출은 무타입 선언과 완전히 동일 -- 이 오라클은 "새로 파싱 가능해진 구문이 기존 array.* 배관과
// 정확히 같은 값을 낸다"를 bar-by-bar로 검증한다.
//
// var:accFloat/var:accInt/var:flagHist(원시 배열 채널)는 비교 대상에서 뺀다 -- gen_oracle.py의
// ctx._var_state 스냅샷이 배열을 참조로 담아 매 바 최종 상태를 그대로 보여주는 기존 하네스 아티팩트
// (C213 corpus differential 재실측 중 array.fill 사례로 재확인, DIVERGENCES #90 인접 관찰)라 바별
// 대조가 무의미 -- 스칼라 __obs_* 채널만이 진짜 per-bar 값이다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_type_shorthand";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_acc_size",
  "var:__obs_acc_avg",
  "var:__obs_int_last",
  "var:__obs_flag_size",
  "var:__obs_local_sum",
  "var:__obs_if_local",
];

describe("oracle: array_type_shorthand", () => {
  it("matches the pine2py golden bar-by-bar for var/varip float[]/int[]/bool[] and var 없는 신규 로컬 float[] 채널", () => {
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
    expect(v.__obs_int_last).toBe(9);
    expect(v.__obs_flag_size).toBe(10);
    expect(v.__obs_local_sum).toBe(10); // array.new_float(2, 5.0) -> [5.0, 5.0], 매 바 재생성
    expect(v.__obs_if_local).toBe(9); // bar_index > 2 게이트 확정 후: array.new_float(1, 9.0)[0]
  });
});
