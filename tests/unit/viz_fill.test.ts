// viz S2b — fill() capture. The two handle arguments are resolved statically:
// bare nested plot()/hline() calls land directly in the slot maps, and identifier
// references go through uniqueTopEqVars (top-level unique '=' bindings, the same
// safety basis as directive constant substitution). Unresolvable refs become null
// rather than errors. Colors follow the bgcolor rules (static meta / runtime slot).
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

describe("viz S2b: fill handle resolution", () => {
  it("resolves '=' local plot handles to plot slots", () => {
    const r = ok(`//@version=5
indicator("f")
p1 = plot(high, "H")
p2 = plot(low, "L")
fill(p1, p2, color.red, "band")
`);
    expect(r.viz.fills).toEqual([
      {
        a: { kind: "plot", index: 0 },
        b: { kind: "plot", index: 1 },
        color: "#FF5252",
        colorSlot: null,
        title: "band",
      },
    ]);
  });

  it("resolves bare nested plot() calls", () => {
    const r = ok(`//@version=5
indicator("f")
fill(plot(high, "H"), plot(low, "L"), color.blue)
`);
    expect(r.viz.fills[0]!.a).toEqual({ kind: "plot", index: 0 });
    expect(r.viz.fills[0]!.b).toEqual({ kind: "plot", index: 1 });
    // the rescued nested plots still record their values
    const res = run(r, DATA);
    expect(res.plots.map((p) => p.title)).toEqual(["H", "L"]);
    expect(res.plots[0]!.values).toEqual([103, 104, 103, 105]);
  });

  it("resolves hline handles to hline indices", () => {
    const r = ok(`//@version=5
indicator("f")
h1 = hline(70, "OB")
h2 = hline(30, "OS")
fill(h1, h2, color=color.new(color.purple, 90))
plot(close)
`);
    expect(r.viz.fills[0]!.a).toEqual({ kind: "hline", index: 0 });
    expect(r.viz.fills[0]!.b).toEqual({ kind: "hline", index: 1 });
    // color.new(...) is a call — runtime channel, constant per bar
    const res = run(r, DATA);
    const colors = res.viz!.fills[0]!.colors!;
    expect(colors).toHaveLength(4);
    expect(new Set(colors).size).toBe(1);
    expect(colors[0]).toMatch(/^#9C27B0/i);
  });

  it("records a per-bar fill color for a conditional color", () => {
    const r = ok(`//@version=5
indicator("f")
p1 = plot(high, "H")
p2 = plot(low, "L")
fill(p1, p2, color = close > open ? color.green : na)
`);
    const res = run(r, DATA);
    expect(res.viz!.fills[0]!.colors).toEqual(["#4CAF50", null, "#4CAF50", "#4CAF50"]);
  });

  it("kwarg plot1=/plot2= nested calls resolve too", () => {
    const r = ok(`//@version=5
indicator("f")
fill(plot1=plot(high, "H"), plot2=plot(low, "L"), color=color.gray)
`);
    expect(r.viz.fills[0]!.a).toEqual({ kind: "plot", index: 0 });
    expect(r.viz.fills[0]!.b).toEqual({ kind: "plot", index: 1 });
    expect(r.viz.fills[0]!.color).toBe("#787B86");
  });
});
