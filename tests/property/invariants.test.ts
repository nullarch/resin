// Metamorphic invariants over seeded random scripts built from the ta.* pool of TA_REGISTRY.
//
// Every block here is "self-consistency": resin against itself, one script run under two related
// conditions. Nothing says the values are right; each property says they cannot depend on what it
// must not depend on:
//   a. PREFIX INVARIANCE  - a bar's value cannot depend on later bars (no lookahead);
//   b. DETERMINISM        - same input, same bits, across runs, processes-in-one-process, fresh Contexts;
//   c. FORMATTING         - CRLF, blank lines, trailing spaces, comments, tabs and a BOM are not code;
//   d. POWER-OF-TWO SCALE - multiplying OHLC by 2^k multiplies a homogeneous function's value by
//                           2^(k * degree), bit for bit (scaling by 2^k commutes with IEEE rounding);
//   e. SHIFT              - close + c moves level-type functions by c and leaves difference-type ones;
//   f. LITERAL vs SERIES LENGTH - resin has a fixed-length and a *VarLen machine for every
//                           seriesLengthOk function; f(x, 5) and f(x, 5 + bar_index * 0) must agree
//                           (clean and na-gap data). ta.roc does not on na gaps: a suspected defect,
//                           an it.fails with a minimal repro;
//   g. CALL-SITE CONTEXT  - the same call inside a user-defined function, an always-true if block or a
//                           one-iteration loop gives the same bits as at top level (state slots are
//                           wired differently in each);
//   h. DELAY COMMUTES     - f(x[1]) == f(x)[1] for functions that read only their source's history.
//
// THE GENERATOR (seeded, mulberry32; `case ${seed}` identifies a script, and every failure prints the
// seed, the script text and the plot title that differs):
//   * the POOL is hand-written below, one argument template per TA_REGISTRY entry it covers (the
//     registry only knows argument COUNTS). Every pooled and every skipped name is asserted to exist
//     in TA_REGISTRY; registry keys nobody has classified are reported (RESIN_PROP_REPORT=1) and in
//     tests/property/README.md, not failed, so a new registry entry cannot turn this file red;
//   * a case is 1..3 calls, each `vK = <call>` (or a tuple destructure) at top level, never inside
//     an and/or right-hand side, ternary branch or elif condition (those positions are forbidden for
//     stateful calls); a source expression from a fixed list (sometimes an earlier call's result),
//     a literal length or, where the registry marks `seriesLengthOk`, a series length such as
//     `bar_index % 5 + 2` (those entry points also receive the bar count, the likeliest place for N
//     and N+K runs to differ); `//@version=5` for 70% of cases and 6 for 30%; a `var` accumulator
//     with an `if` block in some, so the script has an indented block for the formatting transforms;
//   * the cases rotate through the pool (case i starts at entry 3i) so RESIN_PROP_RUNS=1 already
//     covers every pooled function, and every generated script is asserted to transpile (a dropped
//     transpile error would hide coverage).
//
// LEGITIMATELY VARYING with the number of bars, hence excluded from (a): barstate.islast,
// last_bar_index, last_bar_time, timenow, request.security (and negative plot offsets, a render-time
// shift). A canary below confirms (a) does detect a script that reads the last bar.
//
// RESIN_PROP_RUNS multiplies the number of generated cases (seed = base + i).

import { afterAll, describe, expect, it } from "vitest";
import { TA_REGISTRY } from "../../src/transpiler/analyzer";
import {
  EPS,
  PROP_RUNS,
  compileScript,
  firstBitDiff,
  flushReport,
  head,
  makeBars,
  mulberry32,
  propSeeds,
  reportRow,
  runScript,
  scaleBars,
  sliceBars,
  streamScript,
  withNanClose,
  type Bars,
  type Out,
} from "../helpers/prop_util";
import { genStrategy } from "../helpers/prop_strategy";

// ---------------------------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------------------------

type Rng = () => number;
const ri = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

interface Entry {
  /** TA_REGISTRY key this entry exercises. */
  name: string;
  out: "value" | "flag" | "tuple";
  arity?: number;
  /** The call text for source expression `s` and length expression `L` (a literal or a series int). */
  call: (s: string, L: string, r: Rng) => string;
  /** The registry marks the length as allowed to be a series (seriesLengthOk). */
  varLen?: boolean;
  /** Reads the volume channel in addition to its source (so a volume-free scale claim still holds). */
  usesVolume?: boolean;
  /** Homogeneity degree per output under OHLC * 2^k (volume unscaled); undefined = no claim. */
  degrees?: number[];
  /** Why that degree, in one line. */
  why?: string;
  /** Under close + c: "shifts" moves with c, "invariant" does not (only for calls of the form f(close, L)). */
  shift?: "shifts" | "invariant";
}

const sw = (name: string, call: Entry["call"], extra: Partial<Entry> = {}): Entry => ({ name, out: "value", call, ...extra });
const flag = (name: string, call: Entry["call"], extra: Partial<Entry> = {}): Entry => ({ name, out: "flag", call, ...extra });
const tup = (name: string, arity: number, call: Entry["call"], extra: Partial<Entry> = {}): Entry => ({ name, out: "tuple", arity, call, ...extra });

const MA = "level: a weighted average of the source, scales with it";
const RATIO = "ratio of two quantities of the same degree: degree 0";

const POOL: Entry[] = [
  sw("sma", (s, L) => `ta.sma(${s}, ${L})`, { varLen: true, degrees: [1], why: MA, shift: "shifts" }),
  sw("ema", (s, L) => `ta.ema(${s}, ${L})`, { degrees: [1], why: MA, shift: "shifts" }),
  sw("rma", (s, L) => `ta.rma(${s}, ${L})`, { degrees: [1], why: MA, shift: "shifts" }),
  sw("wma", (s, L) => `ta.wma(${s}, ${L})`, { varLen: true, degrees: [1], why: MA, shift: "shifts" }),
  sw("hma", (s, L) => `ta.hma(${s}, ${L})`, { degrees: [1], why: MA }),
  sw("dema", (s, L) => `ta.dema(${s}, ${L})`, { degrees: [1], why: MA }),
  sw("alma", (s, L) => `ta.alma(${s}, ${L}, 0.85, 6)`, { degrees: [1], why: "weights depend on the length only" }),
  sw("linreg", (s, L) => `ta.linreg(${s}, ${L}, 0)`, { varLen: true, degrees: [1], why: "least-squares line value: linear in the source" }),
  sw("vwma", (s, L) => `ta.vwma(${s}, ${L})`, { varLen: true, usesVolume: true, degrees: [1], why: "sma(s * volume) / sma(volume), volume unscaled" }),
  sw("swma", (s) => `ta.swma(${s})`, { degrees: [1], why: MA }),
  sw("fixnan", (s) => `fixnan(${s})`, { degrees: [1], why: "returns a source value" }),
  sw("rsi", (s, L) => `ta.rsi(${s}, ${L})`, { degrees: [0], why: RATIO + " (gains / losses); the 1e-10 saturation never binds on these data", shift: "invariant" }),
  sw("cmo", (s, L) => `ta.cmo(${s}, ${L})`, { varLen: true, degrees: [0], why: RATIO }),
  sw("cci", (s, L) => `ta.cci(${s}, ${L})`, { varLen: true, degrees: [0], why: "(x - mean) / (0.015 * mean deviation): ratio" }),
  sw("change", (s, L, r) => (r() < 0.2 ? `ta.change(${s})` : `ta.change(${s}, ${L})`), { varLen: true, degrees: [1], why: "difference of two source values", shift: "invariant" }),
  sw("mom", (s, L) => `ta.mom(${s}, ${L})`, { varLen: true, degrees: [1], why: "difference of two source values", shift: "invariant" }),
  sw("roc", (s, L) => `ta.roc(${s}, ${L})`, { varLen: true, degrees: [0], why: "100 * (x - x[n]) / x[n]: ratio" }),
  sw("variance", (s, L) => `ta.variance(${s}, ${L})`, { varLen: true, degrees: [2], why: "second moment: scales with the square", shift: "invariant" }),
  sw("stdev", (s, L) => `ta.stdev(${s}, ${L})`, { varLen: true, degrees: [1], why: "sqrt of the variance: sqrt(2^(2k) v) = 2^k sqrt(v) exactly", shift: "invariant" }),
  sw("dev", (s, L) => `ta.dev(${s}, ${L})`, { varLen: true, degrees: [1], why: "mean absolute deviation", shift: "invariant" }),
  sw("median", (s, L) => `ta.median(${s}, ${L})`, { varLen: true, degrees: [1], why: "order statistic of the source", shift: "shifts" }),
  sw("mode", (s, L) => `ta.mode(${s}, ${L})`, { varLen: true, degrees: [1], why: "returns a source value" }),
  sw("percentrank", (s, L) => `ta.percentrank(${s}, ${L})`, { varLen: true, degrees: [0], why: "a rank share; comparisons are order-based" }),
  sw("highest", (s, L) => `ta.highest(${s}, ${L})`, { varLen: true, degrees: [1], why: "returns a source value", shift: "shifts" }),
  sw("lowest", (s, L) => `ta.lowest(${s}, ${L})`, { varLen: true, degrees: [1], why: "returns a source value", shift: "shifts" }),
  sw("highestbars", (s, L) => `ta.highestbars(${s}, ${L})`, { varLen: true, degrees: [0], why: "an offset in bars" }),
  sw("lowestbars", (s, L) => `ta.lowestbars(${s}, ${L})`, { varLen: true, degrees: [0], why: "an offset in bars" }),
  sw("range", (s, L) => `ta.range(${s}, ${L})`, { varLen: true, degrees: [1], why: "highest - lowest" }),
  sw("cum", (s) => `ta.cum(${s})`, { degrees: [1], why: "running sum of the source" }),
  sw("max", (s) => `ta.max(${s})`, { degrees: [1], why: "all-time high of the source" }),
  sw("min", (s) => `ta.min(${s})`, { degrees: [1], why: "all-time low of the source" }),
  sw("sum", (s, L) => `math.sum(${s}, ${L})`, { varLen: true, degrees: [1], why: "rolling sum of the source" }),
  sw("valuewhen", (s) => `ta.valuewhen(${s} > ${s}[1], ${s}, 0)`, { degrees: [1], why: "returns a source value" }),
  sw("barssince", (s, L) => `ta.barssince(${s} > ta.sma(${s}, ${L}))`, { degrees: [0], why: "a bar count of a scale-free comparison" }),
  flag("crossover", (s, L) => `ta.crossover(${s}, ta.sma(${s}, ${L}))`, { degrees: [0], why: "raw comparison of two scaled values" }),
  flag("crossunder", (s, L) => `ta.crossunder(${s}, ta.sma(${s}, ${L}))`, { degrees: [0], why: "raw comparison of two scaled values" }),
  // ta.cross, ta.rising, ta.falling compare with an ABSOLUTE 1e-10 tolerance: no scale claim.
  flag("cross", (s, L) => `ta.cross(${s}, ta.sma(${s}, ${L}))`),
  flag("rising", (s, L) => `ta.rising(${s}, ${L})`),
  flag("falling", (s, L) => `ta.falling(${s}, ${L})`),
  sw("stoch", (s, L) => `ta.stoch(${s}, high, low, ${L})`, { varLen: true, degrees: [0], why: RATIO }),
  sw("wpr", (_s, L) => `ta.wpr(${L})`, { varLen: true, degrees: [0], why: RATIO }),
  sw("tr", () => `ta.tr`, { degrees: [1], why: "range of prices" }),
  sw("atr", (_s, L) => `ta.atr(${L})`, { degrees: [1], why: "rma of the true range" }),
  // ta.mfi carries NO scale claim: it zeroes a side whose rolling money-flow sum is within the ABSOLUTE
  // 1e-10 (ta.ts mfi), and those sums keep rounding dust of a few 1e-10 that the threshold cuts
  // differently once prices are scaled (found at RESIN_PROP_RUNS=20: k=-5, and k=3 once, 100 vs
  // 99.99999999999999). The same dust can leave a lower side of -2e-10 that is not zeroed, which is
  // why ta.mfi is occasionally 100.00000000000001 (documented dust, ta.ts mfi comment).
  sw("mfi", (s, L) => `ta.mfi(${s}, ${L})`, { varLen: true, usesVolume: true }),
  sw("cog", (s, L) => `ta.cog(${s}, ${L})`, { degrees: [0], why: RATIO + " (weighted over plain sum)" }),
  sw("correlation", (s, L, r) => `ta.correlation(${s}, ${r() < 0.5 ? "volume" : "ta.sma(" + s + ", 2)"}, ${L})`, { varLen: true, usesVolume: true, degrees: [0], why: "Pearson's r is invariant under scaling" }),
  sw("tsi", (s, L, r) => `ta.tsi(${s}, ${ri(r, 2, 5)}, ${ri(r, 6, 10)})`, { degrees: [0], why: RATIO }),
  sw("rci", (s, L) => `ta.rci(${s}, ${L})`, { degrees: [0], why: "rank correlation" }),
  sw("percentile_nearest_rank", (s, L) => `ta.percentile_nearest_rank(${s}, ${L}, 50)`, { varLen: true, degrees: [1], why: "returns a source value" }),
  sw("percentile_linear_interpolation", (s, L) => `ta.percentile_linear_interpolation(${s}, ${L}, 50)`, { varLen: true, degrees: [1], why: "interpolates source values with data-independent weights" }),
  sw("bbw", (s, L) => `ta.bbw(${s}, ${L}, 2.0)`, { varLen: true, degrees: [0], why: RATIO }),
  sw("kcw", (s, L) => `ta.kcw(${s}, ${L}, 1.5)`, { degrees: [0], why: RATIO }),
  sw("pivothigh", (s, L, r) => `ta.pivothigh(${s}, ${ri(r, 1, 4)}, ${ri(r, 1, 4)})`, { degrees: [1], why: "returns a source value" }),
  sw("pivotlow", (s, L, r) => `ta.pivotlow(${s}, ${ri(r, 1, 4)}, ${ri(r, 1, 4)})`, { degrees: [1], why: "returns a source value" }),
  sw("obv", () => `ta.obv`, { usesVolume: true, degrees: [0], why: "sign of the change times volume" }),
  sw("accdist", () => `ta.accdist`, { usesVolume: true, degrees: [0], why: "money-flow ratio times volume" }),
  sw("pvt", () => `ta.pvt`, { usesVolume: true, degrees: [0], why: "relative change times volume" }),
  sw("wad", () => `ta.wad`, { degrees: [1], why: "cumulative sum of price differences" }),
  sw("nvi", () => `ta.nvi`, { usesVolume: true, degrees: [0], why: "index driven by relative price change" }),
  sw("pvi", () => `ta.pvi`, { usesVolume: true, degrees: [0], why: "index driven by relative price change" }),
  sw("wvad", () => `ta.wvad`, { usesVolume: true, degrees: [0], why: "(close - open) / (high - low) * volume" }),
  sw("iii", () => `ta.iii`, { usesVolume: true, degrees: [0], why: "(2c - h - l) / ((h - l) * volume)" }),
  sw("ao", () => `ta.ao()`, { degrees: [1], why: "difference of two averages" }),
  sw("vwap", (s) => `ta.vwap(${s})`, { usesVolume: true, degrees: [1], why: "volume-weighted average of the source" }),
  sw("sar", () => `ta.sar(0.02, 0.02, 0.2)`, { degrees: [1], why: "a price level; the acceleration factors are dimensionless" }),
  sw("random", () => `math.random(0.0, 1.0, 42)`, { degrees: [0], why: "does not read the data" }),
  flag("timeframe_change", () => `timeframe.change("D")`, { degrees: [0], why: "does not read prices" }),
  tup("macd", 3, (s, _L, r) => `ta.macd(${s}, ${ri(r, 3, 6)}, ${ri(r, 8, 13)}, ${ri(r, 3, 5)})`, { degrees: [1, 1, 1], why: "differences of averages" }),
  tup("bb", 3, (s, L) => `ta.bb(${s}, ${L}, 2.0)`, { varLen: true, degrees: [1, 1, 1], why: "average +- k * stdev" }),
  tup("kc", 3, (s, L) => `ta.kc(${s}, ${L}, 1.5)`, { degrees: [1, 1, 1], why: "average +- k * atr" }),
  tup("supertrend", 2, (_s, L, r) => `ta.supertrend(${(1 + r() * 3).toFixed(1)}, ${ri(r, 2, 10)})`, { degrees: [1, 0], why: "a price level and a direction" }),
  tup("dmi", 3, (_s, _L, r) => `ta.dmi(${ri(r, 2, 8)}, ${ri(r, 2, 8)})`, { degrees: [0, 0, 0], why: RATIO + " (di+, di-, adx)" }),
  tup("vwap", 3, (s, _L, r) => `ta.vwap(${s}, bar_index % ${ri(r, 8, 30)} == 0, 1.5)`, { usesVolume: true, degrees: [1, 1, 1], why: "vwap +- k * volume-weighted deviation" }),
];

/** Registry entries deliberately not pooled, with the reason. */
const SKIPPED: Array<{ name: string; reason: string }> = [
  { name: "pivot_point_levels", reason: "returns an array handle consumed through array.*, not a plottable scalar series (needs a calendar-anchored `timeframe.change` anchor and array reads: exotic arguments)" },
];

const POOL_NAMES = new Set(POOL.map((e) => e.name));

const SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4", "close - open", "nz(close[1], close)", "ta.sma(close, 3)"];
const PRICE_SOURCES = ["close", "open", "high", "low", "hl2", "hlc3", "ohlc4"];

// ---------------------------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------------------------

interface Gen {
  seed: number;
  source: string;
  version: 5 | 6;
  /** plot title -> the call it plots (for failure messages) */
  titles: Map<string, string>;
  /** plot title -> the TA_REGISTRY name behind it */
  titleEntry: Map<string, string>;
  names: string[];
}

function genCase(seed: number, pool: Entry[], o: { sources?: string[]; volume?: boolean; literalLengths?: boolean; calls?: number; entries?: Entry[] } = {}): Gen {
  const r = mulberry32(seed * 2654435761 + 12345);
  const version: 5 | 6 = r() < 0.7 ? 5 : 6;
  const srcList = o.sources ?? SOURCES;
  const nCalls = o.calls ?? 3;
  const lines = [`//@version=${version}`, 'indicator("prop")'];
  const titles = new Map<string, string>();
  const titleEntry = new Map<string, string>();
  const names: string[] = [];
  const vars: string[] = [];
  let plotCount = 0;
  let currentEntry = "";
  const addPlot = (expr: string, what: string): void => {
    const t = `p${plotCount++}`;
    titles.set(t, what);
    titleEntry.set(t, currentEntry);
    lines.push(`plot(${expr}, "${t}")`);
  };
  for (let k = 0; k < nCalls; k++) {
    // rotate through the pool (case i starts at entry 3i), or take the explicit list as it is
    const entry = o.entries !== undefined ? o.entries[k % o.entries.length]! : pool[(seed * 3 + k) % pool.length]!;
    let s = srcList[ri(r, 0, srcList.length - 1)]!;
    if (vars.length > 0 && r() < 0.2 && o.sources === undefined) s = vars[ri(r, 0, vars.length - 1)]!;
    if (o.volume && r() < 0.1) s = "volume";
    const L = entry.varLen === true && o.literalLengths !== true && r() < 0.35 ? (r() < 0.5 ? `bar_index % ${ri(r, 3, 6)} + 2` : `math.max(1, ${ri(r, 2, 5)} + bar_index % 4)`) : String(ri(r, 2, 12));
    const call = entry.call(s, L, r);
    names.push(entry.name);
    currentEntry = entry.name;
    if (entry.out === "tuple") {
      const vs = Array.from({ length: entry.arity! }, (_, j) => `t${k}_${j}`);
      lines.push(`[${vs.join(", ")}] = ${call}`);
      vs.forEach((v, j) => addPlot(v, `${call} [${j}]`));
    } else if (entry.out === "flag") {
      lines.push(`v${k} = (${call}) ? 1 : 0`);
      vars.push(`v${k}`);
      addPlot(`v${k}`, call);
    } else {
      lines.push(`v${k} = ${call}`);
      vars.push(`v${k}`);
      addPlot(`v${k}`, call);
    }
  }
  currentEntry = "(script glue)";
  if (r() < 0.4 && vars.length > 0) {
    // a block, so the formatting transforms have indentation to work with
    lines.push("var float acc = 0.0", `if not na(${vars[0]})`, `    acc := acc + ${vars[0]}`, "else", "    acc := acc");
    addPlot("acc", "var accumulator");
  }
  if (r() < 0.3 && vars.length > 1) addPlot(`nz(${vars[0]}[1]) - ${vars[1]}`, "glue: nz(v0[1]) - v1");
  return { seed, source: lines.join("\n"), version, titles, titleEntry, names };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const PREFIX_N = [100, 123, 127, 150]; // 123 cuts inside the 120..126 na burst of the gap variant
const BAR_BUDGET = 190;

function dataFor(seed: number, nan: boolean, bars = BAR_BUDGET): Bars {
  const d = makeBars(bars, seed);
  return nan ? withNanClose(d, seed) : d;
}

/** Enough bars for the na burst at 120..126 and a stretch after it; the context properties need no more. */
const SHORT_BARS = 135;

function diffOuts(a: Out, b: Out, n: number, g: Gen, label: string): string[] {
  const out: string[] = [];
  for (const t of a.titles) {
    const bv = b.plots[t];
    if (bv === undefined) {
      out.push(`${label}: plot ${t} missing`);
      continue;
    }
    const i = firstBitDiff(a.plots[t]!, bv, n);
    let finite = 0;
    for (let j = 0; j < n; j++) if (Number.isFinite(a.plots[t]![j]!)) finite++;
    bump(finiteByEntry, g.titleEntry.get(t) ?? "?", finite);
    if (i >= 0) out.push(`${label}: plot ${t} (${g.titles.get(t)}) differs first at bar ${i}: ${a.plots[t]![i]} vs ${bv[i]}`);
  }
  return out;
}

const finiteByEntry = new Map<string, number>();
const bump = (m: Map<string, number>, k: string, by: number): void => void m.set(k, (m.get(k) ?? 0) + by);

const finiteScaleByEntry = new Map<string, number>();
const ctr = { cases: 0, prefixBars: 0, entriesCovered: new Set<string>(), formatVariants: 0, scaleChecks: 0, shiftChecks: 0, stratPrefix: 0 };

const CASES = propSeeds(1, 26);
const generated: Gen[] = CASES.map((s) => genCase(s, POOL, { volume: true }));

// ---------------------------------------------------------------------------------------------
// The pool and the generator themselves
// ---------------------------------------------------------------------------------------------

describe("self-consistency: pool and generator", () => {
  it("every pooled and every skipped name exists in TA_REGISTRY (a rename must be noticed here)", () => {
    const registry = TA_REGISTRY as Record<string, unknown>;
    for (const e of POOL) expect(registry[e.name], `pooled ${e.name}`).toBeDefined();
    for (const s of SKIPPED) expect(registry[s.name], `skipped ${s.name}`).toBeDefined();
    // tuple arities and the registry agree
    for (const e of POOL) if (e.out === "tuple" && e.name !== "vwap") expect(TA_REGISTRY[e.name]!.returnArity, e.name).toBe(e.arity);
    expect(TA_REGISTRY["vwap"]!.returnArityByArgCount).toEqual({ 3: 3 });
    // series lengths are used exactly where the registry allows them
    for (const e of POOL) if (e.varLen === true) expect(TA_REGISTRY[e.name]!.seriesLengthOk, `${e.name} varLen`).toBe(true);
  });

  it("every generated script transpiles (no case is silently dropped) and the pool is covered at RUNS=1", () => {
    for (const g of generated) {
      expect(() => compileScript(g.source), `case ${g.seed}`).not.toThrow();
      ctr.cases++;
      g.names.forEach((n) => ctr.entriesCovered.add(n));
    }
    // cover every pooled name at least once (some are driven only through their `vwap` 3-arg tuple twin)
    const missing = [...POOL_NAMES].filter((n) => !ctr.entriesCovered.has(n));
    expect(missing, `pooled functions never generated: ${missing.join(", ")}`).toEqual([]);
  });

  it("each pool entry runs with a literal and (where allowed) a series length, in v5 and v6", () => {
    // Fast path: all entries of one form in a single script; only if that fails are the entries
    // tried one by one to name the culprit.
    const d = makeBars(60, 7);
    const one = (e: Entry, L: string, i: number): string[] => {
      const call = e.call("close", L, mulberry32(3));
      if (e.out === "tuple") {
        const vs = Array.from({ length: e.arity! }, (_, j) => `u${i}_${j}`);
        return [`[${vs.join(", ")}] = ${call}`, ...vs.map((v, j) => `plot(${v}, "q${i}_${j}")`)];
      }
      return [`u${i} = ${e.out === "flag" ? `(${call}) ? 1 : 0` : call}`, `plot(u${i}, "q${i}")`];
    };
    const failures: string[] = [];
    for (const version of [5, 6]) {
      for (const form of ["literal", "series"] as const) {
        const entries = POOL.filter((e) => form === "literal" || e.varLen === true);
        const L = form === "literal" ? "6" : "bar_index % 4 + 2";
        const src = [`//@version=${version}`, 'indicator("one")', ...entries.flatMap((e, i) => one(e, L, i))].join("\n");
        try {
          runScript(src, d);
        } catch {
          for (const [i, e] of entries.entries()) {
            try {
              runScript([`//@version=${version}`, 'indicator("one")', ...one(e, L, i)].join("\n"), d);
            } catch (err) {
              failures.push(`${e.name} v${version} ${form} length: ${(err as Error).message.split("\n")[0]}`);
            }
          }
        }
      }
    }
    expect(failures, head(failures)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (a) prefix invariance
// ---------------------------------------------------------------------------------------------

describe("self-consistency: (a) prefix invariance - bar i does not depend on bars after i", () => {
  it("canary: a script that reads the last bar IS detected as prefix-dependent", () => {
    const src = ["//@version=5", 'indicator("canary")', 'plot(barstate.islast ? 1 : 0, "last")', 'plot(last_bar_index, "lbi")'].join("\n");
    const d = makeBars(40, 3);
    const full = runScript(src, d);
    const pre = runScript(src, sliceBars(d, 30));
    expect(firstBitDiff(pre.plots["last"]!, full.plots["last"]!, 30)).toBe(29);
    expect(firstBitDiff(pre.plots["lbi"]!, full.plots["lbi"]!, 30)).toBe(0);
  });

  it("indicator plots: N bars and N + K bars agree on the first N (clean and na-gap data, cuts inside and after the na burst)", () => {
    const failures: string[] = [];
    for (const [idx, g] of generated.entries()) {
      for (const nan of [false, true]) {
        const total = dataFor(g.seed, nan);
        const n = PREFIX_N[(idx + (nan ? 1 : 0)) % PREFIX_N.length]!;
        const full = runScript(g.source, total);
        const pre = runScript(g.source, sliceBars(total, n));
        failures.push(...diffOuts(pre, full, n, g, `case ${g.seed} (v${g.version}, ${nan ? "na gaps" : "clean"}, N=${n}, K=${BAR_BUDGET - n})`).map((m) => `${m}\n    ${g.source.split("\n").join("\n    ")}`));
        ctr.prefixBars += n;
      }
    }
    expect(failures, head(failures, 4)).toEqual([]);
  });

  it("the prefix cases are not vacuous: every pooled function plotted numbers, and series lengths were generated", () => {
    // (runs after the indicator test above filled the counters)
    const sparse = [...POOL_NAMES].filter((n) => (finiteByEntry.get(n) ?? 0) < 20);
    expect(sparse, `pooled functions whose plots were (almost) all na in the prefix test: ${sparse.join(", ")}`).toEqual([]);
    const withSeriesLength = generated.filter((g) => /bar_index % \d+ \+ 2|math\.max\(1,/.test(g.source)).length;
    expect(withSeriesLength, "cases with a series length").toBeGreaterThanOrEqual(3);
    expect(generated.some((g) => g.version === 6) && generated.some((g) => g.version === 5)).toBe(true);
  });

  it("strategies: per-bar account plots of the first N bars agree, and so do the closed trades completed before bar N", () => {
    const failures: string[] = [];
    for (const seed of propSeeds(900, 6)) {
      const c = genStrategy(seed, { fillModes: true });
      const total = makeBars(BAR_BUDGET + 40, seed);
      const n = 120 + (seed % 5) * 7;
      const tr = compileScript(c.source, c.options);
      const full = streamScript(tr, total);
      const pre = streamScript(tr, sliceBars(total, n));
      for (const t of pre.out.titles) {
        const i = firstBitDiff(pre.out.plots[t]!, full.out.plots[t]!, n);
        if (i >= 0) failures.push(`strategy seed ${seed}: plot ${t} differs first at bar ${i}: ${pre.out.plots[t]![i]} vs ${full.out.plots[t]![i]}\n  ${c.desc}`);
      }
      // trades completed before bar N (positions still open at the end of the shorter data differ legitimately)
      type Rec = { exitBarIndex: number };
      const preRecs = pre.ctx.strategy.closedTradeRecords as unknown as Rec[];
      const fullRecs = (full.ctx.strategy.closedTradeRecords as unknown as Rec[]).filter((t) => t.exitBarIndex < n);
      if (JSON.stringify(preRecs) !== JSON.stringify(fullRecs)) failures.push(`strategy seed ${seed}: closed trades before bar ${n} differ (${preRecs.length} vs ${fullRecs.length})\n  ${c.desc}`);
      ctr.stratPrefix++;
    }
    expect(failures, head(failures, 4)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (b) determinism
// ---------------------------------------------------------------------------------------------

describe("self-consistency: (b) determinism", () => {
  it("two runs, a re-transpile, and a fresh Context driven by hand give bit-identical plots", () => {
    const failures: string[] = [];
    for (const g of generated) {
      const data = dataFor(g.seed, g.seed % 2 === 0);
      const a = runScript(g.source, data);
      const b = runScript(g.source, data);
      failures.push(...diffOuts(a, b, data.close.length, g, `case ${g.seed} second run`));
      const tr = compileScript(g.source);
      const again = compileScript(g.source + "\n"); // a different cache key: transpiled afresh
      if (again.code !== tr.code) failures.push(`case ${g.seed}: transpile output differs for the same source`);
      const fresh = streamScript(tr, data).out;
      failures.push(...diffOuts(a, fresh, data.close.length, g, `case ${g.seed} fresh Context`));
      // var-slot snapshots of the one-shot run, compared as text (NaN prints as null on both sides)
      if (JSON.stringify(a.res.bars) !== JSON.stringify(b.res.bars)) failures.push(`case ${g.seed}: var snapshots differ between runs`);
    }
    expect(failures, head(failures, 4)).toEqual([]);
  });

  it("strategies: two runs and a fresh Context give identical plots and identical closed trades", () => {
    const failures: string[] = [];
    for (const seed of propSeeds(950, 4)) {
      const c = genStrategy(seed, { fillModes: true });
      const data = makeBars(200, seed);
      const tr = compileScript(c.source, c.options);
      const a = streamScript(tr, data);
      const b = streamScript(tr, data);
      const viaRun = runScript(c.source, data, c.options);
      for (const t of a.out.titles) {
        if (firstBitDiff(a.out.plots[t]!, b.out.plots[t]!) >= 0) failures.push(`strategy seed ${seed}: plot ${t} differs between two Contexts`);
        if (firstBitDiff(a.out.plots[t]!, viaRun.plots[t]!) >= 0) failures.push(`strategy seed ${seed}: plot ${t} differs between run() and a hand-driven Context`);
      }
      if (JSON.stringify(a.ctx.strategy.closedTradeRecords) !== JSON.stringify(b.ctx.strategy.closedTradeRecords)) failures.push(`strategy seed ${seed}: closed trades differ`);
    }
    expect(failures, head(failures, 4)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (c) formatting invariance
// ---------------------------------------------------------------------------------------------

/** Transforms that must not change what a script computes. Statement indentation is never altered
 *  except tabs-for-four-spaces, a valid Pine spelling of one indent level. */
const FORMATS: Array<[string, (src: string) => string]> = [
  ["crlf", (s) => s.replace(/\n/g, "\r\n")],
  ["blank lines", (s) => s.split("\n").join("\n\n")],
  ["trailing spaces", (s) => s.split("\n").map((l, i) => (i === 0 ? l : l + "   ")).join("\n")],
  ["end-of-line comments", (s) => s.split("\n").map((l, i) => (i === 0 ? l : l + "  // note")).join("\n")],
  ["own-line comments at the statement's indentation", (s) => s.split("\n").flatMap((l, i) => (i === 0 ? [l] : [`${/^\s*/.exec(l)![0]}// a comment`, l])).join("\n")],
  ["tabs for four spaces", (s) => s.replace(/^ {4}/gm, "\t")],
  ["byte order mark", (s) => "﻿" + s],
  ["everything at once", (s) => "﻿" + s.split("\n").flatMap((l, i) => (i === 0 ? [l] : ["", `${/^\s*/.exec(l)![0]}// c`, l.replace(/^ {4}/, "\t") + "  // n  "])).join("\r\n")],
];

describe("self-consistency: (c) formatting invariance", () => {
  const sample = generated.filter((_, i) => i % 3 === 0 || generated[i]!.source.includes("var float acc"));

  it("the transforms really change the text, and the sample has indented blocks for them to work on", () => {
    expect(sample.some((g) => g.source.includes("\n    acc :="))).toBe(true);
    for (const [name, fn] of FORMATS) expect(sample.some((g) => fn(g.source) !== g.source), name).toBe(true);
  });

  it("the //@version line still selects the version after CRLF, a BOM, trailing spaces or blank lines (5/2 is 2 in v5, 2.5 in v6)", () => {
    const failures: string[] = [];
    const d = makeBars(5, 1);
    for (const [version, want] of [[5, 2], [6, 2.5]] as const) {
      const base = [`//@version=${version}`, 'indicator("v")', 'plot(5 / 2, "q")'];
      const variants: Array<[string, string]> = [
        ["plain", base.join("\n")],
        ["crlf", base.join("\r\n")],
        ["bom", "\uFEFF" + base.join("\n")],
        ["bom+crlf", "\uFEFF" + base.join("\r\n")],
        ["trailing spaces on the directive", [`${base[0]}   `, base[1], base[2]].join("\n")],
        ["blank line after the directive", [base[0], "", base[1], base[2]].join("\n")],
        ["comment line after the directive", [base[0], "// note", base[1], base[2]].join("\n")],
      ];
      for (const [label, text] of variants) {
        try {
          const got = runScript(text, d).plots["q"]![0]!;
          if (got !== want) failures.push(`v${version} ${label}: 5 / 2 = ${got}, expected ${want}`);
        } catch (err) {
          failures.push(`v${version} ${label}: ${(err as Error).message.split("\n")[0]}`);
        }
      }
    }
    expect(failures, head(failures)).toEqual([]);
  });

  for (const [name, fn] of FORMATS) {
    it(`${name} does not change the plots`, () => {
      const failures: string[] = [];
      for (const g of sample) {
        const data = dataFor(g.seed, false);
        const base = runScript(g.source, data);
        const text = fn(g.source);
        let variant: Out;
        try {
          variant = runScript(text, data);
        } catch (err) {
          failures.push(`case ${g.seed}: the ${name} variant no longer compiles or runs: ${(err as Error).message.split("\n")[0]}\n    ${JSON.stringify(text.slice(0, 160))}`);
          continue;
        }
        failures.push(...diffOuts(base, variant, data.close.length, g, `case ${g.seed} (v${g.version})`));
        ctr.formatVariants++;
      }
      expect(failures, head(failures, 4)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// (d) power-of-two scale
// ---------------------------------------------------------------------------------------------

const scalable = POOL.filter((e) => e.degrees !== undefined);
const scaleCases = propSeeds(400, Math.ceil(scalable.length / 3)).map((seed, i) => {
  const entries = [0, 1, 2].map((k) => scalable[(i * 3 + k) % scalable.length]!);
  return { entries, gen: genCase(seed, scalable, { entries, sources: PRICE_SOURCES, calls: 3 }) };
});

describe("self-consistency: (d) power-of-two scale - OHLC * 2^k scales a homogeneous function by 2^(k * degree), bit for bit", () => {
  it("canary: the comparison is sensitive - a factor of 3 is NOT bit-exact for ta.sma, 2^3 is", () => {
    const src = ["//@version=5", 'indicator("c")', 'plot(ta.sma(close, 5), "q")'].join("\n");
    const d = makeBars(120, 5);
    const base = runScript(src, d).plots["q"]!;
    const exact = (f: number): number => {
      const s = runScript(src, scaleBars(d, f)).plots["q"]!;
      return base.filter((v, i) => !Object.is(v * f, s[i]!)).length;
    };
    expect(exact(8)).toBe(0);
    expect(exact(3)).toBeGreaterThan(0);
  });

  // Degrees are in the pool table with a one-line reason each. Absolute thresholds (the 1e-10
  // comparison tolerance of ta.cross / ta.rising / ta.falling, the 1e-10 saturation of ta.rsi) are
  // not scale-free: ta.cross/rising/falling carry no claim; ta.rsi carries one because on these data
  // its average gain and loss stay many orders of magnitude above 1e-10 for |k| <= 6.
  it("the claims hold for k in {-5, 3, 6} on every claimed pool function", () => {
    const failures: string[] = [];
    const d = makeBars(220, 77);
    for (const sc of scaleCases) {
      const g = sc.gen;
      // The scale claim is per output, so the plots are matched to the entries by position:
      // a case's plots are in call order; a tuple's outputs are consecutive.
      const degreeOf: number[] = sc.entries.flatMap((e) => e.degrees!);
      const base = runScript(g.source, d);
      // plots beyond the claimed ones (accumulator, glue) are not part of the claim
      for (const kexp of [-5, 3, 6]) {
        const scaled = runScript(g.source, scaleBars(d, 2 ** kexp));
        base.titles.slice(0, degreeOf.length).forEach((t, j) => {
          const factor = 2 ** (kexp * degreeOf[j]!);
          const b = base.plots[t]!;
          const s = scaled.plots[t]!;
          if (kexp === 3) bump(finiteScaleByEntry, g.titleEntry.get(t) ?? "?", b.filter(Number.isFinite).length);
          for (let i = 0; i < b.length; i++) {
            const want = b[i]! * factor;
            if (!Object.is(want, s[i]!)) {
              failures.push(`case ${g.seed} k=${kexp}: ${g.titles.get(t)} (degree ${degreeOf[j]}) bar ${i}: ${s[i]} vs ${b[i]} * 2^${kexp * degreeOf[j]!} = ${want}\n    ${g.source.split("\n").join("\n    ")}`);
              break;
            }
          }
          ctr.scaleChecks++;
        });
      }
    }
    expect(failures, head(failures, 4)).toEqual([]);
    const sparse = scalable.filter((e) => (finiteScaleByEntry.get(e.name) ?? 0) < 10).map((e) => e.name);
    expect(sparse, `claimed functions whose scaled plots were (almost) all na: ${sparse.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// (e) shift
// ---------------------------------------------------------------------------------------------

describe("self-consistency: (e) shift - close + c moves level functions by c and leaves difference functions alone", () => {
  const shifting = POOL.filter((e) => e.shift !== undefined);
  const K = 16;
  for (const c of [-20.5, 64, 250]) {
    it(`c = ${c}: ${shifting.map((e) => e.name).join(", ")}`, () => {
      const failures: string[] = [];
      const d = makeBars(190, 21);
      const shiftedBars: Bars = { ...d, close: d.close.map((v) => v + c) };
      const maxLevel = Math.max(...shiftedBars.close.map(Math.abs));
      for (const e of shifting) {
        // fixed lengths: 5 and 12, source close
        for (const L of ["5", "12"]) {
          const call = e.call("close", L, mulberry32(1));
          const src = ["//@version=5", 'indicator("shift")', `x = ${call}`, 'plot(x, "x")'].join("\n");
          const a = runScript(src, d).plots["x"]!;
          const b = runScript(src, shiftedBars).plots["x"]!;
          for (let i = 0; i < a.length; i++) {
            const base = a[i]!;
            const got = b[i]!;
            if (Number.isNaN(base) || Number.isNaN(got)) {
              if (!(Number.isNaN(base) && Number.isNaN(got))) failures.push(`${call} c=${c} bar ${i}: na mismatch ${base} vs ${got}`);
              continue;
            }
            let ok: boolean;
            if (e.name === "highest" || e.name === "lowest") {
              // fl(x + c) is monotone in x, so the extreme commutes with the shift exactly
              ok = Object.is(base + c, got);
            } else if (e.shift === "shifts") {
              ok = Math.abs(got - (base + c)) <= 1e-9 + K * EPS * maxLevel;
            } else if (e.name === "variance" || e.name === "stdev") {
              // moment form: error ~ K * EPS * level^2 on the variance (see reference_ta.test.ts)
              const dv = K * EPS * maxLevel * maxLevel;
              ok = e.name === "variance" ? Math.abs(got - base) <= 1e-9 * (1 + base) + dv : Math.abs(got - base) <= 1e-9 * (1 + base) + Math.min(Math.sqrt(dv), base > 0 ? dv / base : Infinity);
            } else {
              ok = Math.abs(got - base) <= 1e-9 * (1 + Math.abs(base)) + K * EPS * maxLevel * (e.name === "rsi" ? 100 : 1);
            }
            if (!ok) {
              failures.push(`${call} c=${c} bar ${i}: ${got} vs ${base}${e.shift === "shifts" ? " + c" : ""}`);
              break;
            }
          }
          ctr.shiftChecks++;
        }
      }
      expect(failures, head(failures)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// (f) a literal length and the same length as a series
// ---------------------------------------------------------------------------------------------

describe("self-consistency: (f) a literal length and the same value as a series (the fixed and the *VarLen machines are one function)", () => {
  // Resin keeps two implementations of every seriesLengthOk function: the fixed-length machine and a
  // *VarLen machine that reads the length on every call. TradingView evaluates one function for both
  // spellings, so `f(x, 5)` and `f(x, 5 + bar_index * 0)` must agree, on na gaps as well.
  const varLenEntries = POOL.filter((e) => e.varLen === true);
  const tol = (a: number): number => 1e-9 * (1 + Math.abs(a));
  const known: Record<string, string> = {
    // (none: roc is a finding, asserted by the it.fails below)
  };
  for (const e of varLenEntries) {
    const isRoc = e.name === "roc";
    const run1 = (): string[] => {
      const failures: string[] = [];
      for (const nan of [false, true]) {
        const d = dataFor(11, nan, SHORT_BARS);
        for (const L of [3, 9]) {
          const call = (len: string): string => e.call("close", len, mulberry32(2));
          const names = e.out === "tuple" ? Array.from({ length: e.arity! }, (_, j) => `o${j}`) : ["o"];
          const body = (len: string, tag: string): string[] => {
            const c = call(len);
            if (e.out === "tuple") return [`[${names.map((n) => tag + n).join(", ")}] = ${c}`, ...names.map((n, j) => `plot(${tag}${n}, "${tag}${j}")`)];
            return [`${tag}o = ${e.out === "flag" ? `(${c}) ? 1 : 0` : c}`, `plot(${tag}o, "${tag}0")`];
          };
          const src = ["//@version=5", 'indicator("f")', ...body(String(L), "a"), ...body(`${L} + bar_index * 0`, "b")].join("\n");
          const out = runScript(src, d);
          for (let j = 0; j < names.length; j++) {
            const a = out.plots[`a${j}`]!;
            const b = out.plots[`b${j}`]!;
            for (let i = 0; i < a.length; i++) {
              const x = a[i]!;
              const y = b[i]!;
              if (Number.isNaN(x) || Number.isNaN(y) ? !(Number.isNaN(x) && Number.isNaN(y)) : !(Math.abs(x - y) <= tol(x))) {
                failures.push(`ta.${e.name} length ${L} (${nan ? "na gaps" : "clean"}) bar ${i}: literal ${x} vs series ${y}\n    ${src.split("\n").slice(2).join("\n    ")}`);
                break;
              }
            }
          }
        }
      }
      return failures;
    };
    if (isRoc) {
      // Was an it.fails: rocVarLen took its numerator over the non-na bars only (ta.roc(close, 2) 18.18
      // on bar 3 of [10, 11, na, 13, 14, ...] against 27.27 for the series spelling). Fixed with
      // resin-harness dispute D12, settled for the manual's formula.
      it(`ta.${e.name}: literal and series length agree, na gaps included`, () => {
        expect(run1(), head(run1(), 2)).toEqual([]);
      });
    } else {
      it(`ta.${e.name}: literal and series length agree on clean and na-gap data${known[e.name] ?? ""}`, () => {
        const failures = run1();
        expect(failures, head(failures, 3)).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// (g) call-site context
// ---------------------------------------------------------------------------------------------

describe("self-consistency: (g) the same call gives the same values inside a user-defined function, an if block, and a loop body", () => {
  // Stateful builtins get their state slots per call site, and differently inside functions
  // (function-relative slots), conditional blocks and loops (per-call advance). A call that runs on
  // every bar must not care where it is written.
  const entries = POOL.filter((e) => e.out !== "tuple");
  const contexts: Array<[string, (call: string, callOf: (s: string) => string) => string[]]> = [
    ["user-defined function", (_c, callOf) => ["f(src) =>", `    ${callOf("src")}`, "v = f(close)"]],
    ["if block taken on every bar", (c) => ["float v = na", "if bar_index >= 0", `    v := ${c}`]],
    ["loop body of one iteration", (c) => ["float v = na", "for i = 0 to 0", `    v := ${c}`]],
  ];
  for (const [label, wrap] of contexts) {
    it(`${label}: every pooled function`, () => {
      const failures: string[] = [];
      const compileFailures: string[] = [];
      let compared = 0;
      for (const e of entries) {
        for (const nan of [false, true]) {
          const d = dataFor(13, nan, SHORT_BARS);
          const callOf = (s: string): string => {
            const c = e.call(s, "6", mulberry32(5));
            return e.out === "flag" ? `(${c}) ? 1 : 0` : c;
          };
          const base = ["//@version=5", 'indicator("g")', `v = ${callOf("close")}`, 'plot(v, "q")'].join("\n");
          const wrapped = ["//@version=5", 'indicator("g")', ...wrap(callOf("close"), callOf), 'plot(v, "q")'].join("\n");
          let a: Out;
          let b: Out;
          try {
            a = runScript(base, d);
            b = runScript(wrapped, d);
          } catch (err) {
            compileFailures.push(`ta.${e.name} in ${label}: ${(err as Error).message.split("\n")[0]}`);
            break;
          }
          const i = firstBitDiff(a.plots["q"]!, b.plots["q"]!);
          compared++;
          if (i >= 0) failures.push(`ta.${e.name} in ${label} (${nan ? "na gaps" : "clean"}) bar ${i}: top level ${a.plots["q"]![i]} vs wrapped ${b.plots["q"]![i]}\n    ${wrapped.split("\n").slice(2).join("\n    ")}`);
        }
      }
      expect(compared).toBeGreaterThan(entries.length);
      expect([...compileFailures, ...failures], head([...compileFailures, ...failures], 3)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// (h) delay commutes with a windowed function
// ---------------------------------------------------------------------------------------------

describe("self-consistency: (h) f(x[1]) == f(x)[1] for functions that read only their source's own history", () => {
  // Feeding a function the source delayed by one bar must give its own result delayed by one bar:
  // history slots (x[1], f(x)[1]) and the builtins' own windows have to line up, na gaps included.
  // Excluded because their warm-up reads bar_index, which the delay moves: highest, lowest, percentrank,
  // rci, and every function that also reads volume or high/low.
  const delaying = ["sma", "ema", "rma", "wma", "hma", "dema", "linreg", "rsi", "cmo", "cci", "change", "mom", "roc", "variance", "stdev", "dev", "median", "mode", "sum", "swma", "cog"];
  const entries = POOL.filter((e) => delaying.includes(e.name));
  it("covers the whole list", () => expect(entries.map((e) => e.name).sort()).toEqual([...delaying].sort()));
  for (const e of entries) {
    it(`ta.${e.name}: clean and na-gap data (literal length; a series length reads bar_index, which the delay moves)`, () => {
      const failures: string[] = [];
      for (const nan of [false, true]) {
        const d = dataFor(17, nan, SHORT_BARS);
        const direct = e.call("close", "7", mulberry32(4));
        const delayed = e.call("close[1]", "7", mulberry32(4));
        const src = ["//@version=5", 'indicator("h")', `a = ${direct}`, 'plot(a, "a")', `b = ${delayed}`, 'plot(b, "b")'].join("\n");
        const out = runScript(src, d);
        const a = out.plots["a"]!;
        const b = out.plots["b"]!;
        let finite = 0;
        for (let i = 1; i < a.length; i++) {
          if (Number.isFinite(a[i - 1]!)) finite++;
          if (!Object.is(b[i], a[i - 1])) {
            failures.push(`ta.${e.name} (${nan ? "na gaps" : "clean"}) bar ${i}: f(close[1]) = ${b[i]} but f(close)[1] = ${a[i - 1]}\n    ${src.split("\n").slice(2).join("\n    ")}`);
            break;
          }
        }
        expect(finite, `ta.${e.name}: not vacuous`).toBeGreaterThan(40);
      }
      expect(failures, head(failures, 3)).toEqual([]);
    });
  }
});

afterAll(() => {
  const unclassified = Object.keys(TA_REGISTRY).filter((k) => !POOL_NAMES.has(k) && !SKIPPED.some((s) => s.name === k));
  reportRow(`pool=${POOL.length} entries over ${POOL_NAMES.size} registry names; skipped: ${SKIPPED.map((s) => s.name).join(", ")}; RUNS=${PROP_RUNS}`);
  reportRow(`registry keys not classified (not a failure): ${unclassified.join(", ") || "(none)"}`);
  reportRow(`finite plotted values compared by the prefix test, fewest first: ${[...finiteByEntry].sort((a, b) => a[1] - b[1]).slice(0, 14).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  reportRow(`cases=${ctr.cases}, covered names=${ctr.entriesCovered.size}, prefix bars compared=${ctr.prefixBars}, strategy prefix cases=${ctr.stratPrefix}, format variants run=${ctr.formatVariants}, scale checks=${ctr.scaleChecks}, shift checks=${ctr.shiftChecks}`);
  flushReport("invariants");
});
