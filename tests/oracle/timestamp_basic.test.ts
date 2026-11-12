// oracle/cases/timestamp_basic.pine: timestamp() 신규 구현(C210, PROGRESS next_hint 1순위 --
// pine2py wavealgo.timestamp(*args) 2-오버로드 literal port). The golden was recorded from the
// pine2py port, which unpacked the timezone argument and never used it; TradingView reads the wall
// clock in that timezone (tier 1 base_001_time: timestamp("GMT+6", 2016, 1, 19, 9, 30) is
// 03:30 UTC), so the __obs_tz channel is no longer compared with the golden but with the real
// New York time, and the other three channels (UTC symbol, no timezone argument) still are.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "timestamp_basic";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = ["var:__obs_ymd", "var:__obs_ymdhms", "var:__obs_defaults"];

describe("oracle: timestamp_basic", () => {
  it("matches the pine2py golden bar-by-bar for the three timezone-free timestamp() channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("reads the components as the wall clock of the timezone argument", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    // 2024-01-15 12:30:45 in America/New_York (UTC-5) is 17:30:45 UTC
    expect(v.__obs_tz).toBe(1705339845000);
    expect(v.__obs_tz).toBe(v.__obs_ymdhms as number + 5 * 3600 * 1000);
    expect(v.__obs_ymd).toBe(1705276800000);
    expect(v.__obs_ymdhms).toBe(1705321845000);
    expect(v.__obs_defaults).toBe(1717232400000);
  });
});
