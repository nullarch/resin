// oracle/cases/array_new_ctor_kwargs.pine: array.new_float/new_int/new_bool/new_string 'size='/
// 'initial_value=' 생성자 kwargs(C383, wild gate(220) 2순위 — pine2py wavealgo/builtins/array.py
// new_X(size, initial_value) 파라미터명이 Pine 키워드와 정확히 일치해 오라클 골든 대조 가능).
// 전체 키워드 폼/위치+trailing kwarg 혼합/kwarg 순서 뒤바뀜/size=만 있는 폼 4종을 커버한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_new_ctor_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a_size",
  "var:__obs_a_v0",
  "var:__obs_a_v1",
  "var:__obs_b_size",
  "var:__obs_b_v2",
  "var:__obs_c_v0",
  "var:__obs_c_v1",
  "var:__obs_d_v0",
];

const STRING_CHANNELS = ["var:__obs_e_v0"];

describe("oracle: array_new_ctor_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for numeric/bool channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for the string channel", () => {
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
