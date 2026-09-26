import { MINCONTRACT, MINMOVE, MINTICK, POINTVALUE, PRICESCALE } from "./syminfo";

// StrategyState: strategy.* 브로커 에뮬레이터 — 마켓 주문 entry/close, 롱/숏 양방향(C164 둘째
// 슬라이스), 계좌 속성 netprofit/openprofit/equity/트레이드 카운터(C165 셋째 슬라이스),
// limit/stop entry 주문 + 바 넘어 이월 + cancel/cancel_all(C166 넷째 슬라이스),
// strategy.exit 브래킷 청산(limit=익절/stop=손절, C167 다섯째 슬라이스),
// strategy.close_all(id 무관 전량 청산) + close/exit qty= 부분 청산(C168 여섯째 슬라이스),
// strategy.order 넷팅 주문(리버스/pyramiding 가드 없는 순수 방향 주문 — 반대 방향 체결은
// |posSize| 상쇄: 축소/정확 flat/부호 반전, C169 일곱째 슬라이스), entry/order/exit/close/
// close_all(comment=) 실소비 + strategy.closedtrades.entry_comment/exit_comment(index) 최신
// 트레이드 1건 조회(C173 열한째 슬라이스).
// strategy.closedtrades.<method>(trade_num) 전 인덱스(0=가장 오래된 트레이드 ~ closedTrades-1=
// 가장 최근) 조회용 레코드(C579, 배치28 (1) — per-trade 이력 설계 승인). TV 공식 레퍼런스:
// "trades are numbered starting at zero...the number increasing with each closed trade" — 즉
// trade_num 0이 최초 청산, 최댓값이 최신 청산이라 closeAt()의 push 순서(청산 발생 순)가 그대로
// 정답 순서다.
interface ClosedTradeRecord {
  entryComment: string;
  exitComment: string;
  entryPrice: number;
  exitPrice: number;
  entryBarIndex: number;
  exitBarIndex: number;
  entryTime: number;
  exitTime: number;
  entryId: string;
  exitId: string | null; // null (string na) for a margin call, which is no order of the script
  profit: number; // net of the trade's commission (entry and exit legs)
  size: number;
  maxRunup: number;
  maxDrawdown: number;
  maxRunupPercent: number; // as the open trade last reported it (see updateTradeExcursion)
  maxDrawdownPercent: number;
  commission: number; // the entry leg's share plus the exit leg
  profitRatio: number; // profit over the entry cost (its value plus its entry fee)
  profitPercent: number; // profitRatio × 100
}

// One open trade. The manual (strategies.txt, "Orders and trades"): "a trade is the resulting
// transaction that opens after the emulator fills an entry order. A market position is total of
// all open trades." Every entry fill (strategy.entry, pyramiding adds, strategy.order) opens its
// own trade with its own entry price; a partial exit shrinks `size` (signed: >0 long, <0 short).
interface OpenTrade {
  entryId: string;
  entryComment: string;
  entryPrice: number;
  entryBarIndex: number;
  entryTime: number;
  size: number;
  maxRunup: number;
  maxDrawdown: number;
  maxRunupPercent: number;
  maxDrawdownPercent: number;
  commission: number; // the entry fee still carried by the open part of the trade
  entryMoment: number; // the fillMoment its entry filled at (see closeAt)
}

// One filled entry as the order commands see it: it holds a pyramiding slot and sizes the exits
// bound to its id (strategy.close(id), strategy.exit(from_entry=id)). It is settled separately from
// the FIFO trade rows: strategies.txt, "Closing a market position" — the strategy.close("Buy2")
// order "is for 10 units because it links to the open trade with the "Buy2" entry ID", yet "five
// units of the order close the "Buy1" trade first because it is the oldest".
// `entryPrice` is the entry's own fill price: the base an exit's tick distances are measured from.
// `size` is the size it filled with, frozen at the fill: the exit legs bound to it reserve their
// slices off it (see ExitLeg).
interface EntryBinding {
  entryId: string;
  bound: number;
  entryPrice: number;
  size: number;
}

// One exit order of a strategy.exit() call. A call places one per filled entry it covers — each
// entry of its from_entry id, or every entry of the position without one — and one for a still
// pending entry order it covers, which is handed to the entry the order produces when it fills
// (bindLegs). Legs are kept per (exit id, entry): calls with different ids place orders side by side,
// and a call with the id of a resting leg modifies it. strategies.txt ("Partial and multi-level
// exits"): "Strategies can use more than one call to the strategy.exit() command to create
// successive partial exit orders for the same entry ID", and "the orders from each call
// automatically reserve a portion of the open position. The orders from one strategy.exit() call
// cannot exit the portion of a position that a previous call already reserved."
// A leg's slice is taken off its entry's filled size (rn.txt, June 2022: the qty_percent
// "percentages now always apply to the initial position size"); a leg with neither qty nor
// qty_percent takes all its entry's size its siblings have not reserved. A leg that fills is
// consumed: it keeps its reservation and the same call does not place it again while its entry is
// open (the oracle's tombstone; tier 2 resin-harness state/repros/exit-leg-tombstone.json).
interface ExitLeg {
  id: string;
  entryId: string; // the id of the entry it is bound to (its from_entry, or the entry's own id)
  binding: EntryBinding | null; // the filled entry; null while it waits on a pending entry order
  reserved: number; // its slice of the entry, in contracts
  boundSize: number; // the entry size the slice was taken off; NaN = not sized yet (see exit())
  qty: number; // strategy.exit(qty=) (NaN = not given)
  qtyPercent: number; // strategy.exit(qty_percent=) (NaN = not given)
  limit: number; // take-profit price (NaN = none)
  stop: number; // stop-loss price (NaN = none)
  // profit=/loss=: the take-profit and stop-loss levels as tick distances from the bound entry's
  // fill price (NaN = not given; limit=/stop= is used instead).
  profitPoints: number;
  lossPoints: number;
  // Trailing stop — trail_points=/trail_price= activate it, trail_offset= is the line's distance in
  // ticks (NaN = reuse trail_points). trailPrice is the line once active (NaN = not active).
  trailPoints: number;
  trailOffset: number;
  trailPriceArg: number;
  trailPrice: number;
  comment: string;
  // comment_loss=/comment_profit=/comment_trailing= (null = not given; comment= is used instead).
  commentLoss: string | null;
  commentProfit: string | null;
  commentTrailing: string | null;
  consumed: boolean;
  // Placed, or modified under its id, by the script on the current bar (see processFillsAtClose).
  placedThisBar: boolean;
  seq: number; // placement order
  // Scratch for fillExitLegs: this bar's fill price, the level that triggered it ("profit" = the
  // take-profit, "loss" = the stop-loss, null = the trailing line) and where the bar's path reaches
  // it (as PendingEntry).
  fillPrice: number;
  fillKind: "profit" | "loss" | null;
  pathLeg: number;
  pathDist: number;
}

// One unfilled strategy.entry() order. Orders with different ids rest side by side; a call with
// the id of a resting order modifies that order (see entry()).
interface PendingEntry {
  id: string;
  direction: string; // "long" | "short" (entry() validates it)
  qty: number; // contracts; when qtyAuto, the money budget frozen at placement instead
  qtyAuto: boolean; // a default-sized limit/stop order: its size resolves at the fill price (see moneyQtyAt)
  limit: number; // NaN = none; limit and stop both NaN = a market order
  stop: number; // NaN = none; both given = a stop-limit order
  comment: string;
  // The order's OCA group (strategy.entry(oca_name=, oca_type=)): "" = none (see applyOca).
  ocaName: string;
  ocaType: string; // "cancel" | "reduce" | "none"
  // Contracts of an opposite position the order closes on top of its own quantity (see entry()):
  // frozen at placement for a limit/stop order, NaN for a market order (it closes whatever opposite
  // position its fill meets), 0 for an order modified on the bar it was placed.
  flip: number;
  // Placement order among the orders placed on the current bar (see positionAfterPlacedMarketOrders).
  seq: number;
  // Placed, or modified under its id, by the script on the current bar: only those orders are
  // "created on a bar's close" and get the process_orders_on_close pass. processFills clears it.
  placedThisBar: boolean;
  // Scratch for processFills: this bar's fill price, and where the bar's path reaches it (pathLeg
  // 0 = at the open, 1 = the leg to the extreme nearer the open, 2 = the leg to the other extreme;
  // pathDist = distance from the open along that leg).
  fillPrice: number;
  pathLeg: number;
  pathDist: number;
}

// The lower-timeframe bars inside one chart bar, for strategy(use_bar_magnifier=true): indexes
// [from, to) of the feed's arrays, in time order (Context.advance hands one window per chart bar).
export interface SubBarWindow {
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  from: number;
  to: number;
}

// What a margin call that liquidated part of the position leaves for the next checkpoint of its bar
// (see marginCallStage2): the bar, the shortfall it covered, the price it was judged at, the side,
// and the open trades before it as (quantity, entry price) pairs, oldest first.
interface MarginCallStage {
  bar: number;
  deficit: number;
  price: number;
  short: boolean;
  trades: number[];
}

// Python's round(): half to even. The oracle's margin-call arithmetic uses it.
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// The lots a margin call covers: `raw` truncated, except that a value within about 2^-26 (relative)
// of a whole count is that count. The oracle's cover sizing (tier 2, measured on TradingView:
// "21840.99976 (rel dist 1.10e-8) covered 21841 lots on TV, while 26510.99945 (rel dist 2.08e-8)
// truncated to 26510").
function marginCoverLots(raw: number): number {
  const nearest = roundHalfEven(raw);
  return Math.abs(raw - nearest) <= raw * 2 ** -26 + 1e-9 ? nearest : Math.trunc(raw);
}

// strategy(initial_capital=) when the declaration omits it. props.txt: "Initial Capital (parameter:
// initial_capital) ... By default, this value is equal to 1,000,000." TradingView measured it
// (tier 1 resin-harness suites/strategy/tv/barupdn: the script omits initial_capital and its first
// 10%-of-equity entry buys 87927.5 units at 1.1373), and so does the oracle (tier 2, its strategy()
// default).
export const DEFAULT_INITIAL_CAPITAL = 1000000;

// How many of the latest closed trades TradingView keeps outside Deep Backtesting (strategies.txt,
// "Trade limit"; the oracle's closed-trade deque has the same length).
const CLOSED_TRADES_KEPT = 9000;

// Lots per contract of a syminfo.mincontract: the quantity grid step is 1 / lotsPerContract. A lot
// larger than one contract keeps the whole-contract grid, as in the oracle (`_size_round_factor`).
function lotsPerContract(mincontract: number): number {
  return Math.max(1, Math.round(1 / mincontract));
}

// Materializes a quantity on TradingView's 1e-8 unit grid: TV carries every quantity as an integer
// count of 1e-8 units (the oracle's `_size_units`, tier 2, measured on TradingView — its EURUSD run
// reports 5294.900000000001, not 5294.9). A whole-contract quantity is already on it, so this only
// matters on a fractional lot grid. Beyond 1e8 lots per contract, or TV's long range, it is left alone.
function toUnits(qty: number, lotsPerContract: number): number {
  if (lotsPerContract > 1e8) return qty;
  const units = qty / 1e-8;
  if (!(Math.abs(units) < 9.223372036854776e18)) return qty;
  return Math.round(units) * 1e-8;
}

// Rounds a sizing budget half-up to 10 significant decimal digits of its shortest decimal form,
// before it is divided by the unit price. This is the oracle's `_sig10_money` (tier 2, measured on
// TradingView): it decides the lot count whenever the budget sits within half a digit of a whole lot.
function sig10(money: number): number {
  if (!(money > 0) || money === Infinity) return money;
  const [mantissa, exp] = money.toExponential().split("e");
  const digits = mantissa!.replace(".", "");
  if (digits.length <= 10) return money;
  const kept = Number(digits.slice(0, 10)) + (digits[10]! >= "5" ? 1 : 0);
  return Number(`${kept}e${Number(exp) - 9}`);
}

// A double's shortest decimal form as an exact decimal: mantissa × 10^exp.
function toDecimal(x: number): { m: bigint; e: number } {
  const [mantissa, exp] = x.toExponential().split("e");
  const dot = mantissa!.indexOf(".");
  const frac = dot < 0 ? 0 : mantissa!.length - dot - 1;
  return { m: BigInt(mantissa!.replace(".", "")), e: Number(exp) - frac };
}

// num / den × 10^e (num, den > 0) rounded half-up to 10 significant digits, in exact decimal
// arithmetic, as a double.
function divideToCash(num: bigint, den: bigint, e: number): number {
  if (num === 0n) return 0;
  // Scale so that the integer quotient has exactly 10 digits.
  let s = 9 - (num.toString().length - den.toString().length);
  let q = s >= 0 ? (num * 10n ** BigInt(s)) / den : num / (den * 10n ** BigInt(-s));
  if (q >= 10000000000n) s -= 1;
  else if (q < 1000000000n) s += 1;
  const n = s >= 0 ? num * 10n ** BigInt(s) : num;
  const d = s >= 0 ? den : den * 10n ** BigInt(-s);
  q = n / d;
  if ((n % d) * 2n >= d) q += 1n;
  return Number(`${q}e${e - s}`);
}

// Commission is booked as a cash flow rounded half-up to 10 significant digits of the amount's
// shortest decimal form (the oracle's `_round_cash`, tier 2, measured on TradingView: "TV books each
// commission cash flow rounded HALF-UP to TEN SIGNIFICANT DIGITS").
function roundCash(amount: number): number {
  if (!(amount > 0) || amount === Infinity) return amount;
  const d = toDecimal(amount);
  return divideToCash(d.m, 1n, d.e);
}

// The per-contract fee of strategy.commission.percent at `price`: price × value%, taken in exact
// decimal arithmetic on the two shortest decimal forms and only then made a double (the oracle's
// `_book_commission`, measured on TradingView: "the percent rate is the fill price times the rate in
// EXACT DECIMAL arithmetic, converted to a double").
function percentRate(price: number, value: number): number {
  const p = toDecimal(price);
  const v = toDecimal(value);
  return Number(`${p.m * v.m}e${p.e + v.e - 2}`);
}

// pine2py wavealgo/strategy/engine.py의 주문 상태머신 구조(pending 주문 → 체결 → Position
// 갱신, entry()의 반대 포지션 청산/pyramiding 가드, _fill_entry의 가중평균 추가 진입)를 시맨틱
// 참조로 이식하되, **체결 시점은 pine2py를 따르지 않는다**: pine2py StrategyEngine은 market 주문을
// 당일 close에 즉시 체결하는데(engine.py entry()의 `self._fill_entry(order, self._close)`) 이는
// 알려진 버그다(GOAL.md "strategy 체결: market 주문은 **다음 바 open** 체결" — TV 브로커 에뮬레이터
// 규칙). 따라서 strategy 계열은 오라클(gen_oracle.py) 골든 생성 자체가 무효 구간이며 전 기능을
// hand-verified로 검증한다(tests/unit/strategy.test.ts, DIVERGENCES.md #1/#66/#67 참조).
//
// 체결 적격성(리버스/pyramiding)도 콜타임이 아니라 **체결 시점**에 판정한다 — pine2py의 콜타임 판정
// (entry()의 `self.position.is_short` 체크 등)은 당일 체결 전제라 next-bar-open 모델에 그대로 이식할
// 수 없다(주문을 낸 바와 체결되는 바 사이에 포지션이 바뀔 수 있음). DIVERGENCES.md #66/#67의 TV
// 미검증 가설 축.
//
// 상태 표현: close/order는 고정 pending 슬롯을 in-place 뮤테이션으로만 쓴다(close는 멱등,
// order는 "첫 주문 유지 + 같은 id 재호출만 수정"). 마켓 주문은 다음 바 open에서 반드시
// 소진(체결 또는 취소)되고, limit/stop 주문(C166)은 체결/취소까지 이월된다.
// strategy.entry() orders are kept per id (pendingEntries): orders with different ids rest side by
// side and each is judged on every bar, as TradingView's built-in channel breakout strategy needs
// (it keeps a long and a short stop entry resting at once; see entry()). strategy.exit() orders are
// kept per exit id and entry (exitLegs; see ExitLeg).
// The position itself is a list of open trades (one per entry fill) consumed FIFO by closing fills;
// those arrays grow only at order and fill events, never on every bar (the same reasoning as
// closedTradeRecords).
export class StrategyState {
  // Running sum of the open trades' signed sizes (strategy.position_size): >0 long, <0 short, 0 flat.
  posSize: number;
  // strategy.position_avg_price, re-derived from the open trades after every fill (NaN when flat).
  posAvgPrice: number;
  // The open trades, oldest first — closing fills consume them in this order (FIFO).
  openTrades: OpenTrade[];
  // The filled entries, oldest first (see EntryBinding).
  entryBook: EntryBinding[];

  // strategy() 지시어 메타데이터(C164, C165에서 initialCapital 추가) — codegen이 프리앰블에서
  // configure()로 1회 주입. 미지정 스크립트는 configure 호출 자체가 없거나(1/1) 세 번째 인자를
  // 생략해 기본값(DEFAULT_INITIAL_CAPITAL)이 그대로 쓰인다.
  defaultQty: number; // strategy(default_qty_value=N) — entry qty 생략 시 사용
  pyramiding: number; // strategy(pyramiding=N) — 같은 방향 추가 진입 최대 횟수(0은 1과 실질 동치 — 아래 processFills 참조)
  initialCapital: number; // strategy(initial_capital=N) — equity의 기저(default DEFAULT_INITIAL_CAPITAL = 1,000,000)
  // strategy(default_qty_type=strategy.percent_of_equity): an entry/order that omits qty spends
  // defaultQty percent of the equity (see defaultOrderQty).
  qtyIsPercent: boolean;
  // strategy(default_qty_type=strategy.cash): an entry/order that omits qty spends defaultQty units
  // of the account currency. Exclusive with qtyIsPercent (codegen emits at most one of them).
  qtyIsCash: boolean;
  // The close of the bar the script body is running on (set by Context.advance). A default-sized
  // order is sized when it is placed, at this price.
  barClose: number;
  // strategy(process_orders_on_close=true): the orders the script places on a bar get one more
  // fill attempt at that bar's close (processFillsAtClose), instead of waiting for the next open.
  processOrdersOnClose: boolean;
  // strategy(use_bar_magnifier=true): fills are judged on the lower-timeframe bars inside each chart
  // bar when the run supplies them (processFills' `sub`), else on the chart bar as usual.
  useBarMagnifier: boolean;
  // strategy(slippage=N): ticks every market or stop fill is moved against the order (see slipped).
  slippage: number;
  // strategy(commission_type=, commission_value=): the fee every filled order pays (see
  // bookCommission). commissionType is "percent" | "cash_per_contract" | "cash_per_order";
  // commissionValue 0 charges nothing.
  commissionType: string;
  commissionValue: number;
  // The entry fees of the open trades. They are already taken off strategy.netprofit (see
  // updateNetProfit) and move into a closed trade's own commission when it closes.
  openCommission: number;
  // The commission pool of the order being filled (beginOrder/bookCommission): one TradingView
  // order is charged one fee, however many fills (trades closed, reversal legs) it executes as.
  private commLegs: number[];
  private commBooked: number;
  private commOrderQty: number;
  // The chart symbol's grids (setSymbol): syminfo.mintick, the tick grid minmove / pricescale, and
  // the lot grid 1 / lotsPerContract (syminfo.mincontract).
  mintick: number;
  pricescale: number;
  minmove: number;
  lotsPerContract: number;
  // strategy(margin_long=, margin_short=): the percent of a long/short position's value the account
  // must fund (setMargin). 0, the engine's default (and a v5 script's), turns margin calls off.
  marginLong: number;
  marginShort: number;
  // A margin call put off to the bar's close (see marginCall), and the second stage a liquidation
  // arms for the next checkpoint of its bar (marginCallStage2).
  private mcDeferred: { price: number; short: boolean } | null;
  private mcStage2: MarginCallStage | null;
  // syminfo.pointvalue: the money one contract makes or loses when the price moves by 1.0. Every
  // money amount the engine derives from a price (profit, entry value, percent commission, the
  // unit cost a default-sized order divides its budget by, the marks behind the statistics) is
  // that price amount times it; cash commissions and the initial capital are money already. The
  // manual (faq.txt): "the cost of entering a futures contract position is the chart price
  // multiplied by the syminfo.pointvalue". Tier 1 resin-harness suites/strategy/tv/futures_pnl
  // (NYMEX_MINI:QM1!, pointvalue 500): a 1-contract short from 73.4 closed at 74.275 is -437.5.
  pointvalue: number;

  // Account counters, updated as trades close (recordClosedTrade), on each closed trade's profit
  // after commission.
  // strategy.netprofit: the closed trades' net profit, less the entry fees of the open trades
  // (see updateNetProfit).
  realizedPnl: number;
  closedTrades: number; // strategy.closedtrades — 청산된 트레이드 수(리버스 1회도 1건)
  winTrades: number; // strategy.wintrades — profit > 0 트레이드 수(0은 win도 loss도 아님 — pine2py 부등호 동일)
  lossTrades: number; // strategy.losstrades — profit < 0 트레이드 수
  evenTrades: number; // strategy.eventrades(C331, wild 신규) — profit === 0 트레이드 수(win/lossTrades가
  // 원래 안 세던 나머지 축을 명시적으로 채움 — DIVERGENCES #68 (c)가 미리 지적해둔 gap)
  grossProfit: number; // the winning trades' profits
  // The losing trades' profits, kept negative. strategy.grossloss reports it positive with the open
  // trades' entry fees added (see reportedGrossLoss).
  grossLoss: number;
  // Sums of the closed trades' profit ratios (profit over entry cost) — all trades, the winning ones,
  // the losing ones — behind strategy.avg_trade_percent/avg_winning_trade_percent/
  // avg_losing_trade_percent. rn.txt (May 2024): "the sum of all profit and loss percentages divided
  // by the number of closed trades". The ratios are summed and the average scaled to percent last, as
  // the oracle does (tier 2): (1 + 0.1) / 2 × 100 is 55.00000000000001, not the 55 of (100 + 10) / 2.
  sumProfitRatio: number;
  sumWinProfitRatio: number;
  sumLossProfitRatio: number;

  // 트레이드 접근자 실소비(C173 열한째 슬라이스 entry_comment/exit_comment → C308이 나머지
  // 필드로 확장) — pine2py는 Trade 리스트 전체를 보관해 임의 인덱스로 재조회 가능하지만
  // (types.py Trade 필드셋: entry_id/exit_id/entry_price/exit_price/entry_bar/exit_bar/
  // entry_comment/exit_comment/profit), 여기서는 GOAL.md "bar loop 안 할당 제로"와의 충돌
  // 우려(청산마다 성장하는 Trade 배열)를 피해 **가장 최근 청산 트레이드 1건만** 스칼라로
  // 캐시한다(next_hint 압축안 채택) — closeAt이 매 청산(부분 포함)마다 갱신.
  // strategy.closedtrades.<method>(index)는 index가 closedTrades-1(최신)이 아니면 하드
  // 에러(closedTradeXxx 접근자 참조 — 없는 데이터를 조용히 틀리게 반환하는 대신 명시적 실패,
  // LIMITATIONS.md). size는 TV 규약대로 부호 있음(롱 +, 숏 -, closeAt의 sign*closeQty).
  lastClosedEntryComment: string;
  lastClosedExitComment: string;
  lastClosedEntryPrice: number;
  lastClosedExitPrice: number;
  lastClosedEntryBarIndex: number;
  lastClosedExitBarIndex: number;
  lastClosedEntryId: string;
  lastClosedExitId: string | null;
  lastClosedProfit: number;
  lastClosedSize: number;
  // strategy.closedtrades.entry_time/exit_time(C418) — entry_bar_index/exit_bar_index와 동일
  // lifecycle의 시간판(ms). entryTimeOpen의 청산 시점 스냅샷 + closeAt이 받는 barTimeMs 그대로.
  lastClosedEntryTime: number;
  lastClosedExitTime: number;
  // The latest closed trade's strategy.closedtrades.max_drawdown/max_runup (money, never below 0).
  // Each open trade carries its own running excursion (OpenTrade.maxRunup/maxDrawdown and their
  // percents, updated by updateTradeExcursion every bar); closeAt() snapshots the closed share of it
  // into the record.
  lastClosedMaxRunup: number;
  lastClosedMaxDrawdown: number;
  // strategy.closedtrades.<method>(trade_num) 전 인덱스 조회용 레코드 배열(C579) — closeAt()이
  // 청산마다(부분 청산 포함, closedTrades 증가와 동일 관례) 1건 push. 청산은 바 루프의 매 바가
  // 아니라 실제 체결 이벤트에서만 일어나는 드문 이벤트라 GOAL.md "bar loop 안 할당 제로"(매 바
  // 무조건 발생하는 할당 금지)의 대상과는 성격이 다르다 — 위 lastClosed* 스칼라 필드는 기존
  // 화이트박스 테스트 호환을 위해 그대로 유지하며 항상 이 배열의 마지막 원소와 동치.
  closedTradeRecords: ClosedTradeRecord[];

  // The close-marked equity peak the strategy.risk.max_drawdown/max_intraday_loss latches measure
  // against (updateDrawdown), and the largest drop from it. Not the reported statistics below.
  peakEquity: number;
  riskMaxDrawdown: number;

  // strategy.max_drawdown/max_runup and their percents (updateStatistics). The drawdown runs from the
  // realized equity's high-water mark `maxRealizedEquity` (never below the initial capital) down to
  // the worst intrabar mark; the run-up runs from `runupTrough` — the lowest equity at an entry fill
  // (updateRunupTrough) — up to the best intrabar mark. rn.txt (November 2023): max_drawdown_percent
  // is "The maximum drop from a peak in the equity curve, expressed as a percentage of the peak
  // value"; the run-up percent is taken over the top it rose to (see updateStatistics).
  maxDrawdown: number;
  maxDrawdownPercent: number;
  maxRunup: number;
  maxRunupPercent: number;
  maxRealizedEquity: number; // -Infinity until the first bar
  runupTrough: number; // Infinity until the first entry fill

  // strategy.max_contracts_held_long/short: the largest long and short position held. Only an entry
  // fill can raise them (openTradeAt); max_contracts_held_all is the larger of the two.
  maxContractsHeldLong: number;
  maxContractsHeldShort: number;

  // pending 주문 슬롯 — processFills()가 매 바 체결 시도. 테스트 관측 편의상 public
  // (Context의 다른 필드와 동일 관례)이지만 트랜스파일 출력이 직접 만지는 것은 entry/exit/close/
  // close_all/cancel/cancel_all/configure 일곱 메서드 + openProfit/equity/closedTradeEntryComment/
  // closedTradeExitComment 네 관측 메서드 + posSize/posAvgPrice/realizedPnl/closedTrades/
  // winTrades/lossTrades/evenTrades/grossProfit/grossLoss/initialCapital/defaultQty 관측 필드뿐이다
  // (analyzer.ts STRATEGY_RUNTIME_PROPS + call-expr.ts closedtrades.entry_comment/exit_comment 분기가 유일한
  // 방출 지점).
  // 마켓 주문은 다음 바 open에서 반드시 소진(체결 또는 취소)되지만, limit/stop 주문(C166 넷째
  // 슬라이스)은 가격 조건 미충족 시 **바를 넘어 이월**된다(pine2py _pending_orders 존속과 동형 —
  // 취소 수단은 cancel/cancel_all, 같은 id 재호출은 주문 수정).
  // The unfilled strategy.entry() orders, in placement order (a modification keeps its place).
  pendingEntries: PendingEntry[];
  // Reused by processFills/processFillsAtClose to order one bar's entry fills without allocating.
  private entryScratch: PendingEntry[];
  // Reused by closeAt to collect one closing order's closed trades before they are booked.
  private closedScratch: ClosedTradeRecord[];
  // Counts order placements (entry orders and the close slot); orders placed on one bar are walked
  // in this order (positionAfterPlacedMarketOrders).
  orderSeq: number;
  closeSeq: number; // orderSeq of the pending close/close_all order
  closePending: boolean;
  closeOrderId: string;
  closeQty: number; // strategy.close(qty=) 부분 청산 수량(C168) — Infinity=전량(기본)
  closeOrderComment: string; // strategy.close(comment=)/close_all(comment=, C173) 공유 슬롯(closeQty와 동일 공유 관례)
  // strategy.close_all() 플래그(C168) — closePending 슬롯을 재사용하되 체결 시 id 매칭을 생략.
  // close_all은 항상 전량이므로 이 플래그가 서면 closeQty도 Infinity로 고정되고, 같은 바의 후속
  // close(qty=) 부분 주문은 전량 청산의 부분집합이라 무시된다(TV라면 두 주문이 각각 나가지만 둘 다
  // 다음 바 open 체결이라 순효과는 전량 청산으로 동일 — TV 실측 미검증 가설, DIVERGENCES #71).
  closeAllPending: boolean;
  // The strategy.exit() orders (see ExitLeg), in placement order. A consumed leg stays here, out of
  // the book, until its entry closes.
  exitLegs: ExitLeg[];
  private exitSeq: number;
  // Legs an entry fill of the current bar has just bound or spawned (bindLegs): they are live on the
  // fill bar, so processFills judges them once that fill is done.
  private freshLegs: ExitLeg[];
  // Reused by runExitLegs to order one pass of exit fills without allocating.
  private legScratch: ExitLeg[];
  // The exit legs walked on the path being filled whose fill is still ahead on it (queueExitLegs):
  // runExitLegs fills them segment by segment, so the margin-call checkpoints between the segments
  // see the position the path has left there.
  private legQueue: ExitLeg[];
  // The bar processFills is filling: its assumed intrabar path (open, the extreme nearer the open,
  // the other extreme, close; see walkLeg) and whether it runs to the high first.
  private barPath: number[];
  private pathUpFirst: boolean;
  // The point of the run the fills being made happen at: a new value for every point of a path
  // fillOnPath walks (the open, then each segment) and for the process_orders_on_close pass. Two
  // fills with the same value happened at the same moment (see closeAt).
  private fillMoment: number;
  // What the strategy.exit() call being run states, reused across calls (see exit()).
  private legTemplate: ExitLeg;
  // pending order(넷팅 주문) 슬롯(C169 일곱째 슬라이스) — entry 주문과 별개: entry의 체결 판정
  // (리버스 전량 청산 + pyramiding 게이트)과 달리 order는 반대 방향을 |posSize|와 상쇄하고
  // 같은 방향 추가엔 pyramiding 게이트가 없어 체결 경로가 다르다. 마켓/limit/stop·이월·같은 id
  // 수정은 entry와 같지만, 슬롯이 하나라 다른 id의 주문은 첫 주문 유지(not covered yet: entry
  // orders are kept per id, see pendingEntries).
  orderPending: boolean;
  orderOrderId: string;
  orderDirection: string; // "long" | "short" (order()가 검증)
  orderQty: number; // as entryQty
  orderQtyAuto: boolean; // as entryQtyAuto
  orderLimit: number; // 지정가(NaN=없음) — limit/stop 둘 다 NaN이면 마켓 주문
  orderStop: number; // 역지정가(NaN=없음)
  orderOrderComment: string; // strategy.order(comment=, C173)
  orderOcaName: string; // as PendingEntry.ocaName
  orderOcaType: string; // as PendingEntry.ocaType
  // Whether the order slot was placed (or re-placed under the same id) by the script on the current
  // bar — only those orders are "created on a bar's close" and get the close pass. processFills
  // clears it at every bar's open. (Entry orders and exit legs carry their own flag.)
  orderPlacedThisBar: boolean;

  // strategy.risk.allow_entry_in(value)(C309) — "all"|"long"|"short" 방향 제한. entry()의
  // 체결 시점(processFills)에서만 소비 — 콜타임이 아니라 체결 시점에 검사해야 그 사이 방향이
  // 바뀌어도(같은 바에 재호출) 최종 체결에 항상 최신 설정이 반영된다(entryDirection/qty 등
  // "체결 시점 해석" 기존 관례와 동일 축).
  allowedDirection: string;

  // strategy.risk.max_intraday_filled_orders(count)(C320) — 거래일 안에 신규 체결(오픈/피라미딩
  // 추가)된 entry 수 상한. NaN=제한 없음(기본값). "거래일" 경계는 C299가 이미 채택한 축(exchange
  // 타임존 미구현 — UTC 고정, LIMITATIONS.md 동일 갭)을 그대로 연장해 UTC 달력일로 판정한다.
  // intradayDayKey는 그 경계 판정용 키(NaN=아직 관측 안 됨, processFills가 바 시각을 받을 때만
  // 갱신 — 시각 채널이 없는 기존 단위 테스트 호출부는 이 게이트 자체가 무해하게 no-op).
  maxIntradayFilledOrders: number;
  intradayFilledCount: number;
  intradayDayKey: number;

  // strategy.risk.max_drawdown(value, type)/max_intraday_loss(value, type)(C322, next_hint 2순위 —
  // LIMITATIONS.md C309 착수 체크리스트 (a)~(d) 완료) — 둘 다 pine2py에 대응 구현이 전혀 없어
  // (allow_entry_in/max_intraday_filled_orders와 동일 근거) hand-verified 신규 설계, "TV
  // 미검증(가설)": max_drawdown은 전체 실행 기간의 peakEquity(이미 존재하는 updateDrawdown 인프라)
  // 대비 하락폭이 문턱을 넘으면 **영구** 정지(이름에 "intraday"가 없어 max_intraday_filled_orders류
  // 거래일 한정과 다른 축으로 판단 — 이름 자체가 유일한 근거라 DIVERGENCES에 가설로 명시), 반대로
  // max_intraday_loss는 "거래일 안의 peak equity" 대비 하락폭이라 peakEquity와 별도로 거래일마다
  // 리셋되는 intradayPeakEquity가 필요하다(intradayDayKey 재사용 — max_intraday_filled_orders와
  // 동일한 "거래일" 경계 판정 채널 공유). type("cash"|"percent_of_equity", strategy.cash/
  // percent_of_equity 상수가 analyzer의 builtinStringConstants로 이미 문자열 폴딩됨)에 따라
  // 문턱값을 통화 절대값 또는 peak 대비 퍼센트(0~100 스케일 — autoQtyAt의 percent/100 관례와 동일)로
  // 해석한다. 둘 다 "한 번 넘으면 래치"(같은 바 안에서 등락으로 되돌아오지 못하게) — 넘은 순간의
  // equity가 peak보다 낮아 손실폭이 줄어드는 조합이어도 재계산하면 거짓으로 풀려버리므로 불리언
  // 래치가 필수(단순 부등호 재비교로는 불가, MEMORY.md C91급 함정과 유사). max_drawdown은 영구라
  // 리셋 자체가 없고, max_intraday_loss는 processFills의 거래일 경계 블록에서 intradayFilledCount와
  // 나란히 리셋된다. 게이트는 allow_entry_in/max_intraday_filled_orders와 동일하게 entry()의
  // 오픈/피라미딩 분기만 막고(REMARKS 패턴 계승 — 청산/반대방향 리버스-청산은 계속 허용) order()는
  // 기존 두 게이트와 동일하게 미적용 범위 밖(대칭성 유지). "포지션 강제 청산"(TV가 실제로 그렇게
  // 동작한다는 설/외부 통설이 있으나 이 세션 1차 검증 불가)은 신규 진입 차단보다 훨씬 큰 행동
  // 변화라 이번 슬라이스 범위 밖으로 명시적으로 제외(LIMITATIONS.md 신규 등재).
  maxDrawdownValue: number; // strategy.risk.max_drawdown(value)의 value — NaN=제한 없음(기본값)
  maxDrawdownType: string; // "cash" | "percent_of_equity"
  drawdownLimitReached: boolean; // 영구 래치 — 한 번 true면 이후 절대 false로 안 돌아감
  maxIntradayLossValue: number; // strategy.risk.max_intraday_loss(value)의 value — NaN=제한 없음
  maxIntradayLossType: string; // "cash" | "percent_of_equity"
  intradayPeakEquity: number; // 거래일 안 peak equity(NaN=이번 거래일 아직 미관측 — updateDrawdown이 시드)
  intradayLossLimitReached: boolean; // 거래일 한정 래치 — 거래일 경계에서만 false로 리셋
  // strategy.risk.max_position_size(value)(C324) — 위 3형제와 달리 "전면 차단"이 아니라 "신규
  // 진입/피라미딩 수량 축소"(reduce) 게이트다(TV 문서 발췌: "quantity of new strategy.entry
  // orders will be reduced if necessary to prevent exceeding this limit"). 영구 상한(거래일 리셋
  // 없음, maxDrawdownValue와 동일 스코프) — 판정은 processFills의 qty 계산 자리에서 직접 캡한다.
  maxPositionSizeValue: number; // NaN=제한 없음(기본값)

  // strategy.risk.max_cons_loss_days(count)(C325, next_hint(C324) 신규 발견 — strategy.risk.* 6종
  // 중 마지막 미구현 형제) — pine2py에 대응 구현이 전혀 없어(형제들과 동일 근거) hand-verified 신규
  // 설계, "TV 미검증(가설)": wild 코퍼스 자신에 포함된 TV 문서 발췌(86e04be3ab6c.pine DESCRIPTION::
  // "A strategy-wide rule that stops all trading (cancels pending orders, closes open positions)
  // if the specified count of consecutive days end with a loss.")가 근거. 이름에 "intraday"가
  // 없어 max_drawdown과 동일 축(영구 래치, 거래일 경계 리셋 없음)으로 판단 — allow_entry_in류
  // "거래일마다 리셋"과 달리 한 번 N일 연속 손실이 발생하면 전략 전체가 영구 정지된다(maxDrawdown과
  // 동일하게 processFills의 거래일 경계 리셋 블록에서 이 래치는 건드리지 않음). "거래일이 손실로
  // 끝났는가"는 그 거래일이 끝나는 시점(다음 거래일 전환이 감지되는 processFills 호출)에 그날 실현
  // 손익(realizedPnl 변화량)이 음수인지로 판정한다 — consLossDayStartRealizedPnl이 거래일 시작
  // 시점의 realizedPnl 스냅샷(intradayPeakEquity와 동일한 "day-key 전환 블록에서 다음 날 기준으로
  // 재시드" 패턴), 전환 시 (이전) realizedPnl - consLossDayStartRealizedPnl < 0 이면 연속 카운터 +1,
  // 0 이상(무손실/무거래일 포함)이면 0으로 리셋. count<=0/NaN도 그대로 저장(C91 긍정형 가드 원칙).
  maxConsLossDaysValue: number; // NaN=제한 없음(기본값)
  consLossDayCount: number; // 현재까지의 연속 손실-거래일 스트릭
  consLossDayStartRealizedPnl: number; // 현재 거래일 시작 시점의 realizedPnl 스냅샷(NaN=아직 미관측)
  consLossLimitReached: boolean; // 영구 래치 — 한 번 true면 이후 절대 false로 안 돌아감

  constructor() {
    this.posSize = 0;
    this.posAvgPrice = NaN;
    this.openTrades = [];
    this.entryBook = [];
    this.defaultQty = 1;
    this.pyramiding = 1;
    this.initialCapital = DEFAULT_INITIAL_CAPITAL;
    this.qtyIsPercent = false;
    this.qtyIsCash = false;
    this.barClose = NaN;
    this.processOrdersOnClose = false;
    this.useBarMagnifier = false;
    this.slippage = 0;
    this.commissionType = "percent";
    this.commissionValue = 0;
    this.openCommission = 0;
    this.commLegs = [];
    this.commBooked = 0;
    this.commOrderQty = 0;
    this.mintick = MINTICK;
    this.pricescale = PRICESCALE;
    this.minmove = MINMOVE;
    this.lotsPerContract = lotsPerContract(MINCONTRACT);
    this.pointvalue = POINTVALUE;
    this.marginLong = 0;
    this.marginShort = 0;
    this.mcDeferred = null;
    this.mcStage2 = null;
    this.realizedPnl = 0;
    this.closedTrades = 0;
    this.winTrades = 0;
    this.lossTrades = 0;
    this.evenTrades = 0;
    this.grossProfit = 0;
    this.grossLoss = 0;
    this.sumProfitRatio = 0;
    this.sumWinProfitRatio = 0;
    this.sumLossProfitRatio = 0;
    this.peakEquity = NaN;
    this.riskMaxDrawdown = 0;
    this.maxDrawdown = 0;
    this.maxDrawdownPercent = 0;
    this.maxRunup = 0;
    this.maxRunupPercent = 0;
    this.maxRealizedEquity = -Infinity;
    this.runupTrough = Infinity;
    this.maxContractsHeldLong = 0;
    this.maxContractsHeldShort = 0;
    this.lastClosedEntryComment = "";
    this.lastClosedExitComment = "";
    this.lastClosedEntryPrice = NaN;
    this.lastClosedExitPrice = NaN;
    this.lastClosedEntryBarIndex = NaN;
    this.lastClosedExitBarIndex = NaN;
    this.lastClosedEntryTime = NaN;
    this.lastClosedExitTime = NaN;
    this.lastClosedEntryId = "";
    this.lastClosedExitId = "";
    this.lastClosedProfit = NaN;
    this.lastClosedSize = NaN;
    this.lastClosedMaxRunup = NaN;
    this.lastClosedMaxDrawdown = NaN;
    this.closedTradeRecords = [];
    this.pendingEntries = [];
    this.orderSeq = 0;
    this.closeSeq = 0;
    this.closePending = false;
    this.closeOrderId = "";
    this.closeQty = Infinity;
    this.closeOrderComment = "";
    this.closeAllPending = false;
    this.exitLegs = [];
    this.exitSeq = 0;
    this.freshLegs = [];
    this.legScratch = [];
    this.legQueue = [];
    this.barPath = [NaN, NaN, NaN, NaN];
    this.pathUpFirst = false;
    this.fillMoment = 0;
    this.legTemplate = {
      id: "", entryId: "", binding: null, reserved: 0, boundSize: NaN, qty: NaN, qtyPercent: NaN,
      limit: NaN, stop: NaN, profitPoints: NaN, lossPoints: NaN, trailPoints: NaN, trailOffset: NaN,
      trailPriceArg: NaN, trailPrice: NaN, comment: "", commentLoss: null, commentProfit: null,
      commentTrailing: null, consumed: false, placedThisBar: false, seq: 0,
      fillPrice: NaN, fillKind: null, pathLeg: 0, pathDist: 0,
    };
    this.orderPending = false;
    this.orderOrderId = "";
    this.orderDirection = "long";
    this.orderQty = 0;
    this.orderQtyAuto = false;
    this.orderLimit = NaN;
    this.orderStop = NaN;
    this.orderOrderComment = "";
    this.orderOcaName = "";
    this.orderOcaType = "none";
    this.orderPlacedThisBar = false;
    this.allowedDirection = "all";
    this.maxIntradayFilledOrders = NaN;
    this.intradayFilledCount = 0;
    this.intradayDayKey = NaN;
    this.maxDrawdownValue = NaN;
    this.maxDrawdownType = "cash";
    this.drawdownLimitReached = false;
    this.maxIntradayLossValue = NaN;
    this.maxIntradayLossType = "cash";
    this.intradayPeakEquity = NaN;
    this.intradayLossLimitReached = false;
    this.maxPositionSizeValue = NaN;
    this.maxConsLossDaysValue = NaN;
    this.consLossDayCount = 0;
    this.consLossDayStartRealizedPnl = NaN;
    this.consLossLimitReached = false;
    this.entryScratch = [];
    this.closedScratch = [];
  }

  // The position's entry as a single name: the oldest open trade's (strategy.position_entry_name —
  // the oracle measured it on TradingView to stay "A" with A and B pyramided, and to become "B"
  // only after strategy.close("A")). null/""/NaN when flat.
  get entryId(): string | null {
    return this.openTrades.length > 0 ? this.openTrades[0]!.entryId : null;
  }

  get entryComment(): string {
    return this.openTrades.length > 0 ? this.openTrades[0]!.entryComment : "";
  }

  get entryBarIndexOpen(): number {
    return this.openTrades.length > 0 ? this.openTrades[0]!.entryBarIndex : NaN;
  }

  get entryTimeOpen(): number {
    return this.openTrades.length > 0 ? this.openTrades[0]!.entryTime : NaN;
  }

  // Entries counted against `pyramiding` — "the maximum number of open trades, from the orders
  // created by strategy.entry() calls, that a strategy allows for a single position"
  // (strategies.txt). An entry keeps its slot until its own bound quantity is spent.
  get entryCount(): number {
    return this.entryBook.length;
  }

  // Whether any strategy.entry() order is unfilled.
  get entryPending(): boolean {
    return this.pendingEntries.length > 0;
  }

  // The unfilled entry order with this id, if any.
  private pendingEntry(id: string): PendingEntry | undefined {
    for (const e of this.pendingEntries) if (e.id === id) return e;
    return undefined;
  }

  private removePendingEntry(e: PendingEntry): void {
    const i = this.pendingEntries.indexOf(e);
    if (i >= 0) this.pendingEntries.splice(i, 1);
  }

  // The signed position the market orders already placed on this bar will leave, walked in
  // placement order: the close slot shrinks it (close_all flattens it), a market entry adds to it or,
  // opposite, reverses it to its own size. Resting limit/stop orders do not count. This is what the
  // pyramiding gate of a new strategy.entry() call reads — the oracle's `_size_flippable_by_entry`,
  // measured on TradingView: "a close hands its slot over (a close_all ahead of a same-id re-entry is
  // what lets that entry through under pyramiding=1), and a pending reversal entry makes the next
  // opposite-direction entry a reversal of its own instead of a pyramid add". Every market order
  // pending while the script body runs was placed on this bar (processFills consumes them).
  private positionAfterPlacedMarketOrders(): number {
    let size = this.posSize;
    let closeWalked = !this.closePending;
    for (const e of this.pendingEntries) {
      if (StrategyState.isPriceBased(e)) continue;
      if (!closeWalked && this.closeSeq < e.seq) {
        size = this.sizeAfterPendingClose(size);
        closeWalked = true;
      }
      const q = e.direction === "long" ? e.qty : -e.qty;
      size = size * q >= 0 ? size + q : q;
    }
    return closeWalked ? size : this.sizeAfterPendingClose(size);
  }

  private sizeAfterPendingClose(size: number): number {
    if (this.closeAllPending) return 0;
    const rest = Math.abs(size) - this.closeQty;
    return rest > 0 ? Math.sign(size) * rest : 0;
  }

  // Open quantity bound to an entry id — what strategy.close(id) closes by default.
  private boundQty(id: string): number {
    let sum = 0;
    for (const b of this.entryBook) if (b.entryId === id) sum += b.bound;
    return sum;
  }

  private hasBound(id: string): boolean {
    for (const b of this.entryBook) if (b.entryId === id) return true;
    return false;
  }

  // Whether any exit leg is live (placed, and neither filled nor cancelled).
  get exitPending(): boolean {
    return this.firstLiveLeg() !== undefined;
  }

  // The oldest live exit leg's take-profit price, slice and trailing line (NaN, 0, NaN without one).
  get exitLimit(): number {
    return this.firstLiveLeg()?.limit ?? NaN;
  }

  get exitQty(): number {
    return this.firstLiveLeg()?.reserved ?? 0;
  }

  get exitTrailPrice(): number {
    return this.firstLiveLeg()?.trailPrice ?? NaN;
  }

  private firstLiveLeg(): ExitLeg | undefined {
    for (const l of this.exitLegs) if (!l.consumed) return l;
    return undefined;
  }

  // The leg of exit `id` bound to `binding` (or, with binding null, to the pending entry order
  // `entryId`), if any.
  private findLeg(id: string, entryId: string, binding: EntryBinding | null): ExitLeg | undefined {
    for (const l of this.exitLegs) if (l.id === id && l.entryId === entryId && l.binding === binding) return l;
    return undefined;
  }

  // The contracts the other legs on the same entry have reserved against the same entry size.
  private reservedBySiblings(entryId: string, binding: EntryBinding | null, bound: number, except: ExitLeg | undefined): number {
    let sum = 0;
    for (const l of this.exitLegs) {
      if (l !== except && l.entryId === entryId && l.binding === binding && l.boundSize === bound) sum += l.reserved;
    }
    return sum;
  }

  // A leg's slice of an entry of `bound` contracts of which `siblings` are already reserved: qty=,
  // or qty_percent= of the entry's size, capped at what is left, or all that is left when the call
  // gives neither. strategies.txt: "If the sum of the exit order sizes exceeds the open position,
  // the strategy automatically reduces their sizes to match the total size of the position." A
  // derived slice is floored onto the lot grid (sizeRound); an explicit qty is taken as stated, as
  // entry quantities are (not covered: the oracle floors it too).
  private legSlice(qty: number, qtyPercent: number, bound: number, siblings: number): number {
    const unreserved = bound - siblings;
    if (!Number.isNaN(qty)) return qty < unreserved ? qty : this.sizeRound(unreserved);
    const share = Number.isNaN(qtyPercent) ? unreserved : bound * (qtyPercent * 0.01);
    return this.sizeRound(share < unreserved ? share : unreserved);
  }

  // What a pending entry order `e` will open when it fills, for the legs placed against it to reserve
  // off: its own quantity (the part of a reversal that closes the opposite position is covered by
  // that position's own legs); 0 for a market order adding to a position whose pyramiding slots are
  // full (it is dropped at its fill); NaN for a default-sized limit/stop order, whose size is only
  // known at its fill price (its legs are sized when it fills, bindLegs).
  private pendingEntryOpens(e: PendingEntry): number {
    const sign = e.direction === "long" ? 1 : -1;
    const adds = this.posSize !== 0 && this.posSize > 0 === sign > 0;
    if (!StrategyState.isPriceBased(e) && adds && this.entryCount >= this.pyramiding) return 0;
    return e.qtyAuto ? NaN : e.qty;
  }

  // An entry fill (binding `b`) takes over the legs that waited on its order, and gets a leg of its
  // own from every live strategy.exit() order already holding an earlier fill of its id. The oracle
  // (tier 2, `_bind_entry`/`_spawn_legs_for_add`, measured on TradingView): "A strategy.exit order
  // stands on its from_entry id, not on the one entry that was open when the script issued it: an
  // entry filling LATER gets its own leg off the same call, priced from its OWN fill". A waiting leg
  // with no slice yet is sized now; a leg taking all that is left grows to the fill. Both kinds are
  // live on the fill bar (freshLegs).
  private bindLegs(b: EntryBinding): void {
    const n = this.exitLegs.length;
    for (let i = 0; i < this.exitLegs.length; ) {
      const l = this.exitLegs[i]!;
      if (l.binding !== null || l.entryId !== b.entryId) {
        i++;
        continue;
      }
      l.binding = b;
      if (Number.isNaN(l.boundSize)) {
        l.reserved = this.legSlice(l.qty, l.qtyPercent, b.size, this.reservedBySiblings(b.entryId, b, b.size, l));
      } else if (Number.isNaN(l.qty) && Number.isNaN(l.qtyPercent)) {
        l.reserved = this.sizeRound(l.reserved + b.size - l.boundSize);
      }
      l.boundSize = b.size;
      if (!(l.reserved > 0)) {
        this.exitLegs.splice(i, 1);
        continue;
      }
      this.freshLegs.push(l);
      i++;
    }
    for (let i = 0; i < n && i < this.exitLegs.length; i++) {
      const src = this.exitLegs[i]!;
      if (src.entryId !== b.entryId || src.binding === null || src.binding === b || src.consumed) continue;
      if (this.findLeg(src.id, b.entryId, b) !== undefined) continue;
      const reserved = this.legSlice(src.qty, src.qtyPercent, b.size, 0);
      if (!(reserved > 0)) continue;
      const leg: ExitLeg = {
        ...src, binding: b, reserved, boundSize: b.size, trailPrice: NaN, consumed: false,
        placedThisBar: false, seq: ++this.exitSeq,
      };
      this.exitLegs.push(leg);
      this.freshLegs.push(leg);
    }
  }

  // A filled entry whose bound quantity is spent retires, and the legs bound to it die with it (a
  // consumed one included); so do the legs waiting on a pending order of its id once no filled entry
  // of that id is left. A reversal by an entry of the same id is no re-entry: the position it opens
  // gets its exit from a later call. This is the oracle's `_drop_binding` (tier 2, measured on
  // TradingView: a short reversed by a long of the same id with the reversal bar's bracket reached
  // on the next bar — "TradingView fills nothing there in 5/5 events, the long is first covered by
  // the next bar's re-issued call"). Repro: resin-harness state/repros/mixed-seed-149.json.
  // The oracle also measured one exception, kept as TradingView prints it: when an order other than
  // the entry's own exit leg spends it (`carry`) and a LONG entry order of its id is waiting, the
  // legs carry over to that order's fill ("prev long -> new long carried 15/15, prev short -> new
  // short carried 0/19"). A reversing entry order has left the book by the time its fill spends the
  // entry, so it never carries.
  private dropBinding(i: number, carry: boolean): void {
    const b = this.entryBook[i]!;
    this.entryBook.splice(i, 1);
    const orphaned = !this.hasBound(b.entryId);
    const waiting = carry ? this.pendingEntry(b.entryId) : undefined;
    const carried = waiting !== undefined && waiting.direction === "long";
    for (let j = 0; j < this.exitLegs.length; ) {
      const l = this.exitLegs[j]!;
      if (l.binding === b || (orphaned && l.binding === null && l.entryId === b.entryId)) {
        if (carried) {
          l.binding = null;
          j++;
        } else {
          this.exitLegs.splice(j, 1);
        }
      } else {
        j++;
      }
    }
  }

  // An entry fill opens a new trade (never merges into an existing one) and a binding for it. Its
  // fee is booked on the order being filled (beginOrder) and taken off strategy.netprofit at once.
  private openTradeAt(
    entryId: string, entryComment: string, fillPrice: number, signedQty: number,
    barIndex: number, barTimeMs: number,
  ): void {
    const commission = this.bookCommission(Math.abs(signedQty), fillPrice);
    this.openCommission += commission;
    this.updateNetProfit();
    this.updateRunupTrough(fillPrice);
    this.openTrades.push({
      entryId, entryComment, entryPrice: fillPrice, entryBarIndex: barIndex, entryTime: barTimeMs,
      size: signedQty, maxRunup: 0, maxDrawdown: 0, maxRunupPercent: 0, maxDrawdownPercent: 0, commission,
      entryMoment: this.fillMoment,
    });
    const binding = { entryId, bound: Math.abs(signedQty), entryPrice: fillPrice, size: Math.abs(signedQty) };
    this.entryBook.push(binding);
    this.bindLegs(binding);
    this.posSize += signedQty;
    // The peak is the position's, not one trade's: the oracle (tier 2, measured on TradingView with
    // pyramiding 3) reports 3 for long legs of 1 and 2, and 7 for short legs of 4 and 3; tier 1
    // resin-harness suites/strategy/tv/stats_variables agrees on every bar.
    if (this.posSize > this.maxContractsHeldLong) this.maxContractsHeldLong = this.posSize;
    else if (-this.posSize > this.maxContractsHeldShort) this.maxContractsHeldShort = -this.posSize;
    this.recalcAvgPrice();
  }

  // strategy.max_contracts_held_all: the larger of the long and short peaks.
  get maxContractsHeldAll(): number {
    return this.maxContractsHeldLong > this.maxContractsHeldShort ? this.maxContractsHeldLong : this.maxContractsHeldShort;
  }

  // Lowers the run-up anchor to the equity at an entry fill: the realized equity (this fill's fee
  // already taken) plus the paper profit of the position held before it, when that is a profit.
  // This is the oracle's entry-fill low-water mark (tier 2, measured on TradingView: "a second long
  // leg added at 94802.99 on top of one leg from 94711.84 anchors the run-up at 994705.330255, the
  // 91.15 the first leg was ahead by, and not at the realized equity below it").
  private updateRunupTrough(fillPrice: number): void {
    let mark = this.initialCapital + this.realizedPnl;
    if (this.posSize !== 0) {
      const open = this.posSize * (fillPrice - this.posAvgPrice) * this.pointvalue;
      if (open > 0) mark += open;
    }
    if (mark < this.runupTrough) this.runupTrough = mark;
  }

  // position_avg_price is the size-weighted entry price of the trades still open — it moves when
  // a FIFO exit removes the oldest trade (faq.txt: "Since the average price of the open position
  // changes according to which positions are still open, be aware of the order in which trades are
  // closed"). Summed oldest-first over the open trades and divided by the running position size,
  // as the oracle does (its _recalc_avg_price).
  private recalcAvgPrice(): void {
    if (this.posSize === 0) {
      this.posAvgPrice = NaN;
      return;
    }
    let sum = 0;
    for (const t of this.openTrades) sum += t.entryPrice * Math.abs(t.size);
    this.posAvgPrice = sum / Math.abs(this.posSize);
  }

  // Settles a closed quantity against the entry book: an exit leg takes it off the one entry it is
  // bound to; an id-bound closer (strategy.close(id)) takes it off that id's entries oldest-first; an
  // unbound one (close_all, a reversal, strategy.order) walks every entry oldest-first. An entry
  // whose bound quantity is spent gives its pyramiding slot back (dropBinding). A leg settles only
  // its own entry, whichever trades the FIFO fill consumed (the oracle's `_settle_entry_book`: "A
  // sticky strategy.exit leg is bound to ONE fill and settles exactly that one").
  private settleEntryBook(qty: number, target: string | EntryBinding | null): void {
    const dust = qty * 1e-12; // float dust of unsnapped sizes (see closeAt)
    if (typeof target === "object" && target !== null) {
      const i = this.entryBook.indexOf(target);
      if (i < 0) return;
      target.bound -= target.bound < qty ? target.bound : qty;
      if (target.bound <= dust) this.dropBinding(i, false);
      return;
    }
    let remaining = qty;
    for (let i = 0; i < this.entryBook.length && remaining > dust; ) {
      const b = this.entryBook[i]!;
      if (target !== null && b.entryId !== target) {
        i++;
        continue;
      }
      const take = b.bound < remaining ? b.bound : remaining;
      b.bound -= take;
      remaining -= take;
      if (b.bound <= dust) this.dropBinding(i, true);
      else i++;
    }
  }

  // strategy() 지시어의 default_qty_value/pyramiding/initial_capital 주입(C164, C165에서 세 번째
  // 인자 추가, C171에서 default_qty_type 네 번째 인자 추가, C330에서 cash 다섯 번째 인자 추가) —
  // codegen이 프리앰블(ctx당 1회 실행 영역)에 방출하므로 바 루프 시작 전에 정확히 한 번 호출된다.
  // initialCapital/qtyIsPercent/qtyIsCash는 기본 파라미터로 두어 이전 슬라이스가 방출한 2~4-인자
  // 호출 형태(및 그 exact-string 테스트)가 그대로 유효하다 — codegen도 미지정 슬롯 뒤쪽은 방출을
  // 생략한다(C129 원칙).
  configure(
    defaultQty: number, pyramiding: number, initialCapital: number = DEFAULT_INITIAL_CAPITAL,
    qtyIsPercent: boolean = false, qtyIsCash: boolean = false, processOrdersOnClose: boolean = false,
    slippage: number = 0,
  ): void {
    this.defaultQty = defaultQty;
    this.pyramiding = pyramiding;
    this.initialCapital = initialCapital;
    this.qtyIsPercent = qtyIsPercent;
    this.qtyIsCash = qtyIsCash;
    this.processOrdersOnClose = processOrdersOnClose;
    this.slippage = slippage;
  }

  // The chart symbol the strategy trades (transpile's syminfo option; codegen emits this once, before
  // the first bar, when it differs from resin's default symbol). Tick distances, slippage and level
  // snapping use its tick grid; default-sized orders floor to its lot grid; money amounts scale by
  // its point value.
  setSymbol(
    mintick: number, pricescale: number, minmove: number, mincontract: number, pointvalue: number = POINTVALUE,
  ): void {
    this.mintick = mintick;
    this.pricescale = pricescale;
    this.minmove = minmove;
    this.lotsPerContract = lotsPerContract(mincontract);
    this.pointvalue = pointvalue;
  }

  // strategy(commission_type=, commission_value=) (codegen emits this once, before the first bar,
  // when commission_value is not 0). props.txt: "Note that commission is applied on both entries and
  // exits"; strategies.txt ("Commission"): "the broker emulator now applies a commission of 1% of the
  // transaction size to each filled order".
  setCommission(type: string, value: number): void {
    if (type !== "percent" && type !== "cash_per_contract" && type !== "cash_per_order") {
      throw new Error(`strategy(): unsupported commission_type '${String(type)}'`);
    }
    this.commissionType = type;
    this.commissionValue = value;
  }

  // strategy(margin_long=, margin_short=), or the script version's default (codegen emits this once,
  // before the first bar, when either is not 0). props.txt: "If a trade has been opened and it
  // starts losing money to the extent where the trader's funds are not enough to cover their portion
  // of the trade, a Margin Call occurs and forcibly liquidates a part of the original position."
  setMargin(long: number, short: number): void {
    this.marginLong = long;
    this.marginShort = short;
  }

  // Starts the commission pool of one order's fill. `orderQty` is the order's whole quantity when it
  // is known ahead of its legs — a reversal, whose closing and opening legs are one order — and 0
  // otherwise (the legs are summed as they come).
  private beginOrder(orderQty: number = 0): void {
    this.commLegs.length = 0;
    this.commBooked = 0;
    this.commOrderQty = orderQty;
  }

  // Books one leg (`qty` contracts at `price`) of the order being filled and returns the fee to charge
  // it. TradingView charges ONE fee per order over the order's whole quantity, rounded once
  // (roundCash): percent is price × value% per contract, scaled by the point value (the rate as a
  // double first, then × pointvalue, as the oracle does), cash_per_contract is value per contract,
  // cash_per_order is value once — cash fees are money already. That fee is split over the legs in proportion to their quantity,
  // each share rounded again, and every leg is charged what its share adds to the shares already
  // booked — so a single-leg order pays exactly the rounded fee. This is the oracle's
  // `_book_commission`/`_book_flat_commission`/`_apply_booking` (tier 2, probe-measured on
  // TradingView: a reversal's two legs share one fee; a cash_per_order reversal "pays it once and
  // splits it over the two legs in qty proportion"). Proportions are taken over exact counts of 1e-8
  // units, as TradingView carries every quantity (see toUnits).
  private bookCommission(qty: number, price: number): number {
    if (this.commissionValue === 0) return 0;
    this.commLegs.push(qty);
    let qtyTotal = this.commOrderQty;
    if (qtyTotal === 0) {
      let sum = 0n;
      for (const q of this.commLegs) sum += BigInt(Math.round(q / 1e-8));
      qtyTotal = Number(`${sum}e-8`);
    }
    const total =
      this.commissionType === "percent"
        ? roundCash(percentRate(price, this.commissionValue) * this.pointvalue * qtyTotal)
        : this.commissionType === "cash_per_contract"
          ? roundCash(this.commissionValue * qtyTotal)
          : roundCash(this.commissionValue);
    let target: number;
    if (this.commLegs.length === 1 && this.commLegs[0] === qtyTotal) {
      target = total;
    } else {
      const t = toDecimal(total);
      const den = BigInt(Math.round(qtyTotal / 1e-8));
      target = 0;
      for (const q of this.commLegs) target += divideToCash(t.m * BigInt(Math.round(q / 1e-8)), den, t.e);
    }
    const amount = target - this.commBooked;
    this.commBooked = target;
    return amount;
  }

  // strategy.netprofit derived from the gross totals, the open trades' entry fees counted as a loss
  // already. The oracle keeps no running netprofit either (tier 2, measured on TradingView: "TV keeps
  // NO running netprofit accumulator: it derives netprofit from the gross totals, with an open
  // position's entry commissions still pending"). grossLoss is kept negative here.
  private updateNetProfit(): void {
    this.realizedPnl = this.grossProfit - (-this.grossLoss + this.openCommission);
  }

  // Snaps an order's price level (an entry's limit/stop, or a level derived from a tick distance)
  // onto the symbol's tick grid, rounding up (`up`) or down, so the level is a price the chart can
  // print. A level within 1e-4 tick of a grid point counts as on it, which absorbs the float error of
  // `price ± ticks * mintick`. This is the oracle's `_price_round` (tier 2, measured on TradingView —
  // see resin-harness state/repros/ticks-seed-1.json).
  private snapToTick(price: number, up: boolean): number {
    const ticks = (price * this.pricescale) / this.minmove;
    return ((up ? Math.ceil(ticks - 1e-4) : Math.floor(ticks + 1e-4)) * this.minmove) / this.pricescale;
  }

  // Truncates a quantity toward zero onto the symbol's quantity grid (syminfo.mincontract), then
  // materializes it on the 1e-8 unit grid (toUnits). An order sized from money (percent_of_equity/
  // cash) buys whole lots only: 5000 cash at 100.28 is 49 contracts, not 49.86. This is the oracle's
  // `_size_floor` (tier 2, measured on TradingView; repros resin-harness
  // state/repros/mixed-seed-5.json and qtyType-seed-1.json).
  private floorToLots(qty: number): number {
    const lots = Math.trunc(Math.abs(qty) * this.lotsPerContract);
    if (lots === 0) return 0;
    return toUnits(Math.sign(qty) * lots * (1 / this.lotsPerContract), this.lotsPerContract);
  }

  // Floors a quantity derived from another quantity (an exit leg's share of its entry) onto the lot
  // grid, like floorToLots, except that a value within a few ULPs of a whole lot count is that count:
  // the scaling multiply can land an exact lot multiple a hair below it. The oracle's `_size_round`
  // (tier 2, measured on TradingView: a qty_percent close floors "the real 0.77-lot fraction").
  private sizeRound(qty: number): number {
    const scaled = Math.abs(qty) * this.lotsPerContract;
    const nearest = Math.round(scaled);
    const lots = Math.abs(scaled - nearest) <= 8 * Number.EPSILON * scaled + 1e-9 ? nearest : Math.trunc(scaled);
    if (!(lots > 0)) return 0;
    return toUnits(Math.sign(qty) * lots * (1 / this.lotsPerContract), this.lotsPerContract);
  }

  // The fill price of a market or stop order after slippage: `price` moved `slippage` ticks against
  // the order, up for a buy (`side` 1) and down for a sell (-1). props.txt: "Slippage (parameter:
  // slippage) specifies the value in ticks to be added to the fill price of market or stop orders";
  // strategies.txt, "Slippage and unfilled limits": "each order fills 20 ticks beyond the intended
  // price in the unfavorable direction (higher for long orders, and lower for short orders)". A limit
  // fill keeps its price ("limit orders execute at the specified price or a better value"). The price
  // is not snapped afterwards, as in the oracle. Repro: resin-harness state/repros/mixed-seed-6.json.
  private slipped(price: number, side: number): number {
    return this.slippage > 0 ? price + side * (this.mintick * this.slippage) : price;
  }

  // strategy.openprofit — 미실현 손익(pine2py engine.py openprofit 프로퍼티의 signed-posSize 형:
  // flat=0, 롱=(close-avg)*size, 숏=(avg-close)*size — 부호 있는 posSize 곱 하나로 두 분기 동치).
  // 현재 바 close는 브로커 상태가 아니라 시장 데이터라 호출자(codegen이 방출하는 식)가 인자로
  // 넘긴다 — position_size류 순수 프로퍼티 식과 달리 메서드 호출 식으로 등록되는 이유.
  openProfit(closePrice: number): number {
    if (this.posSize === 0) return 0;
    return (closePrice - this.posAvgPrice) * this.posSize * this.pointvalue;
  }

  // strategy.equity = initial_capital + 실현 손익 + 미실현 손익 (engine.py equity 프로퍼티 literal port).
  equity(closePrice: number): number {
    return this.initialCapital + this.realizedPnl + this.openProfit(closePrice);
  }

  // The strategy.risk.max_drawdown/max_intraday_loss latches, on the equity marked at the bar's close.
  // Context.advance() calls it every bar after processFills() and before the script body; this is a
  // batch replay, so the close is already the one the body will read. peakEquity is seeded with the
  // initial capital on the first call. (Unverified hypothesis, DIVERGENCES #75; the oracle measures the
  // risk drawdown from the realized peak and judges it only on bars that close a trade.)
  updateDrawdown(closePrice: number): void {
    if (Number.isNaN(this.peakEquity)) this.peakEquity = this.initialCapital;
    const currentEquity = this.equity(closePrice);
    if (currentEquity > this.peakEquity) this.peakEquity = currentEquity;
    const drawdown = this.peakEquity - currentEquity;
    if (drawdown > this.riskMaxDrawdown) this.riskMaxDrawdown = drawdown;

    // strategy.risk.max_drawdown(C322) — 영구 래치. peakEquity가 시드된 이 시점 이후에만 의미가
    // 있어 위 두 줄 다음에 판정(같은 바에서 peakEquity가 이미 이번 equity를 반영한 뒤).
    if (!this.drawdownLimitReached && !Number.isNaN(this.maxDrawdownValue)) {
      const measure =
        this.maxDrawdownType === "percent_of_equity" ? (this.riskMaxDrawdown / this.peakEquity) * 100 : this.riskMaxDrawdown;
      if (measure >= this.maxDrawdownValue) this.drawdownLimitReached = true;
    }

    // strategy.risk.max_intraday_loss(C322) — 거래일 한정 peak(intradayPeakEquity, processFills의
    // 거래일 경계 블록이 day 전환 시 NaN으로 리셋)를 전체 peakEquity와 동일한 "NaN-시드 후 ratchet"
    // 패턴으로 갱신한다.
    if (Number.isNaN(this.intradayPeakEquity)) this.intradayPeakEquity = currentEquity;
    if (currentEquity > this.intradayPeakEquity) this.intradayPeakEquity = currentEquity;
    if (!this.intradayLossLimitReached && !Number.isNaN(this.maxIntradayLossValue)) {
      const intradayLoss = this.intradayPeakEquity - currentEquity;
      const measure =
        this.maxIntradayLossType === "percent_of_equity" ? (intradayLoss / this.intradayPeakEquity) * 100 : intradayLoss;
      if (measure >= this.maxIntradayLossValue) this.intradayLossLimitReached = true;
    }
  }

  // strategy.max_drawdown/max_runup and their percents, after the bar's fills (Context.advance(),
  // before the script body). The drop runs from the realized high-water mark — the largest realized
  // equity (initial capital + netprofit) seen, never below the initial capital; open paper profit
  // does not lift it — to the worst mark of the bar, the open trades marked at the bar's high or low
  // against the position's average price. The rise runs from the run-up trough (updateRunupTrough) to
  // the best mark. The drawdown percent is over the peak (rn.txt, November 2023: "expressed as a
  // percentage of the peak value"); the run-up percent is over the top it rose to, not over the
  // trough: tier 1 resin-harness suites/strategy/tv/stats_variables bar 1 reports 747.52 as
  // 0.07469966249943294% = 747.52 / 1000700.63905, where the trough 999953.11905 would give 0.07475.
  // This is the oracle's _finalize_bar_pnl (tier 2, measured on TradingView: "a bar whose intrabar
  // mark peaked at 1000700.63905 still reports the next drawdown against 1000000.0"). Both maxima and
  // both percent maxima are kept separately: a percent maximum can be set on another bar.
  updateStatistics(high: number, low: number): void {
    let drawdownSum = 0;
    let runupSum = 0;
    for (const t of this.openTrades) {
      const atHigh = t.size * (high - this.posAvgPrice) * this.pointvalue;
      const atLow = t.size * (low - this.posAvgPrice) * this.pointvalue;
      drawdownSum += -Math.min(atHigh, atLow, 0);
      runupSum += Math.max(atHigh, atLow, 0);
    }
    const realized = this.initialCapital + this.realizedPnl;
    if (realized > this.maxRealizedEquity) this.maxRealizedEquity = realized;
    const peak = this.maxRealizedEquity > this.initialCapital ? this.maxRealizedEquity : this.initialCapital;
    const drawdown = peak - realized + drawdownSum;
    if (drawdown > this.maxDrawdown) this.maxDrawdown = drawdown;
    if (peak > 0) {
      const percent = (drawdown / peak) * 100;
      if (percent > this.maxDrawdownPercent) this.maxDrawdownPercent = percent;
    }
    // Before the first entry fill the trough is Infinity: no run-up yet.
    const runup = realized + runupSum - this.runupTrough;
    if (runup > this.maxRunup) this.maxRunup = runup;
    const top = this.runupTrough + runup;
    if (top > 0) {
      const percent = (runup / top) * 100;
      if (percent > this.maxRunupPercent) this.maxRunupPercent = percent;
    }
  }

  // strategy.grossloss: the losing trades' losses as a positive amount, plus the entry fees of the
  // open trades, which netprofit has already taken. Tier 1 resin-harness suites/strategy/tv/
  // stats_variables: with one 1-BTC long open at 0.05% commission and no trade closed yet,
  // grossloss_percent is 0.004688095 (the 46.88095 entry fee over the 1,000,000 capital), and with one
  // loss of 602.31064 closed and a short open, avg_losing_trade is 789.13114 (+186.8205 of fees).
  // The manual compares it against grossprofit as a positive amount (strategies.txt: "strategy.
  // grossprofit > strategy.grossloss ? color.lime : color.red").
  reportedGrossLoss(): number {
    return -this.grossLoss + this.openCommission;
  }

  // strategy.closedtrades.first_index: the number of the oldest closed trade still listed.
  // strategies.txt, "Trade limit": "By default, strategies preserve information for up to the latest
  // 9000 trades ... If the strategy simulates fewer than 9000 trades ..., the variable's value is 0".
  closedTradesFirstIndex(): number {
    return this.closedTrades > CLOSED_TRADES_KEPT ? this.closedTrades - CLOSED_TRADES_KEPT : 0;
  }

  // strategy.opentrades/closedtrades.max_drawdown/max_runup and their percents: each open trade's
  // largest paper loss and profit, marked at the bar's high and low against its own entry price and
  // size, with its entry fee counted in; neither goes below 0. Run at the end of processFills, after
  // the bar's fills: a trade opened at this bar's open is marked at this bar's high and low, and a
  // trade closed on this bar is no longer marked by it. Trades opened in the process_orders_on_close
  // pass are first marked on the next bar. The percents are over the trade's entry cost, its value
  // plus its entry fee, like profit_percent (rn.txt, November 2023: "the maximum possible loss during
  // the trade, expressed as a percentage"). Tier 1 resin-harness suites/strategy/tv/trade_percents
  // (1 BTC long at 93761.9 on bar 1 at 0.05%): max_runup 700.63905 = (94509.42 - 93761.9) - 46.88095
  // is the entry bar's own high, max_drawdown 308.78095 is 0.3291599644223016% of 93808.78095; the
  // 2-BTC leg at 94098.9 reports 1291.8989 as 0.686114966999266% of 188291.8989. This is the oracle's
  // _finalize_bar_pnl (tier 2), which also stores the percents rather than deriving them later.
  updateTradeExcursion(high: number, low: number): void {
    for (const t of this.openTrades) {
      const pnlAtHigh = (high - t.entryPrice) * t.size * this.pointvalue - t.commission;
      const pnlAtLow = (low - t.entryPrice) * t.size * this.pointvalue - t.commission;
      const bestPnl = pnlAtHigh > pnlAtLow ? pnlAtHigh : pnlAtLow;
      const worstPnl = pnlAtHigh < pnlAtLow ? pnlAtHigh : pnlAtLow;
      if (bestPnl > t.maxRunup) t.maxRunup = bestPnl;
      if (-worstPnl > t.maxDrawdown) t.maxDrawdown = -worstPnl;
      const entryCost = Math.abs(t.size) * t.entryPrice * this.pointvalue + t.commission;
      if (entryCost > 0) {
        t.maxDrawdownPercent = (t.maxDrawdown / entryCost) * 100;
        t.maxRunupPercent = (t.maxRunup / entryCost) * 100;
      }
    }
  }

  // strategy.closedtrades.<method>(trade_num): trade 0 is the first closed trade, strategy.closedtrades
  // - 1 the latest (strategies.txt: "The index of the first open/closed trade is 0, and the last
  // trade's index is one less than the value of the strategy.opentrades/strategy.closedtrades
  // variable"). A number with no listed trade behind it (not closed yet, negative, or older than
  // strategy.closedtrades.first_index) is not an error: the amounts (profit, profit_percent, size,
  // commission, max_drawdown/max_runup and their percents) read 0, the prices, bar indexes and times
  // na, the ids and comments an empty string. Tier 1 resin-harness suites/strategy/tv/trade_percents
  // plots closedtrades.profit_percent/max_drawdown/max_drawdown_percent/max_runup/max_runup_percent
  // of trades 0 and 1 as 0.0 on the 11 bars before any trade closed; the oracle (tier 2) returns the
  // same 0/na per accessor, and reads an na trade number as trade 0 and a fractional one truncated.
  private closedTradeAt(index: number): ClosedTradeRecord | undefined {
    const i = Number.isNaN(index) ? 0 : Math.trunc(index);
    if (!(i >= this.closedTradesFirstIndex() && i < this.closedTrades)) return undefined;
    return this.closedTradeRecords[i];
  }

  closedTradeEntryComment(index: number): string {
    return this.closedTradeAt(index)?.entryComment ?? "";
  }

  closedTradeExitComment(index: number): string {
    return this.closedTradeAt(index)?.exitComment ?? "";
  }

  closedTradeEntryPrice(index: number): number {
    return this.closedTradeAt(index)?.entryPrice ?? NaN;
  }

  closedTradeExitPrice(index: number): number {
    return this.closedTradeAt(index)?.exitPrice ?? NaN;
  }

  closedTradeEntryBarIndex(index: number): number {
    return this.closedTradeAt(index)?.entryBarIndex ?? NaN;
  }

  closedTradeExitBarIndex(index: number): number {
    return this.closedTradeAt(index)?.exitBarIndex ?? NaN;
  }

  closedTradeEntryId(index: number): string {
    return this.closedTradeAt(index)?.entryId ?? "";
  }

  // A margin call's exit has no id: na (null).
  closedTradeExitId(index: number): string | null {
    const t = this.closedTradeAt(index);
    return t === undefined ? "" : t.exitId;
  }

  closedTradeProfit(index: number): number {
    return this.closedTradeAt(index)?.profit ?? 0;
  }

  closedTradeSize(index: number): number {
    return this.closedTradeAt(index)?.size ?? 0;
  }

  closedTradeEntryTime(index: number): number {
    return this.closedTradeAt(index)?.entryTime ?? NaN;
  }

  closedTradeExitTime(index: number): number {
    return this.closedTradeAt(index)?.exitTime ?? NaN;
  }

  // strategy.closedtrades.commission(index): the fees the trade paid, entry and exit (see closeAt).
  closedTradeCommission(index: number): number {
    return this.closedTradeAt(index)?.commission ?? 0;
  }

  // strategy.closedtrades.profit_percent(index): the profit after commission over the trade's entry
  // cost, its value plus its entry fee (see closeAt); 0 when that cost is 0.
  closedTradeProfitPercent(index: number): number {
    return this.closedTradeAt(index)?.profitPercent ?? 0;
  }

  closedTradeMaxRunup(index: number): number {
    return this.closedTradeAt(index)?.maxRunup ?? 0;
  }

  closedTradeMaxDrawdown(index: number): number {
    return this.closedTradeAt(index)?.maxDrawdown ?? 0;
  }

  // strategy.closedtrades.max_runup_percent/max_drawdown_percent(index): as the trade last reported
  // them while open (see updateTradeExcursion).
  closedTradeMaxRunupPercent(index: number): number {
    return this.closedTradeAt(index)?.maxRunupPercent ?? 0;
  }

  closedTradeMaxDrawdownPercent(index: number): number {
    return this.closedTradeAt(index)?.maxDrawdownPercent ?? 0;
  }

  // strategy.opentrades.<method>(index) — index 0 is the oldest open trade, strategy.opentrades - 1
  // the most recent (faq.txt: "To find the entry price for the most recent open trade, and
  // remembering that the trade indexes start at zero, use float entryPrice =
  // strategy.opentrades.entry_price(strategy.opentrades - 1)"). An index outside the open trades
  // throws rather than returning a made-up value. While flat every accessor returns na: the
  // `strategy.opentrades > 0 and strategy.opentrades.entry_bar_index(0) >= n` idiom evaluates both
  // operands on every bar (C578).
  private assertOpenTrade(method: string, index: number): void {
    if (this.posSize !== 0 && !(index >= 0 && index < this.openTrades.length)) {
      throw new Error(
        `strategy.opentrades.${method}: index ${index} is out of range — valid range 0..${this.openTrades.length - 1} (opentrades=${this.openTrades.length})`,
      );
    }
  }

  // The open trade at a validated index, or undefined while flat.
  private openTradeAtIndex(method: string, index: number): OpenTrade | undefined {
    this.assertOpenTrade(method, index);
    return this.posSize === 0 ? undefined : this.openTrades[index];
  }

  openTradeEntryPrice(index: number): number {
    return this.openTradeAtIndex("entry_price", index)?.entryPrice ?? NaN;
  }

  openTradeEntryBarIndex(index: number): number {
    return this.openTradeAtIndex("entry_bar_index", index)?.entryBarIndex ?? NaN;
  }

  openTradeEntryTime(index: number): number {
    return this.openTradeAtIndex("entry_time", index)?.entryTime ?? NaN;
  }

  openTradeEntryId(index: number): string {
    return this.openTradeAtIndex("entry_id", index)?.entryId ?? "";
  }

  openTradeSize(index: number): number {
    return this.openTradeAtIndex("size", index)?.size ?? NaN;
  }

  // strategy.opentrades.commission(index): the entry fee the open part of the trade carries.
  openTradeCommission(index: number): number {
    return this.openTradeAtIndex("commission", index)?.commission ?? NaN;
  }

  // Unrealized profit of one open trade at the current close (codegen injects `$.close.get(0)`,
  // see codegen.ts OPEN_TRADE_CLOSE_PRICE_METHODS), net of its entry fee and of the fee an exit at
  // that close would pay (a cash_per_order fee stays whole). This is the oracle's per-bar open trade
  // profit (tier 2), and what TradingView plots (tier 1 resin-harness
  // suites/strategy/tv/opentrades_profit_percent, one run per commission mode).
  openTradeProfit(closePrice: number, index: number): number {
    const t = this.openTradeAtIndex("profit", index);
    return t === undefined ? NaN : this.openTradeNetProfit(t, closePrice);
  }

  private openTradeNetProfit(t: OpenTrade, closePrice: number): number {
    const v = this.commissionValue;
    const pv = this.pointvalue;
    const exitFee =
      this.commissionType === "cash_per_order"
        ? v
        : Math.abs(t.size) * (this.commissionType === "percent" ? closePrice * pv * v * 0.01 : v);
    return t.size * (closePrice - t.entryPrice) * pv - t.commission - exitFee;
  }

  // The open profit over the trade's entry cost, its value plus its entry fee, as closedtrades.
  openTradeProfitPercent(closePrice: number, index: number): number {
    const t = this.openTradeAtIndex("profit_percent", index);
    if (t === undefined) return NaN;
    const entryCost = Math.abs(t.size) * t.entryPrice * this.pointvalue + t.commission;
    return entryCost === 0 ? 0 : (this.openTradeNetProfit(t, closePrice) / entryCost) * 100;
  }

  openTradeMaxRunup(index: number): number {
    return this.openTradeAtIndex("max_runup", index)?.maxRunup ?? NaN;
  }

  openTradeMaxDrawdown(index: number): number {
    return this.openTradeAtIndex("max_drawdown", index)?.maxDrawdown ?? NaN;
  }

  openTradeMaxRunupPercent(index: number): number {
    return this.openTradeAtIndex("max_runup_percent", index)?.maxRunupPercent ?? NaN;
  }

  openTradeMaxDrawdownPercent(index: number): number {
    return this.openTradeAtIndex("max_drawdown_percent", index)?.maxDrawdownPercent ?? NaN;
  }

  // The money a default-sized order spends, fixed when the order is placed: percent_of_equity is
  // that share of the equity marked at the bar's close, cash is the amount itself. strategies.txt
  // ("Position sizing"): the default order size applies to "orders from strategy.entry() and
  // strategy.order() calls that do not include a qty argument". The oracle freezes the budget at
  // placement, also for a limit/stop order that fills bars later (tier 2, `_default_entry_budget`).
  // A percent_of_equity budget pays the order's commission out of itself: a cash_per_order fee comes
  // off the budget here, a per-contract fee goes into the unit cost (unitCost).
  private defaultBudget(): number {
    if (!this.qtyIsPercent) return this.defaultQty;
    const money = this.equity(this.barClose) * this.defaultQty * 0.01;
    if (this.commissionType === "cash_per_order") return Math.max(0, money - this.commissionValue);
    return money;
  }

  // What one contract costs a default-sized order at `price`. Under percent_of_equity the budget is
  // the whole investment, commission included, so a contract costs its price plus its fee. The
  // oracle's `_default_entry_budget` (tier 2, measured on TradingView): "TradingView calculates the
  // position size so that the total investment (position value + commission) equals the specified
  // percentage of equity". A cash budget buys at the bare price. A contract's price is money times
  // the point value (a cash fee is money already).
  private unitCost(price: number): number {
    const value = price * this.pointvalue;
    if (!this.qtyIsPercent) return value;
    if (this.commissionType === "percent") return value * (1.0 + this.commissionValue * 0.01);
    if (this.commissionType === "cash_per_contract") return value + this.commissionValue;
    return value;
  }

  // Contracts a frozen money budget buys at `price`, floored to whole lots; NaN when nothing
  // sizable comes out (a non-positive budget, or no price to divide it by).
  private moneyQtyAt(money: number, price: number): number {
    const raw = sig10(money) / this.unitCost(price);
    return raw > 0 && raw < Infinity ? this.floorToLots(raw) : NaN;
  }

  // The quantity of an entry/order that omits qty, resolved when it is placed on this bar:
  // - fixed: default_qty_value as stated. Like an explicit qty it is not snapped to the lot grid
  //   yet (not covered: the oracle floors both onto syminfo.mincontract);
  // - percent_of_equity/cash, market order: the budget divided by the price the order would fill at
  //   now, this bar's close moved by slippage against it, floored to whole lots. The size stays
  //   fixed until the fill; a later open does not re-size it;
  // - percent_of_equity/cash, limit/stop order: the budget itself (auto), divided by the actual fill
  //   price when the order fills (moneyQtyAt). Placing it still requires a size of at least one lot
  //   at the price it would fill at now.
  // This is the oracle's entry()/order() sizing (tier 2, probe-verified on TradingView: market
  // entries are sized "from the mark-to-market equity and close of the placement bar", pushed by
  // slippage; repros resin-harness state/repros/mixed-seed-5.json and qtyType-seed-1.json).
  // Returns null when the order is dropped: nothing sizable, or zero lots with no opposite position
  // for the order to close (`reverses`: an entry facing an opposite position still closes it).
  private defaultOrderQty(
    sign: number, limit: number, stop: number, reverses: boolean,
  ): { qty: number; auto: boolean } | null {
    const moneyBased = this.qtyIsPercent || this.qtyIsCash;
    const priceBased = !Number.isNaN(limit) || !Number.isNaN(stop);
    let qty: number;
    let money = NaN;
    if (moneyBased) {
      money = this.defaultBudget();
      const c = this.barClose;
      const sizingPrice = !Number.isNaN(limit)
        ? sign > 0 ? Math.min(limit, c) : Math.max(limit, c)
        : !Number.isNaN(stop)
          ? sign > 0 ? Math.max(stop, c) : Math.min(stop, c)
          : this.slipped(c, sign);
      qty = this.moneyQtyAt(money, sizingPrice);
    } else {
      qty = this.defaultQty > 0 ? this.defaultQty : NaN;
    }
    if (Number.isNaN(qty) || (qty === 0 && !reverses)) return null;
    return moneyBased && priceBased ? { qty: money, auto: true } : { qty, auto: false };
  }

  // strategy.default_entry_qty(price): the size an entry/order that omits qty would get if it filled
  // at `price`, snapped to the tick grid first and floored to whole lots (0 when it cannot be sized).
  // The oracle's default_entry_qty, measured on TradingView (tier 2): "The price argument is SNAPPED
  // to the tick grid before sizing ... The quantity is then FLOORED on the lot grid, never rounded".
  // A fixed default_qty_value is returned as stated (see defaultOrderQty).
  defaultEntryQty(price: number): number {
    if (!this.qtyIsPercent && !this.qtyIsCash) return this.defaultQty;
    const raw = sig10(this.defaultBudget()) / this.unitCost(Math.floor(price / this.mintick + 0.5) * this.mintick);
    return Math.abs(raw) < Infinity ? this.floorToLots(raw) : 0;
  }

  // A closing fill of `qty` (Infinity = the whole position) at `fillPrice`. It consumes the open
  // trades oldest-first whatever order produced it — strategies.txt, "Closing a market position":
  // "By default, strategies close a market position using the First In, First Out (FIFO) method
  // ... any exit order closes or reduces the position starting with the first open trade, even if
  // the exit command specifies the entry ID of a different open trade." Every trade it touches
  // becomes its own closed trade with that trade's entry id, price, bar and the share of the size
  // it closed; a partly consumed trade stays open with the rest. `binding` is what the closing order
  // is bound to — an exit leg's entry, a strategy.close() id, or null when unbound — used to settle
  // the entry book (settleEntryBook). Callers: the close/exit fills and the reversal/netting legs in
  // processFills, and the immediately= paths of close/close_all.
  //
  // `reversal` marks the closing leg of an order that also opens a position in its own direction.
  // When such a long order closes a short trade opened at the same moment (fillMoment) and price,
  // the two orders waited in the book together and annihilate at one instant, and that closed trade
  // is booked long side first: the long order is its entry, the short one its exit, and its size is
  // positive. The oracle (tier 2, `_fill_order`) measured this on TradingView: "the lots they
  // annihilate are booked LONG side first, whichever order came first", for strategy.entry and
  // strategy.order alike; "a reversal whose legs land on different bars or different points of the
  // bar walk keeps its order even when both legs price identically". Its other exception, an order
  // placed by a calc_on_order_fills re-execution after the trade opened, cannot happen in resin:
  // every order is placed by the script body, before the fills of the moment it fills at. The price,
  // bar and P&L of the record are the same either way. Repro: resin-harness
  // state/repros/mixed-seed-17.json (short "S" then long "Q" placed on one bar, both filled at the
  // next open: TradingView books Q → S, size 3).
  private closeAt(
    fillPrice: number, qty: number = Infinity, exitComment: string = "",
    barIndex: number = NaN, exitId: string | null = "", barTimeMs: number = NaN,
    binding: string | EntryBinding | null = null, reversal: boolean = false,
  ): void {
    const size = Math.abs(this.posSize);
    const sign = this.posSize > 0 ? 1 : -1;
    // Sizes are not snapped to a lot grid, so a quantity summed from trade sizes can differ from
    // them by float dust; dust must not split off a phantom closing piece.
    const dust = size * 1e-12;
    let remaining = qty >= size ? Infinity : qty;
    let closedQty = 0;
    // Commission: each closed trade carries its share of the trade's entry fee (which leaves
    // openCommission) plus the exit fee of the order being filled (beginOrder). percent and
    // cash_per_contract book the exit fee trade by trade; a cash_per_order fee is one flat amount for
    // the order, split over the closed trades in proportion to their quantity once all are known.
    // The profit percent divides by the trade's entry cost: its value plus its entry fee. This is the
    // oracle's closing fill (tier 2, measured on TradingView: closedtrades.profit_percent is
    // "36.01317999999651 / (93761.90000000001 + 46.88095)" for 1 BTC at 0.05%).
    const flatFee = this.commissionType === "cash_per_order";
    const records = this.closedScratch;
    records.length = 0;
    while (this.openTrades.length > 0 && remaining > dust) {
      const t = this.openTrades[0]!;
      const tradeQty = Math.abs(t.size);
      const whole = remaining >= tradeQty - dust;
      const take = whole ? tradeQty : remaining;
      const share = take / tradeQty;
      let entryFee = t.commission;
      if (!whole) {
        const keep = 1 - take / tradeQty;
        entryFee = t.commission * (1 - keep);
        t.commission *= keep;
      }
      this.openCommission -= entryFee;
      let profit = (fillPrice - t.entryPrice) * sign * take * this.pointvalue;
      let commission = entryFee;
      if (!flatFee) {
        const exitFee = this.bookCommission(take, fillPrice);
        profit -= entryFee;
        commission += exitFee;
        profit -= exitFee;
      }
      const entryCost = take * t.entryPrice * this.pointvalue + entryFee;
      const profitRatio = entryCost === 0 ? 0 : profit / entryCost;
      const longFirst = reversal && sign < 0 && t.entryMoment === this.fillMoment && t.entryPrice === fillPrice;
      records.push({
        entryComment: longFirst ? exitComment : t.entryComment,
        exitComment: longFirst ? t.entryComment : exitComment,
        entryPrice: t.entryPrice,
        exitPrice: fillPrice,
        entryBarIndex: t.entryBarIndex,
        exitBarIndex: barIndex,
        entryTime: t.entryTime,
        exitTime: barTimeMs,
        entryId: longFirst ? exitId ?? "" : t.entryId,
        exitId: longFirst ? t.entryId : exitId,
        profit,
        size: longFirst ? take : sign * take,
        maxRunup: t.maxRunup * share,
        maxDrawdown: t.maxDrawdown * share,
        // A split scales the excursion and the entry cost alike, so the percents carry over as is.
        maxRunupPercent: t.maxRunupPercent,
        maxDrawdownPercent: t.maxDrawdownPercent,
        commission,
        profitRatio,
        profitPercent: profitRatio * 100,
      });
      if (whole) {
        this.openTrades.shift();
      } else {
        t.size -= sign * take;
        t.maxRunup *= 1 - share;
        t.maxDrawdown *= 1 - share;
      }
      this.posSize -= sign * take;
      remaining -= take;
      closedQty += take;
    }
    if (flatFee && records.length > 0) {
      const fee = this.bookCommission(closedQty, fillPrice);
      for (const rec of records) {
        const entryFee = rec.commission;
        rec.commission += (fee * Math.abs(rec.size)) / closedQty;
        rec.profit -= rec.commission;
        const entryCost = Math.abs(rec.size) * rec.entryPrice * this.pointvalue + entryFee;
        rec.profitRatio = entryCost === 0 ? 0 : rec.profit / entryCost;
        rec.profitPercent = rec.profitRatio * 100;
      }
    }
    for (const rec of records) this.recordClosedTrade(rec);
    records.length = 0;
    if (this.openTrades.length === 0) {
      this.posSize = 0;
      this.openCommission = 0;
    }
    this.updateNetProfit();
    this.settleEntryBook(closedQty, binding);
    this.recalcAvgPrice();
    // Flat, every entry is spent (dropBinding).
    const carry = typeof binding !== "object" || binding === null;
    if (this.posSize === 0) while (this.entryBook.length > 0) this.dropBinding(this.entryBook.length - 1, carry);
  }

  // Books one closed trade: the record behind strategy.closedtrades.*(trade_num), the latest-trade
  // snapshot fields, and the account counters. The counters classify the trade on its profit after
  // commission, as the oracle does in every commission mode. netprofit follows (updateNetProfit).
  private recordClosedTrade(rec: ClosedTradeRecord): void {
    this.closedTrades += 1;
    this.lastClosedEntryComment = rec.entryComment;
    this.lastClosedExitComment = rec.exitComment;
    this.lastClosedEntryPrice = rec.entryPrice;
    this.lastClosedExitPrice = rec.exitPrice;
    this.lastClosedEntryBarIndex = rec.entryBarIndex;
    this.lastClosedExitBarIndex = rec.exitBarIndex;
    this.lastClosedEntryTime = rec.entryTime;
    this.lastClosedExitTime = rec.exitTime;
    this.lastClosedEntryId = rec.entryId;
    this.lastClosedExitId = rec.exitId;
    this.lastClosedProfit = rec.profit;
    this.lastClosedSize = rec.size;
    this.lastClosedMaxRunup = rec.maxRunup;
    this.lastClosedMaxDrawdown = rec.maxDrawdown;
    this.closedTradeRecords.push(rec);
    this.sumProfitRatio += rec.profitRatio;
    if (rec.profit > 0) {
      this.winTrades += 1;
      this.grossProfit += rec.profit;
      this.sumWinProfitRatio += rec.profitRatio;
    } else if (rec.profit < 0) {
      this.lossTrades += 1;
      this.grossLoss += rec.profit;
      this.sumLossProfitRatio += rec.profitRatio;
    } else {
      this.evenTrades += 1;
    }
  }

  // strategy.risk.allow_entry_in(value)(C309) — value는 컴파일타임 상수가 아닐 수 있어(wild:
  // 삼항식으로 조립) 런타임에서도 이중 방어(entry()의 direction 검증과 동일 관례). "all"은 제한
  // 해제(기본값) — pine2py에 대응 구현이 전혀 없어 hand-verified 신규 설계(TV 미검증 가설,
  // DIVERGENCES 참조). 실제 제한 적용은 processFills의 entry 체결 분기에서 일어난다(콜타임이
  // 아니라 체결 시점 — entryDirection 등 다른 필드와 동일한 "체결 시점 해석" 원칙).
  setAllowEntryIn(direction: string): void {
    if (direction !== "all" && direction !== "long" && direction !== "short") {
      throw new Error(
        `strategy.risk.allow_entry_in: unsupported value '${String(direction)}' (only "all"/"long"/"short" supported)`,
      );
    }
    this.allowedDirection = direction;
  }

  // strategy.risk.max_intraday_filled_orders(count)(C320, wild "지원하지 않는 호출" 클러스터
  // next_hint 2순위 서브그룹) — pine2py에 대응 구현이 전혀 없어(allow_entry_in과 동일 근거)
  // hand-verified 신규 설계, "TV 미검증(가설)": 근거는 allow_entry_in과 같은 wild 코퍼스 자신에
  // 포함된 TV 문서 발췌(86e04be3ab6c.pine, DESCRIPTION:: "stops new orders for the current day
  // once the maximum allowed number of filled orders (count) is reached", REMARKS:: "A market
  // order to exit a current open position is still allowed, even after the limit is reached.").
  // count<=0/NaN도 그대로 저장 — processFills 게이트가 `intradayFilledCount >= NaN`은 항상
  // false로 안전하게 무시(C91 긍정형 가드와 동일 원칙), count<=0은 그날 즉시 전면 차단으로
  // 자연히 동작해 별도 검증 분기가 불필요하다.
  setMaxIntradayFilledOrders(count: number): void {
    this.maxIntradayFilledOrders = count;
  }

  // strategy.risk.max_drawdown(value, type)(C322) — value<=0/NaN도 그대로 저장하고 실제 판정은
  // updateDrawdown에서 일어난다(allow_entry_in/max_intraday_filled_orders와 동일 "저장은 setter,
  // 판정은 다른 곳" 분리 원칙). type은 setAllowEntryIn과 동일하게 이중 방어(analyzer가 이미
  // strategy.cash/percent_of_equity 상수만 문자열로 접지만, 런타임에서도 검증).
  setMaxDrawdown(value: number, type: string): void {
    if (type !== "cash" && type !== "percent_of_equity") {
      throw new Error(
        `strategy.risk.max_drawdown: unsupported type '${String(type)}' (only "strategy.cash"/"strategy.percent_of_equity" supported)`,
      );
    }
    this.maxDrawdownValue = value;
    this.maxDrawdownType = type;
  }

  // strategy.risk.max_intraday_loss(value, type)(C322) — setMaxDrawdown과 동일 관례, 거래일 한정
  // peak(intradayPeakEquity)을 기준으로 삼는다는 점만 다르다(updateDrawdown 참조).
  setMaxIntradayLoss(value: number, type: string): void {
    if (type !== "cash" && type !== "percent_of_equity") {
      throw new Error(
        `strategy.risk.max_intraday_loss: unsupported type '${String(type)}' (only "strategy.cash"/"strategy.percent_of_equity" supported)`,
      );
    }
    this.maxIntradayLossValue = value;
    this.maxIntradayLossType = type;
  }

  // strategy.risk.max_position_size(value)(C324) — value<=0/NaN도 그대로 저장(allow_entry_in류와
  // 동일 "저장은 setter, 판정은 다른 곳" 분리 원칙). 실제 캡 적용은 processFills의 entry 체결
  // 분기에서 일어난다(qty_type 인자는 wild 실사용 0건이라 미지원 — C283 큐레이션, LIMITATIONS.md).
  setMaxPositionSize(value: number): void {
    this.maxPositionSizeValue = value;
  }

  // strategy.risk.max_cons_loss_days(count)(C325) — value<=0/NaN도 그대로 저장(형제들과 동일
  // "저장은 setter, 판정은 다른 곳" 분리 원칙). 실제 스트릭 판정/래치는 processFills의 거래일
  // 경계 블록에서 일어난다.
  setMaxConsLossDays(count: number): void {
    this.maxConsLossDaysValue = count;
  }

  // strategy.entry(id, direction, qty=default_qty_value, limit=, stop=) — 주문 큐잉. 마켓은 다음 바
  // open의 processFills에서 체결, limit/stop은 가격 조건 충족 바까지 이월(C166). direction은
  // analyzer가 strategy.long/strategy.short 상수만 폴딩하지만 문자열 리터럴/변수로 우회 전달될 수
  // 있어 런타임에서도 조용한 오동작 대신 하드 에러로 막는다(이중 방어).
  // limit/stop의 na(NaN)는 "조건 없음"으로 정규화한다(limit=na는 마켓 주문) — pine2py는 na를
  // nan 가격의 limit 주문으로 만들어 영원히 미체결로 남는데, 이는 None(인자 생략 센티널)과 na가
  // 겹치는 C107/C110 클래스의 부작용이라 이식하지 않는다(DIVERGENCES #69, TV 미검증 가설).
  // when=(C372)은 pine2py entry(..., when=True, **kwargs)의 게이트 파라미터 literal port —
  // close()의 when=(C293)과 동일하게 함수 최상단에서 direction 검증보다 먼저 판정한다(when=false면
  // direction이 잘못돼도 에러 없이 완전 no-op이어야 "이 콜 자체가 없었던 것"이라는 게이트 의미와
  // 일치). 생략(JS 기본 파라미터)은 항상 true로 떨어져 기존 호출 무변화.
  entry(
    id: string | null | undefined, direction: string, qty?: number, limit?: number, stop?: number,
    comment?: string, when: boolean = true, ocaName?: string | null, ocaType?: string,
  ): void {
    if (!when) return;
    if (direction !== "long" && direction !== "short") {
      throw new Error(
        `strategy.entry: unsupported direction '${String(direction)}' (only "long"/"short" supported)`,
      );
    }
    const oca = StrategyState.ocaType("strategy.entry", ocaType);
    // na 안전성: id가 na(null)이거나 qty가 na(NaN) 또는 0 이하면 주문을 내지 않는다(LIMITATIONS.md).
    // `!(qty > 0)`은 NaN에서도 안전한 긍정형 가드(MEMORY.md C91 — NaN 비교는 항상 false).
    if (id === null || id === undefined) return;
    // The order's levels are put on the symbol's tick grid when it is placed, on the side the market
    // has to travel further to reach: a buy limit and a sell stop round down, a sell limit and a buy
    // stop round up (a level within 1e-4 tick of a grid point is on it; snapToTick). rn.txt (July
    // 2023) fixed "improper tick rounding of the limit price"; the oracle rounds entry levels this
    // way (`_price_round`, measured on TradingView). Tier 1 needs it: the channel breakout short stop
    // `ta.lowest(low, 5) - syminfo.mintick` is 1.13641 - 0.00001 = 1.1363999999999999 in floating
    // point, and TradingView fills it at 1.1364 on the bar whose low is 1.1364 (resin-harness
    // suites/strategy/tv/channelbreakout trade 28; keltnerchannel trade 141 likewise).
    const sign = direction === "long" ? 1 : -1;
    if (limit !== undefined && !Number.isNaN(limit)) limit = this.snapToTick(limit, sign < 0);
    if (stop !== undefined && !Number.isNaN(stop)) stop = this.snapToTick(stop, sign > 0);
    // An explicit qty is a number of contracts whatever default_qty_type says; an omitted one is
    // resolved now, on the placement bar (see defaultOrderQty).
    const existing = this.pendingEntry(id);
    const reissued = existing !== undefined && existing.placedThisBar;
    let qtyAuto = false;
    if (qty === undefined) {
      const reverses = !reissued && this.posSize !== 0 && this.posSize > 0 !== sign > 0;
      const sized = this.defaultOrderQty(sign, limit ?? NaN, stop ?? NaN, reverses);
      if (sized === null) return;
      qty = sized.qty;
      qtyAuto = sized.auto;
    } else if (!(qty > 0)) {
      return;
    }
    // The pyramiding limit is also judged when the call runs, not only at the fill: a same-direction
    // entry placed while the position already holds `pyramiding` entries is dropped, whatever its
    // id, and does not wait for a later bar. strategies.txt ("Pyramiding"): "After the number of
    // open trades from strategy.entry() calls reaches the pyramiding limit, the strategy does not
    // execute new orders from subsequent calls to the command until at least one of those trades
    // closes." TradingView's built-in channel breakout strategy shows it (tier 1 resin-harness
    // suites/strategy/tv/channelbreakout): it calls a long and a short stop entry on every bar, and
    // on the 257 bars whose range crosses both stops TradingView only reverses, never adds the second
    // fill, because the stop in the position's direction was never placed. The oracle measured the
    // same on TradingView (`entry()`: "a second entry placed while the position is open never fills
    // ... regardless of the entry id"), with the position read as this bar's market orders leave it.
    // Re-issuing this bar's own unfilled order under its id adds no entry, so it is not judged.
    //
    // An entry facing an opposite position reverses it by adding that position to its own size.
    // strategies.txt ("Reversing positions"): "when an order from a strategy.entry() call executes
    // while a position is open in the opposite direction, the command automatically adds the
    // position's size to the new order's size". For a market order that is the position its fill
    // meets (flip NaN: added in fillPendingEntry). A limit/stop order fixes the added size when it
    // is PLACED, against the position this bar's market orders leave (read only while a position is
    // open), and keeps it however the position moves before the fill: placed while flat it only
    // closes a position that opened meanwhile, placed against a larger position it only reduces it.
    // TradingView itself shows this, which outranks the manual's "executes": tier 1 resin-harness
    // suites/strategy/tv/slippage_limit trade 6 — the short limit placed while flat on bar 674
    // fills on bar 690 after a long limit opened on bar 688, closes that long at 1.14743 and opens
    // nothing (the next trade is a long from flat on bar 841). The oracle measured the same (tier 2,
    // entry(): "TradingView calculates the flip quantity at order creation time"). An order modified
    // on the bar it was placed carries its raw quantity and no flip, market or not (the oracle,
    // measured: "with a 10-contract long open, one strategy.entry(short, 4) reverses to 4 short,
    // while the SAME call issued twice on one bar sells only 4 and leaves 6 long").
    let flip = NaN;
    if (!reissued) {
      const pos = this.positionAfterPlacedMarketOrders();
      if (pos !== 0 && pos > 0 === sign > 0 && this.entryCount >= this.pyramiding) return;
      const priceBased = (limit !== undefined && !Number.isNaN(limit)) || (stop !== undefined && !Number.isNaN(stop));
      if (priceBased) flip = this.posSize !== 0 && pos !== 0 && pos > 0 !== sign > 0 ? Math.abs(pos) : 0;
    } else {
      flip = 0;
    }
    const cmt = comment ?? "";
    // Entry orders are kept per id. A call with the id of an unfilled order modifies it — qty,
    // direction, limit, stop, comment (a resting limit order can become a market order this way);
    // a call with a new id places another order beside the ones already resting. strategies.txt
    // names orders by id ("The strategy.cancel() command cancels all unfilled orders that have the
    // specified entry ID") and has several rest at once ("OCA groups": a long stop order "at the
    // bar's high" and a short one "at the bar's low"); the channel breakout strategy above keeps its
    // two stop entries resting together, and TradingView reverses at whichever the price reaches.
    const ocaGroup = StrategyState.ocaName(ocaName);
    if (existing !== undefined) {
      existing.direction = direction;
      existing.qty = qty;
      existing.qtyAuto = qtyAuto;
      existing.limit = limit ?? NaN;
      existing.stop = stop ?? NaN;
      existing.comment = cmt;
      existing.ocaName = ocaGroup;
      existing.ocaType = oca;
      existing.flip = flip;
      existing.placedThisBar = true;
      return;
    }
    this.pendingEntries.push({
      id, direction, qty, qtyAuto, limit: limit ?? NaN, stop: stop ?? NaN, comment: cmt,
      ocaName: ocaGroup, ocaType: oca, flip,
      seq: ++this.orderSeq, placedThisBar: true, fillPrice: NaN, pathLeg: 0, pathDist: 0,
    });
  }

  // strategy.entry()/strategy.order(oca_type=): strategy.oca.cancel | reduce | none (the analyzer
  // folds the constants to these strings). Omitted is none, "the default oca_type argument for the
  // strategy.order() and strategy.entry() commands" (strategies.txt, "strategy.oca.none").
  private static ocaType(method: string, type: string | null | undefined): string {
    if (typeof type !== "string") return "none"; // omitted, or na
    if (type !== "cancel" && type !== "reduce" && type !== "none") {
      throw new Error(`${method}: unsupported oca_type '${String(type)}' (only strategy.oca.cancel/reduce/none supported)`);
    }
    return type;
  }

  // The OCA group name of an order: "" (and na) = the order belongs to no group.
  private static ocaName(name: string | null | undefined): string {
    return typeof name === "string" ? name : "";
  }

  // One-Cancels-All: an order of an OCA group has just executed `filledQty` contracts, so the other
  // unfilled orders of its group are cancelled (strategy.oca.cancel) or have their quantity reduced
  // by that amount, and cancelled at zero (strategy.oca.reduce). strategies.txt ("OCA groups"):
  // "the strategy completely cancels the resulting order if another order from the same OCA group
  // executes first"; reduce "reduces the order's size by the filled number of
  // contracts/shares/lots/units"; strategy.oca.none orders "execute independently of any OCA group".
  // A group is a name AND a type: "If two commands have the same oca_name value but different
  // oca_type values, the strategy considers them to be from two distinct groups." (The oracle groups
  // by name alone — resin-harness state/disputes.md D3.) The executed order has already left the
  // book, so it is never its own sibling. An order consumed without executing anything (a gate kept
  // it from opening) leaves its group alone. Repros: resin-harness state/repros/oca-cancel.json,
  // oca-reduce.json, oca-mixed-types.json; tier 1 suites/strategy/tv/bollinger.
  // Not covered: a default-sized (percent_of_equity/cash) limit/stop sibling keeps its money budget
  // under reduce, and strategy.exit(oca_name=) cannot join a group yet.
  private applyOca(name: string, type: string, filledQty: number): void {
    if (name === "" || type === "none" || !(filledQty > 0)) return;
    for (let i = 0; i < this.pendingEntries.length; ) {
      const e = this.pendingEntries[i]!;
      if (e.ocaName === name && e.ocaType === type) {
        if (type === "cancel") {
          this.pendingEntries.splice(i, 1);
          continue;
        }
        if (!e.qtyAuto) {
          // The reduction comes off the order's whole size, a frozen flip included (the oracle's
          // `_reduce_oca_group` reduces `order.size`).
          const flip = Number.isNaN(e.flip) ? 0 : e.flip;
          const rest = toUnits(e.qty + flip - filledQty, this.lotsPerContract);
          if (!(rest > 0)) {
            this.pendingEntries.splice(i, 1);
            continue;
          }
          if (flip > rest) e.flip = rest;
          e.qty = toUnits(rest - (Number.isNaN(e.flip) ? 0 : e.flip), this.lotsPerContract);
        }
      }
      i++;
    }
    if (this.orderPending && this.orderOcaName === name && this.orderOcaType === type) {
      if (type === "cancel") {
        this.orderPending = false;
      } else if (!this.orderQtyAuto) {
        this.orderQty = toUnits(this.orderQty - filledQty, this.lotsPerContract);
        if (!(this.orderQty > 0)) this.orderPending = false;
      }
    }
  }

  // The quantity one order executed, from the position before and after its fill: a reversal
  // closes the old side and opens the new one.
  private static executedQty(before: number, after: number): number {
    return before * after < 0 ? Math.abs(before) + Math.abs(after) : Math.abs(after - before);
  }

  // strategy.order(id, direction, qty=, limit=, stop=) — 넷팅 주문 큐잉(C169). entry와 시그니처는
  // 같지만 체결 시맨틱이 다르다: 콜타임/체결 시점 어디에도 리버스 전량 청산·pyramiding 게이트가
  // 없고, 체결 시 포지션과 같은 방향이면 무조건 가중평균 증분, 반대 방향이면 |posSize|와 상쇄
  // (축소/정확 flat/부호 반전 — processFills의 order 분기 참조). **pine2py order()는 _fill_entry로
  // 직행해 반대 방향이면 기존 포지션을 실현손익 기록 없이 통째로 새 Position으로 교체하는
  // 실버그**(engine.py L353 `direction != order.direction` → 새 Position — next_hint의 "가중평균에
  // 반대 qty 혼입" 서술과 달리 실제로는 전체 교체지만, 어느 쪽이든 TV 넷팅과 다른 비경제 동작이라
  // 미추종. TV order는 순수 방향 주문이라 상쇄가 정합이라는 가설 — TV 실측 미검증, DIVERGENCES #72).
  // id na/qty na·0 이하 가드, defaultQty 해석, limit/stop na 정규화, 같은 id 수정/다른 id 첫 주문
  // 유지, direction 런타임 이중 방어, when=(C372, entry와 동일 관례 — 게이트가 direction 검증보다
  // 먼저) 전부 entry와 동일 관례.
  order(
    id: string | null | undefined, direction: string, qty?: number, limit?: number, stop?: number,
    comment?: string, when: boolean = true, ocaName?: string | null, ocaType?: string,
  ): void {
    if (!when) return;
    if (direction !== "long" && direction !== "short") {
      throw new Error(
        `strategy.order: unsupported direction '${String(direction)}' (only "long"/"short" supported)`,
      );
    }
    const oca = StrategyState.ocaType("strategy.order", ocaType);
    const ocaGroup = StrategyState.ocaName(ocaName);
    if (id === null || id === undefined) return;
    // Sized as in entry(), except that a zero-lot order is always dropped: strategy.order() has no
    // reversal leg to keep.
    let qtyAuto = false;
    if (qty === undefined) {
      const sized = this.defaultOrderQty(direction === "long" ? 1 : -1, limit ?? NaN, stop ?? NaN, false);
      if (sized === null) return;
      qty = sized.qty;
      qtyAuto = sized.auto;
    } else if (!(qty > 0)) {
      return; // NaN-safe positive guard
    }
    const cmt = comment ?? "";
    if (this.orderPending) {
      if (this.orderOrderId === id) {
        this.orderQty = qty;
        this.orderQtyAuto = qtyAuto;
        this.orderDirection = direction;
        this.orderLimit = limit ?? NaN;
        this.orderStop = stop ?? NaN;
        this.orderOrderComment = cmt;
        this.orderOcaName = ocaGroup;
        this.orderOcaType = oca;
        this.orderPlacedThisBar = true;
      }
      return;
    }
    this.orderPlacedThisBar = true;
    this.orderPending = true;
    this.orderOrderId = id;
    this.orderDirection = direction;
    this.orderQty = qty;
    this.orderQtyAuto = qtyAuto;
    this.orderLimit = limit ?? NaN;
    this.orderStop = stop ?? NaN;
    this.orderOrderComment = cmt;
    this.orderOcaName = ocaGroup;
    this.orderOcaType = oca;
  }

  // strategy.exit(id, from_entry, limit=, stop=, qty=, trail_points=, trail_offset=, comment=,
  // trail_price=, profit=, loss=, qty_percent=, comment_loss=, comment_profit=, when=,
  // comment_trailing=) — places the call's exit legs (see ExitLeg). Its targets: with a from_entry
  // id, each filled entry of that id and a pending entry order of that id; without one, every filled
  // entry of the position and each pending entry order that opens from flat or adds to the position
  // (a reversing one's position gets its exit from a later call — the oracle, measured on
  // TradingView). The manual (strategies.txt, "Exits for multiple entries"): with a from_entry ID,
  // the call "places exit orders for every corresponding entry created before or on the bar where
  // the call occurs" — entry orders, filled or not; its bracket example ("Take-profit and stop-loss
  // demo") calls strategy.entry() and strategy.exit() once, on the same bar, before the entry fills.
  // Repros: resin-harness state/repros/mixed-seed-1.json, partial-seed-1.json.
  // Each leg holds its own trigger levels: limit=/stop= (put on the tick grid at use, see
  // exitLimitLevel), or profit=/loss= tick distances from its entry's fill price (the absolute level
  // wins when a pair is given), and an optional trailing stop (trail_points= or trail_price= activate
  // it, trail_offset= trails it; trail_offset alone arms nothing, DIVERGENCES #73). A call whose
  // levels are all na places nothing (DIVERGENCES #70). qty= wins over qty_percent=
  // (strategies.txt: "If a strategy.exit() call includes both qty and qty_percent arguments, the
  // command uses the qty value"); an na, zero or negative quantity ignores the call (DIVERGENCES
  // #71). comment_loss=/comment_profit=/comment_trailing= override comment= for a fill by the
  // stop-loss, the take-profit or the trailing line (null = not given; hand-verified, C375/C673).
  // when=false makes the call a no-op (C380).
  exit(
    id: string | null | undefined, fromEntry?: string | null, limit?: number, stop?: number,
    qty?: number, trailPoints?: number, trailOffset?: number, comment?: string, trailPrice?: number,
    profit?: number, loss?: number, qtyPercent?: number,
    commentLoss?: string | null, commentProfit?: string | null, when: boolean = true,
    commentTrailing?: string | null,
  ): void {
    if (!when) return;
    if (id === null || id === undefined) return;
    if (qty !== undefined ? !(qty > 0) : qtyPercent !== undefined && !(qtyPercent > 0)) return; // NaN-safe (C91)
    const t = this.legTemplate;
    t.id = id;
    t.qty = qty ?? NaN;
    t.qtyPercent = qty === undefined ? qtyPercent ?? NaN : NaN;
    t.limit = limit ?? NaN;
    t.stop = stop ?? NaN;
    t.trailPoints = trailPoints ?? NaN;
    t.trailOffset = trailOffset ?? NaN;
    t.trailPriceArg = trailPrice ?? NaN;
    t.profitPoints = profit ?? NaN;
    t.lossPoints = loss ?? NaN;
    t.comment = comment ?? "";
    t.commentLoss = commentLoss ?? null;
    t.commentProfit = commentProfit ?? null;
    t.commentTrailing = commentTrailing ?? null;
    if (
      Number.isNaN(t.limit) && Number.isNaN(t.stop) && Number.isNaN(t.trailPoints) && Number.isNaN(t.trailPriceArg) &&
      Number.isNaN(t.profitPoints) && Number.isNaN(t.lossPoints)
    ) {
      return;
    }
    const from = fromEntry ?? "";
    for (const b of this.entryBook) if (from === "" || b.entryId === from) this.placeLeg(b.entryId, b, b.size);
    for (const e of this.pendingEntries) {
      if (from !== "" ? e.id !== from : this.posSize !== 0 && this.posSize > 0 !== (e.direction === "long")) continue;
      this.placeLeg(e.id, null, this.pendingEntryOpens(e));
    }
  }

  // Places (or modifies) the leg of the call in legTemplate on one target: a filled entry
  // (`binding`), or the pending entry order `entryId` (binding null) opening `bound` contracts.
  private placeLeg(entryId: string, binding: EntryBinding | null, bound: number): void {
    const t = this.legTemplate;
    const existing = this.findLeg(t.id, entryId, binding);
    // A leg that has filled is not placed again while its entry is open (see ExitLeg).
    if (existing !== undefined && existing.consumed) return;
    // A leg waiting on a default-sized entry order is sized when the order fills (bindLegs).
    const sized = !Number.isNaN(bound);
    const reserved = sized
      ? this.legSlice(t.qty, t.qtyPercent, bound, this.reservedBySiblings(entryId, binding, bound, existing))
      : NaN;
    if (sized && !(reserved > 0)) return;
    if (existing !== undefined) {
      // A call with the id of a resting leg modifies it — the standard pattern re-issues the bracket
      // every bar. The trailing line it has reached is kept, unless the call drops the trailing stop
      // (hand-verified, DIVERGENCES #73: pine2py re-arms it on every call, which would keep a per-bar
      // re-issued trailing stop from ever ratcheting).
      const trailPrice = Number.isNaN(t.trailPoints) && Number.isNaN(t.trailPriceArg) ? NaN : existing.trailPrice;
      StrategyState.assignLegSpec(existing, t);
      existing.reserved = reserved;
      existing.boundSize = bound;
      existing.trailPrice = trailPrice;
      existing.placedThisBar = true;
      return;
    }
    const leg: ExitLeg = {
      ...t, entryId, binding, reserved, boundSize: bound, trailPrice: NaN, consumed: false,
      placedThisBar: true, seq: ++this.exitSeq,
    };
    this.exitLegs.push(leg);
  }

  // Copies what a strategy.exit() call states onto a leg.
  private static assignLegSpec(dst: ExitLeg, src: ExitLeg): void {
    dst.qty = src.qty;
    dst.qtyPercent = src.qtyPercent;
    dst.limit = src.limit;
    dst.stop = src.stop;
    dst.profitPoints = src.profitPoints;
    dst.lossPoints = src.lossPoints;
    dst.trailPoints = src.trailPoints;
    dst.trailOffset = src.trailOffset;
    dst.trailPriceArg = src.trailPriceArg;
    dst.comment = src.comment;
    dst.commentLoss = src.commentLoss;
    dst.commentProfit = src.commentProfit;
    dst.commentTrailing = src.commentTrailing;
  }

  // strategy.cancel(id) — 미체결 주문 취소. An entry order is cancelled whatever its type, a market
  // entry included: strategies.txt ("strategy.cancel() and strategy.cancel_all()"): "The
  // strategy.cancel() and strategy.cancel_all() commands can cancel orders of any type, including
  // market orders. However, ... either command can cancel a market order only if its call occurs on
  // the same script execution as the order placement command." A market entry is only ever pending
  // during the execution that placed it (processFills fills it at the next open), so any one found
  // here qualifies. Repros: resin-harness state/repros/mixed-seed-199.json, mixed-seed-333.json
  // (the oracle cancels the same-bar market entry). Not covered yet: the market strategy.order()
  // and strategy.close() orders keep the older rule below (only price-based orders are cancelled;
  // close의 마켓 청산 주문은 cancel 대상이 아님, DIVERGENCES #69).
  // when=(C708) — entry/order/close/close_all/exit(C372/C293/C378/C380)과 동일한 게이트를 마저
  // 이식(hand-verified, DIVERGENCES 신규 — pine2py engine.py cancel(id, when=True)는 when을
  // named parameter로 받으나 본문에서 전혀 참조하지 않는 latent 미적용, literal port 대상 아님).
  cancel(id: string | null | undefined, when: boolean = true): void {
    if (!when) return;
    if (id === null || id === undefined) return;
    const e = this.pendingEntry(id);
    if (e !== undefined) this.removePendingEntry(e);
    // Exit orders are cancelled by their own id, every leg of it (a consumed one too, as in the
    // oracle's `_remove_order_by_id`: "cancel matches an exit by its exit_id only"). An exit is
    // always price-based, so there is no market-order exception.
    for (let i = 0; i < this.exitLegs.length; ) {
      if (this.exitLegs[i]!.id === id) this.exitLegs.splice(i, 1);
      else i++;
    }
    // order 주문(C169)도 entry와 동일 규칙: 가격 기반만 취소 가능(마켓은 다음 바 open 무조건 체결).
    if (this.orderPending && this.orderOrderId === id && this.orderIsPriceBased()) {
      this.orderPending = false;
    }
  }

  // strategy.cancel_all() — 모든 미체결 주문 취소: every entry order (market ones included, see
  // cancel), the exit legs, and a price-based strategy.order() (its market order is not covered yet).
  cancel_all(): void {
    this.pendingEntries.length = 0;
    this.exitLegs.length = 0;
    if (this.orderPending && this.orderIsPriceBased()) {
      this.orderPending = false;
    }
  }

  // limit/stop 중 하나라도 지정된 주문인가(둘 다 NaN이면 마켓). NaN 판별은 자기 비교(x !== x)가
  // 아니라 Number.isNaN으로 명시(가독성 — hot path 아님: 호출 지점이 전부 주문 이벤트 시점).
  private static isPriceBased(e: PendingEntry): boolean {
    return !Number.isNaN(e.limit) || !Number.isNaN(e.stop);
  }

  private orderIsPriceBased(): boolean {
    return !Number.isNaN(this.orderLimit) || !Number.isNaN(this.orderStop);
  }

  // strategy.close(id, qty=) — 마켓 청산 주문 큐잉. 호출 시점에 포지션이 없거나 entry id가 다르면
  // 무시(pine2py close()의 콜타임 가드와 동일 — 이 판정은 체결 시점 축과 무관한 순수 시맨틱이라
  // 이식). qty=(C168)는 부분 청산 수량 — 생략은 전량, na/0 이하는 호출 무시(exit의 qty 가드와
  // 동일한 entry 관례 미러). 같은 바에 close_all이 이미 걸려 있으면 부분 close는 전량 청산의
  // 부분집합이라 무시된다(closeAllPending 필드 주석 참조). when=(C293)은 pine2py
  // close(id="", comment="", when=True, **kwargs)의 게이트 파라미터 literal port — 생략(JS 기본
  // 파라미터가 "생략"과 "명시적 undefined"를 동일 취급)은 항상 true로 떨어져 기존 호출 무변화.
  // qty_percent=(C373, hand-verified) — exit()의 qty_percent와 동일 메커니즘(qty 우선, 생략 시에만
  // |posSize|*percent/100 콜타임 계산). posSize===0 조기 반환이 이 계산보다 먼저라 division 걱정 없음.
  // immediately=(C379, hand-verified — pine2py는 close()가 **kwargs로 흡수해 오라클 불가, TV 공식
  // 시맨틱은 "다음 바 open" 큐잉을 건너뛰고 이 바에서 즉시 체결) — currentClose/currentBarIndex는
  // codegen이 $.close.get(0)/$.idx를 암묵 주입한다(트레이드 접근자 OPEN_TRADE_CLOSE_PRICE_METHODS의
  // unshift와 동일 원리). id 매칭/when 게이트는 즉시·큐잉 두 경로가 공유(분기는 그 이후에만 갈림) —
  // closeAllPending 가드는 "다음 바에 이미 전량 청산이 걸려 있으면 부분 큐잉을 skip"하는 pending-vs-
  // pending 축이라 즉시 체결(지금 당장 발생)에는 적용하지 않는다(즉시 체결로 posSize가 0이 되면
  // 나중에 pending 소비 시점의 기존 posSize!==0 가드가 자연히 no-op 처리).
  // The id of the exit order strategy.close(id) creates. strategies.txt: the command's id
  // "specifies the entry ID of an open trade. It does not represent the ID of the resulting exit
  // order." TradingView names that order "Close entry(s) order <id>" (the oracle's exit_id).
  private static closeExitId(entryId: string): string {
    return `Close entry(s) order ${entryId}`;
  }

  close(
    id: string | null | undefined, qty?: number, comment?: string, when: boolean = true,
    qtyPercent?: number, immediately?: boolean, currentClose?: number, currentBarIndex?: number,
    currentBarTimeMs?: number,
  ): void {
    if (!when) return;
    if (this.posSize === 0) return;
    if (id === null || id === undefined) return;
    // The order closes the open quantity bound to the entries with this id, not the whole
    // position (strategies.txt: "If a market position consists of multiple open trades with the
    // same entry ID, a single strategy.close() call with that ID as its id argument generates a
    // single market order to close all of those trades"; in the FIFO demo the strategy.close("Buy2")
    // order "is for 10 units because it links to the open trade with the "Buy2" entry ID"). Which
    // trades the fill consumes is FIFO (closeAt). Repro: resin-harness state/repros/mixed-seed-5.json.
    const bound = this.boundQty(id);
    if (!(bound > 0)) return;
    const q = qty !== undefined
      ? qty > bound ? bound : qty
      : qtyPercent !== undefined
        ? (bound * qtyPercent) / 100
        : bound;
    if (!(q > 0)) return; // NaN에서도 안전한 긍정형 가드(MEMORY.md C91)
    const cmt = comment ?? "";
    if (immediately) {
      // A market order at the close: slipped against the position (closing a long sells).
      const fill = this.slipped(currentClose ?? NaN, this.posSize > 0 ? -1 : 1);
      this.beginOrder();
      this.closeAt(fill, q, cmt, currentBarIndex ?? NaN, StrategyState.closeExitId(id), currentBarTimeMs ?? NaN, id);
      return;
    }
    if (this.closeAllPending) return;
    this.closePending = true;
    this.closeSeq = ++this.orderSeq;
    this.closeOrderId = id;
    this.closeQty = q;
    this.closeOrderComment = cmt;
  }

  // strategy.close_all() — id 무관 전량 마켓 청산 주문 큐잉(C168). pine2py close_all()의 콜타임
  // flat 가드는 literal port하되, 체결은 콜타임 즉시 _close_position(당일 close — #66 버그 축)이
  // 아니라 close와 동일하게 다음 바 open이다(TV 규칙). closePending 슬롯을 재사용하고 체결 시
  // id 매칭만 생략한다(closeAllPending 플래그) — 먼저 걸린 close(id, qty=) 부분 주문이 있어도
  // 전량으로 덮어쓴다(전량이 부분의 상위집합). when=(C378)은 pine2py
  // close_all(comment: str="", when: bool=True)의 게이트 파라미터 literal port — entry/order
  // (C372)/close(C293)와 동일하게 함수 최상단에서 flat 검증보다 먼저 판정한다(when=false면 posSize
  // 상태와 무관하게 무조건 no-op). immediately=(C379) — close()와 동일 원리(pine2py close_all()은
  // **kwargs 자체가 없어 구조적 크래시, hand-verified). id 개념이 없어 exitId는 close()의 "id 매칭"
  // 대응물이 없는 빈 문자열로 기록한다(기존 pending 경로도 close_all 전용 id를 추적하지 않음 —
  // closeOrderId는 close()만 채우는 필드, 동일 관례 유지).
  close_all(
    comment?: string, when: boolean = true, immediately?: boolean,
    currentClose?: number, currentBarIndex?: number, currentBarTimeMs?: number,
  ): void {
    if (!when) return;
    if (this.posSize === 0) return;
    const cmt = comment ?? "";
    if (immediately) {
      const fill = this.slipped(currentClose ?? NaN, this.posSize > 0 ? -1 : 1); // as in close()
      this.beginOrder();
      this.closeAt(fill, Infinity, cmt, currentBarIndex ?? NaN, "", currentBarTimeMs ?? NaN);
      return;
    }
    this.closePending = true;
    this.closeSeq = ++this.orderSeq;
    this.closeAllPending = true;
    this.closeQty = Infinity;
    this.closeOrderComment = cmt;
  }

  // Context.advance()가 매 바 barFn 실행 **전에** 호출한다 — 마켓 주문은 이번 바 open으로 체결
  // (TV 규칙: 주문은 다음 바 open에서 체결되고, 스크립트는 그 바에서 체결 후의 position_size를
  // 본다), limit/stop 주문(C166)은 이번 바에서 가격 조건을 검사해 충족하면 체결·미충족이면 이월.
  // 처리 순서는 close 먼저 → entry: 같은 바에 청산+재진입이 큐잉됐을 때 둘 다 같은 바에서 순차
  // 체결되는 TV 패턴 재현(TV 실측 미검증 가설 — DIVERGENCES.md 참조). 체결이 트리거됐지만
  // 적격성(같은 방향 + pyramiding 소진)에 막힌 entry는 이월 없이 취소된다(마켓과 동일 소진 규칙).
  // high/low는 limit/stop의 intrabar 판정에만 쓰인다 — 마켓 전용 단위 테스트 호환을 위해 기본값
  // NaN(NaN 비교는 전부 false라 intrabar 트리거가 안전하게 죽는다, MEMORY.md C91 축). 실제 실행
  // 경로(Context.advance)는 항상 세 값을 모두 넘긴다. barIndex(C308, C129 원칙대로 뒤쪽 슬롯 추가
  // — 기존 3-인자 호출부 exact-string 무변화)는 closedtrades.entry_bar_index/exit_bar_index 및
  // opentrades.entry_bar_index 스냅샷의 유일한 소스라, 없으면(단위 테스트 기본값) 그 채널만 NaN.
  // barTimeMs(C320, C129/C308과 동일 원칙 — 뒤쪽 슬롯 추가로 기존 4-인자 호출부 exact-string
  // 무변화)는 strategy.risk.max_intraday_filled_orders의 "거래일" 경계 판정 유일한 소스라, 없으면
  // (단위 테스트 기본값) 그 게이트 자체가 무해하게 no-op(아래 NaN 가드).
  // closePrice ends the bar's path, whose closing segment a trailing stop can still be hit on
  // (walkLeg); without it (unit tests) that segment fills nothing.
  //
  // `sub` is the bar's lower-timeframe bars. With strategy(use_bar_magnifier=true) the orders are
  // judged on them instead of on the chart bar (strategies.txt, "Adjusting historical bar detail":
  // "the broker emulator retrieves open, high, low, and close prices from the bars on a suitable
  // lower timeframe, when possible, to increase the number of ticks available for estimating price
  // action and filling orders on historical bars"): each sub-bar is walked like a bar of its own
  // (fillOnPath), in time order. The market orders fill at the first one's open, which is the chart
  // bar's; a price-based order fills where a sub-bar's path reaches its level, or at the open of the
  // sub-bar after a gap that jumped it ("the emulator fills the order at the opening price of the
  // bar following the gap"). The trades' excursions stay marked on the chart bar's high and low.
  // The oracle does the same (`process_orders_magnified`: the at-open phase on the first sub-bar,
  // the limit/stop phase on every sub-bar, the P&L phase on the chart bar), except that it fills
  // a gapped level only at the first sub-bar's open (resin-harness state/disputes.md D4).
  // Tier 1: resin-harness suites/strategy/tv/bar_magnifier (a 1D chart judged on its 60m bars;
  // trade 10, a short entered at 80734.48 whose 81734.37 stop-loss the hours reach before its
  // 79234.37 take-profit, where the day's path alone reaches the take-profit first). Without `sub`,
  // or a bar with no sub-bars in it, the chart bar is walked as usual.
  processFills(
    openPrice: number, high: number = NaN, low: number = NaN, barIndex: number = NaN, barTimeMs: number = NaN,
    closePrice: number = NaN, sub?: SubBarWindow,
  ): void {
    if (!Number.isNaN(barTimeMs)) {
      const d = new Date(barTimeMs);
      const dayKey = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (dayKey !== this.intradayDayKey) {
        this.intradayDayKey = dayKey;
        this.intradayFilledCount = 0;
        // strategy.risk.max_intraday_loss(C322) — 거래일 전환 시 이번 거래일의 peak/래치를
        // 리셋(updateDrawdown이 이번 바 close로 intradayPeakEquity를 새로 시드).
        this.intradayPeakEquity = NaN;
        this.intradayLossLimitReached = false;

        // strategy.risk.max_cons_loss_days(C325) — 이 전환 시점에 "끝난"(직전) 거래일의 실현손익을
        // 판정한다: consLossDayStartRealizedPnl이 아직 NaN이면 이번이 관측된 첫 거래일 전환이라
        // 비교 대상(직전 거래일)이 없어 시드만 하고 스트릭 판정은 건너뛴다(intradayPeakEquity류
        // "첫 관측 시드" 패턴과 동일). 그 외엔 realizedPnl 변화량이 음수면 손실일 -> 스트릭 +1,
        // 0 이상(무손실 또는 무거래일 포함)이면 스트릭 리셋. consLossLimitReached는 max_drawdown과
        // 동일한 영구 래치라 여기서 리셋하지 않는다.
        if (!Number.isNaN(this.consLossDayStartRealizedPnl)) {
          const dayPnl = this.realizedPnl - this.consLossDayStartRealizedPnl;
          if (dayPnl < 0) {
            this.consLossDayCount += 1;
            if (
              !this.consLossLimitReached &&
              !Number.isNaN(this.maxConsLossDaysValue) &&
              this.consLossDayCount >= this.maxConsLossDaysValue
            ) {
              this.consLossLimitReached = true;
            }
          } else {
            this.consLossDayCount = 0;
          }
        }
        this.consLossDayStartRealizedPnl = this.realizedPnl;
      }
    }
    for (const e of this.pendingEntries) e.placedThisBar = false;
    for (const l of this.exitLegs) l.placedThisBar = false;
    this.orderPlacedThisBar = false;
    this.freshLegs.length = 0;
    // A leg waiting on a pending entry order lives only as long as that order: once it is gone
    // (cancelled, or consumed without opening a position) the leg has nothing to close. The oracle
    // drops it at the bar's open too (tier 2, measured on TradingView: "TradingView does not let it
    // reach the position an OLDER entry of the same id still holds"). Not covered: the oracle keeps
    // a from_entry-less one and re-aims it at the next position that opens.
    for (let i = 0; i < this.exitLegs.length; ) {
      const l = this.exitLegs[i]!;
      if (l.binding === null && this.pendingEntry(l.entryId) === undefined) this.exitLegs.splice(i, 1);
      else i++;
    }
    if (sub !== undefined && this.useBarMagnifier && sub.from < sub.to) {
      for (let k = sub.from; k < sub.to; k++) {
        this.fillOnPath(sub.open[k]!, sub.high[k]!, sub.low[k]!, sub.close[k]!, barIndex, barTimeMs, k === sub.from);
      }
    } else {
      this.fillOnPath(openPrice, high, low, closePrice, barIndex, barTimeMs, true);
    }
    this.updateTradeExcursion(high, low);
  }

  // Fills what the price path open → nearer extreme → farther extreme → close reaches: the chart bar,
  // or one of its sub-bars under the bar magnifier (processFills; `chartOpen` marks the path that
  // starts at the chart bar's open). The market orders are all filled at the first path's open, so a
  // later sub-bar only meets price-based orders and exit legs.
  //
  // The fills happen segment by segment, in the order the path reaches them: first everything at the
  // open, then each segment to an extreme, then the closing segment. So a market reversal at the open
  // closes the old position before its stop-loss further down the bar could (strategies.txt: a market
  // order executes "on the next available tick"; probe resin-harness suites/strategy/probes/C23.json).
  // On one segment the exit legs of entries filled on earlier bars go first, then the entry orders
  // (each followed by the legs its fill binds), then the strategy.order() slot. Between the segments
  // the broker emulator judges margin calls (marginCheckpoint), so a margin call at an extreme meets
  // the position the path left there: an exit whose level lies further on fills what the liquidation
  // left (the oracle, measured on TradingView: "a partial 'Margin call' at the high preceded the
  // trailing exit filling near the low of the same bar").
  private fillOnPath(
    openPrice: number, high: number, low: number, closePrice: number, barIndex: number, barTimeMs: number,
    chartOpen: boolean,
  ): void {
    // strategies.txt ("Broker emulator"): open → high → low → close when the open is closer to the
    // high, else open → low → high → close (halfway walks down first, as in the oracle).
    this.pathUpFirst = high - openPrice < openPrice - low;
    this.barPath[0] = openPrice;
    this.barPath[1] = this.pathUpFirst ? high : low;
    this.barPath[2] = this.pathUpFirst ? low : high;
    this.barPath[3] = closePrice;
    this.legQueue.length = 0;
    this.fillMoment++; // the open
    if (this.closePending) this.fillPendingClose(openPrice, barIndex, barTimeMs);
    // exit 브래킷(C167)은 close(마켓 청산) 다음, entry 앞에서 판정한다 — 마켓 close는 open 체결이라
    // 항상 이 바의 첫 가격이고, exit도 청산 계열이라 기존 "청산 먼저 → entry" 순서 원칙에 합류한다
    // (같은 바에 exit 체결+재진입 entry 체결이 순차 발생 가능 — TV 실측 미검증 가설, DIVERGENCES #70).
    // These are the legs bound to entries filled on earlier bars; the legs an entry fill of this bar
    // binds are judged after that fill.
    this.queueExitLegs(false, 0);
    this.runExitLegs(0, barIndex, barTimeMs, false);
    // The market orders, and the orders whose level the open is already past, fill at the open, all
    // before any intrabar price. The legs their fills bind are judged once they are all done (a
    // second market entry meets the position the first one opened, not the exit's close; repro
    // resin-harness state/repros/mixed-seed-475.json).
    const due = this.dueEntries(openPrice, high, low);
    let i = 0;
    for (; i < due.length && due[i]!.pathLeg === 0; i++) {
      if (this.pendingEntries.includes(due[i]!)) this.fillPendingEntry(due[i]!, due[i]!.fillPrice, barIndex, barTimeMs);
    }
    this.queueExitLegs(true, 0);
    this.runExitLegs(0, barIndex, barTimeMs, false);
    // order 넷팅 주문(C169)은 같은 경로 지점의 entry 다음에 판정한다 — 청산 계열 먼저 원칙(기존 순서
    // 불변) + 같은 지점에서 entry와 order가 둘 다 체결되면 entry가 만든 포지션에 대해 order가
    // 넷팅한다(고정 슬롯 모델의 결정론적 순서 — pine2py는 _pending_orders 삽입 순서, TV 실측 미검증
    // 가설 DIVERGENCES #72). 가격 판정은 entry와 동일한 directionalFillPrice(마켓=open,
    // limit/stop=조건 충족 시 체결·미충족 시 이월, 갭 오픈 or-better #69 (a) 축).
    let orderFill = NaN;
    let orderSeg = -1;
    if (this.orderPending) {
      orderFill = this.directionalFillPrice(this.orderDirection, this.orderLimit, this.orderStop, openPrice, high, low);
      if (!Number.isNaN(orderFill)) orderSeg = orderFill === openPrice ? 0 : orderFill > openPrice === this.pathUpFirst ? 1 : 2;
    }
    if (orderSeg === 0) this.fillOrderOnPath(orderFill, 0, barIndex, barTimeMs);
    // The margin call at the open, after the open's fills: only on the chart bar's open (a later
    // sub-bar's open is inside the bar; the oracle judges it in its at-open phase alone).
    if (chartOpen) this.marginCall(openPrice, this.posSize < 0, barIndex, barTimeMs, true, false, false);
    // The trailing lines of the legs bound so far are walked ahead of the level fills, up to the
    // farther extreme: a line hit on the way back from the nearer extreme closes its trade before an
    // entry level on the way to that extreme reverses it. This is the oracle's order (tier 2,
    // `_process_limit_stop_orders`: "Trailing stops walk the assumed intrabar path themselves ... so
    // they are processed here rather than inside the level-indexed walk — but only up to the second
    // extreme"; repro resin-harness state/repros/mixed-seed-45.json).
    this.runExitLegs(2, barIndex, barTimeMs, true);
    // An entry or strategy.order() level reached on a segment fills there, nearer the segment's start
    // first; an exit leg of an earlier bar's entry fills on the segment its walk reached (walkLeg).
    // A margin call deferred at the first extreme stops the level fills for the rest of the path; the
    // trailing lines still fill (see marginCall).
    let deferred = false;
    for (let s = 1; s <= 2; s++) {
      this.fillMoment++; // segment s
      this.runExitLegs(s, barIndex, barTimeMs, deferred);
      if (deferred) continue;
      for (; i < due.length && due[i]!.pathLeg === s; i++) {
        if (!this.pendingEntries.includes(due[i]!)) continue; // cancelled by an OCA sibling's fill
        this.fillPendingEntry(due[i]!, due[i]!.fillPrice, barIndex, barTimeMs);
        this.queueExitLegs(true, s);
        this.runExitLegs(s, barIndex, barTimeMs, false);
      }
      if (orderSeg === s) this.fillOrderOnPath(orderFill, s, barIndex, barTimeMs);
      deferred = this.marginCheckpoint(s, barIndex, barTimeMs);
    }
    this.runExitLegs(3, barIndex, barTimeMs, deferred);
    this.legQueue.length = 0;
    due.length = 0;
  }

  // Fills the strategy.order() slot at `orderFill`, reached on path segment `seg`, and queues the legs
  // its fill binds.
  private fillOrderOnPath(orderFill: number, seg: number, barIndex: number, barTimeMs: number): void {
    this.fillPendingOrder(orderFill, barIndex, barTimeMs);
    this.queueExitLegs(true, seg);
    this.runExitLegs(seg, barIndex, barTimeMs, false);
  }

  // strategy(process_orders_on_close=true): the extra fill attempt at the bar's close, after the
  // script body ran (Context.finishBar). The manual (strategies.txt, "process_orders_on_close"): "If
  // the value is true, the broker emulator can fill orders created on a bar's close immediately, on
  // the same tick, rather than waiting for the next available tick"; props.txt: "If the orders are
  // market orders, the broker emulator executes them before the next bar's open. If the orders are
  // price-dependent, they will only be filled if the price conditions are met." So only the orders
  // the script placed on this bar take part (the ones resting from earlier bars already met this
  // bar's prices in processFills), and the close is the single price they are judged at and fill
  // at. The exits go last: the entry they are bound to may have just filled. The oracle's close pass
  // runs in the same order (market orders, then triggered entries, then exits).
  // Repro: resin-harness state/repros/mixed-seed-4.json.
  processFillsAtClose(closePrice: number, barIndex: number = NaN, barTimeMs: number = NaN): void {
    if (!this.processOrdersOnClose) return;
    this.fillMoment++;
    if (this.closePending) this.fillPendingClose(closePrice, barIndex, barTimeMs);
    if (this.pendingEntries.length > 0) this.fillPendingEntriesAtClose(closePrice, barIndex, barTimeMs);
    if (this.orderPending && this.orderPlacedThisBar) {
      const orderFill = this.directionalFillPrice(
        this.orderDirection, this.orderLimit, this.orderStop, closePrice, closePrice, closePrice,
      );
      if (!Number.isNaN(orderFill)) this.fillPendingOrder(orderFill, barIndex, barTimeMs);
    }
    this.freshLegs.length = 0;
    this.fillExitLegsAtClose(closePrice, barIndex, barTimeMs);
  }

  // Fills the pending strategy.close()/close_all() market order at `fillPrice`, slipped against the
  // position (closing a long sells).
  private fillPendingClose(fillPrice: number, barIndex: number, barTimeMs: number): void {
    this.closePending = false;
    const ignoreId = this.closeAllPending; // close_all(C168) — id 매칭 생략(전량 청산)
    this.closeAllPending = false;
    if (this.posSize !== 0 && (ignoreId || this.hasBound(this.closeOrderId))) {
      // close_all has no entry id: its exit id is "" as on its immediately= path.
      this.beginOrder();
      this.closeAt(
        this.slipped(fillPrice, this.posSize > 0 ? -1 : 1), this.closeQty, this.closeOrderComment, barIndex,
        ignoreId ? "" : StrategyState.closeExitId(this.closeOrderId), barTimeMs,
        ignoreId ? null : this.closeOrderId,
      );
    }
  }

  // Judges every unfilled entry order against the path and returns the triggered ones (entryScratch)
  // in the order the path reaches them. strategies.txt ("Broker emulator"): "If the opening price of
  // a bar is closer to the high than it is to the low, the emulator assumes that the market price
  // moved in this order: open → high → low → close. If the opening price of a bar is closer to the low
  // than it is to the high, the emulator assumes that the market price moved in this order: open →
  // low → high → close." (An open halfway between them walks down first, as in the oracle.) A market
  // order, or one whose level the open already crossed, fills at the open, first; the rest fill where
  // the path reaches their level: on the leg to the nearer extreme before the leg to the farther one,
  // and on one leg nearer the open first. Orders reached at one point fill in placement order. Each
  // fill meets the position the previous one left, so the second of two stop entries a bar crosses
  // reverses the first one's position (or is dropped by the pyramiding gate at the fill); an order an
  // earlier fill cancelled through its OCA group is no longer in the book by its turn (fillOnPath).
  // An exit leg an entry fill binds (placed against the pending entry order, or spawned for a pyramid
  // add; bindLegs) is live on the fill bar itself, not from the next one: the order exists before the
  // fill, so the rest of this bar can trigger it (the manual's "Take-profit and stop-loss demo" places
  // both on one bar), over the path from that fill on (walkLeg).
  private dueEntries(openPrice: number, high: number, low: number): PendingEntry[] {
    const due = this.entryScratch;
    due.length = 0;
    for (const e of this.pendingEntries) {
      const price = this.directionalFillPrice(e.direction, e.limit, e.stop, openPrice, high, low);
      if (Number.isNaN(price)) continue; // its level is not reached on this bar: the order rests
      e.fillPrice = price;
      e.pathLeg = price === openPrice ? 0 : price > openPrice === this.pathUpFirst ? 1 : 2;
      e.pathDist = Math.abs(price - openPrice);
      due.push(e);
    }
    if (due.length > 1) due.sort((a, b) => a.pathLeg - b.pathLeg || a.pathDist - b.pathDist || a.seq - b.seq);
    return due;
  }

  // The close pass (processFillsAtClose) for the entry orders placed on this bar: the market ones
  // first, then the price-based ones the close has reached, each group in placement order, as the
  // oracle's close pass collects its candidates.
  private fillPendingEntriesAtClose(closePrice: number, barIndex: number, barTimeMs: number): void {
    const due = this.entryScratch;
    due.length = 0;
    for (const e of this.pendingEntries) if (e.placedThisBar && !StrategyState.isPriceBased(e)) due.push(e);
    for (const e of this.pendingEntries) if (e.placedThisBar && StrategyState.isPriceBased(e)) due.push(e);
    for (const e of due) {
      if (!this.pendingEntries.includes(e)) continue; // cancelled by an OCA sibling's fill
      const price = this.directionalFillPrice(e.direction, e.limit, e.stop, closePrice, closePrice, closePrice);
      if (!Number.isNaN(price)) this.fillPendingEntry(e, price, barIndex, barTimeMs);
    }
    due.length = 0;
  }

  // Fills the entry order `e` at `fillPrice`, its trigger already judged: it closes what it can of
  // an opposite position first, then the risk and pyramiding gates decide whether the rest opens a
  // trade. The order is consumed either way.
  private fillPendingEntry(e: PendingEntry, fillPrice: number, barIndex: number, barTimeMs: number): void {
    this.removePendingEntry(e);
    const before = this.posSize;
    const sign = e.direction === "long" ? 1 : -1;
    // A market or stop entry fills slipped against it, the reversal's closing leg included (one
    // order, one price); a limit entry, and a stop-limit (a limit order once its stop triggers),
    // keeps its price.
    if (Number.isNaN(e.limit)) fillPrice = this.slipped(fillPrice, sign);
    // A default-sized limit/stop entry divides its frozen budget by the actual fill price now (see
    // defaultOrderQty). Nothing sizable consumes the order unfilled, reversal included. Zero lots
    // still close an opposite position and open nothing (the oracle keeps the reversal leg).
    let qty = e.qty;
    if (e.qtyAuto) {
      qty = this.moneyQtyAt(e.qty, fillPrice);
      if (Number.isNaN(qty)) return;
    }
    // strategy.risk.allow_entry_in(C309) — 금지된 방향의 entry는 아래 리버스-청산(있었다면)
    // 까지만 수행하고 신규 포지션/피라미딩 추가는 열지 않는다("position-closing order
    // instead of a reversal" — call-expr.ts strategy.risk.allow_entry_in 분기 주석의 TV 문서
    // 발췌 근거 참조). "all"(기본값)이면 이 게이트는 항상 false — 기존 무제한 동작 무변화.
    const directionForbidden =
      this.allowedDirection !== "all" && e.direction !== this.allowedDirection;
    // strategy.risk.max_intraday_filled_orders(C320) — 오늘 이미 상한만큼 신규 체결됐으면
    // directionForbidden과 동일하게 "위 리버스 청산까지만" 허용하고 아래 오픈/피라미딩 분기는
    // 막는다(REMARKS "market order to exit ... still allowed"). 카운터는 오픈/피라미딩 분기가
    // 실제로 실행될 때만 +1 — 청산 전용 체결(반대 방향 entry의 리버스-청산 부분, close/exit)은
    // 세지 않는다(TV 미검증 가설 — call-expr.ts 분기 주석 근거 참조).
    const intradayLimitReached =
      !Number.isNaN(this.maxIntradayFilledOrders) &&
      this.intradayFilledCount >= this.maxIntradayFilledOrders;
    // strategy.risk.max_drawdown/max_intraday_loss(C322)/max_cons_loss_days(C325) — allow_entry_in/
    // max_intraday_filled_orders와 동일한 "위 리버스 청산까지만 허용" 게이트에 합류.
    const drawdownForbidden =
      this.drawdownLimitReached || this.intradayLossLimitReached || this.consLossLimitReached;
    // The order is its own quantity plus the flip (see entry()): a market order's is the opposite
    // position its fill meets, a limit/stop order's the one frozen at placement. Against an opposite
    // position it closes up to that position, oldest trade first, and opens what is left: all of it
    // and the rest in its own direction (a reversal), all of it and nothing, or only part of it
    // (tier 1 resin-harness suites/strategy/tv/slippage_limit trade 6). A flip that finds a smaller
    // position, or none, opens its excess (the oracle, measured: "the unspent flip opens under the
    // entry's id"). An order of zero size executes nothing.
    const held = this.posSize !== 0 && this.posSize > 0 !== sign > 0 ? Math.abs(this.posSize) : 0;
    const flip = Number.isNaN(e.flip) ? held : e.flip;
    if (!(qty + flip > 0)) return;
    const closesAll = held > 0 && (flip === held || qty + flip >= held);
    const closeQty = held === 0 ? 0 : closesAll ? held : toUnits(qty + flip, this.lotsPerContract);
    // A flip equal to the position it meets leaves exactly the order's own quantity to open.
    qty = flip === held ? qty : closesAll || held === 0 ? toUnits(qty + flip - held, this.lotsPerContract) : 0;
    // A reversal is one order executed as two legs, so both share one commission pool stamped with
    // the order's whole quantity: the position it closes plus what it opens (nothing when a gate
    // below keeps it from opening). The oracle measured it on TradingView (see bookCommission).
    const reverses = closeQty > 0;
    let orderQty = 0;
    if (reverses) {
      const openQty = Number.isNaN(this.maxPositionSizeValue) ? qty : Math.max(0, Math.min(qty, this.maxPositionSizeValue));
      const opens = !(directionForbidden || intradayLimitReached || drawdownForbidden) && openQty > 0;
      orderQty = toUnits(closeQty + (opens ? openQty : 0), this.lotsPerContract);
    }
    this.beginOrder(orderQty);
    if (reverses) {
      // 반대 방향이면 리버스(TV: 반대 direction entry는 기존 포지션 청산 후 진입 — pine2py
      // entry()의 콜타임 `_close_position` + `_fill_entry` "새 Position" 분기를 체결 시점으로
      // 옮긴 것, DIVERGENCES #67). 청산을 실현 손익으로 기록(closedtrades 1건)한 뒤 flat이 되어
      // 아래 새 포지션 분기로 이어진다 — C164의 "포지션 교체" 단축과 포지션 관측은 동일하고
      // 계좌 속성 관측만 추가된 것. limit/stop 체결도 동일 경로(청산가 = 그 주문의 체결가).
      // exit_comment(C173)는 pine2py `self._close_position(id, comment)`처럼 **청산을 유발한
      // 새 entry 주문 자신의 comment**를 쓴다(_close_position이 exit_id/comment 인자를
      // exit()의 그것이 아니라 리버스를 일으킨 entry()의 id/comment로 호출하는 것의 미러).
      this.closeAt(fillPrice, closesAll ? Infinity : closeQty, e.comment, barIndex, e.id, barTimeMs, null, qty > 0);
    }
    // strategy.risk.max_position_size(value)(C324) — 위 3형제(directionForbidden 등)와 달리
    // "전면 차단"이 아니라 "부족분만 체결"이다(TV 문서: "quantity of new strategy.entry orders
    // will be reduced if necessary to prevent exceeding this limit"). 위 리버스 청산 이후
    // 시점의 |posSize|(리버스가 있었다면 이미 0)를 "기존 같은 방향 보유량"으로 삼아 남은 여유만
    // qty에서 깎는다 — 이미 한도 이상이면 0으로 축소돼 아래 오픈/피라미딩 분기 자체가
    // 무해하게 스킵된다(긍정형 가드, C91과 동일 원칙).
    if (!Number.isNaN(this.maxPositionSizeValue)) {
      qty = Math.max(0, Math.min(qty, this.maxPositionSizeValue - Math.abs(this.posSize)));
    }
    if (directionForbidden || intradayLimitReached || drawdownForbidden || qty <= 0) {
      // 위 청산까지만 — 아래 신규/피라미딩 분기 스킵(주문 자체는 소진, 이월 없음).
    } else if (this.posSize === 0) {
      this.openTradeAt(e.id, e.comment, fillPrice, sign * qty, barIndex, barTimeMs);
      this.intradayFilledCount += 1;
    } else if (this.entryCount < this.pyramiding) {
      // A pyramiding add opens its own trade beside the earlier ones (it is not merged into
      // them): "Pyramiding specifies the maximum number of open trades, from the orders created
      // by strategy.entry() calls, that a strategy allows for a single position"
      // (strategies.txt). pyramiding=0 never gets here (0 < 0), the same as 1.
      // 자동 수량의 추가 진입 equity에는 기존 포지션의 미실현 손익(체결가 기준)이 포함된다.
      this.openTradeAt(e.id, e.comment, fillPrice, sign * qty, barIndex, barTimeMs);
      this.intradayFilledCount += 1;
    }
    // else: 같은 방향 + pyramiding 소진 → 주문 취소(이월 없음)
    this.applyOca(e.ocaName, e.ocaType, toUnits(StrategyState.executedQty(before, this.posSize), this.lotsPerContract));
  }

  // Fills the pending strategy.order() at `orderFill`, its trigger already judged: netted against an
  // opposite position first, the rest opening a trade.
  private fillPendingOrder(orderFill: number, barIndex: number, barTimeMs: number): void {
    this.orderPending = false;
    const before = this.posSize;
    const sign = this.orderDirection === "long" ? 1 : -1;
    if (Number.isNaN(this.orderLimit)) orderFill = this.slipped(orderFill, sign); // as in fillPendingEntry
    // A default-sized limit/stop order resolves at its fill price, as in fillPendingEntry; zero lots
    // consume it unfilled.
    let qty = this.orderQtyAuto ? this.moneyQtyAt(this.orderQty, orderFill) : this.orderQty;
    if (!(qty > 0)) return;
    const opposite = this.posSize !== 0 && this.posSize > 0 !== sign > 0;
    // An order that nets through an opposite position into a new one is a reversal: its two legs
    // share one commission pool over its whole quantity, as in fillPendingEntry.
    this.beginOrder(opposite && qty > Math.abs(this.posSize) ? qty : 0);
    if (opposite) {
      // 반대 방향은 |posSize|와 상쇄 — 축소분을 실현 손익으로 기록(closeAt 부분 산식 재사용,
      // C168 인프라의 자연 확장: avg/entryId/entryCount 유지, 전량 도달 시 flat 리셋 + 브래킷
      // 소멸까지 기존 경로와 동치). qty가 |posSize|를 초과하면 잔여분이 아래 분기에서 반대
      // 방향 새 포지션이 된다(부호 반전 — entry의 리버스 전량+전량과 달리 넷 수량만 진입).
      const size = Math.abs(this.posSize);
      const reduceQty = qty < size ? qty : size;
      // exit_comment(C173)는 entry 리버스 분기와 같은 가설(주문 자신의 comment) — order()엔
      // pine2py 대응 구현이 없어(DIVERGENCES #72) 대칭성만 근거로 삼는다.
      this.closeAt(orderFill, reduceQty, this.orderOrderComment, barIndex, this.orderOrderId, barTimeMs, null, qty > size);
      qty -= reduceQty;
    }
    if (qty > 0) {
      // Opens a trade of its own, from flat or beside the open ones — with no pyramiding gate
      // (strategies.txt: strategy.order() "ignores most properties, such as pyramiding"). Its
      // entry still takes a slot the next strategy.entry() is gated on (entryCount).
      this.openTradeAt(this.orderOrderId, this.orderOrderComment, orderFill, sign * qty, barIndex, barTimeMs);
    }
    this.applyOca(
      this.orderOcaName, this.orderOcaType,
      toUnits(StrategyState.executedQty(before, this.posSize), this.lotsPerContract),
    );
  }

  // Judges live exit legs against the rest of the path — every leg bound to a filled entry
  // (`onlyFresh` false), or only the legs this bar's last entry fill bound (freshLegs), which fill
  // from that entry's fill on path segment `seg` (0 = at the open) — and queues the triggered ones
  // with where the path reaches them (walkLeg: the first tick, then segment by segment). A leg queued
  // before and bound anew is walked again from its new entry.
  private queueExitLegs(onlyFresh: boolean, seg: number): void {
    const legs = onlyFresh ? this.freshLegs : this.exitLegs;
    if (legs.length === 0) return;
    if (this.posSize !== 0) {
      for (const l of legs) {
        if (l.consumed || l.binding === null) continue;
        const queued = this.legQueue.indexOf(l);
        if (queued >= 0) this.legQueue.splice(queued, 1);
        const price = this.walkLeg(l, seg, seg === 0 ? this.barPath[0]! : l.binding.entryPrice);
        if (Number.isNaN(price)) continue;
        l.fillPrice = price;
        this.legQueue.push(l);
      }
    }
    if (onlyFresh) this.freshLegs.length = 0;
  }

  // Fills the queued exit legs the path reaches by segment `upTo` (only the trailing lines when
  // `trailingOnly`, see marginCall), in the order it reaches them: segment, then nearer the segment's
  // start, then placement order. Each fill meets the position the previous one left, so a leg whose
  // entry an earlier fill spent is gone by its turn.
  private runExitLegs(upTo: number, barIndex: number, barTimeMs: number, trailingOnly: boolean): void {
    const queue = this.legQueue;
    if (queue.length === 0) return;
    const due = this.legScratch;
    due.length = 0;
    for (let i = 0; i < queue.length; ) {
      const l = queue[i]!;
      if (l.pathLeg <= upTo && (!trailingOnly || l.fillKind === null)) {
        due.push(l);
        queue.splice(i, 1);
      } else {
        i++;
      }
    }
    if (due.length > 1) due.sort((a, b) => a.pathLeg - b.pathLeg || a.pathDist - b.pathDist || a.seq - b.seq);
    for (const l of due) {
      if (this.posSize !== 0 && !l.consumed && l.binding !== null && this.exitLegs.includes(l)) {
        this.executeLeg(l, l.fillPrice, barIndex, barTimeMs);
      }
    }
    due.length = 0;
  }

  // The margin calls the broker emulator judges after path segment `seg` (1 = the segment to the
  // extreme nearer the open, 2 = the one to the farther extreme), at the extremes; true when one was
  // deferred to the bar's close (marginCall). A position is judged at its adverse extreme once the
  // segment reaching it has filled; the oracle also judges the favourable extreme where fills can
  // have grown the position (a pyramid entry filled on the way up), or where its equity is compared
  // in whole ticks (marginCall): after the first segment and, on an open → low → high → close path,
  // before the second one too. This is the oracle's checkpoint order (tier 2, `_process_limit_stop_orders`,
  // measured on TradingView: a long's margin call "at H-slip right after the rising leg's fills").
  private marginCheckpoint(seg: number, barIndex: number, barTimeMs: number): boolean {
    const near = this.barPath[1]!;
    const far = this.barPath[2]!;
    if (seg === 1) {
      if (this.pathUpFirst) {
        if (this.marginCall(near, true, barIndex, barTimeMs, false, true, false)) return true;
        this.marginCall(near, false, barIndex, barTimeMs, false, false, false);
        this.marginCall(far, true, barIndex, barTimeMs, false, false, false);
      } else {
        if (this.marginCall(near, false, barIndex, barTimeMs, false, true, false)) return true;
        this.marginCall(far, false, barIndex, barTimeMs, false, false, false);
      }
    } else if (this.pathUpFirst) {
      this.marginCall(far, false, barIndex, barTimeMs, false, false, false);
    } else {
      this.marginCall(far, true, barIndex, barTimeMs, false, false, false);
      this.marginCall(far, false, barIndex, barTimeMs, false, false, false);
    }
    return false;
  }

  // The margin calls judged at the bar's close, after the script body and the process_orders_on_close
  // pass (Context.finishBar): a margin call deferred there from an extreme (marginCall), then the
  // close itself, where a shortfall is covered in whole contracts. The oracle's
  // `process_deferred_margin_call` (tier 2, measured on TradingView: "TV trims 1.0 contract at
  // C=80898.0 on the 02:00 bar while the O/H/L walk points all pass the margin comparison").
  settleMargin(closePrice: number, barIndex: number = NaN, barTimeMs: number = NaN): void {
    const d = this.mcDeferred;
    if (d !== null) {
      this.mcDeferred = null;
      this.marginCall(d.price, d.short, barIndex, barTimeMs, true, false, false);
    }
    this.marginCall(closePrice, this.posSize < 0, barIndex, barTimeMs, true, false, true);
  }

  // A margin call on the short (`short`) or long position at `price`. strategies.txt ("Margin and
  // leverage"): "the broker emulator generates margin call events if a strategy's available funds fall
  // below the required margin percentage. Each time that a margin call event occurs, the emulator
  // immediately liquidates four times the number of contracts/shares/lots/units required to cover the
  // loss", with MVS = size × price, equity = initial capital + net profit + open profit, margin = MVS ×
  // margin percent / 100, available funds = equity − margin, loss = available funds / margin ratio,
  // cover amount = TRUNCATE(loss / price) "to the same decimal precision as the minimum position size",
  // margin call size = cover amount × 4; and "short trades in a strategy that uses any nonzero margin
  // are subject to forced liquidation from margin call events, even if the margin_short argument is
  // 100". The liquidation is a market order: it fills at `price`, slipped against the position, as a
  // closing fill that closes the oldest trades first, and its exit has no id (na) and the comment
  // "Margin call". Returns true when the call is deferred instead.
  //
  // The rest is the oracle's measurement of TradingView (tier 2, `_check_margin_call`):
  // - From 1e7 of equity upward the trigger compares whole ticks: the equity truncated against the
  //   margin rounded half-up (to a multiple of 10 ticks from 1e10 margin ticks), so it can fire on a
  //   sub-tick surplus; above 1e10 margin ticks the cover comes from that tick shortfall.
  // - A shortfall under one lot on a fractional lot grid closes one whole contract (at most the
  //   position); on a whole-lot grid it covers one lot. `wholeContracts` (the close check) sizes in
  //   whole contracts on any grid.
  // - A one-lot margin call at the first extreme (`canDefer`) whose position would still be short of
  //   margin at the path's close is deferred to the bar's close (settleMargin); the path's level fills
  //   stop there, its trailing lines still fill (fillOnPath).
  // - A liquidation arms a second stage for the next checkpoint of its bar (marginCallStage2).
  private marginCall(
    price: number, short: boolean, barIndex: number, barTimeMs: number,
    atOpen: boolean, canDefer: boolean, wholeContracts: boolean,
  ): boolean {
    if (this.openTrades.length === 0 || (short ? this.posSize >= 0 : this.posSize <= 0)) return false;
    const percent = short ? this.marginShort : this.marginLong;
    if (!(percent > 0) || Number.isNaN(price)) return false;
    const stage = this.mcStage2;
    if (stage !== null) {
      this.mcStage2 = null;
      if (stage.bar === barIndex && stage.short === short && this.marginCallStage2(stage, price, short, barIndex, barTimeMs)) {
        return false;
      }
    }
    const qty = Math.abs(this.posSize);
    const pv = this.pointvalue;
    const moneySpent = qty * this.posAvgPrice * pv;
    const mvs = qty * price * pv;
    const openProfit = short ? -(mvs - moneySpent) : mvs - moneySpent;
    const equity = this.initialCapital + this.realizedPnl + openProfit;
    const ratio = percent / 100;
    const margin = mvs * ratio;
    const available = equity - margin;
    const mintick = this.mintick;
    let bigMargin = false;
    let equityTicks = 0;
    let marginTicks = 0;
    if (equity >= 1e7 && mintick > 0) {
      equityTicks = Math.floor(equity / mintick);
      marginTicks = margin / mintick;
      bigMargin = marginTicks >= 1e10;
      marginTicks = bigMargin ? 10 * roundHalfEven(marginTicks / 10) : Math.floor(marginTicks + 0.5);
      if (equityTicks >= marginTicks) return false;
    } else if (available >= 0) {
      return false;
    }
    const lots = wholeContracts ? 1 : this.lotsPerContract;
    let cover: number;
    if (bigMargin) {
      cover = Math.max(0, Math.trunc((((marginTicks - equityTicks) * mintick) / ratio / (price * pv)) * lots));
    } else {
      cover = marginCoverLots((Math.abs(available / ratio) / (price * pv)) * lots);
    }
    let mcLots: number;
    let size: number;
    if (cover === 0 && lots > 1) {
      mcLots = 0;
      size = Math.min(1, qty);
    } else {
      mcLots = Math.max(1, cover * 4);
      size = mcLots / lots;
    }
    if (size > qty) size = qty;
    const close = this.barPath[3]!;
    if (!atOpen && canDefer && mcLots === 1 && price !== close) {
      const closeMvs = qty * close * pv;
      const closeProfit = short ? -(closeMvs - moneySpent) : closeMvs - moneySpent;
      if (this.initialCapital + this.realizedPnl + closeProfit - closeMvs * ratio < 0) {
        this.mcDeferred = { price: close, short };
        return true;
      }
    }
    const trades: number[] = [];
    for (const t of this.openTrades) trades.push(Math.abs(t.size), t.entryPrice);
    this.mcStage2 = {
      bar: barIndex, deficit: bigMargin ? (marginTicks - equityTicks) * mintick : -available, price, short, trades,
    };
    this.beginOrder();
    this.closeAt(this.slipped(price, short ? 1 : -1), size, "Margin call", barIndex, null, barTimeMs, null);
    return false;
  }

  // The second stage of a margin call, at the next checkpoint of the bar whose earlier checkpoint
  // (`stage.price`) liquidated part of the position. The oracle measured it on TradingView (tier 2,
  // `_margin_call_stage2`, "848/848 margin-call bars exact"): the available funds there do not reflect
  // the first liquidation's proceeds; TradingView walks the trades open before it, oldest first,
  // crediting each one's entry cost at once and its gain at the first stage's price (net of the exit
  // commission) one trade late, and stops before the credit covers the first stage's shortfall. What
  // is left is covered four times over, sized at the first stage's price, and filled at `price`. When
  // the first trade's cost alone covers the shortfall (the common single-trade case) nothing fires
  // and the checkpoint judges the position as usual. Returns true when the second stage fired.
  private marginCallStage2(stage: MarginCallStage, price: number, short: boolean, barIndex: number, barTimeMs: number): boolean {
    const ratio = (short ? this.marginShort : this.marginLong) / 100;
    const pv = this.pointvalue;
    let credited = 0;
    let gain = 0;
    let steps = 0;
    let left = stage.deficit;
    for (let j = 0; j < stage.trades.length; j += 2) {
      const qty = stage.trades[j]!;
      const entryPrice = stage.trades[j + 1]!;
      const cost = qty * entryPrice * pv;
      if (stage.deficit - (credited + cost) - gain < 0) break;
      credited += cost;
      const gainBefore = gain;
      let tradeGain = qty * (short ? entryPrice - stage.price : stage.price - entryPrice) * pv;
      if (this.commissionValue !== 0) {
        if (this.commissionType === "percent") tradeGain -= (qty * stage.price * pv * this.commissionValue) / 100;
        else if (this.commissionType === "cash_per_contract") tradeGain -= qty * this.commissionValue;
        else tradeGain -= this.commissionValue;
      }
      gain += tradeGain;
      steps += 1;
      left = stage.deficit - credited - gainBefore;
    }
    if (steps === 0 || left <= 0) return false;
    const cover = marginCoverLots((left / ratio / (stage.price * pv)) * this.lotsPerContract);
    if (cover <= 0) return false;
    const size = Math.min((cover * 4) / this.lotsPerContract, Math.abs(this.posSize));
    this.beginOrder();
    this.closeAt(this.slipped(price, short ? 1 : -1), size, "Margin call", barIndex, null, barTimeMs, null);
    return true;
  }

  // The close pass (processFillsAtClose) for the exit legs placed on this bar: each one's price
  // levels judged against the close alone, the stop before the limit, filling at the close, in
  // placement order. A trailing stop is left to the next bar's walk, as in the oracle's close pass,
  // which tests an order's limit and stop levels only.
  private fillExitLegsAtClose(closePrice: number, barIndex: number, barTimeMs: number): void {
    const due = this.legScratch;
    due.length = 0;
    for (const l of this.exitLegs) if (l.placedThisBar && !l.consumed && l.binding !== null) due.push(l);
    for (const l of due) {
      if (this.posSize === 0 || l.consumed || !this.exitLegs.includes(l)) continue;
      const isLong = this.posSize > 0;
      const base = l.binding!.entryPrice;
      const stop = this.exitStopLevel(l, isLong, base);
      const limit = this.exitLimitLevel(l, isLong, base);
      // NaN levels compare false (C91).
      if (isLong ? closePrice <= stop : closePrice >= stop) l.fillKind = "loss";
      else if (isLong ? closePrice >= limit : closePrice <= limit) l.fillKind = "profit";
      else continue;
      this.executeLeg(l, closePrice, barIndex, barTimeMs);
    }
    due.length = 0;
  }

  // Fills exit leg `l` at `fill`; l.fillKind names the level that triggered it. The stop-loss and
  // trailing legs are stop orders and fill slipped against the position; the take-profit leg is a
  // limit order and keeps its price. The leg closes its slice, oldest trade first like every
  // closing fill (closeAt), and settles the one entry it is bound to. Having closed all of its slice
  // it is consumed and stays behind while that entry is open (see ExitLeg); having closed less (the
  // position was smaller) it is gone.
  private executeLeg(l: ExitLeg, fill: number, barIndex: number, barTimeMs: number): void {
    if (l.fillKind !== "profit") fill = this.slipped(fill, this.posSize > 0 ? -1 : 1);
    // comment_loss=/comment_profit=/comment_trailing=(C375+C673) — 체결을 결정한 축으로 트리거별
    // 오버라이드를 선택: "profit"→comment_profit=, "loss"→comment_loss=, null(순수 트레일링)→
    // comment_trailing=. 셋 다 미지정(null)이면 comment=로 폴백.
    const cmt =
      l.fillKind === "profit" && l.commentProfit !== null
        ? l.commentProfit
        : l.fillKind === "loss" && l.commentLoss !== null
          ? l.commentLoss
          : l.fillKind === null && l.commentTrailing !== null
            ? l.commentTrailing
            : l.comment;
    const wholeSlice = l.reserved <= Math.abs(this.posSize);
    this.beginOrder();
    this.closeAt(fill, l.reserved, cmt, barIndex, l.id, barTimeMs, l.binding);
    const i = this.exitLegs.indexOf(l);
    if (i < 0) return; // its entry is spent: the leg died with it
    if (wholeSlice) l.consumed = true;
    else this.exitLegs.splice(i, 1);
  }

  // pending entry/order 주문의 이번 바 체결가 — NaN이면 미체결(이월). pine2py _check_fill의 entry
  // 분기(long limit: low<=limit → limit 체결, long stop: high>=stop → stop 체결, stop-limit: 두 조건
  // 동시 충족 시 limit 체결, 숏은 부등호 반전)를 기본으로 하되, **트리거 조건이 이 바 open에서
  // 이미 충족돼 있으면 open으로 체결**한다(갭 오픈: pine2py는 갭에서도 정확히 limit/stop 가격을
  // 반환해 "시장에 존재하지 않았던 가격" 체결이 되는데, TV 브로커 에뮬레이터는 limit을 "지정가
  // 이하/이상(or better)", stop을 "트리거 시점 시장가"로 채우므로 open 체결이 정합 — TV 실측
  // 미검증 가설, DIVERGENCES #69). 한 주문의 체결가는 "open 스냅샷 → 바 전체 H/L" 2단 모델로 정하고
  // (stop-limit의 트리거-후-limit 시차도 같은 바 결합 조건으로 접는다), 여러 entry가 한 바에서
  // 트리거되면 그 순서는 fillPendingEntries가 봉 내 경로로 정한다. exit leg의 판정(walkLeg)과는
  // 별개.
  private directionalFillPrice(
    direction: string, limitV: number, stopV: number, openPrice: number, high: number, low: number,
  ): number {
    const hasLimit = !Number.isNaN(limitV);
    const hasStop = !Number.isNaN(stopV);
    if (!hasLimit && !hasStop) return openPrice; // 마켓 — 다음 바 open 무조건 체결
    const limit = limitV;
    const stop = stopV;
    if (direction === "long") {
      if (hasLimit && hasStop) {
        if (openPrice >= stop && openPrice <= limit) return openPrice;
        if (high >= stop && low <= limit) return limit;
      } else if (hasLimit) {
        if (openPrice <= limit) return openPrice;
        if (low <= limit) return limit;
      } else {
        if (openPrice >= stop) return openPrice;
        if (high >= stop) return stop;
      }
    } else {
      if (hasLimit && hasStop) {
        if (openPrice <= stop && openPrice >= limit) return openPrice;
        if (low <= stop && high >= limit) return limit;
      } else if (hasLimit) {
        if (openPrice >= limit) return openPrice;
        if (high >= limit) return limit;
      } else {
        if (openPrice <= stop) return openPrice;
        if (low <= stop) return stop;
      }
    }
    return NaN;
  }

  // Walks exit leg `l` over the rest of this bar's assumed path (barPath) and returns the price it
  // fills at (NaN = it rests), with l.fillKind naming the level that filled it ("profit", "loss",
  // null = the trailing line) and l.pathLeg/l.pathDist where the path reaches it (the segment: 0 =
  // the first tick, 1 and 2 = the segments to the two extremes, 3 = the closing one; the distance
  // from where that segment starts). The manual (strategies.txt, "Broker emulator"): "If the opening
  // price of a bar is closer to the high than it is to the low, the emulator assumes that the market
  // price moved in this order: open → high → low → close. If the opening price of a bar is closer to
  // the low than it is to the high, the emulator assumes that the market price moved in this order:
  // open → low → high → close." So a leg's levels are met in that order, and the one reached first
  // fills: a long's take-profit is reached on a rising segment and its stop-loss on a falling one,
  // so a long's take-profit wins on an open → high → low → close bar that reaches both, its
  // stop-loss on an open → low → high → close bar (a short the other way round). The trailing line
  // arms and follows the extreme on the segments running in the position's favour, and is hit only
  // on a segment running against it after that, the closing one included; the oracle walks it the
  // same way (`_process_trailing_stop`). Repros: resin-harness state/repros/mixed-seed-14.json (a
  // long's take-profit and stop-loss both reached on an open → high → low → close bar: the
  // take-profit fills), trail-seed-3.json (a short's line armed on the way down is not hit by the
  // high that bar reached before it).
  //
  // The walk starts at `first` on segment `seg`: the open (seg 0) for a leg resting from an earlier
  // bar or bound by an entry filled at the open, or the fill price of the entry that bound the leg
  // mid-bar (seg 1 or 2), whose trade does not exist at the prices the bar reached before it (the
  // oracle's `_activate_brackets_on_fill`, `_walk_activated_brackets`, `_check_close_leg_up`). A
  // level the first tick is already past fills there: a gap at the open, or an entry filling beyond
  // it. The stop-loss and trailing legs are stop orders and the take-profit a limit order
  // (executeLeg prices the slippage).
  //
  // The walk runs in the position's favourable direction: x = dir × price rises when the market moves
  // the position's way, so one pass serves longs and shorts. A trailing stop mutates l.trailPrice (its
  // line, NaN until it arms): it arms where the path reaches the activation level (trail_price=, or
  // trail_points ticks from the bound entry's fill), sits trail_offset ticks behind the best price
  // since, and with an offset of 0 fills on the arming tick itself. On one segment reaching both, the
  // hard stop-loss and the line fill at whichever the path reaches first (the stop-loss at a tie), and
  // the take-profit precedes the line's arming unless that arming fills at a level not beyond the
  // take-profit (the oracle's `_process_trailing_stop`). NaN prices (unit tests without high/low/close)
  // compare false, so their segments fill nothing (C91).
  private walkLeg(l: ExitLeg, seg: number, first: number): number {
    const isLong = this.posSize > 0;
    const dir = isLong ? 1 : -1;
    const base = l.binding!.entryPrice;
    const hasTrail = !Number.isNaN(l.trailPoints) || !Number.isNaN(l.trailPriceArg);
    const lim = dir * this.exitLimitLevel(l, isLong, base);
    const stp = dir * this.exitStopLevel(l, isLong, base);
    const offset = hasTrail ? (Number.isNaN(l.trailOffset) ? l.trailPoints : l.trailOffset) * this.mintick : NaN;
    const act = !hasTrail
      ? NaN
      : dir * (Number.isNaN(l.trailPriceArg) ? this.snapToTick(base + dir * l.trailPoints * this.mintick, isLong) : l.trailPriceArg);
    let line = dir * l.trailPrice;
    let x = dir * first;
    let hit = NaN;
    let kind: "profit" | "loss" | null = null;
    // The first tick.
    if (x <= stp) {
      hit = x;
      kind = "loss";
    } else if (x <= line) {
      hit = x;
    } else if (x >= lim) {
      hit = x;
      kind = "profit";
    } else if (hasTrail) {
      if (Number.isNaN(line)) {
        if (x >= act) line = x - offset;
      } else if (x - offset > line) {
        line = x - offset;
      }
      if (x <= line) hit = line;
    }
    let s = seg;
    let from = x;
    if (Number.isNaN(hit)) {
      for (s = seg === 0 ? 1 : seg; s <= 3; s++) {
        const nxt = dir * this.barPath[s]!;
        if (nxt > x) {
          const armsAt = hasTrail && Number.isNaN(line) && nxt >= act ? act : NaN;
          if (nxt >= lim && !(offset <= 0 && armsAt <= lim)) {
            hit = lim;
            kind = "profit";
          } else if (hasTrail) {
            if (!Number.isNaN(armsAt)) {
              line = armsAt - offset;
              if (armsAt <= line) hit = line;
            }
            if (Number.isNaN(hit) && nxt - offset > line) line = nxt - offset;
          }
        } else if (nxt < x) {
          const trailHit = nxt <= line;
          if (nxt <= stp && !(trailHit && line > stp)) {
            hit = stp;
            kind = "loss";
          } else if (trailHit) {
            hit = line;
          }
        }
        if (!Number.isNaN(hit)) break;
        from = x = nxt;
      }
    }
    if (hasTrail) l.trailPrice = dir * line;
    if (Number.isNaN(hit)) return NaN;
    l.fillKind = kind;
    l.pathLeg = s;
    l.pathDist = Math.abs(hit - from);
    return dir * hit;
  }

  // A leg's take-profit level: limit=, else `profit` ticks from `base` (the bound
  // entry's fill price) in the position's favour. NaN when it has neither.
  // An absolute limit=/stop= is put on the tick grid like an entry's levels, on the side the market
  // has to travel further to reach: a long's take-profit rounds up and its stop-loss down, a
  // short's the other way (a level within 1e-4 tick of a grid point is on it; snapToTick). The
  // oracle rounds exit levels this way at the call (`_exit_leg` → `_price_round`, measured on
  // TradingView). Tier 1: resin-harness suites/strategy/tv/slippage_limit trade 1, a short's stop
  // `position_avg_price * 1.01` = 1.13323 * 1.01 = 1.1445623 fills at 1.14477 with 20 ticks of
  // slippage, i.e. at 1.14457 + 0.0002; trade 2, a long's 1.14213 * 0.99 = 1.1307087, at
  // 1.1307 - 0.0002 = 1.1305. The unsnapped level filled at 1.1447623 and 1.1305087.
  private exitLimitLevel(l: ExitLeg, isLong: boolean, base: number): number {
    if (!Number.isNaN(l.limit)) return this.snapToTick(l.limit, isLong);
    if (Number.isNaN(l.profitPoints)) return NaN;
    return isLong
      ? this.snapToTick(base + l.profitPoints * this.mintick, true)
      : this.snapToTick(base - l.profitPoints * this.mintick, false);
  }

  // A leg's stop-loss level: stop=, else `loss` ticks from `base` against the position.
  // NaN when it has neither.
  private exitStopLevel(l: ExitLeg, isLong: boolean, base: number): number {
    if (!Number.isNaN(l.stop)) return this.snapToTick(l.stop, !isLong);
    if (Number.isNaN(l.lossPoints)) return NaN;
    return isLong
      ? this.snapToTick(base - l.lossPoints * this.mintick, false)
      : this.snapToTick(base + l.lossPoints * this.mintick, true);
  }
}
