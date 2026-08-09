// oracle/cases/udf_param_container_typehint.pine: C415 -- UDF/method 매개변수(및 method 수신자
// "this")의 명시 array<T>/map<K,V> typeHint를 컨테이너 종류 판별 신호로 인정해 for-in 이터러블로
// 허용(resolveContainerExprKind 신규 우선순위), array<UDT> 매개변수의 원소 UDT 타입 전파
// (resolveArrayElemUdtType), top-level var/'=' 로컬이 생성자 콜이 아닌 값(na/UDF 반환)을 받아도
// 명시 typeHint만으로 컨테이너 종류를 확정하는 폴백까지 6개 채널로 검증한다. pine2py는 값 흐름을
// 추적하지 않는 duck-typing 런타임이라 이 조합 전체가 오라클 대조 가능.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_param_container_typehint";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_sum_param",
  "var:__obs_sum_method",
  "var:__obs_highest",
  "var:__obs_sum_map",
  "var:__obs_sum_typehint_var",
  "var:__obs_sum_typehint_local",
];

describe("oracle: udf_param_container_typehint", () => {
  it("matches the pine2py golden bar-by-bar for all 6 typeHint-driven container-kind channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("renders the exact expected values at the final bar", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_sum_param).toBe(60); // array<float> param, 10+20+30
    expect(v.__obs_sum_method).toBe(60); // method receiver "this" typed array<float>, same array
    expect(v.__obs_highest).toBe(9); // array<Candle> param, max(5, 9)
    expect(v.__obs_sum_map).toBe(3); // map<string, float> param, 1+2
    expect(v.__obs_sum_typehint_var).toBe(300); // var array<float> b = na, typeHint-only fallback
    expect(v.__obs_sum_typehint_local).toBe(15); // '=' local array<float> c = makeArr(), typeHint-only fallback
  });
});
