// A type check on what is certain: the type record of types/infer.ts (literals, built-in variables,
// operators, built-in calls with a plain return, once-introduced variables). Everything else is
// "unknown", and an unknown never produces a finding, so nothing here needs a guess: it catches a
// string where the language takes a number or a bool, and the reverse.
//
// docs/design/typed-ir.md, step 4. It began on literals alone; `literalType` is now the record.
//
// Rules, each from the manual's type system and operators pages (language_type-system.txt,
// language_operators.txt):
//   - a declared type and its initializer: `int x = "a"`, `string s = 1`, `bool b = "a"`;
//   - `:=` keeps the variable's type: `x = 1` then `x := "a"`;
//   - a condition is a bool: `if "a"`, `"a" ? 1 : 2`, `while "a"`;
//   - `not`, `and`, `or` take bools; `-`, `*`, `/`, `%` and unary `-` take numbers; `+` takes two
//     numbers or two strings; `<`, `>`, `<=`, `>=` take numbers;
//   - a history offset and a `for` bound are numbers: `close["a"]`, `for i = "a" to 5`;
//   - a built-in argument: `ta.sma(close, "5")`, `str.format(1)`, where every overload's parameter
//     at that position is plainly numeric or plainly a string.
// Numbers are not told apart (int for float is a qualifier and version question), and a number
// where a bool is expected is not reported: v5 casts it.
import type { Script } from "../ast";
import { BUILTIN_SIGNATURES } from "../builtins/signatures";
import { annotatedType, declaredType, dottedName, inferTypes, type ExprType } from "./infer";

export interface TypeFinding {
  name: string; // what the finding is about: a variable, an operator, a function
  line: number;
  message: string;
}

type T = ExprType;
type Node = Record<string, unknown> & { kind?: string; line?: number };

export function checkTypes(script: Script): TypeFinding[] {
  const out: TypeFinding[] = [];
  const report = (name: string, line: number | undefined, message: string): void => {
    out.push({ name, line: line ?? 0, message });
  };
  // The type record (types/infer.ts): literals, built-in variables, operators, built-in calls and
  // once-introduced variables. `literalType` keeps its name from the first slice, when it read
  // literals only.
  const types = inferTypes(script);
  const introduced = types.introduced;
  const literalType = (e: unknown): T => types.typeOf(e);

  const expectBool = (e: unknown, what: string, line: number | undefined): void => {
    if (literalType(e) === "string") report(what, line, `${what} takes a bool, not a string`);
  };
  const expectNumber = (e: unknown, what: string, line: number | undefined): void => {
    const t = literalType(e);
    if (t === "string" || t === "bool") report(what, line, `${what} takes a number, not a ${t}`);
  };

  const checkCall = (n: Node): void => {
    const name = dottedName(n.callee);
    if (name === null || introduced.has(name.split(".")[0]!)) return;
    const overloads = BUILTIN_SIGNATURES[name];
    if (overloads === undefined || overloads.some((o) => o.open === true || o.variadic !== undefined)) return;
    const judge = (arg: unknown, expected: T[], param: string): void => {
      const got = literalType(arg);
      if (got === "unknown" || expected.length === 0 || expected.includes("unknown")) return;
      const want = new Set(expected);
      if (want.size !== 1 || want.has(got)) return;
      const w = [...want][0]!;
      // Only the two confusions that no cast covers in any version.
      if ((w === "number" && got === "string") || (w === "string" && got === "number")) {
        report(name, n.line, `'${name}' takes a ${w} for '${param}', not a ${got}`);
      }
    };
    (n.args as unknown[]).forEach((arg, i) => {
      const at = overloads.map((o) => o.params.filter((p) => p.keywordOnly !== true)[i]);
      if (at.some((p) => p === undefined)) return;
      judge(arg, at.map((p) => annotatedType(p!.type)), at[0]!.name);
    });
    for (const kw of n.kwargs as { name: string; value: unknown }[]) {
      const at = overloads.map((o) => o.params.find((p) => p.name === kw.name));
      if (at.some((p) => p === undefined)) continue;
      judge(kw.value, at.map((p) => annotatedType(p!.type)), kw.name);
    }
  };

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const n = node as Node;
    switch (n.kind) {
      case "VarDecl":
      case "Assignment": {
        const name = n.name as string;
        const value = literalType(n.value);
        if (n.kind === "VarDecl" || n.operator === "=") {
          const declared = declaredType(n.typeHint as string | null);
          if (declared !== "unknown" && value !== "unknown" && declared !== value && !(declared === "bool" && value === "number")) {
            report(name, n.line, `'${name}' is declared ${String(n.typeHint).trim()} and initialized with a ${value}`);
          }
          types.settle(name, declared !== "unknown" ? declared : value);
        } else {
          const has = types.variable(name);
          if (has !== "unknown" && value !== "unknown" && has !== value && !(has === "bool" && value === "number")) {
            report(name, n.line, `':=' cannot give '${name}', a ${has}, a ${value}`);
          }
        }
        break;
      }
      case "IfStmt":
        expectBool(n.condition, "an `if` condition", n.line);
        for (const c of n.elifClauses as { condition: unknown }[]) expectBool(c.condition, "an `else if` condition", n.line);
        break;
      case "WhileStmt":
        expectBool(n.condition, "a `while` condition", n.line);
        break;
      case "TernaryOp":
        expectBool(n.condition, "a `?:` condition", n.line);
        break;
      case "UnaryOp":
        if (n.op === "not") expectBool(n.operand, "`not`", n.line);
        else expectNumber(n.operand, "unary `-`", n.line);
        break;
      case "BinOp": {
        const op = n.op as string;
        if (op === "and" || op === "or") {
          expectBool(n.left, `\`${op}\``, n.line);
          expectBool(n.right, `\`${op}\``, n.line);
        } else if (op === "-" || op === "*" || op === "/" || op === "%" || op === "<" || op === ">" || op === "<=" || op === ">=") {
          expectNumber(n.left, `\`${op}\``, n.line);
          expectNumber(n.right, `\`${op}\``, n.line);
        } else if (op === "+") {
          const l = literalType(n.left);
          const r = literalType(n.right);
          if ((l === "string" && r === "number") || (l === "number" && r === "string")) report("`+`", n.line, "`+` adds two numbers or joins two strings, not a number and a string");
        }
        break;
      }
      case "IndexAccess":
        if (literalType(n.index) === "string") report("[]", n.line, "a history offset is a number, not a string");
        break;
      case "ForStmt":
        expectNumber(n.start, "a `for` bound", n.line);
        expectNumber(n.end, "a `for` bound", n.line);
        if (n.step !== null) expectNumber(n.step, "a `for` step", n.line);
        break;
      case "CallExpr":
        checkCall(n);
        break;
    }
    for (const [key, child] of Object.entries(n)) {
      if (key !== "line" && key !== "col" && key !== "kind") visit(child);
    }
  };
  visit(script.body);
  return out.sort((a, b) => a.line - b.line);
}
