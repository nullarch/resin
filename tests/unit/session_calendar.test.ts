// session.isfirstbar / islastbar / ismarket on the chart symbol's session schedule
// (src/runtime/calendar.ts). The expected bars are TradingView's: resin-harness tier 1
// session_001_properties (CAPITALCOM:EURUSD 60m, US/Eastern, forex; sessions start Sunday 17:00 and
// Monday-Thursday 17:05, end Monday-Friday 16:59:50) and session_002_24x7 (BINANCE:BTCUSDT 60m,
// UTC, 00:00-00:00 every day), lines of data/t02_session/session.csv and session_24x7.csv.

import { describe, expect, it } from "vitest";
import { ExchangeCalendar, calendarSpecOf } from "../../src/runtime/calendar";
import { transpile } from "../../src/index";
import { runPipeline } from "../helpers/pipeline";

const weekdays = (days: number[], start: string, end: string) => days.map((day) => ({ day, start, end }));

// data/t02_session/session.toml, as the harness hands it with transpile's syminfo option.
const EURUSD = {
  timezone: "US/Eastern",
  type: "forex",
  opening_hours: [
    ...weekdays([0, 1, 2, 3, 4], "00:00:00", "16:59:50"),
    ...weekdays([0, 1, 2, 3], "17:05:00", "00:00:00"),
    { day: 6, start: "17:00:00", end: "00:00:00" },
  ],
  session_starts: [0, 1, 2, 3].map((day) => ({ day, time: "17:05:00" })).concat([{ day: 6, time: "17:00:00" }]),
  session_ends: [0, 1, 2, 3, 4].map((day) => ({ day, time: "16:59:50" })),
};

// data/t02_session/session_24x7.toml.
const BTCUSDT = {
  timezone: "Etc/UTC",
  type: "crypto",
  opening_hours: weekdays([0, 1, 2, 3, 4, 5, 6], "00:00:00", "00:00:00"),
  session_starts: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, time: "00:00:00" })),
  session_ends: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, time: "00:00:00" })),
};

const fx = new ExchangeCalendar(calendarSpecOf("60", EURUSD, "test"));
const crypto = new ExchangeCalendar(calendarSpecOf("60", BTCUSDT, "test"));
const at = (iso: string) => Date.parse(iso);
const flags = (cal: ExchangeCalendar, iso: string) => [cal.isSessionFirstBar(at(iso)), cal.isSessionLastBar(at(iso)), cal.isMarketBar(at(iso))];

describe("session.* on the exchange calendar", () => {
  it("marks the bar holding a session start as the first bar (tier 1 session_001, session.csv lines 11, 59, 83)", () => {
    expect(flags(fx, "2025-01-01T17:00:00-05:00")).toEqual([true, false, true]); // Wednesday 17:05 start
    expect(flags(fx, "2025-01-05T17:00:00-05:00")).toEqual([true, false, true]); // Sunday 17:00 start
    expect(flags(fx, "2025-01-06T17:00:00-05:00")).toEqual([true, false, true]);
  });

  it("marks the bar holding a session end as the last bar (tier 1 session_001, session.csv lines 10, 58)", () => {
    expect(flags(fx, "2024-12-31T16:00:00-05:00")).toEqual([false, true, true]); // Tuesday 16:59:50 end
    expect(flags(fx, "2025-01-03T16:00:00-05:00")).toEqual([false, true, true]); // Friday
  });

  it("marks neither inside a session (tier 1 session_001, session.csv lines 2, 18)", () => {
    expect(flags(fx, "2024-12-31T08:00:00-05:00")).toEqual([false, false, true]);
    expect(flags(fx, "2025-01-02T00:00:00-05:00")).toEqual([false, false, true]);
  });

  it("is out of the market on a bar no opening hours overlap (pynecore core/session.py is_in_session)", () => {
    expect(fx.isMarketBar(at("2025-01-03T17:00:00-05:00"))).toBe(false); // Friday after the close
    expect(fx.isMarketBar(at("2025-01-04T12:00:00-05:00"))).toBe(false); // Saturday
    expect(fx.isMarketBar(at("2025-01-05T16:00:00-05:00"))).toBe(false); // Sunday before the open
  });

  it("takes a 00:00 session end as the day's midnight close (tier 1 session_002_24x7)", () => {
    expect(flags(crypto, "2025-01-03T22:00:00Z").slice(0, 2)).toEqual([false, false]);
    expect(flags(crypto, "2025-01-03T23:00:00Z").slice(0, 2)).toEqual([false, true]);
    expect(flags(crypto, "2025-01-04T00:00:00Z").slice(0, 2)).toEqual([true, false]);
  });

  it("reads a 00:00-00:00 day as open around the clock (concepts_sessions.txt: for BTCUSD ismarket is always true)", () => {
    expect(crypto.isMarketBar(at("2025-01-03T22:00:00Z"))).toBe(true);
    expect(crypto.isMarketBar(at("2025-01-04T00:00:00Z"))).toBe(true);
  });

  it("runs the tier 1 script on the syminfo option's schedule", () => {
    const src = [
      "//@version=6",
      'indicator("Session")',
      "var float first = na",
      "var float last = na",
      "first := session.isfirstbar ? 1 : 0",
      "last := session.islastbar_regular ? 1 : 0",
    ].join("\n");
    const time = ["2025-01-02T15:00:00-05:00", "2025-01-02T16:00:00-05:00", "2025-01-02T17:00:00-05:00", "2025-01-02T18:00:00-05:00"].map(at);
    const n = time.length;
    const data = { open: new Array(n).fill(1), high: new Array(n).fill(1), low: new Array(n).fill(1), close: new Array(n).fill(1), volume: new Array(n).fill(1), time };
    const result = runPipeline(src, data, {}, { chartTf: "60", syminfo: EURUSD });
    expect(result.bars.map((b) => b["var:first"])).toEqual([0, 0, 1, 0]);
    expect(result.bars.map((b) => b["var:last"])).toEqual([0, 1, 0, 0]);
  });

  it("rejects a malformed session_ends entry", () => {
    const bad = transpile("x = session.islastbar", { syminfo: { session_ends: [{ day: 7, time: "16:00" }] } });
    expect(bad.ok).toBe(false);
  });
});
