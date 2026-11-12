// The data shape matrix: whatever OHLCV a caller feeds run(), the answer is a result with one value
// per bar and, where API.md promises it, a warning — or the one documented refusal (arrays of
// different lengths, a TypeError). Never a raw exception, never a hang.
//
// Scripts are transpiled for hourly bars (`chartTf: "60"`, as tests/unit/run_diagnostics.test.ts
// does), so a clean run carries no warning and any warning below is about the shape under test.
// Timings of the 20,000-bar runs print when RESIN_ROBUSTNESS_TIMINGS=1 (or RESIN_PROP_RUNS > 1).
import { describe, expect, it } from "vitest";
import { run, transpile, type OHLCVData, type RunResult, type TranspileOk } from "../../src/index";
import { makeSyntheticOHLCV, SYNTHETIC_BAR_MS, type SyntheticOHLCV } from "../helpers/synthetic";

const RUNS = Math.max(1, Math.floor(Number(process.env.RESIN_PROP_RUNS ?? 1)) || 1);
const LIMITS = { maxStepsPerBar: 200_000, maxCollectionLength: 100_000 } as const;
const H = "//@version=6\n";

const SCRIPTS = {
  indicator:
    H +
    'indicator("ind")\nplot(ta.sma(close, 5), "sma")\nplot(ta.rsi(close, 14), "rsi")\nplot(ta.atr(14), "atr")\n' +
    'plot(ta.crossover(close, ta.sma(close, 5)) ? 1 : 0, "xo")\nplot(ta.stdev(close, 5), "sd")\n' +
    '[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(m, "macd")\nplot(ta.vwap(hlc3), "vwap")\nplot(ta.pivothigh(high, 2, 2), "ph")\n',
  strategy:
    H +
    'strategy("s", default_qty_type=strategy.percent_of_equity, default_qty_value=100, initial_capital=1000, commission_type=strategy.commission.percent, commission_value=0.1)\n' +
    "fast = ta.sma(close, 5)\nslow = ta.sma(close, 20)\nif ta.crossover(fast, slow)\n    strategy.entry(\"L\", strategy.long)\n" +
    'if ta.crossunder(fast, slow)\n    strategy.close("L")\nstrategy.exit("x", "L", stop=close * 0.98, limit=close * 1.02)\n' +
    'plot(strategy.equity, "eq")\nplot(strategy.netprofit, "np")\nplot(strategy.position_size, "ps")\n',
  // Enters and exits on a clock rather than on a crossover, so every data shape reaches a fill.
  entries:
    H +
    'strategy("e", initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.1)\n' +
    'if bar_index % 4 == 0\n    strategy.entry("L", strategy.long)\nif bar_index % 4 == 2\n    strategy.close("L")\n' +
    'plot(strategy.equity, "eq")\nplot(strategy.position_size, "ps")\n',
  calendar:
    H +
    'indicator("cal")\nplot(timeframe.change("D") ? 1 : 0, "chg")\nplot(dayofweek, "dow")\nplot(hour, "hr")\nplot(time, "t")\nplot(bar_index, "bi")\n',
  collections:
    H +
    'indicator("col")\nvar a = array.new_float(0)\narray.push(a, close)\nif array.size(a) > 50\n    array.shift(a)\n' +
    'plot(array.avg(a), "avg")\nx = request.security(syminfo.tickerid, "D", close)\nplot(x, "daily")\nplot(ta.pivotlow(low, 3, 3), "pl")\n',
} as const;
type ScriptName = keyof typeof SCRIPTS;

const compiled = new Map<ScriptName, TranspileOk>();
function script(name: ScriptName): TranspileOk {
  let t = compiled.get(name);
  if (t === undefined) {
    const r = transpile(SCRIPTS[name], { chartTf: "60" });
    if (!r.ok) throw new Error(`${name}: ${r.errors.join("; ")}`);
    compiled.set(name, (t = r));
  }
  return t;
}

const snapshot = (d: OHLCVData): string =>
  JSON.stringify(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Array.from(v as ArrayLike<number>, (x) => (Number.isNaN(x) ? "NaN" : x))])));
const plotsOf = (r: RunResult): string => JSON.stringify(r.plots.map((p) => [p.title, p.values.map((x) => (Number.isNaN(x) ? "NaN" : x))]));

function clone(d: SyntheticOHLCV): SyntheticOHLCV {
  return { open: d.open.slice(), high: d.high.slice(), low: d.low.slice(), close: d.close.slice(), volume: d.volume.slice(), time: d.time.slice() };
}
const mapPrices = (d: SyntheticOHLCV, f: (v: number) => number): SyntheticOHLCV => ({
  ...d, open: d.open.map(f), high: d.high.map(f), low: d.low.map(f), close: d.close.map(f),
});

// A (script, shape) cell that fails today with the given raw error: it runs as `it.fails`, so it turns
// red the day the defect is fixed. All of these are KD9 in tests/robustness/README.md: the strategy
// commission code converts a non-finite fill value to a BigInt.
const KD9 = /BigInt/;

interface Shape {
  name: string;
  make: (base: SyntheticOHLCV) => OHLCVData;
  // Cells known to throw: script name -> the error message they throw.
  knownFail?: Partial<Record<ScriptName, RegExp>>;
  // Messages RunResult.warnings must contain (each a regex over the joined list); null: no check.
  warns?: RegExp[];
  // No warning at all is promised for this shape.
  clean?: boolean;
}

const BARS = 60;
const SHAPES: Shape[] = [
  { name: "baseline (60 hourly bars)", make: (d) => d, clean: true },
  { name: "0 bars", make: () => ({ open: [], high: [], low: [], close: [], volume: [], time: [] }), clean: true },
  { name: "0 bars, no time channel", make: () => ({ open: [], high: [], low: [], close: [], volume: [] }), clean: true },
  { name: "1 bar", make: (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.slice(0, 1)])) as unknown as OHLCVData, clean: true },
  { name: "2 bars", make: (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.slice(0, 2)])) as unknown as OHLCVData, clean: true },
  { name: "every price NaN", make: (d) => mapPrices(d, () => NaN) },
  { name: "open NaN on the bar an order fills", make: (d) => ({ ...d, open: d.open.map((v, i) => (i === 5 ? NaN : v)) }), knownFail: { entries: KD9 } },
  { name: "one bar a hole (open, high, low, close NaN)", make: (d) => { const o = clone(d); for (const k of ["open", "high", "low", "close"] as const) o[k][5] = NaN; return o; }, knownFail: { entries: KD9 } },
  { name: "every 7th close NaN", make: (d) => ({ ...d, close: d.close.map((v, i) => (i % 7 === 3 ? NaN : v)) }) },
  { name: "volume NaN", make: (d) => ({ ...d, volume: d.volume.map(() => NaN) }), clean: true },
  { name: "one close is Infinity", make: (d) => ({ ...d, close: d.close.map((v, i) => (i === 30 ? Infinity : v)) }) },
  { name: "one low is -Infinity", make: (d) => ({ ...d, low: d.low.map((v, i) => (i === 30 ? -Infinity : v)) }) },
  { name: "negative prices", make: (d) => ({ ...d, open: d.open.map((v) => -v), high: d.low.map((v) => -v), low: d.high.map((v) => -v), close: d.close.map((v) => -v) }), clean: true },
  { name: "zero prices", make: (d) => mapPrices(d, () => 0), clean: true },
  { name: "zero volume", make: (d) => ({ ...d, volume: d.volume.map(() => 0) }), clean: true },
  { name: "negative volume", make: (d) => ({ ...d, volume: d.volume.map((v) => -v) }), clean: true },
  { name: "constant prices", make: (d) => mapPrices(d, () => 100), clean: true },
  { name: "huge prices (x1e300)", make: (d) => mapPrices(d, (v) => v * 1e300) },
  { name: "tiny prices (x1e-300)", make: (d) => mapPrices(d, (v) => v * 1e-300), knownFail: { strategy: KD9, entries: KD9 } },
  { name: "Float64Array columns", make: (d) => ({ open: Float64Array.from(d.open), high: Float64Array.from(d.high), low: Float64Array.from(d.low), close: Float64Array.from(d.close), volume: Float64Array.from(d.volume), time: Float64Array.from(d.time) }), clean: true },
  { name: "no time channel", make: ({ time: _t, ...rest }) => rest },
  // time
  { name: "equal timestamps", make: (d) => ({ ...d, time: d.time.map(() => d.time[0]!) }), warns: [/not strictly increasing at bar 1/] },
  { name: "duplicate timestamps in pairs", make: (d) => ({ ...d, time: d.time.map((_, i) => d.time[i - (i % 2)]!) }), warns: [/not strictly increasing at bar 1/] },
  { name: "two adjacent timestamps swapped", make: (d) => { const o = clone(d); [o.time[10], o.time[11]] = [o.time[11]!, o.time[10]!]; return o; }, warns: [/not strictly increasing at bar 11/] },
  { name: "bars in reverse order", make: (d) => { const o = clone(d); for (const k of Object.keys(o) as (keyof SyntheticOHLCV)[]) o[k].reverse(); return o; }, warns: [/not strictly increasing at bar 1/] },
  { name: "all timestamps 0", make: (d) => ({ ...d, time: d.time.map(() => 0) }), warns: [/not strictly increasing/] },
  { name: "timestamps before 1970", make: (d) => ({ ...d, time: d.time.map((_, i) => -1e12 + i * SYNTHETIC_BAR_MS) }) },
  { name: "time in seconds", make: (d) => ({ ...d, time: d.time.map((v) => v / 1000) }), warns: [/looks like seconds/] },
  { name: "weekend-sized gaps every 5 bars", make: (d) => ({ ...d, time: d.time.map((v, i) => v + Math.floor(i / 5) * 400 * 3_600_000) }), clean: true },
  { name: "high below low", make: (d) => { const o = clone(d); o.high[2] = o.low[2]! - 1; return o; }, warns: [/bar 2 has high < low/] },
];

const noThrow = (name: string, fn: () => RunResult): RunResult => {
  try {
    return fn();
  } catch (e) {
    throw new Error(`${name}: threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)}`, { cause: e });
  }
};

describe("data shape matrix", () => {
  const base = makeSyntheticOHLCV(BARS, 5);
  for (const shape of SHAPES) {
    for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
      const known = shape.knownFail?.[name];
      if (known !== undefined) {
        it.fails(`${name} on ${shape.name} throws ${known.source} today`, () => {
          const data = shape.make(clone(base));
          try {
            run(script(name), data, { limits: { ...LIMITS } });
          } catch (e) {
            // The defect is gone only when the run stops throwing; any other error would be new.
            if (!(e instanceof Error && known.test(e.message))) return;
            throw e;
          }
        });
        continue;
      }
      it(`${name} on ${shape.name}`, () => {
        const data = shape.make(clone(base));
        const before = snapshot(data);
        const bars = data.close.length;
        const r = noThrow(`${name} / ${shape.name}`, () => run(script(name), data, { limits: { ...LIMITS } }));

        expect(r.bars.length).toBe(bars);
        for (const p of r.plots) expect(p.values.length, `plot '${p.title}'`).toBe(bars);
        expect(r.viz?.plots.length).toBe(r.plots.length);

        const w = r.warnings.join("\n");
        for (const re of shape.warns ?? []) expect(w, "RunResult.warnings").toMatch(re);
        if (shape.clean === true) expect(r.warnings, "a clean shape promises no warning").toEqual([]);

        // run() reads the caller's arrays and leaves them alone, and a second run is the same run.
        expect(snapshot(data), "run() modified the caller's data").toBe(before);
        const again = run(script(name), data, { limits: { ...LIMITS } });
        expect(plotsOf(again), "a second run on the same data differs").toBe(plotsOf(r));
      });
    }
  }

  it("a plain-array run and a Float64Array run agree", () => {
    const d = base;
    const f64 = { open: Float64Array.from(d.open), high: Float64Array.from(d.high), low: Float64Array.from(d.low), close: Float64Array.from(d.close), volume: Float64Array.from(d.volume), time: Float64Array.from(d.time) };
    expect(plotsOf(run(script("indicator"), f64, { limits: { ...LIMITS } }))).toBe(plotsOf(run(script("indicator"), d, { limits: { ...LIMITS } })));
  });

  it("a constant price gives a constant average and no deviation", () => {
    const r = run(script("indicator"), mapPrices(clone(base), () => 100), { limits: { ...LIMITS } });
    const sma = r.plots.find((p) => p.title === "sma")!.values;
    const sd = r.plots.find((p) => p.title === "sd")!.values;
    for (let i = 4; i < BARS; i++) {
      expect(sma[i]).toBeCloseTo(100, 9);
      expect(sd[i]).toBeCloseTo(0, 9);
    }
  });

  it("baseline numbers are finite where the indicators are warm", () => {
    const r = run(script("indicator"), base, { limits: { ...LIMITS } });
    for (const title of ["sma", "rsi", "atr", "sd", "macd"]) {
      const v = r.plots.find((p) => p.title === title)!.values;
      expect(Number.isFinite(v[BARS - 1]), `${title} at the last bar`).toBe(true);
    }
    const eq = run(script("strategy"), base, { limits: { ...LIMITS } }).plots.find((p) => p.title === "eq")!.values;
    expect(Number.isFinite(eq[BARS - 1])).toBe(true);
  });
});

describe("unequal array lengths are the one refusal, and it is a TypeError", () => {
  const base = makeSyntheticOHLCV(20, 5);
  for (const key of ["open", "high", "low", "volume", "time"] as const) {
    it(`${key} shorter than close`, () => {
      const d = { ...clone(base), [key]: base[key].slice(0, 10) };
      expect(() => run(script("indicator"), d)).toThrow(TypeError);
      expect(() => run(script("indicator"), d)).toThrow(new RegExp(`differ in length: close has 20 bars, ${key} has 10`));
    });
  }
  it("close shorter than the rest", () => {
    expect(() => run(script("indicator"), { ...clone(base), close: base.close.slice(0, 5) })).toThrow(TypeError);
  });
  it("longer is refused too", () => {
    expect(() => run(script("indicator"), { ...clone(base), volume: [...base.volume, 1] })).toThrow(/volume has 21/);
  });
});

// A bar time that is not a date — NaN, Infinity, or past JavaScript's ±8.64e15 ms — reaches the
// exchange calendar. API.md says unequal lengths are "the one data problem refused outright" and
// time that is out of order is a warning; this one is neither: a raw RangeError from Intl, thrown
// by a script that reads the calendar (ta.vwap, timeframe.change, session.*, str.format_time).
// (dayofweek, hour, month and time itself are computed without the calendar and survive.) KD8.
describe("known defect: a bar time that is not a date", () => {
  const base = makeSyntheticOHLCV(BARS, 5);
  const cases: [string, (d: SyntheticOHLCV) => SyntheticOHLCV][] = [
    ["one NaN time", (d) => ({ ...d, time: d.time.map((v, i) => (i === 10 ? NaN : v)) })],
    ["one Infinity time", (d) => ({ ...d, time: d.time.map((v, i) => (i === 5 ? Infinity : v)) })],
    ["times past 8.64e15 ms", (d) => ({ ...d, time: d.time.map((_, i) => 8.64e15 + i * SYNTHETIC_BAR_MS) })],
  ];
  for (const [name, make] of cases) {
    for (const expr of ['timeframe.change("D") ? 1 : 0', "ta.vwap(hlc3)", "session.ismarket ? 1 : 0"]) {
      it.fails(`${name}: plot(${expr}) throws a RangeError instead of warning`, () => {
        const t = transpile(H + `indicator("x")\nplot(${expr})\n`, { chartTf: "60" });
        if (!t.ok) return; // not the documented defect: returning makes this it.fails go red
        let r: RunResult;
        try {
          r = run(t, make(clone(base)), { limits: { ...LIMITS } });
        } catch (e) {
          if (e instanceof RangeError && /Invalid time value/.test(e.message)) throw e; // the defect
          return; // some other error: also not the documented defect
        }
        expect(r.bars.length).toBe(BARS);
      });
    }
  }

  it("a script that never reads the calendar is unaffected", () => {
    const t = transpile(H + 'indicator("x")\nplot(ta.sma(close, 3))\n', { chartTf: "60" });
    if (!t.ok) throw new Error(t.errors.join("; "));
    const d = { ...clone(base), time: base.time.map((v, i) => (i === 10 ? NaN : v)) };
    const r = run(t, d, { limits: { ...LIMITS } });
    expect(r.bars.length).toBe(BARS);
    expect(r.warnings.join("\n")).toMatch(/not strictly increasing at bar 10/);
  });
});

// ---------------------------------------------------------------------------------------------
// Volume: 20,000 bars must stay linear. The bound is on this process's CPU time (user + system), not
// the wall clock, so a loaded machine cannot fail it: idle, the four scripts take 25-110 ms of CPU
// against a 1,000 ms bound, and a quadratic slip in a history or window buffer is 100x over it. A
// generous wall-clock bound only guards against a hang.

const SHOW_TIMINGS = process.env.RESIN_ROBUSTNESS_TIMINGS === "1" || RUNS > 1;
const timings: string[] = [];

describe("long series", () => {
  const scale = Math.min(RUNS, 5);
  const bars = 20_000 * scale;
  const boundMs = 1_000 * scale;
  const data = makeSyntheticOHLCV(bars, 9);

  for (const name of Object.keys(SCRIPTS) as ScriptName[]) {
    it(`${name}: ${bars} bars in under ${boundMs} ms of CPU`, () => {
      const t = script(name);
      const t0 = performance.now();
      const c0 = process.cpuUsage();
      const r = run(t, data, { limits: { ...LIMITS } });
      const c = process.cpuUsage(c0);
      const wallMs = performance.now() - t0;
      const cpuMs = (c.user + c.system) / 1000;
      timings.push(`${name.padEnd(12)} ${String(bars).padStart(7)} bars ${cpuMs.toFixed(0).padStart(5)} ms cpu ${wallMs.toFixed(0).padStart(5)} ms wall`);
      expect(r.bars.length).toBe(bars);
      for (const p of r.plots) expect(p.values.length).toBe(bars);
      expect(cpuMs, `${name} took ${cpuMs.toFixed(0)} ms of CPU`).toBeLessThan(boundMs);
      expect(wallMs, `${name} took ${wallMs.toFixed(0)} ms of wall clock`).toBeLessThan(15_000 * scale);
    });
  }

  it("reports the timings", () => {
    if (SHOW_TIMINGS) console.info(`data_edge timings\n${timings.join("\n")}`);
    expect(timings.length).toBeGreaterThan(0);
  });
});
