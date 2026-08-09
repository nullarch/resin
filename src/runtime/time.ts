// time(timeframe[, session[, timezone]])(C299, wild 3위 클러스터 "알 수 없는 함수 호출"의
// 압도적 지배 함수 — 510건 중 443건). 인자 없는 bare `time`(TIME_VAR_NAMES, $.barTimeMs)과
// 별개인 *호출형* — pine2py에는 대응 구현이 전혀 없다(bare 변수 하나뿐, python 직접 실행/소스
// 대조로 확인 — analyzer.ts BAR_INDEX_NAME/TIME_VAR_NAMES 주석 참조) — 오라클 구조적 불가라
// TV 공식 문서 통설 기반 hand-verified 설계(DIVERGENCES.md 'TV 미검증(가설)' 신규 항목).
//
// GOAL.md 배치 리플레이 원칙(Context가 전체 바 이미 보유) 덕에 request.security류 HTF 캐시
// 전체가 불필요하다: "현재 바 자신의 시각을 timeframe 단위로 재계산 + session 필터"는 다른
// 바 데이터를 전혀 참조하지 않는 순수 per-bar 계산이라, security.ts처럼 콜사이트별 컴파일타임
// tf 리터럴 제약/사전 집계 캐시가 필요 없다 — timeframe/session/timezone 셋 다 임의 런타임
// 표현식으로 받는다(analyzer.ts 쪽 제약 없음).
//
// **세션 필터가 검사하는 시각은 반환값(재계산된 periodStart)이 아니라 바 자신의 실제 시각이다**
// — "0930-1600" 같은 시각 패턴은 그 바가 실제로 위치한 순간을 묻는 것이지, timeframe으로 뭉갠
// 집계 경계를 묻는 게 아니라고 판단(TV 미검증(가설) — 이 축은 VERIFIED_SEMANTICS.md에 근거 없어
// 추측 결정, DIVERGENCES 참조). timeframe.period(컴파일타임 "D" 고정, analyzer.ts
// TIMEFRAME_STRING_PROPS)와 결합해 쓰는 가장 흔한 실전 관용구(`time(timeframe.period, session)`
// = "현재 바가 세션 안인가")에서는 이 구분이 무의미하다(재계산 대상 tf가 항상 원본 그대로).
//
// **timezone 인자는 값을 받되 계산에 반영하지 않는다**(항상 UTC로 세션 판정) — datetime.ts가
// 이미 확립한 동일 축의 divergence(hour/minute/dayofweek 등 전부 UTC 고정, "exchange 타임존
// 지원 없음"이 VERIFIED_SEMANTICS.md에 근거 없는 기존 가설)를 그대로 연장한다. 진짜 IANA
// 타임존(DST 포함)을 지원하려면 Intl.DateTimeFormat 기반 신규 엔진이 필요해(런타임 의존성은
// 0이지만 설계 범위가 커짐) 이번 슬라이스 밖으로 미룬다(LIMITATIONS.md 참조).
import { parseTfMinutes } from "./security";
import { dayofweek } from "./datetime";

// D/W/M은 달력 경계(UTC), 그 외(분단위 tf 문자열)는 epoch 기준 floor — security.ts
// periodForTime과 동일한 판별 축이지만, 여기서는 "그 period가 시작하는 실제 ms 시각"을
// 돌려줘야 해서 정수 period 키 대신 boundary timestamp를 직접 계산한다.
function periodStartMs(tMs: number, tf: string): number {
  if (tf === "D" || tf === "1D") {
    const d = new Date(tMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  if (tf === "W" || tf === "1W") {
    // ISO 주 시작(월요일 00:00 UTC) — security.ts isoWeekOf는 (연,주) 키만 필요했지만 여기선
    // 그 주가 시작하는 실제 날짜가 필요해 dayNum(월=0..일=6)만큼 뒤로 물러난다.
    const d = new Date(tMs);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const dow = new Date(dayStart).getUTCDay(); // 0=일..6=토
    const daysSinceMonday = (dow + 6) % 7;
    return dayStart - daysSinceMonday * 86400000;
  }
  if (tf === "M" || tf === "1M") {
    const d = new Date(tMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const tfMs = parseTfMinutes(tf) * 60000;
  if (!(tfMs > 0)) return tMs; // 방어적 폴백(0/NaN tf) — security.ts와 동일하게 크래시 대신 원값 통과
  return Math.floor(tMs / tfMs) * tfMs;
}

// time_close(timeframe[, session[, timezone]])(C400, wild "알 수 없는 함수 호출" 클러스터 재세분화
// 1위 — 61건 중 19건). time()(C299)의 직접 형제: 같은 바 자신의 시각을 같은 timeframe으로 재계산하되
// period의 시작이 아니라 **끝**을 반환한다(TV 공식 문서 통설 — time()/time_close() 쌍은 각각
// 요청 timeframe 바의 시가/종가 시각, hand-verified 설계, DIVERGENCES.md 'TV 미검증(가설)' 신규
// 항목 — pine2py 대응 구현 없음, C299와 동일 이유로 오라클 구조적 불가). D/W는 고정 일수(달력 주 경계는
// 이미 periodStartMs가 흡수)만큼, M은 그 다음 달 1일(달마다 일수가 달라 고정 ms 불가), 그 외
// 분단위 tf 문자열은 periodStart + tfMs. tfMs 방어적 폴백(0/NaN) 분기는 periodStartMs와 대칭으로
// tMs 그대로 반환(크래시 대신 원값 통과, 위 policy 동일).
function periodEndMs(tMs: number, tf: string): number {
  const start = periodStartMs(tMs, tf);
  if (tf === "D" || tf === "1D") return start + 86400000;
  if (tf === "W" || tf === "1W") return start + 7 * 86400000;
  if (tf === "M" || tf === "1M") {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  const tfMs = parseTfMinutes(tf) * 60000;
  if (!(tfMs > 0)) return tMs;
  return start + tfMs;
}

interface SessionRange {
  startMin: number;
  endMin: number;
}

interface ParsedSession {
  ranges: SessionRange[];
  days: string | null; // null = 요일 제약 없음(전 요일)
}

// 세션 문자열 파싱 결과 캐시 — timeframe/session 둘 다 컴파일타임 리터럴 강제가 없어(위 파일
// 헤더 참조) 매 바 같은 문자열을 다시 파싱하지 않도록 메모이즈한다(GOAL.md "bar loop 안 할당
// 제로"에 대한 실용적 타협 — 실전 session 인자는 사실상 상수라 캐시 크기가 세션 종류 수로
// 수렴한다, C283 kwargs 캐시와 동일한 실용주의).
const sessionCache = new Map<string, ParsedSession | "24x7">();

function parseSession(session: string): ParsedSession | "24x7" {
  const cached = sessionCache.get(session);
  if (cached !== undefined) return cached;
  let parsed: ParsedSession | "24x7";
  if (session === "24x7") {
    parsed = "24x7";
  } else {
    // 문법: RANGE(,RANGE)*[:DAYS] — 요일 접미사는 전체 range 목록 뒤에 단 한 번만 온다(wild
    // 실측, 예: "1000-1300,1600-2000,2400-0700:23456"). DAYS 자릿수는 dayofweek()와 동일한
    // 1=일..7=토 값 체계(TV 세션 문자열 공식 관례).
    const colonIdx = session.indexOf(":");
    const rangesPart = colonIdx >= 0 ? session.slice(0, colonIdx) : session;
    const days = colonIdx >= 0 ? session.slice(colonIdx + 1) : null;
    const ranges: SessionRange[] = [];
    for (const part of rangesPart.split(",")) {
      const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(part.trim());
      if (!m) continue;
      // "2400"을 다음날 "0000"과 동치로 접어(% 1440) "2400-0700" 같은 표기를 자연스럽게 정규화.
      const startMin = (parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10)) % 1440;
      const endMin = (parseInt(m[3]!, 10) * 60 + parseInt(m[4]!, 10)) % 1440;
      ranges.push({ startMin, endMin });
    }
    parsed = { ranges, days };
  }
  sessionCache.set(session, parsed);
  return parsed;
}

function inSession(tMs: number, session: string): boolean {
  const parsed = parseSession(session);
  if (parsed === "24x7") return true;
  if (parsed.ranges.length === 0) return true; // 파싱 실패(malformed/빈 문자열) — 제약 없음으로 안전 취급
  if (parsed.days !== null && parsed.days !== "") {
    const dow = dayofweek(tMs); // 1=일..7=토(datetime.ts와 동일 값 체계)
    if (!parsed.days.includes(String(dow))) return false;
  }
  const d = new Date(tMs);
  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  for (const { startMin, endMin } of parsed.ranges) {
    // "0000-0000"/"0000-2400"류 — TV의 24시간(round-the-clock) 세션 관행(syminfo.session이 크립토
    // 심볼에 이 값을 직접 낸다, wild 코퍼스 실측) — 시작==끝을 "0폭"이 아니라 "종일"로 취급.
    if (startMin === endMin) return true;
    if (startMin < endMin) {
      if (minuteOfDay >= startMin && minuteOfDay < endMin) return true;
    } else {
      // 자정을 넘어가는 세션(예: "1614-0930")
      if (minuteOfDay >= startMin || minuteOfDay < endMin) return true;
    }
  }
  return false;
}

// codegen이 $.barTimeMs를 첫 인자로 암묵 주입한다(codegen.ts genCallExpr "time" 분기 참조,
// ta.vwma의 volume 주입과 동일한 원리). session/timezone은 선택 인자라 시그니처 기본값(둘 다
// undefined)으로 1-인자 폼을 그대로 지원 — timezone은 받되 계산에 쓰지 않는다(파일 헤더 참조).
// C575: 세 인자 전부 na 가능(codegen NaLiteral->null, 위 헤더 참조) — timeframe이 na(wild
// `time(na)` 관용구)면 "필수 입력이 na → 결과도 na" 산술 na 전파 원칙(VERIFIED_SEMANTICS.md
// CONFIRMED)을 함수 인자에도 그대로 연장해 NaN 반환(크래시 대신). session이 na면 필터 없음
// (기존 "" 취급과 동일 취급 — 세션 지정을 안 한 것과 구분 불가하므로 방어적으로 동일 처리).
export function resolve(barTimeMs: number, timeframe: string | null, session?: string | null, _timezone?: string | null): number {
  if (barTimeMs === 0) return NaN; // datetime.ts와 동일한 "시간 채널 없음" 센티널
  if (timeframe === null) return NaN;
  if (session !== undefined && session !== null && session !== "" && !inSession(barTimeMs, session)) return NaN;
  return periodStartMs(barTimeMs, timeframe);
}

// codegen이 $.barTimeMs를 첫 인자로 암묵 주입한다(resolve()와 동일 원리, codegen.ts genCallExpr
// "timeClose" 분기 참조). 세션/na 센티널 판정은 resolve()와 완전히 동일(세션 필터는 바 자신의
// 실제 시각을 검사 — 파일 헤더 참조) — periodStartMs 대신 periodEndMs만 다르다.
export function resolveClose(barTimeMs: number, timeframe: string | null, session?: string | null, _timezone?: string | null): number {
  if (barTimeMs === 0) return NaN;
  if (timeframe === null) return NaN;
  if (session !== undefined && session !== null && session !== "" && !inSession(barTimeMs, session)) return NaN;
  return periodEndMs(barTimeMs, timeframe);
}
