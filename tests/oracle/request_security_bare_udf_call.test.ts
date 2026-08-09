// oracle/cases/request_security_bare_udf_call.pine: request.security bare UDF call expression
// (C432, wild 클러스터① 최대 하위축 269건) — `[a,b] = request.security(sym, tf, myFunc(...))`.
// pine2py wavealgo/security.py._resolve_expression은 UDF 콜을 인식하지 못해 "미지원 값은 그대로
// 통과"로 떨어진다(문서화된 의도된 설계, 크래시/버그 아님) — UDF는 request_security() 진입 전
// 파이썬 인자 평가 시점에 이미 현재(차트) 타임프레임에서 실행 완료된 값이 그대로 반환값이 된다.
// pine2js는 이 오라클 시맨틱을 literal port(HTF 프리패스/캐시 없이 UDF를 그 자리에서 직접 호출)
// 했으므로, 다른 request.security 슬라이스(C176~C370)와 달리 이 축은 진짜 오라클 골든 대조가
// 가능하다(lazy-singleton 캐시 자체를 안 타는 경로라 MEMORY.md C176의 구조적 불가 제약 밖).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_security_bare_udf_call";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_hi", "var:__obs_lo"];

describe("oracle: request_security_bare_udf_call", () => {
  it("matches the pine2py golden bar-by-bar for both channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for both channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });

  it("sanity: the value tracks the CURRENT bar's high+1 every single bar, it does not hold constant across the 'D' HTF period (proves this is the eager-passthrough oracle behavior, not a real HTF fetch)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const hiValues = result.bars.map((b) => b["var:__obs_hi"]);
    expect(hiValues).toEqual(Array.from(data.high).map((h) => h + 1));
  });
});
