// A local declaration named like a variable of an enclosing scope makes a new variable from that
// statement on; before it, and in its own initializer, the name still means the outer variable
// (ref_v6_lang.txt OPERATOR =: "It means *this is a new variable*"; language_user-defined-
// functions.txt "Function scopes": a function "can access any global variables declared above its
// definition"). A JS `let` covers its whole block, so such a read used to throw "Cannot access
// '<name>' before initialization". Harness probe suites/lang/probes/L50.json (oracle = resin on every
// channel; RESIN_RUNTIME_ERROR before), realworld b17655fc60c9 (`normalizeMethod = switch
// normalizeMethod` in a function over the global input).

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";
import type { Assignment, FuncDecl, IfStmt, Script, SwitchStmt } from "../../src/transpiler/ast";
import { parse } from "../../src/transpiler/parser";
import { renameShadowingDecls } from "../../src/transpiler/passes/shadowing";

const renamed = (src: string): Script => renameShadowingDecls(parse(src));
const fnBody = (script: Script, i: number) => (script.body[i] as FuncDecl).body;

describe("renameShadowingDecls", () => {
  it("renames a function's local whose initializer reads the global of its name; the read keeps the global", () => {
    const script = renamed(['m = "a"', "f(v) =>", "    m = switch m", '        "a" => v', "        => 0", "    m"].join("\n"));
    const [decl, tail] = fnBody(script, 1);
    expect((decl as Assignment).name).toBe("m$1");
    const sw = (decl as Assignment).value as SwitchStmt;
    expect(sw.subject).toMatchObject({ kind: "Identifier", name: "m" });
    expect(tail).toMatchObject({ kind: "ExprStmt", expr: { kind: "Identifier", name: "m$1" } });
  });

  it("renames a local after an earlier read or := of the outer variable in its block, and later := follow it", () => {
    const script = renamed(
      ["x = 1.0", "if true", "    x := x + 1", "    y = x", "    x = y * 2", "    x := x + 1", "    z = x"].join("\n"),
    );
    const body = (script.body[1] as IfStmt).thenBody as Assignment[];
    expect(body[0]!.name).toBe("x"); // reassigns the global
    expect(body[1]!.value).toMatchObject({ kind: "Identifier", name: "x" });
    expect(body[2]!.name).toBe("x$1");
    expect(body[3]!.name).toBe("x$1");
    expect(body[3]!.value).toMatchObject({ kind: "BinOp", left: { kind: "Identifier", name: "x$1" } });
    expect(body[4]!.value).toMatchObject({ kind: "Identifier", name: "x$1" });
  });

  it("counts a read in a nested block of the declaring block", () => {
    const script = renamed(["k = 1.0", "f(v) =>", "    if v > 0", "        t = k", "    k = 2.0", "    k"].join("\n"));
    expect((fnBody(script, 1)[1] as Assignment).name).toBe("k$1");
  });

  it("gives a shadow of a shadow a name of its own", () => {
    const script = renamed(["m = 1.0", "f(v) =>", "    m = m + v", "    if v > 0", "        m = m * 10", "    m"].join("\n"));
    const body = fnBody(script, 1);
    expect((body[0] as Assignment).name).toBe("m$1");
    const inner = (body[1] as IfStmt).thenBody[0] as Assignment;
    expect(inner.name).toBe("m$2");
    expect(inner.value).toMatchObject({ left: { kind: "Identifier", name: "m$1" } });
    expect(body[2]).toMatchObject({ expr: { name: "m$1" } });
  });

  it("renames tuple targets and var declarations under the same rule", () => {
    const script = renamed(
      ["a = 1.0", "g(p) => [p, p]", "if true", "    [a, _] = g(a)", "base = 5.0", "h() =>", "    var float base = base * 2", "    base"].join("\n"),
    );
    expect((script.body[2] as IfStmt).thenBody[0]).toMatchObject({ kind: "TupleDestructure", names: ["a$1", "_"] });
    expect(fnBody(script, 4)[0]).toMatchObject({ kind: "VarDecl", name: "base$2" });
  });

  it("leaves a shadow its block never read before it, a parameter's redeclaration and a loop header's variable alone", () => {
    const script = renamed(
      ["m = 1.0", "f(v) =>", "    m = 2.0", "    m + v", "g(v) =>", "    v = v + 1", "    v", "for i = 0 to 2", "    i = i + 1"].join("\n"),
    );
    expect((fnBody(script, 1)[0] as Assignment).name).toBe("m");
    expect((fnBody(script, 2)[0] as Assignment).name).toBe("v");
    expect(((script.body[3] as { body: Assignment[] }).body[0]!).name).toBe("i");
  });

  // A function's `var` belongs to its own block, but the analyzer keys a function's var slots by
  // name across the body: harness probe suites/lang/probes/L51.json (transpile error before; a
  // sibling branch's read of the global read the var's slot), realworld 8fb3f514575f.
  it("renames a function's var whose name another block of the function declares; every use of the var follows", () => {
    const script = renamed(
      [
        "f(t, src) =>",
        "    out = 0.0",
        '    if t == "A"',
        "        b = 0.0",
        "        out := b",
        '    else if t == "B"',
        "        var b = array.new_float(0)",
        "        array.push(b, src)",
        "        out := array.sum(b)",
        "    else",
        "        b = 0.0",
        "        b := src + nz(b[1])",
        "        out := b",
        "    out",
      ].join("\n"),
    );
    const chain = fnBody(script, 0)[1] as IfStmt;
    expect(chain.thenBody[0]).toMatchObject({ kind: "Assignment", name: "b" });
    const [decl, push, sum] = chain.elifClauses[0]!.body;
    expect(decl).toMatchObject({ kind: "VarDecl", name: "b$1" });
    expect(push).toMatchObject({ expr: { args: [{ kind: "Identifier", name: "b$1" }, { name: "src" }] } });
    expect(sum).toMatchObject({ value: { args: [{ kind: "Identifier", name: "b$1" }] } });
    const [eq, reassign] = chain.elseBody! as Assignment[];
    expect(eq!.name).toBe("b");
    expect(reassign!.name).toBe("b");
    expect(reassign!.value).toMatchObject({ right: { args: [{ kind: "IndexAccess", obj: { name: "b" } }] } });
  });

  it("renames a function's var named like a global, and a sibling block's read keeps the global", () => {
    const script = renamed(
      ["var float g = 0.0", "f(t) =>", "    out = g", "    if t", "        var g = 1.0", "        g += 1", "        out := g", "    out"].join("\n"),
    );
    const [head, chain] = fnBody(script, 1);
    expect(head).toMatchObject({ value: { kind: "Identifier", name: "g" } });
    const [decl, inc, read] = (chain as IfStmt).thenBody as Assignment[];
    expect(decl).toMatchObject({ kind: "VarDecl", name: "g$1" });
    expect(inc!.name).toBe("g$1");
    expect(read!.value).toMatchObject({ kind: "Identifier", name: "g$1" });
  });

  it("leaves a function's var alone when its name means nothing else, also when another function has one", () => {
    const script = renamed(["f() =>", "    var c = 0", "    c += 1", "    c", "h() =>", "    var c = 5", "    c"].join("\n"));
    expect(fnBody(script, 0)[0]).toMatchObject({ kind: "VarDecl", name: "c" });
    expect(fnBody(script, 0)[1]).toMatchObject({ name: "c" });
    expect(fnBody(script, 1)[0]).toMatchObject({ kind: "VarDecl", name: "c" });
  });
});

describe("E2E: a local that shadows a variable its block read first", () => {
  it("reads the outer variable before and in its declaration, and leaves it untouched", () => {
    const close = [1, 2, 3, 4];
    const data: OHLCVData = { open: close, high: close, low: close, close, volume: close.map(() => 1) };
    const src = [
      'mode = close > 2 ? "up" : "down"',
      "norm(v) =>",
      "    mode = switch mode",
      '        "up" => v * 2',
      "        => v - 1",
      "    mode",
      "var float __n1 = na",
      "__n1 := norm(close)",
      "k = 3.0",
      "calc(v) =>",
      "    y = k + v",
      "    k = k * 2 + y",
      "    k",
      "var float __n2 = na",
      "__n2 := calc(close)",
      "x = close",
      "var float __xin = na",
      "if close > 2",
      "    x = x * 2",
      "    x := x + 1",
      "    __xin := x",
      "var float __x = na",
      "__x := x",
      "s = 1.0",
      "tot = 0.0",
      "for i = 0 to 2",
      "    s = s + i",
      "    tot += s",
      "var float __tot = na",
      "__tot := tot * 100 + s",
      "var float acc = 0.0",
      "acc += 1",
      "grow(v) =>",
      "    t = acc + v",
      "    acc = t * 2",
      "    acc",
      "var float __n6 = na",
      "__n6 := grow(close) * 100 + acc",
      "base = 5.0",
      "counter() =>",
      "    var float base = base * 2",
      "    base += 1",
      "    base",
      "var float __n9 = na",
      "__n9 := counter()",
    ].join("\n");
    const result = runPipeline(src, data);
    const obs = (name: string) => result.bars.map((b) => b[`var:${name}`] as number);
    expect(obs("__n1")).toEqual([0, 1, 6, 8]);
    expect(obs("__n2")).toEqual([10, 11, 12, 13]);
    expect(obs("__xin")).toEqual([NaN, NaN, 7, 9]);
    expect(obs("__x")).toEqual([1, 2, 3, 4]);
    expect(obs("__tot")).toEqual([601, 601, 601, 601]);
    expect(obs("__n6")).toEqual([401, 802, 1203, 1604]);
    expect(obs("__n9")).toEqual([11, 12, 13, 14]);
  });
});

describe("E2E: a function's var and the other variables of its name", () => {
  it("keeps the var's state, the sibling branches' locals and their histories, and the global apart", () => {
    const close = [1, 2, 3, 4];
    const data: OHLCVData = { open: close, high: close, low: close, close, volume: close.map(() => 1) };
    // get_ma_out's shape (realworld 8fb3f514575f): one branch keeps `var b`, its siblings declare
    // their own `b`; values as in harness probe L51 (oracle = resin).
    const src = [
      "gl = close * 2",
      "f(t, src) =>",
      "    out = 0.0",
      "    if t == 1",
      "        b = 0.0",
      "        b := src + nz(b[1])",
      "        out := b",
      "    else if t == 2",
      "        var b = array.new_float(0)",
      "        array.push(b, src)",
      "        out := array.sum(b)",
      "    else if t == 3",
      "        b = 0.0",
      "        b := src * 2 + nz(b[1]) / 2",
      "        out := b",
      "    else",
      "        out := gl + 1",
      "        var gl = 0.0",
      "        gl += 1",
      "        out := out * 100 + gl",
      "    out",
      "var float __p1 = na",
      "__p1 := f(1, close)",
      "var float __p2 = na",
      "__p2 := f(2, close)",
      "var float __p3 = na",
      "__p3 := f(3, close)",
      "var float __p4 = na",
      "__p4 := f(4, close)",
    ].join("\n");
    const result = runPipeline(src, data);
    const obs = (name: string) => result.bars.map((b) => b[`var:${name}`] as number);
    expect(obs("__p1")).toEqual([1, 3, 6, 10]);
    expect(obs("__p2")).toEqual([1, 3, 6, 10]);
    expect(obs("__p3")).toEqual([2, 5, 8.5, 12.25]);
    expect(obs("__p4")).toEqual([301, 502, 703, 904]);
  });
});
