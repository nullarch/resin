// oracle/cases/math_sum.pine: math.sum(source, length) 고정폭 슬라이딩 윈도우 합계 검증.
// __obs_s0(math.sum(close,3) — 정상 3바 창)/__obs_s1(math.sum(volume,100) — length가 10바
// 데이터셋 전체보다 커서 창이 끝내 안 참)/__obs_s2(math.sum(high,1) — length=1 축퇴) 세 채널.
// The golden's warm-up bars (__obs_s0 bars 0-1, __obs_s1 throughout) are hand-edited over
// pine2py's partial sums to na, the tier-2 oracle's values (PyneCore run of this case via the
// resin-harness `case` tool; ref_v6_ta_math.txt "math.sum": "the function calculates on the
// `length` quantity of non-`na` values"; harness indicators probes I01/I08). 세 채널 모두 bare CONTEXT_DATA_VARS
// (close/volume/high)를 직접 넘긴다 — pine2py의 math.sum은 source가 실제 Series 객체(bare
// open/high/low/close/volume 등)일 때만 이 윈도우 로직을 타고 계산된 변수(스칼라)면 다른(잘못된)
// 값을 내는 latent 버그가 있어(DIVERGENCES.md #15) 오라클 비교는 bare 인자로만 구성했다. na가
// 실제로 섞인 스킵 시맨틱은 codegen.test.ts/runtime.test.ts가 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "math_sum";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: math_sum", () => {
  it("matches the pine2py golden bar-by-bar for all three channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_s0", "var:__obs_s1", "var:__obs_s2"]);
  });

  it("matches the pine2py golden final var state for all three channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_s0", "__obs_s1", "__obs_s2"]) {
      const expected = golden.finalVarState[key];
      if (expected === "NaN") {
        expect(result.finalVarState[key]).toBeNaN();
      } else {
        expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
      }
    }
  });
});
