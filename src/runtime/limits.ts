// Host limits: what stops a script from taking the process with it.
//
// Pine is a language for charts, and a script is untrusted input as soon as a service runs scripts
// it did not write. Three things can take a host down without a bug in the script's logic being
// visible anywhere: a loop that does not end, a size argument that asks for a billion elements, and
// a run that simply takes too long. Each is a typed ResinLimitError here, not a hang, an abort of
// the process (a V8 out-of-memory is not catchable) or a bare RangeError.
//
// What the limits do not do: they bound one allocation and one bar's loop steps, not the sum. A
// script that allocates many arrays just under maxCollectionLength can still exhaust memory, and a
// run of many bars each just under maxStepsPerBar can still take minutes. A host that needs a hard
// bound runs the engine in a worker it can terminate; deadlineMs only lets the engine stop itself
// at a bar boundary.

export type LimitKind = "steps" | "size" | "deadline";

// Not a PineRuntimeHaltError: that class means "the script stopped itself on purpose" (runtime.error()),
// and a host uses it to tell that apart from the engine failing. A script that hits a limit did not
// choose to stop.
export class ResinLimitError extends Error {
  readonly limit: LimitKind;
  constructor(limit: LimitKind, message: string) {
    super(message);
    this.name = "ResinLimitError";
    this.limit = limit;
  }
}

export interface RunLimits {
  // Loop iterations (for, while, and their value-position forms) one bar may take in total, across
  // every loop and nesting level. TradingView stops a script that takes too long on a bar (500 ms);
  // this is the engine's step-count version of that rule. Default 10,000,000.
  maxStepsPerBar?: number;
  // The most elements one allocation may ask for: array.new_*, array.from, matrix.new (rows x
  // columns), str.repeat, and the window of a ta.* function. Default 10,000,000.
  maxCollectionLength?: number;
  // An absolute time (Date.now() scale, in ms) after which the run stops at the next bar boundary.
  // Default none.
  deadlineMs?: number;
}

export interface ResolvedLimits {
  maxStepsPerBar: number;
  maxCollectionLength: number;
  deadlineMs: number | undefined;
}

export const DEFAULT_RUN_LIMITS: Readonly<ResolvedLimits> = {
  maxStepsPerBar: 10_000_000,
  maxCollectionLength: 10_000_000,
  deadlineMs: undefined,
};

export const RUN_LIMIT_KEYS: readonly (keyof RunLimits)[] = ["maxStepsPerBar", "maxCollectionLength", "deadlineMs"];

export function resolveLimits(given: RunLimits | undefined): ResolvedLimits {
  const out: ResolvedLimits = { ...DEFAULT_RUN_LIMITS };
  if (given === undefined) return out;
  for (const key of ["maxStepsPerBar", "maxCollectionLength"] as const) {
    const v = given[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !(v >= 1)) throw new TypeError(`limits.${key} must be a number >= 1, got ${String(v)}`);
    out[key] = v;
  }
  if (given.deadlineMs !== undefined) {
    if (typeof given.deadlineMs !== "number" || Number.isNaN(given.deadlineMs)) {
      throw new TypeError(`limits.deadlineMs must be a number, got ${String(given.deadlineMs)}`);
    }
    out.deadlineMs = given.deadlineMs;
  }
  return out;
}

// The limits of the Context that is running. Allocation sites are plain functions with no Context
// in reach, so Context.advance() points this at its own limits before every bar; a run is
// synchronous, so contexts interleaved by a caller each reassert theirs.
let active: ResolvedLimits = DEFAULT_RUN_LIMITS;

export function setActiveLimits(limits: ResolvedLimits): void {
  active = limits;
}

// Validates a size a script asked for. A size that is not a whole non-negative number (NaN,
// negative, fractional) used to surface as a bare RangeError from `new Array(n)`.
export function checkedLength(n: number, what: string): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new ResinLimitError("size", `${what}: ${String(n)} is not a valid size`);
  }
  if (n > active.maxCollectionLength) {
    throw new ResinLimitError("size", `${what}: ${n} elements is over the limit of ${active.maxCollectionLength} (maxCollectionLength)`);
  }
  return n;
}

export function allocArray<T = number>(n: number, what: string): T[] {
  return new Array<T>(checkedLength(n, what));
}

export function allocFloat64(n: number, what: string): Float64Array {
  return new Float64Array(checkedLength(n, what));
}

// Called by generated code when a bar's loop budget runs out.
export function stepsExceeded(barIndex: number): never {
  throw new ResinLimitError(
    "steps",
    `a bar ran more than ${active.maxStepsPerBar} loop iterations (bar ${barIndex}); raise limits.maxStepsPerBar if the script is meant to`,
  );
}

export function checkDeadline(limits: ResolvedLimits, barIndex: number): void {
  if (limits.deadlineMs !== undefined && Date.now() > limits.deadlineMs) {
    throw new ResinLimitError("deadline", `the run passed its deadline at bar ${barIndex} (limits.deadlineMs)`);
  }
}
