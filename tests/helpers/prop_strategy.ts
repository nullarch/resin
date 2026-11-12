// Seeded random strategy scripts for the property tier.
//
// Design: every order is driven by a bar_index schedule (`bar_index % period == remainder`), never by
// equity, netprofit or an indicator. So the order intents are identical across runs that change only
// costs, sizes, data scale or mirror the price path, and a property can state exactly what changes.
// Strategy properties (initial capital, sizing, pyramiding, commission, slippage, margin) are NOT in
// the script: they go through transpile(src, { strategy: {...} }), the Properties tab.
//
// The script ends with a read-back block that plots, per bar, the account variables and quantities
// recomputed from the strategy.closedtrades.* / strategy.opentrades.* accessors; the accounting tests
// compare the two. The loops are guarded: Pine's `for i = 0 to -1` counts DOWN (0, -1).

import type { AnalyzeOptions } from "../../src/transpiler/analyzer";
import { mulberry32 } from "./synthetic";

export interface StrategyCase {
  seed: number;
  source: string;
  options: AnalyzeOptions;
  /** one-line description for failure messages */
  desc: string;
}

export interface StrategyGenOptions {
  /** Market entries and strategy.close / close_all only: no limit/stop entries, no exit brackets. */
  marketOnly?: boolean;
  /** Every order carries an explicit qty (no default sizing: size is independent of equity and price). */
  fixedQty?: boolean;
  /** commission 0, slippage 0. */
  costFree?: boolean;
  /** Also draw process_orders_on_close / calc_on_order_fills (off for the symmetry properties). */
  fillModes?: boolean;
  /** Swap strategy.long and strategy.short everywhere; schedule, ids, sizes and exits stay identical. */
  swap?: boolean;
  /** Entries other than market ones are priced in ticks off the close, so they mirror with the data. */
  tickPricedOnly?: boolean;
}

interface Rule {
  kind: "entry" | "order" | "close" | "closeAll";
  side: 1 | -1;
  id: string;
  period: number;
  rem: number;
  qty: number;
  ordType: "market" | "limit" | "stop";
  offTicks: number;
}

interface ExitRule {
  id: string;
  from: string;
  profit: number;
  loss: number;
}

/** The var arrays the last bar fills with strategy.closedtrades.* accessor reads, by field. */
export const TRADE_ARRAYS = { entryPrice: "aEP", exitPrice: "aXP", entryBarIndex: "aEB", exitBarIndex: "aXB", size: "aSZ", profit: "aPR", commission: "aCM" } as const;

/** Plot titles of the read-back block, in order. */
export const STRAT_PLOTS = [
  "equity", "net", "open", "closed", "opent", "pos", "avg", "wins", "losses", "evens", "gp", "gl",
  "sumClosed", "sumOpenComm", "sumOpenPnl", "sumOpenSize", "wAvg", "sumLots",
] as const;

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (rand: () => number, lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));

export function genStrategy(seed: number, o: StrategyGenOptions = {}): StrategyCase {
  const rand = mulberry32(seed * 7919 + 17);
  const rules: Rule[] = [];
  const nEntries = int(rand, 1, 3);
  for (let k = 0; k < nEntries; k++) {
    const side = rand() < 0.5 ? 1 : -1;
    const isOrder = !o.marketOnly && rand() < 0.2;
    const ordType = o.marketOnly ? "market" : pick(rand, ["market", "market", "limit", "stop"] as const);
    rules.push({
      kind: isOrder ? "order" : "entry",
      side: side as 1 | -1,
      id: isOrder ? `O${k}` : side === 1 ? `L${k}` : `S${k}`,
      period: int(rand, 6, 38),
      rem: int(rand, 0, 5),
      qty: int(rand, 1, 4),
      ordType: isOrder ? "market" : ordType,
      offTicks: int(rand, 10, 80),
    });
  }
  const nCloses = int(rand, 1, 2); // at least one, so trades actually close
  for (let k = 0; k < nCloses; k++) {
    const target = rules[int(rand, 0, rules.length - 1)]!;
    rules.push({
      kind: rand() < 0.5 && target.kind === "entry" ? "close" : "closeAll",
      side: target.side,
      id: target.id,
      period: int(rand, 9, 45),
      rem: int(rand, 0, 8),
      qty: 0,
      ordType: "market",
      offTicks: 0,
    });
  }
  const exits: ExitRule[] = [];
  if (!o.marketOnly) {
    for (const r of rules) {
      if (r.kind === "entry" && rand() < 0.7) {
        exits.push({ id: `X${r.id}`, from: r.id, profit: int(rand, 40, 300), loss: int(rand, 40, 300) });
      }
    }
  }

  const dir = (side: number): string => ((side === 1) !== !!o.swap ? "strategy.long" : "strategy.short");
  const lines: string[] = ["//@version=5", 'strategy("prop", overlay=true)'];
  const qtyArg = (r: Rule): string => (o.fixedQty || rand() < 0.5 ? `, qty=${r.qty}` : "");
  for (const r of rules) {
    lines.push(`if bar_index % ${r.period} == ${r.rem}`);
    if (r.kind === "closeAll") {
      lines.push("    strategy.close_all()");
    } else if (r.kind === "close") {
      lines.push(`    strategy.close("${r.id}")`);
    } else {
      const call = r.kind === "order" ? "strategy.order" : "strategy.entry";
      // limit buys rest below the close, limit sells above; stop buys above, stop sells below. In
      // ticks off the close, so the price mirrors with the data (the script text does not change).
      const sgn = (r.side === 1) !== !!o.swap ? 1 : -1;
      const price =
        r.ordType === "limit"
          ? `, limit=close - ${sgn * r.offTicks} * syminfo.mintick`
          : r.ordType === "stop"
            ? `, stop=close + ${sgn * r.offTicks} * syminfo.mintick`
            : "";
      lines.push(`    ${call}("${r.id}", ${dir(r.side)}${qtyArg(r)}${price})`);
    }
  }
  for (const x of exits) lines.push(`strategy.exit("${x.id}", "${x.from}", profit=${x.profit}, loss=${x.loss})`);

  lines.push(
    "float sumClosed = 0.0",
    "float sumOpenComm = 0.0",
    "float sumOpenPnl = 0.0",
    "float sumOpenSize = 0.0",
    "float wNum = 0.0",
    "float sumLots = 0.0",
    "if strategy.closedtrades > 0",
    "    for i = 0 to strategy.closedtrades - 1",
    "        sumClosed += strategy.closedtrades.profit(i)",
    "        sumLots += math.abs(strategy.closedtrades.size(i))",
    "if strategy.opentrades > 0",
    "    for i = 0 to strategy.opentrades - 1",
    "        sumOpenComm += strategy.opentrades.commission(i)",
    "        sumOpenPnl += (close - strategy.opentrades.entry_price(i)) * strategy.opentrades.size(i)",
    "        sumOpenSize += strategy.opentrades.size(i)",
    "        wNum += strategy.opentrades.entry_price(i) * strategy.opentrades.size(i)",
    "        sumLots += math.abs(strategy.opentrades.size(i))",
    // per-trade read-back through the strategy.closedtrades.* accessors, taken on the last bar
    "var array<float> aEP = array.new_float()",
    "var array<float> aXP = array.new_float()",
    "var array<float> aEB = array.new_float()",
    "var array<float> aXB = array.new_float()",
    "var array<float> aSZ = array.new_float()",
    "var array<float> aPR = array.new_float()",
    "var array<float> aCM = array.new_float()",
    "if barstate.islast and strategy.closedtrades > 0",
    "    for i = 0 to strategy.closedtrades - 1",
    "        array.push(aEP, strategy.closedtrades.entry_price(i))",
    "        array.push(aXP, strategy.closedtrades.exit_price(i))",
    "        array.push(aEB, strategy.closedtrades.entry_bar_index(i))",
    "        array.push(aXB, strategy.closedtrades.exit_bar_index(i))",
    "        array.push(aSZ, strategy.closedtrades.size(i))",
    "        array.push(aPR, strategy.closedtrades.profit(i))",
    "        array.push(aCM, strategy.closedtrades.commission(i))",
    'plot(strategy.equity, "equity")',
    'plot(strategy.netprofit, "net")',
    'plot(strategy.openprofit, "open")',
    'plot(strategy.closedtrades, "closed")',
    'plot(strategy.opentrades, "opent")',
    'plot(strategy.position_size, "pos")',
    'plot(strategy.position_avg_price, "avg")',
    'plot(strategy.wintrades, "wins")',
    'plot(strategy.losstrades, "losses")',
    'plot(strategy.eventrades, "evens")',
    'plot(strategy.grossprofit, "gp")',
    'plot(strategy.grossloss, "gl")',
    'plot(sumClosed, "sumClosed")',
    'plot(sumOpenComm, "sumOpenComm")',
    'plot(sumOpenPnl, "sumOpenPnl")',
    'plot(sumOpenSize, "sumOpenSize")',
    'plot(sumOpenSize != 0.0 ? wNum / sumOpenSize : na, "wAvg")',
    'plot(sumLots, "sumLots")',
  );

  // ---- strategy properties ----
  const sizing = o.fixedQty ? "fixed" : pick(rand, ["fixed", "percent", "cash"] as const);
  const strategyOptions: NonNullable<AnalyzeOptions["strategy"]> = {
    initial_capital: pick(rand, [100000, 1000000]),
    pyramiding: pick(rand, [1, 1, 2, 4]),
    margin_long: 0,
    margin_short: 0,
  };
  if (sizing === "percent") {
    strategyOptions.default_qty_type = "percent_of_equity";
    strategyOptions.default_qty_value = pick(rand, [5, 10, 25, 50]);
  } else if (sizing === "cash") {
    strategyOptions.default_qty_type = "cash";
    strategyOptions.default_qty_value = pick(rand, [3000, 8000, 20000]);
  } else {
    strategyOptions.default_qty_value = int(rand, 1, 3);
  }
  let modes = "";
  if (o.fillModes) {
    if (rand() < 0.15) {
      strategyOptions.process_orders_on_close = true;
      modes += " process_orders_on_close";
    }
    if (rand() < 0.1) {
      strategyOptions.calc_on_order_fills = true;
      modes += " calc_on_order_fills";
    }
  }
  let costs = "none";
  if (!o.costFree) {
    const type = pick(rand, ["none", "percent", "cash_per_order", "cash_per_contract"] as const);
    if (type !== "none") {
      strategyOptions.commission_type = type;
      strategyOptions.commission_value = type === "percent" ? pick(rand, [0.04, 0.1, 0.25]) : pick(rand, [0.5, 2, 5]) * (type === "cash_per_contract" ? 0.05 : 1);
      costs = `${type} ${strategyOptions.commission_value}`;
    }
    const slip = pick(rand, [0, 0, 1, 3]);
    if (slip > 0) strategyOptions.slippage = slip;
    if (slip > 0) costs += ` slippage ${slip}`;
  }
  const desc = `seed ${seed}: ${rules.map((r) => `${r.kind}${r.ordType === "market" ? "" : "/" + r.ordType}(${r.side > 0 ? "long" : "short"} ${r.id} %${r.period}==${r.rem})`).join(" ")}; ` +
    `exits ${exits.length};${modes} sizing ${sizing}${strategyOptions.default_qty_type ? " " + strategyOptions.default_qty_value : ""}; pyramiding ${strategyOptions.pyramiding}; costs ${costs}`;
  return { seed, source: lines.join("\n"), options: { strategy: strategyOptions }, desc };
}

/** Same case with other strategy properties merged over its own (for the cost-doubling property). */
export function withProps(c: StrategyCase, props: NonNullable<AnalyzeOptions["strategy"]>): StrategyCase {
  return { ...c, options: { ...c.options, strategy: { ...c.options.strategy, ...props } } };
}
