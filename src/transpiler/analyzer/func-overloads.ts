// Function overload resolution prepass (C686 arity-disjoint sets; typed same-arity sets).
//
// Pine accepts several top-level functions under one name when their signatures differ
// (language_user-defined-functions.txt, "Function overloading"): "a function overload is valid
// only if its definition satisfies one of the following conditions: It has a different number of
// required parameters (...) than that of any other defined overload. It has the same number of
// required parameters as another overload, but at least one required parameter has a different
// qualified type than the one declared at the same position in the other overload's header."
//
// Design: this runs before every other analyzer prepass (all of them are keyed by name). It renames
// the 2nd+ declarations of a valid overload set to `name$ov$k` (k = 2, 3, ...) and rewires every
// call site to the overload it calls, so the rest of the pipeline only ever sees distinct functions.
// `$` is not a lexer identifier character, so the names never collide with user names, and
// mangleMethodName("Type$method") has exactly one `$`, so it never collides with `$ov$` either.
//
// A call site picks its overload in two steps:
//   (1) arity: the overloads whose [required, total] parameter range holds the call's argument
//       count (positional + keyword). A set whose ranges are pairwise disjoint always stops here
//       (the C686 behaviour, unchanged).
//   (2) type: when several overloads fit the count, the argument types decide. They are inferred
//       from the AST alone (literals, declared types, parameters' type keywords, UDT fields, the
//       values functions return, a small table of built-ins); an int argument may go to a float
//       parameter (the one automatic cast), and an exact match beats it. A call whose types cannot
//       be told apart gets an explicit error instead of a guess.
// Inside an overload's own body only the overloads declared before it are candidates: "function
// overloads can contain calls to overloads with the same function name in their bodies, but only
// if those overloads are defined first. However, just like non-overloaded functions, an overload
// cannot use calls to itself within its body."
//
// Safety gates (a wrong dispatch would be a silent wrong answer, a rejection is not):
// - A set with two overloads whose ranges overlap is accepted only if some parameter position
//   that both require carries a type keyword in both headers, and the types differ. Parameters
//   without a type keyword, or two headers differing only by qualifier, leave the set alone, and
//   registerFuncSignature's "name conflicts with an existing declaration" error stands.
// - A name that also has a same-name MethodDecl is left alone: bare method calls dispatch on the
//   first argument's type in the analyzer (C676), which would interact with the rename.
// - A call site matching no overload's count keeps the first declaration's name, which reports the
//   standard arity error.

import type { CallExpr, Expr, FuncDecl, FuncParam, MethodDecl, Script, Stmt } from "../ast";
import { stripParamQualifierPrefix } from "./udt-types";

// Same computation as registerFuncSignature: required = 1-based index of the last parameter without
// a default (C565: defaults need not trail), max = the parameter count.
function arityRange(decl: FuncDecl): [number, number] {
  let required = 0;
  decl.params.forEach((p, i) => {
    if (p.default === null) required = i + 1;
  });
  return [required, decl.params.length];
}

// A type as this prepass knows it: "int", "float", "bool", "string", "color", a UDT or enum name, a
// drawing kind, "array<T>", "map<K,V>" (K may be "?", map.new<K, V>() keeps only V) or "na" (the
// untyped na literal). null means unknown.
type Ty = string | null;

function normType(hint: string | null): Ty {
  if (hint === null) return null;
  return stripParamQualifierPrefix(hint).replace(/\s+/g, "");
}

// Two overloads with overlapping ranges are told apart by a position both require whose declared
// types differ.
function distinguishable(a: FuncDecl, ra: [number, number], b: FuncDecl, rb: [number, number]): boolean {
  const shared = Math.min(ra[0], rb[0]);
  for (let i = 0; i < shared; i++) {
    const ha = a.params[i]!.typeHint;
    const hb = b.params[i]!.typeHint;
    if (ha === null || hb === null) continue;
    if (normType(ha) !== normType(hb)) return true;
  }
  return false;
}

function isValidOverloadSet(decls: FuncDecl[], ranges: [number, number][]): boolean {
  for (let i = 0; i < decls.length; i++) {
    for (let j = i + 1; j < decls.length; j++) {
      const disjoint = ranges[i]![1] < ranges[j]![0] || ranges[j]![1] < ranges[i]![0];
      if (!disjoint && !distinguishable(decls[i]!, ranges[i]!, decls[j]!, ranges[j]!)) return false;
    }
  }
  return true;
}

function splitGeneric(t: string): { base: string; args: string[] } | null {
  const lt = t.indexOf("<");
  if (lt === -1 || !t.endsWith(">")) return null;
  const args: string[] = [];
  let depth = 0;
  let start = lt + 1;
  for (let i = lt + 1; i < t.length - 1; i++) {
    const c = t[i];
    if (c === "<") depth++;
    else if (c === ">") depth--;
    else if (c === "," && depth === 0) {
      args.push(t.slice(start, i));
      start = i + 1;
    }
  }
  args.push(t.slice(start, t.length - 1));
  return { base: t.slice(0, lt), args };
}

type Fit = "exact" | "cast" | "maybe" | "no";

// How an argument of type `arg` fits a parameter declared as `param` (null: no type keyword).
function fit(arg: Ty, param: Ty): Fit {
  if (param === null) return "exact";
  if (arg === null || arg === "na") return "maybe";
  if (arg === param) return "exact";
  if (arg === "int" && param === "float") return "cast";
  const ga = splitGeneric(arg);
  const gp = splitGeneric(param);
  if (ga !== null && gp !== null && ga.base === gp.base && ga.args.length === gp.args.length) {
    let unknown = false;
    for (let i = 0; i < ga.args.length; i++) {
      if (ga.args[i] === "?") unknown = true;
      else if (ga.args[i] !== gp.args[i]) return "no";
    }
    return unknown ? "maybe" : "exact";
  }
  return "no";
}

const FLOAT_SERIES = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "hlcc4"]);
const INT_SERIES = new Set([
  "bar_index", "last_bar_index", "time", "time_close", "timenow", "last_bar_time",
  "year", "month", "weekofyear", "dayofmonth", "dayofweek", "hour", "minute", "second",
]);
const TA_FLOAT = new Set([
  "sma", "ema", "rma", "wma", "vwma", "hma", "alma", "swma", "linreg", "cci", "rsi", "mfi", "atr",
  "stdev", "variance", "dev", "mom", "roc", "cmo", "highest", "lowest", "median", "percentrank",
  "percentile_linear_interpolation", "percentile_nearest_rank", "stoch", "wpr", "cog", "sar",
  "correlation", "tsi", "rci", "mode", "range", "cum", "vwap",
]);
const TA_BOOL = new Set(["crossover", "crossunder", "cross", "rising", "falling"]);
const TA_INT = new Set(["barssince", "highestbars", "lowestbars"]);
const MATH_FLOAT = new Set([
  "sqrt", "log", "log10", "exp", "pow", "sin", "cos", "tan", "asin", "acos", "atan", "avg",
  "random", "todegrees", "toradians", "round_to_mintick",
]);
const MATH_INT = new Set(["round", "floor", "ceil"]);
const MATH_KEEP = new Set(["abs", "max", "min", "sum", "sign"]);
const STR_STRING = new Set([
  "tostring", "format", "format_time", "substring", "replace", "replace_all", "upper", "lower",
  "trim", "repeat",
]);
const STR_BOOL = new Set(["contains", "startswith", "endswith", "match"]);
const INPUT_TYPES: Record<string, string> = {
  int: "int", float: "float", bool: "bool", string: "string", color: "color", source: "float",
  price: "float", time: "int", timeframe: "string", session: "string", symbol: "string",
  text_area: "string",
};
const CASTS = new Set(["int", "float", "bool", "color", "string", "line", "label", "box", "table", "linefill", "polyline"]);
const DRAWINGS = new Set(["line", "label", "box", "table", "linefill", "polyline"]);
const ARRAY_NEW_PRIMITIVE: Record<string, string> = {
  new_float: "float", new_int: "int", new_bool: "bool", new_string: "string", new_color: "color",
  new_line: "line", new_label: "label", new_box: "box", new_table: "table", new_linefill: "linefill",
};

function numeric(a: Ty, b: Ty): Ty {
  if ((a === "int" || a === "float") && (b === "int" || b === "float")) return a === "float" || b === "float" ? "float" : "int";
  return null;
}

interface TyScope {
  parent: TyScope | null;
  names: Map<string, Ty>;
  // The function whose body this scope belongs to (null at the top level).
  func: FuncDecl | MethodDecl | null;
}

interface OverloadSet {
  decls: FuncDecl[];
  ranges: [number, number][];
}

// Returns the errors of call sites whose overload cannot be determined.
export function resolveFuncOverloads(script: Script): string[] {
  const funcDecls = new Map<string, FuncDecl[]>();
  const methodNames = new Set<string>();
  const methodsByReceiver = new Map<string, MethodDecl>();
  const udtFields = new Map<string, Map<string, Ty>>();
  const enumNames = new Set<string>();
  const globals = new Map<string, Stmt>();
  for (const stmt of script.body) {
    if (stmt.kind === "FuncDecl") {
      const list = funcDecls.get(stmt.name);
      if (list === undefined) funcDecls.set(stmt.name, [stmt]);
      else list.push(stmt);
    } else if (stmt.kind === "MethodDecl") {
      methodNames.add(stmt.name);
      const recv = normType(stmt.params[0]?.typeHint ?? null);
      if (recv !== null) methodsByReceiver.set(`${recv}.${stmt.name}`, stmt);
    } else if (stmt.kind === "TypeDecl") {
      udtFields.set(stmt.name, new Map(stmt.fields.map((f) => [f.name, normType(f.typeHint)])));
    } else if (stmt.kind === "EnumDecl") {
      enumNames.add(stmt.name);
    } else if (stmt.kind === "VarDecl" || (stmt.kind === "Assignment" && stmt.operator === "=")) {
      globals.set(stmt.name, stmt);
    } else if (stmt.kind === "TupleDestructure") {
      for (const n of stmt.names) globals.set(n, stmt);
    }
  }

  const overloadSets = new Map<string, OverloadSet>();
  for (const [name, decls] of funcDecls) {
    if (decls.length < 2 || methodNames.has(name)) continue;
    const ranges = decls.map(arityRange);
    if (!isValidOverloadSet(decls, ranges)) continue;
    overloadSets.set(name, { decls, ranges });
  }
  if (overloadSets.size === 0) return [];

  // The first declaration keeps the original name (the call sites matching no range report their
  // arity error against it).
  for (const [name, { decls }] of overloadSets) {
    for (let i = 1; i < decls.length; i++) {
      decls[i]!.name = `${name}$ov$${i + 1}`;
    }
  }

  const errors: string[] = [];
  const resolved = new Map<CallExpr, FuncDecl | null>();
  const returnTypes = new Map<FuncDecl | MethodDecl, Ty>();
  const walking = new Set<FuncDecl | MethodDecl>();
  const globalTypes = new Map<string, Ty>();
  const globalPending = new Set<string>();
  const globalScope: TyScope = { parent: null, names: new Map(), func: null };

  const lookup = (scope: TyScope, name: string): Ty | undefined => {
    for (let s: TyScope | null = scope; s !== null; s = s.parent) {
      if (s.names.has(name)) return s.names.get(name)!;
    }
    const decl = globals.get(name);
    if (decl === undefined) return undefined;
    if (globalTypes.has(name)) return globalTypes.get(name)!;
    if (globalPending.has(name)) return null;
    globalPending.add(name);
    const t = decl.kind === "VarDecl" || decl.kind === "Assignment" ? declaredType(decl.typeHint, decl.value, globalScope) : null;
    globalPending.delete(name);
    globalTypes.set(name, t);
    return t;
  };

  const declaredType = (hint: string | null, value: Expr, scope: TyScope): Ty => {
    if (hint !== null) return normType(hint);
    const t = typeOf(value, scope);
    return t === "na" ? null : t;
  };

  const fieldType = (objType: Ty, field: string): Ty => {
    if (objType === null) return null;
    return udtFields.get(objType)?.get(field) ?? null;
  };

  const elemType = (container: Ty, index: number): Ty => {
    if (container === null) return null;
    const g = splitGeneric(container);
    if (g === null) return null;
    const t = g.args[index];
    return t === undefined || t === "?" ? null : t;
  };

  const returnType = (decl: FuncDecl | MethodDecl): Ty => {
    walkFunc(decl);
    return returnTypes.get(decl) ?? null;
  };

  const typeOfCall = (call: CallExpr, scope: TyScope): Ty => {
    const callee = call.callee;
    const arg0 = call.args[0];
    if (callee.kind === "Identifier") {
      const name = callee.name;
      if (overloadSets.has(name) || resolved.has(call)) {
        const decl = resolveCall(call, scope);
        return decl === null ? null : returnType(decl);
      }
      const decls = funcDecls.get(name);
      if (decls !== undefined) return returnType(decls[0]!);
      if (CASTS.has(name)) return name;
      if (name === "na") return "bool";
      if (name === "nz" || name === "fixnan") return arg0 === undefined ? null : declaredType(null, arg0, scope);
      if (name === "time" || name === "time_close" || name === "timestamp") return "int";
      if (name === "input") return arg0 === undefined ? null : declaredType(null, arg0, scope);
      return null;
    }
    const method = callee.attr;
    const obj = callee.obj;
    const ns = obj.kind === "Identifier" && lookup(scope, obj.name) === undefined ? obj.name : null;
    if (ns !== null) {
      if (udtFields.has(ns)) return method === "new" ? ns : method === "copy" ? ns : null;
      switch (ns) {
        case "ta":
          if (TA_FLOAT.has(method)) return "float";
          if (TA_BOOL.has(method)) return "bool";
          if (TA_INT.has(method)) return "int";
          if (method === "change" || method === "valuewhen") return arg0 === undefined ? null : typeOf(arg0, scope);
          return null;
        case "math": {
          if (MATH_FLOAT.has(method)) return "float";
          if (MATH_INT.has(method)) return "int";
          if (!MATH_KEEP.has(method)) return null;
          let t: Ty = "int";
          for (const a of call.args) t = numeric(t, typeOf(a, scope));
          return method === "sign" && t !== null ? "float" : t;
        }
        case "str":
          if (STR_STRING.has(method)) return "string";
          if (STR_BOOL.has(method)) return "bool";
          if (method === "length" || method === "pos") return "int";
          if (method === "tonumber") return "float";
          if (method === "split") return "array<string>";
          return null;
        case "input":
          return INPUT_TYPES[method] ?? null;
        case "color":
          return method === "new" || method === "rgb" || method === "from_gradient" ? "color" : null;
        case "array": {
          const prim = ARRAY_NEW_PRIMITIVE[method];
          if (prim !== undefined) return `array<${prim}>`;
          if (method === "new_generic") return callee.genericElemType !== undefined ? `array<${callee.genericElemType}>` : null;
          if (method === "from") {
            const t = arg0 === undefined ? null : typeOf(arg0, scope);
            return t === null || t === "na" ? null : `array<${t}>`;
          }
          return arg0 === undefined ? null : containerMethodType(typeOf(arg0, scope), method);
        }
        case "map":
          if (method === "new") return callee.genericElemType !== undefined ? `map<?,${callee.genericElemType}>` : null;
          return arg0 === undefined ? null : containerMethodType(typeOf(arg0, scope), method);
        default:
          if (DRAWINGS.has(ns) && method === "new") return ns;
          return null;
      }
    }
    // A method call on a value: `obj.copy()`, `arr.get(i)`, `m.get(k)`, a user-defined method.
    const recv = typeOf(obj, scope);
    if (recv === null) return null;
    const userMethod = methodsByReceiver.get(`${recv}.${method}`) ?? methodsByReceiver.get(`${splitGeneric(recv)?.base}.${method}`);
    if (userMethod !== undefined) return returnType(userMethod);
    if (udtFields.has(recv)) return method === "copy" ? recv : null;
    return containerMethodType(recv, method);
  };

  const containerMethodType = (container: Ty, method: string): Ty => {
    if (container === null) return null;
    const g = splitGeneric(container);
    if (g === null) return null;
    if (method === "size") return "int";
    if (method === "copy" || method === "slice") return container;
    if (g.base === "array") {
      if (["get", "first", "last", "pop", "shift", "remove"].includes(method)) return elemType(container, 0);
      if (method === "includes") return "bool";
      if (method === "indexof" || method === "lastindexof") return "int";
      return null;
    }
    if (g.base === "map") {
      if (method === "get" || method === "remove") return elemType(container, 1);
      if (method === "contains") return "bool";
      if (method === "keys") return g.args[0] === "?" ? null : `array<${g.args[0]}>`;
      if (method === "values") return `array<${g.args[1]}>`;
    }
    return null;
  };

  const typeOf = (expr: Expr, scope: TyScope): Ty => {
    switch (expr.kind) {
      case "NumberLiteral":
        return /[.eE]/.test(expr.raw) ? "float" : "int";
      case "StringLiteral":
        return "string";
      case "BoolLiteral":
        return "bool";
      case "ColorLiteral":
        return "color";
      case "NaLiteral":
        return "na";
      case "Identifier": {
        const t = lookup(scope, expr.name);
        if (t !== undefined) return t;
        if (FLOAT_SERIES.has(expr.name)) return "float";
        if (INT_SERIES.has(expr.name)) return "int";
        return null;
      }
      case "IndexAccess":
        return typeOf(expr.obj, scope);
      case "UnaryOp": {
        if (expr.op === "not") return "bool";
        const t = typeOf(expr.operand, scope);
        return t === "int" || t === "float" ? t : null;
      }
      case "BinOp": {
        if (["==", "!=", "<", ">", "<=", ">=", "and", "or"].includes(expr.op)) return "bool";
        const l = typeOf(expr.left, scope);
        const r = typeOf(expr.right, scope);
        if (expr.op === "+" && (l === "string" || r === "string")) return "string";
        // int / int is version-dependent (v5 const ints, v6): leave it unknown.
        if (expr.op === "/") return l === "float" || r === "float" ? numeric(l, r) : null;
        return numeric(l, r);
      }
      case "TernaryOp": {
        const a = typeOf(expr.trueExpr, scope);
        const b = typeOf(expr.falseExpr, scope);
        if (a === b) return a;
        if (a === "na") return b;
        if (b === "na") return a;
        return numeric(a, b);
      }
      case "DotAccess": {
        if (expr.obj.kind === "Identifier" && lookup(scope, expr.obj.name) === undefined) {
          const ns = expr.obj.name;
          if (enumNames.has(ns)) return ns;
          if (ns === "color") return "color";
          if (ns === "barstate") return "bool";
          if (ns === "timeframe" && expr.attr === "period") return "string";
          return null;
        }
        return fieldType(typeOf(expr.obj, scope), expr.attr);
      }
      case "CallExpr":
        return typeOfCall(expr, scope);
      default:
        return null;
    }
  };

  // The overload a call site calls, or null when it cannot be decided (an error is recorded) or no
  // overload has the call's argument count (the first declaration reports it).
  const resolveCall = (call: CallExpr, scope: TyScope): FuncDecl | null => {
    if (resolved.has(call)) return resolved.get(call)!;
    const callee = call.callee;
    if (callee.kind !== "Identifier") return null;
    const set = overloadSets.get(callee.name)!;
    const total = call.args.length + call.kwargs.length;
    const own = scope.func !== null && scope.func.kind === "FuncDecl" ? set.decls.indexOf(scope.func) : -1;
    const visible = own >= 0 ? set.decls.slice(0, own) : set.decls;
    let candidates = visible.filter((d) => {
      const [min, max] = set.ranges[set.decls.indexOf(d)]!;
      return total >= min && total <= max;
    });
    let chosen: FuncDecl | null = null;
    if (candidates.length === 1) {
      chosen = candidates[0]!;
    } else if (candidates.length > 1) {
      candidates = candidates.filter((d) => call.kwargs.every((k) => d.params.some((p) => p.name === k.name)));
      const argTypes = call.args.map((a) => typeOf(a, scope));
      const kwargTypes = call.kwargs.map((k) => typeOf(k.value, scope));
      const scored = candidates.map((d) => {
        const fits: Fit[] = argTypes.map((t, i) => fit(t, normType(d.params[i]!.typeHint)));
        call.kwargs.forEach((k, i) => {
          const p = d.params.find((q: FuncParam) => q.name === k.name)!;
          fits.push(fit(kwargTypes[i]!, normType(p.typeHint)));
        });
        return { d, fits };
      });
      const possible = scored.filter((s) => !s.fits.includes("no"));
      if (possible.length === 1) {
        chosen = possible[0]!.d;
      } else if (possible.length > 1 && possible.every((s) => !s.fits.includes("maybe"))) {
        const casts = possible.map((s) => s.fits.filter((f) => f === "cast").length);
        const least = Math.min(...casts);
        const best = possible.filter((_, i) => casts[i] === least);
        if (best.length === 1) chosen = best[0]!.d;
      }
      if (chosen === null) {
        errors.push(
          possible.length === 0
            ? `no '${callee.name}' overload accepts these argument types (L${call.line}:${call.col})`
            : `cannot determine which '${callee.name}' overload this call uses: the argument types match more than one or are not known (L${call.line}:${call.col})`,
        );
      }
    }
    resolved.set(call, chosen);
    if (chosen !== null) callee.name = chosen.name;
    return chosen;
  };

  const walkExpr = (expr: Expr, scope: TyScope): void => {
    switch (expr.kind) {
      case "CallExpr":
        if (expr.callee.kind === "DotAccess") walkExpr(expr.callee.obj, scope);
        for (const a of expr.args) walkExpr(a, scope);
        for (const k of expr.kwargs) walkExpr(k.value, scope);
        if (expr.callee.kind === "Identifier" && overloadSets.has(expr.callee.name)) resolveCall(expr, scope);
        return;
      case "BinOp":
        walkExpr(expr.left, scope);
        walkExpr(expr.right, scope);
        return;
      case "UnaryOp":
        walkExpr(expr.operand, scope);
        return;
      case "TernaryOp":
        walkExpr(expr.condition, scope);
        walkExpr(expr.trueExpr, scope);
        walkExpr(expr.falseExpr, scope);
        return;
      case "DotAccess":
        walkExpr(expr.obj, scope);
        return;
      case "IndexAccess":
        walkExpr(expr.obj, scope);
        walkExpr(expr.index, scope);
        return;
      case "TupleExpr":
        for (const e of expr.elements) walkExpr(e, scope);
        return;
      case "IfStmt":
      case "ForStmt":
      case "WhileStmt":
      case "SwitchStmt":
        walkStmt(expr, scope);
        return;
      default:
        return;
    }
  };

  const child = (scope: TyScope): TyScope => ({ parent: scope, names: new Map(), func: scope.func });

  const walkBody = (body: Stmt[], scope: TyScope): void => {
    for (const s of body) walkStmt(s, scope);
  };

  const walkStmt = (stmt: Stmt, scope: TyScope): void => {
    switch (stmt.kind) {
      case "VarDecl":
        walkExpr(stmt.value, scope);
        if (scope !== globalScope) scope.names.set(stmt.name, declaredType(stmt.typeHint, stmt.value, scope));
        return;
      case "Assignment":
        walkExpr(stmt.value, scope);
        if (stmt.operator === "=" && scope !== globalScope) scope.names.set(stmt.name, declaredType(stmt.typeHint, stmt.value, scope));
        return;
      case "TupleDestructure":
        walkExpr(stmt.value, scope);
        if (scope !== globalScope) for (const n of stmt.names) scope.names.set(n, null);
        return;
      case "ExprStmt":
        walkExpr(stmt.expr, scope);
        return;
      case "FieldAssignment":
        walkExpr(stmt.object, scope);
        walkExpr(stmt.value, scope);
        return;
      case "IfStmt":
        walkExpr(stmt.condition, scope);
        walkBody(stmt.thenBody, child(scope));
        for (const e of stmt.elifClauses) {
          walkExpr(e.condition, scope);
          walkBody(e.body, child(scope));
        }
        if (stmt.elseBody !== null) walkBody(stmt.elseBody, child(scope));
        return;
      case "ForStmt": {
        walkExpr(stmt.start, scope);
        walkExpr(stmt.end, scope);
        if (stmt.step !== null) walkExpr(stmt.step, scope);
        const s = child(scope);
        const bounds = [stmt.start, stmt.end, ...(stmt.step !== null ? [stmt.step] : [])].map((e) => typeOf(e, scope));
        s.names.set(stmt.varName, bounds.reduce<Ty>((acc, t) => numeric(acc, t), "int"));
        walkBody(stmt.body, s);
        return;
      }
      case "ForInStmt": {
        walkExpr(stmt.iterable, scope);
        const s = child(scope);
        const it = typeOf(stmt.iterable, scope);
        const g = it === null ? null : splitGeneric(it);
        if (g !== null && g.base === "map") {
          if (stmt.indexName !== null) s.names.set(stmt.indexName, elemType(it, 0));
          s.names.set(stmt.varName, elemType(it, 1));
        } else {
          if (stmt.indexName !== null) s.names.set(stmt.indexName, "int");
          s.names.set(stmt.varName, g !== null && g.base === "array" ? elemType(it, 0) : null);
        }
        walkBody(stmt.body, s);
        return;
      }
      case "WhileStmt":
        walkExpr(stmt.condition, scope);
        walkBody(stmt.body, child(scope));
        return;
      case "SwitchStmt":
        if (stmt.subject !== null) walkExpr(stmt.subject, scope);
        for (const c of stmt.cases) {
          if (c.values !== null) for (const v of c.values) walkExpr(v, scope);
          walkBody(c.body, child(scope));
        }
        return;
      case "FuncDecl":
      case "MethodDecl":
        walkFunc(stmt);
        return;
      case "TypeDecl":
        for (const f of stmt.fields) if (f.default !== null) walkExpr(f.default, scope);
        return;
      default:
        return;
    }
  };

  // Walks a function body once: resolves the call sites in it and records the type of the value it
  // returns (its last statement's).
  const walkFunc = (decl: FuncDecl | MethodDecl): void => {
    if (returnTypes.has(decl) || walking.has(decl)) return;
    walking.add(decl);
    const scope: TyScope = { parent: globalScope, names: new Map(), func: decl };
    for (const p of decl.params) {
      if (p.default !== null) walkExpr(p.default, globalScope);
      scope.names.set(p.name, p.typeHint !== null ? normType(p.typeHint) : null);
    }
    walkBody(decl.body, scope);
    const last = decl.body[decl.body.length - 1];
    let t: Ty = null;
    if (last !== undefined) {
      if (last.kind === "ExprStmt") t = typeOf(last.expr, scope);
      else if (last.kind === "VarDecl" || (last.kind === "Assignment" && last.operator === "=")) t = scope.names.get(last.name) ?? null;
      else if (last.kind === "Assignment") t = typeOf({ kind: "Identifier", name: last.name, line: last.line, col: last.col }, scope);
    }
    walking.delete(decl);
    returnTypes.set(decl, t === "na" ? null : t);
  };

  walkBody(script.body, globalScope);
  return errors;
}
