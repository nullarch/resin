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
    return run(
      r.code, r.varSlots, r.taSlotCount, varSlotsOrData as OHLCVData,
      r.fnVarSlotCount, r.historySlotCount, r.taScratchSize, opts.inputs ?? {},
      r.plotTitles, r.securityTfs, r.refHistorySlotCount,
      r.condCallHistorySlotCount, r.condCallRefHistorySlotCount,
    );
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
