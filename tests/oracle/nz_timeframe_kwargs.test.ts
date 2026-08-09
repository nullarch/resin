// oracle/cases/nz_timeframe_kwargs.pine: nz(replacement=)/timeframe.in_seconds(timeframe=) kwargs
// 신규 지원(C405, next_hint(C404) 1순위). nz는 replacement=만 오라클 가능(pine2py 실제 파라미터명이
// 'value'라 source=는 이름 불일치로 TypeError -- codegen.test.ts의 hand-verified 동치성 테스트가
// 대체). timeframe.in_seconds는 pine2py 실제 파라미터명이 정확히 'timeframe'이라 완전 키워드
// 폼까지 오라클 가능.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "nz_timeframe_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_nz_replacement_kw",
  "var:__obs_nz_replacement_kw_passthrough",
  "var:__obs_tf_in_seconds_kw_d",
  "var:__obs_tf_in_seconds_kw_empty",
];

describe("oracle: nz_timeframe_kwargs", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(nearlyEqual(result.finalVarState[key]!, decodeSentinel(golden.finalVarState[key]!))).toBe(true);
    }
  });
});
