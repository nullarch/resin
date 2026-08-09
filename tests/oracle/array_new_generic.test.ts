// oracle/cases/array_new_generic.pine: `array.new<TYPE>(size, initial_value)` 제네릭 타입 인자
// 호출(C221, corpus 144건 실측 — 137건이 float) — parser.ts가 attr을 'new_float'/'new_int'/
// 'new_bool'/'new_string'/'new_color'로 재작성해 array_new_typed.pine이 이미 검증한 non-generic
// suffix 형태와 동일한 ARRAY_REGISTRY 라우팅을 탄다. 전부 리터럴 인자만 사용해 바 데이터와 무관하게
// 매 바 동일값 — string/color 원소만 compareStringToGolden(C77)이 필요하다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_new_generic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_f0_size",
  "var:__obs_f_size",
  "var:__obs_f0v",
  "var:__obs_f2v",
  "var:__obs_i0_size",
  "var:__obs_i0v",
  "var:__obs_b0_size",
  "var:__obs_b_v0",
  "var:__obs_s0_size",
  "var:__obs_push0",
];

const STRING_CHANNELS = ["var:__obs_s_v0", "var:__obs_c_v0"];

describe("oracle: array_new_generic", () => {
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
