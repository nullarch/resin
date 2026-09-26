// oracle/cases/cond_loop_ta.pine: stateful calls in loop bodies (for/while, a `continue`, and a
// per-bar iteration count that alternates 2,1,2,1,...).
//
// The rule (tier 2, certified against TradingView): a call site in a loop body keeps ONE state,
// and every execution on one bar re-derives from the state the bar started with; the state carried
// to the next bar is the last execution's. PyneCore core/instance_state.py `__loop_state__`
// ("the builtin machines in the callee's subtree are rolled back to their bar-start state before
// every same-bar re-execution"); tier 1 ta_373_sma_loop_shared_window (ta.sma in a for loop,
// 260/260 TradingView bars). With the same arguments on every iteration, a loop call site therefore
// reads exactly what the straight-line call reads, however many times the loop runs on a bar.
//
// The golden in oracle/golden/cond_loop_ta.json is pine2py's, and pine2py advanced the state once
// per iteration (C161). That is not ground truth: the harness twin of this case (same bars,
// sample10) run by PyneCore gives the values asserted below, and resin matches it on every bar.
// Only the golden's `flag` channel, which has no stateful call, is still read from it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_loop_ta";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// PyneCore on the harness twin of this case (close = 101, 102, 103, 102, 104, 105, 106, 105, 107,
// 108): each channel is the straight-line ema of its length.
const ORACLE: Record<"__obs_a" | "__obs_b" | "__obs_c" | "__obs_d", readonly number[]> = {
  // ema(close, 3), two iterations per bar
  __obs_a: [NaN, NaN, 102, 102, 103, 104, 105, 105, 106, 107],
  // ema(close, 5), while loop, two iterations per bar
  __obs_b: [
    NaN, NaN, NaN, NaN, 102.4, 103.26666666666668, 104.17777777777779, 104.45185185185187, 105.30123456790125,
    106.20082304526751,
  ],
  // ema(close, 4), for loop skipping i == 1 with continue
  __obs_c: [NaN, NaN, NaN, 102, 102.8, 103.68, 104.608, 104.7648, 105.65888, 106.595328],
  // ema(close, 2), 2,1,2,1,... iterations per bar
  __obs_d: [
    NaN, 101.5, 102.5, 102.16666666666667, 103.38888888888889, 104.46296296296296, 105.48765432098764,
    105.16255144032922, 106.38751714677642, 107.46250571559214,
  ],
};
const OBS_CHANNELS = ["__obs_a", "__obs_b", "__obs_c", "__obs_d"] as const;

describe("oracle: cond_loop_ta (stateful calls in for/while loop bodies, bar-start rollback per execution)", () => {
  it("pine2py's golden advanced the ema once per loop iteration (the per-call model the tier-2 oracle contradicts)", () => {
    const golden = loadGolden(CASE_NAME);
    // pine2py: ema(close,3) twice per bar seeds on its 3rd call (bar 1) and steps once more.
    expect(golden.bars[0]!["var:__obs_a"]).toBe("NaN");
    expect(decodeSentinel(golden.bars[1]!["var:__obs_a"]!)).toBeCloseTo(101.66666666666667, 9);
    // PyneCore: one step per bar, so bar 1 is still warming up.
    expect(ORACLE.__obs_a[1]).toBeNaN();
  });

  it("matches the tier-2 oracle bar-for-bar on all four loop channels (flag from the golden)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    for (let i = 0; i < golden.bars.length; i++) {
      for (const ch of OBS_CHANNELS) {
        const expected = ORACLE[ch][i]!;
        expect(
          nearlyEqual(result.bars[i]![`var:${ch}`]!, expected),
          `bar ${i} ${ch}: actual=${result.bars[i]![`var:${ch}`]} oracle=${expected}`,
        ).toBe(true);
      }
      const flag = decodeSentinel(golden.bars[i]!["var:flag"]!);
      expect(nearlyEqual(result.bars[i]!["var:flag"]!, flag), `bar ${i} flag`).toBe(true);
    }
  });

  it("re-derives a fixed 2-iteration for-loop ema from the bar-start state (one step per bar)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // ema(close,3), alpha=0.5: seeded on bar 2 by (101+102+103)/3, then one step per bar even
    // though the loop body runs twice.
    for (let i = 0; i < ORACLE.__obs_a.length; i++) {
      const e = ORACLE.__obs_a[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_a"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_a"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("advances a variable-iteration for-loop ema at one step per bar whatever the iteration count (2,1,2,1,...)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // ema(close,2), alpha=2/3: seeded on bar 1 by (101+102)/2 = 101.5, then one step per bar.
    for (let i = 0; i < ORACLE.__obs_d.length; i++) {
      const e = ORACLE.__obs_d[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_d"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_d"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("matches the tier-2 oracle's final value on all channels (flag from the golden)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    for (const ch of OBS_CHANNELS) {
      expect(result.finalVarState[ch], ch).toBeCloseTo(ORACLE[ch][ORACLE[ch].length - 1]!, 9);
    }
    expect(result.finalVarState.flag, "flag").toBeCloseTo(decodeSentinel(golden.finalVarState.flag!), 9);
  });
});
