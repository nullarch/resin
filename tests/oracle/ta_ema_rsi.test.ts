// oracle/cases/ta_ema_rsi.pine: ta.ema(close,3)/ta.rsi(close,3) 검증(ROADMAP P1 "Oracle: SMA/EMA/RSI
// 3종" — SMA는 smoke_var_sma.test.ts에서 이미 검증됨). length=3이라 sample10.json 10바 안에서
// 초기화 구간(NaN)과 정상 구간을 모두 커버한다.
//
// The ema channel is still read from the pine2py golden. The rsi channel is not: pine2py counted
// the first bar (which has no x[1]) toward the rma seed, so its rsi(close, 3) started on bar 2 with
// two changes divided by 3. The manual's reference (ref_v6_ta_math.txt "ta.rsi": u =
// math.max(x - x[1], 0), d = math.max(x[1] - x, 0), ta.rma of each, and "`na` values in the
// `source` series are ignored") seeds the rmas on the first `length` changes, so the first value
// lands on bar `length`. TradingView agrees (tier 1 resin-harness suites/indicators/tv/
// ta_211_mfi_rsi_stoch: rsi(close, 14) na on bar 13, 35.699373695 on bar 14), and so does the
// PyneCore oracle on the harness twin of this case (state/repros/mfi-rsi-warmup.json, channel
// rsi3), whose values are asserted below.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, decodeSentinel, loadGolden, loadOracleData, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_ema_rsi";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore, sample10.json, ta.rsi(close, 3).
const RSI3_SAMPLE10: readonly number[] = [
  NaN, NaN, NaN, 66.66666666666666, 83.33333333333333, 87.87878787878788, 91.3978494623656, 63.670411985018724,
  80.98039215686275, 85.98772119898881,
];

describe("oracle: ta_ema_rsi", () => {
  it("the pine2py golden (not ground truth) reports rsi on bar 2, one bar before the rma seed holds `length` changes", () => {
    const golden = loadGolden(CASE_NAME);
    expect(decodeSentinel(golden.bars[2]!["var:__obs_rsi"]!)).toBe(100);
    expect(decodeSentinel(golden.bars[3]!["var:__obs_rsi"]!)).toBeCloseTo(57.1428571429, 9);
    expect(RSI3_SAMPLE10[2]).toBeNaN();
  });

  it("matches the pine2py golden bar-by-bar for ta.ema", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_ema"]);
  });

  it("matches the PyneCore oracle bar-by-bar for ta.rsi", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(RSI3_SAMPLE10.length);
    for (let i = 0; i < RSI3_SAMPLE10.length; i++) {
      const actual = result.bars[i]!["var:__obs_rsi"]!;
      expect(nearlyEqual(actual, RSI3_SAMPLE10[i]!), `bar ${i}: actual=${actual} oracle=${RSI3_SAMPLE10[i]}`).toBe(true);
    }
  });

  it("matches the final var state (ema from the golden, rsi from the oracle)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.finalVarState["__obs_ema"]).toBeCloseTo(golden.finalVarState["__obs_ema"] as number, 6);
    expect(result.finalVarState["__obs_rsi"]).toBeCloseTo(RSI3_SAMPLE10[9]!, 9);
  });
});
