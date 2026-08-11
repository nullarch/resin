// The bar execution engine.
//
// transpile() emits a two-layer module: a preamble, then `return function
// () {...}`. compile() runs the preamble exactly once per context and hands
// back the per-bar function, so user-defined functions and constants are not
// rebuilt on every bar.
//
// run() also collects a snapshot of every var slot per bar under the
// `var:<name>` channel, which is the format the differential oracle compares.

import { Context, type OHLCVData } from "./context";
import { rt } from "./rt";
// Type-only: erased at runtime, so no runtime cycle back into the transpiler.
import type { TranspileOk } from "../transpiler/pipeline";

export type BarSnapshot = Record<string, number>;

export interface PlotResult {
  title: string;
  values: number[];
}

export interface RunResult {
  bars: BarSnapshot[];
  finalVarState: BarSnapshot;
  plots: PlotResult[];
  // viz S1 — present only when run() was given the TranspileOk object form; the
  // positional spelling has no access to the metadata and leaves this undefined.
  viz?: {
    overlay: boolean;
    plots: Array<{
      title: string;
      style: string;
      linewidth: number;
      offset: number;
      histbase: number;
      trackprice: boolean;
      forceOverlay: boolean;
      color: string | null; // compile-time color, when statically known
      colors: (string | null)[] | null; // per-bar colors when computed at runtime, else null
    }>;
  };
}

// Compile module code into a factory: give it a context, get back the per-bar
// function. Call the factory once per context — only the returned function
// belongs in the bar loop.
export function compile(code: string): (ctx: Context) => () => void {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("$", "rt", code) as (ctx: Context, runtime: typeof rt) => () => void;
  return (ctx: Context) => {
    const barFn = factory(ctx, rt);
    if (typeof barFn !== "function") {
      throw new Error("compiled module did not return a per-bar function (not two-layer output)");
    }
    return barFn;
  };
}

// Object form (viz S0): everything run() needs is already on TranspileOk, so take it
// whole. The positional form below stays supported — this is an additive overload,
// not a replacement. New slot kinds land here once instead of at every call site.
export function run(result: TranspileOk, data: OHLCVData, opts?: { inputs?: Record<string, unknown> }): RunResult;
export function run(
  code: string,
  varSlots: string[],
  taSlotCount: number,
  data: OHLCVData,
  fnVarSlotCount?: number,
  historySlotCount?: number,
  taScratchSize?: number,
  inputs?: Record<string, unknown>,
  plotTitles?: string[],
  securityTfs?: string[],
  refHistorySlotCount?: number,
  condCallHistorySlotCount?: number,
  condCallRefHistorySlotCount?: number,
): RunResult;
export function run(
  codeOrResult: string | TranspileOk,
  varSlotsOrData?: string[] | OHLCVData,
  taSlotCountOrOpts?: number | { inputs?: Record<string, unknown> },
  positionalData?: OHLCVData,
  fnVarSlotCount: number = 0,
  historySlotCount: number = 0,
  taScratchSize: number = 0,
  inputs: Record<string, unknown> = {},
  plotTitles: string[] = [],
  securityTfs: string[] = [],
  refHistorySlotCount: number = 0,
  condCallHistorySlotCount: number = 0,
  condCallRefHistorySlotCount: number = 0,
): RunResult {
  if (typeof codeOrResult !== "string") {
    const r = codeOrResult;
    const opts = (taSlotCountOrOpts as { inputs?: Record<string, unknown> } | undefined) ?? {};
    const ctx = Context.from(r, varSlotsOrData as OHLCVData, opts);
    const base = collect(r.code, r.varSlots, r.plotTitles, ctx);
    // viz S1 — only the object form can assemble this: the metadata lives on
    // TranspileOk, which the positional spelling never sees.
    base.viz = {
      overlay: r.viz.overlay,
      plots: r.viz.plots.map((m) => ({
        title: m.title,
        style: m.style,
        linewidth: m.linewidth,
        offset: m.offset,
        histbase: m.histbase,
        trackprice: m.trackprice,
        forceOverlay: m.forceOverlay,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
      })),
    };
    return base;
  }
  const code = codeOrResult;
  const varSlots = varSlotsOrData as string[];
  const taSlotCount = taSlotCountOrOpts as number;
  const data = positionalData as OHLCVData;
  const ctx = new Context(
    data,
    varSlots.length,
    taSlotCount,
    fnVarSlotCount,
    historySlotCount,
    taScratchSize,
    inputs,
    plotTitles.length,
    securityTfs,
    refHistorySlotCount,
    condCallHistorySlotCount,
    condCallRefHistorySlotCount,
  );
  return collect(code, varSlots, plotTitles, ctx);
}

// The shared bar loop both run() spellings drive: execute every bar, snapshot the
// var slots per bar (the differential oracle's comparison format), collect plots.
function collect(code: string, varSlots: string[], plotTitles: string[], ctx: Context): RunResult {
  const barFn = compile(code)(ctx);
  const bars: BarSnapshot[] = [];

  for (let i = 0; i < ctx.barCount; i++) {
    ctx.advance();
    barFn();
    const snap: BarSnapshot = {};
    for (let s = 0; s < varSlots.length; s++) {
      snap[`var:${varSlots[s]}`] = ctx.vars[s] as number;
    }
    bars.push(snap);
  }

  const finalVarState: BarSnapshot = {};
  for (let s = 0; s < varSlots.length; s++) {
    finalVarState[varSlots[s]!] = ctx.vars[s] as number;
  }

  const plots: PlotResult[] = plotTitles.map((title, i) => ({ title, values: ctx.plots[i]!.toArray() }));

  return { bars, finalVarState, plots };
}
