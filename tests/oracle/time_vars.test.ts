// oracle/cases/time_vars.pine + time_vars_no_channel.pine: TV 시각 변수(time/year/month/
// dayofmonth/dayofweek/hour/minute/second/time_tradingday/last_bar_index/last_bar_time,
// C242 — ROADMAP P3 next_hint 1순위) 신규 지원. pine2py wavealgo/context.py
// Context.time/_datetime_component/time_tradingday를 UTC 고정으로 literal port
// (runtime/datetime.ts). time_vars.json은 sample10 OHLCV + 다양한 요일/윤년/연도경계/시각을
// 덮는 커스텀 time[] 배열(월~일 전 요일, 2024-02-29 윤년, 2023-12-31/2024-01-01 연도경계 포함).
// time_vars_no_channel.pine은 sample10.json(time 채널 없음)으로 "시간 데이터가 없으면 전부 0"
// 폴백(pine2py Context.time이 _time_data 비어있을 때 0을 반환하는 것과 동형, ta.vwap C59와
// 동일한 "양쪽 다 없는 인프라" 원칙)을 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: time_vars (TV 시각 변수, time[] 채널 있음)", () => {
  const CASE_NAME = "time_vars";

  it("matches the pine2py golden bar-by-bar across weekday/leap-day/year-boundary timestamps", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    expect(data.time).toBeDefined();
    expect(data.time).toHaveLength(10);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});

describe("oracle: time_vars_no_channel (time[] 채널 없음 -> 전부 0 폴백)", () => {
  const CASE_NAME = "time_vars_no_channel";

  it("matches the pine2py golden bar-by-bar (all-zero fallback, last_bar_index unaffected)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    expect(data.time).toBeUndefined();

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
    for (const bar of result.bars) {
      expect(bar["var:__obs_time"]).toBe(0);
      expect(bar["var:__obs_year"]).toBe(0);
      expect(bar["var:__obs_dayofweek"]).toBe(0);
      expect(bar["var:__obs_hour"]).toBe(0);
      expect(bar["var:__obs_time_tradingday"]).toBe(0);
      expect(bar["var:__obs_last_bar_index"]).toBe(9);
      expect(bar["var:__obs_last_bar_time"]).toBe(0);
    }
  });
});
