// Pipeline orchestration: Lexer -> Parser -> (scope pass: renameShadowingDecls)
// -> Analyzer -> transform passes (hoisting) -> CodeGen. The five stages are
// fixed; this file is just the sequence.

import {
  analyze,
  SYMINFO_CALENDAR_KEYS,
  SYMINFO_IDENTITY_KEYS,
  SYMINFO_OPTION_KEYS,
  type AnalyzeOptions,
  type BarcolorMeta,
  type BgcolorMeta,
  type FillMeta,
  type HlineMeta,
  type PlotMeta,
  type PlotarrowMeta,
  type PlotcandleMeta,
  type PlotcharMeta,
  type PlotshapeMeta,
} from "./analyzer";
import type { CalendarSpec } from "../runtime/calendar";
import { generateCode } from "./codegen";
import type { Script } from "./ast";
import { hoist } from "./passes/hoisting";
import { BUILTIN_NAMESPACES, type LinkResult, describeLibraryLines, libraryLocation, linkLibraries } from "./passes/libraries";
import { renameShadowingDecls } from "./passes/shadowing";
import { ParseError, parse } from "./parser";
import { STRICT_REFUSED_TIERS, collectSurfaceWarnings, type TranspileWarning } from "./surface";
import { checkBuiltinCalls } from "./builtins/check";
import { checkTypes } from "./types/check";

export type { TranspileWarning } from "./surface";

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
  // The symbol each security slot reads when it is known at compile time, null for the chart's
  // own or one known only at run time (Context.from pairs the named ones with ContextOptions.security).
  securitySymbols: (string | null)[];
  calendar: CalendarSpec; // the chart symbol's exchange calendar with the chart timeframe
  refHistorySlotCount: number; // size of $.refHistSlots — history for '=' locals holding drawing handles
  condCallHistorySlotCount: number; // size of $.condCallHistSlots — call-count history for stateful calls inside a conditional
  condCallRefHistorySlotCount: number; // size of $.condCallRefHistSlots — the same, for drawing-constructor results
  isStrategy: boolean; // whether the script declares strategy() at top level
  // What compiled but is not faithful: stub and pass-through builtins, approximations, guesses,
  // ignored option keys, a version annotation below 5. Empty for a script that uses none. With
  // `strict: true` the stub and pass-through ones are errors instead (src/transpiler/surface.ts).
  warnings: TranspileWarning[];
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
    // viz S2b — fill() call sites; a/b reference viz.plots / viz.hlines by index.
    fills: FillMeta[];
    // viz S3 — marker family, source order. conditionSlot/seriesSlot/openSlot…
    // index the per-bar Context.vizSeries channels; colorSlot the shared color pool.
    shapes: PlotshapeMeta[];
    chars: PlotcharMeta[];
    arrows: PlotarrowMeta[];
    candles: PlotcandleMeta[];
    plotbars: PlotcandleMeta[];
  };
}

export interface TranspileErr {
  ok: false;
  errors: string[];
  // True when the failure is a bug in resin rather than a problem with the script (transpile()
  // never throws; an exception inside it comes back as this).
  internal?: true;
}

export type TranspileResult = TranspileOk | TranspileErr;

const DEFAULT_MAX_SOURCE_BYTES = 1_000_000;
const TRANSPILE_OPTION_KEYS: readonly string[] = ["chartTf", "syminfo", "strategy", "strict", "maxSourceBytes", "libraries"];
const SYMINFO_KEYS: readonly string[] = [...SYMINFO_OPTION_KEYS, ...SYMINFO_CALENDAR_KEYS, ...SYMINFO_IDENTITY_KEYS];

// Option keys resin does not read. A consumer may pass keys meant for another engine, so these warn
// rather than fail; a typo (`chartTF`) still shows up instead of silently falling back to a default.
function optionWarnings(options: AnalyzeOptions | undefined): TranspileWarning[] {
  const out: TranspileWarning[] = [];
  const ignored = (where: string, key: string): void => {
    out.push({ kind: "option", name: `${where}${key}`, line: 0, message: `option '${where}${key}' is not read by resin and was ignored [option]` });
  };
  if (options === undefined) return out;
  for (const key of Object.keys(options)) if (!TRANSPILE_OPTION_KEYS.includes(key)) ignored("", key);
  const syminfo = options.syminfo as Record<string, unknown> | undefined;
  if (syminfo !== undefined && syminfo !== null && typeof syminfo === "object") {
    for (const key of Object.keys(syminfo)) if (!SYMINFO_KEYS.includes(key)) ignored("syminfo.", key);
  }
  return out;
}

// Warnings from library code name the library, and warnings about libraries with no source are added:
// `import foo/bar/1 as ta` compiles, and `ta.sma` then reads resin's builtin rather than foo's.
function libraryWarnings(found: TranspileWarning[], link: LinkResult): TranspileWarning[] {
  const out = found.map((w) => {
    const at = libraryLocation(w.line, link.linked);
    return at === null ? w : { ...w, line: at.line, message: `library ${at.path}: ${w.message}` };
  });
  for (const m of link.missing) {
    if (!BUILTIN_NAMESPACES.has(m.alias)) continue;
    out.push({
      kind: "import",
      name: m.path,
      line: Math.max(m.line, 0),
      message: `library '${m.path}' has no source, so '${m.alias}.*' reads resin's builtins rather than that library; pass it in the libraries option to link it [import]`,
    });
  }
  return out;
}

// Without its source a library's names read as unknown calls. Say what is actually missing.
function missingLibraryErrors(errors: readonly string[], link: LinkResult): string[] {
  return link.missing
    .filter((m) => errors.some((e) => new RegExp(`(?<![\\w.])${m.alias}\\.`).test(e)))
    .map((m) => `library '${m.path}' (imported as ${m.alias}) has no source: pass it in the libraries option (resin run/check: --libs <dir>)`);
}

export function transpile(source: string, options?: AnalyzeOptions): TranspileResult {
  try {
    return transpileUnguarded(source, options);
  } catch (e) {
    // Every stage reports a problem with the script as an error value. What reaches here is resin's
    // own bug or a script too deep for the host's stack; a caller must not have to try/catch for it.
    const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, errors: [`internal error: ${what}`], internal: true };
  }
}

function transpileUnguarded(source: string, options?: AnalyzeOptions): TranspileResult {
  const limit = options?.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  if (source.length > limit) {
    return { ok: false, errors: [`source is ${source.length} characters, over the ${limit} limit (maxSourceBytes)`] };
  }

  let script: Script;
  try {
    script = parse(source);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, errors: [e.message] };
    throw e;
  }

  const link = linkLibraries(script, source, options?.libraries, limit);
  if (link.errors.length > 0) return { ok: false, errors: link.errors.map((e) => describeLibraryLines(e, link.linked)) };
  script = link.script;

  const warnings = [...optionWarnings(options), ...libraryWarnings(collectSurfaceWarnings(script), link)];
  if (script.version !== undefined && script.version !== 5 && script.version !== 6) {
    warnings.push({
      kind: "version",
      name: "//@version",
      line: 1,
      message: `'//@version=${script.version}' is not implemented: resin runs v5 and v6, and compiles this script as one of them [version]`,
    });
  }
  // A built-in call its signature does not allow: a keyword the function does not have, too many
  // arguments, a required one left out (builtins/check.ts). TradingView refuses these; resin still
  // runs the ones it has always run and says so, and `strict` refuses them.
  for (const f of checkBuiltinCalls(script)) {
    const at = libraryLocation(f.line, link.linked);
    warnings.push({ kind: "signature", name: f.name, line: at === null ? f.line : at.line, message: `${at === null ? "" : `library ${at.path}: `}${f.message} [signature]` });
  }
  // A type error visible without inference: a string literal where the language takes a number or
  // a bool, a declared type against its literal initializer (types/check.ts). Same standing as a
  // signature finding: TradingView refuses it, resin warns, `strict` refuses.
  for (const f of checkTypes(script)) {
    const at = libraryLocation(f.line, link.linked);
    warnings.push({ kind: "type", name: f.name, line: at === null ? f.line : at.line, message: `${at === null ? "" : `library ${at.path}: `}${f.message} [type]` });
  }
  if (options?.strict === true) {
    const refused = warnings.filter((w) => w.kind === "option" || w.kind === "version" || w.kind === "import" || w.kind === "signature" || w.kind === "type" || (STRICT_REFUSED_TIERS as readonly string[]).includes(w.kind));
    if (refused.length > 0) {
      return { ok: false, errors: refused.map((w) => (w.line > 0 ? `${w.message} (L${w.line}, strict)` : `${w.message} (strict)`)) };
    }
  }

  const analyzed = hoist(analyze(renameShadowingDecls(script), options));
  if (analyzed.errors.length > 0) {
    return { ok: false, errors: [...missingLibraryErrors(analyzed.errors, link), ...analyzed.errors.map((e) => describeLibraryLines(e, link.linked))] };
  }

  const code = generateCode(analyzed);
  // `ok: true` means the module loads. A generator bug that emits unparsable JavaScript would
  // otherwise surface later, in compile(), as a SyntaxError with no link to the script.
  try {
    new Function("$", "rt", code);
  } catch (e) {
    return { ok: false, errors: [`internal error: generated code does not parse (${e instanceof Error ? e.message : String(e)})`], internal: true };
  }
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
    securitySymbols: analyzed.securityTfs.map((_, slot) => analyzed.securitySymbols[slot] ?? null),
    calendar: { chartTf: analyzed.chartTf, ...analyzed.calendar },
    refHistorySlotCount: analyzed.refHistorySlotCount,
    condCallHistorySlotCount: analyzed.condCallHistorySlotCount,
    condCallRefHistorySlotCount: analyzed.condCallRefHistorySlotCount,
    isStrategy: analyzed.isStrategy,
    warnings,
    viz: {
      overlay: analyzed.overlay,
      plots: analyzed.plotMeta.map((m, i) => ({ title: analyzed.plotTitles[i]!, ...m })),
      bgcolors: analyzed.bgcolorMeta,
      barcolors: analyzed.barcolorMeta,
      hlines: analyzed.hlineMeta,
      fills: analyzed.fillMeta,
      shapes: analyzed.plotshapeMeta,
      chars: analyzed.plotcharMeta,
      arrows: analyzed.plotarrowMeta,
      candles: analyzed.plotcandleMeta,
      plotbars: analyzed.plotbarMeta,
    },
  };
}
