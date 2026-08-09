// oracle/cases/udf_history_basic.pine: UDF 매개변수/내부 '=' 로컬/내부 var 히스토리(C364 —
// ROADMAP P4 "wild 최우선 [hard]: 로컬 히스토리" (b)슬라이스) 검증. 오라클 유효 조건(pine2py
// ctx.param()이 이름 문자열 키 + 읽는 시점 inline push라서): 함수마다 단일 콜사이트 + 무조건
// 호출 + 함수 간 유일한 이름(psrc/dval/vacc) + 히스토리 읽기가 그 이름의 같은-바 대입 이후에만
// 등장(재대입-전-읽기 순서 모호성 DIVERGENCES #6 원천 회피 — local_history_basic.test.ts와 동일
// 원칙). 콜사이트 독립성(다중 콜사이트)은 pine2py가 이름 하나로 상태를 공유해(MEMORY.md C9)
// 오라클 무효 — tests/unit/udf_history.test.ts의 hand-verified 테스트가 담당.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "udf_history_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// onlyKeys: pine2py는 UDF 내부 var(vacc)도 flat ctx._var_state로 골든에 노출하지만 pine2js는
// 설계상 그 상태를 콜사이트별 $.fnVars에 격리해 var:<name> 채널로 노출하지 않는다(compareToGolden
// onlyKeys 주석의 udf_single_var 'total'과 동일 케이스) — __obs_* 채널만 비교. vacc의 수치 자체는
// __obs_v(vacc[1] 관측)가 바별로 그대로 검증한다.
const OBS_KEYS = ["var:__obs_p", "var:__obs_d", "var:__obs_v"];

describe("oracle: udf_history_basic", () => {
  it("matches the pine2py golden bar-by-bar for UDF param/'=' local/var history reads", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, OBS_KEYS);
  });

  it("matches the pine2py golden final var state (__obs_* channels)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      if (!key.startsWith("__obs_")) continue;
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
