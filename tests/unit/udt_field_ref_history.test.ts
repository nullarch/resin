// drawing 핸들 타입 UDT 필드 히스토리 obj.field[N](C718, wild `phl.top[1]`류 — `type Zphl \n line top`
// + `phl.top := line.new(...)` 뒤 `line.delete(phl.top[1])`, hist-index(all) 클러스터 최다
// 서브그룹). udt_field_history.test.ts(C523, 수치 필드 — Float64Array $.histSlots)의 거울상: 필드
// 타입이 drawing 핸들이면 top-level var 드로잉 핸들(C652)/UDT 인스턴스 var(C637)와 동일한 물리
// 배열($.refHistSlots, RefSeries object 원형 버퍼)로 담는다. pine2py는 _gen_index_access가 obj가
// Identifier가 아니면 plain subscript를 방출해 크래시(C522/C523 실측과 동일 latent 버그)라 오라클
// 대조가 원천 불가 — 시맨틱은 "필드 값의 바 종료 커밋 시리즈"(C523/C637과 동일)로 설계했고
// DIVERGENCES에 "TV 미검증(가설)"로 등재한다. 이 파일의 assertion은 그 설계 시맨틱의 회귀 방지다.

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

const MARKER = ["type T", "    label lb"];

describe("drawing-handle UDT field history — analyzer gates (C718)", () => {
  it("allows history indexing on a drawing-handle field of a top-level var UDT receiver", () => {
    const prog = analyzeSource([...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "y = obj.lb[1]"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.udtFieldRefHistorySlots.has("obj.lb")).toBe(true);
    expect(prog.udtFieldRefHistorySlots.size).toBe(1);
    expect(prog.refHistorySlotCount).toBe(1);
    // 별도 물리 배열/카운터를 쓴다 — 수치 필드 슬롯(historySlotCount)은 전혀 늘지 않는다.
    expect(prog.historySlotCount).toBe(0);
  });

  it("supports a dynamic (runtime) offset on the drawing-handle field", () => {
    const prog = analyzeSource(
      [...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "n = 1", "y = obj.lb[n]"].join("\n"),
    );
    expect(prog.errors).toEqual([]);
    expect(prog.dynamicHistoryOffsets.size).toBe(1);
  });

  it("treats [0] as an identity read — no ref-hist slot allocated", () => {
    const prog = analyzeSource([...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "y = obj.lb[0]"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.udtFieldRefHistorySlots.size).toBe(0);
  });

  it("supports a depth-0 '=' local receiver reconstructed every bar", () => {
    const prog = analyzeSource(["type Box", "    label lb", "Box b = Box.new(na)", "y = b.lb[1]"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.udtFieldRefHistorySlots.has("b.lb")).toBe(true);
  });

  it("allows method-call sugar chained directly on the history-indexed field, e.g. (obj.lb[1]).get_x()", () => {
    const prog = analyzeSource([...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "y = (obj.lb[1]).get_x()"].join("\n"));
    expect(prog.errors).toEqual([]);
  });

  it("allows a UDF/method parameter UDT receiver (call-site independent field history, C750)", () => {
    const prog = analyzeSource([...MARKER, "f(T x) =>", "    x.lb[1]", "y = f(T.new(na))"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.funcs.get("f")?.localFieldRefHistSlots.get("x.lb")).toBe(0);
    expect(prog.funcs.get("f")?.localRefHistSlotCount).toBe(1);
    expect(prog.udtFieldRefHistorySlots.size).toBe(0);
  });

  it("still rejects a UDF/method-internal var/'=' local UDT receiver (record-timing ambiguity, out of slice, C750)", () => {
    const prog = analyzeSource([...MARKER, "f() =>", "    var T x = T.new(na)", "    y = x.lb[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("UDF/method-internal UDT receivers"))).toBe(true);
  });

  it("still rejects a nested-block '=' local receiver (JS let — invisible to the bar-end record loop)", () => {
    const prog = analyzeSource([...MARKER, "if close > 0", "    x = T.new(na)", "    y = x.lb[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("top-level var/varip or unconditional (depth-0)"))).toBe(true);
  });

  it("still rejects a non-drawing/non-numeric field kind (e.g. array) on the same UDT — unrelated axis unaffected", () => {
    const prog = analyzeSource(["type U", "    map<string, float> mm", "var U x = na", "y = x.mm[1]"].join("\n"));
    expect(prog.errors.some((e) => e.includes("UDT fields of map type"))).toBe(true);
  });
});

describe("drawing-handle UDT field history — codegen output (C718)", () => {
  it("emits a null-safe bar-end record line into $.refHistSlots for the var receiver", () => {
    const src = [...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "x = obj.lb[1]"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[0].record($.vars[0]?.lb);");
      expect(result.code).toContain("$.refHistSlots[0].get(1)");
    }
  });

  it("emits rt.refHistGet with a null-guarded current-value argument for dynamic offsets", () => {
    const src = [...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "n = 1", "x = obj.lb[n]"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.refHistGet(($.vars[0]?.lb ?? null), $.refHistSlots[0], ");
    }
  });
});

describe("drawing-handle UDT field history — execution semantics (C718, hand-verified)", () => {
  it("returns the prior bar's freshly-reassigned handle (true history, mirrors the drawing-var case C652)", () => {
    const src = [
      ...MARKER,
      "var T obj = T.new(na)",
      "obj.lb := label.new(bar_index, close)",
      "var float __obs_a = na",
      "__obs_a := (obj.lb[1]).get_x()",
    ].join("\n");
    const vals = obs(src);
    // bar 0: 히스토리 없음(워밍업, RefSeries.get()이 null -> get_x()가 NaN). bar i(>=1): 직전 바에
    // 새로 만든 핸들의 x(=bar_index, 0-based) 그대로.
    expect(vals[0]).toBeNaN();
    expect(vals.slice(1)).toEqual([0, 1, 2, 3]);
  });

  it("supports the bare/static call form matching the wild idiom, e.g. label.get_x(obj.lb[1])", () => {
    const src = [
      ...MARKER,
      "var T obj = T.new(na)",
      "obj.lb := label.new(bar_index, close)",
      "var float __obs_a = na",
      "__obs_a := label.get_x(obj.lb[1])",
    ].join("\n");
    const vals = obs(src);
    expect(vals[0]).toBeNaN();
    expect(vals.slice(1)).toEqual([0, 1, 2, 3]);
  });

  it("treats [0] as an identity read equal to the bare field value (no slot, no warmup gap)", () => {
    const src = [
      ...MARKER,
      "var T obj = T.new(na)",
      "obj.lb := label.new(bar_index, close)",
      "var float __obs_a = na",
      "__obs_a := (obj.lb[0]).get_x()",
    ].join("\n");
    expect(obs(src)).toEqual([0, 1, 2, 3, 4]);
  });

  it("does not crash on bar 0 (no history yet) — null RefSeries slot yields NaN via the drawing accessor's na guard", () => {
    const src = [...MARKER, "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "y = (obj.lb[1]).get_x()"].join("\n");
    expect(() => runPipeline(src, data)).not.toThrow();
  });

  it("supports a depth-0 '=' local receiver (reconstructed fresh every bar, true history like reassignment)", () => {
    const src = [
      "type Box",
      "    label lb",
      "b = Box.new(na)",
      "b.lb := label.new(bar_index, close)",
      "var float __obs_a = na",
      "__obs_a := (b.lb[1]).get_x()",
    ].join("\n");
    const vals = obs(src);
    expect(vals[0]).toBeNaN();
    expect(vals.slice(1)).toEqual([0, 1, 2, 3]);
  });
});

describe("drawing-handle UDT field history — UDF/method parameter receiver (C750)", () => {
  it("emits an entry-point record line into $.refHistSlots at a __refHistBase-relative slot", () => {
    const src = [...MARKER, "f(T x) =>", "    x.lb[1]", "y = f(T.new(na))"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[__refHistBase + 0].record(x.lb);");
      expect(result.code).toContain("$.refHistSlots[__refHistBase + 0].get(1)");
    }
  });

  it("emits rt.refHistGet with a null-guarded current-value argument for dynamic offsets on a parameter field", () => {
    const src = [...MARKER, "f(T x, n) =>", "    x.lb[n]", "y = f(T.new(na), 1)"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.refHistGet((x?.lb ?? null), $.refHistSlots[__refHistBase + 0], ");
    }
  });

  it("returns the prior call's freshly-reassigned handle (true history) through a single call site per bar", () => {
    const src = [
      ...MARKER,
      "f(T x) =>",
      "    (x.lb[1]).get_x()",
      "var T obj = T.new(na)",
      "obj.lb := label.new(bar_index, close)",
      "var float __obs_a = na",
      "__obs_a := f(obj)",
    ].join("\n");
    const vals = obs(src);
    expect(vals[0]).toBeNaN();
    expect(vals.slice(1)).toEqual([0, 1, 2, 3]);
  });

  it("does not crash on bar 0 (no call-site history yet)", () => {
    const src = [...MARKER, "f(T x) =>", "    (x.lb[1]).get_x()", "var T obj = T.new(na)", "obj.lb := label.new(bar_index, close)", "y = f(obj)"].join(
      "\n",
    );
    expect(() => runPipeline(src, data)).not.toThrow();
  });
});

// 매개변수 자신 전체(필드가 아니라 receiver 자체)의 히스토리 x[N](C751, wild `id[i]`
// — series MoreCandleInfo 타입 매개변수를 for i=0 to n_back 루프로 배열에 모으는 관용구).
// 위 블록(C750)이 연 "x.field[N]"의 거울상 — 히스토리가 obj.field 이전에 오는 (x[N]).field 폼과
// x[N] bare 자체(예: array.set(result, i, id[i]))를 함께 커버한다. RefSeries가 타입 불문 plain
// unknown[]이라 물리 배열/record 타이밍은 필드 히스토리와 완전히 동일(함수 진입 직후 1회).
const PRICE_MARKER = ["type Q", "    float price = na"];

describe("UDT parameter whole-object history — analyzer/codegen (C751)", () => {
  it("allows a UDF/method parameter UDT receiver, no field access needed", () => {
    const prog = analyzeSource([...PRICE_MARKER, "f(Q x) =>", "    (x[1]).price", "y = f(Q.new(1.0))"].join("\n"));
    expect(prog.errors).toEqual([]);
    const func = prog.funcs.get("f")!;
    expect(func.localRefHistSlots.get("x")).toBe(0);
    expect(func.localRefHistKinds.get("x")).toBe("param");
    expect(func.localRefHistSlotCount).toBe(1);
  });

  it("emits an entry-point record line into $.refHistSlots keyed on the bare parameter", () => {
    const src = [...PRICE_MARKER, "f(Q x) =>", "    x[1]", "y = f(Q.new(1.0))"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[__refHistBase + 0].record(x);");
      expect(result.code).toContain("$.refHistSlots[__refHistBase + 0].get(1)");
    }
  });

  it("routes a dynamic (runtime) offset through rt.refHistGet with the bare parameter as the current-value arg", () => {
    const src = [...PRICE_MARKER, "f(Q x, n) =>", "    x[n]", "y = f(Q.new(1.0), 1)"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("rt.refHistGet(x, $.refHistSlots[__refHistBase + 0], n)");
    }
  });

  it("returns the prior call's freshly-passed argument (true history, hand-verified) — mirrors the wild id[i] idiom", () => {
    const src = [
      ...PRICE_MARKER,
      "f(Q x) =>",
      "    (x[1]).price",
      "var float __obs_a = na",
      "__obs_a := f(Q.new(close))",
    ].join("\n");
    expect(obs(src)).toEqual([NaN, 10, 20, 30, 40]);
  });

  it("does not crash on bar 0 (no call-site history yet)", () => {
    const src = [...PRICE_MARKER, "f(Q x) =>", "    (x[1]).price", "y = f(Q.new(close))"].join("\n");
    expect(() => runPipeline(src, data)).not.toThrow();
  });
});
