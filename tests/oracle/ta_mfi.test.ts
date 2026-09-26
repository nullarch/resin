// oracle/cases/ta_mfi.pine: ta.mfi(close, 3) on sample10.json, covering the warm-up and the valid
// range inside 10 bars.
//
// The golden in oracle/golden/ta_mfi.json is pine2py's, and pine2py skipped the first bar (no
// previous source, no money flow) so its first value landed on bar 3. That is not ground truth:
// the manual's reference (ref_v6_ta_math.txt "ta.mfi": `math.sum(volume * (ta.change(src) <= 0.0 ?
// 0.0 : src), length)` and its mirror) puts the first bar's money flow in BOTH sums, because its
// ta.change is na and both comparisons are false, so the first value lands on bar length - 1.
// TradingView agrees (tier 1 resin-harness suites/indicators/tv/ta_211_mfi_rsi_stoch: mfi(close, 14)
// is 46.173185267 on bar 13), and so does the PyneCore oracle on the harness twin of this case
// (resin-harness state/repros/mfi-rsi-warmup.json, channel mfi3), whose values are asserted below.
// From bar 3 on the window no longer holds bar 0 and the golden agrees with the oracle.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_mfi";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json, ta.mfi(close, 3).
const MFI3_SAMPLE10: readonly number[] = [
  NaN, NaN, 76.9301050708086, 66.77994902293969, 68.81148630683329, 69.43322475570032, 100, 66.36212624584718,
  68.54543437257294, 69.10755148741418,
];

describe("oracle: ta_mfi", () => {
  it("the pine2py golden (not ground truth) is NaN on bar 2, where the first bar's money flow already counts", () => {
    const golden = loadGolden(CASE_NAME);
    expect(golden.bars[2]!["var:__obs_mfi"]).toBe("NaN");
    expect(MFI3_SAMPLE10[2]).toBeCloseTo(76.9301050708086, 9);
    for (let i = 3; i < golden.bars.length; i++) {
      expect(nearlyEqual(decodeSentinel(golden.bars[i]!["var:__obs_mfi"]!), MFI3_SAMPLE10[i]!), `bar ${i}`).toBe(true);
    }
  });

  it("matches the PyneCore oracle bar-by-bar for ta.mfi", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(MFI3_SAMPLE10.length);
    for (let i = 0; i < MFI3_SAMPLE10.length; i++) {
      const actual = result.bars[i]!["var:__obs_mfi"]!;
      expect(nearlyEqual(actual, MFI3_SAMPLE10[i]!), `bar ${i}: actual=${actual} oracle=${MFI3_SAMPLE10[i]}`).toBe(true);
    }
  });

  it("matches the PyneCore oracle final var state", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_mfi"]).toBeCloseTo(MFI3_SAMPLE10[9]!, 9);
  });
});
