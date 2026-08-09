// oracle/cases/array_search.pine: array.includes/indexof/lastindexof (C82) — array.* 검색류,
// C79/80/81이 확정한 stateless builtinCalls 패턴의 계속된 기계적 확장. 채널 A(리터럴 배열,
// found/missing), 채널 B(중복값 — indexof는 첫 매치, lastindexof는 마지막 매치), 채널 C(bar
// series 값), 채널 D(na 원소가 섞인 배열 — na 리터럴 검색은 "정상"(non-identity) 케이스라 양쪽
// 다 not-found로 일치, na 원소가 index 넘버링에 영향 없음도 함께 확인). NaN 검색값의 CPython
// identity-reuse divergence(array.get()로 읽어온 na를 그대로 되검색하는 경우만 Python이 True를
// 주는 예외)는 오라클로 검증 불가(이 케이스를 넣으면 골든과 실제로 값이 갈림) — runtime.test.ts
// hand-verified로 대체(DIVERGENCES.md #22).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_search";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_a_inc_found",
  "var:__obs_a_inc_missing",
  "var:__obs_a_idx_found",
  "var:__obs_a_idx_missing",
  "var:__obs_b_first",
  "var:__obs_b_last",
  "var:__obs_b_last_missing",
  "var:__obs_c_inc_found",
  "var:__obs_c_inc_missing",
  "var:__obs_c_idx_found",
  "var:__obs_d_inc_na",
  "var:__obs_d_idx_na",
  "var:__obs_d_idx_high",
];

const FINAL_KEYS = [
  "__obs_a_inc_found",
  "__obs_a_inc_missing",
  "__obs_a_idx_found",
  "__obs_a_idx_missing",
  "__obs_b_first",
  "__obs_b_last",
  "__obs_b_last_missing",
  "__obs_c_inc_found",
  "__obs_c_inc_missing",
  "__obs_c_idx_found",
  "__obs_d_inc_na",
  "__obs_d_idx_na",
  "__obs_d_idx_high",
];

describe("oracle: array_search", () => {
  it("matches the pine2py golden bar-by-bar for all thirteen channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all thirteen channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of FINAL_KEYS) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });

  it("indexof finds the first match, lastindexof finds the last match", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_b_first"]).toBe(0);
    expect(result.finalVarState["__obs_b_last"]).toBe(2);
  });

  it("a na element does not shift index numbering for a later found value", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_d_idx_high"]).toBe(2);
  });
});
