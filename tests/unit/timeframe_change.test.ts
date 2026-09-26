// timeframe.change on the chart symbol's exchange calendar (src/runtime/calendar.ts). The expected
// bars are TradingView's: resin-harness tier 1 tf_010_change, a chart export of
// timeframe.change("15"/"240"/"D"/...) on CAPITALCOM:EURUSD 5m (US/Eastern, forex; sessions open
// Sunday 17:00 and Monday-Thursday 17:05, close 16:59:50), rows 50/98/146/194/242/290 of
// data/t01_timeframe/timeframe.csv.

import { describe, expect, it } from "vitest";
import { ExchangeCalendar, change, type CalendarSpec, type TimeframeChangeState } from "../../src/runtime/calendar";
import { transpile } from "../../src/index";

const H = 3600;
const EURUSD: Omit<CalendarSpec, "chartTf"> = {
  timezone: "US/Eastern",
  type: "forex",
  openingHours: [
    [0, 0, 16 * H + 59 * 60 + 50], [0, 17 * H + 5 * 60, 0],
    [1, 0, 16 * H + 59 * 60 + 50], [1, 17 * H + 5 * 60, 0],
    [2, 0, 16 * H + 59 * 60 + 50], [2, 17 * H + 5 * 60, 0],
    [3, 0, 16 * H + 59 * 60 + 50], [3, 17 * H + 5 * 60, 0],
    [4, 0, 16 * H + 59 * 60 + 50],
    [6, 17 * H, 0],
  ],
  sessionStarts: [[0, 17 * H + 5 * 60], [1, 17 * H + 5 * 60], [2, 17 * H + 5 * 60], [3, 17 * H + 5 * 60], [6, 17 * H]],
};

// 5-minute bars from Sunday 2024-10-20 17:00 to Monday 17:10 New York (EDT, UTC-4), without the
// Monday 17:00 bar the session break leaves out.
function fxBars(): number[] {
  const out: number[] = [];
  const monday1700 = Date.UTC(2024, 9, 21, 21, 0);
  for (let t = Date.UTC(2024, 9, 20, 21, 0); t <= Date.UTC(2024, 9, 21, 21, 10); t += 300_000) {
    if (t !== monday1700) out.push(t);
  }
  return out;
}

function firing(tf: string, times: number[], cal: ExchangeCalendar): string[] {
  const state: TimeframeChangeState = {};
  const out: string[] = [];
  times.forEach((t, i) => {
    if (change(state, tf, t, i, cal)) out.push(new Date(t - 4 * H * 1000).toISOString().slice(5, 16));
  });
  return out;
}

describe("timeframe.change on the exchange calendar", () => {
  const cal = new ExchangeCalendar({ chartTf: "5", ...EURUSD });
  const times = fxBars();

  it("starts 240-minute periods at the session open's hour, the Monday 17:05 bar included (tier 1 tf_010_change rows 50-290)", () => {
    expect(firing("240", times, cal)).toEqual(["10-20T21:00", "10-21T01:00", "10-21T05:00", "10-21T09:00", "10-21T13:00", "10-21T17:05"]);
  });

  it("rolls the FX trading day at the 17:05 open, not at midnight (tier 1 tf_010_change row 290)", () => {
    expect(firing("D", times, cal)).toEqual(["10-21T17:05"]);
  });

  it("never fires on the first bar a call site sees, nor for a timeframe below the chart's", () => {
    expect(firing("15", times, cal)[0]).toBe("10-20T17:15");
    expect(firing("1", times, cal)).toEqual([]);
  });

  it("reads an empty timeframe as the chart's own", () => {
    expect(firing("", times, cal)).toHaveLength(times.length - 1);
  });

  it("lays days on UTC midnight around the clock when no schedule is given", () => {
    const hourly = Array.from({ length: 49 }, (_, i) => Date.UTC(2024, 0, 1, 0) + i * H * 1000);
    const state: TimeframeChangeState = {};
    const utc = new ExchangeCalendar({
      chartTf: "60",
      timezone: "UTC",
      type: "stock",
      openingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 0, 86_399] as const),
      sessionStarts: [0, 1, 2, 3, 4, 5, 6].map((d) => [d, 0] as const),
    });
    const fired = hourly.map((t, i) => change(state, "D", t, i, utc));
    expect(fired.flatMap((f, i) => (f ? [i] : []))).toEqual([24, 48]);
  });

  it("takes the calendar from transpile's syminfo option and rejects an unknown timezone", () => {
    const opts = {
      chartTf: "5",
      syminfo: {
        timezone: "US/Eastern",
        type: "forex",
        opening_hours: [{ day: 6, start: "17:00:00", end: "00:00:00" }],
        session_starts: [{ day: 6, time: "17:00:00" }],
      },
    };
    const ok = transpile('x = timeframe.change("D")\ns = syminfo.timezone', opts);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.code).toContain('"timezone":"US/Eastern","type":"forex","openingHours":[[6,61200,0]],"sessionStarts":[[6,61200]]');
      expect(ok.code).toContain('var s = "US/Eastern";');
    }
    const bad = transpile('x = timeframe.change("D")', { syminfo: { timezone: "Mars/Olympus" } });
    expect(bad.ok).toBe(false);
  });
});
