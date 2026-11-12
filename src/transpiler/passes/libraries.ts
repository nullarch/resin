// Link pass, run on the parsed script before analysis: `import user/name/version as alias` becomes
// the library's own declarations, inside the script.
//
// A library is Pine source like any other, and a call of its function keeps its own state like a call
// of any UDF does, so the rest of the transpiler needs nothing new once the two are one program: a
// library's top-level names get a prefix no script can already be using (`lib0_MLExtensions__n_rsi`),
// `ml.n_rsi(...)` becomes a call of that name, and the declarations go in front of the script's body.
// Only declarations come over. A library's other global code is "to demonstrate how other scripts can
// use its exported structures" and its exports are "the only visible part of the library when imported
// by another script" (Pine manual, Libraries): KernelFunctions ends in four plot() calls, and they are
// not plots of the script that imports it. A function or variable nothing reaches is dropped too, so a
// table helper a script never calls costs nothing and a global's input() does not become an input.
//
// resin reads no network and no disk here: the caller hands over the sources (options.libraries). An
// import with no source is left as it always was. Unused, it compiles; a name read through it is
// refused (pipeline.ts says which library was missing); and an alias that is also a builtin namespace,
// such as `import TradingView/ta/7`, keeps reading resin's builtins, which `transpile()` warns about.
//
// A library line number is negative so that it cannot be mistaken for a line of the script and stays
// below every line of it: the analyzer treats "declared on a lower line" as "declared earlier".
// libraryLocation() turns one back into something a person can read.
import type { DotAccess, Expr, FuncParam, Script, Stmt } from "../ast";
import { ParseError, parse } from "../parser";

export type LibrarySources = Readonly<Record<string, string>> | ((path: string) => string | undefined);

// The namespaces of the language. An alias equal to one of them adds to it instead of replacing it:
// `import TradingView/ta/7` leaves `ta.sma` the builtin.
export const BUILTIN_NAMESPACES: ReadonlySet<string> = new Set([
  "array", "barstate", "box", "chart", "color", "currency", "dayofweek", "display", "dividends", "earnings", "extend",
  "font", "format", "hline", "input", "label", "line", "linefill", "location", "log", "map", "math", "matrix", "order",
  "plot", "polyline", "position", "request", "runtime", "scale", "session", "shape", "size", "splits", "str", "strategy",
  "syminfo", "ta", "table", "text", "ticker", "time", "timeframe", "xloc", "yloc",
]);

const MAX_LIBRARIES = 64;
const LINE_SPAN = 1_000_000;

interface Linked {
  path: string;
  version: number | undefined;
  funcs: Map<string, string>;
  values: Map<string, string>; // variables, types and enums
  methods: Set<string>;
  body: Stmt[];
}

export interface LinkResult {
  script: Script;
  errors: string[];
  // Paths imported with no source, and the alias each was imported under.
  missing: { path: string; alias: string; line: number }[];
  linked: string[];
}

function sourceOf(libraries: LibrarySources | undefined, path: string): string | undefined {
  if (libraries === undefined) return undefined;
  if (typeof libraries === "function") return libraries(path);
  return Object.prototype.hasOwnProperty.call(libraries, path) ? libraries[path] : undefined;
}

// Lines of the n-th library linked: earlier links lie lower, because they come first in the program.
function lineBase(n: number): number {
  return (MAX_LIBRARIES - n) * LINE_SPAN;
}

export function libraryLocation(line: number, linked: readonly string[]): { path: string; line: number } | null {
  if (line >= 0) return null;
  const slot = Math.ceil(-line / LINE_SPAN);
  const path = linked[MAX_LIBRARIES - slot];
  return path === undefined ? null : { path, line: line + slot * LINE_SPAN };
}

// `(L-63999825:26)` → `(library jdehorty/MLExtensions/2 L175:26)`.
export function describeLibraryLines(message: string, linked: readonly string[]): string {
  return message.replace(/L(-\d+)/g, (whole, n: string) => {
    const at = libraryLocation(Number(n), linked);
    return at === null ? whole : `library ${at.path} L${at.line}`;
  });
}

function shiftLines(node: unknown, by: number): void {
  if (Array.isArray(node)) {
    for (const child of node) shiftLines(child, by);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.line === "number") rec.line -= by;
  for (const key of Object.keys(rec)) if (typeof rec[key] === "object") shiftLines(rec[key], by);
}

// What of a library's global scope can matter to a script that imports it.
function isLibraryDeclaration(s: Stmt): boolean {
  return (
    s.kind === "FuncDecl" ||
    s.kind === "MethodDecl" ||
    s.kind === "TypeDecl" ||
    s.kind === "EnumDecl" ||
    s.kind === "VarDecl" ||
    s.kind === "TupleDestructure" ||
    (s.kind === "Assignment" && s.operator === "=")
  );
}

// The names a statement that dropUnreached may drop goes by, or null for one it always keeps.
function droppableNames(s: Stmt): readonly string[] | null {
  if (s.kind === "FuncDecl" || s.kind === "VarDecl" || s.kind === "Assignment") return [s.name];
  return s.kind === "TupleDestructure" ? s.names : null;
}

function isDeclarationCall(stmt: Stmt, names: readonly string[]): boolean {
  return stmt.kind === "ExprStmt" && stmt.expr.kind === "CallExpr" && stmt.expr.callee.kind === "Identifier" && names.includes(stmt.expr.callee.name);
}

class Renamer {
  private scopes: Set<string>[] = [new Set()];
  private readonly funcs: ReadonlyMap<string, string>;
  private readonly values: ReadonlyMap<string, string>;
  private readonly aliases: ReadonlyMap<string, Linked>;
  private readonly errors: string[];
  private readonly where: string;

  constructor(
    funcs: ReadonlyMap<string, string>,
    values: ReadonlyMap<string, string>,
    aliases: ReadonlyMap<string, Linked>,
    errors: string[],
    where: string,
  ) {
    this.funcs = funcs;
    this.values = values;
    this.aliases = aliases;
    this.errors = errors;
    this.where = where;
  }

  private shadowed(name: string): boolean {
    return this.scopes.some((s) => s.has(name));
  }

  private atTop(): boolean {
    return this.scopes.length === 1;
  }

  private bind(name: string): string {
    if (this.atTop()) {
      const mangled = this.values.get(name);
      if (mangled !== undefined) return mangled;
    }
    this.scopes[this.scopes.length - 1]!.add(name);
    return name;
  }

  private block(body: Stmt[]): void {
    this.scopes.push(new Set());
    for (const s of body) this.stmt(s);
    this.scopes.pop();
  }

  // The library an expression names, when it is an alias nothing local has taken.
  private aliasOf(e: Expr): Linked | null {
    if (e.kind !== "Identifier" || this.shadowed(e.name)) return null;
    return this.aliases.get(e.name) ?? null;
  }

  private noSuchExport(lib: Linked, alias: string, attr: string, line: number, col: number): void {
    this.errors.push(`library '${lib.path}' (imported as ${alias}) does not export '${attr}' (${this.where}L${line}:${col})`);
  }

  private hint(h: string, at: { line: number; col: number }): string {
    return h.replace(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g, (tok) => {
      const dot = tok.indexOf(".");
      if (dot < 0) return this.values.get(tok) ?? tok;
      const alias = tok.slice(0, dot);
      const lib = this.aliases.get(alias);
      if (lib === undefined) return tok;
      const name = tok.slice(dot + 1);
      const mangled = lib.values.get(name);
      if (mangled === undefined && !BUILTIN_NAMESPACES.has(alias)) this.noSuchExport(lib, alias, name, at.line, at.col);
      return mangled ?? tok;
    });
  }

  private params(params: FuncParam[]): void {
    for (const p of params) {
      if (p.typeHint !== null) p.typeHint = this.hint(p.typeHint, p);
      if (p.default !== null) p.default = this.expr(p.default);
      this.scopes[this.scopes.length - 1]!.add(p.name);
    }
  }

  private expr(e: Expr): Expr {
    switch (e.kind) {
      case "BinOp":
        e.left = this.expr(e.left);
        e.right = this.expr(e.right);
        return e;
      case "UnaryOp":
        e.operand = this.expr(e.operand);
        return e;
      case "TernaryOp":
        e.condition = this.expr(e.condition);
        e.trueExpr = this.expr(e.trueExpr);
        e.falseExpr = this.expr(e.falseExpr);
        return e;
      case "IndexAccess":
        e.obj = this.expr(e.obj);
        e.index = this.expr(e.index);
        return e;
      case "TupleExpr":
        e.elements = e.elements.map((x) => this.expr(x));
        return e;
      case "Identifier": {
        if (this.shadowed(e.name)) return e;
        const mangled = this.values.get(e.name);
        if (mangled !== undefined) e.name = mangled;
        return e;
      }
      case "DotAccess": {
        if (e.genericElemType !== undefined) e.genericElemType = this.hint(e.genericElemType, e);
        const lib = this.aliasOf(e.obj);
        if (lib !== null) {
          const mangled = lib.values.get(e.attr);
          if (mangled !== undefined) return { kind: "Identifier", name: mangled, line: e.line, col: e.col };
          if (!BUILTIN_NAMESPACES.has((e.obj as { name: string }).name)) this.noSuchExport(lib, (e.obj as { name: string }).name, e.attr, e.line, e.col);
          return e;
        }
        e.obj = this.expr(e.obj);
        return e;
      }
      case "CallExpr": {
        e.args = e.args.map((a) => this.expr(a));
        for (const kw of e.kwargs) kw.value = this.expr(kw.value);
        const callee = e.callee;
        if (callee.kind === "Identifier") {
          const mangled = this.funcs.get(callee.name) ?? (this.shadowed(callee.name) ? undefined : this.values.get(callee.name));
          if (mangled !== undefined) callee.name = mangled;
          return e;
        }
        const lib = this.aliasOf(callee.obj);
        if (lib === null) {
          e.callee = this.expr(callee) as DotAccess;
          return e;
        }
        const mangled = lib.funcs.get(callee.attr) ?? lib.values.get(callee.attr);
        if (mangled !== undefined) {
          e.callee = { kind: "Identifier", name: mangled, line: callee.line, col: callee.col };
          return e;
        }
        if (lib.methods.has(callee.attr) && e.args.length > 0) {
          // `lib.m(x, y)` is the function form of `x.m(y)`.
          e.callee = { ...callee, obj: e.args[0]! };
          e.args = e.args.slice(1);
          return e;
        }
        const alias = (callee.obj as { name: string }).name;
        if (!BUILTIN_NAMESPACES.has(alias)) this.noSuchExport(lib, alias, callee.attr, e.line, e.col);
        return e;
      }
      case "IfStmt":
      case "ForStmt":
      case "WhileStmt":
      case "SwitchStmt":
        this.stmt(e);
        return e;
      default:
        return e;
    }
  }

  stmt(s: Stmt): void {
    switch (s.kind) {
      case "VarDecl":
        if (s.typeHint !== null) s.typeHint = this.hint(s.typeHint, s);
        s.value = this.expr(s.value);
        s.name = this.bind(s.name);
        return;
      case "Assignment":
        if (s.typeHint !== null) s.typeHint = this.hint(s.typeHint, s);
        s.value = this.expr(s.value);
        if (s.operator === "=") s.name = this.bind(s.name);
        else if (!this.shadowed(s.name)) s.name = this.values.get(s.name) ?? s.name;
        return;
      case "ExprStmt":
        s.expr = this.expr(s.expr);
        return;
      case "IfStmt":
        s.condition = this.expr(s.condition);
        this.block(s.thenBody);
        for (const c of s.elifClauses) {
          c.condition = this.expr(c.condition);
          this.block(c.body);
        }
        if (s.elseBody !== null) this.block(s.elseBody);
        return;
      case "ForStmt":
        s.start = this.expr(s.start);
        s.end = this.expr(s.end);
        if (s.step !== null) s.step = this.expr(s.step);
        this.scopes.push(new Set([s.varName]));
        this.block(s.body);
        this.scopes.pop();
        return;
      case "ForInStmt":
        s.iterable = this.expr(s.iterable);
        this.scopes.push(new Set(s.indexName === null ? [s.varName] : [s.varName, s.indexName]));
        this.block(s.body);
        this.scopes.pop();
        return;
      case "WhileStmt":
        s.condition = this.expr(s.condition);
        this.block(s.body);
        return;
      case "SwitchStmt":
        if (s.subject !== null) s.subject = this.expr(s.subject);
        for (const c of s.cases) {
          if (c.values !== null) c.values = c.values.map((v) => this.expr(v));
          this.block(c.body);
        }
        return;
      case "FuncDecl":
        s.name = this.funcs.get(s.name) ?? s.name;
        this.scopes.push(new Set());
        this.params(s.params);
        this.block(s.body);
        this.scopes.pop();
        return;
      case "MethodDecl":
        // A method keeps its name: it is called on a receiver, and the receiver's type decides.
        this.scopes.push(new Set());
        this.params(s.params);
        this.block(s.body);
        this.scopes.pop();
        return;
      case "TupleDestructure":
        s.value = this.expr(s.value);
        s.names = s.names.map((n) => this.bind(n));
        return;
      case "TypeDecl":
        s.name = this.values.get(s.name) ?? s.name;
        for (const f of s.fields) {
          f.typeHint = this.hint(f.typeHint, f);
          if (f.default !== null) f.default = this.expr(f.default);
        }
        return;
      case "EnumDecl":
        s.name = this.values.get(s.name) ?? s.name;
        return;
      case "FieldAssignment":
        s.object = this.expr(s.object);
        s.value = this.expr(s.value);
        return;
      case "BreakStmt":
      case "ContinueStmt":
        return;
      default: {
        const never: never = s;
        throw new Error(`link: unhandled statement ${(never as { kind: string }).kind}`);
      }
    }
  }
}

// Every top-level name of a library, with the name it goes by in the program.
function topLevelNames(body: Stmt[], prefix: string): { funcs: Map<string, string>; values: Map<string, string> } {
  const funcs = new Map<string, string>();
  const values = new Map<string, string>();
  const value = (n: string): void => void values.set(n, prefix + n);
  for (const s of body) {
    if (s.kind === "FuncDecl") funcs.set(s.name, prefix + s.name);
    else if (s.kind === "VarDecl" || s.kind === "TypeDecl" || s.kind === "EnumDecl") value(s.name);
    else if (s.kind === "Assignment" && s.operator === "=") value(s.name);
    else if (s.kind === "TupleDestructure") s.names.forEach(value);
  }
  return { funcs, values };
}

function identifiersIn(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) identifiersIn(child, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.kind === "Identifier" && typeof rec.name === "string") out.add(rec.name);
  for (const key of Object.keys(rec)) if (typeof rec[key] === "object") identifiersIn(rec[key], out);
}

// Library functions and variables nothing reaches go. Everything else is a root, the script's own
// functions included: a function of the script compiles whether or not it is called. Types and enums
// stay: they run nothing, and what reads them is mostly a type hint, not an expression.
function dropUnreached(body: Stmt[], fromLibrary: ReadonlySet<Stmt>): Stmt[] {
  const byName = new Map<string, Stmt[]>();
  const reached = new Set<Stmt>();
  const seen = new Set<string>();
  const work: Stmt[] = [];
  for (const s of body) {
    const names = fromLibrary.has(s) ? droppableNames(s) : null;
    if (names === null) {
      work.push(s);
      continue;
    }
    for (const n of names) {
      const list = byName.get(n);
      if (list === undefined) byName.set(n, [s]);
      else list.push(s);
    }
  }
  while (work.length > 0) {
    const names = new Set<string>();
    identifiersIn(work.pop(), names);
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      for (const decl of byName.get(n) ?? []) {
        if (reached.has(decl)) continue;
        reached.add(decl);
        work.push(decl);
      }
    }
  }
  return body.filter((s) => !fromLibrary.has(s) || droppableNames(s) === null || reached.has(s));
}

export function linkLibraries(script: Script, source: string, libraries: LibrarySources | undefined, maxSourceBytes: number): LinkResult {
  const errors: string[] = [];
  const missing: LinkResult["missing"] = [];
  const done = new Map<string, Linked>();
  const order: Linked[] = [];
  const linked: string[] = [];

  const aliasesFor = (unit: Script, stack: readonly string[], where: string): Map<string, Linked> => {
    const aliases = new Map<string, Linked>();
    const seenAlias = new Set<string>();
    for (const imp of unit.imports ?? []) {
      if (seenAlias.has(imp.alias)) errors.push(`import alias '${imp.alias}' is used twice (${where}L${imp.line}:${imp.col})`);
      seenAlias.add(imp.alias);
      const lib = linkOne(imp.path, stack);
      if (lib === undefined) missing.push({ path: imp.path, alias: imp.alias, line: imp.line });
      else if (lib !== null) aliases.set(imp.alias, lib);
    }
    return aliases;
  };

  // undefined: no source. null: it has one, and it did not link (the reason is in `errors`).
  function linkOne(path: string, stack: readonly string[]): Linked | null | undefined {
    const known = done.get(path);
    if (known !== undefined) return known;
    if (stack.includes(path)) {
      errors.push(`library '${path}' imports itself: ${[...stack, path].join(" -> ")}`);
      return null;
    }
    const text = sourceOf(libraries, path);
    if (text === undefined) return undefined;
    if (order.length + stack.length >= MAX_LIBRARIES) {
      errors.push(`more than ${MAX_LIBRARIES} libraries linked at '${path}'`);
      return null;
    }
    if (text.length > maxSourceBytes) {
      errors.push(`library '${path}' is ${text.length} characters, over the ${maxSourceBytes} limit (maxSourceBytes)`);
      return null;
    }
    let unit: Script;
    try {
      unit = parse(text);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      errors.push(`library '${path}': ${e.message}`);
      return null;
    }
    if (!unit.body.some((s) => isDeclarationCall(s, ["library"]))) {
      errors.push(`'${path}' is not a library: its source has no library() declaration`);
      return null;
    }
    const before = errors.length;
    const where = `library ${path} `;
    const aliases = aliasesFor(unit, [...stack, path], where);
    if (errors.length > before) return null;

    const lib: Linked = { path, version: unit.version, funcs: new Map(), values: new Map(), methods: new Set(), body: [] };
    const n = linked.length;
    linked.push(path);
    shiftLines(unit.body, lineBase(n));
    const body = unit.body.filter(isLibraryDeclaration);

    let tag = n;
    const stem = path.split("/")[1]?.replace(/\W/g, "_") ?? "lib";
    while (source.includes(`lib${tag}_${stem}__`) || text.includes(`lib${tag}_${stem}__`)) tag += 1000;
    const { funcs, values } = topLevelNames(body, `lib${tag}_${stem}__`);

    for (const s of body) {
      if (!(s as { exported?: true }).exported) continue;
      if (s.kind === "FuncDecl") lib.funcs.set(s.name, funcs.get(s.name)!);
      else if (s.kind === "MethodDecl") lib.methods.add(s.name);
      else if (s.kind === "VarDecl" || s.kind === "TypeDecl" || s.kind === "EnumDecl" || (s.kind === "Assignment" && s.operator === "=")) {
        lib.values.set(s.name, values.get(s.name)!);
      }
    }

    const renamer = new Renamer(funcs, values, aliases, errors, where);
    for (const s of body) renamer.stmt(s);
    lib.body = body;
    done.set(path, lib);
    order.push(lib);
    return lib;
  }

  const imports = script.imports ?? [];
  if (imports.length === 0) return { script, errors, missing, linked };

  const aliases = aliasesFor(script, [], "");
  const mainV6 = (script.version ?? 1) >= 6;
  for (const lib of order) {
    if ((lib.version ?? 1) >= 6 !== mainV6) {
      errors.push(`library '${lib.path}' is Pine v${lib.version ?? 5} and the script is v${script.version ?? 5}: resin compiles one program under one version's rules, and those rules differ`);
    }
  }
  if (errors.length > 0) return { script, errors, missing, linked };
  if (order.length === 0) return { script, errors, missing, linked };

  // Two units declaring the same method on the same receiver would become one overload set, which no
  // Pine program has: in Pine each stays with its own unit. Refused rather than picked between.
  const methodOwner = new Map<string, string>();
  const units: [string, Stmt[]][] = [...order.map((l): [string, Stmt[]] => [`library '${l.path}'`, l.body]), ["the script", script.body]];

  const renamer = new Renamer(new Map(), new Map(), aliases, errors, "");
  for (const s of script.body) renamer.stmt(s);
  if (errors.length > 0) return { script, errors, missing, linked };

  for (const [owner, body] of units) {
    for (const s of body) {
      if (s.kind !== "MethodDecl") continue;
      const key = `${s.name} on ${s.params[0]?.typeHint ?? "?"}`;
      const first = methodOwner.get(key);
      if (first !== undefined && first !== owner) {
        errors.push(`method ${key} is declared by both ${first} and ${owner}: resin keeps one method namespace, so it cannot tell them apart`);
      }
      methodOwner.set(key, owner);
    }
  }
  if (errors.length > 0) return { script, errors, missing, linked };

  const libraryBody = order.flatMap((l) => l.body);
  const at = script.body.findIndex((s) => isDeclarationCall(s, ["indicator", "strategy", "library"]));
  const merged = [...script.body.slice(0, at + 1), ...libraryBody, ...script.body.slice(at + 1)];
  return { script: { ...script, body: dropUnreached(merged, new Set(libraryBody)) }, errors, missing, linked };
}
