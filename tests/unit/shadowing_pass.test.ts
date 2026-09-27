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
