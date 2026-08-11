// viz S1 — plot() rendering kwargs stop being discarded. Static kwargs land on
// TranspileOk.viz.plots (best-effort: literal or TV default, never an error);
// a runtime color= expression gets a $.plotColors slot the generated code fills
// per bar, surfaced as RunResult.viz.plots[i].colors by the object-form run().
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

describe("viz S1: static plot metadata", () => {
  it("captures literal style/linewidth/offset/histbase/trackprice", () => {
    const r = ok(`//@version=5
indicator("m")
plot(close, "P", color.red, 3, plot.style_histogram, true, 50, 2)
`);
    expect(r.viz.plots).toEqual([
      {
        title: "P",
        style: "histogram",
        linewidth: 3,
        offset: 2,
        histbase: 50,
        trackprice: true,
        forceOverlay: false,
        color: "#FF5252",
        colorSlot: null,
      },
    ]);
  });

  it("falls back to TV defaults when kwargs are absent", () => {
    const r = ok('//@version=5\nindicator("m")\nplot(close)');
    expect(r.viz.plots).toEqual([
      {
        title: "Plot 0",
        style: "line",
        linewidth: 1,
        offset: 0,
        histbase: 0,
        trackprice: false,
        forceOverlay: false,
        color: null,
        colorSlot: null,
      },
    ]);
  });

  it("falls back per-field, not per-call, when a kwarg is not a literal", () => {
    const r = ok(`//@version=5
indicator("m")
w = 4
plot(close, "P", linewidth=w, style=plot.style_area)
`);
    expect(r.viz.plots[0]!.linewidth).toBe(1); // non-literal → default, never an error
    expect(r.viz.plots[0]!.style).toBe("area"); // sibling literal still captured
  });

  it("resolves color constants and hex literals at compile time (no slot)", () => {
    const r = ok(`//@version=5
indicator("m")
plot(close, "A", color=color.orange)
plot(open, "B", color=#00FF0080)
`);
    expect(r.viz.plots.map((p) => [p.color, p.colorSlot])).toEqual([
      ["#FF9800", null],
      ["#00FF0080", null],
    ]);
  });
});

describe("viz S1: runtime color channel", () => {
  it("records a per-bar color series for a ternary color kwarg", () => {
    const r = ok(`//@version=5
indicator("m")
plot(close, "P", color = close > open ? color.green : color.red)
`);
    expect(r.viz.plots[0]!.colorSlot).toBe(0);
    const res = run(r, DATA);
    // close>open per bar: 102>100 T, 101>102 F, 102.5>101 T, 104>103 T
    expect(res.viz!.plots[0]!.colors).toEqual(["#4CAF50", "#FF5252", "#4CAF50", "#4CAF50"]);
    expect(res.viz!.plots[0]!.color).toBeNull();
  });

  it("keeps the value series identical to a plot without color", () => {
    const withColor = ok(`//@version=5
indicator("m")
plot(ta.sma(close, 2), "P", color = close > open ? color.green : color.red)
`);
    const without = ok(`//@version=5
indicator("m")
plot(ta.sma(close, 2), "P")
`);
    expect(run(withColor, DATA).plots[0]!.values).toEqual(run(without, DATA).plots[0]!.values);
  });

  it("gives independent slots to multiple dynamic-color plots", () => {
    const r = ok(`//@version=5
indicator("m")
up = close > open
plot(close, "A", color = up ? color.blue : color.gray)
plot(open, "B", color = up ? color.yellow : color.purple)
`);
    expect(r.viz.plots.map((p) => p.colorSlot)).toEqual([0, 1]);
    const res = run(r, DATA);
    expect(res.viz!.plots[0]!.colors![1]).toBe("#787B86"); // bar1: down
    expect(res.viz!.plots[1]!.colors![1]).toBe("#9C27B0");
  });

  it("advances ta.* state inside a dynamic color expression every bar", () => {
    // The color expression is evaluated unconditionally per bar, so the sma inside
    // it must see all four bars — its last color compares close to a 2-bar mean.
    const r = ok(`//@version=5
indicator("m")
plot(close, "P", color = close > ta.sma(close, 2) ? color.lime : color.silver)
`);
    const res = run(r, DATA);
    // bar3: close 104 > sma(102.5,104)=103.25 → lime; bar1: 101 > 101.5 false → silver
    expect(res.viz!.plots[0]!.colors![1]).toBe("#B2B5BE");
    expect(res.viz!.plots[0]!.colors![3]).toBe("#00E676");
  });

  it("positional runtime color works the same as kwarg", () => {
    const r = ok(`//@version=5
indicator("m")
plot(close, "P", close > open ? color.green : color.red)
`);
    expect(r.viz.plots[0]!.colorSlot).toBe(0);
    expect(run(r, DATA).viz!.plots[0]!.colors![0]).toBe("#4CAF50");
  });

  it("the positional run() spelling leaves viz undefined", () => {
    const r = ok(`//@version=5
indicator("m")
plot(close, "P", color = close > open ? color.green : color.red)
`);
    const res = run(
      r.code, r.varSlots, r.taSlotCount, DATA, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, {}, r.plotTitles, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount,
    );
    expect(res.viz).toBeUndefined();
    expect(res.plots[0]!.values.length).toBe(4); // value channel unaffected
  });
});
