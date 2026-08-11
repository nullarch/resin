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
import { setDrawingContext } from "./drawing";
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
  // viz S1/S2 — present only when run() was given the TranspileOk object form; the
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
      // The value series itself (same array as RunResult.plots[i].values), so viz is
      // self-contained — a `resin run --viz` dump alone can drive a renderer.
      values: number[];
    }>;
    bgcolors: Array<{
      title: string | null;
      offset: number;
      forceOverlay: boolean;
      color: string | null;
      colors: (string | null)[] | null;
    }>;
    barcolors: Array<{
      title: string | null;
      offset: number;
      color: string | null;
      colors: (string | null)[] | null;
    }>;
    hlines: Array<{
      title: string | null;
      price: number | null;
      color: string | null;
      linestyle: string;
      linewidth: number;
    }>;
    fills: Array<{
      a: { kind: "plot" | "hline"; index: number } | null;
      b: { kind: "plot" | "hline"; index: number } | null;
      title: string | null;
      color: string | null;
      colors: (string | null)[] | null;
    }>;
    // viz S3 — marker family. condition is per-bar show/hide; values/OHLC carry NaN for na.
    shapes: Array<{
      title: string | null;
      style: string;
      location: string;
      size: string;
      text: string | null;
      textcolor: string | null;
      offset: number;
      forceOverlay: boolean;
      color: string | null;
      colors: (string | null)[] | null;
      condition: boolean[];
    }>;
    chars: Array<{
      title: string | null;
      char: string;
      location: string;
      size: string;
      text: string | null;
      textcolor: string | null;
      offset: number;
      forceOverlay: boolean;
      color: string | null;
      colors: (string | null)[] | null;
      condition: boolean[];
    }>;
    arrows: Array<{
      title: string | null;
      colorup: string | null;
      colordown: string | null;
      minheight: number;
      maxheight: number;
      offset: number;
      forceOverlay: boolean;
      values: number[];
    }>;
    candles: Array<{
      title: string | null;
      color: string | null;
      colors: (string | null)[] | null;
      wickcolor: string | null;
      bordercolor: string | null;
      forceOverlay: boolean;
      open: number[];
      high: number[];
      low: number[];
      close: number[];
    }>;
    plotbars: Array<{
      title: string | null;
      color: string | null;
      colors: (string | null)[] | null;
      wickcolor: string | null;
      bordercolor: string | null;
      forceOverlay: boolean;
      open: number[];
      high: number[];
      low: number[];
      close: number[];
    }>;
    // viz S4 — runtime drawing creations (label/line/box/table), in creation order.
    // `bar` is the bar index the object was created on; `state` is its final state
    // after every set_* the script performed (coordinates, text, colors, styles).
    drawings: Array<{
      kind: string;
      id: number;
      bar: number;
      state: Record<string, number | string | null>;
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
    // viz S4 — route drawing creations to this context's log. Set before every bar,
    // not once, so interleaved streaming contexts never cross-contaminate.
    return () => {
      setDrawingContext(ctx);
      barFn();
    };
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
      plots: r.viz.plots.map((m, i) => ({
        title: m.title,
        style: m.style,
        linewidth: m.linewidth,
        offset: m.offset,
        histbase: m.histbase,
        trackprice: m.trackprice,
        forceOverlay: m.forceOverlay,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
        values: base.plots[i]!.values,
      })),
      bgcolors: r.viz.bgcolors.map((m) => ({
        title: m.title,
        offset: m.offset,
        forceOverlay: m.forceOverlay,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
      })),
      barcolors: r.viz.barcolors.map((m) => ({
        title: m.title,
        offset: m.offset,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
      })),
      hlines: r.viz.hlines.map((m) => ({ ...m })),
      fills: r.viz.fills.map((m) => ({
        a: m.a,
        b: m.b,
        title: m.title,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
      })),
      shapes: r.viz.shapes.map((m) => ({
        title: m.title, style: m.style, location: m.location, size: m.size,
        text: m.text, textcolor: m.textcolor, offset: m.offset, forceOverlay: m.forceOverlay,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
        condition: ctx.vizSeries[m.conditionSlot]!.map((v) => v === 1),
      })),
      chars: r.viz.chars.map((m) => ({
        title: m.title, char: m.char, location: m.location, size: m.size,
        text: m.text, textcolor: m.textcolor, offset: m.offset, forceOverlay: m.forceOverlay,
        color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
        condition: ctx.vizSeries[m.conditionSlot]!.map((v) => v === 1),
      })),
      arrows: r.viz.arrows.map((m) => ({
        title: m.title, colorup: m.colorup, colordown: m.colordown,
        minheight: m.minheight, maxheight: m.maxheight, offset: m.offset,
        forceOverlay: m.forceOverlay,
        values: ctx.vizSeries[m.seriesSlot]!,
      })),
      candles: r.viz.candles.map((m) => ({
        title: m.title, color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
        wickcolor: m.wickcolor, bordercolor: m.bordercolor, forceOverlay: m.forceOverlay,
        open: ctx.vizSeries[m.openSlot]!, high: ctx.vizSeries[m.highSlot]!,
        low: ctx.vizSeries[m.lowSlot]!, close: ctx.vizSeries[m.closeSlot]!,
      })),
      plotbars: r.viz.plotbars.map((m) => ({
        title: m.title, color: m.color,
        colors: m.colorSlot !== null ? ctx.plotColors[m.colorSlot]! : null,
        wickcolor: m.wickcolor, bordercolor: m.bordercolor, forceOverlay: m.forceOverlay,
        open: ctx.vizSeries[m.openSlot]!, high: ctx.vizSeries[m.highSlot]!,
        low: ctx.vizSeries[m.lowSlot]!, close: ctx.vizSeries[m.closeSlot]!,
      })),
      drawings: ctx.drawingLog.map((d) => ({ kind: d.kind, id: d.id, bar: d.bar, state: { ...d.state } })),
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
