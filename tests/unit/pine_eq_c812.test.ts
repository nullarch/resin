// C812 (ROADMAP 배치49 (3-a)) — C602 결함 수정: 히스토리 슬롯을 왕복한 bool의 `==`/`!=` 비교.
//
// 결함: Float64Array 히스토리 슬롯($.histSlots/UDF 슬롯/security expr 캐시)에 저장된 boolean은
// 숫자 강제변환으로 true→1/false→0이 되는데, genEquality가 방출하던 네이티브 `===`는 `1 === true`를
// false로 판정했다 — `b[1] == true`가 b[1]이 실제로 true인데도 false가 되는 조용한 오답(반대로
// `b[1] != true`는 true). pineAnd/pineOr가 C449에서 고친 것과 정확히 같은 원인이라 같은
// {true,1}/{false,0} 동치 판정을 rt.pineEq/pineNeq로 신설해 genEquality와 switch subject 비교가
// 함께 쓰도록 했다.
import { describe, expect, it } from "vitest";
import { pineEq, pineNeq } from "../../src/runtime/numeric";
import { runPipeline } from "../helpers/pipeline";
import { transpile } from "../../src/transpiler/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2, 8, 3, 9, 4, 10, 6, 7],
  high: [3, 7, 5, 10, 6, 12, 8, 15, 9, 11],
  low: [0, 2, 1, 4, 2, 5, 3, 6, 4, 5],
  // close > 3: [F, T, F, T, F, T, F, T, T, T] — 마지막 3바가 T라 b[1]/b[2]도 확정 T,
  // 첫 몇 바를 보면 false 히스토리(`b[1] == false`)도 함께 검증할 수 있다.
  close: [2, 4, 3, 9, 2, 11, 3, 12, 5, 8],
  volume: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
};

const src = (...lines: string[]): string => ['//@version=5', 'indicator("t")', ...lines].join("\n");

function obs(source: string, key = "var:__obs"): unknown[] {
  return runPipeline(source, data).bars.map((b) => b[key]);
}

function code(source: string): string {
  const result = transpile(source);
  expect(result.ok).toBe(true);
  return result.ok ? result.code : "";
}

describe("C812 rt.pineEq/pineNeq 런타임 시맨틱", () => {
  it("히스토리 슬롯을 왕복한 bool(1/0)을 원시 boolean과 같은 값으로 인정한다", () => {
    expect(pineEq(1, true)).toBe(true);
    expect(pineEq(true, 1)).toBe(true);
    expect(pineEq(0, false)).toBe(true);
    expect(pineEq(false, 0)).toBe(true);
  });

  it("반대 진리값은 여전히 다르다(동치 판정이 모든 bool↔숫자를 뭉개지 않는다)", () => {
    expect(pineEq(0, true)).toBe(false);
    expect(pineEq(1, false)).toBe(false);
    expect(pineEq(2, true)).toBe(false);
    expect(pineEq(true, 2)).toBe(false);
    expect(pineEq(-1, false)).toBe(false);
  });

  it("숫자/문자열/불리언 동일 타입 비교는 기존 `===` 시맨틱 그대로다", () => {
    expect(pineEq(3, 3)).toBe(true);
    expect(pineEq(3, 4)).toBe(false);
    expect(pineEq("ab", "ab")).toBe(true);
    expect(pineEq("ab", "zz")).toBe(false);
    expect(pineEq(true, true)).toBe(true);
    expect(pineEq(true, false)).toBe(false);
    expect(pineEq(0, -0)).toBe(true); // `===`와 동일(Object.is가 아님)
  });

  it("na 3분할(NaN/null)의 기존 동작을 바꾸지 않는다", () => {
    expect(pineEq(NaN, NaN)).toBe(false); // `x == na`는 genEquality의 rt.na 분기가 따로 처리
    expect(pineEq(NaN, 1)).toBe(false);
    expect(pineEq(NaN, true)).toBe(false);
    expect(pineEq(null, null)).toBe(true);
    expect(pineEq(null, 0)).toBe(false);
    expect(pineEq(null, false)).toBe(false);
    expect(pineEq(undefined, null)).toBe(false);
  });

  it("참조형은 동일성(identity) 비교 그대로다", () => {
    const a = { x: 1 };
    expect(pineEq(a, a)).toBe(true);
    expect(pineEq(a, { x: 1 })).toBe(false);
  });

  it("pineNeq는 항상 pineEq의 정확한 부정이다", () => {
    const values: unknown[] = [1, 0, 2, true, false, NaN, null, "ab", ""];
    for (const a of values) {
      for (const b of values) {
        expect(pineNeq(a, b)).toBe(!pineEq(a, b));
      }
    }
  });
});

describe("C812 codegen 방출", () => {
  it("'=='/'!='를 rt.pineEq/rt.pineNeq로 낸다", () => {
    expect(code(src("x = close == open"))).toContain("rt.pineEq($.close.get(0), $.open.get(0))");
    expect(code(src("x = close != open"))).toContain("rt.pineNeq($.close.get(0), $.open.get(0))");
  });

  it("`x == na`는 종전대로 rt.na 우회를 유지한다(pineEq로 내리지 않는다)", () => {
    const generated = code(src("x = close == na"));
    expect(generated).toContain("rt.na($.close.get(0))");
    expect(generated).not.toContain("rt.pineEq");
  });

  it("switch subject 비교도 같은 rt.pineEq를 쓴다", () => {
    expect(code(src("x = 0.0", "switch close", "    1 =>", "        x := 1.0"))).toContain(
      "rt.pineEq(__switchSubject, 1)",
    );
  });
});

describe("C812 E2E — 히스토리 bool 비교가 정확해진다", () => {
  it("var bool 히스토리: `b[1] == true`가 b[1]과 일치한다", () => {
    const source = src(
      "var bool b = false",
      "b := close > 3",
      "var float __obs = na",
      "var float __raw = na",
      "__raw := b[1] ? 1.0 : 0.0",
      "__obs := (b[1] == true) ? 1.0 : 0.0",
    );
    const raw = obs(source, "var:__raw");
    const viaEq = obs(source);
    expect(viaEq).toEqual(raw);
    expect(raw.at(-1)).toBe(1); // 실제로 true인 바가 포함돼 있어야 회귀 가드가 의미를 가진다
  });

  it("var bool 히스토리: `b[1] != true`가 정확히 그 부정이다", () => {
    const source = src(
      "var bool b = false",
      "b := close > 3",
      "var float __obs = na",
      "__obs := (b[1] != true) ? 1.0 : 0.0",
    );
    expect(obs(source).at(-1)).toBe(0);
  });

  it("false 히스토리도 `b[1] == false`로 정확히 잡힌다(0 vs false)", () => {
    // bar 2(close=3)에서 b는 false → bar 3에서 b[1] === false.
    const source = src(
      "var bool b = false",
      "b := close > 3",
      "var float __obs = na",
      "__obs := (b[1] == false) ? 1.0 : 0.0",
    );
    const got = obs(source);
    expect(got[3]).toBe(1);
    expect(got.at(-1)).toBe(0); // 마지막 바의 b[1]은 true
  });

  it("타입힌트 없는 '=' 로컬 bool 히스토리도 동일하게 정확하다", () => {
    const source = src(
      "c = close > 3",
      "var float __obs = na",
      "var float __raw = na",
      "__raw := c[1] ? 1.0 : 0.0",
      "__obs := (c[1] == true) ? 1.0 : 0.0",
    );
    expect(obs(source)).toEqual(obs(source, "var:__raw"));
  });

  it("UDF 안의 bool 히스토리(별도 슬롯 경로)도 정확하다", () => {
    const source = src(
      "f() =>",
      "    var bool bb = false",
      "    bb := close > 3",
      "    (bb[1] == true) ? 1.0 : 0.0",
      "var float __obs = na",
      "__obs := f()",
    );
    expect(obs(source).at(-1)).toBe(1);
  });

  it("히스토리와 라이브 피연산자를 섞은 비교(`b[1] == b`)가 정확하다", () => {
    const source = src(
      "var bool b = false",
      "b := close > 3",
      "var float __obs = na",
      "__obs := (b[1] == b) ? 1.0 : 0.0",
    );
    // 마지막 3바(close 12/5/8)는 전부 close>3이라 b[1]도 b도 true.
    expect(obs(source).at(-1)).toBe(1);
  });

  it("`switch b[1]`의 true/false arm이 default로 새지 않는다", () => {
    const source = src(
      "var bool b = false",
      "b := close > 3",
      "var float __obs = na",
      "__obs := switch b[1]",
      "    true => 1.0",
      "    false => 2.0",
      "    => 3.0",
    );
    const got = obs(source);
    expect(got.at(-1)).toBe(1);
    expect(got[3]).toBe(2); // bar 2의 b는 false
    // bar 0은 히스토리가 없어 subject가 na — 어느 arm과도 매치되지 않아 default(3.0)가 맞다.
    // 그 이후로는 default arm이 한 번도 타면 안 된다(수정 전에는 true 바가 전부 여기로 샜다).
    expect(got[0]).toBe(3);
    expect(got.slice(1)).not.toContain(3);
  });

  it("양쪽 다 히스토리인 비교(`b[1] == b[2]`)의 기존 정확성은 그대로다", () => {
    const source = src(
      "var bool b = false",
      "b := close > 3",
      "var float __obs = na",
      "__obs := (b[1] == b[2]) ? 1.0 : 0.0",
    );
    expect(obs(source).at(-1)).toBe(1);
  });
});

describe("C812 회귀 — bool이 아닌 피연산자의 동등성은 불변", () => {
  it("숫자/문자열 비교", () => {
    expect(obs(src("var float __obs = na", "__obs := (close == 8.0) ? 1.0 : 0.0")).at(-1)).toBe(1);
    expect(obs(src("var float __obs = na", "__obs := (close != 8.0) ? 1.0 : 0.0")).at(-1)).toBe(0);
    expect(obs(src('s = "ab"', "var float __obs = na", '__obs := (s == "ab") ? 1.0 : 0.0')).at(-1)).toBe(1);
    expect(obs(src('s = "ab"', "var float __obs = na", '__obs := (s == "zz") ? 1.0 : 0.0')).at(-1)).toBe(0);
  });

  it("숫자 히스토리 비교와 na 비교", () => {
    expect(obs(src("var float __obs = na", "__obs := (close[1] == 5.0) ? 1.0 : 0.0")).at(-1)).toBe(1);
    expect(obs(src("var float __obs = na", "__obs := (close == na) ? 1.0 : 0.0")).at(-1)).toBe(0);
    expect(obs(src("var float __obs = na", "__obs := (close[99] == na) ? 1.0 : 0.0")).at(-1)).toBe(1);
  });

  it("enum 멤버 비교(문자열로 낮춰지는 경로)", () => {
    expect(
      obs(src(
        "enum Direction",
        "    long",
        "    short",
        "var Direction d = Direction.long",
        "var float __obs = na",
        "__obs := (d == Direction.long) ? 1.0 : 0.0",
      )).at(-1),
    ).toBe(1);
    expect(
      obs(src(
        "enum Direction",
        "    long",
        "    short",
        "var Direction d = Direction.long",
        "var float __obs = na",
        "__obs := (d == Direction.short) ? 1.0 : 0.0",
      )).at(-1),
    ).toBe(0);
  });

  it("문자열 subject switch도 그대로 매칭된다", () => {
    expect(
      obs(src(
        's = "ab"',
        "var float __obs = na",
        "__obs := switch s",
        '    "ab" => 1.0',
        "    => 0.0",
      )).at(-1),
    ).toBe(1);
  });
});
