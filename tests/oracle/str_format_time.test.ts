// oracle/cases/str_format_time.pine: str.format_time(time_ms, format_str="yyyy-MM-dd'T'HH:mm:ssZ",
// timezone="") — Pine format token replace chain (yyyy/yy/MMMM/MMM/MM/dd/HH/hh/mm/ss/'T'/Z) reused
// via JS Date getUTC* values. All literal args (three combinations are NOT covered here because
// pine2py itself crashes generating the golden — +/-Infinity time_ms, a negative time_ms before
// ~2 hours prior to epoch on this Windows/Python 3.11 env, and format_str=na when time_ms is not
// NaN; hand-verified in runtime.test.ts instead, LIMITATIONS.md/DIVERGENCES.md).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_format_time";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_a",
  "var:__obs_b",
  "var:__obs_c",
  "var:__obs_d",
  "var:__obs_e",
  "var:__obs_f",
  "var:__obs_g",
  "var:__obs_h",
  "var:__obs_i",
  "var:__obs_j",
  "var:__obs_k",
  "var:__obs_l",
];

describe("oracle: str_format_time", () => {
  it("matches the pine2py golden bar-by-bar for all twelve channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all twelve channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_a", "__obs_b", "__obs_c", "__obs_d", "__obs_e", "__obs_f", "__obs_g", "__obs_h", "__obs_i", "__obs_j", "__obs_k", "__obs_l"]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});
