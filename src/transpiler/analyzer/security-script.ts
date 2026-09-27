// request.security evaluated in the requested context, for an expression the prepass grammar
// (call-expr.ts buildSecurityExpr) cannot compile: a variable assigned with `:=` or in a block, a
// user-defined function call, `var` state, history on locals.
//
// The rule (concepts_other-timeframes-and-data.txt, "Declared variables"): "When using a declared
// variable as the expression argument, the function call duplicates all preceding code that
// determines the assigned value or reference. This duplication allows the function to evaluate
// necessary calculations and logic in the requested context without affecting the original
// variable." And: "the function only duplicates code that affects the variable before the call. It
// cannot copy any subsequent code following the call." (The pinned oracle runs the code after the
// call as well; state/disputes.md D9 in resin-harness.)
//
// planSecurityScript finds that code: the top-level statements before the call's own statement that
// can affect its expression, a backward slice over names. It is conservative: a statement it cannot
// rule out is kept. codegen then runs the script's own per-bar function on the requested bars in a
// child context that executes only those statements and records the expression where the call's
// statement begins (Context.runSecurityScript). TradingView computes a requested context's series on
// every bar whatever branch the call is written in (pynecore transformers/security_slice.py
// _force_conditional_writes, "MEASURED"), which recording at the statement's start does.
//
// A slice may read another request.security call (a nested request through a variable): the child
// reads it as the chart computed it, paired with the requested bars (Context.runSecurityScript).
// The timeframe.* variables there describe the requested timeframe (ref_v6_lang.txt
// timeframe.period: "The variable's value represents the timeframe of a requested dataset when used
// in the `expression` argument of a `request.*()` function call"; Context.secTf), and
// timeframe.main_period the chart's.
// What the child cannot reproduce is refused instead of approximated: a nested request the child
// could not read that way (nestedRequestRefusal), the strategy's state, a `timeframe.*()` call
// (timeframe.change and the default of timeframe.in_seconds read the chart's timeframe), or
// `syminfo.*` of another symbol.

import type { CallExpr, Expr, FuncDecl, MethodDecl, Stmt } from "../ast";
import { EARNINGS_CONSTANTS, SYMINFO_STRING_PROPS, type AnalyzedProgram } from "../analyzer";
import { TA_REGISTRY, taCallReturnArity } from "./ta";

export interface SecurityScriptPlan {
  // The top-level statement the call is in: the child records the expression where it begins.
  stmt: Stmt;
  // The top-level statements before it that the child runs.
  slice: ReadonlySet<Stmt>;
}

export type SecurityScriptPlanResult = { ok: true; plan: SecurityScriptPlan } | { ok: false; reason: string };

// A request in a user-defined function: every call of the function is a request of its own
// (concepts_other-timeframes-and-data.txt "In local scopes": "the Pine Script compiler extracts
// such calls into the global scope during translation"), evaluated with that call's arguments.
export interface SecurityFuncScriptSite {
  // The call of the function. Its child evaluates it where its top-level statement begins, and the
  // function records the request's expression when this call's instance reaches it.
  call: CallExpr;
  stmt: Stmt;
  // The top-level statements before it that the child runs.
  slice: ReadonlySet<Stmt>;
}

export interface SecurityFuncScriptPlan {
  // The statement of the function's body the request is in: the child records the expression where
  // it begins.
  stmt: Stmt;
  // One per call of the function, in prog.funcAllCallSites order (the calls' __secIdx ordinals).
  sites: SecurityFuncScriptSite[];
}

export type SecurityFuncScriptPlanResult = { ok: true; plan: SecurityFuncScriptPlan } | { ok: false; reason: string };

// Whether the script allows dynamic requests: its declaration's `dynamic_requests` argument, else
// the version's default (mig6.txt: "Non-dynamic requests are the default in Pine v5 ... If not
// specified, the default argument is false"; "In Pine v6, the dynamic_requests parameter of the
// indicator(), strategy(), and library() functions is true by default").
export function allowsDynamicRequests(prog: AnalyzedProgram): boolean {
  for (const s of prog.script.body) {
    if (s.kind !== "ExprStmt" || s.expr.kind !== "CallExpr") continue;
    const callee = s.expr.callee;
    if (callee.kind !== "Identifier" || !["indicator", "strategy", "library"].includes(callee.name)) continue;
    const arg = s.expr.kwargs.find((k) => k.name === "dynamic_requests")?.value;
    if (arg?.kind === "BoolLiteral") return arg.value;
  }
  return (prog.script.version ?? 1) >= 6;
}

// Whether a request.security call names the context it runs in rather than a context of its own: a
// syminfo.tickerid or "" symbol, a timeframe.period or "" timeframe (concepts_other-timeframes-and-
// data.txt "Nested requests": "the requested ticker ID or timeframe depends on the context where
// the call executes").
export function requestInheritsContext(call: CallExpr): boolean {
  const byName = (i: number, name: string): Expr | undefined => call.args[i] ?? call.kwargs.find((k) => k.name === name)?.value;
  const symbol = byName(0, "symbol");
  const tf = byName(1, "timeframe");
  const isEmpty = (e: Expr | undefined): boolean => e?.kind === "StringLiteral" && e.value === "";
  const isNs = (e: Expr | undefined, ns: string, attr: string): boolean =>
    e?.kind === "DotAccess" && e.obj.kind === "Identifier" && e.obj.name === ns && e.attr === attr;
  return isEmpty(symbol) || isNs(symbol, "syminfo", "tickerid") || isEmpty(tf) || isNs(tf, "timeframe", "period");
}

// strategy.* calls that place or cancel orders: they read no strategy state into the script.
const STRATEGY_ORDER_CALLS = new Set(["entry", "order", "exit", "close", "close_all", "cancel", "cancel_all"]);
// strategy.* names that are constants, not state.
const STRATEGY_CONSTANTS = new Set([
  "long", "short", "fixed", "cash", "percent_of_equity", "direction", "oca", "commission",
]);
// Namespaces whose calls change their arguments in place (collections, drawings) or store
// references in them.
const MUTATING_NAMESPACES = new Set(["array", "map", "matrix", "label", "line", "box", "table", "polyline", "linefill"]);
// Namespaces whose calls return a plain value (number, bool, string, color) and change nothing.
const VALUE_NAMESPACES = new Set(["ta", "math", "str", "input", "color", "ticker", "timeframe", "syminfo", "strategy"]);
// Builtin functions called by a bare name that return a plain value.
const VALUE_FUNCTIONS = new Set([
  "nz", "na", "fixnan", "int", "float", "bool", "string", "time", "time_close", "timestamp", "year", "month",
  "weekofyear", "dayofmonth", "dayofweek", "hour", "minute", "second", "input",
]);
const PRIMITIVE_TYPES = new Set(["float", "int", "bool", "string", "color"]);
// str.* functions that return a number or a bool; the others return a string (or an array).
const STR_NUMBER_FUNCTIONS = new Set(["length", "pos", "tonumber", "contains", "startswith", "endswith"]);
// input.* functions that return a string.
const INPUT_STRING_FUNCTIONS = new Set(["string", "timeframe", "symbol", "session", "text_area"]);

// What an expression evaluates to, as far as the script's text tells: a number or a bool
// ("number"), a string, a color, an object (collection, drawing, user-defined type, tuple), or
// "unknown" (a user-defined function's result, a field, a collection element).
type ValueKind = "number" | "string" | "color" | "object" | "unknown";

function combineKinds(a: ValueKind, b: ValueKind): ValueKind {
  for (const k of ["string", "color", "object"] as const) if (a === k || b === k) return k;
  return a === "number" || b === "number" ? "number" : "unknown";
}

interface Effects {
  reads: Set<string>; // user names read
  defs: Set<string>; // user names declared or assigned
  muts: Set<string>; // user names whose object may change in place
  groups: string[][]; // user names that may come to share an object
  request: boolean;
  // The request.*() calls it makes, and whether each is written in a function's body.
  requestCalls: { call: CallExpr; inFunction: boolean }[];
  strategy: boolean;
  timeframe: boolean; // a timeframe.*() call
  syminfo: boolean;
  globalWrite: boolean; // a function it calls assigns a global variable
}

function newEffects(): Effects {
  return {
    reads: new Set(), defs: new Set(), muts: new Set(), groups: [],
    request: false, requestCalls: [], strategy: false, timeframe: false, syminfo: false, globalWrite: false,
  };
}

function mergeInto(to: Effects, from: Effects): void {
  for (const n of from.reads) to.reads.add(n);
  for (const n of from.defs) to.defs.add(n);
  for (const n of from.muts) to.muts.add(n);
  for (const g of from.groups) to.groups.push(g);
  to.request ||= from.request;
  for (const r of from.requestCalls) to.requestCalls.push(r);
  to.strategy ||= from.strategy;
  to.timeframe ||= from.timeframe;
  to.syminfo ||= from.syminfo;
  to.globalWrite ||= from.globalWrite;
}

// Every statement and expression directly below `node` (bodies included).
function children(node: Stmt | Expr): (Stmt | Expr)[] {
  switch (node.kind) {
    case "VarDecl":
    case "Assignment":
    case "TupleDestructure":
      return [node.value];
    case "FieldAssignment":
      return [node.object, node.value];
    case "ExprStmt":
      return [node.expr];
    case "IfStmt":
      return [
        node.condition,
        ...node.thenBody,
        ...node.elifClauses.flatMap((c) => [c.condition, ...c.body]),
        ...(node.elseBody ?? []),
      ];
    case "ForStmt":
      return [node.start, node.end, ...(node.step ? [node.step] : []), ...node.body];
    case "ForInStmt":
      return [node.iterable, ...node.body];
    case "WhileStmt":
      return [node.condition, ...node.body];
    case "SwitchStmt":
      return [...(node.subject ? [node.subject] : []), ...node.cases.flatMap((c) => [...(c.values ?? []), ...c.body])];
    case "FuncDecl":
    case "MethodDecl":
      return [...node.params.flatMap((p) => (p.default ? [p.default] : [])), ...node.body];
    case "BinOp":
      return [node.left, node.right];
    case "UnaryOp":
      return [node.operand];
    case "TernaryOp":
      return [node.condition, node.trueExpr, node.falseExpr];
    case "CallExpr":
      return [node.callee, ...node.args, ...node.kwargs.map((k) => k.value)];
    case "DotAccess":
      return [node.obj];
    case "IndexAccess":
      return [node.obj, node.index];
    case "TupleExpr":
      return node.elements;
    default:
      return [];
  }
}

// The statement lists directly below `node` (the bodies a block-valued expression or a
// compound statement holds).
function bodiesOf(node: Stmt | Expr): Stmt[][] {
  switch (node.kind) {
    case "IfStmt":
      return [node.thenBody, ...node.elifClauses.map((c) => c.body), ...(node.elseBody ? [node.elseBody] : [])];
    case "ForStmt":
    case "ForInStmt":
    case "WhileStmt":
    case "FuncDecl":
    case "MethodDecl":
      return [node.body];
    case "SwitchStmt":
      return node.cases.map((c) => c.body);
    default:
      return [];
  }
}

function contains(node: Stmt | Expr, target: Expr): boolean {
  if (node === target) return true;
  return children(node).some((c) => contains(c, target));
}

// Whether `target` sits in a statement list below `node` (a block, also one of a block-valued
// expression) rather than in its own expressions.
function inBody(node: Stmt | Expr, target: Expr): boolean {
  const bodies = bodiesOf(node);
  if (bodies.some((b) => b.some((s) => contains(s, target)))) return true;
  const bodyStmts = new Set<Stmt | Expr>(bodies.flat());
  return children(node).some((c) => !bodyStmts.has(c) && inBody(c, target));
}

// A name's declarations in a function body (its parameters and locals): type hint and value.
type LocalEnv = Map<string, { hint: string | null; value: Expr | null }[]>;

// `declarationsOnly`: leave out `:=` assignments (they declare nothing).
function collectLocalDefs(body: readonly Stmt[], env: LocalEnv, declarationsOnly = false): void {
  const note = (name: string, hint: string | null, value: Expr | null): void => {
    const defs = env.get(name) ?? [];
    defs.push({ hint, value });
    env.set(name, defs);
  };
  const visit = (node: Stmt | Expr): void => {
    switch (node.kind) {
      case "VarDecl":
        note(node.name, node.typeHint, node.value);
        break;
      case "Assignment":
        if (!declarationsOnly || node.operator === "=") note(node.name, node.typeHint, node.value);
        break;
      case "TupleDestructure":
        // A tuple element is whatever the function it comes from returns: not known here.
        for (const n of node.names) note(n, null, null);
        break;
      case "ForStmt":
        note(node.varName, "int", null);
        break;
      case "ForInStmt":
        note(node.varName, null, null);
        if (node.indexName !== null) note(node.indexName, "int", null);
        break;
    }
    for (const c of children(node)) visit(c);
  };
  for (const s of body) visit(s);
}

function isPrimitiveHint(hint: string): boolean {
  const words = hint.trim().split(/\s+/);
  return PRIMITIVE_TYPES.has(words[words.length - 1]!);
}

function hintKind(hint: string): ValueKind {
  const words = hint.trim().split(/\s+/);
  const t = words[words.length - 1]!;
  return t === "string" ? "string" : t === "color" ? "color" : PRIMITIVE_TYPES.has(t) ? "number" : "object";
}

// A function's parameters and locals.
function localEnvOf(f: FuncDecl | MethodDecl): LocalEnv {
  const env: LocalEnv = new Map();
  for (const p of f.params) env.set(p.name, [{ hint: p.typeHint, value: null }]);
  collectLocalDefs(f.body, env);
  return env;
}

function rootIdentifier(e: Expr): string | null {
  let cur = e;
  while (cur.kind === "DotAccess" || cur.kind === "IndexAccess") cur = cur.obj;
  return cur.kind === "Identifier" ? cur.name : null;
}

class SliceAnalysis {
  private readonly userNames = new Set<string>();
  // `elem`: the name is element `elem` of the tuple `value` evaluates to (`[a, b] = f()`).
  private readonly topDefs = new Map<string, { hint: string | null; value: Expr | null; elem?: number }[]>();
  private readonly primitiveMemo = new Map<string, boolean>();
  private readonly funcs = new Map<string, (FuncDecl | MethodDecl)[]>();
  private readonly funcEffects = new Map<string, Effects>();
  private readonly typeNames = new Set<string>();
  private readonly funcPrimitiveMemo = new Map<string, boolean>();
  // Top-level names declared with var/varip, and names read with the history operator: the ones
  // whose value on one bar can reach code that runs on a later bar.
  private readonly persistent = new Set<string>();
  private readonly historyNames = new Set<string>();

  // Whether a change to `name` late on a bar can be seen by code that runs before it on a later bar.
  carriesOver(name: string): boolean {
    return this.persistent.has(name) || this.historyNames.has(name);
  }

  carryingNames(): string[] {
    return [...this.persistent, ...this.historyNames];
  }

  readonly prog: AnalyzedProgram;

  constructor(prog: AnalyzedProgram) {
    this.prog = prog;
    for (const s of prog.script.body) if (s.kind === "TypeDecl") this.typeNames.add(s.name);
    const collectNames = (node: Stmt | Expr, top: boolean): void => {
      const note = (name: string, hint: string | null, value: Expr | null, elem?: number): void => {
        this.userNames.add(name);
        if (!top) return;
        const defs = this.topDefs.get(name) ?? [];
        defs.push(elem === undefined ? { hint, value } : { hint, value, elem });
        this.topDefs.set(name, defs);
      };
      switch (node.kind) {
        case "VarDecl":
          note(node.name, node.typeHint, node.value);
          if (top && node.persistent) this.persistent.add(node.name);
          break;
        case "Assignment":
          note(node.name, node.typeHint, node.value);
          break;
        case "IndexAccess":
          if (node.obj.kind === "Identifier") this.historyNames.add(node.obj.name);
          break;
        case "TupleDestructure":
          node.names.forEach((n, i) => note(n, null, node.value, i));
          break;
        case "ForStmt":
          note(node.varName, "int", null);
          break;
        case "ForInStmt":
          note(node.varName, null, node.iterable);
          if (node.indexName !== null) note(node.indexName, "int", null);
          break;
        case "FuncDecl":
        case "MethodDecl":
          for (const p of node.params) this.userNames.add(p.name);
          break;
      }
      const inner = node.kind === "FuncDecl" || node.kind === "MethodDecl" ? false : top;
      for (const c of children(node)) collectNames(c, inner);
    };
    for (const s of prog.script.body) {
      collectNames(s, true);
      if (s.kind === "FuncDecl" || s.kind === "MethodDecl") {
        const list = this.funcs.get(s.name) ?? [];
        list.push(s);
        this.funcs.set(s.name, list);
      }
    }
  }

  private isUser(name: string): boolean {
    return this.userNames.has(name);
  }

  // Whether every top-level declaration of `name` gives it a plain value (number, bool, string,
  // color): such a variable holds no object that another one could share or a call could change.
  private isPrimitiveName(name: string, visiting: Set<string> = new Set()): boolean {
    const memo = this.primitiveMemo.get(name);
    if (memo !== undefined) return memo;
    if (visiting.has(name)) return true;
    visiting.add(name);
    const defs = this.topDefs.get(name) ?? [];
    let prim = true;
    for (const d of defs) {
      if (d.hint !== null) {
        const words = d.hint.trim().split(/\s+/);
        if (PRIMITIVE_TYPES.has(words[words.length - 1]!)) continue;
        prim = false;
        break;
      }
      if (d.value !== null && !this.isPrimitiveExpr(d.value, visiting)) {
        prim = false;
        break;
      }
    }
    visiting.delete(name);
    if (visiting.size === 0) this.primitiveMemo.set(name, prim);
    return prim;
  }

  // `env`: inside a function body, its parameters and locals (a name found there is resolved there,
  // any other name at the top level).
  private isPrimitiveExpr(e: Expr, visiting: Set<string>, env?: LocalEnv): boolean {
    switch (e.kind) {
      case "NumberLiteral":
      case "StringLiteral":
      case "BoolLiteral":
      case "NaLiteral":
      case "ColorLiteral":
      case "BinOp":
      case "UnaryOp":
        return true;
      case "Identifier": {
        const local = env?.get(e.name);
        if (local !== undefined) {
          const key = `local:${e.name}`;
          if (visiting.has(key)) return true;
          visiting.add(key);
          // A parameter without a primitive type hint may be handed any object.
          const prim = local.every((d) =>
            d.hint !== null ? isPrimitiveHint(d.hint) : d.value !== null && this.isPrimitiveExpr(d.value, visiting, env),
          );
          visiting.delete(key);
          return prim;
        }
        return !this.isUser(e.name) || this.isPrimitiveName(e.name, visiting);
      }
      case "TernaryOp":
        return this.isPrimitiveExpr(e.trueExpr, visiting, env) && this.isPrimitiveExpr(e.falseExpr, visiting, env);
      case "IndexAccess":
        return this.isPrimitiveExpr(e.obj, visiting, env);
      case "TupleExpr":
        return e.elements.every((el) => this.isPrimitiveExpr(el, visiting, env));
      case "DotAccess":
        return e.obj.kind === "Identifier" && !this.isUser(e.obj.name);
      case "CallExpr": {
        const callee = e.callee;
        if (callee.kind === "Identifier") {
          if (this.funcs.has(callee.name)) return this.isPrimitiveFunction(callee.name);
          if (callee.name === "nz" || callee.name === "fixnan") return e.args.length > 0 && this.isPrimitiveExpr(e.args[0]!, visiting, env);
          return VALUE_FUNCTIONS.has(callee.name);
        }
        // A request's result is a new value on every bar (a copy, when it is an object).
        return (
          callee.obj.kind === "Identifier" &&
          !this.isUser(callee.obj.name) &&
          (VALUE_NAMESPACES.has(callee.obj.name) || callee.obj.name === "request")
        );
      }
      case "IfStmt":
      case "SwitchStmt":
      case "ForStmt":
      case "WhileStmt":
        return bodiesOf(e).every((b) => this.isPrimitiveResult(b, visiting, env));
      default:
        return false;
    }
  }

  // Whether a block's value, its last statement's, is a plain value.
  private isPrimitiveResult(body: readonly Stmt[], visiting: Set<string>, env?: LocalEnv): boolean {
    const last = body[body.length - 1];
    if (last === undefined) return true;
    switch (last.kind) {
      case "ExprStmt":
        return this.isPrimitiveExpr(last.expr, visiting, env);
      case "VarDecl":
      case "Assignment":
        return this.isPrimitiveExpr(last.value, visiting, env);
      case "IfStmt":
      case "SwitchStmt":
      case "ForStmt":
      case "ForInStmt":
      case "WhileStmt":
        return bodiesOf(last).every((b) => this.isPrimitiveResult(b, visiting, env));
      default:
        return false;
    }
  }

  // Whether a user-defined function returns a plain value: every declaration of it ends in one.
  private isPrimitiveFunction(name: string): boolean {
    const memo = this.funcPrimitiveMemo.get(name);
    if (memo !== undefined) return memo;
    this.funcPrimitiveMemo.set(name, true); // Pine functions cannot recurse
    let prim = true;
    for (const f of this.funcs.get(name) ?? []) {
      if (!this.isPrimitiveResult(f.body, new Set(), localEnvOf(f))) {
        prim = false;
        break;
      }
    }
    this.funcPrimitiveMemo.set(name, prim);
    return prim;
  }

  // `env`: inside a function body, its parameters and locals (a name found there is resolved there,
  // any other name at the top level).
  valueKind(e: Expr, visiting: Set<string> = new Set(), env?: LocalEnv): ValueKind {
    switch (e.kind) {
      case "NumberLiteral":
      case "BoolLiteral":
      case "UnaryOp":
        return "number";
      case "NaLiteral":
        return "unknown";
      case "StringLiteral":
        return "string";
      case "ColorLiteral":
        return "color";
      case "BinOp":
        if (e.op !== "+") return "number";
        return combineKinds(combineKinds(this.valueKind(e.left, visiting, env), this.valueKind(e.right, visiting, env)), "number");
      case "TernaryOp":
        return combineKinds(this.valueKind(e.trueExpr, visiting, env), this.valueKind(e.falseExpr, visiting, env));
      case "IndexAccess":
        return this.valueKind(e.obj, visiting, env);
      case "TupleExpr":
        return "object";
      case "Identifier": {
        const local = env?.get(e.name);
        if (local !== undefined) {
          const key = `local:${e.name}`;
          if (visiting.has(key)) return "unknown";
          visiting.add(key);
          let kind: ValueKind = "unknown";
          for (const d of local) {
            if (d.hint !== null) kind = combineKinds(kind, hintKind(d.hint));
            else if (d.value !== null) kind = combineKinds(kind, this.valueKind(d.value, visiting, env));
          }
          visiting.delete(key);
          return kind;
        }
        if (!this.isUser(e.name)) return "number";
        if (visiting.has(e.name)) return "unknown";
        visiting.add(e.name);
        let kind: ValueKind = "unknown";
        for (const d of this.topDefs.get(e.name) ?? []) {
          if (d.hint !== null) {
            kind = combineKinds(kind, hintKind(d.hint));
          } else if (d.value !== null && d.elem !== undefined) {
            kind = combineKinds(kind, this.tupleElementKind(d.value, d.elem, visiting));
          } else if (d.value !== null) {
            kind = combineKinds(kind, this.valueKind(d.value, visiting));
          }
        }
        visiting.delete(e.name);
        return kind;
      }
      case "DotAccess": {
        if (e.obj.kind !== "Identifier" || this.isUser(e.obj.name)) return "unknown";
        const ns = e.obj.name;
        if (ns === "color") return "color";
        if (ns === "syminfo" && SYMINFO_STRING_PROPS.has(e.attr)) return "string";
        if (ns === "timeframe" && (e.attr === "period" || e.attr === "main_period")) return "string";
        if ((ns === "earnings" || ns === "dividends" || ns === "splits") && EARNINGS_CONSTANTS.has(e.attr)) return "string";
        return "unknown";
      }
      case "CallExpr": {
        const callee = e.callee;
        if (callee.kind === "Identifier") {
          if (this.funcs.has(callee.name)) {
            // What the function returns, as the analysis of its body found (a function declared
            // after the call has not been analyzed yet: not known).
            const info = this.prog.funcs.get(callee.name);
            if (info === undefined) return "unknown";
            if (!info.bodyAnalyzed) return "object";
            const returnsObject =
              info.tupleArity !== null ||
              info.returnUdtType !== null ||
              info.returnContainerKind !== null ||
              info.returnArrayElemUdtType !== null ||
              info.returnArrayElemDrawingKind !== null;
            return returnsObject ? "object" : info.returnIsScalarSafe ? "number" : "unknown";
          }
          if (callee.name === "nz" || callee.name === "fixnan") return e.args.length > 0 ? this.valueKind(e.args[0]!, visiting, env) : "unknown";
          if (callee.name === "input") return e.args.length > 0 ? this.valueKind(e.args[0]!, visiting, env) : "unknown";
          return VALUE_FUNCTIONS.has(callee.name) ? "number" : "unknown";
        }
        if (callee.obj.kind === "DotAccess" && callee.obj.obj.kind === "Identifier" && callee.obj.obj.name === "chart") return "object";
        if (callee.obj.kind !== "Identifier" || this.isUser(callee.obj.name)) return "unknown";
        const ns = callee.obj.name;
        const fn = callee.attr;
        if (this.typeNames.has(ns)) return fn === "new" || fn === "copy" ? "object" : "unknown";
        switch (ns) {
          case "ta": {
            // ta.valuewhen returns its source's type.
            if (fn === "valuewhen") return e.args.length > 1 ? this.valueKind(e.args[1]!, visiting, env) : "unknown";
            const entry = TA_REGISTRY[fn];
            if (entry?.returnsArrayHandle) return "object";
            const arity = entry !== undefined ? taCallReturnArity(entry, e.args.length + e.kwargs.length) : undefined;
            return arity !== undefined && arity > 1 ? "object" : "number";
          }
          case "math":
          case "strategy":
            return "number";
          case "str":
            return STR_NUMBER_FUNCTIONS.has(fn) ? "number" : "string";
          case "color":
            return "color";
          case "input":
            return INPUT_STRING_FUNCTIONS.has(fn) ? "string" : fn === "color" ? "color" : "number";
          case "ticker":
            return "string";
          case "array":
          case "map":
          case "matrix":
            return fn.startsWith("new") || fn === "from" || fn === "copy" || fn === "slice" ? "object" : "unknown";
          case "label":
          case "line":
          case "box":
          case "table":
          case "polyline":
          case "linefill":
            return fn === "new" || fn === "copy" ? "object" : "unknown";
          default:
            return "unknown";
        }
      }
      default:
        return "unknown";
    }
  }

  // What element `i` of the tuple `e` evaluates to (`[a, b] = f()`: `b` is element 1 of `f()`). A
  // name declared by a tuple declaration holds one of the values, not the tuple
  // (language_type-system.txt "Tuples": "the script must use a tuple declaration to declare one new
  // variable for each value returned by the function", and "The compiler automatically determines
  // the type of each variable in a declared tuple").
  private tupleElementKind(e: Expr, i: number, visiting: Set<string>): ValueKind {
    switch (e.kind) {
      case "TupleExpr":
        return i < e.elements.length ? this.valueKind(e.elements[i]!, visiting) : "unknown";
      case "CallExpr": {
        const callee = e.callee;
        if (callee.kind === "Identifier") {
          if (!this.funcs.has(callee.name)) return "unknown";
          // What the analysis of the function's body found its tuple's element to be: a string or
          // an object (collection, drawing, user-defined type) that a history slot cannot hold. A
          // function declared after the call has not been analyzed yet: not known.
          const info = this.prog.funcs.get(callee.name);
          if (info === undefined) return "unknown";
          if (!info.bodyAnalyzed) return "object";
          const k = info.tupleElemNonNumericKinds?.[i];
          if (k !== undefined && k !== null) return k === "string" ? "string" : "object";
          // Otherwise what the element's own expression says, in the function's scope (a str.*
          // call is a string, a color.* call a color), over every declaration of the function.
          let kind: ValueKind = "unknown";
          for (const f of this.funcs.get(callee.name)!) {
            const last = f.body[f.body.length - 1];
            if (last?.kind !== "ExprStmt" || last.expr.kind !== "TupleExpr") continue;
            const el = last.expr.elements[i];
            if (el !== undefined) kind = combineKinds(kind, this.valueKind(el, visiting, localEnvOf(f)));
          }
          return kind;
        }
        if (callee.obj.kind !== "Identifier" || this.isUser(callee.obj.name)) return "unknown";
        // A multi-return ta.* call returns numbers (ta.macd, ta.bb, ta.dmi, ...).
        if (callee.obj.name === "ta") return "number";
        if (callee.obj.name === "request" && callee.attr === "security") {
          const expression = e.args[2] ?? e.kwargs.find((k) => k.name === "expression")?.value;
          return expression !== undefined ? this.tupleElementKind(expression, i, visiting) : "unknown";
        }
        return "unknown";
      }
      default:
        return "unknown";
    }
  }

  // User names in `e` that may hold an object, and so the objects `e` may evaluate to or hold:
  // a user-defined function's result may be any object its body reaches.
  private objectNames(e: Expr, out: Set<string> = new Set()): Set<string> {
    if (e.kind === "Identifier") {
      if (this.isUser(e.name) && !this.isPrimitiveName(e.name)) out.add(e.name);
      return out;
    }
    if (e.kind === "CallExpr") {
      const fn = e.callee.kind === "Identifier" ? e.callee.name : e.callee.attr;
      if (this.funcs.has(fn)) {
        for (const n of this.effectsOfFunction(fn).reads) if (!this.isPrimitiveName(n)) out.add(n);
      }
    }
    for (const c of children(e)) this.objectNames(c as Expr, out);
    return out;
  }

  isFunction(name: string): boolean {
    return this.funcs.has(name);
  }

  // Whether `e` is a call of a function that returns a tuple (a user-defined one whose body the
  // analysis has seen end in one, or a multi-value ta.* function).
  returnsTuple(e: Expr): boolean {
    if (e.kind !== "CallExpr") return false;
    const callee = e.callee;
    if (callee.kind === "Identifier") {
      const info = this.funcs.has(callee.name) ? this.prog.funcs.get(callee.name) : undefined;
      return info !== undefined && info.bodyAnalyzed && info.tupleArity !== null;
    }
    if (callee.obj.kind !== "Identifier" || callee.obj.name !== "ta" || this.isUser("ta")) return false;
    const entry = TA_REGISTRY[callee.attr];
    const arity = entry !== undefined ? taCallReturnArity(entry, e.args.length + e.kwargs.length) : undefined;
    return arity !== undefined && arity > 1;
  }

  // What calling a user-defined function does to the caller's names: the globals its body reads
  // and the global objects it may change (a function cannot assign a global variable, so it defines
  // none). Its parameters and locals are its own and left out.
  effectsOfFunction(name: string): Effects {
    const memo = this.funcEffects.get(name);
    if (memo !== undefined) return memo;
    const eff = newEffects();
    this.funcEffects.set(name, eff);
    for (const f of this.funcs.get(name) ?? []) {
      const body = newEffects();
      for (const p of f.params) if (p.default) this.walkExpr(p.default, body);
      for (const s of f.body) this.walkStmt(s, body);
      const own = new Set<string>(f.params.map((p) => p.name));
      const env: LocalEnv = new Map();
      collectLocalDefs(f.body, env, true);
      for (const n of env.keys()) own.add(n);
      // A `:=` to a name the function does not declare assigns a global (not valid Pine: "Cannot
      // modify global variable in function"; resin's own analysis lets it through).
      if ([...body.defs].some((n) => !own.has(n))) eff.globalWrite = true;
      for (const n of body.reads) if (!own.has(n)) eff.reads.add(n);
      for (const n of body.muts) if (!own.has(n)) eff.muts.add(n);
      for (const g of body.groups) {
        const globals = g.filter((n) => !own.has(n));
        if (globals.length > 1) eff.groups.push(globals);
      }
      eff.request ||= body.request;
      for (const r of body.requestCalls) eff.requestCalls.push({ call: r.call, inFunction: true });
      eff.strategy ||= body.strategy;
      eff.timeframe ||= body.timeframe;
      eff.syminfo ||= body.syminfo;
      eff.globalWrite ||= body.globalWrite;
    }
    return eff;
  }

  walkStmt(s: Stmt, eff: Effects): void {
    switch (s.kind) {
      case "VarDecl":
      case "Assignment":
        eff.defs.add(s.name);
        this.walkExpr(s.value, eff);
        eff.groups.push([s.name, ...this.objectNames(s.value)]);
        return;
      case "TupleDestructure":
        for (const n of s.names) eff.defs.add(n);
        this.walkExpr(s.value, eff);
        eff.groups.push([...s.names, ...this.objectNames(s.value)]);
        return;
      case "FieldAssignment": {
        const root = rootIdentifier(s.object);
        this.walkExpr(s.object, eff);
        this.walkExpr(s.value, eff);
        if (root !== null && this.isUser(root)) {
          eff.muts.add(root);
          eff.groups.push([root, ...this.objectNames(s.value)]);
        }
        return;
      }
      case "ForStmt":
        eff.defs.add(s.varName);
        break;
      case "ForInStmt":
        eff.defs.add(s.varName);
        if (s.indexName !== null) eff.defs.add(s.indexName);
        eff.groups.push([s.varName, ...this.objectNames(s.iterable)]);
        break;
      case "FuncDecl":
      case "MethodDecl":
      case "TypeDecl":
      case "EnumDecl":
        return;
    }
    for (const c of children(s)) {
      if (bodiesOf(s).some((b) => b.includes(c as Stmt))) this.walkStmt(c as Stmt, eff);
      else this.walkExpr(c as Expr, eff);
    }
  }

  walkExpr(e: Expr, eff: Effects): void {
    switch (e.kind) {
      case "Identifier":
        if (this.isUser(e.name)) eff.reads.add(e.name);
        return;
      case "DotAccess": {
        if (e.obj.kind === "Identifier" && !this.isUser(e.obj.name)) {
          // The timeframe.* variables are the requested timeframe's in the child (Context.secTf).
          const ns = e.obj.name;
          if (ns === "strategy" && !STRATEGY_CONSTANTS.has(e.attr)) eff.strategy = true;
          else if (ns === "syminfo") eff.syminfo = true;
          return;
        }
        this.walkExpr(e.obj, eff);
        return;
      }
      case "CallExpr":
        this.walkCall(e, eff);
        return;
      case "IfStmt":
      case "ForStmt":
      case "WhileStmt":
      case "SwitchStmt":
        this.walkStmt(e, eff);
        return;
    }
    for (const c of children(e)) this.walkExpr(c as Expr, eff);
  }

  private walkCall(c: CallExpr, eff: Effects): void {
    const callee = c.callee;
    const args = [...c.args, ...c.kwargs.map((k) => k.value)];
    if (callee.kind === "DotAccess" && callee.obj.kind === "Identifier" && callee.obj.name === "request" && !this.isUser("request")) {
      // A request. A child reads the value the chart computed for it and evaluates none of its
      // arguments (nestedRequestRefusal): its symbol and timeframe are resolved as on the chart,
      // its expression in its own context. Only the names they read are kept (a request in a
      // function whose call a child evaluates records its expression there, and the slice must
      // hold what that reads; planSecurityScriptInFunction checks the expression itself).
      const argEff = newEffects();
      for (const a of args) this.walkExpr(a, argEff);
      for (const n of argEff.reads) eff.reads.add(n);
      eff.request = true;
      eff.requestCalls.push({ call: c, inFunction: false });
      return;
    }
    for (const a of args) this.walkExpr(a, eff);
    // The objects the call is handed: it may change them or make them share one another.
    const handed = (extra: string[] = []): void => {
      const names = new Set(extra);
      for (const a of args) this.objectNames(a, names);
      for (const n of names) eff.muts.add(n);
      if (names.size > 1) eff.groups.push([...names]);
    };
    if (callee.kind === "Identifier") {
      if (this.funcs.has(callee.name)) {
        mergeInto(eff, this.effectsOfFunction(callee.name));
        handed();
      }
      return;
    }
    const obj = callee.obj;
    if (obj.kind === "Identifier" && !this.isUser(obj.name)) {
      const ns = obj.name;
      if (ns === "strategy") {
        if (!STRATEGY_ORDER_CALLS.has(callee.attr)) eff.strategy = true;
      } else if (ns === "timeframe") eff.timeframe = true;
      else if (ns === "syminfo") eff.syminfo = true;
      else if (MUTATING_NAMESPACES.has(ns)) handed();
      else if (!VALUE_NAMESPACES.has(ns) && ns !== "log" && ns !== "runtime" && ns !== "chart") {
        // Anything else by a name that is not the script's own (an imported library, a namespace
        // this analysis does not know): it may change what it is handed.
        handed();
      }
      return;
    }
    // A method call on a value (`x.push(1)`, `p.update()`, `strategy.opentrades.entry_price(0)`,
    // `chart.point.new(...)`): the receiver's own effects, then what the method may change.
    const root = rootIdentifier(obj);
    if (root !== null && !this.isUser(root)) {
      if (root === "strategy") {
        if (!(obj.kind === "DotAccess" && obj.attr === "risk")) eff.strategy = true;
      } else if (root === "timeframe") eff.timeframe = true;
      else if (root === "syminfo") eff.syminfo = true;
      return;
    }
    this.walkExpr(obj, eff);
    if (this.funcs.has(callee.attr)) mergeInto(eff, this.effectsOfFunction(callee.attr));
    handed([...this.objectNames(obj)]);
  }
}

// The requests a child reads (a nested request through a variable), from `effs`: the child reads
// each as the chart computed it, paired with its own rows (Context.runSecurityScript). Without
// dynamic requests that is Pine's rule (concepts_other-timeframes-and-data.txt "Nested requests":
// "Without dynamic requests enabled, the script evaluates each call independently, passing the
// first call's calculated value directly into the second call rather than executing the first call
// within the second context"); with them a call that names its own symbol and timeframe reads the
// same bars from within the requested context, but one that names the context it runs in ("the
// nested request inherits that request.*() call's ticker ID or timeframe information") would read
// another context's, which the reference does not do either (resin-harness state/disputes.md D11),
// and is refused, as is a request in a function (its symbol and timeframe are the call's). Also
// refused: a request.*() function other than request.security, and a request whose timeframe is
// bound on its first execution (its data is not built before the child runs). Why the child
// cannot read them, or null.
function nestedRequestRefusal(prog: AnalyzedProgram, effs: readonly Effects[]): string | null {
  const dynamic = allowsDynamicRequests(prog);
  for (const e of effs) {
    for (const { call, inFunction } of e.requestCalls) {
      const fn = call.callee.kind === "DotAccess" ? call.callee.attr : "";
      if (fn !== "security") return `it depends on a request.${fn}() call (not implemented in a requested context)`;
      if (prog.securityDeferredTfs.has(call)) {
        return "it depends on a request whose timeframe is bound on its first execution (not implemented in a requested context)";
      }
      if (dynamic && (inFunction || requestInheritsContext(call))) {
        return "it depends on a request that, with dynamic requests, may run in the requested context's symbol or timeframe (not implemented; resin-harness state/disputes.md D11)";
      }
    }
  }
  return null;
}

export function planSecurityScript(prog: AnalyzedProgram, call: CallExpr, expression: Expr, foreignSymbol: boolean): SecurityScriptPlanResult {
  const body = prog.script.body;
  const at = body.findIndex((s) => contains(s, call));
  if (at < 0) return { ok: false, reason: "the call is not in a top-level statement" };
  const stmt = body[at]!;
  if (stmt.kind === "FuncDecl" || stmt.kind === "MethodDecl") return { ok: false, reason: "the call is in a function" };
  if (stmt.kind === "TupleDestructure" && stmt.value === call) return { ok: false, reason: "requesting a tuple value is not implemented" };

  const a = new SliceAnalysis(prog);
  // The chart reads the child's values from a Float64Array (Context.runSecurityScript).
  const kind = a.valueKind(expression);
  if (kind !== "number" && kind !== "unknown") {
    return { ok: false, reason: `requesting a ${kind === "object" ? "tuple or object" : kind} value is not implemented` };
  }
  const exprEff = newEffects();
  a.walkExpr(expression, exprEff);
  const selfRead = declaredNames(stmt).find((n) => exprEff.reads.has(n));
  if (selfRead !== undefined) return { ok: false, reason: `the expression reads '${selfRead}', which its own statement declares` };
  const effects = body.map((s) => {
    const eff = newEffects();
    a.walkStmt(s, eff);
    return eff;
  });
  const sliced = sliceBefore(a, body, effects, at, call, exprEff, foreignSymbol);
  if (!sliced.ok) return sliced;
  return { ok: true, plan: { stmt, slice: sliced.slice } };
}

// The names a top-level statement declares (`x = request.security(..., x)`: the name is not declared
// yet where the expression reads it).
function declaredNames(stmt: Stmt): string[] {
  return stmt.kind === "VarDecl" || (stmt.kind === "Assignment" && stmt.operator === "=")
    ? [stmt.name]
    : stmt.kind === "TupleDestructure"
      ? stmt.names
      : [];
}

// The top-level statements before `body[at]` that a child must run so that `target`, evaluated where
// `body[at]` begins, reads what it reads on the chart; `targetEff` is what evaluating it reads and
// depends on. Or why the child cannot evaluate it.
function sliceBefore(
  a: SliceAnalysis,
  body: readonly Stmt[],
  effects: readonly Effects[],
  at: number,
  target: Expr,
  targetEff: Effects,
  foreignSymbol: boolean,
): { ok: true; slice: Set<Stmt> } | { ok: false; reason: string } {
  const exprEff = targetEff;
  // A call in a local block (an if/switch/loop body at the top level) is hoisted as TradingView
  // hoists it: evaluated where the top-level statement begins, which holds as long as nothing in
  // that statement changes what it reads (checked below).
  const inBlock = inBody(body[at]!, target);

  // Names that may come to share one object, as one class (over the whole script: an object the
  // expression reads may be reached through a name bound anywhere).
  const parent = new Map<string, string>();
  const find = (n: string): string => {
    let r = n;
    while (parent.has(r)) r = parent.get(r)!;
    return r;
  };
  for (const eff of [...effects, exprEff]) {
    for (const g of eff.groups) {
      for (let i = 1; i < g.length; i++) {
        const x = find(g[0]!);
        const y = find(g[i]!);
        if (x !== y) parent.set(y, x);
      }
    }
  }

  const needed = new Set(exprEff.reads);
  const slice = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    const neededClasses = new Set([...needed].map(find));
    effects.forEach((eff, i) => {
      if (i >= at || slice.has(i)) return;
      const s = body[i]!;
      if (s.kind === "FuncDecl" || s.kind === "MethodDecl" || s.kind === "TypeDecl" || s.kind === "EnumDecl") return;
      const affects = [...eff.defs].some((n) => needed.has(n)) || [...eff.muts].some((n) => neededClasses.has(find(n)));
      if (!affects) return;
      slice.add(i);
      for (const n of eff.reads) needed.add(n);
      for (const n of eff.muts) needed.add(n);
      changed = true;
    });
  }

  // Code from the call's statement on that changes what the expression reads on a later bar
  // (`counter += 1` after `request.security(..., counter)` with `var counter`, or
  // `x := request.security(..., x)` itself): the manual leaves it out of the requested context ("It
  // cannot copy any subsequent code following the call"; its counter example reads 0 on every
  // bar), the pinned oracle runs it there (resin-harness state/disputes.md D9). Neither is taken
  // until that is settled. A change no later bar can see (a variable declared without var, read
  // without history: its declaration runs again before any read) is the same either way.
  const neededClasses = new Set([...needed].map(find));
  if (inBlock) {
    const eff = effects[at]!;
    const touched = [...eff.defs].find((n) => needed.has(n)) ?? [...eff.muts].find((n) => neededClasses.has(find(n)));
    if (touched !== undefined) {
      return { ok: false, reason: `the call is in a local block whose statement also changes '${touched}', which the expression reads` };
    }
  }
  // An object carries over when any name that may hold it does.
  const carryingClasses = new Set(a.carryingNames().map(find));
  for (let i = at; i < body.length; i++) {
    const eff = effects[i]!;
    const changed =
      [...eff.defs].find((n) => needed.has(n) && a.carriesOver(n)) ??
      [...eff.muts].find((n) => neededClasses.has(find(n)) && carryingClasses.has(find(n)));
    if (changed !== undefined) {
      return {
        ok: false,
        reason: `the script changes '${changed}', which the expression reads, after the call (L${body[i]!.line}; disputed: whether the requested context runs that code)`,
      };
    }
  }

  const all = [exprEff, ...[...slice].map((i) => effects[i]!)];
  const nested = nestedRequestRefusal(a.prog, all);
  if (nested !== null) return { ok: false, reason: nested };
  if (all.some((e) => e.strategy)) return { ok: false, reason: "it reads the strategy's state" };
  if (all.some((e) => e.globalWrite)) return { ok: false, reason: "a function it calls assigns a global variable" };
  if (all.some((e) => e.timeframe)) return { ok: false, reason: "it calls timeframe.*() (not implemented in the requested context)" };
  if (foreignSymbol && all.some((e) => e.syminfo)) return { ok: false, reason: "it reads syminfo.* of another symbol (not implemented)" };
  return { ok: true, slice: new Set([...slice].map((i) => body[i]!)) };
}

// A request.security call in the body of the user-defined function `funcName`, with an expression the
// prepass grammar does not take. Each call of the function is a request of its own, evaluated with
// that call's arguments: the child of call k evaluates the call where its top-level statement begins
// (after the statements before it that the call needs), and the function records the expression
// where the request's statement of its body begins, when __secIdx is k. The function's code before
// that statement runs in the child as it runs on the chart, with the call's own instance state.
// `foreignSymbol(k)`: whether call k requests another symbol than the chart's.
export function planSecurityScriptInFunction(
  prog: AnalyzedProgram,
  call: CallExpr,
  expression: Expr,
  funcName: string,
  foreignSymbol: (ordinal: number) => boolean,
): SecurityFuncScriptPlanResult {
  const body = prog.script.body;
  const decl = body.find((s): s is FuncDecl => s.kind === "FuncDecl" && s.name === funcName && contains(s, call));
  if (decl === undefined) return { ok: false, reason: "the call is in a method" };
  const fat = decl.body.findIndex((s) => contains(s, call));
  const fstmt = decl.body[fat]!;

  const a = new SliceAnalysis(prog);
  const kind = a.valueKind(expression);
  if (kind !== "number" && kind !== "unknown") {
    return { ok: false, reason: `requesting a ${kind === "object" ? "tuple or object" : kind} value is not implemented` };
  }

  // What the expression depends on in the function: the statements of its body before the request's
  // that can change what it reads. The requested context computes them itself; a value another
  // request returned is not there.
  const exprEff = newEffects();
  a.walkExpr(expression, exprEff);
  const fEffects = decl.body.map((s) => {
    const eff = newEffects();
    a.walkStmt(s, eff);
    return eff;
  });
  const needed = new Set(exprEff.reads);
  const dep = new Set<number>();
  for (let changed = true; changed; ) {
    changed = false;
    fEffects.forEach((eff, i) => {
      if (i >= fat || dep.has(i)) return;
      const affects = [...eff.defs, ...eff.muts].some((n) => needed.has(n));
      if (!affects) return;
      dep.add(i);
      for (const n of eff.reads) needed.add(n);
      for (const n of eff.muts) needed.add(n);
      changed = true;
    });
  }
  const depEff = [exprEff, ...[...dep].map((i) => fEffects[i]!)];
  if (depEff.some((e) => e.request)) return { ok: false, reason: "it depends on another request.*() call (a nested request through a variable is not implemented)" };
  if (depEff.some((e) => e.timeframe)) return { ok: false, reason: "it calls timeframe.*() (not implemented in the requested context)" };
  const sites = prog.funcAllCallSites.get(funcName) ?? [];
  if (depEff.some((e) => e.syminfo) && sites.some((_, k) => foreignSymbol(k))) {
    return { ok: false, reason: "it reads syminfo.* of another symbol (not implemented)" };
  }
  if (inBody(fstmt, call)) {
    const eff = fEffects[fat]!;
    const touched = [...eff.defs, ...eff.muts].find((n) => needed.has(n));
    if (touched !== undefined) {
      return { ok: false, reason: `the call is in a local block whose statement also changes '${touched}', which the expression reads` };
    }
  }
  // The function's code from the request's statement on that changes what the expression reads on a
  // later call (a `var` local, or one read with history): disputed as at the top level (D9).
  const persistentLocals = new Set<string>();
  const notePersistent = (node: Stmt | Expr): void => {
    if (node.kind === "VarDecl" && node.persistent) persistentLocals.add(node.name);
    for (const c of children(node)) notePersistent(c);
  };
  for (const s of decl.body) notePersistent(s);
  for (let i = fat; i < decl.body.length; i++) {
    const eff = fEffects[i]!;
    const changed = [...eff.defs, ...eff.muts].find((n) => needed.has(n) && (persistentLocals.has(n) || a.carriesOver(n)));
    if (changed !== undefined) {
      return {
        ok: false,
        reason: `the function changes '${changed}', which the expression reads, after the call (L${decl.body[i]!.line}; disputed: whether the requested context runs that code)`,
      };
    }
  }

  // The child evaluates the whole call, so all of the function's code runs there, not only what the
  // expression needs: none of it may need what a child does not have. Its other requests read
  // nothing in the child (codegen), which holds for request.security calls written in its body.
  const whole = newEffects();
  for (const eff of fEffects) mergeInto(whole, eff);
  // The request's own expression too: a statement's effects leave a request's arguments out.
  mergeInto(whole, exprEff);
  if (whole.strategy) return { ok: false, reason: "the function reads the strategy's state" };
  if (whole.globalWrite) return { ok: false, reason: "a function it calls assigns a global variable" };
  let otherRequest: string | null = null;
  const scanCalls = (node: Stmt | Expr): void => {
    if (node.kind === "CallExpr") {
      const callee = node.callee;
      if (callee.kind === "Identifier") {
        if (a.isFunction(callee.name) && a.effectsOfFunction(callee.name).request) otherRequest ??= `the function it calls, '${callee.name}', makes a request`;
      } else if (callee.obj.kind === "Identifier" && callee.obj.name === "request" && callee.attr !== "security") {
        otherRequest ??= `the function calls request.${callee.attr}()`;
      }
    }
    for (const c of children(node)) scanCalls(c);
  };
  for (const s of decl.body) scanCalls(s);
  if (otherRequest !== null) return { ok: false, reason: `${otherRequest} (not implemented in a requested context)` };

  // Each call: the statements before it that it needs, its arguments and the globals the function
  // reads (a parameter's default is evaluated at the top level too).
  if (sites.length === 0) return { ok: false, reason: "the function is never called" };
  const funcEff = a.effectsOfFunction(funcName);
  const effects = body.map((s) => {
    const eff = newEffects();
    a.walkStmt(s, eff);
    return eff;
  });
  const planned: SecurityFuncScriptSite[] = [];
  for (let k = 0; k < sites.length; k++) {
    const site = sites[k]!;
    if (site.inFuncName !== null) return { ok: false, reason: "the function is called from another function" };
    const at = body.findIndex((s) => contains(s, site.call));
    if (at < 0) return { ok: false, reason: "the function's call is not in a top-level statement" };
    const siteEff = newEffects();
    let tupleArg = false;
    decl.params.forEach((p, pi) => {
      const arg = site.call.args[pi] ?? site.call.kwargs.find((kw) => kw.name === p.name)?.value ?? p.default;
      if (!arg) return;
      a.walkExpr(arg, siteEff);
      // A tuple is no argument (language_type-system.txt: a call of a function returning one "must
      // use a tuple declaration"), and the child could not record it.
      tupleArg ||= a.returnsTuple(arg);
    });
    if (tupleArg) return { ok: false, reason: "a call of the function passes a tuple" };
    const selfRead = declaredNames(body[at]!).find((n) => siteEff.reads.has(n));
    if (selfRead !== undefined) return { ok: false, reason: `the function's call reads '${selfRead}', which its own statement declares` };
    for (const n of funcEff.reads) siteEff.reads.add(n);
    for (const n of funcEff.muts) siteEff.muts.add(n);
    for (const g of funcEff.groups) siteEff.groups.push(g);
    const sliced = sliceBefore(a, body, effects, at, site.call, siteEff, foreignSymbol(k));
    if (!sliced.ok) return sliced;
    planned.push({ call: site.call, stmt: body[at]!, slice: sliced.slice });
  }
  return { ok: true, plan: { stmt: fstmt, sites: planned } };
}
