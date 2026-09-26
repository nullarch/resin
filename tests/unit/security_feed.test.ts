// request.security on another symbol reads that symbol's feed (ContextOptions.security): the
// expression runs on the feed's bars, and a chart bar reads the last feed bar whose scheduled close
// is at or before its own (src/runtime/security.ts buildFromFeed, ExchangeCalendar.barClose).
// The first case is TradingView's: resin-harness tier 1 sec_001_advance_decline_ratio, a daily
// chart export of request.security("USI:ADVN.NY"/"USI:DECL.NY", timeframe.period, close) ratios,
// rows 0-2 of data/t40_security/advance_decline_ratio.csv with the feeds' first bars.

import { describe, expect, it } from "vitest";
import { Context, type SecurityFeed } from "../../src/runtime/context";
import { ExchangeCalendar, calendarSpecOf } from "../../src/runtime/calendar";
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
