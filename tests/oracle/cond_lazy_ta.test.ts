// oracle/cases/cond_lazy_ta.pine: 조건부 stateful call — 삼항/and·or lazy 위치의 eager 호이스팅
// (ROADMAP P2 "조건부 stateful call" lazy 슬라이스, C66).
//
// 오라클 유효 범위(케이스 파일 헤더 주석 참조): pine2py는 삼항/and·or를 Python lazy 구문으로
// 트랜스파일하므로 조건이 변하는 시나리오는 골든 자체가 TV-eager와 갈린다(DIVERGENCES.md #12) —
// 골든 비교는 조건이 상수인 4채널(플러밍 검증)로 한정하고, 조건이 변하는 갭 시나리오는 이 파일의
// hand-verified 트레이스(레퍼런스: rt.ta.*를 매 바 직접 호출한 값)로 검증한다(C14 'var +
// 제어문-식' 오라클 무효 케이스와 동일한 이중 구조).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";
import { ema, sma, crossover, change } from "../../src/runtime/ta";
import type { EmaState, SmaState, CrossState, ChangeState } from "../../src/runtime/ta";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_lazy_ta";
const OBS_KEYS = ["__obs_t", "__obs_f", "__obs_a", "__obs_o"] as const;

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// __obs_o is `close < 0 or ta.rsi(close, 2) > 60 ? 1.0 : 0.0`. The pine2py golden reads 1 on bar 1,
// where its rsi(close, 2) was already valid (it counted the first bar, which has no x[1], toward
// the rma seed). ref_v6_ta_math.txt "ta.rsi" seeds on the first `length` changes, so rsi(close, 2)
// is na on bar 1 and the comparison is false; PyneCore on the harness twin (resin-harness
// state/repros/mfi-rsi-warmup.json, channel rsi2: na, na, 100, 50, 83.3, 90, 94.4, 50, 82.7, 89.5)
// and tier 1 ta_211_mfi_rsi_stoch agree. That channel is asserted from the oracle.
const ORACLE_OBS_O: readonly number[] = [0, 0, 1, 0, 1, 1, 1, 0, 1, 1];

// The ternary channels of the case keep a constant condition, so they read the same under the
// lazy `?:` (only the selected branch runs) as under the old eager hoisting.
describe("oracle: cond_lazy_ta (stateful calls in ternary branches and and/or operands)", () => {
  it("matches golden bar-for-bar on all four constant-condition channels (__obs_o from the oracle)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    expect(golden.bars[1]!["var:__obs_o"]).toBe(1);
    for (let i = 0; i < golden.bars.length; i++) {
      for (const key of OBS_KEYS) {
        const expected = key === "__obs_o" ? ORACLE_OBS_O[i]! : decodeSentinel(golden.bars[i]![`var:${key}`]!);
        expect(
          nearlyEqual(result.bars[i]![`var:${key}`]!, expected),
          `bar ${i} ${key}: actual=${result.bars[i]![`var:${key}`]} golden=${expected}`,
        ).toBe(true);
      }
    }
  });

  it("matches golden finalVarState on all four channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    for (const key of OBS_KEYS) {
      expect(result.finalVarState[key]).toBeCloseTo(decodeSentinel(golden.finalVarState[key]!), 9);
    }
  });

  // ── hand-verified: 조건이 변하는 갭 시나리오(오라클 무효 구간 — DIVERGENCES.md #12) ──

  // A `?:` runs only the branch its condition selects: "only the branch corresponding to the
  // evaluated condition is calculated" (rn.txt, Pine v4); "Pine v5 evaluates all bool expressions
  // except for the ?: ternary operator strictly" (mig6.txt). The ta call in a branch advances only
  // on the bars that branch runs. PyneCore agrees (resin-harness state/repros/lang.ternary-seed-5.json:
  // `bar_index % 5 == 4 ? ta.sma(close, 2) : ...` is na on bar 4, the sma's first call). These
  // tests asserted the old eager hoisting (both branches every bar) until then.
  it("advances a ternary true-branch ema only on the bars that branch runs", () => {
    // close > 102: F F T F T T T T T T. bar2 is the ema's first call, so it is na there.
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      ["e = close > 102 ? ta.ema(close, 2) : -1.0", "var float __obs = na", "__obs := e"].join("\n"),
      data,
    );
    const st = {} as EmaState;
    for (let i = 0; i < data.close.length; i++) {
      const expected = data.close[i]! > 102 ? ema(st, data.close[i]!, 2) : -1.0;
      const actual = result.bars[i]!["var:__obs"]!;
      if (Number.isNaN(expected)) expect(actual, `bar ${i}`).toBeNaN();
      else expect(actual, `bar ${i}`).toBeCloseTo(expected, 9);
    }
    expect(result.bars[2]!["var:__obs"]).toBeNaN();
  });

  it("advances a ternary false-branch ema only on the bars the condition is false", () => {
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      ["e = close > 102 ? -1.0 : ta.ema(close, 2)", "var float __obs = na", "__obs := e"].join("\n"),
      data,
    );
    const st = {} as EmaState;
    for (let i = 0; i < data.close.length; i++) {
      const expected = data.close[i]! > 102 ? -1.0 : ema(st, data.close[i]!, 2);
      const actual = result.bars[i]!["var:__obs"]!;
      if (Number.isNaN(expected)) expect(actual, `bar ${i}`).toBeNaN();
      else expect(actual, `bar ${i}`).toBeCloseTo(expected, 9);
    }
  });

  it("advances an and-rhs crossover(+nested sma) on EVERY bar under a varying lhs (eager, hand-verified)", () => {
    // lhs(close>104)가 F인 바에도 crossover/sma 상태는 전진해야 bar8의 교차가 정확히 잡힌다.
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      [
        "c = close > 104 and ta.crossover(close, ta.sma(close, 3))",
        "var float __obs = na",
        "__obs := c ? 1.0 : 0.0",
      ].join("\n"),
      data,
    );
    const stC = {} as CrossState;
    const stS = {} as SmaState;
    for (let i = 0; i < data.close.length; i++) {
      const s = sma(stS, data.close[i]!, 3);
      const x = crossover(stC, data.close[i]!, s);
      const expected = data.close[i]! > 104 && x ? 1.0 : 0.0;
      expect(result.bars[i]!["var:__obs"], `bar ${i}`).toBeCloseTo(expected, 9);
    }
    // bar8에서만 1(lhs T && 교차) — lazy였다면 crossover가 lhs T인 바만 봐서 다른 궤적이 된다.
    expect(result.bars[8]!["var:__obs"]).toBeCloseTo(1.0, 9);
  });

  // The test above is v5 (no //@version: strict). Pine v6 short-circuits `and`/`or`: "If the first
  // expression of an or operation is true, or the first expression of an and operation is false,
  // the script does not evaluate the second expression" (rn.txt, Pine v6); a skipped ta call "is
  // not evaluated on every bar, which interferes with the internal history" it stores (mig6.txt
  // "Lazy evaluation of conditions"). PyneCore agrees: resin-harness
  // state/repros/short-circuit-and-or.json (a1-a7), lang.ternary-seed-3.json.
  it("v6: advances an and-rhs change(+nested sma) only on the bars the lhs is true", () => {
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      [
        "//@version=6",
        "indicator('t')",
        "c = close > 104 and ta.change(ta.sma(close, 2)) > 0",
        "var float __obs = na",
        "__obs := c ? 1.0 : 0.0",
      ].join("\n"),
      data,
    );
    // close > 104 on bars 5, 6, 8, 9. Called there only, the sma is na on bar 5 (its first call)
    // and the change is na on bar 6 (no previous sma): both false. Called every bar (v5), the
    // change is 1.5 and 1 there.
    const stC = {} as ChangeState;
    const stS = {} as SmaState;
    for (let i = 0; i < data.close.length; i++) {
      let expected = 0.0;
      if (data.close[i]! > 104) {
        const s = sma(stS, data.close[i]!, 2);
        expected = change(stC, s) > 0 ? 1.0 : 0.0;
      }
      expect(result.bars[i]!["var:__obs"], `bar ${i}`).toBe(expected);
    }
    expect(result.bars.map((b) => b["var:__obs"])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
  });

  it("v6: an or-rhs ta.cum counts only the bars the lhs is not true", () => {
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      [
        "//@version=6",
        "indicator('t')",
        "var float n = 0.0",
        "if close > 102 or ta.cum(1) > 100",
        "    n := n + 1",
        "c = bar_index % 2 == 0 or ta.cum(1) >= 3",
        "var float __obs = na",
        "__obs := c ? 1.0 : 0.0",
      ].join("\n"),
      data,
    );
    // The second cum runs on the odd bars only: its 1st, 2nd, 3rd calls are bars 1, 3, 5. The if
    // condition's cum (never above 100 here) leaves n counting the bars with close > 102.
    let calls = 0;
    let n = 0;
    for (let i = 0; i < data.close.length; i++) {
      if (data.close[i]! > 102) n += 1;
      expect(result.bars[i]!["var:n"], `bar ${i} n`).toBe(n);
      let expected = 1.0;
      if (i % 2 !== 0) {
        calls += 1;
        expected = calls >= 3 ? 1.0 : 0.0;
      }
      expect(result.bars[i]!["var:__obs"], `bar ${i}`).toBe(expected);
    }
    expect(result.bars[3]!["var:__obs"]).toBe(0.0);
    expect(result.bars[5]!["var:__obs"]).toBe(1.0);
  });

  it("an if-body ternary's emas advance only on the bars the if body runs and their branch is selected", () => {
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      [
        "var float __obs = na",
        "__obs := na",
        "if close > 102",
        "    __obs := close > 104 ? ta.ema(close, 2) : ta.ema(close, 2) * 1.0",
      ].join("\n"),
      data,
    );
    // Each ema call site runs on the if-true bars (close > 102) where its branch is selected.
    const stA = {} as EmaState;
    const stB = {} as EmaState;
    for (let i = 0; i < data.close.length; i++) {
      let expected = NaN;
      if (data.close[i]! > 102) {
        expected = data.close[i]! > 104 ? ema(stA, data.close[i]!, 2) : ema(stB, data.close[i]!, 2) * 1.0;
      }
      const actual = result.bars[i]!["var:__obs"]!;
      if (Number.isNaN(expected)) expect(actual, `bar ${i}`).toBeNaN();
      else expect(actual, `bar ${i}`).toBeCloseTo(expected, 9);
    }
  });
});
