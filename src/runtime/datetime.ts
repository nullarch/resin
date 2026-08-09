// TV 시각 변수(hour/year/dayofweek 등, analyzer.ts TIME_VAR_NAMES) — pine2py
// wavealgo/context.py Context._datetime_component/time_tradingday 리터럴 포트. pine2py는
// 타임존을 UTC로 고정하고(exchange 타임존 지원 없음), 시간 데이터가 없거나(ms===0) 범위를
// 벗어나면 전부 0을 반환한다 — 이 UTC 고정 시맨틱은 VERIFIED_SEMANTICS.md에 근거가 없어
// (OPEN으로도 언급 안 됨) 추측 구현이 금지된 축이라 이 구현 그대로 이식하고 DIVERGENCES에
// "TV 미검증(가설, 실제로는 exchange 타임존일 가능성)"로 등재한다. JS Date의 getUTC* 계열이
// Python datetime.fromtimestamp(t/1000, tz=utc)와 동일한 UTC 분해를 하므로 그대로 대응
// (MEMORY C112의 Windows CRT 크래시 경계는 datetime.fromtimestamp 자체의 문제라 JS Date에는
// 없음 — 이 채널의 ms는 항상 실제 바 타임스탬프(>=0)뿐이라 애초에 그 경계에 도달하지 않는다).

// year/month/.../weekofyear(time_expr[, timezone]) 함수-호출 오버로드의 2번째 timezone 인자
// (C326, wild 175건: hour 138/year 26/dayofweek 5/month 3/dayofmonth 2/minute 1) — pine2py
// time_component()(wavealgo/__init__.py)는 이 인자를 파라미터로만 받고 본문에서 전혀 안 읽어
// (`from datetime import timezone as tz`로 이름까지 shadow) 항상 UTC로만 계산하는 실제 버그다
// (Explore 에이전트 소스 대조 확인) — GOAL.md "pine2py의 당일 close 체결은 버그이므로 따르지
// 말 것"과 동일 원칙(MEMORY.md C2/C14/C18)으로 literal-port 대신 실제 타임존 변환을
// hand-verified로 새로 설계한다(DIVERGENCES 'TV 미검증(가설)' — 이 세션은 웹 접근 없음). wild
// 실사용은 두 형태(C283 큐레이션 — 실사용 확인된 것만): (a) IANA 존 이름("America/New_York" 등,
// '/' 포함) — Node 내장 Intl.DateTimeFormat이 전체 ICU 타임존 DB를 갖고 있어(런타임 의존성 0
// 유지) 새 npm 패키지 없이 그대로 쓸 수 있다. (b) 고정 UTC±offset 문자열("UTC-8"/"GMT+9"류,
// DST 없음) — 정규식으로 직접 파싱. 인식 불가 문자열(오타/미지원 zone)은 조용히 UTC로 폴백
// (기존 1-인자 동작과 동치 — 이 폴백 규칙 자체도 hand-verified 설계).
const FIXED_OFFSET_TZ_RE = /^(?:UTC|GMT)([+-]\d{1,2})(?::?(\d{2}))?$/;

const IANA_ZONE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat | null>();

function getIanaZoneFormatter(zone: string): Intl.DateTimeFormat | null {
  const cached = IANA_ZONE_FORMATTER_CACHE.get(zone);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    fmt = null;
  }
  IANA_ZONE_FORMATTER_CACHE.set(zone, fmt);
  return fmt;
}

// ms가 실제 UTC epoch 타임스탬프일 때, `timezone`으로 표시되는 "벽시계" 값을 기존 getUTC*
// 계열로 그대로 뽑아낼 수 있도록 재-앵커링한 합성 ms를 반환한다(반환값 자체는 진짜 UTC epoch가
// 아니다 — 추출 전용). timezone이 없거나("")/na(null)/미인식 문자열이면 원본 ms를 그대로
// 반환한다(기존 UTC-전용 1-인자 동작과 동치).
function zonedWallClockMs(ms: number, timezone: string | null | undefined): number {
  // ms가 NaN(워밍업 구간 히스토리 오프셋 등)이면 IANA 경로의 Intl.DateTimeFormat.formatToParts가
  // new Date(NaN)에 "RangeError: Invalid time value"를 던진다(고정 오프셋/무-타임존 경로는 NaN을
  // 그대로 전파해 무해하다 — IANA 경로만 예외적으로 throw, C570 wild "Invalid time value" 14건).
  // 다른 컴포넌트 함수(year 등)와 동일하게 NaN을 조용히 전파해야 하므로 여기서 선제 흡수한다.
  if (!Number.isFinite(ms)) return ms;
  if (!timezone) return ms;
  const fixedMatch = FIXED_OFFSET_TZ_RE.exec(timezone);
  if (fixedMatch !== null) {
    const h = parseInt(fixedMatch[1]!, 10);
    const m = fixedMatch[2] !== undefined ? parseInt(fixedMatch[2], 10) : 0;
    const offsetMinutes = h * 60 + (h < 0 ? -m : m);
    return ms + offsetMinutes * 60000;
  }
  const fmt = getIanaZoneFormatter(timezone);
  if (fmt === null) return ms;
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)!.value);
  // hourCycle:"h23"는 0~23이 정상이지만 일부 ICU 빌드의 자정 렌더링 이슈(과거 알려진 브라우저
  // 버그) 방어로 %24를 유지 — 비용 0, 위험만 제거.
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
}

export function year(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCFullYear();
}

export function month(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCMonth() + 1;
}

export function dayofmonth(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCDate();
}

// PineScript dayofweek: 1=Sunday ~ 7=Saturday(pine2py context.py 원문 주석 그대로). JS
// Date.getUTCDay()는 이미 0=Sunday~6=Saturday라 +1만 하면 동형(pine2py의 Python
// weekday()->PineScript 변환식보다 직접적).
export function dayofweek(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCDay() + 1;
}

export function hour(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCHours();
}

export function minute(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCMinutes();
}

export function second(ms: number, timezone?: string | null): number {
  return ms === 0 ? 0 : new Date(zonedWallClockMs(ms, timezone)).getUTCSeconds();
}

// weekofyear — pine2py time_component()의 `dt.isocalendar()[1]`(Python 표준 ISO 8601 주차,
// C302 wild "알 수 없는 함수 호출" 잔존 30-클러스터 조사 중 발견된 gap: TIME_VAR_NAMES/
// TIME_FUNC_NAMES 7종에서 weekofyear만 누락돼 있었음 — pine2py는 bare 변수(ctx.weekofyear)와
// 함수-호출(weekofyear_func) 양쪽을 이미 완전히 지원). ISO 8601 주차는 월요일 시작 + "그 해
// 첫 목요일이 포함된 주가 1주차"(=1월 4일이 포함된 주와 동치) 규칙 — JS에는 대응 내장 메서드가
// 없어 표준 공개 알고리즘(목요일로 스냅 후 그 날짜 기준 연초로부터 몇 주째인지 역산)을 그대로
// 구현. python isocalendar()[1]과 윤년/연말연시 경계(2020-12-31→53, 2021-01-01→53,
// 2018-12-31→1, 2023-01-01→52 등) 전수 대조로 검증 완료.
export function weekofyear(ms: number, timezone?: string | null): number {
  if (ms === 0) return 0;
  const date = new Date(zonedWallClockMs(ms, timezone));
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - isoDayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

// time_tradingday — 거래일 00:00:00 UTC 타임스탬프(pine2py context.py time_tradingday 리터럴
// 포트). 가드가 `t > 0`으로 _datetime_component류의 `t === 0`과 다르나, 이 채널의 ms는 항상
// 실제 바 타임스탬프(음수 없음)뿐이라 실질적으로 동치 — 원본 그대로 이식. NaN 입력(C368,
// 히스토리 워밍업 time_tradingday[n]의 idx<n)만은 0이 아니라 NaN을 전파해야 한다 — 다른
// 컴포넌트(year 등)는 new Date(NaN)이 자연 전파하지만 이 함수는 `NaN > 0` false가 0 폴백
// (채널 부재 신호)과 뭉개지므로 명시 분기.
export function tradingDayStart(ms: number): number {
  if (ms !== ms) return NaN;
  return ms > 0 ? Math.floor(ms / 86400000) * 86400000 : 0;
}
