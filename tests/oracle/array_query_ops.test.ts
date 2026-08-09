// oracle/cases/array_query_ops.pine: array.abs/every/some/range/binary_search·leftmost·
// rightmost/sort_indices(C86). Reuses the sample10.json invariant (low < open < close < high on
// every bar) from array_slice_ops.pine(C85) to build deterministic sorted/na-mixed arrays without
// literal-only data — plus a few pure-literal channels (duplicate/tie handling) where bar-derived
// values can't exercise the interesting branch. All channels are numeric/bool — bool (every/some)
// coerces fine through the numeric-only compareToGolden path (JS true/false arithmetic-coerces the
// same way as array_new_typed.pine's new_bool elements did, C84).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_query_ops";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_abs0",
  "var:__obs_abs1",
  "var:__obs_abs2",
  "var:__obs_every_truthy",
  "var:__obs_some_truthy",
  "var:__obs_every_zero",
  "var:__obs_some_zero",
  "var:__obs_every_na",
  "var:__obs_some_na",
  "var:__obs_every_allfalsy",
  "var:__obs_some_allfalsy",
  "var:__obs_range",
  "var:__obs_range_allna",
  "var:__obs_bsearch_found",
  "var:__obs_bsearch_missing",
  "var:__obs_bsearch_left",
  "var:__obs_bsearch_right",
  "var:__obs_dup_search",
  "var:__obs_dup_left",
  "var:__obs_dup_right",
  "var:__obs_si_asc0",
  "var:__obs_si_asc1",
  "var:__obs_si_asc2",
  "var:__obs_si_asc3",
  "var:__obs_si_desc0",
  "var:__obs_si_desc1",
  "var:__obs_tie_asc0",
  "var:__obs_tie_asc1",
  "var:__obs_tie_desc0",
  "var:__obs_tie_desc1",
];

describe("oracle: array_query_ops", () => {
  it("matches the pine2py golden bar-by-bar", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMERIC_CHANNELS);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // NaN-valued channels (__obs_abs2/__obs_range_allna) encode as the "NaN" sentinel string in
    // golden — a raw .toBe() fails (NaN !== "NaN"), so compare those explicitly (established
    // array_basic/residual/stats precedent) and use .toBe() for the rest.
    for (const key of Object.keys(golden.finalVarState)) {
      if (golden.finalVarState[key] === "NaN") {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
        continue;
      }
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
