import { describe, it, expect } from "vitest";
import { Series, histGet, RefSeries, refHistGet } from "../../src/runtime/series";
import { Context } from "../../src/runtime/context";
import { sma, ema, rsi, rma, wma, alma, hma, dema, linreg, vwma, swma, crossover, crossunder, cross, fixnan, cmo, cci, change, roc, rising, falling, variance, stdev, cum, cumMax, cumMin, barssince, valuewhen, highest, lowest, highestVarLen, lowestVarLen, smaVarLen, highestbars, lowestbars, highestbarsVarLen, lowestbarsVarLen, medianVarLen, linregVarLen, wmaVarLen, stdevVarLen, sumVarLen, stoch, wpr, mfi, cog, correlation, tsi, macd, bb, bbw, tr, atr, kc, kcw, obv, accdist, pvt, wad, nvi, pvi, wvad, iii, ao, vwap, pivothigh, pivotlow, pivothighVarLen, pivotlowVarLen, supertrend, sar, dmi, sum, median, mode, percentrank, dev, rci, random, range, rangeVarLen, percentileNearestRank, percentileLinearInterpolation, percentileNearestRankVarLen, percentileLinearInterpolationVarLen, vwmaVarLen } from "../../src/runtime/ta";
import { na, pineNot, pineLt, pineGt, pineLe, pineGe, pineAnd, pineOr, pineDiv, pineMod, idiv, barIndexHistory, histConst, round, round_to_mintick, abs, max, min, clamp, avg, floor, ceil, sqrt, pow, log, log10, exp, sign, sin, cos, tan, asin, acos, atan, atan2, todegrees, toradians, nz, concat, udtCopy } from "../../src/runtime/numeric";
import { length, contains, startswith, endswith, pos, lower, upper, trim, replace_all, replace, substring, repeat, split, match, format, format_number, format_time, tonumber, tostring } from "../../src/runtime/str";
import { rgb, colorNew, from_gradient, colorR, colorG, colorB, colorT } from "../../src/runtime/color";
import * as parray from "../../src/runtime/array";
import * as pmap from "../../src/runtime/map";
import * as pmatrix from "../../src/runtime/matrix";
import * as pinput from "../../src/runtime/input";
import { in_seconds, from_seconds } from "../../src/runtime/timeframe";
import { chartPointNew, chartPointFromIndex, chartPointFromTime, chartPointCopy, chartPointNow } from "../../src/runtime/drawing";
import { logInfo, logWarning, logError, runtimeWarning, runtimeError } from "../../src/runtime/log";
import { year, month, dayofmonth, dayofweek, hour, minute, second, weekofyear, tradingDayStart } from "../../src/runtime/datetime";
import { ticker as syminfoTicker } from "../../src/runtime/syminfo";

describe("Series", () => {
  it("get(0) returns the current bar after advance()", () => {
    const s = new Series([10, 20, 30]);
    s.advance();
    expect(s.get(0)).toBe(10);
    s.advance();
    expect(s.get(0)).toBe(20);
  });

  it("get(1) returns the previous bar", () => {
    const s = new Series([10, 20, 30]);
    s.advance();
    s.advance();
    expect(s.get(1)).toBe(10);
  });

  it("returns NaN for out-of-range history (before bar 0)", () => {
    const s = new Series([10, 20, 30]);
    s.advance();
    expect(s.get(1)).toBeNaN();
  });

  it("returns NaN for offsets past the end of data", () => {
    const s = new Series([10, 20, 30]);
    s.advance();
    s.advance();
    s.advance();
    expect(s.get(5)).toBeNaN();
  });

  // ── preallocate()/record() — 사용자 var 히스토리 슬롯 전용 ────

  it("preallocate() fills a fixed-length buffer with NaN before any record()", () => {
    const s = Series.preallocate(3);
    s.advance();
    expect(s.get(0)).toBeNaN();
  });

  it("record() writes the value at the current cursor position, readable via get(0) on the same bar", () => {
    const s = Series.preallocate(3);
    s.advance();
    s.record(42);
    expect(s.get(0)).toBe(42);
  });

  it("a value recorded on one bar becomes readable as get(1) on the next bar (history semantics)", () => {
    const s = Series.preallocate(3);
    s.advance();
    s.record(10);
    s.advance();
    s.record(20);
    expect(s.get(1)).toBe(10);
    expect(s.get(0)).toBe(20);
  });

  it("record() before the first advance() is a no-op (cursor still -1)", () => {
    const s = Series.preallocate(3);
    expect(() => s.record(1)).not.toThrow();
  });
});

// RefSeries(배치25 (1), drawing 핸들 '=' 로컬 히스토리) — Series와 동형이나 기본값이 NaN 대신 null,
// 원소가 Float64Array가 아니라 object 원형 버퍼(unknown[]).
describe("RefSeries", () => {
  it("preallocate() fills a fixed-length buffer with null before any record()", () => {
    const s = RefSeries.preallocate(3);
    s.advance();
    expect(s.get(0)).toBeNull();
  });

  it("record() writes the value at the current cursor position, readable via get(0) on the same bar", () => {
    const s = RefSeries.preallocate(3);
    const handle = { kind: "label", id: 1 };
    s.advance();
    s.record(handle);
    expect(s.get(0)).toBe(handle);
  });

  it("a value recorded on one bar becomes readable as get(1) on the next bar (history semantics)", () => {
    const s = RefSeries.preallocate(3);
    const first = { kind: "label", id: 1 };
    const second = { kind: "label", id: 2 };
    s.advance();
    s.record(first);
    s.advance();
    s.record(second);
    expect(s.get(1)).toBe(first);
    expect(s.get(0)).toBe(second);
  });

  it("returns null for out-of-range history (before bar 0)", () => {
    const s = RefSeries.preallocate(3);
    s.advance();
    expect(s.get(1)).toBeNull();
  });

  it("returns null for offsets past the end of data", () => {
    const s = RefSeries.preallocate(3);
    s.advance();
    s.advance();
    s.advance();
    expect(s.get(5)).toBeNull();
  });

  it("returns null for a negative or non-integer offset (positive-form guard, C91)", () => {
    const s = RefSeries.preallocate(3);
    const handle = { kind: "label", id: 1 };
    s.advance();
    s.record(handle);
    expect(s.get(-1)).toBeNull();
    expect(s.get(NaN)).toBeNull();
  });

  it("record() before the first advance() is a no-op (cursor still -1)", () => {
    const s = RefSeries.preallocate(3);
    expect(() => s.record({ kind: "label", id: 1 })).not.toThrow();
  });
});

describe("refHistGet", () => {
  it("returns the current value for offset 0 (record timing bypass, mirrors histGet)", () => {
    const s = RefSeries.preallocate(3);
    s.advance();
    const current = { kind: "label", id: 9 };
    expect(refHistGet(current, s, 0)).toBe(current);
  });

  it("returns slot.get(offset) for offset >= 1", () => {
    const s = RefSeries.preallocate(3);
    const prev = { kind: "label", id: 1 };
    s.advance();
    s.record(prev);
    s.advance();
    expect(refHistGet({ kind: "label", id: 2 }, s, 1)).toBe(prev);
  });

  it("returns null for a negative offset", () => {
    const s = RefSeries.preallocate(3);
    s.advance();
    expect(refHistGet({ kind: "label", id: 1 }, s, -1)).toBeNull();
  });
});

describe("ta.sma", () => {
  it("returns NaN for the first length-1 bars", () => {
    const state = {};
    expect(sma(state, 101, 3)).toBeNaN();
    expect(sma(state, 102, 3)).toBeNaN();
  });

  it("returns the rolling average once the window fills", () => {
    const state = {};
    sma(state, 101, 3);
    sma(state, 102, 3);
    expect(sma(state, 103, 3)).toBeCloseTo(102, 9);
  });

  it("matches a hand-computed rolling average across bars", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104];
    const results = closes.map((c) => sma(state, c, 3));
    expect(results[2]).toBeCloseTo(102, 9);
    expect(results[3]).toBeCloseTo(307 / 3, 9);
    expect(results[4]).toBeCloseTo(309 / 3, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    sma(stateA, 1, 2);
    sma(stateA, 2, 2);
    expect(sma(stateA, 3, 2)).toBeCloseTo(2.5, 9);
    // stateB is freshly warming up (1 real bar with length=2) and must be unaffected by stateA.
    expect(sma(stateB, 100, 2)).toBeNaN();
  });

  it("re-contaminates with NaN when a new value is NaN", () => {
    const state = {};
    sma(state, 1, 2);
    sma(state, 2, 2);
    expect(sma(state, NaN, 2)).toBeNaN();
  });
});

describe("ta.ema", () => {
  it("returns NaN for the first length-1 bars", () => {
    const state = {};
    expect(ema(state, 101, 3)).toBeNaN();
    expect(ema(state, 102, 3)).toBeNaN();
  });

  it("seeds the length-th bar with the plain SMA of the init window", () => {
    const state = {};
    ema(state, 101, 3);
    ema(state, 102, 3);
    expect(ema(state, 103, 3)).toBeCloseTo(102, 9); // (101+102+103)/3
  });

  it("applies alpha=2/(length+1) smoothing after the seed bar", () => {
    const state = {};
    ema(state, 101, 3);
    ema(state, 102, 3);
    ema(state, 103, 3); // seed = 102
    // alpha = 2/(3+1) = 0.5 -> 0.5*104 + 0.5*102 = 103
    expect(ema(state, 104, 3)).toBeCloseTo(103, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => ema(state, c, 3));
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(102, 9);
    expect(results[3]).toBeCloseTo(102, 9);
    expect(results[9]).toBeCloseTo(107, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    ema(stateA, 1, 2);
    expect(ema(stateA, 2, 2)).toBeCloseTo(1.5, 9); // seed SMA of [1,2]
    expect(ema(stateB, 100, 2)).toBeNaN(); // stateB is a fresh call site, still warming up
  });

  it("passes a NaN input through without disturbing init state (resumes counting afterward)", () => {
    const state = {};
    expect(ema(state, 101, 3)).toBeNaN(); // initCount -> 1
    expect(ema(state, NaN, 3)).toBeNaN(); // ignored, initCount stays 1
    expect(ema(state, 102, 3)).toBeNaN(); // initCount -> 2
    expect(ema(state, 103, 3)).toBeCloseTo(102, 9); // initCount -> 3, seeds SMA(101,102,103)
  });

  it("passes a NaN input through without disturbing prevEma during the smoothing phase", () => {
    const state = {};
    ema(state, 101, 3);
    ema(state, 102, 3);
    ema(state, 103, 3); // prevEma = 102
    expect(ema(state, NaN, 3)).toBeNaN();
    // prevEma is still 102 after the NaN gap
    expect(ema(state, 104, 3)).toBeCloseTo(103, 9);
  });
});

describe("ta.rsi", () => {
  it("returns NaN for the seed bar (no prior value to diff against)", () => {
    const state = {};
    expect(rsi(state, 101, 3)).toBeNaN();
  });

  it("returns 100 when avgLoss is 0 (strictly increasing values through the init window)", () => {
    const state = {};
    rsi(state, 101, 3); // seed
    rsi(state, 102, 3); // +1
    rsi(state, 103, 3); // +1
    expect(rsi(state, 104, 3)).toBeCloseTo(100, 9); // +1, avgLoss=0
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => rsi(state, c, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(100, 9);
    expect(results[3]).toBeCloseTo(57.1428571429, 9);
    expect(results[9]).toBeCloseTo(85.7684313486, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    rsi(stateA, 1, 2);
    rsi(stateA, 2, 2);
    expect(rsi(stateA, 3, 2)).toBeCloseTo(100, 9);
    expect(rsi(stateB, 100, 2)).toBeNaN();
  });

  it("passes a NaN input through without disturbing init state (resumes counting afterward)", () => {
    const state = {};
    expect(rsi(state, 101, 3)).toBeNaN(); // seed, initCount -> 1
    expect(rsi(state, NaN, 3)).toBeNaN(); // ignored entirely (prevValue untouched)
    expect(rsi(state, 102, 3)).toBeNaN(); // change vs 101, initCount -> 2 (< length=3)
    expect(rsi(state, 103, 3)).toBeCloseTo(100, 9); // change vs 102, initCount -> 3 == length, avgLoss=0
  });
});

describe("ta.rma", () => {
  it("returns NaN for the first length-1 bars", () => {
    const state = {};
    expect(rma(state, 101, 3)).toBeNaN();
    expect(rma(state, 102, 3)).toBeNaN();
  });

  it("seeds the length-th bar with the plain SMA of the init window", () => {
    const state = {};
    rma(state, 101, 3);
    rma(state, 102, 3);
    expect(rma(state, 103, 3)).toBeCloseTo(102, 9); // (101+102+103)/3
  });

  it("applies alpha=1/length smoothing after the seed bar", () => {
    const state = {};
    rma(state, 101, 3);
    rma(state, 102, 3);
    rma(state, 103, 3); // seed = 102
    // alpha = 1/3 -> (1/3)*102 + (2/3)*102 = 102 (steady value stays steady)
    expect(rma(state, 102, 3)).toBeCloseTo(102, 9);
    // alpha = 1/3 -> (1/3)*105 + (2/3)*102 = 103
    expect(rma(state, 105, 3)).toBeCloseTo(103, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => rma(state, c, 3));
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(102, 9);
    expect(results[3]).toBeCloseTo(102, 9);
    expect(results[6]).toBeCloseTo(104.2962962963, 9);
    expect(results[9]).toBeCloseTo(106.2359396433, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    rma(stateA, 1, 2);
    expect(rma(stateA, 2, 2)).toBeCloseTo(1.5, 9); // seed SMA of [1,2]
    expect(rma(stateB, 100, 2)).toBeNaN(); // stateB is a fresh call site, still warming up
  });

  it("passes a NaN input through without disturbing init state (resumes counting afterward)", () => {
    const state = {};
    expect(rma(state, 101, 3)).toBeNaN(); // initCount -> 1
    expect(rma(state, NaN, 3)).toBeNaN(); // ignored, initCount stays 1
    expect(rma(state, 102, 3)).toBeNaN(); // initCount -> 2
    expect(rma(state, 103, 3)).toBeCloseTo(102, 9); // initCount -> 3, seeds SMA(101,102,103)
  });

  it("passes a NaN input through without disturbing prevRma during the smoothing phase", () => {
    const state = {};
    rma(state, 101, 3);
    rma(state, 102, 3);
    rma(state, 103, 3); // prevRma = 102
    expect(rma(state, NaN, 3)).toBeNaN();
    // prevRma is still 102 after the NaN gap
    expect(rma(state, 105, 3)).toBeCloseTo(103, 9);
  });
});

describe("ta.wma", () => {
  it("returns NaN for the first length-1 bars", () => {
    const state = {};
    expect(wma(state, 101, 3)).toBeNaN();
    expect(wma(state, 102, 3)).toBeNaN();
  });

  it("returns the weight-newest-highest average once the window fills (length=2)", () => {
    const state = {};
    wma(state, 1, 2); // NaN, warming up
    // window [1,2], weight(oldest=1)=1, weight(newest=2)=2 -> (1*1+2*2)/3
    expect(wma(state, 2, 2)).toBeCloseTo(5 / 3, 9);
    // window [2,3] -> (2*1+3*2)/3
    expect(wma(state, 3, 2)).toBeCloseTo(8 / 3, 9);
  });

  it("matches a hand-computed weighted rolling average across bars (length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104];
    const results = closes.map((c) => wma(state, c, 3));
    // window [101,102,103] weights [1,2,3] -> (101+204+309)/6
    expect(results[2]).toBeCloseTo(614 / 6, 9);
    // window [102,103,102] weights [1,2,3] -> (102+206+306)/6
    expect(results[3]).toBeCloseTo(614 / 6, 9);
    // window [103,102,104] weights [1,2,3] -> (103+204+312)/6
    expect(results[4]).toBeCloseTo(619 / 6, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => wma(state, c, 3));
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(102.3333333333, 9);
    expect(results[6]).toBeCloseTo(105.3333333333, 9);
    expect(results[9]).toBeCloseTo(107.1666666667, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    wma(stateA, 1, 2);
    expect(wma(stateA, 2, 2)).toBeCloseTo(5 / 3, 9);
    // stateB is freshly warming up (1 real bar with length=2) and must be unaffected by stateA.
    expect(wma(stateB, 100, 2)).toBeNaN();
  });

  it("re-contaminates with NaN when a new value is NaN", () => {
    const state = {};
    wma(state, 1, 3);
    wma(state, 2, 3);
    expect(wma(state, 3, 3)).toBeCloseTo(14 / 6, 9);
    expect(wma(state, NaN, 3)).toBeNaN();
  });

  it("only clears NaN contamination once the poisoned slot cycles back out of the fixed-width buffer", () => {
    const state = {};
    wma(state, 1, 3);
    wma(state, 2, 3);
    wma(state, 3, 3); // window [1,2,3]
    wma(state, NaN, 3); // window [2,3,NaN] -> poisoned
    expect(wma(state, 4, 3)).toBeNaN(); // window [3,NaN,4] -> still poisoned
    expect(wma(state, 5, 3)).toBeNaN(); // window [NaN,4,5] -> still poisoned (NaN slot not yet overwritten)
    // window [4,5,6] -> the NaN slot (written length=3 calls ago) finally gets overwritten
    expect(wma(state, 6, 3)).toBeCloseTo((4 * 1 + 5 * 2 + 6 * 3) / 6, 9);
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 4;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.3 + (i % 3));
    const results = values.map((v) => wma(state, v, length));
    function direct(idx: number): number {
      let weightedTotal = 0;
      let weightTotal = 0;
      for (let i = 0; i < length; i++) {
        const w = i + 1;
        weightedTotal += values[idx - length + 1 + i]! * w;
        weightTotal += w;
      }
      return weightedTotal / weightTotal;
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });

  it("weights the most recent value more heavily than ta.sma would (reacts faster to a jump)", () => {
    const wmaState = {};
    const smaState = {};
    const closes = [100, 100, 100, 100, 120]; // sharp jump on the last bar
    let wmaResult = NaN;
    let smaResult = NaN;
    for (const c of closes) {
      wmaResult = wma(wmaState, c, 3);
      smaResult = sma(smaState, c, 3);
    }
    expect(wmaResult).toBeGreaterThan(smaResult);
  });
});

// ta.alma — Gaussian 가중 이동평균. GOAL.md "incremental O(1)/bar" 원칙의 첫 명시적 예외(runtime/
// ta.ts alma() 주석 참조 — Gaussian 가중치는 wma류와 달리 telescoping 재귀식이 없어 가중합을 매 바
// O(length) 재계산, 가중치 배열 자체만 최초 호출 값으로 캐시). PROGRESS C113에서 python 2,000건
// fuzz로 이 재계산 결정이 pine2py wavealgo/ta/alma.py와 정확히 동치임을 확인.
describe("ta.alma", () => {
  it("returns NaN for the first length-1 bars", () => {
    const state = {};
    expect(alma(state, 101, 3, 0.85, 6.0)).toBeNaN();
    expect(alma(state, 102, 3, 0.85, 6.0)).toBeNaN();
  });

  it("returns the value itself when length=1 (single-tap window, weight=1)", () => {
    const state = {};
    expect(alma(state, 5.0, 1, 0.85, 6.0)).toBeCloseTo(5.0, 9);
    expect(alma(state, 7.0, 1, 0.85, 6.0)).toBeCloseTo(7.0, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3, offset=0.85, sigma=6.0)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => alma(state, c, 3, 0.85, 6.0));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(102.6856736002, 9);
    expect(results[3]).toBeCloseTo(102.309236523, 9);
    expect(results[4]).toBeCloseTo(103.3789820156, 9);
    expect(results[5]).toBeCloseTo(104.6831286619, 9);
    expect(results[6]).toBeCloseTo(105.6856736002, 9);
    expect(results[7]).toBeCloseTo(105.309236523, 9);
    expect(results[8]).toBeCloseTo(106.3789820156, 9);
    expect(results[9]).toBeCloseTo(107.6831286619, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    alma(stateA, 1, 2, 0.85, 6.0);
    expect(Number.isNaN(alma(stateA, 2, 2, 0.85, 6.0))).toBe(false);
    // stateB is freshly warming up (1 real bar with length=2) and must be unaffected by stateA.
    expect(alma(stateB, 100, 2, 0.85, 6.0)).toBeNaN();
  });

  it("re-contaminates with NaN when a new value is NaN, and only recovers once the poisoned slot cycles out", () => {
    const state = {};
    alma(state, 1, 3, 0.85, 6.0);
    alma(state, 2, 3, 0.85, 6.0);
    expect(Number.isNaN(alma(state, 3, 3, 0.85, 6.0))).toBe(false); // window [1,2,3]
    expect(alma(state, NaN, 3, 0.85, 6.0)).toBeNaN(); // window [2,3,NaN] -> poisoned
    expect(alma(state, 4, 3, 0.85, 6.0)).toBeNaN(); // window [3,NaN,4] -> still poisoned
    expect(alma(state, 5, 3, 0.85, 6.0)).toBeNaN(); // window [NaN,4,5] -> still poisoned
    expect(Number.isNaN(alma(state, 6, 3, 0.85, 6.0))).toBe(false); // window [4,5,6] -> NaN slot finally overwritten
  });

  it("stays correct across many bars beyond the initial fill, matching a direct O(length) recomputation", () => {
    const state = {};
    const length = 4;
    const offsetMult = 0.85;
    const sigma = 6.0;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.3 + (i % 3));
    const results = values.map((v) => alma(state, v, length, offsetMult, sigma));
    const m = offsetMult * (length - 1);
    const s = length / sigma;
    const weights = Array.from({ length }, (_, i) => Math.exp(-((i - m) ** 2) / (2 * s * s)));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    function direct(idx: number): number {
      let weightedTotal = 0;
      for (let i = 0; i < length; i++) {
        weightedTotal += values[idx - length + 1 + i]! * weights[i]!;
      }
      return weightedTotal / weightSum;
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });

  it("weights the center of the window most heavily (Gaussian bump), unlike ta.wma's monotonic newest-heaviest weighting", () => {
    // offset=0.5 centers the Gaussian bump in the middle of the window instead of near the newest
    // bar (TV default offset=0.85 skews it toward the newest bar, same direction as wma but with a
    // falloff instead of a straight line) — a symmetric spike in the middle of the window should
    // dominate the result more than it would for ta.sma (uniform weight) on the same data.
    const almaState = {};
    const smaState = {};
    const values = [10, 10, 100, 10, 10]; // spike in the middle
    let almaResult = NaN;
    let smaResult = NaN;
    for (const v of values) {
      almaResult = alma(almaState, v, 5, 0.5, 2.0);
      smaResult = sma(smaState, v, 5);
    }
    expect(almaResult).toBeGreaterThan(smaResult);
  });

  it("[divergence] sigma=0 degrades gracefully to a uniform-weight (SMA-equivalent) average instead of crashing", () => {
    // pine2py wavealgo/ta/alma.py computes `s = length / sigma` — sigma=0.0 raises a Python
    // ZeroDivisionError (verified by direct execution, PROGRESS C113). JS division by zero yields
    // Infinity instead of throwing, so `(i-m)**2 / (2*Infinity*Infinity)` collapses to 0 and every
    // weight becomes exp(-0)=1 (uniform) — GOAL.md "알려진 버그는 따르지 않는다" applied; TV-
    // unverified hypothesis (DIVERGENCES.md).
    const almaState = {};
    const smaState = {};
    const values = [1, 2, 3];
    let almaResult = NaN;
    let smaResult = NaN;
    for (const v of values) {
      almaResult = alma(almaState, v, 3, 0.85, 0);
      smaResult = sma(smaState, v, 3);
    }
    expect(almaResult).toBeCloseTo(smaResult, 9);
  });

  it("negative sigma produces the same result as its positive counterpart (s only ever appears squared)", () => {
    const stateNeg = {};
    const statePos = {};
    const values = [1, 2, 3];
    let negResult = NaN;
    let posResult = NaN;
    for (const v of values) {
      negResult = alma(stateNeg, v, 3, 0.85, -6.0);
      posResult = alma(statePos, v, 3, 0.85, 6.0);
    }
    expect(negResult).toBeCloseTo(posResult, 9);
  });

  it("length<=0 returns NaN via the weight_sum===0 path (no crash; matches pine2py's own nan result for non-positive length)", () => {
    const state = {};
    expect(alma(state, 5.0, 0, 0.85, 6.0)).toBeNaN();
  });
});

describe("ta.hma", () => {
  it("returns NaN until both inner WMAs and the outer window are warm (length=4 -> half_len=2, full_len=4, outer needs 2 diffs)", () => {
    const state = {};
    const closes = [101, 102, 103, 102]; // full WMA(length=4) itself isn't warm yet
    for (const c of closes) expect(hma(state, c, 4)).toBeNaN();
  });

  it("matches the pine2py-verified sample10.json trace (close, length=4 -> half_len=2, sqrt_len=2)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => hma(state, c, 4));
    for (let i = 0; i < 4; i++) expect(results[i]).toBeNaN();
    expect(results[4]).toBeCloseTo(103.2666666667, 9);
    expect(results[5]).toBeCloseTo(104.8444444444, 9);
    expect(results[6]).toBeCloseTo(106.1, 9);
    expect(results[7]).toBeCloseTo(105.7888888889, 9);
    expect(results[8]).toBeCloseTo(106.2666666667, 9);
    expect(results[9]).toBeCloseTo(107.8444444444, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    const closes = [101, 102, 103, 102, 104];
    let resultA = NaN;
    for (const c of closes) resultA = hma(stateA, c, 4);
    expect(resultA).toBeCloseTo(103.2666666667, 9);
    // stateB has only seen 1 bar and must be unaffected by stateA's fully-warmed state.
    expect(hma(stateB, 999, 4)).toBeNaN();
  });

  it("collapses to pass-through identity when length=1 (half_len=sqrt_len=1 -> no warmup at all)", () => {
    const state = {};
    // half_len=max(1,trunc(1/2))=1, sqrt_len=max(1,trunc(sqrt(1)))=1: every inner/outer WMA is a
    // 1-tap window, i.e. the identity function, so hma(x,1) === x from the very first call.
    expect(hma(state, 42, 1)).toBeCloseTo(42, 9);
    expect(hma(state, 7, 1)).toBeCloseTo(7, 9);
  });

  it("does not advance the outer WMA window while either inner WMA is still NaN (matches pine2py's conditional diff_window.append, not a poisoned push)", () => {
    // Cross-checked against a from-scratch direct recomputation of pine2py's hma.py algorithm
    // (window-scan wma + conditional diff_window append), independent of the incremental wma()
    // this file's hma() delegates to. length=4 -> half_len=2, sqrt_len=2. An embedded NaN gap at
    // index 4 keeps wma_full NaN for several bars after the gap (poisoned fixed-width buffer), so
    // the outer window must skip those bars entirely rather than counting them toward its 2-diff
    // warmup.
    const state = {};
    const values = [10, 11, 12, 13, NaN, 14, 15, 16, 17, 18, 19, 20];
    const results = values.map((v) => hma(state, v, 4));
    for (let i = 0; i < 8; i++) expect(results[i]).toBeNaN();
    expect(results[8]).toBeCloseTo(16, 9);
    expect(results[9]).toBeCloseTo(18, 9);
    expect(results[10]).toBeCloseTo(19, 9);
    expect(results[11]).toBeCloseTo(20, 9);
  });

  it("reacts faster than ta.wma to a sharp jump (Hull's whole point — lower lag)", () => {
    const hmaState = {};
    const wmaState = {};
    const closes = [100, 100, 100, 100, 100, 100, 100, 120]; // sharp jump on the last bar
    let hmaResult = NaN;
    let wmaResult = NaN;
    for (const c of closes) {
      hmaResult = hma(hmaState, c, 4);
      wmaResult = wma(wmaState, c, 4);
    }
    expect(hmaResult).toBeGreaterThan(wmaResult);
  });
});

// ta.dema — pine2py에 대응 구현이 전혀 없는 hand-verified 신규 함수(배치25 (3), DIVERGENCES.md
// #175). 표준 공식 DEMA = 2*EMA(src,len) - EMA(EMA(src,len),len)을 손으로 정확히 유도해(alpha=2/3
// for length=2) 검증한다 — 등차수열 입력은 이 공식이 EMA의 상수 지연을 정확히 상쇄해 완전 워밍업
// 이후 dema(x)===x가 되는 성질을 이용, 부동소수점 반올림 없이 정확한 기대값을 손 계산으로 도출.
describe("ta.dema", () => {
  it("returns NaN for exactly 2*length-2 leading bars (length=2 -> inner ema1 warms at index1, ema2 needs 2 more non-NaN ema1 feeds)", () => {
    const state = {};
    const values = [10, 20, 30, 40, 50];
    const results = values.map((v) => dema(state, v, 2));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(30, 9);
    expect(results[3]).toBeCloseTo(40, 9);
    expect(results[4]).toBeCloseTo(50, 9);
  });

  it("does not advance ema2's state on a bar where ema1 is still NaN, and recovers exactly after a mid-stream NaN gap (hand-derived, length=2)", () => {
    const state = {};
    const values = [10, 20, 30, NaN, 40, 50, 60, 70];
    const results = values.map((v) => dema(state, v, 2));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(30, 9);
    expect(results[3]).toBeNaN();
    expect(results[4]).toBeCloseTo(40, 9);
    expect(results[5]).toBeCloseTo(50, 9);
    expect(results[6]).toBeCloseTo(60, 9);
    expect(results[7]).toBeCloseTo(70, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    const values = [10, 20, 30, 40, 50];
    let resultA = NaN;
    for (const v of values) resultA = dema(stateA, v, 2);
    expect(resultA).toBeCloseTo(50, 9);
    // stateB has only seen 1 bar and must be unaffected by stateA's fully-warmed state.
    expect(dema(stateB, 999, 2)).toBeNaN();
  });

  it("matches an independent two-call ema() recomputation over a non-linear trace (length=4, regression guard)", () => {
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const ema1State = {};
    const ema2State = {};
    const expected = closes.map((c) => {
      const e1 = ema(ema1State, c, 4);
      if (Number.isNaN(e1)) return NaN;
      const e2 = ema(ema2State, e1, 4);
      return 2 * e1 - e2;
    });
    const demaState = {};
    const actual = closes.map((c) => dema(demaState, c, 4));
    for (let i = 0; i < closes.length; i++) {
      if (Number.isNaN(expected[i])) expect(actual[i]).toBeNaN();
      else expect(actual[i]).toBeCloseTo(expected[i]!, 9);
    }
  });
});

// ta.rci — pine2py에 대응 구현이 전혀 없는 hand-verified 신규 함수(배치25 (3), DIVERGENCES.md
// #177). 표준 RCI 공식(timeRank/priceRank 완전 항등 -> +-100)을 손으로 유도해(완전 상승/하락 시
// sum(d^2)=0) 검증한다(scratch/rci_probe.mjs, gitignored 확인 후 삭제).
describe("ta.rci", () => {
  it("returns NaN for the first length-1 bars, then +100 for a monotonic uptrend (length=3)", () => {
    const state = {};
    const results = [10, 20, 30, 40, 50].map((v) => rci(state, v, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(100, 9);
    expect(results[3]).toBeCloseTo(100, 9);
    expect(results[4]).toBeCloseTo(100, 9);
  });

  it("returns -100 for a monotonic downtrend (length=3)", () => {
    const state = {};
    const results = [30, 20, 10, 5, 1].map((v) => rci(state, v, 3));
    expect(results[2]).toBeCloseTo(-100, 9);
    expect(results[3]).toBeCloseTo(-100, 9);
    expect(results[4]).toBeCloseTo(-100, 9);
  });

  it("returns a non-zero skew for a flat series (strict-greater rank, no tie-averaging — hand-derived, length=3)", () => {
    const state = {};
    const results = [5, 5, 5, 5].map((v) => rci(state, v, 3));
    expect(results[2]).toBeCloseTo(-25, 9);
    expect(results[3]).toBeCloseTo(-25, 9);
  });

  it("poisons the window on a mid-stream NaN and recovers exactly length bars after the gap closes (length=3)", () => {
    const state = {};
    const results = [10, NaN, 20, 30, 40].map((v) => rci(state, v, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeNaN(); // window still has the NaN slot
    expect(results[3]).toBeNaN(); // window still has the NaN slot (buffer wrapped once)
    expect(results[4]).toBeCloseTo(100, 9); // NaN slot finally overwritten, window fully valid + monotonic
  });

  it("returns NaN at length=1 (denominator n*(n^2-1)=0, IEEE754 0/0 naturally yields NaN)", () => {
    const state = {};
    expect(rci(state, 10, 1)).toBeNaN();
    expect(rci(state, 20, 1)).toBeNaN();
    expect(rci(state, 30, 1)).toBeNaN();
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    [10, 20, 30].forEach((v) => rci(stateA, v, 3));
    expect(rci(stateA, 40, 3)).toBeCloseTo(100, 9);
    // stateB has only seen 1 bar and must still be warming up, unaffected by stateA.
    expect(rci(stateB, 999, 3)).toBeNaN();
  });

  it("alternates between +100 and -100 for a perfectly oscillating 2-value series (length=2, regression guard)", () => {
    const state = {};
    const results = [10, 20, 10, 20, 10, 20].map((v) => rci(state, v, 2));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeCloseTo(100, 9);
    expect(results[2]).toBeCloseTo(-100, 9);
    expect(results[3]).toBeCloseTo(100, 9);
    expect(results[4]).toBeCloseTo(-100, 9);
    expect(results[5]).toBeCloseTo(100, 9);
  });
});

describe("ta.linreg", () => {
  it("returns NaN until the window is fully warm (length=4)", () => {
    const state = {};
    const closes = [101, 102, 103]; // only 3 of 4 bars seen
    for (const c of closes) expect(linreg(state, c, 4, 0)).toBeNaN();
  });

  it("matches the pine2py-verified sample10.json trace (close, length=4, offset=0)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => linreg(state, c, 4, 0));
    for (let i = 0; i < 3; i++) expect(results[i]).toBeNaN();
    expect(results[3]).toBeCloseTo(102.6, 9);
    expect(results[4]).toBeCloseTo(103.5, 9);
    expect(results[5]).toBeCloseTo(104.7, 9);
    expect(results[6]).toBeCloseTo(106.2, 9);
    expect(results[7]).toBeCloseTo(105.6, 9);
    expect(results[8]).toBeCloseTo(106.5, 9);
    expect(results[9]).toBeCloseTo(107.7, 9);
  });

  it("projects forward when offset>0 (pine2py-verified sample10.json trace, length=4, offset=2)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => linreg(state, c, 4, 2));
    expect(results[3]).toBeCloseTo(103.4, 9);
    expect(results[4]).toBeCloseTo(104.5, 9);
    expect(results[5]).toBeCloseTo(106.3, 9);
    expect(results[6]).toBeCloseTo(108.8, 9);
    expect(results[7]).toBeCloseTo(106.4, 9);
    expect(results[8]).toBeCloseTo(107.5, 9);
    expect(results[9]).toBeCloseTo(109.3, 9);
  });

  it("collapses to the raw input value regardless of offset when length=1 (denom~0 branch: a single point has no slope)", () => {
    // n=1 -> sum_x=sum_x2=0 -> denom=0 exactly, taking the `abs(denom)<1e-15` early return (sum_y/n),
    // which never reads offset — pine2py linreg.py L58-60 does the same before computing slope.
    const stateZero = {};
    const stateOffset = {};
    expect(linreg(stateZero, 42, 1, 0)).toBeCloseTo(42, 9);
    expect(linreg(stateOffset, 42, 1, 100)).toBeCloseTo(42, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    const closes = [101, 102, 103, 102];
    let resultA = NaN;
    for (const c of closes) resultA = linreg(stateA, c, 4, 0);
    expect(resultA).toBeCloseTo(102.6, 9);
    // stateB has only seen 1 bar and must be unaffected by stateA's fully-warmed state.
    expect(linreg(stateB, 999, 4, 0)).toBeNaN();
  });

  it("defaults offset to 0 when omitted (C252 — pine2py linreg.py offset: int = 0)", () => {
    const stateDefault = {};
    const stateExplicit = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    let resultDefault = NaN;
    let resultExplicit = NaN;
    for (const c of closes) {
      resultDefault = (linreg as (s: object, v: number, l: number) => number)(stateDefault, c, 4);
      resultExplicit = linreg(stateExplicit, c, 4, 0);
    }
    expect(resultDefault).toBe(resultExplicit);
    expect(resultDefault).toBeCloseTo(107.7, 9);
  });

  it("cross-checked against a from-scratch direct recomputation of pine2py's linreg.py algorithm (embedded NaN gap)", () => {
    // Independent of the wma() this file's linreg() delegates to internally — reimplements pine2py's
    // window-scan sum_y/sum_xy/slope/intercept formula directly against an oldest-to-newest window.
    function directLinreg(values: number[], length: number, offset: number): number {
      if (values.length < length) return NaN;
      const window = values.slice(values.length - length);
      if (window.some((v) => Number.isNaN(v))) return NaN;
      const n = length;
      const sumX = (n * (n - 1)) / 2;
      const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
      const sumY = window.reduce((a, b) => a + b, 0);
      const sumXY = window.reduce((acc, v, i) => acc + i * v, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (Math.abs(denom) < 1e-15) return sumY / n;
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      return intercept + slope * (n - 1 + offset);
    }

    const values = [10, 11, 12, 13, NaN, 14, 15, 16, 17, 18, 19, 20];
    const state = {};
    for (let i = 0; i < values.length; i++) {
      const got = linreg(state, values[i]!, 4, 1);
      const want = directLinreg(values.slice(0, i + 1), 4, 1);
      if (Number.isNaN(want)) {
        expect(got).toBeNaN();
      } else {
        expect(got).toBeCloseTo(want, 9);
      }
    }
  });
});

describe("ta.vwma", () => {
  it("returns NaN for the first length-1 bars", () => {
    const state = {};
    expect(vwma(state, 101, 1000, 3)).toBeNaN();
    expect(vwma(state, 102, 1100, 3)).toBeNaN();
  });

  it("returns the volume-weighted average once the window fills (length=2)", () => {
    const state = {};
    vwma(state, 1, 10, 2); // NaN, warming up
    // window price=[1,2] vol=[10,20] -> (1*10+2*20)/(10+20)
    expect(vwma(state, 2, 20, 2)).toBeCloseTo(50 / 30, 9);
    // window price=[2,3] vol=[20,30] -> (2*20+3*30)/(20+30)
    expect(vwma(state, 3, 30, 2)).toBeCloseTo(130 / 50, 9);
  });

  it("is genuinely volume-weighted, not just a plain average (differs from ta.sma)", () => {
    const vwmaState = {};
    const smaState = {};
    // heavy volume on the low bar should pull vwma below the plain sma
    const prices = [100, 100, 200];
    const volumes = [1000, 1000, 1];
    let vwmaResult = NaN;
    let smaResult = NaN;
    for (let i = 0; i < prices.length; i++) {
      vwmaResult = vwma(vwmaState, prices[i]!, volumes[i]!, 3);
      smaResult = sma(smaState, prices[i]!, 3);
    }
    expect(vwmaResult).toBeLessThan(smaResult);
  });

  it("matches the pine2py-verified sample10.json trace (close/volume, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const results = closes.map((c, i) => vwma(state, c, volumes[i]!, 3));
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(102.0606060606, 9);
    expect(results[6]).toBeCloseTo(105.0253164557, 9);
    expect(results[9]).toBeCloseTo(106.7093023256, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    vwma(stateA, 1, 10, 2);
    expect(vwma(stateA, 2, 20, 2)).toBeCloseTo(50 / 30, 9);
    expect(vwma(stateB, 100, 5, 2)).toBeNaN();
  });

  it("re-contaminates with NaN when a new price is NaN", () => {
    const state = {};
    vwma(state, 1, 10, 3);
    vwma(state, 2, 10, 3);
    expect(vwma(state, 3, 10, 3)).not.toBeNaN();
    expect(vwma(state, NaN, 10, 3)).toBeNaN();
  });

  it("re-contaminates with NaN when a new volume is NaN", () => {
    const state = {};
    vwma(state, 1, 10, 3);
    vwma(state, 2, 10, 3);
    expect(vwma(state, 3, 10, 3)).not.toBeNaN();
    expect(vwma(state, 4, NaN, 3)).toBeNaN();
  });

  it("returns NaN when the window's total volume is zero (division-by-zero guard)", () => {
    const state = {};
    vwma(state, 1, 0, 2);
    expect(vwma(state, 2, 0, 2)).toBeNaN();
  });

  it("only clears NaN contamination once the poisoned slot cycles back out of the fixed-width buffer", () => {
    const state = {};
    vwma(state, 1, 10, 3);
    vwma(state, 2, 10, 3);
    vwma(state, 3, 10, 3); // window [1,2,3]
    vwma(state, NaN, 10, 3); // window [2,3,NaN] -> poisoned
    expect(vwma(state, 4, 10, 3)).toBeNaN(); // window [3,NaN,4] -> still poisoned
    expect(vwma(state, 5, 10, 3)).toBeNaN(); // window [NaN,4,5] -> still poisoned
    // window [4,5,6] -> the NaN slot (written length=3 calls ago) finally gets overwritten
    expect(vwma(state, 6, 10, 3)).toBeCloseTo((4 + 5 + 6) / 3, 9);
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 4;
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 1.3 + (i % 3));
    const volumes = Array.from({ length: 20 }, (_, i) => 1000 + i * 17 + (i % 5) * 3);
    const results = prices.map((p, i) => vwma(state, p, volumes[i]!, length));
    function direct(idx: number): number {
      let pv = 0;
      let v = 0;
      for (let i = idx - length + 1; i <= idx; i++) {
        pv += prices[i]! * volumes[i]!;
        v += volumes[i]!;
      }
      return pv / v;
    }
    for (let i = length - 1; i < prices.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

// ta.vwma series length 변형(vwmaVarLen, 배치25 (4) 마지막 항목, C555) — 버퍼/barIdx 덮어쓰기
// 메커니즘은 highestVarLen과 동형(price/volume 두 Float64Array), 값 계산만 Σ(price·volume)/Σ(volume).
// **여기의 "값이 실제로 변하는 length" 케이스들은 hand-verified다**: pine2py vwma.py도 sma.py(#179)와
// 동일하게 첫 성공 호출 length로 윈도우를 영구 고정하는 latent 버그가 있어(직접 실행 실측
// 2026-08-01) 이 축의 오라클이 성립하지 않는다 — DIVERGENCES #184/신규 항목, GOAL.md "알려진 버그는
// 따르지 않는다". 상수-값 series length 퇴화 케이스만 oracle/cases/ta_vwma_varlen.pine이 골든 대조한다.
describe("ta.vwma variable(series) length (vwmaVarLen)", () => {
  it("computes the volume-weighted mean over the trailing `length` values as length cycles (TV semantics, hand-verified)", () => {
    const state = {};
    const prices = [10, 11, 12, 13, 14, 15, 16, 17];
    const volumes = [100, 110, 90, 120, 130, 80, 105, 95];
    const lens = [3, 3, 4, 5, 2, 3, 4, 5];
    const results = prices.map((p, i) => vwmaVarLen(state, p, volumes[i]!, lens[i]!, 10, i));
    for (let i = 0; i < prices.length; i++) {
      const len = lens[i]!;
      if (len > i + 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      let pv = 0;
      let v = 0;
      for (let j = i - len + 1; j <= i; j++) {
        pv += prices[j]! * volumes[j]!;
        v += volumes[j]!;
      }
      expect(results[i]).toBeCloseTo(pv / v, 12);
    }
  });

  it("returns NaN for length<1 (pine2py crashes from the second call onward — empty-list pop(0) IndexError; hand-verified na)", () => {
    const state = {};
    expect(vwmaVarLen(state, 50, 1000, 0, 10, 0)).toBeNaN();
    expect(vwmaVarLen(state, 51, 1100, -3, 10, 1)).toBeNaN();
    // length<1 호출도 버퍼 기록 자체는 전진해야 한다 — 다음 바 정상 length가 이전 바 값을 본다.
    expect(vwmaVarLen(state, 52, 1200, 2, 10, 2)).toBeCloseTo((51 * 1100 + 52 * 1200) / (1100 + 1200), 12);
  });

  it("returns NaN when length is NaN (hand-verified na-propagation, highestVarLen parity)", () => {
    const state = {};
    expect(vwmaVarLen(state, 50, 1000, NaN, 10, 0)).toBeNaN();
    expect(vwmaVarLen(state, 51, 1100, 1, 10, 1)).toBe(51);
  });

  it("truncates a fractional length toward zero (Math.trunc, array-index rule)", () => {
    const state = {};
    vwmaVarLen(state, 10, 100, 1, 10, 0);
    expect(vwmaVarLen(state, 20, 200, 2.9, 10, 1)).toBeCloseTo((10 * 100 + 20 * 200) / (100 + 200), 12);
  });

  it("returns NaN when length exceeds the number of distinct bars seen so far (warmup, matches pine2py data_len<length)", () => {
    const state = {};
    expect(vwmaVarLen(state, 10, 100, 3, 10, 0)).toBeNaN();
    expect(vwmaVarLen(state, 20, 100, 3, 10, 1)).toBeNaN();
    expect(vwmaVarLen(state, 30, 100, 3, 10, 2)).toBeCloseTo(20, 12); // constant volume -> plain mean
  });

  it("poisons the result while any price or volume in the trailing window is NaN, then recovers (fixed-length vwma parity)", () => {
    const state = {};
    vwmaVarLen(state, 10, 100, 2, 10, 0);
    expect(vwmaVarLen(state, NaN, 100, 2, 10, 1)).toBeNaN();
    expect(vwmaVarLen(state, 20, 100, 2, 10, 2)).toBeNaN(); // 창에 NaN 바(price) 포함
    expect(vwmaVarLen(state, 30, 100, 2, 10, 3)).toBeCloseTo(25, 12); // [20,30], equal volume
    expect(vwmaVarLen(state, 40, NaN, 2, 10, 4)).toBeNaN(); // volume 쪽 NaN도 동일 오염
  });

  it("returns NaN when the window's total volume is zero (division-by-zero guard, fixed-length vwma parity)", () => {
    const state = {};
    vwmaVarLen(state, 1, 0, 2, 10, 0);
    expect(vwmaVarLen(state, 2, 0, 2, 10, 1)).toBeNaN();
  });

  it("keeps independent state across two call sites (per-call-site private history buffers)", () => {
    const stateA = {};
    const stateB = {};
    vwmaVarLen(stateA, 10, 100, 1, 10, 0);
    expect(vwmaVarLen(stateA, 20, 200, 2, 10, 1)).toBeCloseTo((10 * 100 + 20 * 200) / (100 + 200), 12);
    expect(vwmaVarLen(stateB, 5, 50, 1, 10, 0)).toBe(5);
  });

  it("does NOT advance the history buffer on repeated calls within the same bar (same barIdx) — pine2py context.param() parity", () => {
    const state = {};
    vwmaVarLen(state, 10, 100, 1, 10, 0);
    vwmaVarLen(state, 20, 100, 1, 10, 0);
    expect(vwmaVarLen(state, 30, 100, 1, 10, 0)).toBe(30); // 같은 바 마지막 값만 유지
    expect(vwmaVarLen(state, 6, 100, 2, 10, 1)).toBeCloseTo((30 * 100 + 6 * 100) / (100 + 100), 12); // bar0 슬롯은 1개뿐
  });

  it("matches a hand-simulated multi-call-per-bar loop (3 calls/bar, lengths 3/4/5) against the context.param() dedup rule", () => {
    const state = {};
    const prices = [105, 106, 104, 108, 103];
    const volumes = [10, 20, 15, 25, 30];
    const priceHistory: number[] = [];
    const volHistory: number[] = [];
    for (let bar = 0; bar < prices.length; bar++) {
      priceHistory.push(prices[bar]!);
      volHistory.push(volumes[bar]!);
      for (const period of [3, 4, 5]) {
        const result = vwmaVarLen(state, prices[bar]!, volumes[bar]!, period, 10, bar);
        const dataLen = priceHistory.length;
        if (period > dataLen) {
          expect(result).toBeNaN();
        } else {
          let pv = 0;
          let v = 0;
          for (let j = dataLen - period; j < dataLen; j++) {
            pv += priceHistory[j]! * volHistory[j]!;
            v += volHistory[j]!;
          }
          expect(result).toBeCloseTo(pv / v, 12);
        }
      }
    }
  });
});

describe("ta.swma", () => {
  it("returns NaN for the first 3 bars (fixed 4-tap window, no length argument)", () => {
    const state = {};
    expect(swma(state, 101)).toBeNaN();
    expect(swma(state, 102)).toBeNaN();
    expect(swma(state, 103)).toBeNaN();
  });

  it("returns the symmetric weighted average once the 4-wide window fills", () => {
    const state = {};
    swma(state, 1); // NaN, warming up
    swma(state, 2);
    swma(state, 3);
    // window [1,2,3,4], weights [1,2,2,1] -> (1*1+2*2+3*2+4*1)/6
    expect(swma(state, 4)).toBeCloseTo(15 / 6, 9);
  });

  it("matches a hand-computed symmetric weighted average across bars (length=4)", () => {
    const state = {};
    const values = [101, 102, 103, 102, 104];
    const results = values.map((v) => swma(state, v));
    // window [101,102,103,102] weights [1,2,2,1] -> (101*1+102*2+103*2+102*1)/6
    expect(results[3]).toBeCloseTo(613 / 6, 9);
    // window [102,103,102,104] weights [1,2,2,1] -> (102*1+103*2+102*2+104*1)/6
    expect(results[4]).toBeCloseTo(616 / 6, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => swma(state, c));
    expect(results[2]).toBeNaN();
    expect(results[3]).toBeCloseTo(102.1666666667, 9);
    expect(results[6]).toBeCloseTo(104.3333333333, 9);
    expect(results[9]).toBeCloseTo(106.3333333333, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    swma(stateA, 1);
    swma(stateA, 2);
    swma(stateA, 3);
    expect(swma(stateA, 4)).toBeCloseTo(15 / 6, 9);
    expect(swma(stateB, 100)).toBeNaN();
  });

  it("re-contaminates with NaN when a new value is NaN", () => {
    const state = {};
    swma(state, 1);
    swma(state, 2);
    swma(state, 3);
    expect(swma(state, 4)).toBeCloseTo(15 / 6, 9);
    expect(swma(state, NaN)).toBeNaN();
  });

  it("only clears NaN contamination once the poisoned slot cycles back out of the fixed 4-wide window", () => {
    const state = {};
    swma(state, 1);
    swma(state, 2);
    swma(state, 3);
    swma(state, 4); // window [1,2,3,4]
    swma(state, NaN); // window [NaN,4,3,2] -> poisoned
    expect(swma(state, 5)).toBeNaN(); // window [5,NaN,4,3] -> still poisoned
    expect(swma(state, 6)).toBeNaN(); // window [6,5,NaN,4] -> still poisoned
    expect(swma(state, 7)).toBeNaN(); // window [7,6,5,NaN] -> still poisoned (NaN about to cycle out)
    // window [8,7,6,5] -> the NaN written 4 calls ago finally gets shifted out
    expect(swma(state, 8)).toBeCloseTo((5 * 1 + 6 * 2 + 7 * 2 + 8 * 1) / 6, 9);
  });

  it("is symmetric under call-order reversal (palindromic weights, unlike ta.wma)", () => {
    const stateForward = {};
    const stateReversed = {};
    let forwardResult = NaN;
    for (const v of [1, 2, 3, 4]) forwardResult = swma(stateForward, v);
    let reversedResult = NaN;
    for (const v of [4, 3, 2, 1]) reversedResult = swma(stateReversed, v);
    expect(forwardResult).toBeCloseTo(15 / 6, 9);
    expect(reversedResult).toBeCloseTo(forwardResult, 9);
  });

  it("differs from ta.sma (middle two bars are weighted twice as heavily as the outer two)", () => {
    const swmaState = {};
    const smaState = {};
    const values = [10, 5, 5, 10]; // plain average = 7.5, but swma weighs the middle 5s twice as heavily
    let swmaResult = NaN;
    let smaResult = NaN;
    for (const v of values) {
      swmaResult = swma(swmaState, v);
      smaResult = sma(smaState, v, 4);
    }
    expect(swmaResult).toBeCloseTo(40 / 6, 9);
    expect(smaResult).toBeCloseTo(7.5, 9);
    expect(swmaResult).toBeLessThan(smaResult);
  });

  it("stays correct across many bars beyond the initial fill (shift register, no wraparound state)", () => {
    const state = {};
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.3 + (i % 3));
    const results = values.map((v) => swma(state, v));
    function direct(idx: number): number {
      const v0 = values[idx]!;
      const v1 = values[idx - 1]!;
      const v2 = values[idx - 2]!;
      const v3 = values[idx - 3]!;
      return (v3 * 1 + v2 * 2 + v1 * 2 + v0 * 1) / 6;
    }
    for (let i = 3; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.cmo", () => {
  it("returns NaN for the first length calls (momentum warmup + window fill, length=3)", () => {
    const state = {};
    const values = [10, 12, 11, 14];
    expect(cmo(state, values[0]!, 3)).toBeNaN(); // no prevValue yet
    expect(cmo(state, values[1]!, 3)).toBeNaN(); // window len 1 < 3
    expect(cmo(state, values[2]!, 3)).toBeNaN(); // window len 2 < 3
  });

  it("matches a hand-computed CMO once the gain/loss window fills (length=2)", () => {
    const state = {};
    // mom: 2, -1, 3, -4
    cmo(state, 10, 2); // NaN, no prevValue
    cmo(state, 12, 2); // NaN, window [2] len 1 < 2
    // window [mom=2, mom=-1] -> gains=[2,0]=2, losses=[0,1]=1 -> 100*(2-1)/3
    expect(cmo(state, 11, 2)).toBeCloseTo(100 * (2 - 1) / 3, 9);
    // window [-1,3] -> gains=[0,3]=3, losses=[1,0]=1 -> 100*(3-1)/4
    expect(cmo(state, 14, 2)).toBeCloseTo(100 * (3 - 1) / 4, 9);
    // window [3,-4] -> gains=[3,0]=3, losses=[0,4]=4 -> 100*(3-4)/7
    expect(cmo(state, 10, 2)).toBeCloseTo((100 * (3 - 4)) / 7, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => cmo(state, c, 3));
    expect(results[2]).toBeNaN();
    expect(results[3]).toBeCloseTo(33.3333333333, 9);
    expect(results[6]).toBeCloseTo(100.0, 9);
    expect(results[9]).toBeCloseTo(50.0, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    cmo(stateA, 10, 2);
    cmo(stateA, 12, 2);
    expect(cmo(stateA, 11, 2)).toBeCloseTo(100 * (2 - 1) / 3, 9);
    expect(cmo(stateB, 100, 2)).toBeNaN();
  });

  it("returns 0 (not NaN) when the window has zero net movement (denominator guard)", () => {
    const state = {};
    cmo(state, 10, 2); // NaN, no prevValue
    cmo(state, 10, 2); // NaN, window len 1 < 2
    expect(cmo(state, 10, 2)).toBe(0);
    expect(cmo(state, 10, 2)).toBe(0);
  });

  it("skips (does not poison) the gain/loss window across a NaN gap, unlike ta.sma/ta.vwma/ta.swma's push-and-poison buffers", () => {
    // pine2py cmo.py returns NaN immediately (without appending) when source.get(0) or
    // source.get(1) is NaN — the gains/losses window is only ever touched by valid momentum.
    // A NaN bar should therefore NOT cost `length` bars of recovery the way sma's fixed
    // circular buffer would (MEMORY.md ta.cmo architecture note).
    const state = {};
    cmo(state, 10, 2); // NaN, no prevValue
    cmo(state, 12, 2); // NaN, window [mom=2] len 1 < 2
    expect(cmo(state, 11, 2)).toBeCloseTo(100 * (2 - 1) / 3, 9); // window [2,-1]
    expect(cmo(state, NaN, 2)).toBeNaN(); // value NaN -> skip, window untouched, prevValue <- NaN
    expect(cmo(state, 9, 2)).toBeNaN(); // prevValue NaN -> skip, window still untouched
    // mom = 13-9 = 4 replaces the oldest window slot (mom=2 from the very first valid pair) ->
    // window [-1,4] -> gains=[0,4]=4, losses=[1,0]=1 -> 100*(4-1)/5 = 60 (one bar of recovery, not two)
    expect(cmo(state, 13, 2)).toBeCloseTo(60, 9);
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 3;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.3 + (i % 3));
    const results = values.map((v) => cmo(state, v, length));
    function direct(idx: number): number {
      let sumGain = 0;
      let sumLoss = 0;
      for (let j = idx - length + 1; j <= idx; j++) {
        const mom = values[j]! - values[j - 1]!;
        sumGain += mom >= 0 ? mom : 0;
        sumLoss += mom < 0 ? -mom : 0;
      }
      const denom = sumGain + sumLoss;
      return denom === 0 ? 0 : (100 * (sumGain - sumLoss)) / denom;
    }
    for (let i = length; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.cci", () => {
  it("returns NaN for the first length-1 calls (window not yet full, length=3)", () => {
    const state = {};
    expect(cci(state, 7, 3)).toBeNaN();
    expect(cci(state, 8, 3)).toBeNaN();
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => cci(state, c, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(100.0, 9);
    expect(results[3]).toBeCloseTo(-50.0, 9);
    expect(results[9]).toBeCloseTo(80.0, 9);
  });

  it("returns 0 (not NaN) when the window is perfectly flat (mean deviation guard)", () => {
    const state = {};
    cci(state, 10, 2);
    expect(cci(state, 10, 2)).toBe(0);
    expect(cci(state, 10, 2)).toBe(0);
  });

  // pine2py cci.py rebuilds its window from source history every bar until the first fully
  // clean (no-NaN) window is found (last_idx<0 branch) — a NaN embedded in the warmup period
  // delays initialization rather than being poison-primed like ta.sma's fixed buffer (verified
  // against a direct pine2py cci() run, scratch/verify_cci_fuzz.mjs).
  it("retries window initialization across an embedded NaN in the warmup period (length=3)", () => {
    const state = {};
    expect(cci(state, 1, 3)).toBeNaN(); // data_len 1 < 3
    expect(cci(state, 2, 3)).toBeNaN(); // data_len 2 < 3
    expect(cci(state, NaN, 3)).toBeNaN(); // window [1,2,NaN] has NaN -> not persisted
    expect(cci(state, 4, 3)).toBeNaN(); // window [2,NaN,4] has NaN -> not persisted
    expect(cci(state, 5, 3)).toBeNaN(); // window [NaN,4,5] has NaN -> not persisted
    // window [4,5,9] finally clean -> sma=6, meanDev=(2+1+3)/3=2, cci=(9-6)/(0.015*2)=100
    expect(cci(state, 9, 3)).toBeCloseTo(100, 9);
  });

  // Once initialized, a NaN current value freezes the window entirely (pine2py: `if isnan(current):
  // return nan` before window.pop/append) rather than poisoning it like ta.sma/ta.vwma/ta.swma's
  // push-and-poison buffers — the next valid bar resumes from the same (unmodified) window.
  it("skips (does not poison) the window across a NaN gap once initialized", () => {
    const state = {};
    cci(state, 7, 3);
    cci(state, 8, 3);
    expect(cci(state, 9, 3)).toBeCloseTo(100, 9); // window [7,8,9] locked in
    expect(cci(state, NaN, 3)).toBeNaN(); // skip, window untouched
    // window [8,9,11] (oldest 7 evicted, 11 appended) -> sma=9.3333, meanDev=1.1111, cci=100
    expect(cci(state, 11, 3)).toBeCloseTo(100, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    cci(stateA, 7, 2);
    expect(cci(stateA, 8, 2)).toBeCloseTo(66.66666666666667, 9);
    expect(cci(stateB, 100, 2)).toBeNaN();
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 3;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.3 + (i % 3));
    const results = values.map((v) => cci(state, v, length));
    function direct(idx: number): number {
      const window = [values[idx - 2]!, values[idx - 1]!, values[idx]!];
      const smaVal = window.reduce((a, b) => a + b, 0) / length;
      const meanDev = window.reduce((a, b) => a + Math.abs(b - smaVal), 0) / length;
      if (meanDev === 0) return 0;
      return (values[idx]! - smaVal) / (0.015 * meanDev);
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.median", () => {
  it("returns NaN for the first length-1 calls (window not yet full, length=3)", () => {
    const state = {};
    expect(median(state, 101, 3)).toBeNaN();
    expect(median(state, 102, 3)).toBeNaN();
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3, odd length)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => median(state, c, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(102, 9); // sorted [101,102,103] -> mid
    expect(results[3]).toBeCloseTo(102, 9); // buffer [102,102,103]
    expect(results[9]).toBeCloseTo(107, 9);
  });

  it("averages the two middle values for an even length", () => {
    const state = {};
    const vals = [10, 20, 30, 40];
    const results = vals.map((v) => median(state, v, 4));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeNaN();
    // sorted [10,20,30,40] -> (20+30)/2
    expect(results[3]).toBeCloseTo(25, 9);
  });

  it("returns the value itself immediately for length=1", () => {
    const state = {};
    expect(median(state, 5, 1)).toBe(5);
    expect(median(state, 7, 1)).toBe(7);
    expect(median(state, 3, 1)).toBe(3);
  });

  // pine2py median.py has no explicit skip-on-NaN branch — the underlying source history (pushed
  // via ensure_series/context.param before median() runs) always records the raw value, so a NaN
  // poisons the window exactly like ta.sma/ta.change/ta.highest's raw-passthrough circular buffers
  // (unlike ta.cci's skip-freeze). Verified against a direct pine2py median() run (300-trial fuzz,
  // length 1-10, ~12% NaN injection rate, 0 mismatches).
  it("poisons (does not skip-freeze) the window across a NaN gap once initialized", () => {
    const state = {};
    median(state, 7, 3);
    median(state, 8, 3);
    expect(median(state, 9, 3)).toBeCloseTo(8, 9); // window [7,8,9] -> 8
    expect(median(state, NaN, 3)).toBeNaN(); // window [8,9,NaN] has NaN
    expect(median(state, 11, 3)).toBeNaN(); // window [9,NaN,11] still has NaN (7 evicted, not NaN slot)
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    median(stateA, 7, 2);
    expect(median(stateA, 9, 2)).toBeCloseTo(8, 9);
    expect(median(stateB, 100, 2)).toBeNaN();
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 4;
    const values = Array.from({ length: 25 }, (_, i) => 100 + i * 1.7 + (i % 5));
    const results = values.map((v) => median(state, v, length));
    function direct(idx: number): number {
      const window = [values[idx - 3]!, values[idx - 2]!, values[idx - 1]!, values[idx]!].slice().sort((a, b) => a - b);
      return (window[1]! + window[2]!) / 2;
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.mode", () => {
  it("returns NaN for the first length-1 calls regardless of value validity (call-count gate, length=3)", () => {
    const state = {};
    expect(mode(state, 101, 3)).toBeNaN();
    expect(mode(state, 102, 3)).toBeNaN();
  });

  // pine2py wavealgo/ta/mode.py's warmup gate is a pure call-count counter
  // (context.get_ta_state("count")), independent of whether the window's values are NaN — unlike
  // ta.median's gate (buffer still has an un-overwritten NaN-primed slot). Verified against a
  // direct pine2py mode() run (Context().param()/get_ta_state() with idx advanced per bar).
  it("all-distinct-frequency window ties on the minimum value once the window fills", () => {
    const state = {};
    mode(state, 101, 3); // NaN
    mode(state, 102, 3); // NaN
    // window [101,102,103], all frequency 1 -> tie-break to the minimum
    expect(mode(state, 103, 3)).toBeCloseTo(101, 9);
  });

  it("returns the most frequent value, not just the most recent (length=4)", () => {
    const state = {};
    mode(state, 5, 4);
    mode(state, 5, 4);
    mode(state, 3, 4);
    expect(mode(state, 3, 4)).toBeCloseTo(3, 9); // window [5,5,3,3] -> tie 5 vs 3, min=3
  });

  it("returns the value itself immediately for length=1", () => {
    const state = {};
    expect(mode(state, 5, 1)).toBe(5);
    expect(mode(state, 7, 1)).toBe(7);
    expect(mode(state, 3, 1)).toBe(3);
  });

  // Unlike ta.median (any NaN in the window poisons the whole result), ta.mode's individual NaN
  // entries are simply excluded from the frequency count — only an all-NaN window returns NaN.
  it("skips (does not poison on) individual NaN entries in the window", () => {
    const state = {};
    mode(state, 1, 3); // NaN
    mode(state, 1, 3); // NaN
    expect(mode(state, NaN, 3)).toBeCloseTo(1, 9); // window [1,1,NaN] -> vals=[1,1] -> mode=1
    expect(mode(state, 2, 3)).toBeCloseTo(1, 9); // window [1,NaN,2] -> vals=[1,2] tie -> min=1
  });

  it("returns NaN only when every value in the window is NaN", () => {
    const state = {};
    expect(mode(state, NaN, 2)).toBeNaN();
    expect(mode(state, NaN, 2)).toBeNaN();
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    mode(stateA, 7, 2);
    expect(mode(stateA, 7, 2)).toBeCloseTo(7, 9);
    expect(mode(stateB, 100, 2)).toBeNaN();
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 4;
    // small integer range to force repeated values (frequency ties matter for mode)
    const values = Array.from({ length: 25 }, (_, i) => (i * 3) % 5);
    const results = values.map((v) => mode(state, v, length));
    function direct(idx: number): number {
      const window = [values[idx - 3]!, values[idx - 2]!, values[idx - 1]!, values[idx]!];
      const counts = new Map<number, number>();
      for (const v of window) counts.set(v, (counts.get(v) ?? 0) + 1);
      let maxFreq = 0;
      for (const c of counts.values()) if (c > maxFreq) maxFreq = c;
      let result = Infinity;
      for (const [v, c] of counts) if (c === maxFreq && v < result) result = v;
      return result;
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.percentrank", () => {
  it("returns NaN for the first length calls (window excludes the current bar, so warmup needs length+1 bars — one later than ta.median/ta.mode's length, length=3)", () => {
    const state = {};
    expect(percentrank(state, 101, 3)).toBeNaN();
    expect(percentrank(state, 102, 3)).toBeNaN();
    expect(percentrank(state, 103, 3)).toBeNaN(); // window still empty (buffer not yet written)
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => percentrank(state, c, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeNaN();
    expect(results[3]).toBeCloseTo(66.6666666667, 6); // window [101,102,103] vs 102 -> 2/3
    expect(results[4]).toBeCloseTo(100, 9); // window [102,103,102] vs 104 -> 3/3
    expect(results[7]).toBeCloseTo(66.6666666667, 6);
    expect(results[9]).toBeCloseTo(100, 9);
  });

  it("returns 100 immediately for length=1 (window of 1 prior bar, current is always >= a single prior value once tied or higher)", () => {
    const state = {};
    expect(percentrank(state, 5, 1)).toBeNaN(); // no prior bar yet
    expect(percentrank(state, 7, 1)).toBeCloseTo(100, 9); // prior=5, 5<=7
    expect(percentrank(state, 3, 1)).toBeCloseTo(0, 9); // prior=7, 7<=3 false
  });

  // pine2py percentrank.py checks `math.isnan(current)` before even touching the window — the
  // current bar's own value is never part of the counted window (i only ranges 1..length), so a
  // NaN current must be checked separately from the buffer's NaN scan.
  it("returns NaN when the current value itself is NaN, independent of the window's content", () => {
    const state = {};
    percentrank(state, 1, 2);
    percentrank(state, 2, 2);
    expect(percentrank(state, NaN, 2)).toBeNaN(); // window [1,2] is fully valid, but current is NaN
  });

  // Unlike ta.mode (individual NaN entries are skipped from the count), ta.percentrank poisons the
  // whole result if any of the length prior bars is NaN — matching ta.median's "any NaN in window"
  // gate, verified against a direct pine2py percentrank() run (300-trial fuzz, length 1-10, ~12%
  // NaN injection, 0 mismatches).
  it("poisons (does not skip) the result when a NaN is inside the prior-length window, and the poison persists until the NaN slot itself is overwritten by a later push", () => {
    const state = {};
    percentrank(state, 5, 2); // NaN (window empty), buffer [5, NaN]
    percentrank(state, NaN, 2); // NaN (current itself is NaN), buffer [5, NaN]
    expect(percentrank(state, 6, 2)).toBeNaN(); // window [5,NaN] has a real NaN slot, buffer [6, NaN]
    expect(percentrank(state, 7, 2)).toBeNaN(); // window [6,NaN] still has that NaN slot, buffer [6, 7]
    expect(percentrank(state, 8, 2)).toBeCloseTo(100, 9); // window [6,7] fully valid vs 8 -> 2/2
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    percentrank(stateA, 5, 1);
    expect(percentrank(stateA, 7, 1)).toBeCloseTo(100, 9);
    expect(percentrank(stateB, 100, 1)).toBeNaN();
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound, read-before-write ordering)", () => {
    const state = {};
    const length = 4;
    const values = Array.from({ length: 25 }, (_, i) => 100 + ((i * 7) % 11));
    const results = values.map((v) => percentrank(state, v, length));
    function direct(idx: number): number {
      // window = the `length` bars strictly before idx (current bar excluded)
      const window = [values[idx - 4]!, values[idx - 3]!, values[idx - 2]!, values[idx - 1]!];
      const count = window.filter((w) => w <= values[idx]!).length;
      return (count / length) * 100;
    }
    for (let i = length; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.dev", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3)", () => {
    const state = {};
    expect(dev(state, 101, 3)).toBeNaN();
    expect(dev(state, 102, 3)).toBeNaN();
  });

  it("returns exactly 0 when every value in the window is identical (tie case, no division involved so no epsilon leak like ta.cci's mean-deviation guard)", () => {
    const state = {};
    dev(state, 7, 3);
    dev(state, 7, 3);
    expect(dev(state, 7, 3)).toBe(0);
    expect(dev(state, 7, 3)).toBe(0);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => dev(state, c, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(0.6666666667, 6);
    expect(results[3]).toBeCloseTo(0.4444444444, 6);
    expect(results[4]).toBeCloseTo(0.6666666667, 6);
    expect(results[5]).toBeCloseTo(1.1111111111, 6);
    expect(results[8]).toBeCloseTo(0.6666666667, 6);
    expect(results[9]).toBeCloseTo(1.1111111111, 6);
  });

  it("matches a hand-computed MAD once the window fills (length=2)", () => {
    const state = {};
    dev(state, 10, 2); // NaN, buffer [10, NaN]
    expect(dev(state, 12, 2)).toBeCloseTo(1, 9); // window [10,12], mean=11, MAD=(1+1)/2=1
    expect(dev(state, 15, 2)).toBeCloseTo(1.5, 9); // window [12,15], mean=13.5, MAD=(1.5+1.5)/2=1.5
    expect(dev(state, 20, 2)).toBeCloseTo(2.5, 9); // window [15,20], mean=17.5, MAD=(2.5+2.5)/2=2.5
  });

  it("returns exactly 0 for length=1 (a single-element window has zero deviation from its own mean)", () => {
    const state = {};
    expect(dev(state, 5, 1)).toBe(0);
    expect(dev(state, 7, 1)).toBe(0);
    expect(dev(state, 3, 1)).toBe(0);
  });

  // pine2py dev.py accepts context/state_key kwargs but never calls context.get_ta_state — unlike
  // ta.cci (which freezes the window on NaN post-init), dev() re-reads the live Series directly on
  // every call, so it has no persisted "poison" concept beyond the buffer's own contents: the
  // window keeps rolling forward every bar regardless of NaN (raw-passthrough, sma/change style),
  // and the poison only clears once the NaN slot itself is overwritten by a later push.
  it("poisons the result while a NaN is inside the window, and the window keeps rolling forward (NaN is not frozen in place)", () => {
    const state = {};
    dev(state, 5, 2); // NaN (window empty), buffer [5, NaN]
    dev(state, NaN, 2); // NaN (still incomplete + now holds a real NaN), buffer [5, NaN]
    expect(dev(state, 6, 2)).toBeNaN(); // buffer becomes [6, NaN] - still has the NaN slot
    expect(dev(state, 7, 2)).toBeCloseTo(0.5, 9); // buffer becomes [6, 7] - NaN slot finally overwritten
    expect(dev(state, 8, 2)).toBeCloseTo(0.5, 9); // buffer [8, 7], mean=7.5, MAD=0.5
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    dev(stateA, 10, 2);
    expect(dev(stateA, 12, 2)).toBeCloseTo(1, 9);
    expect(dev(stateB, 100, 2)).toBeNaN();
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 4;
    const values = Array.from({ length: 25 }, (_, i) => 100 + ((i * 7) % 11));
    const results = values.map((v) => dev(state, v, length));
    function direct(idx: number): number {
      const window = [values[idx - 3]!, values[idx - 2]!, values[idx - 1]!, values[idx]!];
      const mean = window.reduce((a, b) => a + b, 0) / length;
      return window.reduce((a, b) => a + Math.abs(b - mean), 0) / length;
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

// ta.range(source, length) — highest(source,length) - lowest(source,length) 재호출 합성(stoch과
// 동일 원칙, C256). "지원하지 않는 호출" 클러스터 조사 중 발견된 실제 누락 TA 함수 —
// wavealgo/ta/range_func.py + wavealgo/ta/__init__.py L76 TA 함수 세트에 등록됨(array.range(id)와는
// 별개 함수).
describe("ta.range", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3)", () => {
    const state = {};
    expect(range(state, 101, 3)).toBeNaN();
    expect(range(state, 102, 3)).toBeNaN();
  });

  it("returns exactly 0 when every value in the window is identical (tie case — highest and lowest agree on the same value)", () => {
    const state = {};
    range(state, 7, 3);
    range(state, 7, 3);
    expect(range(state, 7, 3)).toBe(0);
    expect(range(state, 7, 3)).toBe(0);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => range(state, c, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    expect(results[2]).toBe(2);
    expect(results[3]).toBe(1);
    expect(results[4]).toBe(2);
    expect(results[5]).toBe(3);
    expect(results[6]).toBe(2);
    expect(results[7]).toBe(1);
    expect(results[8]).toBe(2);
    expect(results[9]).toBe(3);
  });

  it("matches a hand-computed range once the window fills (length=2)", () => {
    const state = {};
    range(state, 10, 2); // NaN, window [10, NaN]
    expect(range(state, 12, 2)).toBe(2); // window [10,12], max-min=2
    expect(range(state, 15, 2)).toBe(3); // window [12,15], max-min=3
    expect(range(state, 20, 2)).toBe(5); // window [15,20], max-min=5
  });

  it("returns exactly 0 for length=1 (a single-element window has zero range against itself)", () => {
    const state = {};
    expect(range(state, 5, 1)).toBe(0);
    expect(range(state, 7, 1)).toBe(0);
    expect(range(state, 3, 1)).toBe(0);
  });

  it("poisons the result while a NaN is inside the window, and the window keeps rolling forward (NaN is not frozen in place — mirrors ta.highest/ta.lowest's nanCount gate)", () => {
    const state = {};
    range(state, 5, 3); // NaN (window incomplete), buffer [5, NaN, NaN]
    range(state, 6, 3); // NaN (still incomplete), buffer [5, 6, NaN]
    expect(range(state, NaN, 3)).toBeNaN(); // buffer [5, 6, NaN] - now a genuine NaN fills the last slot
    expect(range(state, 7, 3)).toBeNaN(); // buffer [7, 6, NaN] - NaN slot still present
    expect(range(state, 8, 3)).toBeNaN(); // buffer [7, 8, NaN] - NaN slot still present
    expect(range(state, 9, 3)).toBe(2); // buffer [7, 8, 9] - NaN slot finally overwritten, max-min=2
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    range(stateA, 10, 2);
    expect(range(stateA, 12, 2)).toBe(2);
    expect(range(stateB, 100, 2)).toBeNaN();
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 4;
    const values = Array.from({ length: 25 }, (_, i) => 100 + ((i * 7) % 11));
    const results = values.map((v) => range(state, v, length));
    function direct(idx: number): number {
      const window = [values[idx - 3]!, values[idx - 2]!, values[idx - 1]!, values[idx]!];
      return Math.max(...window) - Math.min(...window);
    }
    for (let i = length - 1; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(direct(i), 9);
    }
  });
});

describe("ta.change / ta.mom", () => {
  it("returns NaN for the first length calls (buffer warmup, length=3)", () => {
    const state = {};
    expect(change(state, 101, 3)).toBeNaN();
    expect(change(state, 102, 3)).toBeNaN();
    expect(change(state, 103, 3)).toBeNaN();
  });

  it("matches a hand-computed change once the window fills (length=2)", () => {
    const state = {};
    change(state, 10, 2); // NaN, buffer [10, NaN]
    change(state, 12, 2); // NaN, buffer [10, 12]
    expect(change(state, 15, 2)).toBe(5); // 15 - 10 (2 calls ago)
    expect(change(state, 20, 2)).toBe(8); // 20 - 12
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => change(state, c, 3));
    expect(results[2]).toBeNaN();
    expect(results[3]).toBeCloseTo(1, 9);
    expect(results[6]).toBeCloseTo(4, 9);
    expect(results[9]).toBeCloseTo(2, 9);
  });

  it("ta.mom is the identical runtime function as ta.change (pine2py mom() aliases change(), TA_REGISTRY.mom.rtPath === rt.ta.change — no separate rt.ta.mom exists)", () => {
    const stateA = {};
    const stateB = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const changeResults = closes.map((c) => change(stateA, c, 3));
    const momResults = closes.map((c) => change(stateB, c, 3));
    expect(momResults).toEqual(changeResults);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    change(stateA, 10, 2);
    change(stateA, 12, 2);
    expect(change(stateA, 15, 2)).toBe(5);
    expect(change(stateB, 100, 2)).toBeNaN();
  });

  it("poisons the window across a NaN gap (unlike ta.cmo's skip-on-NaN) — matches ta.sma/ta.vwma/ta.swma's push-and-poison buffers, since change/mom store the raw source value itself rather than a derived gain/loss aggregate", () => {
    const state = {};
    change(state, 10, 2); // NaN, buffer [10, NaN]
    change(state, 12, 2); // NaN, buffer [10, 12]
    expect(change(state, 15, 2)).toBe(5); // 15 - 10, buffer [15, 12]
    expect(change(state, NaN, 2)).toBeNaN(); // value NaN -> buffer [15, NaN]
    expect(change(state, 20, 2)).toBe(5); // old=15 (untouched slot) -> 20-15=5, buffer [20, NaN]
    expect(change(state, 25, 2)).toBeNaN(); // old=NaN (the poisoned slot cycles back in), buffer [20, 25]
    expect(change(state, 30, 2)).toBe(10); // old=20 (fresh, non-NaN) -> 30-20=10
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 3;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.7 + (i % 4));
    const results = values.map((v) => change(state, v, length));
    for (let i = length; i < values.length; i++) {
      expect(results[i]).toBeCloseTo(values[i]! - values[i - length]!, 9);
    }
  });
});

describe("ta.roc", () => {
  it("returns NaN for the first length calls (buffer warmup, length=3)", () => {
    const state = {};
    expect(roc(state, 101, 3)).toBeNaN();
    expect(roc(state, 102, 3)).toBeNaN();
    expect(roc(state, 103, 3)).toBeNaN();
  });

  it("matches a hand-computed roc once the window fills (length=2)", () => {
    const state = {};
    roc(state, 10, 2); // NaN, buffer [10, NaN]
    roc(state, 12, 2); // NaN, buffer [10, 12]
    expect(roc(state, 15, 2)).toBeCloseTo(50, 9); // 100*(15-10)/10
    expect(roc(state, 20, 2)).toBeCloseTo(66.66666666666667, 9); // 100*(20-12)/12
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => roc(state, c, 3));
    expect(results[2]).toBeNaN();
    expect(results[3]).toBeCloseTo(0.9900990099, 9);
    expect(results[6]).toBeCloseTo(3.9215686275, 9);
    expect(results[9]).toBeCloseTo(1.8867924528, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    roc(stateA, 10, 2);
    roc(stateA, 12, 2);
    expect(roc(stateA, 15, 2)).toBeCloseTo(50, 9);
    expect(roc(stateB, 100, 2)).toBeNaN();
  });

  it("returns NaN when the length-bars-ago value is 0 (division guard absent from ta.change/ta.mom)", () => {
    const state = {};
    roc(state, 0, 2); // NaN, buffer [0, NaN]
    roc(state, 1, 2); // NaN, buffer [0, 1]
    expect(roc(state, 2, 2)).toBeNaN(); // old=0 -> guard, buffer [2, 1]
    expect(roc(state, 3, 2)).toBeCloseTo(200, 9); // old=1 (fresh) -> 100*(3-1)/1
  });

  it("poisons the window across a NaN gap (same raw-passthrough principle as ta.change/ta.mom — roc stores the raw source value itself)", () => {
    const state = {};
    roc(state, 10, 2); // NaN, buffer [10, NaN]
    roc(state, 12, 2); // NaN, buffer [10, 12]
    expect(roc(state, 15, 2)).toBeCloseTo(50, 9); // 100*(15-10)/10, buffer [15, 12]
    expect(roc(state, NaN, 2)).toBeNaN(); // value NaN -> buffer [15, NaN]
    expect(roc(state, 20, 2)).toBeCloseTo(33.33333333333333, 9); // old=15 (untouched slot), buffer [20, NaN]
    expect(roc(state, 25, 2)).toBeNaN(); // old=NaN (poisoned slot cycles back in), buffer [20, 25]
    expect(roc(state, 30, 2)).toBeCloseTo(50, 9); // old=20 (fresh) -> 100*(30-20)/20
  });

  it("stays correct across many bars beyond the initial fill (circular buffer wraparound)", () => {
    const state = {};
    const length = 3;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.7 + (i % 4));
    const results = values.map((v) => roc(state, v, length));
    for (let i = length; i < values.length; i++) {
      const prev = values[i - length]!;
      expect(results[i]).toBeCloseTo((100 * (values[i]! - prev)) / prev, 9);
    }
  });
});

describe("ta.crossover", () => {
  it("returns false on the first call (no previous value to compare)", () => {
    const state = {};
    expect(crossover(state, 10, 5)).toBe(false);
  });

  it("detects an upward cross (a was <= b, now a > b)", () => {
    const state = {};
    crossover(state, 5, 10); // a <= b
    expect(crossover(state, 15, 10)).toBe(true); // a now > b
  });

  it("stays false while a remains above b across calls (no new cross)", () => {
    const state = {};
    crossover(state, 15, 10); // first call: false regardless
    expect(crossover(state, 20, 10)).toBe(false); // a was already > b
  });

  it("stays false when a crosses below b (that's crossunder's job)", () => {
    const state = {};
    crossover(state, 15, 10);
    expect(crossover(state, 5, 10)).toBe(false);
  });

  it("returns false when either current value is NaN", () => {
    const state = {};
    crossover(state, 5, 10);
    expect(crossover(state, NaN, 10)).toBe(false);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    crossover(stateA, 5, 10);
    expect(crossover(stateA, 15, 10)).toBe(true);
    expect(crossover(stateB, 15, 10)).toBe(false); // stateB has no prior value yet
  });
});

describe("ta.crossunder", () => {
  it("returns false on the first call (no previous value to compare)", () => {
    const state = {};
    expect(crossunder(state, 10, 5)).toBe(false);
  });

  it("detects a downward cross (a was >= b, now a < b)", () => {
    const state = {};
    crossunder(state, 15, 10); // a >= b
    expect(crossunder(state, 5, 10)).toBe(true); // a now < b
  });

  it("stays false when a crosses above b (that's crossover's job)", () => {
    const state = {};
    crossunder(state, 5, 10);
    expect(crossunder(state, 15, 10)).toBe(false);
  });

  it("returns false when either current value is NaN", () => {
    const state = {};
    crossunder(state, 15, 10);
    expect(crossunder(state, NaN, 10)).toBe(false);
  });
});

describe("ta.cross", () => {
  it("returns false on the first call (no previous value to compare)", () => {
    const state = {};
    expect(cross(state, 10, 5)).toBe(false);
  });

  it("detects an upward cross (a was <= b, now a > b) — same as crossover", () => {
    const state = {};
    cross(state, 5, 10); // a <= b
    expect(cross(state, 15, 10)).toBe(true); // a now > b
  });

  it("detects a downward cross (a was >= b, now a < b) — same as crossunder", () => {
    const state = {};
    cross(state, 15, 10); // a >= b
    expect(cross(state, 5, 10)).toBe(true); // a now < b
  });

  it("stays false while a remains above b across calls (no new cross)", () => {
    const state = {};
    cross(state, 15, 10); // first call: false regardless
    expect(cross(state, 20, 10)).toBe(false); // a was already > b
  });

  it("returns false when either current value is NaN", () => {
    const state = {};
    cross(state, 5, 10);
    expect(cross(state, NaN, 10)).toBe(false);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    cross(stateA, 5, 10);
    expect(cross(stateA, 15, 10)).toBe(true);
    expect(cross(stateB, 15, 10)).toBe(false); // stateB has no prior value yet
  });

  it("agrees with crossover(a,b) || crossunder(a,b) across a scripted sequence", () => {
    // 두 상태 슬롯을 병렬로 굴려, cross()가 매 바 crossover||crossunder와 정확히 동치임을 확인
    // (pine2py cross.py L54-55가 이 두 부울식의 OR임을 소스 대조로 확인한 것의 실행 레벨 검증)
    const crossState = {};
    const overState = {};
    const underState = {};
    const as = [5, 15, 15, 5, 5, 20, 10, 10];
    const bs = [10, 10, 10, 10, 10, 10, 10, 10];
    for (let i = 0; i < as.length; i++) {
      const c = cross(crossState, as[i]!, bs[i]!);
      const expected = crossover(overState, as[i]!, bs[i]!) || crossunder(underState, as[i]!, bs[i]!);
      expect(c).toBe(expected);
    }
  });
});

describe("ta.rising", () => {
  it("returns false on the very first call regardless of length (no previous value yet)", () => {
    const state = {};
    expect(rising(state, 100, 1)).toBe(false);
  });

  it("stays false while the streak has not yet reached length (length=3)", () => {
    const state = {};
    rising(state, 10, 3); // false: no prev
    expect(rising(state, 11, 3)).toBe(false); // streak=1
    expect(rising(state, 12, 3)).toBe(false); // streak=2
  });

  it("becomes true exactly once length consecutive strict increases accumulate", () => {
    const state = {};
    rising(state, 10, 3);
    rising(state, 11, 3); // streak=1
    rising(state, 12, 3); // streak=2
    expect(rising(state, 13, 3)).toBe(true); // streak=3
  });

  it("resets the streak immediately on a non-increase (equal value)", () => {
    const state = {};
    rising(state, 10, 2);
    expect(rising(state, 11, 2)).toBe(false); // streak=1
    expect(rising(state, 11, 2)).toBe(false); // equal -> streak resets to 0
    expect(rising(state, 12, 2)).toBe(false); // streak=1 again, not yet 2
  });

  it("resets the streak immediately on a decrease", () => {
    const state = {};
    rising(state, 10, 2);
    rising(state, 15, 2); // streak=1
    expect(rising(state, 12, 2)).toBe(false); // decrease -> reset
  });

  it("resets on a NaN gap and rebuilds the streak from scratch afterward", () => {
    const state = {};
    rising(state, 10, 2);
    rising(state, 11, 2); // streak=1
    expect(rising(state, NaN, 2)).toBe(false); // NaN -> reset, prevValue becomes NaN
    expect(rising(state, 12, 2)).toBe(false); // prev is NaN -> still reset, streak=0
    expect(rising(state, 13, 2)).toBe(false); // 12->13: streak=1, not yet 2
    expect(rising(state, 14, 2)).toBe(true); // 13->14: streak=2
  });

  it("matches the pine2py-verified sample10.json trace (close, length=2)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => rising(state, c, 2));
    expect(results).toEqual([false, false, true, false, false, true, true, false, false, true]);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    rising(stateA, 10, 2);
    rising(stateA, 11, 2);
    expect(rising(stateA, 12, 2)).toBe(true); // streak=2 on stateA
    expect(rising(stateB, 12, 2)).toBe(false); // stateB has no prior value yet
  });

  it("supports a length that changes per call — no fixed-size buffer is allocated (unlike sma/wma), so TA_REGISTRY.lengthArgIndex is null for rising/falling", () => {
    const state = {};
    rising(state, 10, 999); // streak=0 (no prev)
    rising(state, 11, 1); // streak=1, length=1 -> true would be evaluated against a different length each call
    expect(rising(state, 12, 2)).toBe(true); // streak=2, compared against length=2 this call
    expect(rising(state, 13, 5)).toBe(false); // streak=3, but this call's length jumped to 5
  });
});

describe("ta.falling", () => {
  it("returns false on the very first call regardless of length (no previous value yet)", () => {
    const state = {};
    expect(falling(state, 100, 1)).toBe(false);
  });

  it("detects a single-bar fall at length=1", () => {
    const state = {};
    falling(state, 10, 1); // false: no prev
    expect(falling(state, 9, 1)).toBe(true); // 9 < 10
  });

  it("resets the streak immediately on a non-decrease (equal value)", () => {
    const state = {};
    falling(state, 10, 1);
    expect(falling(state, 10, 1)).toBe(false); // equal -> not falling
  });

  it("resets the streak immediately on an increase", () => {
    const state = {};
    falling(state, 10, 2);
    falling(state, 5, 2); // streak=1
    expect(falling(state, 8, 2)).toBe(false); // increase -> reset
  });

  it("matches the pine2py-verified sample10.json trace (open, length=1)", () => {
    const state = {};
    const opens = [100, 101, 102, 101, 103, 104, 105, 104, 106, 107];
    const results = opens.map((o) => falling(state, o, 1));
    expect(results).toEqual([false, false, false, true, false, false, false, true, false, false]);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    falling(stateA, 10, 1);
    expect(falling(stateA, 9, 1)).toBe(true);
    expect(falling(stateB, 9, 1)).toBe(false); // stateB has no prior value yet
  });

  it("mirrors rising on the negated sequence (falling(x) streak logic == rising(-x))", () => {
    const fallState = {};
    const riseState = {};
    const values = [10, 9, 8, 9, 7, 6, 6, 5, 10, 4];
    for (const v of values) {
      const f = falling(fallState, v, 2);
      const r = rising(riseState, -v, 2);
      expect(f).toBe(r);
    }
  });
});

describe("ta.variance", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3, data_len<length)", () => {
    const state = {};
    expect(variance(state, 101, 3)).toBeNaN();
    expect(variance(state, 102, 3)).toBeNaN();
  });

  it("matches a hand-computed population variance once the window fills (length=2)", () => {
    const state = {};
    variance(state, 10, 2); // NaN, buffer [10, NaN]
    expect(variance(state, 12, 2)).toBeCloseTo(1, 9); // mean=11, ((10-11)^2+(12-11)^2)/2 = 1
    expect(variance(state, 14, 2)).toBeCloseTo(1, 9); // window [12,14], mean=13, var=1
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => variance(state, c, 3));
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(0.6666666667, 9);
    expect(results[3]).toBeCloseTo(0.2222222222, 9);
    expect(results[5]).toBeCloseTo(1.5555555556, 9);
    expect(results[9]).toBeCloseTo(1.5555555556, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    variance(stateA, 10, 2);
    expect(variance(stateA, 12, 2)).toBeCloseTo(1, 9);
    expect(variance(stateB, 100, 2)).toBeNaN(); // stateB has no history yet
  });

  it("returns exactly 0 (not a tiny negative float) for a perfectly constant window", () => {
    const state = {};
    variance(state, 107.5, 3);
    variance(state, 107.5, 3);
    expect(variance(state, 107.5, 3)).toBe(0);
  });

  it("clamps a near-constant window's floating-point cancellation to 0 instead of a spurious negative", () => {
    // window [100.000000004, 100, 100, 100]: sumSq/length - mean^2 evaluates to
    // -1.8189894035458565e-12 unclamped (confirmed via a scratch probe) — the true
    // Σ(v-mean)²/length can never be negative, so this is purely a cancellation artifact.
    const state = {};
    variance(state, 100.000000004, 4);
    variance(state, 100, 4);
    variance(state, 100, 4);
    const v = variance(state, 100, 4);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeCloseTo(0, 9);
  });

  it("poisons the window across a NaN gap, then recovers once the buffer fills with fresh values", () => {
    const state = {};
    variance(state, 10, 2); // NaN, buffer [10, NaN]
    expect(variance(state, 12, 2)).toBeCloseTo(1, 9); // buffer [10, 12]
    expect(variance(state, NaN, 2)).toBeNaN(); // buffer [NaN, 12]
    expect(variance(state, 20, 2)).toBeNaN(); // buffer [NaN, 20] — poisoned slot still in window
    expect(variance(state, 24, 2)).toBeCloseTo(4, 9); // buffer [24, 20], mean=22, var=4
  });

  it("matches a direct O(length) recomputation across many bars (buffer wraparound regression)", () => {
    const state = {};
    const length = 4;
    const values = Array.from({ length: 20 }, (_, i) => 100 + i * 1.7 + (i % 4));
    const results = values.map((v) => variance(state, v, length));
    for (let i = length - 1; i < values.length; i++) {
      const window = values.slice(i - length + 1, i + 1);
      const mean = window.reduce((a, b) => a + b, 0) / length;
      const expected = window.reduce((a, v) => a + (v - mean) ** 2, 0) / length;
      expect(results[i]).toBeCloseTo(expected, 6);
    }
  });

  // C296: biased(3rd positional, TV 공식 ta.variance/ta.stdev 시그니처) — pine2py wavealgo/ta/
  // stdev.py는 2-positional 고정이라 오라클 구조적 불가, hand-verified만 가능(DIVERGENCES #110).
  it("biased=true (default, explicit or omitted) matches the population variance (divide by length)", () => {
    const stateOmitted = {};
    const stateExplicit = {};
    variance(stateOmitted, 10, 2); // warmup
    variance(stateExplicit, 10, 2); // warmup
    expect(variance(stateOmitted, 12, 2)).toBeCloseTo(1, 9);
    expect(variance(stateExplicit, 12, 2, true)).toBeCloseTo(1, 9);
  });

  it("biased=false applies Bessel's correction (divide by length-1, sample variance)", () => {
    const state = {};
    variance(state, 10, 2); // warmup
    // window=[10,12], mean=11, population=((10-11)^2+(12-11)^2)/2=1 -> unbiased=1*2/(2-1)=2.
    expect(variance(state, 12, 2, false)).toBeCloseTo(2, 9);
  });

  it("biased=false with length=1 divides by zero (natural IEEE754 fallout, not a special-cased guard)", () => {
    const stateZeroVariance = {};
    expect(variance(stateZeroVariance, 10, 1, false)).toBeNaN(); // population=0 -> 0/0=NaN
  });
});

describe("ta.stdev", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3)", () => {
    const state = {};
    expect(stdev(state, 101, 3)).toBeNaN();
    expect(stdev(state, 102, 3)).toBeNaN();
  });

  it("matches a hand-computed population stdev once the window fills (length=2)", () => {
    const state = {};
    stdev(state, 10, 2); // NaN
    expect(stdev(state, 12, 2)).toBeCloseTo(1, 9); // sqrt(variance=1)
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => stdev(state, c, 3));
    expect(results[1]).toBeNaN();
    expect(results[2]).toBeCloseTo(0.8164965809, 9);
    expect(results[3]).toBeCloseTo(0.4714045208, 9);
    expect(results[5]).toBeCloseTo(1.2472191289, 9);
    expect(results[9]).toBeCloseTo(1.2472191289, 9);
  });

  it("always equals sqrt(ta.variance) computed independently on the same input sequence", () => {
    const stdevState = {};
    const varianceState = {};
    const length = 3;
    const values = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    for (const v of values) {
      const sd = stdev(stdevState, v, length);
      const vr = variance(varianceState, v, length);
      if (Number.isNaN(vr)) {
        expect(sd).toBeNaN();
      } else {
        expect(sd).toBeCloseTo(Math.sqrt(vr), 9);
      }
    }
  });

  it("returns exactly 0 (not NaN) for a perfectly constant window — regression guard for the sqrt(negative-zero) clamp", () => {
    const state = {};
    stdev(state, 107.5, 3);
    stdev(state, 107.5, 3);
    expect(stdev(state, 107.5, 3)).toBe(0);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    stdev(stateA, 10, 2);
    expect(stdev(stateA, 12, 2)).toBeCloseTo(1, 9);
    expect(stdev(stateB, 100, 2)).toBeNaN();
  });

  // C296: biased passthrough (see "ta.variance" describe above for the DIVERGENCES #110 rationale).
  it("biased=false takes sqrt of the Bessel-corrected (unbiased) variance", () => {
    const state = {};
    stdev(state, 10, 2); // warmup
    // window=[10,12] -> unbiased variance=2 (see ta.variance test) -> stdev=sqrt(2).
    expect(stdev(state, 12, 2, false)).toBeCloseTo(Math.sqrt(2), 9);
  });

  it("always equals sqrt(ta.variance) computed independently with the same biased flag", () => {
    const stdevState = {};
    const varianceState = {};
    const length = 3;
    const values = [101, 103, 99, 107, 95, 110];
    for (const v of values) {
      const sd = stdev(stdevState, v, length, false);
      const vr = variance(varianceState, v, length, false);
      if (Number.isNaN(vr)) {
        expect(sd).toBeNaN();
      } else {
        expect(sd).toBeCloseTo(Math.sqrt(vr), 9);
      }
    }
  });
});

describe("ta.cum", () => {
  it("returns the running sum starting from the very first call (no warmup, unlike sma/swma)", () => {
    const state = {};
    expect(cum(state, 101)).toBe(101);
    expect(cum(state, 102)).toBe(203);
    expect(cum(state, 103)).toBe(306);
  });

  it("matches the pine2py-verified sample10.json trace (close)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => cum(state, c));
    expect(results[0]).toBe(101);
    expect(results[3]).toBe(408);
    expect(results[6]).toBe(723);
    expect(results[9]).toBe(1043);
  });

  it("treats a NaN input as 0 and carries the running sum forward — never returns NaN (third NaN-handling pattern, distinct from sma/wma's push-and-poison and cmo's skip-on-NaN)", () => {
    const state = {};
    expect(cum(state, 10)).toBe(10);
    expect(cum(state, NaN)).toBe(10); // NaN treated as 0 -> sum unchanged, and NOT NaN itself
    expect(cum(state, 5)).toBe(15);
  });

  it("returns 0 (not NaN) on a first call with a NaN input — initial state is 0.0, not NaN-primed", () => {
    const state = {};
    expect(cum(state, NaN)).toBe(0);
    expect(cum(state, 7)).toBe(7);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    cum(stateA, 10);
    cum(stateA, 20);
    expect(cum(stateA, 30)).toBe(60);
    expect(cum(stateB, 5)).toBe(5);
  });

  it("matches a hand-computed running sum across many bars including embedded NaN gaps", () => {
    const state = {};
    const values = [1, NaN, 2, 3, NaN, NaN, 4];
    const results = values.map((v) => cum(state, v));
    expect(results).toEqual([1, 1, 3, 6, 6, 6, 10]);
  });
});

describe("ta.barssince", () => {
  it("returns NaN on the very first call when the condition is false (NaN-primed, unlike ta.cum's 0.0-primed initial state)", () => {
    const state = {};
    expect(barssince(state, false)).toBeNaN();
  });

  it("resets to 0 the moment the condition first becomes true", () => {
    const state = {};
    barssince(state, false);
    barssince(state, false);
    expect(barssince(state, true)).toBe(0);
  });

  it("counts bars since the last true, incrementing by 1 per false call after the first true", () => {
    const state = {};
    expect(barssince(state, true)).toBe(0);
    expect(barssince(state, false)).toBe(1);
    expect(barssince(state, false)).toBe(2);
    expect(barssince(state, false)).toBe(3);
  });

  it("resets the counter back to 0 on any subsequent true, even mid-count", () => {
    const state = {};
    barssince(state, true);
    barssince(state, false);
    barssince(state, false);
    expect(barssince(state, true)).toBe(0);
    expect(barssince(state, false)).toBe(1);
  });

  it("matches the pine2py-verified sample10.json trace (condition = close > 105)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => barssince(state, c > 105));
    expect(results[0]).toBeNaN();
    expect(results[5]).toBeNaN();
    expect(results[6]).toBe(0);
    expect(results[7]).toBe(1);
    expect(results[8]).toBe(0);
    expect(results[9]).toBe(0);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    barssince(stateA, true);
    barssince(stateA, false);
    expect(barssince(stateA, false)).toBe(2);
    expect(barssince(stateB, false)).toBeNaN();
  });

  it("stays NaN across any number of false calls until the condition becomes true for the first time", () => {
    const state = {};
    const results = [false, false, false, false].map((v) => barssince(state, v));
    expect(results.every((r) => Number.isNaN(r))).toBe(true);
  });
});

describe("ta.valuewhen", () => {
  it("returns NaN on the very first call when the condition is false", () => {
    const state = {};
    expect(valuewhen(state, false, 100, 0)).toBeNaN();
  });

  it("occurrence=0: returns the source value the instant the condition becomes true", () => {
    const state = {};
    expect(valuewhen(state, true, 42, 0)).toBe(42);
  });

  it("occurrence=0: keeps returning the same value across false calls (history untouched when condition is false)", () => {
    const state = {};
    valuewhen(state, true, 42, 0);
    expect(valuewhen(state, false, 999, 0)).toBe(42);
    expect(valuewhen(state, false, 999, 0)).toBe(42);
  });

  it("occurrence=0: overwrites (evicts) on the next true, since size=occurrence+1=1", () => {
    const state = {};
    valuewhen(state, true, 42, 0);
    valuewhen(state, false, 999, 0);
    expect(valuewhen(state, true, 43, 0)).toBe(43);
  });

  it("occurrence=1: stays NaN until the condition has been true at least twice (size=2 warm-up)", () => {
    const state = {};
    expect(valuewhen(state, true, 10, 1)).toBeNaN();
    expect(valuewhen(state, false, 999, 1)).toBeNaN();
    expect(valuewhen(state, true, 20, 1)).toBe(10);
  });

  it("occurrence=1: returns the second-most-recent true value, not the latest", () => {
    const state = {};
    valuewhen(state, true, 10, 1);
    valuewhen(state, true, 20, 1);
    expect(valuewhen(state, true, 30, 1)).toBe(20);
    expect(valuewhen(state, false, 999, 1)).toBe(20);
  });

  it("occurrence=2: correctly reorders across repeated eviction cycles (size=3, 5 successive true calls)", () => {
    const state = {};
    expect(valuewhen(state, true, 1, 2)).toBeNaN();
    expect(valuewhen(state, true, 2, 2)).toBeNaN();
    expect(valuewhen(state, true, 3, 2)).toBe(1);
    expect(valuewhen(state, true, 4, 2)).toBe(2);
    expect(valuewhen(state, true, 5, 2)).toBe(3);
  });

  it("matches the pine2py-verified sample10.json trace (condition = close > 105, source = close)", () => {
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const state0 = {};
    const results0 = closes.map((c) => valuewhen(state0, c > 105, c, 0));
    expect(results0.slice(0, 6).every((r) => Number.isNaN(r))).toBe(true);
    expect(results0[6]).toBe(106);
    expect(results0[7]).toBe(106);
    expect(results0[8]).toBe(107);
    expect(results0[9]).toBe(108);

    const state1 = {};
    const results1 = closes.map((c) => valuewhen(state1, c > 105, c, 1));
    expect(results1.slice(0, 8).every((r) => Number.isNaN(r))).toBe(true);
    expect(results1[8]).toBe(106);
    expect(results1[9]).toBe(107);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    valuewhen(stateA, true, 7, 0);
    expect(valuewhen(stateA, false, 999, 0)).toBe(7);
    expect(valuewhen(stateB, false, 999, 0)).toBeNaN();
  });

  it("stores a NaN source value verbatim when the condition is true (raw-passthrough, no guard on value)", () => {
    const state = {};
    valuewhen(state, true, NaN, 0);
    expect(valuewhen(state, false, 5, 0)).toBeNaN();
    expect(valuewhen(state, true, 9, 0)).toBe(9);
  });

});

describe("ta.highest", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3, data_len<length)", () => {
    const state = {};
    expect(highest(state, 101, 3)).toBeNaN();
    expect(highest(state, 102, 3)).toBeNaN();
  });

  it("matches a hand-computed sliding max once the window fills (length=2)", () => {
    const state = {};
    highest(state, 10, 2); // NaN, buffer [10, NaN]
    expect(highest(state, 12, 2)).toBe(12); // window [10,12]
    expect(highest(state, 5, 2)).toBe(12); // window [12,5]
    expect(highest(state, 3, 2)).toBe(5); // window [5,3]
  });

  it("matches the pine2py-verified sample10.json trace (close, length=4)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => highest(state, c, 4));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBe(103);
    expect(results[4]).toBe(104);
    expect(results[5]).toBe(105);
    expect(results[6]).toBe(106);
    expect(results[7]).toBe(106);
    expect(results[8]).toBe(107);
    expect(results[9]).toBe(108);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    highest(stateA, 10, 2);
    expect(highest(stateA, 12, 2)).toBe(12);
    expect(highest(stateB, 100, 2)).toBeNaN();
  });

  it("poisons the window across a NaN gap, then recovers once the buffer fills with fresh values", () => {
    const state = {};
    highest(state, 10, 2); // NaN, buffer [10, NaN]
    expect(highest(state, 12, 2)).toBe(12); // buffer [10,12]
    expect(highest(state, NaN, 2)).toBeNaN(); // buffer [NaN,12]
    expect(highest(state, 20, 2)).toBeNaN(); // buffer [NaN,20] — poisoned slot still in window
    expect(highest(state, 24, 2)).toBe(24); // buffer [24,20], window fully real again
  });

  it("correctly pops dominated candidates from the back of the monotonic deque (decreasing-then-increasing run)", () => {
    const state = {};
    const values = [10, 9, 8, 7, 6, 5, 6, 7, 8, 9, 10, 11];
    const length = 3;
    const results = values.map((v) => highest(state, v, length));
    for (let i = length - 1; i < values.length; i++) {
      const window = values.slice(i - length + 1, i + 1);
      expect(results[i]).toBe(Math.max(...window));
    }
  });

  it("collapses to raw passthrough when length=1 (each bar's own value)", () => {
    const state = {};
    expect(highest(state, 5, 1)).toBe(5);
    expect(highest(state, 3, 1)).toBe(3);
    expect(highest(state, 8, 1)).toBe(8);
  });

  it("matches a from-scratch O(length) brute-force recomputation across a long sequence with embedded NaN gaps and buffer/deque wraparound", () => {
    const state = {};
    const length = 5;
    const raw = [12, 45, 7, 23, NaN, 88, 3, 3, 3, 60, 61, NaN, NaN, 10, 99, 1, 1, 1, 50, 20, 5, 5, 80, 80, 80, 2, 2, 2, 44, 44];
    const results = raw.map((v) => highest(state, v, length));
    for (let i = 0; i < raw.length; i++) {
      if (i < length - 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const window = raw.slice(i - length + 1, i + 1);
      if (window.some((w) => Number.isNaN(w))) {
        expect(results[i]).toBeNaN();
      } else {
        expect(results[i]).toBe(Math.max(...window));
      }
    }
  });
});

describe("ta.lowest", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3, data_len<length)", () => {
    const state = {};
    expect(lowest(state, 101, 3)).toBeNaN();
    expect(lowest(state, 102, 3)).toBeNaN();
  });

  it("matches a hand-computed sliding min once the window fills (length=2)", () => {
    const state = {};
    lowest(state, 10, 2); // NaN, buffer [10, NaN]
    expect(lowest(state, 12, 2)).toBe(10); // window [10,12]
    expect(lowest(state, 5, 2)).toBe(5); // window [12,5]
    expect(lowest(state, 20, 2)).toBe(5); // window [5,20]
  });

  it("matches the pine2py-verified sample10.json trace (close, length=4)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => lowest(state, c, 4));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBe(101);
    expect(results[4]).toBe(102);
    expect(results[5]).toBe(102);
    expect(results[6]).toBe(102);
    expect(results[7]).toBe(104);
    expect(results[8]).toBe(105);
    expect(results[9]).toBe(105);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    lowest(stateA, 10, 2);
    expect(lowest(stateA, 12, 2)).toBe(10);
    expect(lowest(stateB, 100, 2)).toBeNaN();
  });

  it("poisons the window across a NaN gap, then recovers once the buffer fills with fresh values", () => {
    const state = {};
    lowest(state, 10, 2); // NaN, buffer [10, NaN]
    expect(lowest(state, 12, 2)).toBe(10); // buffer [10,12]
    expect(lowest(state, NaN, 2)).toBeNaN(); // buffer [NaN,12]
    expect(lowest(state, 20, 2)).toBeNaN(); // buffer [NaN,20] — poisoned slot still in window
    expect(lowest(state, 8, 2)).toBe(8); // buffer [8,20], window fully real again
  });

  it("correctly pops dominated candidates from the back of the monotonic deque (increasing-then-decreasing run)", () => {
    const state = {};
    const values = [1, 2, 3, 4, 5, 4, 3, 2, 1, 0, -1];
    const length = 3;
    const results = values.map((v) => lowest(state, v, length));
    for (let i = length - 1; i < values.length; i++) {
      const window = values.slice(i - length + 1, i + 1);
      expect(results[i]).toBe(Math.min(...window));
    }
  });

  it("collapses to raw passthrough when length=1 (each bar's own value)", () => {
    const state = {};
    expect(lowest(state, 5, 1)).toBe(5);
    expect(lowest(state, 3, 1)).toBe(3);
    expect(lowest(state, 8, 1)).toBe(8);
  });

  it("matches a from-scratch O(length) brute-force recomputation across a long sequence with embedded NaN gaps and buffer/deque wraparound", () => {
    const state = {};
    const length = 5;
    const raw = [12, 45, 7, 23, NaN, 88, 3, 3, 3, 60, 61, NaN, NaN, 10, 99, 1, 1, 1, 50, 20, 5, 5, 80, 80, 80, 2, 2, 2, 44, 44];
    const results = raw.map((v) => lowest(state, v, length));
    for (let i = 0; i < raw.length; i++) {
      if (i < length - 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const window = raw.slice(i - length + 1, i + 1);
      if (window.some((w) => Number.isNaN(w))) {
        expect(results[i]).toBeNaN();
      } else {
        expect(results[i]).toBe(Math.min(...window));
      }
    }
  });
});

// C800: 배치48 (3)/(4) 감사 — ROADMAP이 "highest/lowest/highestbars/lowestbars는 매 호출 윈도우
// 전체를 재스캔한다"고 전제했으나, 실제 rt.ta.highest/lowest(고정 length 경로, seriesLength=false일
// 때 codegen이 선택하는 rtPath — VARLEN_RT_PATHS는 length가 런타임 series일 때만 쓰임)는 이미
// monotonic deque로 O(1) amortized임을 위 describe 블록들의 정확성 테스트가 증명한다. 이 블록은
// 그 O(1) 보장이 미래에 실수로 O(length) 재스캔으로 퇴행하면(즉 GOAL.md "TA는 전부 incremental
// O(1)/bar" 위반) 잡아내는 회귀 가드 — length*barCount를 수십억 스케일로 잡아 O(length) 구현이면
// 수 초~수십 초가 걸리도록(느슨한 시간 상한도 구분 가능한 자릿수 차이) 설계했다.
describe("ta.highest/ta.lowest O(1) amortized complexity guard (C800)", () => {
  it("highest() stays fast when length and barCount are both large (O(length*barCount) rescan would blow the budget)", () => {
    const state = {};
    const length = 50_000;
    const barCount = 50_000;
    const start = Date.now();
    for (let i = 0; i < barCount; i++) {
      highest(state, Math.sin(i), length);
    }
    const elapsedMs = Date.now() - start;
    // O(1) amortized: ~50k deque ops, well under 100ms even under heavy CI load.
    // O(length) rescan: ~2.5B comparisons, multiple seconds at minimum. 2s is a generous
    // discriminator that tolerates background load without being timing-fragile.
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("lowest() stays fast when length and barCount are both large (O(length*barCount) rescan would blow the budget)", () => {
    const state = {};
    const length = 50_000;
    const barCount = 50_000;
    const start = Date.now();
    for (let i = 0; i < barCount; i++) {
      lowest(state, Math.cos(i), length);
    }
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("keeps the monotonic deque bounded by length (never grows past the window size)", () => {
    const state: { dequeSize?: number } = {};
    const length = 100;
    // Strictly increasing values are the worst case for deque growth (every push pops nothing
    // from the back before the front starts evicting) — still must stay <= length.
    for (let i = 0; i < 10_000; i++) {
      highest(state, i, length);
      expect(state.dequeSize!).toBeLessThanOrEqual(length);
    }
  });
});

describe("ta.stoch", () => {
  it("returns NaN while hh/ll are still in warmup (data_len<length)", () => {
    const state = {};
    expect(stoch(state, 101, 102, 99, 3)).toBeNaN();
    expect(stoch(state, 102, 103, 100, 3)).toBeNaN();
  });

  it("matches a hand-computed %K once hh/ll fill (length=2)", () => {
    const state = {};
    stoch(state, 10, 12, 8, 2); // NaN, hh/ll warmup
    // window: high=[12,14] -> hh=14, low=[8,9] -> ll=8, source=13 -> %K=100*(13-8)/(14-8)
    expect(stoch(state, 13, 14, 9, 2)).toBeCloseTo((100 * (13 - 8)) / (14 - 8), 9);
  });

  it("matches the pine2py-verified sample10.json trace (source=close, length=4)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const highs = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const lows = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const results = closes.map((c, i) => stoch(state, c, highs[i]!, lows[i]!, 4));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBeCloseTo(60.0, 9);
    expect(results[4]).toBeCloseTo(80.0, 9);
    expect(results[5]).toBeCloseTo(83.3333333333, 9);
    expect(results[6]).toBeCloseTo(85.7142857143, 9);
    expect(results[7]).toBeCloseTo(60.0, 9);
    expect(results[8]).toBeCloseTo(80.0, 9);
    expect(results[9]).toBeCloseTo(83.3333333333, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    stoch(stateA, 10, 12, 8, 2);
    expect(stoch(stateA, 13, 14, 9, 2)).toBeCloseTo((100 * (13 - 8)) / (14 - 8), 9);
    expect(stoch(stateB, 100, 102, 98, 2)).toBeNaN();
  });

  it("returns NaN when the high channel value is NaN this bar, poisoning hh even though source/low are valid", () => {
    const state = {};
    stoch(state, 10, 12, 8, 2); // warm up window
    expect(stoch(state, 13, NaN, 9, 2)).toBeNaN();
  });

  it("returns NaN when hh/ll are valid but source is NaN this bar (and diff != 0)", () => {
    const state = {};
    stoch(state, 10, 12, 8, 2);
    expect(stoch(state, NaN, 14, 9, 2)).toBeNaN();
  });

  it("returns 50.0 for a fully flat window (hh===ll) even when source is NaN this bar (pine2py stoch.py L48-49: diff===0 short-circuits before the source NaN check)", () => {
    const stateA = {};
    stoch(stateA, 100, 100, 100, 2);
    expect(stoch(stateA, 100, 100, 100, 2)).toBe(50.0);
    const stateB = {};
    stoch(stateB, NaN, 100, 100, 2);
    expect(stoch(stateB, NaN, 100, 100, 2)).toBe(50.0);
  });

  it("matches a from-scratch O(length) brute-force cross-check (Math.max/min over the window) across a sequence with an embedded source NaN gap", () => {
    const state = {};
    const length = 3;
    const closeSeq = [10, 11, NaN, 9, 8, 12, 15, 15, 15, 3, 4, 5];
    const highSeq = [11, 12, 13, 10, 9, 13, 16, 16, 16, 4, 5, 6];
    const lowSeq = [9, 10, 11, 8, 7, 11, 14, 14, 14, 2, 3, 4];
    const results = closeSeq.map((c, i) => stoch(state, c, highSeq[i]!, lowSeq[i]!, length));
    for (let i = 0; i < closeSeq.length; i++) {
      if (i < length - 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const hiWindow = highSeq.slice(i - length + 1, i + 1);
      const loWindow = lowSeq.slice(i - length + 1, i + 1);
      const hh = Math.max(...hiWindow);
      const ll = Math.min(...loWindow);
      const diff = hh - ll;
      if (diff === 0) {
        expect(results[i]).toBe(50.0);
      } else if (Number.isNaN(closeSeq[i])) {
        expect(results[i]).toBeNaN();
      } else {
        expect(results[i]).toBeCloseTo((100 * (closeSeq[i]! - ll)) / diff, 9);
      }
    }
  });
});

// ta.wpr(length) — Williams %R = 100*(close-hh)/(hh-ll), hh=highest(high,length)/ll=lowest(low,length).
// **Deliberate divergence from pine2py** (DIVERGENCES.md #7, runtime/ta.ts wpr() comment): reuses
// rt.ta.highest/rt.ta.lowest's NaN-poison window (a NaN anywhere in the trailing `length` bars poisons
// the result until that bar ages out of the window) instead of pine2py wpr.py's own skip-NaN window
// (which only checks the *current* bar and silently skips NaN bars rather than being poisoned by them).
describe("ta.wpr", () => {
  it("returns NaN while hh/ll are still in warmup (data_len<length)", () => {
    const state = {};
    expect(wpr(state, 101, 102, 99, 3)).toBeNaN();
    expect(wpr(state, 102, 103, 100, 3)).toBeNaN();
  });

  it("matches a hand-computed %R once hh/ll fill (length=2)", () => {
    const state = {};
    wpr(state, 10, 12, 8, 2); // NaN, hh/ll warmup
    // window: high=[12,14] -> hh=14, low=[8,9] -> ll=8, close=13 -> %R=100*(13-14)/(14-8)
    expect(wpr(state, 13, 14, 9, 2)).toBeCloseTo((100 * (13 - 14)) / (14 - 8), 9);
  });

  it("matches the pine2py-verified sample10.json trace (length=4)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const highs = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const lows = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const results = closes.map((c, i) => wpr(state, c, highs[i]!, lows[i]!, 4));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBeCloseTo(-40.0, 9);
    expect(results[4]).toBeCloseTo(-20.0, 9);
    expect(results[5]).toBeCloseTo(-16.6666666667, 9);
    expect(results[6]).toBeCloseTo(-14.2857142857, 9);
    expect(results[7]).toBeCloseTo(-40.0, 9);
    expect(results[8]).toBeCloseTo(-20.0, 9);
    expect(results[9]).toBeCloseTo(-16.6666666667, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    wpr(stateA, 10, 12, 8, 2);
    expect(wpr(stateA, 13, 14, 9, 2)).toBeCloseTo((100 * (13 - 14)) / (14 - 8), 9);
    expect(wpr(stateB, 100, 102, 98, 2)).toBeNaN();
  });

  it("returns NaN when the high channel value is NaN this bar, poisoning hh even though close/low are valid", () => {
    const state = {};
    wpr(state, 10, 12, 8, 2); // warm up window
    expect(wpr(state, 13, NaN, 9, 2)).toBeNaN();
  });

  it("returns NaN when hh/ll are valid but close is NaN this bar (and diff != 0)", () => {
    const state = {};
    wpr(state, 10, 12, 8, 2);
    expect(wpr(state, NaN, 14, 9, 2)).toBeNaN();
  });

  it("returns 0.0 for a fully flat window (hh===ll) even when close is NaN this bar (pine2py wpr.py L68-69: rng===0 returns 0.0, not stoch's 50.0 — and, mirroring stoch's branch order, short-circuits before the close NaN check)", () => {
    const stateA = {};
    wpr(stateA, 100, 100, 100, 2);
    expect(wpr(stateA, 100, 100, 100, 2)).toBe(0.0);
    const stateB = {};
    wpr(stateB, NaN, 100, 100, 2);
    expect(wpr(stateB, NaN, 100, 100, 2)).toBe(0.0);
  });

  it("poisons results for `length` bars after a NaN gap (unlike pine2py wpr.py's own skip-NaN window, which would only skip the NaN bar itself and resume immediately — the deliberate divergence documented in DIVERGENCES.md #7)", () => {
    const state = {};
    const length = 3;
    // idx2 is a NaN bar. Under the poison-window semantics (rt.ta.highest/rt.ta.lowest), that NaN stays
    // inside the trailing 3-bar window through idx2,3,4 and only exits at idx5 - three consecutive NaN
    // results (idx2-4), not one.
    const closeSeq = [10, 11, NaN, 9, 8, 12];
    const highSeq = [11, 12, NaN, 10, 9, 13];
    const lowSeq = [9, 10, NaN, 8, 7, 11];
    const results = closeSeq.map((c, i) => wpr(state, c, highSeq[i]!, lowSeq[i]!, length));
    expect(results[0]).toBeNaN(); // warmup
    expect(results[1]).toBeNaN(); // warmup
    expect(results[2]).toBeNaN(); // the NaN bar itself
    expect(results[3]).toBeNaN(); // still poisoned - idx2 remains in the trailing 3-bar window
    expect(results[4]).toBeNaN(); // still poisoned - idx2 is the oldest bar in [2,3,4]
    // idx5: window is [3,4,5], idx2 has aged out - hh=max(10,9,13)=13, ll=min(8,7,11)=7, close=12
    expect(results[5]).toBeCloseTo((100 * (12 - 13)) / (13 - 7), 9);
  });

  it("matches a from-scratch O(length) brute-force cross-check (Math.max/min over the window) across a sequence with an embedded close NaN gap", () => {
    const state = {};
    const length = 3;
    const closeSeq = [10, 11, NaN, 9, 8, 12, 15, 15, 15, 3, 4, 5];
    const highSeq = [11, 12, 13, 10, 9, 13, 16, 16, 16, 4, 5, 6];
    const lowSeq = [9, 10, 11, 8, 7, 11, 14, 14, 14, 2, 3, 4];
    const results = closeSeq.map((c, i) => wpr(state, c, highSeq[i]!, lowSeq[i]!, length));
    for (let i = 0; i < closeSeq.length; i++) {
      if (i < length - 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const hiWindow = highSeq.slice(i - length + 1, i + 1);
      const loWindow = lowSeq.slice(i - length + 1, i + 1);
      const hh = Math.max(...hiWindow);
      const ll = Math.min(...loWindow);
      const diff = hh - ll;
      if (Number.isNaN(hh) || Number.isNaN(ll)) {
        expect(results[i]).toBeNaN();
      } else if (diff === 0) {
        expect(results[i]).toBe(0.0);
      } else if (Number.isNaN(closeSeq[i])) {
        expect(results[i]).toBeNaN();
      } else {
        expect(results[i]).toBeCloseTo((100 * (closeSeq[i]! - hh)) / diff, 9);
      }
    }
  });
});

// ta.tr() - True Range = max(high-low, |high-prevClose|, |low-prevClose|); prevClose NaN (first bar
// included) falls back to hl alone (pine2py wavealgo/ta/atr.py's tr(), confirmed stateless - the
// state arg exists only for TA_REGISTRY dispatch uniformity and is never read/written).
describe("ta.tr", () => {
  it("returns high-low on the first bar (prevClose NaN)", () => {
    expect(tr({}, 12, 8, NaN)).toBeCloseTo(4, 9);
  });

  it("matches a hand-computed TR once prevClose is available", () => {
    // hl=14-9=5, |h-pc|=|14-10|=4, |l-pc|=|9-10|=1 -> max=5
    expect(tr({}, 14, 9, 10)).toBeCloseTo(5, 9);
    // hl=14-9=5, |h-pc|=|14-20|=6, |l-pc|=|9-20|=11 -> max=11 (prevClose gap dominates)
    expect(tr({}, 14, 9, 20)).toBeCloseTo(11, 9);
  });

  it("is stateless - the first argument is never read or written regardless of what's passed", () => {
    const untouched = { poison: "should never be read or mutated" };
    expect(tr(untouched, 14, 9, 10)).toBeCloseTo(5, 9);
    expect(untouched).toEqual({ poison: "should never be read or mutated" });
    expect(tr(undefined, 14, 9, 10)).toBeCloseTo(5, 9);
  });

  it("propagates NaN when high or low is NaN this bar, regardless of prevClose", () => {
    expect(tr({}, NaN, 9, 10)).toBeNaN();
    expect(tr({}, 14, NaN, 10)).toBeNaN();
    expect(tr({}, NaN, NaN, NaN)).toBeNaN();
  });

  it("matches the sample10.json trace (high=close+1, low=close-2, so hl=3 every bar and prevClose gaps never exceed it)", () => {
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 2);
    const results = closes.map((c, i) => tr({}, highs[i]!, lows[i]!, i === 0 ? NaN : closes[i - 1]!));
    for (const r of results) expect(r).toBeCloseTo(3, 9);
  });

  // C291: TV 공식 시그니처 ta.tr(handle_na) — pine2py tr()엔 이 파라미터 자체가 없어(OHLCV_INJECT가
  // user_arg_count>0이면 injection을 스킵해 `ta.tr(true)` 자체가 오라클에서 크래시, analyzer.ts
  // TA_REGISTRY.tr 주석 참조) 오라클 불가, hand-verified("TV 미검증(가설)", 이 세션 웹 접근 없음).
  describe("ta.tr handle_na parameter (C291)", () => {
    it("defaults to true (5th arg omitted) - identical to the pre-C291 no-arg behavior on the first bar", () => {
      expect(tr({}, 12, 8, NaN)).toBeCloseTo(4, 9); // hl fallback, unchanged regression guard
      expect(tr({}, 12, 8, NaN, true)).toBeCloseTo(4, 9); // explicit true == default
    });

    it("handle_na=false returns NaN (instead of the hl fallback) when prevClose is NaN", () => {
      expect(tr({}, 12, 8, NaN, false)).toBeNaN();
    });

    it("handle_na has no effect once prevClose is a real number (both branches agree)", () => {
      expect(tr({}, 14, 9, 10, true)).toBeCloseTo(5, 9);
      expect(tr({}, 14, 9, 10, false)).toBeCloseTo(5, 9);
    });

    it("handle_na=false still propagates NaN when high/low themselves are NaN (unrelated to the prevClose branch)", () => {
      expect(tr({}, NaN, 9, 10, false)).toBeNaN();
    });
  });
});

// ta.atr(length) - Average True Range = RMA(TR, length) (GOAL.md "RSI/ATR는 RMA(Wilder)" - an O(1)
// streaming composition of the already-implemented rt.ta.tr/rt.ta.rma).
//
// **Deliberate divergence from pine2py** (DIVERGENCES.md, runtime/ta.ts atr() comment): pine2py
// wavealgo/ta/atr.py does *not* use this streaming composition - it re-scans up to `length+10` TR
// values from scratch on every call (SMA-seed the most recent `length`, then Wilder-smooth the rest
// in reverse). scratch/probe_atr.mjs and the actual pine2py oracle golden
// (oracle/golden/ta_atr_tr.json, length=3) both confirm this re-scan requires `dataLen >= length+1`
// before it emits a value - one bar later than the `dataLen >= length` a true streaming RMA needs -
// and, independently, its length+10-bar truncation makes it diverge numerically from an infinite-
// history RMA on longer series. Both are treated as pine2py's own latent bugs (same class as wpr
// C44/rt.max·min C13), so pine2js's atr becomes valid one bar *earlier* than pine2py's golden would
// (and matches it exactly only if the caller feeds a synthetic dataset that starts one bar "later"
// than pine2py expects). The oracle test for this case therefore only compares the ta.tr channel
// against the golden (compareToGolden onlyKeys) - ta.atr's correctness is covered here instead.
describe("ta.atr", () => {
  it("returns NaN while the RMA seed is still accumulating (dataLen < length)", () => {
    const state = {};
    expect(atr(state, 12, 8, NaN, 3)).toBeNaN(); // bar0: TR=4
    expect(atr(state, 14, 9, 10, 3)).toBeNaN(); // bar1: TR=5
  });

  it("becomes valid one bar *earlier* than pine2py's own re-scan atr.py would (dataLen===length, not length+1 - the divergence documented above)", () => {
    const state = {};
    atr(state, 12, 8, NaN, 3); // bar0: TR=4
    atr(state, 14, 9, 10, 3); // bar1: TR=5
    // bar2: TR=6 (hl=6, |h-pc|=|16-10|=6, |l-pc|=|11-10|=1 -> max=6). Seed = SMA(4,5,6) = 5.
    expect(atr(state, 16, 11, 10, 3)).toBeCloseTo(5, 9);
  });

  it("applies Wilder smoothing after the seed bar (alpha=1/length)", () => {
    const state = {};
    atr(state, 12, 8, NaN, 3); // TR=4
    atr(state, 14, 9, 10, 3); // TR=5
    atr(state, 16, 11, 10, 3); // TR=6, seed=5
    // bar3: TR = hl=|20-15|=5, |h-pc|=|20-16|=4, |l-pc|=|15-16|=1 -> max=5
    // wilder: (5*(3-1)+5)/3 = (10+5)/3 = 5
    expect(atr(state, 20, 15, 16, 3)).toBeCloseTo(5, 9);
  });

  it("length=1 degenerate: ATR equals TR itself from the very first bar (RMA seed completes instantly)", () => {
    const state = {};
    expect(atr(state, 12, 8, NaN, 1)).toBeCloseTo(4, 9); // TR=hl=4
    expect(atr(state, 14, 9, 10, 1)).toBeCloseTo(5, 9); // TR=5, alpha=1 -> equals TR exactly
  });

  it("matches the pine2py-verified sample10.json trace shifted one bar earlier than the golden (length=3, TR=3 constant - see DIVERGENCES entry)", () => {
    // oracle/golden/ta_atr_tr.json (length=3) has ATR NaN for bars0-2 and 3.0 from bar3 onward
    // (pine2py's off-by-one). pine2js's streaming composition is valid from bar2 instead - since
    // every TR in this dataset is exactly 3 (high=close+1, low=close-2), the seeded value is also
    // exactly 3, so this only exercises the *timing* divergence, not the SMA arithmetic itself.
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const highs = closes.map((c) => c + 1);
    const lows = closes.map((c) => c - 2);
    const results = closes.map((_, i) => atr(state, highs[i]!, lows[i]!, i === 0 ? NaN : closes[i - 1]!, 3));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeNaN();
    for (let i = 2; i < results.length; i++) {
      expect(results[i]).toBeCloseTo(3, 9);
    }
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    atr(stateA, 12, 8, NaN, 2);
    atr(stateA, 14, 9, 10, 2); // stateA now seeded
    expect(Number.isNaN(atr(stateA, 14, 9, 10, 2))).toBe(false);
    expect(atr(stateB, 12, 8, NaN, 2)).toBeNaN(); // stateB independent, still warming up
  });

  it("freezes (returns NaN, state unchanged) on a bar where high/low go NaN, then resumes once TR is valid again (ema/rma-style return-NaN-untouched gate, MEMORY.md C19)", () => {
    const state = {};
    atr(state, 12, 8, NaN, 2); // TR=4
    atr(state, 14, 9, 10, 2); // TR=5, seed=(4+5)/2=4.5
    expect(atr(state, NaN, NaN, 14, 2)).toBeNaN(); // high/low NaN this bar -> TR NaN -> frozen
    // resumes exactly where it left off: bar TR = hl=|16-12|=4, |h-pc|=|16-13|=3, |l-pc|=|12-13|=1 -> 4
    // wilder: (4.5*(2-1)+4)/2 = (4.5+4)/2 = 4.25
    expect(atr(state, 16, 12, 13, 2)).toBeCloseTo(4.25, 9);
  });

  it("matches a from-scratch streaming rt.ta.tr()+rt.ta.rma() brute-force cross-check over a longer randomized series", () => {
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rng = mulberry32(424242);
    const length = 7;
    const n = 80;
    const closes: number[] = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
      price += (rng() - 0.5) * 3;
      closes.push(price);
    }
    const highs = closes.map((c) => c + rng() * 2 + 0.1);
    const lows = closes.map((c) => c - rng() * 2 - 0.1);

    // independent brute-force: literal seed/wilder recursion, not calling rt.ta.rma at all.
    let bruteInitCount = 0;
    let bruteSum = 0;
    let brutePrevRma = NaN;
    const bruteResults: number[] = [];
    for (let i = 0; i < n; i++) {
      const prevClose = i === 0 ? NaN : closes[i - 1]!;
      const h = highs[i]!;
      const l = lows[i]!;
      const hl = h - l;
      const trVal = Number.isNaN(prevClose) ? hl : Math.max(hl, Math.abs(h - prevClose), Math.abs(l - prevClose));
      if (bruteInitCount < length) {
        bruteInitCount += 1;
        bruteSum += trVal;
        brutePrevRma = bruteInitCount === length ? bruteSum / length : NaN;
      } else {
        const alpha = 1 / length;
        brutePrevRma = alpha * trVal + (1 - alpha) * brutePrevRma;
      }
      bruteResults.push(brutePrevRma);
    }

    const state = {};
    for (let i = 0; i < n; i++) {
      const prevClose = i === 0 ? NaN : closes[i - 1]!;
      const actual = atr(state, highs[i]!, lows[i]!, prevClose, length);
      if (Number.isNaN(bruteResults[i]!)) {
        expect(actual).toBeNaN();
      } else {
        expect(actual).toBeCloseTo(bruteResults[i]!, 9);
      }
    }
  });
});

// ta.mfi(source, length) — Money Flow Index. volume is Pine-implicit (codegen injects
// $.volume.get(0)) so the runtime signature takes it as an explicit second arg. Unlike ta.cmo's
// prevValue (raw-passthrough every call, even to NaN), mfi's prevTp only updates on a bar where
// *both* source and volume are non-NaN (pine2py mfi.py: the prevTp write sits after both NaN
// checks) — a NaN-volume bar leaves prevTp exactly as it was, not overwritten with this bar's
// source. scratch/probe_mfi.mjs cross-checked this design against a literal port of mfi.py.
describe("ta.mfi", () => {
  it("returns NaN for the first two calls (no prevTp yet, then window still empty)", () => {
    const state = {};
    expect(mfi(state, 10, 100, 2)).toBeNaN(); // no prevTp yet
    expect(mfi(state, 11, 100, 2)).toBeNaN(); // window len 1 < 2
  });

  it("matches a hand-computed MFI once the window fills (length=2)", () => {
    const state = {};
    mfi(state, 10, 100, 2); // NaN, no prevTp yet -> prevTp <- 10
    // bar1: tp=11>prevTp(10) -> push (1100,0); window len 1 < 2 -> still NaN
    expect(mfi(state, 11, 100, 2)).toBeNaN();
    // bar2: tp=9<prevTp(11) -> push (0,900); window=[(1100,0),(0,900)] -> pos_sum=1100, neg_sum=900
    expect(mfi(state, 9, 100, 2)).toBeCloseTo((100 * 1100) / 2000, 9);
    // bar3: tp=13>prevTp(9) -> push (1300,0), evicts oldest (1100,0) -> pos_sum=1300, neg_sum=900
    expect(mfi(state, 13, 100, 2)).toBeCloseTo((100 * 1300) / 2200, 9);
  });

  it("matches the pine2py-verified sample10.json trace (length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const results = closes.map((c, i) => mfi(state, c, volumes[i]!, 3));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBeCloseTo(66.7799490229, 9);
    expect(results[4]).toBeCloseTo(68.8114863068, 9);
    expect(results[5]).toBeCloseTo(69.4332247557, 9);
    expect(results[6]).toBeCloseTo(100.0, 9);
    expect(results[7]).toBeCloseTo(66.3621262458, 9);
    expect(results[8]).toBeCloseTo(68.5454343726, 9);
    expect(results[9]).toBeCloseTo(69.1075514874, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    mfi(stateA, 10, 100, 2);
    mfi(stateA, 11, 100, 2);
    expect(mfi(stateA, 9, 100, 2)).toBeCloseTo((100 * 1100) / 2000, 9);
    expect(mfi(stateB, 50, 5, 2)).toBeNaN();
  });

  it("returns NaN when source itself is NaN this bar (prevTp untouched)", () => {
    const state = {};
    mfi(state, 10, 100, 2);
    expect(mfi(state, NaN, 100, 2)).toBeNaN();
  });

  it("returns NaN when only volume is NaN this bar (source still valid) — and does NOT push or advance the window", () => {
    const state = {};
    mfi(state, 10, 100, 2); // NaN, prevTp <- 10
    expect(mfi(state, 11, NaN, 2)).toBeNaN(); // vol NaN -> NaN, prevTp untouched (stays 10)
    // bar2: prevTp(old) should still be 10 (bar1's source=11 must NOT have overwritten it) -> tp=9<10 -> push (0,900)
    expect(mfi(state, 9, 100, 2)).toBeNaN(); // window len 1 < 2 still
    // bar3: prevTp(old)=9 -> tp=9 tie -> push (0,0); window=[(0,900),(0,0)] -> pos_sum=0, neg_sum=900 -> ratio 0 -> MFI 0.0
    expect(mfi(state, 9, 100, 2)).toBe(0.0);
  });

  it("regression guard: a volume-NaN bar must not raw-passthrough prevTp like ta.cmo's prevValue — doing so would flip the push direction and change the eventual MFI value", () => {
    // Same source/volume/length as the previous test's second half, isolated as a direct value
    // assertion: if prevTp were wrongly set to bar1's source (11) despite volume being NaN, bar2's
    // push would be (900,0) instead of (0,900), and the final MFI would come out 100.0, not 0.0.
    const state = {};
    mfi(state, 10, 100, 2); // prevTp <- 10
    mfi(state, 11, NaN, 2); // vol NaN -> prevTp must stay 10
    mfi(state, 9, 100, 2); // window len 1 < 2
    expect(mfi(state, 9, 100, 2)).toBe(0.0);
  });

  it("pushes (0,0) on a tie (source === prevTp this bar)", () => {
    const state = {};
    mfi(state, 100, 1000, 2); // prevTp <- 100
    mfi(state, 100, 1000, 2); // tie -> push (0,0); window len 1 < 2
    // bar2: tie again -> push (0,0); window=[(0,0),(0,0)] -> pos_sum=0, neg_sum=0 -> negSum===0 -> 100.0
    expect(mfi(state, 100, 1000, 2)).toBe(100.0);
  });

  it("returns 100.0 when negSum===0 (monotonically rising source, all pushes positive)", () => {
    const state = {};
    const closes = [100, 101, 102, 103, 104];
    const volumes = [1000, 1000, 1000, 1000, 1000];
    const results = closes.map((c, i) => mfi(state, c, volumes[i]!, 3));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBe(100.0);
    expect(results[4]).toBe(100.0);
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py mfi.py port) across a sequence with embedded source/volume NaN gaps", () => {
    const state = {};
    const length = 3;
    const closeSeq = [100, 101, 102, NaN, 104, 105, 106, 105, 103, 101, 99, 100];
    const volSeq = [1000, 1000, 1000, 1000, 1000, NaN, 1000, 1000, 1000, 1000, 1000, 1000];

    function bruteForce(sources: number[], volumes: number[], len: number): number[] {
      const st = { prevTp: NaN, posFlows: [] as number[], negFlows: [] as number[], count: 0 };
      const out: number[] = [];
      for (let i = 0; i < sources.length; i++) {
        const tp = sources[i]!;
        if (Number.isNaN(tp)) {
          out.push(NaN);
          continue;
        }
        const vol = volumes[i]!;
        if (Number.isNaN(vol)) {
          out.push(NaN);
          continue;
        }
        const prevTp = st.prevTp;
        st.prevTp = tp;
        if (Number.isNaN(prevTp)) {
          out.push(NaN);
          continue;
        }
        const moneyFlow = tp * vol;
        if (tp > prevTp) {
          st.posFlows.push(moneyFlow);
          st.negFlows.push(0);
        } else if (tp < prevTp) {
          st.posFlows.push(0);
          st.negFlows.push(moneyFlow);
        } else {
          st.posFlows.push(0);
          st.negFlows.push(0);
        }
        st.count += 1;
        if (st.count < len) {
          out.push(NaN);
          continue;
        }
        if (st.posFlows.length > len) {
          st.posFlows = st.posFlows.slice(-len);
          st.negFlows = st.negFlows.slice(-len);
        }
        const posSum = st.posFlows.reduce((a, b) => a + b, 0);
        const negSum = st.negFlows.reduce((a, b) => a + b, 0);
        if (negSum === 0) {
          out.push(100.0);
          continue;
        }
        out.push(100.0 - 100.0 / (1.0 + posSum / negSum));
      }
      return out;
    }

    const expected = bruteForce(closeSeq, volSeq, length);
    const actual = closeSeq.map((c, i) => mfi(state, c, volSeq[i]!, length));
    for (let i = 0; i < closeSeq.length; i++) {
      if (Number.isNaN(expected[i])) {
        expect(actual[i]).toBeNaN();
      } else {
        expect(actual[i]).toBeCloseTo(expected[i]!, 9);
      }
    }
  });
});

// ta.highest/ta.lowest series(가변) length 변형(highestVarLen/lowestVarLen, 배치25 (4) 첫 착수) —
// 상세 설계 근거는 runtime/ta.ts 주석 및 oracle/cases/ta_highest_lowest_varlen.pine 참조. state-fixed
// deque(위 describe 블록들)와 별개 함수라 그 쪽 회귀 위험은 없다. barIdx(마지막 인자, $.idx)는 같은
// 바 반복 호출을 push가 아니라 덮어쓰기로 판별하는 기준(pine2py context.param() 이식) — 아래 대부분의
// 테스트는 "매 호출이 새 바"(barIdx=호출 순번)를 가정하고, 전용 테스트가 "같은 바 반복 호출"을 검증한다.
describe("ta.highest/ta.lowest variable(series) length (highestVarLen/lowestVarLen)", () => {
  it("matches the pine2py-verified oracle trace for a length cycling 5..1 (close source, barCount=10)", () => {
    const stateHi = {};
    const stateLo = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const lens = closes.map((_, i) => 5 - (i % 5));
    const hiResults = closes.map((c, i) => highestVarLen(stateHi, c, lens[i]!, 10, i));
    const loResults = closes.map((c, i) => lowestVarLen(stateLo, c, lens[i]!, 10, i));
    expect(hiResults[0]).toBeNaN();
    expect(hiResults[1]).toBeNaN();
    expect(hiResults.slice(2)).toEqual([103, 103, 104, 105, 106, 106, 107, 108]);
    expect(loResults[0]).toBeNaN();
    expect(loResults[1]).toBeNaN();
    expect(loResults.slice(2)).toEqual([101, 102, 104, 102, 102, 105, 105, 108]);
  });

  it("returns -Infinity(highest)/+Infinity(lowest) for length<1 — literal-ported pine2py highest.py range(length) empty-loop quirk", () => {
    const stateHi = {};
    const stateLo = {};
    expect(highestVarLen(stateHi, 50, 0, 10, 0)).toBe(-Infinity);
    expect(lowestVarLen(stateLo, 50, 0, 10, 0)).toBe(Infinity);
    expect(highestVarLen(stateHi, 50, -3, 10, 1)).toBe(-Infinity);
    expect(lowestVarLen(stateLo, 50, -3, 10, 1)).toBe(Infinity);
  });

  it("returns NaN when length is NaN (hand-verified na-propagation — pine2py's range(nan) would crash, not oracle-able)", () => {
    const stateHi = {};
    expect(highestVarLen(stateHi, 50, NaN, 10, 0)).toBeNaN();
    const stateLo = {};
    expect(lowestVarLen(stateLo, 50, NaN, 10, 0)).toBeNaN();
  });

  it("returns NaN when length exceeds the number of distinct bars seen so far (warmup, matches pine2py data_len<length)", () => {
    const state = {};
    expect(highestVarLen(state, 10, 3, 10, 0)).toBeNaN(); // bar 0, length=3 > data_len=1
    expect(highestVarLen(state, 20, 3, 10, 1)).toBeNaN(); // bar 1, data_len=2
    expect(highestVarLen(state, 30, 3, 10, 2)).toBe(30); // bar 2, data_len=3, window=[10,20,30]
  });

  it("poisons the window when any value in the (variable-width) trailing range is NaN", () => {
    const state = {};
    highestVarLen(state, 10, 2, 10, 0);
    expect(highestVarLen(state, NaN, 2, 10, 1)).toBeNaN();
    expect(highestVarLen(state, 20, 2, 10, 2)).toBeNaN(); // window still includes the NaN bar
    expect(highestVarLen(state, 30, 2, 10, 3)).toBe(30); // window [20,30], no NaN
  });

  it("supports length varying up and down bar to bar without corrupting the per-call-site history buffer (unlike the fixed-length deque)", () => {
    const state = {};
    const values = [5, 8, 2, 9, 1, 7];
    const lens = [1, 2, 3, 1, 4, 2];
    const results = values.map((v, i) => highestVarLen(state, v, lens[i]!, 10, i));
    for (let i = 0; i < values.length; i++) {
      const len = lens[i]!;
      if (len > i + 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const window = values.slice(i - len + 1, i + 1);
      expect(results[i]).toBe(Math.max(...window));
    }
  });

  it("keeps independent state across two call sites (per-call-site private history buffer)", () => {
    const stateA = {};
    const stateB = {};
    highestVarLen(stateA, 10, 1, 10, 0);
    expect(highestVarLen(stateA, 20, 2, 10, 1)).toBe(20);
    expect(highestVarLen(stateB, 5, 1, 10, 0)).toBe(5);
  });

  // corpus_diff 회귀 플로어 실측으로 발견(116e6a965746.pine, `for period=3 to 5` 루프 안에서
  // ta.highest(high,period)를 매 바 3회 호출) — pine2py context.param()은 같은 바 반복 호출을
  // push가 아니라 마지막 슬롯 덮어쓰기로 처리한다(wavealgo/context.py L179 `len(s) <= self.idx`).
  // barIdx가 이전 호출과 같으면 데이터 길이가 늘지 않아야 정합.
  it("does NOT advance the history buffer on repeated calls within the same bar (same barIdx) — only the last value of that bar is kept (pine2py context.param() parity)", () => {
    const state = {};
    // bar 0: 3 calls (loop iterations) with the same barIdx, only the last value(30) should stick.
    highestVarLen(state, 10, 1, 10, 0);
    highestVarLen(state, 20, 1, 10, 0);
    expect(highestVarLen(state, 30, 1, 10, 0)).toBe(30); // length=1 -> just this bar's (latest) value
    // bar 1: a single call — data_len is now 2 (bar0's single slot + bar1's), not 4.
    expect(highestVarLen(state, 5, 2, 10, 1)).toBe(30); // window = [30(bar0 final), 5(bar1)]
  });

  it("matches a hand-simulated multi-call-per-bar loop (3 calls/bar, lengths 3/4/5) against the pine2py context.param() dedup rule", () => {
    // Mirrors corpus_diff 116e6a965746.pine's `for period = 3 to 5 \n ta.highest(high, period)`.
    const state = {};
    const highs = [105, 106, 104, 108, 103];
    // Per-bar "distinct value history" as pine2py's context.param() would build it: one slot per
    // bar, always holding that bar's `high` (repeated pushes within a bar just overwrite the same
    // slot with the same `high` value here, since `high` doesn't change across loop iterations).
    const perBarHistory: number[] = [];
    let lastResult = NaN;
    for (let bar = 0; bar < highs.length; bar++) {
      perBarHistory.push(highs[bar]!);
      for (const period of [3, 4, 5]) {
        lastResult = highestVarLen(state, highs[bar]!, period, 10, bar);
        const dataLen = perBarHistory.length;
        if (period > dataLen) {
          expect(lastResult).toBeNaN();
        } else {
          const window = perBarHistory.slice(dataLen - period);
          expect(lastResult).toBe(Math.max(...window));
        }
      }
    }
  });
});

// ta.sma series length 변형(smaVarLen, 배치25 (4) 두 번째, C548) — 버퍼/barIdx 덮어쓰기 메커니즘은
// highestVarLen과 동형(ExtremeVarLenState 재사용), 값 계산만 최근 len개 산술평균. **여기의 "값이
// 실제로 변하는 length" 케이스들은 hand-verified다**: pine2py sma.py는 첫 성공 호출 length로
// 윈도우를 영구 고정한 채 현재 length로 나누는 인크리멘탈이라(직접 실행 실측 2026-08-01, len=[3,3,
// 4,5,2,3,4,5]에서 bar5부터 "2개 합/3" 같은 무의미한 값) 이 축의 오라클이 성립하지 않는다 —
// DIVERGENCES #179, GOAL.md "알려진 버그는 따르지 않는다". 상수-값 series length 퇴화 케이스만
// oracle/cases/ta_sma_varlen.pine이 골든 대조한다.
describe("ta.sma variable(series) length (smaVarLen)", () => {
  it("computes the arithmetic mean over the trailing `length` values as length cycles (TV semantics, hand-verified)", () => {
    const state = {};
    const closes = [10, 11, 12, 13, 14, 15, 16, 17];
    const lens = [3, 3, 4, 5, 2, 3, 4, 5];
    const results = closes.map((c, i) => smaVarLen(state, c, lens[i]!, 10, i));
    for (let i = 0; i < closes.length; i++) {
      const len = lens[i]!;
      if (len > i + 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const window = closes.slice(i - len + 1, i + 1);
      expect(results[i]).toBeCloseTo(window.reduce((a, b) => a + b, 0) / len, 12);
    }
    // 명시 스팟체크: pine2py 직접 실행이 bar5부터 9.6666/7.75/6.6(고정 윈도우 버그)을 내는 지점 —
    // TV 정합 값은 최근 len개 평균이다.
    expect(results[5]).toBeCloseTo((13 + 14 + 15) / 3, 12);
    expect(results[6]).toBeCloseTo((13 + 14 + 15 + 16) / 4, 12);
    expect(results[7]).toBeCloseTo((13 + 14 + 15 + 16 + 17) / 5, 12);
  });

  it("returns NaN for length<1 (pine2py crashes here — len=0 ZeroDivisionError, negative empty-window pop; hand-verified na)", () => {
    const state = {};
    expect(smaVarLen(state, 50, 0, 10, 0)).toBeNaN();
    expect(smaVarLen(state, 51, -3, 10, 1)).toBeNaN();
    // length<1 호출도 버퍼 기록 자체는 전진해야 한다 — 다음 바 정상 length가 이전 바 값을 본다.
    expect(smaVarLen(state, 52, 2, 10, 2)).toBeCloseTo((51 + 52) / 2, 12);
  });

  it("returns NaN when length is NaN (hand-verified na-propagation, highestVarLen parity)", () => {
    const state = {};
    expect(smaVarLen(state, 50, NaN, 10, 0)).toBeNaN();
    expect(smaVarLen(state, 51, 1, 10, 1)).toBe(51);
  });

  it("truncates a fractional length toward zero (Math.trunc, array-index rule)", () => {
    const state = {};
    smaVarLen(state, 10, 1, 10, 0);
    expect(smaVarLen(state, 20, 2.9, 10, 1)).toBeCloseTo((10 + 20) / 2, 12);
  });

  it("returns NaN when length exceeds the number of distinct bars seen so far (warmup, matches pine2py data_len<length)", () => {
    const state = {};
    expect(smaVarLen(state, 10, 3, 10, 0)).toBeNaN();
    expect(smaVarLen(state, 20, 3, 10, 1)).toBeNaN();
    expect(smaVarLen(state, 30, 3, 10, 2)).toBeCloseTo(20, 12);
  });

  it("poisons the result while any value in the trailing window is NaN, then recovers (fixed-length sma parity)", () => {
    const state = {};
    smaVarLen(state, 10, 2, 10, 0);
    expect(smaVarLen(state, NaN, 2, 10, 1)).toBeNaN();
    expect(smaVarLen(state, 20, 2, 10, 2)).toBeNaN(); // 창에 NaN 바 포함
    expect(smaVarLen(state, 30, 2, 10, 3)).toBeCloseTo(25, 12); // [20,30]
  });

  it("keeps independent state across two call sites (per-call-site private history buffer)", () => {
    const stateA = {};
    const stateB = {};
    smaVarLen(stateA, 10, 1, 10, 0);
    expect(smaVarLen(stateA, 20, 2, 10, 1)).toBeCloseTo(15, 12);
    expect(smaVarLen(stateB, 5, 1, 10, 0)).toBe(5);
  });

  it("does NOT advance the history buffer on repeated calls within the same bar (same barIdx) — pine2py context.param() parity", () => {
    const state = {};
    smaVarLen(state, 10, 1, 10, 0);
    smaVarLen(state, 20, 1, 10, 0);
    expect(smaVarLen(state, 30, 1, 10, 0)).toBe(30); // 같은 바 마지막 값만 유지
    expect(smaVarLen(state, 6, 2, 10, 1)).toBeCloseTo((30 + 6) / 2, 12); // bar0 슬롯은 1개뿐
  });

  it("matches a hand-simulated multi-call-per-bar loop (3 calls/bar, lengths 3/4/5) against the context.param() dedup rule", () => {
    const state = {};
    const closes = [105, 106, 104, 108, 103];
    const perBarHistory: number[] = [];
    for (let bar = 0; bar < closes.length; bar++) {
      perBarHistory.push(closes[bar]!);
      for (const period of [3, 4, 5]) {
        const result = smaVarLen(state, closes[bar]!, period, 10, bar);
        const dataLen = perBarHistory.length;
        if (period > dataLen) {
          expect(result).toBeNaN();
        } else {
          const window = perBarHistory.slice(dataLen - period);
          expect(result).toBeCloseTo(window.reduce((a, b) => a + b, 0) / period, 12);
        }
      }
    }
  });
});

// ta.highestbars/ta.lowestbars series length 변형(highestbarsVarLen/lowestbarsVarLen, 배치25 (4)
// 세 번째, C549) — 버퍼/writeIdx/barIdx 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLen
// State 재사용), 값 계산만 극값 대신 극값 "오프셋"(-i, 0=현재바). pine2py highest.py의 highestbars()/
// lowestbars()가 highest()와 동일한 무상태 재스캔이라 이 축은 오라클 가능(oracle/cases/
// ta_highestbars_lowestbars_varlen.pine). 동률은 엄격 부등호 스캔(i=0=현재바부터)이라 가장 최근
// 바가 이긴다. length<1은 pine2py `range(length)` 빈 루프로 max_idx=0 → `-max_idx`=0 반환(highest의
// -inf/+inf와 다른, 크래시 없는 정의된 동작 — 골든의 len2=0 바가 직접 검증). length=NaN만
// hand-verified na 전파(pine2py는 range(nan) TypeError 크래시).
describe("ta.highestbars/ta.lowestbars variable(series) length (highestbarsVarLen/lowestbarsVarLen)", () => {
  it("matches the pine2py-verified oracle trace for a length cycling 5..1 (close source, barCount=10)", () => {
    const stateHb = {};
    const stateLb = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const lens = closes.map((_, i) => 5 - (i % 5));
    const hbResults = closes.map((c, i) => highestbarsVarLen(stateHb, c, lens[i]!, 10, i));
    const lbResults = closes.map((c, i) => lowestbarsVarLen(stateLb, c, lens[i]!, 10, i));
    expect(hbResults[0]).toBeNaN();
    expect(hbResults[1]).toBeNaN();
    // bar2 len=3 창[101,102,103] max=103(현재) → 0; bar3 len=2 창[103,102] max=103(1바 전) → -1;
    // bar4 len=1 → 0; bar5 len=5 창(bar1..5)[102,103,102,104,105] max=105(현재) → 0; bar6 len=4
    // 창(bar3..6)[102,104,105,106] max=106(현재) → 0; bar7 len=3 창(bar5..7)[105,106,105]
    // max=106(1바 전) → -1; bar8 len=2 창[105,107] → 0; bar9 len=1 → 0.
    expect(hbResults.slice(2)).toEqual([0, -1, 0, 0, 0, -1, 0, 0]);
    // lowest 대칭: bar2 창[101,102,103] min=101(2바 전) → -2; bar3 창[103,102] min=102(현재) → 0;
    // bar4 len=1 → 0; bar5 창(bar1..5)[102,103,102,104,105] min=102 동률(bar1/bar3) → 엄격 부등호
    // 스캔이라 더 최근 bar3이 남아 -2; bar6 창(bar3..6)[102,104,105,106] min=102(3바 전) → -3;
    // bar7 창(bar5..7)[105,106,105] min=105 동률 → 최근(현재바) 0; bar8 창[105,107] min=105
    // (1바 전) → -1; bar9 len=1 → 0.
    expect(lbResults.slice(2)).toEqual([-2, 0, 0, -2, -3, 0, -1, 0]);
  });

  it("returns 0 for length<1 — literal-ported pine2py highestbars() empty range(length) loop leaves max_idx=0 (NOT the -inf/+inf of highest/lowest)", () => {
    const stateHb = {};
    const stateLb = {};
    expect(highestbarsVarLen(stateHb, 50, 0, 10, 0)).toBe(0);
    expect(lowestbarsVarLen(stateLb, 50, 0, 10, 0)).toBe(0);
    expect(highestbarsVarLen(stateHb, 60, -3, 10, 1)).toBe(0);
    expect(lowestbarsVarLen(stateLb, 60, -3, 10, 1)).toBe(0);
  });

  it("returns NaN when length is NaN (hand-verified na-propagation — pine2py's range(nan) would crash, not oracle-able)", () => {
    const stateHb = {};
    expect(highestbarsVarLen(stateHb, 50, NaN, 10, 0)).toBeNaN();
    const stateLb = {};
    expect(lowestbarsVarLen(stateLb, 50, NaN, 10, 0)).toBeNaN();
  });

  it("returns NaN when length exceeds the number of distinct bars seen so far (warmup, matches pine2py data_len<length)", () => {
    const state = {};
    expect(highestbarsVarLen(state, 10, 3, 10, 0)).toBeNaN();
    expect(highestbarsVarLen(state, 20, 3, 10, 1)).toBeNaN();
    expect(highestbarsVarLen(state, 30, 3, 10, 2)).toBe(0); // window=[10,20,30], max=현재바
  });

  it("poisons the window when any value in the (variable-width) trailing range is NaN", () => {
    const state = {};
    highestbarsVarLen(state, 10, 2, 10, 0);
    expect(highestbarsVarLen(state, NaN, 2, 10, 1)).toBeNaN();
    expect(highestbarsVarLen(state, 20, 2, 10, 2)).toBeNaN(); // 창에 NaN 바 포함
    expect(highestbarsVarLen(state, 30, 2, 10, 3)).toBe(0); // 창[20,30], max=현재바
  });

  it("breaks ties toward the most recent bar (strict inequality scan from i=0, fixed-length deque parity)", () => {
    const stateHb = {};
    const stateLb = {};
    const values = [7, 7, 7];
    for (let i = 0; i < values.length; i++) {
      highestbarsVarLen(stateHb, values[i]!, 1, 10, i);
      lowestbarsVarLen(stateLb, values[i]!, 1, 10, i);
    }
    // 전 바 동률 창 — 항상 가장 최근(오프셋 0)이 남아야 한다(그리고 -0이 아니라 +0이어야 한다).
    const hb = highestbarsVarLen(stateHb, 7, 3, 10, 3);
    const lb = lowestbarsVarLen(stateLb, 7, 3, 10, 3);
    expect(Object.is(hb, 0)).toBe(true);
    expect(Object.is(lb, 0)).toBe(true);
  });

  it("returns a plain +0 (not negative zero) when the extreme is the current bar (MEMORY C45 -0 pitfall)", () => {
    const state = {};
    highestbarsVarLen(state, 10, 1, 10, 0);
    const r = highestbarsVarLen(state, 20, 2, 10, 1); // max=20(현재바)
    expect(Object.is(r, 0)).toBe(true);
  });

  it("supports length varying up and down bar to bar against a brute-force rescan reference", () => {
    const stateHb = {};
    const stateLb = {};
    const values = [5, 8, 2, 9, 1, 7, 4, 9];
    const lens = [1, 2, 3, 1, 4, 2, 5, 3];
    for (let i = 0; i < values.length; i++) {
      const len = lens[i]!;
      const hb = highestbarsVarLen(stateHb, values[i]!, len, 10, i);
      const lb = lowestbarsVarLen(stateLb, values[i]!, len, 10, i);
      if (len > i + 1) {
        expect(hb).toBeNaN();
        expect(lb).toBeNaN();
        continue;
      }
      // pine2py 스캔 재현: i=0(현재)부터 len-1까지 엄격 부등호.
      let maxVal = -Infinity;
      let maxIdx = 0;
      let minVal = Infinity;
      let minIdx = 0;
      for (let k = 0; k < len; k++) {
        const v = values[i - k]!;
        if (v > maxVal) {
          maxVal = v;
          maxIdx = k;
        }
        if (v < minVal) {
          minVal = v;
          minIdx = k;
        }
      }
      expect(hb).toBe(maxIdx === 0 ? 0 : -maxIdx);
      expect(lb).toBe(minIdx === 0 ? 0 : -minIdx);
    }
  });

  it("keeps independent state across two call sites (per-call-site private history buffer)", () => {
    const stateA = {};
    const stateB = {};
    highestbarsVarLen(stateA, 10, 1, 10, 0);
    expect(highestbarsVarLen(stateA, 20, 2, 10, 1)).toBe(0);
    expect(highestbarsVarLen(stateB, 5, 1, 10, 0)).toBe(0);
  });

  it("does NOT advance the history buffer on repeated calls within the same bar (same barIdx) — pine2py context.param() parity", () => {
    const state = {};
    highestbarsVarLen(state, 10, 1, 10, 0);
    highestbarsVarLen(state, 20, 1, 10, 0);
    expect(highestbarsVarLen(state, 30, 1, 10, 0)).toBe(0); // 같은 바 마지막 값만 유지
    expect(highestbarsVarLen(state, 5, 2, 10, 1)).toBe(-1); // 창=[30(bar0 최종), 5] → max는 1바 전
  });

  it("matches a hand-simulated multi-call-per-bar loop (3 calls/bar, lengths 3/4/5) against the context.param() dedup rule", () => {
    const state = {};
    const highs = [105, 106, 104, 108, 103];
    const perBarHistory: number[] = [];
    for (let bar = 0; bar < highs.length; bar++) {
      perBarHistory.push(highs[bar]!);
      for (const period of [3, 4, 5]) {
        const result = highestbarsVarLen(state, highs[bar]!, period, 10, bar);
        const dataLen = perBarHistory.length;
        if (period > dataLen) {
          expect(result).toBeNaN();
        } else {
          let maxVal = -Infinity;
          let maxIdx = 0;
          for (let k = 0; k < period; k++) {
            const v = perBarHistory[dataLen - 1 - k]!;
            if (v > maxVal) {
              maxVal = v;
              maxIdx = k;
            }
          }
          expect(result).toBe(maxIdx === 0 ? 0 : -maxIdx);
        }
      }
    }
  });
});

// ta.median/ta.linreg/ta.wma series length 변형(배치25 (4) 묶음, C550) — 버퍼/barIdx 덮어쓰기
// 메커니즘은 highestVarLen과 동형(ExtremeVarLenState 재사용), 값 계산만 각각 창 정렬 중앙값/
// 최소제곱 회귀/선형 가중 평균. median/linreg는 pine2py가 무상태 재스캔이라 가변 length 축까지
// 오라클 골든(ta_median_linreg_varlen.pine)이 직접 대조하고, wma만 pine2py 고정-윈도우 latent
// 버그(#179와 동일 패턴)라 이 hand-verified 유닛 + 퇴화 오라클(ta_wma_varlen.pine)로 검증한다.
describe("ta.median/ta.linreg/ta.wma variable(series) length (medianVarLen/linregVarLen/wmaVarLen)", () => {
  it("medianVarLen: computes the trailing-window median as length cycles (odd=middle, even=mean of middle two)", () => {
    const state = {};
    const closes = [10, 14, 12, 18, 11, 16];
    const lens = [1, 2, 3, 4, 5, 3];
    const results = closes.map((c, i) => medianVarLen(state, c, lens[i]!, 10, i));
    expect(results[0]).toBe(10); // [10]
    expect(results[1]).toBe(12); // [10,14] → (10+14)/2
    expect(results[2]).toBe(12); // [10,14,12]
    expect(results[3]).toBe(13); // [10,14,12,18] → (12+14)/2
    expect(results[4]).toBe(12); // [10,14,12,18,11]
    expect(results[5]).toBe(16); // [18,11,16]
  });

  it("medianVarLen: NaN for warmup / length<1 (pine2py IndexError crash → hand-verified na) / length=NaN, and the buffer still advances", () => {
    const state = {};
    expect(medianVarLen(state, 10, 3, 10, 0)).toBeNaN(); // 워밍업
    expect(medianVarLen(state, 20, 0, 10, 1)).toBeNaN(); // len=0
    expect(medianVarLen(state, 30, -2, 10, 2)).toBeNaN(); // len<0
    expect(medianVarLen(state, 40, NaN, 10, 3)).toBeNaN(); // len=NaN
    expect(medianVarLen(state, 50, 4, 10, 4)).toBe(35); // [20,30,40,50] → (30+40)/2 — 위 바들도 기록됨
  });

  it("medianVarLen: poisons while a NaN value sits inside the trailing window, then recovers (fixed-length median parity)", () => {
    const state = {};
    medianVarLen(state, 10, 1, 10, 0);
    expect(medianVarLen(state, NaN, 1, 10, 1)).toBeNaN();
    expect(medianVarLen(state, 20, 2, 10, 2)).toBeNaN(); // 창=[NaN,20]
    expect(medianVarLen(state, 30, 2, 10, 3)).toBe(25); // 창=[20,30]
  });

  it("medianVarLen: same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    medianVarLen(state, 10, 1, 10, 0);
    medianVarLen(state, 90, 1, 10, 0);
    expect(medianVarLen(state, 30, 1, 10, 0)).toBe(30);
    expect(medianVarLen(state, 50, 2, 10, 1)).toBe(40); // 창=[30(bar0 최종),50]
  });

  it("linregVarLen: matches the least-squares fit + offset projection as length varies (pine2py 무상태 재스캔 literal port)", () => {
    const state = {};
    // pine2py 직접 실행 골든(2026-08-01 프로브): vals/lens 조합의 linreg(offset 0/2)
    const vals = [10.0, 12.0, 11.0, 15.0, 13.0, 14.0, 16.0, 12.5];
    const lens = [1, 2, 3, 4, 5, 1, 2, 3];
    const expected0 = [10.0, 12.0, 11.5, 14.1, 14.0, 14.0, 16.0, 13.4166666667];
    const expected2 = [10.0, 16.0, 12.5, 16.9, 15.8, 14.0, 20.0, 11.9166666667];
    for (let i = 0; i < vals.length; i++) {
      const r0 = linregVarLen(state, vals[i]!, lens[i]!, 0, 10, i);
      expect(r0).toBeCloseTo(expected0[i]!, 9);
    }
    const stateB = {};
    for (let i = 0; i < vals.length; i++) {
      const r2 = linregVarLen(stateB, vals[i]!, lens[i]!, 2, 10, i);
      expect(r2).toBeCloseTo(expected2[i]!, 9);
    }
  });

  it("linregVarLen: length=0 → NaN (pine2py ZeroDivisionError crash → hand-verified na), length<0 → +0 (pine2py crash-free +0.0 literal port)", () => {
    const state = {};
    expect(linregVarLen(state, 10, 0, 0, 10, 0)).toBeNaN();
    const neg = linregVarLen(state, 20, -1, 0, 10, 1);
    expect(neg).toBe(0);
    expect(Object.is(neg, -0)).toBe(false); // MEMORY C45 — +0 고정
    expect(Object.is(linregVarLen(state, 30, -3, 0, 10, 2), 0)).toBe(true);
    expect(linregVarLen(state, 40, NaN, 0, 10, 3)).toBeNaN();
    expect(linregVarLen(state, 50, 2, 0, 10, 4)).toBeCloseTo(50, 9); // [40,50] 회귀 → 현재 바 50
  });

  it("linregVarLen: warmup NaN and NaN-poison window parity with the fixed-length linreg", () => {
    const state = {};
    expect(linregVarLen(state, 10, 2, 0, 10, 0)).toBeNaN(); // 워밍업
    expect(linregVarLen(state, NaN, 1, 0, 10, 1)).toBeNaN();
    expect(linregVarLen(state, 20, 2, 0, 10, 2)).toBeNaN(); // 창=[NaN,20]
    expect(linregVarLen(state, 30, 2, 0, 10, 3)).toBeCloseTo(30, 9); // 창=[20,30]
  });

  it("wmaVarLen: computes the linearly-weighted mean over the *current* length as it varies (TV semantics, hand-verified — pine2py 고정 윈도우 버그라 오라클 불가)", () => {
    const state = {};
    const closes = [10, 11, 12, 13, 14, 15];
    const lens = [1, 2, 3, 4, 2, 3];
    const results = closes.map((c, i) => wmaVarLen(state, c, lens[i]!, 10, i));
    for (let i = 0; i < closes.length; i++) {
      const len = lens[i]!;
      if (len > i + 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      let weighted = 0;
      for (let k = 0; k < len; k++) weighted += closes[i - len + 1 + k]! * (k + 1);
      expect(results[i]).toBeCloseTo(weighted / ((len * (len + 1)) / 2), 12);
    }
    // 명시 스팟체크: bar4 len=2 → (13*1+14*2)/3, bar5 len=3 → (13*1+14*2+15*3)/6
    expect(results[4]).toBeCloseTo(41 / 3, 12);
    expect(results[5]).toBeCloseTo(86 / 6, 12);
  });

  it("wmaVarLen: NaN for length<1 (pine2py ZeroDivisionError crash → hand-verified na) / length=NaN / warmup / NaN-poison window", () => {
    const state = {};
    expect(wmaVarLen(state, 10, 0, 10, 0)).toBeNaN();
    expect(wmaVarLen(state, 20, -1, 10, 1)).toBeNaN();
    expect(wmaVarLen(state, 30, NaN, 10, 2)).toBeNaN();
    expect(wmaVarLen(state, 40, 5, 10, 3)).toBeNaN(); // 워밍업(관측 4바 < 5)
    expect(wmaVarLen(state, 50, 2, 10, 4)).toBeCloseTo((40 * 1 + 50 * 2) / 3, 12);
    expect(wmaVarLen(state, NaN, 1, 10, 5)).toBeNaN();
    expect(wmaVarLen(state, 60, 2, 10, 6)).toBeNaN(); // 창=[NaN,60]
    expect(wmaVarLen(state, 70, 2, 10, 7)).toBeCloseTo((60 + 140) / 3, 12);
  });

  it("wmaVarLen: same-bar repeated calls overwrite (loop-body parity) and call sites stay independent", () => {
    const stateA = {};
    const stateB = {};
    wmaVarLen(stateA, 10, 1, 10, 0);
    wmaVarLen(stateA, 90, 1, 10, 0);
    expect(wmaVarLen(stateA, 30, 1, 10, 0)).toBe(30);
    expect(wmaVarLen(stateA, 60, 2, 10, 1)).toBeCloseTo((30 * 1 + 60 * 2) / 3, 12);
    expect(wmaVarLen(stateB, 5, 1, 10, 0)).toBe(5);
  });

  it("medianVarLen/linregVarLen/wmaVarLen: fractional length truncates toward zero (Math.trunc, array-index rule)", () => {
    const m = {};
    medianVarLen(m, 10, 1, 10, 0);
    expect(medianVarLen(m, 20, 2.9, 10, 1)).toBe(15);
    const l = {};
    linregVarLen(l, 10, 1, 0, 10, 0);
    expect(linregVarLen(l, 20, 2.7, 0, 10, 1)).toBeCloseTo(20, 9);
    const w = {};
    wmaVarLen(w, 10, 1, 10, 0);
    expect(wmaVarLen(w, 20, 2.5, 10, 1)).toBeCloseTo((10 + 40) / 3, 12);
  });
});

// ta.stdev/math.sum series(가변) length (배치25 (4) 다섯 번째 묶음, C551 — stdevVarLen/sumVarLen).
// 버퍼 메커니즘은 highestVarLen과 완전 동형. pine2py stdev.py/math.sum 둘 다 상태 없이 매 호출
// 현재 length로 창을 재구축하는 무상태 재스캔이라(median/linreg #181과 동일 축) 가변 length
// 오라클이 성립한다(oracle/cases/ta_stdev_sum_varlen.pine 골든이 정상 구간을 이미 대조) — 여기서는
// 오라클이 못 미치는 크래시 경계(length=0/NaN, biased=false)를 hand-verified로 커버한다.
describe("ta.stdev variable(series) length (stdevVarLen)", () => {
  it("matches a from-scratch population variance/stdev recomputed over the trailing window as length varies", () => {
    const state = {};
    const closes = [10, 20, 30, 40, 50];
    const lens = [1, 2, 3, 4, 2];
    const results = closes.map((c, i) => stdevVarLen(state, c, lens[i]!, true, 10, i));
    for (let i = 0; i < closes.length; i++) {
      const len = lens[i]!;
      const window = closes.slice(i - len + 1, i + 1);
      const mean = window.reduce((a, b) => a + b, 0) / len;
      const population = window.reduce((a, v) => a + (v - mean) ** 2, 0) / len;
      expect(results[i]).toBeCloseTo(Math.sqrt(population), 9);
    }
    // 명시 스팟체크(python wavealgo/ta/stdev.py 직접 실행값과 대조): len=3 window=[10,20,30] → 8.164965809
    expect(results[2]).toBeCloseTo(8.164965809, 9);
    // len=4 window=[10,20,30,40] → population=125 → sqrt=11.180339887
    expect(results[3]).toBeCloseTo(11.180339887, 9);
  });

  it("biased=false applies the Bessel correction (population*n/(n-1)) on top of the same recomputed window", () => {
    const state = {};
    stdevVarLen(state, 10, 1, true, 10, 0);
    stdevVarLen(state, 20, 1, true, 10, 1);
    // window=[10,20,30], population variance=200/3, unbiased=population*3/2=100 → stdev=10
    expect(stdevVarLen(state, 30, 3, false, 10, 2)).toBeCloseTo(10, 9);
  });

  it("length=0 → NaN (pine2py ZeroDivisionError crash → hand-verified na, DIVERGENCES #182)", () => {
    const state = {};
    expect(stdevVarLen(state, 10, 0, true, 10, 0)).toBeNaN();
  });

  it("length<0 → +0 (pine2py crash-free 0.0 literal port, python 직접 확인 — negative zero normalized to +0, MEMORY C45)", () => {
    const state = {};
    const result = stdevVarLen(state, 10, -2, true, 10, 0);
    expect(result).toBe(0);
    expect(Object.is(result, 0)).toBe(true);
  });

  it("length=NaN → NaN (TV 미검증 가설, highestVarLen과 동일 na 전파 외삽)", () => {
    const state = {};
    expect(stdevVarLen(state, 10, NaN, true, 10, 0)).toBeNaN();
  });

  it("returns NaN during warmup (observed bars < length) and recovers once the window fills", () => {
    const state = {};
    expect(stdevVarLen(state, 10, 3, true, 10, 0)).toBeNaN();
    expect(stdevVarLen(state, 20, 3, true, 10, 1)).toBeNaN();
    expect(stdevVarLen(state, 30, 3, true, 10, 2)).toBeCloseTo(8.164965809, 9);
  });

  it("poisons while a NaN value sits inside the trailing window, then recovers", () => {
    const state = {};
    stdevVarLen(state, 10, 1, true, 10, 0);
    expect(stdevVarLen(state, NaN, 1, true, 10, 1)).toBeNaN();
    expect(stdevVarLen(state, 20, 2, true, 10, 2)).toBeNaN(); // 창=[NaN,20]
    expect(stdevVarLen(state, 30, 2, true, 10, 3)).toBeCloseTo(5, 9); // 창=[20,30]
  });

  it("same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    stdevVarLen(state, 10, 1, true, 10, 0);
    stdevVarLen(state, 90, 1, true, 10, 0);
    expect(stdevVarLen(state, 30, 1, true, 10, 0)).toBe(0); // 단일 값 창 → stdev 0
    expect(stdevVarLen(state, 50, 2, true, 10, 1)).toBeCloseTo(10, 9); // 창=[30(bar0 최종),50]
  });

  it("fractional length truncates toward zero (Math.trunc, array-index rule)", () => {
    const state = {};
    stdevVarLen(state, 10, 1, true, 10, 0);
    expect(stdevVarLen(state, 20, 2.9, true, 10, 1)).toBeCloseTo(5, 9); // trunc(2.9)=2 → 창=[10,20]
  });
});

describe("math.sum variable(series) length (sumVarLen)", () => {
  it("sums whatever's available with no warmup NaN gate — min(length, observed bars), NaN elements contribute 0 (not poison)", () => {
    const state = {};
    expect(sumVarLen(state, 10, 1, 10, 0)).toBe(10);
    expect(sumVarLen(state, NaN, 2, 10, 1)).toBe(10); // 창=[NaN,10] → NaN 기여 0
    expect(sumVarLen(state, 30, 5, 10, 2)).toBe(40); // length(5) > 관측 3바 → min(5,3)=3, 창=[30,NaN,10]
    expect(sumVarLen(state, 40, 3, 10, 3)).toBe(70); // 창=[40,30,NaN] → NaN 기여 0
  });

  it("length<=0 → 0 (pine2py crash-free 0.0 literal port, python 직접 확인 — no negative-zero concern, pure sum)", () => {
    const state = {};
    expect(sumVarLen(state, 10, 0, 10, 0)).toBe(0);
    expect(sumVarLen(state, 20, -3, 10, 1)).toBe(0);
  });

  it("length=NaN → NaN (pine2py `min(nan, dataLen)` → `range(nan)` TypeError crash → hand-verified na)", () => {
    const state = {};
    expect(sumVarLen(state, 10, NaN, 10, 0)).toBeNaN();
  });

  it("same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    sumVarLen(state, 10, 2, 10, 0);
    sumVarLen(state, 90, 2, 10, 0);
    expect(sumVarLen(state, 30, 2, 10, 0)).toBe(30); // 창=[30] (여전히 1바)
    expect(sumVarLen(state, 50, 2, 10, 1)).toBe(80); // 창=[30(bar0 최종),50]
  });

  it("fractional length truncates toward zero (Math.trunc, array-index rule)", () => {
    const state = {};
    sumVarLen(state, 10, 1, 10, 0);
    expect(sumVarLen(state, 20, 2.9, 10, 1)).toBe(30); // trunc(2.9)=2 → 창=[10,20]
  });
});

// ta.highestbars/ta.lowestbars(source, length) — offset (0=current bar, -1=1 bar ago, ...) to where
// the max/min occurred over the trailing `length` bars. No new state shape: reuses rt.ta.highest/
// rt.ta.lowest's ExtremeState and reads `state.seq - state.dequeSeq[state.dequeHead]` (bars elapsed
// since the current extreme was recorded) after calling highest()/lowest() to advance. Same NaN-poison
// window as highest/lowest (no divergence from pine2py here — highest.py's own highestbars()/
// lowestbars() already use poison-window, unlike wpr.py). Tie-break: pine2py scans source.get(0..
// length-1) newest-to-oldest with a strict `>`/`<` update, so on a tie the smallest i (=most recent
// occurrence) wins — verified against the deque-based implementation with a 5,000-sample fuzz
// (including a narrow value range to force frequent ties) in scratch/probe_highestbars.mjs.
describe("ta.highestbars", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3, data_len<length)", () => {
    const state = {};
    expect(highestbars(state, 101, 3)).toBeNaN();
    expect(highestbars(state, 102, 3)).toBeNaN();
  });

  it("matches a hand-computed offset once the window fills (length=2)", () => {
    const state = {};
    highestbars(state, 10, 2); // NaN, buffer [10, NaN]
    expect(highestbars(state, 12, 2)).toBe(0); // window [10,12], max=12 at current bar
    expect(highestbars(state, 5, 2)).toBe(-1); // window [12,5], max=12 one bar ago
    expect(highestbars(state, 3, 2)).toBe(-1); // window [5,3], max=5 one bar ago
  });

  it("matches the pine2py-verified sample10.json trace (close, length=4)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => highestbars(state, c, 4));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBe(-1);
    expect(results[4]).toBe(0);
    expect(results[5]).toBe(0);
    expect(results[6]).toBe(0);
    expect(results[7]).toBe(-1);
    expect(results[8]).toBe(0);
    expect(results[9]).toBe(0);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    highestbars(stateA, 10, 2);
    expect(highestbars(stateA, 12, 2)).toBe(0);
    expect(highestbars(stateB, 100, 2)).toBeNaN();
  });

  it("resolves ties toward the most recent occurrence (smallest offset, not the oldest)", () => {
    const state = {};
    // all-equal window: the max is "achieved" at every position, but the tie-break must land on the
    // current bar (offset 0) every time, not the oldest bar in the window.
    expect(highestbars(state, 5, 3)).toBeNaN();
    expect(highestbars(state, 5, 3)).toBeNaN();
    expect(highestbars(state, 5, 3)).toBe(0);
    expect(highestbars(state, 5, 3)).toBe(0);
  });

  it("re-anchors the recorded offset to the newer bar when a later value ties the running max", () => {
    const state = {};
    // window fills with [1,9,2] -> max=9 at offset -1. Next bar ties at 9 (now [9,2,9]) -> the tie must
    // be recorded as the *new* occurrence (offset -1 again relative to the new current bar), not still
    // pointing at the original bar (which would now be offset -2).
    highestbars(state, 1, 3); // NaN
    highestbars(state, 9, 3); // NaN
    expect(highestbars(state, 2, 3)).toBe(-1); // window [1,9,2], max=9 one bar ago
    expect(highestbars(state, 9, 3)).toBe(0); // window [9,2,9], tie resolves to the current bar
    expect(highestbars(state, 4, 3)).toBe(-1); // window [2,9,4], max=9 one bar ago (the re-anchored one)
  });

  it("matches a from-scratch O(length) brute-force recomputation (pine2py highest.py highestbars(): scan newest-to-oldest, strict '>' keeps the smallest/most-recent index) across ties, NaN gaps, and deque wraparound", () => {
    const state = {};
    const length = 4;
    const raw = [5, 5, 5, 3, 5, 5, 1, 1, 1, 9, 9, 2, 2, 2, 2, NaN, 6, 6, 6, 6, 6];
    const results = raw.map((v) => highestbars(state, v, length));
    for (let i = 0; i < raw.length; i++) {
      if (i < length - 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const window = raw.slice(i - length + 1, i + 1); // oldest..newest
      if (window.some((w) => Number.isNaN(w))) {
        expect(results[i]).toBeNaN();
        continue;
      }
      let maxVal = -Infinity;
      let maxIdx = 0; // 0=current bar (newest), counting backward
      for (let k = 0; k < length; k++) {
        const val = window[length - 1 - k]!; // k=0 -> newest, k=length-1 -> oldest
        if (val > maxVal) {
          maxVal = val;
          maxIdx = k;
        }
      }
      expect(results[i]).toBe(maxIdx === 0 ? 0 : -maxIdx); // -0 normalized (see runtime/ta.ts highestbars comment)
    }
  });
});

describe("ta.lowestbars", () => {
  it("returns NaN for the first length-1 calls (buffer warmup, length=3, data_len<length)", () => {
    const state = {};
    expect(lowestbars(state, 101, 3)).toBeNaN();
    expect(lowestbars(state, 102, 3)).toBeNaN();
  });

  it("matches a hand-computed offset once the window fills (length=2)", () => {
    const state = {};
    lowestbars(state, 10, 2); // NaN, buffer [10, NaN]
    expect(lowestbars(state, 12, 2)).toBe(-1); // window [10,12], min=10 one bar ago
    expect(lowestbars(state, 5, 2)).toBe(0); // window [12,5], min=5 at current bar
    expect(lowestbars(state, 20, 2)).toBe(-1); // window [5,20], min=5 one bar ago
  });

  it("matches the pine2py-verified sample10.json trace (close, length=4)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => lowestbars(state, c, 4));
    expect(results.slice(0, 3).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[3]).toBe(-3);
    expect(results[4]).toBe(-1);
    expect(results[5]).toBe(-2);
    expect(results[6]).toBe(-3);
    expect(results[7]).toBe(-3);
    expect(results[8]).toBe(-1);
    expect(results[9]).toBe(-2);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    lowestbars(stateA, 10, 2);
    expect(lowestbars(stateA, 12, 2)).toBe(-1);
    expect(lowestbars(stateB, 100, 2)).toBeNaN();
  });

  it("resolves ties toward the most recent occurrence (smallest offset, not the oldest)", () => {
    const state = {};
    expect(lowestbars(state, 5, 3)).toBeNaN();
    expect(lowestbars(state, 5, 3)).toBeNaN();
    expect(lowestbars(state, 5, 3)).toBe(0);
    expect(lowestbars(state, 5, 3)).toBe(0);
  });

  it("re-anchors the recorded offset to the newer bar when a later value ties the running min", () => {
    const state = {};
    lowestbars(state, 9, 3); // NaN
    lowestbars(state, 1, 3); // NaN
    expect(lowestbars(state, 8, 3)).toBe(-1); // window [9,1,8], min=1 one bar ago
    expect(lowestbars(state, 1, 3)).toBe(0); // window [1,8,1], tie resolves to the current bar
    expect(lowestbars(state, 6, 3)).toBe(-1); // window [8,1,6], min=1 one bar ago (the re-anchored one)
  });

  it("matches a from-scratch O(length) brute-force recomputation (pine2py highest.py lowestbars(): scan newest-to-oldest, strict '<' keeps the smallest/most-recent index) across ties, NaN gaps, and deque wraparound", () => {
    const state = {};
    const length = 4;
    const raw = [5, 5, 5, 7, 5, 5, 9, 9, 9, 1, 1, 8, 8, 8, 8, NaN, 4, 4, 4, 4, 4];
    const results = raw.map((v) => lowestbars(state, v, length));
    for (let i = 0; i < raw.length; i++) {
      if (i < length - 1) {
        expect(results[i]).toBeNaN();
        continue;
      }
      const window = raw.slice(i - length + 1, i + 1); // oldest..newest
      if (window.some((w) => Number.isNaN(w))) {
        expect(results[i]).toBeNaN();
        continue;
      }
      let minVal = Infinity;
      let minIdx = 0;
      for (let k = 0; k < length; k++) {
        const val = window[length - 1 - k]!;
        if (val < minVal) {
          minVal = val;
          minIdx = k;
        }
      }
      expect(results[i]).toBe(minIdx === 0 ? 0 : -minIdx); // -0 normalized (see runtime/ta.ts lowestbars comment)
    }
  });
});

// ta.cog(source, length) — Center of Gravity. pine2py wavealgo/ta/cog.py: num=Σsource.get(i)*(i+1)
// (i=0=current bar, weight 1..i=length-1=oldest bar, weight length), denom=Σsource.get(i)(=state.sum),
// result=-num/denom (negative sign). No new state shape: reuses rt.ta.wma's internal running totals
// (state.sum/state.weightedSum) via the identity num=(length+1)*state.sum-state.weightedSum, same
// "compose from an already-implemented TA" principle as linreg (C41). scratch/probe_cog.mjs
// cross-checked this identity against a literal brute-force port of cog.py.
describe("ta.cog", () => {
  it("returns NaN while the window is still filling (length=2)", () => {
    const state = {};
    expect(cog(state, 10, 2)).toBeNaN();
  });

  it("matches a hand-computed COG once the window fills (length=2)", () => {
    const state = {};
    cog(state, 10, 2); // window=[10]
    // window=[10,20], get(0)=20(weight1) get(1)=10(weight2): num=20*1+10*2=40, denom=30 -> -40/30
    expect(cog(state, 20, 2)).toBeCloseTo(-1.3333333333333333, 9);
    // window=[20,5], get(0)=5(weight1) get(1)=20(weight2): num=5*1+20*2=45, denom=25 -> -45/25
    expect(cog(state, 5, 2)).toBeCloseTo(-1.8, 9);
  });

  it("matches the pine2py-verified sample10.json trace (length=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => cog(state, c, 3));
    expect(results.slice(0, 2).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[2]).toBeCloseTo(-1.9934640522875817, 9);
    expect(results[3]).toBeCloseTo(-2.0, 9);
    expect(results[4]).toBeCloseTo(-1.9967637540453074, 9);
    expect(results[5]).toBeCloseTo(-1.9903536977491962, 9);
    expect(results[6]).toBeCloseTo(-1.9936507936507937, 9);
    expect(results[7]).toBeCloseTo(-2.0, 9);
    expect(results[8]).toBeCloseTo(-1.9968553459119496, 9);
    expect(results[9]).toBeCloseTo(-1.990625, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    cog(stateA, 10, 2);
    expect(cog(stateA, 20, 2)).toBeCloseTo(-1.3333333333333333, 9);
    expect(cog(stateB, 50, 2)).toBeNaN(); // stateB's own window still filling
  });

  it("returns NaN when the window contains a NaN (poison window, same class as ta.highest)", () => {
    const state = {};
    cog(state, 10, 3);
    cog(state, NaN, 3);
    expect(cog(state, 20, 3)).toBeNaN(); // window still has the NaN at position get(2)
    expect(cog(state, 30, 3)).toBeNaN(); // window=[NaN,20,30]
    expect(cog(state, 40, 3)).toBeCloseTo(-1.7777777777777777, 9); // window=[20,30,40], NaN evicted
  });

  it("length=1 degenerate case: result is -1 unless the single value is 0 (denom===0 -> NaN)", () => {
    const state = {};
    expect(cog(state, 5, 1)).toBeCloseTo(-1, 9);
    expect(cog(state, -3, 1)).toBeCloseTo(-1, 9);
    expect(cog(state, 0, 1)).toBeNaN();
  });

  it("returns NaN when denom(=state.sum)===0 for a symmetric window (length=2)", () => {
    const state = {};
    cog(state, 3, 2);
    expect(cog(state, -3, 2)).toBeNaN(); // window=[3,-3], sum=0
  });

  it("keeps returning NaN until the NaN spike is fully evicted from a longer window (length=4)", () => {
    const state = {};
    cog(state, 1, 4);
    cog(state, 2, 4);
    cog(state, 3, 4);
    expect(cog(state, NaN, 4)).toBeNaN(); // buffer now [1,2,3,NaN]
    // buffer's circular writeIdx only overwrites slots 0/1 next (values 4/5) — the NaN slot isn't
    // due for eviction yet, so the whole window stays poisoned for two more calls.
    expect(cog(state, 4, 4)).toBeNaN();
    expect(cog(state, 5, 4)).toBeNaN();
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py cog.py port) across a longer randomized-ish sequence (length=4)", () => {
    const state = {};
    const values = [12, -5, 33, 0, 7, -19, 8, 21, -2, 14, 6, -8, 40, 1, -1];
    const length = 4;

    function bruteForce(source: number[], len: number): number[] {
      const out: number[] = [];
      for (let idx = 0; idx < source.length; idx++) {
        if (idx + 1 < len) {
          out.push(NaN);
          continue;
        }
        let num = 0;
        let denom = 0;
        let hasNaN = false;
        for (let i = 0; i < len; i++) {
          const val = source[idx - i]!;
          if (Number.isNaN(val)) {
            hasNaN = true;
            break;
          }
          num += val * (i + 1);
          denom += val;
        }
        if (hasNaN || denom === 0) {
          out.push(NaN);
          continue;
        }
        out.push(-num / denom);
      }
      return out;
    }

    const expected = bruteForce(values, length);
    const actual = values.map((v) => cog(state, v, length));
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(expected[i])) {
        expect(actual[i]).toBeNaN();
      } else {
        expect(actual[i]).toBeCloseTo(expected[i]!, 9);
      }
    }
  });
});

// ta.correlation(source1, source2, length) — Pearson correlation coefficient. pine2py wavealgo/ta/
// correlation.py: five running sums (Σx,Σy,Σxy,Σx²,Σy²) over a fixed window, numerator=n*Σxy-Σx*Σy,
// denom_x=n*Σx²-(Σx)², denom_y=n*Σy²-(Σy)², result=numerator/sqrt(denom_x*denom_y). This is ta.vwma's
// "two signals, parallel buffers" shape (C29) combined with ta.variance/ta.stdev's sum-of-squares
// identity (C36) — no positional weighting involved. denom_x<=0 or denom_y<=0 (not just ==0) guards
// both an exactly-flat window and floating-point cancellation pushing a near-zero denominator slightly
// negative, ported byte-for-byte from pine2py (same class of pitfall as ta.variance's clamp, C36).
// scratch/probe_correlation.mjs cross-checked this against a literal brute-force port of
// correlation.py (sample10 + perfectly-(anti)correlated + exact/near-constant windows + embedded-NaN
// gaps in each signal independently + length=1 degenerate + 5,000-sample fuzz per length).
describe("ta.correlation", () => {
  it("returns NaN while the window is still filling (length=3)", () => {
    const state = {};
    expect(correlation(state, 1, 2, 3)).toBeNaN();
    expect(correlation(state, 2, 4, 3)).toBeNaN();
  });

  it("matches a hand-computed perfect positive correlation once the window fills (length=2, y=2x)", () => {
    const state = {};
    correlation(state, 1, 2, 2); // window=[1], NaN
    expect(correlation(state, 2, 4, 2)).toBeCloseTo(1, 9); // window x=[1,2] y=[2,4], perfectly linear
  });

  it("matches a hand-computed perfect negative correlation once the window fills (length=2, y=-x)", () => {
    const state = {};
    correlation(state, 1, -1, 2);
    expect(correlation(state, 2, -2, 2)).toBeCloseTo(-1, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close vs volume, length=3)", () => {
    // close vs open/high/low is a degenerate case in sample10.json — those series are each a
    // constant offset from close (open=close-1, high=close+1, low=close-2 for every bar), so their
    // correlation with close is always exactly 1.0 and never exercises the numerator's variability.
    // close vs volume is genuinely independent and matches the oracle case (ta_correlation.pine).
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const results = closes.map((c, i) => correlation(state, c, volumes[i]!, 3));
    expect(results.slice(0, 2).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[2]).toBeCloseTo(1, 9);
    expect(results[3]).toBeCloseTo(0.8660254037844387, 9);
    expect(results[4]).toBeCloseTo(0.9819805060619657, 9);
    expect(results[5]).toBeCloseTo(0.7857142857142857, 9);
    expect(results[6]).toBeCloseTo(0.6546536707079772, 9);
    expect(results[7]).toBeCloseTo(0.7559289460184544, 9);
    expect(results[8]).toBeCloseTo(0.9819805060619657, 9);
    expect(results[9]).toBeCloseTo(0.7857142857142857, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    correlation(stateA, 1, 2, 2);
    expect(correlation(stateA, 2, 4, 2)).toBeCloseTo(1, 9);
    expect(correlation(stateB, 5, 9, 2)).toBeNaN(); // stateB's own window still filling
  });

  it("returns NaN when source1's window contains a NaN (poison window)", () => {
    const state = {};
    correlation(state, 10, 1, 3);
    correlation(state, NaN, 2, 3);
    expect(correlation(state, 20, 3, 3)).toBeNaN(); // window still has the NaN at get(2)
    expect(correlation(state, 30, 4, 3)).toBeNaN(); // x window=[NaN,20,30]
  });

  it("returns NaN when source2's window contains a NaN (poison window)", () => {
    const state = {};
    correlation(state, 1, 10, 3);
    correlation(state, 2, NaN, 3);
    expect(correlation(state, 3, 20, 3)).toBeNaN(); // window still has the NaN at get(2)
    expect(correlation(state, 4, 30, 3)).toBeNaN(); // y window=[NaN,20,30]
  });

  it("returns NaN when source1 is constant within the window (denom_x<=0)", () => {
    const state = {};
    correlation(state, 5, 1, 3);
    correlation(state, 5, 2, 3);
    expect(correlation(state, 5, 3, 3)).toBeNaN();
  });

  it("returns NaN when source2 is constant within the window (denom_y<=0)", () => {
    const state = {};
    correlation(state, 1, 5, 3);
    correlation(state, 2, 5, 3);
    expect(correlation(state, 3, 5, 3)).toBeNaN();
  });

  it("length=1 degenerate case: denom is always exactly 0 -> always NaN", () => {
    const state = {};
    expect(correlation(state, 5, 9, 1)).toBeNaN();
    expect(correlation(state, -3, 2, 1)).toBeNaN();
  });

  it("keeps returning NaN until the NaN spike is fully evicted from a longer window (length=4)", () => {
    const state = {};
    correlation(state, 1, 10, 4);
    correlation(state, 2, 20, 4);
    correlation(state, 3, 30, 4);
    expect(correlation(state, NaN, 40, 4)).toBeNaN(); // x buffer now [1,2,3,NaN]
    expect(correlation(state, 4, 41, 4)).toBeNaN(); // NaN slot not due for eviction yet
    expect(correlation(state, 5, 42, 4)).toBeNaN();
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py correlation.py port) with independent x/y sequences (length=4)", () => {
    const state = {};
    const xs = [12, -5, 33, 0, 7, -19, 8, 21, -2, 14, 6, -8, 40, 1, -1];
    const ys = [3, 8, -2, 15, -7, 4, 22, -11, 9, 0, 18, -5, 6, -13, 10];
    const length = 4;

    function bruteForce(source1: number[], source2: number[], len: number): number[] {
      const out: number[] = [];
      for (let idx = 0; idx < source1.length; idx++) {
        if (idx + 1 < len) {
          out.push(NaN);
          continue;
        }
        let sumX = 0;
        let sumY = 0;
        let sumXY = 0;
        let sumX2 = 0;
        let sumY2 = 0;
        let hasNaN = false;
        for (let i = 0; i < len; i++) {
          const x = source1[idx - i]!;
          const y = source2[idx - i]!;
          if (Number.isNaN(x) || Number.isNaN(y)) {
            hasNaN = true;
            break;
          }
          sumX += x;
          sumY += y;
          sumXY += x * y;
          sumX2 += x * x;
          sumY2 += y * y;
        }
        if (hasNaN) {
          out.push(NaN);
          continue;
        }
        const n = len;
        const numerator = n * sumXY - sumX * sumY;
        const denomX = n * sumX2 - sumX * sumX;
        const denomY = n * sumY2 - sumY * sumY;
        if (denomX <= 0 || denomY <= 0) {
          out.push(NaN);
          continue;
        }
        out.push(numerator / Math.sqrt(denomX * denomY));
      }
      return out;
    }

    const expected = bruteForce(xs, ys, length);
    const actual = xs.map((x, i) => correlation(state, x, ys[i]!, length));
    for (let i = 0; i < xs.length; i++) {
      if (Number.isNaN(expected[i])) {
        expect(actual[i]).toBeNaN();
      } else {
        expect(actual[i]).toBeCloseTo(expected[i]!, 9);
      }
    }
  });
});

// ta.tsi(source, short_length, long_length) — True Strength Index. pine2py wavealgo/ta/tsi.py
// inlines its own _ema_step helper rather than reusing ema.py, but the step transition (accumulate
// `length` bars, seed with their SMA, then alpha=2/(length+1) exponential smoothing) is identical to
// rt.ta.ema — so this is a composition calling the already-implemented ema() four independent times
// (e1 over pc/abs(pc) with long_length, e2 over e1's outputs with short_length), same principle as
// hma/linreg/stoch/cog. pine2py explicitly skips the e2 _ema_step calls while e1 is still NaN
// (early return before calling them); this port calls e2's ema() unconditionally every bar instead,
// relying on ema()'s own top-of-function NaN gate (leaves state untouched when fed NaN) to produce an
// equivalent result without an explicit skip branch — verified via scratch/probe_tsi.mjs (sample10 +
// flat-series e2AbsVal===0 + short=long=1 degenerate + source NaN gaps + zigzag + 5,000-sample fuzz
// across several short/long pairs, all PASS against a literal brute-force port of tsi.py). prevSource
// is raw-passthrough (mirrors change/cmo/crossover): overwritten whenever value itself is non-NaN,
// even if the old prevSource was NaN. e2AbsVal===0 returns 0.0 (not NaN), matching tsi.py L128-129.
describe("ta.tsi", () => {
  it("returns NaN for the first bar (no prevSource yet)", () => {
    const state = {};
    expect(tsi(state, 100, 2, 3)).toBeNaN();
  });

  it("returns NaN while e1/e2 are still warming up (short=2, long=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102];
    const results = closes.map((c) => tsi(state, c, 2, 3));
    expect(results.every((r) => Number.isNaN(r))).toBe(true);
  });

  it("matches the pine2py-verified sample10.json trace (close, short=2, long=3)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => tsi(state, c, 2, 3));
    expect(results.slice(0, 4).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[4]).toBeCloseTo(0.6, 9);
    expect(results[5]).toBeCloseTo(0.7777777777777779, 9);
    expect(results[6]).toBeCloseTo(0.873015873015873, 9);
    expect(results[7]).toBeCloseTo(0.32208157524613223, 9);
    expect(results[8]).toBeCloseTo(0.5707660916342052, 9);
    expect(results[9]).toBeCloseTo(0.7151485311012638, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    const closes = [101, 102, 103, 102, 104];
    for (const c of closes) tsi(stateA, c, 2, 3);
    expect(tsi(stateB, 5, 2, 3)).toBeNaN(); // stateB's own warmup still fresh
  });

  it("returns NaN on a NaN bar without clobbering prevSource (raw-passthrough skip, short=1 long=1 for immediate resume)", () => {
    // length=1 means each ema() call's alpha is 2/(1+1)=1, which discards prevEma entirely and
    // returns the raw input - so warmup finishes after a single bar and every later bar resumes
    // immediately. This isolates the raw-passthrough prevSource claim: if a NaN bar incorrectly
    // overwrote state.prevSource with NaN, the very next bar's pc would compute against NaN and
    // stay NaN forever instead of resuming.
    const state = {};
    tsi(state, 100, 1, 1); // NaN (no prevSource yet)
    expect(tsi(state, 101, 1, 1)).toBeCloseTo(1, 9);
    expect(tsi(state, 102, 1, 1)).toBeCloseTo(1, 9);
    expect(tsi(state, NaN, 1, 1)).toBeNaN(); // value itself NaN - prevSource must stay 102
    expect(tsi(state, 105, 1, 1)).toBeCloseTo(1, 9); // pc=105-102=3, resumes immediately
  });

  it("returns 0.0 (not NaN) when e2's abs-pc EMA is exactly zero (perfectly flat series)", () => {
    const state = {};
    const flat = new Array(10).fill(100);
    const results = flat.map((v) => tsi(state, v, 2, 3));
    expect(results.slice(0, 4).every((r) => Number.isNaN(r))).toBe(true);
    for (let i = 4; i < 10; i++) {
      expect(results[i]).toBe(0);
      expect(Object.is(results[i], -0)).toBe(false);
    }
  });

  it("matches a hand-computed degenerate trace (short_length=1, long_length=1)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => tsi(state, c, 1, 1));
    expect(results[0]).toBeNaN();
    expect(results[1]).toBeCloseTo(1, 9);
    expect(results[2]).toBeCloseTo(1, 9);
    expect(results[3]).toBeCloseTo(-1, 9);
    expect(results[4]).toBeCloseTo(1, 9);
    expect(results[5]).toBeCloseTo(1, 9);
    expect(results[6]).toBeCloseTo(1, 9);
    expect(results[7]).toBeCloseTo(-1, 9);
    expect(results[8]).toBeCloseTo(1, 9);
    expect(results[9]).toBeCloseTo(1, 9);
  });

  it("keeps returning NaN across a source NaN gap until pc/abs(pc) warm back up (short=2, long=3)", () => {
    const state = {};
    const srcGap = [100, 101, NaN, 103, 104, 105, 106, 107, 108, 109];
    const results = srcGap.map((v) => tsi(state, v, 2, 3));
    expect(results.slice(0, 5).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[5]).toBeCloseTo(1, 9);
    expect(results[6]).toBeCloseTo(1, 9);
    expect(results[7]).toBeCloseTo(1, 9);
    expect(results[8]).toBeCloseTo(1, 9);
    expect(results[9]).toBeCloseTo(1, 9);
  });

  it("matches a hand-verified zigzag trace (short_length=3, long_length=5)", () => {
    const state = {};
    const zigzag = [100, 105, 98, 107, 96, 109, 94, 111, 92, 113];
    const results = zigzag.map((v) => tsi(state, v, 3, 5));
    expect(results.slice(0, 7).every((r) => Number.isNaN(r))).toBe(true);
    expect(results[7]).toBeCloseTo(0.03434343434343432, 9);
    expect(results[8]).toBeCloseTo(-0.14871794871794874, 9);
    expect(results[9]).toBeCloseTo(0.07456790123456788, 9);
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py tsi.py port) with a longer random sequence (short=5, long=13)", () => {
    const state = {};
    const values = [
      100, 102, 99, 105, 108, 104, 110, 107, 113, 109, 115, 112, 118, 121, 116, 123, 119, 126, 130, 124, 128, 133,
      129, 135, 131,
    ];
    const shortLength = 5;
    const longLength = 13;

    function bruteEmaStep(value: number, length: number, s: { count: number; sum: number; ema: number }): number {
      s.count += 1;
      if (s.count <= length) {
        s.sum += value;
        s.ema = s.count === length ? s.sum / length : NaN;
        return s.ema;
      }
      const mult = 2.0 / (length + 1);
      s.ema = value * mult + s.ema * (1 - mult);
      return s.ema;
    }

    function bruteForce(sources: number[], shortLen: number, longLen: number): number[] {
      const bs = {
        prevSource: NaN,
        e1Pc: { count: 0, sum: 0, ema: NaN },
        e1Abs: { count: 0, sum: 0, ema: NaN },
        e2Pc: { count: 0, sum: 0, ema: NaN },
        e2Abs: { count: 0, sum: 0, ema: NaN },
      };
      const out: number[] = [];
      for (const val of sources) {
        if (Number.isNaN(val)) {
          out.push(NaN);
          continue;
        }
        const prevSource = bs.prevSource;
        bs.prevSource = val;
        if (Number.isNaN(prevSource)) {
          out.push(NaN);
          continue;
        }
        const pc = val - prevSource;
        const absPc = Math.abs(pc);
        const e1PcVal = bruteEmaStep(pc, longLen, bs.e1Pc);
        const e1AbsVal = bruteEmaStep(absPc, longLen, bs.e1Abs);
        if (Number.isNaN(e1PcVal) || Number.isNaN(e1AbsVal)) {
          out.push(NaN);
          continue;
        }
        const e2PcVal = bruteEmaStep(e1PcVal, shortLen, bs.e2Pc);
        const e2AbsVal = bruteEmaStep(e1AbsVal, shortLen, bs.e2Abs);
        if (Number.isNaN(e2PcVal) || Number.isNaN(e2AbsVal)) {
          out.push(NaN);
          continue;
        }
        out.push(e2AbsVal === 0 ? 0.0 : e2PcVal / e2AbsVal);
      }
      return out;
    }

    const expected = bruteForce(values, shortLength, longLength);
    const actual = values.map((v) => tsi(state, v, shortLength, longLength));
    for (let i = 0; i < values.length; i++) {
      if (Number.isNaN(expected[i])) {
        expect(actual[i]).toBeNaN();
      } else {
        expect(actual[i]).toBeCloseTo(expected[i]!, 9);
      }
    }
  });
});

// ta.macd(source, fast_length, slow_length, signal_length) — 첫 다중 반환 TA(C50). pine2py
// wavealgo/ta/macd.py는 macd_line = ema(fast) - ema(slow)(진짜 wavealgo ema 재사용) 후 signal
// EMA를 자체 인라인(signal_init_count/sum/prev_signal)하는데 그 전이가 rt.ta.ema와 완전히 동일해
// rt.ta.ema 3벌 합성으로 이식했다(tsi C49와 동일 원칙). pine2py는 fast/slow가 NaN이면 signal
// 블록 전체를 조기 반환으로 건너뛰지만, pine2js는 NaN macdLine을 ema()에 무조건 먹여 최상단
// NaN 게이트가 상태를 불변으로 두는 것으로 동치를 얻는다(scratch/probe_macd.mjs로 검증 완료).
// 반환은 튜플/배열 생성 대신 호출자가 넘긴 공유 스크래치 배열 scratch[0..2]에 기록(GOAL.md
// "다중 반환 TA는 재사용 스크래치 배열").
describe("ta.macd", () => {
  function macd3(state: Parameters<typeof macd>[0], value: number, f: number, s: number, sig: number): [number, number, number] {
    const scratch = new Float64Array(3);
    macd(state, value, f, s, sig, scratch);
    return [scratch[0]!, scratch[1]!, scratch[2]!];
  }

  it("writes NaN to all three outputs while the slow EMA is still warming up (fast=2, slow=3)", () => {
    const state = {};
    for (const c of [101, 102]) {
      const [m, s, h] = macd3(state, c, 2, 3, 2);
      expect(m).toBeNaN();
      expect(s).toBeNaN();
      expect(h).toBeNaN();
    }
  });

  it("emits macd-only (signal/hist still NaN) on the bar the slow EMA seeds, before signal warms up", () => {
    const state = {};
    macd3(state, 101, 2, 3, 2);
    macd3(state, 102, 2, 3, 2);
    const [m, s, h] = macd3(state, 103, 2, 3, 2); // slow seeds here: fast=102.5, slow=102
    expect(m).toBeCloseTo(0.5, 9);
    expect(s).toBeNaN();
    expect(h).toBeNaN();
  });

  it("matches the pine2py-verified sample10.json trace (close, fast=2, slow=3, signal=2)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c) => macd3(state, c, 2, 3, 2));
    for (let i = 0; i < 2; i++) {
      expect(out[i]![0]).toBeNaN();
      expect(out[i]![1]).toBeNaN();
      expect(out[i]![2]).toBeNaN();
    }
    expect(out[2]![0]).toBeCloseTo(0.5, 9);
    expect(out[2]![1]).toBeNaN();
    expect(out[2]![2]).toBeNaN();
    // 바3부터 3값 전부 유효 — oracle/golden/ta_macd.json(pine2py precision 10자리)과 동일 값
    expect(out[3]![0]).toBeCloseTo(0.1666666667, 9);
    expect(out[3]![1]).toBeCloseTo(0.3333333333, 9);
    expect(out[3]![2]).toBeCloseTo(-0.1666666667, 9);
    expect(out[4]![0]).toBeCloseTo(0.3888888889, 9);
    expect(out[4]![1]).toBeCloseTo(0.3703703704, 9);
    expect(out[4]![2]).toBeCloseTo(0.0185185185, 9);
    expect(out[9]![0]).toBeCloseTo(0.4625057156, 9);
    expect(out[9]![1]).toBeCloseTo(0.4238683128, 9);
    expect(out[9]![2]).toBeCloseTo(0.0386374028, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    for (const c of [101, 102, 103, 102, 104]) macd3(stateA, c, 2, 3, 2);
    const [m, s, h] = macd3(stateB, 5, 2, 3, 2); // stateB's own warmup still fresh
    expect(m).toBeNaN();
    expect(s).toBeNaN();
    expect(h).toBeNaN();
  });

  it("leaves the signal state untouched across a source NaN gap (hand-verified, fast=1, slow=2, signal=2)", () => {
    // 바0: slow 워밍업 → 전부 NaN. 바1: slow 시드 101, macd=1, signal 축적 1개. 바2: NaN — 만약
    // NaN macdLine이 signal 상태를 오염/전진시켰다면 바3의 시드값이 달라진다. 바3: fast=106,
    // slow=2/3*106+1/3*101=104.3333..., macd=5/3, signal 시드=(1+5/3)/2=4/3, hist=5/3-4/3=1/3.
    const state = {};
    macd3(state, 100, 1, 2, 2);
    const bar1 = macd3(state, 102, 1, 2, 2);
    expect(bar1[0]).toBeCloseTo(1, 9);
    expect(bar1[1]).toBeNaN();
    const gap = macd3(state, NaN, 1, 2, 2);
    expect(gap[0]).toBeNaN();
    expect(gap[1]).toBeNaN();
    expect(gap[2]).toBeNaN();
    const bar3 = macd3(state, 106, 1, 2, 2);
    expect(bar3[0]).toBeCloseTo(5 / 3, 9);
    expect(bar3[1]).toBeCloseTo(4 / 3, 9);
    expect(bar3[2]).toBeCloseTo(1 / 3, 9);
  });

  it("returns macd=0, signal=0, hist=0 once seeded when fast_length equals slow_length", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106];
    const out = closes.map((c) => macd3(state, c, 3, 3, 2));
    // fast/slow가 동일 상태 전이라 macd는 시드 직후부터 정확히 0, signal도 0들의 평균 → 0
    for (let i = 0; i < 2; i++) expect(out[i]![0]).toBeNaN();
    expect(out[2]![0]).toBe(0);
    expect(out[2]![1]).toBeNaN(); // signal은 아직 1개 축적
    expect(out[3]![0]).toBe(0);
    expect(out[3]![1]).toBe(0);
    expect(out[3]![2]).toBe(0);
    for (let i = 4; i < 7; i++) {
      expect(out[i]![0]).toBe(0);
      expect(out[i]![1]).toBe(0);
      expect(out[i]![2]).toBe(0);
    }
  });

  it("matches a hand-computed degenerate trace with every length = 1 (macd/signal/hist all 0 from bar 0)", () => {
    const state = {};
    for (const c of [101, 102, 103]) {
      const [m, s, h] = macd3(state, c, 1, 1, 1);
      expect(m).toBe(0); // ema(x,1) = x라 fast-slow = 0
      expect(s).toBe(0);
      expect(h).toBe(0);
    }
  });

  it("pins hist to exactly 0 with signal_length=1 (signal always equals macd)", () => {
    const state = {};
    const closes = [100, 104, 99, 108, 103, 111];
    const out = closes.map((c) => macd3(state, c, 2, 3, 1));
    for (let i = 2; i < closes.length; i++) {
      expect(Number.isNaN(out[i]![0])).toBe(false);
      expect(out[i]![1]).toBeCloseTo(out[i]![0]!, 12);
      expect(out[i]![2]).toBe(0);
    }
  });

  it("reuses the same scratch array across calls without allocating (values overwritten in place)", () => {
    // 손 계산(fast=1, slow=2, signal=2, close 101→102→104): 바0은 slow 워밍업이라 NaN, 바1은
    // slow 시드 101.5로 macd=102-101.5=0.5, 바2는 slow=2/3*104+1/3*101.5=103.1666...로
    // macd=0.8333..., signal 시드=(0.5+0.8333...)/2=0.6666...
    const state = {};
    const scratch = new Float64Array(3);
    macd(state, 101, 1, 2, 2, scratch);
    expect(scratch[0]).toBeNaN();
    macd(state, 102, 1, 2, 2, scratch);
    expect(scratch[0]).toBeCloseTo(0.5, 9); // 같은 배열 인스턴스에 덮어써졌다
    macd(state, 104, 1, 2, 2, scratch);
    expect(scratch[1]).toBeCloseTo(2 / 3, 9); // signal 시드 = (0.5 + 5/6)/2
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py macd.py port) with NaN gaps (fast=3, slow=7, signal=4)", () => {
    const state = {};
    const values = [
      100, 102, 99, NaN, 105, 108, 104, 110, 107, 113, NaN, NaN, 109, 115, 112, 118, 121, 116, 123, 119, 126, 130,
      NaN, 124, 128, 133, 129, 135, 131, 137,
    ];
    const fastLength = 3;
    const slowLength = 7;
    const signalLength = 4;

    function bruteEmaStep(value: number, length: number, s: { count: number; sum: number; ema: number }): number {
      if (Number.isNaN(value)) return NaN; // ema.py 최상단 NaN 게이트(상태 불변)
      s.count += 1;
      if (s.count <= length) {
        s.sum += value;
        s.ema = s.count === length ? s.sum / length : NaN;
        return s.ema;
      }
      const mult = 2.0 / (length + 1);
      s.ema = value * mult + s.ema * (1 - mult);
      return s.ema;
    }

    function bruteForce(sources: number[]): [number, number, number][] {
      const fast = { count: 0, sum: 0, ema: NaN };
      const slow = { count: 0, sum: 0, ema: NaN };
      const sig = { count: 0, sum: 0, prev: NaN };
      const out: [number, number, number][] = [];
      for (const val of sources) {
        const fastEma = bruteEmaStep(val, fastLength, fast);
        const slowEma = bruteEmaStep(val, slowLength, slow);
        // macd.py L54-55: 하나라도 NaN이면 signal 블록을 통째로 건너뛰는 조기 반환
        if (Number.isNaN(fastEma) || Number.isNaN(slowEma)) {
          out.push([NaN, NaN, NaN]);
          continue;
        }
        const macdLine = fastEma - slowEma;
        const alpha = 2.0 / (signalLength + 1);
        if (sig.count < signalLength) {
          sig.count += 1;
          sig.sum += macdLine;
          if (sig.count === signalLength) {
            const signalLine = sig.sum / signalLength;
            sig.prev = signalLine;
            out.push([macdLine, signalLine, macdLine - signalLine]);
          } else {
            out.push([macdLine, NaN, NaN]);
          }
          continue;
        }
        const signalLine = alpha * macdLine + (1 - alpha) * sig.prev;
        sig.prev = signalLine;
        out.push([macdLine, signalLine, macdLine - signalLine]);
      }
      return out;
    }

    const expected = bruteForce(values);
    for (let i = 0; i < values.length; i++) {
      const actual = macd3(state, values[i]!, fastLength, slowLength, signalLength);
      for (let k = 0; k < 3; k++) {
        if (Number.isNaN(expected[i]![k]!)) {
          expect(actual[k]).toBeNaN();
        } else {
          expect(actual[k]).toBeCloseTo(expected[i]![k]!, 9);
        }
      }
    }
  });
});

// ta.bb(source, length, mult) — the second multi-return TA (C51, after ta.macd/C50). pine2py
// wavealgo/ta/bb.py computes middle=SMA(source,length) and a population stdev of the same window
// (no Bessel correction, byte-identical formula to ta.variance/ta.stdev, C36), then
// upper/lower=middle±mult*stdev; poison window (data_len<length or any NaN in the window) yields
// (NaN, NaN, NaN) — same class as ta.highest (C42). Rather than an independent SMA buffer beside a
// stdev buffer, bb() calls variance() once on a single nested StdevState and reads state.inner.sum
// (already length*mean after that call) to derive middle — the linreg/cog "call for its side
// effect, read the internal running sum" pattern generalized to all three outputs from one buffer.
// Verified against a literal bb.py port via scratch/probe_bb.mjs before implementation.
describe("ta.bb", () => {
  function bb3(state: Parameters<typeof bb>[0], value: number, length: number, mult: number): [number, number, number] {
    const scratch = new Float64Array(3);
    bb(state, value, length, mult, scratch);
    return [scratch[0]!, scratch[1]!, scratch[2]!];
  }

  it("writes NaN to all three outputs while the window is still warming up (length=3)", () => {
    const state = {};
    for (const c of [101, 102]) {
      const [m, u, l] = bb3(state, c, 3, 2);
      expect(m).toBeNaN();
      expect(u).toBeNaN();
      expect(l).toBeNaN();
    }
  });

  it("matches a hand-computed trace once the window fills (length=2, mult=2)", () => {
    // window=[102,100]: middle=101, variance=((1)^2+(-1)^2)/2=1, stdev=1 -> upper=103, lower=99.
    const state = {};
    bb3(state, 100, 2, 2);
    const [m, u, l] = bb3(state, 102, 2, 2);
    expect(m).toBeCloseTo(101, 9);
    expect(u).toBeCloseTo(103, 9);
    expect(l).toBeCloseTo(99, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3, mult=2)", () => {
    // oracle/golden/ta_bb.json과 동일 값(바0~1 워밍업 NaN, 바2부터 유효).
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c) => bb3(state, c, 3, 2));
    for (let i = 0; i < 2; i++) {
      expect(out[i]![0]).toBeNaN();
      expect(out[i]![1]).toBeNaN();
      expect(out[i]![2]).toBeNaN();
    }
    expect(out[2]![0]).toBeCloseTo(102.0, 9);
    expect(out[2]![1]).toBeCloseTo(103.6329931619, 9);
    expect(out[2]![2]).toBeCloseTo(100.3670068381, 9);
    expect(out[9]![0]).toBeCloseTo(106.6666666667, 9);
    expect(out[9]![1]).toBeCloseTo(109.1611049245, 9);
    expect(out[9]![2]).toBeCloseTo(104.1722284088, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    for (const c of [101, 102, 103, 102, 104]) bb3(stateA, c, 3, 2);
    const [m, u, l] = bb3(stateB, 5, 3, 2); // stateB's own warmup still fresh
    expect(m).toBeNaN();
    expect(u).toBeNaN();
    expect(l).toBeNaN();
  });

  it("returns upper===lower===middle (no spurious NaN from sqrt) on a perfectly constant window", () => {
    // variance identity(sumSq/length - mean^2) 클램프(C36)가 정확히 0을 내는지, sqrt(0)=0이
    // 어떤 mult에도 upper/lower를 middle과 정확히 같게 만드는지 확인.
    const state = {};
    let out: [number, number, number] = [NaN, NaN, NaN];
    for (const c of [5, 5, 5, 5]) out = bb3(state, c, 3, 2);
    expect(out[0]).toBe(5);
    expect(out[1]).toBe(5);
    expect(out[2]).toBe(5);
  });

  it("applies mult algebraically (upper=middle+mult*stdev even for mult<=0, no absolute-value clamp)", () => {
    const stateZero = {};
    for (const c of [100, 102]) bb3(stateZero, c, 2, 0);
    const zero = bb3(stateZero, 104, 2, 0);
    expect(zero[0]).toBeCloseTo(103, 9);
    expect(zero[1]).toBeCloseTo(103, 9); // mult=0 -> upper===lower===middle
    expect(zero[2]).toBeCloseTo(103, 9);

    const stateNeg = {};
    for (const c of [100, 102]) bb3(stateNeg, c, 2, -1);
    const neg = bb3(stateNeg, 104, 2, -1);
    // window=[104,102], middle=103, stdev=1 -> mult=-1이면 upper=102(middle 아래), lower=104(middle 위)
    expect(neg[0]).toBeCloseTo(103, 9);
    expect(neg[1]).toBeCloseTo(102, 9);
    expect(neg[2]).toBeCloseTo(104, 9);
  });

  it("poisons the window for `length` bars after an embedded NaN, then recovers (recompute-on-pollution)", () => {
    const state = {};
    const closes = [101, 102, NaN, 102, 104, 105];
    const out = closes.map((c) => bb3(state, c, 3, 2));
    // 바0~1: 워밍업. 바2: NaN 입력 자체가 창을 오염 -> NaN. 바3: 창=[102,NaN,102] 여전히 NaN 포함
    // -> NaN. 바4: 창=[104,102,NaN] 여전히 NaN 포함 -> NaN. 바5: 창=[105,104,102] NaN 없음 -> 회복.
    for (let i = 0; i <= 4; i++) {
      expect(out[i]![0]).toBeNaN();
      expect(out[i]![1]).toBeNaN();
      expect(out[i]![2]).toBeNaN();
    }
    expect(Number.isNaN(out[5]![0])).toBe(false);
  });

  it("reuses the same scratch array across calls without allocating (values overwritten in place)", () => {
    const state = {};
    const scratch = new Float64Array(3);
    bb(state, 100, 2, 2, scratch);
    expect(scratch[0]).toBeNaN();
    bb(state, 102, 2, 2, scratch);
    expect(scratch[0]).toBeCloseTo(101, 9); // 같은 배열 인스턴스에 덮어써졌다
    bb(state, 104, 2, 2, scratch);
    expect(scratch[0]).toBeCloseTo(103, 9);
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py bb.py port) with NaN gaps (length=4, mult=1.5)", () => {
    const state = {};
    const length = 4;
    const mult = 1.5;
    const values = [
      100, 102, 99, NaN, 105, 108, 104, 110, 107, 113, NaN, NaN, 109, 115, 112, 118, 121, 116, 123, 119, 126, 130,
      NaN, 124, 128, 133, 129, 135, 131, 137,
    ];

    function bruteForce(sources: number[]): [number, number, number][] {
      // pine2py bb.py 그대로: 매 바 O(length) 재스캔, source.get(i) i=0(현재)..length-1(가장 오래된)
      const out: [number, number, number][] = [];
      for (let bar = 0; bar < sources.length; bar++) {
        if (bar + 1 < length) {
          out.push([NaN, NaN, NaN]);
          continue;
        }
        let total = 0;
        const win: number[] = [];
        let hasNaN = false;
        for (let i = 0; i < length; i++) {
          const v = sources[bar - i]!;
          if (Number.isNaN(v)) {
            hasNaN = true;
            break;
          }
          total += v;
          win.push(v);
        }
        if (hasNaN) {
          out.push([NaN, NaN, NaN]);
          continue;
        }
        const middle = total / length;
        const variance = win.reduce((acc, v) => acc + (v - middle) * (v - middle), 0) / length;
        const sd = Math.sqrt(variance);
        out.push([middle, middle + mult * sd, middle - mult * sd]);
      }
      return out;
    }

    const expected = bruteForce(values);
    for (let i = 0; i < values.length; i++) {
      const actual = bb3(state, values[i]!, length, mult);
      for (let k = 0; k < 3; k++) {
        if (Number.isNaN(expected[i]![k]!)) {
          expect(actual[k]).toBeNaN();
        } else {
          expect(actual[k]).toBeCloseTo(expected[i]![k]!, 9);
        }
      }
    }
  });
});

// ta.bbw(source, length, mult) — Bollinger Bands Width, built on ta.bb (C51). pine2py
// wavealgo/ta/bbw.py calls bb(source, length, mult) for (basis, upper, lower), then returns NaN
// if basis is NaN or exactly 0, else (upper-lower)/basis*100. Unlike ta.bb, bbw returns a single
// scalar, so it reuses BbState{inner:StdevState} + variance() but inlines the bb math into local
// variables instead of writing a scratch array (no returnArity — standard single-return pattern).
// Verified against a literal bbw.py+bb.py port via scratch/probe_bbw.mjs before implementation.
describe("ta.bbw", () => {
  it("returns NaN while the window is still warming up (length=3)", () => {
    const state = {};
    for (const c of [101, 102]) {
      expect(bbw(state, c, 3, 2)).toBeNaN();
    }
  });

  it("matches a hand-computed trace once the window fills (length=2, mult=2)", () => {
    // window=[102,100]: middle=101, variance=1, stdev=1 -> upper=103, lower=99.
    // bbw = (103-99)/101*100 = 400/101 = 3.9603960396...
    const state = {};
    bbw(state, 100, 2, 2);
    expect(bbw(state, 102, 2, 2)).toBeCloseTo(3.9603960396039604, 9);
  });

  it("matches the pine2py-verified sample10.json trace (close, length=3, mult=2)", () => {
    // oracle/golden/ta_bbw.json과 동일 값(바0~1 워밍업 NaN, 바2부터 유효).
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c) => bbw(state, c, 3, 2));
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(3.2019473763, 9);
    expect(out[9]).toBeCloseTo(4.6770717335, 9);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    for (const c of [101, 102, 103, 102, 104]) bbw(stateA, c, 3, 2);
    expect(bbw(stateB, 5, 3, 2)).toBeNaN(); // stateB's own warmup still fresh
  });

  it("returns 0.0 (not NaN) on a perfectly constant non-zero window", () => {
    // upper===lower===middle!==0 -> (upper-lower)/basis*100 = 0/5*100 = 0, not a spurious NaN.
    const state = {};
    let out = NaN;
    for (const c of [5, 5, 5, 5]) out = bbw(state, c, 3, 2);
    expect(out).toBe(0);
  });

  it("returns NaN when basis (the window mean) is exactly 0, regardless of NaN-ness", () => {
    // pine2py bbw.py: `if math.isnan(basis) or basis == 0: return NaN` — division-by-zero guard,
    // distinct from the "any NaN in the window" poison check.
    const state = {};
    bbw(state, -1, 3, 2);
    bbw(state, 0, 3, 2);
    expect(bbw(state, 1, 3, 2)).toBeNaN(); // window=[1,0,-1], sum=0 -> basis===0 exactly
  });

  it("poisons the window for `length` bars after an embedded NaN, then recovers (recompute-on-pollution)", () => {
    const state = {};
    const closes = [101, 102, NaN, 102, 104, 105];
    const out = closes.map((c) => bbw(state, c, 3, 2));
    // 바0~1: 워밍업. 바2: NaN 입력이 창을 오염. 바3~4: 창에 NaN이 여전히 남아 NaN. 바5: 창=[105,104,102]
    // NaN 없음 -> 회복(basis=103.6666...!=0 이라 NaN 아닌 실수 반환).
    for (let i = 0; i <= 4; i++) expect(out[i]).toBeNaN();
    expect(out[5]).toBeCloseTo(4.812421076236585, 9);
  });

  it("applies mult algebraically (mult<=0 collapses to 0, no absolute-value clamp)", () => {
    const stateZero = {};
    for (const c of [100, 102]) bbw(stateZero, c, 2, 0);
    expect(bbw(stateZero, 104, 2, 0)).toBeCloseTo(0, 9); // mult=0 -> upper===lower===basis

    const stateNeg = {};
    for (const c of [100, 102]) bbw(stateNeg, c, 2, -1);
    // window=[104,102], middle=103, stdev=1, mult=-1 -> upper=102, lower=104
    // bbw = (102-104)/103*100 = -1.941747...(부호도 그대로 산술로 전파, abs 없음)
    expect(bbw(stateNeg, 104, 2, -1)).toBeCloseTo((-2 / 103) * 100, 9);
  });

  it("matches a from-scratch brute-force cross-check (literal pine2py bbw.py+bb.py port) with NaN gaps (length=4, mult=1.5)", () => {
    const state = {};
    const length = 4;
    const mult = 1.5;
    const values = [
      100, 102, 99, NaN, 105, 108, 104, 110, 107, 113, NaN, NaN, 109, 115, 112, 118, 121, 116, 123, 119, 126, 130,
      NaN, 124, 128, 133, 129, 135, 131, 137,
    ];

    function bruteForce(sources: number[]): number[] {
      // pine2py bbw.py+bb.py 그대로: 매 바 O(length) 재스캔.
      const out: number[] = [];
      for (let bar = 0; bar < sources.length; bar++) {
        if (bar + 1 < length) {
          out.push(NaN);
          continue;
        }
        let total = 0;
        const win: number[] = [];
        let hasNaN = false;
        for (let i = 0; i < length; i++) {
          const v = sources[bar - i]!;
          if (Number.isNaN(v)) {
            hasNaN = true;
            break;
          }
          total += v;
          win.push(v);
        }
        if (hasNaN) {
          out.push(NaN);
          continue;
        }
        const basis = total / length;
        const variance = win.reduce((acc, v) => acc + (v - basis) * (v - basis), 0) / length;
        const sd = Math.sqrt(variance);
        const upper = basis + mult * sd;
        const lower = basis - mult * sd;
        out.push(basis === 0 ? NaN : ((upper - lower) / basis) * 100);
      }
      return out;
    }

    const expected = bruteForce(values);
    for (let i = 0; i < values.length; i++) {
      const actual = bbw(state, values[i]!, length, mult);
      if (Number.isNaN(expected[i]!)) {
        expect(actual).toBeNaN();
      } else {
        expect(actual).toBeCloseTo(expected[i]!, 9);
      }
    }
  });
});

// ta.kc(source, length, mult, useTrueRange) — Keltner Channels, the third multi-return TA (C54).
// Composes rt.ta.ema (basis) with rt.ta.atr (range, when useTrueRange) called unconditionally every
// bar (see runtime/ta.ts kc() comment for why gating atr's call on basis's NaN-ness, as pine2py's
// kc.py literally does, desyncs the two independent length-bar warmups — scratch/probe_kc.mjs).
describe("ta.kc", () => {
  function kc3(
    state: Parameters<typeof kc>[0],
    high: number,
    low: number,
    prevClose: number,
    value: number,
    length: number,
    mult: number,
    useTrueRange: boolean,
  ): [number, number, number] {
    const scratch = new Float64Array(3);
    kc(state, high, low, prevClose, value, length, mult, useTrueRange, scratch);
    return [scratch[0]!, scratch[1]!, scratch[2]!];
  }

  it("writes NaN to all three outputs while ema/atr are still warming up (useTrueRange=true, length=3)", () => {
    const state = {};
    const closes = [101, 102];
    for (const c of closes) {
      const [b, u, l] = kc3(state, c + 1, c - 2, NaN, c, 3, 2, true);
      expect(b).toBeNaN();
      expect(u).toBeNaN();
      expect(l).toBeNaN();
    }
  });

  it("matches the pine2py-verified sample10.json trace shifted one bar earlier than golden (useTrueRange=true, length=3, mult=2 — DIVERGENCES.md #9)", () => {
    // oracle/golden/ta_kc_kcw.json has basis_t/upper_t/lower_t NaN through bar2 (atr's off-by-one
    // leaks through kc.py's shared NaN gate, even though ema's own state is already seeded by
    // bar2) - pine2js's rt.ta.atr doesn't carry that off-by-one, so this is valid from bar2.
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c, i) => kc3(state, c + 1, c - 2, i === 0 ? NaN : closes[i - 1]!, c, 3, 2, true));
    expect(out[0]![0]).toBeNaN();
    expect(out[1]![0]).toBeNaN();
    expect(out[2]).toEqual([102, 108, 96]);
    expect(out[3]).toEqual([102, 108, 96]);
    expect(out[4]![0]).toBeCloseTo(103, 9);
    expect(out[4]![1]).toBeCloseTo(109, 9);
    expect(out[4]![2]).toBeCloseTo(97, 9);
    expect(out[9]![0]).toBeCloseTo(107, 9);
    expect(out[9]![1]).toBeCloseTo(113, 9);
    expect(out[9]![2]).toBeCloseTo(101, 9);
  });

  it("matches the pine2py golden byte-for-byte for the basis channel when useTrueRange=false (length=4, mult=1.5 — range never goes NaN, no atr contamination)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c, i) => kc3(state, c + 1, c - 2, i === 0 ? NaN : closes[i - 1]!, c, 4, 1.5, false));
    for (let i = 0; i < 3; i++) expect(out[i]![0]).toBeNaN();
    expect(out[3]![0]).toBeCloseTo(102, 9);
    expect(out[3]![1]).toBeCloseTo(106.5, 9);
    expect(out[3]![2]).toBeCloseTo(97.5, 9);
    expect(out[9]![0]).toBeCloseTo(106.595328, 9);
    expect(out[9]![1]).toBeCloseTo(111.095328, 9);
    expect(out[9]![2]).toBeCloseTo(102.095328, 9);
  });

  it("useTrueRange=false uses real TV semantics (range=high-low), not pine2py's source-source=0 bug", () => {
    // high/low set far from source(=value) - a source-source read would give range=0, but the
    // real high-low here is 8, so upper/lower must reflect that (DIVERGENCES.md #9).
    const state = {};
    kc3(state, 105, 97, NaN, 100, 2, 1, false); // bar0: high=105,low=97,value=100 -> range=8
    const [b, u, l] = kc3(state, 106, 98, 100, 101, 2, 1, false); // bar1: seed=avg(100,101)=100.5
    expect(b).toBeCloseTo(100.5, 9);
    expect(u).toBeCloseTo(100.5 + 8, 9); // range=106-98=8, not abs(101-101)=0
    expect(l).toBeCloseTo(100.5 - 8, 9);
  });

  it("propagates NaN through useTrueRange=false's range when high or low itself is NaN (plain subtraction, no explicit guard needed) - and, matching kc.py's shared gate, the whole triple (including basis) goes NaN that bar", () => {
    const state: Parameters<typeof kc>[0] = {};
    kc3(state, 105, 97, NaN, 100, 2, 1, false);
    const [b, u, l] = kc3(state, NaN, 98, 100, 101, 2, 1, false); // high NaN this bar -> range NaN
    // ema's own internal state still seeds correctly this bar (value=101 is valid) - but kc's
    // NaN(basis)||NaN(range) gate zeroes the whole triple, so the scratch output for basis is also
    // NaN even though a standalone ta.ema(101, 2) call would already report a value here.
    expect(b).toBeNaN();
    expect(u).toBeNaN();
    expect(l).toBeNaN();
    expect(state.ema!.prevEma).toBeCloseTo(100.5, 9); // underlying ema state is unaffected
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    const closes = [101, 102, 103, 102, 104];
    for (const c of closes) kc3(stateA, c + 1, c - 2, NaN, c, 3, 2, true);
    const [b, u, l] = kc3(stateB, 6, 3, NaN, 5, 3, 2, true); // stateB's own warmup still fresh
    expect(b).toBeNaN();
    expect(u).toBeNaN();
    expect(l).toBeNaN();
  });

  it("reuses the same scratch array across calls without allocating (values overwritten in place)", () => {
    const state = {};
    const scratch = new Float64Array(3);
    kc(state, 103, 100, NaN, 101, 2, 2, false, scratch);
    expect(scratch[0]).toBeNaN();
    kc(state, 104, 101, 101, 102, 2, 2, false, scratch);
    expect(scratch[0]).toBeCloseTo(101.5, 9); // 같은 배열 인스턴스에 덮어써졌다
  });

  it("matches a from-scratch brute-force cross-check (independent ema+atr composition) with NaN gaps, both useTrueRange values (length=5)", () => {
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    for (const useTrueRange of [true, false]) {
      const rng = mulberry32(useTrueRange ? 5001 : 5002);
      const n = 200;
      const closes: number[] = [];
      let price = 100;
      for (let i = 0; i < n; i++) {
        price += (rng() - 0.5) * 3;
        closes.push(rng() < 0.04 ? NaN : price);
      }
      const highs = closes.map((c) => (Number.isNaN(c) ? NaN : c + rng() * 2 + 0.1));
      const lows = closes.map((c) => (Number.isNaN(c) ? NaN : c - rng() * 2 - 0.1));

      // brute reference: independent ema/rma/tr recursion (not calling the module's own ta.ts
      // functions), mirroring runtime/ta.ts's exact transition logic bar-for-bar.
      const emaS = { count: 0, sum: 0, prev: NaN };
      const rmaS = { count: 0, sum: 0, prev: NaN };
      function bruteEma(value: number, length: number, s: typeof emaS): number {
        if (Number.isNaN(value)) return NaN;
        if (s.count < length) {
          s.count += 1;
          s.sum += value;
          s.prev = s.count === length ? s.sum / length : NaN;
          return s.prev;
        }
        const alpha = 2 / (length + 1);
        s.prev = alpha * value + (1 - alpha) * s.prev;
        return s.prev;
      }
      function bruteRma(value: number, length: number, s: typeof rmaS): number {
        if (Number.isNaN(value)) return NaN;
        if (s.count < length) {
          s.count += 1;
          s.sum += value;
          s.prev = s.count === length ? s.sum / length : NaN;
          return s.prev;
        }
        const alpha = 1 / length;
        s.prev = alpha * value + (1 - alpha) * s.prev;
        return s.prev;
      }
      const length = 5;
      const mult = 1.3;
      const expected: [number, number, number][] = [];
      for (let i = 0; i < n; i++) {
        const high = highs[i]!;
        const low = lows[i]!;
        const prevClose = i === 0 ? NaN : closes[i - 1]!;
        const basis = bruteEma(closes[i]!, length, emaS);
        const hl = high - low;
        const trVal = Number.isNaN(prevClose) ? hl : Math.max(hl, Math.abs(high - prevClose), Math.abs(low - prevClose));
        const atrVal = bruteRma(trVal, length, rmaS);
        const range = useTrueRange ? atrVal : hl;
        if (Number.isNaN(basis) || Number.isNaN(range)) {
          expected.push([NaN, NaN, NaN]);
        } else {
          expected.push([basis, basis + mult * range, basis - mult * range]);
        }
      }

      const state = {};
      for (let i = 0; i < n; i++) {
        const prevClose = i === 0 ? NaN : closes[i - 1]!;
        const actual = kc3(state, highs[i]!, lows[i]!, prevClose, closes[i]!, length, mult, useTrueRange);
        for (let k = 0; k < 3; k++) {
          if (Number.isNaN(expected[i]![k]!)) {
            expect(actual[k]).toBeNaN();
          } else {
            expect(actual[k]).toBeCloseTo(expected[i]![k]!, 9);
          }
        }
      }
    }
  });
});

// ta.kcw(source, length, mult, useTrueRange) — Keltner Channels Width, built on ta.kc's composition
// (same "call for its side effect, inline the arithmetic" pattern as ta.bbw over ta.bb, C52).
describe("ta.kcw", () => {
  function kcwCall(
    state: Parameters<typeof kcw>[0],
    high: number,
    low: number,
    prevClose: number,
    value: number,
    length: number,
    mult: number,
    useTrueRange: boolean,
  ): number {
    return kcw(state, high, low, prevClose, value, length, mult, useTrueRange);
  }

  it("returns NaN while warming up", () => {
    const state = {};
    expect(kcwCall(state, 102, 99, NaN, 101, 3, 2, true)).toBeNaN();
  });

  it("matches the pine2py-verified sample10.json trace for useTrueRange=true (length=3, mult=2)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c, i) => kcwCall(state, c + 1, c - 2, i === 0 ? NaN : closes[i - 1]!, c, 3, 2, true));
    expect(out[0]).toBeNaN();
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeCloseTo(11.76470588235294, 9);
    expect(out[4]).toBeCloseTo(11.650485436893204, 9);
    expect(out[9]).toBeCloseTo(11.214953271028037, 9);
  });

  it("matches the pine2py-verified sample10.json trace for useTrueRange=false (length=4, mult=1.5)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c, i) => kcwCall(state, c + 1, c - 2, i === 0 ? NaN : closes[i - 1]!, c, 4, 1.5, false));
    for (let i = 0; i < 3; i++) expect(out[i]).toBeNaN();
    expect(out[3]).toBeCloseTo(8.823529411764707, 9);
    expect(out[9]).toBeCloseTo(8.443146776564166, 9);
  });

  it("returns NaN when basis is exactly 0 (division guard, mirrors ta.bbw's basis===0 guard)", () => {
    const state = {};
    kcwCall(state, 3, -3, NaN, 0, 2, 1, false); // bar0: value=0
    const result = kcwCall(state, 3, -3, 0, 0, 2, 1, false); // bar1: still value=0 -> basis=0
    expect(result).toBeNaN();
  });

  it("keeps independent state across two call sites (and from ta.kc's own state)", () => {
    const stateKc = {};
    const stateKcw = {};
    const closes = [101, 102, 103];
    const scratch = new Float64Array(3);
    for (const c of closes) kc(stateKc, c + 1, c - 2, NaN, c, 3, 2, true, scratch);
    const result = kcwCall(stateKcw, 105, 100, NaN, 103, 3, 2, true); // stateKcw fresh, still warming up
    expect(result).toBeNaN();
  });
});

// ta.obv() — On Balance Volume. NaN close/volume leaves state fully untouched (unlike every prior
// pattern, which at least advances a warmup counter or NaN-primes a buffer) — the first *valid* bar
// always seeds prevObv=0.0, regardless of how many NaN bars preceded it. scratch/probe_obv.mjs
// cross-checked this against a literal port of pine2py's obv.py.
describe("ta.obv", () => {
  it("seeds the first valid bar to 0.0, not NaN (no warmup period)", () => {
    const state = {};
    expect(obv(state, 101, 1000)).toBe(0);
  });

  it("returns NaN on NaN close or volume without touching state", () => {
    const state = {};
    expect(obv(state, NaN, 1000)).toBeNaN();
    expect(obv(state, 101, NaN)).toBeNaN();
    // state still uninitialized -> next valid bar still seeds to 0.0, not treated as a "second" bar
    expect(obv(state, 102, 1000)).toBe(0);
  });

  it("adds volume on a rise, subtracts on a fall, holds on a tie", () => {
    const state = {};
    obv(state, 100, 1000); // seed: obv=0, prevClose=100
    expect(obv(state, 101, 500)).toBe(500); // rise -> +500
    expect(obv(state, 101, 300)).toBe(500); // tie -> unchanged
    expect(obv(state, 99, 700)).toBe(-200); // fall -> -700
  });

  it("compares against the pre-gap prevClose after a mid-stream NaN gap (state untouched during gap)", () => {
    const state = {};
    obv(state, 101, 1000); // seed: obv=0, prevClose=101
    obv(state, 102, 1100); // rise -> obv=1100, prevClose=102
    expect(obv(state, NaN, NaN)).toBeNaN(); // gap: state stays at prevClose=102
    // next valid bar compares to the pre-gap prevClose(102), not to the NaN bar
    expect(obv(state, 108, 1150)).toBe(2250); // 108 > 102 -> 1100 + 1150
  });

  it("matches the pine2py-verified sample10.json trace", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = closes.map((c, i) => obv(state, c, volumes[i]!));
    expect(out).toEqual([0, 1100, 2300, 1150, 2450, 3700, 5100, 3750, 5250, 6700]);
  });
});

// ta.accdist() — Accumulation/Distribution. Same cumulative-sum shape as ta.cum(C37), but the NaN
// handling is the opposite: cum replaces NaN input with 0 and keeps accumulating; accdist returns
// NaN outright on any NaN input and leaves the running total untouched (ema/rma-style "NaN doesn't
// mutate state"). scratch/probe_obv.mjs cross-checked this against a literal port of accdist.py.
describe("ta.accdist", () => {
  it("returns 0 for the first bar when high===low (hl_range===0 guard, mfv=0.0)", () => {
    const state = {};
    expect(accdist(state, 100, 100, 100, 1000)).toBe(0);
  });

  it("accumulates money flow volume across bars", () => {
    const state = {};
    // c=101,h=102,l=99,v=1000 -> mfv=((101-99)-(102-101))/3*1000 = (2-1)/3*1000 = 333.333...
    expect(accdist(state, 101, 102, 99, 1000)).toBeCloseTo(333.3333333333, 9);
    // c=102,h=103,l=100,v=1100 -> mfv=((102-100)-(103-102))/3*1100 = (2-1)/3*1100 = 366.666...
    expect(accdist(state, 102, 103, 100, 1100)).toBeCloseTo(700, 9);
  });

  it("returns NaN on any NaN input and leaves the cumulative sum untouched (not replaced with 0)", () => {
    const state = {};
    accdist(state, 101, 102, 99, 1000); // cum ~= 333.333
    expect(accdist(state, NaN, 103, 100, 1100)).toBeNaN();
    expect(accdist(state, 102, NaN, 100, 1100)).toBeNaN();
    expect(accdist(state, 102, 103, 100, NaN)).toBeNaN();
    // next valid bar continues from the pre-gap cum, not from 0 and not from a NaN-poisoned value
    expect(accdist(state, 102, 103, 100, 1100)).toBeCloseTo(700, 9);
  });

  it("matches the pine2py-verified sample10.json trace", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const highs = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const lows = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = closes.map((c, i) => accdist(state, c, highs[i]!, lows[i]!, volumes[i]!));
    const expected = [333.3333333333, 700, 1100, 1483.3333333333, 1916.6666666667, 2333.3333333333, 2800, 3250, 3750, 4233.3333333333];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });
});

// ta.ao() — Awesome Oscillator: SMA(hl2,5) - SMA(hl2,34). pine2py에 대응 구현이 전혀 없는
// hand-verified 신규 함수(배치25 (3), DIVERGENCES.md #175) — 오라클로 이미 검증된 sma()를 직접
// 두 번 호출해 독립적으로 재계산한 값과 대조한다(hma가 wma를 세 겹 재사용하는 것과 동일 원칙).
describe("ta.ao", () => {
  it("returns NaN until the slower 34-length SMA warms up (fast(5) warms first but slow(34) gates the subtraction)", () => {
    const state = {};
    const values = Array.from({ length: 33 }, (_, i) => 100 + i);
    for (const v of values) expect(ao(state, v)).toBeNaN();
  });

  it("matches an independent direct sma(fast=5)-sma(slow=34) recomputation over a non-linear trace (regression guard)", () => {
    const aoState = {};
    const fastState = {};
    const slowState = {};
    const values = Array.from({ length: 40 }, (_, i) => 100 + 10 * Math.sin(i * 0.5));
    for (const v of values) {
      const expected = sma(fastState, v, 5) - sma(slowState, v, 34);
      const actual = ao(aoState, v);
      if (Number.isNaN(expected)) expect(actual).toBeNaN();
      else expect(actual).toBeCloseTo(expected, 9);
    }
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    const values = Array.from({ length: 34 }, (_, i) => 100 + (i % 7) * 2 - (i % 5));
    let resultA = NaN;
    for (const v of values) resultA = ao(stateA, v);
    expect(resultA).not.toBeNaN();
    // stateB has only seen 1 bar and must be unaffected by stateA's fully-warmed state.
    expect(ao(stateB, 999)).toBeNaN();
  });
});

// ta.max(source)/ta.min(source) — cumulative (whole-history) extreme, cum()의 형제 함수
// (배치25 (3), DIVERGENCES.md #176). pine2py에 대응 구현이 전혀 없는 hand-verified 신규 함수.
// NaN 처리는 cum과 달리 항등원이 없어(덧셈의 0에 대응하는 값이 max/min엔 없음) 첫 유효값 이전엔
// NaN을 유지한다 — cumMax/cumMin은 완전히 대칭이라 같은 describe에서 나란히 검증한다.
describe("ta.max/ta.min (cumMax/cumMin)", () => {
  it("returns NaN before the first valid (non-NaN) value is seen", () => {
    const maxState = {};
    const minState = {};
    expect(cumMax(maxState, NaN)).toBeNaN();
    expect(cumMax(maxState, NaN)).toBeNaN();
    expect(cumMin(minState, NaN)).toBeNaN();
    expect(cumMin(minState, NaN)).toBeNaN();
  });

  it("seeds the running extreme to the first valid value", () => {
    const maxState = {};
    const minState = {};
    expect(cumMax(maxState, 5)).toBe(5);
    expect(cumMin(minState, 5)).toBe(5);
  });

  it("tracks the running maximum/minimum across the whole history", () => {
    const maxState = {};
    const minState = {};
    const values = [3, 7, 2, 9, 1, 9, -5, 12];
    const maxResults = values.map((v) => cumMax(maxState, v));
    const minResults = values.map((v) => cumMin(minState, v));
    expect(maxResults).toEqual([3, 7, 7, 9, 9, 9, 9, 12]);
    expect(minResults).toEqual([3, 3, 2, 2, 1, 1, -5, -5]);
  });

  it("ignores NaN inputs mid-stream and keeps the previous extreme unchanged", () => {
    const maxState = {};
    const minState = {};
    cumMax(maxState, 5);
    cumMin(minState, 5);
    expect(cumMax(maxState, NaN)).toBe(5);
    expect(cumMin(minState, NaN)).toBe(5);
    // a NaN gap doesn't reset the running extreme — the next valid value still compares against it.
    expect(cumMax(maxState, 3)).toBe(5);
    expect(cumMin(minState, 8)).toBe(5);
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    cumMax(stateA, 100);
    cumMax(stateA, 200);
    expect(cumMax(stateA, 150)).toBe(200);
    // stateB has seen nothing yet and must be unaffected by stateA.
    expect(cumMax(stateB, 5)).toBe(5);
  });
});

// ta.pvt() — Price Volume Trend. Same sixth NaN pattern as obv(C55): NaN input leaves state
// completely untouched and returns NaN outright; the first valid bar always seeds to 0.0 regardless
// of how many NaN bars preceded it. Unlike obv, pvt has a divide-by-zero guard (prevClose===0 ->
// change_pct=0.0) that obv's tie-branch doesn't need. scratch/probe_pvt_wad.mjs cross-checked this
// against a literal port of pvt.py.
describe("ta.pvt", () => {
  it("seeds the first valid bar to 0.0, not NaN (no warmup period)", () => {
    const state = {};
    expect(pvt(state, 101, 1000)).toBe(0);
  });

  it("returns NaN on NaN close or volume without touching state", () => {
    const state = {};
    expect(pvt(state, NaN, 1000)).toBeNaN();
    expect(pvt(state, 101, NaN)).toBeNaN();
    // state still uninitialized -> next valid bar still seeds to 0.0, not treated as a "second" bar
    expect(pvt(state, 102, 1000)).toBe(0);
  });

  it("accumulates change_pct * volume across bars", () => {
    const state = {};
    pvt(state, 100, 1000); // seed: cum=0, prevClose=100
    // c=102,v=1100 -> change_pct=(102-100)/100=0.02 -> cum += 0.02*1100 = 22
    expect(pvt(state, 102, 1100)).toBeCloseTo(22, 9);
  });

  it("uses change_pct=0.0 when prevClose is exactly 0 (divide guard, no obv equivalent)", () => {
    const state = {};
    pvt(state, 0, 1000); // seed: cum=0, prevClose=0
    // prevClose===0 -> change_pct forced to 0.0 regardless of the new close, cum stays 0
    expect(pvt(state, 50, 1100)).toBe(0);
    // next bar compares against the now-nonzero prevClose=50 normally
    expect(pvt(state, 75, 1200)).toBeCloseTo(0 + ((75 - 50) / 50) * 1200, 9);
  });

  it("compares against the pre-gap prevClose after a mid-stream NaN gap (state untouched during gap)", () => {
    const state = {};
    pvt(state, 100, 1000); // seed: cum=0, prevClose=100
    pvt(state, 102, 1100); // cum=22, prevClose=102
    expect(pvt(state, NaN, NaN)).toBeNaN(); // gap: state stays at prevClose=102, cum=22
    // next valid bar compares to the pre-gap prevClose(102), not to the NaN bar
    expect(pvt(state, 108, 1150)).toBeCloseTo(22 + ((108 - 102) / 102) * 1150, 9);
  });

  it("matches the pine2py-verified sample10.json trace", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = closes.map((c, i) => pvt(state, c, volumes[i]!));
    const expected = [0, 10.891089108910892, 22.655794991263832, 11.490746447574512, 36.98094252600588, 49.00017329523665, 62.333506628569985, 49.59765757196621, 78.16908614339478, 91.72048801255366];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });
});

// ta.wad() — Williams Accumulation/Distribution. Same "seed first valid bar to 0.0, NaN leaves
// state untouched" shape as obv/pvt, but the accumulated quantity is a derived gain computed from
// that bar's true range rather than a fixed +/-volume — see runtime/ta.ts wad() comment.
// scratch/probe_pvt_wad.mjs cross-checked this against a literal port of wad.py.
describe("ta.wad", () => {
  it("seeds the first valid bar to 0.0, not NaN (no warmup period)", () => {
    const state = {};
    expect(wad(state, 102, 99, 101)).toBe(0);
  });

  it("returns NaN on any NaN input without touching state", () => {
    const state = {};
    expect(wad(state, NaN, 99, 101)).toBeNaN();
    expect(wad(state, 102, NaN, 101)).toBeNaN();
    expect(wad(state, 102, 99, NaN)).toBeNaN();
    // state still uninitialized -> next valid bar still seeds to 0.0
    expect(wad(state, 103, 100, 102)).toBe(0);
  });

  it("accumulates gain=close-trueLow on a rise, gain=close-trueHigh on a fall, gain=0 on a tie", () => {
    const state = {};
    wad(state, 102, 99, 100); // seed: prevClose=100, cumWad=0
    // rise: c=101>prevClose=100 -> trueLow=min(99,100)=99 -> gain=101-99=2
    expect(wad(state, 103, 99, 101)).toBe(2);
    // tie: c=101===prevClose=101 -> gain=0
    expect(wad(state, 103, 100, 101)).toBe(2);
    // fall: c=99<prevClose=101 -> trueHigh=max(103,101)=103 -> gain=99-103=-4
    expect(wad(state, 103, 97, 99)).toBe(-2);
  });

  it("compares against the pre-gap prevClose after a mid-stream NaN gap (state untouched during gap)", () => {
    const state = {};
    wad(state, 102, 99, 100); // seed: prevClose=100, cumWad=0
    wad(state, 103, 99, 101); // rise -> cumWad=2, prevClose=101
    expect(wad(state, NaN, 99, 101)).toBeNaN(); // gap: state stays at prevClose=101, cumWad=2
    // next valid bar compares to the pre-gap prevClose(101), not to the NaN bar
    // rise: c=108>101 -> trueLow=min(105,101)=101 -> gain=108-101=7 -> cumWad=2+7=9
    expect(wad(state, 109, 105, 108)).toBe(9);
  });

  it("matches the pine2py-verified sample10.json trace", () => {
    const state = {};
    const highs = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const lows = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const out = closes.map((c, i) => wad(state, highs[i]!, lows[i]!, c));
    expect(out).toEqual([0, 2, 4, 3, 5, 7, 9, 8, 10, 12]);
  });
});

// ta.nvi() — Negative Volume Index. Same sixth NaN pattern as obv/pvt/wad(C55/56): NaN input leaves
// state completely untouched and returns NaN outright. Unlike obv/pvt/wad, the seed is 1.0 (not 0.0),
// and the prevClose===0 divide guard sits at the TOP of the elif chain — it overrides the volume
// comparison unconditionally, unlike pvt's "guard replaces change_pct with 0.0 but keeps updating".
// scratch/probe_nvi_pvi.mjs cross-checked this against a literal port of nvi.py.
describe("ta.nvi", () => {
  it("seeds the first valid bar to 1.0, not NaN (no warmup period)", () => {
    const state = {};
    expect(nvi(state, 101, 1000)).toBe(1);
  });

  it("returns NaN on NaN close or volume without touching state", () => {
    const state = {};
    expect(nvi(state, NaN, 1000)).toBeNaN();
    expect(nvi(state, 101, NaN)).toBeNaN();
    // state still uninitialized -> next valid bar still seeds to 1.0, not treated as a "second" bar
    expect(nvi(state, 102, 1000)).toBe(1);
  });

  it("updates only when volume is strictly less than the previous bar's volume (tie holds)", () => {
    const state = {};
    nvi(state, 100, 1000); // seed: prevNvi=1, prevClose=100, prevVolume=1000
    // volume 900 < prevVolume 1000 -> compound: 1 + ((105-100)/100)*1 = 1.05
    expect(nvi(state, 105, 900)).toBeCloseTo(1.05, 9);
    // volume 950 > prevVolume 900 -> hold
    expect(nvi(state, 110, 950)).toBe(1.05);
    // volume 950 === prevVolume 950 (tie, strict < only) -> hold
    expect(nvi(state, 120, 950)).toBe(1.05);
  });

  it("prevClose===0 guard overrides the volume<prevVolume update condition (elif chain top)", () => {
    const state = {};
    nvi(state, 0, 1000); // seed: prevNvi=1, prevClose=0, prevVolume=1000
    // volume 900 < prevVolume 1000 would normally update, but prevClose===0 forces hold
    expect(nvi(state, 50, 900)).toBe(1);
    // next bar compares against the now-nonzero prevClose=50 normally: 900<1000 doesn't apply here,
    // prevVolume is now 900; volume 850 < 900 -> compound: 1 + ((75-50)/50)*1 = 1.5
    expect(nvi(state, 75, 850)).toBeCloseTo(1.5, 9);
  });

  it("compares against the pre-gap prevClose/prevVolume after a mid-stream NaN gap", () => {
    const state = {};
    nvi(state, 100, 1000); // seed
    nvi(state, 90, 900); // volume 900<1000 -> compound: 1 + ((90-100)/100)*1 = 0.9
    expect(nvi(state, NaN, NaN)).toBeNaN(); // gap: state stays at prevClose=90, prevVolume=900, prevNvi=0.9
    // next valid bar compares to the pre-gap prevVolume(900): volume 800<900 -> compound
    expect(nvi(state, 80, 800)).toBeCloseTo(0.9 + ((80 - 90) / 90) * 0.9, 9);
  });

  it("matches the pine2py oracle golden sample10.json trace", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = closes.map((c, i) => nvi(state, c, volumes[i]!));
    const expected = [1, 1, 1, 0.9902912621359223, 0.9902912621359223, 0.9998132935026139, 0.9998132935026139, 0.9903810926205138, 0.9903810926205138, 0.9996369906823878];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });
});

// ta.pvi() — Positive Volume Index. Fully symmetric with nvi (volume must be strictly GREATER than
// the previous bar's volume to compound) — see nvi's comment above and runtime/ta.ts pvi() comment.
describe("ta.pvi", () => {
  it("seeds the first valid bar to 1.0, not NaN (no warmup period)", () => {
    const state = {};
    expect(pvi(state, 101, 1000)).toBe(1);
  });

  it("returns NaN on NaN close or volume without touching state", () => {
    const state = {};
    expect(pvi(state, NaN, 1000)).toBeNaN();
    expect(pvi(state, 101, NaN)).toBeNaN();
    expect(pvi(state, 102, 1000)).toBe(1);
  });

  it("updates only when volume is strictly greater than the previous bar's volume (tie holds)", () => {
    const state = {};
    pvi(state, 100, 1000); // seed: prevPvi=1, prevClose=100, prevVolume=1000
    // volume 1100 > prevVolume 1000 -> compound: 1 + ((105-100)/100)*1 = 1.05
    expect(pvi(state, 105, 1100)).toBeCloseTo(1.05, 9);
    // volume 1050 < prevVolume 1100 -> hold
    expect(pvi(state, 110, 1050)).toBe(1.05);
    // volume 1050 === prevVolume 1050 (tie, strict > only) -> hold
    expect(pvi(state, 120, 1050)).toBe(1.05);
  });

  it("prevClose===0 guard overrides the volume>prevVolume update condition (elif chain top)", () => {
    const state = {};
    pvi(state, 0, 1000); // seed: prevPvi=1, prevClose=0, prevVolume=1000
    // volume 1100 > prevVolume 1000 would normally update, but prevClose===0 forces hold
    expect(pvi(state, 50, 1100)).toBe(1);
    // next bar compares against the now-nonzero prevClose=50 normally; volume 1200 > 1100 -> compound
    expect(pvi(state, 75, 1200)).toBeCloseTo(1.5, 9);
  });

  it("compares against the pre-gap prevClose/prevVolume after a mid-stream NaN gap", () => {
    const state = {};
    pvi(state, 100, 1000); // seed
    pvi(state, 110, 1100); // volume 1100>1000 -> compound: 1 + ((110-100)/100)*1 = 1.1
    expect(pvi(state, NaN, NaN)).toBeNaN(); // gap: state stays at prevClose=110, prevVolume=1100, prevPvi=1.1
    // next valid bar compares to the pre-gap prevVolume(1100): volume 1200>1100 -> compound
    expect(pvi(state, 120, 1200)).toBeCloseTo(1.1 + ((120 - 110) / 110) * 1.1, 9);
  });

  it("matches the pine2py oracle golden sample10.json trace", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = closes.map((c, i) => pvi(state, c, volumes[i]!));
    const expected = [1, 1.00990099009901, 1.0198019801980198, 1.0198019801980198, 1.0397980974568046, 1.0397980974568046, 1.0497009364802028, 1.0497009364802028, 1.0696952400322066, 1.0696952400322066];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });
});

// ta.wvad() - Williams Variable A/D = ((close-open)/(high-low))*volume, 0.0 if high===low (not NaN).
// Unlike obv/pvt/wad/nvi/pvi (TA_IMPLICIT_CALL bare group), this is confirmed **fully stateless**
// (pine2py wavealgo/ta/wvad.py never calls context.get_ta_state) - same category as tr(C53): the
// state arg exists only for TA_REGISTRY dispatch uniformity and is never read/written.
// scratch/probe_wvad_iii.mjs cross-checked this against a literal port of wvad.py.
describe("ta.wvad", () => {
  it("is stateless - the first argument is never read or written regardless of what's passed", () => {
    const untouched = { poison: "should never be read or mutated" };
    expect(wvad(untouched, 100, 102, 99, 101, 1000)).toBeCloseTo(333.3333333333, 9);
    expect(untouched).toEqual({ poison: "should never be read or mutated" });
    expect(wvad(undefined, 100, 102, 99, 101, 1000)).toBeCloseTo(333.3333333333, 9);
  });

  it("matches a hand-computed value: ((close-open)/(high-low))*volume", () => {
    // ((101-100)/(102-99))*1000 = (1/3)*1000
    expect(wvad({}, 100, 102, 99, 101, 1000)).toBeCloseTo(333.3333333333, 9);
  });

  it("returns 0.0 (not NaN) when high===low, regardless of open/close/volume", () => {
    expect(wvad({}, 100, 100, 100, 105, 1000)).toBe(0);
    expect(Number.isNaN(wvad({}, 100, 100, 100, 105, 1000))).toBe(false);
  });

  it("propagates NaN when any of open/high/low/close/volume is NaN", () => {
    expect(wvad({}, NaN, 102, 99, 101, 1000)).toBeNaN();
    expect(wvad({}, 100, NaN, 99, 101, 1000)).toBeNaN();
    expect(wvad({}, 100, 102, NaN, 101, 1000)).toBeNaN();
    expect(wvad({}, 100, 102, 99, NaN, 1000)).toBeNaN();
    expect(wvad({}, 100, 102, 99, 101, NaN)).toBeNaN();
  });

  it("matches the pine2py oracle golden sample10.json trace", () => {
    const open = [100, 101, 102, 101, 103, 104, 105, 104, 106, 107];
    const high = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const low = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volume = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = close.map((c, i) => wvad({}, open[i]!, high[i]!, low[i]!, c, volume[i]!));
    const expected = [333.3333333333, 366.6666666667, 400, 383.3333333333, 433.3333333333, 416.6666666667, 466.6666666667, 450, 500, 483.3333333333];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 6));
  });
});

// ta.iii() - Intraday Intensity Index = (2*close-high-low)/((high-low)*volume), 0.0 if the
// denominator ((high-low)*volume) is 0 (either high===low or volume===0). Also fully stateless
// like wvad (pine2py wavealgo/ta/iii.py never calls context.get_ta_state) - same tr(C53) category.
// scratch/probe_wvad_iii.mjs cross-checked this against a literal port of iii.py.
describe("ta.iii", () => {
  it("is stateless - the first argument is never read or written regardless of what's passed", () => {
    const untouched = { poison: "should never be read or mutated" };
    expect(iii(untouched, 102, 99, 101, 1000)).toBeCloseTo(0.0003333333, 9);
    expect(untouched).toEqual({ poison: "should never be read or mutated" });
    expect(iii(undefined, 102, 99, 101, 1000)).toBeCloseTo(0.0003333333, 9);
  });

  it("matches a hand-computed value: (2*close-high-low)/((high-low)*volume)", () => {
    // (2*101-102-99)/((102-99)*1000) = 1/3000
    expect(iii({}, 102, 99, 101, 1000)).toBeCloseTo(1 / 3000, 9);
  });

  it("returns 0.0 (not NaN) when high===low, regardless of close/volume", () => {
    expect(iii({}, 100, 100, 105, 1000)).toBe(0);
    expect(Number.isNaN(iii({}, 100, 100, 105, 1000))).toBe(false);
  });

  it("returns 0.0 (not NaN) when volume===0 even though high!==low (denominator via volume, not range)", () => {
    expect(iii({}, 102, 99, 101, 0)).toBe(0);
    expect(Number.isNaN(iii({}, 102, 99, 101, 0))).toBe(false);
  });

  it("propagates NaN when any of high/low/close/volume is NaN", () => {
    expect(iii({}, NaN, 99, 101, 1000)).toBeNaN();
    expect(iii({}, 102, NaN, 101, 1000)).toBeNaN();
    expect(iii({}, 102, 99, NaN, 1000)).toBeNaN();
    expect(iii({}, 102, 99, 101, NaN)).toBeNaN();
  });

  it("matches the pine2py oracle golden sample10.json trace", () => {
    const high = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const low = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volume = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = close.map((c, i) => iii({}, high[i]!, low[i]!, c, volume[i]!));
    const expected = [0.0003333333, 0.0003030303, 0.0002777778, 0.0002898551, 0.0002564103, 0.0002666667, 0.0002380952, 0.0002469136, 0.0002222222, 0.0002298851];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });
});

// ta.vwap(source) - Volume Weighted Average Price = Σ(price*vol)/Σ(vol) accumulated from bar 0
// with NO session/anchor reset (pine2py vwap.py identical semantics - 'no session reset in
// backtest mode'; LIMITATIONS.md). NaN handling is the sixth (obv-style) pattern: NaN price or
// volume leaves state completely untouched and returns NaN outright. Unlike obv, the cumVol===0
// guard fires AFTER the accumulation is already applied (vwap.py's cum_vol==0 check comes after
// the state writes). scratch/probe_vwap.mjs cross-checked this against a literal rescan port.
describe("ta.vwap", () => {
  it("is valid from bar 0 with no warmup period (vwap of one bar === that bar's price)", () => {
    const state = {};
    expect(vwap(state, 101, 1000)).toBe(101);
  });

  it("accumulates price*volume / volume across bars (hand-computed)", () => {
    const state = {};
    vwap(state, 101, 1000);
    // (101*1000 + 102*1100) / (1000+1100) = 213200/2100
    expect(vwap(state, 102, 1100)).toBeCloseTo(213200 / 2100, 12);
  });

  it("returns NaN on NaN price or volume without touching state", () => {
    const state: { cumPv?: number; cumVol?: number } = {};
    vwap(state, 100, 10); // cumPv=1000, cumVol=10
    expect(vwap(state, NaN, 20)).toBeNaN();
    expect(vwap(state, 200, NaN)).toBeNaN();
    expect(state.cumPv).toBe(1000);
    expect(state.cumVol).toBe(10);
    // next valid bar continues from the pre-gap accumulation: (1000+2000)/(10+10)=150
    expect(vwap(state, 200, 10)).toBe(150);
  });

  it("returns NaN while the cumulative volume is 0, but still advances state (guard fires after accumulation)", () => {
    const state: { cumPv?: number; cumVol?: number } = {};
    expect(vwap(state, 101, 0)).toBeNaN();
    expect(vwap(state, 102, 0)).toBeNaN();
    // state advanced during the zero-vol prefix (cumPv += price*0 = 0 contributions)
    expect(state.cumVol).toBe(0);
    // first vol>0 bar: vwap === exactly that bar's price (zero-vol bars contributed 0 to cumPv)
    expect(vwap(state, 104, 1000)).toBe(104);
  });

  it("returns NaN for every bar when volume is 0 throughout", () => {
    const state = {};
    expect(vwap(state, 101, 0)).toBeNaN();
    expect(vwap(state, 102, 0)).toBeNaN();
    expect(vwap(state, 103, 0)).toBeNaN();
  });

  it("keeps independent state per call site (separate state objects don't interfere)", () => {
    const a = {};
    const b = {};
    vwap(a, 100, 10);
    expect(vwap(b, 200, 10)).toBe(200); // b unaffected by a's accumulation
    expect(vwap(a, 100, 10)).toBe(100); // a unaffected by b's
  });

  it("never resets: bar 0 still contributes to the accumulation arbitrarily far into the series", () => {
    const state: { cumPv?: number; cumVol?: number } = {};
    const volumes = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    volumes.forEach((v, i) => vwap(state, 100 + i, v));
    // cumVol is the full-series volume sum - no session window ever dropped old bars
    expect(state.cumVol).toBe(volumes.reduce((s, v) => s + v, 0));
  });

  it("matches the pine2py oracle golden sample10.json trace", () => {
    const state = {};
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const volume = [1000, 1100, 1200, 1150, 1300, 1250, 1400, 1350, 1500, 1450];
    const out = close.map((c, i) => vwap(state, c, volume[i]!));
    const expected = [101.0, 101.5238095238, 102.0606060606, 102.0449438202, 102.4869565217, 102.9357142857, 103.4464285714, 103.6615384615, 104.1066666667, 104.5511811024];
    out.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });

  it("matches a literal rescan port of vwap.py on a fuzzed series (NaN + zero-vol mixed)", () => {
    // literal port: rescan all valid bars j<=i in order (same addition order as the streaming state)
    const brute = (prices: number[], vols: number[], i: number): number => {
      if (Number.isNaN(prices[i]!) || Number.isNaN(vols[i]!)) return NaN;
      let cumPv = 0;
      let cumVol = 0;
      for (let j = 0; j <= i; j++) {
        if (Number.isNaN(prices[j]!) || Number.isNaN(vols[j]!)) continue;
        cumPv += prices[j]! * vols[j]!;
        cumVol += vols[j]!;
      }
      return cumVol === 0 ? NaN : cumPv / cumVol;
    };
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const prices: number[] = [];
    const vols: number[] = [];
    for (let i = 0; i < 500; i++) {
      prices.push(rnd() < 0.05 ? NaN : 50 + rnd() * 100);
      const r = rnd();
      vols.push(r < 0.05 ? NaN : r < 0.12 ? 0 : Math.floor(rnd() * 2000));
    }
    const state = {};
    for (let i = 0; i < prices.length; i++) {
      const c = vwap(state, prices[i]!, vols[i]!);
      const b = brute(prices, vols, i);
      if (Number.isNaN(b)) {
        expect(c).toBeNaN();
      } else {
        expect(c).toBe(b); // identical addition order -> bit-identical
      }
    }
  });
});

// C362: ta.vwap 다중 인자 오버로드 — 2-인자(anchor 리셋) 스칼라 / 3-인자 [vwap, upper, lower] 밴드.
// pine2py에 anchor 개념이 없어 오라클 구조적 불가 — TV 공식 VWAP 지표 공개 소스 패턴
// (isNewPeriod 리셋 + Var = Σ(vol·src²)/Σvol − vwap², 음수 클램프)의 hand-verified 이식.
// TV 미검증(가설) — DIVERGENCES 참조. runtime/ta.ts vwap() 주석의 시맨틱 결정 사항:
// (1) anchor===true인 바에서 리셋 후 그 바가 새 누적의 첫 원소, (2) na(NaN) anchor는 false 취급,
// (3) NaN 데이터 바에서도 anchor 리셋 자체는 수행(신호 유실 방지), (4) 밴드는 vwap NaN이면 전부 NaN.
describe("ta.vwap (multi-arg overloads, C362)", () => {
  it("2-arg with anchor always false is bit-identical to the 1-arg form", () => {
    const a = {};
    const b = {};
    const close = [101, 102, 103, 102, 104];
    const volume = [1000, 1100, 1200, 1150, 1300];
    for (let i = 0; i < close.length; i++) {
      expect(vwap(a, close[i]!, volume[i]!, false)).toBe(vwap(b, close[i]!, volume[i]!));
    }
  });

  it("anchor=true resets the accumulation and the reset bar itself seeds the new period", () => {
    const state = {};
    vwap(state, 100, 1000);
    vwap(state, 200, 1000);
    // reset bar: cumulative history dropped, vwap === this bar's price
    expect(vwap(state, 300, 500, true)).toBe(300);
    // next bar continues the NEW period only: (300*500 + 310*1500)/(500+1500)
    expect(vwap(state, 310, 1500, false)).toBeCloseTo((300 * 500 + 310 * 1500) / 2000, 12);
  });

  it("anchor=true on the very first bar is a no-op (sums were already empty)", () => {
    const a = {};
    const b = {};
    expect(vwap(a, 101, 1000, true)).toBe(vwap(b, 101, 1000, false));
  });

  it("anchor=true on every bar makes vwap track the per-bar price exactly", () => {
    const state = {};
    const close = [101, 102, 103, 104];
    for (const c of close) expect(vwap(state, c, 1000, true)).toBe(c);
  });

  it("na (NaN) anchor is treated as no-reset (false)", () => {
    const state = {};
    vwap(state, 100, 1000);
    // NaN anchor: accumulation continues — (100*1000 + 200*1000)/2000 = 150
    expect(vwap(state, 200, 1000, NaN)).toBe(150);
  });

  it("performs the anchor reset even on a NaN data bar (reset signal is not silently lost)", () => {
    const state = {};
    vwap(state, 100, 1000);
    vwap(state, 200, 1000);
    // NaN bar with anchor=true: returns NaN, but the sums are cleared
    expect(vwap(state, NaN, 1000, true)).toBeNaN();
    // next valid bar starts a fresh period: vwap === its own price, old bars gone
    expect(vwap(state, 500, 800, false)).toBe(500);
  });

  it("does not touch accumulation on a NaN data bar without anchor (1-arg NaN-skip rule preserved)", () => {
    const state: { cumPv?: number; cumVol?: number; cumPv2?: number } = {};
    vwap(state, 100, 10, false);
    expect(vwap(state, NaN, 20, false)).toBeNaN();
    expect(state.cumPv).toBe(1000);
    expect(state.cumVol).toBe(10);
    expect(vwap(state, 200, 10, false)).toBe(150);
  });

  it("3-arg band form writes [vwap, upper, lower] into scratch and still returns vwap", () => {
    const state = {};
    const scratch = new Float64Array(3);
    // two bars, then read the bands: vwap = (100*1000 + 110*1000)/2000 = 105
    vwap(state, 100, 1000, false, 2.0, scratch);
    const ret = vwap(state, 110, 1000, false, 2.0, scratch);
    const v = (100 * 1000 + 110 * 1000) / 2000;
    // Var = Σ(vol·src²)/Σvol − vwap² = (100²+110²)/2 − 105² = 25 → sd = 5
    const sd = 5;
    expect(ret).toBe(v);
    expect(scratch[0]).toBe(v);
    expect(scratch[1]).toBeCloseTo(v + 2.0 * sd, 12);
    expect(scratch[2]).toBeCloseTo(v - 2.0 * sd, 12);
  });

  it("3-arg band form with a constant source has zero stdev (upper === lower === vwap)", () => {
    const state = {};
    const scratch = new Float64Array(3);
    for (let i = 0; i < 5; i++) vwap(state, 100, 1000 + i * 37, false, 3.0, scratch);
    expect(scratch[0]).toBe(100);
    expect(scratch[1]).toBe(100);
    expect(scratch[2]).toBe(100);
  });

  it("3-arg band form with stdev_mult=0 collapses both bands onto vwap", () => {
    const state = {};
    const scratch = new Float64Array(3);
    vwap(state, 100, 1000, false, 0, scratch);
    vwap(state, 120, 500, false, 0, scratch);
    expect(scratch[1]).toBe(scratch[0]);
    expect(scratch[2]).toBe(scratch[0]);
  });

  it("3-arg band form fills scratch with NaN on a NaN data bar and on a zero-volume prefix", () => {
    const state = {};
    const scratch = new Float64Array(3);
    expect(vwap(state, NaN, 1000, false, 2.0, scratch)).toBeNaN();
    expect(scratch[0]).toBeNaN();
    expect(scratch[1]).toBeNaN();
    expect(scratch[2]).toBeNaN();
    expect(vwap(state, 100, 0, false, 2.0, scratch)).toBeNaN();
    expect(scratch[0]).toBeNaN();
    expect(scratch[1]).toBeNaN();
    expect(scratch[2]).toBeNaN();
  });

  it("3-arg band variance restarts from the reset bar (post-anchor bars only)", () => {
    const state = {};
    const scratch = new Float64Array(3);
    // wildly different pre-reset regime that would dominate the variance if not dropped
    vwap(state, 10, 1000, false, 1.0, scratch);
    vwap(state, 990, 1000, false, 1.0, scratch);
    // reset, then two post-reset bars: vwap = (100+110)/2 = 105, sd = 5 (equal volumes)
    vwap(state, 100, 700, true, 1.0, scratch);
    vwap(state, 110, 700, false, 1.0, scratch);
    expect(scratch[0]).toBeCloseTo(105, 12);
    expect(scratch[1]).toBeCloseTo(110, 12);
    expect(scratch[2]).toBeCloseTo(100, 12);
  });

  it("volume-weighted variance weights the deviation by volume (hand-computed asymmetric case)", () => {
    const state = {};
    const scratch = new Float64Array(3);
    // bars: (100, vol 3000), (110, vol 1000) → vwap = (300000+110000)/4000 = 102.5
    // Var = (3000·100² + 1000·110²)/4000 − 102.5² = (30000000+12100000)/4000 − 10506.25 = 18.75
    vwap(state, 100, 3000, false, 2.0, scratch);
    vwap(state, 110, 1000, false, 2.0, scratch);
    const v = 102.5;
    const sd = Math.sqrt(18.75);
    expect(scratch[0]).toBeCloseTo(v, 12);
    expect(scratch[1]).toBeCloseTo(v + 2.0 * sd, 12);
    expect(scratch[2]).toBeCloseTo(v - 2.0 * sd, 12);
  });

  it("na stdev_mult poisons only the bands, not the vwap itself", () => {
    const state = {};
    const scratch = new Float64Array(3);
    vwap(state, 100, 1000, false, NaN, scratch);
    const ret = vwap(state, 110, 1000, false, NaN, scratch);
    expect(ret).toBe(105);
    expect(scratch[0]).toBe(105);
    expect(scratch[1]).toBeNaN();
    expect(scratch[2]).toBeNaN();
  });
});

// ta.pivothigh/ta.pivotlow(source, left, right) — candidate=source.get(right)(right바 지연)가 창
// [0..left+right](길이 left+right+1)에서 최댓값/최솟값이면 그 값을, 아니면 NaN을 반환(동률은 pivot
// 성립을 막지 않음, 엄격 부등호만 거부 — pine2py wavealgo/ta/pivot.py). 새 자료구조 없이
// length=left+right+1짜리 rt.ta.highest/rt.ta.lowest(C42 ExtremeState)를 그대로 호출하는 합성 —
// candidate는 ExtremeState의 raw backing buffer(deque가 아닌 원값 순환 저장)를 offset=right로 직접
// 인덱싱해 재사용(별도 버퍼 불필요). scratch/probe_pivot.mjs로 pine2py 리터럴 포트와 대조 완료.
describe("ta.pivothigh", () => {
  it("returns NaN while the window hasn't filled yet (left=1, right=1, total=3 bars)", () => {
    const state = {};
    expect(pivothigh(state, 101, 1, 1)).toBeNaN();
    expect(pivothigh(state, 102, 1, 1)).toBeNaN();
  });

  it("matches a hand-computed pivot once the window fills (left=1, right=1): [1,9,2] -> candidate=9 is the max of the full window", () => {
    const state = {};
    pivothigh(state, 1, 1, 1); // NaN (warmup)
    pivothigh(state, 9, 1, 1); // NaN (warmup)
    expect(pivothigh(state, 2, 1, 1)).toBe(9); // window [1,9,2], candidate=source.get(1)=9, max of window
  });

  it("rejects a candidate that isn't the strict max: [1,9,2,3] at left=1,right=1 -> candidate=2 is not >= 9,3", () => {
    const state = {};
    pivothigh(state, 1, 1, 1);
    pivothigh(state, 9, 1, 1);
    pivothigh(state, 2, 1, 1); // window [1,9,2], candidate=9 -> pivot
    expect(pivothigh(state, 3, 1, 1)).toBeNaN(); // window [9,2,3], candidate=2, but 9>2 on the left -> NaN
  });

  it("allows ties (equal values do not block a pivot, only a strictly greater value does)", () => {
    const state = {};
    pivothigh(state, 3, 1, 1);
    pivothigh(state, 3, 1, 1);
    expect(pivothigh(state, 3, 1, 1)).toBe(3); // flat window [3,3,3]: candidate==max, tie allowed
  });

  it("poisons the result if any bar in the window (including the candidate itself) is NaN", () => {
    const state = {};
    pivothigh(state, 1, 1, 1);
    pivothigh(state, NaN, 1, 1); // candidate bar itself NaN
    expect(pivothigh(state, 2, 1, 1)).toBeNaN();
  });

  it("supports left=0 (no left-side check, only the right-side window matters)", () => {
    const state = {};
    // total=right+1=3; window=[current-2,current-1,current], candidate=source.get(right)=oldest bar.
    expect(pivothigh(state, 5, 0, 2)).toBeNaN();
    expect(pivothigh(state, 1, 0, 2)).toBeNaN();
    expect(pivothigh(state, 2, 0, 2)).toBe(5); // window [5,1,2], candidate=5 (oldest), max -> pivot
  });

  it("supports right=0 (no delay: candidate is the current bar, only the left-side window matters)", () => {
    const state = {};
    expect(pivothigh(state, 1, 2, 0)).toBeNaN();
    expect(pivothigh(state, 2, 2, 0)).toBeNaN();
    expect(pivothigh(state, 9, 2, 0)).toBe(9); // window [1,2,9], candidate=9 (current bar, no delay)
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    pivothigh(stateA, 1, 1, 1);
    pivothigh(stateA, 9, 1, 1);
    expect(pivothigh(stateA, 2, 1, 1)).toBe(9);
    expect(pivothigh(stateB, 100, 1, 1)).toBeNaN();
  });

  it("matches the pine2py oracle golden sample10.json trace (close, left=1, right=1)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => pivothigh(state, c, 1, 1));
    const expected = [NaN, NaN, NaN, 103, NaN, NaN, NaN, 106, NaN, NaN];
    results.forEach((r, i) => (Number.isNaN(expected[i]!) ? expect(r).toBeNaN() : expect(r).toBe(expected[i])));
  });

  it("matches a from-scratch literal port of pivot.py (pivothigh) across ties, NaN gaps, and varying left/right", () => {
    const bruteForce = (history: number[], i: number, left: number, right: number): number => {
      const total = left + right + 1;
      if (i + 1 < total) return NaN;
      const get = (idx: number) => history[i - idx]!;
      const candidate = get(right);
      if (Number.isNaN(candidate)) return NaN;
      for (let k = 1; k <= left; k++) {
        const val = get(right + k);
        if (Number.isNaN(val) || val > candidate) return NaN;
      }
      for (let k = 0; k < right; k++) {
        const val = get(k);
        if (Number.isNaN(val) || val > candidate) return NaN;
      }
      return candidate;
    };
    let seed = 13579;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const [left, right] of [
      [1, 1],
      [3, 2],
      [0, 4],
      [4, 0],
    ]) {
      const raw: number[] = [];
      for (let i = 0; i < 500; i++) raw.push(rnd() < 0.05 ? NaN : Math.floor(rnd() * 5));
      const state = {};
      raw.forEach((v, i) => {
        const actual = pivothigh(state, v, left!, right!);
        const expected = bruteForce(raw, i, left!, right!);
        if (Number.isNaN(expected)) expect(actual).toBeNaN();
        else expect(actual).toBe(expected);
      });
    }
  });
});

describe("ta.pivotlow", () => {
  it("returns NaN while the window hasn't filled yet (left=1, right=1, total=3 bars)", () => {
    const state = {};
    expect(pivotlow(state, 101, 1, 1)).toBeNaN();
    expect(pivotlow(state, 102, 1, 1)).toBeNaN();
  });

  it("matches a hand-computed pivot once the window fills (left=1, right=1): [9,1,8] -> candidate=1 is the min of the full window", () => {
    const state = {};
    pivotlow(state, 9, 1, 1);
    pivotlow(state, 1, 1, 1);
    expect(pivotlow(state, 8, 1, 1)).toBe(1); // window [9,1,8], candidate=source.get(1)=1, min of window
  });

  it("allows ties (equal values do not block a pivot, only a strictly smaller value does)", () => {
    const state = {};
    pivotlow(state, 3, 1, 1);
    pivotlow(state, 3, 1, 1);
    expect(pivotlow(state, 3, 1, 1)).toBe(3); // flat window [3,3,3]: candidate==min, tie allowed
  });

  it("poisons the result if any bar in the window is NaN", () => {
    const state = {};
    pivotlow(state, 9, 1, 1);
    pivotlow(state, NaN, 1, 1);
    expect(pivotlow(state, 8, 1, 1)).toBeNaN();
  });

  it("keeps independent state across two call sites", () => {
    const stateA = {};
    const stateB = {};
    pivotlow(stateA, 9, 1, 1);
    pivotlow(stateA, 1, 1, 1);
    expect(pivotlow(stateA, 8, 1, 1)).toBe(1);
    expect(pivotlow(stateB, -100, 1, 1)).toBeNaN();
  });

  it("matches the pine2py oracle golden sample10.json trace (close, left=1, right=1)", () => {
    const state = {};
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const results = closes.map((c) => pivotlow(state, c, 1, 1));
    const expected = [NaN, NaN, NaN, NaN, 102, NaN, NaN, NaN, 105, NaN];
    results.forEach((r, i) => (Number.isNaN(expected[i]!) ? expect(r).toBeNaN() : expect(r).toBe(expected[i])));
  });

  it("matches a from-scratch literal port of pivot.py (pivotlow) across ties, NaN gaps, and varying left/right", () => {
    const bruteForce = (history: number[], i: number, left: number, right: number): number => {
      const total = left + right + 1;
      if (i + 1 < total) return NaN;
      const get = (idx: number) => history[i - idx]!;
      const candidate = get(right);
      if (Number.isNaN(candidate)) return NaN;
      for (let k = 1; k <= left; k++) {
        const val = get(right + k);
        if (Number.isNaN(val) || val < candidate) return NaN;
      }
      for (let k = 0; k < right; k++) {
        const val = get(k);
        if (Number.isNaN(val) || val < candidate) return NaN;
      }
      return candidate;
    };
    let seed = 97531;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (const [left, right] of [
      [1, 1],
      [2, 3],
      [0, 3],
      [3, 0],
    ]) {
      const raw: number[] = [];
      for (let i = 0; i < 500; i++) raw.push(rnd() < 0.05 ? NaN : Math.floor(rnd() * 5));
      const state = {};
      raw.forEach((v, i) => {
        const actual = pivotlow(state, v, left!, right!);
        const expected = bruteForce(raw, i, left!, right!);
        if (Number.isNaN(expected)) expect(actual).toBeNaN();
        else expect(actual).toBe(expected);
      });
    }
  });
});

// ta.pivothigh/ta.pivotlow series(가변) left/right (배치25 (4) 계속, next_hint(C551) —
// pivothighVarLen/pivotlowVarLen). 버퍼 메커니즘은 highestVarLen과 완전 동형(콜사이트별 barCount
// 크기 버퍼 + barIdx 같은-바 덮어쓰기). pine2py pivot.py도 상태 없이 매 호출 현재 left/right로
// source.get(0..left+right)를 재구축하는 무상태 재스캔이라(median/linreg/stdev #181/#182와 동일
// 축) 가변 length 오라클이 성립한다(oracle/cases/ta_pivot_varlen.pine 골든이 정상 구간을 이미
// 대조) — 여기서는 오라클이 못 미치는 크래시 경계(left/right가 NaN)와 pine2py Series.get()
// out-of-range(음수 인덱스/len 초과 전부 NaN)를 그대로 재현하는 음수 left/right 경계를
// hand-verified로 커버한다.
describe("ta.pivothigh variable(series) left/right (pivothighVarLen)", () => {
  it("matches a from-scratch literal port of pivot.py across ties, NaN gaps, and left/right that vary independently every bar (out-of-range index = NaN, mirroring pine2py Series.get())", () => {
    const bruteForce = (history: number[], i: number, left: number, right: number): number => {
      // idx>i(현재 바보다 미래)도 idx<0과 동일하게 NaN — right가 음수면 candidate가 i보다 뒤를
      // 가리킬 수 있는데, 이 스트리밍 엔진은 그 미래 바를 아직 push 안 했다(history 배열 자체는 정적
      // 300개를 미리 만들어뒀지만 실제로는 매 바 순차 push다) — `idx>=history.length`로 잘못 짰다가
      // 첫 실행에서 실제 mismatch로 드러남(scratch/debug_pivot_varlen.mjs로 원인 격리).
      const get = (idx: number) => (idx < 0 || idx > i ? NaN : history[idx]!);
      const candidate = get(i - right);
      if (Number.isNaN(candidate)) return NaN;
      for (let k = 1; k <= left; k++) {
        const val = get(i - right - k);
        if (Number.isNaN(val) || val > candidate) return NaN;
      }
      for (let k = 0; k < right; k++) {
        const val = get(i - k);
        if (Number.isNaN(val) || val > candidate) return NaN;
      }
      return candidate;
    };
    let seed = 24681;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const raw: number[] = [];
    for (let i = 0; i < 300; i++) raw.push(rnd() < 0.05 ? NaN : Math.floor(rnd() * 5));
    const state = {};
    raw.forEach((v, i) => {
      const left = (i % 5) - 1; // -1..3 순환(음수 포함)
      const right = ((i + 2) % 4) - 1; // -1..2 순환(음수 포함, 서로 다른 위상)
      const actual = pivothighVarLen(state, v, left, right, raw.length, i);
      const expected = bruteForce(raw, i, left, right);
      if (Number.isNaN(expected)) expect(actual).toBeNaN();
      else expect(actual).toBe(expected);
    });
  });

  it("left=NaN or right=NaN → NaN (pine2py range(nan)/list-index TypeError crash → hand-verified na, python 직접 실행 확인, TV 미검증 가설)", () => {
    expect(pivothighVarLen({}, 10, NaN, 1, 10, 0)).toBeNaN();
    expect(pivothighVarLen({}, 10, 1, NaN, 10, 0)).toBeNaN();
  });

  it("same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    pivothighVarLen(state, 1, 0, 0, 10, 0);
    pivothighVarLen(state, 9, 0, 0, 10, 1);
    pivothighVarLen(state, 100, 0, 0, 10, 1); // barIdx(1)는 직전 호출과 동일 → buffer[1]을 덮어쓰기(push 아님)
    expect(pivothighVarLen(state, 2, 1, 1, 10, 2)).toBe(100); // candidate=buffer[1]=100(덮어써진 값), 9였다면 다른 결과
  });

  it("fractional left/right truncate toward zero (Math.trunc, array-index rule)", () => {
    const state = {};
    pivothighVarLen(state, 5, 0, 0, 10, 0);
    pivothighVarLen(state, 1, 0, 0, 10, 1);
    // trunc(1.9)=1(왼쪽 1바만 검사) / trunc(0.9)=0(오른쪽 지연 없음, candidate=현재 바)
    expect(pivothighVarLen(state, 9, 1.9, 0.9, 10, 2)).toBe(9);
  });
});

describe("ta.pivotlow variable(series) left/right (pivotlowVarLen)", () => {
  it("matches a from-scratch literal port of pivot.py across ties, NaN gaps, and left/right that vary independently every bar (out-of-range index = NaN, mirroring pine2py Series.get())", () => {
    const bruteForce = (history: number[], i: number, left: number, right: number): number => {
      // idx>i(현재 바보다 미래)도 idx<0과 동일하게 NaN — right가 음수면 candidate가 i보다 뒤를
      // 가리킬 수 있는데, 이 스트리밍 엔진은 그 미래 바를 아직 push 안 했다(history 배열 자체는 정적
      // 300개를 미리 만들어뒀지만 실제로는 매 바 순차 push다) — `idx>=history.length`로 잘못 짰다가
      // 첫 실행에서 실제 mismatch로 드러남(scratch/debug_pivot_varlen.mjs로 원인 격리).
      const get = (idx: number) => (idx < 0 || idx > i ? NaN : history[idx]!);
      const candidate = get(i - right);
      if (Number.isNaN(candidate)) return NaN;
      for (let k = 1; k <= left; k++) {
        const val = get(i - right - k);
        if (Number.isNaN(val) || val < candidate) return NaN;
      }
      for (let k = 0; k < right; k++) {
        const val = get(i - k);
        if (Number.isNaN(val) || val < candidate) return NaN;
      }
      return candidate;
    };
    let seed = 13579;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const raw: number[] = [];
    for (let i = 0; i < 300; i++) raw.push(rnd() < 0.05 ? NaN : Math.floor(rnd() * 5));
    const state = {};
    raw.forEach((v, i) => {
      const left = (i % 4) - 1; // -1..2 순환(음수 포함)
      const right = ((i + 1) % 5) - 1; // -1..3 순환(음수 포함, 서로 다른 위상)
      const actual = pivotlowVarLen(state, v, left, right, raw.length, i);
      const expected = bruteForce(raw, i, left, right);
      if (Number.isNaN(expected)) expect(actual).toBeNaN();
      else expect(actual).toBe(expected);
    });
  });

  it("left=NaN or right=NaN → NaN (pine2py range(nan)/list-index TypeError crash → hand-verified na, python 직접 실행 확인, TV 미검증 가설)", () => {
    expect(pivotlowVarLen({}, 10, NaN, 1, 10, 0)).toBeNaN();
    expect(pivotlowVarLen({}, 10, 1, NaN, 10, 0)).toBeNaN();
  });

  it("same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    pivotlowVarLen(state, 9, 0, 0, 10, 0);
    pivotlowVarLen(state, 1, 0, 0, 10, 1);
    pivotlowVarLen(state, -100, 0, 0, 10, 1); // barIdx(1)는 직전 호출과 동일 → buffer[1]을 덮어쓰기(push 아님)
    expect(pivotlowVarLen(state, 2, 1, 1, 10, 2)).toBe(-100); // candidate=buffer[1]=-100(덮어써진 값)
  });

  it("fractional left/right truncate toward zero (Math.trunc, array-index rule)", () => {
    const state = {};
    pivotlowVarLen(state, 5, 0, 0, 10, 0);
    pivotlowVarLen(state, 9, 0, 0, 10, 1);
    // trunc(1.9)=1(왼쪽 1바만 검사) / trunc(0.9)=0(오른쪽 지연 없음, candidate=현재 바)
    expect(pivotlowVarLen(state, 1, 1.9, 0.9, 10, 2)).toBe(1);
  });

  it("negative left with right=1 matches the pine2py-verified boundary case (python 직접 실행 대조, hi=NaN/lo=107 across sample10 close with left=-1/right=1 on every bar)", () => {
    const vals = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const stateHi = {};
    const stateLo = {};
    let hi = NaN;
    let lo = NaN;
    vals.forEach((v, i) => {
      hi = pivothighVarLen(stateHi, v, -1, 1, vals.length, i);
      lo = pivotlowVarLen(stateLo, v, -1, 1, vals.length, i);
    });
    expect(hi).toBeNaN();
    expect(lo).toBe(107);
  });
});

// ta.range(source, length) - length가 series인 변형(배치25 (4) 계속, next_hint(C552) 잔여 싱글턴
// 묶음, C553 — runtime/ta.ts rangeVarLen). pine2py range_func.py도 상태 없이 매 호출 재스캔이라
// python 직접 실행으로 가변 length 정상 동작(context 모드 == direct 모드) 확인됨(oracle/cases/
// ta_range_percentile_varlen.pine 골든이 정상 구간 커버) - 여기서는 오라클 불가 축(length<1의
// -inf literal port 자체는 오라클 커버, length=NaN 크래시 경계)과 고정 range()와의 등가성만 추가로
// 확인한다.
describe("ta.range variable(series) length (rangeVarLen)", () => {
  it("matches the fixed-length range() for a constant length across the whole trace (varlen buffer vs fixed monotonic-deque composite)", () => {
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const fixedState = {};
    const varState = {};
    closes.forEach((c, i) => {
      const fixed = range(fixedState, c, 3);
      const varlen = rangeVarLen(varState, c, 3, closes.length, i);
      if (Number.isNaN(fixed)) expect(varlen).toBeNaN();
      else expect(varlen).toBe(fixed);
    });
  });

  it("length<1 (0 and negative) → -Infinity immediately, even during warmup (pine2py's `len(source)<length` gate never fires for length<=0, python 직접 실행 확인 — highest -inf #178과 동일 literal port)", () => {
    const state = {};
    expect(rangeVarLen(state, 10, 0, 10, 0)).toBe(-Infinity); // bar 0(워밍업 구간)인데도 즉시 -inf
    expect(rangeVarLen(state, 20, -3, 10, 1)).toBe(-Infinity);
  });

  it("length=NaN → NaN (pine2py `range(nan)` TypeError crash → hand-verified na 전파 외삽, TV 미검증 가설)", () => {
    expect(rangeVarLen({}, 10, NaN, 10, 0)).toBeNaN();
  });

  it("same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    rangeVarLen(state, 10, 2, 10, 0);
    rangeVarLen(state, 10, 2, 10, 1);
    rangeVarLen(state, 100, 2, 10, 1); // barIdx(1)는 직전과 동일 → buffer[1]을 덮어쓰기(push 아님)
    expect(rangeVarLen(state, 12, 2, 10, 2)).toBe(88); // window=[100(덮어써진 값),12] → 100-12
  });

  it("poisons the result while a NaN sits inside the trailing window, then recovers", () => {
    const state = {};
    rangeVarLen(state, 5, 2, 10, 0);
    expect(rangeVarLen(state, NaN, 2, 10, 1)).toBeNaN();
    expect(rangeVarLen(state, 6, 2, 10, 2)).toBeNaN(); // window=[NaN,6]
    expect(rangeVarLen(state, 9, 2, 10, 3)).toBe(3); // window=[6,9]
  });
});

// ta.percentile_nearest_rank/ta.percentile_linear_interpolation(source, length, percentage=50) -
// length가 series인 변형(배치25 (4) 계속, next_hint(C552) 잔여 싱글턴 묶음, C553 — runtime/ta.ts
// percentileNearestRankVarLen/percentileLinearInterpolationVarLen). pine2py percentrank.py의 두
// percentile_* 함수도 median.py와 동일하게 상태 없이 매 호출 재스캔이라 가변 length 오라클이
// 성립(oracle/cases/ta_range_percentile_varlen.pine 골든이 정상 구간 + 2/3-인자 폼 codegen 패딩
// 둘 다 커버). 여기서는 오라클 불가 축(length<1은 pine2py 빈 window 인덱싱 IndexError 크래시,
// median/wma와 동일하게 na 자체 결정 — range와 달리 "크래시 없는 정의된 동작"이 없다는 점에
// 주의)과 고정판과의 등가성만 추가로 확인한다.
describe("ta.percentile_nearest_rank/ta.percentile_linear_interpolation variable(series) length (percentileNearestRankVarLen/percentileLinearInterpolationVarLen)", () => {
  it("percentileNearestRankVarLen matches the fixed-length percentileNearestRank() for a constant length across the whole trace", () => {
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const fixedState = {};
    const varState = {};
    closes.forEach((c, i) => {
      const fixed = percentileNearestRank(fixedState, c, 3, 30);
      const varlen = percentileNearestRankVarLen(varState, c, 3, 30, closes.length, i);
      if (Number.isNaN(fixed)) expect(varlen).toBeNaN();
      else expect(varlen).toBe(fixed);
    });
  });

  it("percentileLinearInterpolationVarLen matches the fixed-length percentileLinearInterpolation() for a constant length across the whole trace", () => {
    const closes = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const fixedState = {};
    const varState = {};
    closes.forEach((c, i) => {
      const fixed = percentileLinearInterpolation(fixedState, c, 3, 30);
      const varlen = percentileLinearInterpolationVarLen(varState, c, 3, 30, closes.length, i);
      if (Number.isNaN(fixed)) expect(varlen).toBeNaN();
      else expect(varlen).toBe(fixed);
    });
  });

  it("length<1 (0 and negative) → NaN for both (pine2py sorted-window indexing IndexError crash → hand-verified na, python 직접 실행 확인 — median/wma와 동일 축, range의 -inf와 다름)", () => {
    expect(percentileNearestRankVarLen({}, 10, 0, 50, 10, 0)).toBeNaN();
    expect(percentileNearestRankVarLen({}, 10, -2, 50, 10, 0)).toBeNaN();
    expect(percentileLinearInterpolationVarLen({}, 10, 0, 50, 10, 0)).toBeNaN();
    expect(percentileLinearInterpolationVarLen({}, 10, -2, 50, 10, 0)).toBeNaN();
  });

  it("length=NaN → NaN for both (pine2py `range(nan)` TypeError crash → hand-verified na 전파 외삽, TV 미검증 가설)", () => {
    expect(percentileNearestRankVarLen({}, 10, NaN, 50, 10, 0)).toBeNaN();
    expect(percentileLinearInterpolationVarLen({}, 10, NaN, 50, 10, 0)).toBeNaN();
  });

  it("same-bar repeated calls overwrite the current slot instead of advancing (context.param() parity)", () => {
    const state = {};
    percentileNearestRankVarLen(state, 10, 1, 50, 10, 0);
    percentileNearestRankVarLen(state, 1, 1, 50, 10, 1);
    percentileNearestRankVarLen(state, -100, 1, 50, 10, 1); // barIdx(1)는 직전과 동일 → buffer[1]을 덮어쓰기(push 아님)
    // window=buffer[1..2]=[-100(덮어써진 값),2] 정렬=[-100,2], idx=ceil(0.5*2)-1=0 → -100
    expect(percentileNearestRankVarLen(state, 2, 2, 50, 10, 2)).toBe(-100);
  });

  it("poisons the result while a NaN sits inside the trailing window, then recovers", () => {
    const state = {};
    percentileLinearInterpolationVarLen(state, 5, 2, 50, 10, 0);
    expect(percentileLinearInterpolationVarLen(state, NaN, 2, 50, 10, 1)).toBeNaN();
    expect(percentileLinearInterpolationVarLen(state, 6, 2, 50, 10, 2)).toBeNaN(); // window=[NaN,6]
    expect(percentileLinearInterpolationVarLen(state, 9, 2, 50, 10, 3)).toBe(7.5); // window=[6,9] → mid
  });
});

// ta.supertrend(factor, atrPeriod) — the fourth multi-return TA (returnArity: 2), and the first
// non-3-arity use of the C50 multi-return infra. **Intentionally diverges from the pine2py golden**
// (DIVERGENCES.md #10): supertrend's own band/direction state is seeded from ta.atr's output every
// bar, and rt.ta.atr (O(1) RMA streaming, C53) warms up one bar earlier than pine2py's re-scan
// atr.py — so the warmup-bar transient value differs even though, for this short sample10.json
// series, both converge to identical values from bar4 onward (no long-series windowing drift here,
// see DIVERGENCES.md #8 point 2). Values below are cross-checked via scratch/probe_supertrend.mjs
// against a literal line-by-line port of supertrend.py's incremental branch.
describe("ta.supertrend", () => {
  function st2(
    state: Parameters<typeof supertrend>[0],
    high: number,
    low: number,
    close: number,
    prevClose: number,
    factor: number,
    atrPeriod: number,
  ): [number, number] {
    const scratch = new Float64Array(2);
    supertrend(state, high, low, close, prevClose, factor, atrPeriod, scratch);
    return [scratch[0]!, scratch[1]!];
  }

  it("returns (NaN, 0) while atr is still warming up, and leaves its own state untouched", () => {
    const state: Parameters<typeof supertrend>[0] = {};
    const [v0, d0] = st2(state, 102, 99, 101, NaN, 2, 3);
    expect(v0).toBeNaN();
    expect(d0).toBe(0);
    expect(state.upper).toBeUndefined(); // atr NaN -> own band/direction state never created
    const [v1, d1] = st2(state, 103, 100, 102, 101, 2, 3);
    expect(v1).toBeNaN();
    expect(d1).toBe(0);
    expect(state.upper).toBeUndefined();
  });

  it("matches the pine2py-verified sample10.json trace (factor=2, atrPeriod=3) — valid one bar earlier than golden (bar2 vs golden's bar3), same value from bar4 onward", () => {
    // oracle/golden/ta_supertrend.json: NaN through bar2, then 95.5,97.5,98.5,99.5,99.5,100.5,101.5
    // (direction=1 throughout once valid) from bar3. pine2js is valid from bar2 with a different
    // transient value (96.5 vs golden's bar3=95.5), then matches bar-for-bar from bar4 (DIVERGENCES #10).
    const state: Parameters<typeof supertrend>[0] = {};
    const high = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const low = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const expected: [number, number][] = [
      [NaN, 0],
      [NaN, 0],
      [96.5, 1],
      [96.5, 1],
      [97.5, 1],
      [98.5, 1],
      [99.5, 1],
      [99.5, 1],
      [100.5, 1],
      [101.5, 1],
    ];
    for (let i = 0; i < close.length; i++) {
      const prevClose = i === 0 ? NaN : close[i - 1]!;
      const [v, d] = st2(state, high[i]!, low[i]!, close[i]!, prevClose, 2, 3);
      if (Number.isNaN(expected[i]![0])) expect(v).toBeNaN();
      else expect(v).toBeCloseTo(expected[i]![0], 9);
      expect(d).toBe(expected[i]![1]);
    }
  });

  it("flips direction bullish->bearish->bullish on a strong zigzag (direction check uses prevUpper/prevLower, not the just-computed final bands)", () => {
    // 20 rising bars (well above any lower band -> direction stays 1) then 20 falling bars (close
    // drops below the held lower band -> flips to -1) then rising again (-> flips back to 1).
    const state: Parameters<typeof supertrend>[0] = {};
    const closes: number[] = [];
    for (let i = 0; i < 20; i++) closes.push(100 + i);
    for (let i = 0; i < 20; i++) closes.push(119 - i);
    for (let i = 0; i < 20; i++) closes.push(100 + i);
    const dirs: number[] = [];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i]!;
      const prevClose = i === 0 ? NaN : closes[i - 1]!;
      const [, d] = st2(state, c + 1, c - 1, c, prevClose, 2, 3);
      dirs.push(d);
    }
    expect(dirs.slice(0, 5).every((d) => d === 0 || d === 1)).toBe(true);
    expect(dirs[19]).toBe(1); // top of the rise, still bullish
    expect(dirs[39]).toBe(-1); // bottom of the fall, flipped bearish
    expect(dirs[59]).toBe(1); // back to bullish after the second rise
    expect(dirs.includes(-1)).toBe(true); // an actual flip happened, not a fluke of the fixture
  });

  it("keeps independent state across two call sites", () => {
    const stateA: Parameters<typeof supertrend>[0] = {};
    const stateB: Parameters<typeof supertrend>[0] = {};
    const closes = [101, 102, 103, 102, 104];
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i]!;
      st2(stateA, c + 1, c - 2, c, i === 0 ? NaN : closes[i - 1]!, 2, 3);
    }
    const [v, d] = st2(stateB, 6, 3, 5, NaN, 2, 3); // stateB's own warmup still fresh
    expect(v).toBeNaN();
    expect(d).toBe(0);
    expect(stateA.upper).not.toBe(stateB.upper);
  });

  it("reuses the same scratch array across calls without allocating (values overwritten in place)", () => {
    const state: Parameters<typeof supertrend>[0] = {};
    const scratch = new Float64Array(2);
    supertrend(state, 103, 100, 101, NaN, 2, 3, scratch);
    expect(scratch[0]).toBeNaN();
    supertrend(state, 104, 101, 102, 101, 2, 3, scratch);
    expect(scratch[0]).toBeNaN(); // still warming up (atrPeriod=3 needs 3 bars)
    supertrend(state, 105, 102, 103, 102, 2, 3, scratch);
    expect(scratch[0]).not.toBeNaN(); // 같은 배열 인스턴스에 덮어써졌다
  });

  it("matches a from-scratch literal port of supertrend.py's incremental branch across NaN gaps, atrPeriod=1, negative factor, and a 5,000-sample fuzz", () => {
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function bruteRun(highs: number[], lows: number[], closes: number[], factor: number, atrPeriod: number) {
      // literal port of supertrend.py's incremental branch, reusing this module's own atr() for
      // the inner ATR (already validated independently, C53) — only the band/direction state
      // machine itself is under test here.
      const pyState: Record<string, number> = {};
      const atrState: Parameters<typeof atr>[0] = {};
      const out: [number, number][] = [];
      for (let i = 0; i < closes.length; i++) {
        const prevClose = i === 0 ? NaN : closes[i - 1]!;
        const atrVal = atr(atrState, highs[i]!, lows[i]!, prevClose, atrPeriod);
        if (Number.isNaN(atrVal)) {
          out.push([NaN, 0]);
          continue;
        }
        const c = closes[i]!;
        const hl2 = (highs[i]! + lows[i]!) / 2;
        const basicUpper = hl2 + factor * atrVal;
        const basicLower = hl2 - factor * atrVal;
        const has = "upper" in pyState;
        const prevUpper = has ? pyState.upper! : basicUpper;
        const prevLower = has ? pyState.lower! : basicLower;
        const prevDir = has ? pyState.direction! : 1;
        const prevCloseState = has ? pyState.prevClose! : c;
        const finalUpper = basicUpper < prevUpper || prevCloseState > prevUpper ? basicUpper : prevUpper;
        const finalLower = basicLower > prevLower || prevCloseState < prevLower ? basicLower : prevLower;
        let direction: number;
        if (prevDir === -1 && c > prevUpper) direction = 1;
        else if (prevDir === 1 && c < prevLower) direction = -1;
        else direction = prevDir;
        pyState.upper = finalUpper;
        pyState.lower = finalLower;
        pyState.direction = direction;
        pyState.prevClose = c;
        out.push([direction === 1 ? finalLower : finalUpper, direction]);
      }
      return out;
    }
    for (const [factor, atrPeriod, seed] of [
      [2, 3, 9001],
      [1, 1, 9002],
      [-2, 5, 9003],
    ] as const) {
      const rng = mulberry32(seed);
      const n = 5000;
      const closes: number[] = [];
      const highs: number[] = [];
      const lows: number[] = [];
      let base = 100;
      for (let i = 0; i < n; i++) {
        if (rng() < 0.02) {
          closes.push(NaN);
          highs.push(rng() < 0.5 ? NaN : base + 1);
          lows.push(rng() < 0.5 ? NaN : base - 1);
          continue;
        }
        base += (rng() - 0.5) * 4;
        closes.push(base);
        highs.push(base + rng() * 2);
        lows.push(base - rng() * 2);
      }
      const expected = bruteRun(highs, lows, closes, factor, atrPeriod);
      const state: Parameters<typeof supertrend>[0] = {};
      for (let i = 0; i < n; i++) {
        const prevClose = i === 0 ? NaN : closes[i - 1]!;
        const [v, d] = st2(state, highs[i]!, lows[i]!, closes[i]!, prevClose, factor, atrPeriod);
        if (Number.isNaN(expected[i]![0])) expect(v).toBeNaN();
        else expect(v).toBeCloseTo(expected[i]![0], 9);
        expect(d).toBe(expected[i]![1]);
      }
    }
  });
});

// ta.sar(start, inc, maxAf) — Parabolic SAR. Unlike every other ta.* ported so far, sar doesn't
// compose an already-built TA (no inner atr/ema/wma call) — it's a literal port of pine2py's
// self-contained 9-field state machine (runtime/ta.ts sar() comment). This session had no
// WebSearch grant to cross-check TV's Script Reference against the "re-reversal on the init bar"
// quirk the PROGRESS next_hint flagged, so per that next_hint's fallback this is a byte-for-byte
// port of sar.py, cross-checked via scratch/probe_sar.mjs (a fresh snake_case literalPort against
// this candidate) across sample10, forced re-reversal, NaN gaps, degenerate params, and 5,000-sample
// fuzz — all PASS.
describe("ta.sar", () => {
  it("matches the pine2py oracle golden for sample10.json (start=0.02, inc=0.02, maxAf=0.2)", () => {
    // oracle/golden/ta_sar.json — bar0 NaN (seed only), real values from bar1 (2-bar delay, unlike
    // obv's 1-bar seed-on-first-valid-bar).
    const state: Parameters<typeof sar>[0] = {};
    const high = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const low = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const expected = [NaN, 99, 99, 99.2, 99.392, 99.72848, 100.2302016, 100.90718144, 101.516463296, 102.2944877005];
    for (let i = 0; i < close.length; i++) {
      const v = sar(state, high[i]!, low[i]!, close[i]!, 0.02, 0.02, 0.2);
      if (Number.isNaN(expected[i]!)) expect(v).toBeNaN();
      else expect(v).toBeCloseTo(expected[i]!, 9);
    }
  });

  it("returns NaN on the very first successful call and only seeds prevHigh/prevLow/prevClose (result/maxMin stay at their untouched defaults)", () => {
    const state: Parameters<typeof sar>[0] = {};
    const v = sar(state, 102, 99, 101, 0.02, 0.02, 0.2);
    expect(v).toBeNaN();
    expect(state.barIndex).toBe(1);
    expect(state.prevHigh).toBe(102);
    expect(state.prevLow).toBe(99);
    expect(state.prevClose).toBe(101);
    expect(Number.isNaN(state.result!)).toBe(true); // written back as NaN, not left undefined
  });

  it("leaves state completely untouched on a NaN bar (mid-stream gap resumes as if the gap bar never happened)", () => {
    const state: Parameters<typeof sar>[0] = {};
    sar(state, 102, 99, 101, 0.02, 0.02, 0.2);
    sar(state, 103, 100, 102, 0.02, 0.02, 0.2);
    const snapshot = { ...state };
    const vNaNHigh = sar(state, NaN, 105, 106, 0.02, 0.02, 0.2);
    const vNaNLow = sar(state, 107, NaN, 106, 0.02, 0.02, 0.2);
    const vNaNClose = sar(state, 107, 104, NaN, 0.02, 0.02, 0.2);
    expect(vNaNHigh).toBeNaN();
    expect(vNaNLow).toBeNaN();
    expect(vNaNClose).toBeNaN();
    expect(state).toEqual(snapshot); // state object identical field-for-field — not even barIndex advanced
    const vResume = sar(state, 104, 101, 103, 0.02, 0.02, 0.2);
    const freshState: Parameters<typeof sar>[0] = {};
    sar(freshState, 102, 99, 101, 0.02, 0.02, 0.2);
    sar(freshState, 103, 100, 102, 0.02, 0.02, 0.2);
    const vNoGap = sar(freshState, 104, 101, 103, 0.02, 0.02, 0.2);
    expect(vResume).toBeCloseTo(vNoGap, 9); // gap bars are fully invisible to the trajectory
  });

  it("can re-flip isBelow within the trend-init bar itself (bar_idx==1) when the first two bars are highly volatile — not unreachable dead code", () => {
    // Hand-derived: bar0 seeds prevLow=90/prevHigh=100/prevClose=95. bar1 (close=190>prevClose=95)
    // inits isBelow=true/maxMin=high=200/result=prevLow=90, then the SAME call's main block
    // recomputes result=90+0.5*(200-90)=145, sees 145>low(50) -> re-reverses to isBelow=false,
    // result=max(high,maxMin)=max(200,200)=200, maxMin=low=50 - then the upper-side clamp against
    // prevHigh=100 leaves it at max(200,100)=200 (prevHigh2 doesn't apply yet, barIndex==1).
    const state: Parameters<typeof sar>[0] = {};
    sar(state, 100, 90, 95, 0.5, 0.5, 0.9);
    const v = sar(state, 200, 50, 190, 0.5, 0.5, 0.9);
    expect(v).toBe(200);
    expect(state.isBelow).toBe(false); // ended up bearish-side despite the bullish init a moment earlier
  });

  it("applies the 2-bars-back penetration clamp (prevHigh2) distinctly from the 1-bar-back clamp (prevHigh), only once barIndex > 1", () => {
    // Hand-derived (node): a sharp reversal bar (i=3) followed by i=4 where the raw computed result
    // (128.6) clears the 1-bar-back high (90) but NOT the 2-bars-back high (130) - so the clamp
    // against prevHigh2 is the only thing holding the result at 130 instead of leaking to 128.6.
    const state: Parameters<typeof sar>[0] = {};
    const high = [102, 104, 130, 90, 91];
    const low = [99, 101, 105, 60, 62];
    const close = [101, 103, 110, 70, 75];
    const expected = [NaN, 99, 99, 130, 130];
    for (let i = 0; i < close.length; i++) {
      const v = sar(state, high[i]!, low[i]!, close[i]!, 0.02, 0.02, 0.2);
      if (Number.isNaN(expected[i]!)) expect(v).toBeNaN();
      else expect(v).toBeCloseTo(expected[i]!, 9);
    }
    expect(state.isBelow).toBe(false); // i=3 flipped bullish(isBelow=true)->bearish(isBelow=false)
  });

  it("keeps independent state across two call sites", () => {
    const stateA: Parameters<typeof sar>[0] = {};
    const stateB: Parameters<typeof sar>[0] = {};
    sar(stateA, 102, 99, 101, 0.02, 0.02, 0.2);
    sar(stateA, 103, 100, 102, 0.02, 0.02, 0.2);
    const vB = sar(stateB, 6, 3, 5, 0.02, 0.02, 0.2); // stateB's own warmup still fresh
    expect(vB).toBeNaN();
    expect(stateA.barIndex).not.toBe(stateB.barIndex);
  });

  it("matches a from-scratch literal port of sar.py's _sar_incremental across NaN gaps, degenerate accel params, and a 5,000-sample fuzz", () => {
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    // literal port of pine2py sar.py's _sar_incremental(), independently re-derived (snake_case,
    // pine2py field/line order) rather than reused from the implementation under test.
    function bruteRun(highs: number[], lows: number[], closes: number[], start: number, inc: number, max_af: number) {
      const s: Record<string, number | boolean> = {};
      const out: number[] = [];
      for (let i = 0; i < closes.length; i++) {
        const high = highs[i]!;
        const low = lows[i]!;
        const close = closes[i]!;
        if (Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close)) {
          out.push(NaN);
          continue;
        }
        const bar_idx = (s.bar_index as number) ?? 0;
        let result = (s.result as number) ?? NaN;
        let max_min = (s.max_min as number) ?? NaN;
        let acceleration = (s.acceleration as number) ?? NaN;
        let is_below = (s.is_below as boolean) ?? false;
        const prev_high = (s.prev_high as number) ?? NaN;
        const prev_low = (s.prev_low as number) ?? NaN;
        const prev_high2 = (s.prev_high2 as number) ?? NaN;
        const prev_low2 = (s.prev_low2 as number) ?? NaN;
        const prev_close = (s.prev_close as number) ?? NaN;
        let is_first_trend_bar = false;
        if (bar_idx === 1) {
          if (close > prev_close) {
            is_below = true;
            max_min = high;
            result = prev_low;
          } else {
            is_below = false;
            max_min = low;
            result = prev_high;
          }
          is_first_trend_bar = true;
          acceleration = start;
        }
        if (bar_idx >= 1) {
          result = result + acceleration * (max_min - result);
          if (is_below) {
            if (result > low) {
              is_first_trend_bar = true;
              is_below = false;
              result = Math.max(high, max_min);
              max_min = low;
              acceleration = start;
            }
          } else {
            if (result < high) {
              is_first_trend_bar = true;
              is_below = true;
              result = Math.min(low, max_min);
              max_min = high;
              acceleration = start;
            }
          }
          if (!is_first_trend_bar) {
            if (is_below) {
              if (high > max_min) {
                max_min = high;
                acceleration = Math.min(acceleration + inc, max_af);
              }
            } else {
              if (low < max_min) {
                max_min = low;
                acceleration = Math.min(acceleration + inc, max_af);
              }
            }
          }
          if (is_below) {
            if (!Number.isNaN(prev_low)) result = Math.min(result, prev_low);
            if (bar_idx > 1 && !Number.isNaN(prev_low2)) result = Math.min(result, prev_low2);
          } else {
            if (!Number.isNaN(prev_high)) result = Math.max(result, prev_high);
            if (bar_idx > 1 && !Number.isNaN(prev_high2)) result = Math.max(result, prev_high2);
          }
        }
        s.bar_index = bar_idx + 1;
        s.result = result;
        s.max_min = max_min;
        s.acceleration = acceleration;
        s.is_below = is_below;
        s.prev_high2 = prev_high;
        s.prev_low2 = prev_low;
        s.prev_high = high;
        s.prev_low = low;
        s.prev_close = close;
        out.push(bar_idx < 1 ? NaN : result);
      }
      return out;
    }
    for (const [start, inc, maxAf, seed] of [
      [0.02, 0.02, 0.2, 7001],
      [0.01, 0.01, 0.1, 7002],
      [0.1, 0.1, 0.5, 7003],
      [0.05, 0.05, 0.05, 7004], // maxAf === start: acceleration is capped immediately
    ] as const) {
      const rng = mulberry32(seed);
      const n = 5000;
      const closes: number[] = [];
      const highs: number[] = [];
      const lows: number[] = [];
      let base = 100;
      for (let i = 0; i < n; i++) {
        if (rng() < 0.02) {
          closes.push(NaN);
          highs.push(rng() < 0.5 ? NaN : base + 1);
          lows.push(rng() < 0.5 ? NaN : base - 1);
          continue;
        }
        base += (rng() - 0.5) * 8;
        const c = base + (rng() - 0.5) * 3;
        closes.push(c);
        highs.push(Math.max(c, base) + rng() * 4);
        lows.push(Math.min(c, base) - rng() * 4);
      }
      const expected = bruteRun(highs, lows, closes, start, inc, maxAf);
      const state: Parameters<typeof sar>[0] = {};
      for (let i = 0; i < n; i++) {
        const v = sar(state, highs[i]!, lows[i]!, closes[i]!, start, inc, maxAf);
        if (Number.isNaN(expected[i]!)) expect(v).toBeNaN();
        else expect(v).toBeCloseTo(expected[i]!, 9);
      }
    }
  });
});

// ta.dmi(diLength, adxSmoothing) — Directional Movement Index (returnArity: 3, [plusDi, minusDi,
// adx]). runtime/ta.ts dmi() comment covers the full derivation; the key re-verified fact this
// cycle (correcting C62's next_hint) is that dmi.py's `data_len<diLength+1` gate is a genuine
// per-bar warmup barrier - pine2py's Context.push_bar() (runtime.py L150) pushes onto
// context.data.close *before* the transpiled function runs each bar, so `len(close)` grows by
// exactly 1 every bar (confirmed via a direct python run: Context()+10x push_bar -> len(close) goes
// 1,2,...,10). Ported as `state.callCount`, a plain per-callsite invocation counter that is exactly
// equivalent given this callsite runs unconditionally once per bar (the same invariant every other
// ta.* already assumes).
describe("ta.dmi", () => {
  function dmi3(
    state: Parameters<typeof dmi>[0],
    high: number,
    low: number,
    close: number,
    prevHigh: number,
    prevLow: number,
    prevClose: number,
    diLength: number,
    adxSmoothing: number,
  ): [number, number, number] {
    const scratch = new Float64Array(3);
    dmi(state, high, low, close, prevHigh, prevLow, prevClose, diLength, adxSmoothing, scratch);
    return [scratch[0]!, scratch[1]!, scratch[2]!];
  }

  it("matches the pine2py oracle golden for sample10.json (diLength=3, adxSmoothing=2)", () => {
    // oracle/golden/ta_dmi.json — gate opens at bar3 (0-indexed, diLength=3), NaN triple there too
    // (single-value Wilder seed), plusDi/minusDi valid from bar4, adx valid from bar5 (2 dx values
    // accumulated for adxSmoothing=2).
    const state: Parameters<typeof dmi>[0] = {};
    const high = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const low = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    const expected: [number, number, number][] = [
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [NaN, NaN, NaN],
      [22.222222222222218, 22.222222222222225, NaN],
      [25.925925925925927, 14.814814814814817, 13.63636363636364],
      [28.395061728395063, 9.876543209876546, 31.011730205278592],
      [18.930041152263378, 17.695473251028808, 17.191258361066264],
      [34.84224965706448, 11.796982167352539, 33.30151153347431],
      [34.3392775491541, 7.864654778235027, 48.0158695262171],
    ];
    for (let i = 0; i < close.length; i++) {
      const ph = i === 0 ? NaN : high[i - 1]!;
      const pl = i === 0 ? NaN : low[i - 1]!;
      const pc = i === 0 ? NaN : close[i - 1]!;
      const [p, m, a] = dmi3(state, high[i]!, low[i]!, close[i]!, ph, pl, pc, 3, 2);
      for (const [got, exp] of [
        [p, expected[i]![0]],
        [m, expected[i]![1]],
        [a, expected[i]![2]],
      ] as const) {
        if (Number.isNaN(exp)) expect(got).toBeNaN();
        else expect(got).toBeCloseTo(exp, 9);
      }
    }
  });

  it("returns the NaN triple for every bar of a 10-bar run under the default diLength=14 (data_len gate never opens — matches golden sample10 all-NaN)", () => {
    const state: Parameters<typeof dmi>[0] = {};
    const high = [102, 103, 104, 103, 105, 106, 107, 106, 108, 109];
    const low = [99, 100, 101, 100, 102, 103, 104, 103, 105, 106];
    const close = [101, 102, 103, 102, 104, 105, 106, 105, 107, 108];
    for (let i = 0; i < close.length; i++) {
      const ph = i === 0 ? NaN : high[i - 1]!;
      const pl = i === 0 ? NaN : low[i - 1]!;
      const pc = i === 0 ? NaN : close[i - 1]!;
      const [p, m, a] = dmi3(state, high[i]!, low[i]!, close[i]!, ph, pl, pc, 14, 14);
      expect(p).toBeNaN();
      expect(m).toBeNaN();
      expect(a).toBeNaN();
    }
    expect(state.smoothTr).toBeUndefined(); // gate never even reaches the smoothTr seed step
  });

  it("the data_len gate opens at exactly bar_index===diLength (0-indexed) regardless of h/l/c validity, for several diLength values", () => {
    // Isolates the gate itself from the downstream h/l/c-NaN and smoothTr-seed steps by feeding
    // valid OHLC throughout and checking exactly which bar first produces a non-gate-blocked result
    // (still NaN there — the smoothTr seed step — but callCount has cleared diLength+1).
    for (const diLength of [1, 2, 3, 5, 9]) {
      const state: Parameters<typeof dmi>[0] = {};
      let gateOpenBar = -1;
      for (let i = 0; i < 15; i++) {
        const before = state.callCount ?? 0;
        dmi3(state, 105, 100, 102, 104, 99, 101, diLength, 2);
        if (before + 1 >= diLength + 1 && gateOpenBar === -1) gateOpenBar = i;
      }
      expect(gateOpenBar).toBe(diLength);
    }
  });

  it("advances only callCount (mirroring pine2py's unconditional data_len growth) and leaves every other field untouched on a NaN bar after the gate has opened", () => {
    // dmi.py computes `data_len = len(close)` (and checks it) *before* ever touching h/l/c or the
    // ta_state dict, and pine2py's push_bar() grows `close` on every bar regardless of NaN content —
    // so unlike sar (whose entire state, including its own bar counter, is skipped on any NaN),
    // dmi's callCount must advance even on a gated-out NaN bar; only the smoothTr/smoothPlus/
    // smoothMinus/adx fields (which sit behind the NaN check) stay frozen.
    const state: Parameters<typeof dmi>[0] = {};
    // clear the data_len gate (diLength=2) and reach the post-seed blending phase
    dmi3(state, 102, 99, 101, NaN, NaN, NaN, 2, 2);
    dmi3(state, 103, 100, 102, 102, 99, 101, 2, 2);
    dmi3(state, 104, 101, 103, 103, 100, 102, 2, 2);
    const snapshot = { ...state };
    const [pNaN, mNaN, aNaN] = dmi3(state, NaN, 102, 105, 104, 101, 103, 2, 2);
    expect(pNaN).toBeNaN();
    expect(mNaN).toBeNaN();
    expect(aNaN).toBeNaN();
    expect(state.callCount).toBe(snapshot.callCount! + 1); // the gate counter DOES advance on a NaN bar
    expect(state.smoothTr).toBe(snapshot.smoothTr); // but the post-gate smoothing state is untouched
    expect(state.smoothPlus).toBe(snapshot.smoothPlus);
    expect(state.smoothMinus).toBe(snapshot.smoothMinus);
    expect(state.adx).toEqual(snapshot.adx);
    const [pResume, mResume] = dmi3(state, 106, 103, 107, 104, 101, 103, 2, 2);
    const freshState: Parameters<typeof dmi>[0] = {};
    dmi3(freshState, 102, 99, 101, NaN, NaN, NaN, 2, 2);
    dmi3(freshState, 103, 100, 102, 102, 99, 101, 2, 2);
    dmi3(freshState, 104, 101, 103, 103, 100, 102, 2, 2);
    const [pNoGap, mNoGap] = dmi3(freshState, 106, 103, 107, 104, 101, 103, 2, 2);
    expect(pResume).toBeCloseTo(pNoGap, 9); // the gap bar is fully invisible to the smoothing trajectory
    expect(mResume).toBeCloseTo(mNoGap, 9);
  });

  it("seeds smoothTr/smoothPlus/smoothMinus from the raw TR/+DM/-DM of the first bar past the gate, and returns the NaN triple without touching adx state", () => {
    const state: Parameters<typeof dmi>[0] = {};
    // diLength=1 so the gate opens on bar0 itself (callCount=1 >= diLength+1=2 is false actually;
    // need callCount>=2, so gate opens at bar1) — use diLength=1 and inspect bar1 (the seed bar).
    dmi3(state, 102, 99, 101, NaN, NaN, NaN, 1, 2); // bar0: gated (callCount=1 < 2)
    const [p, m, a] = dmi3(state, 105, 100, 103, 102, 99, 101, 1, 2); // bar1: gate open, seeds smoothTr
    expect(p).toBeNaN();
    expect(m).toBeNaN();
    expect(a).toBeNaN();
    // tr = max(105-100, |105-101|, |100-101|) = max(5,4,1) = 5; up=105-102=3, down=99-100=-1 -> plusDm=3, minusDm=0
    expect(state.smoothTr).toBe(5);
    expect(state.smoothPlus).toBe(3);
    expect(state.smoothMinus).toBe(0);
    expect(state.adx).toBeUndefined(); // adx-related fields never touched during the seed bar
  });

  it("dx falls back to 0 (not NaN) when plusDi+minusDi<=0 (flat trend, no directional movement)", () => {
    // high constant, low constant, close constant -> up_move=down_move=0 both bars -> plusDm=minusDm=0
    // every bar -> smoothPlus/smoothMinus converge to 0 -> plusDi=minusDi=0 -> diSum=0 -> dx=0 (not NaN)
    const state: Parameters<typeof dmi>[0] = {};
    const high = new Array(8).fill(100);
    const low = new Array(8).fill(98);
    const close = new Array(8).fill(99);
    let lastAdx = NaN;
    for (let i = 0; i < high.length; i++) {
      const ph = i === 0 ? NaN : high[i - 1]!;
      const pl = i === 0 ? NaN : low[i - 1]!;
      const pc = i === 0 ? NaN : close[i - 1]!;
      const [p, m, a] = dmi3(state, high[i]!, low[i]!, close[i]!, ph, pl, pc, 2, 2);
      if (!Number.isNaN(a)) lastAdx = a;
      if (i >= 4) {
        expect(p).toBeCloseTo(0, 9);
        expect(m).toBeCloseTo(0, 9);
      }
    }
    expect(lastAdx).toBeCloseTo(0, 9); // dx was always exactly 0, never NaN, so adx converges to 0
  });

  it("keeps independent state across two call sites", () => {
    const stateA: Parameters<typeof dmi>[0] = {};
    const stateB: Parameters<typeof dmi>[0] = {};
    dmi3(stateA, 102, 99, 101, 101, 98, 100, 2, 2);
    dmi3(stateA, 103, 100, 102, 102, 99, 101, 2, 2);
    const [vB] = dmi3(stateB, 6, 3, 5, 5, 2, 4, 2, 2); // stateB's own gate still fresh
    expect(vB).toBeNaN();
    expect(stateA.callCount).not.toBe(stateB.callCount);
  });

  it("reuses the same scratch array across calls without allocating (values overwritten in place)", () => {
    const state: Parameters<typeof dmi>[0] = {};
    const scratch = new Float64Array(3);
    dmi(state, 102, 99, 101, NaN, NaN, NaN, 2, 2, scratch);
    expect(scratch[0]).toBeNaN(); // callCount=1 < diLength+1=3 — gate blocked
    dmi(state, 103, 100, 102, 102, 99, 101, 2, 2, scratch);
    expect(scratch[0]).toBeNaN(); // callCount=2 < 3 — still gate blocked
    dmi(state, 104, 101, 103, 103, 100, 102, 2, 2, scratch);
    expect(scratch[0]).toBeNaN(); // callCount=3 — gate just opened, but this bar only seeds smoothTr
    dmi(state, 105, 102, 104, 104, 101, 103, 2, 2, scratch);
    expect(scratch[0]).not.toBeNaN(); // first post-seed blend — 같은 배열 인스턴스에 덮어써졌다
  });

  it("matches a from-scratch literal port of dmi.py (growing len(close) reproduced via a push-count field) across NaN gaps, degenerate params, and a 5,000-sample fuzz", () => {
    function mulberry32(seed: number) {
      return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    // literal port of pine2py dmi.py, independently re-derived (snake_case, dmi.py field/line order)
    // rather than reused from the implementation under test. `data_len` is reproduced as a counter
    // that increments unconditionally every call, mirroring context.data.close's per-bar push().
    function bruteRun(
      highs: number[],
      lows: number[],
      closes: number[],
      diLength: number,
      adxSmoothing: number,
    ): [number, number, number][] {
      const s: {
        data_len: number;
        smooth_tr?: number;
        smooth_plus?: number;
        smooth_minus?: number;
        adx_values?: number[];
        adx?: number;
      } = { data_len: 0 };
      const out: [number, number, number][] = [];
      for (let i = 0; i < closes.length; i++) {
        s.data_len += 1;
        if (s.data_len < diLength + 1) {
          out.push([NaN, NaN, NaN]);
          continue;
        }
        const h = highs[i]!;
        const l = lows[i]!;
        const c = closes[i]!;
        const ph = i === 0 ? NaN : highs[i - 1]!;
        const pl = i === 0 ? NaN : lows[i - 1]!;
        const pc = i === 0 ? NaN : closes[i - 1]!;
        if ([h, l, c, ph, pl, pc].some(Number.isNaN)) {
          out.push([NaN, NaN, NaN]);
          continue;
        }
        const tr_val = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        const up_move = h - ph;
        const down_move = pl - l;
        const plus_dm = up_move > down_move && up_move > 0 ? up_move : 0.0;
        const minus_dm = down_move > up_move && down_move > 0 ? down_move : 0.0;
        if (s.smooth_tr === undefined) {
          s.smooth_tr = tr_val;
          s.smooth_plus = plus_dm;
          s.smooth_minus = minus_dm;
          s.adx_values = [];
          s.adx = NaN;
          out.push([NaN, NaN, NaN]);
          continue;
        }
        const alpha = 1.0 / diLength;
        s.smooth_tr = alpha * tr_val + (1 - alpha) * s.smooth_tr;
        s.smooth_plus = alpha * plus_dm + (1 - alpha) * s.smooth_plus!;
        s.smooth_minus = alpha * minus_dm + (1 - alpha) * s.smooth_minus!;
        const str_val = s.smooth_tr;
        if (str_val === 0) {
          out.push([NaN, NaN, NaN]);
          continue;
        }
        const plus_di = (100.0 * s.smooth_plus!) / str_val;
        const minus_di = (100.0 * s.smooth_minus!) / str_val;
        const di_sum = plus_di + minus_di;
        const dx = di_sum > 0 ? (Math.abs(plus_di - minus_di) / di_sum) * 100.0 : 0.0;
        if (Number.isNaN(s.adx!)) {
          s.adx_values!.push(dx);
          if (s.adx_values!.length >= adxSmoothing) {
            const last = s.adx_values!.slice(-adxSmoothing);
            s.adx = last.reduce((a, b) => a + b, 0) / adxSmoothing;
          }
        } else {
          const adx_alpha = 1.0 / adxSmoothing;
          s.adx = adx_alpha * dx + (1 - adx_alpha) * s.adx!;
        }
        out.push([plus_di, minus_di, Number.isNaN(s.adx!) ? NaN : s.adx!]);
      }
      return out;
    }
    for (const [diLength, adxSmoothing, seed] of [
      [3, 2, 8001],
      [5, 3, 8002],
      [1, 1, 8003],
      [9, 7, 8004],
    ] as const) {
      const rng = mulberry32(seed);
      const n = 5000;
      const closes: number[] = [];
      const highs: number[] = [];
      const lows: number[] = [];
      let base = 100;
      for (let i = 0; i < n; i++) {
        if (rng() < 0.02) {
          closes.push(NaN);
          highs.push(rng() < 0.5 ? NaN : base + 1);
          lows.push(rng() < 0.5 ? NaN : base - 1);
          continue;
        }
        base += (rng() - 0.5) * 4;
        const c = rng() < 0.05 ? base : base + (rng() - 0.5) * 2;
        closes.push(c);
        highs.push(Math.max(c, base) + rng() * 2);
        lows.push(Math.min(c, base) - rng() * 2);
      }
      const expected = bruteRun(highs, lows, closes, diLength, adxSmoothing);
      const state: Parameters<typeof dmi>[0] = {};
      for (let i = 0; i < n; i++) {
        const ph = i === 0 ? NaN : highs[i - 1]!;
        const pl = i === 0 ? NaN : lows[i - 1]!;
        const pc = i === 0 ? NaN : closes[i - 1]!;
        const [p, m, a] = dmi3(state, highs[i]!, lows[i]!, closes[i]!, ph, pl, pc, diLength, adxSmoothing);
        const [ep, em, ea] = expected[i]!;
        if (Number.isNaN(ep)) expect(p).toBeNaN();
        else expect(p).toBeCloseTo(ep, 9);
        if (Number.isNaN(em)) expect(m).toBeNaN();
        else expect(m).toBeCloseTo(em, 9);
        if (Number.isNaN(ea)) expect(a).toBeNaN();
        else expect(a).toBeCloseTo(ea, 9);
      }
    }
  });
});

describe("ta.sum (math.sum runtime, TA_REGISTRY.sum dispatch:'math')", () => {
  it("sums a full window once length values have been pushed", () => {
    const state: Parameters<typeof sum>[0] = {};
    expect(sum(state, 10, 3)).toBe(10);
    expect(sum(state, 20, 3)).toBe(30);
    expect(sum(state, 30, 3)).toBe(60);
    // 4th push evicts the first(10): window is now [20,30,40].
    expect(sum(state, 40, 3)).toBe(90);
  });

  it("na values contribute 0 (no poisoning, unlike sma) — an embedded na still leaves a finite sum", () => {
    const state: Parameters<typeof sum>[0] = {};
    sum(state, 10, 3); // window [10]
    sum(state, NaN, 3); // window [10, NaN] -> na contributes 0
    expect(sum(state, 20, 3)).toBe(30); // window [10, NaN, 20] -> 10+0+20
    // next push evicts the leading 10 (not the na) — window [NaN, 20, 30].
    expect(sum(state, 30, 3)).toBe(50);
  });

  it("returns 0 (not NaN) when the entire window is na", () => {
    const state: Parameters<typeof sum>[0] = {};
    expect(sum(state, NaN, 2)).toBe(0);
    expect(sum(state, NaN, 2)).toBe(0);
  });

  it("sums whatever has been pushed so far when length exceeds the number of calls made (no poisoning from the NaN-primed unwritten slots)", () => {
    const state: Parameters<typeof sum>[0] = {};
    expect(sum(state, 5, 100)).toBe(5);
    expect(sum(state, 7, 100)).toBe(12);
    expect(sum(state, 3, 100)).toBe(15);
  });

  it("length=1 degenerates to the current value every call", () => {
    const state: Parameters<typeof sum>[0] = {};
    expect(sum(state, 5, 1)).toBe(5);
    expect(sum(state, 9, 1)).toBe(9);
    expect(sum(state, NaN, 1)).toBe(0);
  });

  it("independent states don't share a buffer (regression guard, same pattern as ta.cmo)", () => {
    const stateA: Parameters<typeof sum>[0] = {};
    const stateB: Parameters<typeof sum>[0] = {};
    sum(stateA, 10, 2);
    sum(stateA, 20, 2);
    expect(sum(stateB, 100, 2)).toBe(100);
  });

  it("matches a brute-force windowed na-skip sum over a random fuzz (5,000 samples, length 1/3/7)", () => {
    let seed = 24601;
    function rng() {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    for (const length of [1, 3, 7]) {
      const values: number[] = [];
      for (let i = 0; i < 5000; i++) values.push(rng() < 0.1 ? NaN : rng() * 200 - 100);

      const state: Parameters<typeof sum>[0] = {};
      for (let i = 0; i < values.length; i++) {
        const actual = sum(state, values[i]!, length);
        let expected = 0;
        for (let j = Math.max(0, i - length + 1); j <= i; j++) {
          const v = values[j]!;
          if (!Number.isNaN(v)) expected += v;
        }
        expect(actual).toBeCloseTo(expected, 6);
      }
    }
  });
});

// ── ta.random (math.random runtime, TA_REGISTRY.random dispatch:'math', C120) ──────────────
// pine2py math.random delegates to Python's global Mersenne Twister — bit-parity oracle
// verification is structurally impossible (analyzer.ts TA_REGISTRY.random / runtime/ta.ts
// random() 주석 참조). These tests hand-verify the pine2js-original xorshift32 design instead:
// range containment, seed reproducibility, and call-site independence — NOT specific "correct"
// values (there is no oracle-defined correct value for this function).
describe("ta.random (math.random runtime, TA_REGISTRY.random dispatch:'math', C120)", () => {
  it("defaults to the [0, 1) range when min/max/seed are all omitted", () => {
    const state: Parameters<typeof random>[0] = {};
    for (let i = 0; i < 500; i++) {
      const v = random(state, undefined, undefined, undefined, 0);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("stays within an arbitrary [min, max) range across many draws (2,000 samples)", () => {
    const state: Parameters<typeof random>[0] = {};
    for (let i = 0; i < 2000; i++) {
      const v = random(state, -50, 50, NaN, 3);
      expect(v).toBeGreaterThanOrEqual(-50);
      expect(v).toBeLessThan(50);
    }
  });

  it("a given seed reseeds the call-site state and reproduces the exact same draw every time (single-shot determinism)", () => {
    const stateA: Parameters<typeof random>[0] = {};
    const stateB: Parameters<typeof random>[0] = {};
    const a1 = random(stateA, 0, 1, 99, 0);
    const a2 = random(stateA, 0, 1, 99, 0); // re-seeding with the same seed reproduces the value
    const b1 = random(stateB, 0, 1, 99, 0); // a fresh independent state with the same seed also matches
    expect(a1).toBe(a2);
    expect(a1).toBe(b1);
    expect(a1).toBeCloseTo(0.220791295170784, 12);
  });

  it("omitting seed (NaN) after an explicit seed continues the xorshift stream instead of re-seeding", () => {
    const state: Parameters<typeof random>[0] = {};
    const a = random(state, 0, 1, 99, 0);
    const b = random(state, 0, 1, NaN, 0);
    const c = random(state, 0, 1, undefined, 0);
    expect(a).toBeCloseTo(0.220791295170784, 12);
    expect(b).toBeCloseTo(0.5541597432456911, 12);
    expect(c).toBeCloseTo(0.24066934804432094, 12);
    expect(b).not.toBe(a);
    expect(c).not.toBe(b);
  });

  it("different call-site slots (site) with no seed ever given produce different deterministic sequences", () => {
    const stateSite0: Parameters<typeof random>[0] = {};
    const stateSite1: Parameters<typeof random>[0] = {};
    const v0 = random(stateSite0, 0, 1, NaN, 0);
    const v1 = random(stateSite1, 0, 1, NaN, 1);
    expect(v0).toBeCloseTo(0.1967024791520089, 12);
    expect(v1).toBeCloseTo(0.9361879071220756, 12);
    expect(v0).not.toBe(v1);
  });

  it("the same call-site (site) with no seed ever given reproduces the same sequence across independent states (full engine-run reproducibility)", () => {
    const runA: Parameters<typeof random>[0] = {};
    const runB: Parameters<typeof random>[0] = {};
    const seqA = [random(runA, 0, 1, NaN, 5), random(runA, 0, 1, NaN, 5), random(runA, 0, 1, NaN, 5)];
    const seqB = [random(runB, 0, 1, NaN, 5), random(runB, 0, 1, NaN, 5), random(runB, 0, 1, NaN, 5)];
    expect(seqA).toEqual(seqB);
  });

  it("na min or na max propagates to NaN via plain arithmetic (no explicit guard needed, GOAL.md arithmetic na propagation)", () => {
    const state: Parameters<typeof random>[0] = {};
    expect(random(state, NaN, 1, 7, 0)).toBeNaN();
    expect(random(state, 0, NaN, 7, 0)).toBeNaN();
  });

  it("a na-producing call still advances the internal PRNG state (state isn't frozen by na inputs)", () => {
    const stateA: Parameters<typeof random>[0] = {};
    const stateB: Parameters<typeof random>[0] = {};
    random(stateA, 0, 1, 7, 0); // seeds+advances both identically first
    random(stateB, 0, 1, 7, 0);
    random(stateA, NaN, 1, NaN, 0); // stateA advances again (na result)
    const nextA = random(stateA, 0, 1, NaN, 0);
    const nextB = random(stateB, 0, 1, NaN, 0); // stateB only advanced once so far
    expect(nextA).not.toBe(nextB);
  });

  it("independent states at the same declared site don't share PRNG state (regression guard, same pattern as ta.sum)", () => {
    const stateA: Parameters<typeof random>[0] = {};
    const stateB: Parameters<typeof random>[0] = {};
    random(stateA, 0, 1, 42, 0);
    random(stateA, 0, 1, undefined, 0);
    const fresh = random(stateB, 0, 1, 42, 0);
    expect(fresh).toBeCloseTo(0.8455176914576441, 12); // unaffected by stateA's extra advance
  });
});

describe("numeric helpers", () => {
  it("pineDiv returns NaN on division by zero", () => {
    expect(pineDiv(1, 0)).toBeNaN();
    expect(pineDiv(10, 2)).toBe(5);
  });

  it("pineMod returns NaN on modulo by zero", () => {
    expect(pineMod(1, 0)).toBeNaN();
    expect(pineMod(10, 3)).toBe(1);
  });

  // ── idiv(a, b) — int/int trunc division (GOAL.md "int/int→rt.idiv(trunc)") ────

  it("idiv truncates toward zero for exact and inexact positive quotients", () => {
    expect(idiv(6, 2)).toBe(3);
    expect(idiv(7, 2)).toBe(3);
  });

  it("idiv truncates toward zero (not floor) for negative operands", () => {
    expect(idiv(-7, 2)).toBe(-3); // floor(-3.5) would be -4 — trunc must give -3
    expect(idiv(7, -2)).toBe(-3);
    expect(idiv(-7, -2)).toBe(3);
  });

  it("idiv returns NaN on division by zero, matching pineDiv's 0-division safety", () => {
    expect(idiv(5, 0)).toBeNaN();
    expect(idiv(0, 0)).toBeNaN();
  });

  it("idiv propagates NaN operands", () => {
    expect(idiv(NaN, 2)).toBeNaN();
    expect(idiv(2, NaN)).toBeNaN();
  });

  // ── barIndexHistory(idx, offset) — bar_index[동적 오프셋] 전용(C305) ──────────────────
  it("barIndexHistory returns idx - offset when offset is within range", () => {
    expect(barIndexHistory(10, 3)).toBe(7);
    expect(barIndexHistory(5, 0)).toBe(5);
    expect(barIndexHistory(5, 5)).toBe(0);
  });

  it("barIndexHistory returns NaN when offset exceeds idx (not enough history yet, Series.get() parity)", () => {
    expect(barIndexHistory(2, 3)).toBeNaN();
    expect(barIndexHistory(0, 1)).toBeNaN();
  });

  it("barIndexHistory returns NaN for a negative offset (a 'future' bar_index is not well-defined)", () => {
    expect(barIndexHistory(10, -1)).toBeNaN();
  });

  it("barIndexHistory truncates a non-integer runtime offset toward zero (Series.get() parity)", () => {
    expect(barIndexHistory(10, 2.9)).toBe(8);
  });

  it("barIndexHistory propagates NaN offset (na guard, !(NaN>=0) is true)", () => {
    expect(barIndexHistory(10, NaN)).toBeNaN();
  });

  // ── histConst(value, idx, offset) — 리플레이 상수(last_bar_index/last_bar_time/timenow)의
  // 동적 오프셋 히스토리 전용(C368) — barIndexHistory와 같은 trunc+긍정형 가드, 값만 상수.
  it("histConst returns the constant when the offset bar exists", () => {
    expect(histConst(42, 10, 3)).toBe(42);
    expect(histConst(42, 5, 0)).toBe(42);
    expect(histConst(42, 5, 5)).toBe(42);
  });

  it("histConst returns NaN during warmup (idx < offset), for negative and for NaN offsets", () => {
    expect(histConst(42, 2, 3)).toBeNaN();
    expect(histConst(42, 10, -1)).toBeNaN();
    expect(histConst(42, 10, NaN)).toBeNaN();
  });

  it("histConst truncates a non-integer runtime offset toward zero (Series.get() parity)", () => {
    expect(histConst(42, 10, 2.9)).toBe(42);
    expect(histConst(42, 2, 2.9)).toBe(42);
  });

  // ── histGet(currentValue, slot, offset) — histSlot 대상 동적 오프셋 전용(C365) ──────────
  // slot: 3바 진행(cursor=2), bar0=10/bar1=20 기록, bar2는 미기록(NaN) — 읽는 시점의 histSlot
  // 상태 그대로(record는 top-level 문장 종료 후).
  function makeHistSlot(): Series {
    const s = Series.preallocate(5);
    s.advance();
    s.record(10);
    s.advance();
    s.record(20);
    s.advance();
    return s;
  }

  it("histGet returns currentValue verbatim for offset 0 (record has not run yet this bar)", () => {
    expect(histGet(99, makeHistSlot(), 0)).toBe(99);
  });

  it("histGet delegates to slot.get for offset >= 1", () => {
    expect(histGet(99, makeHistSlot(), 1)).toBe(20);
    expect(histGet(99, makeHistSlot(), 2)).toBe(10);
  });

  it("histGet returns NaN when the offset exceeds recorded history (warmup)", () => {
    expect(histGet(99, makeHistSlot(), 3)).toBeNaN();
  });

  it("histGet returns NaN for negative offsets (no lookahead)", () => {
    expect(histGet(99, makeHistSlot(), -1)).toBeNaN();
  });

  it("histGet propagates a NaN offset (na guard, positive-form comparison)", () => {
    expect(histGet(99, makeHistSlot(), NaN)).toBeNaN();
  });

  it("histGet truncates non-integer offsets toward zero (0.9 → currentValue, 1.9 → slot.get(1))", () => {
    expect(histGet(99, makeHistSlot(), 0.9)).toBe(99);
    expect(histGet(99, makeHistSlot(), 1.9)).toBe(20);
  });

  it("na() detects NaN for numbers and null for references", () => {
    expect(na(NaN)).toBe(true);
    expect(na(0)).toBe(false);
    expect(na(null)).toBe(true);
    expect(na("x")).toBe(false);
  });

  it("round() rounds .5 away from zero, not toward +Infinity like Math.round", () => {
    expect(round(2.5)).toBe(3);
    expect(round(-2.5)).toBe(-3); // Math.round(-2.5) would give -2 (JS bankers-ish quirk)
    expect(round(-0.5)).toBe(-1); // Math.round(-0.5) gives -0 in JS — the exact bug this fixes
  });

  it("round() rounds non-half values to the nearest integer normally", () => {
    expect(round(2.4)).toBe(2);
    expect(round(2.6)).toBe(3);
    expect(round(-2.4)).toBe(-2);
    expect(round(-2.6)).toBe(-3);
  });

  it("round() with precision rounds to that many decimal places (half away from zero)", () => {
    expect(round(1.25, 1)).toBeCloseTo(1.3, 9);
    expect(round(-1.25, 1)).toBeCloseTo(-1.3, 9);
    expect(round(3.14159, 2)).toBeCloseTo(3.14, 9);
  });

  it("round() passes NaN through unchanged", () => {
    expect(round(NaN)).toBeNaN();
    expect(round(NaN, 2)).toBeNaN();
  });

  it("round() of exactly zero is zero", () => {
    expect(round(0)).toBe(0);
    expect(round(0, 2)).toBe(0);
  });

  // ── round_to_mintick() — math.round_to_mintick (DIVERGENCES.md #14: reuses round()'s
  // half-away-from-zero instead of porting pine2py's Python-round() banker's rounding) ──

  it("round_to_mintick() rounds to the nearest multiple of mintick", () => {
    expect(round_to_mintick(1.234, 0.01)).toBeCloseTo(1.23, 9);
    expect(round_to_mintick(1.236, 0.01)).toBeCloseTo(1.24, 9);
    expect(round_to_mintick(101, 0.25)).toBeCloseTo(101.0, 9);
    expect(round_to_mintick(101.1, 0.25)).toBeCloseTo(101.0, 9);
    expect(round_to_mintick(101.13, 0.25)).toBeCloseTo(101.25, 9);
  });

  it("round_to_mintick() defaults mintick to 0.01 when omitted", () => {
    expect(round_to_mintick(1.234)).toBeCloseTo(round_to_mintick(1.234, 0.01), 9);
  });

  it("round_to_mintick() ties round away from zero, consistent with round() — NOT Python's banker's rounding that pine2py's round_to_mintick delegates to", () => {
    expect(round_to_mintick(2.5, 1)).toBe(3); // Python round(2.5)=2 (banker's) — intentional divergence
    expect(round_to_mintick(-2.5, 1)).toBe(-3); // Python round(-2.5)=-2 (banker's)
    expect(round_to_mintick(4.5, 1)).toBe(5); // Python round(4.5)=4 (banker's)
  });

  it("round_to_mintick() with mintick=1 matches round() with precision 0", () => {
    for (const v of [2.4, 2.6, -2.4, -2.6, 0, 7]) {
      expect(round_to_mintick(v, 1)).toBeCloseTo(round(v), 9);
    }
  });

  it("round_to_mintick() passes value through unchanged when mintick <= 0", () => {
    expect(round_to_mintick(5.678, 0)).toBe(5.678);
    expect(round_to_mintick(5.678, -1)).toBe(5.678);
  });

  it("round_to_mintick() passes NaN through unchanged", () => {
    expect(round_to_mintick(NaN)).toBeNaN();
    expect(round_to_mintick(NaN, 0.25)).toBeNaN();
  });

  it("abs() returns the magnitude regardless of sign", () => {
    expect(abs(-3.5)).toBe(3.5);
    expect(abs(3.5)).toBe(3.5);
    expect(abs(0)).toBe(0);
  });

  it("abs() passes NaN through unchanged", () => {
    expect(abs(NaN)).toBeNaN();
  });

  it("max()/min() return the largest/smallest of 2+ arguments", () => {
    expect(max(1, 5, 3)).toBe(5);
    expect(min(1, 5, 3)).toBe(1);
    expect(max(-2, -8)).toBe(-2);
    expect(min(-2, -8)).toBe(-8);
  });

  it("max()/min() propagate na regardless of argument order (unlike pine2py's Python max()/min(), which is order-dependent: max(nan,5)=nan but max(5,nan)=5)", () => {
    expect(max(NaN, 5)).toBeNaN();
    expect(max(5, NaN)).toBeNaN();
    expect(min(NaN, 5)).toBeNaN();
    expect(min(5, NaN)).toBeNaN();
  });

  // ── clamp() — math.clamp(value, min, max), 배치25 (3) 신규(DIVERGENCES.md #176). pine2py에
  // 대응 구현이 전혀 없는 hand-verified 신규 함수 — max()/min()과 동일하게 인자 중 하나라도 na면
  // na 전파(순수 비교 기반이라 na 시맨틱을 통일하는 것이 자연스러움).

  it("clamp() returns value unchanged when already inside [min, max]", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("clamp() clamps to min when value is below it", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it("clamp() clamps to max when value is above it", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("clamp() works with negative/fractional ranges", () => {
    expect(clamp(-0.5, -1, 1)).toBeCloseTo(-0.5, 9);
    expect(clamp(-2, -1, 1)).toBe(-1);
    expect(clamp(2, -1, 1)).toBe(1);
  });

  it("clamp() propagates na if any of value/min/max is na", () => {
    expect(clamp(NaN, 0, 10)).toBeNaN();
    expect(clamp(5, NaN, 10)).toBeNaN();
    expect(clamp(5, 0, NaN)).toBeNaN();
  });

  // ── avg() — math.avg (pine2py wavealgo.math.avg: skip na args, average the rest; na only if
  // every argument is na — the OPPOSITE na policy from max()/min() above, which propagate na) ──

  it("avg() returns the arithmetic mean of 2+ arguments", () => {
    expect(avg(1, 5, 3)).toBeCloseTo(3, 9);
    expect(avg(2, 8)).toBeCloseTo(5, 9);
    expect(avg(-2, -8)).toBeCloseTo(-5, 9);
  });

  it("avg() skips na arguments and averages only the valid ones (unlike max()/min(), which propagate na)", () => {
    expect(avg(NaN, 5)).toBe(5);
    expect(avg(5, NaN)).toBe(5);
    expect(avg(1, NaN, 5)).toBeCloseTo(3, 9);
  });

  it("avg() returns na when every argument is na", () => {
    expect(avg(NaN, NaN)).toBeNaN();
    expect(avg(NaN, NaN, NaN)).toBeNaN();
  });

  // ── floor()/ceil() — math.floor/math.ceil (JS Math.floor/ceil already NaN-transparent) ──

  it("floor() rounds down toward -Infinity for positive and negative values", () => {
    expect(floor(1.9)).toBe(1);
    expect(floor(-1.1)).toBe(-2); // toward -Infinity, not toward zero
    expect(floor(2)).toBe(2); // exact integer stays unchanged
  });

  it("ceil() rounds up toward +Infinity for positive and negative values", () => {
    expect(ceil(1.1)).toBe(2);
    expect(ceil(-1.9)).toBe(-1); // toward +Infinity, not toward zero
    expect(ceil(2)).toBe(2); // exact integer stays unchanged
  });

  it("floor()/ceil() pass NaN through unchanged", () => {
    expect(floor(NaN)).toBeNaN();
    expect(ceil(NaN)).toBeNaN();
  });

  // ── sqrt() — math.sqrt (negative domain -> NaN, matching pine2py's explicit x<0 guard) ──

  it("sqrt() returns the principal square root for non-negative values", () => {
    expect(sqrt(9)).toBe(3);
    expect(sqrt(0)).toBe(0);
  });

  it("sqrt() returns NaN for negative values (out of domain, like pine2py's explicit guard)", () => {
    expect(sqrt(-4)).toBeNaN();
  });

  it("sqrt() passes NaN through unchanged", () => {
    expect(sqrt(NaN)).toBeNaN();
  });

  // ── pow() — math.pow (variadic-free, exactly 2 args) ──

  it("pow() raises the base to the given exponent, including negative bases with integer exponents", () => {
    expect(pow(2, 10)).toBe(1024);
    expect(pow(-2, 2)).toBe(4);
    expect(pow(2, 0)).toBe(1);
  });

  it("pow() propagates NaN in either operand", () => {
    expect(pow(NaN, 2)).toBeNaN();
    expect(pow(2, NaN)).toBeNaN();
  });

  // ── log()/log10() — pine2py defines x<=0 as NaN; JS Math.log/log10(0) natively give
  // -Infinity instead, so the zero boundary needs an explicit override (negative is already NaN) ──

  it("log()/log10() compute the natural/base-10 logarithm for positive values", () => {
    expect(log(Math.E)).toBeCloseTo(1, 9);
    expect(log10(100)).toBeCloseTo(2, 9);
  });

  it("log()/log10() return NaN (not -Infinity) at exactly zero", () => {
    expect(log(0)).toBeNaN();
    expect(log10(0)).toBeNaN();
  });

  it("log()/log10() return NaN for negative values", () => {
    expect(log(-1)).toBeNaN();
    expect(log10(-1)).toBeNaN();
  });

  it("log()/log10() pass NaN through unchanged", () => {
    expect(log(NaN)).toBeNaN();
    expect(log10(NaN)).toBeNaN();
  });

  // ── exp() — math.exp (Math.exp already NaN-transparent) ──

  it("exp() computes e^x", () => {
    expect(exp(0)).toBe(1);
    expect(exp(1)).toBeCloseTo(Math.E, 9);
  });

  it("exp() passes NaN through unchanged", () => {
    expect(exp(NaN)).toBeNaN();
  });

  // ── sign() — math.sign (explicit 3-way branch to avoid signed-zero leakage, C45-style) ──

  it("sign() returns 1/-1/0 for positive/negative/zero values", () => {
    expect(sign(5)).toBe(1);
    expect(sign(-5)).toBe(-1);
    expect(sign(0)).toBe(0);
  });

  it("sign() normalizes negative zero to a plain (non-signed) zero", () => {
    expect(Object.is(sign(-0), -0)).toBe(false); // would be true if we returned Math.sign(-0) directly
    expect(sign(-0)).toBe(0);
  });

  it("sign() passes NaN through unchanged", () => {
    expect(sign(NaN)).toBeNaN();
  });

  // ── sin()/cos()/tan()/atan() — no domain restriction, Math.* already NaN-transparent ──

  it("sin()/cos()/tan() compute the standard trig functions in radians", () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
    expect(tan(0)).toBe(0);
    expect(sin(Math.PI / 2)).toBeCloseTo(1, 9);
    expect(cos(Math.PI)).toBeCloseTo(-1, 9);
  });

  it("atan() computes the arctangent with no domain restriction", () => {
    expect(atan(0)).toBe(0);
    expect(atan(1)).toBeCloseTo(Math.PI / 4, 9);
    expect(atan(-1)).toBeCloseTo(-Math.PI / 4, 9);
  });

  it("sin()/cos()/tan()/atan() pass NaN through unchanged", () => {
    expect(sin(NaN)).toBeNaN();
    expect(cos(NaN)).toBeNaN();
    expect(tan(NaN)).toBeNaN();
    expect(atan(NaN)).toBeNaN();
  });

  // ── asin()/acos() — domain [-1,1]; out-of-domain returns NaN (JS Math.asin/acos native
  // behavior, unlike Python math.asin/acos which raises ValueError — LIMITATIONS.md) ──

  it("asin()/acos() compute the inverse trig functions inside the [-1,1] domain", () => {
    expect(asin(0)).toBe(0);
    expect(asin(1)).toBeCloseTo(Math.PI / 2, 9);
    expect(acos(1)).toBe(0);
    expect(acos(0)).toBeCloseTo(Math.PI / 2, 9);
  });

  it("asin()/acos() return NaN outside the [-1,1] domain", () => {
    expect(asin(1.5)).toBeNaN();
    expect(asin(-1.5)).toBeNaN();
    expect(acos(1.5)).toBeNaN();
    expect(acos(-1.5)).toBeNaN();
  });

  it("asin()/acos() pass NaN through unchanged", () => {
    expect(asin(NaN)).toBeNaN();
    expect(acos(NaN)).toBeNaN();
  });

  // ── atan2(y, x) — same argument order as pine2py's wavealgo.math.atan2(y, x) ──

  it("atan2() computes the two-argument arctangent across all four quadrants", () => {
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(1, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(atan2(1, 1)).toBeCloseTo(Math.PI / 4, 9);
    expect(atan2(-1, -1)).toBeCloseTo(-3 * Math.PI / 4, 9);
  });

  it("atan2() returns NaN if either argument is NaN", () => {
    expect(atan2(NaN, 1)).toBeNaN();
    expect(atan2(1, NaN)).toBeNaN();
  });

  // ── todegrees()/toradians() — simple linear scale conversion ──

  it("todegrees()/toradians() convert between radians and degrees", () => {
    expect(todegrees(Math.PI)).toBeCloseTo(180, 9);
    expect(todegrees(0)).toBe(0);
    expect(toradians(180)).toBeCloseTo(Math.PI, 9);
    expect(toradians(0)).toBe(0);
  });

  it("todegrees()/toradians() are inverse to each other and pass NaN through unchanged", () => {
    expect(toradians(todegrees(1.23))).toBeCloseTo(1.23, 9);
    expect(todegrees(NaN)).toBeNaN();
    expect(toradians(NaN)).toBeNaN();
  });

  it("nz() returns the default replacement (0) when the value is na and no replacement given", () => {
    expect(nz(NaN)).toBe(0);
  });

  it("nz() returns the given replacement when the value is na", () => {
    expect(nz(NaN, -5)).toBe(-5);
  });

  it("nz() passes a non-na value through unchanged, ignoring the replacement", () => {
    expect(nz(3.5)).toBe(3.5);
    expect(nz(3.5, -5)).toBe(3.5);
    expect(nz(0)).toBe(0);
  });

  // ── pineNot(x) — UnaryOp 'not'의 na 시맨틱(DIVERGENCES.md #4, ROADMAP P2-0) ────

  it("pineNot() negates a true boolean like plain JS '!'", () => {
    expect(pineNot(true)).toBe(false);
  });

  it("pineNot() negates a false boolean like plain JS '!'", () => {
    expect(pineNot(false)).toBe(true);
  });

  it("pineNot() propagates na (NaN) instead of JS '!NaN'===true (TV: 'not na'===na)", () => {
    expect(pineNot(NaN)).toBeNaN();
  });

  // ── pineLt/pineGt/pineLe/pineGe(a, b) — </>/<=/>= 의 na 시맨틱(DIVERGENCES.md #4, C25와 같은
  // 클래스, ROADMAP P2 "C25 발견" 항목): JS `NaN < x`/`NaN > x` 등은 항상 false를 반환해 na가
  // 조용히 사라지지만, TV는 피연산자 중 하나라도 na면 결과도 na다. ──────────────────

  it("pineLt() compares two finite numbers like plain JS '<'", () => {
    expect(pineLt(1, 2)).toBe(true);
    expect(pineLt(2, 1)).toBe(false);
    expect(pineLt(2, 2)).toBe(false);
  });

  it("pineLt() propagates na (NaN) instead of JS 'NaN < x'===false (TV: 'na < x'===na)", () => {
    expect(pineLt(NaN, 2)).toBeNaN();
    expect(pineLt(2, NaN)).toBeNaN();
    expect(pineLt(NaN, NaN)).toBeNaN();
  });

  it("pineGt() compares two finite numbers like plain JS '>'", () => {
    expect(pineGt(2, 1)).toBe(true);
    expect(pineGt(1, 2)).toBe(false);
    expect(pineGt(2, 2)).toBe(false);
  });

  it("pineGt() propagates na (NaN) instead of JS 'NaN > x'===false (TV: 'na > x'===na)", () => {
    expect(pineGt(NaN, 2)).toBeNaN();
    expect(pineGt(2, NaN)).toBeNaN();
    expect(pineGt(NaN, NaN)).toBeNaN();
  });

  it("pineLe() compares two finite numbers like plain JS '<=' (including the equal case)", () => {
    expect(pineLe(1, 2)).toBe(true);
    expect(pineLe(2, 2)).toBe(true);
    expect(pineLe(2, 1)).toBe(false);
  });

  it("pineLe() propagates na (NaN) instead of JS 'NaN <= x'===false (TV: 'na <= x'===na)", () => {
    expect(pineLe(NaN, 2)).toBeNaN();
    expect(pineLe(2, NaN)).toBeNaN();
    expect(pineLe(NaN, NaN)).toBeNaN();
  });

  it("pineGe() compares two finite numbers like plain JS '>=' (including the equal case)", () => {
    expect(pineGe(2, 1)).toBe(true);
    expect(pineGe(2, 2)).toBe(true);
    expect(pineGe(1, 2)).toBe(false);
  });

  it("pineGe() propagates na (NaN) instead of JS 'NaN >= x'===false (TV: 'na >= x'===na)", () => {
    expect(pineGe(NaN, 2)).toBeNaN();
    expect(pineGe(2, NaN)).toBeNaN();
    expect(pineGe(NaN, NaN)).toBeNaN();
  });

  // ── pineAnd/pineOr(a, b) — and/or의 na 시맨틱(C69, ROADMAP P2 "C67 발견" 항목). 이 둘은
  // pineLt류("피연산자 중 하나라도 na면 무조건 na")와 다른 패턴이다 — TV는 진짜 Kleene 3치 논리를
  // 쓴다: false는 AND를, true는 OR를 다른 피연산자의 na 여부와 무관하게 절대적으로 결정한다
  // (pine2py docs/pinescript/03-operators.md L60-62, 09-edge-cases.md L5-11이 명시하는 시맨틱 —
  // pine2py 자체 codegen은 Python 네이티브 and/or를 그대로 방출해 이 문서를 따르지 않으므로
  // 오라클 검증 불가, hand-verified). 아래는 {true, false, na} x {true, false, na} 9칸 전체 대조.

  it("pineAnd() matches plain boolean AND when neither operand is na", () => {
    expect(pineAnd(true, true)).toBe(true);
    expect(pineAnd(true, false)).toBe(false);
    expect(pineAnd(false, true)).toBe(false);
    expect(pineAnd(false, false)).toBe(false);
  });

  it("pineAnd(): false absolutely decides AND even when the other operand is na (TV 'false and na'===false — native JS '&&' would return NaN here, since NaN is falsy and short-circuits to the na operand)", () => {
    expect(pineAnd(false, NaN)).toBe(false);
    expect(pineAnd(NaN, false)).toBe(false);
  });

  it("pineAnd(): na propagates only when neither operand is false (TV 'true and na'===na)", () => {
    expect(pineAnd(true, NaN)).toBeNaN();
    expect(pineAnd(NaN, true)).toBeNaN();
    expect(pineAnd(NaN, NaN)).toBeNaN();
  });

  it("pineOr() matches plain boolean OR when neither operand is na", () => {
    expect(pineOr(true, true)).toBe(true);
    expect(pineOr(true, false)).toBe(true);
    expect(pineOr(false, true)).toBe(true);
    expect(pineOr(false, false)).toBe(false);
  });

  it("pineOr(): true absolutely decides OR even when the other operand is na (TV 'true or na'===true — native JS '||' already gets this one right by luck, unlike its AND counterpart)", () => {
    expect(pineOr(true, NaN)).toBe(true);
    expect(pineOr(NaN, true)).toBe(true);
  });

  it("pineOr(): na propagates only when neither operand is true (TV 'false or na'===na)", () => {
    expect(pineOr(false, NaN)).toBeNaN();
    expect(pineOr(NaN, false)).toBeNaN();
    expect(pineOr(NaN, NaN)).toBeNaN();
  });

  // C449 회귀 가드: bool 값이 Float64Array 슬롯(top-level '=' 로컬/UDF 히스토리 C363/C364,
  // request.security expr 캐시 C367+)을 한 번 왕복하면 true/false가 1/0으로 강제변환된다 — 이
  // 함수들의 원래 구현은 원시 boolean만(`===false`/`===true`) 인식해 1/0을 걸러내지 못했고, 그
  // 결과 예를 들어 `pineAnd(true, 0)`이 (0이 어느 분기에도 안 걸려 na-분기까지 떨어져) 잘못된
  // `true`를 반환했다(실제 재현: scratch history-round-trip 스크립트로 request.security 없이도
  // 확인됨). 아래는 numeric 0/1이 boolean false/true와 정확히 같은 결과를 내는지 직접 대조한다.
  it("pineAnd() treats a Float64Array-round-tripped numeric 0/1 identically to boolean false/true", () => {
    expect(pineAnd(1, 1)).toBe(true);
    expect(pineAnd(1, 0)).toBe(false);
    expect(pineAnd(0, 1)).toBe(false);
    expect(pineAnd(0, 0)).toBe(false);
    expect(pineAnd(true, 0)).toBe(false);
    expect(pineAnd(0, true)).toBe(false);
    expect(pineAnd(false, 1)).toBe(false);
    expect(pineAnd(1, false)).toBe(false);
  });

  it("pineAnd(): na still propagates correctly when the other operand is the numeric encoding of true (not just boolean true)", () => {
    expect(pineAnd(1, NaN)).toBeNaN();
    expect(pineAnd(NaN, 1)).toBeNaN();
    expect(pineAnd(0, NaN)).toBe(false);
    expect(pineAnd(NaN, 0)).toBe(false);
  });

  it("pineOr() treats a Float64Array-round-tripped numeric 0/1 identically to boolean false/true", () => {
    expect(pineOr(1, 1)).toBe(true);
    expect(pineOr(1, 0)).toBe(true);
    expect(pineOr(0, 1)).toBe(true);
    expect(pineOr(0, 0)).toBe(false);
    expect(pineOr(true, 0)).toBe(true);
    expect(pineOr(0, true)).toBe(true);
    expect(pineOr(false, 1)).toBe(true);
    expect(pineOr(1, false)).toBe(true);
  });

  it("pineOr(): na still propagates correctly when the other operand is the numeric encoding of false (not just boolean false)", () => {
    expect(pineOr(0, NaN)).toBeNaN();
    expect(pineOr(NaN, 0)).toBeNaN();
    expect(pineOr(1, NaN)).toBe(true);
    expect(pineOr(NaN, 1)).toBe(true);
  });

  // ── concat(a, b) — '+' 문자열 연결(na-safe), "na/수치 2c-ii" ────

  it("concat() joins two strings", () => {
    expect(concat("foo", "bar")).toBe("foobar");
  });

  it("concat() stringifies a non-string operand (JS native template coercion, not Pine display formatting)", () => {
    expect(concat("n=", 5)).toBe("n=5");
    expect(concat(5, "=n")).toBe("5=n");
  });

  it("concat() returns null (na) when either operand is a NaN number", () => {
    expect(concat("prefix", NaN)).toBe(null);
    expect(concat(NaN, "suffix")).toBe(null);
  });

  it("concat() returns null (na) when either operand is a null string (reference-type na)", () => {
    expect(concat("prefix", null)).toBe(null);
    expect(concat(null, "suffix")).toBe(null);
  });

  it("concat() does NOT produce the JS native 'xnull'/'xNaN' string leak (the exact bug this fixes)", () => {
    // 네이티브 JS `+`라면 "prefix" + null === "prefixnull", "prefix" + NaN === "prefixNaN" —
    // MEMORY.md Pitfalls "string + null → 'xnull' 문자열이 됨" 함정을 rt.concat이 차단.
    expect(concat("prefix", null)).not.toBe("prefixnull");
    expect(concat("prefix", NaN)).not.toBe("prefixNaN");
  });

  // ── str.length/contains/startswith/endswith/pos (C76, str.* 착수 첫 슬라이스) ────

  it("length() returns the string's character count", () => {
    expect(length("hello")).toBe(5);
    expect(length("")).toBe(0);
  });

  it("length() returns 0 (not na) for a null source — literal port of pine2py's `if source else 0` guard", () => {
    expect(length(null)).toBe(0);
  });

  it("contains()/startswith()/endswith() match native JS String equivalents for plain (non-na) inputs", () => {
    expect(contains("hello world", "wor")).toBe(true);
    expect(contains("hello world", "xyz")).toBe(false);
    expect(startswith("hello world", "hello")).toBe(true);
    expect(startswith("hello world", "world")).toBe(false);
    expect(endswith("hello world", "world")).toBe(true);
    expect(endswith("hello world", "hello")).toBe(false);
  });

  it("pos() returns the 0-based index of the first match, or -1 if not found (matches Python str.find exactly)", () => {
    expect(pos("hello world", "wor")).toBe(6);
    expect(pos("hello world", "xyz")).toBe(-1);
    expect(pos("hello world", "")).toBe(0);
  });

  it("contains()/startswith()/endswith()/pos() propagate na (NaN) when source or target is a null string", () => {
    // pine2py str_funcs.contains/startswith/endswith/pos have no None-guard and would crash
    // (AttributeError/TypeError) on na input — unlike length()'s deliberate `if source else 0`
    // fallback, there is no pine2py-defined behavior here to literal-port. GOAL.md na-safety
    // principle applied instead: any reference-type na (null) argument propagates to na (NaN,
    // since these return bool/int — same numeric-na convention as pineAnd/pineLt). Not oracle-
    // verifiable (pine2py itself can't produce a golden for this path) — hand-verified only.
    expect(contains(null, "x")).toBeNaN();
    expect(contains("x", null)).toBeNaN();
    expect(startswith(null, "x")).toBeNaN();
    expect(startswith("x", null)).toBeNaN();
    expect(endswith(null, "x")).toBeNaN();
    expect(endswith("x", null)).toBeNaN();
    expect(pos(null, "x")).toBeNaN();
    expect(pos("x", null)).toBeNaN();
  });

  // ── str.lower/upper/trim/replace_all/substring/repeat (C77, string 반환 함수) ────

  it("lower()/upper() match native JS case-folding equivalents", () => {
    expect(lower("HeLLo World")).toBe("hello world");
    expect(upper("HeLLo World")).toBe("HELLO WORLD");
  });

  it("trim() strips leading/trailing whitespace (including tabs/newlines) like Python str.strip()", () => {
    expect(trim("  hi there  ")).toBe("hi there");
    expect(trim("\t\n hi \r\n")).toBe("hi");
  });

  it("replace_all() replaces every occurrence (Python str.replace() with no count is all-occurrences)", () => {
    expect(replace_all("aaa", "a", "bb")).toBe("bbbbbb");
    expect(replace_all("abc", "x", "y")).toBe("abc");
  });

  it("replace_all() with an empty target inserts the replacement between every character (matches Python)", () => {
    expect(replace_all("abc", "", "X")).toBe("XaXbXcX");
  });

  it("substring() matches Python slice semantics for negative/out-of-range/reversed bounds", () => {
    expect(substring("hello", 1, 3)).toBe("el");
    expect(substring("hello", -3, -1)).toBe("llo");
    expect(substring("hello", -10, 3)).toBe("hel");
    expect(substring("hello", 0, 100)).toBe("hello");
    expect(substring("hello", 100)).toBe("");
    expect(substring("hello", -100)).toBe("hello");
    expect(substring("hello", 3, 1)).toBe("");
    expect(substring("hello", 2, 2)).toBe("");
  });

  it("substring() with end_pos omitted (default -1) goes to the end of the string, not count-from-end", () => {
    // pine2py's `if end_pos < 0: return source[begin_pos:]` treats ANY negative end_pos as "no
    // end bound" — it does not use Python's negative-index-counts-from-end slicing for this arg.
    expect(substring("hello", 2)).toBe("llo");
    expect(substring("hello", 1, -1)).toBe("ello");
  });

  it("repeat() joins count copies of source with separator (default separator is '')", () => {
    expect(repeat("ab", 3, "-")).toBe("ab-ab-ab");
    expect(repeat("ab", 3)).toBe("ababab");
  });

  it("repeat() returns '' for count <= 0 (Python `[source]*count` on non-positive count is an empty list)", () => {
    expect(repeat("ab", 0, "-")).toBe("");
    expect(repeat("ab", -1, "-")).toBe("");
  });

  it("lower/upper/trim/substring/repeat propagate na (null) when source is a null string", () => {
    // pine2py str_funcs.lower/upper/trim/substring/repeat have no None-guard and crash
    // (AttributeError/TypeError on source.lower()/.strip()/subscripting/list-multiply) — same
    // "no pine2py-defined behavior to literal-port" situation as C76's contains/startswith/
    // endswith/pos, but these return string (reference type) so na is null, not NaN
    // (DIVERGENCES.md #17). Not oracle-verifiable — hand-verified only.
    expect(lower(null)).toBe(null);
    expect(upper(null)).toBe(null);
    expect(trim(null)).toBe(null);
    expect(substring(null, 0, 3)).toBe(null);
    expect(repeat(null, 3)).toBe(null);
  });

  it("replace_all() propagates na (null) when source, target, or replacement is a null string", () => {
    expect(replace_all(null, "a", "b")).toBe(null);
    expect(replace_all("abc", null, "b")).toBe(null);
    expect(replace_all("abc", "a", null)).toBe(null);
  });

  it("substring() propagates na (null) when begin_pos or end_pos is NaN (na int)", () => {
    // pine2py crashes with TypeError ('<' not supported .../slice indices must be integers) when
    // begin_pos/end_pos is na (NaN for a numeric param, not None) — verified via scratch probe.
    expect(substring("hello", NaN, 3)).toBe(null);
    expect(substring("hello", 1, NaN)).toBe(null);
  });

  it("repeat() propagates na (null) when count is NaN (na int) or separator is a null string", () => {
    expect(repeat("ab", NaN)).toBe(null);
    expect(repeat("ab", 3, null)).toBe(null);
  });

  // ── str.split (C107, array.*/map.*/matrix.* 완주 후 str.* 잔여 슬라이스의 첫 항목) ────

  it("split() matches Python str.split(sep) for plain (non-na) inputs, including consecutive/leading/trailing separators", () => {
    expect(split("a,b,c", ",")).toEqual(["a", "b", "c"]);
    expect(split("a,,b", ",")).toEqual(["a", "", "b"]);
    expect(split(",a,", ",")).toEqual(["", "a", ""]);
    expect(split("", ",")).toEqual([""]);
    expect(split("abc", ",")).toEqual(["abc"]);
    expect(split("aXXbXXc", "XX")).toEqual(["a", "b", "c"]);
  });

  it("split() propagates na (null) when source is a null string", () => {
    // pine2py str_funcs.split has no None-guard for source — `None.split(...)` crashes with
    // AttributeError (verified via direct python execution). Not oracle-verifiable.
    expect(split(null, ",")).toBe(null);
  });

  it("split() propagates na (null) for an empty-string separator, unlike JS's native per-character split", () => {
    // Python str.split("") raises ValueError("empty separator") — a genuine pine2py crash boundary
    // (verified via direct python execution), absorbed as na like every other crash boundary in
    // this codebase. JS's native "abc".split("") would instead silently return ["a","b","c"]
    // (per-character split) with no crash — this divergence is exactly why an explicit guard is
    // needed instead of relying on JS's natural leniency (MEMORY.md Pitfalls, C103 kron precedent).
    expect(split("abc", "")).toBe(null);
  });

  it("split() propagates na (null) for a null separator, NOT Python's str.split(None) whitespace-split sentinel", () => {
    // Python str.split(None) does NOT crash — it's documented stdlib behavior meaning "split on
    // any whitespace run" (verified via direct python execution:
    // split("  a  b  ", None) == ["a","b"]). But this is an accidental artifact of Python's
    // str.split() overloading None as both "argument omitted" and "the na value" — pine2py's
    // split(source, separator) signature has no default and no None-guard of its own; the
    // whitespace behavior comes entirely from Python's built-in str.split, not from any
    // TV-intentional na handling. GOAL.md "pine2py의 알려진 버그는 따르지 않는다" applies: this is
    // not deliberately-implemented TV semantics, just a Python API accident, so it is NOT
    // literal-ported. Treated consistently with the other two crash boundaries above instead
    // (DIVERGENCES.md 신규, TV 미검증 가설 — no TV access to confirm what na-separator actually
    // does on the real platform). JS's native "a,b".split(null) would instead search for the
    // literal substring "null" (String(null) coercion) — neither Python's whitespace-split nor na,
    // so an explicit guard is required regardless of which semantic is chosen.
    expect(split("a,b", null)).toBe(null);
  });

  // ── str.replace (C108, str.split(C107) 다음 str.* 잔여 슬라이스 항목) ────

  it("replace() with the default occurrence (0) replaces only the first match, matching Python str.replace(...,1)", () => {
    expect(replace("hello world hello", "hello", "X")).toBe("X world hello");
    expect(replace("hello world hello", "hello", "X", 0)).toBe("X world hello");
  });

  it("replace() with an explicit occurrence replaces only that Nth match, leaving all others untouched", () => {
    expect(replace("hello world hello", "hello", "X", 1)).toBe("X world hello");
    expect(replace("hello world hello", "hello", "X", 2)).toBe("hello world X");
    expect(replace("aaa", "a", "bb", 2)).toBe("abba");
  });

  it("replace() leaves the source unchanged when occurrence is out of range, negative, or the target is absent", () => {
    // pine2py's manual scan loop only ever increments `count` on an actual match (1,2,3,...) — an
    // occurrence that's never reached (too high, negative, or the target simply isn't found) falls
    // through to "target.find returns -1" and the untouched remainder is appended as-is (verified
    // via direct python execution).
    expect(replace("hello world hello", "hello", "X", 3)).toBe("hello world hello");
    expect(replace("hello world hello", "hello", "X", -1)).toBe("hello world hello");
    expect(replace("hello world hello", "xyz", "X", 0)).toBe("hello world hello");
    expect(replace("hello world hello", "xyz", "X", 1)).toBe("hello world hello");
  });

  it("replace() with an empty target prepends the replacement, for any positive-integer occurrence", () => {
    // pine2py's scan loop never advances `i` when target==="" (source.find("", i) always returns i
    // itself), so `count` increments every iteration while `i` stays pinned at 0 — whichever
    // iteration finally matches `occurrence`, the accumulated result is always `replacement +
    // source` (verified via direct python execution for occurrence=1 and occurrence=2, both
    // producing the same "Xabc").
    expect(replace("abc", "", "X")).toBe("Xabc");
    expect(replace("abc", "", "X", 2)).toBe("Xabc");
  });

  it("replace() with an empty target and an occurrence that count can never reach avoids pine2py's real infinite loop", () => {
    // GENUINE pine2py bug (not just a divergence): with target==="", pine2py's `i` never advances,
    // so `count` climbs 1,2,3,... forever without ever hitting a negative/non-integer/NaN
    // occurrence — verified to hang for real via `timeout python -c ...` (exit code 124). GOAL.md
    // "알려진 버그는 따르지 않는다" applies — pine2js resolves this analytically instead of looping
    // (DIVERGENCES.md 신규): any occurrence that can't be reached by counting up from 1 falls back
    // to "no match found", same as the out-of-range/negative cases above for a non-empty target.
    expect(replace("abc", "", "X", -1)).toBe("abc");
    expect(replace("abc", "", "X", 1.5)).toBe("abc");
    expect(replace("abc", "", "X", NaN)).toBe("abc");
  });

  it("replace() propagates na (null) when source, target, or replacement is a null string", () => {
    // pine2py str_funcs.replace has no None-guard for any of the three string params — crashes with
    // AttributeError/TypeError (verified via direct python execution), same as replace_all(C77).
    expect(replace(null, "a", "b")).toBe(null);
    expect(replace("abc", null, "b")).toBe(null);
    expect(replace("abc", "a", null)).toBe(null);
  });

  it("replace() treats a na (NaN) occurrence as well-defined 'no match found', not a crash boundary", () => {
    // occurrence is numeric (not a reference type), so na is NaN, not null (GOAL.md 3분할 규약).
    // `count === occurrence` is naturally false for every integer count (NaN !== NaN in both Python
    // and JS), so pine2py's loop runs to completion untouched with no explicit na-guard needed —
    // literal port, not the None-double-overload trap that split()'s separator hit (C107).
    expect(replace("hello world hello", "hello", "X", NaN)).toBe("hello world hello");
  });

  // ── str.match (C574 정정 — DIVERGENCES.md #44 참조): TV 공식 반환형은 첫 매치 부분문자열
  // (없으면 "")이지 pine2py의 bool이 아니다. wild corpus의 `str.tonumber(str.match(...))` 관용구가
  // TV에서 실제로 컴파일된다는 사실이 이를 증명(bool을 str.tonumber에 넘기면 타입 에러). 15개
  // 패턴(digit/anchor/character class/alternation/quantifier/invalid syntax 등)을 python re와
  // node RegExp로 교차 실측(scratch/probe_match.mjs, scratch/c574_match_probe.mjs)해 기본 구문은
  // 전부 일치 확인 완료. ────

  it("match() finds a pattern anywhere in the string, matching Python re.search (not anchored like re.match), and returns the matched substring", () => {
    expect(match("price 123", "\\d+")).toBe("123");
    expect(match("hello", "\\d+")).toBe("");
  });

  it("match() honors ^ and $ anchors, character classes, alternation, and quantifiers like Python re", () => {
    expect(match("hello", "^he")).toBe("he");
    expect(match("hello", "^ell")).toBe("");
    expect(match("hello", "lo$")).toBe("lo");
    expect(match("abc123", "[a-z]+\\d+")).toBe("abc123");
    expect(match("cat", "cat|dog")).toBe("cat");
    expect(match("aaa", "a{2,3}")).toBe("aaa");
  });

  it("match() is case-sensitive by default, same as Python re.search with no flags", () => {
    expect(match("Hello", "hello")).toBe("");
  });

  it("match() treats an empty pattern as matching any (including empty) string, same as Python re.search('') — the matched substring is itself empty", () => {
    expect(match("hello", "")).toBe("");
    expect(match("", "")).toBe("");
    expect(match("", "\\d+")).toBe("");
  });

  it("match() catches an invalid regex pattern and returns \"\" (same 'no match' value as a genuine non-match)", () => {
    expect(match("hello", "[")).toBe("");
  });

  it("match() propagates na (null) when source or pattern is a null string — string-returning function, GOAL.md 3-way na split", () => {
    // pine2py str_funcs.match has no None-guard for either param — crashes with AttributeError
    // (re.search(pattern, None)) or TypeError, same class as contains/startswith/endswith(C76).
    expect(match(null, "\\d+")).toBe(null);
    expect(match("hello", null)).toBe(null);
  });

  // ── str.format (C110, str.match(C109) 다음 str.* 잔여 슬라이스 항목) — pine2py
  // str_funcs.format(template, *args): `{idx}` 단순 치환 + `{idx,number,pattern}` 숫자 포맷
  // 치환. 정규식 `\{(\d+)(?:,number,([^}]+))?\}`을 python re/node RegExp로 교차 실측
  // (scratch/probe_format.py+.mjs, 31개 수동 케이스 + 데시멀 포맷 2,000건 + round-half-even
  // 2,013건 전부 일치) 확인 완료. ────

  it("format() substitutes simple {idx} placeholders with pyFloatStr-style number text", () => {
    expect(format("{0} {1}", "hello", 5.0)).toBe("hello 5.0");
    expect(format("{0}", 5.0)).toBe("5.0");
  });

  it("format() substitutes booleans as Python-capitalized 'True'/'False' (array.join #28b precedent)", () => {
    expect(format("{0}", true)).toBe("True");
    expect(format("{0}", false)).toBe("False");
  });

  it("format() applies {idx,number,pattern} decimal formatting, counting digits after the dot", () => {
    expect(format("{0,number,#.##}", 3.14159)).toBe("3.14");
    expect(format("{0,number,0.000}", 3.14159)).toBe("3.142");
    expect(format("{0,number,#,###.##}", 1234.5678)).toBe("1234.57");
  });

  it("format() with a dot-less number pattern rounds half-to-even (Python round(), not half-away-from-zero)", () => {
    // Deliberately literal-ported from pine2py's plain `round()` builtin, NOT rt's half-away-
    // from-zero math.round — this is a different code path and its TV-true rounding mode is
    // unverified (WebSearch unavailable), so it is NOT "corrected" the way math.round was.
    expect(format("{0,number,#}", 2.5)).toBe("2");
    expect(format("{0,number,#}", 0.5)).toBe("0");
    expect(format("{0,number,#}", 1.5)).toBe("2");
    expect(format("{0,number,#}", -2.5)).toBe("-2");
    expect(format("{0,number,#}", 3.6)).toBe("4");
  });

  it("format() repeats the same arg for repeated placeholder indices and leaves out-of-range indices as literal text", () => {
    expect(format("{0} {0}", "x")).toBe("x x");
    expect(format("{5}", 1.0, 2.0)).toBe("{5}");
  });

  it("format() leaves non-placeholder text and unmatched brace patterns untouched", () => {
    expect(format("no placeholder", 1.0, 2.0)).toBe("no placeholder");
    expect(format("{a}", 5.0)).toBe("{a}");
  });

  it("format() uses lowercase 'nan' for a bare {idx} substitution but uppercase 'NaN' for a {idx,number,...} one (pine2py's own isnan-guard asymmetry, array.join #28c precedent)", () => {
    expect(format("{0}", NaN)).toBe("nan");
    expect(format("{0,number,#.##}", NaN)).toBe("NaN");
  });

  it("format() renders +/-Infinity as lowercase 'inf'/'-inf' in every branch, including the dot-less pattern that would crash pine2py's own int(round(inf))", () => {
    expect(format("{0}", Infinity)).toBe("inf");
    expect(format("{0}", -Infinity)).toBe("-inf");
    expect(format("{0,number,#.##}", Infinity)).toBe("inf");
    expect(format("{0,number,#}", Infinity)).toBe("inf");
    expect(format("{0,number,#}", -Infinity)).toBe("-inf");
  });

  it("format() parses a numeric-looking string arg under a {idx,number,...} pattern and formats it as a number", () => {
    expect(format("{0,number,#.##}", "3.14159")).toBe("3.14");
    expect(format("{0,number,#.##}", "  3.5  ")).toBe("3.50");
  });

  it("format() falls back to the literal string arg under a {idx,number,...} pattern when it fails to parse as a number (Python float() ValueError -> str(value))", () => {
    expect(format("{0,number,#.##}", "abc")).toBe("abc");
    expect(format("{0,number,#.##}", "0x1A")).toBe("0x1A");
    expect(format("{0,number,#.##}", "")).toBe("");
  });

  it("format() preserves the negative sign on literal -0 under decimal formatting (JS toFixed drops it, C45 Pitfalls precedent)", () => {
    expect(format("{0,number,0.00}", -0)).toBe("-0.00");
    expect(format("{0,number,0}", -0)).toBe("0");
    expect(format("{0,number,0.00}", 0)).toBe("0.00");
  });

  it("format() propagates na (null) when the template itself is na", () => {
    expect(format(null, 1.0)).toBe(null);
  });

  it("format() propagates na (null) for the whole result when a substituted arg is a null string (pine2js-only decision — pine2py structurally can never produce a real None arg here, see LIMITATIONS.md)", () => {
    expect(format("{0}", null)).toBe(null);
    expect(format("prefix {0} suffix", null)).toBe(null);
  });

  // str_funcs.format_number(value, format_str="")(C111): value가 NaN이면 "NaN"(format_str 유무와
  // 무관, 이 체크가 먼저), format_str이 truthy면 format(C110)의 {idx,number,pattern} 내부 헬퍼
  // (_apply_number_format)를 그대로 재사용, 없으면 pine2py `str(value)`와 동치인 pyFloatStr.
  it("format_number() with no format_str (or empty string) falls back to pyFloatStr, matching Python's plain str(value)", () => {
    expect(format_number(1234.5678)).toBe("1234.5678");
    expect(format_number(1234.5678, "")).toBe("1234.5678");
    expect(format_number(0)).toBe("0.0");
  });

  it("format_number() applies a decimal pattern via the same round-half-even/toFixedPy logic as format()'s {idx,number,pattern} branch", () => {
    expect(format_number(1234.5678, "#.##")).toBe("1234.57");
    expect(format_number(1234.5, "0.000")).toBe("1234.500");
    expect(format_number(-1234.5678, "#.##")).toBe("-1234.57");
  });

  it("format_number() with a dot-less pattern rounds half-to-even (Python round(), same as format())", () => {
    expect(format_number(2.5, "#")).toBe("2");
    expect(format_number(3.5, "#")).toBe("4");
    expect(format_number(1234.5, "#")).toBe("1234");
  });

  it("format_number() returns 'NaN' for a NaN value regardless of format_str (isnan check runs before the format_str branch)", () => {
    expect(format_number(NaN)).toBe("NaN");
    expect(format_number(NaN, "#.##")).toBe("NaN");
  });

  it("format_number() renders +/-Infinity as 'inf'/'-inf' in every branch, including the dot-less pattern that would crash pine2py's own int(round(inf)) (OverflowError, confirmed via direct python execution)", () => {
    expect(format_number(Infinity)).toBe("inf");
    expect(format_number(Infinity, "#.##")).toBe("inf");
    expect(format_number(Infinity, "#")).toBe("inf");
    expect(format_number(-Infinity, "#.##")).toBe("-inf");
  });

  it("format_number() preserves the negative sign on literal -0 under decimal formatting (C45 Pitfalls precedent, same as format())", () => {
    expect(format_number(-0, "#.##")).toBe("-0.00");
    expect(format_number(0, "#.##")).toBe("0.00");
  });

  it("format_number() propagates na (null) when format_str is explicitly na and value is not NaN — pine2py itself crashes here (AttributeError: 'float' object has no attribute 'find', confirmed via direct python execution: format_str is a string parameter so na compiles to float('nan') and actually reaches _apply_number_format's pattern.find('.'), unlike str.format's template/arg na paths) — not oracle-verifiable, hand-verified only (LIMITATIONS.md)", () => {
    expect(format_number(1234.5, null)).toBe(null);
  });

  it("format_number() returns 'NaN' (not na) when value is NaN even if format_str is also na — the value isnan check short-circuits before format_str is ever touched, so it masks what would otherwise be a crash (confirmed via direct python execution: format_number(nan, nan) === 'NaN')", () => {
    expect(format_number(NaN, null)).toBe("NaN");
  });

  // str_funcs.format_time(time_ms, format_str="yyyy-MM-dd'T'HH:mm:ssZ", timezone="")(C112, str.*
  // 마지막 잔여 항목): time_ms/1000를 UTC datetime으로 변환 후 Pine 포맷 토큰(yyyy/yy/MMMM/MMM/MM/
  // dd/HH/hh/mm/ss/'T'/Z)을 pine2py와 동일한 순서(긴 토큰부터)로 값 치환. 골든은 python
  // str_funcs.format_time을 직접 실행해 확보(2024-01-15T00:00:00Z=1705276800000ms,
  // 2024-01-15T14:30:45Z=1705329045000ms).
  it("format_time() formats a basic yyyy-MM-dd pattern (matches pine2py's format_time byte-for-byte)", () => {
    expect(format_time(1705276800000, "yyyy-MM-dd")).toBe("2024-01-15");
  });

  it("format_time() formats a date+time pattern with HH:mm:ss (24-hour)", () => {
    expect(format_time(1705329045000, "yyyy-MM-dd HH:mm:ss")).toBe("2024-01-15 14:30:45");
  });

  it("format_time() with no format_str defaults to \"yyyy-MM-dd'T'HH:mm:ssZ\" (pine2py default arg)", () => {
    expect(format_time(1705276800000)).toBe("2024-01-15T00:00:00+0000");
    expect(format_time(1705329045000)).toBe("2024-01-15T14:30:45+0000");
  });

  it("format_time() renders MMMM/MMM as locale-independent hardcoded English month names (verified this Python env returns English regardless of Korean_Korea system locale)", () => {
    expect(format_time(1705276800000, "MMMM MMM")).toBe("January Jan");
    expect(format_time(1706745600000, "MMMM MMM")).toBe("February Feb");
  });

  it("format_time() applies yyyy before yy in the replace chain so a 4-digit year isn't double-substituted", () => {
    expect(format_time(1705276800000, "yy vs yyyy")).toBe("24 vs 2024");
  });

  it("format_time() renders hh (12-hour) as 12 at both midnight and noon, distinct from HH (24-hour)", () => {
    expect(format_time(1705276800000, "hh:mm:ss HH")).toBe("12:00:00 00");
    expect(format_time(1705276800000 + 43200 * 1000, "hh:mm:ss HH")).toBe("12:00:00 12");
    expect(format_time(1705329045000, "hh:mm:ss")).toBe("02:30:45");
  });

  it("format_time() ignores the timezone argument entirely (pine2py accepts it but never references it in the function body — always UTC)", () => {
    expect(format_time(1705276800000, "yyyy-MM-dd", "America/New_York")).toBe("2024-01-15");
    expect(format_time(1705276800000, "yyyy-MM-dd", "")).toBe("2024-01-15");
  });

  it("format_time() returns 'NaN' for a NaN time_ms (matches pine2py's explicit isnan/None guard)", () => {
    expect(format_time(NaN, "yyyy-MM-dd")).toBe("NaN");
  });

  it("format_time() returns 'NaN' for +/-Infinity time_ms — pine2py itself crashes uncaught here (OverflowError, not in the except tuple, confirmed via direct python execution), so this is a deliberate na-safety absorption rather than a literal port", () => {
    expect(format_time(Infinity, "yyyy-MM-dd")).toBe("NaN");
    expect(format_time(-Infinity, "yyyy-MM-dd")).toBe("NaN");
  });

  it("format_time() propagates na (null) when format_str is explicitly na and time_ms is otherwise valid — pine2py crashes here too (AttributeError: 'NoneType' object has no attribute 'replace', confirmed via direct python execution) — not oracle-verifiable, hand-verified only (LIMITATIONS.md)", () => {
    expect(format_time(1705276800000, null)).toBe(null);
  });

  it("format_time() returns 'NaN' (not na) when time_ms is NaN even if format_str is also na — the time_ms conversion guard runs first and masks the format_str crash (confirmed via direct python execution: format_time(nan, None) === 'NaN')", () => {
    expect(format_time(NaN, null)).toBe("NaN");
  });

  it("format_time() computes a correct pre-1970 date for a negative time_ms — deliberate divergence from pine2py's oracle: this Windows/Python 3.11 env's datetime.fromtimestamp raises OSError for timestamps before ~2 hours prior to epoch (confirmed via direct python execution: -7200s succeeds, -86399s fails), a platform time_t artifact rather than a real Python or TV semantic, so pine2js computes the date via JS Date instead of replicating the crash (DIVERGENCES.md; not oracle-verifiable, hand-verified only)", () => {
    expect(format_time(-86400000, "yyyy-MM-dd HH:mm:ss")).toBe("1969-12-31 00:00:00");
  });

  // ── C575: array.get() 범위밖 sentinel(NaN, string 배열이라도 na=null이 아니라 NaN — C572/
  // array.ts 주석 참조) 하드닝. wild `str.tonumber(array.get(stringArr, oobIdx))` 관용구가
  // "value.trim is not a function"으로 죽었다(corpus_scan --exec 실측, wild ab6b6e047a85.pine) —
  // 이 함수뿐 아니라 위 str.* 전 함수가 동일한 "null만 가드, NaN sentinel은 미가드" 취약점을
  // 공유해(모두 `x === null` 가드) `typeof x !== "string"`로 일괄 강화했다. 기존 null 입력 경로의
  // 반환값은 위 테스트들에서 이미 검증돼 그대로 유지되므로, 여기서는 "NaN이 null과 동일하게 취급
  // 되는가"만 각 함수 1건씩 회귀로 남긴다 — 사실상의 방어적 가드라 pine2py 오라클 대상이 아니다.
  it("str.* functions treat a NaN sentinel (not just null) as na, matching each function's existing null-na return convention", () => {
    const NAN = NaN as unknown as string;
    expect(length(NAN)).toBe(0); // length() has the 0-fallback, not na
    expect(contains(NAN, "x")).toBeNaN();
    expect(startswith("x", NAN)).toBeNaN();
    expect(endswith(NAN, "x")).toBeNaN();
    expect(pos("x", NAN)).toBeNaN();
    expect(lower(NAN)).toBe(null);
    expect(upper(NAN)).toBe(null);
    expect(trim(NAN)).toBe(null);
    expect(replace_all(NAN, "a", "b")).toBe(null);
    expect(substring(NAN, 0, 1)).toBe(null);
    expect(repeat(NAN, 3)).toBe(null);
    expect(repeat("ab", 3, NAN)).toBe(null);
    expect(split(NAN, ",")).toBe(null);
    expect(split("a,b", NAN)).toBe(null);
    expect(replace(NAN, "a", "b")).toBe(null);
    expect(match(NAN, "\\d+")).toBe(null);
    expect(tonumber(NAN)).toBeNaN();
    expect(format(NAN)).toBe(null);
    expect(format_number(1, NAN)).toBe(null);
    expect(format_time(0, NAN)).toBe(null);
  });

  it("fixnan() returns na and does not set state when the value is na and no non-na has been seen yet", () => {
    const state = {};
    expect(fixnan(state, NaN)).toBeNaN();
    expect(state).toEqual({});
  });

  it("fixnan() passes a non-na value through and remembers it in the state slot", () => {
    const state = {};
    expect(fixnan(state, 3.5)).toBe(3.5);
    expect(state).toEqual({ last: 3.5 });
  });

  it("fixnan() recalls the last remembered non-na value across repeated na calls on the same state slot", () => {
    const state = {};
    expect(fixnan(state, 7)).toBe(7);
    expect(fixnan(state, NaN)).toBe(7);
    expect(fixnan(state, NaN)).toBe(7);
    expect(fixnan(state, 9)).toBe(9);
    expect(fixnan(state, NaN)).toBe(9);
  });

  it("fixnan() remembers 0 as a valid non-na value (nullish-coalescing edge case)", () => {
    const state = {};
    expect(fixnan(state, 0)).toBe(0);
    expect(fixnan(state, NaN)).toBe(0);
  });

  it("fixnan() keeps independent state across two separate state slots", () => {
    const stateA = {};
    const stateB = {};
    expect(fixnan(stateA, 1)).toBe(1);
    expect(fixnan(stateB, 2)).toBe(2);
    expect(fixnan(stateA, NaN)).toBe(1);
    expect(fixnan(stateB, NaN)).toBe(2);
  });

  // ── color.rgb/color.new/color.from_gradient (C78) ────

  it("rgb() clamps r/g/b to [0,255] and formats as uppercase 6-digit hex", () => {
    expect(rgb(255, 0, 0)).toBe("#FF0000");
    expect(rgb(300, -10, 128)).toBe("#FF0080");
  });

  it("rgb() with transp > 0 appends a 2-digit alpha channel (8-digit hex)", () => {
    expect(rgb(0, 128, 255, 50)).toBe("#0080FF7F");
  });

  it("rgb() treats a NaN transp as 'no transparency' (both Python and JS evaluate 'transp > 0' as false for NaN — literal port, no explicit guard needed)", () => {
    expect(rgb(255, 0, 0, NaN)).toBe("#FF0000");
  });

  it("rgb() propagates na (null) when r, g, or b is NaN (pine2py's `int(r)` crashes with no guard — GOAL.md na-safety principle applied instead)", () => {
    expect(rgb(NaN, 0, 0)).toBe(null);
    expect(rgb(255, NaN, 0)).toBe(null);
    expect(rgb(255, 0, NaN)).toBe(null);
  });

  it("colorNew() strips any existing alpha and appends a new one when transp > 0", () => {
    expect(colorNew("#FF5252", 50)).toBe("#FF52527F");
    expect(colorNew("#FF5252FF", 50)).toBe("#FF52527F");
  });

  it("colorNew() returns the base color unchanged when transp is 0 (default)", () => {
    expect(colorNew("#2196F3")).toBe("#2196F3");
    expect(colorNew("#2196F3", 0)).toBe("#2196F3");
  });

  it("colorNew() passes na (null/empty) straight through — pine2py's own `if not color_val` guard already handles this, no new na decision needed", () => {
    expect(colorNew(null)).toBe(null);
    expect(colorNew("")).toBe("");
  });

  it("colorNew() treats a NaN transp as 'no transparency' (same non-crashing `transp > 0` as rgb())", () => {
    expect(colorNew("#FF5252", NaN)).toBe("#FF5252");
  });

  it("from_gradient() linearly interpolates RGB channels between bottom and top color at the midpoint", () => {
    expect(from_gradient(50, 0, 100, "#FF5252", "#2196F3")).toBe("#9074A2");
  });

  it("from_gradient() returns the bottom/top color exactly at the range endpoints", () => {
    expect(from_gradient(0, 0, 100, "#FF5252", "#2196F3")).toBe("#FF5252");
    expect(from_gradient(100, 0, 100, "#FF5252", "#2196F3")).toBe("#2196F3");
  });

  it("from_gradient() clamps t to [0,1] outside the range (matches pine2py's max(0, min(1, t)))", () => {
    expect(from_gradient(150, 0, 100, "#FF5252", "#2196F3")).toBe("#2196F3");
    expect(from_gradient(-10, 0, 100, "#FF5252", "#2196F3")).toBe("#FF5252");
  });

  it("from_gradient() returns the bottom color when value is NaN or the range is degenerate (top===bottom) — literal port of pine2py's guard", () => {
    expect(from_gradient(NaN, 0, 100, "#FF5252", "#2196F3")).toBe("#FF5252");
    expect(from_gradient(50, 5, 5, "#FF5252", "#2196F3")).toBe("#FF5252");
  });

  it("from_gradient() returns na (null) when bottomValue/topValue themselves are NaN (extreme edge pine2py itself would crash on inside the RGB interpolation — GOAL.md na-safety principle applied instead of reproducing the crash)", () => {
    expect(from_gradient(50, NaN, 100, "#FF5252", "#2196F3")).toBe(null);
    expect(from_gradient(50, 0, NaN, "#FF5252", "#2196F3")).toBe(null);
  });

  // ── color.r/g/b/t (C311, pine2py에 대응 구현 0건 — hand-verified, DIVERGENCES.md #118) ────

  it("colorR/colorG/colorB parse the RGB channels from an opaque 6-digit hex string", () => {
    expect(colorR("#FF5252")).toBe(255);
    expect(colorG("#FF5252")).toBe(82);
    expect(colorB("#FF5252")).toBe(82);
  });

  it("colorT() returns 0 for an opaque 6-digit hex string (no alpha byte present)", () => {
    expect(colorT("#FF5252")).toBe(0);
  });

  it("colorR/colorG/colorB/colorT round-trip exactly through rgb()'s own hex/alpha encoding", () => {
    const encoded = rgb(0, 128, 255, 50);
    expect(encoded).toBe("#0080FF7F");
    expect(colorR(encoded)).toBe(0);
    expect(colorG(encoded)).toBe(128);
    expect(colorB(encoded)).toBe(255);
    expect(colorT(encoded)).toBe(50);
  });

  it("colorT() round-trips the transparency extremes (0 and 100) exactly", () => {
    expect(colorT(rgb(1, 2, 3, 0))).toBe(0);
    expect(colorT(rgb(1, 2, 3, 100))).toBe(100);
  });

  it("colorR/colorG/colorB/colorT all return na (NaN) for a null color (GOAL.md reference-type na)", () => {
    expect(colorR(null)).toBeNaN();
    expect(colorG(null)).toBeNaN();
    expect(colorB(null)).toBeNaN();
    expect(colorT(null)).toBeNaN();
  });

  it("colorR/colorG/colorB/colorT absorb any non-string input as na without crashing (defends against the pre-existing 'var color x = na' -> NaN gap, LIMITATIONS.md C311, and malformed/short hex strings)", () => {
    expect(colorR(NaN)).toBeNaN();
    expect(colorG(undefined)).toBeNaN();
    expect(colorB(42)).toBeNaN();
    expect(colorT("#FFF")).toBeNaN();
  });
});

// ── array.* 최초 슬라이스(C79): new_float/get/set/push/pop/size — pine2py wavealgo/builtins/
// array.py literal port. na(null) 배열 인자 동작은 pine2py가 가드 없이 크래시하는 미정의 동작이라
// (pop만 `if arr` falsy 가드로 정의됨) GOAL.md 원칙으로 새로 결정 — 오라클 검증 불가, 여기서
// hand-verified(DIVERGENCES.md #19, LIMITATIONS.md 참조). ──

describe("array builtins (rt.array, C79)", () => {
  it("new_float() with no arguments returns an empty array (size default 0)", () => {
    expect(parray.new_float()).toEqual([]);
  });

  it("new_float(3) fills with NaN (initial_value default, matches pine2py new_float signature)", () => {
    const a = parray.new_float(3)!;
    expect(a).toHaveLength(3);
    for (const v of a) expect(Number.isNaN(v)).toBe(true);
  });

  it("new_float(2, 5.0) fills every slot with the initial value", () => {
    expect(parray.new_float(2, 5.0)).toEqual([5.0, 5.0]);
  });

  it("new_float with size<=0 returns an empty array (literal port of Python [v]*n, n<=0)", () => {
    expect(parray.new_float(0, 7.0)).toEqual([]);
    expect(parray.new_float(-1)).toEqual([]);
  });

  it("new_float with a NaN size returns na (null) — pine2py [v]*nan crashes (undefined), na propagated instead", () => {
    expect(parray.new_float(NaN)).toBe(null);
  });

  it("new_float truncates a fractional size (Math.trunc — JS has no int type, MEMORY.md Pitfalls)", () => {
    expect(parray.new_float(2.9, 1.0)).toEqual([1.0, 1.0]);
  });

  it("get() returns the element in range and NaN out of range / for negative indices (pine2py guard literal port)", () => {
    const a = [10.0, 20.0];
    expect(parray.get(a, 0)).toBe(10.0);
    expect(parray.get(a, 1)).toBe(20.0);
    expect(Number.isNaN(parray.get(a, 2))).toBe(true);
    expect(Number.isNaN(parray.get(a, -1))).toBe(true);
  });

  it("get() with a NaN index returns NaN without crashing (same path as pine2py's chained comparison being False)", () => {
    expect(Number.isNaN(parray.get([1.0], NaN))).toBe(true);
  });

  it("get() truncates a fractional index", () => {
    expect(parray.get([10.0, 20.0], 1.7)).toBe(20.0);
  });

  it("get() on a na (null) array returns NaN (pine2py crashes — na propagation decided, DIVERGENCES #19)", () => {
    expect(Number.isNaN(parray.get(null, 0))).toBe(true);
  });

  it("set() writes in range and silently no-ops out of range / on NaN index (pine2py guard literal port)", () => {
    const a = [1.0, 2.0];
    parray.set(a, 1, 9.0);
    expect(a).toEqual([1.0, 9.0]);
    parray.set(a, 5, 7.0);
    parray.set(a, NaN, 7.0);
    expect(a).toEqual([1.0, 9.0]);
  });

  it("set() on a na (null) array is a silent no-op (pine2py crashes — DIVERGENCES #19)", () => {
    expect(() => parray.set(null, 0, 1.0)).not.toThrow();
  });

  it("push() appends to the end, including NaN values (no NaN filtering — the array stores what you push)", () => {
    const a: number[] = [];
    parray.push(a, 1.0);
    parray.push(a, NaN);
    expect(a).toHaveLength(2);
    expect(a[0]).toBe(1.0);
    expect(Number.isNaN(a[1]!)).toBe(true);
  });

  it("push() on a na (null) array is a silent no-op (pine2py crashes — DIVERGENCES #19)", () => {
    expect(() => parray.push(null, 1.0)).not.toThrow();
  });

  it("pop() removes and returns the last element", () => {
    const a = [1.0, 2.0];
    expect(parray.pop(a)).toBe(2.0);
    expect(a).toEqual([1.0]);
  });

  it("pop() on an empty or na (null) array returns NaN — literal port of pine2py's falsy guard (both are defined behavior, not a new na decision)", () => {
    expect(Number.isNaN(parray.pop([]))).toBe(true);
    expect(Number.isNaN(parray.pop(null))).toBe(true);
  });

  it("size() returns the element count and NaN for a na (null) array (pine2py len(None) crashes — DIVERGENCES #19)", () => {
    expect(parray.size([1.0, 2.0, 3.0])).toBe(3);
    expect(parray.size([])).toBe(0);
    expect(Number.isNaN(parray.size(null))).toBe(true);
  });

  it("mutations through one reference are visible through another (Pine array is a true reference type — design question (a)/(b) of C79)", () => {
    const a = parray.new_float(0)!;
    const alias = a;
    parray.push(alias, 42.0);
    expect(parray.size(a)).toBe(1);
    expect(parray.get(a, 0)).toBe(42.0);
  });
});

// ── array.* 잔여 슬라이스(C80): first/last/shift/unshift/insert/remove/clear/fill — C79가
// 확정한 패턴의 기계적 확장. na(null) 배열 인자/na 인덱스는 pine2py가 가드 없이 크래시하는
// 미정의 동작이라(first/last/shift만 pop과 동일한 falsy 가드로 정의됨) GOAL.md 원칙으로 새로
// 결정 — 오라클 검증 불가, hand-verified(DIVERGENCES.md #20, LIMITATIONS.md 참조). ──

describe("array builtins — residual slice (rt.array, C80)", () => {
  it("first() returns the first element", () => {
    expect(parray.first([10.0, 20.0])).toBe(10.0);
  });

  it("first() on an empty or na (null) array returns NaN — literal port of pine2py's falsy guard (same as pop, not a new na decision)", () => {
    expect(Number.isNaN(parray.first([]))).toBe(true);
    expect(Number.isNaN(parray.first(null))).toBe(true);
  });

  it("last() returns the last element", () => {
    expect(parray.last([10.0, 20.0])).toBe(20.0);
  });

  it("last() on an empty or na (null) array returns NaN — literal port of pine2py's falsy guard", () => {
    expect(Number.isNaN(parray.last([]))).toBe(true);
    expect(Number.isNaN(parray.last(null))).toBe(true);
  });

  it("shift() removes and returns the first element", () => {
    const a = [1.0, 2.0, 3.0];
    expect(parray.shift(a)).toBe(1.0);
    expect(a).toEqual([2.0, 3.0]);
  });

  it("shift() on an empty or na (null) array returns NaN — literal port of pine2py's falsy guard (same as pop)", () => {
    expect(Number.isNaN(parray.shift([]))).toBe(true);
    expect(Number.isNaN(parray.shift(null))).toBe(true);
  });

  it("unshift() prepends to the front, including NaN values", () => {
    const a = [1.0, 2.0];
    parray.unshift(a, 9.0);
    expect(a).toEqual([9.0, 1.0, 2.0]);
    parray.unshift(a, NaN);
    expect(a).toHaveLength(4);
    expect(Number.isNaN(a[0]!)).toBe(true);
  });

  it("unshift() on a na (null) array is a silent no-op (pine2py crashes — DIVERGENCES #20)", () => {
    expect(() => parray.unshift(null, 1.0)).not.toThrow();
  });

  it("insert() inserts at the given position, clamping out-of-range/negative indices exactly like Python list.insert (node/python cross-check)", () => {
    const a1 = [1.0, 2.0, 3.0];
    parray.insert(a1, 0, 9.0);
    expect(a1).toEqual([9.0, 1.0, 2.0, 3.0]);
    const a2 = [1.0, 2.0, 3.0];
    parray.insert(a2, 10, 9.0);
    expect(a2).toEqual([1.0, 2.0, 3.0, 9.0]);
    const a3 = [1.0, 2.0, 3.0];
    parray.insert(a3, -1, 9.0);
    expect(a3).toEqual([1.0, 2.0, 9.0, 3.0]);
    const a4 = [1.0, 2.0, 3.0];
    parray.insert(a4, -10, 9.0);
    expect(a4).toEqual([9.0, 1.0, 2.0, 3.0]);
  });

  it("insert() truncates a fractional index (array index Math.trunc convention)", () => {
    const a = [1.0, 2.0, 3.0];
    parray.insert(a, 1.9, 9.0);
    expect(a).toEqual([1.0, 9.0, 2.0, 3.0]);
  });

  it("insert() with a NaN index is a silent no-op — pine2py's list.insert(nan,...) crashes (TypeError), JS Array.splice(NaN,...) would silently default to index 0 instead (DIVERGENCES #20)", () => {
    const a = [1.0, 2.0, 3.0];
    parray.insert(a, NaN, 9.0);
    expect(a).toEqual([1.0, 2.0, 3.0]);
  });

  it("insert() on a na (null) array is a silent no-op (pine2py crashes — DIVERGENCES #20)", () => {
    expect(() => parray.insert(null, 0, 1.0)).not.toThrow();
  });

  it("remove() removes and returns the element at the given index (explicit range guard, same shape as get())", () => {
    const a = [1.0, 2.0, 3.0];
    expect(parray.remove(a, 1)).toBe(2.0);
    expect(a).toEqual([1.0, 3.0]);
  });

  it("remove() returns NaN without mutating for an out-of-range or NaN index (pine2py's `0<=index<len(arr)` guard literal port)", () => {
    const a = [1.0, 2.0];
    expect(Number.isNaN(parray.remove(a, 5))).toBe(true);
    expect(Number.isNaN(parray.remove(a, -1))).toBe(true);
    expect(Number.isNaN(parray.remove(a, NaN))).toBe(true);
    expect(a).toEqual([1.0, 2.0]);
  });

  it("remove() on a na (null) array returns NaN (pine2py crashes — DIVERGENCES #20)", () => {
    expect(Number.isNaN(parray.remove(null, 0))).toBe(true);
  });

  it("clear() empties the array in place", () => {
    const a = [1.0, 2.0, 3.0];
    parray.clear(a);
    expect(a).toEqual([]);
  });

  it("clear() on a na (null) array is a silent no-op (pine2py crashes — DIVERGENCES #20)", () => {
    expect(() => parray.clear(null)).not.toThrow();
  });

  it("fill() writes the value across [index_from, index_to)", () => {
    const a = [1.0, 2.0, 3.0, 4.0];
    parray.fill(a, 9.0, 1, 3);
    expect(a).toEqual([1.0, 9.0, 9.0, 4.0]);
  });

  it("fill() with omitted index_from/index_to defaults to the whole array (index_to<0 -> length, literal port)", () => {
    const a = [1.0, 2.0, 3.0];
    parray.fill(a, 9.0);
    expect(a).toEqual([9.0, 9.0, 9.0]);
  });

  it("fill() clamps index_to beyond the array length to the length (min(index_to, len), literal port)", () => {
    const a = [1.0, 2.0, 3.0];
    parray.fill(a, 9.0, 1, 100);
    expect(a).toEqual([1.0, 9.0, 9.0]);
  });

  it("fill() clamps a negative index_from to 0 instead of reproducing pine2py's IndexError crash (DIVERGENCES #20 — 'pine2py's known bug is not followed')", () => {
    const a = [1.0, 2.0, 3.0, 4.0, 5.0];
    parray.fill(a, 9.0, -10);
    expect(a).toEqual([9.0, 9.0, 9.0, 9.0, 9.0]);
  });

  it("fill() with a NaN index_from or index_to is a silent no-op — pine2py's range(nan,...) crashes (TypeError, DIVERGENCES #20)", () => {
    const a = [1.0, 2.0, 3.0];
    parray.fill(a, 9.0, NaN);
    expect(a).toEqual([1.0, 2.0, 3.0]);
    parray.fill(a, 9.0, 0, NaN);
    expect(a).toEqual([1.0, 2.0, 3.0]);
  });

  it("fill() on a na (null) array is a silent no-op (pine2py crashes — DIVERGENCES #20)", () => {
    expect(() => parray.fill(null, 1.0)).not.toThrow();
  });

  // ── sum/avg/min/max/median/mode/stdev/variance(C81) — pine2py array.py L200-256의 공통
  // _valid_nums(NaN 스킵) 위에서 갈리는 stateless 통계류. na(null) 배열은 get/size(C79,
  // DIVERGENCES #19)와 동일한 "읽기는 na" 원칙 재적용(새 divergence 아님). ──

  it("sum() adds only the valid (non-NaN) elements", () => {
    expect(parray.sum([1.0, NaN, 2.0, 3.0])).toBe(6.0);
  });

  it("sum() of an empty or all-na array is 0, not na (Python sum([])==0 — distinct from avg/min/max/median/stdev)", () => {
    expect(parray.sum([])).toBe(0);
    expect(parray.sum([NaN, NaN])).toBe(0);
  });

  it("sum() on a na (null) array returns na (NaN) — 'read' branch of the #19 principle", () => {
    expect(Number.isNaN(parray.sum(null))).toBe(true);
  });

  it("avg() skips na elements and averages the rest", () => {
    expect(parray.avg([1.0, NaN, 3.0])).toBe(2.0);
  });

  it("avg() of an empty or all-na array is na (zero valid values, math.avg C74 counterpart)", () => {
    expect(Number.isNaN(parray.avg([]))).toBe(true);
    expect(Number.isNaN(parray.avg([NaN, NaN]))).toBe(true);
  });

  it("avg() on a na (null) array returns na", () => {
    expect(Number.isNaN(parray.avg(null))).toBe(true);
  });

  it("min()/max() skip na elements", () => {
    expect(parray.min([5.0, NaN, 2.0, 8.0])).toBe(2.0);
    expect(parray.max([5.0, NaN, 2.0, 8.0])).toBe(8.0);
  });

  it("min()/max() of an empty or all-na array is na", () => {
    expect(Number.isNaN(parray.min([]))).toBe(true);
    expect(Number.isNaN(parray.max([NaN]))).toBe(true);
  });

  it("min()/max() on a na (null) array return na", () => {
    expect(Number.isNaN(parray.min(null))).toBe(true);
    expect(Number.isNaN(parray.max(null))).toBe(true);
  });

  // C297: array.max(id, nth)/array.min(id, nth) 선택 인자(TV 공식, wild 실사용 확인 -- DIVERGENCES
  // #111) -- nth는 0-기반, 0=최댓값/최솟값 자체(기존 1-인자 동작과 동치), 1=두 번째로 큰/작은 값.
  it("max()/min() with nth=0 (default omitted) matches the 1-arg behavior", () => {
    expect(parray.max([5.0, NaN, 2.0, 8.0], 0)).toBe(8.0);
    expect(parray.min([5.0, NaN, 2.0, 8.0], 0)).toBe(2.0);
  });

  it("max()/min() with nth=1 returns the second-highest/second-lowest valid value (na skipped)", () => {
    expect(parray.max([5.0, NaN, 2.0, 8.0], 1)).toBe(5.0);
    expect(parray.min([5.0, NaN, 2.0, 8.0], 1)).toBe(5.0);
  });

  it("max()/min() with nth beyond the last valid element is na", () => {
    expect(Number.isNaN(parray.max([5.0, 2.0], 2))).toBe(true);
    expect(Number.isNaN(parray.min([5.0, 2.0], 2))).toBe(true);
  });

  it("max()/min() with a negative nth is na", () => {
    expect(Number.isNaN(parray.max([5.0, 2.0], -1))).toBe(true);
    expect(Number.isNaN(parray.min([5.0, 2.0], -1))).toBe(true);
  });

  it("max()/min() truncates a fractional nth (array index, C297 same as Pitfalls Math.trunc rule)", () => {
    expect(parray.max([5.0, 2.0, 8.0], 1.9)).toBe(5.0);
    expect(parray.min([5.0, 2.0, 8.0], 1.9)).toBe(5.0);
  });

  it("max()/min() with nth ties (duplicate extreme values) picks the tied value again for nth=1", () => {
    expect(parray.max([8.0, 8.0, 2.0], 1)).toBe(8.0);
    expect(parray.min([8.0, 8.0, 2.0], 1)).toBe(8.0);
  });

  // C586: nth=0(기본)은 sort() 없는 O(n) 단일 스캔 경로로 최적화됨(wild timeout triage) — 그
  // 경로가 여전히 sort 기반 nth>=1 경로와 동일 값을 내는지 확인(퇴화 회귀 방지).
  it("max()/min() nth=0 fast path matches sort-based result on negative/duplicate/single-element arrays", () => {
    expect(parray.max([-5.0, -1.0, -8.0], 0)).toBe(-1.0);
    expect(parray.min([-5.0, -1.0, -8.0], 0)).toBe(-8.0);
    expect(parray.max([3.0, 3.0, 3.0], 0)).toBe(3.0);
    expect(parray.min([3.0, 3.0, 3.0], 0)).toBe(3.0);
    expect(parray.max([42.0], 0)).toBe(42.0);
    expect(parray.min([42.0], 0)).toBe(42.0);
  });

  it("max()/min() nth=0 fast path skips na and returns na for all-na/empty arrays (same as no-arg form)", () => {
    expect(parray.max([NaN, NaN], 0)).toBeNaN();
    expect(parray.min([NaN, NaN], 0)).toBeNaN();
    expect(parray.max([], 0)).toBeNaN();
    expect(parray.min([], 0)).toBeNaN();
  });

  it("median() averages the two middle values for an even count of valid elements (sorts first)", () => {
    expect(parray.median([4.0, 1.0, 3.0, 2.0])).toBe(2.5);
  });

  it("median() returns the middle value for an odd count (skips na, sorts first)", () => {
    expect(parray.median([3.0, NaN, 1.0, 2.0])).toBe(2.0);
  });

  it("median() of an empty or all-na array is na", () => {
    expect(Number.isNaN(parray.median([]))).toBe(true);
    expect(Number.isNaN(parray.median(null))).toBe(true);
  });

  it("mode() returns the most frequent valid value", () => {
    expect(parray.mode([1.0, 2.0, 2.0, 3.0])).toBe(2.0);
  });

  it("mode() breaks ties by first-encountered value (Python statistics.mode 3.8+ Counter.most_common(1) semantics)", () => {
    expect(parray.mode([2.0, 1.0, 1.0, 2.0, 3.0])).toBe(2.0);
    expect(parray.mode([1.0, 2.0, 2.0, 1.0])).toBe(1.0);
  });

  it("mode() of an empty or all-na array is na", () => {
    expect(Number.isNaN(parray.mode([]))).toBe(true);
    expect(Number.isNaN(parray.mode(null))).toBe(true);
  });

  it("variance()/stdev() compute population statistics over the valid elements", () => {
    const a = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0];
    expect(parray.variance(a)).toBeCloseTo(4.0, 9);
    expect(parray.stdev(a)).toBeCloseTo(2.0, 9);
  });

  it("variance()/stdev() skip na elements before computing", () => {
    expect(parray.variance([1.0, NaN, 3.0, 5.0])).toBeCloseTo(8 / 3, 9);
  });

  it("variance()/stdev() with fewer than 2 valid elements is na (population stat needs >=2 points)", () => {
    expect(Number.isNaN(parray.variance([5.0]))).toBe(true);
    expect(Number.isNaN(parray.stdev([5.0]))).toBe(true);
    expect(Number.isNaN(parray.variance([]))).toBe(true);
  });

  it("variance()/stdev() on a na (null) array return na", () => {
    expect(Number.isNaN(parray.variance(null))).toBe(true);
    expect(Number.isNaN(parray.stdev(null))).toBe(true);
  });

  // ── includes/indexof/lastindexof (C82) — pine2py array.py L134-154, 순수 읽기. na(null)
  // 배열은 get/size(C79, DIVERGENCES #19)와 동일한 "읽기는 na" 원칙 재적용. ──

  it("includes() finds a present value and reports false for a missing one", () => {
    expect(parray.includes([10.0, 20.0, 30.0], 20.0)).toBe(true);
    expect(parray.includes([10.0, 20.0, 30.0], 50.0)).toBe(false);
  });

  it("indexof() returns the first matching index, -1 (not na) when not found", () => {
    expect(parray.indexof([10.0, 20.0, 10.0], 10.0)).toBe(0);
    expect(parray.indexof([10.0, 20.0, 10.0], 99.0)).toBe(-1);
  });

  it("lastindexof() returns the last matching index, -1 when not found", () => {
    expect(parray.lastindexof([10.0, 20.0, 10.0], 10.0)).toBe(2);
    expect(parray.lastindexof([10.0, 20.0, 10.0], 99.0)).toBe(-1);
  });

  it("includes()/indexof()/lastindexof() on a na (null) array return na (NaN) — 'read' branch of the #19 principle", () => {
    expect(Number.isNaN(parray.includes(null, 1.0) as number)).toBe(true);
    expect(Number.isNaN(parray.indexof(null, 1.0))).toBe(true);
    expect(Number.isNaN(parray.lastindexof(null, 1.0))).toBe(true);
  });

  it("includes()/indexof()/lastindexof() never match a NaN search value, even against a NaN-containing array (DIVERGENCES #22)", () => {
    // pine2py's `value in arr`/`arr.index(value)` compare by identity-then-`==` (CPython
    // list.__contains__/list.index). Two fresh `float('nan')` objects never satisfy either check
    // (`nan == nan` is False, and they aren't the same object) — this is the *normal*, overwhelmingly
    // common case (na literals, out-of-range Series.get(), arithmetic producing na all mint a new
    // float object each time) and it's exactly what JS strict-equality search gives too (NaN !== NaN).
    const arr = [1.0, NaN, 3.0];
    expect(parray.includes(arr, NaN)).toBe(false);
    expect(parray.indexof(arr, NaN)).toBe(-1);
    expect(parray.lastindexof(arr, NaN)).toBe(-1);
  });

  it("does NOT reproduce pine2py's CPython object-identity fast path for a NaN read back from the same array (DIVERGENCES #22, hand-verified — pine2py itself only diverges from 'not found' in this narrow, python-object-identity-dependent scenario: `array.includes(arr, array.get(arr, i))` where arr[i] is exactly the NaN object already stored in arr, which Python's `in`/`.index()` find via reference identity before falling back to `==`. JS number primitives have no identity concept, so pine2js's strict-equality search can't and shouldn't try to replicate it — every NaN search here uniformly reports 'not found', matching the practical majority of real call sites)", () => {
    const arr = [1.0, NaN, 3.0];
    const readBack = arr[1]; // same JS primitive value as arr[1] — no identity distinction exists
    expect(parray.includes(arr, readBack!)).toBe(false);
    expect(parray.indexof(arr, readBack!)).toBe(-1);
  });

  // ── covariance/percentile_nearest_rank/percentile_linear_interpolation/percentrank/standardize
  // (C83) — pine2py array.py L314-370, python/node 교차 실측(scratch/probe_array_stats2.mjs) 전
  // 케이스 바이트 단위 일치 확인. na(null) 배열은 sum/avg류(#21)와 동일한 "읽기는 na" 원칙 —
  // standardize만 참조형 반환이라 na가 null(get(#19)의 "읽기 na"를 배열 반환에 적용한 첫 사례). ──

  it("covariance() computes population covariance over index-aligned valid pairs", () => {
    // python(pine2py wa.covariance) 사전 검증: 0.875.
    expect(parray.covariance([1.0, 2.0, 3.0, 4.0], [2.0, 4.0, 5.0, 4.0])).toBeCloseTo(0.875, 9);
  });

  it("covariance() skips a pair when either side is NaN, and truncates to the shorter array's length", () => {
    expect(parray.covariance([1.0, NaN, 3.0, 4.0], [2.0, 4.0, 5.0, 4.0])).toBeCloseTo(1.2222222222222223, 9);
    expect(parray.covariance([1.0, 2.0, 3.0, 4.0, 5.0], [2.0, 4.0, 5.0])).toBeCloseTo(1.0, 9);
  });

  it("covariance() returns na with fewer than 2 valid pairs, or on a na (null) array", () => {
    expect(Number.isNaN(parray.covariance([1.0], [2.0]))).toBe(true);
    expect(Number.isNaN(parray.covariance(null, [1.0, 2.0]))).toBe(true);
    expect(Number.isNaN(parray.covariance([1.0, 2.0], null))).toBe(true);
  });

  it("percentile_nearest_rank() returns the value at the nearest-rank index (no interpolation)", () => {
    const vals = [1.0, 2.0, 3.0, 4.0, 5.0];
    expect(parray.percentile_nearest_rank(vals, 0.0)).toBe(1);
    expect(parray.percentile_nearest_rank(vals, 50.0)).toBe(3);
    expect(parray.percentile_nearest_rank(vals, 100.0)).toBe(5);
  });

  it("percentile_nearest_rank() clamps out-of-range percentages into [0, 100]", () => {
    const vals = [1.0, 2.0, 3.0, 4.0, 5.0];
    expect(parray.percentile_nearest_rank(vals, -10.0)).toBe(1);
    expect(parray.percentile_nearest_rank(vals, 200.0)).toBe(5);
  });

  it("percentile_nearest_rank()/percentile_linear_interpolation() clamp a NaN percentage to 100 (literal port of pine2py's `max(0, min(100, p))` quirk, NOT a divergence)", () => {
    // Python's builtin min(100.0, percentage) keeps 100.0 when percentage is nan (`nan < 100.0`
    // is False, so no replacement happens) — pine2py itself resolves this to 100%, not a crash
    // and not na (python 실측: percentile_nearest_rank([1..5], nan) == 5.0). This is deterministic
    // per fixed argument order (not the order-dependent rt.max/min bug, C13) and unverifiable
    // against real TV without WebSearch in this session, so it's literal-ported as-is (MEMORY.md
    // Pitfalls fallback). The JS implementation must NOT use Math.min/Math.max here — those
    // propagate NaN (opposite direction from Python's) and would silently produce NaN instead of
    // 100.
    const vals = [1.0, 2.0, 3.0, 4.0, 5.0];
    expect(parray.percentile_nearest_rank(vals, NaN)).toBe(5);
    expect(parray.percentile_linear_interpolation(vals, NaN)).toBe(5);
  });

  it("percentile_nearest_rank() returns na on an empty/all-na array or a na (null) array", () => {
    expect(Number.isNaN(parray.percentile_nearest_rank([], 50.0))).toBe(true);
    expect(Number.isNaN(parray.percentile_nearest_rank([NaN, NaN], 50.0))).toBe(true);
    expect(Number.isNaN(parray.percentile_nearest_rank(null, 50.0))).toBe(true);
  });

  it("percentile_linear_interpolation() interpolates between the two bracketing ranks", () => {
    const vals = [1.0, 2.0, 3.0, 4.0, 5.0];
    expect(parray.percentile_linear_interpolation(vals, 50.0)).toBe(3);
    expect(parray.percentile_linear_interpolation(vals, 25.0)).toBe(2);
  });

  it("percentile_linear_interpolation() returns the single element for a 1-valid array without dividing by zero, and na for empty/null", () => {
    expect(parray.percentile_linear_interpolation([7.0], 50.0)).toBe(7);
    expect(Number.isNaN(parray.percentile_linear_interpolation([], 50.0))).toBe(true);
    expect(Number.isNaN(parray.percentile_linear_interpolation(null, 50.0))).toBe(true);
  });

  it("percentrank() reports the percentage of valid elements strictly below value (ties do not count)", () => {
    expect(parray.percentrank([1.0, 2.0, 2.0, 3.0], 2.0)).toBe(25);
    expect(parray.percentrank([1.0, 2.0, 3.0, 4.0, 5.0], 3.0)).toBe(40);
  });

  it("percentrank() with a NaN value naturally reports 0 (every '<' comparison is false, no special-case needed — literal port)", () => {
    expect(parray.percentrank([1.0, 2.0, 3.0, 4.0, 5.0], NaN)).toBe(0);
  });

  it("percentrank() returns na on an empty array or a na (null) array", () => {
    expect(Number.isNaN(parray.percentrank([], 3.0))).toBe(true);
    expect(Number.isNaN(parray.percentrank(null, 3.0))).toBe(true);
  });

  it("standardize() z-score normalizes every element against the population mean/stdev", () => {
    const result = parray.standardize([1.0, 2.0, 3.0, 4.0, 5.0]);
    expect(result).not.toBeNull();
    result!.forEach((v, i) => expect(v).toBeCloseTo([-1.414213562373095, -0.7071067811865475, 0, 0.7071067811865475, 1.414213562373095][i]!, 9));
  });

  it("standardize() returns all 1.0 (arr.length, not vals.length) when stdev is exactly 0 (pine2py's own special-case branch)", () => {
    expect(parray.standardize([5.0, 5.0, 5.0])).toEqual([1.0, 1.0, 1.0]);
  });

  it("standardize() leaves na elements as na and preserves original order/position (not just the valid subsequence)", () => {
    const result = parray.standardize([5.0, NaN, 1.0, 3.0]);
    expect(result![0]).toBeCloseTo(1.224744871391589, 9);
    expect(Number.isNaN(result![1])).toBe(true);
    expect(result![2]).toBeCloseTo(-1.224744871391589, 9);
    expect(result![3]).toBeCloseTo(0, 9);
  });

  it("standardize() returns a shallow copy of the original array (na included) when fewer than 2 valid elements, and na/null passthrough", () => {
    const src = [1.0, NaN, NaN];
    const result = parray.standardize(src);
    expect(result).toEqual([1.0, NaN, NaN]);
    expect(result).not.toBe(src); // 새 배열(참조 아님) — pine2py `arr[:]`와 동치
    expect(parray.standardize([])).toEqual([]);
    expect(parray.standardize(null)).toBeNull();
  });
});

describe("array builtins — typed constructors + variadic (rt.array, C84)", () => {
  it("new_int() with no arguments returns an empty array (both defaults: size=0, initial_value=0)", () => {
    expect(parray.new_int()).toEqual([]);
  });

  it("new_int(size, initial_value) fills an array of the given size with the given int value", () => {
    expect(parray.new_int(3, 7)).toEqual([7, 7, 7]);
  });

  it("new_int(size) with the default initial_value fills with 0 (not NaN — differs from new_float's na default)", () => {
    expect(parray.new_int(3)).toEqual([0, 0, 0]);
  });

  it("new_int(na_size) returns na(null) — literal port of new_float's na-size crash decision (DIVERGENCES #19/#24)", () => {
    expect(parray.new_int(NaN)).toBeNull();
  });

  it("new_int(non_integer_size) truncates toward zero (Math.trunc convention)", () => {
    expect(parray.new_int(3.9)).toEqual([0, 0, 0]);
  });

  it("new_int(size<=0) returns an empty array", () => {
    expect(parray.new_int(0)).toEqual([]);
    expect(parray.new_int(-1)).toEqual([]);
  });

  it("new_bool() with no arguments returns an empty array (both defaults: size=0, initial_value=false)", () => {
    expect(parray.new_bool()).toEqual([]);
  });

  it("new_bool(size, initial_value) fills an array of the given size with the given bool value", () => {
    expect(parray.new_bool(2, true)).toEqual([true, true]);
    expect(parray.new_bool(2, false)).toEqual([false, false]);
  });

  it("new_bool(na_size) returns na(null) — same size-crash decision as new_int/new_float", () => {
    expect(parray.new_bool(NaN)).toBeNull();
  });

  it("new_string() with no arguments returns an empty array (both defaults: size=0, initial_value=\"\")", () => {
    expect(parray.new_string()).toEqual([]);
  });

  it("new_string(size, initial_value) fills an array of the given size with the given string value", () => {
    expect(parray.new_string(2, "hi")).toEqual(["hi", "hi"]);
  });

  it("new_string(na_size) returns na(null) — same size-crash decision as new_int/new_float", () => {
    expect(parray.new_string(NaN)).toBeNull();
  });

  it("new_color() with no arguments returns an empty array (both defaults: size=0, initial_value=\"\")", () => {
    expect(parray.new_color()).toEqual([]);
  });

  it("new_color(size, initial_value) fills an array of the given size with the given hex color string", () => {
    expect(parray.new_color(2, "#FF5252")).toEqual(["#FF5252", "#FF5252"]);
  });

  it("new_color(na_size) returns na(null) — same size-crash decision as new_int/new_float", () => {
    expect(parray.new_color(NaN)).toBeNull();
  });

  it("from(...items) returns the items as an array, preserving order and element type", () => {
    expect(parray.from(1.0, 2.0, 3.0)).toEqual([1.0, 2.0, 3.0]);
    expect(parray.from("a", "b")).toEqual(["a", "b"]);
    expect(parray.from(true, false, true)).toEqual([true, false, true]);
  });

  it("from() with a single item returns a single-element array", () => {
    expect(parray.from(9.0)).toEqual([9.0]);
  });

  it("from() with zero items returns an empty array (pine2py list(args) never crashes — no na decision needed)", () => {
    expect(parray.from()).toEqual([]);
  });
});

// ── array.new<T>(size, initial_value)의 T가 5종 원시 타입 밖(사용자 UDT 타입명 또는 label/
// chart.point 같은 built-in 특수 타입)일 때의 무타입 단일 생성자(C230, new_generic — parser.ts가
// attr을 이 이름으로 재작성). pine2py는 이 경우도 T와 무관하게 정확히 같은 무타입 단일 생성자로
// 라우팅하지만 그 함수의 initial_value 기본값(0)은 참조형 슬롯에 정수를 두는 Python 타입-무시
// 관행일 뿐이라(python 직접 실행으로 확인) literal port 대상이 아니다 — GOAL.md na 3분할(참조형
// na=null) 원칙대로 default를 null로 결정(corpus 4건 전부 size=0이라 이 기본값 차이 자체는
// 오라클로 검증 불가, DIVERGENCES.md 신규 등재). ──
describe("array builtins — untyped generic constructor for non-primitive T (rt.array, C230)", () => {
  it("new_generic() with no arguments returns an empty array (both defaults: size=0, initial_value=null)", () => {
    expect(parray.new_generic()).toEqual([]);
  });

  it("new_generic(size) with the default initial_value fills with null (na for reference types, not pine2py's untyped 0)", () => {
    expect(parray.new_generic(3)).toEqual([null, null, null]);
  });

  it("new_generic(size, initial_value) fills an array of the given size with the given value (any type — UDT instance, plain object, etc.)", () => {
    const udtLike = { price: 1.5 };
    expect(parray.new_generic(2, udtLike)).toEqual([udtLike, udtLike]);
  });

  it("new_generic(na_size) returns na(null) — same size-crash decision as new_float/new_int/new_bool/new_string/new_color", () => {
    expect(parray.new_generic(NaN)).toBeNull();
  });

  it("new_generic(non_integer_size) truncates toward zero (Math.trunc convention)", () => {
    expect(parray.new_generic(2.9, 1)).toEqual([1, 1]);
  });

  it("new_generic(size<=0) returns an empty array", () => {
    expect(parray.new_generic(0)).toEqual([]);
    expect(parray.new_generic(-1)).toEqual([]);
  });
});

// array.new_label/new_line/new_box/new_table/new_linefill(C236) — v4식 명명 typed 생성자
// (drawing 핸들 전용, corpus 5건 실측). pine2py codegen.py L1497-1501이 5종 전부 T와 무관하게
// array.new<T> 제네릭과 정확히 같은 무타입 단일 생성자로 라우팅하므로(위 new_generic과 동일 함수)
// 별도 구현 대신 alias — 그 자체가 결과에 영향을 주는 유일한 지점이라 "같은 함수 참조인가"만 확인
// (동작 자체는 위 new_generic 테스트가 이미 전수 커버).
describe("array builtins — named typed constructors for drawing handles alias new_generic (C236)", () => {
  const NAMED_DRAWING_CONSTRUCTORS = ["new_label", "new_line", "new_box", "new_table", "new_linefill"] as const;

  it.each(NAMED_DRAWING_CONSTRUCTORS)(
    "array.%s is the exact same function reference as new_generic (pine2py routes all to wa.builtins.array.new)",
    (name) => {
      expect(parray[name]).toBe(parray.new_generic);
    },
  );
});

// ── sort/reverse/slice/concat/copy (C85) — pine2py array.py L159-195. sort/reverse mutate
// in-place; slice/concat/copy return a new array. na(null) array: sort/reverse are "writes" (no-op,
// #19/#20 principle), slice/concat/copy are reference-type "reads" (na propagates as null, same as
// standardize C83). python/node cross-check confirmed byte-for-byte before implementing (Bash
// history — no scratch file needed for this straightforward case). ──
describe("array builtins — sort/reverse/slice/concat/copy (rt.array, C85)", () => {
  it("sort(arr) defaults to ascending order", () => {
    const arr = [3, 1, 2];
    parray.sort(arr);
    expect(arr).toEqual([1, 2, 3]);
  });

  it("sort(arr, true) sorts ascending explicitly (order.ascending)", () => {
    const arr = [3, 1, 2];
    parray.sort(arr, true);
    expect(arr).toEqual([1, 2, 3]);
  });

  it("sort(arr, false) sorts descending (order.descending)", () => {
    const arr = [3, 1, 2];
    parray.sort(arr, false);
    expect(arr).toEqual([3, 2, 1]);
  });

  it("sort places NaN elements at the end regardless of ascending/descending", () => {
    const asc = [3, NaN, 1, 2];
    parray.sort(asc, true);
    expect(asc.slice(0, 3)).toEqual([1, 2, 3]);
    expect(asc[3]).toBeNaN();

    const desc = [3, NaN, 1, 2];
    parray.sort(desc, false);
    expect(desc.slice(0, 3)).toEqual([3, 2, 1]);
    expect(desc[3]).toBeNaN();
  });

  it("sort preserves the relative order of equal elements (stable sort, matches Python list.sort())", () => {
    const arr = [3, 1, 2, 1];
    parray.sort(arr, true);
    expect(arr).toEqual([1, 1, 2, 3]);
  });

  it("sort(null) is a no-op (write on na array — #19/#20 principle)", () => {
    expect(() => parray.sort(null)).not.toThrow();
  });

  it("reverse(arr) reverses in-place", () => {
    const arr = [1, 2, 3];
    parray.reverse(arr);
    expect(arr).toEqual([3, 2, 1]);
  });

  it("reverse(null) is a no-op (write on na array)", () => {
    expect(() => parray.reverse(null)).not.toThrow();
  });

  it("slice() with no from/to args returns a copy of the whole array", () => {
    expect(parray.slice([10, 20, 30, 40, 50])).toEqual([10, 20, 30, 40, 50]);
  });

  it("slice(arr, from, to) returns the [from, to) sub-range", () => {
    expect(parray.slice([10, 20, 30, 40, 50], 1, 3)).toEqual([20, 30]);
  });

  it("slice(arr, negative_from) counts from the end (JS/Python slicing are equivalent here)", () => {
    expect(parray.slice([10, 20, 30, 40, 50], -2)).toEqual([40, 50]);
  });

  it("slice(arr, from, any_negative_to) treats ANY negative index_to as the sentinel for full length, not a from-the-end offset (pine2py literal port — index_to=-2 is NOT 'drop last 2')", () => {
    expect(parray.slice([10, 20, 30, 40, 50], 0, -2)).toEqual([10, 20, 30, 40, 50]);
  });

  it("slice(arr, out_of_range) clamps quietly like Python slicing", () => {
    expect(parray.slice([10, 20, 30, 40, 50], 10, 20)).toEqual([]);
    expect(parray.slice([10, 20, 30, 40, 50], -100, 3)).toEqual([10, 20, 30]);
  });

  it("slice(arr) does not mutate the original array (new array reference)", () => {
    const arr = [1, 2, 3];
    const s = parray.slice(arr)!;
    s.push(99);
    expect(arr).toEqual([1, 2, 3]);
  });

  it("slice(null) returns na(null) — reference-type read na (same class as standardize C83)", () => {
    expect(parray.slice(null)).toBeNull();
  });

  it("slice(arr, NaN index_from/index_to) returns na(null) — pine2py crashes on NaN slice indices (undefined), JS would otherwise silently coerce NaN to 0", () => {
    expect(parray.slice([1, 2, 3], NaN)).toBeNull();
    expect(parray.slice([1, 2, 3], 0, NaN)).toBeNull();
  });

  it("concat(arr1, arr2) returns a new array with arr2 appended to arr1, without mutating either input", () => {
    const a = [1, 2];
    const b = [3, 4];
    expect(parray.concat(a, b)).toEqual([1, 2, 3, 4]);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([3, 4]);
  });

  it("concat(null, arr) / concat(arr, null) return na(null) — pine2py `None + list` crashes (undefined)", () => {
    expect(parray.concat(null, [1, 2])).toBeNull();
    expect(parray.concat([1, 2], null)).toBeNull();
  });

  it("copy(arr) returns a new array with the same elements, independent of the original", () => {
    const arr = [1, 2, 3];
    const c = parray.copy(arr)!;
    expect(c).toEqual([1, 2, 3]);
    c.push(99);
    expect(arr).toEqual([1, 2, 3]);
  });

  it("copy(null) returns na(null) — reference-type read na", () => {
    expect(parray.copy(null)).toBeNull();
  });
});

describe("udtCopy (UDT .copy() shallow-copy sugar, C125, DIVERGENCES.md #57)", () => {
  it("returns a new top-level object, independent of the original", () => {
    const orig = { x: 1.0, y: 2.0 };
    const dup = udtCopy(orig)!;
    expect(dup).toEqual(orig);
    expect(dup).not.toBe(orig);
    dup.x = 999;
    expect(orig.x).toBe(1.0);
  });

  it("shares the SAME nested object reference between original and copy (true Python copy.copy() shallow semantics, not a deep copy)", () => {
    const inner = { x: 1.0 };
    const orig = { inner, label: 0.0 };
    const dup = udtCopy(orig)!;
    expect(dup.inner).toBe(orig.inner);
    (dup.inner as { x: number }).x = 999;
    expect((orig.inner as { x: number }).x).toBe(999);
  });

  it("copy(null) returns na(null) — same class as array.copy/map.copy/matrix.copy", () => {
    expect(udtCopy(null)).toBeNull();
  });
});

describe("input.int/float/bool/string (첫 슬라이스, C131 — 외부 오버라이드 dict 우선 조회)", () => {
  it("int: no override -> returns defval", () => {
    expect(pinput.int({}, 14, "Length")).toBe(14);
  });

  it("int: override present under the title key -> returns the override, not defval", () => {
    expect(pinput.int({ Length: 99 }, 14, "Length")).toBe(99);
  });

  it("int: override present under a DIFFERENT title -> falls back to defval (title 불일치는 무시)", () => {
    expect(pinput.int({ Other: 99 }, 14, "Length")).toBe(14);
  });

  it("int: empty title never matches an override, even if the dict has an empty-string key (title 없는 input은 오버라이드 불가)", () => {
    expect(pinput.int({ "": 99 }, 14, "")).toBe(14);
  });

  it("float: no override -> returns defval; override present -> returns override", () => {
    expect(pinput.float({}, 2.5, "Multiplier")).toBe(2.5);
    expect(pinput.float({ Multiplier: 7.25 }, 2.5, "Multiplier")).toBe(7.25);
  });

  it("bool: no override -> returns defval; override present -> returns override (override flips the value)", () => {
    expect(pinput.bool({}, true, "Use Filter")).toBe(true);
    expect(pinput.bool({ "Use Filter": false }, true, "Use Filter")).toBe(false);
  });

  it("string: no override -> returns defval; override present -> returns override", () => {
    expect(pinput.string({}, "hello", "Label")).toBe("hello");
    expect(pinput.string({ Label: "world" }, "hello", "Label")).toBe("world");
  });

  it("minval/maxval/step are accepted but never consulted (literal port of pine2py's no-op stub — no clamping)", () => {
    expect(pinput.int({}, 500, "Length", 1, 10, 1)).toBe(500);
    expect(pinput.float({}, -5.0, "X", 0.0, 1.0)).toBe(-5.0);
  });

  it("all four default to pine2py's stub defaults when called with no args at all", () => {
    expect(pinput.int({})).toBe(0);
    expect(pinput.float({})).toBe(0.0);
    expect(pinput.bool({})).toBe(false);
    expect(pinput.string({})).toBe("");
  });
});

describe("input.color/source/symbol/timeframe/session/price/text_area/time + bare input() (세 번째 슬라이스, C133)", () => {
  it("color: no override -> returns defval; override present -> returns override", () => {
    expect(pinput.color({}, "#ff0000", "Line Color")).toBe("#ff0000");
    expect(pinput.color({ "Line Color": "#00ff00" }, "#ff0000", "Line Color")).toBe("#00ff00");
  });

  it("source: no override -> returns defval as-is (unknown type, Any-typed passthrough like pine2py's source_input)", () => {
    expect(pinput.source({}, 1.5, "Source")).toBe(1.5);
    expect(pinput.source({ Source: 2.5 }, 1.5, "Source")).toBe(2.5);
  });

  it("symbol/timeframe/session/text_area: no override -> returns defval; override present -> returns override", () => {
    expect(pinput.symbol({}, "AAPL", "Symbol")).toBe("AAPL");
    expect(pinput.symbol({ Symbol: "MSFT" }, "AAPL", "Symbol")).toBe("MSFT");
    expect(pinput.timeframe({}, "60", "Timeframe")).toBe("60");
    expect(pinput.timeframe({ Timeframe: "D" }, "60", "Timeframe")).toBe("D");
    expect(pinput.session({}, "0930-1600", "Session")).toBe("0930-1600");
    expect(pinput.session({ Session: "24x7" }, "0930-1600", "Session")).toBe("24x7");
    expect(pinput.text_area({}, "notes", "Notes")).toBe("notes");
    expect(pinput.text_area({ Notes: "override" }, "notes", "Notes")).toBe("override");
  });

  it("price: no override -> returns defval; override present -> returns override", () => {
    expect(pinput.price({}, 100.5, "Price")).toBe(100.5);
    expect(pinput.price({ Price: 200 }, 100.5, "Price")).toBe(200);
  });

  it("time: no override -> returns defval; override present -> returns override", () => {
    expect(pinput.time({}, 0, "Time")).toBe(0);
    expect(pinput.time({ Time: 1700000000 }, 0, "Time")).toBe(1700000000);
  });

  it("bare 'any': no override -> returns defval as-is; override present -> returns override", () => {
    expect(pinput.any({}, 7, "Any Input")).toBe(7);
    expect(pinput.any({ "Any Input": 42 }, 7, "Any Input")).toBe(42);
  });

  it("all 9 default to pine2py's stub defaults when called with no args at all", () => {
    expect(pinput.color({})).toBe("");
    expect(pinput.source({})).toBeNull();
    expect(pinput.symbol({})).toBe("");
    expect(pinput.timeframe({})).toBe("");
    expect(pinput.session({})).toBe("");
    expect(pinput.price({})).toBe(0);
    expect(pinput.text_area({})).toBe("");
    expect(pinput.time({})).toBe(0);
    expect(pinput.any({})).toBeNull();
  });
});

describe("input.enum (C134 — last input.* method, exported as enumInput since 'enum' is a reserved JS identifier)", () => {
  it("no override -> returns defval as-is (Any-typed passthrough like source/any)", () => {
    expect(pinput.enumInput({}, "A", "Choice", ["A", "B"])).toBe("A");
  });

  it("override present -> returns override, options argument ignored either way (pine2py enum_input never reads it)", () => {
    expect(pinput.enumInput({ Choice: "B" }, "A", "Choice", ["A", "B"])).toBe("B");
  });

  it("defaults to pine2py's stub default (null) when called with no args at all", () => {
    expect(pinput.enumInput({})).toBeNull();
  });
});

// ── abs/every/some/range/binary_search·leftmost·rightmost/sort_indices (C86) — pine2py
// array.py L260-392. abs/sort_indices return a new array (reference-type read na — null on
// na array, same class as slice/standardize). every/some/range/binary_search* return scalars
// (numeric-na — NaN on na array, same class as includes C82). python/node cross-check confirmed
// byte-for-byte before implementing (Bash history — no scratch file needed). ──
describe("array builtins — abs/every/some/range/binary_search·leftmost·rightmost/sort_indices (rt.array, C86)", () => {
  it("abs(arr) maps each element to its absolute value (new array, source untouched)", () => {
    const arr = [-3, 4.5, -0.5];
    expect(parray.abs(arr)).toEqual([3, 4.5, 0.5]);
    expect(arr).toEqual([-3, 4.5, -0.5]);
  });

  it("abs(arr) leaves NaN elements unchanged (Math.abs(NaN) is already NaN — no special branch needed)", () => {
    const result = parray.abs([1, NaN, -2])!;
    expect(result[0]).toBe(1);
    expect(result[1]).toBeNaN();
    expect(result[2]).toBe(2);
  });

  it("abs(null) returns na(null) — reference-type read na", () => {
    expect(parray.abs(null)).toBeNull();
  });

  it("every(arr) is true when all elements are truthy, false when any is 0", () => {
    expect(parray.every([1, 2, 3])).toBe(true);
    expect(parray.every([1, 0, 3])).toBe(false);
  });

  it("every(arr) is false when any element is NaN (JS NaN is already falsy — Python needs an explicit isnan branch, JS doesn't, MEMORY.md Pitfalls)", () => {
    expect(parray.every([1, NaN, 3])).toBe(false);
  });

  it("every([]) is true (no elements to fail the check, matches pine2py)", () => {
    expect(parray.every([])).toBe(true);
  });

  it("every(null) returns na(NaN) — numeric-na for a bool-returning read (same convention as includes C82)", () => {
    expect(parray.every(null)).toBeNaN();
  });

  it("some(arr) is true when any element is truthy, false when all are falsy (0/NaN)", () => {
    expect(parray.some([0, NaN, 5])).toBe(true);
    expect(parray.some([0, NaN])).toBe(false);
  });

  it("some([]) is false (no truthy element found, matches pine2py)", () => {
    expect(parray.some([])).toBe(false);
  });

  it("some(null) returns na(NaN)", () => {
    expect(parray.some(null)).toBeNaN();
  });

  it("range(arr) is max-min over valid (non-NaN) elements", () => {
    expect(parray.range([3, 1, 7, NaN])).toBe(6);
  });

  it("range(arr) is na when there are no valid elements (empty or all-NaN)", () => {
    expect(parray.range([])).toBeNaN();
    expect(parray.range([NaN, NaN])).toBeNaN();
  });

  it("range(null) returns na(NaN)", () => {
    expect(parray.range(null)).toBeNaN();
  });

  it("binary_search(arr, value) returns the index when found, -1 when missing", () => {
    expect(parray.binary_search([1, 3, 5, 7], 5)).toBe(2);
    expect(parray.binary_search([1, 3, 5, 7], 4)).toBe(-1);
  });

  it("binary_search([], value) returns -1 (empty array, no crash)", () => {
    expect(parray.binary_search([], 5)).toBe(-1);
  });

  it("binary_search(arr, NaN) returns -1 (bisect converges to lo=0 via '<' comparisons that are always false against NaN, then the strict-equality check fails)", () => {
    expect(parray.binary_search([1, 2, 3], NaN)).toBe(-1);
  });

  it("binary_search(null, value) returns na(NaN)", () => {
    expect(parray.binary_search(null, 5)).toBeNaN();
  });

  it("binary_search_leftmost/rightmost bracket a run of duplicate values (bisect_left/bisect_right, matches Python cross-check: leftmost=1, rightmost=4)", () => {
    const arr = [1, 3, 3, 3, 7];
    expect(parray.binary_search_leftmost(arr, 3)).toBe(1);
    expect(parray.binary_search_rightmost(arr, 3)).toBe(4);
    expect(parray.binary_search(arr, 3)).toBe(1);
  });

  it("binary_search_leftmost/rightmost(null, value) return na(NaN)", () => {
    expect(parray.binary_search_leftmost(null, 3)).toBeNaN();
    expect(parray.binary_search_rightmost(null, 3)).toBeNaN();
  });

  it("sort_indices(arr) defaults to ascending order, NaN-holding indices appended last in original order", () => {
    expect(parray.sort_indices([3, 1, 2, NaN])).toEqual([1, 2, 0, 3]);
  });

  it("sort_indices(arr, false) sorts descending (order.descending)", () => {
    expect(parray.sort_indices([3, 1, 2, NaN], false)).toEqual([0, 2, 1, 3]);
  });

  it("sort_indices preserves the original relative order of tied elements in both directions (Python list.sort(reverse=True) does not reverse ties, matches cross-check)", () => {
    expect(parray.sort_indices([2, 1, 1, 3])).toEqual([1, 2, 0, 3]);
    expect(parray.sort_indices([2, 1, 1, 3], false)).toEqual([3, 0, 1, 2]);
  });

  it("sort_indices does not mutate the source array", () => {
    const arr = [3, 1, 2];
    parray.sort_indices(arr);
    expect(arr).toEqual([3, 1, 2]);
  });

  it("sort_indices(null) returns na(null) — reference-type read na", () => {
    expect(parray.sort_indices(null)).toBeNull();
  });
});

// ── array.join (C88, pine2py array.py L193-195 `separator.join(str(x) for x in arr)`) —
// ROADMAP array.* 49종 완료. na(null) 배열/separator는 get/size(#19)류의 "읽기는 na" 원칙을
// 참조형 반환에 적용해 na(null)(slice/standardize/sort_indices와 동일 계열). 원소별 포맷은
// array.ts join 주석 참조 — number는 pyFloatStr(str.tostring(C87) 기본 분기 재사용, NaN은 소문자
// "nan" literal port — tostring의 대문자 "NaN" 가드와 다른 지점), boolean은 Python str(bool)
// literal port(대문자 "True"/"False", TV 미검증), string은 그대로 통과.
describe("array.join (rt.array.join, C88)", () => {
  it("joins a float array with the default separator (pine2py `separator: str = \" \"` — single space)", () => {
    expect(parray.join([1.0, 2.0, 3.0])).toBe("1.0 2.0 3.0");
  });

  it("joins a float array with a custom separator, whole numbers render with a trailing '.0' (pyFloatStr, matches str.tostring's default branch)", () => {
    expect(parray.join([1.0, 2.0, 3.0], ",")).toBe("1.0,2.0,3.0");
  });

  it("formats negative/zero/decimal float elements via pyFloatStr", () => {
    expect(parray.join([-3.5, 0.0, 100.25], "|")).toBe("-3.5|0.0|100.25");
  });

  it("renders a NaN element as lowercase 'nan' (pine2py `str(float('nan'))=='nan'` — no explicit NaN guard in join(), unlike str.tostring's uppercase 'NaN')", () => {
    expect(parray.join([1.0, NaN, 2.0], ",")).toBe("1.0,nan,2.0");
  });

  it("passes string elements through unchanged", () => {
    expect(parray.join(["a", "b", "c"], "-")).toBe("a-b-c");
  });

  it("renders boolean elements with Python capitalization (literal port of pine2py str(bool) — TV real display convention unverified, VERIFIED_SEMANTICS.md has no entry)", () => {
    expect(parray.join([true, false, true], ",")).toBe("True,False,True");
  });

  it("treats a null element (reference-type na) the same as a NaN element — lowercase 'nan'", () => {
    expect(parray.join(["a", null, "b"], ",")).toBe("a,nan,b");
  });

  it("joins an empty array to an empty string", () => {
    expect(parray.join([], ",")).toBe("");
  });

  it("supports an empty-string separator (elements concatenated with no delimiter)", () => {
    expect(parray.join([1.0, 2.0], "")).toBe("1.02.0");
  });

  it("does not mutate the source array", () => {
    const arr = [1.0, 2.0];
    parray.join(arr, ",");
    expect(arr).toEqual([1.0, 2.0]);
  });

  it("join(null) returns na(null) — reference-type read na, pine2py `for x in None` crashes undefined", () => {
    expect(parray.join(null, ",")).toBeNull();
  });

  it("join(arr, null) returns na(null) — separator na, pine2py `None.join(...)` crashes undefined", () => {
    expect(parray.join([1.0, 2.0], null)).toBeNull();
  });
});

// ── map.* (C89, pine2py wavealgo/builtins/map_funcs.py — 11종 전체) — na(null) 맵 인자는
// get/size(#19)류의 "읽기는 na, 쓰기는 no-op" 원칙을 그대로 재적용(pine2py가 None 맵 인자에
// 가드 없이 크래시하는 미정의 동작이라 pine2py 오라클로 검증 불가 — 여기서 hand-verified로 대체).
describe("map.new (rt.map.new, C89)", () => {
  it("creates an empty map", () => {
    const m = pmap.newMap();
    expect(m.size).toBe(0);
  });

  it("creates independent map instances on each call", () => {
    const a = pmap.newMap();
    const b = pmap.newMap();
    pmap.put(a, "k", 1.0);
    expect(b.has("k")).toBe(false);
  });
});

describe("map.put (rt.map.put, C89)", () => {
  it("returns na(NaN) for a previously-absent key, then stores the value", () => {
    const m = pmap.newMap();
    const prev = pmap.put(m, "k", 1.0);
    expect(Number.isNaN(prev as number)).toBe(true);
    expect(m.get("k")).toBe(1.0);
  });

  it("returns the previous value and overwrites it on a repeated put", () => {
    const m = pmap.newMap();
    pmap.put(m, "k", 1.0);
    const prev = pmap.put(m, "k", 2.0);
    expect(prev).toBe(1.0);
    expect(m.get("k")).toBe(2.0);
  });

  it("put(null map, ...) is a no-op that returns na(NaN) — pine2py `m[key]=value` on None crashes undefined", () => {
    const prev = pmap.put(null, "k", 1.0);
    expect(Number.isNaN(prev as number)).toBe(true);
  });
});

describe("map.get (rt.map.get, C89)", () => {
  it("returns the stored value for a present key", () => {
    const m = pmap.newMap();
    pmap.put(m, "k", 5.0);
    expect(pmap.get(m, "k")).toBe(5.0);
  });

  it("returns na(NaN) for an absent key when no default is given (pine2py default=nan)", () => {
    const m = pmap.newMap();
    expect(Number.isNaN(pmap.get(m, "missing") as number)).toBe(true);
  });

  it("get(null map, key) returns na(NaN) — treated as an empty map (#19 read-na extended to a keyed lookup)", () => {
    expect(Number.isNaN(pmap.get(null, "k") as number)).toBe(true);
  });

  it("returns the explicit 3rd-arg default for an absent key (C241, pine2py get(m, key, default=nan))", () => {
    const m = pmap.newMap();
    expect(pmap.get(m, "missing", 0.0)).toBe(0.0);
  });

  it("returns the stored value (not the default) for a present key even with a 3rd-arg default", () => {
    const m = pmap.newMap();
    pmap.put(m, "k", 5.0);
    expect(pmap.get(m, "k", 0.0)).toBe(5.0);
  });

  it("get(null map, key, default) returns the default — na map treated as empty", () => {
    expect(pmap.get(null, "k", 0.0)).toBe(0.0);
  });
});

describe("map.remove (rt.map.remove, C89)", () => {
  it("removes a present key and returns its value", () => {
    const m = pmap.newMap();
    pmap.put(m, "k", 3.0);
    const removed = pmap.remove(m, "k");
    expect(removed).toBe(3.0);
    expect(m.has("k")).toBe(false);
  });

  it("returns na(NaN) for an absent key without mutating the map", () => {
    const m = pmap.newMap();
    pmap.put(m, "other", 1.0);
    const removed = pmap.remove(m, "missing");
    expect(Number.isNaN(removed as number)).toBe(true);
    expect(m.size).toBe(1);
  });

  it("remove(null map, key) returns na(NaN) — pine2py `m.pop(key, nan)` on None crashes undefined", () => {
    expect(Number.isNaN(pmap.remove(null, "k") as number)).toBe(true);
  });
});

describe("map.contains (rt.map.contains, C89)", () => {
  it("returns true for a present key, false otherwise", () => {
    const m = pmap.newMap();
    pmap.put(m, "k", 1.0);
    expect(pmap.contains(m, "k")).toBe(true);
    expect(pmap.contains(m, "missing")).toBe(false);
  });

  it("contains(null map, key) returns false — boolean has no na state, treated as an empty map", () => {
    expect(pmap.contains(null, "k")).toBe(false);
  });
});

describe("map.keys/map.values (rt.map.keys/rt.map.values, C89)", () => {
  it("returns keys/values in insertion order (matches Python dict ordering)", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    pmap.put(m, "b", 2.0);
    expect(pmap.keys(m)).toEqual(["a", "b"]);
    expect(pmap.values(m)).toEqual([1.0, 2.0]);
  });

  it("returns a new array each call (mutating the result does not affect the map)", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    const ks = pmap.keys(m)!;
    ks.push("intruder");
    expect(pmap.keys(m)).toEqual(["a"]);
  });

  it("keys(null map)/values(null map) return na(null) — reference-type read na, same class as array.standardize(#19)", () => {
    expect(pmap.keys(null)).toBeNull();
    expect(pmap.values(null)).toBeNull();
  });
});

describe("map.size (rt.map.size, C89)", () => {
  it("returns the number of entries", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    pmap.put(m, "b", 2.0);
    expect(pmap.size(m)).toBe(2);
  });

  it("size(null map) returns na(NaN) — matches array.size", () => {
    expect(Number.isNaN(pmap.size(null))).toBe(true);
  });
});

describe("map.clear (rt.map.clear, C89)", () => {
  it("removes all entries in place", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    pmap.put(m, "b", 2.0);
    pmap.clear(m);
    expect(m.size).toBe(0);
  });

  it("clear(null map) is a no-op (does not throw)", () => {
    expect(() => pmap.clear(null)).not.toThrow();
  });
});

describe("map.copy (rt.map.copy, C89)", () => {
  it("creates an independent shallow copy", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    const m2 = pmap.copy(m)!;
    pmap.put(m2, "a", 999.0);
    expect(m.get("a")).toBe(1.0);
    expect(m2.get("a")).toBe(999.0);
  });

  it("copy(null map) returns na(null) — same class as array.copy(#19/#23)", () => {
    expect(pmap.copy(null)).toBeNull();
  });
});

describe("map.put_all (rt.map.put_all, C89)", () => {
  it("merges all entries from the other map in place, overwriting shared keys", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    const other = pmap.newMap();
    pmap.put(other, "a", 999.0);
    pmap.put(other, "b", 2.0);
    pmap.put_all(m, other);
    expect(m.get("a")).toBe(999.0);
    expect(m.get("b")).toBe(2.0);
    expect(m.size).toBe(2);
  });

  it("put_all(null, other) is a no-op (does not throw)", () => {
    const other = pmap.newMap();
    pmap.put(other, "a", 1.0);
    expect(() => pmap.put_all(null, other)).not.toThrow();
  });

  it("put_all(m, null) is a no-op — na 'other' treated as having nothing to merge", () => {
    const m = pmap.newMap();
    pmap.put(m, "a", 1.0);
    pmap.put_all(m, null);
    expect(m.size).toBe(1);
    expect(m.get("a")).toBe(1.0);
  });
});

// ── matrix.* (C90, pine2py wavealgo/builtins/matrix.py — 첫 슬라이스: new/get/set/rows/columns/
// elements_count 6종). pine2py matrix.py는 array.py(0<=index<len 가드)와 달리 get/set/rows/
// columns에 가드가 전혀 없어(범위 밖 IndexError, None 인자 크래시) 전부 미정의 동작 — array.*
// (#19)가 이미 확립한 "읽기는 na, 쓰기는 no-op" 원칙을 그대로 재적용해 pine2py 오라클로 검증
// 불가한 부분은 여기서 hand-verified로 대체.
describe("matrix.new (rt.matrix.new, C90)", () => {
  it("creates a rows x columns matrix filled with the initial value", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    expect(m).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  it("defaults to a 0x0 empty matrix when no arguments are given (pine2py rows=0/columns=0/initial_value=nan)", () => {
    const m = pmatrix.newMatrix()!;
    expect(m).toEqual([]);
  });

  it("creates independent matrix instances on each call (separate row arrays too)", () => {
    const a = pmatrix.newMatrix(1, 1, 0.0)!;
    const b = pmatrix.newMatrix(1, 1, 0.0)!;
    a[0]![0] = 999;
    expect(b[0]![0]).toBe(0);
  });

  it("rows<=0 returns an empty matrix regardless of columns (Python `range(rows)` on non-positive rows is empty)", () => {
    expect(pmatrix.newMatrix(0, 5, 1.0)).toEqual([]);
    expect(pmatrix.newMatrix(-3, 5, 1.0)).toEqual([]);
  });

  it("rows>0 with columns<=0 returns that many empty rows (Python `[v]*columns` on non-positive columns is [])", () => {
    expect(pmatrix.newMatrix(2, 0, 1.0)).toEqual([[], []]);
    expect(pmatrix.newMatrix(2, -1, 1.0)).toEqual([[], []]);
  });

  it("new(na, columns) / new(rows, na) returns na(null) — pine2py `range(nan)` crashes undefined, new_float(#19)와 동일 결정", () => {
    expect(pmatrix.newMatrix(NaN, 2, 0.0)).toBeNull();
    expect(pmatrix.newMatrix(2, NaN, 0.0)).toBeNull();
  });

  it("truncates non-integer rows/columns toward zero (Math.trunc, array index 규약 재사용)", () => {
    const m = pmatrix.newMatrix(2.9, 2.9, 0.0)!;
    expect(m.length).toBe(2);
    expect(m[0]!.length).toBe(2);
  });
});

describe("matrix.get (rt.matrix.get, C90)", () => {
  it("returns the stored value at (row, column)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[1]![0] = 5.0;
    expect(pmatrix.get(m, 1, 0)).toBe(5.0);
  });

  it("returns na(NaN) for an out-of-range row or column (pine2py crashes with IndexError undefined — new decision, no array.py-style guard exists)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    expect(Number.isNaN(pmatrix.get(m, 5, 0) as number)).toBe(true);
    expect(Number.isNaN(pmatrix.get(m, 0, 5) as number)).toBe(true);
    expect(Number.isNaN(pmatrix.get(m, -1, 0) as number)).toBe(true);
  });

  it("get(null matrix, row, column) returns na(NaN) — read-na (#19 원칙 재적용)", () => {
    expect(Number.isNaN(pmatrix.get(null, 0, 0) as number)).toBe(true);
  });

  it("returns na(NaN) instead of crashing when row or column index itself is na(NaN) — C91 회귀 테스트: C90의 부정형 가드(`r<0||r>=len`)는 NaN과의 모든 비교가 false라 NaN row가 통과해버려 `.length` 접근에서 실제로 크래시했고, NaN column은 크래시 없이 `undefined`를 반환하는 은닉 오답이었다(긍정형 `r>=0&&r<len`으로 수정, array.get(#19)과 동일한 가드 모양으로 통일)", () => {
    const m = pmatrix.newMatrix(2, 2, 5.0)!;
    expect(() => pmatrix.get(m, NaN, 0)).not.toThrow();
    expect(Number.isNaN(pmatrix.get(m, NaN, 0) as number)).toBe(true);
    expect(Number.isNaN(pmatrix.get(m, 0, NaN) as number)).toBe(true);
  });

  it("truncates non-integer row/column indices toward zero", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[1]![1] = 7.0;
    expect(pmatrix.get(m, 1.9, 1.9)).toBe(7.0);
  });
});

describe("matrix.set (rt.matrix.set, C90)", () => {
  it("stores a value at (row, column) in place", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    pmatrix.set(m, 0, 1, 9.0);
    expect(m[0]![1]).toBe(9.0);
  });

  it("is a no-op for an out-of-range row or column (write-na-op, #19 원칙 재적용)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    pmatrix.set(m, 5, 0, 9.0);
    pmatrix.set(m, 0, 5, 9.0);
    expect(m).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("set(null matrix, ...) is a no-op that does not throw — pine2py `m[row][column]=value` on None crashes undefined", () => {
    expect(() => pmatrix.set(null, 0, 0, 9.0)).not.toThrow();
  });

  it("is a no-op (does not throw, does not mutate) when row or column index is na(NaN) — C91 회귀 테스트, matrix.get과 동일한 부정형->긍정형 가드 수정", () => {
    const m = pmatrix.newMatrix(2, 2, 5.0)!;
    expect(() => pmatrix.set(m, NaN, 0, 9.0)).not.toThrow();
    expect(() => pmatrix.set(m, 0, NaN, 9.0)).not.toThrow();
    expect(m).toEqual([
      [5, 5],
      [5, 5],
    ]);
  });
});

describe("matrix.row (rt.matrix.row, C91)", () => {
  it("returns a copy of the given row as a new array", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    m[1] = [7, 8, 9];
    const r = pmatrix.row(m, 1);
    expect(r).toEqual([7, 8, 9]);
    // 복사본이어야 함 — 반환된 배열을 바꿔도 원본 행렬이 바뀌지 않음.
    (r as number[])[0] = 999;
    expect(m[1]).toEqual([7, 8, 9]);
  });

  it("returns na(null) for an out-of-range row (positive or negative — see rt/matrix.ts C91 comment: pine2py's guardless `list(m[index])` accidentally allows Python negative wraparound, but sibling matrix.get/set(C90) already reject negative indices, so row/col follow that precedent instead of literal-porting the wraparound)", () => {
    const m = pmatrix.newMatrix(3, 2, 0.0)!;
    expect(pmatrix.row(m, 5)).toBeNull();
    expect(pmatrix.row(m, -1)).toBeNull();
    expect(pmatrix.row(m, -3)).toBeNull();
  });

  it("returns na(null) for any index on a 0-row matrix (pine2py itself crashes with IndexError here regardless of index — avoiding the crash is a new decision, not a literal port)", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(pmatrix.row(m, 0)).toBeNull();
    expect(pmatrix.row(m, -1)).toBeNull();
  });

  it("returns an empty array for a row of a matrix with 0 columns (row itself is a well-defined empty row, not na)", () => {
    const m = pmatrix.newMatrix(2, 0, 0.0)!;
    expect(pmatrix.row(m, 0)).toEqual([]);
  });

  it("row(null matrix, index) returns na(null) — read-na on reference type (#19/#23 원칙 재적용)", () => {
    expect(pmatrix.row(null, 0)).toBeNull();
  });

  it("truncates a non-integer row index toward zero", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[1] = [1, 2];
    expect(pmatrix.row(m, 1.9)).toEqual([1, 2]);
  });

  it("returns na(null) instead of crashing when the row index itself is na(NaN)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    expect(() => pmatrix.row(m, NaN)).not.toThrow();
    expect(pmatrix.row(m, NaN)).toBeNull();
  });
});

describe("matrix.col (rt.matrix.col, C91)", () => {
  it("returns the given column across all rows as a new array", () => {
    const m = pmatrix.newMatrix(3, 2, 0.0)!;
    m[0] = [1, 10];
    m[1] = [2, 20];
    m[2] = [3, 30];
    expect(pmatrix.col(m, 0)).toEqual([1, 2, 3]);
    expect(pmatrix.col(m, 1)).toEqual([10, 20, 30]);
  });

  it("returns a fresh array independent of the matrix's row arrays", () => {
    const m = pmatrix.newMatrix(2, 2, 5.0)!;
    const c = pmatrix.col(m, 0);
    (c as number[])[0] = 999;
    expect(m[0]![0]).toBe(5);
  });

  it("returns na(null) for an out-of-range column (positive or negative — matrix.get/set(C90) 원칙 재적용, pine2py의 우연한 negative wraparound는 literal port 안 함)", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    expect(pmatrix.col(m, 5)).toBeNull();
    expect(pmatrix.col(m, -1)).toBeNull();
    expect(pmatrix.col(m, -3)).toBeNull();
  });

  it("returns [] regardless of index on a 0-row matrix — literal port of pine2py's vacuous list comprehension (well-defined, not a crash-avoidance na)", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(pmatrix.col(m, 0)).toEqual([]);
    expect(pmatrix.col(m, 5)).toEqual([]);
    expect(pmatrix.col(m, -5)).toEqual([]);
  });

  it("returns na(null) for column 0 on a matrix with >0 rows but 0 columns (pine2py crashes with IndexError here — this is the case that differs from the 0-row vacuous case)", () => {
    const m = pmatrix.newMatrix(2, 0, 0.0)!;
    expect(pmatrix.col(m, 0)).toBeNull();
  });

  it("col(null matrix, index) returns na(null) — read-na on reference type (#19/#23 원칙 재적용)", () => {
    expect(pmatrix.col(null, 0)).toBeNull();
  });

  it("truncates a non-integer column index toward zero", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[0] = [1, 2];
    m[1] = [3, 4];
    expect(pmatrix.col(m, 1.9)).toEqual([2, 4]);
  });

  it("returns na(null) instead of crashing when the column index itself is na(NaN)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    expect(() => pmatrix.col(m, NaN)).not.toThrow();
    expect(pmatrix.col(m, NaN)).toBeNull();
  });
});

describe("matrix.rows/matrix.columns/matrix.elements_count (rt.matrix.rows/columns/elements_count, C90)", () => {
  it("returns row count, column count, and their product", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    expect(pmatrix.rows(m)).toBe(2);
    expect(pmatrix.columns(m)).toBe(3);
    expect(pmatrix.elements_count(m)).toBe(6);
  });

  it("columns(empty matrix) is 0 (no first row to measure)", () => {
    expect(pmatrix.columns([])).toBe(0);
    expect(pmatrix.elements_count([])).toBe(0);
  });

  it("rows/columns/elements_count(null matrix) return na(NaN) — matches array.size (#19)", () => {
    expect(Number.isNaN(pmatrix.rows(null))).toBe(true);
    expect(Number.isNaN(pmatrix.columns(null))).toBe(true);
    expect(Number.isNaN(pmatrix.elements_count(null))).toBe(true);
  });
});

describe("matrix.add_row (rt.matrix.add_row, C92)", () => {
  it("inserts a value-filled row at a valid index, shifting later rows down", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[0] = [1, 2];
    m[1] = [3, 4];
    pmatrix.add_row(m, 1, [9, 9]);
    expect(m).toEqual([
      [1, 2],
      [9, 9],
      [3, 4],
    ]);
  });

  it("appends a NaN-filled row of columns(m) width when value is omitted (na)", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    pmatrix.add_row(m);
    expect(m).toHaveLength(3);
    expect(m[2]).toEqual([NaN, NaN, NaN]);
  });

  it("appends (does not insert) for any out-of-range or negative index, mirroring pine2py's own explicit `index<0 or index>=len(m)` branch", () => {
    const m = pmatrix.newMatrix(1, 1, 0.0)!;
    pmatrix.add_row(m, 5, [1]);
    expect(m).toEqual([[0], [1]]);
    const m2 = pmatrix.newMatrix(1, 1, 0.0)!;
    pmatrix.add_row(m2, -3, [2]);
    expect(m2).toEqual([[0], [2]]);
  });

  it("does not pad or truncate a value array shorter/longer than columns(m) — literal port of pine2py's un-validated `list(value)`", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    pmatrix.add_row(m, 0, [9, 9]);
    expect(m[0]).toEqual([9, 9]);
  });

  it("does not crash on a whole-number-valued (non-integer-typed) index in range, unlike pine2py's `list.insert` TypeError (DIVERGENCES.md #32 — JS has no int/float distinction to reproduce this crash)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[0] = [1, 2];
    m[1] = [3, 4];
    expect(() => pmatrix.add_row(m, 1.0, [9, 9])).not.toThrow();
    expect(m[1]).toEqual([9, 9]);
  });

  it("is a no-op instead of crashing when the index itself is na(NaN)", () => {
    const m = pmatrix.newMatrix(1, 1, 0.0)!;
    expect(() => pmatrix.add_row(m, NaN, [1])).not.toThrow();
    expect(m).toEqual([[0]]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.add_row(null, 0, [1])).not.toThrow();
  });
});

describe("matrix.add_col (rt.matrix.add_col, C92)", () => {
  it("inserts a value-filled column at a valid index, shifting later columns right", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[0] = [1, 2];
    m[1] = [3, 4];
    pmatrix.add_col(m, 1, [10, 20]);
    expect(m).toEqual([
      [1, 10, 2],
      [3, 20, 4],
    ]);
  });

  it("appends a NaN-filled column of rows(m) height when value is omitted (na)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    pmatrix.add_col(m);
    expect(m[0]).toEqual([0, 0, NaN]);
    expect(m[1]).toEqual([0, 0, NaN]);
  });

  it("fills rows beyond the value array's length with NaN (literal port of pine2py's `vals[i] if i < len(vals) else nan`)", () => {
    const m = pmatrix.newMatrix(3, 1, 0.0)!;
    pmatrix.add_col(m, 0, [9]);
    expect(m).toEqual([
      [9, 0],
      [NaN, 0],
      [NaN, 0],
    ]);
  });

  it("appends (does not insert) for any out-of-range or negative index, evaluated per-row", () => {
    const m = pmatrix.newMatrix(2, 1, 0.0)!;
    pmatrix.add_col(m, -1, [7, 8]);
    expect(m).toEqual([
      [0, 7],
      [0, 8],
    ]);
  });

  it("is a no-op on a 0-row matrix regardless of index (the per-row loop never runs)", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(() => pmatrix.add_col(m, 5, [1])).not.toThrow();
    expect(m).toEqual([]);
  });

  it("is a no-op instead of crashing when the index itself is na(NaN)", () => {
    const m = pmatrix.newMatrix(1, 1, 0.0)!;
    expect(() => pmatrix.add_col(m, NaN, [1])).not.toThrow();
    expect(m).toEqual([[0]]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.add_col(null, 0, [1])).not.toThrow();
  });
});

describe("matrix.remove_row (rt.matrix.remove_row, C92)", () => {
  it("removes and returns the row at a valid index, shifting later rows up", () => {
    const m = pmatrix.newMatrix(3, 2, 0.0)!;
    m[0] = [1, 1];
    m[1] = [2, 2];
    m[2] = [3, 3];
    const removed = pmatrix.remove_row(m, 1);
    expect(removed).toEqual([2, 2]);
    expect(m).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  it("returns na(null) and does not mutate for an out-of-range or negative index (positive or negative — see matrix.ts C92 comment: pine2py's guardless `m.pop(index)` accidentally allows Python negative wraparound, but sibling get/set/row/col already reject negative indices, so remove_row follows that precedent instead of literal-porting the wraparound)", () => {
    const m = pmatrix.newMatrix(2, 1, 0.0)!;
    m[0] = [1];
    m[1] = [2];
    expect(pmatrix.remove_row(m, 5)).toBeNull();
    expect(pmatrix.remove_row(m, -1)).toBeNull();
    expect(m).toEqual([[1], [2]]);
  });

  it("returns na(null) for any index on a 0-row matrix (pine2py itself crashes with IndexError here regardless of index)", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(pmatrix.remove_row(m, 0)).toBeNull();
    expect(pmatrix.remove_row(m, -1)).toBeNull();
  });

  it("returns na(null) instead of crashing when the index itself is na(NaN)", () => {
    const m = pmatrix.newMatrix(2, 1, 0.0)!;
    expect(() => pmatrix.remove_row(m, NaN)).not.toThrow();
    expect(pmatrix.remove_row(m, NaN)).toBeNull();
  });

  it("remove_row(null matrix, index) returns na(null) — read-na on reference type", () => {
    expect(pmatrix.remove_row(null, 0)).toBeNull();
  });
});

describe("matrix.remove_col (rt.matrix.remove_col, C92)", () => {
  it("removes and returns the column at a valid index (across all rows), shifting later columns left", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    m[0] = [1, 2, 3];
    m[1] = [10, 20, 30];
    const removed = pmatrix.remove_col(m, 1);
    expect(removed).toEqual([2, 20]);
    expect(m).toEqual([
      [1, 3],
      [10, 30],
    ]);
  });

  it("returns na(null) and does not mutate for an out-of-range or negative index on a non-empty matrix", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    expect(pmatrix.remove_col(m, 5)).toBeNull();
    expect(pmatrix.remove_col(m, -1)).toBeNull();
    expect(m).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("returns [] regardless of index on a 0-row matrix — literal port of pine2py's vacuous per-row loop (well-defined, not a crash-avoidance na, matches col()/C91)", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(pmatrix.remove_col(m, 0)).toEqual([]);
    expect(pmatrix.remove_col(m, 5)).toEqual([]);
    expect(pmatrix.remove_col(m, -5)).toEqual([]);
  });

  it("returns na(null) instead of crashing when the index itself is na(NaN)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    expect(() => pmatrix.remove_col(m, NaN)).not.toThrow();
    expect(pmatrix.remove_col(m, NaN)).toBeNull();
  });

  it("remove_col(null matrix, index) returns na(null) — read-na on reference type", () => {
    expect(pmatrix.remove_col(null, 0)).toBeNull();
  });
});

describe("matrix.swap_rows (rt.matrix.swap_rows, C92)", () => {
  it("swaps two rows in place (no return value)", () => {
    const m = pmatrix.newMatrix(3, 1, 0.0)!;
    m[0] = [1];
    m[1] = [2];
    m[2] = [3];
    expect(pmatrix.swap_rows(m, 0, 2)).toBeUndefined();
    expect(m).toEqual([[3], [2], [1]]);
  });

  it("is a full no-op (neither row touched) when either index is out of range or negative", () => {
    const m = pmatrix.newMatrix(2, 1, 0.0)!;
    m[0] = [1];
    m[1] = [2];
    pmatrix.swap_rows(m, 5, 0);
    expect(m).toEqual([[1], [2]]);
    pmatrix.swap_rows(m, -1, 0);
    expect(m).toEqual([[1], [2]]);
  });

  it("is a no-op on a 0-row matrix regardless of indices", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(() => pmatrix.swap_rows(m, 5, -9)).not.toThrow();
    expect(m).toEqual([]);
  });

  it("is a no-op instead of crashing when either index is na(NaN)", () => {
    const m = pmatrix.newMatrix(2, 1, 0.0)!;
    m[0] = [1];
    m[1] = [2];
    expect(() => pmatrix.swap_rows(m, NaN, 0)).not.toThrow();
    expect(m).toEqual([[1], [2]]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.swap_rows(null, 0, 1)).not.toThrow();
  });
});

describe("matrix.swap_columns (rt.matrix.swap_columns, C92)", () => {
  it("swaps two columns in place across all rows (no return value)", () => {
    const m = pmatrix.newMatrix(2, 3, 0.0)!;
    m[0] = [1, 2, 3];
    m[1] = [4, 5, 6];
    expect(pmatrix.swap_columns(m, 0, 2)).toBeUndefined();
    expect(m).toEqual([
      [3, 2, 1],
      [6, 5, 4],
    ]);
  });

  it("is a full no-op (no row touched) when either index is out of range or negative", () => {
    const m = pmatrix.newMatrix(1, 2, 0.0)!;
    m[0] = [1, 2];
    pmatrix.swap_columns(m, 5, 0);
    expect(m).toEqual([[1, 2]]);
    pmatrix.swap_columns(m, -1, 0);
    expect(m).toEqual([[1, 2]]);
  });

  it("is a no-op on a 0-row matrix regardless of indices (columns(m)=0 makes the guard always fail, same end result as pine2py's vacuous per-row loop)", () => {
    const m = pmatrix.newMatrix(0, 0, 0.0)!;
    expect(() => pmatrix.swap_columns(m, 5, -9)).not.toThrow();
    expect(m).toEqual([]);
  });

  it("is a no-op instead of crashing when either index is na(NaN)", () => {
    const m = pmatrix.newMatrix(1, 2, 0.0)!;
    m[0] = [1, 2];
    expect(() => pmatrix.swap_columns(m, NaN, 0)).not.toThrow();
    expect(m).toEqual([[1, 2]]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.swap_columns(null, 0, 1)).not.toThrow();
  });
});

describe("matrix.copy (rt.matrix.copy, C93)", () => {
  it("returns a deep copy independent from the original (mutating the original after copy does not affect the copy)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    m[0] = [1, 2];
    m[1] = [3, 4];
    const c = pmatrix.copy(m)!;
    m[0]![0] = 99;
    expect(c).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("mutating the copy does not affect the original (independent row arrays, not shared references)", () => {
    const m = pmatrix.newMatrix(1, 2, 0.0)!;
    m[0] = [1, 2];
    const c = pmatrix.copy(m)!;
    c[0]![0] = 99;
    expect(m).toEqual([[1, 2]]);
  });

  it("returns a different array reference from the original (not just row references)", () => {
    const m = pmatrix.newMatrix(1, 1, 5.0)!;
    const c = pmatrix.copy(m)!;
    expect(c).not.toBe(m);
    expect(c[0]).not.toBe(m[0]);
  });

  it("returns an equal but independent empty matrix for a 0-row matrix", () => {
    const m: unknown[][] = [];
    const c = pmatrix.copy(m)!;
    expect(c).toEqual([]);
    expect(c).not.toBe(m);
  });

  it("returns na(null) for a na(null) matrix (pine2py copy.deepcopy(None) is well-defined and returns None, unlike other constructor-returning methods)", () => {
    expect(pmatrix.copy(null)).toBeNull();
  });
});

describe("matrix.fill (rt.matrix.fill, C93)", () => {
  it("fills only the specified [from_row,to_row) x [from_column,to_column) sub-block, leaving the rest untouched", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    pmatrix.fill(m, 9.0, 0, 1, 0, 2);
    expect(m).toEqual([
      [9, 9],
      [0, 0],
    ]);
  });

  it("fills the entire matrix when from/to arguments are omitted (defaults)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    pmatrix.fill(m, 7.0);
    expect(m).toEqual([
      [7, 7],
      [7, 7],
    ]);
  });

  it("clamps a negative from_row/from_column to 0 (pine2py's Python negative-index wraparound is result-equivalent to starting at 0 for a same-value fill, and avoids an out-of-bounds crash for very negative inputs)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    pmatrix.fill(m, 9.0, -5, -1, -5, -1);
    expect(m).toEqual([
      [9, 9],
      [9, 9],
    ]);
  });

  it("clamps a to_row/to_column that exceeds the matrix bounds instead of crashing (pine2py IndexError latent bug, new divergence mirroring array.fill DIVERGENCES #20)", () => {
    const m = pmatrix.newMatrix(2, 2, 0.0)!;
    expect(() => pmatrix.fill(m, 9.0, 0, 100, 0, 100)).not.toThrow();
    expect(m).toEqual([
      [9, 9],
      [9, 9],
    ]);
  });

  it("is a no-op instead of crashing when any range argument is na(NaN)", () => {
    const m = pmatrix.newMatrix(1, 1, 0.0)!;
    expect(() => pmatrix.fill(m, 9.0, NaN, -1, 0, -1)).not.toThrow();
    expect(m).toEqual([[0]]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.fill(null, 9.0)).not.toThrow();
  });
});

describe("matrix.concat (rt.matrix.concat, C93)", () => {
  it("concatenates rows by default (dimension omitted)", () => {
    const m1 = pmatrix.newMatrix(1, 2, 0.0)!;
    m1[0] = [1, 2];
    const m2 = pmatrix.newMatrix(1, 2, 0.0)!;
    m2[0] = [3, 4];
    expect(pmatrix.concat(m1, m2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("tolerates mismatched column counts when concatenating rows (no validation, ragged result — pine2py `[list(r) for r in m1] + [list(r) for r in m2]`)", () => {
    const m1 = [[1, 2]];
    const m2 = [[3, 4, 5]];
    expect(pmatrix.concat(m1, m2)).toEqual([
      [1, 2],
      [3, 4, 5],
    ]);
  });

  it("concatenates columns when dimension='columns' (row-wise zip, each row extended)", () => {
    const m1 = [[1, 2], [3, 4]];
    const m2 = [[5], [6]];
    expect(pmatrix.concat(m1, m2, "columns")).toEqual([
      [1, 2, 5],
      [3, 4, 6],
    ]);
  });

  it("truncates to the shorter row count when concatenating columns with mismatched row counts (pine2py Python zip() semantics, python 실측 확인)", () => {
    const m1 = [[1, 2], [3, 4], [5, 6]];
    const m2 = [[7, 8]];
    expect(pmatrix.concat(m1, m2, "columns")).toEqual([[1, 2, 7, 8]]);
  });

  it("returns na(null) when either argument is na(null)", () => {
    expect(pmatrix.concat(null, [[1]])).toBeNull();
    expect(pmatrix.concat([[1]], null)).toBeNull();
  });

  it("does not mutate either input matrix", () => {
    const m1 = [[1, 2]];
    const m2 = [[3, 4]];
    pmatrix.concat(m1, m2);
    expect(m1).toEqual([[1, 2]]);
    expect(m2).toEqual([[3, 4]]);
  });
});

describe("matrix.submatrix (rt.matrix.submatrix, C93)", () => {
  const M = [
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
    [10, 11, 12],
  ];

  it("extracts a [from_row,to_row) x [from_column,to_column) block", () => {
    expect(pmatrix.submatrix(M, 1, 3, 0, 2)).toEqual([
      [4, 5],
      [7, 8],
    ]);
  });

  it("supports Python-slice-equivalent negative indices (matches array.slice C85's established JS/Python slice equivalence)", () => {
    expect(pmatrix.submatrix(M, -2, -1, 0, 2)).toEqual([[7, 8]]);
  });

  it("clamps out-of-range positive indices instead of crashing (JS Array.slice's own clamping — pine2py python 실측으로 동일 결과 확인)", () => {
    expect(pmatrix.submatrix(M, 0, 100, 0, 100)).toEqual(M);
  });

  it("returns na(null) instead of crashing when any index argument is na(NaN)", () => {
    expect(pmatrix.submatrix(M, NaN, 3, 0, 2)).toBeNull();
  });

  it("returns na(null) for a na(null) matrix", () => {
    expect(pmatrix.submatrix(null, 0, 1, 0, 1)).toBeNull();
  });
});

describe("matrix.reshape (rt.matrix.reshape, C93)", () => {
  it("reshapes by flattening row-major and re-slicing into nr x nc", () => {
    const m = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(pmatrix.reshape(m, 3, 2)).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("leaves the last row short/empty when total elements < nr*nc (no padding, literal port)", () => {
    expect(pmatrix.reshape([[1, 2], [3, 4]], 3, 2)).toEqual([[1, 2], [3, 4], []]);
  });

  it("silently drops extra elements when total elements > nr*nc (no error)", () => {
    expect(pmatrix.reshape([[1, 2], [3, 4], [5, 6]], 2, 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns an empty matrix when nr<=0 (Python range(nr<=0) is vacuous)", () => {
    expect(pmatrix.reshape([[1, 2], [3, 4]], 0, 2)).toEqual([]);
    expect(pmatrix.reshape([[1, 2], [3, 4]], -1, 2)).toEqual([]);
  });

  it("returns na(null) instead of crashing when nr or nc is na(NaN)", () => {
    expect(pmatrix.reshape([[1, 2], [3, 4]], NaN, 2)).toBeNull();
  });

  it("returns na(null) for a na(null) matrix", () => {
    expect(pmatrix.reshape(null, 2, 2)).toBeNull();
  });
});

describe("matrix.reverse (rt.matrix.reverse, C93)", () => {
  it("reverses row order in place and returns undefined", () => {
    const m = [[1], [2], [3]];
    expect(pmatrix.reverse(m)).toBeUndefined();
    expect(m).toEqual([[3], [2], [1]]);
  });

  it("is a no-op on an empty matrix", () => {
    const m: unknown[][] = [];
    expect(() => pmatrix.reverse(m)).not.toThrow();
    expect(m).toEqual([]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.reverse(null)).not.toThrow();
  });
});

describe("matrix.sort (rt.matrix.sort, C93)", () => {
  it("sorts rows ascending by the given column (default column=0, order=ascending)", () => {
    const m = [[3, "a"], [1, "b"], [2, "c"]];
    pmatrix.sort(m);
    expect(m).toEqual([[1, "b"], [2, "c"], [3, "a"]]);
  });

  it("sorts rows descending when ascending=false", () => {
    const m = [[3], [1], [2]];
    pmatrix.sort(m, 0, false);
    expect(m).toEqual([[3], [2], [1]]);
  });

  it("always sorts na(NaN) values to the end in ascending order", () => {
    const m = [[3], [NaN], [1], [2]];
    pmatrix.sort(m, 0, true);
    expect(m.map((r) => r[0])).toEqual([1, 2, 3, NaN]);
  });

  it("sorts na(NaN) values to the front in descending order (pine2py treats NaN as +infinity, which sorts first when descending — python 직접 실행으로 확인, array.sort C85의 '항상 끝' 규칙과 다름)", () => {
    const m = [[3], [NaN], [1], [2]];
    pmatrix.sort(m, 0, false);
    expect(m.map((r) => r[0])).toEqual([NaN, 3, 2, 1]);
  });

  it("preserves original relative order for tied keys in both ascending and descending order (stable sort, python 직접 실행으로 확인: reverse=True는 '오름차순 후 전체 반전'이 아니라 부호만 뒤집는 진짜 stable 정렬)", () => {
    const asc = [[1, "a"], [1, "b"], [2, "c"], [1, "d"]];
    pmatrix.sort(asc, 0, true);
    expect(asc).toEqual([[1, "a"], [1, "b"], [1, "d"], [2, "c"]]);

    const desc = [[1, "a"], [1, "b"], [2, "c"], [1, "d"]];
    pmatrix.sort(desc, 0, false);
    expect(desc).toEqual([[2, "c"], [1, "a"], [1, "b"], [1, "d"]]);
  });

  it("is a no-op when column is out of range or na(NaN) (형제 함수 일관성 원칙 — get/set/row/col과 동일하게 na 통일, pine2py의 IndexError 크래시를 literal port하지 않음)", () => {
    const m = [[1, 2], [3, 4]];
    pmatrix.sort(m, 5, true);
    expect(m).toEqual([[1, 2], [3, 4]]);
    pmatrix.sort(m, NaN, true);
    expect(m).toEqual([[1, 2], [3, 4]]);
  });

  it("is a no-op on a na(null) matrix", () => {
    expect(() => pmatrix.sort(null)).not.toThrow();
  });
});

describe("matrix.diff (rt.matrix.diff, C93)", () => {
  it("returns row-to-row element-wise differences (result has one fewer row than the input)", () => {
    const m = [
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ];
    expect(pmatrix.diff(m)).toEqual([
      [3, 3, 3],
      [3, 3, 3],
    ]);
  });

  it("returns an empty matrix for a single-row matrix", () => {
    expect(pmatrix.diff([[1, 2, 3]])).toEqual([]);
  });

  it("returns an empty matrix for a 0-row matrix", () => {
    expect(pmatrix.diff([])).toEqual([]);
  });

  it("propagates na(NaN) through the subtraction (IEEE754 NaN propagation, no special-case needed)", () => {
    expect(pmatrix.diff([[1], [NaN]])).toEqual([[NaN]]);
  });

  it("returns na(null) for a na(null) matrix", () => {
    expect(pmatrix.diff(null)).toBeNull();
  });
});

// ── matrix.is_square/is_symmetric/is_antisymmetric/is_diagonal/is_antidiagonal/is_identity/
// is_triangular/is_stochastic/is_binary/is_zero (C94, 다섯 번째 슬라이스) — python 직접 실행으로
// 확인한 na/경계 케이스를 hand-verified로 대체(오라클은 matrix_predicates.pine이 구조 검사류
// 정상 경로만 커버, 크래시 지점인 na 행렬과 0행/na-원소 조합은 오라클 무효 구간).

describe("matrix.is_square (rt.matrix.is_square, C94)", () => {
  it("returns true for a square matrix", () => {
    expect(pmatrix.is_square([[1, 2], [3, 4]])).toBe(true);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_square([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns true for a 0-row matrix (pine2py `if m else True` exception, python-verified)", () => {
    expect(pmatrix.is_square([])).toBe(true);
  });

  it("returns false for a matrix with rows but 0 columns (does not hit the 0-row exception, python-verified)", () => {
    expect(pmatrix.is_square([[], [], []])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_square(null))).toBe(true);
  });
});

describe("matrix.is_symmetric (rt.matrix.is_symmetric, C94)", () => {
  it("returns true for a symmetric matrix regardless of diagonal values (diagonal is not checked, python-verified)", () => {
    expect(pmatrix.is_symmetric([[99, 2], [2, 55]])).toBe(true);
  });

  it("returns false when an off-diagonal pair does not match", () => {
    expect(pmatrix.is_symmetric([[1, 2], [3, 4]])).toBe(false);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_symmetric([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns true for a 0-row matrix", () => {
    expect(pmatrix.is_symmetric([])).toBe(true);
  });

  it("na on the diagonal does not affect the result (diagonal untouched, python-verified)", () => {
    expect(pmatrix.is_symmetric([[1, 0], [0, NaN]])).toBe(true);
  });

  it("na off the diagonal always fails the epsilon comparison", () => {
    expect(pmatrix.is_symmetric([[1, NaN], [0, 1]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_symmetric(null))).toBe(true);
  });
});

describe("matrix.is_antisymmetric (rt.matrix.is_antisymmetric, C94)", () => {
  it("returns true for an antisymmetric matrix regardless of diagonal values", () => {
    expect(pmatrix.is_antisymmetric([[99, 2], [-2, 55]])).toBe(true);
  });

  it("returns false when an off-diagonal pair does not sum to 0", () => {
    expect(pmatrix.is_antisymmetric([[0, 2], [3, 0]])).toBe(false);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_antisymmetric([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_antisymmetric(null))).toBe(true);
  });
});

describe("matrix.is_diagonal (rt.matrix.is_diagonal, C94)", () => {
  it("returns true for a diagonal matrix", () => {
    expect(pmatrix.is_diagonal([[5, 0], [0, 6]])).toBe(true);
  });

  it("returns false when an off-diagonal element is non-zero", () => {
    expect(pmatrix.is_diagonal([[5, 1], [0, 6]])).toBe(false);
  });

  it("na on the diagonal does not affect the result (diagonal untouched, python-verified)", () => {
    expect(pmatrix.is_diagonal([[1, 0], [0, NaN]])).toBe(true);
  });

  it("na off the diagonal always fails the epsilon comparison", () => {
    expect(pmatrix.is_diagonal([[1, NaN], [0, 1]])).toBe(false);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_diagonal([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_diagonal(null))).toBe(true);
  });
});

describe("matrix.is_antidiagonal (rt.matrix.is_antidiagonal, C94)", () => {
  it("returns true for an antidiagonal matrix (n=3, nonzero only where i+j===n-1)", () => {
    expect(
      pmatrix.is_antidiagonal([
        [0, 0, 5],
        [0, 6, 0],
        [7, 0, 0],
      ]),
    ).toBe(true);
  });

  it("returns false when a required-zero cell is non-zero", () => {
    expect(
      pmatrix.is_antidiagonal([
        [1, 0, 5],
        [0, 6, 0],
        [7, 0, 0],
      ]),
    ).toBe(false);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_antidiagonal([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_antidiagonal(null))).toBe(true);
  });
});

describe("matrix.is_identity (rt.matrix.is_identity, C94)", () => {
  it("returns true for an identity matrix", () => {
    expect(pmatrix.is_identity([[1, 0], [0, 1]])).toBe(true);
  });

  it("returns false for a diagonal matrix that is not all-ones", () => {
    expect(pmatrix.is_identity([[1, 0], [0, 2]])).toBe(false);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_identity([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_identity(null))).toBe(true);
  });
});

describe("matrix.is_triangular (rt.matrix.is_triangular, C94)", () => {
  it("returns true for an upper-triangular matrix", () => {
    expect(
      pmatrix.is_triangular([
        [1, 2, 3],
        [0, 4, 5],
        [0, 0, 6],
      ]),
    ).toBe(true);
  });

  it("returns true for a lower-triangular matrix", () => {
    expect(
      pmatrix.is_triangular([
        [1, 0, 0],
        [2, 4, 0],
        [3, 5, 6],
      ]),
    ).toBe(true);
  });

  it("returns false when neither triangle is all-zero", () => {
    expect(pmatrix.is_triangular([[1, 2], [3, 4]])).toBe(false);
  });

  it("na in the failing triangle does not block a match on the passing side (python-verified: m=[[1,nan],[0,1]] is lower-triangular)", () => {
    expect(pmatrix.is_triangular([[1, NaN], [0, 1]])).toBe(true);
  });

  it("returns false for a non-square matrix", () => {
    expect(pmatrix.is_triangular([[1, 2, 3], [4, 5, 6]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_triangular(null))).toBe(true);
  });
});

describe("matrix.is_stochastic (rt.matrix.is_stochastic, C94)", () => {
  it("returns true when every row sums to 1 (square)", () => {
    expect(pmatrix.is_stochastic([[0.5, 0.5], [0.25, 0.75]])).toBe(true);
  });

  it("does not require a square matrix (python-verified)", () => {
    expect(pmatrix.is_stochastic([[0.2, 0.3, 0.5], [0.1, 0.4, 0.5]])).toBe(true);
  });

  it("returns false when a row does not sum to 1", () => {
    expect(pmatrix.is_stochastic([[0.5, 0.4], [1.0, 1.0]])).toBe(false);
  });

  it("returns true for a 0-row matrix (empty product of the all() check)", () => {
    expect(pmatrix.is_stochastic([])).toBe(true);
  });

  it("returns false for a row containing na (sum becomes NaN, epsilon comparison fails)", () => {
    expect(pmatrix.is_stochastic([[1, NaN]])).toBe(false);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_stochastic(null))).toBe(true);
  });
});

describe("matrix.is_binary (rt.matrix.is_binary, C94)", () => {
  it("returns true when every element is exactly 0 or 1", () => {
    expect(pmatrix.is_binary([[0, 1], [1, 0]])).toBe(true);
  });

  it("returns false when an element is neither 0 nor 1", () => {
    expect(pmatrix.is_binary([[0, 1], [1, 2]])).toBe(false);
  });

  it("returns false for an element that is na (NaN !== 0 and NaN !== 1)", () => {
    expect(pmatrix.is_binary([[0, NaN]])).toBe(false);
  });

  it("treats negative zero as equal to 0 (JS ===, matches pine2py)", () => {
    expect(pmatrix.is_binary([[-0, 1]])).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_binary(null))).toBe(true);
  });
});

describe("matrix.is_zero (rt.matrix.is_zero, C94)", () => {
  it("returns true for an all-zero matrix", () => {
    expect(pmatrix.is_zero([[0, 0], [0, 0]])).toBe(true);
  });

  it("returns true for values within the 1e-10 epsilon (1e-11)", () => {
    expect(pmatrix.is_zero([[1e-11, 0], [0, 0]])).toBe(true);
  });

  it("returns false for a value outside the epsilon", () => {
    expect(pmatrix.is_zero([[0, 0], [0, 0.001]])).toBe(false);
  });

  it("returns false for an element that is na (Math.abs(NaN) < 1e-10 is false)", () => {
    expect(pmatrix.is_zero([[0, NaN]])).toBe(false);
  });

  it("treats negative zero as zero", () => {
    expect(pmatrix.is_zero([[-0, 0]])).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.is_zero(null))).toBe(true);
  });
});

describe("matrix.sum (rt.matrix.sum, C95)", () => {
  it("sums all valid elements across rows", () => {
    expect(pmatrix.sum([[1, 2], [3, 4]])).toBe(10);
  });

  it("skips na elements", () => {
    expect(pmatrix.sum([[1, NaN], [3, 4]])).toBe(8);
  });

  it("returns 0 for an all-na matrix (Python sum([])==0, distinct from avg/min/max/median, C81 재적용)", () => {
    expect(pmatrix.sum([[NaN, NaN]])).toBe(0);
  });

  it("returns 0 for an empty (0x0) matrix", () => {
    expect(pmatrix.sum([])).toBe(0);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.sum(null))).toBe(true);
  });
});

describe("matrix.sum 2-인자 오버로드 (rt.matrix.sum, C656 — elementwise add, hand-verified)", () => {
  it("adds two matrices element-by-element into a new matrix", () => {
    expect(pmatrix.sum([[1, 2], [3, 4]], [[10, 20], [30, 40]])).toEqual([[11, 22], [33, 44]]);
  });

  it("does not mutate either input matrix", () => {
    const a = [[1, 2]];
    const b = [[10, 20]];
    pmatrix.sum(a, b);
    expect(a).toEqual([[1, 2]]);
    expect(b).toEqual([[10, 20]]);
  });

  it("propagates na(NaN) through '+' at the affected cell only (VERIFIED_SEMANTICS 산술 na 전파)", () => {
    const got = pmatrix.sum([[1, NaN]], [[10, 20]])!;
    expect(got[0]![0]).toBe(11);
    expect(Number.isNaN(got[0]![1] as number)).toBe(true);
  });

  it("returns na(null) when either matrix is na(null)", () => {
    expect(pmatrix.sum(null, [[1]])).toBeNull();
    expect(pmatrix.sum([[1]], null)).toBeNull();
  });

  it("supports the Kalman P=FPF'+Q chained idiom (F.mult(P.mult(F.transpose())).sum(Q))", () => {
    const F = [[1, 1], [0, 1]];
    const P = [[1, 0], [0, 1]];
    const Q = [[0.1, 0], [0, 0.1]];
    const Ft = pmatrix.transpose(F)!;
    const predicted = pmatrix.sum(pmatrix.mult(F, pmatrix.mult(P, Ft) as pmatrix.PineMatrix) as pmatrix.PineMatrix, Q);
    expect(predicted).toEqual([[2.1, 1], [1, 1.1]]);
  });
});

describe("matrix.avg (rt.matrix.avg, C95)", () => {
  it("averages all valid elements across rows", () => {
    expect(pmatrix.avg([[1, 2], [3, 4]])).toBe(2.5);
  });

  it("skips na elements when averaging", () => {
    expect(pmatrix.avg([[1, NaN], [3, 4]])).toBe(8 / 3);
  });

  it("returns na(NaN) for an all-na matrix (distinct from sum's 0)", () => {
    expect(Number.isNaN(pmatrix.avg([[NaN, NaN]]))).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.avg(null))).toBe(true);
  });
});

describe("matrix.min (rt.matrix.min, C95)", () => {
  it("returns the smallest valid element across rows", () => {
    expect(pmatrix.min([[5, 2], [8, 1]])).toBe(1);
  });

  it("skips na elements", () => {
    expect(pmatrix.min([[5, NaN], [8, 1]])).toBe(1);
  });

  it("returns na(NaN) for an all-na matrix", () => {
    expect(Number.isNaN(pmatrix.min([[NaN, NaN]]))).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.min(null))).toBe(true);
  });
});

describe("matrix.max (rt.matrix.max, C95)", () => {
  it("returns the largest valid element across rows", () => {
    expect(pmatrix.max([[5, 2], [8, 1]])).toBe(8);
  });

  it("skips na elements", () => {
    expect(pmatrix.max([[5, NaN], [8, 1]])).toBe(8);
  });

  it("returns na(NaN) for an all-na matrix", () => {
    expect(Number.isNaN(pmatrix.max([[NaN, NaN]]))).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.max(null))).toBe(true);
  });
});

describe("matrix.median (rt.matrix.median, C95)", () => {
  it("averages the two middle values for an even count of valid elements", () => {
    // sorted flatten = [1,2,3,4] -> (2+3)/2.
    expect(pmatrix.median([[4, 1], [3, 2]])).toBe(2.5);
  });

  it("returns the middle value for an odd count of valid elements (na skipped)", () => {
    // flatten = [4, na, 3, 2] -> valid sorted = [2,3,4] -> middle = 3.
    expect(pmatrix.median([[4, NaN], [3, 2]])).toBe(3);
  });

  it("returns na(NaN) for an all-na matrix", () => {
    expect(Number.isNaN(pmatrix.median([[NaN, NaN]]))).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.median(null))).toBe(true);
  });
});

describe("matrix.mode (rt.matrix.mode, C95)", () => {
  it("returns the most frequent valid element", () => {
    expect(pmatrix.mode([[1, 2], [1, 3]])).toBe(1);
  });

  it("breaks ties by first-encountered value (flatten row-major order, Counter.most_common tie-break)", () => {
    // flatten = [2,1,1,2,3] -> 2 and 1 both count 2, 2 appears first -> 2 wins.
    expect(pmatrix.mode([[2, 1, 1, 2, 3]])).toBe(2);
  });

  it("skips na elements", () => {
    expect(pmatrix.mode([[1, NaN], [1, 2]])).toBe(1);
  });

  it("returns na(NaN) for an all-na matrix", () => {
    expect(Number.isNaN(pmatrix.mode([[NaN, NaN]]))).toBe(true);
  });

  it("returns na(NaN) for a na(null) matrix", () => {
    expect(Number.isNaN(pmatrix.mode(null))).toBe(true);
  });
});

// matrix.transpose(rt.matrix.transpose, C96, 행렬 대수 11종의 첫 항목) — na(null) 인자는 pine2py
// `if not m: return []`가 None을 파이썬 falsy로 잡아 크래시가 아니라 []를 반환하는 잘 정의된 동작
// (python 직접 실행 실측, oracle/cases/matrix_transpose.pine 헤더 주석 참조) — 다른 matrix.* 생성자류
// (copy/concat/submatrix/reshape)의 "null 인자는 na 전파" 원칙과 달리 여기선 hand-verified로 []를
// 명시 확인해야 한다(오라클은 na 행렬 var 선언 구문이 아직 미지원이라 이 분기를 직접 트리거 못 함,
// LIMITATIONS.md "map<K,V>/matrix<T> 명시적 타입힌트 var 선언" 참조).
describe("matrix.transpose (rt.matrix.transpose, C96)", () => {
  it("transposes a non-square matrix (rows/columns swap)", () => {
    expect(pmatrix.transpose([[1, 2, 3], [4, 5, 6]])).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  it("relocates na elements to their transposed position", () => {
    expect(pmatrix.transpose([[1, NaN], [3, 4]])).toEqual([[1, 3], [NaN, 4]]);
  });

  it("returns the same single-element matrix for a 1x1 input", () => {
    expect(pmatrix.transpose([[7]])).toEqual([[7]]);
  });

  it("returns [] for a na(null) matrix (pine2py 'if not m' falsy path, not na propagation)", () => {
    expect(pmatrix.transpose(null)).toEqual([]);
  });

  it("returns [] for a 0-row matrix", () => {
    expect(pmatrix.transpose([])).toEqual([]);
  });

  it("returns [] for a matrix with rows but 0 columns (nc=0 loop-zero path, distinct from the falsy path)", () => {
    expect(pmatrix.transpose([[], [], []])).toEqual([]);
  });
});

// matrix.mult(rt.matrix.mult, C97, 행렬 대수 11종의 두 번째 항목) — 표준 3분기(스칼라/벡터/행렬)는
// oracle/cases/matrix_mult.pine(A~G)이 pine2py 골든 대조로 검증한다. 여기선 오라클로 트리거 불가한
// degenerate 입력(pine2py가 크래시하는 미정의 지점 — python 직접 실행 실측: mult(None,5)/
// mult(m,None)/mult(m,[])가 전부 TypeError/IndexError)만 hand-verified로 확인한다 — matrix.ts
// rt.matrix.mult 주석 참조.
describe("matrix.mult (rt.matrix.mult, C97)", () => {
  it("multiplies matrix x matrix (standard algebraic product)", () => {
    expect(pmatrix.mult([[1, 2], [3, 4]], [[5, 6], [7, 8]])).toEqual([[19, 22], [43, 50]]);
  });

  it("multiplies matrix x vector (dot product per row)", () => {
    expect(pmatrix.mult([[1, 2], [3, 4]], [1, 2])).toEqual([5, 11]);
  });

  it("multiplies matrix x scalar (elementwise)", () => {
    expect(pmatrix.mult([[1, 2], [3, 4]], 3)).toEqual([[3, 6], [9, 12]]);
  });

  it("propagates na for a na(NaN) scalar (Python isinstance(nan,float)===True falls into the scalar branch, literal port)", () => {
    const result = pmatrix.mult([[1, 2], [3, 4]], NaN) as unknown[][];
    for (const row of result) for (const v of row) expect(Number.isNaN(v as number)).toBe(true);
  });

  it("returns na(null) for a na(null) matrix argument (m===null — pine2py crashes on 'for r in None' regardless of branch)", () => {
    expect(pmatrix.mult(null, 5)).toBeNull();
  });

  it("returns na(null) for a na(null) other argument (pine2py crashes on 'other[0]'/'isinstance(None,...)' fallthrough)", () => {
    expect(pmatrix.mult([[1, 2], [3, 4]], null)).toBeNull();
  });

  it("returns na(null) for an empty array other argument (ambiguous empty vector vs empty matrix — pine2py IndexError on other[0], avoided instead of literal-ported as a crash)", () => {
    expect(pmatrix.mult([[1, 2], [3, 4]], [])).toBeNull();
  });

  it("degrades dimension-mismatch (other has more rows than m has columns) to na entries instead of crashing (pine2py IndexError on m[i][p], JS out-of-range access is undefined*number=NaN)", () => {
    const result = pmatrix.mult([[1, 2]], [[1, 2], [3, 4], [5, 6]]) as unknown[][];
    expect(result).toHaveLength(1);
    for (const v of result[0]!) expect(Number.isNaN(v as number)).toBe(true);
  });
});

// matrix.det(rt.matrix.det, C98, 행렬 대수 11종의 세 번째 항목) — n=0/1/2/n>=3 표준 경로와
// singular/na-first-pivot/na-not-first-pivot/비정사각 rows<columns는 oracle/cases/matrix_det.pine
// (A~J)이 pine2py 골든 대조로 검증한다. 여기선 오라클로 트리거 불가한 degenerate 입력(pine2py가
// 크래시하는 미정의 지점 — python 직접 실행 실측: det(None)/det([[]])/det(3x2)가 전부
// TypeError/IndexError)만 hand-verified로 확인한다 — matrix.ts rt.matrix.det 주석 참조.
describe("matrix.det (rt.matrix.det, C98)", () => {
  it("computes det for n=0 (empty matrix) as 0.0", () => {
    expect(pmatrix.det([])).toBe(0);
  });

  it("computes det for n=1 as the single element", () => {
    expect(pmatrix.det([[5]])).toBe(5);
  });

  it("computes det for n=2 via the direct formula", () => {
    expect(pmatrix.det([[1, 2], [3, 4]])).toBe(-2);
  });

  it("computes det for n=3 via Gaussian elimination (known value)", () => {
    expect(
      pmatrix.det([
        [6, 1, 1],
        [4, -2, 5],
        [2, 8, 7],
      ]),
    ).toBeCloseTo(-306, 6);
  });

  it("returns 0.0 for a singular n=3 matrix (linearly dependent rows, pivot not found — well-defined, not a crash)", () => {
    expect(
      pmatrix.det([
        [1, 2, 3],
        [2, 4, 6],
        [7, 8, 9],
      ]),
    ).toBe(0);
  });

  it("returns na(NaN) for a na(null) matrix argument (m===null — pine2py crashes on 'len(None)')", () => {
    expect(Number.isNaN(pmatrix.det(null))).toBe(true);
  });

  it("returns na(NaN) for a 1-row 0-column matrix ([[]], n=1 branch — pine2py crashes on m[0][0] IndexError, JS m[0][0] is undefined and must be cast to avoid leaking undefined per the na 3-way convention)", () => {
    expect(Number.isNaN(pmatrix.det([[]]))).toBe(true);
  });

  it("returns na(NaN) for rows>columns (3x2, non-square — pine2py crashes with IndexError mid-elimination; JS out-of-range access is undefined, and undefined!==0 lets it through as a bogus pivot, propagating to NaN by the final multiplication without an explicit guard)", () => {
    const result = pmatrix.det([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(Number.isNaN(result)).toBe(true);
  });

  it("matches the top-left nxn submatrix det for rows<columns (2x3 — pine2py never touches the extra column either, literal port naturally agrees)", () => {
    expect(
      pmatrix.det([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toBe(-3);
  });
});

// matrix.trace(rt.matrix.trace, C99, 행렬 대수 11종의 네 번째 항목) — min(rows,columns) 상한
// 대각합의 n=0/1/2/3/rectangular 전 경로는 oracle/cases/matrix_trace.pine(A~J)이 pine2py 골든
// 대조로 검증한다(trace는 det와 달리 pivot/singular 개념이 없어 rows>columns/rows-only-0cols도
// pine2py가 크래시하지 않음). 여기선 오라클로 트리거 불가한 m===null(pine2py `len(None)`
// TypeError)만 hand-verified로 확인하고, 나머지는 오라클과 별개로 직접 계산 재확인용 소규모
// 유닛만 둔다(matrix.ts rt.matrix.trace 주석 참조).
describe("matrix.trace (rt.matrix.trace, C99)", () => {
  it("computes trace for n=0 (empty matrix) as 0", () => {
    expect(pmatrix.trace([])).toBe(0);
  });

  it("computes trace for n=1 as the single diagonal element", () => {
    expect(pmatrix.trace([[7]])).toBe(7);
  });

  it("computes trace for n=2 as the sum of the diagonal", () => {
    expect(pmatrix.trace([[1, 2], [3, 4]])).toBe(5);
  });

  it("computes trace for n=3 as the sum of the diagonal, ignoring off-diagonal entries", () => {
    expect(
      pmatrix.trace([
        [1, 99, 99],
        [99, 2, 99],
        [99, 99, 3],
      ]),
    ).toBe(6);
  });

  it("propagates NaN when a diagonal entry is na, but off-diagonal na has no effect (matches Python sum() passthrough)", () => {
    expect(Number.isNaN(pmatrix.trace([[1, 0], [0, NaN]]))).toBe(true);
    expect(pmatrix.trace([[1, NaN], [0, 4]])).toBe(5);
  });

  it("sums only the top-left min(rows,columns) diagonal for rows<columns (2x3 — matches pine2py, no crash)", () => {
    expect(
      pmatrix.trace([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toBe(6);
  });

  it("sums only the top-left min(rows,columns) diagonal for rows>columns (3x2 — matches pine2py, no crash unlike det)", () => {
    expect(
      pmatrix.trace([
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
    ).toBe(5);
  });

  it("returns 0 for a 1-row 0-column matrix ([[]], no crash unlike det's n=1 undefined-leak branch)", () => {
    expect(pmatrix.trace([[]])).toBe(0);
  });

  it("returns 0 for a rows>0, 0-column matrix ([[],[],[]])", () => {
    expect(pmatrix.trace([[], [], []])).toBe(0);
  });

  it("returns na(NaN) for a na(null) matrix argument (m===null — pine2py crashes on 'len(None)' before the falsy-guard ternary is even reached)", () => {
    expect(Number.isNaN(pmatrix.trace(null))).toBe(true);
  });
});

// matrix.inv(rt.matrix.inv, C100, 열한 번째 슬라이스 — 행렬 대수 11종의 다섯 번째 항목) — n=0/1/2/3
// Gauss-Jordan 유효 경로는 oracle/cases/matrix_inv.pine(A~F)이 pine2py 골든 대조로 검증한다. 여기선
// 오라클로 트리거 불가한 경계만 hand-verified로 확인: singular(pine2py `raise ValueError`), m===null,
// m=[[]](1행0열), 비정사각(rows<columns/rows>columns — pine2py는 크래시하거나 수학적으로 무의미한
// 값을 내지만 pine2js는 isSquare 가드로 일괄 na(null) 통일, DIVERGENCES.md #37).
describe("matrix.inv (rt.matrix.inv, C100)", () => {
  it("computes inv for n=0 (empty matrix) as []", () => {
    expect(pmatrix.inv([])).toEqual([]);
  });

  it("computes inv for n=1 as the reciprocal", () => {
    expect(pmatrix.inv([[2]])).toEqual([[0.5]]);
  });

  it("computes inv for n=2 via Gauss-Jordan (known value)", () => {
    const result = pmatrix.inv([
      [4, 7],
      [2, 6],
    ]) as number[][];
    expect(result[0]![0]).toBeCloseTo(0.6, 10);
    expect(result[0]![1]).toBeCloseTo(-0.7, 10);
    expect(result[1]![0]).toBeCloseTo(-0.2, 10);
    expect(result[1]![1]).toBeCloseTo(0.4, 10);
  });

  it("computes inv for n=3 via Gauss-Jordan (known value, matches pine2py byte-for-byte per scratch/probe_inv.mjs)", () => {
    const result = pmatrix.inv([
      [2, -1, 0],
      [-1, 2, -1],
      [0, -1, 2],
    ]) as number[][];
    expect(result[0]![0]).toBeCloseTo(0.75, 10);
    expect(result[1]![1]).toBeCloseTo(1.0, 10);
    expect(result[2]![2]).toBeCloseTo(0.75, 10);
  });

  it("returns na(null) for a singular n=2 matrix (pine2py raises ValueError('Matrix is singular') — pine2js has no throw path, so it substitutes na like det/mult's crash-absorption principle)", () => {
    expect(
      pmatrix.inv([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
  });

  it("returns na(null) for a singular n=3 matrix (linearly dependent rows)", () => {
    expect(
      pmatrix.inv([
        [1, 2, 3],
        [2, 4, 6],
        [7, 8, 9],
      ]),
    ).toBeNull();
  });

  it("returns na(null) for a na(null) matrix argument (m===null)", () => {
    expect(pmatrix.inv(null)).toBeNull();
  });

  it("returns na(null) for a 1-row 0-column matrix ([[]] — not square, pine2py crashes with IndexError)", () => {
    expect(pmatrix.inv([[]])).toBeNull();
  });

  it("returns na(null) for rows<columns (2x3, non-square — pine2py doesn't crash but returns a mathematically meaningless mix of data and identity columns; pine2js diverges intentionally, DIVERGENCES.md #37)", () => {
    expect(
      pmatrix.inv([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toBeNull();
  });

  it("returns na(null) for rows>columns (3x2, non-square — pine2py crashes with IndexError mid-elimination)", () => {
    expect(
      pmatrix.inv([
        [1, 2],
        [3, 4],
        [5, 6],
      ]),
    ).toBeNull();
  });
});

// matrix.rank(rt.matrix.rank, C101, 열두 번째 슬라이스 — 행렬 대수 11종의 여섯 번째 항목) — n=0/1/2/3
// 및 na/deficient/비정사각/0열 전 경로는 oracle/cases/matrix_rank.pine(A~M)이 pine2py 골든 대조로
// 검증한다(rank는 정사각을 전제하지 않아 inv와 달리 비정사각도 오라클로 그대로 트리거 가능).
// 여기선 오라클로 트리거 불가한 m===null(pine2py `if not m: return 0`가 크래시 없이 well-defined
// 0을 반환 — det/trace/inv와 정반대 방향, matrix.ts rt.matrix.rank 주석 참조)만 hand-verified로
// 확인하고, det/inv와 정확히 반대인 "NaN이 첫 후보 위치에 있어도 유효 pivot으로 오인되지 않는다"는
// 핵심 시맨틱 역전을 오라클 F그룹과 별개로 여기서도 직접 재확인한다.
describe("matrix.rank (rt.matrix.rank, C101)", () => {
  it("returns 0 for a na(null) matrix argument (m===null — pine2py's 'if not m: return 0' guard catches None without crashing, unlike det/trace/inv)", () => {
    expect(pmatrix.rank(null)).toBe(0);
  });

  it("returns 0 for n=0 (empty matrix)", () => {
    expect(pmatrix.rank([])).toBe(0);
  });

  it("does not treat na(NaN) as a valid pivot even when it is the very first candidate (opposite of det/inv, which mistake NaN for a valid pivot via '!== 0') — the other 3 entries still form a full-rank 2x2, so rank=2", () => {
    expect(
      pmatrix.rank([
        [NaN, 1],
        [3, 4],
      ]),
    ).toBe(2);
  });

  it("skips a fully-NaN row without poisoning the rest of the matrix (NaN never becomes a pivot)", () => {
    expect(
      pmatrix.rank([
        [NaN, NaN],
        [3, 4],
      ]),
    ).toBe(1);
  });

  it("returns 0 for a 1-row 0-column matrix ([[]], no crash)", () => {
    expect(pmatrix.rank([[]])).toBe(0);
  });
});

// matrix.pow(rt.matrix.pow, C102, 열세 번째 슬라이스 — 행렬 대수 11종의 일곱 번째 항목) — square
// n=0/1/2/3 유효 경로(positive/zero/negative exponent, na-embedded 포함)는
// oracle/cases/matrix_pow.pine(A~K)이 pine2py 골든 대조로 검증한다. 여기선 오라클로 트리거 불가한
// 경계만 hand-verified로 확인: m===null, n=0+비0 exponent(pine2py `mult([],[])`가 IndexError로
// 크래시하는 지점), singular+음수 exponent(inv 내부 ValueError), 비정사각(inv(C100)과 동일한
// isSquareMatrix 신규 가드 — pine2py는 크래시 여부가 exponent별로 불규칙하게 갈리지만 pine2js는
// 일괄 na(null) 통일, matrix.ts rt.matrix.pow 주석/DIVERGENCES.md #37 확장 참조).
describe("matrix.pow (rt.matrix.pow, C102)", () => {
  it("returns na(null) for a na(null) matrix argument (m===null)", () => {
    expect(pmatrix.pow(null, 2)).toBeNull();
  });

  it("returns [] for n=0 (empty matrix) with exponent=0 (loop never runs, no crash)", () => {
    expect(pmatrix.pow([], 0)).toEqual([]);
  });

  it("returns na(null) for n=0 (empty matrix) with a nonzero exponent (pine2py crashes with IndexError inside the mandatory 'base=mult(base,base)' call, pine2js absorbs it like mult's own empty-array crash point, C97)", () => {
    expect(pmatrix.pow([], 2)).toBeNull();
    expect(pmatrix.pow([], -1)).toBeNull();
  });

  it("computes known powers for n=2 (matches pine2py byte-for-byte per scratch/gen_pow_cases.mjs+compare_pow_fuzz.mjs, 5,000-sample fuzz)", () => {
    const m = [
      [1, 2],
      [3, 4],
    ];
    expect(pmatrix.pow(m, 0)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(pmatrix.pow(m, 1)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(pmatrix.pow(m, 2)).toEqual([
      [7, 10],
      [15, 22],
    ]);
    const cubed = pmatrix.pow(m, 3) as number[][];
    expect(cubed).toEqual([
      [37, 54],
      [81, 118],
    ]);
    const neg1 = pmatrix.pow(m, -1) as number[][];
    expect(neg1[0]![0]).toBeCloseTo(-2, 10);
    expect(neg1[0]![1]).toBeCloseTo(1, 10);
    expect(neg1[1]![0]).toBeCloseTo(1.5, 10);
    expect(neg1[1]![1]).toBeCloseTo(-0.5, 10);
  });

  it("applies inv only once at the very end for negative exponents, not (inv(m))^n — computes m^|exponent| first via repeated squaring, then inv (order matters for float rounding, pine2py pow.py literal port)", () => {
    const m = [
      [2, -1, 0],
      [-1, 2, -1],
      [0, -1, 2],
    ];
    const result = pmatrix.pow(m, -2) as number[][];
    // python 직접 실행 골든(anaconda python -c, wavealgo.builtins.matrix.pow 직접 호출로 확인)
    expect(result[0]![0]).toBeCloseTo(0.875, 9);
    expect(result[1]![1]).toBeCloseTo(1.5, 9);
    expect(result[2]![2]).toBeCloseTo(0.875, 9);
  });

  it("returns na(null) for a singular matrix with a negative exponent (pine2py's inv() raises ValueError('Matrix is singular') deep inside pow — pine2js absorbs it via inv's own C100 na-substitution, no throw path)", () => {
    expect(
      pmatrix.pow(
        [
          [1, 2],
          [2, 4],
        ],
        -1,
      ),
    ).toBeNull();
  });

  it("returns identity regardless of matrix content when exponent=0, even with na embedded (loop body never executes)", () => {
    expect(
      pmatrix.pow(
        [
          [NaN, 2],
          [3, 4],
        ],
        0,
      ),
    ).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it("returns na(null) for non-square matrices for every exponent (isSquareMatrix guard, DIVERGENCES.md #37 extension) — even exponent=0, where pine2py itself doesn't crash and returns a well-defined identity", () => {
    const rect3x2 = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    expect(pmatrix.pow(rect3x2, 0)).toBeNull();
    expect(pmatrix.pow(rect3x2, 1)).toBeNull();
    expect(pmatrix.pow(rect3x2, 2)).toBeNull();
    expect(pmatrix.pow(rect3x2, -1)).toBeNull();
    const rect2x3 = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(pmatrix.pow(rect2x3, -1)).toBeNull();
  });
});

// matrix.kron(rt.matrix.kron, C103, 열네 번째 슬라이스 — 행렬 대수 11종의 여덟 번째 항목) — 표준
// 크로네커 곱 경로(정상값/na-embedded/비대칭 차원/0열)는 oracle/cases/matrix_kron.pine(A~G)이
// pine2py 골든 대조로 검증한다. 여기선 오라클로 트리거 불가한 경계만 hand-verified로 확인:
// m1/m2===null, m1/m2가 0행(`[]`) — pine2py `len(m1[0])`가 `m1[0]` 자체 IndexError로 크래시하는
// 지점이자 **JS도 동일하게 크래시하는**(undefined.length가 산술식이 아니라 프로퍼티 접근이라
// 자연 NaN 전파 경로가 없음, matrix.ts rt.matrix.kron 주석 참조) 첫 matrix.* 이항 함수. 0열
// (`[[]]`, 1행0열)은 크래시 없이 well-defined [[]] 반환이라 na 흡수 대상이 아님.
describe("matrix.kron (rt.matrix.kron, C103)", () => {
  it("returns na(null) for a na(null) matrix argument (m1===null or m2===null)", () => {
    expect(pmatrix.kron(null, [[1]])).toBeNull();
    expect(pmatrix.kron([[1]], null)).toBeNull();
    expect(pmatrix.kron(null, null)).toBeNull();
  });

  it("returns na(null) for a 0-row matrix argument (pine2py's len(m[0]) crashes with IndexError, and the naive JS port crashes identically — undefined.length is a property access, not arithmetic, so there's no natural NaN-propagation escape like mult/pow/det have)", () => {
    expect(pmatrix.kron([], [[1]])).toBeNull();
    expect(pmatrix.kron([[1]], [])).toBeNull();
  });

  it("returns a well-defined 1-row 0-column result ([[]]) for a 0-column operand (no crash — len(m[0])===0 is a valid length, unlike len(m) on a 0-row matrix)", () => {
    expect(pmatrix.kron([[]], [[1]])).toEqual([[]]);
    expect(pmatrix.kron([[1]], [[]])).toEqual([[]]);
  });

  it("computes a known 2x2 x 2x2 Kronecker product (matches pine2py byte-for-byte, python direct execution + scratch/gen_kron_cases.mjs+compare_kron_fuzz.mjs 3,000-sample fuzz)", () => {
    const result = pmatrix.kron(
      [
        [1, 2],
        [3, 4],
      ],
      [
        [0, 1],
        [1, 0],
      ],
    );
    expect(result).toEqual([
      [0, 1, 0, 2],
      [1, 0, 2, 0],
      [0, 3, 0, 4],
      [3, 0, 4, 0],
    ]);
  });

  it("computes a rectangular (1x3 x 2x1) Kronecker product — result size depends on both operands (r1*r2 x c1*c2), the first matrix.* binary function where this holds", () => {
    const result = pmatrix.kron([[1, 2, 3]], [[4], [5]]);
    expect(result).toEqual([
      [4, 8, 12],
      [5, 10, 15],
    ]);
  });

  it("propagates na through multiplication without a separate branch (IEEE754 NaN auto-propagation)", () => {
    const result = pmatrix.kron([[NaN, 1]], [[2]]) as number[][];
    expect(Number.isNaN(result[0]![0])).toBe(true);
    expect(result[0]![1]).toBe(2);
  });
});

// matrix.pinv(rt.matrix.pinv, C104, 열다섯 번째 슬라이스 — 행렬 대수 11종의 아홉 번째 항목) — 와이드/
// 톨/정사각/na-embedded/1x1/명시적 폴백 경로는 oracle/cases/matrix_pinv.pine(A~F)이 pine2py 골든
// 대조로 검증한다. 여기선 오라클로 트리거 불가한 크래시 경계만 hand-verified로 확인: m===null/
// m=[]/m=[[]]는 pine2py에서 IndexError로 크래시하는 미정의 지점(mult(m,transpose(m))의 매트릭스
// 분기가 `other[0]`를 참조)이라 na(null) 흡수 — pine2js는 별도 가드 없이 mult/inv의 기존 null
// 전파(C97/C100)를 그대로 관통해 자연히 null로 수렴한다(matrix.ts rt.matrix.pinv 주석 참조).
// 정사각 특이/랭크 결핍 행렬은 rank(AA^T)=rank(A^TA)=rank(A) 항등식상 두 공식(formula1/formula2)
// 모두 같은 이유로 실패해(python 실측: 두 번째 ValueError가 캐치되지 않고 그대로 전파) 크래시.
describe("matrix.pinv (rt.matrix.pinv, C104)", () => {
  it("returns na(null) for a na(null) matrix argument", () => {
    expect(pmatrix.pinv(null)).toBeNull();
  });

  it("returns na(null) for a 0-row matrix ([]) — pine2py crashes with IndexError inside mult(m, transpose(m)) when the matrix branch's `other[0]` reads an empty transposed vector", () => {
    expect(pmatrix.pinv([])).toBeNull();
  });

  it("returns na(null) for a 1-row 0-column matrix ([[]]) — transpose([[]]) collapses to [] (C96), then the same 0-row mult() crash site as above applies", () => {
    expect(pmatrix.pinv([[]])).toBeNull();
  });

  it("returns na(null) for a square singular matrix (symmetric) — formula1's inv(mult(m,mt)) and formula2's inv(mult(mt,m)) are both singular for a rank-deficient square matrix (rank(AA^T)=rank(A^TA)=rank(A) identity), matching pine2py's uncaught second ValueError", () => {
    expect(
      pmatrix.pinv([
        [1, 2],
        [2, 4],
      ]),
    ).toBeNull();
  });

  it("returns na(null) for a square singular matrix (non-symmetric)", () => {
    expect(
      pmatrix.pinv([
        [2, 4],
        [1, 2],
      ]),
    ).toBeNull();
  });

  it("returns na(null) for a wide row-rank-deficient matrix (row1 = 2*row0 exactly)", () => {
    expect(
      pmatrix.pinv([
        [1, 2, 3],
        [2, 4, 6],
      ]),
    ).toBeNull();
  });

  it("returns na(null) for a tall column-rank-deficient matrix (col1 = 2*col0 exactly)", () => {
    expect(
      pmatrix.pinv([
        [1, 2],
        [2, 4],
        [3, 6],
      ]),
    ).toBeNull();
  });

  it("computes a known 1x1 trivial reciprocal", () => {
    expect(pmatrix.pinv([[5]])).toEqual([[0.2]]);
  });

  it("computes the ordinary inverse for a known invertible square matrix (formula1 == A^-1 for square input, python direct execution golden)", () => {
    const result = pmatrix.pinv([
      [1, 2],
      [3, 4],
    ]) as number[][];
    expect(result[0]![0]).toBeCloseTo(-2, 9);
    expect(result[0]![1]).toBeCloseTo(1, 9);
    expect(result[1]![0]).toBeCloseTo(1.5, 9);
    expect(result[1]![1]).toBeCloseTo(-0.5, 9);
  });

  it("falls back to formula2 (mult(inv(mult(mt,m)),mt)) when formula1's inv(mult(m,mt)) hits an exact-zero pivot — a tall matrix built so row1=2*row0 exactly (python direct execution golden, oracle/cases/matrix_pinv.pine group F)", () => {
    const result = pmatrix.pinv([
      [1, 2],
      [2, 4],
      [3, 5],
    ]) as number[][];
    expect(result[0]![0]).toBeCloseTo(-1, 9);
    expect(result[0]![1]).toBeCloseTo(-2, 9);
    expect(result[0]![2]).toBeCloseTo(2, 9);
    expect(result[1]![0]).toBeCloseTo(0.6, 9);
    expect(result[1]![1]).toBeCloseTo(1.2, 9);
    expect(result[1]![2]).toBeCloseTo(-1, 9);
  });
});

// matrix.eigenvalues(rt.matrix.eigenvalues, C105, 열여섯 번째 슬라이스 — 행렬 대수 11종의 열 번째
// 항목) — n=1/n=2(disc>=0/disc<0)/n=3 정상 경로는 oracle/cases/matrix_eigenvalues.pine이 pine2py
// 골든 대조로 검증한다. 여기선 오라클로 트리거 불가한 크래시 경계만 hand-verified로 확인: m===null은
// pine2py `len(None)` 크래시(미정의)를 na(null, array 반환이라 참조형)로 흡수(det/trace/rank의
// 스칼라 "읽기는 na"=NaN과 다름 — row/col(#31)과 동일 반환형 원칙). m=[[]](1행0열)는 n=1 분기
// `m[0][0]`이 undefined를 그대로 반환하는 det(C98) n=1과 동일한 함정 — Number() 캐스팅으로 NaN
// 보정. 비정사각(rows>columns)은 n>=3 분기의 `m[i][i]`가 범위 밖일 때 Number(undefined)=NaN으로
// 부분 오염(일부 위치는 유효, 일부는 NaN)되는 새 위험 — det의 n=1 캐스팅과 같은 원리를 루프
// 안에서도 적용해 흡수(matrix.ts rt.matrix.eigenvalues 주석 참조, 487케이스 node fuzz로 검증
// 완료). isSquareMatrix 가드는 두지 않는다(inv/pow와 다른 결정 — 결과가 "그럴듯한 오답"이 아니라
// NaN으로 명시 오염되므로 det/trace와 동일하게 자연 literal port를 신뢰).
describe("matrix.eigenvalues (rt.matrix.eigenvalues, C105)", () => {
  it("returns na(null) for a na(null) matrix argument (array return type, not the scalar NaN of det/trace/rank)", () => {
    expect(pmatrix.eigenvalues(null)).toBeNull();
  });

  it("returns an empty array for a 0-row matrix ([]) — falls into the n>=3 branch with 0 iterations, no crash (python direct execution: well-defined [])", () => {
    expect(pmatrix.eigenvalues([])).toEqual([]);
  });

  it("returns [NaN] for a 1-row 0-column matrix ([[]]) — the n=1 branch reads m[0][0] as a bare value (not inside arithmetic), so JS undefined must be Number()-cast to NaN (det(C98) n=1 pitfall recurrence)", () => {
    const result = pmatrix.eigenvalues([[]]) as number[];
    expect(result.length).toBe(1);
    expect(Number.isNaN(result[0]!)).toBe(true);
  });

  it("computes the trivial n=1 eigenvalue as the sole element itself", () => {
    expect(pmatrix.eigenvalues([[7]])).toEqual([7]);
  });

  it("computes real eigenvalues for a n=2 matrix with disc>=0 (trace=7, det=10 -> eigenvalues 5 and 2)", () => {
    const result = pmatrix.eigenvalues([
      [4, 1],
      [2, 3],
    ]) as number[];
    expect(result[0]).toBeCloseTo(5, 9);
    expect(result[1]).toBeCloseTo(2, 9);
  });

  it("collapses to the repeated real part [tr/2, tr/2] for a n=2 matrix with disc<0 (complex eigenvalues, imaginary part dropped — pine2py's intentional approximation, literal port)", () => {
    const result = pmatrix.eigenvalues([
      [0, -1],
      [1, 0],
    ]) as number[];
    expect(result[0]).toBeCloseTo(0, 9);
    expect(result[1]).toBeCloseTo(0, 9);
  });

  it("returns a repeated eigenvalue for a n=2 matrix with disc==0 exactly (tr=4, det=4)", () => {
    const result = pmatrix.eigenvalues([
      [3, 1],
      [-1, 1],
    ]) as number[];
    expect(result[0]).toBeCloseTo(2, 9);
    expect(result[1]).toBeCloseTo(2, 9);
  });

  it("returns the raw diagonal for a n=3 matrix (not a real eigenvalue algorithm — pine2py's 'QR iteration' comment is misleading, the code just reads m[i][i])", () => {
    expect(
      pmatrix.eigenvalues([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8, 10],
      ]),
    ).toEqual([1, 5, 10]);
  });

  it("computes the top-left 2x2 submatrix's eigenvalues for a wide (rows<columns) matrix — extra columns are never touched, matching det(C98)'s 'left n-by-n submatrix' natural literal port (no crash, no isSquareMatrix gate)", () => {
    const result = pmatrix.eigenvalues([
      [1, 2, 3],
      [4, 5, 6],
    ]) as number[];
    expect(result[0]).toBeCloseTo(6.464101615137754, 9);
    expect(result[1]).toBeCloseTo(-0.4641016151377544, 9);
  });

  it("partially NaN-poisons a tall (rows>columns) matrix — pine2py crashes with IndexError reading m[2][2] out of range, JS naturally converges to NaN in the unreachable diagonal position while earlier valid positions stay intact ([1,2],[3,4],[5,6] -> [1,4,NaN])", () => {
    const result = pmatrix.eigenvalues([
      [1, 2],
      [3, 4],
      [5, 6],
    ]) as number[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(4);
    expect(Number.isNaN(result[2]!)).toBe(true);
  });
});

// matrix.eigenvectors(rt.matrix.eigenvectors, C106, 열일곱 번째이자 마지막 슬라이스 — 행렬 대수
// 11종의 열한 번째 항목, matrix.* 48/49 -> 49/49 완주) — n=2 두 분기(ratio/fallback)와 n=3(고정
// 벡터 반복)의 정상 경로는 oracle/cases/matrix_eigenvectors.pine이 pine2py 골든 대조로 검증한다.
// 여기선 오라클로 트리거 불가한 크래시 경계만 hand-verified로 확인: m===null은 eigenvalues(m)
// 호출 자체가 pine2py `len(None)` TypeError로 크래시(미정의)하지만, 이미 구현된
// rt.matrix.eigenvalues(null)===null을 그대로 승계해 na(null, matrix 반환이라 참조형)로 흡수.
// m=[[]](1행0열)와 rows>columns(예 3x2 tall)는 pine2py가 eigenvalues(m) 내부에서 이미 크래시하는
// 지점이지만, rt.matrix.eigenvalues가 그 크래시를 각각 [NaN]/부분-NaN 배열로 흡수해뒀으므로(C105)
// eigenvectors는 n!==2 분기(ev 값을 전혀 읽지 않는 고정 벡터)라 크래시 없이 정상 반환된다 —
// "하위 함수의 흡수를 그대로 승계"가 공짜로 일어나는 사례(matrix.ts rt.matrix.eigenvectors 주석
// 참조, python 직접 실행으로 각 케이스의 크래시 여부를 대조 확인 완료).
describe("matrix.eigenvectors (rt.matrix.eigenvectors, C106)", () => {
  it("returns na(null) for a na(null) matrix argument (matrix return type — evals===null propagates through the eigenvalues() composition)", () => {
    expect(pmatrix.eigenvectors(null)).toBeNull();
  });

  it("returns an empty matrix for a 0-row matrix ([]) — evals=[] so the result loop runs 0 times, no crash", () => {
    expect(pmatrix.eigenvectors([])).toEqual([]);
  });

  it("returns [[1.0]] for a 1-row 0-column matrix ([[]]) — pine2py crashes inside the nested eigenvalues(m) call (IndexError on m[0][0]), but rt.matrix.eigenvalues already absorbs that into [NaN]; eigenvectors' n!==2 branch never reads the eigenvalue itself, so the NaN is silently discarded and a fixed vector comes out", () => {
    const result = pmatrix.eigenvectors([[]]) as number[][];
    expect(result.length).toBe(1);
    expect(result[0]).toEqual([1.0]);
  });

  it("computes the ratio branch [-mat01/mat00, 1.0] for both repeated eigenvalues of a n=2 matrix with disc==0 exactly (literal [[3,1],[-1,1]], tr=4 det=4 -> eigenvalue 2.0 repeated, mat00=3-2=1!=0)", () => {
    const result = pmatrix.eigenvectors([
      [3, 1],
      [-1, 1],
    ]) as number[][];
    expect(result.length).toBe(2);
    expect(result[0]![0]).toBeCloseTo(-1, 9);
    expect(result[0]![1]).toBeCloseTo(1, 9);
    expect(result[1]![0]).toBeCloseTo(-1, 9);
    expect(result[1]![1]).toBeCloseTo(1, 9);
  });

  it("falls back to [1.0, 0.0] when mat00 is within 1e-10 of zero for a diagonal n=2 matrix ([[2,0],[0,3]] -> eigenvalues [3,2], first eigenvalue exactly matches m[0][0]=2? no — matches m[1][1]=3 second, so mat00=2-3=-1 for ev=2 (ratio) and mat00=2-2=0 for the other since eigenvalues() returns [3,2] not [2,3] when trace=5,det=6 gives max-first)", () => {
    const result = pmatrix.eigenvectors([
      [2, 0],
      [0, 3],
    ]) as number[][];
    expect(result.length).toBe(2);
    // eigenvalues([[2,0],[0,3]]) = [3, 2] (larger root first) — matches python direct execution.
    expect(result[0]![0]).toBeCloseTo(0, 9);
    expect(result[0]![1]).toBe(1.0);
    expect(result[1]).toEqual([1.0, 0.0]);
  });

  it("repeats the fixed [1.0, 0.0, 0.0] vector for every eigenvalue of a n=3 matrix (eigenvector value is independent of the eigenvalue's actual value — only evals.length matters)", () => {
    const result = pmatrix.eigenvectors([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]) as number[][];
    expect(result).toEqual([
      [1.0, 0.0, 0.0],
      [1.0, 0.0, 0.0],
      [1.0, 0.0, 0.0],
    ]);
  });

  it("returns the trivial [1.0] vector for a n=1 matrix regardless of the cell's value", () => {
    expect(pmatrix.eigenvectors([[7]])).toEqual([[1.0]]);
  });

  it("computes a well-defined result for a wide (rows<columns) n=2 matrix — the eigenvalues() composition already handles the left n-by-n submatrix, no crash (python direct execution: no crash for 2x3 wide either)", () => {
    const result = pmatrix.eigenvectors([
      [1, 2, 3],
      [4, 5, 6],
    ]) as number[][];
    expect(result.length).toBe(2);
    expect(Number.isFinite(result[0]![0] as number)).toBe(true);
    expect(Number.isFinite(result[1]![0] as number)).toBe(true);
  });

  it("stays crash-free for a tall (rows>columns) n=3 matrix — pine2py crashes inside eigenvalues(m) (IndexError on m[2][2]), rt.matrix.eigenvalues absorbs it into a partially-NaN array, and eigenvectors' n!==2 branch never reads the eigenvalue so the fixed [1,0,0] vector repeats 3 times regardless", () => {
    const result = pmatrix.eigenvectors([
      [1, 2],
      [3, 4],
      [5, 6],
    ]) as number[][];
    expect(result).toEqual([
      [1.0, 0.0, 0.0],
      [1.0, 0.0, 0.0],
      [1.0, 0.0, 0.0],
    ]);
  });
});

describe("Series.toArray (plot collection channel, C135)", () => {
  it("returns the full recorded history in oldest-to-newest order", () => {
    const s = Series.preallocate(3);
    s.advance();
    s.record(10);
    s.advance();
    s.record(20);
    s.advance();
    s.record(30);
    expect(s.toArray()).toEqual([10, 20, 30]);
  });

  it("leaves un-recorded slots as NaN", () => {
    const s = Series.preallocate(2);
    s.advance();
    s.record(5);
    s.advance(); // second slot never record()ed
    expect(s.toArray()[0]).toBe(5);
    expect(s.toArray()[1]).toBeNaN();
  });
});

describe("Context", () => {
  it("initializes var slots as undefined (uninitialized marker)", () => {
    const ctx = new Context({ open: [1], high: [1], low: [1], close: [1], volume: [1] }, 2, 0);
    expect(ctx.vars).toEqual([undefined, undefined]);
  });

  it("preallocates plot slots to the bar count and advances them alongside the bar series (C135)", () => {
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3] },
      0,
      0,
      0,
      0,
      0,
      {},
      2,
    );
    expect(ctx.plots).toHaveLength(2);
    ctx.advance();
    ctx.plots[0]!.record(100);
    ctx.advance();
    ctx.plots[0]!.record(200);
    expect(ctx.plots[0]!.toArray()).toEqual([100, 200, NaN]);
    expect(ctx.plots[1]!.toArray()).toEqual([NaN, NaN, NaN]); // 한 번도 record() 안 됨
  });

  it("gives each TA slot its own independent plain-object state", () => {
    const ctx = new Context({ open: [1], high: [1], low: [1], close: [1], volume: [1] }, 0, 2);
    expect(ctx.taSlots).toHaveLength(2);
    expect(ctx.taSlots[0]).not.toBe(ctx.taSlots[1]);
    (ctx.taSlots[0] as Record<string, unknown>).touched = true;
    expect(ctx.taSlots[1]).not.toHaveProperty("touched");
  });

  it("advances all bar series together", () => {
    const ctx = new Context(
      { open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] },
      0,
      0,
    );
    ctx.advance();
    expect(ctx.close.get(0)).toBe(1);
    ctx.advance();
    expect(ctx.close.get(0)).toBe(2);
    expect(ctx.close.get(1)).toBe(1);
  });

  it("starts idx at -1 before any advance() (barstate.*/session.* rely on this pre-loop state, ROADMAP P2)", () => {
    const ctx = new Context({ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] }, 0, 0);
    expect(ctx.idx).toBe(-1);
  });

  it("advances idx by 1 per advance() call, in lockstep with the bar series cursor (pine2py wavealgo Context.idx equivalent)", () => {
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3] },
      0,
      0,
    );
    ctx.advance();
    expect(ctx.idx).toBe(0);
    ctx.advance();
    expect(ctx.idx).toBe(1);
    ctx.advance();
    expect(ctx.idx).toBe(2);
  });

  // ── barTimeAt/timeCloseAt(C368) — time 계열 빌트인 히스토리의 (idx-offset) 직접 합성 ────
  const TIMES5 = [1000, 2000, 3000, 4000, 5000];
  function makeTimeCtx(): Context {
    const ctx = new Context(
      { open: [1, 2, 3, 4, 5], high: [1, 2, 3, 4, 5], low: [1, 2, 3, 4, 5], close: [1, 2, 3, 4, 5], volume: [1, 2, 3, 4, 5], time: TIMES5 },
      0,
      0,
    );
    ctx.advance();
    ctx.advance();
    ctx.advance(); // idx = 2
    return ctx;
  }

  it("barTimeAt returns the time of bar (idx - offset), offset 0 being the current bar", () => {
    const ctx = makeTimeCtx();
    expect(ctx.barTimeAt(0)).toBe(3000);
    expect(ctx.barTimeAt(1)).toBe(2000);
    expect(ctx.barTimeAt(2)).toBe(1000);
  });

  it("barTimeAt returns NaN during warmup / for negative / for NaN offsets (Series.get() parity) and truncates fractional offsets", () => {
    const ctx = makeTimeCtx();
    expect(ctx.barTimeAt(3)).toBeNaN();
    expect(ctx.barTimeAt(-1)).toBeNaN();
    expect(ctx.barTimeAt(NaN)).toBeNaN();
    expect(ctx.barTimeAt(1.9)).toBe(2000);
  });

  it("barTimeAt falls back to 0 when the time channel is absent (barTimeMs parity), but keeps the warmup NaN guard", () => {
    const ctx = new Context({ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] }, 0, 0);
    ctx.advance();
    ctx.advance(); // idx = 1
    expect(ctx.barTimeAt(1)).toBe(0);
    expect(ctx.barTimeAt(2)).toBeNaN();
  });

  it("timeCloseAt returns the next bar's open time for the (idx - offset) bar (timeCloseMs parity)", () => {
    const ctx = makeTimeCtx();
    expect(ctx.timeCloseAt(1)).toBe(3000); // bar1의 close 시각 = bar2의 open 시각
    expect(ctx.timeCloseAt(2)).toBe(2000);
    expect(ctx.timeCloseAt(3)).toBeNaN(); // 워밍업
    expect(ctx.timeCloseAt(0)).toBe(4000); // 현재 바(2)의 close = bar3의 open
  });

  it("timeCloseAt extrapolates the last bar's close from the previous interval (runtime offset 0 on the final bar)", () => {
    const ctx = makeTimeCtx();
    ctx.advance();
    ctx.advance(); // idx = 4 (마지막 바)
    expect(ctx.timeCloseAt(0)).toBe(6000); // 5000 + (5000 - 4000)
    expect(ctx.timeCloseAt(1)).toBe(5000);
  });

  it("keeps barCount fixed at the total bar count regardless of idx (pine2py Context.length equivalent)", () => {
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3] },
      0,
      0,
    );
    expect(ctx.barCount).toBe(3);
    ctx.advance();
    expect(ctx.barCount).toBe(3);
    ctx.advance();
    ctx.advance();
    expect(ctx.barCount).toBe(3);
  });

  it("preallocates each history slot to the bar count and advances them alongside the bar series", () => {
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3] },
      0,
      0,
      0,
      2,
    );
    expect(ctx.histSlots).toHaveLength(2);
    ctx.advance();
    ctx.histSlots[0]!.record(100);
    ctx.advance();
    expect(ctx.histSlots[0]!.get(1)).toBe(100);
    expect(ctx.histSlots[1]!.get(0)).toBeNaN(); // 아직 한 번도 record() 안 됨
  });

  // request.security 0번째 슬라이스(ROADMAP P2 [hard->분할], 선행 작업) — OHLCVData/Context에
  // 옵셔널 time 채널만 추가하는 사이클. request.security 자체(HTF 집계)는 아직 구현하지 않는다.
  it("leaves time undefined when the OHLCVData omits it (existing callers unaffected, C129 원칙)", () => {
    const ctx = new Context({ open: [1], high: [1], low: [1], close: [1], volume: [1] }, 0, 0);
    expect(ctx.time).toBeUndefined();
  });

  it("stores the time channel verbatim when OHLCVData provides it (pine2py ctx._time_data equivalent)", () => {
    const time = [1704067200000, 1704153600000, 1704240000000];
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time },
      0,
      0,
    );
    expect(ctx.time).toBe(time);
    expect(ctx.time).toEqual([1704067200000, 1704153600000, 1704240000000]);
  });

  it("does not change any other Context field when time is supplied (regression: additive-only channel)", () => {
    const withoutTime = new Context(
      { open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] },
      1,
      0,
    );
    const withTime = new Context(
      { open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2], time: [1000, 2000] },
      1,
      0,
    );
    withoutTime.advance();
    withTime.advance();
    expect(withTime.idx).toBe(withoutTime.idx);
    expect(withTime.close.get(0)).toBe(withoutTime.close.get(0));
    expect(withTime.barCount).toBe(withoutTime.barCount);
    expect(withTime.vars).toEqual(withoutTime.vars);
  });

  it("accepts a time array shorter than the bar count without validation (mirrors pine2py's unchecked raw list — bounds are the HTF-aggregation slice's responsibility, not Context's)", () => {
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time: [1000] },
      0,
      0,
    );
    expect(ctx.time).toEqual([1000]);
    expect(ctx.barCount).toBe(3);
  });

  // barTimeMs/lastBarTimeMs(C242 — ROADMAP P3 next_hint 1순위, TV 시각 변수의 공통 입력 채널)

  it("barTimeMs returns 0 for every bar when time is undefined (pine2py Context.time default)", () => {
    const ctx = new Context({ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] }, 0, 0);
    ctx.advance();
    expect(ctx.barTimeMs).toBe(0);
    ctx.advance();
    expect(ctx.barTimeMs).toBe(0);
  });

  it("barTimeMs tracks time[idx] as the bar loop advances", () => {
    const time = [1704067200000, 1704153600000, 1704240000000];
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time },
      0,
      0,
    );
    ctx.advance();
    expect(ctx.barTimeMs).toBe(1704067200000);
    ctx.advance();
    expect(ctx.barTimeMs).toBe(1704153600000);
    ctx.advance();
    expect(ctx.barTimeMs).toBe(1704240000000);
  });

  it("barTimeMs returns 0 once idx runs past a shorter time array (pine2py 'idx < len(_time_data)' guard)", () => {
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time: [1000] },
      0,
      0,
    );
    ctx.advance();
    expect(ctx.barTimeMs).toBe(1000);
    ctx.advance();
    expect(ctx.barTimeMs).toBe(0);
  });

  it("lastBarTimeMs returns the final time[] element regardless of idx (pine2py Context.last_bar_time equivalent)", () => {
    const time = [1704067200000, 1704153600000, 1704240000000];
    const ctx = new Context(
      { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time },
      0,
      0,
    );
    ctx.advance();
    expect(ctx.lastBarTimeMs).toBe(1704240000000);
    ctx.advance();
    expect(ctx.lastBarTimeMs).toBe(1704240000000);
  });

  it("lastBarTimeMs returns 0 when time is undefined or empty", () => {
    const ctx = new Context({ open: [1], high: [1], low: [1], close: [1], volume: [1] }, 0, 0);
    expect(ctx.lastBarTimeMs).toBe(0);
  });

  // timeCloseMs/timenowMs(C342, wild "알 수 없는 식별자" 클러스터 1/2위) — pine2py 자신은 둘 다
  // 구조적으로 dead(time_close는 _time_close_data가 어디서도 안 채워져 항상 0, timenow는 실제
  // 벽시계라 재현 불가)라 literal port가 아니라 hand-verified 신규 설계(context.ts 주석 참조).
  describe("timeCloseMs (next bar's open time approximates this bar's close time, gapless assumption)", () => {
    it("returns the next bar's time[] element while more bars remain", () => {
      const time = [1704067200000, 1704153600000, 1704240000000];
      const ctx = new Context(
        { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time },
        0,
        0,
      );
      ctx.advance();
      expect(ctx.timeCloseMs).toBe(1704153600000);
      ctx.advance();
      expect(ctx.timeCloseMs).toBe(1704240000000);
    });

    it("extrapolates the last bar using the prior bar-to-bar interval", () => {
      const time = [1704067200000, 1704153600000, 1704240000000];
      const ctx = new Context(
        { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time },
        0,
        0,
      );
      ctx.advance();
      ctx.advance();
      ctx.advance();
      expect(ctx.idx).toBe(2);
      // interval = 1704240000000 - 1704153600000 = 86400000 (1 day)
      expect(ctx.timeCloseMs).toBe(1704240000000 + 86400000);
    });

    it("falls back to time[0] itself (zero duration) when only one bar exists", () => {
      const ctx = new Context(
        { open: [1], high: [1], low: [1], close: [1], volume: [1], time: [1704067200000] },
        0,
        0,
      );
      ctx.advance();
      expect(ctx.timeCloseMs).toBe(1704067200000);
    });

    it("returns 0 when time is undefined (no time channel infrastructure)", () => {
      const ctx = new Context({ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [1, 2] }, 0, 0);
      ctx.advance();
      expect(ctx.timeCloseMs).toBe(0);
    });
  });

  describe("timenowMs (deterministic environment-value stand-in, pinned to lastBarTimeMs)", () => {
    it("equals lastBarTimeMs regardless of idx", () => {
      const time = [1704067200000, 1704153600000, 1704240000000];
      const ctx = new Context(
        { open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 2, 3], time },
        0,
        0,
      );
      ctx.advance();
      expect(ctx.timenowMs).toBe(1704240000000);
      ctx.advance();
      expect(ctx.timenowMs).toBe(1704240000000);
    });

    it("returns 0 when time is undefined or empty", () => {
      const ctx = new Context({ open: [1], high: [1], low: [1], close: [1], volume: [1] }, 0, 0);
      expect(ctx.timenowMs).toBe(0);
    });
  });
});

// timeframe.in_seconds/from_seconds(ROADMAP P2 "barstate/session/syminfo/timeframe" 세 번째(마지막)
// 슬라이스) — literal port 대상은 pine2py codegen.py의 함수-이름 매핑 테이블이 실제로 라우팅하는
// wa.timeframe_in_seconds/wa.timeframe_from_seconds(wavealgo/__init__.py)다. 이 값들은
// wavealgo/builtins/timeframe.py Timeframe.in_seconds/from_seconds staticmethod의 값과 다르다 —
// PROGRESS.md C149 next_hint가 python으로 "직접 실행 확인"했다고 기록한 예시값(in_seconds('1W')=
// 604800, in_seconds('15S')=15, from_seconds(86400)='D' 등)은 사실 이 staticmethod 쪽을 실행한
// 결과였고, 실제 codegen이 호출하는 wa.timeframe_in_seconds/from_seconds는 전혀 다른(더 단순한)
// 로직이라 값이 갈린다(C150에서 python 직접 실행으로 재확인 후 정정 — MEMORY.md 승격 대상).
// 아래 기대값은 전부 gen_oracle.py가 생성한 oracle/golden/timeframe_basic.json과 대조 완료.
describe("rt.timeframe.in_seconds/from_seconds (literal port of wa.timeframe_in_seconds/from_seconds)", () => {
  it("in_seconds resolves 'D'/'W'/'M' to their fixed second counts", () => {
    expect(in_seconds("D")).toBe(86400);
    expect(in_seconds("W")).toBe(604800);
    expect(in_seconds("M")).toBe(2592000);
  });

  it("in_seconds resolves a bare digit string as minutes", () => {
    expect(in_seconds("60")).toBe(3600);
    expect(in_seconds("1")).toBe(60);
    expect(in_seconds("5")).toBe(300);
  });

  it("in_seconds falls back to 86400 for a compound string like '1W'/'15S' (NOT 604800/15 — that's the unrelated Timeframe class staticmethod, not what codegen actually calls)", () => {
    expect(in_seconds("1W")).toBe(86400);
    expect(in_seconds("15S")).toBe(86400);
  });

  it("in_seconds falls back to 86400 for an empty or non-numeric string", () => {
    expect(in_seconds("")).toBe(86400);
    expect(in_seconds("abc")).toBe(86400);
  });

  it("in_seconds falls back to 86400 when called with no argument (C269 — pine2py timeframe_in_seconds(timeframe: str = '') default, corpus 390cd5d7f5f3.pine)", () => {
    expect(in_seconds()).toBe(86400);
  });

  it("in_seconds accepts a signed integer string like Python's int()", () => {
    expect(in_seconds("-5")).toBe(-300);
  });

  it("from_seconds formats sub-minute durations as a 5-second-rounded 'NS' string", () => {
    expect(from_seconds(30)).toBe("30S");
    expect(from_seconds(15)).toBe("15S");
  });

  it("from_seconds formats intraday durations (<86400s) as a bare minute-count string", () => {
    expect(from_seconds(60)).toBe("1");
    expect(from_seconds(3600)).toBe("60");
  });

  it("from_seconds formats exactly 86400 as '1D' (NOT 'D' — that's the unrelated Timeframe class staticmethod)", () => {
    expect(from_seconds(86400)).toBe("1D");
  });

  it("from_seconds formats an exact multiple of a week as 'NW'", () => {
    expect(from_seconds(604800)).toBe("1W");
    expect(from_seconds(604800 * 52)).toBe("52W");
  });

  it("from_seconds formats a non-week-exact multi-day duration as 'ND' (ceil)", () => {
    expect(from_seconds(2592000)).toBe("30D");
  });

  it("from_seconds falls back to '12M' beyond the 52-week cap", () => {
    expect(from_seconds(604800 * 53)).toBe("12M");
  });

  it("from_seconds treats non-positive seconds as 'D'", () => {
    expect(from_seconds(0)).toBe("D");
    expect(from_seconds(-5)).toBe("D");
  });
});

// chart.point.new/from_index/from_time/copy/now(C229, corpus 10개 파일 실측) — pine2py
// wavealgo chart_point_*(runtime/drawing.ts ChartPoint 주석 참조)의 literal port. drawing 핸들과
// 달리 no-op 카운터가 아니라 {time,index,price} 값 자체 — 인자 "생략"(JS undefined)만 기본값을
// 채우고 명시적 na(NaN)는 그대로 통과한다(pine2py도 na 리터럴이 항상 float('nan')으로 컴파일돼
// None 분기를 안 탐, MEMORY.md C110).
describe("chart.point.* (C229)", () => {
  it("new(time, index, price) returns all three fields as given", () => {
    expect(chartPointNew(100, 5, 42.5)).toEqual({ time: 100, index: 5, price: 42.5 });
  });

  it("new() with omitted trailing args defaults those fields to null (pine2py time=None/index=None/price=None)", () => {
    expect(chartPointNew()).toEqual({ time: null, index: null, price: null });
    expect(chartPointNew(100)).toEqual({ time: 100, index: null, price: null });
  });

  it("new() passes an explicit na (NaN) through unchanged rather than defaulting it to null (matches pine2py's na-is-not-None compile behavior)", () => {
    expect(chartPointNew(NaN, 5, 42.5)).toEqual({ time: NaN, index: 5, price: 42.5 });
  });

  it("from_index(index, price) always nulls the time field", () => {
    expect(chartPointFromIndex(7, 100.0)).toEqual({ time: null, index: 7, price: 100.0 });
  });

  it("from_index() with all args omitted falls back to pine2py's index=0/price=0.0 defaults", () => {
    expect(chartPointFromIndex()).toEqual({ time: null, index: 0, price: 0 });
  });

  it("from_time(time, price) always nulls the index field", () => {
    expect(chartPointFromTime(1234, 55.0)).toEqual({ time: 1234, index: null, price: 55.0 });
  });

  it("now(price) nulls both time and index", () => {
    expect(chartPointNow(99.5)).toEqual({ time: null, index: null, price: 99.5 });
  });

  it("now() with price omitted falls back to pine2py's price=0.0 default", () => {
    expect(chartPointNow()).toEqual({ time: null, index: null, price: 0 });
  });

  it("copy(point) makes an independent shallow copy (mutating the copy does not affect the original)", () => {
    const original = chartPointNew(1, 2, 3);
    const copy = chartPointCopy(original);
    expect(copy).toEqual({ time: 1, index: 2, price: 3 });
    copy.price = 999;
    expect(original.price).toBe(3);
  });

  it("copy() with no point (or a non-object na/NaN) returns an all-null point instead of crashing (pine2py's dict(nan) would TypeError here — GOAL.md 'known bugs are not ported')", () => {
    expect(chartPointCopy()).toEqual({ time: null, index: null, price: null });
    expect(chartPointCopy(null)).toEqual({ time: null, index: null, price: null });
    // @ts-expect-error deliberately passing a non-object to exercise the defensive guard
    expect(chartPointCopy(NaN)).toEqual({ time: null, index: null, price: null });
  });
});

describe("log.info/warning/error + runtime.warning (C231, literal port of pine2py's pure no-op)", () => {
  it("logInfo/logWarning/logError discard any number of args and return undefined", () => {
    expect(logInfo("price: {0}", 100)).toBeUndefined();
    expect(logWarning("warn")).toBeUndefined();
    expect(logError()).toBeUndefined();
  });

  it("runtimeWarning discards its message and returns undefined (pine2py prints to stderr — a side effect, not a computed value)", () => {
    expect(runtimeWarning("just a warning")).toBeUndefined();
  });
});

describe("runtime.error (C231 — pine2py's runtime_error actually raises, not a no-op; this is TV's own fatal semantics, not a bug to avoid porting)", () => {
  it("throws (halting script execution), matching pine2py's raise RuntimeError(...)", () => {
    expect(() => runtimeError("boom")).toThrow("PineScript runtime error: boom");
  });

  it("defaults the message to an empty string when omitted (pine2py runtime_error(message: str = \"\"))", () => {
    expect(() => runtimeError()).toThrow("PineScript runtime error: ");
  });
});

// rt.datetime.*(C242 — ROADMAP P3 next_hint 1순위, TV 시각 변수 hour/dayofweek/year/
// last_bar_index/time_tradingday 등) — pine2py wavealgo/context.py
// Context._datetime_component/time_tradingday의 UTC 고정 literal port. 아래 기대값은 전부
// gen_oracle.py가 생성한 oracle/golden/time_vars.json과 대조 완료(python datetime.fromtimestamp
// (t/1000, tz=utc)로 직접 재확인한 타임스탬프).
describe("rt.datetime.* (literal port of pine2py Context._datetime_component/time_tradingday, UTC-fixed)", () => {
  const MONDAY_2024_01_01 = 1704067200000; // 2024-01-01T00:00:00Z
  const LEAP_DAY_2024_02_29 = 1709214330000; // 2024-02-29T13:45:30Z (Thu)
  const YEAR_BOUNDARY_2023_12_31 = 1704067199000; // 2023-12-31T23:59:59Z (Sun)
  const SATURDAY_2024_01_06 = 1704499200000; // 2024-01-06T00:00:00Z

  it("decomposes year/month/dayofmonth/hour/minute/second from a UTC ms timestamp", () => {
    expect(year(LEAP_DAY_2024_02_29)).toBe(2024);
    expect(month(LEAP_DAY_2024_02_29)).toBe(2);
    expect(dayofmonth(LEAP_DAY_2024_02_29)).toBe(29);
    expect(hour(LEAP_DAY_2024_02_29)).toBe(13);
    expect(minute(LEAP_DAY_2024_02_29)).toBe(45);
    expect(second(LEAP_DAY_2024_02_29)).toBe(30);
  });

  it("handles the year boundary correctly (2023-12-31T23:59:59Z, not rounded into 2024)", () => {
    expect(year(YEAR_BOUNDARY_2023_12_31)).toBe(2023);
    expect(month(YEAR_BOUNDARY_2023_12_31)).toBe(12);
    expect(dayofmonth(YEAR_BOUNDARY_2023_12_31)).toBe(31);
    expect(hour(YEAR_BOUNDARY_2023_12_31)).toBe(23);
    expect(minute(YEAR_BOUNDARY_2023_12_31)).toBe(59);
    expect(second(YEAR_BOUNDARY_2023_12_31)).toBe(59);
  });

  it("maps dayofweek to PineScript's 1=Sunday..7=Saturday convention (pine2py context.py comment, verified via gen_oracle.py)", () => {
    expect(dayofweek(MONDAY_2024_01_01)).toBe(2); // Monday
    expect(dayofweek(LEAP_DAY_2024_02_29)).toBe(5); // Thursday
    expect(dayofweek(YEAR_BOUNDARY_2023_12_31)).toBe(1); // Sunday
    expect(dayofweek(SATURDAY_2024_01_06)).toBe(7); // Saturday
  });

  it("computes the ISO 8601 week number (pine2py 'dt.isocalendar()[1]', C302 — gap missed by C242's original TIME_VAR_NAMES 7종)", () => {
    expect(weekofyear(MONDAY_2024_01_01)).toBe(1);
    expect(weekofyear(LEAP_DAY_2024_02_29)).toBe(9);
    expect(weekofyear(YEAR_BOUNDARY_2023_12_31)).toBe(52); // ISO 주는 그레고리력 연도 경계와 안 맞음
    expect(weekofyear(SATURDAY_2024_01_06)).toBe(1);
  });

  it("handles a leap ISO year (53 weeks) straddling a Gregorian year boundary (python isocalendar()로 대조)", () => {
    expect(weekofyear(Date.UTC(2020, 11, 31))).toBe(53); // 2020-12-31 -> ISO 2020-W53
    expect(weekofyear(Date.UTC(2021, 0, 1))).toBe(53); // 2021-01-01 -> still ISO 2020-W53
    expect(weekofyear(Date.UTC(2021, 0, 4))).toBe(1); // 2021-01-04(Mon) -> ISO 2021-W01
  });

  it("returns 0 for every component when ms is exactly 0 (pine2py 'if t == 0: return 0' guard — the no-time-channel sentinel)", () => {
    expect(year(0)).toBe(0);
    expect(month(0)).toBe(0);
    expect(dayofmonth(0)).toBe(0);
    expect(dayofweek(0)).toBe(0);
    expect(hour(0)).toBe(0);
    expect(minute(0)).toBe(0);
    expect(second(0)).toBe(0);
    expect(weekofyear(0)).toBe(0);
    expect(tradingDayStart(0)).toBe(0);
  });

  it("tradingDayStart truncates to the 00:00:00 UTC start of the same calendar day", () => {
    expect(tradingDayStart(LEAP_DAY_2024_02_29)).toBe(1709164800000); // 2024-02-29T00:00:00Z
    expect(tradingDayStart(YEAR_BOUNDARY_2023_12_31)).toBe(1703980800000); // 2023-12-31T00:00:00Z
    expect(tradingDayStart(MONDAY_2024_01_01)).toBe(MONDAY_2024_01_01); // already midnight -> unchanged
  });

  it("returns 0 from tradingDayStart for non-positive ms (pine2py 'if t > 0' guard, distinct from the '=== 0' component guard)", () => {
    expect(tradingDayStart(0)).toBe(0);
    expect(tradingDayStart(-1)).toBe(0);
  });

  it("propagates NaN through tradingDayStart (C368 history warmup — must not collapse into the 0 no-channel fallback)", () => {
    expect(tradingDayStart(NaN)).toBeNaN();
  });

  // ── 2-인자 timezone 오버로드(C326, wild 175건) — pine2py는 이 인자를 항상 무시하는 실제 버그라
  // (runtime/datetime.ts 헤더 주석) 오라클 대조가 불가능한 축, 전부 hand-verified(node Intl.
  // DateTimeFormat 직접 실행으로 기대값 도출, DIVERGENCES 'TV 미검증(가설)').
  describe("timezone-aware overload (hand-verified — pine2py always ignores this argument, a known bug)", () => {
    it("converts to an IANA zone with a fixed (no-DST) offset (Asia/Seoul, UTC+9)", () => {
      expect(year(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(2024);
      expect(month(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(2);
      expect(dayofmonth(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(29);
      expect(hour(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(22);
      expect(minute(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(45);
      expect(second(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(30);
      expect(dayofweek(LEAP_DAY_2024_02_29, "Asia/Seoul")).toBe(5); // still Thursday, same-day shift
    });

    it("matches the equivalent fixed UTC±offset string (UTC+9 == Asia/Seoul for this timestamp)", () => {
      expect(hour(LEAP_DAY_2024_02_29, "UTC+9")).toBe(22);
      expect(dayofmonth(LEAP_DAY_2024_02_29, "UTC+9")).toBe(29);
    });

    it("rolls the calendar date forward across a UTC day/year boundary for an eastern zone", () => {
      // 2023-12-31T23:59:59Z + 9h -> 2024-01-01T08:59:59 local (Asia/Seoul)
      expect(year(YEAR_BOUNDARY_2023_12_31, "Asia/Seoul")).toBe(2024);
      expect(month(YEAR_BOUNDARY_2023_12_31, "Asia/Seoul")).toBe(1);
      expect(dayofmonth(YEAR_BOUNDARY_2023_12_31, "Asia/Seoul")).toBe(1);
      expect(hour(YEAR_BOUNDARY_2023_12_31, "Asia/Seoul")).toBe(8);
      expect(dayofweek(YEAR_BOUNDARY_2023_12_31, "Asia/Seoul")).toBe(2); // Sun UTC -> Mon local
    });

    it("rolls the calendar date backward across a UTC day boundary for a western zone", () => {
      // 2024-01-01T00:00:00Z - 5h -> 2023-12-31T19:00:00 local (America/New_York, winter/EST)
      expect(year(MONDAY_2024_01_01, "America/New_York")).toBe(2023);
      expect(month(MONDAY_2024_01_01, "America/New_York")).toBe(12);
      expect(dayofmonth(MONDAY_2024_01_01, "America/New_York")).toBe(31);
      expect(hour(MONDAY_2024_01_01, "America/New_York")).toBe(19);
      expect(dayofweek(MONDAY_2024_01_01, "America/New_York")).toBe(1); // Mon UTC -> Sun local
      expect(hour(MONDAY_2024_01_01, "UTC-5")).toBe(19); // fixed-offset form matches (no DST in winter)
    });

    it("applies real DST rules for an IANA zone (America/New_York EDT=UTC-4 in July, distinct from its winter EST=UTC-5)", () => {
      const summer2024_07_15T18_30Z = Date.UTC(2024, 6, 15, 18, 30, 0);
      expect(hour(summer2024_07_15T18_30Z, "America/New_York")).toBe(14); // 18:30 - 4h (EDT)
      // a naive fixed "UTC-5" would wrongly give 13, proving the IANA path isn't just offset math
      expect(hour(summer2024_07_15T18_30Z, "UTC-5")).toBe(13);
    });

    it("falls back to UTC (unchanged ms) for an unrecognized timezone string", () => {
      expect(hour(MONDAY_2024_01_01, "Not/AZone")).toBe(hour(MONDAY_2024_01_01));
      expect(year(MONDAY_2024_01_01, "Not/AZone")).toBe(year(MONDAY_2024_01_01));
    });

    it("treats an empty string, null, or omitted timezone identically to the UTC-only 1-arg form", () => {
      expect(hour(LEAP_DAY_2024_02_29, "")).toBe(hour(LEAP_DAY_2024_02_29));
      expect(hour(LEAP_DAY_2024_02_29, null)).toBe(hour(LEAP_DAY_2024_02_29));
      expect(hour(LEAP_DAY_2024_02_29, undefined)).toBe(hour(LEAP_DAY_2024_02_29));
    });

    it("still returns 0 for every component when ms is exactly 0, regardless of timezone (sentinel takes priority)", () => {
      expect(year(0, "Asia/Seoul")).toBe(0);
      expect(hour(0, "America/New_York")).toBe(0);
      expect(weekofyear(0, "UTC+9")).toBe(0);
    });

    it("shifts the ISO week number when the zone offset crosses an ISO week boundary", () => {
      // 2021-01-01T00:00:00Z(Fri, ISO week 53 of 2020) + 9h(Asia/Seoul) -> still 2021-01-01, same week
      expect(weekofyear(Date.UTC(2021, 0, 1), "UTC")).toBe(53);
      // 2020-12-31T20:00:00Z + 9h -> 2021-01-01T05:00:00 local -> still ISO week 53(2021-01-01 itself is W53)
      expect(weekofyear(Date.UTC(2020, 11, 31, 20, 0, 0), "Asia/Seoul")).toBe(53);
      // but 2020-12-31T14:00:00Z + 9h -> 2020-12-31T23:00:00 local -> stays in 2020, ISO week 53
      expect(weekofyear(Date.UTC(2020, 11, 31, 14, 0, 0), "Asia/Seoul")).toBe(53);
    });

    it("propagates NaN instead of throwing RangeError: Invalid time value for an IANA zone (C570 — wild history-warmup reads like hour(time[1], \"America/New_York\") on an early bar feed NaN ms into Intl.DateTimeFormat.formatToParts, which throws on new Date(NaN) unlike the fixed-offset/no-zone paths that let NaN propagate naturally)", () => {
      expect(() => hour(NaN, "America/New_York")).not.toThrow();
      expect(hour(NaN, "America/New_York")).toBeNaN();
      expect(year(NaN, "Asia/Seoul")).toBeNaN();
      expect(month(NaN, "UTC")).toBeNaN();
      expect(dayofmonth(NaN, "UTC")).toBeNaN();
      expect(dayofweek(NaN, "America/New_York")).toBeNaN();
      expect(minute(NaN, "Asia/Seoul")).toBeNaN();
      expect(second(NaN, "Asia/Seoul")).toBeNaN();
      expect(weekofyear(NaN, "Asia/Seoul")).toBeNaN();
    });
  });
});

// syminfo.ticker(symbol)(신규, C430) — 호출형(1-인자). pine2py에 대응 구현이 전혀 없어(C429 확인)
// 오라클 검증 불가 — TV 통설(TV 미검증(가설)) 기반 hand-verified: "EXCHANGE:TICKER" 형식에서
// 콜론 뒤 TICKER 부분만 추출, 콜론 없으면 그대로 반환.
describe("syminfo.ticker(symbol)", () => {
  it("extracts the ticker part after the first colon", () => {
    expect(syminfoTicker("NASDAQ:AAPL")).toBe("AAPL");
    expect(syminfoTicker("BINANCE:BTCUSDT")).toBe("BTCUSDT");
  });

  it("returns the symbol as-is when it has no colon", () => {
    expect(syminfoTicker("NIFTY")).toBe("NIFTY");
  });

  it("splits on the first colon only, keeping any remaining colons in the result (e.g. futures continuous contract IDs)", () => {
    expect(syminfoTicker("CME:ES1!:USD")).toBe("ES1!:USD");
  });

  it("treats a leading colon as an empty exchange prefix, returning the rest of the string", () => {
    expect(syminfoTicker(":AAPL")).toBe("AAPL");
  });

  it("returns an empty string unchanged (no colon to split on)", () => {
    expect(syminfoTicker("")).toBe("");
  });

  it("propagates na (null) straight through, matching the GOAL.md string-na=null convention", () => {
    expect(syminfoTicker(null)).toBe(null);
  });
});

// C730: str.tostring 숫자 패턴 + 문자 접미사 포맷('###M'류) — wild auto-HTF 관용구가
// tf 문자열("8M"/"8W"/"8D")을 만드는 형태. pine2py는 접미사를 버리고 "8"만 내지만(#/0+. 판별 →
// toFixed) 그 값으로는 관용구가 TV에서 tf로 기능할 수 없어 "패턴 밖 문자는 리터럴 보존"을 채택
// (TV 미검증 가설, DIVERGENCES #220). 기존 포맷('#.##'/'integer'/무포맷)은 바이트 불변.
describe("rt.tostring digit-pattern + letter-suffix format (C730, '###M' auto-HTF idiom)", () => {
  it("preserves a single-letter suffix after the digit pattern", () => {
    expect(tostring(8, "###M")).toBe("8M");
    expect(tostring(8, "###W")).toBe("8W");
    expect(tostring(8, "###D")).toBe("8D");
  });

  it("preserves a multi-letter suffix and works with short patterns", () => {
    expect(tostring(24, "#h")).toBe("24h");
    expect(tostring(3, "##Mo")).toBe("3Mo");
  });

  it("rounds like the sibling '#' branch (toFixed(0)) before appending the suffix", () => {
    expect(tostring(8.4, "###M")).toBe("8M");
    expect(tostring(8.5, "###M")).toBe("9M");
  });

  it("keeps the pure-digit pattern ('####') byte-identical to the pre-C730 branch", () => {
    expect(tostring(8, "####")).toBe("8");
    expect(tostring(8.7, "####")).toBe("9");
  });

  it("keeps decimal patterns ('#.##') on the existing branch — suffix regex requires no dot", () => {
    expect(tostring(1234.5678, "#.##")).toBe("1234.57");
  });

  it("keeps named formats and the no-format default branch unchanged", () => {
    expect(tostring(5, "integer")).toBe("5");
    expect(tostring(5.25)).toBe("5.25");
    expect(tostring(NaN, "###M")).toBe("NaN");
  });
});
