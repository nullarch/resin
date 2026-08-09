// oracle/cases/str_split.pine: str.split(source, separator) — reduces array<string> results to
// observable scalar channels via array.size(numeric)/array.get(string) (str_transform.pine pattern
// extended to array-returning str.* functions). na channels (source/separator=na, separator="") are
// NOT covered here — hand-verified in runtime.test.ts instead (DIVERGENCES.md 신규).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_split";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const SIZE_CHANNELS = ["var:__obs_a_size", "var:__obs_b_size", "var:__obs_c_size", "var:__obs_d_size", "var:__obs_e_size", "var:__obs_f_size"];
const STRING_CHANNELS = [
  "var:__obs_a0",
  "var:__obs_a2",
  "var:__obs_b1",
  "var:__obs_c0",
  "var:__obs_c2",
  "var:__obs_d0",
  "var:__obs_e0",
  "var:__obs_f0",
  "var:__obs_f1",
  "var:__obs_f2",
];

describe("oracle: str_split", () => {
  it("matches the pine2py golden bar-by-bar for size channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars as unknown as Record<string, number>[], golden, SIZE_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for string element channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden final var state for all sixteen channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_a_size", "__obs_b_size", "__obs_c_size", "__obs_d_size", "__obs_e_size", "__obs_f_size"]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
    for (const key of ["__obs_a0", "__obs_a2", "__obs_b1", "__obs_c0", "__obs_c2", "__obs_d0", "__obs_e0", "__obs_f0", "__obs_f1", "__obs_f2"]) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
