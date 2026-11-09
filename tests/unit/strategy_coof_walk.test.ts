// strategy(calc_on_order_fills=true): a bar is walked ONE FILL AT A TIME, and a strategy.exit() waits on
// the strategy.order() it names.
//
// Evidence: TradingView's own trade list of the PyneCore probe "COOF stepwise probe" (CAPITALCOM:BTCUSD 30m,
// 2026-09-28; pynecore tests/t01_lib/t30_strategy/test_140_coof_stepwise_walk.py, the exact Pine below),
// bars 0..105 of its export. The probe's bar_index phases line up with the first bar, the first 48 bars
// are warm-up. Every bar from 48 on places up to four strategy.order("E") entries, one per fill (TradingView
// re-runs the body after EVERY fill), each with a strategy.exit("X", "E", limit = ...). The rules it measures
// (pynecore lib/strategy process_orders(coof=True), the docstring of that test):
//  - a pass walks only the legs AFTER the path node it stands at, never the leg that led there;
//  - the walk stops at the end of the first leg that fills anything, and the next pass stands at its end;
//  - a pass whose own market orders filled at its node walks only the next leg (the bar's first pass none);
//  - the "already fillable" test of a limit compares against the price of the node the pass stands at, not
//    the bar open: an exit marketable at the high fills at the high, one whose entry filled at the far
//    extreme rests until the next bar;
//  - sticky exit legs bound to different adds of one entry id gap through (fill) together.
import { describe, expect, it } from "vitest";
import { compile, run } from "../../src/runtime/engine";
import { Context } from "../../src/runtime/context";
import { transpile } from "../../src/transpiler/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const PINE = `//@version=6
strategy("COOF stepwise probe", overlay=true, calc_on_order_fills=true,
     pyramiding=0, default_qty_type=strategy.fixed, default_qty_value=1,
     initial_capital=10000000, margin_long=0, margin_short=0)
phase = bar_index % 8
cyc = math.floor(bar_index / 8) % 6
isLong = cyc < 3
k = cyc % 3 == 0 ? -0.25 : cyc % 3 == 1 ? 0.3 : 0.6
rng = high[1] - low[1]
if phase == 0 or phase == 1
    strategy.order("E", isLong ? strategy.long : strategy.short)
lvl = isLong ? open + k * rng : open - k * rng
strategy.exit("X", "E", limit = lvl)
if phase == 4
    strategy.close_all()
`;

// [open, high, low, close, volume] of bars 0..105; bar i opens at START + i * 1800000
const START = 1764433800000;
const BARS: number[][] = [[90903.6, 91006.3, 90893.7, 91005.2, 1186.0], [91008.1, 91023.05, 90630.6, 90713.35, 4678.0], [90712.45, 90715.35, 90449.65, 90452.6, 6459.0], [90452.35, 90552.55, 90197.0, 90296.15, 8131.0], [90294.15, 90722.75, 90232.45, 90701.9, 9230.0], [90702.4, 90846.6, 90617.4, 90817.25, 7897.0], [90816.75, 90832.6, 90606.75, 90647.4, 5804.0], [90647.8, 90682.9, 90429.35, 90664.15, 8344.0], [90664.25, 91022.05, 90654.6, 90967.1, 8708.0], [90966.35, 91012.8, 90817.95, 90949.75, 7092.0], [90949.5, 91046.0, 90922.8, 91003.35, 5852.0], [90932.35, 90937.5, 90708.85, 90733.8, 5650.0], [90733.95, 90916.35, 90715.05, 90761.4, 5084.0], [90761.15, 90881.5, 90703.5, 90830.35, 6439.0], [90830.75, 90885.2, 90771.15, 90807.85, 5688.0], [90809.15, 90941.0, 90776.0, 90867.1, 7356.0], [90866.6, 90891.15, 90821.4, 90877.3, 5414.0], [90878.2, 91048.75, 90856.55, 90957.8, 6110.0], [90958.3, 91008.5, 90896.4, 90914.1, 5875.0], [90913.85, 91029.4, 90911.7, 90958.0, 5675.0], [90957.75, 90981.9, 90756.95, 90789.7, 4434.0], [90789.95, 90806.1, 90473.25, 90698.65, 6120.0], [90698.15, 90911.35, 90682.9, 90903.1, 6002.0], [90903.0, 90968.25, 90869.5, 90879.95, 4982.0], [90879.35, 90897.8, 90809.85, 90844.9, 4603.0], [90843.15, 90843.15, 90684.6, 90684.6, 5042.0], [90683.85, 90817.4, 90683.85, 90790.5, 5110.0], [90790.9, 90900.85, 90731.25, 90898.25, 5304.0], [90898.35, 90918.85, 90863.8, 90884.75, 4600.0], [90884.5, 90959.6, 90855.5, 90944.2, 5201.0], [90944.05, 91021.15, 90907.55, 90957.3, 3410.0], [90957.65, 91396.75, 90927.3, 91145.55, 5349.0], [91146.3, 91277.65, 90941.3, 91190.4, 7465.0], [91190.65, 91604.3, 91139.75, 91395.05, 9001.0], [91394.8, 91431.3, 91309.6, 91379.95, 5073.0], [91380.95, 91436.3, 91230.4, 91383.4, 4372.0], [91382.4, 91382.4, 91195.1, 91221.35, 4852.0], [91222.85, 91375.65, 91201.75, 91240.0, 4677.0], [91239.5, 91253.05, 90997.8, 91038.85, 3560.0], [91039.7, 91331.25, 91013.35, 91257.95, 5246.0], [91257.2, 91497.75, 91205.4, 91451.1, 7142.0], [91451.45, 91941.65, 91400.5, 91823.1, 11201.0], [91822.85, 91856.7, 91631.35, 91746.5, 11731.0], [91745.65, 91756.1, 91479.2, 91525.4, 8408.0], [91524.8, 91554.9, 91253.95, 91456.0, 7626.0], [91455.75, 91574.25, 91301.65, 91553.8, 5274.0], [91553.3, 91553.85, 91364.9, 91421.25, 4810.0], [91421.15, 91764.5, 91396.6, 91746.95, 6020.0], [91748.2, 91842.65, 91637.3, 91808.4, 5621.0], [91808.25, 91809.25, 91348.95, 91371.4, 6067.0], [91373.65, 91519.75, 91316.1, 91473.95, 5839.0], [91473.7, 91473.95, 91147.1, 91357.0, 6310.0], [91355.45, 91457.2, 91321.7, 91438.2, 3382.0], [91437.95, 91459.35, 91290.1, 91327.15, 3560.0], [91326.9, 91454.55, 91291.4, 91438.5, 2950.0], [91437.25, 91603.5, 91294.8, 91303.2, 3174.0], [91302.8, 91339.95, 91175.0, 91291.5, 5197.0], [91291.6, 91306.1, 90905.15, 91050.15, 7126.0], [91050.4, 91162.45, 91027.9, 91157.05, 5964.0], [91222.4, 91313.5, 91168.2, 91216.8, 3208.0], [91216.3, 91251.9, 91044.25, 91206.4, 4119.0], [91206.5, 91226.0, 90648.0, 90655.95, 8213.0], [90657.7, 90723.4, 90332.6, 90346.45, 11203.0], [90347.7, 90394.35, 88335.75, 88353.85, 22882.0], [88353.6, 88409.0, 86974.4, 86994.0, 25172.0], [86994.5, 87721.2, 86952.2, 87273.0, 23795.0], [87271.6, 87574.45, 87151.75, 87157.5, 16682.0], [87158.4, 87480.1, 87069.45, 87081.95, 13396.0], [87081.35, 87128.55, 86477.0, 86707.0, 16492.0], [86707.25, 86784.15, 86307.35, 86376.5, 16772.0], [86376.1, 86450.15, 86163.2, 86332.55, 12948.0], [86333.45, 86333.45, 85683.95, 85708.15, 13739.0], [85709.0, 85969.85, 85673.3, 85778.9, 14058.0], [85779.65, 85987.7, 85599.75, 85987.55, 12444.0], [85987.4, 85988.8, 85649.55, 85981.0, 8775.0], [85980.85, 86240.65, 85960.8, 86043.85, 10112.0], [86043.7, 86327.65, 85977.0, 86231.15, 9322.0], [86229.9, 86265.65, 86040.9, 86232.7, 9992.0], [86232.45, 86537.2, 86130.15, 86517.15, 9453.0], [86517.55, 86613.5, 86377.75, 86597.6, 6436.0], [86598.0, 86857.35, 86482.2, 86849.3, 8597.0], [86848.35, 86896.5, 86492.65, 86589.7, 9308.0], [86589.65, 86867.7, 86563.95, 86688.2, 9496.0], [86687.7, 86785.05, 86517.6, 86551.9, 8201.0], [86552.05, 86661.3, 86541.85, 86618.7, 6894.0], [86618.85, 86661.05, 86391.65, 86429.8, 7523.0], [86431.2, 86434.75, 86102.3, 86105.05, 8732.0], [86106.55, 86175.25, 85771.65, 85796.15, 14265.0], [85797.25, 85822.0, 84727.1, 85379.2, 18170.0], [85377.45, 86092.8, 85308.05, 85950.55, 17204.0], [85949.85, 86072.1, 85647.15, 85955.45, 15218.0], [85956.3, 86288.7, 85941.35, 86215.75, 14440.0], [86214.9, 86633.9, 85856.25, 86030.0, 22864.0], [86038.45, 86067.75, 84906.15, 84916.75, 19066.0], [84916.1, 84928.9, 83799.2, 84644.9, 23232.0], [84656.6, 84816.15, 84028.1, 84520.15, 18273.0], [84520.9, 85402.7, 84465.5, 84522.85, 18971.0], [84521.2, 85013.95, 84433.8, 84966.9, 14912.0], [84966.75, 85233.4, 84639.75, 84926.6, 14003.0], [84927.35, 85507.0, 84913.15, 85283.8, 13653.0], [85274.8, 85299.6, 84692.2, 85173.85, 15550.0], [85171.6, 85248.2, 84706.2, 84708.5, 16889.0], [84709.0, 85062.85, 84586.7, 84995.3, 14991.0], [84995.8, 85805.65, 84980.45, 85240.35, 16566.0], [85240.1, 85521.3, 85162.05, 85479.15, 15448.0], [85480.55, 86346.95, 85470.3, 86152.85, 12342.0]];

// TradingView's trades: [entry bar, side, entry price, exit bar, exit price, exit id]
const TRADES: [number, string, number, number, number, string][] = [[49, "long", 91808.25, 49, 91808.25, "X"], [49, "long", 91808.25, 49, 91808.25, "X"], [49, "long", 91809.25, 49, 91809.25, "X"], [49, "long", 91348.95, 50, 91373.65, "X"], [50, "long", 91373.65, 50, 91373.65, "X"], [57, "long", 91291.6, 59, 91222.4, "X"], [57, "long", 91291.6, 59, 91222.4, "X"], [57, "long", 91306.1, 59, 91222.4, "X"], [57, "long", 90905.15, 59, 91222.4, "X"], [58, "long", 91050.4, 59, 91222.4, "X"], [65, "long", 86994.5, 69, 86707.25, "Close position order"], [65, "long", 86994.5, 69, 86707.25, "Close position order"], [65, "long", 86952.2, 69, 86707.25, "Close position order"], [65, "long", 87721.2, 69, 86707.25, "Close position order"], [66, "long", 87271.6, 69, 86707.25, "Close position order"], [73, "short", 85779.65, 73, 85779.65, "X"], [73, "short", 85779.65, 73, 85779.65, "X"], [73, "short", 85599.75, 73, 85599.75, "X"], [73, "short", 85987.7, 74, 85987.4, "X"], [74, "short", 85987.4, 74, 85987.4, "X"], [81, "short", 86848.35, 81, 86735.8, "X"], [81, "short", 86848.35, 81, 86735.8, "X"], [81, "short", 86896.5, 81, 86735.8, "X"], [81, "short", 86492.65, 81, 86492.65, "X"], [82, "short", 86589.65, 82, 86589.65, "X"], [89, "short", 85377.45, 89, 85377.45, "X"], [89, "short", 85377.45, 93, 86038.45, "Close position order"], [89, "short", 85308.05, 93, 86038.45, "Close position order"], [89, "short", 86092.8, 93, 86038.45, "Close position order"], [90, "short", 85949.85, 93, 86038.45, "Close position order"], [97, "long", 84521.2, 97, 84521.2, "X"], [97, "long", 84521.2, 97, 84521.2, "X"], [97, "long", 84433.8, 97, 84433.8, "X"], [97, "long", 85013.95, 97, 85013.95, "X"], [98, "long", 84966.75, 98, 84966.75, "X"]];

const data: OHLCVData = {
  open: BARS.map((b) => b[0]!), high: BARS.map((b) => b[1]!), low: BARS.map((b) => b[2]!),
  close: BARS.map((b) => b[3]!), volume: BARS.map((b) => b[4]!),
  time: BARS.map((_, i) => START + i * 1800000),
};

const SYMINFO = { mintick: 0.05, pricescale: 100, minmove: 5, mincontract: 1e-6, pointvalue: 1, timezone: "UTC", type: "crypto", prefix: "CAPITALCOM", ticker: "BTCUSD" };

function closedTrades(pine: string, bars: OHLCVData): [number, string, number, number, number, string][] {
  const r = transpile(pine, { chartTf: "30", syminfo: SYMINFO });
  if (!r.ok) throw new Error(r.errors.join("; "));
  const ctx = Context.from(r, bars);
  const bar = compile(r.code)(ctx);
  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    bar();
  }
  const s = ctx.strategy;
  const times = Array.from(bars.time!);
  const out: [number, string, number, number, number, string][] = [];
  for (let k = s.closedTradesFirstIndex(); k < s.closedTrades; k++) {
    out.push([
      times.indexOf(s.closedTradeEntryTime(k)), s.closedTradeSize(k) > 0 ? "long" : "short", s.closedTradeEntryPrice(k),
      times.indexOf(s.closedTradeExitTime(k)), s.closedTradeExitPrice(k), s.closedTradeExitComment(k) || s.closedTradeExitId(k),
    ]);
  }
  return out;
}

describe("calc_on_order_fills walks a bar one fill at a time (TradingView's COOF stepwise probe)", () => {
  // the trades TradingView lists: entered from bar 48 (the first 48 bars are warm-up) and closed within the slice
  const trades = closedTrades(PINE, data).filter((t) => t[0] >= 48 && t[0] <= BARS.length - 3 && t[3] <= BARS.length - 2);

  it("books every trade TradingView lists for bars 48 and on, with its entry, exit bar, exit price and exit id", () => {
    expect(trades.length).toBe(TRADES.length);
    trades.forEach((got, i) => {
      const want = TRADES[i]!;
      expect(got.slice(0, 2), `trade ${i}`).toEqual(want.slice(0, 2));
      expect(got[3], `trade ${i} exit bar`).toBe(want[3]);
      expect(got[5], `trade ${i} exit id`).toBe(want[5]);
      expect(got[2], `trade ${i} entry price`).toBeCloseTo(want[2] as number, 6);
      expect(got[4], `trade ${i} exit price`).toBeCloseTo(want[4] as number, 6);
    });
  });

  it("bar 49: an exit marketable at the node a pass stands at fills at that node's price, one marketable only at the open rests", () => {
    // open 91808.25, high 91809.25, low 91348.95: four entries (open, open, high, low); the long's take-profit
    // lies below the open, so the first three fill at the price of the node their entry filled at, and the
    // fourth, entered at the low, waits for the next bar.
    const bar49 = trades.filter((t) => t[0] === 49);
    expect(bar49.map((t) => [t[2], t[3], t[4]])).toEqual([
      [91808.25, 49, 91808.25],
      [91808.25, 49, 91808.25],
      [91809.25, 49, 91809.25],
      [91348.95, 50, 91373.65],
    ]);
  });
});

describe("strategy.exit() waits on a pending strategy.order()", () => {
  const bars = (rows: number[][]): OHLCVData => ({
    open: rows.map((r) => r[0]!), high: rows.map((r) => r[1]!), low: rows.map((r) => r[2]!), close: rows.map((r) => r[3]!),
    volume: rows.map(() => 1), time: rows.map((_, i) => START + i * 1800000),
  });
  const pine = (header: string): string => [
    "//@version=6",
    header,
    "if bar_index == 1",
    '    strategy.order("E", strategy.long)',
    'strategy.exit("X", "E", limit = 108)',
  ].join("\n");
  const rows = [[100, 101, 99, 100], [100, 101, 99, 100], [100, 110, 99, 105], [105, 106, 104, 105]];

  it("the leg placed with the order binds when it fills and fills on its level", () => {
    const got = closedTrades(pine('strategy("o", default_qty_type=strategy.fixed, default_qty_value=1)'), bars(rows));
    expect(got).toEqual([[2, "long", 100, 2, 108, "X"]]);
  });

  it("also in a calc_on_order_fills strategy", () => {
    const got = closedTrades(pine('strategy("o", calc_on_order_fills=true, default_qty_type=strategy.fixed, default_qty_value=1)'), bars(rows));
    expect(got).toEqual([[2, "long", 100, 2, 108, "X"]]);
  });
});
