// oracle/cases/str_format_number.pine: str.format_number(value, format_str="") — pyFloatStr
// fallback + {idx,number,pattern}-equivalent decimal formatting reused from str.format(C110). All
// literal args (na-format_str-arg propagation is NOT covered here — pine2py itself crashes on it,
// AttributeError: 'float' object has no attribute 'find'; hand-verified in runtime.test.ts instead,
// LIMITATIONS.md).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_format_number";

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
  "var:__obs_m",
  "var:__obs_n",
];

describe("oracle: str_format_number", () => {
  it("matches the pine2py golden bar-by-bar for all fourteen channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, CHANNELS);
  });

  it("matches the pine2py golden final var state for all fourteen channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const key of ["__obs_a", "__obs_b", "__obs_c", "__obs_d", "__obs_e", "__obs_f", "__obs_g", "__obs_h", "__obs_i", "__obs_j", "__obs_k", "__obs_l", "__obs_m", "__obs_n"]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});
