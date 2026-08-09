// ticker.* — pine2py wavealgo/__init__.py L228-265의 ticker_new/standard/modify/heikinashi/renko/
// kagi/linebreak/pointfigure를 literal port. 전부 순수 문자열 pass-through/접합(백테스트 배치
// 엔진은 렌코/카기/라인브레이크/포인트&피겨/하이킨아시 같은 합성 바 재구성을 실제로 구현하지 않고,
// 심볼 문자열만 그대로 통과시키는 게 pine2py의 의도된 단순화 — TV의 티커 조작 네임스페이스가
// 반환하는 값은 원래도 "새 차트 컨텍스트를 여는 티커 식별자 문자열"이라 이 축소가 corpus
// 트랜스파일 목적에서는 정보 손실이 없다).
// modify()의 _backadjustment와 renko()의 _param/_source/_request_wicks(C385, 각각 4번째/3~5번째
// 트레일링 파라미터)는 pine2py 시그니처엔 없는 TV 실제 kwarg 이름(wild corpus 실측) — 둘 다 어차피
// 반환값에 전혀 안 쓰이는 discard 파라미터라 이름/개수를 pine2py 그대로 맞출 필요가 없다(첫 슬롯인
// tickerid/symbol만 정확하면 나머지는 자유).

export function newTicker(prefix = "", ticker = "", _session = "", _adjustment = ""): string {
  if (prefix) return `${prefix}:${ticker}`;
  return ticker;
}

export function standard(symbol = ""): string {
  return symbol;
}

export function modify(tickerid = "", _session = "", _adjustment = "", _backadjustment = ""): string {
  return tickerid;
}

export function heikinashi(symbol = ""): string {
  return symbol;
}

export function renko(symbol = "", _style = "", _param = 14, _source = "close", _request_wicks = true): string {
  return symbol;
}

export function kagi(symbol = "", _reversal = 0.0): string {
  return symbol;
}

export function linebreak(symbol = "", _number_of_lines = 3): string {
  return symbol;
}

export function pointfigure(symbol = "", _source = "close", _style = "", _param = 0.0, _reversal = 3): string {
  return symbol;
}

// ticker.inherit(from_tickerid, symbol)(C664 — wild "지원하지 않는 호출" 클러스터, pine2py엔
// ticker 네임스페이스 자체에 대응 함수가 없어 hand-verified. TV 실제 동작은 from_tickerid의
// session/adjustment 등 수정자를 symbol에 그대로 상속하는 것이지만, 위 8종과 동일하게 이 런타임은
// 수정자를 전혀 추적하지 않는 단순화 — 그 전제 아래 "새 심볼"인 두 번째 인자를 그대로 반환한다
// (from_tickerid는 다른 family 멤버의 discard 트레일링 인자와 동일하게 무시).
export function inherit(_fromTickerid = "", symbol = ""): string {
  return symbol;
}

// timeframe.change — pine2py wavealgo/__init__.py L269 timeframe_change(timeframe='D')는 인자와
// 무관하게 항상 False 고정(주석: "백테스트 기본 모드: 항상 False, 단일 타임프레임" — 실제 멀티
// 타임프레임 경계 감지는 미구현). 이 함수는 timeframe 네임스페이스 소속이라 src/runtime/
// timeframe.ts의 change()로 별도 export.
