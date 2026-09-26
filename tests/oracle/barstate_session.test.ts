// oracle/cases/barstate_session.pine: barstate.*(7종)/session.*(7종) 검증(ROADMAP P2
// "barstate/session/syminfo/timeframe" 첫 슬라이스). sample10.json 10바 전 구간에서 첫/중간/마지막
// 바 분기를 모두 커버.
//
// session.isfirstbar/isfirstbar_regular/islastbar/islastbar_regular are NOT compared to the pine2py
// golden: pine2py makes them barstate.isfirst/islast (true on bar 0 / bar 9 only). TradingView reads
// "the first bar of the day's session" / "the last bar of the day's session" (ref_v6_lang.txt) on the
// symbol's session schedule (tier 1 resin-harness suites/indicators/tv/session_001_properties and
// session_002_24x7; PyneCore lib/session.py). sample10.json has no time channel and runs on resin's
// default daily chart open around the clock, so every bar holds its day's 00:00 session start and
// 23:59:59 session end: all four read true on every bar.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "barstate_session";

// The session first/last-bar channels, judged against the schedule rather than the golden.
const SESSION_BAR_KEYS = [
  "var:__obs_sess_isfirstbar",
  "var:__obs_sess_isfirstbar_regular",
  "var:__obs_sess_islastbar",
  "var:__obs_sess_islastbar_regular",
];

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: barstate_session", () => {
  it("matches the pine2py golden bar-by-bar for barstate.* and session.ismarket/ispremarket/ispostmarket", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    const keys = Object.keys(golden.bars[0]!).filter((k) => !SESSION_BAR_KEYS.includes(k));
    compareToGolden(result.bars, golden, keys);
  });

  it("reads session.isfirstbar/islastbar (and _regular) true on every bar of a daily chart open around the clock", () => {
    const result = runPipeline(loadCaseSource(CASE_NAME), loadOracleData(CASE_NAME));
    for (const key of SESSION_BAR_KEYS) {
      expect(result.bars.map((b) => b[key])).toEqual(new Array(10).fill(1));
    }
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      if (SESSION_BAR_KEYS.includes(`var:${key}`)) continue;
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });
});
