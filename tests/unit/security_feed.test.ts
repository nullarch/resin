// request.security on another symbol reads that symbol's feed (ContextOptions.security): the
// expression runs on the feed's bars, and a chart bar reads the last feed bar whose scheduled close
// is at or before its own (src/runtime/security.ts buildFromFeed, ExchangeCalendar.barClose).
// The first case is TradingView's: resin-harness tier 1 sec_001_advance_decline_ratio, a daily
// chart export of request.security("USI:ADVN.NY"/"USI:DECL.NY", timeframe.period, close) ratios,
// rows 0-2 of data/t40_security/advance_decline_ratio.csv with the feeds' first bars.

import { describe, expect, it } from "vitest";
import { Context, type SecurityFeed } from "../../src/runtime/context";
import { ExchangeCalendar, calendarSpecOf } from "../../src/runtime/calendar";
import { get, getFromArray, getFromArrayHist, nestedView, pairNested, readNested, type SecurityCache } from "../../src/runtime/security";
import { compile, transpile } from "../../src/index";

const NYSE = {
  timezone: "America/New_York",
  type: "index",
  opening_hours: [0, 1, 2, 3, 4].map((day) => ({ day, start: "09:30:00", end: "16:00:00" })),
  session_starts: [0, 1, 2, 3, 4].map((day) => ({ day, time: "09:30:00" })),
};

// 2003-09-25 (Thursday), 2003-09-26, 2003-09-29 at 09:30 New York (EDT).
const DAYS = [Date.UTC(2003, 8, 25, 13, 30), Date.UTC(2003, 8, 26, 13, 30), Date.UTC(2003, 8, 29, 13, 30)];

function feed(closes: number[], time: number[] = DAYS): SecurityFeed {
  return { time, open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 0), timeframe: "1D", syminfo: NYSE };
}

function chart(time: number[], close: number[] = time.map((_, i) => 100 + i)) {
  return { time, open: close, high: close, low: close, close, volume: close.map(() => 1) };
}

function run(src: string, data: ReturnType<typeof chart>, security?: Record<string, SecurityFeed>): (number | null)[] {
  const r = transpile(src, { chartTf: "D", syminfo: { timezone: "US/Eastern", type: "crypto" } });
  if (!r.ok) throw new Error(r.errors.join("; "));
  const ctx = Context.from(r, data, security === undefined ? {} : { security });
  const bar = compile(r.code)(ctx);
  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    bar();
  }
  return ctx.plots[0]!.toArray().map((v) => (Number.isFinite(v) ? v : null));
}

const RATIO = `//@version=6
indicator("ADR")
ratio(t1, t2, source) =>
    request.security(t1, timeframe.period, source) / request.security(t2, timeframe.period, source)
plot(ratio("USI:ADVN.NY", "USI:DECL.NY", close), "Plot")
`;

describe("request.security on another symbol's feed", () => {
  it("reads each named symbol's bar of the same day (tier 1 sec_001_advance_decline_ratio rows 0-2)", () => {
    const got = run(RATIO, chart(DAYS), { "USI:ADVN.NY": feed([534, 596, 1285]), "USI:DECL.NY": feed([1261, 1181, 509]) });
    expect(got).toEqual([0.4234734337827121, 0.5046570702794242, 2.524557956777996]);
  });

  it("repeats the feed's last bar on a chart bar the feed lacks, and is na before its first", () => {
    const src = `//@version=6
indicator("x")
plot(request.security("USI:ADVN.NY", "D", close), "p")
`;
    const feedTimes = [DAYS[1]!, DAYS[2]!];
    expect(run(src, chart(DAYS), { "USI:ADVN.NY": feed([10, 30], feedTimes) })).toEqual([null, 10, 30]);
    expect(run(src, chart([DAYS[0]!, DAYS[2]!]), { "USI:ADVN.NY": feed([10, 20, 30]) })).toEqual([10, 30]);
  });

  it("runs the expression on the feed's own bars", () => {
    const src = `//@version=6
indicator("x")
plot(request.security("USI:ADVN.NY", "D", close - close[1]), "p")
`;
    expect(run(src, chart(DAYS), { "USI:ADVN.NY": feed([10, 13, 19]) })).toEqual([null, 3, 6]);
  });

  it("groups a daily feed into weeks on its calendar and shows a week from the chart bar that closes it", () => {
    // Monday 2003-09-22 to Friday 2003-10-03, New York trading days.
    const days = Array.from({ length: 10 }, (_, k) => Date.UTC(2003, 8, 22 + k + 2 * Math.floor(k / 5), 13, 30));
    const src = `//@version=6
indicator("x")
plot(request.security("USI:ADVN.NY", "W", close), "p")
`;
    const closes = days.map((_, k) => k + 1);
    expect(run(src, chart(days), { "USI:ADVN.NY": feed(closes, days) })).toEqual([null, null, null, null, 5, 5, 5, 5, 5, 10]);
  });

  it("reads the chart's own bars for a symbol without a feed", () => {
    const src = `//@version=6
indicator("x")
plot(request.security("OTHER:SYM", "D", close), "p")
`;
    const data = chart(DAYS);
    expect(run(src, data, { "USI:ADVN.NY": feed([1, 2, 3]) })).toEqual(run(src, data));
  });

  it("names each slot's symbol at compile time: a literal, the one string every call site passes, none for the chart's", () => {
    const r = transpile(`//@version=6
indicator("x")
f(sym) => request.security(sym, "D", close)
plot(request.security("A:B", "D", close) + f("C:D") + request.security(syminfo.tickerid, "D", close))
`);
    // Slots follow analysis order: the function body comes first.
    expect(r.ok && r.securitySymbols).toEqual(["C:D", "A:B", null]);
  });
});

// The chart symbol named by the syminfo option (prefix/ticker): syminfo.tickerid folds to
// "PREFIX:TICKER", and a request on it finds that symbol's feeds. A feed keyed "SYMBOL:TF" is read
// before one keyed "SYMBOL" (the reference's key order, pynecore ScriptRunner._resolve_security_data),
// so one symbol can be handed at several timeframes (resin-harness tier 1
// sec_032_dependent_cross_context hands CAPITALCOM:EURUSD at "D" and "W").
describe("request.security on the chart symbol's own feeds", () => {
  // Monday 2003-09-22 to Friday 2003-10-03, New York trading days; closes 1..10.
  const days = Array.from({ length: 10 }, (_, k) => Date.UTC(2003, 8, 22 + k + 2 * Math.floor(k / 5), 13, 30));
  const daily = feed(days.map((_, k) => k + 1), days);
  const weekly: SecurityFeed = { ...feed([50, 60], [days[0]!, days[5]!]), timeframe: "1W" };
  const runAs = (src: string, security: Record<string, SecurityFeed>): (number | null)[] => {
    const r = transpile(src, { chartTf: "D", syminfo: { ...NYSE, prefix: "USI", ticker: "ADVN.NY" } });
    if (!r.ok) throw new Error(r.errors.join("; "));
    const ctx = Context.from(r, chart(days), { security });
    const bar = compile(r.code)(ctx);
    for (let i = 0; i < ctx.barCount; i++) {
      ctx.advance();
      bar();
    }
    return ctx.plots[0]!.toArray().map((v) => (Number.isFinite(v) ? v : null));
  };

  it("folds syminfo.prefix, syminfo.ticker and syminfo.tickerid to the syminfo option's identity", () => {
    const r = transpile(`//@version=6
indicator("x")
plot(request.security(syminfo.tickerid, "D", close))
`, { syminfo: { prefix: "USI", ticker: "ADVN.NY" } });
    expect(r.ok && r.securitySymbols).toEqual(["USI:ADVN.NY"]);
    const bad = transpile(`indicator("x")\nplot(close)`, { syminfo: { ticker: "A:B" } });
    expect(bad.ok).toBe(false);
  });

  it("reads the feed keyed SYMBOL:TF before the one keyed SYMBOL", () => {
    const src = `//@version=6
indicator("x")
plot(request.security(syminfo.tickerid, "W", close), "p")
`;
    expect(runAs(src, { "USI:ADVN.NY": daily, "USI:ADVN.NY:W": weekly })).toEqual([null, null, null, null, 50, 50, 50, 50, 50, 60]);
    // Without the weekly feed the daily one is grouped into weeks.
    expect(runAs(src, { "USI:ADVN.NY": daily })).toEqual([null, null, null, null, 5, 5, 5, 5, 5, 10]);
  });

  it("reads a nested request in the outer request's context: a week reads its last day, a day the last week it closes", () => {
    const feeds = { "USI:ADVN.NY:D": daily, "USI:ADVN.NY:W": weekly };
    // In the weekly context the nested "" request inherits the symbol: week 0 reads day 4 (5),
    // week 1 day 9 (10); d - d[1] is that change, shown from the day that closes the week.
    const weekOfDays = `//@version=6
indicator("x")
d = request.security("", "D", close)
plot(request.security(syminfo.tickerid, "W", d - d[1]), "p")
`;
    expect(runAs(weekOfDays, feeds)).toEqual([null, null, null, null, null, null, null, null, null, 5]);
    // In the daily context each day reads the last week closed at or before its close: none until
    // Friday's close, then week 0 (50), week 1 (60) on day 9.
    const dayOfWeeks = `//@version=6
indicator("x")
w = request.security(syminfo.tickerid, "W", close)
plot(request.security(syminfo.tickerid, "D", w), "p")
`;
    expect(runAs(dayOfWeeks, feeds)).toEqual([null, null, null, null, 50, 50, 50, 50, 50, 60]);
  });
});

describe("pairNested / readNested", () => {
  // Inner bars close at 10, 20, 30, 40; outer bars open at 0 and 25, close at 25 and 45.
  const cache = (open: number[], close: number[]) =>
    ({ timeOpen: Float64Array.from(open), timeClose: Float64Array.from(close) }) as unknown as SecurityCache;
  const inner = cache([0, 10, 20, 30], [10, 20, 30, 40]);
  const outer = cache([0, 25], [25, 45]);
  const values = Float64Array.from([1, 2, 3, 4]);

  it("pairs each outer bar with the last inner bar closed by its close, or opened before it with lookahead", () => {
    expect(Array.from(pairNested(inner, outer, false))).toEqual([1, 3]);
    expect(Array.from(pairNested(inner, outer, true))).toEqual([2, 3]);
    expect(Array.from(pairNested(inner, cache([0], [5]), false))).toEqual([-1]);
  });

  it("is na before the first pair, and with gaps on shows a value only where its inner bar first appears", () => {
    const pair = Int32Array.from([-1, 1, 1, 3]);
    expect([0, 1, 2, 3].map((h) => readNested(values, pair, h, false))).toEqual([NaN, 2, 2, 4]);
    expect([0, 1, 2, 3].map((h) => readNested(values, pair, h, true))).toEqual([NaN, 2, NaN, 4]);
  });

  it("nestedView: a requested context's reads of another request (getFromArray, get, their history) follow readNested on its rows", () => {
    // Outer rows close at 5, 25, 28, 45: row 0 before any inner bar, rows 1 and 2 on the same one.
    const out4 = cache([0, 5, 25, 28], [5, 25, 28, 45]);
    const view = nestedView({ ...inner, close: values } as SecurityCache, out4);
    const pair = pairNested(inner, out4, false);
    for (const gaps of [false, true]) {
      const want = [0, 1, 2, 3].map((h) => readNested(values, pair, h, gaps));
      expect([0, 1, 2, 3].map((h) => getFromArray(values, view, h, gaps, false))).toEqual(want);
      expect([0, 1, 2, 3].map((h) => get(view, h, "close", gaps, false))).toEqual(want);
      expect([1, 2, 3].map((h) => getFromArrayHist(values, view, h, gaps, false, 1))).toEqual(want.slice(0, 3));
    }
    // With lookahead on, the inner bar that opened before the outer row's close.
    expect([0, 1, 2, 3].map((h) => getFromArray(values, view, h, false, true))).toEqual([1, 3, 3, 4]);
  });
});

describe("ExchangeCalendar.barClose", () => {
  const nyse = new ExchangeCalendar(calendarSpecOf("1D", NYSE, "test"));
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

  it("closes an equity daily bar at its session end, a round-the-clock one at the next midnight", () => {
    expect(nyse.barClose(at(2003, 9, 26, 13, 30), 0, "1D")).toBe(at(2003, 9, 26, 20));
    const crypto = new ExchangeCalendar(calendarSpecOf("D", { timezone: "US/Eastern", type: "crypto" }, "test"));
    expect(crypto.barClose(at(2003, 9, 26, 13, 30), 0, "D")).toBe(at(2003, 9, 27, 4));
  });

  it("closes a weekly bar at the week's last session end and a monthly one at the month's", () => {
    expect(nyse.barClose(at(2003, 9, 22, 13, 30), 0, "W")).toBe(at(2003, 9, 26, 20));
    expect(nyse.barClose(at(2003, 9, 2, 13, 30), 0, "M")).toBe(at(2003, 9, 30, 20));
  });

  it("closes an intraday bar at the session end, the next bar's open or a span after its open", () => {
    const hourly = new ExchangeCalendar(calendarSpecOf("60", NYSE, "test"));
    expect(hourly.barClose(at(2003, 9, 26, 19, 30), 0, "60")).toBe(at(2003, 9, 26, 20));
    expect(hourly.barClose(at(2003, 9, 26, 14, 30), at(2003, 9, 26, 15), "60")).toBe(at(2003, 9, 26, 15));
    expect(hourly.barClose(at(2003, 9, 26, 14, 30), 0, "60")).toBe(at(2003, 9, 26, 15, 30));
  });

  it("maps wall-clock times back across daylight-saving changes", () => {
    // 2003-10-26 01:30 New York happens twice; the first is EDT (05:30Z). 2003-04-06 02:30 does not
    // happen; the offset before the change (EST) gives 07:30Z.
    expect(nyse.unwall(at(2003, 10, 26, 1, 30))).toBe(at(2003, 10, 26, 5, 30));
    expect(nyse.unwall(at(2003, 4, 6, 2, 30))).toBe(at(2003, 4, 6, 7, 30));
    expect(nyse.unwall(at(2003, 7, 1, 9, 30))).toBe(at(2003, 7, 1, 13, 30));
  });
});
