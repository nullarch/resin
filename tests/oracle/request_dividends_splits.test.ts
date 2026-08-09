// oracle/cases/request_dividends_splits.pine: request.dividends/request.splits(신규, C239
// next_hint 1순위) — pine2py wavealgo/__init__.py L122-128 request_splits/request_dividends가
// 인자 전부 무시하고 항상 0.0을 반환하는 순수 스텁이라 bar-independent(literal 인자,
// ticker_timeframe.pine 패턴과 동일).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "request_dividends_splits";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_div",
  "var:__obs_div_net",
  "var:__obs_spl",
  "var:__obs_spl_num",
  "var:__obs_div_bare",
  "var:__obs_spl_bare",
];

describe("oracle: request_dividends_splits", () => {
  it("matches the pine2py golden bar-by-bar for all six channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all six channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
