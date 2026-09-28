// transpile's `strategy` option: TradingView's strategy "Properties" tab. Each given key replaces
// the script's strategy() argument (or its default), so a caller can measure many scripts under
// one set of rules without editing their sources.
import { describe, expect, it } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { run } from "../../src/runtime/engine";
import { Context } from "../../src/runtime/context";
import { compile } from "../../src/runtime/engine";
import type { OHLCVData } from "../../src/runtime/context";
import type { StrategyPropertyOptions } from "../../src/transpiler/analyzer";

function bars(rows: number[][]): OHLCVData {
  const t0 = Date.UTC(2024, 0, 1);
  return {
    open: rows.map((r) => r[0]!),
    high: rows.map((r) => r[1]!),
    low: rows.map((r) => r[2]!),
    close: rows.map((r) => r[3]!),
    volume: rows.map(() => 100),
    time: rows.map((_, i) => t0 + i * 86_400_000),
  };
}

// Enter on bar 0, close on bar 2: filled at bar 1's and bar 3's open (or at those bars' closes
// with process_orders_on_close).
const DATA = bars([
  [100, 101, 99, 100],
  [100, 101, 99, 101],
  [110, 111, 109, 110],
  [120, 121, 119, 120],
  [120, 121, 119, 120],
]);

function trades(src: string, strategy?: StrategyPropertyOptions) {
  const r = transpile(src, { chartTf: "D", strategy });
  if (!r.ok) throw new Error(r.errors.join("; "));
  const ctx = Context.from(r, DATA);
  const bar = compile(r.code)(ctx);
  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    bar();
  }
  return {
    trades: ctx.strategy.closedTradeRecords.map((t) => ({ eBar: t.entryBarIndex, xBar: t.exitBarIndex, eP: t.entryPrice, xP: t.exitPrice, size: t.size, pnl: t.profit })),
    capital: ctx.strategy.initialCapital,
  };
}

const HEADER = (props: string) => `//@version=5\nstrategy("s"${props})\n`;
const BODY = `if bar_index == 0\n    strategy.entry("L", strategy.long, qty=10)\nif bar_index == 2\n    strategy.close("L")\n`;

describe("transpile({ strategy }) — the Properties tab", () => {
  it("replaces the declaration's commission (the declared fee is not charged)", () => {
    const src = HEADER(", commission_type=strategy.commission.percent, commission_value=1") + BODY;
    const declared = trades(src).trades[0]!;
    const overridden = trades(src, { commission_value: 0 }).trades[0]!;
    // gross: (120 - 100) * 10 = 200; the declared 1% per side is 10 + 12 = 22
    expect(declared.pnl).toBeCloseTo(178, 9);
    expect(overridden.pnl).toBeCloseTo(200, 9);
  });

  it("replaces process_orders_on_close: fills move back to the next bar's open", () => {
    const src = HEADER(", process_orders_on_close=true") + BODY;
    expect(trades(src).trades[0]).toMatchObject({ eBar: 0, eP: 100, xBar: 2, xP: 110 });
    expect(trades(src, { process_orders_on_close: false }).trades[0]).toMatchObject({ eBar: 1, eP: 100, xBar: 3, xP: 120 });
  });

  it("sets a property the declaration omits (slippage, capital)", () => {
    const src = HEADER("") + BODY;
    const t = trades(src, { slippage: 2, initial_capital: 50_000 });
    // mintick 0.01: 2 ticks against the order on both market fills
    expect(t.trades[0]).toMatchObject({ eP: 100.02, xP: 119.98 });
    expect(t.capital).toBe(50_000);
  });

  it("replaces default sizing (percent_of_equity of an overridden capital)", () => {
    const src = HEADER(", default_qty_type=strategy.fixed, default_qty_value=1") +
      `if bar_index == 0\n    strategy.entry("L", strategy.long)\nif bar_index == 2\n    strategy.close("L")\n`;
    expect(trades(src).trades[0]!.size).toBe(1);
    // 10% of 100,000 at the placement close 100 = 100 units (whole lots, mincontract 1)
    const t = trades(src, { initial_capital: 100_000, default_qty_type: "percent_of_equity", default_qty_value: 10 });
    expect(t.trades[0]!.size).toBe(100);
  });

  it("rejects a bad value and an unknown key as transpile errors", () => {
    const src = HEADER("") + BODY;
    const bad = transpile(src, { strategy: { commission_value: -1 } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toContain("strategy option 'commission_value'");
    const unknown = transpile(src, { strategy: { risk_free_rate: 2 } as unknown as StrategyPropertyOptions });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors.join(" ")).toContain("strategy option 'risk_free_rate'");
  });

  it("is ignored by a script that is not a strategy", () => {
    const r = transpile(`//@version=5\nindicator("i")\nplot(close)\n`, { strategy: { commission_value: 0.1 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(run(r, DATA).plots[0]!.values).toHaveLength(5);
  });
});
