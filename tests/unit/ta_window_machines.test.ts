// The two window machines TradingView runs for ta.highest / ta.lowest / ta.highestbars / ta.lowestbars /
// ta.linreg, told apart by the length's qualifier (PyneCore lib/ta.py, MEASURED LAW on BINANCE:BTCUSDT
// 30m over 30657 bars; tier 1 evidence: TradingView's exports of ta_375_linreg_windows and
// ta_376_window_extreme_machines, resin-bench h2h):
//   - a length known before the first bar (literal, input, simple): a ring of `length + 1` slots
//     addressed by the chart bar, written only on the bars the call runs, a never-written slot holding 0;
//   - a `series` length: one slot per chart bar, a bar that skips the call forward-fills the last call's
//     value, the whole history stays readable.
import { describe, expect, it } from "vitest";
import { run } from "../../src/runtime/engine";
import { transpile } from "../../src/transpiler/pipeline";
import { highestVarLen, lowestVarLen, highestbarsVarLen, lowestbarsVarLen, linregVarLen } from "../../src/runtime/ta";

function pipeline(source: string, bars: number): Record<string, number[]> {
  const r = transpile(source);
  if (!r.ok) throw new Error(r.errors.join("; "));
  const low = Array.from({ length: bars }, (_, i) => 100 + i);
  const data = { open: low, high: low.map((v) => v + 5), low, close: low, volume: low.map(() => 1) };
  const out: Record<string, number[]> = {};
  for (const p of run(r, data).plots) out[p.title] = p.values;
  return out;
}

describe("fixed-length ring: a slot no call has written holds 0", () => {
  it("ta.lowest(low, 6) called on bars 0-4 and again from bar 37 sees the 0 of the never-written slots", () => {
    const plots = pipeline(
      [
        "//@version=6",
        'indicator("gap")',
        "float v = na",
        "if bar_index % 37 < 5",
        "    v := ta.lowest(low, 6)",
        'plot(v, "v")',
      ].join("\n"),
      45,
    );
    const v = plots["v"]!;
    // bars 0-4: warm-up (bar_index < 5); bar 37: the window of bars 32..37 reaches slots 33 and 34
    // (mod 7), which no call has written: 0, TradingView's value, where na slots would be skipped
    expect(Number.isNaN(v[4]!)).toBe(true);
    expect(v[37]).toBe(0);
    expect(v[38]).toBe(0);
    expect(v[39]).toBe(0); // until the unwritten slots (33, 34 mod 7) age out of the window of 6
  });
});

describe("series-length machines read one slot per chart bar and forward-fill skipped bars", () => {
  // A brute-force model: history[k] is the value of the last call at or before bar k, the window of a
  // call on bar b is bars b - L + 1 .. b, a window that reaches before the first call is na.
  function model(calls: { bar: number; value: number; length: number }[], bar: number, kind: "high" | "low" | "hbars" | "lbars" | "linreg"): number {
    const call = calls.find((c) => c.bar === bar)!;
    const first = calls[0]!.bar;
    const at = (k: number): number => calls.filter((c) => c.bar <= k).at(-1)!.value;
    const oldest = bar - call.length + 1;
    if (kind === "linreg") {
      if (oldest < first) return NaN;
      const ys = Array.from({ length: call.length }, (_, i) => at(oldest + i));
      const n = ys.length;
      const mx = (n - 1) / 2;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      ys.forEach((y, i) => {
        sxy += (i - mx) * (y - my);
        sxx += (i - mx) * (i - mx);
      });
      return my + (sxy / sxx) * (n - 1 - mx);
    }
    if (bar < call.length - 1) return NaN;
    const from = Math.max(oldest, first);
    let best = at(bar);
    let bestBar = bar;
    for (let k = bar - 1; k >= from; k--) {
      const y = at(k);
      const better = kind === "high" || kind === "hbars" ? y >= best : y <= best; // ties go to the oldest bar
      if (better) {
        best = y;
        bestBar = k;
      }
    }
    return kind === "hbars" || kind === "lbars" ? bestBar - bar : best;
  }

  it("matches the model on a gated call with a length that changes (highest, lowest, highestbars, lowestbars, linreg)", () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const calls: { bar: number; value: number; length: number }[] = [];
    for (let bar = 0; bar < 300; bar++) {
      if (bar % 3 !== 1 && bar > 2) calls.push({ bar, value: Math.round(rand() * 1000) / 10, length: 3 + Math.floor(rand() * 10) });
    }
    const states = { high: {}, low: {}, hbars: {}, lbars: {}, linreg: {} };
    for (const c of calls) {
      const got = {
        high: highestVarLen(states.high, c.value, c.length, 300, c.bar),
        low: lowestVarLen(states.low, c.value, c.length, 300, c.bar),
        hbars: highestbarsVarLen(states.hbars, c.value, c.length, 300, c.bar),
        lbars: lowestbarsVarLen(states.lbars, c.value, c.length, 300, c.bar),
        linreg: linregVarLen(states.linreg, c.value, c.length, 0, 300, c.bar),
      };
      for (const kind of ["high", "low", "hbars", "lbars", "linreg"] as const) {
        const want = model(calls.filter((x) => x.bar <= c.bar), c.bar, kind);
        if (Number.isNaN(want)) expect(got[kind], `${kind} bar ${c.bar}`).toBeNaN();
        else expect(got[kind], `${kind} bar ${c.bar}`).toBeCloseTo(want, 9);
      }
    }
  });

  it("the qualifier is the switch, not the value: a series length that is always 8 still forward-fills", () => {
    // Skipping bars 1 and 2, bar 3's window of 8 reads bars -4..3: bars 1 and 2 carry bar 0's 50.
    const state = {};
    lowestVarLen(state, 50, 2, 10, 0);
    expect(lowestVarLen(state, 70, 2, 10, 3)).toBe(50); // bars 2..3 = [50 (filled), 70]
    expect(lowestbarsVarLen({}, 70, 1, 10, 3)).toBe(0);
  });
});
