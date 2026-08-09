// "method" 예약어를 UDF 파라미터 이름으로 받아 본문에서 bare 식별자로 되읽는 관용구(C691, wild
// "예상치 못한 토큰 METHOD" 클러스터 16건, 대표 파일: `methodRiskIndicator(method) => if method
// == 'Average' ...`) + 문장 시작 위치의 "method = expr" 변수 관용구(C691, LuxAlgo 계열 지표
// `method = input.string('Atr', ...)`) 풀 파이프라인 hand-verified 테스트. pine2py도 동일한
// 렉서 설계(KEYWORDS 테이블이 문맥과 무관하게 항상 METHOD 토큰을 방출)라 오라클 골든 대신
// 손 계산 기대값으로 검증한다.

import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 2, 3],
  high: [1, 2, 3],
  low: [1, 2, 3],
  close: [1, 2, 3],
  volume: [1, 1, 1],
};

describe("reserved METHOD keyword used as a bare identifier (C691, hand-verified)", () => {
  it("reads a UDF param named 'method' back inside an if/else-if chain (the exact wild shape)", () => {
    const src = [
      "classify(method) =>",
      "    result = 0.0",
      "    if method == 'Average'",
      "        result := 1.0",
      "    else if method == 'PC1'",
      "        result := 2.0",
      "    else",
      "        result := 3.0",
      "    result",
      "var float __obs_avg = na",
      "__obs_avg := classify('Average')",
      "var float __obs_pc1 = na",
      "__obs_pc1 := classify('PC1')",
      "var float __obs_other = na",
      "__obs_other := classify('nope')",
    ].join("\n");
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_avg"])).toEqual([1, 1, 1]);
    expect(result.bars.map((b) => b["var:__obs_pc1"])).toEqual([2, 2, 2]);
    expect(result.bars.map((b) => b["var:__obs_other"])).toEqual([3, 3, 3]);
  });

  it("parses 'method = expr' as a plain top-level variable, not a MethodDecl name", () => {
    const src = [
      "method = 'Atr'",
      "var float __obs_a = na",
      "__obs_a := method == 'Atr' ? 1.0 : 0.0",
    ].join("\n");
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([1, 1, 1]);
  });

  it("still executes a real 'method name(params) => body' MethodDecl correctly alongside the bare-identifier form", () => {
    const src = [
      "type Point",
      "    float x",
      "method double(Point this) =>",
      "    this.x * 2",
      "p = Point.new(5.0)",
      "var float __obs_a = na",
      "__obs_a := p.double()",
    ].join("\n");
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([10, 10, 10]);
  });
});
