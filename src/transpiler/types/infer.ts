// A type for every expression that has an evident one: docs/design/typed-ir.md's record, built from
// what needs no analyzer. Bottom-up over the parsed script:
//   - literals;
//   - built-in variables (the analyzer's own name tables: prices and volume are numbers, syminfo's
//     string properties strings, barstate's bools, color.* colors, ...);
//   - operators, by the manual's rules (language_operators.txt): arithmetic of two numbers is a
//     number, `+` of two strings a string, comparisons and `not`/`and`/`or` bools, `?:` the type its
//     two branches share;
//   - built-in calls, from the signature table's return annotation where it is plain
//     (`PyneFloat`, `PyneInt`, `str`, `bool`, `Color`); a polymorphic or unannotated return is unknown;
//   - `x[n]`: the type of `x`;
//   - variables: the declared type, or the type of the initializer, for a name the whole script
//     introduces exactly once (scopes are not modelled: a name introduced twice is unknown).
// Everything else is "unknown": a user function's result, a parameter, a tuple, a collection's
// element. An unknown is never an error and never trusted. Numbers are one kind here: int against
// float is a qualifier and version question the checker does not ask yet.
//
// Used by types/check.ts. The analyzer still runs its own piecemeal inference (inferQualifier,
// inferNumType, isStringExpr); moving it onto this record is the design's step 2.
import type { Script } from "../ast";
import {
  BARSTATE_PROPS,
  BAR_INDEX_NAME,
  BAR_SERIES_NAMES,
  BID_ASK_NAMES,
  COLOR_CONSTANTS,
  DERIVED_PRICE_NAMES,
  MATH_CONSTANTS,
  SYMINFO_NUMBER_PROPS,
  SYMINFO_STRING_PROPS,
  TIMEFRAME_BOOLEAN_PROPS,
  TIMEFRAME_STRING_PROPS,
  TIME_VAR_NAMES,
} from "../analyzer";
import { BUILTIN_SIGNATURES } from "../builtins/signatures";

export type KnownType = "number" | "string" | "bool" | "color";
export type ExprType = KnownType | "unknown";

type Node = Record<string, unknown> & { kind?: string; line?: number };

const QUALIFIERS = /^(?:const|input|simple|series)\s+/;

export function declaredType(hint: string | null | undefined): ExprType {
  if (hint === null || hint === undefined) return "unknown";
  const base = hint.trim().replace(QUALIFIERS, "");
  if (base === "int" || base === "float") return "number";
  if (base === "string" || base === "bool" || base === "color") return base;
  return "unknown";
}

// The oracle's annotation, when it leaves no doubt (a parameter's or a return's).
export function annotatedType(annotation: string): ExprType {
  const parts = annotation.split("|").map((p) => p.trim()).filter((p) => p !== "" && p !== "None" && !/^NA\b/.test(p));
  if (parts.length === 0) return "unknown";
  const one = (p: string): ExprType =>
    /^(int|float|PyneInt|PyneFloat|Series\[(int|float)\]|Series\[int \| float\])$/.test(p)
      ? "number"
      : /^(str|PyneStr|Series\[str\])$/.test(p)
        ? "string"
        : /^(bool|PyneBool)$/.test(p)
          ? "bool"
          : /^(Color|_color\.Color)$/.test(p)
            ? "color"
            : "unknown";
  const kinds = new Set(parts.map(one));
  return kinds.size === 1 ? [...kinds][0]! : "unknown";
}

export function dottedName(e: unknown): string | null {
  const node = e as Node | null;
  if (node === null || typeof node !== "object") return null;
  if (node.kind === "Identifier") return (node.name as string) ?? null;
  if (node.kind === "DotAccess") {
    const head = dottedName(node.obj);
    return head === null ? null : `${head}.${node.attr as string}`;
  }
  return null;
}

function builtinVariableType(name: string): ExprType {
  if (BAR_SERIES_NAMES.has(name) || DERIVED_PRICE_NAMES.has(name) || name === BAR_INDEX_NAME || TIME_VAR_NAMES.has(name) || BID_ASK_NAMES.has(name)) return "number";
  const dot = name.indexOf(".");
  if (dot < 0) return "unknown";
  const ns = name.slice(0, dot);
  const attr = name.slice(dot + 1);
  if (ns === "color" && COLOR_CONSTANTS.has(attr)) return "color";
  if (ns === "math" && MATH_CONSTANTS.has(attr)) return "number";
  if (ns === "syminfo" && SYMINFO_STRING_PROPS.has(attr)) return "string";
  if (ns === "syminfo" && SYMINFO_NUMBER_PROPS.has(attr)) return "number";
  if (ns === "barstate" && BARSTATE_PROPS.has(attr)) return "bool";
  if (ns === "timeframe" && TIMEFRAME_STRING_PROPS.has(attr)) return "string";
  if (ns === "timeframe" && TIMEFRAME_BOOLEAN_PROPS.has(attr)) return "bool";
  return "unknown";
}

export interface TypeRecord {
  typeOf(expr: unknown): ExprType;
  // Names the script introduces (a variable, a function, a parameter, an import alias, a loop
  // variable), with how many times.
  introduced: ReadonlyMap<string, number>;
  // The settled type of a once-introduced variable, as known so far in source order.
  variable(name: string): ExprType;
  // Called by the checker as it walks declarations in source order.
  settle(name: string, type: ExprType): void;
}

export function inferTypes(script: Script): TypeRecord {
  const introduced = new Map<string, number>();
  const settled = new Map<string, KnownType>();
  const cache = new Map<unknown, ExprType>();

  const collect = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    const n = node as Node;
    const introduce = (name: unknown): void => {
      if (typeof name === "string") introduced.set(name, (introduced.get(name) ?? 0) + 1);
    };
    switch (n.kind) {
      case "VarDecl":
        introduce(n.name);
        break;
      case "Assignment":
        if (n.operator === "=") introduce(n.name);
        break;
      case "FuncDecl":
      case "MethodDecl":
      case "TypeDecl":
      case "EnumDecl":
      case "FuncParam":
        introduce(n.name);
        break;
      case "ImportDecl":
        introduce(n.alias);
        break;
      case "ForStmt":
        introduce(n.varName);
        break;
      case "ForInStmt":
        introduce(n.varName);
        introduce(n.indexName);
        break;
      case "TupleDestructure":
        if (Array.isArray(n.names)) for (const name of n.names) introduce(name);
        break;
    }
    for (const [key, child] of Object.entries(n)) {
      if (key !== "line" && key !== "col" && key !== "kind") collect(child);
    }
  };
  collect(script.body);

  const variable = (name: string): ExprType => (introduced.get(name) === 1 ? settled.get(name) ?? "unknown" : "unknown");

  const compute = (n: Node): ExprType => {
    switch (n.kind) {
      case "NumberLiteral":
        return "number";
      case "StringLiteral":
        return "string";
      case "BoolLiteral":
        return "bool";
      case "ColorLiteral":
        return "color";
      case "Identifier": {
        const name = n.name as string;
        return introduced.has(name) ? variable(name) : builtinVariableType(name);
      }
      case "DotAccess": {
        const name = dottedName(n);
        if (name === null || introduced.has(name.split(".")[0]!)) return "unknown";
        return builtinVariableType(name);
      }
      case "UnaryOp": {
        const t = typeOf(n.operand);
        if (n.op === "not") return "bool";
        return t === "number" ? "number" : "unknown";
      }
      case "BinOp": {
        const op = n.op as string;
        if (op === "and" || op === "or" || op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") return "bool";
        const l = typeOf(n.left);
        const r = typeOf(n.right);
        if (l === "number" && r === "number") return "number";
        if (op === "+" && l === "string" && r === "string") return "string";
        return "unknown";
      }
      case "TernaryOp": {
        const a = typeOf(n.trueExpr);
        const b = typeOf(n.falseExpr);
        return a === b ? a : "unknown";
      }
      case "IndexAccess":
        return typeOf(n.obj);
      case "CallExpr": {
        const name = dottedName(n.callee);
        if (name === null || introduced.has(name.split(".")[0]!)) return "unknown";
        const overloads = BUILTIN_SIGNATURES[name];
        if (overloads === undefined) return "unknown";
        const kinds = new Set(overloads.map((o) => annotatedType(o.returns)));
        return kinds.size === 1 ? [...kinds][0]! : "unknown";
      }
      default:
        return "unknown";
    }
  };

  function typeOf(e: unknown): ExprType {
    if (e === null || typeof e !== "object") return "unknown";
    const n = e as Node;
    // A variable read depends on what has been settled so far, so identifiers are not cached.
    if (n.kind === "Identifier") return compute(n);
    const hit = cache.get(e);
    if (hit !== undefined) return hit;
    const t = compute(n);
    cache.set(e, t);
    return t;
  }

  return {
    typeOf,
    introduced,
    variable,
    settle(name, type) {
      if (type !== "unknown" && introduced.get(name) === 1) settled.set(name, type);
    },
  };
}
