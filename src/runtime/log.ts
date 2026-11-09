// log.info / log.warning / log.error / runtime.warning / runtime.error.
//
// The five are not uniform. log.info/warning/error produce no value and affect no
// computation; what they write goes to the caller's sink when one is given
// (ContextOptions.onLog, wired by engine.compile()) and nowhere otherwise, so the
// functions below are the no-sink default. runtime.warning is a genuine no-op. But
// runtime.error() is different — in TradingView it aborts the script fatally,
// and that is intended behaviour rather than an accident, so it throws here
// too. The bar loop has no try/catch of its own, so the throw propagates all
// the way out to run()'s caller and the whole execution is discarded, which is
// the same effect TradingView produces.
// One log.info / log.warning / log.error call as the caller's sink receives it
// (ContextOptions.onLog). `message` is the text TradingView's Pine Logs pane shows:
// str.format(formatString, ...args), so `log.info("{0} bars", bar_index)` is "12 bars" and a
// number of 1000 or more is grouped ("1,234.5"). `bar` is the zero-based bar index the call
// ran on, `time` that bar's open time in unix milliseconds (undefined without a time channel).
export interface LogEntry {
  level: "info" | "warning" | "error";
  message: string;
  bar: number;
  time: number | undefined;
}

export function logInfo(..._args: unknown[]): undefined {
  return undefined;
}

export function logWarning(..._args: unknown[]): undefined {
  return undefined;
}

export function logError(..._args: unknown[]): undefined {
  return undefined;
}

export function runtimeWarning(..._args: unknown[]): undefined {
  return undefined;
}

// A distinct class so callers can separate "the engine crashed" from "the
// script stopped itself", without matching on message prefixes. runtimeError()
// is the only thing that throws it; no other runtime path does.
export class PineRuntimeHaltError extends Error {}

export function runtimeError(message = ""): never {
  throw new PineRuntimeHaltError(`PineScript runtime error: ${message}`);
}
