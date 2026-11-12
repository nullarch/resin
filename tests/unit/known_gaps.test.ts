// The known-gaps ledger (known-gaps.json): what resin is known to get wrong, approximate or refuse,
// with a repro for each.
//
//  - "it.fails" repros assert the CORRECT behaviour and are expected to fail today. When a gap is
//    closed its repro starts passing, vitest reports the `it.fails` test as failed, and the entry has
//    to be removed from the ledger in the same change — so a fix cannot leave a stale gap behind, and
//    a gap cannot be fixed without anyone noticing.
//  - "warned" repros assert transpile() reports the gap (TranspileOk.warnings).
//  - "pinned" repros assert today's loud refusal.
//  - Every ledger entry names the documents that mention it, and the phrase is checked to be there,
//    so the docs cannot claim a gap that was removed.
//  - The number of "hypothesis" marker lines in src/ may only go down. A new unverified semantic must
//    either be verified or arrive with a ledger entry (and the count raised in the same change).
//
// The expectations come from arithmetic, the repo's own documentation or the Pine reference's
// definitions, not from a TradingView run (tvVerified is false throughout).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run, transpile, type AnalyzeOptions } from "../../src/index";
import type { ContextOptions } from "../../src/runtime/context";
import { makeSyntheticOHLCV, type SyntheticOHLCV } from "../helpers/synthetic";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ledger = JSON.parse(readFileSync(join(ROOT, "known-gaps.json"), "utf-8")) as {
  hypothesisMarkerLines: number;
  gaps: { id: string; kind: string; documented: Record<string, string>; repro: "it.fails" | "warned" | "pinned" | "negative" | "external"; category?: string; count?: number; where?: string; marker?: string }[];
};

function exec(body: string, data: SyntheticOHLCV = makeSyntheticOHLCV(60, 1234), opts: ContextOptions = {}, tp: AnalyzeOptions = { chartTf: "60" }) {
  const r = transpile(`//@version=6\nindicator("t")\n${body}\n`, tp);
  if (!r.ok) throw new Error(`transpile: ${r.errors[0]}`);
  return run(r, data, opts);
}
const series = (r: ReturnType<typeof exec>, i = 0): number[] => Array.from(r.plots[i]!.values);
const scaled = (d: SyntheticOHLCV, k: number): SyntheticOHLCV => ({
  ...d,
  open: d.open.map((v) => v * k),
  high: d.high.map((v) => v * k),
  low: d.low.map((v) => v * k),
  close: d.close.map((v) => v * k),
});
const warningKinds = (body: string, tp?: AnalyzeOptions): string[] => {
  const r = transpile(`//@version=6\n${body}\n`, tp);
  if (!r.ok) throw new Error(`transpile: ${r.errors[0]}`);
  return r.warnings.map((w) => `${w.kind}:${w.name}`);
};

// For `it.fails` entries: each function asserts the correct behaviour (and so throws today).
const CORRECT: Record<string, () => void> = {
  "KG-SEC-HTF-LAG": () => {
    const bars = makeSyntheticOHLCV(120, 9);
    const src = 'x = request.security("TEST:SYM", "D", close)\nplot(x, "x")';
    const own = series(exec(src, bars));
    const fed = series(exec(src, bars, { security: { "TEST:SYM": { ...bars, timeframe: "60" } } }));
    expect(own).toEqual(fed);
  },
  "KG-TZ-HOUR": () => {
    const d = makeSyntheticOHLCV(6, 3);
    const got = series(exec("plot(hour)", d, {}, { chartTf: "60", syminfo: { timezone: "Asia/Seoul" } }));
    expect(got).toEqual(d.time.map((t) => (new Date(t).getUTCHours() + 9) % 24));
  },
  "KG-TZ-UNKNOWN": () => {
    let refused = false;
    try {
      exec('plot(hour(time, "Mars/Phobos"))', makeSyntheticOHLCV(4, 1));
    } catch {
      refused = true;
    }
    expect(refused, "an unknown timezone must be refused, not read as UTC").toBe(true);
  },
  "KG-TF-GARBAGE": () => {
    let refused = false;
    try {
      exec('x = request.security(syminfo.tickerid, "garbage", close)\nplot(x)', makeSyntheticOHLCV(10, 1));
    } catch {
      refused = true;
    }
    expect(refused, "an unparsable timeframe literal must be refused, not read as daily").toBe(true);
  },
  "KG-TIME-CLOSE-GAP": () => {
    const d = makeSyntheticOHLCV(12, 3);
    d.time = d.time.map((t, i) => (i >= 6 ? t + 10 * 3_600_000 : t));
    expect(series(exec("plot((time_close - time) / 3600000)", d))).toEqual(new Array(12).fill(1));
  },
  "KG-EIGEN-N3": () => {
    const src = [
      "m = matrix.new<float>(3, 3, 0.0)",
      "m.set(0, 0, 2.0)", "m.set(0, 1, 1.0)", "m.set(1, 0, 1.0)", "m.set(1, 1, 3.0)",
      "m.set(1, 2, 1.0)", "m.set(2, 1, 1.0)", "m.set(2, 2, 4.0)",
      "ev = matrix.eigenvalues(m)",
      "plot(array.get(ev, 0))", "plot(array.get(ev, 1))", "plot(array.get(ev, 2))",
    ].join("\n");
    const r = exec(src, makeSyntheticOHLCV(2, 1));
    const got = [0, 1, 2].map((i) => series(r, i).at(-1)!).sort((a, b) => a - b);
    const want = [3 - Math.sqrt(3), 3, 3 + Math.sqrt(3)];
    got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 9));
  },
  "KG-CORR-SCALE": () => {
    const base = makeSyntheticOHLCV(60, 1234);
    const src = "plot(ta.correlation(close, open, 14))";
    const a = series(exec(src, base)).slice(30, 36);
    const b = series(exec(src, scaled(base, 1e-6))).slice(30, 36);
    b.forEach((v, i) => expect(v).toBeCloseTo(a[i]!, 9));
  },
  "KG-BBW-X100": () => {
    const r = exec("[mid, up, lo] = ta.bb(close, 20, 2)\nplot(ta.bbw(close, 20, 2), 'bbw')\nplot((up - lo) / mid, 'ratio')", makeSyntheticOHLCV(40, 7));
    expect(series(r, 0).at(-1)!).toBeCloseTo(series(r, 1).at(-1)!, 12);
  },
  "KG-DRAWING-ID": () => {
    const r = transpile('//@version=6\nindicator("t")\nif bar_index % 20 == 0\n    label.new(bar_index, high, "x")\nplot(close)\n', { chartTf: "60" });
    if (!r.ok) throw new Error(r.errors[0]);
    const d = makeSyntheticOHLCV(60, 1);
    expect(JSON.stringify(run(r, d).viz)).toBe(JSON.stringify(run(r, d).viz));
  },
  "KG-BAD-TIME": () => {
    const d = makeSyntheticOHLCV(10, 1);
    d.time[4] = NaN;
    let threw: unknown;
    let warnings = "";
    try {
      warnings = exec('plot(timeframe.change("D") ? 1 : 0)', d).warnings.join("\n");
    } catch (e) {
      threw = e;
    }
    expect(threw, "a bad bar time must not reach the host as a raw error").toBeUndefined();
    expect(warnings).toMatch(/not strictly increasing/);
  },
  "KG-NAN-FILL": () => {
    const d = makeSyntheticOHLCV(10, 1);
    d.open[4] = NaN;
    const t = transpile('//@version=6\nstrategy("s", commission_type=strategy.commission.percent, commission_value=0.1)\nif bar_index == 3\n    strategy.entry("L", strategy.long)\nplot(close)\n', { chartTf: "60" });
    if (!t.ok) throw new Error(t.errors[0]);
    let threw: unknown;
    try {
      run(t, d);
    } catch (e) {
      threw = e;
    }
    expect(threw, "a NaN open on the fill bar must not stop the run").toBeUndefined();
  },
  "KG-DRAWING-ALL": () => {
    const r = exec("l1 = line.new(0, 0, 1, 1)\nl2 = line.new(0, 1, 1, 2)\nplot(array.size(line.all))", makeSyntheticOHLCV(3, 1));
    expect(series(r).at(-1)).toBe(2);
  },
};

const WARNED: Record<string, () => void> = {
  "KG-SEC-NOFEED": () => {
    const r = exec('x = request.security("NYSE:SPY", "60", close)\nplot(x)', makeSyntheticOHLCV(20, 1));
    expect(r.warnings.join("\n")).toMatch(/NYSE:SPY.*no feed/);
  },
  "KG-STUB-DATA": () => {
    for (const call of ["request.dividends(syminfo.tickerid)", "request.splits(syminfo.tickerid)", 'request.quandl("X")', 'request.seed("a", "b", close)']) {
      expect(warningKinds(`indicator("t")\nv = ${call}\nplot(v)`)).toContain(`stub:${call.slice(0, call.indexOf("("))}`);
    }
  },
  "KG-TICKER-PASSTHROUGH": () => {
    expect(warningKinds('indicator("t")\nt = ticker.heikinashi(syminfo.tickerid)\nplot(close)')).toContain("passthrough:ticker.heikinashi");
  },
  "KG-LOWER-TF": () => {
    expect(warningKinds('indicator("t")\nv = array.size(request.security_lower_tf(syminfo.tickerid, "1", close))\nplot(v)')).toContain("stub:request.security_lower_tf");
  },
  "KG-RISK": () => {
    expect(warningKinds('strategy("t")\nstrategy.risk.max_drawdown(10, strategy.percent_of_equity)\nplot(close)')).toContain("hypothesis:strategy.risk.max_drawdown");
  },
  "KG-STRATEGY-PARAMS": () => {
    expect(warningKinds('strategy("t", close_entries_rule="ANY", backtest_fill_limits_assumption=2)\nplot(close)').sort()).toEqual([
      "stub:strategy(backtest_fill_limits_assumption=)",
      "stub:strategy(close_entries_rule=)",
    ]);
    // The values resin implements change nothing and are not reported.
    expect(warningKinds('strategy("t", close_entries_rule="FIFO", backtest_fill_limits_assumption=0)\nplot(close)')).toEqual([]);
    expect(transpile('//@version=6\nstrategy("t", close_entries_rule="ANY")\nplot(close)\n', { strict: true }).ok).toBe(false);
  },
};

const PINNED: Record<string, () => void> = {
  "KG-RAW-RANGEERROR": () => {
    let caught: unknown;
    try {
      exec('plot(str.length(str.format_time(9007199254740993, "yyyy", "UTC")))', makeSyntheticOHLCV(2, 1));
    } catch (e) {
      caught = e;
    }
    expect(caught, "extreme values still reach the host as a raw RangeError").toBeInstanceOf(RangeError);
  },
  "KG-SERIES-LENGTH": () => {
    for (const fn of ["ema", "rsi", "rma", "atr"]) {
      const call = fn === "atr" ? "ta.atr(l)" : `ta.${fn}(close, l)`;
      const r = transpile(`//@version=6\nindicator("t")\nl = bar_index % 5 + 2\nplot(${call})\n`);
      expect(r.ok, `${call} with a series length is refused today`).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/cannot be 'series'/);
    }
  },
};

// "negative": the entry stands for a family of scripts in tests/negative/false_accepts.json (invalid
// Pine that compiles), each pinned there by its own `it.fails`. The ledger records how many there are
// per category; the count may only go down, and when it does the entry's `count` must follow.
const NEGATIVE: Record<string, () => void> = {};
const REPROS = { "it.fails": CORRECT, warned: WARNED, pinned: PINNED, negative: NEGATIVE, external: NEGATIVE } as const;

describe("known-gaps ledger", () => {
  it("every entry has a repro of the declared kind, and every repro has an entry", () => {
    for (const g of ledger.gaps.filter((x) => x.repro !== "negative" && x.repro !== "external")) {
      expect(REPROS[g.repro][g.id], `${g.id} has no ${g.repro} repro in this file`).toBeTypeOf("function");
    }
    const ids = new Set(ledger.gaps.map((g) => g.id));
    expect(ids.size, "duplicate ids").toBe(ledger.gaps.length);
    for (const [kind, table] of Object.entries(REPROS)) {
      for (const id of Object.keys(table)) {
        expect(ledger.gaps.find((g) => g.id === id)?.repro, `${id} has a ${kind} repro here but no matching ledger entry`).toBe(kind);
      }
    }
  });

  it("the documents an entry says mention it still do", () => {
    for (const g of ledger.gaps) {
      for (const [file, phrase] of Object.entries(g.documented)) {
        expect(readFileSync(join(ROOT, file), "utf-8").replace(/\s+/g, " "), `${g.id}: ${file} no longer contains "${phrase}"`).toContain(phrase);
      }
    }
  });

  it("the count of 'hypothesis' marker lines in src/ only goes down", () => {
    let count = 0;
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".ts")) count += readFileSync(p, "utf-8").split("\n").filter((l) => /TV 미검증|가설|hypothes/i.test(l)).length;
      }
    };
    walk(join(ROOT, "src"));
    expect(
      count,
      count > ledger.hypothesisMarkerLines
        ? `${count - ledger.hypothesisMarkerLines} new line(s) mark an unverified semantic: verify it, or add a known-gaps.json entry and raise hypothesisMarkerLines`
        : `the count fell to ${count}: lower hypothesisMarkerLines in known-gaps.json to lock it in`,
    ).toBe(ledger.hypothesisMarkerLines);
  });
});

describe("known gaps: pinned by another suite", () => {
  for (const g of ledger.gaps.filter((x) => x.repro === "external")) {
    it(`${g.id} is still pinned in ${g.where}`, () => {
      expect(readFileSync(join(ROOT, g.where!), "utf-8"), `${g.where} no longer mentions ${g.marker}`).toContain(g.marker!);
    });
  }
});

describe("known gaps: invalid Pine that compiles (tests/negative/false_accepts.json)", () => {
  const accepts = JSON.parse(readFileSync(join(ROOT, "tests", "negative", "false_accepts.json"), "utf-8")) as { id: string; category: string }[];
  const entries = ledger.gaps.filter((x) => x.repro === "negative");
  it("the ledger covers every category of false accept, with the right count", () => {
    const byCategory: Record<string, number> = {};
    for (const a of accepts) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
    const declared = Object.fromEntries(entries.map((g) => [g.category!, g.count!]));
    expect(declared, "a false-accept category has no ledger entry, or its count is stale; fewer is progress, so lower the count").toEqual(byCategory);
  });
});

describe("known gaps: expected to fail today (the repro asserts the correct behaviour)", () => {
  for (const g of ledger.gaps.filter((x) => x.repro === "it.fails")) {
    // `it.fails` passes when the body throws, whatever the reason. Only a failed ASSERTION about the
    // behaviour counts: a transpile error or a typo in the repro returns normally here, so the
    // `it.fails` reports it instead of letting the entry pass for the wrong reason.
    it.fails(`${g.id}`, () => {
      try {
        CORRECT[g.id]!();
      } catch (e) {
        if ((e as Error).name !== "AssertionError") return;
        throw e;
      }
    });
  }
});

describe("known gaps: reported by transpile()/run()", () => {
  for (const g of ledger.gaps.filter((x) => x.repro === "warned")) {
    it(`${g.id}`, WARNED[g.id]!);
  }
});

describe("known gaps: refused today", () => {
  for (const g of ledger.gaps.filter((x) => x.repro === "pinned")) {
    it(`${g.id}`, PINNED[g.id]!);
  }
});
