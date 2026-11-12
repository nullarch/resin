// timestamp(dateString). The reference is the JavaScript engine's own date parser, which shares no code
// with the parser under test: every form below is one the Pine manual shows or real scripts write.
import { describe, expect, it } from "vitest";
import { run, transpile } from "../../src/index";
import { timestamp } from "../../src/runtime/numeric";

const utc = (s: string): number => Date.parse(s);

describe("timestamp(dateString)", () => {
  it.each([
    // The manual's own (Time, "timestamp()").
    ["20 Aug 2024", "2024-08-20T00:00:00Z"],
    ["2021-01-01", "2021-01-01T00:00:00Z"],
    ["20 Aug 2024 00:00:00 UTC+0", "2024-08-20T00:00:00Z"],
    ["1 May 2022 00:00 -0400", "2022-05-01T04:00:00Z"],
    // Real scripts'.
    ["31 Dec 2025 23:45:00 GMT+10", "2025-12-31T13:45:00Z"],
    ["01 January 2020 00:00:00 UTC-5", "2020-01-01T05:00:00Z"],
    ["01 Jan 2000 00:00 GMT-7", "2000-01-01T07:00:00Z"],
    ["Nov 01 2021 23:59:59", "2021-11-01T23:59:59Z"],
    ["Jan 1 2023 00:00:00", "2023-01-01T00:00:00Z"],
    ["15Aug 2022 20:00 +0000", "2022-08-15T20:00:00Z"],
    ["UTC 31 Dec 2022 23:45", "2022-12-31T23:45:00Z"],
    ["Mon, 03 Jan 2022 10:00:00 GMT", "2022-01-03T10:00:00Z"],
    ["2024-03-05T14:48:00+09:00", "2024-03-05T05:48:00Z"],
    ["2024-03-05 14:48", "2024-03-05T14:48:00Z"],
  ])("%s", (text, iso) => {
    expect(timestamp(text)).toBe(utc(iso));
  });

  it("keeps hours and minutes apart in a zone", () => {
    expect(timestamp("1 Jan 2020 00:00 +0530")).toBe(utc("2019-12-31T18:30:00Z"));
    expect(timestamp("1 Jan 2020 00:00 UTC+5:30")).toBe(utc("2019-12-31T18:30:00Z"));
    expect(timestamp("1 Jan 2020 00:00 GMT+10")).toBe(timestamp("1 Jan 2020 00:00 +1000"));
  });

  it("does not take a time zone name or a bad month for a date", () => {
    expect(timestamp("America/New_York")).toBeNaN();
    expect(timestamp("01 Foo 2020")).toBeNaN();
  });

  it("a date window on a string it reads opens, and one it cannot read says so", () => {
    const bars = {
      open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [1, 2, 3], volume: [1, 1, 1],
      time: [utc("2024-01-01T00:00:00Z"), utc("2024-01-02T00:00:00Z"), utc("2024-01-03T00:00:00Z")],
    };
    const script = (date: string): string => `//@version=5
indicator("x")
int stopdate = timestamp('${date}')
stop = input.time(stopdate, 'Stop')
plot(time <= stop ? 1 : 0, "open")
`;
    const good = transpile(script("31 Dec 2025 23:45:00 GMT+10"));
    if (!good.ok) throw new Error(good.errors.join());
    const a = run(good, bars);
    expect(Array.from(a.plots[0]!.values as ArrayLike<number>)).toEqual([1, 1, 1]);
    expect(a.warnings).toEqual([]);

    const bad = transpile(script("sometime next year"));
    if (!bad.ok) throw new Error(bad.errors.join());
    expect(run(bad, bars).warnings.join(" ")).toMatch(/timestamp\('sometime next year'\) is not a date string/);
  });
});
