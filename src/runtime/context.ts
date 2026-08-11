// Context: the bar-loop execution state. Everything lives in integer-indexed
// slot arrays and plain objects — no closures, because the bar loop must not
// allocate.
//
//   var / varip            -> $.vars[slot]      (undefined marks "not yet initialized")
//   TA call state          -> $.taSlots[slot]   (plain object, preallocated so each
//                                                call site is independent)
//   var / varip inside UDFs -> $.fnVars[base + local]
//
// fnVars is a separate array from vars rather than an extension of it. Slot
// bases are per-call-site, so sharing one array with the named top-level slots
// would break the uniqueness assumption behind the `var:<name>` snapshot
// channel that run() exposes — two call sites of the same function reuse the
// same local name. Splitting the arrays removes the problem at the root.
//
// The slot element type includes string and number[] because Pine's reference
// types are stored by reference: a `var string` declaration puts the string
// straight in the slot, and a Pine array puts the JS array reference there.
// Generated code runs through `new Function` and is untyped, so widening this
// type changes nothing at runtime; the TypeScript that touches these arrays
// already casts explicitly.

import { Series, RefSeries } from "./series";
import { StrategyState } from "./strategy";
import { build as buildSecurityCache, type SecurityCache } from "./security";
// Type-only: erased at runtime, so no runtime cycle back into the transpiler.
import type { TranspileOk } from "../transpiler/pipeline";

export interface OHLCVData {
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  volume: ArrayLike<number>;
  // Bar open time, unix milliseconds — the same unit as TradingView's `time`
  // builtin. Optional: without it, calendar-aware behaviour falls back to
  // naive bar counting and everything else is unchanged.
  time?: ArrayLike<number>;
}

export class Context {
  vars: (number | string | number[] | null | undefined)[];
  taSlots: Record<string, unknown>[];
  // Shared scratch for multi-return TA functions (rt.ta.macd and friends),
  // used instead of allocating a tuple per bar. Sized by the analyzer to the
  // widest multi-return call the script actually contains. It does not need to
  // be per-call-site: codegen emits "run the TA call, copy straight into the
  // destination variables" as one statement block, so the scratch is always
  // consumed before the next stateful call can touch it.
  taScratch: Float64Array;
  fnVars: (number | string | number[] | null | undefined)[];
  histSlots: Series[];
  // History for `=` locals holding drawing handles (line/label/box/table),
  // which cannot live in a Float64Array. Counted independently of histSlots,
  // so this array is empty in most scripts.
  refHistSlots: RefSeries[];
  // History for stateful calls that sit inside a conditional (if/for/while).
  // Deliberately not advanced by advance(): each slot's cursor moves only when
  // its own Series.push() runs, at the exact point codegen emits the call. The
  // index therefore counts "times actually called" rather than bars elapsed,
  // which is what Pine's history semantics require in a branch.
  condCallHistSlots: Series[];
  // Same call-count indexing as condCallHistSlots, but backed by RefSeries for
  // drawing-constructor results — the `line.delete(line.new(...)[1])` idiom for
  // erasing the previous shape. Also untouched by advance().
  condCallRefHistSlots: RefSeries[];
  open: Series;
  high: Series;
  low: Series;
  close: Series;
  volume: Series;
  // Overrides for input.*, keyed by the input's title. An absent key falls back
  // to the declared default, so passing nothing runs the script as authored.
  inputs: Record<string, unknown>;
  // viz S1 — per-bar colors for plot() call sites whose color= is a runtime
  // expression. Allocated by the generated preamble's $.initPlotColors(N) — the
  // generated code itself carries the slot count, so neither constructor spelling
  // widens — and written as $.plotColors[k][$.idx] = "#rrggbb" (null = na color).
  plotColors: (string | null)[][] = [];
  // viz S3 — per-bar numeric viz channels (plotshape/plotchar conditions as 0/1,
  // plotarrow values, plotcandle/plotbar OHLC). Same lifecycle as plotColors: the
  // generated preamble calls $.initVizSeries(N), the bar loop writes by index.
  vizSeries: number[][] = [];
  // Plot collection channel, one preallocated Series per plot call site.
  // Generated code fills them with `$.plots[N].record(value)` each bar; once
  // the loop finishes, run() converts them to plain arrays.
  plots: Series[];
  // Zero-based index of the current bar, for barstate.* and session.*.
  // advance() moves it forward by one; barCount is the fixed total.
  idx: number;
  // Broker state for strategy.*. Always constructed, whether or not the script
  // declares a strategy: with no order calls, processFills costs two boolean
  // checks a bar. Generated code reaches it directly as `$.strategy.entry(...)`
  // and `$.strategy.posSize`, the same way it reaches `$.plots[n].record`.
  strategy: StrategyState;
  // Raw bar times, not wrapped in a Series. Higher-timeframe aggregation is a
  // precomputation pass outside the bar loop that indexes by absolute position,
  // so it never needs reverse access or history.
  time: ArrayLike<number> | undefined;
  // Per-call-site higher-timeframe aggregation cache for request.security,
  // indexed by the slot the analyzer assigned in source order. When the
  // timeframe is a compile-time literal there is nothing to defer, so every
  // cache is built here, before the bar loop starts.
  securityCache: SecurityCache[];
  // Cache for request.security call sites whose argument is an expression
  // rather than a bare series. It shares the slot numbering with
  // securityCache, but the entries are filled by the `__secExprN()` calls
  // codegen puts in the preamble, which run right after construction. The
  // constructor cannot compute them itself: doing so would mean generating
  // code for a user Pine expression, which a runtime module cannot do.
  securityExprCache: (Float64Array | undefined)[];
  // Kept so a security cache can be rebuilt when its timeframe turns out to be
  // a runtime value. open/high/low/close/volume are already wrapped as Series
  // above (reverse access only, no raw exposure), but the cache builder needs
  // forward ArrayLike. This is the constructor argument itself — no copy.
  private rawData: OHLCVData;

  // Object form (viz S0): build a Context straight from a TranspileOk instead of
  // hand-copying its twelve slot fields into the positional constructor. The
  // positional form stays supported; new slot kinds land here once instead of at
  // every call site (API.md "Rough edges" — this is that overload).
  static from(
    result: TranspileOk,
    data: OHLCVData,
    opts: { inputs?: Record<string, unknown> } = {},
  ): Context {
    return new Context(
      data, result.varSlots.length, result.taSlotCount, result.fnVarSlotCount,
      result.historySlotCount, result.taScratchSize, opts.inputs ?? {},
      result.plotTitles.length, result.securityTfs, result.refHistorySlotCount,
      result.condCallHistorySlotCount, result.condCallRefHistorySlotCount,
    );
  }

  // viz S1 — called once from the generated preamble when the script has runtime
  // plot colors. Sized bar-count × slot so the bar loop writes by index, never pushes.
  initPlotColors(count: number): void {
    this.plotColors = Array.from({ length: count }, () => new Array<string | null>(this.barCount).fill(null));
  }

  // viz S3 — sibling of initPlotColors for the numeric channels. NaN prefill = na.
  initVizSeries(count: number): void {
    this.vizSeries = Array.from({ length: count }, () => new Array<number>(this.barCount).fill(NaN));
  }

  constructor(
    data: OHLCVData,
    varSlotCount: number,
    taSlotCount: number,
    fnVarSlotCount: number = 0,
    historySlotCount: number = 0,
    taScratchSize: number = 0,
    inputs: Record<string, unknown> = {},
    plotSlotCount: number = 0,
    securityTfs: readonly string[] = [],
    refHistorySlotCount: number = 0,
    condCallHistorySlotCount: number = 0,
    condCallRefHistorySlotCount: number = 0,
  ) {
    this.vars = new Array(varSlotCount).fill(undefined);
    this.taSlots = Array.from({ length: taSlotCount }, () => ({}));
    this.taScratch = new Float64Array(taScratchSize);
    this.fnVars = new Array(fnVarSlotCount).fill(undefined);
    this.histSlots = Array.from({ length: historySlotCount }, () => Series.preallocate(data.close.length));
    this.refHistSlots = Array.from({ length: refHistorySlotCount }, () => RefSeries.preallocate(data.close.length));
    this.condCallHistSlots = Array.from({ length: condCallHistorySlotCount }, () => Series.preallocate(data.close.length));
    this.condCallRefHistSlots = Array.from({ length: condCallRefHistorySlotCount }, () => RefSeries.preallocate(data.close.length));
    this.open = new Series(data.open);
    this.high = new Series(data.high);
    this.low = new Series(data.low);
    this.close = new Series(data.close);
    this.volume = new Series(data.volume);
    this.inputs = inputs;
    this.plots = Array.from({ length: plotSlotCount }, () => Series.preallocate(data.close.length));
    this.idx = -1;
    this.strategy = new StrategyState();
    this.time = data.time;
    this.rawData = data;
    this.securityCache = securityTfs.map((tf) =>
      buildSecurityCache(data.open, data.high, data.low, data.close, data.volume, data.time, tf),
    );
    this.securityExprCache = new Array(securityTfs.length).fill(undefined);
  }

  // Rebuild one security cache once its timeframe expression has been
  // evaluated. Called from the codegen preamble, before the bar loop, and only
  // for slots whose timeframe was not a compile-time literal — the constructor
  // has already filled those with the chart timeframe as a harmless
  // placeholder, so slots that are never rebuilt behave exactly as before.
  rebuildSecurityCache(slot: number, tf: string): void {
    this.securityCache[slot] = buildSecurityCache(
      this.rawData.open,
      this.rawData.high,
      this.rawData.low,
      this.rawData.close,
      this.rawData.volume,
      this.rawData.time,
      tf,
    );
  }

  get barCount(): number {
    return this.close.length;
  }

  // Input to `time` and to everything derived from it — year, month, day,
  // hour, minute, second, trading day. Falls back to 0 when no time channel
  // was supplied; that is an absent-infrastructure default, not an attempt to
  // reproduce any particular platform behaviour.
  get barTimeMs(): number {
    return this.time !== undefined && this.idx < this.time.length ? this.time[this.idx]! : 0;
  }

  // last_bar_time — the final element of the whole time array, constant no
  // matter how far the bar loop has advanced.
  get lastBarTimeMs(): number {
    return this.time !== undefined && this.time.length > 0 ? this.time[this.time.length - 1]! : 0;
  }

  // time[n]. Context already holds the entire time array, so history is
  // synthesized by indexing (idx - offset) directly rather than recording into
  // a history slot — which also means there is no restriction on using it
  // inside a conditional or a user-defined function. The guards match
  // Series.get(): truncate, reject negative or NaN offsets, and return NaN
  // during warmup. With no time channel the fallback is 0, but the warmup
  // guard comes first: "that bar does not exist" is a separate question from
  // "there is no time data".
  barTimeAt(offset: number): number {
    const t = Math.trunc(offset);
    if (!(t >= 0) || this.idx - t < 0) return NaN;
    if (this.time === undefined) return 0;
    const i = this.idx - t;
    return i < this.time.length ? this.time[i]! : 0;
  }

  // time_close[n] — the timeCloseMs getter's "next bar's open, extrapolated on
  // the last bar" logic, generalized to the bar at (idx - offset). For any
  // offset >= 1 a following bar exists, so the extrapolation branch is reached
  // only when a dynamic offset evaluates to 0 at runtime.
  timeCloseAt(offset: number): number {
    const t = Math.trunc(offset);
    if (!(t >= 0) || this.idx - t < 0) return NaN;
    if (this.time === undefined || this.time.length === 0) return 0;
    const i = this.idx - t;
    const n = this.time.length;
    if (i + 1 < n) return this.time[i + 1]!;
    if (n >= 2) return this.time[n - 1]! + (this.time[n - 1]! - this.time[n - 2]!);
    return this.time[0]!;
  }

  // The bars_back argument of time(...) and time_close(...) — barTimeAt with a
  // sign. Zero or positive behaves identically. Negative means a future bar:
  // replaying a batch, the array may genuinely already hold it, in which case
  // the real value is used; past the end of the array it extrapolates from the
  // last two bars' spacing. That extrapolation is unverified against
  // TradingView.
  timeAtBarsBack(barsBack: number): number {
    const n = Math.trunc(barsBack);
    if (this.time === undefined) return 0;
    const len = this.time.length;
    const i = this.idx - n;
    if (n >= 0) {
      if (i < 0) return NaN;
      return i < len ? this.time[i]! : 0;
    }
    if (i < len) return this.time[i]!;
    if (len >= 2) return this.time[len - 1]! + (i - (len - 1)) * (this.time[len - 1]! - this.time[len - 2]!);
    return len > 0 ? this.time[len - 1]! : 0;
  }

  // chart.left_visible_bar_time. A headless batch engine has no viewport, so
  // every bar is "visible" and the leftmost one is the first — the mirror of
  // lastBarTimeMs.
  get firstBarTimeMs(): number {
    return this.time !== undefined && this.time.length > 0 ? this.time[0]! : 0;
  }

  // time_close. Replaying a whole batch, the close time of the current bar is
  // approximated by the open time of the next one, which assumes the data has
  // no gaps — an exchange session break makes it wrong. The last bar has no
  // successor, so it extrapolates the previous interval; a single-bar series
  // has zero duration and returns itself.
  get timeCloseMs(): number {
    if (this.time === undefined || this.time.length === 0) return 0;
    const n = this.time.length;
    if (this.idx + 1 < n) return this.time[this.idx + 1]!;
    if (n >= 2) return this.time[n - 1]! + (this.time[n - 1]! - this.time[n - 2]!);
    return this.time[0]!;
  }

  // timenow. Reading the wall clock would make a replay non-reproducible, so
  // this is pinned to the last bar's time — the closest thing a batch replay
  // has to a "now" that is the same on every run.
  get timenowMs(): number {
    return this.lastBarTimeMs;
  }

  advance(): void {
    this.idx += 1;
    this.open.advance();
    this.high.advance();
    this.low.advance();
    this.close.advance();
    this.volume.advance();
    for (const h of this.histSlots) h.advance();
    for (const h of this.refHistSlots) h.advance();
    for (const p of this.plots) p.advance();
    // Fill market orders queued on the previous bar at this bar's open, which
    // is TradingView's rule. Limit and stop orders are tested against this
    // bar's open (for a gap fill) and its high/low (for an intrabar trigger);
    // untriggered ones stay in the slot and carry to the next bar. advance()
    // runs before barFn(), so this bar's script code sees the post-fill
    // position.
    this.strategy.processFills(this.open.get(0), this.high.get(0), this.low.get(0), this.idx, this.barTimeMs);
    // Updating drawdown here, before barFn, gives the same answer as updating
    // it afterwards: this is a batch replay, so the bar's close is already
    // fixed and equals whatever the script will read later.
    this.strategy.updateDrawdown(this.close.get(0));
    // Same reasoning — posSize already reflects this bar's final fills, so no
    // post-bar hook is needed.
    this.strategy.updateMaxContractsHeld();
  }
}
