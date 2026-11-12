// Strategy accounting identities: properties of a strategy run that need no external engine.
//
// Every block is labelled by what it can and cannot prove:
//   "self-consistency"                              - resin against itself (two readings of one
//                                                     quantity, or two runs related by a symmetry);
//   "reference (independent implementation in this test)" - a quantity recomputed here from the
//                                                     primitives the accessors expose.
// Nothing here says anything about TradingView.
//
// Seeded random strategies (tests/helpers/prop_strategy.ts) run on 300 bars through the public API
// (transpile + Context.from + compile, i.e. the streaming spelling) with every order driven by a
// bar_index schedule. RESIN_PROP_RUNS multiplies the number of seeds.
//
// What the per-bar identities do and do not establish (read before trusting a green run):
//   * equity == initial_capital + netprofit + openprofit and netprofit == grossprofit - grossloss are
//     close to tautologies of the implementation (equity() is that sum; netprofit is derived from the
//     gross totals). They are kept as regression guards; the evidence is the recomputation below.
//   * netprofit is recomputed from the closed trades' own profits and the open trades' entry
//     commissions (CHANGELOG 836fdc1: grossloss "includes the open trades' entry fees"):
//         netprofit == sum(closedtrades.profit(i)) - sum(opentrades.commission(i))
//   * each closed trade's profit is recomputed from its prices, size and commission; the open
//     position's size, average price and open profit from the open trades.
//   * every fill price lies in [low, high] of its fill bar, widened by the slippage in ticks (a slipped
//     fill is not re-snapped to the bar's range, strategy.ts slipped()).
//
// MIRROR SYMMETRY, stated precisely (the task's "equal and opposite" splits in two):
//   * M1 same data, long and short swapped, market orders only, no costs: every trade is the exact
//     opposite (fills do not depend on direction), so net profit, open profit and position size are
//     exactly OPPOSITE.
//   * M2 price path mirrored (p' = 2K - p, high' = 2K - low, low' = 2K - high) AND directions swapped:
//     a long that gains when p rises becomes a short that gains when p' falls, so net profit is
//     EQUAL, the position size opposite, and prices mirror. Limit/stop levels and bracket exits are
//     expressed in ticks off the close/entry, so the text of the script does not change. Tick
//     snapping rounds away from the market, which mirrors too (ceil <-> floor) as 2K is on the
//     0.01 tick grid. Sizes are explicit: percent_of_equity / cash sizing divides by the price
//     level, which does not mirror, so those are excluded here.

import { afterAll, describe, expect, it } from "vitest";
import {
  EPS,
  compileScript,
  flushReport,
  head,
  makeBars,
  propSeeds,
  reportRow,
  streamScript,
  type Bars,
  type Out,
} from "../helpers/prop_util";
import { genStrategy, withProps, STRAT_PLOTS, TRADE_ARRAYS, type StrategyCase, type StrategyGenOptions } from "../helpers/prop_strategy";
import type { Context } from "../../src/runtime/context";
import { StrategyState } from "../../src/runtime/strategy";

const N = 300;
const MINTICK = 0.01;

interface RunData {
  out: Out;
  ctx: Context;
  recs: ClosedRec[];
  vars: Record<string, unknown>;
}

// The fields of ctx.strategy.closedTradeRecords the checks read (StrategyState is a public type;
// the record type is not exported).
interface ClosedRec {
  entryPrice: number;
  exitPrice: number;
  entryBarIndex: number;
  exitBarIndex: number;
  entryId: string;
  exitId: string | null;
  profit: number;
  size: number;
  commission: number;
}

function runCase(c: StrategyCase, data: Bars): RunData {
  const tr = compileScript(c.source, c.options);
  const { out, ctx, vars } = streamScript(tr, data);
  const warn = ctx.diagnostics.messages;
  if (warn.length > 0) throw new Error(`run warnings: ${warn.join(" | ")} (${c.desc})`);
  return { out, ctx, vars, recs: ctx.strategy.closedTradeRecords as unknown as ClosedRec[] };
}

const ctxLabel = (c: StrategyCase): string => `${c.desc}\n--- script ---\n${c.source}\n--- options ---\n${JSON.stringify(c.options)}`;

const stats = { cases: 0, bars: 0, trades: 0, withShort: 0, withSlip: 0, withComm: 0, pyr: 0 };
let tradesSeen = 0;

// ---------------------------------------------------------------------------------------------

/** Every identity of the header, per bar and per trade; returns the violations. */
function accountingViolations(c: StrategyCase, data: Bars): { fail: string[]; run: RunData } {
  const run = runCase(c, data);
  const { out, recs, ctx } = run;
  const p = out.plots;
  const ic = ctx.strategy.initialCapital;
  const fail: string[] = [];
  const check = (bar: number, what: string, a: number, b: number, tol: number): void => {
    if (!(Math.abs(a - b) <= tol)) fail.push(`bar ${bar}: ${what}: ${a} vs ${b} (|diff|=${Math.abs(a - b)} > ${tol})`);
  };
  let prevLots = 0;
  let prevClosed = 0;
  for (let i = 0; i < N; i++) {
    const v = (k: (typeof STRAT_PLOTS)[number]): number => p[k]![i]!;
    const equity = v("equity");
    const net = v("net");
    const open = v("open");
    const pos = v("pos");
    const close = data.close[i]!;
    // self-consistency (near-tautology): the account sums
    check(i, "equity = initial_capital + netprofit + openprofit", equity, ic + net + open, 8 * EPS * Math.max(ic, Math.abs(equity)));
    check(i, "netprofit = grossprofit - grossloss", net, v("gp") - v("gl"), 1e-9 * (1 + v("gp") + v("gl")));
    // reference: netprofit from the closed trades' profits and the open trades' entry fees
    check(i, "netprofit = sum(closed profit) - sum(open commission)", net, v("sumClosed") - v("sumOpenComm"), 1e-9 * (1 + v("gp") + v("gl")));
    // counts
    if (v("wins") + v("losses") + v("evens") !== v("closed")) fail.push(`bar ${i}: wins+losses+evens != closedtrades`);
    if (v("closed") < prevClosed) fail.push(`bar ${i}: closedtrades decreased`);
    prevClosed = v("closed");
    // conservation of quantity: closed lots + open lots = every entry fill so far, never decreasing
    if (v("sumLots") + 1e-9 < prevLots) fail.push(`bar ${i}: quantity entered decreased (${prevLots} -> ${v("sumLots")})`);
    prevLots = v("sumLots");
    // reference: the open position from the open trades
    check(i, "position_size = sum(opentrades.size)", pos, v("sumOpenSize"), 1e-9 * (1 + Math.abs(pos)));
    if (pos !== 0) {
      const avg = v("avg");
      check(i, "position_avg_price = size-weighted mean of the open entry prices", avg, v("wAvg"), 1e-9 * avg);
    } else if (v("opent") !== 0) {
      fail.push(`bar ${i}: flat but opentrades=${v("opent")}`);
    }
    check(i, "openprofit = sum((close - entry) * size)", open, v("sumOpenPnl"), 64 * EPS * Math.abs(pos) * close + 1e-9);
  }
  // The commission of one closing ORDER is rounded to 10 significant digits as a whole (a relative
  // error of 5e-10 of the ORDER's fee, in absolute terms 1e-6 for a fee near 2000) and then shared
  // over the trades it closes, each leg being charged what its share adds to the shares already
  // booked (strategy.ts bookCommission). A small trade closed together with a big one therefore carries
  // an absolute rounding error of the big order's size (seen: +-1e-7 on a 0.8 fee next to a 1000 fee).
  // Per record the bound is thus relative to the fees booked on its exit bar.
  const feesOnExitBar = new Map<number, number>();
  for (const r of recs) feesOnExitBar.set(r.exitBarIndex, (feesOnExitBar.get(r.exitBarIndex) ?? 0) + r.commission);
  // reference: per closed trade
  const lo = data.low;
  const hi = data.high;
  const slip = (c.options.strategy?.slippage ?? 0) * MINTICK;
  let lastExit = -1;
  for (const [k, r] of recs.entries()) {
    const where = `trade ${k} (${r.entryId} -> ${r.exitId})`;
    check(r.exitBarIndex, `${where}: profit = (exit - entry) * size - commission`, r.profit, (r.exitPrice - r.entryPrice) * r.size - r.commission, 64 * EPS * (Math.abs(r.entryPrice) + Math.abs(r.exitPrice)) * Math.abs(r.size) + 1e-9);
    if (r.commission < 0) fail.push(`${where}: negative commission ${r.commission}`);
    // reference: the fee schedule recomputed from the fill prices. Every filled order pays rate x its
    // quantity at its fill price (props.txt: commission "is applied on both entries and exits"), and a
    // fee shared over an order's legs is shared pro rata to quantity at one price, so a closed trade's
    // commission is its entry leg plus its exit leg. Each cash flow is rounded to 10 significant
    // digits (<= 5e-10 relative to the order's fee) and shared again, hence feeTol below. cash_per_order is one
    // flat amount per ORDER split over several trades: only bounded.
    const feeTol = 2e-9 * (r.commission + (feesOnExitBar.get(r.exitBarIndex) ?? 0)) + 1e-9;
    const ct = c.options.strategy?.commission_type;
    const cv = c.options.strategy?.commission_value ?? 0;
    const q = Math.abs(r.size);
    if (ct === "percent") {
      const want = ((r.entryPrice + r.exitPrice) * q * cv) / 100;
      if (!(Math.abs(r.commission - want) <= feeTol)) fail.push(`${where}: commission ${r.commission} vs (entry + exit) * size * ${cv}% = ${want}`);
    } else if (ct === "cash_per_contract") {
      const want = 2 * q * cv;
      if (!(Math.abs(r.commission - want) <= feeTol)) fail.push(`${where}: commission ${r.commission} vs 2 * size * ${cv} = ${want}`);
    } else if (ct === "cash_per_order" && !(r.commission <= 2 * cv + 1e-9)) {
      fail.push(`${where}: cash_per_order commission ${r.commission} exceeds one fee per leg (2 * ${cv})`);
    } else if (ct === undefined && r.commission !== 0) {
      fail.push(`${where}: commission ${r.commission} without a commission setting`);
    }
    if (!(r.entryBarIndex >= 0 && r.entryBarIndex <= r.exitBarIndex && r.exitBarIndex < N)) fail.push(`${where}: bars ${r.entryBarIndex}..${r.exitBarIndex}`);
    if (r.exitBarIndex < lastExit) fail.push(`${where}: closed trades not in exit order`);
    lastExit = r.exitBarIndex;
    for (const [side, price, b] of [["entry", r.entryPrice, r.entryBarIndex], ["exit", r.exitPrice, r.exitBarIndex]] as const) {
      if (!(price >= lo[b]! - slip - 1e-9 && price <= hi[b]! + slip + 1e-9)) {
        fail.push(`${where}: ${side} price ${price} outside bar ${b} [${lo[b]}, ${hi[b]}] +- slippage ${slip}`);
      }
    }
  }
  // The per-bar closedtrades count is the number of records exited so far. With
  // process_orders_on_close an order placed on bar b fills at b's close, AFTER the body ran, so the
  // body of bar b cannot count a trade that exits there: the plot lies between the records exited
  // before b and those exited by b (equal when the strategy has no such fills).
  const pooc = c.options.strategy?.process_orders_on_close === true;
  {
    let upTo = 0; // records with exitBarIndex <= i
    let before = 0; // records with exitBarIndex < i
    for (let i = 0; i < N; i++) {
      before = upTo;
      while (upTo < recs.length && recs[upTo]!.exitBarIndex <= i) upTo++;
      const closedNow = p["closed"]![i]!;
      if (pooc ? !(closedNow >= before && closedNow <= upTo) : closedNow !== upTo) {
        fail.push(`bar ${i}: closedtrades=${closedNow} but ${before}..${upTo} records have exited${pooc ? " (process_orders_on_close)" : ""}`);
        break;
      }
    }
  }
  // the records the last bar's body could see (all of them unless an order filled at the last close)
  const seenRecs = recs.slice(0, p["closed"]![N - 1]!);
  // The strategy.closedtrades.* ACCESSORS (what a script reads) against the engine's own records, field
  // by field, bit for bit: entry/exit price, entry/exit bar index, size, profit, commission of every
  // trade the last bar could see.
  for (const [field, varName] of Object.entries(TRADE_ARRAYS) as Array<[keyof typeof TRADE_ARRAYS, string]>) {
    const got = (run.vars[varName] ?? []) as number[];
    if (got.length !== seenRecs.length) {
      fail.push(`accessor read-back of ${field}: ${got.length} values for ${seenRecs.length} closed trades`);
      continue;
    }
    for (let k = 0; k < got.length; k++) {
      if (!Object.is(got[k], seenRecs[k]![field])) {
        fail.push(`strategy.closedtrades accessor for ${field}(${k}) = ${got[k]} but the engine's record has ${seenRecs[k]![field]}`);
        break;
      }
    }
  }
  // the win/loss/even counters and the gross totals from the records
  {
    const last = N - 1;
    const wins = seenRecs.filter((r) => r.profit > 0).length;
    const losses = seenRecs.filter((r) => r.profit < 0).length;
    const evens = seenRecs.length - wins - losses;
    if (p["wins"]![last] !== wins || p["losses"]![last] !== losses || p["evens"]![last] !== evens) fail.push(`wins/losses/evens ${p["wins"]![last]}/${p["losses"]![last]}/${p["evens"]![last]} vs records ${wins}/${losses}/${evens}`);
    const gp = seenRecs.filter((r) => r.profit > 0).reduce((a, r) => a + r.profit, 0);
    const gl = -seenRecs.filter((r) => r.profit < 0).reduce((a, r) => a + r.profit, 0);
    check(last, "grossprofit = sum of the winning records", p["gp"]![last]!, gp, 1e-9 * (1 + gp));
    // reported grossloss includes the open trades' entry fees (CHANGELOG 836fdc1)
    check(last, "grossloss = sum of the losing records + open entry fees", p["gl"]![last]!, gl + p["sumOpenComm"]![last]!, 1e-9 * (1 + gl));
    const lots = seenRecs.reduce((a, r) => a + Math.abs(r.size), 0) + Math.abs(p["sumOpenSize"]![last]!);
    check(last, "quantity entered = closed lots + open lots", p["sumLots"]![last]!, lots, 1e-9 * (1 + lots));
  }
  // the accessor read-back and the engine's own records agree
  const sumRecs = seenRecs.reduce((a, r) => a + r.profit, 0);
  check(N - 1, "sum(closedtrades.profit(i)) = sum of the records' profit", p["sumClosed"]![N - 1]!, sumRecs, 1e-9 * (1 + Math.abs(sumRecs)));
  if (!pooc && recs.length !== p["closed"]![N - 1]!) fail.push(`records ${recs.length} != closedtrades ${p["closed"]![N - 1]}`);
  return { fail, run };
}

describe("self-consistency + reference (independent implementation in this test): account identities per bar", () => {
  for (const seed of propSeeds(100, 14)) {
    it(`seed ${seed}: identities hold on every one of ${N} bars`, () => {
      const c = genStrategy(seed, { fillModes: true });
      const { fail, run } = accountingViolations(c, makeBars(N, seed));
      stats.cases++;
      stats.bars += N;
      stats.trades += run.recs.length;
      tradesSeen += run.recs.length;
      if (run.recs.some((r) => r.size < 0)) stats.withShort++;
      if (c.options.strategy?.slippage) stats.withSlip++;
      if (c.options.strategy?.commission_value) stats.withComm++;
      if ((c.options.strategy?.pyramiding ?? 1) > 1) stats.pyr++;
      expect(fail, `${fail.length} identity violation(s)\n  ${head(fail)}\n${ctxLabel(c)}`).toEqual([]);
    });
  }

  it("the random strategies exercise trades, shorts, costs and pyramiding (the identities are not vacuous)", () => {
    expect(stats.cases).toBeGreaterThan(0);
    expect(tradesSeen / stats.cases).toBeGreaterThan(8);
    expect(stats.withShort).toBeGreaterThan(0);
    expect(stats.withSlip).toBeGreaterThan(0);
    expect(stats.withComm).toBeGreaterThan(0);
    expect(stats.pyr).toBeGreaterThan(0);
  });

  // The checks must be able to fail: tamper with the engine (restored in `finally`) and expect the
  // identities to notice. Vitest isolates module state per test file, so the patch cannot leak.
  it("canary: the identities detect a tampered openProfit and a tampered equity", () => {
    const proto = StrategyState.prototype as unknown as Record<string, (...a: number[]) => number>;
    const c = genStrategy(100);
    const data = makeBars(N, 100);
    for (const [method, delta] of [["openProfit", 0.01], ["equity", 0.01]] as const) {
      const original = proto[method]!;
      proto[method] = function (this: unknown, ...a: number[]) {
        return original.apply(this, a) + delta;
      };
      try {
        expect(accountingViolations(c, data).fail.length, `${method} tampered by ${delta}`).toBeGreaterThan(0);
      } finally {
        proto[method] = original;
      }
    }
    expect(accountingViolations(c, data).fail).toEqual([]); // and the engine is back to normal
  });
});

// ---------------------------------------------------------------------------------------------

describe("reference (independent implementation in this test): fill bars and prices on a hand-built 5-bar run", () => {
  it("entry_bar_index is the bar the entry FILLED on (next open), exit_bar_index likewise", () => {
    const d: Bars = {
      open: [100, 101, 103, 102, 98],
      high: [102, 104, 105, 103, 99],
      low: [99, 100, 101, 97, 96],
      close: [101, 103, 102, 98, 97],
      volume: [1, 1, 1, 1, 1],
      time: [0, 1, 2, 3, 4].map((i) => Date.UTC(2020, 0, 1) + i * 3_600_000),
    };
    const src = [
      "//@version=5",
      'strategy("hand", overlay=true)',
      "if bar_index == 0",
      '    strategy.entry("L", strategy.long, qty=2)',
      "if bar_index == 2",
      '    strategy.close("L")',
      'plot(strategy.closedtrades, "closed")',
    ].join("\n");
    const tr = compileScript(src, { strategy: { initial_capital: 10000, margin_long: 0, margin_short: 0 } });
    const { ctx } = streamScript(tr, d);
    const recs = ctx.strategy.closedTradeRecords as unknown as ClosedRec[];
    expect(recs).toHaveLength(1);
    // ordered on bar 0 -> fills at bar 1's open (101); closed on bar 2 -> fills at bar 3's open (102)
    expect([recs[0]!.entryBarIndex, recs[0]!.entryPrice, recs[0]!.exitBarIndex, recs[0]!.exitPrice, recs[0]!.size, recs[0]!.profit]).toEqual([1, 101, 3, 102, 2, 2]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("reference (independent implementation in this test): the fee schedule on a hand-built run", () => {
  // Flat price 100, A (2 lots) fills at bar 1, B (3 lots) at bar 2, close_all fills at bar 5.
  // Hand-computed per closed trade = its entry order's fee + its share of the closing order's fee:
  //   cash_per_order 1.5     one flat fee per ORDER: A 1.5 + 1.5 * 2/5 = 2.1,  B 1.5 + 1.5 * 3/5 = 2.4
  //   cash_per_contract .05  per lot, both legs:     A 2 * .05 * 2 = 0.2,      B 3 * .05 * 2 = 0.3
  //   percent 0.1%           of the traded value:    A (100 + 100) * 2 * .001 = 0.4,  B = 0.6
  const d: Bars = {
    open: Array(8).fill(100), high: Array(8).fill(101), low: Array(8).fill(99), close: Array(8).fill(100), volume: Array(8).fill(1),
    time: Array.from({ length: 8 }, (_, i) => Date.UTC(2020, 0, 1) + i * 3_600_000),
  };
  const src = [
    "//@version=5", 'strategy("fees", overlay=true)',
    "if bar_index == 0", '    strategy.entry("A", strategy.long, qty=2)',
    "if bar_index == 1", '    strategy.entry("B", strategy.long, qty=3)',
    "if bar_index == 4", "    strategy.close_all()",
    'plot(strategy.netprofit, "net")',
  ].join("\n");
  for (const [type, value, a, b] of [["cash_per_order", 1.5, 2.1, 2.4], ["cash_per_contract", 0.05, 0.2, 0.3], ["percent", 0.1, 0.4, 0.6]] as const) {
    it(`${type} ${value}: trade A pays ${a}, trade B ${b}, and netprofit is minus their sum`, () => {
      const tr = compileScript(src, { strategy: { initial_capital: 100000, pyramiding: 3, commission_type: type, commission_value: value, margin_long: 0, margin_short: 0 } });
      const { ctx, out } = streamScript(tr, d);
      const recs = ctx.strategy.closedTradeRecords as unknown as ClosedRec[];
      expect(recs.map((r) => r.entryId)).toEqual(["A", "B"]);
      expect(recs[0]!.commission).toBeCloseTo(a, 9);
      expect(recs[1]!.commission).toBeCloseTo(b, 9);
      expect(recs[0]!.profit + recs[0]!.commission).toBeCloseTo(0, 9); // flat price: all of A's loss is its fee
      expect(out.plots["net"]![7]).toBeCloseTo(-(a + b), 9);
    });
  }
});

// ---------------------------------------------------------------------------------------------

const commTrades = { count: 0, cases: 0 };

describe("self-consistency: commission is additive (zero slippage, fixed sizes, no margin)", () => {
  const TYPES = [
    ["cash_per_order", 1.5],
    ["percent", 0.1],
    ["cash_per_contract", 0.05],
  ] as const;
  for (const seed of propSeeds(300, 3)) {
    for (const [type, c] of TYPES) {
      it(`seed ${seed}, ${type} ${c}: net(2c) - net(c) == net(c) - net(0) on every bar, same trades`, () => {
        const base = genStrategy(seed, { fixedQty: true, costFree: true });
        const data = makeBars(N, seed);
        const r0 = runCase(base, data);
        const r1 = runCase(withProps(base, { commission_type: type, commission_value: c }), data);
        const r2 = runCase(withProps(base, { commission_type: type, commission_value: 2 * c }), data);
        const fail: string[] = [];
        for (const key of ["net", "equity"] as const) {
          const a = r0.out.plots[key]!;
          const b = r1.out.plots[key]!;
          const d2 = r2.out.plots[key]!;
          for (let i = 0; i < N; i++) {
            // Fees booked so far at c and 2c (f1, f2). Each order's fee is rounded to 10 significant
            // digits (strategy.ts roundCash: a relative error up to 5e-10), then split over its legs
            // with each share rounded again, so the residual of net(2c) - 2 net(c) + net(0) is
            // bounded by a few 5e-10 of the fees booked: tol = 1e-8 * (f1 + f2) (that is ~3 roundings
            // of two fee streams with 4x slack), plus the float error of the sums (a few ulps of
            // the magnitudes involved).
            const f1 = Math.abs(a[i]! - b[i]!);
            const f2 = Math.abs(a[i]! - d2[i]!);
            const tol = 1e-8 * (f1 + f2) + 16 * EPS * (Math.abs(a[i]!) + Math.abs(b[i]!) + Math.abs(d2[i]!)) + (key === "equity" ? 8 * EPS * r0.ctx.strategy.initialCapital : 0);
            if (!(Math.abs(d2[i]! - b[i]! - (b[i]! - a[i]!)) <= tol)) fail.push(`${key} bar ${i}: ${a[i]}, ${b[i]}, ${d2[i]} (residual ${d2[i]! - 2 * b[i]! + a[i]!} > ${tol})`);
          }
        }
        // identical trades: only the commission (and so the profit) changes
        if (r0.recs.length !== r1.recs.length || r0.recs.length !== r2.recs.length) fail.push(`trade counts ${r0.recs.length}/${r1.recs.length}/${r2.recs.length}`);
        else {
          for (const [k, t0] of r0.recs.entries()) {
            const t1 = r1.recs[k]!;
            const t2 = r2.recs[k]!;
            if (![t1, t2].every((t) => t.entryBarIndex === t0.entryBarIndex && t.exitBarIndex === t0.exitBarIndex && Object.is(t.entryPrice, t0.entryPrice) && Object.is(t.exitPrice, t0.exitPrice) && t.size === t0.size)) {
              fail.push(`trade ${k} differs between commission levels`);
            }
            // per record the fee is a share of an order's rounded fee (10 significant digits, then shared over the legs): 1e-7 relative
            if (!(Math.abs(t2.commission - 2 * t1.commission) <= 1e-7 * (t1.commission + t2.commission) + 1e-9)) fail.push(`trade ${k}: commission ${t1.commission} vs ${t2.commission}`);
            if (!(Math.abs(t1.profit - (t0.profit - t1.commission)) <= 64 * EPS * (Math.abs(t0.profit) + t1.commission) + 1e-9)) fail.push(`trade ${k}: profit not reduced by exactly its commission`);
          }
        }
        commTrades.count += r1.recs.length;
        commTrades.cases++;
        expect(fail, `${fail.length} violation(s)\n  ${head(fail)}\n${ctxLabel(base)}\ncommission ${type} ${c}`).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------

/**
 * Compare two closed-trade lists that should be mirror images. `priceMap` maps A's price to the price B
 * must have (identity for M1, 2K - p for M2).
 *
 * DOCUMENTED ASYMMETRY (CHANGELOG 78f3320): "Two opposite orders filled at the same moment book their
 * closed trade long side first (its entry/exit ids and the sign of its size)". Such a record opens
 * and closes at one price on one bar, so its profit is 0 either way; only the sign of its size and
 * its ids depend on which side is the long one. For it the mirror is asserted on the size's
 * magnitude, the bars, the price and the zero profit.
 */
function recordMirrorFailures(ra: ClosedRec[], rb: ClosedRec[], priceMap: (p: number) => number, priceTol: number): string[] {
  const fail: string[] = [];
  if (ra.length !== rb.length) fail.push(`trade counts ${ra.length} vs ${rb.length}`);
  for (const [k, t] of ra.entries()) {
    const u = rb[k];
    if (u === undefined) break;
    const samePairing = t.entryBarIndex === t.exitBarIndex && t.entryPrice === t.exitPrice;
    const sizeOk = samePairing ? Math.abs(u.size) === Math.abs(t.size) : u.size === -t.size;
    const pricesOk = Math.abs(u.entryPrice - priceMap(t.entryPrice)) <= priceTol && Math.abs(u.exitPrice - priceMap(t.exitPrice)) <= priceTol;
    const barsOk = u.entryBarIndex === t.entryBarIndex && u.exitBarIndex === t.exitBarIndex;
    const zeroOk = !samePairing || (t.profit === 0 && u.profit === 0);
    if (!(sizeOk && pricesOk && barsOk && zeroOk)) {
      fail.push(`trade ${k}: ${t.entryId}/${t.exitId} ${t.entryBarIndex}->${t.exitBarIndex} ${t.entryPrice}->${t.exitPrice} x${t.size}  vs  ${u.entryId}/${u.exitId} ${u.entryBarIndex}->${u.exitBarIndex} ${u.entryPrice}->${u.exitPrice} x${u.size}${samePairing ? " (same-moment pairing)" : ""}`);
    }
  }
  return fail;
}

const mirrorTrades = { count: 0, cases: 0 };

function mirrorBars(d: Bars, twoK: number): Bars {
  return {
    open: d.open.map((v) => twoK - v),
    high: d.low.map((v) => twoK - v),
    low: d.high.map((v) => twoK - v),
    close: d.close.map((v) => twoK - v),
    volume: d.volume.slice(),
    time: d.time.slice(),
  };
}

describe("self-consistency: mirror symmetry", () => {
  const costFreeMarket: StrategyGenOptions = { marketOnly: true, fixedQty: true, costFree: true };
  for (const seed of propSeeds(500, 4)) {
    it(`M1 seed ${seed}: same data, long and short swapped, market orders: net, open profit and position are exactly opposite`, () => {
      const a = genStrategy(seed, costFreeMarket);
      const b = genStrategy(seed, { ...costFreeMarket, swap: true });
      const data = makeBars(N, seed);
      const ra = runCase(a, data);
      const rb = runCase(b, data);
      const fail: string[] = [];
      for (let i = 0; i < N; i++) {
        // a mirrored trade list wins where the other loses; zero-profit trades stay even
        const wl = [ra.out.plots["wins"]![i], rb.out.plots["losses"]![i], ra.out.plots["losses"]![i], rb.out.plots["wins"]![i], ra.out.plots["evens"]![i], rb.out.plots["evens"]![i]] as const;
        if (wl[0] !== wl[1] || wl[2] !== wl[3] || wl[4] !== wl[5]) fail.push(`wins/losses/evens bar ${i}: A ${wl[0]}/${wl[2]}/${wl[4]} vs B ${wl[3]}/${wl[1]}/${wl[5]}`);
        for (const key of ["net", "open", "pos"] as const) {
          const x = ra.out.plots[key]![i]!;
          const y = rb.out.plots[key]![i]!;
          if (!(Math.abs(x + y) <= 8 * EPS * (1 + Math.abs(x) * 100))) fail.push(`${key} bar ${i}: ${x} vs ${y}`);
        }
        const ic = ra.ctx.strategy.initialCapital;
        const ex = ra.out.plots["equity"]![i]! - ic;
        const ey = rb.out.plots["equity"]![i]! - ic;
        if (!(Math.abs(ex + ey) <= 8 * EPS * ic + 1e-9)) fail.push(`equity-IC bar ${i}: ${ex} vs ${ey}`);
      }
      fail.push(...recordMirrorFailures(ra.recs, rb.recs, (p) => p, 0));
      mirrorTrades.count += ra.recs.length;
      mirrorTrades.cases++;
      expect(fail, `${fail.length} violation(s)\n  ${head(fail)}\n${ctxLabel(a)}`).toEqual([]);
    });
  }

  for (const seed of propSeeds(600, 5)) {
    it(`M2 seed ${seed}: mirrored prices (2K - p) and swapped directions: net profit EQUAL, position opposite, prices mirrored`, () => {
      // limit/stop entries (tick priced) and tick brackets included; fixed sizes, no costs.
      const o: StrategyGenOptions = { fixedQty: true, costFree: true };
      const a = genStrategy(seed, o);
      const b = genStrategy(seed, { ...o, swap: true });
      const data = makeBars(N, seed);
      const twoK = 400;
      const ra = runCase(a, data);
      const rb = runCase(b, mirrorBars(data, twoK));
      const fail: string[] = [];
      for (let i = 0; i < N; i++) {
        const nx = ra.out.plots["net"]![i]!;
        const ny = rb.out.plots["net"]![i]!;
        if (!(Math.abs(nx - ny) <= 1e-9 * (1 + Math.abs(nx)))) fail.push(`net bar ${i}: ${nx} vs ${ny}`);
        const px = ra.out.plots["pos"]![i]!;
        const py = rb.out.plots["pos"]![i]!;
        if (px !== -py) fail.push(`pos bar ${i}: ${px} vs ${py}`);
      }
      fail.push(...recordMirrorFailures(ra.recs, rb.recs, (p) => twoK - p, 1e-9));
      mirrorTrades.count += ra.recs.length;
      mirrorTrades.cases++;
      expect(fail, `${fail.length} violation(s)\n  ${head(fail)}\n${ctxLabel(a)}`).toEqual([]);
    });
  }
});

describe("self-consistency: the symmetry and additivity properties are not vacuous", () => {
  it("the commission, M1 and M2 cases close trades on average", () => {
    expect(commTrades.cases).toBeGreaterThan(0);
    expect(commTrades.count / commTrades.cases).toBeGreaterThan(5);
    expect(mirrorTrades.cases).toBeGreaterThan(0);
    expect(mirrorTrades.count / mirrorTrades.cases).toBeGreaterThan(5);
  });
});

afterAll(() => {
  reportRow(`cases=${stats.cases} bars=${stats.bars} closed trades=${stats.trades} (cases with a short: ${stats.withShort}, slippage: ${stats.withSlip}, commission: ${stats.withComm}, pyramiding>1: ${stats.pyr})`);
  flushReport("strategy_accounting");
});
