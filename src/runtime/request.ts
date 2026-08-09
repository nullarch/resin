// request.dividends/request.splits(신규, C239 next_hint 1순위 — corpus 실측 request.dividends
// 2건/request.splits 1건). pine2py wavealgo/__init__.py L122-128 request_splits/request_dividends
// (ticker=None, field=None, gaps=False, lookahead=False, **kwargs)가 인자 전부 무시하고 항상 0.0을
// 반환하는 순수 스텁이다 — request.security(C174~182)의 실데이터 집계와 달리 이 스텁 자체가
// 오라클이라 literal port로 오라클 대조 가능(request.financial/earnings/economic/quandl 등 형제
// 스텁은 corpus 0건이라 이번 스코프 밖, PROGRESS.md 참조).

export function dividends(_ticker = "", _field = "", _gaps = false, _lookahead = false): number {
  return 0.0;
}

export function splits(_ticker = "", _field = "", _gaps = false, _lookahead = false): number {
  return 0.0;
}

// request.financial(신규, C257 — corpus 실측 2건, 65306019fd7f.pine + ecb416ca8aa7.pine, 둘 다
// `request.financial(syminfo.tickerid, "TOTAL_REVENUE", "FQ")` 3-인자 패턴). pine2py
// wavealgo/__init__.py L118-120 request_financial(symbol=None, financial_id=None, period=None,
// gaps=False, lookahead=False, **kwargs)이 인자 전부 무시하고 항상 NaN을 반환하는 순수 스텁 —
// dividends/splits와 동일한 무상태 스텁(캐싱/실데이터 스캔 없음, request.security류 C176 함정 없음).

export function financial(
  _symbol = "",
  _financialId = "",
  _period = "",
  _gaps = false,
  _lookahead = false,
): number {
  return NaN;
}

// request.earnings(신규, C397 — wild kwarg 블랑켓 잔여 94건 재세분류 1위, ignore_invalid_symbol=
// 21건/gaps= 3건 = 24건). pine2py wavealgo/__init__.py L130-132 request_earnings(ticker=None,
// field=None, gaps=False, lookahead=False, **kwargs)가 dividends/splits와 완전히 동일한 형태의
// 순수 스텁 — 인자 전부 무시하고 항상 0.0 반환(literal port로 오라클 대조 가능).

export function earnings(_ticker = "", _field = "", _gaps = false, _lookahead = false): number {
  return 0.0;
}

// request.quandl(신규, C310 — corpus 실측 2건). pine2py wavealgo/__init__.py L138-140
// request_quandl(ticker=None, gaps=False, lookahead=False, **kwargs)이 인자 전부 무시하고 항상
// 0.0을 반환하는 순수 스텁 — dividends/splits/financial과 동일 원칙(스텁 자체가 오라클).

export function quandl(_ticker = "", _gaps = false, _lookahead = false): number {
  return 0.0;
}

// request.security_lower_tf(신규, C310 — wild 3위 서브클러스터 14건). pine2py
// wavealgo/__init__.py L103-113 request_security_lower_tf(symbol=None, timeframe=None,
// expression=None, ignore_invalid_symbol=False, currency=None, ignore_invalid_timeframe=False,
// calc_bars_count=0, **kwargs) 시그니처를 codegen.py CONTEXT_FUNCS가 context=ctx 키워드까지
// 얹어 호출하지만, 이 함수 자신은 context 파라미터를 아예 안 받아(**kwargs로 흡수) 조용히
// 버려진다 — 즉 request.security(실제 HTF 캐시 집계, C174~182)와 달리 symbol/timeframe/
// context 전부 무시하고 "expression을 현재 바 값으로 평가해 원소 1개짜리 배열로 감싸기"만
// 하는 순수 스텁이다(python 실측 확인). pine2js는 codegen이 이미 Series 산술을 스칼라로
// 낮추므로(GOAL.md ".get(0) 명시 생성") expression은 호출 시점에 이미 평가된 값 — 별도 narrow
// 표현식 제약(request.security의 캐싱 제약과 달리) 자체가 불필요하다.
export function securityLowerTf<T>(
  _symbol = "",
  _timeframe = "",
  expression: T,
  _ignoreInvalidSymbol = false,
  _currency: string | null = null,
  _ignoreInvalidTimeframe = false,
  _calcBarsCount = 0,
): T[] {
  return [expression];
}

// request.seed(신규, C321 — corpus 실측 8건). pine2py에 대응 구현이 전혀 없다(dividends/splits/
// financial/quandl과 달리 스텁조차 없음) — TV 공식 문법상 커뮤니티 유지보수 "seed" 데이터셋을
// 조회하는 함수라 우리 엔진의 단일 OHLCV 배치 리플레이 데이터 모델엔 그 데이터 소스 자체가 없다.
// financial/economic(NaN 고정 스텁)과 동일 원칙을 hand-verified로 신규 적용 — expression은 값을
// 버리지만 인자로 받아 evaluation order/부작용을 보존한다(security_lower_tf와 동일 관례).
export function seed<T>(_source = "", _symbol = "", _expression?: T, _ignoreInvalidSymbol = false): number {
  return NaN;
}

// request.currency_rate(신규, C321 — corpus 실측 2건). pine2py에 대응 구현 전혀 없음. TV 공식 문서:
// "값을 계산할 수 없으면 na가 반환된다" — 우리 엔진엔 실제 FX 환율 데이터 소스가 없어 일반적인
// 경우엔 na가 유일하게 안전한 값이지만, from===to는 정의상 항상 1.0(항등 변환, 외부 데이터 조회
// 불필요)이라 이 경우만 hand-verified로 분기.
export function currencyRate(from = "", to = "", _ignoreInvalidCurrency = false): number {
  return from === to ? 1.0 : NaN;
}
