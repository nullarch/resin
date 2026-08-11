// viz S2 — bgcolor()/barcolor()/hline() stop being pure no-ops. Static arguments
// land on TranspileOk.viz (best-effort, TV defaults, never an error); a runtime
// color on bgcolor/barcolor gets a slot in the same $.plotColors pool as plot(),
// written through rt.vizColor so a na color branch records null. hline stays
// compile-time metadata (its color is a const input in TV).
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

describe("viz S2: bgcolor", () => {
  it("records a per-bar color with null on the na branch", () => {
    const r = ok(`//@version=5
indicator("bg")
up = close > open
bgcolor(up ? color.green : na)
plot(close)
`);
    expect(r.viz.bgcolors).toHaveLength(1);
    expect(r.viz.bgcolors[0]!.colorSlot).toBe(0);
    const res = run(r, DATA);
    // up per bar: T, F, T, T — the na branch must land as null, not NaN
    expect(res.viz!.bgcolors[0]!.colors).toEqual(["#4CAF50", null, "#4CAF50", "#4CAF50"]);
  });

  it("keeps a static color as metadata without opening a channel", () => {
    const r = ok(`//@version=5
indicator("bg")
bgcolor(color.blue, title="tint")
plot(close)
`);
    expect(r.viz.bgcolors[0]).toEqual({
      title: "tint",
      offset: 0,
      forceOverlay: false,
      color: "#2196F3",
      colorSlot: null,
    });
    // no runtime channel — generated code has no color write for this statement
    expect(r.code).not.toContain("plotColors");
  });
});

describe("viz S2: barcolor", () => {
  it("records runtime colors alongside plot's channel without collision", () => {
    const r = ok(`//@version=5
indicator("bar")
up = close > open
plot(close, "P", color = up ? color.lime : color.silver)
barcolor(up ? color.green : color.red)
plot(open)
`);
    // plot's dynamic color takes slot 0, barcolor's takes slot 1 — shared pool
    expect(r.viz.plots[0]!.colorSlot).toBe(0);
    expect(r.viz.barcolors[0]!.colorSlot).toBe(1);
    const res = run(r, DATA);
    expect(res.viz!.barcolors[0]!.colors).toEqual(["#4CAF50", "#FF5252", "#4CAF50", "#4CAF50"]);
    expect(res.viz!.plots[0]!.colors![1]).toBe("#B2B5BE");
  });
});

describe("viz S2: hline", () => {
  it("captures price/title/color/linestyle/linewidth as metadata", () => {
    const r = ok(`//@version=5
indicator("h")
hline(70, "Overbought", color.red, hline.style_dashed, linewidth=2)
hline(30)
plot(close)
`);
    expect(r.viz.hlines).toEqual([
      { title: "Overbought", price: 70, color: "#FF5252", linestyle: "dashed", linewidth: 2 },
      { title: null, price: 30, color: null, linestyle: "solid", linewidth: 1 },
    ]);
  });

  it("leaves a non-literal price as null instead of erroring", () => {
    const r = ok(`//@version=5
indicator("h")
lvl = input.float(70, "L")
hline(lvl, "Level")
plot(close)
`);
    expect(r.viz.hlines[0]!.price).toBeNull();
  });
});

describe("viz S2: values stay untouched", () => {
  it("adding bgcolor/barcolor does not change plot values or var snapshots", () => {
    const bare = ok(`//@version=5
indicator("v")
s = ta.sma(close, 2)
plot(s, "S")
`);
    const decorated = ok(`//@version=5
indicator("v")
s = ta.sma(close, 2)
bgcolor(close > s ? color.new(color.green, 85) : na)
barcolor(close > open ? color.green : color.red)
hline(102)
plot(s, "S")
`);
    const a = run(bare, DATA);
    const b = run(decorated, DATA);
    expect(b.plots[0]!.values).toEqual(a.plots[0]!.values);
    expect(b.bars.map((x) => x["var:s"])).toEqual(a.bars.map((x) => x["var:s"]));
  });
});
