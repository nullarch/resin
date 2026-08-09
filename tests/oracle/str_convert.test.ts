// oracle/cases/str_convert.pine: str.tostring/str.tonumber (C87). Unlike most other str.*
// functions, pine2py's tostring/tonumber both have explicit None/exception guards (str_funcs.py
// L26-27, L56-58) so na inputs do NOT crash pine2py — na coverage is included directly here (no
// hand-verified fallback needed).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareStringToGolden, compareToGolden, decodeSentinel, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "str_convert";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const STRING_CHANNELS = [
  "var:__obs_ts0",
  "var:__obs_ts1",
  "var:__obs_ts2",
  "var:__obs_ts3",
  "var:__obs_ts4",
  "var:__obs_ts5",
  "var:__obs_ts6",
  "var:__obs_ts7",
  "var:__obs_ts8",
  "var:__obs_ts9",
  "var:__obs_ts10",
  "var:__obs_ts11",
  "var:__obs_ts12",
  "var:__obs_ts13",
  "var:__obs_ts14",
  "var:__obs_ts15",
];

const NUMBER_CHANNELS = [
  "var:__obs_tn0",
  "var:__obs_tn1",
  "var:__obs_tn2",
  "var:__obs_tn3",
  "var:__obs_tn4",
  "var:__obs_tn5",
  "var:__obs_tn6",
  "var:__obs_tn7",
  "var:__obs_tn8",
  "var:__obs_tn9",
];

describe("oracle: str_convert", () => {
  it("matches the pine2py golden bar-by-bar for str.tostring channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareStringToGolden(result.bars as unknown as Record<string, string | null>[], golden, STRING_CHANNELS);
  });

  it("matches the pine2py golden bar-by-bar for str.tonumber channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, NUMBER_CHANNELS);
  });

  it("matches the pine2py golden final var state for all twenty-six channels", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // tostring channels (incl. __obs_ts3's literal "NaN" string) compare as plain strings — the
    // golden sentinel and our result are the *same literal string*, not a numeric NaN encoding.
    for (const key of STRING_CHANNELS.map((k) => k.slice("var:".length))) {
      expect(result.finalVarState[key]).toBe(golden.finalVarState[key]);
    }
    // tonumber channels may be numeric-NaN/Infinity sentinels (decodeSentinel, golden.ts) — decode
    // both sides before comparing (established array_query_ops.test.ts precedent, extended to inf).
    for (const key of NUMBER_CHANNELS.map((k) => k.slice("var:".length))) {
      const expected = decodeSentinel(golden.finalVarState[key] as number | string);
      const actual = result.finalVarState[key] as number;
      if (Number.isNaN(expected)) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        expect(actual).toBe(expected);
      }
    }
  });
});
