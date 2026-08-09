// C686: arity-disjoint 함수 오버로드 rename prepass (src/transpiler/analyzer/func-overloads.ts).
// TV v5는 같은 이름의 UDF를 시그니처가 다르면 오버로드로 수용한다(wild tv_verdict_v2 실측 대장
// "이름이 이미 다른 선언과 충돌함" 클러스터 accept 19파일이 arity-disjoint 서브셋). pine2py는
// 동명 UDF가 Python def 재정의(마지막 선언이 조용히 승리)로 내려가는 latent 버그라 오라클 대조
// 불가 — 전부 hand-verified.
import { describe, it, expect } from "vitest";
import { parse } from "../../src/transpiler/parser";
import { analyze, type AnalyzeOptions } from "../../src/transpiler/analyzer";
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

describe("Analyzer arity-disjoint UDF overloads (C686)", () => {
  it("accepts two same-name FuncDecls with disjoint arity ranges (0-arg vs 2-arg, wild newPivot template)", () => {
    const prog = analyzeSource("f() => 10.0\nf(a, b) => a + b\nx = f()\ny = f(1.0, 2.0)");
    expect(prog.errors).toEqual([]);
  });

  it("accepts three same-name FuncDecls when all arity ranges are pairwise disjoint", () => {
    const prog = analyzeSource("g(a) => a\ng(a, b) => a + b\ng(a, b, c) => a + b + c\nx = g(1) + g(1, 2) + g(1, 2, 3)");
    expect(prog.errors).toEqual([]);
  });

  it("registers renamed FuncInfos for the 2nd+ overloads while the first keeps the original name", () => {
    const prog = analyzeSource("f() => 10.0\nf(a, b) => a + b\nx = f(1.0, 2.0)");
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has("f")).toBe(true);
    expect(prog.funcs.has("f$ov$2")).toBe(true);
    expect(prog.funcs.get("f$ov$2")?.paramNames).toEqual(["a", "b"]);
  });

  it("still rejects two same-name FuncDecls with identical arity (needs type dispatch — out of scope)", () => {
    const prog = analyzeSource("f(x) => x + 1\nf(y) => y + 2");
    expect(prog.errors.some((e) => e.includes("이름이 이미 다른 선언과 충돌함") && e.includes("f"))).toBe(true);
  });

  it("still rejects overloads whose arity ranges overlap through default parameters ([1,2] vs [2,2])", () => {
    const prog = analyzeSource("f(a, b = 1) => a + b\nf(x, y) => x * y");
    expect(prog.errors.some((e) => e.includes("이름이 이미 다른 선언과 충돌함") && e.includes("f"))).toBe(true);
  });

  it("default parameters count toward the disjointness range: [0,1] vs [2,3] is accepted and dispatched by count", () => {
    const prog = analyzeSource("f(a = 1.0) => a\nf(x, y, z = 0.0) => x + y + z\np = f() + f(2.0) + f(1.0, 2.0) + f(1.0, 2.0, 3.0)");
    expect(prog.errors).toEqual([]);
  });

  it("a call matching no overload's range reports the arity error against the first declaration's name", () => {
    const prog = analyzeSource("f() => 10.0\nf(a, b) => a + b\nx = f(1.0, 2.0, 3.0, 4.0)");
    expect(prog.errors.some((e) => e.includes("'f' 호출 인자 개수 불일치"))).toBe(true);
  });

  it("dispatches forward-reference call sites that appear before both declarations (C255 prepass order)", () => {
    const prog = analyzeSource("x = f(1.0, 2.0)\ny = f()\nf() => 10.0\nf(a, b) => a + b");
    expect(prog.errors).toEqual([]);
  });

  it("keyword-argument call sites dispatch by total specified count (positional + kwargs, C396)", () => {
    const prog = analyzeSource("f() => 10.0\nf(a, b) => a + b\nx = f(1.0, b = 2.0)");
    expect(prog.errors).toEqual([]);
    // 잘못된 kwarg 이름은 count로 매칭된 그 오버로드 기준으로 검증된다
    const bad = analyzeSource("f() => 10.0\nf(a, b) => a + b\nx = f(1.0, c = 2.0)");
    expect(bad.errors.some((e) => e.includes("없는 매개변수 이름"))).toBe(true);
  });

  it("does not touch a name that also has a same-name MethodDecl (bare-method dispatch interplay guard)", () => {
    const prog = analyzeSource(
      ["type P", "    float v", "method f(P p) => p.v", "f() => 10.0", "f(a, b) => a + b"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("이름이 이미 다른 선언과 충돌함") && e.includes("f"))).toBe(true);
  });

  it("single (non-duplicated) FuncDecls are left completely untouched", () => {
    const prog = analyzeSource("helper(x) => x + 1\ny = helper(close)");
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.has("helper")).toBe(true);
    expect([...prog.funcs.keys()].some((k) => k.includes("$ov$"))).toBe(false);
  });
});

describe("E2E arity-disjoint UDF overloads (C686, hand-verified)", () => {
  it("hand-verified E2E: 0-arg and 2-arg overloads dispatch independently across bars", () => {
    const source = [
      "f() => 10.0",
      "f(a, b) => a + b + 100.0",
      "var float __obs_zero = na",
      "var float __obs_two = na",
      "__obs_zero := f()",
      "__obs_two := f(close, 1.0)",
    ].join("\n");
    const bars = runBars(source, [1, 2, 3]);
    expect(bars.map((b) => b["var:__obs_zero"])).toEqual([10, 10, 10]);
    expect(bars.map((b) => b["var:__obs_two"])).toEqual([102, 103, 104]);
  });

  it("hand-verified E2E: an overload calling its sibling overload dispatches by count inside the body too", () => {
    const source = [
      "f(a) => a * 2.0",
      "f(a, b) => f(a) + f(b)",
      "var float __obs_x = na",
      "__obs_x := f(3.0, 4.0)",
    ].join("\n");
    const bars = runBars(source, [1, 2]);
    expect(bars.map((b) => b["var:__obs_x"])).toEqual([14, 14]);
  });

  it("hand-verified E2E: per-overload var/TA state stays call-site independent (slotBase mechanism intact)", () => {
    const source = [
      "count() =>",
      "    var float n = 0.0",
      "    n := n + 1.0",
      "    n",
      "count(step) =>",
      "    var float n = 0.0",
      "    n := n + step",
      "    n",
      "var float __obs_a = na",
      "var float __obs_b = na",
      "__obs_a := count()",
      "__obs_b := count(10.0)",
    ].join("\n");
    const bars = runBars(source, [1, 2, 3]);
    expect(bars.map((b) => b["var:__obs_a"])).toEqual([1, 2, 3]);
    expect(bars.map((b) => b["var:__obs_b"])).toEqual([10, 20, 30]);
  });

  it("hand-verified E2E: overloads containing stateful ta.* calls keep independent incremental state", () => {
    const source = [
      "ma(src) => ta.sma(src, 2)",
      "ma(src, len, extra) => ta.sma(src, 3) + extra",
      "var float __obs_s2 = na",
      "var float __obs_s3 = na",
      "__obs_s2 := ma(close)",
      "__obs_s3 := ma(close, 0, 1000.0)",
    ].join("\n");
    const bars = runBars(source, [2, 4, 6, 8]);
    const s2 = bars.map((b) => b["var:__obs_s2"]);
    const s3 = bars.map((b) => b["var:__obs_s3"]);
    expect(s2[0]).toBeNaN();
    expect(s2.slice(1)).toEqual([3, 5, 7]);
    expect(s3[0]).toBeNaN();
    expect(s3[1]).toBeNaN();
    expect(s3.slice(2)).toEqual([1004, 1006]);
  });

  it("hand-verified E2E: wild newPivot template — 0-arg constructor-style vs 3-arg initializer returning a UDT", () => {
    const source = [
      "type Pivot",
      "    float price",
      "    int barIdx",
      "newPivot() =>",
      "    Pivot.new(0.0, 0)",
      "newPivot(price, barIdx, offset) =>",
      "    Pivot.new(price + offset, barIdx)",
      "var float __obs_p0 = na",
      "var float __obs_p3 = na",
      "__obs_p0 := newPivot().price",
      "__obs_p3 := newPivot(close, 1, 0.5).price",
    ].join("\n");
    const bars = runBars(source, [1, 2]);
    expect(bars.map((b) => b["var:__obs_p0"])).toEqual([0, 0]);
    expect(bars.map((b) => b["var:__obs_p3"])).toEqual([1.5, 2.5]);
  });
});
