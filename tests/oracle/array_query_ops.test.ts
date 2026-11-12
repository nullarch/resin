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

// Three channels (bsearch_right, dup_search, dup_right) are not decided by the golden any more:
// pine2py (not ground truth) answered bisect_right for a hit (the slot AFTER the value) and
// bisect_left for the plain search of a run of duplicates. TradingView answers the last duplicate
// for rightmost and the slot the halving lands on for binary_search (tier 1 array_002_array_functions
// for the miss; the oracle's TradingView probe notes, test_014_binary_search_bounds, for a hit). They
// are asserted by hand below.
const HAND_VERIFIED = new Set(["__obs_bsearch_right", "__obs_dup_search", "__obs_dup_right"]);

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
  "var:__obs_dup_left",
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
      if (HAND_VERIFIED.has(key)) continue;
      if (golden.finalVarState[key] === "NaN") {
        expect(Number.isNaN(result.finalVarState[key])).toBe(true);
        continue;
      }
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
  // arrSorted = [low, open, close, high], searched for close (slot 2, no duplicate): a hit answers
  // its own index for all three searches. arrDup = [1, 3, 3, 3, 7] searched for 3: the halving lands
  // on slot 2, leftmost is the first duplicate (1) and rightmost the last (3).
  it("binary searches answer the index of a hit, the last duplicate for rightmost (hand-verified)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (let i = 0; i < data.close.length; i++) {
      const bar = result.bars[i]!;
      expect(bar["var:__obs_bsearch_right"], `bar ${i} bsearch_right`).toBe(2);
      expect(bar["var:__obs_dup_search"], `bar ${i} dup_search`).toBe(2);
      expect(bar["var:__obs_dup_right"], `bar ${i} dup_right`).toBe(3);
    }
  });
});
