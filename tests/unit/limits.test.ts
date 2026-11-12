// Host limits (src/runtime/limits.ts): a script must not be able to hang the host, abort the process
// with an out-of-memory, or be cut short without saying so.
import { describe, expect, it } from "vitest";
import { ResinLimitError, run, transpile, type RunLimits } from "../../src/index";
import { PineRuntimeHaltError } from "../../src/runtime/log";
import { makeSyntheticOHLCV } from "../helpers/synthetic";

const data = (bars = 5) => makeSyntheticOHLCV(bars, 42);

function runScript(body: string, bars = 5, limits?: RunLimits) {
  const r = transpile(`//@version=6\nindicator("t")\n${body}\n`);
  if (!r.ok) throw new Error(r.errors.join("; "));
  return run(r, data(bars), limits === undefined ? undefined : { limits });
}

describe("loop budget", () => {
  it("stops three nested loops, which a per-loop cap multiplied into a hang", () => {
    const body = "s = 0.0\nfor i = 0 to 9999\n    for j = 0 to 9999\n        for k = 0 to 9999\n            s += 1\nplot(s)";
    const t0 = Date.now();
    expect(() => runScript(body, 3)).toThrow(ResinLimitError);
    expect(Date.now() - t0, "must stop in seconds, not run 1e12 iterations").toBeLessThan(20_000);
  });

  it("stops an endless while loop", () => {
    expect(() => runScript("n = 0\nwhile true\n    n += 1\nplot(n)", 2, { maxStepsPerBar: 50_000 })).toThrow(/loop iterations/);
  });

  it("stops a for-in that grows the array it walks", () => {
    const body = "a = array.from(1.0)\nfor x in a\n    array.push(a, x)\nplot(array.size(a))";
    expect(() => runScript(body, 2, { maxStepsPerBar: 10_000 })).toThrow(ResinLimitError);
  });

  it("no longer cuts a long loop short: 20,000 iterations sum to 20,000", () => {
    // The old per-loop cap stopped at 10,000 and returned a plausible-looking 10,000 with ok:true.
    const out = runScript("s = 0\nfor i = 1 to 20000\n    s += 1\nplot(s)", 3);
    expect(Array.from(out.plots[0]!.values)).toEqual([20000, 20000, 20000]);
  });

  it("refills the budget on every bar, so the limit is per bar and not per run", () => {
    const body = "s = 0\nfor i = 1 to 600\n    s += 1\nplot(s)";
    expect(() => runScript(body, 50, { maxStepsPerBar: 1_000 })).not.toThrow();
    expect(() => runScript(body, 2, { maxStepsPerBar: 500 })).toThrow(ResinLimitError);
  });

  it("is a ResinLimitError and not a PineRuntimeHaltError", () => {
    try {
      runScript("n = 0\nwhile true\n    n += 1\nplot(n)", 1, { maxStepsPerBar: 100 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ResinLimitError);
      expect(e).not.toBeInstanceOf(PineRuntimeHaltError);
      expect((e as ResinLimitError).limit).toBe("steps");
    }
  });
});

describe("allocation limits", () => {
  const cases: [string, string][] = [
    ["array.new_float", "a = array.new_float(2000000000, 0.0)\nplot(array.size(a))"],
    ["array.new<float>", "a = array.new<float>(2000000000)\nplot(array.size(a))"],
    ["array.new_int", "a = array.new_int(2000000000, 0)\nplot(array.size(a))"],
    ["matrix.new rows x columns", "m = matrix.new<float>(100000, 100000, 0.0)\nplot(matrix.rows(m))"],
    ["str.repeat", 'plot(str.length(str.repeat("ab", 2000000000)))'],
    ["ta.sma window", "plot(ta.sma(close, 2000000000))"],
  ];
  for (const [name, body] of cases) {
    it(`${name} asks for more than the limit: a typed error, not an out-of-memory abort`, () => {
      expect(() => runScript(body, 3)).toThrow(ResinLimitError);
    });
  }

  it("a size that is not a whole number is the same typed error, not a bare RangeError", () => {
    expect(() => runScript("plot(ta.sma(close, 2.5e9))", 2)).toThrow(ResinLimitError);
  });

  it("maxCollectionLength is configurable", () => {
    const body = "a = array.new_float(100, 0.0)\nplot(array.size(a))";
    expect(() => runScript(body, 2, { maxCollectionLength: 99 })).toThrow(/maxCollectionLength/);
    expect(Array.from(runScript(body, 2, { maxCollectionLength: 100 }).plots[0]!.values)).toEqual([100, 100]);
  });

  it("an na size still gives an na array, as before", () => {
    const out = runScript("a = array.new_float(na, 0.0)\nplot(array.size(a))", 2);
    expect(out.plots[0]!.values.length).toBe(2);
  });
});

describe("deadline and option checking", () => {
  it("stops at the next bar once the deadline has passed", () => {
    expect(() => runScript("plot(close)", 10, { deadlineMs: Date.now() - 1 })).toThrow(/deadline/);
    expect(() => runScript("plot(close)", 10, { deadlineMs: Date.now() + 60_000 })).not.toThrow();
  });

  it("rejects a limit that is not a usable number", () => {
    expect(() => runScript("plot(close)", 2, { maxStepsPerBar: 0 })).toThrow(TypeError);
    expect(() => runScript("plot(close)", 2, { maxCollectionLength: NaN })).toThrow(TypeError);
  });

  it("one run's limits do not leak into the next", () => {
    expect(() => runScript("a = array.new_float(100, 0.0)\nplot(1)", 2, { maxCollectionLength: 10 })).toThrow(ResinLimitError);
    expect(() => runScript("a = array.new_float(100, 0.0)\nplot(1)", 2)).not.toThrow();
  });
});
