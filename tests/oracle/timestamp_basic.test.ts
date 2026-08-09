// oracle/cases/timestamp_basic.pine: timestamp() 신규 구현(C210, PROGRESS next_hint 1순위 --
// pine2py wavealgo.timestamp(*args) 2-오버로드 literal port). tz_str 오버로드가 tz를 완전히 무시하고
// 항상 UTC로 계산됨(__obs_tz === __obs_ymdhms)과 h/mi/s 기본값(0)을 함께 검증한다.

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

const NUMERIC_CHANNELS = ["var:__obs_ymd", "var:__obs_ymdhms", "var:__obs_tz", "var:__obs_defaults"];

describe("oracle: timestamp_basic", () => {
  it("matches the pine2py golden bar-by-bar for all four timestamp() channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, NUMERIC_CHANNELS);
  });

  it("ignores the timezone string argument (always computes as UTC, matching pine2py)", () => {
    const source = loadCaseSource(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(source, data);
    const v = result.finalVarState;

    expect(v.__obs_tz).toBe(v.__obs_ymdhms);
    expect(v.__obs_ymd).toBe(1705276800000);
    expect(v.__obs_ymdhms).toBe(1705321845000);
    expect(v.__obs_defaults).toBe(1717232400000);
  });
});
