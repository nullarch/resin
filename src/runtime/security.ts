// request.security 첫 슬라이스(ROADMAP P2 [hard->분할]) — HTF(higher timeframe) 사전 집계 +
// O(1) 바별 lookup. pine2py wavealgo/security.py(SecurityManager)를 시맨틱 참조로 이식하되
// GOAL.md 배치 리플레이 철학(C172 발견: Context가 전 OHLCV 배열을 이미 쥔다)에 맞춰 "바 루프
// 진입 전 timeframe 문자열당 1회 집계 + 매 바 배열 인덱싱만" 구조로 짠다 — pine2py도 구조는
// 동일(캐시 lazy-build 후 재사용)이나, tf가 pine2js에서는 컴파일타임 리터럴로 고정돼 있어(analyzer
// 검증) 콜사이트별로 Context 생성 시점에 즉시 선계산해도 무해하다(첫 호출까지 미룰 이유가 없음).
//
// **의도적 미추종(GOAL.md "알려진 버그는 따르지 않는다", DIVERGENCES.md 신규 항목)**: pine2py는
// lookahead=off인데 htf_idx===0(전체 데이터의 첫 HTF 구간)이면 "이전 구간 없음" 가드
// (security.py:129-135 `htf_idx > 0`)가 안 걸려 그 구간이 아직 진행 중이든 아니든 이미 전체 배열
// 기준으로 완성된 첫 HTF 바의 값을 그대로 새버린다(미래 확정값 누출). pine2js는 htf_idx===0인
// 모든 바에서 na를 반환한다(TV 실제 규칙: 데이터의 첫 HTF 구간은 그 구간 안에서는 "확정된 이전
// 구간"이 존재하지 않으므로 na가 정합이라고 추정 — P3 TV 골든 전까지 가설). htf_idx>=1인 바는
// pine2py와 동일하게 htf_idx-1(직전 확정 HTF 바)을 반환해 literal port로 오라클 대조 가능.
//
// gaps=off/lookahead=off 고정(이번 슬라이스는 인자 자체를 받지 않음 — 어차피 TV 기본값과 동일하므로
// 무인자 request.security(symbol, tf, expr) 호출과 완전히 동등) — gaps 분기(security.py:139-143)는
// 아직 구현하지 않는다(analyzer가 4번째 이상 인자를 하드 에러로 거부).

// AggregatedBar 5필드를 flat Float64Array 4종 + volume으로 저장(array-of-struct 대신
// struct-of-array — GOAL.md 스타일, TA taSlots의 plain object와 달리 이건 정적 크기라 typed array가
// 자연스럽다). barMap은 차트 바 idx -> 그 바가 속한 HTF 바 인덱스(pine2py bar_map과 동일, 항상
// 0 이상 — 첫 원본 바가 항상 새 HTF 바를 만들어 음수 인덱스가 나올 수 없다).
// C441: timeOpen/timeClose — HTF 바의 시각 필드(wild "var-subst:undeclared" 최대 버킷, 37건 중
// 32건이 request.security 표현식 안에서 bare `time`/`time_close`를 직접 참조 — classifyIdentifier
// 진단이 "미선언"으로 오분류했을 뿐 실제로는 BAR_SERIES_NAMES 5종과 동일 범주의 TV 내장 bar-scoped
// 식별자였다, MEMORY "버킷 라벨을 액면대로 믿지 말 것" 재발현). pine2py security.py의
// _resolve_expression은 8종 OHLC(V) identity만 다루고 time/time_close/bar_index는 아예 없어(오라클
// 구조적 불가, C176류) 순수 hand-verified 신규 설계 — TV 미검증(가설), DIVERGENCES 참조.
export interface SecurityCache {
  barMap: Int32Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  timeOpen: Float64Array;
  timeClose: Float64Array;
}

// bar_index는 배열이 아니라 resolveHtfIndex가 이미 계산한 htfIdx 그 자체를 field로 반환한다(HTF
// 바 시퀀스 안에서의 0-based 위치 — context.ts BAR_INDEX_NAME 주석의 "Context.idx와 동형" 원칙을
// HTF 바 단위로 재적용, 별도 캐시 배열 불필요).
export type SecurityField = "open" | "high" | "low" | "close" | "volume" | "time" | "time_close" | "bar_index";

// pine2py wavealgo/security.py _TF_MINUTES + _parse_tf_minutes literal port. 정확히 일치하지
// 않는 문자열(숫자 아님 + h/d/w 접미사도 아님)은 pine2py라면 int() 캐스팅이 ValueError로 크래시하지만,
// analyzer가 tf를 컴파일타임 문자열 리터럴로만 받게 강제해 이 경로는 사용자가 D/W/M/분단위 표준
// 문자열을 쓰는 한 도달하지 않는다 — 도달해도 JS는 크래시 없이 1440(일봉 기본값)으로 폴백한다(GOAL.md
// "알려진 버그는 따르지 않는다" 취지와 합치, 순수 방어적 폴백이라 오라클 대조 대상이 아님).
const TF_MINUTES: Readonly<Record<string, number>> = {
  "1": 1, "3": 3, "5": 5, "15": 15, "30": 30, "45": 45,
  "60": 60, "120": 120, "180": 180, "240": 240,
  D: 1440, W: 10080, M: 43200,
  "1D": 1440, "1W": 10080, "1M": 43200,
};

// export: time.ts(C299)가 timeframe 문자열 -> 분단위 변환을 재사용한다(time()은 tf가 컴파일타임
// 리터럴로 제약되지 않아 이 함수를 그대로 공유하는 편이 별도 사본보다 안전).
export function parseTfMinutes(tf: string): number {
  const known = TF_MINUTES[tf];
  if (known !== undefined) return known;
  // Python int(tf) 흉내 — 정수 형태(부호+숫자만, 공백 허용)만 인정하고 "1.5" 같은 소수 문자열은
  // 실패시켜(pine2py도 int()가 ValueError) 아래 접미사/기본값 폴백으로 넘긴다.
  const trimmed = tf.trim();
  if (/^[+-]?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const lower = tf.toLowerCase();
  if (lower.endsWith("h")) {
    const n = Number(lower.slice(0, -1));
    if (Number.isFinite(n)) return n * 60;
  }
  if (lower.endsWith("d")) {
    const n = Number(lower.slice(0, -1));
    if (Number.isFinite(n)) return n * 1440;
  }
  if (lower.endsWith("w")) {
    const n = Number(lower.slice(0, -1));
    if (Number.isFinite(n)) return n * 10080;
  }
  return 1440;
}

// ISO 8601 주차(연/주) — Python datetime.isocalendar()와 동일 정의(목요일이 속한 연도를 그 주의
// ISO 연도로 삼는 표준 알고리즘). pine2py _aggregate_by_time의 `dt.isocalendar()` literal port —
// JS Date에는 대응 내장 함수가 없어 직접 구현.
function isoWeekOf(epochMs: number): { isoYear: number; isoWeek: number } {
  const d = new Date(epochMs);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // 월=0..일=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // 이 주의 목요일로 이동
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const isoWeek = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return { isoYear: date.getUTCFullYear(), isoWeek };
}

// pine2py _aggregate_by_time의 period 계산 literal port(security.py:169-185) — D/W/M은 달력
// 경계(UTC), 그 외는 tf_seconds 단위 floor division.
function periodForTime(tSec: number, tf: string, tfSeconds: number): number {
  if (tf === "D" || tf === "1D") {
    const d = new Date(tSec * 1000);
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  }
  if (tf === "W" || tf === "1W") {
    const { isoYear, isoWeek } = isoWeekOf(tSec * 1000);
    return isoYear * 100 + isoWeek;
  }
  if (tf === "M" || tf === "1M") {
    const d = new Date(tSec * 1000);
    return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
  }
  return Math.floor(tSec / tfSeconds);
}

// 두 집계 경로(달력 기반/나이브 count) 공용 accumulate — "새 period면 첫 값으로 시작, 아니면
// high=max/low=min/close=갱신/volume=누적"(pine2py의 "생성 시 open/high/low만 세팅 후 무조건
// 갱신 블록을 한 번 더 통과"와 동치 — volume은 AggregatedBar.__init__ 기본값 0에서 매 바 +=v로
// 귀결되므로 신규 바에서도 결국 v가 된다, security.py:193-209/226-246 참조).
function accumulate(
  bars: {
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
    timeOpen: number[];
  },
  isNewPeriod: boolean,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  t: number,
): void {
  if (isNewPeriod) {
    bars.open.push(o);
    bars.high.push(h);
    bars.low.push(l);
    bars.close.push(c);
    bars.volume.push(v);
    bars.timeOpen.push(t);
    return;
  }
  const last = bars.open.length - 1;
  bars.high[last] = Math.max(bars.high[last]!, h);
  bars.low[last] = Math.min(bars.low[last]!, l);
  bars.close[last] = c;
  bars.volume[last] = bars.volume[last]! + v;
}

// timeClose[k] = timeOpen[k+1](다음 HTF 바의 open 시각 근사), 마지막 바는 직전 간격으로 외삽,
// 바가 1개뿐이면 duration=0으로 자기 자신 — context.ts timeCloseMs/timeCloseAt(C342/C368)와
// 완전히 동일한 공식을 HTF 바 배열에 재적용(메인 차트 time_close의 이미 확정된 hand-verified
// 설계를 그대로 승계, 새 가설 도입 없음).
function deriveTimeClose(timeOpen: Float64Array): Float64Array {
  const n = timeOpen.length;
  const timeClose = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    if (k + 1 < n) {
      timeClose[k] = timeOpen[k + 1]!;
    } else if (n >= 2) {
      timeClose[k] = timeOpen[n - 1]! + (timeOpen[n - 1]! - timeOpen[n - 2]!);
    } else {
      timeClose[k] = timeOpen[0]!;
    }
  }
  return timeClose;
}

function buildByTime(
  open: ArrayLike<number>,
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  volume: ArrayLike<number>,
  time: ArrayLike<number>,
  tf: string,
): SecurityCache {
  const n = close.length;
  const tfSeconds = parseTfMinutes(tf) * 60;
  const barMap = new Int32Array(n);
  const bars = {
    open: [] as number[],
    high: [] as number[],
    low: [] as number[],
    close: [] as number[],
    volume: [] as number[],
    timeOpen: [] as number[],
  };
  let currentPeriod: number | null = null;
  for (let i = 0; i < n; i++) {
    const tMs = i < time.length ? time[i]! : 0;
    const period = periodForTime(tMs / 1000, tf, tfSeconds);
    const isNewPeriod = period !== currentPeriod;
    if (isNewPeriod) currentPeriod = period;
    accumulate(bars, isNewPeriod, open[i]!, high[i]!, low[i]!, close[i]!, volume[i]!, tMs);
    barMap[i] = bars.open.length - 1;
  }
  const timeOpen = Float64Array.from(bars.timeOpen);
  return {
    barMap,
    open: Float64Array.from(bars.open),
    high: Float64Array.from(bars.high),
    low: Float64Array.from(bars.low),
    close: Float64Array.from(bars.close),
    volume: Float64Array.from(bars.volume),
    timeOpen,
    timeClose: deriveTimeClose(timeOpen),
  };
}

function buildByCount(
  open: ArrayLike<number>,
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  volume: ArrayLike<number>,
  tf: string,
): SecurityCache {
  const n = close.length;
  const ratio = Math.max(1, parseTfMinutes(tf));
  const barMap = new Int32Array(n);
  const bars = {
    open: [] as number[],
    high: [] as number[],
    low: [] as number[],
    close: [] as number[],
    volume: [] as number[],
    timeOpen: [] as number[],
  };
  for (let i = 0; i < n; i++) {
    const isNewPeriod = i % ratio === 0;
    // time 채널 자체가 없는 경로(has_time=false 폴백) — timeOpen/timeClose는 pine2py
    // AggregatedBar 기본값(0)과 동일하게 0 고정(barTimeMs의 "채널 부재 시 0" 관례와 동형).
    accumulate(bars, isNewPeriod, open[i]!, high[i]!, low[i]!, close[i]!, volume[i]!, 0);
    barMap[i] = bars.open.length - 1;
  }
  const timeOpen = Float64Array.from(bars.timeOpen);
  return {
    barMap,
    open: Float64Array.from(bars.open),
    high: Float64Array.from(bars.high),
    low: Float64Array.from(bars.low),
    close: Float64Array.from(bars.close),
    volume: Float64Array.from(bars.volume),
    timeOpen,
    timeClose: deriveTimeClose(timeOpen),
  };
}

// 콜사이트 하나당 한 번(Context 생성 시) 호출 — "바 루프 밖에서 timeframe당 1회" 원칙(ROADMAP).
// time이 있으면 달력 기반(D/W/M/분단위), 없으면 나이브 count 비율 폴백(security.py:151 has_time
// 분기 literal port).
export function build(
  open: ArrayLike<number>,
  high: ArrayLike<number>,
  low: ArrayLike<number>,
  close: ArrayLike<number>,
  volume: ArrayLike<number>,
  time: ArrayLike<number> | undefined,
  tf: string,
): SecurityCache {
  return time !== undefined
    ? buildByTime(open, high, low, close, volume, time, tf)
    : buildByCount(open, high, low, close, volume, tf);
}

// barMap+gaps+lookahead -> htfIdx 인덱스 해석부만 분리(3c, ROADMAP [hard->분할] 셋째 슬라이스) —
// get()/getFromArray() 공용. 반환값 -1은 "na 신호"(호출부가 NaN으로 변환) — 실제 htfIdx는 항상
// 0 이상이라(barMap 값 자체가 항상 0 이상, SecurityCache 파일 헤더 참조) -1과 절대 충돌하지 않는다.
// security.py:126-146 get() literal port:
//   htf_idx = bar_map[idx]
//   if not lookahead and htf_idx > 0: htf_idx -= 1      (htf_idx<=0이면 이전 확정 구간이 없어 na —
//                                                          첫 슬라이스가 이미 확정한 미추종 결정,
//                                                          파일 헤더의 "의도적 미추종" 참조)
//   if gaps and idx>0 and bar_map[idx-1] == htf_idx: na   (비교 기준이 lookahead **보정 전** 원본
//                                                          bar_map[idx-1]인 것이 pine2py 원문 그대로
//                                                          — TV 미검증 가설로 literal port, DIVERGENCES)
// lookahead=on은 인덱스 보정 자체가 없다(0번째 구간 na 예외는 lookahead=off 전용, next_hint 명시).
function resolveHtfIndex(cache: SecurityCache, idx: number, gaps: boolean, lookahead: boolean): number {
  const rawHtfIdx = cache.barMap[idx]!;
  let htfIdx: number;
  if (lookahead) {
    htfIdx = rawHtfIdx;
  } else {
    if (rawHtfIdx <= 0) return -1;
    htfIdx = rawHtfIdx - 1;
  }
  if (gaps && idx > 0) {
    const prevRawHtfIdx = cache.barMap[idx - 1]!;
    if (prevRawHtfIdx === htfIdx) return -1;
  }
  return htfIdx;
}

// 매 바 O(1) lookup — 할당 없음(GOAL.md "bar loop 안 할당 제로"). bare series(open/high/low/close/
// volume) 콜사이트 전용(첫/둘째 슬라이스) — 인덱스 해석은 resolveHtfIndex 공용, 여기선 필드만 선택.
export function get(cache: SecurityCache, idx: number, field: SecurityField, gaps: boolean, lookahead: boolean): number {
  const htfIdx = resolveHtfIndex(cache, idx, gaps, lookahead);
  if (htfIdx < 0) return NaN;
  if (field === "open") return cache.open[htfIdx]!;
  if (field === "high") return cache.high[htfIdx]!;
  if (field === "low") return cache.low[htfIdx]!;
  if (field === "close") return cache.close[htfIdx]!;
  if (field === "volume") return cache.volume[htfIdx]!;
  if (field === "time") return cache.timeOpen[htfIdx]!;
  if (field === "time_close") return cache.timeClose[htfIdx]!;
  return htfIdx; // bar_index — 파일 헤더 SecurityField 주석 참조
}

// C739(배치37(3) 9차 — series-arg PARAM sole 리프): bare series 콜사이트의 "요청 tf 문맥 히스토리
// 오프셋"(`request.security(tid, "D", high[_bar])`의 [_bar] — HTF 행 단위 N바 전)을 프리패스 없이
// 읽기 지점에서 적용하는 get() 변형. resolveHtfIndex 해석(gaps/lookahead 동일)까지는 get()과 같고,
// 그 행에서 offset(HTF 행 단위)을 더 뺀 행의 필드를 읽는다. 리터럴 오프셋 프리패스 경로(codegen
// `(h >= n ? cache.f[h-n] : NaN)` + getFromArray[htfIdx])와 정확 동치: 합성하면 field[htfIdx-n],
// 워밍업(htfIdx<n)은 NaN — 여기의 h<0 가드와 일치. 이 함수가 필요한 이유: offset이 UDF 매개변수
// 산술 같은 런타임 값이면 프리패스(프리앰블 1회, per-bar 스코프 없음 — C598 클래스)로는 구조적으로
// 방출 불가라 읽기 지점 평가가 유일한 정확한 위치다. trunc+음수 가드는 secHistGet(series.ts)과
// 동일 원칙(음수/NaN 오프셋은 na). getHist(위)와 다름 주의 — 그쪽은 "메인 tf N바 전 시점의 결과"
// (idx-offset 재조회), 이쪽은 "요청 tf 문맥의 N행 전 필드"(htfIdx-offset).
export function getFieldHtfOffset(
  cache: SecurityCache,
  idx: number,
  field: SecurityField,
  gaps: boolean,
  lookahead: boolean,
  offset: number,
): number {
  const off = Math.trunc(offset);
  if (!(off >= 0)) return NaN;
  const htfIdx = resolveHtfIndex(cache, idx, gaps, lookahead);
  if (htfIdx < 0) return NaN;
  const h = htfIdx - off;
  if (h < 0) return NaN;
  if (field === "open") return cache.open[h]!;
  if (field === "high") return cache.high[h]!;
  if (field === "low") return cache.low[h]!;
  if (field === "close") return cache.close[h]!;
  if (field === "volume") return cache.volume[h]!;
  if (field === "time") return cache.timeOpen[h]!;
  if (field === "time_close") return cache.timeClose[h]!;
  return h; // bar_index — get()의 동일 관례
}

// 셋째 슬라이스 서브슬라이스 3c(ROADMAP [hard->분할]) — 표현식 콜사이트(3a/3b) 전용. valueArr는
// codegen HTF 프리패스(3b, generateSecurityExprPreamble)가 만든 $.securityExprCache[slot]
// (HTF-네이티브 시퀀스 위에서 그 표현식/ta.* 상태를 재실행한 결과) — get()과 동일한 barMap+gaps+
// lookahead 인덱스 해석을 그 배열에 대고 적용할 뿐, 필드 선택 분기가 없다는 점만 get()과 다르다.
export function getFromArray(
  valueArr: Float64Array,
  cache: SecurityCache,
  idx: number,
  gaps: boolean,
  lookahead: boolean,
): number {
  const htfIdx = resolveHtfIndex(cache, idx, gaps, lookahead);
  if (htfIdx < 0) return NaN;
  return valueArr[htfIdx]!;
}

// request.security(...)[N] top-level 히스토리 참조 전용(C448, ROADMAP index-dynamic-or-negative
// 잔여 CallExpr 축 — index-access.ts analyzeIndexAccess CallExpr 분기 주석 참조). ta.* 콜 히스토리
// (series.ts histGet)와 달리 record() 인라인이 필요 없다 -- get()/getFromArray()가 읽는
// SecurityCache/securityExprCache는 이미 트랜스파일 시점에 전체 바 범위로 미리 집계된 배열이라
// (analyzer securityTfs -> engine.ts Context 생성자), 메인 타임프레임 bar index($.idx)에서 offset을
// 뺀 값으로 다시 조회하기만 하면 "N바 전 시점의 request.security 결과"가 그대로 나온다. trunc +
// 긍정형 가드는 series.ts histGet/secHistGet과 동일 원칙 — mainIdx가 0 미만이면(워밍업 구간) na.
export function getHist(
  cache: SecurityCache,
  idx: number,
  field: SecurityField,
  gaps: boolean,
  lookahead: boolean,
  offset: number,
): number {
  const off = Math.trunc(offset);
  if (!(off >= 0)) return NaN;
  const mainIdx = idx - off;
  if (mainIdx < 0) return NaN;
  return get(cache, mainIdx, field, gaps, lookahead);
}

export function getFromArrayHist(
  valueArr: Float64Array,
  cache: SecurityCache,
  idx: number,
  gaps: boolean,
  lookahead: boolean,
  offset: number,
): number {
  const off = Math.trunc(offset);
  if (!(off >= 0)) return NaN;
  const mainIdx = idx - off;
  if (mainIdx < 0) return NaN;
  return getFromArray(valueArr, cache, mainIdx, gaps, lookahead);
}
