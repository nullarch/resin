// The public API surface.
//
// What this file re-exports is supported; everything else under src/ is
// internal and can change without notice — the runtime helpers (ta, numeric,
// str, drawing, color, …) and the transpiler stages (lexer, parser internals,
// analyzer, codegen). Unit tests import those symbols directly, but that is
// white-box testing, not a contract.
//
// API.md documents each entry. tests/unit/public_api_surface.test.ts keeps
// this file, that document, and the shipped CLI consistent — change one alone
// and it goes red.

export const VERSION = "0.1.0";

// --- Transpile: Pine source -> JavaScript module code ---
export { transpile } from "./transpiler/pipeline";
export type { TranspileErr, TranspileOk, TranspileResult } from "./transpiler/pipeline";
export type { AnalyzeOptions } from "./transpiler/analyzer";

// parse() is the lower entry point, useful for telling a parse failure apart
// from an analysis failure. ParseError is part of the contract because parse()
// throws it across the boundary; transpile() catches it and returns a
// TranspileErr instead.
export { ParseError, parse } from "./transpiler/parser";

// --- Execute: module code -> one call per bar ---
// run() does the whole thing in one call.
// compile() + new Context() hands the bar loop to the caller, for when you need
// to observe state as it goes. Both are supported.
export { compile, run } from "./runtime/engine";
export type { BarSnapshot, PlotResult, RunResult } from "./runtime/engine";
export { Context } from "./runtime/context";
export type { OHLCVData } from "./runtime/context";

// The runtime namespace generated code receives as the second argument of
// `new Function("$", "rt", code)`. compile() wires it up for you; this export
// is only needed if you build the factory by hand.
export { rt } from "./runtime/rt";

// Thrown when a script halts itself with runtime.error(). Public because a
// caller has to tell "the engine broke" apart from "the script stopped on
// purpose".
export { PineRuntimeHaltError } from "./runtime/log";

// Type-only: Context constructs these, a caller never does. They exist so
// reads like ctx.close.get(0) and ctx.strategy.posSize type-check.
export type { Series } from "./runtime/series";
export type { StrategyState } from "./runtime/strategy";
