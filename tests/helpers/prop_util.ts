// Shared plumbing for tests/property/*: seeded bar generators and data variants, a cached
// transpile + run wrapper, series comparison with explicit tolerances, and an opt-in report.
//
// Nothing here is a golden: the property tier checks resin against reference code written in the
// tests, against itself (metamorphic relations) and against accounting identities.
//
// Environment:
//   RESIN_PROP_RUNS    integer multiplier on the number of SEEDS / CASES (default 1). The bar
//                      count never changes, and seed = base + i, so RUNS=1 is a prefix of RUNS=20.
//   RESIN_PROP_REPORT  "1" prints the per-function / per-property tables to the console.

import { transpile, type TranspileOk } from "../../src/transpiler/pipeline";
import { compile, run, type RunResult } from "../../src/runtime/engine";
import { Context, type ContextOptions } from "../../src/runtime/context";
import type { AnalyzeOptions } from "../../src/transpiler/analyzer";
import { makeSyntheticOHLCV, mulberry32, type SyntheticOHLCV } from "./synthetic";

// ---------------------------------------------------------------------------------------------
// Knobs
// ---------------------------------------------------------------------------------------------

function readRuns(): number {
  const raw = Number(process.env.RESIN_PROP_RUNS ?? 1);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/** The multiplier on seeds / generated cases. */
export const PROP_RUNS = readRuns();
export const PROP_REPORT = process.env.RESIN_PROP_REPORT === "1";

/** `perRun * PROP_RUNS` consecutive seeds starting at `base` (RUNS=1 is a prefix of RUNS=k). */
export function propSeeds(base: number, perRun: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < perRun * PROP_RUNS; i++) out.push(base + i);
  return out;
}

/** The synthetic bars are hourly (tests/helpers/synthetic.ts), so scripts compile for "60". */
export const CHART_TF = "60";
export const EPS = Number.EPSILON;

// ---------------------------------------------------------------------------------------------
// Bars and their variants
// ---------------------------------------------------------------------------------------------

export type Bars = SyntheticOHLCV;

export function makeBars(n: number, seed: number): Bars {
  return makeSyntheticOHLCV(n, seed);
}

export function sliceBars(d: Bars, n: number): Bars {
  return {
    open: d.open.slice(0, n),
    high: d.high.slice(0, n),
    low: d.low.slice(0, n),
    close: d.close.slice(0, n),
    volume: d.volume.slice(0, n),
    time: d.time.slice(0, n),
  };
}

export function cloneBars(d: Bars): Bars {
  return sliceBars(d, d.close.length);
}

/**
 * Bar indexes of the "missing data" pattern used by the na variants: three leading bars, a burst of
 * seven consecutive bars at 120..126, and isolated bars with probability 0.05. Seeded.
 */
export function gapIndexes(n: number, seed: number): Set<number> {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const gaps = new Set<number>([0, 1, 2]);
  for (let i = 120; i <= 126 && i < n; i++) gaps.add(i);
  for (let i = 3; i < n; i++) if (rand() < 0.05) gaps.add(i);
  return gaps;
}

/** `close` is na on the gap bars; open/high/low/volume are untouched. */
export function withNanClose(d: Bars, seed: number): Bars {
  const out = cloneBars(d);
  for (const i of gapIndexes(out.close.length, seed)) out.close[i] = NaN;
  return out;
}

/** Whole bars (open, high, low and close) are na on the gap bars. */
export function withNanBars(d: Bars, seed: number): Bars {
  const out = cloneBars(d);
  for (const i of gapIndexes(out.close.length, seed)) {
    out.open[i] = NaN;
    out.high[i] = NaN;
    out.low[i] = NaN;
    out.close[i] = NaN;
  }
  return out;
}

/** A dead market: open = high = low = close = the bar before `from`'s close, for bars [from, to). */
export function withFlatStretch(d: Bars, from = 200, to = 320): Bars {
  const out = cloneBars(d);
  const level = out.close[from - 1]!;
  for (let i = from; i < to && i < out.close.length; i++) {
    out.open[i] = level;
    out.high[i] = level;
    out.low[i] = level;
    out.close[i] = level;
  }
  return out;
}

/** volume = 0 on bars [100, 160) and on every bar with probability 0.1. Seeded. */
export function withZeroVolume(d: Bars, seed: number): Bars {
  const out = cloneBars(d);
  const rand = mulberry32(seed ^ 0x85ebca6b);
  for (let i = 0; i < out.volume.length; i++) {
    if ((i >= 100 && i < 160) || rand() < 0.1) out.volume[i] = 0;
  }
  return out;
}

export function scaleBars(d: Bars, factor: number): Bars {
  const out = cloneBars(d);
  for (let i = 0; i < out.close.length; i++) {
    out.open[i] = out.open[i]! * factor;
    out.high[i] = out.high[i]! * factor;
    out.low[i] = out.low[i]! * factor;
    out.close[i] = out.close[i]! * factor;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Compile and run
// ---------------------------------------------------------------------------------------------

const compileCache = new Map<string, TranspileOk>();

/** transpile() once per (source, options); throws with the source on a transpile error. */
export function compileScript(source: string, options: AnalyzeOptions = {}): TranspileOk {
  const opts: AnalyzeOptions = { chartTf: CHART_TF, ...options };
  const key = JSON.stringify([source, opts]);
  const hit = compileCache.get(key);
  if (hit !== undefined) return hit;
  const r = transpile(source, opts);
  if (!r.ok) throw new Error(`transpile failed: ${r.errors.join("; ")}\n--- script ---\n${source}`);
  compileCache.set(key, r);
  return r;
}

export interface Out {
  /** plot values by plot title, in script order. */
  plots: Record<string, number[]>;
  titles: string[];
  res: RunResult;
}

function toOut(res: RunResult): Out {
  const plots: Record<string, number[]> = {};
  const titles: string[] = [];
  for (const p of res.plots) {
    plots[p.title] = p.values;
    titles.push(p.title);
  }
  return { plots, titles, res };
}

/** Compile (cached) and run in one shot. The happy path must not warn about the data. */
export function runScript(source: string, data: Bars, options: AnalyzeOptions = {}, ctxOptions?: ContextOptions): Out {
  const tr = compileScript(source, options);
  const res = run(tr, data, ctxOptions);
  if (res.warnings.length > 0) {
    throw new Error(`run warnings: ${res.warnings.join(" | ")}\n--- script ---\n${source}`);
  }
  return toOut(res);
}

/** The streaming spelling: a fresh Context and the per-bar function driven by hand. */
export function streamScript(tr: TranspileOk, data: Bars, ctxOptions?: ContextOptions): { out: Out; ctx: Context; vars: Record<string, unknown> } {
  const ctx = Context.from(tr, data, ctxOptions);
  const bar = compile(tr.code)(ctx);
  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    bar();
  }
  const plots: Record<string, number[]> = {};
  const titles: string[] = [];
  tr.plotTitles.forEach((t, i) => {
    plots[t] = ctx.plots[i]!.toArray();
    titles.push(t);
  });
  const res = { bars: [], finalVarState: {}, plots: titles.map((t) => ({ title: t, values: plots[t]! })), warnings: ctx.diagnostics.messages.slice() } as RunResult;
  // the script's var slots by name (a Pine array is the live JS array), as RunResult.finalVarState has them
  const vars: Record<string, unknown> = {};
  tr.varSlots.forEach((name, i) => {
    vars[name] = ctx.vars[i];
  });
  return { out: { plots, titles, res }, ctx, vars };
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

/** Index of the first element where `Object.is` differs (so -0 vs +0 differ, NaN equals NaN), else -1. */
export function firstBitDiff(a: ArrayLike<number>, b: ArrayLike<number>, upTo = Math.max(a.length, b.length)): number {
  for (let i = 0; i < upTo; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

export interface TolStats {
  n: number; // bars compared in total
  naMatched: number; // both sides na
  compared: number; // both sides finite and compared against the tolerance
  masked: number; // bars excluded because the reference itself is ill-conditioned there
  maxAbs: number; // largest |actual - expected| over the compared bars
  maxRatio: number; // largest |actual - expected| / allowed over the compared bars (1 = at the tolerance)
}

export interface TolResult {
  stats: TolStats;
  failures: string[];
}

/**
 * Compare two series bar by bar. A non-finite value is na on both sides (the repo's documented rule:
 * "`na()` reads +inf, -inf and NaN as na, so a plot shows none of them", src/runtime/ta.ts at
 * ta.iii; the raw plot array can still carry +-Infinity from a builtin quotient). NaN must match
 * NaN exactly (na parity); otherwise |actual - expected| <= allowed(i, expected).
 * `mask(i)` excludes a bar the reference itself finds ill-conditioned (counted, reported); when
 * `maskedCheck` is given it is run on the resin value of every masked bar and a non-null return is a
 * failure.
 */
export function compareSeries(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  allowed: (i: number, ref: number) => number,
  mask?: (i: number) => boolean,
  maskedCheck?: (i: number, actual: number) => string | null,
): TolResult {
  const stats: TolStats = { n: expected.length, naMatched: 0, compared: 0, masked: 0, maxAbs: 0, maxRatio: 0 };
  const failures: string[] = [];
  if (actual.length !== expected.length) {
    failures.push(`length ${actual.length} != ${expected.length}`);
    return { stats, failures };
  }
  for (let i = 0; i < expected.length; i++) {
    const a = Number.isFinite(actual[i]!) ? actual[i]! : NaN;
    const e = Number.isFinite(expected[i]!) ? expected[i]! : NaN;
    if (mask !== undefined && mask(i)) {
      stats.masked++;
      const why = maskedCheck?.(i, a);
      if (why !== undefined && why !== null) failures.push(`bar ${i} (masked, ill-conditioned reference): resin=${a} ${why}`);
      continue;
    }
    const aNa = Number.isNaN(a);
    const eNa = Number.isNaN(e);
    if (aNa || eNa) {
      if (aNa && eNa) stats.naMatched++;
      else failures.push(`bar ${i}: resin=${a} reference=${e} (na parity)`);
      continue;
    }
    const tol = allowed(i, e);
    const diff = Math.abs(a - e);
    stats.compared++;
    if (diff > stats.maxAbs) stats.maxAbs = diff;
    const ratio = tol > 0 ? diff / tol : diff === 0 ? 0 : Infinity;
    if (ratio > stats.maxRatio) stats.maxRatio = ratio;
    if (!(diff <= tol)) failures.push(`bar ${i}: resin=${a} reference=${e} |diff|=${diff} allowed=${tol}`);
  }
  return { stats, failures };
}

// ---------------------------------------------------------------------------------------------
// Report (opt-in)
// ---------------------------------------------------------------------------------------------

const reportRows: string[] = [];

export function reportRow(line: string): void {
  if (PROP_REPORT) reportRows.push(line);
}

export function flushReport(title: string): void {
  if (!PROP_REPORT || reportRows.length === 0) return;
  console.log(`\n=== ${title} (RESIN_PROP_RUNS=${PROP_RUNS}) ===\n${reportRows.join("\n")}\n`);
  reportRows.length = 0;
}

/** First `max` lines of a failure list, for assertion messages. */
export function head(lines: string[], max = 8): string {
  const shown = lines.slice(0, max).join("\n  ");
  return lines.length > max ? `${shown}\n  ... and ${lines.length - max} more` : shown;
}

export { mulberry32 };
