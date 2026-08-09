// oracle/cases/array_new_typed.pine: array.new_int/new_bool/new_string/new_color/from(C84) — 원소
// 타입별 생성자 4종 + 가변 생성자 1종. 전부 리터럴/유효 인자만 사용해 바 데이터와 무관하게 매 바
// 동일값(math_const.pine/str_basic.pine/color_basic.pine과 동일 패턴). na size(크래시 -> na(null))
// 갭은 pine2py 자체가 크래시해 오라클로 검증 불가 — runtime.test.ts에서 hand-verified로 대체
// (DIVERGENCES.md #24, LIMITATIONS.md 참조). bool 원소는 JS가 산술 컨텍스트에서 boolean을
// number로 강제 변환해(array_search.pine C82와 동일 원칙) 숫자 전용 compareToGolden으로 그대로
// 비교 가능 — string/color 원소만 compareStringToGolden(C77)이 필요하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_new_typed";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_i0_size",
  "var:__obs_i_size",
  "var:__obs_i0v",
  "var:__obs_i2v",
  "var:__obs_b0_size",
  "var:__obs_b_v0",
  "var:__obs_b_v1",
  "var:__obs_s0_size",
  "var:__obs_fn_size",
  "var:__obs_fn1",
  "var:__obs_fb0",
  "var:__obs_fb1",
  "var:__obs_fb2",
];

const STRING_CHANNELS = ["var:__obs_s_v0", "var:__obs_c_v0", "var:__obs_fs0", "var:__obs_fs1"];

describe("oracle: array_new_typed", () => {
  it("matches the pine2py golden bar-by-bar for numeric/bool channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for string/color channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of Object.keys(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
