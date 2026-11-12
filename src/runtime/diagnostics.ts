// Run-time warnings: things that did not stop the run but that a caller needs to know to trust it.
//
// A transpile-time problem is a TranspileOk.warning. These are the ones that only show up when the
// data and options meet the script: bars that are not in the unit the chart timeframe says, an input
// override that matched no input, a security request for a symbol with no feed. They land in
// RunResult.warnings (and Context.diagnostics for a caller driving the loop itself), each message
// once however many bars repeat it.

export class Diagnostics {
  readonly messages: string[] = [];
  private readonly seen = new Set<string>();

  warn(key: string, message: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.messages.push(message);
  }
}

// Builtins are plain functions with no Context in reach, so Context.advance() points this at its own
// sink before every bar (see limits.ts, which does the same for the limits).
let active: Diagnostics | null = null;

export function setActiveDiagnostics(d: Diagnostics): void {
  active = d;
}

export function warnRuntime(key: string, message: string): void {
  active?.warn(key, message);
}
