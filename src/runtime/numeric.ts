// 안전 수치 연산. GOAL.md 아키텍처 불변 원칙: `/`->pineDiv, `%`->pineMod (0-나눗셈 -> NaN).

export function pineDiv(a: number, b: number): number {
  if (b === 0) return NaN;
  return a / b;
}

export function pineMod(a: number, b: number): number {
  if (b === 0) return NaN;
  return a % b;
}

// int/int 나눗셈 — GOAL.md "안전 연산: int/int→rt.idiv(trunc)". pineDiv와 동일하게 0-나눗셈은
// NaN(analyzer가 두 피연산자 모두 컴파일타임에 확실히 int로 판별되는 경우에만 이 함수로 내림 —
// analyzer.ts inferNumType 참조). trunc는 0을 향해 자르는 방향이라 Math.trunc가 정확히 이 의미.
export function idiv(a: number, b: number): number {
  if (b === 0) return NaN;
  return Math.trunc(a / b);
}

export function na(x: unknown): boolean {
  return typeof x === "number" ? x !== x : x === null;
}

// bar_index[n]의 동적(런타임) 오프셋 전용(C305, ROADMAP P4 next_hint 3위 "동적 히스토리 오프셋"
// wild 클러스터). 리터럴 오프셋은 analyzer가 이미 컴파일타임에 0 이상 정수로 확정해뒀으므로
// codegen이 직접 `$.idx >= n ? $.idx-n : NaN` 삼항으로 내린다(그대로 유지, 이 함수는 안 씀) —
// bar_index는 open/high/low/close처럼 실제 Series를 두지 않고 $.idx 산술로만 값을 합성하므로
// (analyzer.ts BAR_INDEX_NAME 주석), 런타임 표현식 오프셋을 받으려면 Series.get()(series.ts)이
// 하는 trunc+음수 가드를 여기서 직접 재현해야 한다. idx는 항상 $.idx(호출부 고정, 이미 정수)라
// trunc 불필요 — offset만 trunc 대상.
export function barIndexHistory(idx: number, offset: number): number {
  const t = Math.trunc(offset);
  if (!(t >= 0) || idx < t) return NaN;
  return idx - t;
}

// 리플레이 전체에서 값이 변하지 않는 시각 상수(last_bar_index/last_bar_time/timenow)의 동적
// (런타임) 오프셋 히스토리(C368) — "n바 전의 값"도 같은 상수지만, 그 바 자체가 없는 워밍업
// (idx < offset)은 다른 히스토리 참조와 동일하게 NaN이어야 한다. barIndexHistory와 같은
// trunc + 긍정형 가드(리터럴 오프셋은 codegen이 `$.idx >= n ? C : NaN` 삼항으로 직접 낸다).
export function histConst(value: number, idx: number, offset: number): number {
  const t = Math.trunc(offset);
  if (!(t >= 0) || idx < t) return NaN;
  return value;
}

// UnaryOp 'not' — DIVERGENCES.md #4: JS `!NaN`===true(na가 조건에 진입), Python `not nan`===False,
// TV `not na`===na(→falsy). pine2js는 TV에 정렬: na 피연산자는 na를 그대로 전파하고, 그 외에만
// JS 네이티브 `!`(부정)를 적용한다. `x !== x`만으로 na 판별이 되는 이유는 이 함수의 실제 피연산자가
// 항상 JS boolean(true/false, 자기 자신과 항상 동일) 또는 na를 나타내는 NaN(자기 자신과 다름)이기
// 때문 — 참조형 na(null)는 bool 위치에 오지 않는다(GOAL.md na 3분할 규약).
export function pineNot(x: boolean | number): boolean | number {
  return x !== x ? NaN : !x;
}

// 비교 연산자(</>/<=/>=) — DIVERGENCES.md #4(pineNot/C25와 같은 클래스): JS `NaN < x`/`NaN > x`
// 등은 항상 false를 반환해 na가 조용히 사라지지만(false로 위장), TV는 "피연산자 중 하나라도 na면
// 결과도 na"다. pine2py도 Python `nan > x`가 False라 이 갭을 오라클로 검증할 수 없음(C25 not과
// 동일 사정) — 두 피연산자 모두 유한할 때만 네이티브 비교를 적용하고, 하나라도 na면 na(NaN)를
// 그대로 전파한다(ROADMAP P2 "C25 발견" 항목).
export function pineLt(a: number, b: number): boolean | number {
  return a !== a || b !== b ? NaN : a < b;
}

export function pineGt(a: number, b: number): boolean | number {
  return a !== a || b !== b ? NaN : a > b;
}

export function pineLe(a: number, b: number): boolean | number {
  return a !== a || b !== b ? NaN : a <= b;
}

export function pineGe(a: number, b: number): boolean | number {
  return a !== a || b !== b ? NaN : a >= b;
}

// 논리 AND/OR — pine2py 문서(docs/pinescript/03-operators.md L60-62, docs/pinescript/09-edge-cases.md
// L5-11)가 명시하는 TV 실제 시맨틱은 pineLt류(DIVERGENCES.md #4, "피연산자 중 하나라도 na면 무조건
// na")와 다른 패턴이다: `false and na`→false, `true and na`→na, `true or na`→true, `false or na`→na
// — AND는 false가, OR는 true가 있으면 그 값이 다른 피연산자의 na 여부와 무관하게 결과를 절대
// 결정한다("단축 평가"), 그 외의 경우에만 na가 전파되는 진짜 Kleene 3치 논리. pine2py 자체도
// codegen이 이 문서화된 시맨틱을 따르지 않고 Python 네이티브 and/or를 그대로 방출한다(Python
// float('nan')이 truthy라 실제 생성 코드가 문서와 어긋남 — 오라클 검증 불가, hand-verified 대상).
// C449 버그 수정: bool 값이 Float64Array 슬롯(top-level '=' 로컬 히스토리 C363/UDF 히스토리 C364/
// request.security expr 캐시)을 한 번 왕복하면 true/false가 JS 숫자 강제변환으로 1/0이 된다(rt.na가
// `x!==x||x===null`이라 이 왕복 자체는 na-safe하지만, 여기 아래의 엄격한 `===false`/`===true` 비교는
// 원시 boolean만 인식해 1/0을 걸러내지 못했다) — `pineAnd(true, 0)`이 false를 반환해야 하는데 어느
// 비교에도 안 걸려 아래로 떨어져 `true`를 반환하는 조용한 오답이었다(스칼라만 다루던 기존 코드가
// 히스토리를 거친 bool과 처음 만나 드러난 latent 버그, C444/C446과 같은 "처음 도달하는 case" 계열).
// 인코딩이 항상 정확히 {true/1, false/0, NaN}뿐임을 이용해(pineLt류의 반환 타입이 이 셋 밖으로
// 못 나간다) 0/1도 함께 인식한다 — 순수 boolean 경로의 기존 동작은 그대로 보존된다.
export function pineAnd(a: boolean | number, b: boolean | number): boolean | number {
  if (a === false || a === 0 || b === false || b === 0) return false;
  if (a !== a || b !== b) return NaN;
  return true;
}

export function pineOr(a: boolean | number, b: boolean | number): boolean | number {
  if (a === true || a === 1 || b === true || b === 1) return true;
  if (a !== a || b !== b) return NaN;
  return false;
}

// '=='/'!=' — C602(C811 실측 확정, C812 수정). pineAnd/pineOr가 C449에서 고친 것과 정확히 같은
// 원인: bool 값이 Float64Array 히스토리 슬롯($.histSlots/$.fnHistSlots/security expr 캐시)을 한 번
// 왕복하면 JS 숫자 강제변환으로 true→1/false→0이 되는데, genEquality가 방출하던 네이티브 `===`는
// `1 === true`를 false로 판정해 `b[1] == true`가 b[1]이 실제로 true인데도 false가 되는 조용한
// 오답이었다(`b[1] != true`는 반대로 true). 살아있는 피연산자(`b == true`)나 양쪽 다 히스토리인
// 경우(`b[1] == b[2]`, 1===1)는 원래도 정확했으므로 그 경로의 동작은 그대로 보존해야 한다.
// 해법은 pineAnd/pineOr와 동일하게 {true,1}/{false,0}을 같은 값으로 인정하는 것뿐 — bool↔숫자
// 혼합 비교는 TV 자체가 컴파일 에러로 막으므로(`1 == true`는 소스에 존재할 수 없다) 이 동치
// 판정이 정상 스크립트의 숫자 비교를 바꿀 여지는 없다. 그 밖의 모든 타입(number/string/null/
// 참조형)은 기존 `===` 시맨틱 그대로 — NaN===NaN이 false인 것(na끼리 비교는 genEquality의
// NaLiteral 분기가 rt.na로 따로 처리)도 그대로 유지된다.
export function pineEq(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean") {
    if (typeof b === "number") return b === (a ? 1 : 0);
  } else if (typeof b === "boolean" && typeof a === "number") {
    return a === (b ? 1 : 0);
  }
  return a === b;
}

export function pineNeq(a: unknown, b: unknown): boolean {
  return !pineEq(a, b);
}

// math.round — half-away-from-zero (MEMORY.md Pitfalls: Math.round(-0.5)는 JS에서 -0(toward +inf),
// Pine은 0에서 멀어지는 방향으로 반올림한다. pine2py wavealgo.math.pine_round의 copysign(floor(...))
// 방식을 그대로 이식 — Math.sign은 크기가 0일 때만 부호가 사라지므로 floor(|x|+0.5)>=1인 한 동치).
export function round(value: number, precision: number = 0): number {
  if (value !== value) return NaN; // NaN은 그대로 통과 (na 시맨틱)
  if (precision === 0) {
    return Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  }
  const multiplier = 10 ** precision;
  return (Math.sign(value) * Math.floor(Math.abs(value) * multiplier + 0.5)) / multiplier;
}

// math.round_to_mintick — value를 mintick의 배수로 반올림. pine2py wavealgo.math.round_to_mintick은
// `round(value / mintick) * mintick`에서 이 round()를 Python 내장 round()(banker's — 0.5를 짝수로
// 반올림)에 위임하는데, 같은 모듈의 math.round(pine_round)는 half-away-from-zero를 명시적으로
// 구현해둔 것과 정면으로 모순된다(DIVERGENCES.md #14) — Pine 공식 문서가 math.round의 tie-break
// 규칙("0에서 멀어지는 방향")을 명시할 뿐 round_to_mintick에 별도 규칙을 두지 않으므로, pine2js는
// 이미 검증된 rt.round(half-away-from-zero)를 그대로 재사용해 두 함수의 반올림 규칙을 통일한다
// (GOAL.md "pine2py의 알려진 버그는 따르지 않는다"). mintick<=0은 pine2py와 동일하게 value 그대로.
export function round_to_mintick(value: number, mintick: number = 0.01): number {
  if (value !== value) return NaN;
  if (mintick <= 0) return value;
  return round(value / mintick) * mintick;
}

// math.abs — Math.abs가 NaN을 그대로 통과시키므로 특수 처리 불필요.
export function abs(value: number): number {
  return Math.abs(value);
}

// math.max/math.min — pine2py는 Python 내장 max()/min()에 그대로 위임하는데, Python 비교(`>`)는
// NaN에서 항상 False라 인자 순서에 따라 na가 조용히 사라지는 순서-의존 버그가 있다(예:
// max(nan,5)=nan이지만 max(5,nan)=5). GOAL.md "pine2py의 알려진 버그는 따르지 않는다" 원칙에 따라
// 인자 중 하나라도 na면 na를 반환하도록 명시적으로 전파(MEMORY.md Architecture Decisions 참조).
export function max(...values: number[]): number {
  for (const v of values) if (v !== v) return NaN;
  return Math.max(...values);
}

export function min(...values: number[]): number {
  for (const v of values) if (v !== v) return NaN;
  return Math.min(...values);
}

// math.clamp(value, min, max) — pine2py wavealgo/에 대응 구현 전무(전수 grep 0건), wild
// corpus(1447c120b6f0.pine/d94863a588e7.pine)가 unshadowed(라이브러리 import 없음)로 실사용해
// 실존이 확인된 hand-verified 신규 함수(DIVERGENCES "TV 미검증(가설)"). math.max/min(C13, 위)과
// 동일하게 인자 중 하나라도 na면 na 전파 — value를 [min,max] 구간으로 자르는 순수 함수라
// 세 값 비교 기반인 max/min과 na 시맨틱을 통일하는 것이 자연스럽다(별도 na 처리 근거 없음).
export function clamp(value: number, lo: number, hi: number): number {
  if (value !== value || lo !== lo || hi !== hi) return NaN;
  return Math.min(Math.max(value, lo), hi);
}

// math.avg — 가변 인자 평균, na(NaN)는 스킵하고 유효값만으로 평균(pine2py wavealgo.math.avg의
// `vals = [v for v in args if not isnan(v)]; sum(vals)/len(vals)`와 동치) — 유효값이 하나도 없으면
// (전부 na) NaN. max/min(na 있으면 즉시 na로 전파)과 정반대 방향의 na 처리라는 게 핵심 차이.
export function avg(...values: number[]): number {
  let total = 0;
  let count = 0;
  for (const v of values) {
    if (v === v) {
      total += v;
      count++;
    }
  }
  return count === 0 ? NaN : total / count;
}

// math.floor/math.ceil — Math.floor/Math.ceil이 NaN을 그대로 통과시키므로(pine2py
// wavealgo.math.floor/ceil의 명시적 NaN 조기반환 분기와 결과적으로 동치) 특수 처리 불필요.
export function floor(value: number): number {
  return Math.floor(value);
}

export function ceil(value: number): number {
  return Math.ceil(value);
}

// math.sqrt — 음수 정의역은 Math.sqrt가 이미 NaN을 반환(pine2py의 명시적 x<0 가드와 동치),
// 0은 정의역 안(sqrt(0)=0)이라 별도 분기 불필요.
export function sqrt(value: number): number {
  return Math.sqrt(value);
}

// math.pow — Math.pow가 NaN 피연산자를 그대로 통과. pine2py wavealgo.math.pow도 NaN만 조기
// 검사(음수 밑 + 분수 지수 같은 정의역 예외는 Python이 예외를 던져 오히려 덜 안전 — 이 리포는
// 정수 지수 사용처만 이식 대상이라 그 함정은 해당 없음).
export function pow(base: number, exponent: number): number {
  return Math.pow(base, exponent);
}

// math.log/math.log10 — pine2py는 x<=0을 명시적으로 NaN 처리하는데, JS Math.log/Math.log10은
// 음수는 이미 NaN을 주지만(동치) 정확히 0은 -Infinity를 반환(pine2py와 갈림) — 0 경계만 덮어쓴다.
export function log(value: number): number {
  if (value <= 0) return NaN;
  return Math.log(value);
}

export function log10(value: number): number {
  if (value <= 0) return NaN;
  return Math.log10(value);
}

// math.exp — Math.exp가 NaN을 그대로 통과시키므로 특수 처리 불필요.
export function exp(value: number): number {
  return Math.exp(value);
}

// math.sign — Math.sign(-0)===-0/Math.sign(0)===0처럼 부호 있는 0이 새어나오는 것을 피하려
// 명시적 3분기로 구현(C45의 -0 정규화 교훈과 동일 원칙 — pine2py도 if/elif/else 3분기).
export function sign(value: number): number {
  if (value !== value) return NaN;
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

// math.sin/cos/tan/atan — Math.sin/cos/tan/atan이 NaN을 그대로 통과시키고 정의역 제약도 없어
// (pine2py wavealgo.math의 sin/cos/tan/atan도 NaN 조기반환 외엔 그대로 Python math에 위임)
// 특수 처리 불필요.
export function sin(value: number): number {
  return Math.sin(value);
}

export function cos(value: number): number {
  return Math.cos(value);
}

export function tan(value: number): number {
  return Math.tan(value);
}

export function atan(value: number): number {
  return Math.atan(value);
}

// math.asin/acos — 정의역 [-1,1] 밖은 JS Math.asin/acos가 이미 NaN을 반환(Python math.asin/acos는
// 반대로 ValueError를 던져 pine2py 쪽이 오히려 이 경계에서 안전하지 않다 — 이 리포는 정의역 밖
// 입력을 오라클로 검증하지 않고 JS 네이티브 NaN 반환에 의존, LIMITATIONS.md 참조), 정의역 안은
// Math.asin/acos가 pine2py와 동치라 특수 처리 불필요.
export function asin(value: number): number {
  return Math.asin(value);
}

export function acos(value: number): number {
  return Math.acos(value);
}

// math.atan2 — Math.atan2(y, x)는 pine2py wavealgo.math.atan2(y, x)와 인자 순서가 동일(둘 다
// Python math.atan2 시그니처를 따름), NaN도 그대로 통과.
export function atan2(y: number, x: number): number {
  return Math.atan2(y, x);
}

// math.todegrees/toradians — 단순 스케일 변환, Math 연산이 NaN을 그대로 통과.
export function todegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function toradians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

// int(x)/float(x)/bool(x) — TV v5 명시적 타입캐스트 bare 콜(input.int류와는 별개, C207). pine2py
// wavealgo.core.pine_int/pine_float/pine_bool(python 직접 실행으로 확인)이 na 인자를 크래시 없이
// 그대로 na로 통과시킨다. int()는 0을 향한 트렁케이션(Python int()와 동일 방향) — Math.trunc가
// 정확히 이 의미이고 NaN도 그대로 통과(Math.trunc(NaN)===NaN)시켜 pine_int의 na-through 시맨틱과
// 일치한다. Number(x)를 먼저 거치는 이유는 boolean 인자(`int(true)`)를 0/1로 강제 변환하기
// 위함(Python bool이 int 서브클래스인 것과 동치 동작) — Math.trunc(Infinity)===Infinity로 자연히
// 통과하는데, pine2py는 이 입력에서 `int(float('inf'))`가 OverflowError로 크래시한다(python 직접
// 실행 확인) — GOAL.md "pine2py의 알려진 버그는 따르지 않는다" 적용(DIVERGENCES.md #88). 트렁케이션
// 결과가 정확히 0일 때(`int(-0.5)`류) Math.trunc가 -0을 낼 수 있는데, Python int는 부호 있는 0이
// 없어(pine_int(-0.5)===0, 항상 양의 0) 그대로 두면 vitest `.toBe(0)`이 실패한다(MEMORY.md C45와
// 동일한 함정) — `=== 0`(===는 -0/+0을 동일 취급) 분기로 명시적으로 +0을 반환해 정규화한다.
export function int(x: number | boolean): number {
  const t = Math.trunc(Number(x));
  return t === 0 ? 0 : t;
}

// float(x) — JS Number는 int/float 구분이 없어(MEMORY.md Pitfalls) 이미 number인 인자는 그대로
// 항등(NaN 포함 통과 — pine_float의 na-through 시맨틱과 일치), boolean 인자만 Number()로 0/1 강제
// 변환한다.
export function float(x: number | boolean): number {
  return Number(x);
}

// bool(x) — Boolean(NaN)===false / Boolean(0)===false / 그 외 true가 pine_bool(na→False,
// 0.0→False, 그 외 bool(x))와 정확히 동치(python 직접 실행으로 확인) — 별도 분기 불필요.
export function bool(x: number | boolean): boolean {
  return Boolean(x);
}

// nz(value, replacement=0) — na(value)면 replacement, 아니면 value 그대로. pine2py
// wavealgo.builtins.core.nz와 동일 시맨틱(기본 replacement=0). round/abs/max/min과 같은
// stateless 빌트인이나, namespace 없는 bare 콜이라 analyzer.ts의 dispatch 지점만 다르다.
export function nz(value: number, replacement: number = 0): number {
  return na(value) ? replacement : value;
}

// dateString 1-인자 오버로드(C289, wild 최다빈도 클러스터 259건) 전용 파서 — pine2py가 이 오버로드를
// 구조적으로 지원하지 않아(LIMITATIONS.md C269) 오라클 대조 불가, wild corpus 실측 포맷 분포(259건
// 전수, scratch/timestamp_dateformats.mjs)로 두 계열만 지원: (A) ISO류 "yyyy-MM-dd[THH:mm[:ss]]"
// (B) RFC류 "d MMM yyyy[ HH:mm[:ss]]"(월 이름은 영문 축약 3자로 대소문자 무관 매칭 — full 이름도
// 앞 3자가 표준 축약과 항상 일치해 별도 표 불필요). 두 계열 모두 트레일링 오프셋 "Z"/"UTC"/"+HH:mm"/
// "+HHMM"을 허용 — 오프셋 없으면 UTC로 간주(TV 문서 통설). 두 계열 모두 매칭 실패 시 NaN(na) 반환
// — "월-일 순서 모호"(01-02-2024류) 등 코퍼스 소수 아티팩트는 의도적으로 미지원(범위 밖).
const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const ISO_DATE_STRING_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i;
const RFC_DATE_STRING_RE =
  /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(UTC|[+-]\d{2}:?\d{2})?$/i;

function parseUtcOffsetMinutes(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const upper = raw.toUpperCase();
  if (upper === "Z" || upper === "UTC") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(raw);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function parseDateString(raw: string): number {
  const s = raw.trim();
  const iso = ISO_DATE_STRING_RE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, off] = iso;
    const offsetMin = parseUtcOffsetMinutes(off);
    return (
      Date.UTC(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : 0, mi ? Number(mi) : 0, sec ? Number(sec) : 0) -
      offsetMin * 60000
    );
  }
  const rfc = RFC_DATE_STRING_RE.exec(s);
  if (rfc) {
    const [, d, monName, y, h, mi, sec, off] = rfc;
    const mo = MONTH_ABBR[monName!.slice(0, 3).toLowerCase()];
    if (mo === undefined) return NaN;
    const offsetMin = parseUtcOffsetMinutes(off);
    return (
      Date.UTC(Number(y), mo - 1, Number(d), h ? Number(h) : 0, mi ? Number(mi) : 0, sec ? Number(sec) : 0) -
      offsetMin * 60000
    );
  }
  return NaN;
}

// timestamp(...) — pine2py wavealgo/__init__.py timestamp(*args)의 literal port(C210, python 직접
// 실행으로 실측: timestamp(2024,1,15)/timestamp(2024,1,15,12,30,45)/timestamp("America/New_York",
// 2024,1,15,12,30,45) 세 콜을 실행해 oracle/cases/timestamp_basic.pine 골든으로 고정). 2-오버로드
// 모두 순수 *args(kwargs 없음): (a) `timestamp(year,month,day[,hour,minute,second])` (b)
// `timestamp(tz_str,year,month,day[,hour,minute,second])` — tz_str은 pine2py가 언패킹만 하고 실제로
// 전혀 안 씀(두 오버로드 다 tzinfo=UTC로 계산, 실측 확인: tz_str을 바꿔도 같은 y/m/d/h/mi/s면 같은
// 값). tz_str 유무는 런타임에 args[0] 타입으로 판별(컴파일타임엔 알 수 없음 — analyzer는 인자
// 개수만 검증). (b)만 day 생략 시 1로 기본값(pine2py 원본 자체의 비대칭, 근거 불명이나 그대로 포트).
// 유효 인자가 3개 미만(연/월/일 셋 다 안 채워짐)이면 pine2py는 0을 반환 — 동일하게 포트(현재 구현
// 범위인 두 오버로드에서는 도달 불가: analyzer가 최소 3개를 강제한다). pine2py는 args가 정수가 아닌
// float(NaN 포함)이면 Python `datetime()` 생성자가 TypeError로 크래시하지만, 이는 CPython
// int-vs-float 타입 시스템의 부작용이지 TV 시맨틱이 아니다(C112/C113과 동급 "플랫폼/언어 아티팩트는
// literal port 대상 아님" 판단) — JS Date.UTC는 NaN 인자에서 크래시 없이 NaN을 자연 반환하므로 그대로
// 둔다. tz_str 실제 타임존 처리 여부를 포함해 이 함수 전체가 VERIFIED_SEMANTICS.md에 근거 없는 "TV
// 미검증(가설)"이다(DIVERGENCES.md 참조) — 되돌릴 근거가 생기면 그쪽을 우선할 것. dateString 1-인자
// 오버로드(C289)는 위 parseDateString으로 분리 위임.
export function timestamp(...args: (number | string)[]): number {
  if (args.length === 1 && typeof args[0] === "string") {
    return parseDateString(args[0]);
  }
  let y: number, m: number, d: number, h: number, mi: number, s: number;
  if (args.length >= 3 && typeof args[0] === "string") {
    y = args[1] as number;
    m = args[2] as number;
    d = args.length > 3 ? (args[3] as number) : 1;
    h = args.length > 4 ? (args[4] as number) : 0;
    mi = args.length > 5 ? (args[5] as number) : 0;
    s = args.length > 6 ? (args[6] as number) : 0;
  } else if (args.length >= 3) {
    y = args[0] as number;
    m = args[1] as number;
    d = args[2] as number;
    h = args.length > 3 ? (args[3] as number) : 0;
    mi = args.length > 4 ? (args[4] as number) : 0;
    s = args.length > 5 ? (args[5] as number) : 0;
  } else {
    return 0;
  }
  return Date.UTC(y, m - 1, d, h, mi, s);
}

// '+' 문자열 연결(analyzer.ts isStringExpr가 판별한 concatBinOps 대상, "na/수치 2c-ii") — JS
// 네이티브 `+`를 그대로 쓰지 않는 이유는 MEMORY.md Pitfalls의 "string + null → 'xnull' 문자열이
// 됨" 함정 때문이다(string na는 GOAL.md 규약대로 null인데, JS는 `"x" + null`을 리터럴 "xnull"로
// 만든다). rt.max/min과 동일한 na 전파 원칙을 그대로 적용: 한쪽이라도 na(숫자 NaN 또는 참조형
// null)면 결과 전체를 na(null)로 전파한다 — pine2py는 이 경로 자체를 검증할 오라클이 없어(모든
// na는 float NaN으로만 존재, 타입별 na 구분이 없음) hand-verified 테스트로 대체.
export function concat(a: unknown, b: unknown): string | null {
  if (isNaAny(a) || isNaAny(b)) return null;
  return `${a}${b}`;
}

function isNaAny(v: unknown): boolean {
  return v === null || (typeof v === "number" && v !== v);
}

// obj.copy() — UDT 인스턴스의 얕은 복사(C125, DIVERGENCES.md #57). UDT 인스턴스는 codegen이
// `{fieldName: value, ...}` plain object로 방출하므로(genTypeDecl) 객체 spread 하나로 Python
// `copy.copy()`와 정확히 동일한 진짜 shallow copy가 된다: 새 top-level 객체를 만들되 각 필드
// "값"은 그대로 복사한다 — float/int/bool/string/color 필드는 원시값이라 사실상 독립되지만,
// 중첩 UDT 필드(참조형)는 **같은 객체를 공유**한다(Explore 조사 + python 직접 실행으로 pine2py
// `TypeName.copy(instance)`가 이렇게 동작함을 확인 — 복사본의 중첩 필드를 변형하면 원본도 함께
// 바뀐다). na(null)는 그대로 na 전파(array.copy/map.copy/matrix.copy와 동일 원칙).
export function udtCopy(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (obj === null) return null;
  return { ...obj };
}
