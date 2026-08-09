// oracle/cases/str_transform.pine: str.lower/upper/trim/replace_all/substring/repeat — string-
// returning pure string functions. All string-literal args (na=null path is NOT covered here —
// pine2py has no None-guard for any of these and crashes, same as str_basic.pine's binary
// functions; hand-verified in runtime.test.ts instead, LIMITATIONS.md/DIVERGENCES.md #17).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_transform";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = [
  "var:__obs_lower0",
  "var:__obs_upper0",
  "var:__obs_trim0",
  "var:__obs_replall0",
  "var:__obs_replall1",
  "var:__obs_sub0",
  "var:__obs_sub1",
  "var:__obs_sub2",
  "var:__obs_sub3",
  "var:__obs_sub4",
  "var:__obs_rep0",
  "var:__obs_rep1",
  "var:__obs_rep2",
  "var:__obs_rep3",
];

describe("oracle: str_transform", () => {
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

    for (const key of ["__obs_lower0", "__obs_upper0", "__obs_trim0", "__obs_replall0", "__obs_replall1", "__obs_sub0", "__obs_sub1", "__obs_sub2", "__obs_sub3", "__obs_sub4", "__obs_rep0", "__obs_rep1", "__obs_rep2", "__obs_rep3"]) {
      const expected = golden.finalVarState[key];
      expect(result.finalVarState[key]).toBe(expected);
    }
  });
});
