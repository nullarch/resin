// log.info / log.warning / log.error through ContextOptions.onLog, and the number formatting of
// their messages (str.format: MessageFormat's '#,##0.###' groups from 1000, the text TradingView's
// Pine Logs pane shows; tier 1 ta_243_variance_stdev_exact expects "-18,189.894").
import { describe, expect, it } from "vitest";
import { compile, run } from "../../src/runtime/engine";
import { Context } from "../../src/runtime/context";
import { transpile } from "../../src/transpiler/pipeline";
import { format, tostring } from "../../src/runtime/str";
import type { LogEntry } from "../../src/runtime/log";
import type { OHLCVData } from "../../src/runtime/context";
import type { TranspileOk } from "../../src/transpiler/pipeline";

const data: OHLCVData = {
  open: [1, 5, 2, 3],
  high: [3, 7, 5, 4],
  low: [0, 2, 1, 2],
  close: [2, 4, 3, 1500.5],
  volume: [10, 20, 30, 40],
  time: [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000, 1_700_000_180_000],
};

function ok(source: string): TranspileOk {
  const r = transpile(source);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
}

const SCRIPT = [
  "//@version=5",
  'indicator("logs")',
  "if bar_index >= 2",
  '    log.info("close {0}", close)',
  '    log.warning("warn")',
  '    log.error("err {0}/{1}", bar_index, "x")',
  "plot(close, 'c')",
].join("\n");

describe("ContextOptions.onLog", () => {
  it("run() hands every log.* call to the sink, in order, with level, bar and time", () => {
    const entries: LogEntry[] = [];
    run(ok(SCRIPT), data, { onLog: (e) => entries.push(e) });
    expect(entries).toEqual([
      { level: "info", message: "close 3", bar: 2, time: 1_700_000_120_000 },
      { level: "warning", message: "warn", bar: 2, time: 1_700_000_120_000 },
      { level: "error", message: "err 2/x", bar: 2, time: 1_700_000_120_000 },
      { level: "info", message: "close 1,500.5", bar: 3, time: 1_700_000_180_000 },
      { level: "warning", message: "warn", bar: 3, time: 1_700_000_180_000 },
      { level: "error", message: "err 3/x", bar: 3, time: 1_700_000_180_000 },
    ]);
  });

  it("the streaming form reads the sink from Context.from", () => {
    const result = ok(SCRIPT);
    const messages: string[] = [];
    const ctx = Context.from(result, data, { onLog: (e) => messages.push(e.message) });
    const bar = compile(result.code)(ctx);
    for (let i = 0; i < ctx.barCount; i++) {
      ctx.advance();
      bar();
    }
    expect(messages.filter((m) => m.startsWith("close"))).toEqual(["close 3", "close 1,500.5"]);
  });

  it("time is undefined when the data has no time channel", () => {
    const entries: LogEntry[] = [];
    const { time: _time, ...noTime } = data;
    run(ok(SCRIPT), noTime, { onLog: (e) => entries.push(e) });
    expect(entries[0]).toMatchObject({ bar: 2, time: undefined });
  });

  it("without a sink the calls stay no-ops and results do not change", () => {
    const plain = run(ok(SCRIPT), data);
    const sunk = run(ok(SCRIPT), data, { onLog: () => {} });
    expect(plain.plots).toEqual(sunk.plots);
    expect(plain.plots[0]!.values).toEqual([2, 4, 3, 1500.5]);
  });

  it("a log call inside a user function reports the bar it runs on", () => {
    const entries: LogEntry[] = [];
    const source = [
      "//@version=5",
      'indicator("fn")',
      "f(x) =>",
      '    log.info("x={0}", x)',
      "    x",
      "plot(f(close), 'c')",
    ].join("\n");
    run(ok(source), data, { onLog: (e) => entries.push(e) });
    expect(entries.map((e) => [e.bar, e.message])).toEqual([
      [0, "x=2"], [1, "x=4"], [2, "x=3"], [3, "x=1,500.5"],
    ]);
  });

  it("an na format string logs as the empty string", () => {
    const entries: LogEntry[] = [];
    const source = ["//@version=5", 'indicator("na")', "string s = na", "log.info(s)", "plot(close, 'c')"].join("\n");
    run(ok(source), data, { onLog: (e) => entries.push(e) });
    expect(entries.map((e) => e.message)).toEqual(["", "", "", ""]);
  });
});

describe("str.format groups thousands the way MessageFormat does", () => {
  it("{0} and {0,number} use '#,##0.###'", () => {
    expect(format("{0}", -18189.894)).toBe("-18,189.894");
    expect(format("{0}", 1000)).toBe("1,000");
    expect(format("{0}", 999.9996)).toBe("1,000");
    expect(format("{0}", 1234567.891)).toBe("1,234,567.891");
    expect(format("{0}", 999)).toBe("999");
    expect(format("{0}", 0.5)).toBe("0.5");
    expect(format("{0,number}", 12345.6789)).toBe("12,345.679");
  });

  it("integer, percent and currency styles group; an explicit pattern groups only with a ','", () => {
    expect(format("{0,number,integer}", 1340000)).toBe("1,340,000");
    expect(format("{0,number,integer}", -2500.5)).toBe("-2,500");
    expect(format("{0,number,percent}", 12.5)).toBe("1,250%");
    expect(format("{0,number,currency}", 1340000)).toBe("$1,340,000.00");
    expect(format("{0,number,#.##}", 12345.678)).toBe("12345.68");
    expect(format("{0,number,#,###.##}", 12345.678)).toBe("12,345.68");
    expect(format("{0,number,#,##0.00}", 1234)).toBe("1,234.00");
    expect(format("{0,number,000,000}", 1234)).toBe("001,234");
  });

  it("array elements and str.tostring are not grouped", () => {
    expect(format("{0}", [1234.5, 2])).toBe("[1234.5, 2.0]");
    expect(tostring(1234567.891)).toBe("1234567.891");
    expect(tostring(1234567.891, "#.##")).toBe("1234567.89");
  });
});
