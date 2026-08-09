// oracle/cases/time_func_call.pine: year(time)/month(time)/dayofmonth(time)/dayofweek(time)/
// hour(time)/minute(time)/second(time) 함수-호출 오버로드(C245 — ROADMAP P3 next_hint 1순위,
// C244가 재확인한 corpus 실사용은 hour(time) 1건뿐이나 TIME_VAR_NAMES(C242)의 bare 식별자
// 형제 7종 모두 rt.datetime.* 함수가 이미 존재해 이 호출-형 오버로드 하나로 공짜로 커버됨).
// pine2py hour_func 등은 (time_ms, timezone, context) 3-인자지만 corpus/next_hint가 확인한
// 1-인자 time_expr 폼만 지원(2-인자 timezone 오버로드는 범위 밖). __obs_hour_offset은 인자가
// bare `time` 변수가 아니라 임의 산술식(`time - 3600000`)일 때도 genExpr(args[0])가 올바르게
// 평가되는지 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: time_func_call (TV 시간 컴포넌트 함수-호출 오버로드)", () => {
  const CASE_NAME = "time_func_call";

  it("matches the pine2py golden bar-by-bar across weekday/leap-day/year-boundary timestamps", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    expect(data.time).toBeDefined();
    expect(data.time).toHaveLength(10);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
