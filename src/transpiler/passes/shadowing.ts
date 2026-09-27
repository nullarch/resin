// Scope pass, run on the parsed script before analysis: a declaration in a local block that
// shadows a variable its own block has already read gets a JS name of its own.
//
// Pine resolves a name to the declaration visible where it stands. A local declaration
// (`x = ...`, `Type x = ...`, `var x = ...`, `[x, y] = ...`) makes a new variable ("It means *this
// is a new variable*", ref_v6_lang.txt OPERATOR =) that exists from that statement on; before it,
// and in its own initializer, the name still means the variable of the enclosing scope — a
// function "can access any global variables declared above its definition"
// (language_user-defined-functions.txt "Function scopes"). So in
//
//     mode = input.string("None")
//     norm(v) =>
//         mode = switch mode      // the switch reads the global `mode`
//             "Max" => v / 2
//             => v
//
// the switch subject is the global. A JS `let` covers its whole block instead (the temporal dead
// zone), so emitting the local under its Pine name made that read throw "Cannot access 'mode'
// before initialization" (resin-harness realworld b17655fc60c9, repro
// state/repros/shadow-self-init.json).
//
// Only such declarations are renamed: one whose block (at any depth, the initializer included)
// read or reassigned the outer variable of that name before it. The new name is `name$N`; `$`
// cannot appear in a Pine identifier, so it collides with no user name nor with resin's own
// `$fn`/`Type$method` names. Every later read and reassignment the declaration's scope resolves to
// it is renamed with it, so the analyzer and codegen see two distinct variables. Programs without
// the pattern are left untouched.
import type { Expr, FuncParam, IfStmt, Script, Stmt, SwitchStmt } from "../ast";

interface Scope {
  parent: Scope | null;
  // Pine name -> the name the rest of the pipeline sees for it.
  bindings: Map<string, string>;
  // Names read or reassigned in this block (or a block inside it) while they meant a variable
  // declared outside this block.
  outerUses: Set<string>;
}

export function renameShadowingDecls(script: Script): Script {
  let counter = 0;
  // A few nodes are shared by two parents (`obj.field += v` reuses `obj`); resolve each once.
  const resolved = new WeakSet<object>();

  const child = (parent: Scope): Scope => ({ parent, bindings: new Map(), outerUses: new Set() });

  const use = (scope: Scope, name: string): string | undefined => {
    let s: Scope | null = scope;
    while (s !== null && !s.bindings.has(name)) s = s.parent;
    if (s === null) return undefined; // a built-in or an undeclared name
    for (let t: Scope = scope; t !== s; t = t.parent!) t.outerUses.add(name);
    return s.bindings.get(name);
  };

  const declare = (scope: Scope, name: string): string => {
    // A second declaration in the same scope (a parameter, a loop header's variable, an earlier
    // '=') names the variable already there; codegen emits it as a plain assignment.
    const existing = scope.bindings.get(name);
    if (existing !== undefined) return existing;
    const jsName = scope.outerUses.has(name) ? `${name}$${++counter}` : name;
    scope.bindings.set(name, jsName);
    return jsName;
  };

  const block = (body: Stmt[], scope: Scope): void => {
    for (const stmt of body) statement(stmt, scope);
  };

  const params = (ps: FuncParam[], scope: Scope): void => {
    for (const p of ps) {
      if (p.default !== null) expr(p.default, scope.parent!);
      declare(scope, p.name);
    }
  };

  const ifChain = (s: IfStmt, scope: Scope): void => {
    expr(s.condition, scope);
    block(s.thenBody, child(scope));
    for (const clause of s.elifClauses) {
      expr(clause.condition, scope);
      block(clause.body, child(scope));
    }
    if (s.elseBody !== null) block(s.elseBody, child(scope));
  };

  const switchStmt = (s: SwitchStmt, scope: Scope): void => {
    if (s.subject !== null) expr(s.subject, scope);
    for (const c of s.cases) {
      if (c.values !== null) for (const v of c.values) expr(v, scope);
      block(c.body, child(scope));
    }
  };

  const statement = (stmt: Stmt, scope: Scope): void => {
    switch (stmt.kind) {
      case "VarDecl":
        expr(stmt.value, scope);
        stmt.name = declare(scope, stmt.name);
        return;
      case "Assignment": {
        expr(stmt.value, scope);
        if (stmt.operator === "=") {
          stmt.name = declare(scope, stmt.name);
        } else {
          const target = use(scope, stmt.name);
          if (target !== undefined) stmt.name = target;
        }
        return;
      }
      case "TupleDestructure":
        expr(stmt.value, scope);
        stmt.names = stmt.names.map((n) => (n === "_" ? n : declare(scope, n)));
        return;
      case "ExprStmt":
        expr(stmt.expr, scope);
        return;
      case "FieldAssignment":
        expr(stmt.object, scope);
        expr(stmt.value, scope);
        return;
      case "IfStmt":
        ifChain(stmt, scope);
        return;
      case "SwitchStmt":
        switchStmt(stmt, scope);
        return;
      case "WhileStmt":
        expr(stmt.condition, scope);
        block(stmt.body, child(scope));
        return;
      case "ForStmt": {
        // The bounds are evaluated before the counter exists; the counter belongs to the body
        // (language_loops.txt "Scope").
        expr(stmt.start, scope);
        expr(stmt.end, scope);
        if (stmt.step !== null) expr(stmt.step, scope);
        const body = child(scope);
        declare(body, stmt.varName);
        block(stmt.body, body);
        return;
      }
      case "ForInStmt": {
        expr(stmt.iterable, scope);
        const body = child(scope);
        if (stmt.indexName !== null) declare(body, stmt.indexName);
        declare(body, stmt.varName);
        block(stmt.body, body);
        return;
      }
      case "FuncDecl":
      case "MethodDecl": {
        const fn = child(scope);
        params(stmt.params, fn);
        block(stmt.body, fn);
        return;
      }
      case "TypeDecl":
        for (const f of stmt.fields) if (f.default !== null) expr(f.default, scope);
        return;
      case "EnumDecl":
      case "BreakStmt":
      case "ContinueStmt":
        return;
    }
  };

  const expr = (e: Expr, scope: Scope): void => {
    switch (e.kind) {
      case "Identifier": {
        if (resolved.has(e)) return;
        resolved.add(e);
        const name = use(scope, e.name);
        if (name !== undefined) e.name = name;
        return;
      }
      case "BinOp":
        expr(e.left, scope);
        expr(e.right, scope);
        return;
      case "UnaryOp":
        expr(e.operand, scope);
        return;
      case "TernaryOp":
        expr(e.condition, scope);
        expr(e.trueExpr, scope);
        expr(e.falseExpr, scope);
        return;
      case "CallExpr":
        // A called name is a function, never a variable (calls and values are separate
        // namespaces); a dotted callee's object may be a variable (a method call's receiver).
        if (e.callee.kind === "DotAccess") expr(e.callee.obj, scope);
        for (const a of e.args) expr(a, scope);
        for (const kw of e.kwargs) expr(kw.value, scope);
        return;
      case "DotAccess":
        expr(e.obj, scope);
        return;
      case "IndexAccess":
        expr(e.obj, scope);
        expr(e.index, scope);
        return;
      case "TupleExpr":
        for (const el of e.elements) expr(el, scope);
        return;
      case "IfStmt":
      case "SwitchStmt":
      case "WhileStmt":
      case "ForStmt":
        statement(e, scope);
        return;
      case "NumberLiteral":
      case "StringLiteral":
      case "BoolLiteral":
      case "NaLiteral":
      case "ColorLiteral":
        return;
    }
  };

  block(script.body, { parent: null, bindings: new Map(), outerUses: new Set() });
  return script;
}
