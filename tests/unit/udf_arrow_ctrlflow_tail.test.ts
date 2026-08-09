// C765: UDF/method 단문 화살표(`f(x) => switch x`/`f(x) => if cond`) 본문이 '=>' 직후 INDENT
// 없이 같은 줄에서 바로 if/switch로 시작하는 폼(wild 실측 9건 중 3건, 대표: `calclevel(...) =>
// switch id\n    0 => ...`). 파서는 이걸 statement-level SwitchStmt/IfStmt가 아니라
// ExprStmt{expr: SwitchStmt|IfStmt}로 감싼다(parseBlockOrExpr가 '=>' 직후 INDENT를 못 찾아
// parseAssignmentOrExpr -> parseExpr 표현식 경로로 떨어짐, parser.ts C319 주석 참조). analyzer가
// 이 래핑을 인식 못 해 "제어문-식은 var 선언 또는 대입문의 값 위치에서만 지원" 하드 에러를 냈다.
// pine2py도 이 정확한 폼(단문 화살표 + 제어문)을 지원하지 않는다(codegen.py가 `return None  #
// unsupported expr: SwitchStmt/IfStmt`를 그대로 방출 — python 직접 실행 확인) — 오라클 골든이
// 항상 null이라 무의미, hand-verified로 대체(MEMORY.md C9/C14/C18급 패턴).

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3, 4, 5],
  high: [2, 3, 4, 5, 6],
  low: [0, 1, 2, 3, 4],
  close: [10, 20, 1, 40, 50],
  volume: [1, 1, 1, 1, 1],
};

describe("UDF/method single-line arrow tail wraps if/switch in ExprStmt (C765, hand-verified)", () => {
  it("returns a scalar value from a same-line `f(x) => switch x` UDF tail (wild shape)", () => {
    const src = [
      "pick(id) => switch id",
      "    0 => 10.0",
      "    1 => 20.0",
      "    => -1.0",
      "var float __obs = na",
      "__obs := pick(bar_index % 3)",
    ].join("\n");
    const result = runPipeline(src, data);
    // bar_index % 3 = 0,1,2,0,1 -> pick = 10,20,-1,10,20
    expect(result.bars.map((b) => b["var:__obs"])).toEqual([10, 20, -1, 10, 20]);
  });

  it("returns a scalar value from a same-line `f(x) => if cond` UDF tail", () => {
    const src = [
      "sign(x) => if x > 0",
      "    1.0",
      "else",
      "    -1.0",
      "var float __obs = na",
      "__obs := sign(close - open)",
    ].join("\n");
    const result = runPipeline(src, data);
    // close-open = 9,18,-2,36,45 -> sign = 1,1,-1,1,1
    expect(result.bars.map((b) => b["var:__obs"])).toEqual([1, 1, -1, 1, 1]);
  });

  it("still supports tuple return through the same ExprStmt-wrapped tail (arity 2)", () => {
    const src = [
      "pickPair(id) => switch id",
      "    0 => [10.0, 100.0]",
      "    => [-1.0, -100.0]",
      "[a, b] = pickPair(bar_index % 2)",
      "var float __obs_a = na",
      "__obs_a := a",
      "var float __obs_b = na",
      "__obs_b := b",
    ].join("\n");
    const result = runPipeline(src, data);
    // bar_index % 2 = 0,1,0,1,0
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([10, -1, 10, -1, 10]);
    expect(result.bars.map((b) => b["var:__obs_b"])).toEqual([100, -100, 100, -100, 100]);
  });

  it("applies the same unwrap to a method decl's same-line arrow switch tail", () => {
    const src = [
      "type Box",
      "    float v",
      "method classify(Box self) => switch true",
      "    self.v > 0 => 1.0",
      "    => -1.0",
      "var Box b = Box.new(5.0)",
      "var float __obs = na",
      "__obs := b.classify()",
    ].join("\n");
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs"])).toEqual([1, 1, 1, 1, 1]);
  });
});
