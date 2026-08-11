// viz S3 — the marker family (plotshape/plotchar/plotarrow/plotcandle/plotbar)
// stops being dropped. Static kwargs land as metadata; the condition/series/OHLC
// arguments get $.vizSeries channels and — this is the slice's semantic shift —
// start executing every bar (TV-aligned: TV always evaluates plot* arguments).
// A ta.* call inside a marker argument therefore advances real state now.
import { describe, expect, it } from "vitest";
import { run } from "../../src/runtime/engine";
import { transpile } from "../../src/transpiler/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import type { TranspileErr, TranspileOk } from "../../src/transpiler/pipeline";

const DATA: OHLCVData = {
  open: [100, 102, 101, 103],
  high: [103, 104, 103, 105],
  low: [99, 100, 99, 101],
  close: [102, 101, 102.5, 104],
  volume: [10, 20, 30, 40],
};

function ok(source: string): TranspileOk {
  const r = transpile(source);
  if (!r.ok) throw new Error((r as TranspileErr).errors.join("; "));
  return r;
}

describe("viz S3: plotshape / plotchar", () => {
  it("records the condition per bar and captures static styling", () => {
    const r = ok(`//@version=5
indicator("s")
up = close > open
plotshape(up, "Up", style=shape.triangleup, location=location.belowbar, color=color.green, size=size.small, text="B")
plot(close)
`);
    expect(r.viz.shapes).toHaveLength(1);
    const meta = r.viz.shapes[0]!;
    expect(meta.style).toBe("triangleup");
    expect(meta.location).toBe("belowbar");
    expect(meta.size).toBe("small");
    expect(meta.text).toBe("B");
    expect(meta.color).toBe("#4CAF50");
    const res = run(r, DATA);
    expect(res.viz!.shapes[0]!.condition).toEqual([true, false, true, true]);
  });

  it("a ta.* call inside the condition advances state every bar (TV-aligned)", () => {
    const r = ok(`//@version=5
indicator("s")
plotshape(ta.crossover(close, ta.sma(close, 2)), "X")
plot(close)
`);
    const res = run(r, DATA);
    // closes: 102,101,102.5,104 — sma2: na,101.5,101.75,103.25 — crossover at bar2 (101<=101.5 then 102.5>101.75)
    expect(res.viz!.shapes[0]!.condition).toEqual([false, false, true, false]);
  });

  it("plotchar captures its char and falls back to ★", () => {
    const r = ok(`//@version=5
indicator("c")
up = close > open
plotchar(up, "A", "▲")
plotchar(up, "B")
plot(close)
`);
    expect(r.viz.chars.map((c) => c.char)).toEqual(["▲", "★"]);
  });
});

describe("viz S3: plotarrow", () => {
  it("records the numeric series with NaN for na", () => {
    const r = ok(`//@version=5
indicator("a")
delta = close - open
plotarrow(delta > 1 ? delta : na, "D", colorup=color.teal, minheight=10)
plot(close)
`);
    const meta = r.viz.arrows[0]!;
    expect(meta.colorup).toBe("#00897B");
    expect(meta.minheight).toBe(10);
    const res = run(r, DATA);
    const v = res.viz!.arrows[0]!.values;
    // deltas: 2, -1, 1.5, 1 → >1: 2, na, 1.5, na
    expect(v[0]).toBe(2);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(v[2]).toBe(1.5);
    expect(Number.isNaN(v[3])).toBe(true);
  });
});

describe("viz S3: plotcandle / plotbar", () => {
  it("records four OHLC channels and a per-bar candle color", () => {
    const r = ok(`//@version=5
indicator("hk")
ha_c = (open + high + low + close) / 4
plotcandle(open, high, low, ha_c, "HA", color = close >= open ? color.green : color.red)
plot(close)
`);
    const res = run(r, DATA);
    const c = res.viz!.candles[0]!;
    expect(c.open).toEqual([100, 102, 101, 103]);
    expect(c.high).toEqual([103, 104, 103, 105]);
    expect(c.close[0]).toBeCloseTo((100 + 103 + 99 + 102) / 4, 12);
    expect(c.colors).toEqual(["#4CAF50", "#FF5252", "#4CAF50", "#4CAF50"]);
  });

  it("plotbar has no wick/border capture and lands in plotbars", () => {
    const r = ok(`//@version=5
indicator("b")
plotbar(open, high, low, close, "Raw", color.gray)
plot(close)
`);
    expect(r.viz.plotbars).toHaveLength(1);
    expect(r.viz.plotbars[0]!.wickcolor).toBeNull();
    expect(r.viz.plotbars[0]!.color).toBe("#787B86");
    const res = run(r, DATA);
    expect(res.viz!.plotbars[0]!.low).toEqual([99, 100, 99, 101]);
  });
});

describe("viz S3: value channels stay untouched", () => {
  it("adding markers does not change plot values or var snapshots", () => {
    const bare = ok(`//@version=5
indicator("v")
s = ta.sma(close, 2)
plot(s, "S")
`);
    const decorated = ok(`//@version=5
indicator("v")
s = ta.sma(close, 2)
plotshape(ta.crossover(close, s), "X", style=shape.circle)
plotarrow(close - open)
plotcandle(open, high, low, close)
plot(s, "S")
`);
    const a = run(bare, DATA);
    const b = run(decorated, DATA);
    expect(b.plots[0]!.values).toEqual(a.plots[0]!.values);
    expect(b.bars.map((x) => x["var:s"])).toEqual(a.bars.map((x) => x["var:s"]));
  });
});
