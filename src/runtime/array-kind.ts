// Which arrays hold Pine `int` elements.
//
// A Pine array is a plain JS array and JS numbers do not tell an int from a float, but
// TradingView prints them differently: `array.join(array.from(10, 20), ",")` is "10,20" and a
// logged `array<int>` is "[10, 20]", while an `array<float>` holds 10.0 and prints "10.0"
// (tier 1 array_008_array_na_index "get: NaN arr: 10,20,30,40", array_001_array_basic
// "ai: [1, 0, 0, 2, 0]" against "af: [1.0, 0.0, 0.0, 2.0, 0.0]", array_003_array_functions_float
// "array.join(a, ', '): 0.0, 1.1, 2.2, ..."). The kind belongs to the array, not to its values, so
// it is recorded on the array object. A WeakSet keeps the arrays plain (no extra property for
// equality checks or rollback to trip over) and lets a collected array take its mark with it.
//
// Only arrays proven int are marked: array.new_int / array.new<int>, array.from with every
// argument a static int (the analyzer's isStaticIntExpr, so literals and for counters), and the
// arrays derived from a marked one (copy, slice, abs, sort_indices). Anything unproven stays
// unmarked and keeps printing as float, which is what it did before.

const intArrays = new WeakSet<object>();

export function markIntArray<T extends object>(arr: T): T {
  intArrays.add(arr);
  return arr;
}

export function isIntArray(arr: unknown): boolean {
  return typeof arr === "object" && arr !== null && intArrays.has(arr);
}

// A derived array keeps the kind of its source.
export function inheritIntKind<T extends object>(source: unknown, derived: T): T {
  if (isIntArray(source)) intArrays.add(derived);
  return derived;
}
