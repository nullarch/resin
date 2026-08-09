// oracle/cases/ta_kwargs.pine: ta.sma/ema/rsi/highest/lowest/change/cum 키워드 인자(source=/length=)
// 및 위치+키워드 혼합 폼(신규, C400, next_hint(C399) 1순위)이 pine2py 골든과 바별로 일치하는지
// 검증한다 — crossover/crossunder/alma/pivotlow의 kwarg 폼은 pine2py 내부 파라미터 이름 불일치로
// 오라클 구조적 불가라 이 케이스에서 제외했다(oracle/cases/ta_kwargs.pine 헤더 주석 참조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_kwargs";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_sma_kw",
  "var:__obs_ema_mixed",
  "var:__obs_rsi_kw",
  "var:__obs_highest_kw",
  "var:__obs_lowest_kw",
  "var:__obs_change_kw",
  "var:__obs_cum_kw",
];

describe("oracle: ta_kwargs", () => {
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
