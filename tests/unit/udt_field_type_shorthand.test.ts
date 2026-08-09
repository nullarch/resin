// UDT 필드 파서 갭 2종 해소(C725, wild "type-field-parser" 클러스터 11건, tv_verdict_v2.jsonl
// accept 실측 확인 — 두 문법 모두 TV가 실제로 컴파일한다):
//   (1) varip 필드 한정자(TV v6 신규, wild 7건) — pine2js는 intrabar 시뮬레이션이 없는 배치
//       리플레이 모델이라(GOAL.md) top-level var/varip처럼 파싱만 하고 한정자를 버린다.
//   (2) 타입힌트 생략 숏핸드('field_name = default', 기본값 리터럴에서 타입 추론, wild 4건).
// 파서 레벨 검증(typeHint 문자열/AST 구조)은 tests/unit/parser.test.ts에 있다. 이 파일은 실제
// 코드젠+실행 경로(Type.new() 팩토리 함수, 필드 기본값, na 참조형 특수화)까지 대조한다 —
// pine2py `_parse_type_field`는 이 두 조합 모두 지원하지 않아(소스 대조 확인, 첫 식별자를
// 무조건 type_hint로 오소비) 오라클 대조 불가, hand-verified.

import { describe, expect, it } from "vitest";
import { transpile } from "../../src/transpiler/pipeline";
import { run } from "../../src/runtime/engine";
import type { OHLCVData } from "../../src/runtime/context";

const DATA: OHLCVData = {
  open: [1, 2, 3],
  high: [2, 3, 4],
  low: [1, 2, 3],
  close: [2, 3, 4],
  volume: [1, 1, 1],
};

function runSource(source: string) {
  const result = transpile(source);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return run(result.code, result.varSlots, result.taSlotCount, DATA, result.fnVarSlotCount);
}

describe("UDT varip field qualifier (C725, hand-verified)", () => {
  it("constructs a UDT with a 'varip float' field defaulting to 0 (no override)", () => {
    const source = [
      "type Dom",
      "    varip float totalVolume",
      "var Dom d = Dom.new()",
      "var float __obs_a = na",
      "__obs_a := d.totalVolume",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([0, 0, 0]);
  });

  it("honors an explicit default value on a 'varip' field", () => {
    const source = [
      "type Dom",
      "    varip float totalVolume = 5.0",
      "var Dom d = Dom.new()",
      "var float __obs_a = na",
      "__obs_a := d.totalVolume",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([5, 5, 5]);
  });

  it("allows constructor positional override of a 'varip' field, same as an unqualified field", () => {
    const source = [
      "type Dom",
      "    varip float totalVolume",
      "var Dom d = Dom.new(9.0)",
      "var float __obs_a = na",
      "__obs_a := d.totalVolume",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([9, 9, 9]);
  });

  it("allows ':=' field mutation on a 'varip' field like any other field", () => {
    const source = [
      "type Dom",
      "    varip float totalVolume",
      "var Dom d = Dom.new()",
      "var int barN = 0",
      "barN := barN + 1",
      "if barN == 2",
      "    d.totalVolume := 42.0",
      "var float __obs_a = na",
      "__obs_a := d.totalVolume",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([0, 42, 42]);
  });

  it("supports a 'varip' generic field ('varip map<float,float>') constructing an empty Map default", () => {
    const source = [
      "type Dom",
      "    varip map<float,float> totalVolume",
      "var Dom d = Dom.new()",
      "var int __obs_a = na",
      "__obs_a := map.size(d.totalVolume)",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([0, 0, 0]);
  });
});

describe("UDT field implicit type hint from default value (C725, hand-verified)", () => {
  it("infers 'bool' from a bool literal default and preserves it through construction", () => {
    const source = [
      "type Pivot",
      "    confirmed = false",
      "var Pivot p = Pivot.new()",
      "var bool __obs_a = na",
      "__obs_a := p.confirmed",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([false, false, false]);
  });

  it("infers 'int' from an integer literal default", () => {
    const source = [
      "type BoostCondCtx",
      "    condindex = 0",
      "var BoostCondCtx ctx = BoostCondCtx.new()",
      "var int __obs_a = na",
      "__obs_a := ctx.condindex",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([0, 0, 0]);
  });

  it("infers 'string' from a string literal default and keeps na-safety (reference-type field)", () => {
    const source = [
      "type BoostCondCtx",
      '    name = "debug"',
      "var BoostCondCtx ctx = BoostCondCtx.new()",
      "var string __obs_a = na",
      "__obs_a := ctx.name",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual(["debug", "debug", "debug"]);
  });

  it("allows constructor positional override of an implicit-type field, mixed with an explicit-type field", () => {
    const source = [
      "type Pivot",
      "    float price",
      "    confirmed = false",
      "var Pivot p = Pivot.new(1.5, true)",
      "var float __obs_price = na",
      "__obs_price := p.price",
      "var bool __obs_confirmed = na",
      "__obs_confirmed := p.confirmed",
    ].join("\n");
    const { bars } = runSource(source);
    expect(bars.map((b) => b["var:__obs_price"])).toEqual([1.5, 1.5, 1.5]);
    expect(bars.map((b) => b["var:__obs_confirmed"])).toEqual([true, true, true]);
  });

  it("allows ':=' field mutation on an implicit-type field", () => {
    const source = [
      "type BoostCondCtx",
      "    condindex = 0",
      "var BoostCondCtx ctx = BoostCondCtx.new()",
      "var int barN = 0",
      "barN := barN + 1",
      "if barN == 2",
      "    ctx.condindex := 7",
      "var int __obs_a = na",
      "__obs_a := ctx.condindex",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([0, 7, 7]);
  });

  it("infers 'int' from a negative integer literal default", () => {
    const source = [
      "type Ctx",
      "    offset = -1",
      "var Ctx c = Ctx.new()",
      "var int __obs_a = na",
      "__obs_a := c.offset",
    ].join("\n");
    expect(runSource(source).bars.map((b) => b["var:__obs_a"])).toEqual([-1, -1, -1]);
  });
});
