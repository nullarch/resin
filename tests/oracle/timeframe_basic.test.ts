// oracle/cases/timeframe_basic.pine: timeframe.* 9종+main_period(ROADMAP P2 "barstate/session/
// syminfo/timeframe" 세 번째(마지막) 슬라이스) + in_seconds/from_seconds 정적 함수 — 9개 속성은
// syminfo.*와 동일하게 바 데이터와 무관한 컴파일타임 상수. in_seconds/from_seconds는 pine2py
// codegen.py 함수-이름 매핑 테이블이 실제로 라우팅하는 wa.timeframe_in_seconds/from_seconds
// (wavealgo/__init__.py)가 대조 대상 — Timeframe 클래스 staticmethod와는 값이 다르다(runtime.test.ts
// 주석 참조). 문자열/숫자 채널로 갈려 compareStringToGolden/compareToGolden을 onlyKeys로 나눠 적용.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "timeframe_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = [
  "var:__obs_period",
  "var:__obs_main_period",
  "var:__obs_from_seconds_60",
  "var:__obs_from_seconds_86400",
  "var:__obs_from_seconds_30",
  "var:__obs_from_seconds_604800",
  "var:__obs_from_seconds_2592000",
  "var:__obs_from_seconds_0",
];

const NUMBER_CHANNELS = [
  "var:__obs_multiplier",
  "var:__obs_isseconds",
  "var:__obs_isminutes",
  "var:__obs_isintraday",
  "var:__obs_isdaily",
  "var:__obs_isweekly",
  "var:__obs_ismonthly",
  "var:__obs_isdwm",
  "var:__obs_in_seconds_d",
  "var:__obs_in_seconds_w",
  "var:__obs_in_seconds_m",
  "var:__obs_in_seconds_60",
  "var:__obs_in_seconds_5",
  "var:__obs_in_seconds_1w",
  "var:__obs_in_seconds_empty",
];

describe("oracle: timeframe_basic", () => {
  it("matches the pine2py golden bar-by-bar for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
    compareToGolden(result.bars, golden, NUMBER_CHANNELS);
  });

  it("matches the pine2py golden final var state for all channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBe(golden.finalVarState[name]);
    }
    for (const key of NUMBER_CHANNELS) {
      const name = key.slice("var:".length);
      expect(result.finalVarState[name]).toBeCloseTo(golden.finalVarState[name] as number, 6);
    }
  });
});
