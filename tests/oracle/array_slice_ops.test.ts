// oracle/cases/array_slice_ops.pine: array.sort/reverse/slice/concat/copy(C85). sample10.json's
// invariant (low < open < close < high on every bar, no ties) makes sort/reverse fully
// deterministic bar-by-bar without needing literal-only data. order.ascending/descending(compile
// -time boolean constants) and slice's index_to<0 full-length sentinel are exercised directly.
// All channels are numeric (no string/color elements involved) — a single compareToGolden pass
// covers everything, unlike array_new_typed/array_search which needed a parallel string channel.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "array_slice_ops";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const NUMERIC_CHANNELS = [
  "var:__obs_a0",
  "var:__obs_a3",
  "var:__obs_b0",
  "var:__obs_b3",
  "var:__obs_c0",
  "var:__obs_c3",
  "var:__obs_d_size",
  "var:__obs_d0",
  "var:__obs_d1",
  "var:__obs_d2_size",
  "var:__obs_d2_last",
  "var:__obs_dall_size",
  "var:__obs_e_size",
  "var:__obs_e0",
  "var:__obs_e3",
  "var:__obs_f_copy_size",
  "var:__obs_f_src_size",
  "var:__obs_f_copy2",
];

describe("oracle: array_slice_ops", () => {
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

    for (const key of Object.keys(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
  });
});
