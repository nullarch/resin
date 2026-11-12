// Checks every call of a built-in function against the signature table (signatures.ts): a keyword
// the function does not have, more positional arguments than it takes, a required parameter left
// out. One pass over the parsed script, before the analyzer.
//
// What it can say is bounded by where the table comes from. The oracle is at most as strict as
// TradingView (it gives `ta.sar` defaults Pine does not), so:
//   - a parameter the oracle requires is required in Pine: "missing" is a real error;
//   - a keyword no overload has, and a count above every overload's, are errors as long as the
//     oracle describes every Pine parameter of that function, which the corpus check in
//     tests/unit/builtin_call_check.test.ts holds it to (no finding on a script known to be valid).
// It cannot say that a call is right: an optional parameter here may be required in Pine.
//
// A name the script declares itself (a variable, a function, a parameter, an import alias) is not
// a built-in namespace at that point as far as this pass can tell, so calls through it are skipped:
// `label.new(...)` is checked, `myLabels.push(...)` is not.
import type { Script } from "../ast";
import { BUILTIN_SIGNATURES, type BuiltinOverload } from "./signatures";

export interface BuiltinCallFinding {
  kind: "unknown-keyword" | "too-many-arguments" | "missing-argument";
  name: string; // the function, e.g. "label.new"
  line: number;
  message: string;
}

const DECLARING_KINDS = new Set(["VarDecl", "Assignment", "FuncDecl", "MethodDecl", "TypeDecl", "EnumDecl", "FuncParam", "ImportDecl", "ForStmt", "ForInStmt", "TupleDestructure"]);

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

// Every name the script introduces, wherever it does: scoping is not modelled, a declared name is
// simply never read as a built-in.
function declaredNames(script: Script): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as Record<string, unknown> & { kind?: string };
    if (typeof n.kind === "string" && DECLARING_KINDS.has(n.kind)) {
      for (const [key, value] of Object.entries(n)) {
        if (key === "kind") continue;
        if (typeof value === "string" && (key === "name" || key === "alias" || /var/i.test(key))) out.add(value);
        if (key === "names" && Array.isArray(value)) for (const v of value) if (typeof v === "string") out.add(v);
      }
    }
    for (const [key, child] of Object.entries(n)) {
      if (key === "line" || key === "col" || key === "kind") continue;
      visit(child);
    }
  };
  visit(script.body);
  return out;
}

// Whether `positional` leading arguments plus the keywords `named` fill every required parameter.
function missingFor(o: BuiltinOverload, positional: number, named: ReadonlySet<string>): string[] {
  const missing: string[] = [];
  o.params.forEach((p, i) => {
    if (p.optional) return;
    const byPosition = p.keywordOnly !== true && i < positional;
    if (!byPosition && !named.has(p.name)) missing.push(p.name);
  });
  return missing;
}

// Parameters v6 removed and v5 still takes (v6 migration guide: "The when parameter is removed from
// all applicable strategy.*() functions", "The transp parameter is removed from all applicable
// functions"). The table is the oracle's, which is v6, so a v5 script may still pass these.
function removedInV6(name: string, keyword: string): boolean {
  return (keyword === "when" && name.startsWith("strategy.")) || keyword === "transp";
}

export function checkBuiltinCalls(script: Script): BuiltinCallFinding[] {
  const declared = declaredNames(script);
  const v6 = script.version === 6;
  const out: BuiltinCallFinding[] = [];

  const checkCall = (name: string, positional: number, kwargs: readonly { name: string }[], line: number): void => {
    const overloads = BUILTIN_SIGNATURES[name];
    if (overloads === undefined || overloads.some((o) => o.open === true)) return;
    const named = new Set(kwargs.map((k) => k.name));

    for (const kw of named) {
      if (!v6 && removedInV6(name, kw)) continue;
      if (!overloads.some((o) => o.params.some((p) => p.name === kw))) {
        const known = [...new Set(overloads.flatMap((o) => o.params.map((p) => p.name)))];
        const removed = removedInV6(name, kw) ? "; v6 removed it" : "";
        out.push({ kind: "unknown-keyword", name, line, message: `'${name}' has no parameter '${kw}'${removed} (it takes ${known.join(", ") || "none"})` });
      }
    }

    if (!overloads.some((o) => o.variadic !== undefined)) {
      const most = Math.max(...overloads.map((o) => o.params.filter((p) => p.keywordOnly !== true).length));
      if (positional > most) {
        out.push({ kind: "too-many-arguments", name, line, message: `'${name}' takes at most ${most} argument${most === 1 ? "" : "s"}, ${positional} given` });
      }
    }

    // Missing only when no overload is filled; the one closest to filled is the one reported.
    const perOverload = overloads.map((o) => missingFor(o, positional, named));
    if (perOverload.every((m) => m.length > 0)) {
      const fewest = perOverload.reduce((a, b) => (b.length < a.length ? b : a));
      out.push({ kind: "missing-argument", name, line, message: `'${name}' needs ${fewest.map((p) => `'${p}'`).join(", ")}` });
    }
  };

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as Record<string, unknown> & { kind?: string; line?: number };
    if (n.kind === "CallExpr") {
      const name = dottedName(n.callee);
      if (name !== null && !declared.has(name.split(".")[0]!)) {
        checkCall(name, (n.args as unknown[]).length, n.kwargs as { name: string }[], n.line ?? 0);
      }
    }
    for (const [key, child] of Object.entries(n)) {
      if (key === "line" || key === "col" || key === "kind") continue;
      visit(child);
    }
  };
  visit(script.body);
  return out.sort((a, b) => a.line - b.line);
}
