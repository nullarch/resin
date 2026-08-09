// oracle/cases/math_avg.pine: math.avg(...args) 가변 인자 na-스킵 평균 검증. __obs_a0(4개 전부
// 유효)/__obs_a1(2개 중 1개 na — 남은 유효값 그대로)/__obs_a2(전부 na — 결과도 na)/__obs_a3(3개 중
// 1개 na — 나머지 2개 평균) 네 채널 전부 pine2py 골든과 바이트 단위 일치(divergence 없음 — avg는
// round_to_mintick과 달리 tie-break 같은 구현 선택지가 없는 단순 합/개수 연산).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "math_avg";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: math_avg", () => {
  it("matches the pine2py golden bar-by-bar for all four channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_a0", "var:__obs_a1", "var:__obs_a2", "var:__obs_a3"]);
  });

  it("matches the pine2py golden final var state for all four channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_a0", "__obs_a1", "__obs_a2", "__obs_a3"]) {
      const expected = golden.finalVarState[key];
      if (expected === "NaN") {
        expect(result.finalVarState[key]).toBeNaN();
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
      }
    }
  });
});
