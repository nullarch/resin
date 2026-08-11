// Pipeline orchestration: Lexer -> Parser -> Analyzer -> transform passes
// (hoisting) -> CodeGen. The five stages are fixed; this file is just the
// sequence.

import { analyze, type AnalyzeOptions, type BarcolorMeta, type BgcolorMeta, type HlineMeta, type PlotMeta } from "./analyzer";
import { generateCode } from "./codegen";
import { hoist } from "./passes/hoisting";
import { ParseError, parse } from "./parser";

export interface TranspileOk {
  ok: true;
  code: string;
  varSlots: string[];
  taSlotCount: number;
  fnVarSlotCount: number;
  historySlotCount: number;
  taScratchSize: number; // size of the shared scratch array for multi-return TA calls (0 if unused)
  plotTitles: string[]; // plot() call-site titles, in slot order
  securityTfs: string[]; // compile-time timeframe of each request.security() call site, in slot order
  refHistorySlotCount: number; // size of $.refHistSlots — history for '=' locals holding drawing handles
  condCallHistorySlotCount: number; // size of $.condCallHistSlots — call-count history for stateful calls inside a conditional
  condCallRefHistorySlotCount: number; // size of $.condCallRefHistSlots — the same, for drawing-constructor results
  isStrategy: boolean; // whether the script declares strategy() at top level
  // Visualization metadata (viz S0/S1). Grows slice by slice; consumers should treat
  // unknown future fields as additive.
  viz: {
    overlay: boolean; // indicator()/strategy() overlay= — true puts plots on the main chart pane
    // One entry per plot() call site, same order as plotTitles. `color` is the
    // compile-time color when statically known; `colorSlot` indexes the per-bar
    // Context.plotColors channel when the script computes the color at runtime.
    plots: Array<{ title: string } & PlotMeta>;
    // viz S2 — one entry per call site, in source order. bgcolor/barcolor share the
    // same runtime color channel pool as plots (colorSlot indexes Context.plotColors);
    // hline is compile-time metadata only.
    bgcolors: BgcolorMeta[];
    barcolors: BarcolorMeta[];
    hlines: HlineMeta[];
  };
}

export interface TranspileErr {
  ok: false;
  errors: string[];
}

export type TranspileResult = TranspileOk | TranspileErr;

export function transpile(source: string, options?: AnalyzeOptions): TranspileResult {
  let script;
  try {
    script = parse(source);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, errors: [e.message] };
    throw e;
  }

  const analyzed = hoist(analyze(script, options));
  if (analyzed.errors.length > 0) {
    return { ok: false, errors: analyzed.errors };
  }

  const code = generateCode(analyzed);
  return {
    ok: true,
    code,
    varSlots: analyzed.varSlots,
    taSlotCount: analyzed.taSlotCount,
    fnVarSlotCount: analyzed.fnVarSlotCount,
    historySlotCount: analyzed.historySlotCount,
    taScratchSize: analyzed.taScratchSize,
    plotTitles: analyzed.plotTitles,
    securityTfs: analyzed.securityTfs,
    refHistorySlotCount: analyzed.refHistorySlotCount,
    condCallHistorySlotCount: analyzed.condCallHistorySlotCount,
    condCallRefHistorySlotCount: analyzed.condCallRefHistorySlotCount,
    isStrategy: analyzed.isStrategy,
    viz: {
      overlay: analyzed.overlay,
      plots: analyzed.plotMeta.map((m, i) => ({ title: analyzed.plotTitles[i]!, ...m })),
      bgcolors: analyzed.bgcolorMeta,
      barcolors: analyzed.barcolorMeta,
      hlines: analyzed.hlineMeta,
    },
  };
}
