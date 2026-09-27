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
//
// A function's `var` is renamed the same way when its name also means another variable of the
// function (one declared in another block — a sibling `else if` branch's `b = 0.0` next to
// `var b = array.new_float(0)`, a nested block's shadow, a loop's counter —, a parameter, a global
// the function reads), or names a global `var`. Such a `var` belongs to its own block like any
// declaration ("Each function definition creates a distinct local scope",
// language_user-defined-functions.txt; `=` "means *this is a new variable*", ref_v6_lang.txt), but
// the analyzer keys a function's `var` slots by name across the whole body and checks them against
// the global `var` slots by name, so the other variable's declaration was rejected ("variable
// declared with var cannot be reassigned with '='", "duplicate var declaration") and its reads fell
// into the var's slot (resin-harness realworld 8fb3f514575f, repro
// state/repros/fn-var-sibling-block.json).
import type { Expr, FuncParam, IfStmt, Script, Stmt, SwitchStmt } from "../ast";

interface Binding {
  // The name the rest of the pipeline sees for the variable.
  name: string;
  // For a function's `var`: every node naming it, so a later rename reaches them all.
  refs: Array<(name: string) => void> | null;
}

// One function (or method) body.
interface FnScope {
  // Pine name -> every variable the name stood for in this body.
  meanings: Map<string, Set<Binding>>;
  vars: Array<{ pine: string; binding: Binding }>;
}

interface Scope {
  parent: Scope | null;
  // Pine name -> the variable it names in this scope.
  bindings: Map<string, Binding>;
  // Names read or reassigned in this block (or a block inside it) while they meant a variable
  // declared outside this block.
  outerUses: Set<string>;
  fn: FnScope | null;
}

export function renameShadowingDecls(script: Script): Script {
  let counter = 0;
  // A few nodes are shared by two parents (`obj.field += v` reuses `obj`); resolve each once.
  const resolved = new WeakSet<object>();
  const fns: FnScope[] = [];
  // Pine names declared with `var` outside every function, at any depth.
  const globalVarNames = new Set<string>();
  const root: Scope = { parent: null, bindings: new Map(), outerUses: new Set(), fn: null };

  const child = (parent: Scope): Scope => ({ parent, bindings: new Map(), outerUses: new Set(), fn: parent.fn });

  const bind = (scope: Scope, pine: string, b: Binding, rename: (name: string) => void): void => {
    rename(b.name);
    b.refs?.push(rename);
    if (scope.fn === null) return;
    const meanings = scope.fn.meanings.get(pine) ?? new Set();
    meanings.add(b);
    scope.fn.meanings.set(pine, meanings);
  };

  // A read or a reassignment: `rename` stores the name of the variable it resolves to.
  const use = (scope: Scope, name: string, rename: (name: string) => void): void => {
    let s: Scope | null = scope;
    while (s !== null && !s.bindings.has(name)) s = s.parent;
    if (s === null) return; // a built-in or an undeclared name
    for (let t: Scope = scope; t !== s; t = t.parent!) t.outerUses.add(name);
    bind(scope, name, s.bindings.get(name)!, rename);
  };

  const noRename = (): void => {};

  const declare = (scope: Scope, name: string, rename: (name: string) => void, isVar = false): void => {
    // A second declaration in the same scope (a parameter, a loop header's variable, an earlier
    // '=') names the variable already there; codegen emits it as a plain assignment.
    const existing = scope.bindings.get(name);
    if (existing !== undefined) {
      bind(scope, name, existing, rename);
      return;
    }
    const b: Binding = {
      name: scope.outerUses.has(name) ? `${name}$${++counter}` : name,
      refs: isVar && scope.fn !== null ? [] : null,
    };
    scope.bindings.set(name, b);
    if (b.refs !== null) scope.fn!.vars.push({ pine: name, binding: b });
    bind(scope, name, b, rename);
  };

  // Gives a function's `var` a name of its own when its Pine name also means another variable of
  // that function or names a global `var` (see the header).
  const settleFunctionVars = (): void => {
    for (const fn of fns) {
      for (const { pine, binding } of fn.vars) {
        if (binding.name !== pine) continue; // already renamed
        if (fn.meanings.get(pine)!.size === 1 && !globalVarNames.has(pine)) continue;
        binding.name = `${pine}$${++counter}`;
        for (const rename of binding.refs!) rename(binding.name);
      }
    }
  };

  const block = (body: Stmt[], scope: Scope): void => {
    for (const stmt of body) statement(stmt, scope);
  };

  const params = (ps: FuncParam[], scope: Scope): void => {
    for (const p of ps) {
      if (p.default !== null) expr(p.default, scope.parent!);
      declare(scope, p.name, noRename);
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
        if (scope.fn === null) globalVarNames.add(stmt.name);
        declare(scope, stmt.name, (n) => (stmt.name = n), true);
        return;
      case "Assignment": {
        expr(stmt.value, scope);
        if (stmt.operator === "=") declare(scope, stmt.name, (n) => (stmt.name = n));
        else use(scope, stmt.name, (n) => (stmt.name = n));
        return;
      }
      case "TupleDestructure":
        expr(stmt.value, scope);
        stmt.names.forEach((n, i) => {
          if (n !== "_") declare(scope, n, (m) => (stmt.names[i] = m));
        });
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
        declare(body, stmt.varName, noRename);
        block(stmt.body, body);
        return;
      }
      case "ForInStmt": {
        expr(stmt.iterable, scope);
        const body = child(scope);
        if (stmt.indexName !== null) declare(body, stmt.indexName, noRename);
        declare(body, stmt.varName, noRename);
        block(stmt.body, body);
        return;
      }
      case "FuncDecl":
      case "MethodDecl": {
        const fnScope: FnScope = { meanings: new Map(), vars: [] };
        fns.push(fnScope);
        const fn: Scope = { ...child(scope), fn: fnScope };
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
        use(scope, e.name, (n) => (e.name = n));
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

  block(script.body, root);
  settleFunctionVars();
  return script;
}
