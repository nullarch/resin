// input.* — 입력 파라미터 선언 함수 (첫 슬라이스: int/float/bool/string, C131).
// pine2py wavealgo/builtins/input_funcs.py는 Context.inputs 필드를 선언만 해두고 실제로는
// 어디서도 read/write하지 않는 죽은 스텁이라(항상 defval만 반환) 오버라이드 경로 자체가 없다.
// pine2js는 GOAL.md의 사업 목적(대량 백테스트로 전략 가치 추출)에 맞춰 이 스텁이 예고만 해둔
// "외부 오버라이드 dict 우선 조회"를 실제로 구현한다(ROADMAP 'input.*' 항목, pine2py에 이식할
// 대응 구현이 없는 pine2js 자체 설계 — DIVERGENCES.md 신규).
//
// 오버라이드 키는 title 문자열이다(사람이 참조하는 유일한 안정적 식별자, pine2py 자신의 문서
// 예시 `wa.input.int_input(14, "Length")`와 동일한 의도). title이 빈 문자열이거나 여러 input이
// 같은 title을 공유하면 오버라이드 대상이 모호해진다 — 회피법은 LIMITATIONS.md 참조.
// minval/maxval/step은 pine2py와 동일하게 그대로 받되 로직에서 쓰지 않는다(literal port,
// pine2py도 검증/클램프를 전혀 안 함 — UI 없는 헤드리스 실행이라 값 자체는 TV 클램프 UI가 하는
// 일이라 우리 쪽 책임이 아님).
export interface InputOverrides {
  [title: string]: unknown;
}

function lookup(overrides: InputOverrides, title: string, defval: unknown): unknown {
  if (title !== "" && Object.prototype.hasOwnProperty.call(overrides, title)) return overrides[title];
  return defval;
}

export function int(
  overrides: InputOverrides,
  defval: number = 0,
  title: string = "",
  _minval: number | null = null,
  _maxval: number | null = null,
  _step: number = 1,
): number {
  return lookup(overrides, title, defval) as number;
}

export function float(
  overrides: InputOverrides,
  defval: number = 0.0,
  title: string = "",
  _minval: number | null = null,
  _maxval: number | null = null,
  _step: number = 1.0,
): number {
  return lookup(overrides, title, defval) as number;
}

export function bool(overrides: InputOverrides, defval: boolean = false, title: string = ""): boolean {
  return lookup(overrides, title, defval) as boolean;
}

// options(C258) — enumInput과 동일하게 pine2py string_input(defval, title, **kwargs)이 값을 전혀
// 안 쓰는 통과 파라미터라(**kwargs로 흡수) 순수 no-op으로만 받는다. codegen이 이 슬롯을 항상
// literal "undefined"로 방출하므로(genCallExpr input.* 분기, TupleExpr는 genExpr에 못 넘김)
// 실제로 값이 들어올 일은 없다 — 시그니처만 enumInput과 대칭으로 맞춰둔다.
export function string(
  overrides: InputOverrides,
  defval: string = "",
  title: string = "",
  _options: unknown[] | null = null,
): string {
  return lookup(overrides, title, defval) as string;
}

// 세 번째 슬라이스(C133) -- 나머지 9종 중 시그니처가 (defval, title)뿐인 8종 + bare input().
// pine2py input_funcs.py 소스 대조로 확인: color/source/symbol/timeframe/session/price/
// text_area/time/any_input 전부 int/float처럼 minval/maxval/step이 없고 bool/string과 완전히
// 동일한 2-파라미터 스텁(둘 다 defval 그대로 반환) -- 새 로직 불필요, lookup() 재사용.
// input.enum만 options 리스트 인자가 추가로 필요해 이번 슬라이스 범위 밖(ROADMAP 참조).

export function color(overrides: InputOverrides, defval: string = "", title: string = ""): string {
  return lookup(overrides, title, defval) as string;
}

// source: pine2py `source_input(defval: Any = None, ...)` -- bar series(close 등)도 받을 수
// 있으나, pine2js codegen은 BAR_SERIES_NAMES 식별자를 항상 .get(0)으로 낮춰 인자 자리에서도
// 무조건 스칼라로 도달한다(genIdentifier, codegen.ts) -- pine2py처럼 Series 참조가 그대로
// 새는(map.put#29/matrix.set#30/UDT 생성자#53 계열) 문제가 구조적으로 없다.
export function source(overrides: InputOverrides, defval: unknown = null, title: string = ""): unknown {
  return lookup(overrides, title, defval);
}

export function symbol(overrides: InputOverrides, defval: string = "", title: string = ""): string {
  return lookup(overrides, title, defval) as string;
}

export function timeframe(overrides: InputOverrides, defval: string = "", title: string = ""): string {
  return lookup(overrides, title, defval) as string;
}

export function session(overrides: InputOverrides, defval: string = "", title: string = ""): string {
  return lookup(overrides, title, defval) as string;
}

export function price(overrides: InputOverrides, defval: number = 0.0, title: string = ""): number {
  return lookup(overrides, title, defval) as number;
}

export function text_area(overrides: InputOverrides, defval: string = "", title: string = ""): string {
  return lookup(overrides, title, defval) as string;
}

export function time(overrides: InputOverrides, defval: number = 0, title: string = ""): number {
  return lookup(overrides, title, defval) as number;
}

// bare `input()` -- pine2py any_input(defval: Any = None, title: str = ""). 타입 미지정이라
// source와 동일하게 unknown으로 통과.
export function any(overrides: InputOverrides, defval: unknown = null, title: string = ""): unknown {
  return lookup(overrides, title, defval);
}

// input.enum(defval, title, options) -- pine2py enum_input(defval, title, options, **kwargs)도
// options를 반환값에 전혀 쓰지 않는 순수 스텁(source/any와 동일한 Any-typed passthrough)이라
// no-op으로 받기만 한다(minval/maxval/step과 동일한 literal-port 관례). 함수 이름은 `enumInput`
// -- `enum`은 JS 예약어라 함수 선언 식별자로 쓸 수 없다(`export function enum` -> SyntaxError,
// MEMORY.md "JS 예약어/전역 충돌" Pitfall). rt.ts에서 프로퍼티 키만 "enum"으로 노출한다
// (프로퍼티명은 예약어 제약을 안 받아 `rt.input.enum(...)` 호출부는 평범하게 동작).
export function enumInput(
  overrides: InputOverrides,
  defval: unknown = null,
  title: string = "",
  _options: unknown[] | null = null,
): unknown {
  return lookup(overrides, title, defval);
}
