// log.info / log.warning / log.error / runtime.warning / runtime.error.
//
// The five are not uniform. The four below are genuine no-ops: they produce no
// value and affect no computation, so there is nothing to implement. But
// runtime.error() is different — in TradingView it aborts the script fatally,
// and that is intended behaviour rather than an accident, so it throws here
// too. The bar loop has no try/catch of its own, so the throw propagates all
// the way out to run()'s caller and the whole execution is discarded, which is
// the same effect TradingView produces.
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
