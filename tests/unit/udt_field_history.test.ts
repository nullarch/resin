// UDT 인스턴스 스칼라 필드 히스토리 obj.field[N](C523, wild "히스토리 인덱스는 식별자에만 지원"
// 클러스터 잔여 최다 서브그룹) hand-verified 테스트. TV 공식 문서를 사이클 세션에서 검증할 수 없고
// (웹 접근 없음, VERIFIED_SEMANTICS 근거 없음) pine2py는 _gen_index_access가 obj가 Identifier가
// 아니면 plain subscript를 방출해 크래시(C522 실측)라 오라클 대조도 원천 불가 — 시맨틱은
// "필드 값의 바 종료 커밋 시리즈"(top-level var 히스토리 C363과 동일)로 설계했고 DIVERGENCES에
// "TV 미검증(가설)"로 등재돼 있다. 이 파일의 assertion은 그 설계 시맨틱의 회귀 방지이지 TV 정합
// 증명이 아니다. 수신자는 top-level var/varip UDT 또는 depth-0 무조건 '=' 로컬만(바-종료 record
// 루프가 볼 수 있는 저장소) — UDF 내부 수신자/중첩 블록/튜플/chart.point는 하드 에러.

import { describe, expect, it } from "vitest";
import { analyze } from "../../src/transpiler/analyzer";
import { parse } from "../../src/transpiler/parser";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [2, 3, 4, 5, 6],
  low: [0, 1, 2, 3, 4],
  close: [10, 20, 30, 40, 50],
  volume: [1, 1, 1, 1, 1],
};

function obs(source: string, key = "__obs_a"): unknown[] {
  const result = runPipeline(source, data);
  return result.bars.map((b) => b[`var:${key}`]);
}

function analyzeSource(source: string) {
  return analyze(parse(source));
}

const MARKER = ["type Marker", "    float price"];

describe("UDT field history — execution (C523, hand-verified)", () => {
  it("reads the previous-bar committed field value of a top-level var UDT receiver", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "m.price := close * 2", "var float __obs_a = na", "__obs_a := m.price[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, 20, 40, 60, 80]);
  });

  it("reads an int counter field two bars back ([2] warmup gap)", () => {
    const src = [
      "type C",
      "    int cnt",
      "var C m = C.new(0)",
      "m.cnt := m.cnt + 1",
      "var float __obs_a = na",
      "__obs_a := m.cnt[2]",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, 1, 2, 3]);
  });

  it("records NaN (not a crash) on bars where the receiver is still na", () => {
    const src = [
      ...MARKER,
      "var Marker m = na",
      "if bar_index >= 2",
      "    m := Marker.new(close)",
      "var float __obs_a = na",
      "__obs_a := m.price[1]",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, NaN, 30, 40]);
  });

  it("supports a depth-0 '=' local receiver reconstructed every bar (type-prefixed decl)", () => {
    const src = ["type Box", "    float hi", "Box b = Box.new(high + 1)", "var float __obs_a = na", "__obs_a := b.hi[1]"].join("\n");
    expect(obs(src)).toEqual([NaN, 3, 4, 5, 6]);
  });

  it("supports a dynamic (runtime) offset via rt.histGet with the off===0 current-value branch", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(na)",
      "m.price := close",
      "o = math.min(bar_index, 1)",
      "var float __obs_a = na",
      "__obs_a := m.price[o]",
    ].join("\n");
    expect(obs(src)).toEqual([10, 10, 20, 30, 40]);
  });

  it("treats [0] as an identity read equal to the bare field value (no slot, no warmup gap)", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "m.price := close * 2", "var float __obs_a = na", "__obs_a := m.price[0]"].join("\n");
    expect(obs(src)).toEqual([20, 40, 60, 80, 100]);
  });

  it("keeps exact values when the read sits inside a conditional branch (record is unconditional)", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(na)",
      "m.price := close",
      "var float __obs_a = na",
      "if close > 25",
      "    __obs_a := m.price[1]",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, NaN, 20, 30, 40]);
  });

  it("allows reading a top-level receiver's field history inside a UDF body (free name, global slot)", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(na)",
      "m.price := close * 2",
      "f() =>",
      "    m.price[1]",
      "var float __obs_a = na",
      "__obs_a := f()",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, 20, 40, 60, 80]);
  });

  it("stores bool fields as 0/1 numbers in the Float64Array slot (same as var bool history)", () => {
    const src = ["type Flag", "    bool up", "var Flag g = Flag.new(false)", "g.up := close > 25", "var float __obs_a = na", "__obs_a := g.up[1]"].join(
      "\n",
    );
    expect(obs(src)).toEqual([NaN, 0, 0, 1, 1]);
  });

  it("commits the final object's field when the receiver is reassigned mid-bar (bar-close commit semantics)", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(0)",
      "m.price := close",
      "m := Marker.new(close * 10)",
      "var float __obs_a = na",
      "__obs_a := m.price[1]",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, 100, 200, 300, 400]);
  });
});

describe("UDT field history — analyzer gates (C523)", () => {
  it("allocates one named slot per receiver.field key and no errors for the valid var form", () => {
    const prog = analyzeSource(
      [...MARKER, "var Marker m = Marker.new(na)", "m.price := close", "x = m.price[1]", "y = m.price[2]"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.udtFieldHistorySlots.has("m.price")).toBe(true);
    expect(prog.udtFieldHistorySlots.size).toBe(1);
    expect(prog.historySlotCount).toBe(1);
  });

  it("allows a UDF/method parameter UDT receiver (call-site independent field history, C750)", () => {
    const prog = analyzeSource([...MARKER, "f(Marker x) =>", "    x.price[1]", "y = f(Marker.new(1.0))"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.get("f")?.localFieldHistSlots.get("x.price")).toBe(0);
    expect(prog.funcs.get("f")?.localHistSlotCount).toBe(1);
    // 매개변수 UDT 필드 슬롯은 top-level udtFieldHistorySlots와 별개 저장소(함수-상대 카운터).
    expect(prog.udtFieldHistorySlots.size).toBe(0);
  });

  it("still rejects a UDF/method-internal var/'=' local UDT receiver (record-timing ambiguity, out of slice, C750)", () => {
    const prog = analyzeSource(
      [...MARKER, "f() =>", "    var Marker x = Marker.new(1.0)", "    y = x.price[1]"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("UDF/method 내부 UDT 수신자"))).toBe(true);
  });

  it("rejects a string-typed field (Float64Array slot cannot hold strings)", () => {
    const prog = analyzeSource(["type T", "    string s", 'var T x = T.new("a")', "y = x.s[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("string 타입 UDT 필드"))).toBe(true);
  });

  it("rejects a color-typed field (color values are strings in this engine)", () => {
    const prog = analyzeSource(["type T", "    color c", "var T x = T.new(color.red)", "y = x.c[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("color 타입 UDT 필드"))).toBe(true);
  });

  it("rejects a nested-UDT-typed field (reference type)", () => {
    const prog = analyzeSource(
      ["type Inner", "    float v", "type Outer", "    Inner core", "var Outer o = na", "y = o.core[1]"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("UDT 타입 UDT 필드"))).toBe(true);
  });

  it("rejects a map-typed field (reference type; array fields stay element-access per C501)", () => {
    const prog = analyzeSource(["type T", "    map<string, float> mm", "var T x = na", "y = x.mm[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("map 타입 UDT 필드"))).toBe(true);
  });

  it("keeps array-typed fields on the C501 element-access path (no history slot, no error)", () => {
    const prog = analyzeSource(
      ["type T", "    array<float> xs", "var T x = T.new(array.new<float>(3, 0.0))", "y = x.xs[1]"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.udtFieldHistorySlots.size).toBe(0);
  });

  it("rejects a nested-block '=' local receiver (JS let — invisible to the bar-end record loop)", () => {
    const prog = analyzeSource(
      ["type T", "    float v", "if close > 0", "    x = T.new(1.0)", "    y = x.v[1]"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("top-level var/varip 또는 무조건(depth-0)"))).toBe(true);
  });

  it("rejects a tuple-destructured receiver (no per-name record injection point)", () => {
    const prog = analyzeSource(
      [
        "type T",
        "    float v",
        "f() =>",
        "    a = T.new(close)",
        "    b = T.new(open)",
        "    [a, b]",
        "[x, y] = f()",
        "z = x.v[1]",
      ].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("top-level var/varip 또는 무조건(depth-0)"))).toBe(true);
  });

  it("rejects chart.point receivers (fields are number|null — null would corrupt to 0 in the slot)", () => {
    const prog = analyzeSource(["var chart.point p = na", "y = p.price[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("chart.point 필드"))).toBe(true);
  });

  it("keeps the legacy identifier-only rejection for non-UDT DotAccess receivers", () => {
    const prog = analyzeSource("y = foo.bar[1]");
    expect(prog.errors.some((e) => e.includes("식별자(bar series 또는 top-level var)에만 지원"))).toBe(true);
  });
});

describe("UDT field history — codegen output (C523)", () => {
  it("emits a null-safe bar-end record line for the var receiver", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "m.price := close", "x = m.price[1]"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.histSlots[0].record($.vars[0]?.price);");
      expect(result.code).toContain("$.histSlots[0].get(1)");
    }
  });

  it("emits rt.histGet with a null-guarded current-value argument for dynamic offsets", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "m.price := close", "o = math.min(bar_index, 1)", "x = m.price[o]"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.histGet(($.vars[0]?.price ?? NaN), $.histSlots[0], ");
    }
  });
});

describe("UDT field history — UDF/method parameter receiver (C750)", () => {
  it("emits an entry-point record line and __histBase-relative slot for the parameter receiver", () => {
    const src = [...MARKER, "f(Marker x) =>", "    x.price[1]", "y = f(Marker.new(1.0))"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.histSlots[__histBase + 0].record(x.price);");
      expect(result.code).toContain("$.histSlots[__histBase + 0].get(1)");
    }
  });

  it("emits rt.histGet with a null-guarded current-value argument for dynamic offsets on a parameter field", () => {
    const src = [...MARKER, "f(Marker x, o) =>", "    x.price[o]", "y = f(Marker.new(1.0), 1)"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.histGet((x?.price ?? NaN), $.histSlots[__histBase + 0], ");
    }
  });

  it("reads the entry-time field value one/two bars back (call-site scoped, single call site)", () => {
    const src = [
      ...MARKER,
      "f(Marker x) =>",
      "    x.price[1] + x.price[2]",
      "var Marker m = Marker.new(na)",
      "m.price := close",
      "var float __obs_a = na",
      "__obs_a := f(m)",
    ].join("\n");
    // bar0/1: 워밍업(price[2] 미충족). bar2: close[1]+close[2] = 20+10 = 30, bar3: 30+20=50, bar4: 40+30=70.
    expect(obs(src)).toEqual([NaN, NaN, 30, 50, 70]);
  });

  it("treats [0] on a parameter field as an identity read equal to the bare field value", () => {
    const src = [
      ...MARKER,
      "f(Marker x) =>",
      "    x.price[0]",
      "var Marker m = Marker.new(na)",
      "m.price := close * 2",
      "var float __obs_a = na",
      "__obs_a := f(m)",
    ].join("\n");
    expect(obs(src)).toEqual([20, 40, 60, 80, 100]);
  });

  it("does not crash across multiple bars when the receiver field starts na", () => {
    const src = [
      ...MARKER,
      "f(Marker x) =>",
      "    x.price[1]",
      "var Marker m = Marker.new(na)",
      "if bar_index >= 2",
      "    m.price := close",
      "var float __obs_a = na",
      "__obs_a := f(m)",
    ].join("\n");
    expect(() => runPipeline(src, data)).not.toThrow();
  });
});
