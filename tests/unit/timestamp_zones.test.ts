// timestamp(): the timezone argument, the exchange timezone default and the date strings.
// Tier 1 evidence: TradingView's export of base_001_time (resin-bench h2h) --
//   timestamp("GMT+6", 2016, 1, 19, 9, 30)             = 1453174200000  (03:30 UTC)
//   timestamp("GMT+3", 2019, 6, 19, 9, 30, 15)         = 1560925815000
//   timestamp(dateString = "Feb 01 2020 22:10:05")     = 1580595005000  (UTC)
//   timestamp("04 Dec 1995 00:12:00 GMT+5")            = 818017920000   (1995-12-03 19:12 UTC)
// The rest follows the oracle's measured rules (pynecore core/datetime.py, lib timestamp).
import { describe, expect, it } from "vitest";
import { timestamp, timestampIn } from "../../src/runtime/numeric";
import { run } from "../../src/runtime/engine";
import { transpile } from "../../src/transpiler/pipeline";

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number => Date.UTC(y, mo - 1, d, h, mi, s);

describe("timestamp(timezone, ...)", () => {
  it("fixed GMT/UTC offsets, whole hours and minutes", () => {
    expect(timestamp("GMT+6", 2016, 1, 19, 9, 30)).toBe(1453174200000);
    expect(timestamp("GMT+3", 2019, 6, 19, 9, 30, 15)).toBe(1560925815000);
    expect(timestamp("UTC-5", 2024, 3, 1, 12)).toBe(utc(2024, 3, 1, 17));
    expect(timestamp("GMT+0530", 2024, 3, 1, 12)).toBe(utc(2024, 3, 1, 6, 30));
  });

  it("named zones follow their daylight saving time", () => {
    expect(timestamp("America/New_York", 2024, 1, 15, 12)).toBe(utc(2024, 1, 15, 17));
    expect(timestamp("America/New_York", 2024, 7, 15, 12)).toBe(utc(2024, 7, 15, 16));
    expect(timestamp("Europe/Budapest", 2024, 7, 15, 12)).toBe(utc(2024, 7, 15, 10));
    expect(timestamp("Asia/Seoul", 2024, 7, 15, 12)).toBe(utc(2024, 7, 15, 3));
  });

  it("a wall time that occurs twice is its first occurrence, one that never occurs uses the offset before the change", () => {
    // 2024-11-03 01:30 happens in EDT (UTC-4) and again in EST (UTC-5)
    expect(timestamp("America/New_York", 2024, 11, 3, 1, 30)).toBe(utc(2024, 11, 3, 5, 30));
    // 2024-03-10 02:30 is skipped (clocks go 02:00 -> 03:00): read with EST (UTC-5)
    expect(timestamp("America/New_York", 2024, 3, 10, 2, 30)).toBe(utc(2024, 3, 10, 7, 30));
  });

  it("an empty or unrecognised zone is UTC; an omitted day is 1", () => {
    expect(timestamp("", 2024, 1, 15, 12)).toBe(utc(2024, 1, 15, 12));
    expect(timestamp("Not/AZone", 2024, 1, 15, 12)).toBe(utc(2024, 1, 15, 12));
    expect(timestamp("GMT+2", 2024, 6)).toBe(utc(2024, 5, 31, 22));
  });
});

describe("timestamp(year, month, day, ...) is a time of the exchange timezone", () => {
  it("timestampIn takes the symbol's timezone as the default; an explicit timezone wins", () => {
    expect(timestampIn("America/New_York", 2024, 1, 15, 9, 30)).toBe(utc(2024, 1, 15, 14, 30));
    expect(timestampIn("America/New_York", 2024, 7, 15, 9, 30)).toBe(utc(2024, 7, 15, 13, 30));
    expect(timestampIn("America/New_York", "GMT+1", 2024, 1, 15, 9, 30)).toBe(utc(2024, 1, 15, 8, 30));
    expect(timestampIn("UTC", 2024, 1, 15, 9, 30)).toBe(timestamp(2024, 1, 15, 9, 30));
  });

  it("a date string without a zone stays UTC whatever the exchange timezone is", () => {
    expect(timestampIn("Asia/Tokyo", "2024-01-15T09:30:00")).toBe(utc(2024, 1, 15, 9, 30));
    expect(timestampIn("Asia/Tokyo", "Jan 15 2024 09:30")).toBe(utc(2024, 1, 15, 9, 30));
  });

  it("transpile({ syminfo: { timezone } }) makes the 6-argument form, positional or by name, read it", () => {
    const source = [
      "//@version=5",
      'indicator("tz")',
      'plot(timestamp(2024, 1, 15, 9, 30), "pos")',
      'plot(timestamp(year = 2024, month = 1, day = 15, hour = 9, minute = 30), "kw")',
      'plot(timestamp("GMT+1", 2024, 1, 15, 9, 30), "explicit")',
      'plot(timestamp("2024-01-15T09:30:00"), "string")',
    ].join("\n");
    const data = { open: [1], high: [1], low: [1], close: [1], volume: [1] };
    const values = (timezone: string): number[] => {
      const r = transpile(source, { syminfo: { timezone } });
      if (!r.ok) throw new Error(r.errors.join("; "));
      return run(r, data).plots.map((p) => p.values[0]!);
    };
    expect(values("America/New_York")).toEqual([utc(2024, 1, 15, 14, 30), utc(2024, 1, 15, 14, 30), utc(2024, 1, 15, 8, 30), utc(2024, 1, 15, 9, 30)]);
    expect(values("UTC")).toEqual([utc(2024, 1, 15, 9, 30), utc(2024, 1, 15, 9, 30), utc(2024, 1, 15, 8, 30), utc(2024, 1, 15, 9, 30)]);
  });
});

describe("timestamp(dateString)", () => {
  it("month-name dates in either order, with the zone spellings of the oracle", () => {
    expect(timestamp("Feb 01 2020 22:10:05")).toBe(1580595005000);
    expect(timestamp("04 Dec 1995 00:12:00 GMT+5")).toBe(818017920000);
    expect(timestamp("20 Feb 2020 15:30:00 GMT+0200")).toBe(utc(2020, 2, 20, 13, 30));
    expect(timestamp("20 Feb 2020 15:30:00 GMT+02:00")).toBe(utc(2020, 2, 20, 13, 30));
    expect(timestamp("Feb 01 2020 22:10:05 UTC-5")).toBe(utc(2020, 2, 2, 3, 10, 5));
    expect(timestamp("Feb 01 2020 22:10 EST")).toBe(utc(2020, 2, 2, 3, 10));
    expect(timestamp("February 01 2020")).toBe(utc(2020, 2, 1));
    expect(timestamp("Jan 2025")).toBe(utc(2025, 1, 1));
    expect(timestamp("January 2025")).toBe(utc(2025, 1, 1));
  });

  it("a month-name date without a time ignores a named zone and refuses a bare offset (measured on TradingView)", () => {
    expect(timestamp("01 Jan 2022 GMT+3")).toBe(utc(2022, 1, 1));
    expect(timestamp("Jan 01 2022 EST")).toBe(utc(2022, 1, 1));
    expect(Number.isNaN(timestamp("01 Jan 2022 +0300"))).toBe(true);
  });

  it("numeric dates are month-first, and their zone counts", () => {
    expect(timestamp("03-04-2023")).toBe(utc(2023, 3, 4));
    expect(timestamp("03/04/2023 10:20:30")).toBe(utc(2023, 3, 4, 10, 20, 30));
    expect(timestamp("03.04.2023 10:20")).toBe(utc(2023, 3, 4, 10, 20));
    expect(timestamp("3 4 2023")).toBe(utc(2023, 3, 4));
    expect(timestamp("01-02-2022 EST")).toBe(utc(2022, 1, 2, 5));
    expect(Number.isNaN(timestamp("13-04-2023"))).toBe(true);
  });

  it("year and year-month, and what is not a date", () => {
    expect(timestamp("2025")).toBe(utc(2025, 1, 1));
    expect(timestamp("2025-06")).toBe(utc(2025, 6, 1));
    expect(Number.isNaN(timestamp("Feb 30 2020"))).toBe(true);
    expect(Number.isNaN(timestamp("Foo 01 2020"))).toBe(true);
    expect(Number.isNaN(timestamp("2024/01/15"))).toBe(true);
    expect(Number.isNaN(timestamp("Feb 01 2020 22:10 CET"))).toBe(true);
  });

  it("the ISO forms still read as before", () => {
    expect(timestamp("2011-10-10T14:48:00")).toBe(utc(2011, 10, 10, 14, 48));
    expect(timestamp("2024-01-15T00:00:00-06:00")).toBe(utc(2024, 1, 15, 6));
    expect(timestamp("2024-02-30")).toSatisfy(Number.isNaN);
  });
});

describe("timestamp components", () => {
  it("roll over like Pine's and keep a year below 100", () => {
    expect(timestamp(2024, 13, 1)).toBe(utc(2025, 1, 1));
    expect(timestamp(2024, 1, 31, 26)).toBe(utc(2024, 2, 1, 2));
    const t = new Date(0);
    t.setUTCFullYear(50, 0, 1);
    expect(timestamp(50, 1, 1)).toBe(t.getTime());
  });
});
