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
import { ema, sma, crossover } from "../../src/runtime/ta";
import type { EmaState, SmaState, CrossState } from "../../src/runtime/ta";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_lazy_ta";
const OBS_KEYS = ["__obs_t", "__obs_f", "__obs_a", "__obs_o"] as const;

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: cond_lazy_ta (stateful calls in ternary/and/or lazy positions, eager-hoisted)", () => {
  it("matches golden bar-for-bar on all four constant-condition channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    for (let i = 0; i < golden.bars.length; i++) {
      for (const key of OBS_KEYS) {
        const expected = decodeSentinel(golden.bars[i]![`var:${key}`]!);
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

  it("advances a ternary true-branch ema on EVERY bar even when the condition interleaves (eager, hand-verified)", () => {
    // close > 102: F F T F T T T T T T. TV-eager(=pine2js)는 ema(close,2)를 매 바 호출한다 —
    // 스모킹 건은 bar2: lazy(호출된 바에서만 전진)였다면 bar2가 첫 호출이라 NaN이어야 하지만,
    // eager는 bar1에서 이미 시드가 끝나 bar2 = 102.5가 나온다.
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      ["e = close > 102 ? ta.ema(close, 2) : -1.0", "var float __obs = na", "__obs := e"].join("\n"),
      data,
    );
    const st = {} as EmaState;
    for (let i = 0; i < data.close.length; i++) {
      const v = ema(st, data.close[i]!, 2); // 레퍼런스: 매 바 무조건 호출(eager)
      const expected = data.close[i]! > 102 ? v : -1.0;
      const actual = result.bars[i]!["var:__obs"]!;
      if (Number.isNaN(expected)) expect(actual, `bar ${i}`).toBeNaN();
      else expect(actual, `bar ${i}`).toBeCloseTo(expected, 9);
    }
    // bar2 = 102.5(eager 시드 완료)를 명시 고정 — lazy였다면 NaN(첫 호출 워밍업).
    expect(result.bars[2]!["var:__obs"]).toBeCloseTo(102.5, 9);
  });

  it("advances a ternary false-branch ema on bars where the condition is TRUE too (eager, hand-verified)", () => {
    // 반대 방향: false 분기의 ema는 조건이 true인 바에도 상태가 전진해야 한다.
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      ["e = close > 102 ? -1.0 : ta.ema(close, 2)", "var float __obs = na", "__obs := e"].join("\n"),
      data,
    );
    const st = {} as EmaState;
    for (let i = 0; i < data.close.length; i++) {
      const v = ema(st, data.close[i]!, 2);
      const expected = data.close[i]! > 102 ? -1.0 : v;
      const actual = result.bars[i]!["var:__obs"]!;
      if (Number.isNaN(expected)) expect(actual, `bar ${i}`).toBeNaN();
      else expect(actual, `bar ${i}`).toBeCloseTo(expected, 9);
    }
    // bar3(조건 F, close=102): eager로 bar0~3 네 번 호출된 값 102.5 - 1/3 = 102.1666...이어야
    // 한다(lazy였다면 F 바인 bar0/1/3만 호출돼 다른 궤적).
    expect(result.bars[3]!["var:__obs"]).toBeCloseTo(102.5 - 1 / 3, 9);
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

  it("keeps per-call semantics for the owning statement: an if-body ternary's hoisted ema advances only on if-true bars", () => {
    // 호이스팅은 문장 직전(같은 블록 안)이므로 if 분기 본문의 per-call 시맨틱(C64)은 유지된다:
    // if 조건이 F인 바에는 삼항 양쪽 모두 호출되지 않아야 한다.
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
    // 레퍼런스: 두 ema 콜사이트 모두 if-true 바(close>102: bar2,4,5,6,7,8,9)에서만 호출(eager로
    // 양쪽 다), 내부 삼항 조건과 무관.
    const stA = {} as EmaState;
    const stB = {} as EmaState;
    for (let i = 0; i < data.close.length; i++) {
      let expected = NaN;
      if (data.close[i]! > 102) {
        const a = ema(stA, data.close[i]!, 2);
        const b = ema(stB, data.close[i]!, 2);
        expected = data.close[i]! > 104 ? a : b * 1.0;
      }
      const actual = result.bars[i]!["var:__obs"]!;
      if (Number.isNaN(expected)) expect(actual, `bar ${i}`).toBeNaN();
      else expect(actual, `bar ${i}`).toBeCloseTo(expected, 9);
    }
  });
});
