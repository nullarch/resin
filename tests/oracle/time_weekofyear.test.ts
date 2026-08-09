// oracle/cases/time_weekofyear.pine: weekofyear(C302 — wild "알 수 없는 함수 호출" 잔존
// 30-클러스터 개별 조사 중 발견된 gap. TIME_VAR_NAMES/TIME_FUNC_NAMES(C242/C245)가 시간
// 컴포넌트 7종을 이식할 때 weekofyear만 누락했으나, pine2py는 ctx.weekofyear(bare)/
// weekofyear_func(호출형) 양쪽을 이미 완전히 지원한다(dt.isocalendar()[1], ISO 8601 주차).
// bare 변수형과 함수-호출형(weekofyear(time)) 양쪽을 같은 oracle/data/time_vars.json
// 타임스탬프 세트(연말연시 경계 1704067199000=2023-12-31 23:59:59 포함)로 함께 검증한다.

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

describe("oracle: time_weekofyear (TV ISO 8601 주차 bare 변수 + 함수-호출 오버로드)", () => {
  const CASE_NAME = "time_weekofyear";

  it("matches the pine2py golden bar-by-bar across a year-boundary timestamp set", () => {
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
