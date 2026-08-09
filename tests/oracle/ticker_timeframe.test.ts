// oracle/cases/ticker_timeframe.pine: ticker.new/standard/modify/heikinashi/renko/kagi/linebreak/
// pointfigure(8종, 문자열 채널) + timeframe.change(bool 채널) — C235. pine2py wavealgo/__init__.py
// 전부가 순수 문자열 pass-through/접합 + timeframe_change 상수 반환이라 bar-independent(literal
// 인자, str_basic.pine/str_convert.pine 패턴과 동일).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ticker_timeframe";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = [
  "var:__obs_new0",
  "var:__obs_new1",
  "var:__obs_new2",
  "var:__obs_std",
  "var:__obs_mod",
  "var:__obs_ha",
  "var:__obs_renko",
  "var:__obs_kagi",
  "var:__obs_lb",
  "var:__obs_pf",
];

const BOOL_CHANNELS = ["var:__obs_tf0", "var:__obs_tf1"];

describe("oracle: ticker_timeframe", () => {
  it("matches the pine2py golden bar-by-bar for ticker.* string channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for timeframe.change bool channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, BOOL_CHANNELS);
  });

  it("matches the pine2py golden final var state for all twelve channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of STRING_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
    for (const key of BOOL_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
