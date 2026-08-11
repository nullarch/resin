// viz S4 — drawing objects get a creation log. The handles always existed at
// runtime (C572 accessors); what was missing was ownership: they were module
// globals nobody could read back. Now newHandle routes every creation into the
// executing Context's drawingLog (installed per bar-function call, so interleaved
// streaming contexts stay isolated), display kwargs stop being dropped at codegen
// (DRAWING_STATE_PARAM_NAMES grew the display columns), and display set_* calls
// write state instead of being no-ops. The object-form run() exposes it all as
// RunResult.viz.drawings with final state snapshots.
import { describe, expect, it } from "vitest";
import { Context } from "../../src/runtime/context";
import { compile, run } from "../../src/runtime/engine";
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

describe("viz S4: creation log", () => {
  it("logs a last-bar label with its creation bar and captured kwargs", () => {
    const r = ok(`//@version=5
indicator("d")
if barstate.islast
    label.new(bar_index, high, "peak", style=label.style_label_down, color=color.red, textcolor=color.white)
plot(close)
`);
    const res = run(r, DATA);
    expect(res.viz!.drawings).toHaveLength(1);
    const d = res.viz!.drawings[0]!;
    expect(d.kind).toBe("label");
    expect(d.bar).toBe(3);
    expect(d.state.x).toBe(3);
    expect(d.state.y).toBe(105);
    expect(d.state.text).toBe("peak");
    expect(d.state.style).toBe("label_down");
    expect(d.state.color).toBe("#FF5252");
    expect(d.state.textcolor).toBe("#FFFFFF");
  });

  it("logs one record per creation with the right bar indices", () => {
    const r = ok(`//@version=5
indicator("d")
if close > open
    line.new(bar_index - 1, close, bar_index, close, width=2, color=color.blue)
plot(close)
`);
    const res = run(r, DATA);
    // close>open on bars 0, 2, 3
    expect(res.viz!.drawings.map((d) => d.bar)).toEqual([0, 2, 3]);
    expect(res.viz!.drawings[0]!.kind).toBe("line");
    expect(res.viz!.drawings[0]!.state.width).toBe(2);
    expect(res.viz!.drawings[0]!.state.color).toBe("#2196F3");
  });

  it("reflects post-creation set_* mutations, including promoted display setters", () => {
    const r = ok(`//@version=5
indicator("d")
var label lb = na
if barstate.isfirst
    lb := label.new(0, 100, "start")
if barstate.islast
    label.set_text(lb, "end")
    label.set_color(lb, color.green)
plot(close)
`);
    const res = run(r, DATA);
    expect(res.viz!.drawings).toHaveLength(1);
    expect(res.viz!.drawings[0]!.state.text).toBe("end");
    expect(res.viz!.drawings[0]!.state.color).toBe("#4CAF50");
  });

  it("captures box and table constructor details", () => {
    const r = ok(`//@version=5
indicator("d")
if barstate.islast
    box.new(0, high, 3, low, border_color=color.gray, bgcolor=color.new(color.blue, 85), text="zone")
    table.new(position.top_right, 2, 3)
plot(close)
`);
    const res = run(r, DATA);
    const [b, t] = res.viz!.drawings;
    expect(b!.kind).toBe("box");
    expect(b!.state.border_color).toBe("#787B86");
    expect(b!.state.text).toBe("zone");
    expect(typeof b!.state.bgcolor).toBe("string");
    expect(t!.kind).toBe("table");
    expect(t!.state.columns).toBe(2);
    expect(t!.state.rows).toBe(3);
  });

  it("keeps interleaved streaming contexts isolated", () => {
    const r = ok(`//@version=5
indicator("d")
line.new(bar_index, low, bar_index, high)
plot(close)
`);
    const a = Context.from(r, DATA);
    const b = Context.from(r, DATA);
    const fnA = compile(r.code)(a);
    const fnB = compile(r.code)(b);
    for (let i = 0; i < a.barCount; i++) {
      a.advance();
      fnA();
      b.advance();
      fnB();
    }
    expect(a.drawingLog).toHaveLength(4);
    expect(b.drawingLog).toHaveLength(4);
    expect(a.drawingLog.map((d) => d.bar)).toEqual([0, 1, 2, 3]);
    expect(b.drawingLog.map((d) => d.bar)).toEqual([0, 1, 2, 3]);
  });
});
