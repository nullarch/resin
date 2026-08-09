// oracle/cases/math_sum.pine: math.sum(source, length) 고정폭 슬라이딩 윈도우 합계 검증.
// __obs_s0(math.sum(close,3) — 정상 3바 창)/__obs_s1(math.sum(volume,100) — length가 10바
// 데이터셋 전체보다 커서 매 바 누적 합, min(length,len(source)) 검증)/__obs_s2(math.sum(high,1) —
// length=1 축퇴) 세 채널 전부 pine2py 골든과 바이트 단위 일치. 세 채널 모두 bare CONTEXT_DATA_VARS
// (close/volume/high)를 직접 넘긴다 — pine2py의 math.sum은 source가 실제 Series 객체(bare
// open/high/low/close/volume 등)일 때만 이 윈도우 로직을 타고 계산된 변수(스칼라)면 다른(잘못된)
// 값을 내는 latent 버그가 있어(DIVERGENCES.md #15) 오라클 비교는 bare 인자로만 구성했다. na가
// 실제로 섞인 스킵 시맨틱은 이 latent 버그 때문에 오라클로 검증 불가 — codegen.test.ts/
// runtime.test.ts의 hand-verified 테스트로 대체.

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
