// lab[N] / (lab[1]).delete() — drawing 핸들(label/line/box/table/polyline/linefill)을 담은
// top-level var의 히스토리 인덱스(C652, wild "?.delete" 잔여 — `(lab[1]).delete()`류,
// `var label lab = na` 뒤 히스토리 참조에 method-call sugar를 바로 체이닝하는 폼).
// udt_var_ref_history.test.ts(C637)의 거울상 — 물리 메커니즘(varRefHistorySlots, $.refHistSlots
// RefSeries)은 완전히 동일, 값 종류만 UDT 인스턴스 대신 drawing 핸들이다. 지금까지 top-level var
// 히스토리의 3종 참조형 가드(array#79/map#89/matrix#90, UDT는 C637부터)에 drawing만 빠져 있어
// 이 var 종류의 히스토리가 조용히 기본 Float64Array 슬롯(숫자 전용, Number(handle)=NaN)으로
// 떨어지는 latent 갭이었다 — 이번 수정으로 UDT와 동일한 $.refHistSlots 경로를 탄다.

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

function analyzeSource(source: string) {
  return analyze(parse(source));
}

describe("drawing var reference history (lab[N]) — analyzer gates (C652)", () => {
  it("allows history indexing on a top-level var holding a label handle and allocates a slot-keyed ref-hist slot", () => {
    const prog = analyzeSource(["var label lab = na", "y = lab[1]"].join("\n"));
    expect(prog.errors).toEqual([]);
    const slot = prog.varIndex.get("lab")!;
    expect(prog.varRefHistorySlots.has(slot)).toBe(true);
    expect(prog.refHistorySlotCount).toBe(1);
    expect(prog.historySlotCount).toBe(0);
  });

  it("supports a dynamic (runtime) offset on the drawing var", () => {
    const prog = analyzeSource(["var label lab = na", "n = 1", "y = lab[n]"].join("\n"));
    expect(prog.errors).toEqual([]);
    expect(prog.dynamicHistoryOffsets.size).toBe(1);
  });

  it("allows method-call sugar chained directly on the history-indexed receiver, e.g. (lab[1]).delete()", () => {
    const prog = analyzeSource(["var label lab = na", "(lab[1]).delete()"].join("\n"));
    expect(prog.errors).toEqual([]);
  });

  it("supports box/line/table/polyline/linefill kinds identically", () => {
    for (const kind of ["box", "line", "table", "polyline", "linefill"]) {
      const prog = analyzeSource([`var ${kind} h = na`, "(h[1]).delete()"].join("\n"));
      expect(prog.errors).toEqual([]);
    }
  });
});

describe("drawing var reference history — codegen output (C652)", () => {
  it("emits a slot-keyed bar-end record line for the var receiver into $.refHistSlots (same mechanism as UDT var, C637)", () => {
    const src = ["var label lab = na", "lab := label.new(bar_index, close)", "x = (lab[1]).delete()"].join("\n");
    const result = transpile(src);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain("$.refHistSlots[0].record($.vars[0]);");
      expect(result.code).toContain("rt.label.delete($.refHistSlots[0].get(1));");
    }
  });
});

describe("drawing var reference history — execution semantics (C652, hand-verified)", () => {
  it("returns the prior bar's freshly-reassigned handle (true history, mirrors the UDT var reassignment case)", () => {
    const src = [
      "var label lab = na",
      "lab := label.new(bar_index, close)",
      "var float __obs_a = na",
      "__obs_a := (lab[1]).get_x()",
    ].join("\n");
    const result = runPipeline(src, data);
    const vals = result.bars.map((b) => b["var:__obs_a"]);
    // bar 0: 히스토리 없음(워밍업) -> NaN. bar i(>=1): lab[1]은 직전 바에 새로 만든 핸들 ->
    // get_x()는 직전 바의 bar_index(0-based) 그대로.
    expect(vals[0]).toBeNaN();
    expect(vals.slice(1)).toEqual([0, 1, 2, 3]);
  });

  it("does not crash calling a no-op method (delete) on the history-indexed receiver", () => {
    const src = ["var label lab = na", "lab := label.new(bar_index, close)", "(lab[1]).delete()"].join("\n");
    expect(() => runPipeline(src, data)).not.toThrow();
  });
});
