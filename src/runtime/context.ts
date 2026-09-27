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
import { StrategyState, type SubBarWindow } from "./strategy";
import { build as buildSecurityCache, buildFromFeed, nestedView, type SecurityCache } from "./security";
import { ExchangeCalendar, calendarSpecOf, type CalendarSpec, type SymbolCalendarOptions } from "./calendar";
// Type-only: erased at runtime, so no runtime cycle back into the transpiler.
import type { TranspileOk } from "../transpiler/pipeline";
import type { DrawingRecord } from "./drawing";
import { BarState } from "./rollback";

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

export interface ContextOptions {
  // Overrides for input.*, keyed by the input's title.
  inputs?: Record<string, unknown>;
  // The bar magnifier's feed: lower-timeframe bars covering the chart's span, in time order, with
  // their open times (required, as is the chart data's). A chart bar owns the sub-bars that open
  // from its own open time up to the next chart bar's; a strategy(use_bar_magnifier=true) fills its
  // orders on them (StrategyState.processFills). Any other script ignores the feed.
  magnifier?: OHLCVData;
  // Other symbols' bars, keyed by the symbol string a script passes request.security. A call
  // whose symbol is known at compile time and has a feed here reads the feed (security.ts
  // buildFromFeed); any other call reads the chart's own bars.
  security?: Readonly<Record<string, SecurityFeed>>;
}

// One symbol's bars with their open times (required), the timeframe they have (taken to be the
// requested one when omitted), and the symbol's exchange calendar in the shape of transpile's
// syminfo option (open around the clock in UTC when omitted).
export interface SecurityFeed extends OHLCVData {
  time: ArrayLike<number>;
  timeframe?: string;
  syminfo?: SymbolCalendarOptions;
}

// The ContextOptions keys this resin takes, for callers that detect support.
export const CONTEXT_OPTION_KEYS: readonly (keyof ContextOptions)[] = ["inputs", "magnifier", "security"];

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
  // viz S4 — creation log for drawing objects (label/line/box/table). Filled by the
  // runtime's newHandle through the per-barFn sink engine.compile() installs; each
  // record's state is the live handle state, so later set_* mutations are reflected.
  drawingLog: DrawingRecord[] = [];
  // Plot collection channel, one preallocated Series per plot call site.
  // Generated code fills them with `$.plots[N].record(value)` each bar; once
  // the loop finishes, run() converts them to plain arrays.
  plots: Series[];
  // Zero-based index of the current bar, for barstate.* and session.* (timeOfBar).
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
  // request.security whose expression the script itself computes in the requested context
  // (runSecurityScript). In such a child context: the security slot whose expression it records
  // (-1 in a chart context), which per-bar statements it runs (secSkip[i] === 0; null runs all),
  // and the values it records, by requested bar.
  secCapture = -1;
  secSkip: Uint8Array | null = null;
  secOut: Float64Array | null = null;
  // Set by engine.compile(): instantiates the compiled module on another context, a child.
  instantiate: ((ctx: Context) => () => void) | undefined = undefined;
  // The $.vars and $.fnVars slots declared with varip, which a discarded run of the body does not
  // roll back (setIntrabarSlots; runtime/rollback.ts). Filled only for a strategy that recalculates
  // on order fills.
  intrabarVarSlots: ReadonlySet<number> = new Set();
  intrabarFnVarSlots: ReadonlySet<number> = new Set();
  // A child's bar close times, the requested bars' own, which time_close reads instead of the
  // next bar's open time.
  private barCloseTimes: ArrayLike<number> | undefined = undefined;
  // Kept so a security cache can be rebuilt when its timeframe turns out to be
  // a runtime value. open/high/low/close/volume are already wrapped as Series
  // above (reverse access only, no raw exposure), but the cache builder needs
  // forward ArrayLike. This is the constructor argument itself — no copy.
  private rawData: OHLCVData;
  // The bar magnifier's feed split by chart bar (setMagnifier), and the window advance() hands the
  // strategy, reused bar after bar. Both undefined when no feed was given.
  private subStart: Int32Array | undefined;
  private subWindow: SubBarWindow | undefined;
  // The other symbols' feeds (setSecurityFeeds), the compile-time symbol of each security slot,
  // and the chart's calendar the feeds pair with. Empty without feeds.
  private securityFeeds: Readonly<Record<string, SecurityFeed>> = {};
  private slotSymbols: readonly (string | null)[] = [];
  private chartSpec: CalendarSpec | undefined;
  private chartCalendar: ExchangeCalendar | undefined;

  // Object form (viz S0): build a Context straight from a TranspileOk instead of
  // hand-copying its twelve slot fields into the positional constructor. The
  // positional form stays supported; new slot kinds land here once instead of at
  // every call site (API.md "Rough edges" — this is that overload).
  static from(
    result: TranspileOk,
    data: OHLCVData,
    opts: ContextOptions = {},
  ): Context {
    const ctx = new Context(
      data, result.varSlots.length, result.taSlotCount, result.fnVarSlotCount,
      result.historySlotCount, result.taScratchSize, opts.inputs ?? {},
      result.plotTitles.length, result.securityTfs, result.refHistorySlotCount,
      result.condCallHistorySlotCount, result.condCallRefHistorySlotCount,
    );
    if (opts.magnifier !== undefined) ctx.setMagnifier(opts.magnifier);
    if (opts.security !== undefined) {
      ctx.setSecurityFeeds(opts.security, result.securitySymbols ?? [], result.securityTfs, result.calendar);
    }
    return ctx;
  }

  // Takes other symbols' feeds (ContextOptions.security): each security slot whose symbol
  // (`symbols`, the analyzer's compile-time symbol per slot, null for the chart's own) has a feed
  // is rebuilt from it, paired with the chart's bars on `chartSpec`, the chart's calendar.
  setSecurityFeeds(
    feeds: Readonly<Record<string, SecurityFeed>>,
    symbols: readonly (string | null)[],
    tfs: readonly string[],
    chartSpec: CalendarSpec | undefined,
  ): void {
    this.securityFeeds = feeds;
    this.slotSymbols = symbols;
    this.chartSpec = chartSpec;
    tfs.forEach((tf, slot) => {
      const found = this.feedOf(slot, tf);
      if (found !== undefined) this.securityCache[slot] = this.buildFeedCache(found.key, found.feed, tf);
    });
  }

  // The feed security slot `slot` reads at timeframe `tf`: the one keyed "SYMBOL:TF", else the one
  // keyed "SYMBOL" (the reference's key order, pynecore ScriptRunner._resolve_security_data: "Try
  // exact "SYMBOL:TF" match, then symbol-only"), so that one symbol can be handed at several
  // timeframes.
  private feedOf(slot: number, tf: string): { key: string; feed: SecurityFeed } | undefined {
    const symbol = this.slotSymbols[slot];
    if (symbol === null || symbol === undefined) return undefined;
    for (const key of [`${symbol}:${tf}`, symbol]) {
      if (Object.prototype.hasOwnProperty.call(this.securityFeeds, key)) return { key, feed: this.securityFeeds[key]! };
    }
    return undefined;
  }

  private buildFeedCache(key: string, feed: SecurityFeed, tf: string): SecurityCache {
    if (this.time === undefined) throw new Error("Context: request.security feeds need a time channel on the chart data");
    this.chartCalendar ??= new ExchangeCalendar(this.chartSpec ?? calendarSpecOf("D", undefined, "chart"));
    const feedCal = new ExchangeCalendar(calendarSpecOf(feed.timeframe ?? tf, feed.syminfo, `request.security feed '${key}'`));
    return buildFromFeed(feed, feedCal, tf, this.time, this.chartCalendar);
  }

  // Takes the bar magnifier's feed (ContextOptions.magnifier) and finds each chart bar's sub-bars in
  // it: chart bar i owns [subStart[i], subStart[i + 1]), the sub-bars opening at or after its open
  // time and before the next bar's (the last bar's end is its time_close, extrapolated as there).
  // Sub-bars before the first chart bar belong to none.
  setMagnifier(feed: OHLCVData): void {
    const chart = this.time;
    const t = feed.time;
    if (chart === undefined || t === undefined) {
      throw new Error("Context: the magnifier feed needs a time channel on both the chart data and the feed");
    }
    const n = this.barCount;
    const start = new Int32Array(n + 1);
    let j = 0;
    for (let i = 0; i <= n; i++) {
      const until = i < n ? chart[i]! : n >= 2 ? chart[n - 1]! + (chart[n - 1]! - chart[n - 2]!) : Infinity;
      while (j < t.length && t[j]! < until) j++;
      start[i] = j;
    }
    this.subStart = start;
    this.subWindow = { open: feed.open, high: feed.high, low: feed.low, close: feed.close, from: 0, to: 0 };
  }

  // Called once from the generated preamble of a strategy(calc_on_order_fills=true): the var slots
  // declared with varip, top-level ($.vars) and in functions ($.fnVars, every call's own block).
  setIntrabarSlots(vars: readonly number[], fnVars: readonly number[]): void {
    this.intrabarVarSlots = new Set(vars);
    this.intrabarFnVarSlots = new Set(fnVars);
  }

  // strategy(calc_on_order_fills=true): after the bar's first order fills (advance(), processFills),
  // the body runs again where the broker emulator stands, and each run's orders are filled from
  // there on; the body's ordinary run, the one that counts, follows (engine.compile). props.txt:
  // "Recalculate After order is filled ... the strategy recalculates on the same bar after an order
  // is filled"; strategies.txt ("calc_on_order_fills"): "The calc_on_order_fills parameter of the
  // strategy() declaration statement enables a strategy to recalculate immediately after an order
  // fills, allowing it to use more granular information and place additional orders without
  // waiting for a confirmed bar"; faq.txt: "sets take-profit and stop-loss orders during the entry
  // bar, based on the entry price strategy.position_avg_price". Every re-execution is discarded
  // (runtime/rollback.ts): only its orders stay.
  // How, as the oracle measured it on TradingView (pynecore core/script_runner.py `_coof_loop`,
  // `_set_path_bar`, `_LAST_PATH_NODE`; lib/strategy `_path_price`, `_mark_to_last_fill`):
  // - the emulator walks the path open (node 0) → the nearer extreme (1) → the farther extreme (2)
  //   → close (3). The first re-execution stands at the node of the pass's last fill, each further
  //   one at least one node further on, and none at node 3, the ordinary run's own place: "at most
  //   FOUR body runs per bar" ("a body that closes and re-enters on every pass ... flatlines at 4");
  // - the body sees the bar as built up to its node: open, the running high and low of the nodes
  //   walked, the node's price as close, (node + 1) / 4 of the volume ("cumulative (node + 1) / 4 of
  //   the bar's volume, exact on every probed bar"; the whole bar would be TradingView's own
  //   look-ahead, which the oracle does not reproduce either);
  // - the strategy is marked at the node's price: strategy.equity/openprofit read there, and a
  //   default-sized order is sized there ("a default-sized market entry it places is sized — and
  //   the equity it reads is marked — there");
  // - the orders of the re-execution fill from the node on (StrategyState.processFillsFrom).
  // Not covered: a strategy that also uses the bar magnifier re-executes nothing yet
  // (processFills), and neither does calc_on_every_tick.
  recalcOnOrderFills(body: () => void): void {
    const s = this.strategy;
    s.coofPending = false;
    const o = this.open.get(0);
    const h = this.high.get(0);
    const l = this.low.get(0);
    const c = this.close.get(0);
    const v = this.volume.get(0);
    const state = new BarState(this);
    try {
      for (let node = s.lastFillNode; node <= 2; ) {
        state.restore();
        const price = s.pathPrice(node);
        let hi = o;
        let lo = o;
        for (let k = 1; k <= node; k++) {
          const p = s.pathPrice(k);
          if (p > hi) hi = p;
          if (p < lo) lo = p;
        }
        this.high.setCurrent(hi);
        this.low.setCurrent(lo);
        this.close.setCurrent(price);
        this.volume.setCurrent((v * (node + 1)) / 4);
        s.beginRecalc(price);
        try {
          body();
        } finally {
          this.high.setCurrent(h);
          this.low.setCurrent(l);
          this.close.setCurrent(c);
          this.volume.setCurrent(v);
        }
        const filled = s.processFillsFrom(node, o, h, l, c, this.idx, this.barTimeMs);
        s.endRecalc(c);
        s.updateDrawdown(c);
        s.updateStatistics(h, l);
        if (!filled) break;
        node = Math.max(node + 1, s.lastFillNode);
      }
    } finally {
      s.endRecalc(c);
      state.close();
    }
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
    this.histSlots = Array.from({ length: historySlotCount }, () => Series.history(data.close.length));
    this.refHistSlots = Array.from({ length: refHistorySlotCount }, () => RefSeries.history(data.close.length));
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
    const found = this.feedOf(slot, tf);
    if (found !== undefined) {
      this.securityCache[slot] = this.buildFeedCache(found.key, found.feed, tf);
      return;
    }
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

  // A request whose timeframe its call binds where it stands (the generated preamble registers a
  // binder under the call's first slot): the call's first execution hands it the timeframe
  // argument's value, and the binder builds the call's caches, prepasses and requested-context runs
  // on it. The context is fixed at the first execution (mig6.txt "Dynamic requests": "the context
  // of a data request (ticker ID and timeframe) must be known on the first script execution and
  // remain unchanged across all subsequent executions"). A timeframe that changes later, which only
  // dynamic requests allow, is refused: TradingView then requests the new context ("it's possible
  // for a single request.*() instance to fetch data from different contexts in different
  // executions"), while the reference keeps the first one (pynecore core/security.py
  // _resolve_context), and resin takes neither side.
  securityBinders: (((tf: string) => void) | undefined)[] = [];
  private securityBoundTfs = new Map<number, string>();

  bindSecurity(slot: number, tf: string): void {
    if (this.securityBoundTfs.has(slot)) {
      const bound = this.securityBoundTfs.get(slot)!;
      if (tf !== bound) {
        throw new Error(
          `request.security: the timeframe of a request changed from ${JSON.stringify(bound)} to ${JSON.stringify(tf)} on bar ${this.idx}; resin binds a request to the timeframe of its first execution and does not follow a changing one`,
        );
      }
      return;
    }
    const bind = this.securityBinders[slot];
    if (bind === undefined) return;
    this.securityBoundTfs.set(slot, tf);
    bind(tf);
  }

  // request.security whose expression the script itself computes in the requested context
  // (transpiler/analyzer/security-script.ts; concepts_other-timeframes-and-data.txt "Declared
  // variables": "the function call duplicates all preceding code that determines the assigned value
  // or reference"). The compiled module runs again in a child context whose bars are the requested
  // ones, security slot `slot`'s rows, with state of its own: it executes only the per-bar
  // statements `runs` (indices among the `stmtCount` of them) and records the expression where the
  // call's statement begins. The result, one value per requested bar, is what the chart reads, as it
  // reads a prepass's (security.ts getFromArray).
  // The child's statements may read other requests (a nested request through a variable). Without
  // dynamic requests, Pine passes such a request's value into this one as the chart computed it
  // (concepts_other-timeframes-and-data.txt "Nested requests": "Without dynamic requests enabled,
  // the script evaluates each call independently, passing the first call's calculated value
  // directly into the second call rather than executing the first call within the second
  // context"), and the reference reads it by its bars' closes (pynecore core/security.py
  // __sec_read__: the producer's "last_close_at_or_before" the consumer bar's as-of instant). So
  // each other request whose data is built by now reaches the child as its own cache and values
  // paired with the requested rows (security.ts nestedView). This request's own slot is left out:
  // its reads in the child are na (codegen childSafeSecurityRead). The analyzer refuses the forms
  // this does not cover, among them a nested request that, with dynamic requests, would run in
  // this context's symbol or timeframe (analyzer/security-script.ts nestedRequestRefusal).
  runSecurityScript(slot: number, runs: readonly number[], stmtCount: number): Float64Array {
    if (this.instantiate === undefined) {
      throw new Error("request.security: evaluating an expression in the requested context needs a context the module was compiled on (engine.compile)");
    }
    const cache = this.securityCache[slot]!;
    const child = new Context(
      { open: cache.open, high: cache.high, low: cache.low, close: cache.close, volume: cache.volume, time: cache.timeOpen },
      this.vars.length,
      this.taSlots.length,
      this.fnVars.length,
      this.histSlots.length,
      this.taScratch.length,
      this.inputs,
      this.plots.length,
      [],
      this.refHistSlots.length,
      this.condCallHistSlots.length,
      this.condCallRefHistSlots.length,
    );
    child.barCloseTimes = cache.timeClose;
    this.securityCache.forEach((inner, s) => {
      if (s === slot || inner === undefined) return;
      child.securityCache[s] = nestedView(inner, cache);
      child.securityExprCache[s] = this.securityExprCache[s];
    });
    const skip = new Uint8Array(stmtCount).fill(1);
    for (const i of runs) skip[i] = 0;
    child.secCapture = slot;
    child.secSkip = skip;
    const out = new Float64Array(cache.close.length).fill(NaN);
    child.secOut = out;
    const bar = this.instantiate(child);
    for (let i = 0; i < child.barCount; i++) {
      child.advance();
      bar();
    }
    return out;
  }

  get barCount(): number {
    return this.close.length;
  }

  // Input to `time` and to everything derived from it — year, month, day,
  // hour, minute, second, trading day. Falls back to 0 when no time channel
  // was supplied; that is an absent-infrastructure default, not an attempt to
  // reproduce any particular platform behaviour.
  get barTimeMs(): number {
    return this.timeOfBar(this.idx);
  }

  // The open time of chart bar `i`, 0 without a time channel as barTimeMs. session.* reads the bar's
  // time through it: its analyzer expression names the bar by `$.idx`, which history indexing
  // (session.isfirstbar[1]) rewrites to the earlier bar.
  timeOfBar(i: number): number {
    return this.time !== undefined && i < this.time.length ? this.time[i]! : 0;
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
    if (this.barCloseTimes !== undefined) return this.barCloseTimes[this.idx - t] ?? 0;
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
    if (this.barCloseTimes !== undefined) return this.barCloseTimes[this.idx] ?? 0;
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
    // bar's open (for a gap fill) and its high/low (for an intrabar trigger;
    // an exit's trailing stop also on the path's closing segment, to the
    // close); untriggered ones stay in the slot and carry to the next bar. advance()
    // runs before barFn(), so this bar's script code sees the post-fill
    // position. With a magnifier feed the bar's sub-bars go along; the strategy
    // uses them only under use_bar_magnifier=true.
    const sub = this.subWindow;
    if (sub !== undefined) {
      sub.from = this.subStart![this.idx]!;
      sub.to = this.subStart![this.idx + 1]!;
    }
    this.strategy.processFills(
      this.open.get(0), this.high.get(0), this.low.get(0), this.idx, this.barTimeMs, this.close.get(0), sub,
    );
    // The close the script body runs at: orders it places without a qty are sized at this price.
    this.strategy.barClose = this.close.get(0);
    // Updating drawdown here, before barFn, gives the same answer as updating
    // it afterwards: this is a batch replay, so the bar's close is already
    // fixed and equals whatever the script will read later.
    this.strategy.updateDrawdown(this.close.get(0));
    // strategy.max_drawdown/max_runup see this bar's high and low after its fills.
    this.strategy.updateStatistics(this.high.get(0), this.low.get(0));
  }

  // The end of a bar, after the script body ran. With
  // strategy(process_orders_on_close=true) the broker emulator makes one more
  // fill attempt at this bar's close for the orders the body just placed.
  // Then the broker emulator judges margin calls at the close (a strategy with
  // no margin set skips them).
  finishBar(): void {
    this.strategy.processFillsAtClose(this.close.get(0), this.idx, this.barTimeMs);
    this.strategy.settleMargin(this.close.get(0), this.idx, this.barTimeMs);
  }
}
