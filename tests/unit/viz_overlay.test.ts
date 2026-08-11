// viz S0 — overlay directive metadata + the TranspileOk object forms of run()/Context.
//
// overlay follows the C164 default_qty_value precedent: the directive statement stays
// a codegen no-op, but the analyzer lifts the literal onto TranspileOk (here under
// `viz`, the container later slices extend). The object forms exist so future viz
// channels never widen the positional signatures again (API.md "Rough edges").
import { describe, expect, it } from "vitest";
import { Context } from "../../src/runtime/context";
import { compile, run } from "../../src/runtime/engine";
import { transpile } from "../../src/transpiler/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import type { TranspileErr, TranspileOk } from "../../src/transpiler/pipeline";

const DATA: OHLCVData = {
  open: [1, 2, 3, 4],
  high: [2, 3, 4, 5],
  low: [0.5, 1.5, 2.5, 3.5],
  close: [1.5, 2.5, 3.5, 4.5],
  volume: [10, 20, 30, 40],
};

function ok(source: string): TranspileOk {
  const r = transpile(source);
  if (!r.ok) throw new Error((r as TranspileErr).errors.join("; "));
  return r;
}

describe("viz S0: overlay extraction", () => {
  it("defaults to false when the directive does not mention overlay", () => {
    expect(ok('//@version=5\nindicator("t")\nplot(close)').viz).toEqual({ overlay: false });
  });

  it("reads overlay=true as a keyword argument", () => {
    expect(ok('//@version=5\nindicator("t", overlay=true)\nplot(close)').viz.overlay).toBe(true);
  });

  it("reads overlay as the third positional argument", () => {
    expect(ok('//@version=5\nindicator("t", "s", true)\nplot(close)').viz.overlay).toBe(true);
  });

  it("reads overlay from strategy() too", () => {
    expect(ok('//@version=5\nstrategy("t", overlay=true)\nplot(close)').viz.overlay).toBe(true);
  });

  it("explicit overlay=false stays false", () => {
    expect(ok('//@version=5\nindicator("t", overlay=false)\nplot(close)').viz.overlay).toBe(false);
  });

  it("rejects a non-literal overlay instead of silently defaulting", () => {
    const r = transpile('//@version=5\nb = true\nindicator("t", overlay=b)\nplot(close)');
    expect(r.ok).toBe(false);
    expect((r as TranspileErr).errors.join(" ")).toContain("overlay");
  });
});

describe("viz S0: object forms match the positional forms", () => {
  const SOURCE = `//@version=5
indicator("obj-form", overlay=true)
acc = ta.cum(close)
plot(acc, "acc")
`;

  it("run(transpileOk, data) equals the 13-argument spelling", () => {
    const r = ok(SOURCE);
    const viaObject = run(r, DATA);
    const viaPositional = run(
      r.code, r.varSlots, r.taSlotCount, DATA, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, {}, r.plotTitles, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount,
    );
    expect(viaObject).toEqual(viaPositional);
  });

  it("Context.from(transpileOk, data) drives the same loop as the positional constructor", () => {
    const r = ok(SOURCE);
    const ctx = Context.from(r, DATA);
    const barFn = compile(r.code)(ctx);
    for (let i = 0; i < ctx.barCount; i++) {
      ctx.advance();
      barFn();
    }
    expect(ctx.plots[0]!.toArray()).toEqual(run(r, DATA).plots[0]!.values);
  });

  it("opts.inputs reaches input.* overrides through both forms", () => {
    const src = `//@version=5
indicator("inputs")
len = input.int(2, "Len")
plot(ta.sma(close, len), "s")
`;
    const r = ok(src);
    const viaObject = run(r, DATA, { inputs: { Len: 3 } });
    const viaPositional = run(
      r.code, r.varSlots, r.taSlotCount, DATA, r.fnVarSlotCount, r.historySlotCount,
      r.taScratchSize, { Len: 3 }, r.plotTitles, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount,
    );
    expect(viaObject).toEqual(viaPositional);
    expect(viaObject.plots[0]!.values).not.toEqual(run(r, DATA).plots[0]!.values);
  });
});
