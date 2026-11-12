// The part of the Pine surface resin accepts but does not implement faithfully.
//
// A name that is missing is refused at transpile time ("unsupported call"). The names below are
// the other kind: they compile and run, but what they return is a placeholder, a pass-through, an
// approximation or a guess, so a script that uses one succeeds with numbers that look right. They
// are registered here so a caller can be told (TranspileOk.warnings) and can refuse them
// (`strict: true`). tests/unit/surface.test.ts keeps the registry honest in both directions: every
// entry is reported, and every function exported by the runtime modules that hold stubs is either
// registered or explicitly listed as faithful.
//
// Only the degraded names are registered. The faithful majority is not listed, so a new name that
// is wrong in a way nobody noticed still compiles silently; that is what the known-gaps ledger
// (known-gaps.json) and the differential suites are for.

import type { Script } from "./ast";

// stub        — returns a placeholder (a constant, na) instead of the real data. Refused under `strict`.
// passthrough — accepts the call and hands its input back unchanged. Refused under `strict`.
// approximated — computes a value that is known to differ from TradingView in the stated way.
// hypothesis  — behaviour reasoned from the manual or the function's name; no measurement behind it.
// noop        — ignored; the script's values do not depend on it.
export type SurfaceTier = "stub" | "passthrough" | "approximated" | "hypothesis" | "noop";

export interface SurfaceEntry {
  // Dotted name as written in Pine. A trailing ".*" matches every name below that prefix.
  name: string;
  // "call" matches `name(...)`, "read" matches the property read `name`.
  use: "call" | "read";
  tier: SurfaceTier;
  note: string;
}

const NO_FEED = "resin has no such data source";

export const SURFACE_DEGRADED: readonly SurfaceEntry[] = [
  { name: "request.dividends", use: "call", tier: "stub", note: `returns 0 on every bar; ${NO_FEED}` },
  { name: "request.splits", use: "call", tier: "stub", note: `returns 0 on every bar; ${NO_FEED}` },
  { name: "request.earnings", use: "call", tier: "stub", note: `returns 0 on every bar; ${NO_FEED}` },
  { name: "request.quandl", use: "call", tier: "stub", note: `returns 0 on every bar; ${NO_FEED}` },
  { name: "request.financial", use: "call", tier: "stub", note: `returns na on every bar; ${NO_FEED}` },
  { name: "request.seed", use: "call", tier: "stub", note: `returns na on every bar; ${NO_FEED}` },
  { name: "request.currency_rate", use: "call", tier: "stub", note: "returns na unless both currencies are the same" },
  {
    name: "request.security_lower_tf",
    use: "call",
    tier: "stub",
    note: "returns a one-element array holding the chart bar's own value, not the lower-timeframe bars",
  },
  ...["heikinashi", "renko", "kagi", "linebreak", "pointfigure"].map(
    (fn): SurfaceEntry => ({
      name: `ticker.${fn}`,
      use: "call",
      tier: "passthrough",
      note: "returns its symbol unchanged, so request.security on it reads ordinary candles",
    }),
  ),
  ...["sector", "industry", "description"].map(
    (prop): SurfaceEntry => ({
      name: `syminfo.${prop}`,
      use: "read",
      tier: "stub",
      note: "is an empty string; resin does not know the symbol's fundamentals",
    }),
  ),
  {
    name: "syminfo.shares_outstanding_total",
    use: "read",
    tier: "stub",
    note: "is 0; resin does not know the symbol's fundamentals",
  },
  ...["currency", "basecurrency"].map(
    (prop): SurfaceEntry => ({
      name: `syminfo.${prop}`,
      use: "read",
      tier: "approximated",
      note: 'is always "USD"; resin cannot be told the symbol\'s currency',
    }),
  ),
  {
    name: "request.security",
    use: "call",
    tier: "approximated",
    note:
      "without a feed in the run option `security`, a higher-timeframe value built from the chart's own bars " +
      "arrives one chart bar later than in TradingView, and a symbol with no feed reads the chart's bars",
  },
  {
    name: "matrix.eigenvalues",
    use: "call",
    tier: "approximated",
    note: "is exact for 2x2 matrices only; larger ones return the diagonal and drop the imaginary part",
  },
  {
    name: "strategy.risk.*",
    use: "call",
    tier: "hypothesis",
    note: "risk-management rules are implemented from the function names, not measured against TradingView",
  },
  { name: "alert", use: "call", tier: "noop", note: "is ignored; resin raises no alerts" },
  { name: "alertcondition", use: "call", tier: "noop", note: "is ignored; resin raises no alerts" },
  { name: "polyline.*", use: "call", tier: "noop", note: "is ignored; polylines are not drawn or recorded" },
  { name: "linefill.*", use: "call", tier: "noop", note: "is ignored; line fills are not drawn or recorded" },
];

export interface TranspileWarning {
  // A SurfaceTier, or "option" for an option key resin ignores, "version" for a version annotation
  // resin does not implement, or "import" for a library with no source whose alias reads builtins.
  // "signature": a built-in call the signature table does not allow (src/transpiler/builtins).
  kind: SurfaceTier | "option" | "version" | "import" | "signature";
  // The Pine name, or the option key.
  name: string;
  // 1-based source line; 0 when the warning is about an option rather than the source.
  line: number;
  message: string;
}

// Tiers `strict` turns from a warning into an error: the result would look like data and is not.
export const STRICT_REFUSED_TIERS: readonly SurfaceTier[] = ["stub", "passthrough"];

function dottedName(e: unknown): string | null {
  const node = e as { kind?: string; name?: string; obj?: unknown; attr?: string } | null;
  if (node === null || typeof node !== "object") return null;
  if (node.kind === "Identifier") return node.name ?? null;
  if (node.kind === "DotAccess") {
    const head = dottedName(node.obj);
    return head === null ? null : `${head}.${node.attr}`;
  }
  return null;
}

function lookup(name: string, use: SurfaceEntry["use"]): SurfaceEntry | undefined {
  for (const entry of SURFACE_DEGRADED) {
    if (entry.use !== use) continue;
    if (entry.name.endsWith(".*") ? name.startsWith(entry.name.slice(0, -1)) : entry.name === name) return entry;
  }
  return undefined;
}

// Parameters of strategy() that are accepted and never read, and whose value changes the result when
// it is not the one resin implements (the default). A cosmetic parameter that is ignored (shorttitle,
// format, ...) is not listed: the script's numbers do not depend on it.
const IGNORED_STRATEGY_PARAMS: readonly { param: string; implemented: string; note: string }[] = [
  {
    param: "close_entries_rule",
    implemented: "FIFO",
    note: "is ignored; resin always closes the oldest entry first (FIFO), so \"ANY\" gives different trades",
  },
  {
    param: "backtest_fill_limits_assumption",
    implemented: "0",
    note: "is ignored; resin fills a limit order when price touches it, so a non-zero tick assumption gives different fills",
  },
];

// Walks the parsed script and reports every use of a degraded name, in source order.
export function collectSurfaceWarnings(script: Script): TranspileWarning[] {
  const out: TranspileWarning[] = [];
  const report = (entry: SurfaceEntry, name: string, line: number): void => {
    out.push({ kind: entry.tier, name, line, message: `'${name}' ${entry.note} [${entry.tier}]` });
  };

  const reportIgnoredStrategyParams = (kwargs: { name: string; value: { kind?: string; value?: unknown } }[], line: number): void => {
    for (const { param, implemented, note } of IGNORED_STRATEGY_PARAMS) {
      const kw = kwargs.find((k) => k.name === param);
      if (kw === undefined) continue;
      // A literal equal to what resin implements changes nothing; anything else (another value, or
      // an expression whose value cannot be known here) does.
      const v = kw.value;
      const literal = v.kind === "StringLiteral" || v.kind === "NumberLiteral" ? String(v.value) : null;
      if (literal === implemented) continue;
      out.push({ kind: "stub", name: `strategy(${param}=)`, line, message: `strategy() parameter '${param}' ${note} [stub]` });
    }
  };

  const visit = (node: unknown, asCallee: boolean): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, false);
      return;
    }
    const n = node as Record<string, unknown> & { kind?: string; line?: number };
    if (n.kind === "CallExpr") {
      const name = dottedName(n.callee);
      const entry = name === null ? undefined : lookup(name, "call");
      if (entry !== undefined && name !== null) report(entry, name, n.line ?? 0);
      if (name === "strategy") reportIgnoredStrategyParams(n.kwargs as { name: string; value: { kind?: string; value?: unknown } }[], n.line ?? 0);
      // The callee is a name, not a read of one; its receiver (`a().b()`) still gets walked.
      visit(n.callee, true);
      visit(n.args, false);
      visit(n.kwargs, false);
      return;
    }
    if (n.kind === "DotAccess" && !asCallee) {
      const name = dottedName(n);
      const entry = name === null ? undefined : lookup(name, "read");
      if (entry !== undefined && name !== null) report(entry, name, n.line ?? 0);
    }
    for (const [key, child] of Object.entries(n)) {
      if (key === "line" || key === "col" || key === "kind") continue;
      visit(child, false);
    }
  };

  visit(script.body, false);
  return out.sort((a, b) => a.line - b.line);
}
