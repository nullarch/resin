// oracle/cases/math_round_to_mintick.pine: math.round_to_mintick(value, mintick?) 검증. __obs_m0
// (default mintick=0.01)/__obs_m1(explicit mintick=1.0)/__obs_m2(mintick<=0 passthrough)/__obs_m3
// (NaN propagation)은 tie-free 입력이라 pine2py 골든과 바이트 단위 일치한다. __obs_m4는 **의도적
// 으로 골든과 다르다**(DIVERGENCES.md #14) — pine2py의 round_to_mintick은 Python 내장 round()
// (banker's rounding: ties to even)에 위임하는데, 같은 pine2py 모듈의 math.round(pine_round)는
// half-away-from-zero를 명시적으로 구현해둔 것과 모순된다. pine2js는 이미 검증된 rt.round를 그대로
// 재사용해 두 함수의 tie-break 규칙을 통일한다 — __obs_m4(close-100.5, mintick=1.0)는 정확히 .5
// 경계라 이 차이가 드러나므로 골든 비교에서 제외하고 손으로 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "math_round_to_mintick";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: math_round_to_mintick", () => {
  it("matches the pine2py golden bar-by-bar for tie-free channels (default mintick, explicit mintick, mintick<=0 passthrough, NaN)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_m0", "var:__obs_m1", "var:__obs_m2", "var:__obs_m3"]);
  });

  it("matches the pine2py golden final var state for tie-free channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_m0", "__obs_m1", "__obs_m2", "__obs_m3"]) {
      const expected = golden.finalVarState[key];
      if (expected === "NaN") {
        expect(result.finalVarState[key]).toBeNaN();
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
      }
    }
  });

  it("__obs_m4 (exact .5 ties) diverges from the golden — pine2js rounds away from zero, pine2py's Python round() rounds ties to even (documented divergence, hand-verified instead of golden-compared)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden (Python round(), banker's): close-100.5 = [0.5,1.5,2.5,1.5,3.5,4.5,5.5,4.5,6.5,7.5]
    // -> [0,2,2,2,4,4,6,4,6,8]
    const goldenExpected = [0, 2, 2, 2, 4, 4, 6, 4, 6, 8];
    // pine2js (rt.round, half-away-from-zero) -> [1,2,3,2,4,5,6,5,7,8]
    const pine2jsExpected = [1, 2, 3, 2, 4, 5, 6, 5, 7, 8];

    for (let i = 0; i < goldenExpected.length; i++) {
      expect(golden.bars[i]!["var:__obs_m4"]).toBe(goldenExpected[i]);
      expect(result.bars[i]!["var:__obs_m4"]).toBeCloseTo(pine2jsExpected[i]!, 9);
    }
  });
});
