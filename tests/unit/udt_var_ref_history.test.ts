// (recv[N]).field — 히스토리 인덱스가 obj 자신을 감싸는 역순 폼(C637, wild "네임스페이스 접근은
// 호출식만 지원" objKind=IndexAccess 축, next_hint(C635/C636) — `not (ts[1]).tp1Hit`류 5파일).
// C523(udt_field_history.test.ts, obj.field[N] — 필드 다음에 히스토리)의 거울상: 여기선 히스토리가
// 먼저 오고 필드가 나중이라 참조형 원형 버퍼($.refHistSlots, drawing 핸들과 동일 물리 배열)로
// UDT 인스턴스 자체(receiver)를 통째로 record/get한다. C523과 달리 pine2py가 크래시 없이 실행
// 가능해(ctx.param()의 오브젝트 참조 push/get, gen_oracle.py 크래시 이슈는 "이 콜사이트의 첫
// 실행에서 [N]이 na"라는 워밍업 경계에서만 발생 — 이 세션 로컬 python 하네스로 직접 실측) 시맨틱을
// 실측 확정했다: var가 재대입 없이 필드만 mutate되면 recv[N]은 항상 "지금" 참조(그 참조의 CURRENT
// 필드값 그대로 반영, aliasing), var가 매 바 새 객체로 재대입되면 recv[N]이 그 바에 기록된 실제
// 과거 객체를 돌려준다(진짜 히스토리) — 두 경우 모두 "그 바에 recv가 가리키던 참조를 기록해두고
// 나중에 그 참조의 현재 필드를 읽는다"는 하나의 메커니즘(RefSeries)으로 자동 정합된다. gen_oracle.py
// 자체는 이 콜사이트의 첫 실행(워밍업 [N]이 na)에서 크래시해(C9/C14/C18/C176급 pine2py latent 크래시
// 패턴) 자동 골든 생성이 안 되므로 이 파일은 hand-verified(위 실측 기반)다.

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

const MARKER = ["type Marker", "    float price = na"];

describe("UDT var/'=' local reference history (recv[N]).field — analyzer gates (C637)", () => {
  it("allows history indexing on a top-level var holding a UDT instance and allocates a slot-keyed ref-hist slot", () => {
    const prog = analyzeSource([...MARKER, "var Marker m = Marker.new(na)", "y = m[1]"].join("\n"));
    expect(prog.errors).toEqual([]);
    const slot = prog.varIndex.get("m")!;
    expect(prog.varRefHistorySlots.has(slot)).toBe(true);
    expect(prog.refHistorySlotCount).toBe(1);
    expect(prog.historySlotCount).toBe(0);
  });

  it("resolves (recv[N]).field as a UDT field read once the analyzer visits the IndexAccess obj", () => {
    const prog = analyzeSource([...MARKER, "var Marker m = Marker.new(na)", "y = (m[1]).price"].join("\n"));
    expect(prog.errors).toEqual([]);
    const slot = prog.varIndex.get("m")!;
    expect(prog.varRefHistorySlots.has(slot)).toBe(true);
  });

  it("supports the same field-access form on a top-level '=' local (reuses refHistorySlots, name-keyed)", () => {
    const prog = analyzeSource([...MARKER, "m = Marker.new(close)", "y = (m[1]).price"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.refHistorySlots.has("m")).toBe(true);
  });

  it("supports a dynamic (runtime) offset on the wrapped IndexAccess", () => {
    const prog = analyzeSource([...MARKER, "var Marker m = Marker.new(na)", "n = 1", "y = (m[n]).price"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.dynamicHistoryOffsets.size).toBe(1);
  });

  it("still rejects a UDF-internal UDT '=' local receiver (call-site independent history, out of this slice)", () => {
    const prog = analyzeSource(
      [...MARKER, "f() =>", "    x = Marker.new(1.0)", "    (x[1]).price", "y = f()"].join("\n"),
    );
    expect(prog.errors.some((e) => e.includes("UDF internal '=' local holding UDT value"))).toBe(true);
  });

  it("allows a UDF/method parameter UDT receiver, whole-object history (C751, wild `id[i]`)", () => {
    const prog = analyzeSource([...MARKER, "f(Marker x) =>", "    (x[1]).price", "y = f(Marker.new(1.0))"].join("\n"));
    expect(prog.errors).toEqual([]);
  });

  it("does not misclassify array<UDT> element access as reference history (array-elem axis stays separate)", () => {
    const prog = analyzeSource(
      [...MARKER, "var arr = array.new<Marker>(1, Marker.new(1.0))", "n = 0", "y = (arr[n]).price"].join("\n"),
    );
    // array<UDT>의 원소-필드 체이닝은 이 슬라이스의 대상이 아니다(resolveUdtObjectType의 IndexAccess
    // 분기는 obj.obj가 UDT 타입으로 확정된 Identifier일 때만 성립 — array 변수 자신은 UDT로
    // 확정되지 않아 이 분기가 개입하지 않는다). 기존 동작(별도 축, 미지원) 그대로 유지 확인.
    expect(prog.errors.length).toBeGreaterThan(0);
  });
});

describe("UDT var/'=' local reference history — codegen output (C637)", () => {
  it("emits a slot-keyed bar-end record line for the var receiver into $.refHistSlots", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "x = (m[1]).price"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[0].record($.vars[0]);");
    }
  });

  it("emits a name-keyed bar-end record line for the '=' local receiver into $.refHistSlots", () => {
    const src = [...MARKER, "m = Marker.new(close)", "x = (m[1]).price"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[0].record(m);");
    }
  });

  it("guards the warmup-null read with a nullish-coalesced na-default UDT instance, not raw undefined", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "x = (m[1]).price"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("($.refHistSlots[0].get(1) ?? Marker()).price");
    }
  });

  it("routes the dynamic-offset read through rt.refHistGet, still na-default-guarded", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "n = 1", "x = (m[n]).price"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("(rt.refHistGet($.vars[0], $.refHistSlots[0], n) ?? Marker()).price");
    }
  });
});

describe("UDT var reference history — execution semantics (C637, hand-verified)", () => {
  it("aliases to the CURRENT field value when the var is mutated in place, never reassigned (pine2py-verified)", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(na)",
      "m.price := close",
      "var float __obs_a = na",
      "__obs_a := (m[1]).price",
    ].join("\n");
    // 매 바 close로 mutate만 하고 m 자신은 재대입되지 않으므로 (m[1])도 같은 참조 -> 항상 '지금'의
    // price(= close 그 자체)를 그대로 반영한다(pine2py 실측과 동일한 aliasing).
    expect(obs(src)).toEqual([NaN, 20, 30, 40, 50]);
  });

  it("returns the true one-bar-ago snapshot when the var is reassigned to a fresh object every bar", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(na)",
      "m := Marker.new(close)",
      "var float __obs_a = na",
      "__obs_a := (m[1]).price",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, 10, 20, 30, 40]);
  });

  it("treats [0] as an identity read equal to the bare field value (no slot, no warmup gap)", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "m.price := close", "var float __obs_a = na", "__obs_a := (m[0]).price"].join(
      "\n",
    );
    expect(obs(src)).toEqual([10, 20, 30, 40, 50]);
  });

  it("supports a top-level '=' local receiver (reconstructed fresh every bar, true history like reassignment)", () => {
    const src = [...MARKER, "m = Marker.new(close)", "var float __obs_a = na", "__obs_a := (m[1]).price"].join("\n");
    expect(obs(src)).toEqual([NaN, 10, 20, 30, 40]);
  });

  it("resolves a dynamic offset with the same aliasing/history rule (offset 0 == current, [n] a runtime int)", () => {
    const src = [
      ...MARKER,
      "var Marker m = Marker.new(na)",
      "m.price := close",
      "o = math.min(bar_index, 2)",
      "var float __obs_a = na",
      "__obs_a := (m[o]).price",
    ].join("\n");
    expect(obs(src)).toEqual([10, 20, 30, 40, 50]);
  });

  it("does not crash on bar 0 (no history yet) — na-default UDT fallback yields NaN, not a TypeError", () => {
    const src = [...MARKER, "var Marker m = Marker.new(na)", "var float __obs_a = na", "__obs_a := (m[1]).price"].join("\n");
    expect(() => obs(src)).not.toThrow();
    expect(Number.isNaN(obs(src)[0])).toBe(true);
  });
});
