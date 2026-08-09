// oracle/cases/color_new_kwarg.pine: color.new(colorVal, transp=N) keyword-argument form (C371,
// wild kwarg 게이트 클러스터 1위) — pine2py의 위치/키워드 인자 처리가 그대로 kwarg 문법을
// 지원함을 gen_oracle.py 실행으로 확인(hand-verified 대체 불필요, request.security류 구조적
// 불가와 다름). 리터럴 인자라 바 데이터와 무관하게 매 바 동일값(color_basic.pine 패턴).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "color_new_kwarg";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["var:__obs_kwarg", "var:__obs_pos", "var:__obs_kwarg_zero"];

describe("oracle: color_new_kwarg", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels, and the kwarg form equals the positional form", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_kwarg", "__obs_pos", "__obs_kwarg_zero"]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
    expect(result.finalVarState["__obs_kwarg"]).toBe(result.finalVarState["__obs_pos"]);
  });
});
