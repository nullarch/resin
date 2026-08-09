// oracle/cases/udf_param_udt_field_hist.pine: UDF/method 매개변수(UDT) 필드 히스토리(C750,
// LIMITATIONS C749 hist-index(all) 잔여 서브그룹 — wild `evaluateTrade(c, inTradeWindow) =>
// ... c.close[1]`류) 검증. 오라클 유효 조건: 매개변수는 본문에서 ':=' 재대입이 불가능해 함수
// 진입 시점 값이 곧 확정값(C364 스칼라 매개변수 히스토리와 동일 원칙) — 단일 콜사이트라
// 콜사이트 독립성 자체는 이 오라클로 검증 안 됨(다중 콜사이트는 잠재 위험, LIMITATIONS 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_param_udt_field_hist";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// onlyKeys: pine2py 골든의 "var:obj"는 pine_fn 클래스 인스턴스 repr 문자열이라 pine2js의 UDT
// 인스턴스(plain object)와 형태가 다름 — __obs_x(함수 반환값 관측) 채널만 비교(기존 udf_history_basic
// 패턴과 동일).
const OBS_KEYS = ["var:__obs_x"];

describe("oracle: udf_param_udt_field_hist", () => {
  it("matches the pine2py golden bar-by-bar for UDF param UDT field history reads", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state (__obs_x)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState.__obs_x).toBeCloseTo(golden.finalVarState.__obs_x as number, 6);
  });
});
