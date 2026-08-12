// C687: arity-disjoint method 오버로드 (C686 FuncDecl 오버로드의 method판). wild tv_verdict_v2
// 실측 대장 "이미 정의된 method" 클러스터 18파일 중 arity-disjoint 서브셋(대표: a14303e258ac.pine
// `init(SessionTime this, int)` / `(this,int,int)` / `(this,int,int,string)` 3-오버로드,
// 351376dbec22.pine `AddResult(Result[] data)` [1,1] vs `(data,name,value,bg=na)` [3,4]).
// method 콜사이트는 DotAccess sugar(receiver 타입이 analyze 시점에야 확정)라 C686의 AST rename
// prepass 대신 등록명 `$ov$k` 분기 + 모든 조회 지점의 lookupMethodOverload(콜사이트 인자 개수
// 기준, receiver 포함) 선택으로 구현. 같은-arity 오버로드(label[]/line[]류 원소타입 디스패치
// 필요)는 기존 하드 에러 유지. pine2py는 method를 flat 함수로 내려 동명 method가 마지막 선언
// last-wins로 덮어써지는 latent 버그(DIVERGENCES #56)라 오라클 대조 불가 — 전부 hand-verified.
import { describe, it, expect } from "vitest";
import { parse } from "../../src/transpiler/parser";
import { analyze, mangleMethodName, type AnalyzeOptions } from "../../src/transpiler/analyzer";
import { transpile } from "../../src/transpiler/pipeline";
import { run } from "../../src/runtime/engine";
import { type OHLCVData } from "../../src/runtime/context";

function analyzeSource(source: string, options?: AnalyzeOptions) {
  return analyze(parse(source), options);
}

function runBars(source: string, close: number[]): Record<string, number>[] {
  const result = transpile(source);
  expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
  if (!result.ok) throw new Error("unreachable");
  expect(() => new Function("$", "rt", result.code)).not.toThrow();
  const data: OHLCVData = { open: close, high: close, low: close, close, volume: close };
  const { bars } = run(
    result.code,
    result.varSlots,
    result.taSlotCount,
    data,
    result.fnVarSlotCount,
    result.historySlotCount,
    result.taScratchSize,
  );
  return bars as Record<string, number>[];
}

const PT = "type Pt\n    float x = 0.0";

describe("Analyzer arity-disjoint method overloads (C687)", () => {
  it("accepts two same-type same-name methods with disjoint arity and registers base + $ov$2 keys", () => {
    const prog = analyzeSource(
      [PT, "method init(Pt this, float a) => this.x := a", "method init(Pt this, float a, float b) => this.x := a * b"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(mangleMethodName("Pt", "init"))).toBe(true);
    expect(prog.funcs.has(`${mangleMethodName("Pt", "init")}$ov$2`)).toBe(true);
    const entries = prog.methodOverloads.get(mangleMethodName("Pt", "init"));
    expect(entries?.map((e) => [e.min, e.max])).toEqual([
      [2, 2],
      [3, 3],
    ]);
  });

  it("accepts three same-type overloads when all arity ranges are pairwise disjoint (wild SessionTime.init pattern)", () => {
    const prog = analyzeSource(
      [
        "type S",
        "    int v = 0",
        "method init(S this, int unixTime) => this.v := unixTime",
        "method init(S this, int h, int m) => this.v := h * 60 + m",
        "method init(S this, int h, int m, string tz) => this.v := h * 60 + m + str.length(tz)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(`${mangleMethodName("S", "init")}$ov$3`)).toBe(true);
  });

  it("still rejects redeclaring the same method with identical arity (needs type dispatch — out of scope)", () => {
    const prog = analyzeSource([PT, "method area(Pt p) => p.x", "method area(Pt p) => p.x + 1.0"].join("\n"));
    expect(prog.errors.some((e) => e.includes("method already defined") && e.includes("Pt.area"))).toBe(true);
  });

  it("still rejects overloads whose arity ranges overlap through default parameters ([2,3] vs [3,3] incl. receiver)", () => {
    const prog = analyzeSource(
      [PT, "method f(Pt this, float a = na) => this.x", "method f(Pt this, float a) => this.x + a"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("method already defined") && e.includes("Pt.f"))).toBe(true);
  });

  it("still rejects same-arity scalar-element overloads that fold to the same 'array' base (label[]/line[] 예시는 C688이 drawing-elem 판별자로 허용 전환 — 아래 C688 블록 참조, 값 흐름 추적이 필요한 스칼라 원소 축은 계속 거부)", () => {
    const prog = analyzeSource(
      [
        "method clearAll(array<string> l) =>",
        "    array.size(l)",
        "method clearAll(array<float> l) =>",
        "    array.size(l)",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("method already defined") && e.includes("array.clearAll"))).toBe(true);
  });

  it("a dot call matching no overload's range reports the standard arity error against the first declaration", () => {
    const prog = analyzeSource(
      [
        PT,
        "method f(Pt this) => this.x",
        "method f(Pt this, float a, float b) => this.x + a + b",
        "t = Pt.new()",
        "y = t.f(1.0)",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("'Pt.f' call argument count mismatch"))).toBe(true);
  });

  it("dispatches dot-sugar, bare-call, and container-receiver call sites by provided argument count", () => {
    const prog = analyzeSource(
      [
        PT,
        "method init(Pt this, float a) => this.x := a",
        "method init(Pt this, float a, float b) => this.x := a * b",
        "type Result",
        "    string name = na",
        "method tally(Result[] data) =>",
        "    array.size(data)",
        "method tally(Result[] data, string name, string value, color bg = na) =>",
        "    array.push(data, Result.new(name))",
        "    array.size(data)",
        "p = Pt.new()",
        "p.init(1.0)",
        "p.init(1.0, 2.0)",
        "init(p, 3.0)",
        "var rs = array.new<Result>()",
        "n0 = rs.tally()",
        "n1 = rs.tally(\"a\", \"b\")",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(`${mangleMethodName("array", "tally")}$ov$2`)).toBe(true);
  });

  it("keeps two different UDTs' same-named methods distinct without creating an overload table", () => {
    const prog = analyzeSource(
      ["type Rect", "    float w = 0.0", PT, "method area(Rect r) => r.w", "method area(Pt p) => p.x"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.methodOverloads.size).toBe(0);
  });

  it("emits two distinct top-level JS functions for the overload declarations (codegen last-wins guard)", () => {
    const result = transpile(
      [
        "//@version=5",
        "indicator(\"t\")",
        PT,
        "method init(Pt this, float a) => this.x := a",
        "method init(Pt this, float a, float b) => this.x := a * b",
        "p = Pt.new()",
        "p.init(1.0)",
        "p.init(1.0, 2.0)",
        "plot(p.x)",
      ].join("\n"),
    );
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.code).toContain("function Pt$init(");
    expect(result.code).toContain("function Pt$init$ov$2(");
  });

  it("scalar-receiver extension method overloads dispatch by count through resolveScalarMethodInfo", () => {
    const prog = analyzeSource(
      [
        "method tag(string s) => s + \"!\"",
        "method tag(string s, string suffix, string prefix) => prefix + s + suffix",
        "a = \"x\".tag()",
        "b = \"x\".tag(\"?\", \"-\")",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(`${mangleMethodName("string", "tag")}$ov$2`)).toBe(true);
  });
});

// C688: same-arity 원소타입 오버로드 중 drawing-elem 서브셋(wild clear_aLabLin label[]/line[] 6파일 +
// clear_arr/deleteall 2파일). MethodOverloadEntry.elemKind 판별자(receiver array<drawing 6종> 원소
// kind) — 등록 게이트는 겹치는 상대 전부와 elemKind가 서로 다를 때만 통과, 디스패치는 call-expr.ts
// array extension 분기가 resolveArrayElemDrawingKind(callee.obj)로 확정 후 노드-캐시
// (prog.methodOverloadResolutions)에 남겨 codegen이 재사용(C224 — codegen은 scope 체인 부재로
// 재유도 불가). 스칼라/UDT 원소·2번째-매개변수 타입 분기는 계속 하드 에러(LIMITATIONS C687).
const LABLIN = [
  "method tag(label[] l) =>",
  "    array.size(l) + 100",
  "method tag(line[] l) =>",
  "    array.size(l) + 200",
].join("\n");

describe("Analyzer same-arity drawing-elem method overloads (C688)", () => {
  it("accepts a same-arity label[]/line[] pair and registers base + $ov$2 with elemKind discriminators", () => {
    const prog = analyzeSource(LABLIN);
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(mangleMethodName("array", "tag"))).toBe(true);
    expect(prog.funcs.has(`${mangleMethodName("array", "tag")}$ov$2`)).toBe(true);
    const entries = prog.methodOverloads.get(mangleMethodName("array", "tag"));
    expect(entries?.map((e) => e.elemKind)).toEqual(["label", "line"]);
  });

  it("accepts qualifier-prefixed receiver hints (series label[] / series line[]) through the same strip rule as receiver folding", () => {
    const prog = analyzeSource(
      [
        "method tag(series label[] l) =>",
        "    array.size(l) + 100",
        "method tag(series line[] l) =>",
        "    array.size(l) + 200",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(`${mangleMethodName("array", "tag")}$ov$2`)).toBe(true);
  });

  it("accepts a three-way same-arity label[]/line[]/box[] group (pairwise distinct elemKind)", () => {
    const prog = analyzeSource(
      [
        LABLIN,
        "method tag(box[] l) =>",
        "    array.size(l) + 300",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has(`${mangleMethodName("array", "tag")}$ov$3`)).toBe(true);
  });

  it("accepts a mixed table: same-arity label[]/line[] pair plus an arity-disjoint third overload", () => {
    const prog = analyzeSource(
      [
        LABLIN,
        "method tag(label[] l, int n) =>",
        "    array.size(l) + n",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    const entries = prog.methodOverloads.get(mangleMethodName("array", "tag"));
    expect(entries?.length).toBe(3);
  });

  it("still rejects declaring the same drawing elem kind twice with the same arity (label[]/label[])", () => {
    const prog = analyzeSource(
      [
        "method tag(label[] l) =>",
        "    array.size(l) + 100",
        "method tag(label[] m) =>",
        "    array.size(m) + 200",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("method already defined") && e.includes("array.tag"))).toBe(true);
  });

  it("still rejects a same-arity pair where only one side is a drawing elem (label[] vs array<float>)", () => {
    const prog = analyzeSource(
      [
        "method tag(label[] l) =>",
        "    array.size(l) + 100",
        "method tag(array<float> m) =>",
        "    array.size(m) + 200",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("method already defined") && e.includes("array.tag"))).toBe(true);
  });

  it("still rejects same-arity element-type overloads on scalar/UDT elems mixed groups (wild arrayStorage string/bool/bar/int/label — one drawing member cannot rescue the group)", () => {
    const prog = analyzeSource(
      [
        "type Bar2",
        "    float v = 0.0",
        "method store(array<string> id, int cap) =>",
        "    array.size(id) + cap",
        "method store(array<bool> id, int cap) =>",
        "    array.size(id) + cap",
        "method store(array<label> id, int cap) =>",
        "    array.size(id) + cap",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("method already defined") && e.includes("array.store"))).toBe(true);
  });

  it("dispatches dot-sugar call sites by receiver elem kind and caches the decision per call site (methodOverloadResolutions)", () => {
    const prog = analyzeSource(
      [
        LABLIN,
        "var label[] labs = array.new_label()",
        "var line[] lins = array.new_line()",
        "a = labs.tag()",
        "b = lins.tag()",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    const resolved = [...prog.methodOverloadResolutions.values()].sort();
    expect(resolved).toEqual([mangleMethodName("array", "tag"), `${mangleMethodName("array", "tag")}$ov$2`]);
  });

  it("dispatches UDT-field receivers (wild MSS.l_bosBl.clear_aLabLin pattern) through resolveArrayElemDrawingKind's field-hint path", () => {
    const prog = analyzeSource(
      [
        "type Holder",
        "    label[] labs",
        "    line[] lins",
        LABLIN,
        "var Holder h = Holder.new(array.new_label(), array.new_line())",
        "x = h.labs.tag()",
        "y = h.lins.tag()",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.methodOverloadResolutions.size).toBe(2);
  });

  it("dispatches an untyped UDF parameter receiver when call-site back-propagation (C505) pins its elem kind", () => {
    const prog = analyzeSource(
      [
        LABLIN,
        "f(arr) =>",
        "    arr.tag()",
        "var label[] labs = array.new_label()",
        "q = f(labs)",
      ].join("\n"),
    );
    expect(prog.errors).toEqual([]);
  });

  it("rejects a call site whose receiver elem kind cannot be determined (dead-code UDF param, C678 placeholder) with an explicit error instead of silent dispatch", () => {
    const prog = analyzeSource(
      [
        LABLIN,
        "f(arr) =>",
        "    arr.tag()",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("multiple 'array.tag' overloads declared with the same argument count"))).toBe(true);
  });

  it("a call matching neither same-arity entry still reports the standard arity error against the first declaration", () => {
    const prog = analyzeSource(
      [
        LABLIN,
        "var label[] labs = array.new_label()",
        "z = labs.tag(1, 2, 3)",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("'array.tag' call argument count mismatch"))).toBe(true);
  });

  it("codegen emits two distinct top-level JS functions and binds each call site to its elemKind-selected overload", () => {
    const result = transpile(
      [
        "//@version=5",
        "indicator(\"t\")",
        LABLIN,
        "var label[] labs = array.new_label()",
        "var line[] lins = array.new_line()",
        "a = labs.tag()",
        "b = lins.tag()",
        "plot(a + b)",
      ].join("\n"),
    );
    expect(result.ok, result.ok ? "" : result.errors.join("; ")).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.code).toContain("function array$tag(");
    expect(result.code).toContain("function array$tag$ov$2(");
    // 콜사이트: label receiver -> base, line receiver -> $ov$2 (선언부 2 + 콜 2 = 총 4 매치)
    expect([...result.code.matchAll(/array\$tag\$ov\$2\(/g)].length).toBe(2);
  });
});

describe("E2E same-arity drawing-elem method overloads (C688, hand-verified)", () => {
  it("hand-verified E2E: label[]/line[] receivers dispatch to distinct bodies (size+100 vs size+200)", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        LABLIN,
        "var label[] labs = array.new_label()",
        "var line[] lins = array.new_line()",
        "if bar_index == 0",
        "    array.push(labs, label.new(0, 0.0, \"t\"))",
        "a = labs.tag()",
        "b = lins.tag()",
        "var float __obs_a = na",
        "var float __obs_b = na",
        "__obs_a := a",
        "__obs_b := b",
      ].join("\n"),
      [1, 2],
    );
    expect(bars[1]!["var:__obs_a"]).toBe(101); // size 1 + 100 (label 오버로드)
    expect(bars[1]!["var:__obs_b"]).toBe(200); // size 0 + 200 (line 오버로드)
  });

  it("hand-verified E2E: UDT-field receivers (wild clear_aLabLin call shape) dispatch per field elem type", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        "type Holder",
        "    label[] labs",
        "    line[] lins",
        LABLIN,
        "var Holder h = Holder.new(array.new_label(), array.new_line())",
        "x = h.labs.tag()",
        "y = h.lins.tag()",
        "var float __obs_x = na",
        "var float __obs_y = na",
        "__obs_x := x",
        "__obs_y := y",
      ].join("\n"),
      [1],
    );
    expect(bars[0]!["var:__obs_x"]).toBe(100);
    expect(bars[0]!["var:__obs_y"]).toBe(200);
  });

  it("hand-verified E2E: mutating overload bodies (wild deleteall box[]/line[] pattern) clear their own receiver only", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        "method wipe(box[] l) =>",
        "    array.clear(l)",
        "    array.size(l)",
        "method wipe(line[] l) =>",
        "    array.size(l)",
        "var box[] bxs = array.new_box()",
        "var line[] lns = array.new_line()",
        "if bar_index == 0",
        "    array.push(bxs, box.new(0, 1.0, 1, 0.0))",
        "    array.push(lns, line.new(0, 1.0, 1, 2.0))",
        "a = bxs.wipe()",
        "b = lns.wipe()",
        "var float __obs_a = na",
        "var float __obs_b = na",
        "__obs_a := a",
        "__obs_b := b",
      ].join("\n"),
      [1],
    );
    expect(bars[0]!["var:__obs_a"]).toBe(0); // box 오버로드는 clear 후 size=0
    expect(bars[0]!["var:__obs_b"]).toBe(1); // line 오버로드는 clear 없이 size=1
  });
});

describe("E2E arity-disjoint method overloads (C687, hand-verified)", () => {
  it("hand-verified E2E: dot + bare call sites dispatch to the right overload (mutation observed via fields)", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        PT,
        "method init(Pt this, float a) => this.x := a",
        "method init(Pt this, float a, float b) => this.x := a * b",
        "var Pt p1 = Pt.new()",
        "var Pt p2 = Pt.new()",
        "var Pt p3 = Pt.new()",
        "p1.init(10.0)",
        "p2.init(10.0, 5.0)",
        "init(p3, 7.0)",
        "var float __obs_a = na",
        "var float __obs_b = na",
        "var float __obs_c = na",
        "__obs_a := p1.x",
        "__obs_b := p2.x",
        "__obs_c := p3.x",
      ].join("\n"),
      [1, 2],
    );
    expect(bars[1]!["var:__obs_a"]).toBe(10);
    expect(bars[1]!["var:__obs_b"]).toBe(50);
    expect(bars[1]!["var:__obs_c"]).toBe(7);
  });

  it("hand-verified E2E: three-way overload (wild SessionTime.init pattern) returns per-arity values", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        "type S",
        "    int v = 0",
        "method init(S this, int unixTime) => this.v := unixTime",
        "method init(S this, int h, int m) => this.v := h * 60 + m",
        "method init(S this, int h, int m, string tz) => this.v := h * 60 + m + str.length(tz)",
        "var S s1 = S.new()",
        "var S s2 = S.new()",
        "var S s3 = S.new()",
        "s1.init(100)",
        "s2.init(2, 30)",
        "s3.init(2, 30, \"XY\")",
        "var float __obs_a = na",
        "var float __obs_b = na",
        "var float __obs_c = na",
        "__obs_a := s1.v",
        "__obs_b := s2.v",
        "__obs_c := s3.v",
      ].join("\n"),
      [1],
    );
    expect(bars[0]!["var:__obs_a"]).toBe(100);
    expect(bars[0]!["var:__obs_b"]).toBe(150);
    expect(bars[0]!["var:__obs_c"]).toBe(152);
  });

  it("hand-verified E2E: container-receiver overloads with a default parameter ([1,1] vs [3,4], wild AddResult pattern)", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        "type Result",
        "    string name = na",
        "method tally(Result[] data) =>",
        "    array.size(data)",
        "method tally(Result[] data, string name, string value, color bg = na) =>",
        "    array.push(data, Result.new(name))",
        "    array.size(data)",
        "var rs = array.new<Result>()",
        "n1 = rs.tally(\"a\", \"b\")",
        "n0 = rs.tally()",
        "var float __obs_n0 = na",
        "var float __obs_n1 = na",
        "__obs_n0 := n0",
        "__obs_n1 := n1",
      ].join("\n"),
      [1],
    );
    expect(bars[0]!["var:__obs_n1"]).toBe(1);
    expect(bars[0]!["var:__obs_n0"]).toBe(1);
  });

  it("hand-verified E2E: overloads with internal var state keep call-site independent slots (slotBase mechanism intact)", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        "type C",
        "    int dummy = 0",
        "method count(C this) =>",
        "    var int n = 0",
        "    n := n + 1",
        "    n",
        "method count(C this, int step) =>",
        "    var int n = 0",
        "    n := n + step",
        "    n",
        "var C c = C.new()",
        "var float __obs_a = na",
        "var float __obs_b = na",
        "__obs_a := c.count()",
        "__obs_b := c.count(10)",
      ].join("\n"),
      [1, 2, 3],
    );
    expect(bars[2]!["var:__obs_a"]).toBe(3);
    expect(bars[2]!["var:__obs_b"]).toBe(30);
  });

  it("hand-verified E2E: scalar-receiver string overloads produce per-arity strings (dispatch through the scalar fallback)", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        "method mark(string s) => s + \"!\"",
        "method mark(string s, string suffix, string prefix) => prefix + s + suffix",
        "a = \"x\".mark()",
        "b = \"y\".mark(\"?\", \"<\")",
        "var float __obs_a = na",
        "var float __obs_b = na",
        "__obs_a := str.length(a)",
        "__obs_b := str.length(b)",
      ].join("\n"),
      [1],
    );
    expect(bars[0]!["var:__obs_a"]).toBe(2); // "x!"
    expect(bars[0]!["var:__obs_b"]).toBe(3); // "<y?"
  });

  it("hand-verified E2E: an overload's body calling its sibling overload dispatches by count inside the body too", () => {
    const bars = runBars(
      [
        "//@version=5",
        "indicator(\"t\")",
        PT,
        "method scale(Pt this, float k) => this.x := this.x * k",
        "method scale(Pt this, float k, float extra) =>",
        "    this.scale(k)",
        "    this.x := this.x + extra",
        "var Pt p = Pt.new(2.0)",
        "p.scale(3.0, 1.0)",
        "var float __obs_x = na",
        "__obs_x := p.x",
      ].join("\n"),
      [1],
    );
    expect(bars[0]!["var:__obs_x"]).toBe(7); // 2*3 + 1
  });
});
