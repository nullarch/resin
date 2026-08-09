// C808: str.tostring 의 문자열 인자 / 참조형 na(null) 경로.
//
// C807(LIMITATIONS 재검토 구간3)이 발견한 결함 — 시그니처가 `number | boolean`만 상정해
// 문자열과 null이 숫자 경로로 흘러들었고, pyFloatStr의 `Number.isFinite` 가드가 비-number를
// 전부 무한대로 오분류해 `str.tostring("Fast")`가 "-inf", `str.tostring("12")`가 "inf",
// 문자열 na가 "-inf"를 냈다(포맷 인자가 붙으면 `value.toFixed is not a function` 크래시).
//
// 기대값 근거는 전부 pine2py `wavealgo/builtins/str_funcs.py` tostring의 python 직접 실행
// 실측이다(`str(value)` / `value is None → "NaN"`). 포맷 인자가 붙은 문자열만 pine2py가
// ValueError로 크래시하므로 GOAL.md na 안전성 원칙에 따라 원문 반환으로 흡수했다
// (TV 미검증 가설, DIVERGENCES 등재).
import { describe, expect, it } from "vitest";
import { tostring } from "../../src/runtime/str";
import { join } from "../../src/runtime/array";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

const data: OHLCVData = {
  open: [1, 5, 2],
  high: [3, 7, 5],
  low: [0, 2, 1],
  close: [2, 4, 3],
  volume: [10, 20, 30],
};

const src = (...lines: string[]): string => lines.join("\n");

/** 관측 채널의 마지막 바 값. */
function lastObs(source: string): unknown {
  const bars = runPipeline(source, data).bars;
  return bars[bars.length - 1]!["var:__obs"];
}

describe("C808 str.tostring — 문자열 인자는 원문을 반환한다", () => {
  it("비-숫자 문자열은 원문 그대로", () => {
    expect(tostring("Fast")).toBe("Fast");
    expect(tostring("Slow Mode")).toBe("Slow Mode");
  });

  it("숫자꼴 문자열도 숫자로 재해석하지 않고 원문 그대로", () => {
    // 이 두 개가 결함 시절 각각 "inf"/"inf"였다 — 부호 비교(`value > 0`)로 갈렸을 뿐이다.
    expect(tostring("12")).toBe("12");
    expect(tostring("12.5")).toBe("12.5");
    expect(tostring("-3")).toBe("-3");
  });

  it("빈 문자열은 빈 문자열(결함 시절 '-inf')", () => {
    expect(tostring("")).toBe("");
  });

  it("포맷 인자가 붙어도 문자열은 원문(pine2py는 여기서 ValueError 크래시 — 흡수)", () => {
    expect(tostring("Fast", "percent")).toBe("Fast");
    expect(tostring("12.5", "#.##")).toBe("12.5");
    expect(tostring("Fast", "integer")).toBe("Fast");
    expect(tostring("1234567", "volume")).toBe("1234567");
  });
});

describe("C808 str.tostring — 참조형 na(null)/미초기화(undefined)", () => {
  it("null은 'NaN'(pine2py `value is None` 분기)", () => {
    expect(tostring(null)).toBe("NaN");
  });

  it("null은 포맷 인자와 무관하게 'NaN' — None 검사가 포맷 분기보다 먼저다", () => {
    // 결함 시절 Math.trunc(null)===0 이라 "integer"에서 "0"이 나왔다(조용한 오답).
    expect(tostring(null, "integer")).toBe("NaN");
    expect(tostring(null, "percent")).toBe("NaN");
    expect(tostring(null, "#.##")).toBe("NaN");
  });

  it("undefined(미초기화)도 na와 동일하게 흡수", () => {
    expect(tostring(undefined)).toBe("NaN");
  });
});

describe("C808 str.tostring — 숫자/불리언 경로 회귀 없음", () => {
  it("숫자 기본 분기(pyFloatStr)와 NaN 표기 불변", () => {
    expect(tostring(1.5)).toBe("1.5");
    expect(tostring(5)).toBe("5.0");
    expect(tostring(5, "", true)).toBe("5");
    expect(tostring(NaN)).toBe("NaN");
  });

  it("포맷 분기 불변", () => {
    expect(tostring(5, "integer")).toBe("5");
    expect(tostring(0.25, "percent")).toBe("0.25%");
    expect(tostring(1234.5678, "#.##")).toBe("1234.57");
    expect(tostring(8, "###M")).toBe("8M");
  });

  it("불리언 분기 불변(C207)", () => {
    expect(tostring(true)).toBe("True");
    expect(tostring(false)).toBe("False");
    expect(tostring(false, "integer")).toBe("0");
    expect(tostring(true, "percent")).toBe("1.00%");
  });
});

describe("C808 str.tostring — 스크립트 경로", () => {
  it("문자열 리터럴 인자", () => {
    expect(lastObs(src("var string __obs = na", '__obs := str.tostring("Fast")'))).toBe("Fast");
  });

  it("문자열 변수 인자", () => {
    expect(lastObs(src("var string __obs = na", 's = "abc"', "__obs := str.tostring(s)"))).toBe("abc");
  });

  it("string(x) 캐스트도 같은 함수를 재사용하므로 함께 고쳐진다(C207 경로)", () => {
    expect(lastObs(src("var string __obs = na", 's = "abc"', "__obs := string(s)"))).toBe("abc");
  });

  it("문자열 na(null 저장)는 'NaN' 문자열", () => {
    expect(lastObs(src("var string __obs = na", "var string s = na", "__obs := str.tostring(s)"))).toBe("NaN");
  });

  it("문자열 연결에 흘러들어도 원문 유지(결함 시절 'v=-inf')", () => {
    expect(lastObs(src("var string __obs = na", 's = "abc"', '__obs := "v=" + str.tostring(s)'))).toBe("v=abc");
  });

  it("숫자 인자 스크립트 경로 회귀 없음", () => {
    expect(lastObs(src("var string __obs = na", "__obs := str.tostring(close)"))).toBe("3.0");
  });
});

describe("C808 str.tostring — array.join 형제 일관성", () => {
  it("joinElement의 문자열/null 처리와 tostring이 이제 같은 방향을 본다", () => {
    // array.join은 처음부터 문자열은 원문, null은 na 표기로 갈랐다(array.ts joinElement).
    // tostring만 그 분기가 없어 비대칭이었던 것 — 문자열 쪽은 이제 완전히 일치한다.
    expect(join(["abc", "12"], ",")).toBe("abc,12");
    expect(tostring("abc")).toBe("abc");
    expect(tostring("12")).toBe("12");
    // na 표기는 서로 다르다: join은 pine2py `str(float('nan'))`="nan"(소문자, array.ts 주석),
    // tostring은 pine2py가 명시적으로 반환하는 "NaN"(대문자) — 둘 다 각자 pine2py 실측 일치다.
    expect(join([null], ",")).toBe("nan");
    expect(tostring(null)).toBe("NaN");
  });
});
