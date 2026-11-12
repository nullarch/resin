// The degraded-surface registry (src/transpiler/surface.ts): names that compile and run but return a
// placeholder, a pass-through or a guess. The registry must (1) report each of them, (2) let `strict`
// refuse the ones whose result looks like data and is not, and (3) stay complete as the runtime
// modules that hold stubs grow.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { SURFACE_DEGRADED, STRICT_REFUSED_TIERS } from "../../src/transpiler/surface";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ind = (body: string): string => `//@version=6\nindicator("t", overlay=true)\n${body}\nplot(close, "c")\n`;

// A valid script for every registry entry (a trailing ".*" entry gets one concrete member).
const SNIPPETS: Record<string, string> = {
  "request.dividends": ind("v = request.dividends(syminfo.tickerid)"),
  "request.splits": ind("v = request.splits(syminfo.tickerid)"),
  "request.earnings": ind("v = request.earnings(syminfo.tickerid, earnings.actual)"),
  "request.quandl": ind('v = request.quandl("X")'),
  "request.financial": ind('v = request.financial(syminfo.tickerid, "ACCRUALS_AND_DEFERRED_INCOME", "FY")'),
  "request.seed": ind('v = request.seed("a", "b", close)'),
  "request.currency_rate": ind('v = request.currency_rate("USD", "EUR")'),
  "request.security_lower_tf": ind('v = array.size(request.security_lower_tf(syminfo.tickerid, "1", close))'),
  "ticker.heikinashi": ind('v = request.security(ticker.heikinashi(syminfo.tickerid), "D", close)'),
  "ticker.renko": ind('t = ticker.renko(syminfo.tickerid, "ATR", 14)'),
  "ticker.kagi": ind("t = ticker.kagi(syminfo.tickerid, 3.0)"),
  "ticker.linebreak": ind("t = ticker.linebreak(syminfo.tickerid, 3)"),
  "ticker.pointfigure": ind('t = ticker.pointfigure(syminfo.tickerid, "hl", "ATR", 14, 3)'),
  "syminfo.sector": ind("v = str.length(syminfo.sector)"),
  "syminfo.industry": ind("v = str.length(syminfo.industry)"),
  "syminfo.description": ind("v = str.length(syminfo.description)"),
  "syminfo.shares_outstanding_total": ind("v = syminfo.shares_outstanding_total"),
  "syminfo.currency": ind("v = str.length(syminfo.currency)"),
  "syminfo.basecurrency": ind("v = str.length(syminfo.basecurrency)"),
  "request.security": ind('v = request.security(syminfo.tickerid, "D", close)'),
  "matrix.eigenvalues": ind("v = array.size(matrix.eigenvalues(matrix.new<float>(2, 2, 1.0)))"),
  "strategy.risk.*": `//@version=6\nstrategy("t")\nstrategy.risk.max_drawdown(10, strategy.percent_of_equity)\nplot(close, "c")\n`,
  alert: ind('alert("x")'),
  alertcondition: ind('alertcondition(close > open, "t", "m")'),
  "polyline.*": ind("polyline.new(array.new<chart.point>())"),
  "linefill.*": ind("x = linefill.new(line.new(0, 0, 1, 1), line.new(0, 1, 1, 2), color.red)"),
};

// The stubs live in these runtime modules. A function exported from one is either registered above
// (by the Pine name `<ns>.<fn>`) or listed here as faithful, so adding a stub forces a decision.
const FAITHFUL: Record<string, string[]> = {
  "src/runtime/ticker.ts": ["newTicker", "standard", "modify", "inherit"],
  "src/runtime/request.ts": [],
};
const PINE_NAME: Record<string, string> = {
  currencyRate: "request.currency_rate",
  securityLowerTf: "request.security_lower_tf",
};

describe("degraded surface registry", () => {
  it("has a snippet for every entry, and every snippet names an entry", () => {
    expect(Object.keys(SNIPPETS).sort()).toEqual(SURFACE_DEGRADED.map((e) => e.name).sort());
  });

  for (const entry of SURFACE_DEGRADED) {
    it(`reports ${entry.name} as ${entry.tier}`, () => {
      const r = transpile(SNIPPETS[entry.name]!);
      expect(r.ok, r.ok ? "" : r.errors.join("; ")).toBe(true);
      if (!r.ok) return;
      const stem = entry.name.endsWith(".*") ? entry.name.slice(0, -1) : entry.name;
      const hit = r.warnings.find((w) => w.name === entry.name || (entry.name.endsWith(".*") && w.name.startsWith(stem)));
      expect(hit, `no warning for ${entry.name}; got ${JSON.stringify(r.warnings)}`).toBeDefined();
      expect(hit!.kind).toBe(entry.tier);
      expect(hit!.line).toBeGreaterThan(0);
    });

    it(`strict ${STRICT_REFUSED_TIERS.includes(entry.tier) ? "refuses" : "accepts"} ${entry.name}`, () => {
      const r = transpile(SNIPPETS[entry.name]!, { strict: true });
      expect(r.ok).toBe(!STRICT_REFUSED_TIERS.includes(entry.tier));
      if (!r.ok) expect(r.errors.join("\n")).toContain("strict");
    });
  }

  it("stays complete: every function the stub modules export is registered or declared faithful", () => {
    const registered = new Set(SURFACE_DEGRADED.map((e) => e.name));
    for (const [file, faithful] of Object.entries(FAITHFUL)) {
      const ns = file.endsWith("ticker.ts") ? "ticker" : "request";
      const text = readFileSync(join(ROOT, file), "utf-8");
      for (const m of text.matchAll(/^export function (\w+)/gm)) {
        const fn = m[1]!;
        const pine = PINE_NAME[fn] ?? `${ns}.${fn}`;
        expect(
          registered.has(pine) || faithful.includes(fn),
          `${file} exports ${fn}() but ${pine} is neither in SURFACE_DEGRADED nor declared faithful in this test`,
        ).toBe(true);
      }
    }
  });
});

describe("transpile warnings and options", () => {
  it("a script that uses nothing degraded has no warnings", () => {
    const r = transpile(ind("v = ta.sma(close, 3)"));
    expect(r.ok && r.warnings).toEqual([]);
  });

  it("warns about option keys it ignores, at the top level and in syminfo", () => {
    const r = transpile(ind("v = 1"), { chartTF: "D", syminfo: { mintick: 0.01, currency: "KRW" } } as never);
    expect(r.ok && r.warnings.map((w) => `${w.kind}:${w.name}`)).toEqual(["option:chartTF", "option:syminfo.currency"]);
  });

  it("strict refuses ignored option keys and old versions; the default only warns", () => {
    const v4 = "//@version=4\nstudy('t')\nplot(close)\n";
    const warned = transpile(v4);
    expect(warned.ok && warned.warnings.map((w) => w.kind)).toEqual(["version"]);
    expect(transpile(v4, { strict: true }).ok).toBe(false);
    expect(transpile(ind("v = 1"), { strict: true, chartTF: "D" } as never).ok).toBe(false);
  });

  it("refuses source over maxSourceBytes without parsing it", () => {
    const r = transpile(ind("v = 1"), { maxSourceBytes: 10 });
    expect(!r.ok && r.errors[0]).toContain("maxSourceBytes");
    expect(transpile(ind("v = 1"), { maxSourceBytes: 10_000 }).ok).toBe(true);
  });

  it("never throws: a script too deep for the stack comes back as an internal error", () => {
    const depth = 200_000;
    const deep = ind(`v = ${"(".repeat(depth)}1${")".repeat(depth)}`);
    const r = transpile(deep, { maxSourceBytes: 10_000_000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/internal error|RangeError|nest|depth/i);
  });
});
