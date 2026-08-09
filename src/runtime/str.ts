// str.* 네임스페이스. 전부 순수(stateless) 함수 — math.*와 동일하게 builtinCalls 패턴으로 디스패치
// (조건부 블록 제약 없음). GOAL.md na 3분할 규약: string na = null.
//
// C575: 아래 모든 `string | null` 매개변수 가드는 `x === null`이 아니라 `typeof x !== "string"`로
// 통일한다 — array.get() 범위밖 sentinel(NaN, 타입 무관, C572)이 string 배열에서 흘러나오면
// null이 아니라 NaN이라 `=== null` 가드를 그냥 통과해버려 `.trim()`류 메서드 호출에서
// "X.trim is not a function"으로 크래시했다(wild `str.tonumber(array.get(stringArr, oobIdx))`
// 관용구 실측). typeof 가드는 null/NaN/undefined를 전부 동일하게 na로 흡수해 기존 null 경로의
// 동작은 그대로 유지한다.

// str.length — pine2py wavealgo.builtins.str_funcs.length는 `len(source) if source else 0`로
// None(na)/빈 문자열을 동일하게 0으로 처리하는 명시적 가드를 갖고 있다(다른 str.* 함수와 달리
// 크래시 없이 na를 안전하게 다룬 유일한 사례) — 그대로 literal port. na 전파(NaN) 대신 0을 반환.
export function length(source: string | null): number {
  if (typeof source !== "string" || source === "") return 0;
  return source.length;
}

// str.contains/startswith/endswith/pos — pine2py 소스(source.find/startswith/endswith, `target in
// source`)는 source가 None이면 가드 없이 크래시한다(AttributeError/TypeError) — length와 달리
// na 입력에 대한 정의된 동작이 없다. length의 "0 폴백"은 pine2py의 의도된 가드를 literal port한
// 것이지만, 이 넷은 그런 가드 자체가 없어 GOAL.md na 안전성 원칙에 따라 source/target 중 하나라도
// na(null)면 na를 전파하기로 결정(둘 다 bool/int 반환이라 na는 pineAnd/pineLt류와 동일하게 NaN —
// DIVERGENCES.md 신규 등재, pine2py 오라클로는 이 na 채널을 검증할 수 없다).
export function contains(source: string | null, target: string | null): boolean | number {
  if (typeof source !== "string" || typeof target !== "string") return NaN;
  return source.includes(target);
}

export function startswith(source: string | null, target: string | null): boolean | number {
  if (typeof source !== "string" || typeof target !== "string") return NaN;
  return source.startsWith(target);
}

export function endswith(source: string | null, target: string | null): boolean | number {
  if (typeof source !== "string" || typeof target !== "string") return NaN;
  return source.endsWith(target);
}

// str.pos — pine2py str_funcs.pos는 Python str.find(대상 없으면 -1)에 위임. JS String.indexOf도
// 대상 없으면 -1을 반환해 정확히 동치(에지 케이스 포함 — 빈 target은 둘 다 0을 반환).
export function pos(source: string | null, target: string | null): number {
  if (typeof source !== "string" || typeof target !== "string") return NaN;
  return source.indexOf(target);
}

// str.lower/upper/trim/replace_all/substring/repeat — string 반환 함수(C77). pine2py
// str_funcs.lower/upper/trim/replace_all/substring/repeat도 contains류(C76)와 동일하게 None 가드가
// 전혀 없어(source.lower()/.strip() 등이 AttributeError로 크래시 — scratch로 직접 확인) na 처리에
// pine2py가 정의한 동작이 없다. 다만 반환 타입이 string(참조형)이므로 GOAL.md na 3분할 규약에 따라
// na는 NaN이 아니라 null을 전파한다(contains류의 numeric-na와 다른 지점 — DIVERGENCES.md #17).

export function lower(source: string | null): string | null {
  if (typeof source !== "string") return null;
  return source.toLowerCase();
}

export function upper(source: string | null): string | null {
  if (typeof source !== "string") return null;
  return source.toUpperCase();
}

export function trim(source: string | null): string | null {
  if (typeof source !== "string") return null;
  return source.trim();
}

export function replace_all(source: string | null, target: string | null, replacement: string | null): string | null {
  if (typeof source !== "string" || typeof target !== "string" || typeof replacement !== "string") return null;
  return source.replaceAll(target, replacement);
}

// str.substring — pine2py: `source[begin_pos:] if end_pos<0 else source[begin_pos:end_pos]`. JS
// String.slice()는 음수/범위초과 인덱스에서 Python 슬라이싱과 동치(둘 다 클램프, start>end는 빈
// 문자열) — scratch로 9가지 경계 케이스(음수/범위초과/역순/동일) 전부 대조 완료. end_pos<0 분기는
// "count-from-end"가 아니라 pine2py 소스가 그대로 "끝까지"로 취급하는 특수 케이스라 literal port.
export function substring(source: string | null, begin_pos: number, end_pos: number = -1): string | null {
  if (typeof source !== "string" || Number.isNaN(begin_pos) || Number.isNaN(end_pos)) return null;
  const b = Math.trunc(begin_pos);
  if (end_pos < 0) return source.slice(b);
  return source.slice(b, Math.trunc(end_pos));
}

// str.repeat — pine2py: `separator.join([source] * count)`. count<=0이면 Python 빈 리스트 join과
// 동치로 ""(JS는 Array(count)가 count<0에서 RangeError를 던지므로 명시적 가드 필요).
export function repeat(source: string | null, count: number, separator: string | null = ""): string | null {
  if (typeof source !== "string" || Number.isNaN(count) || typeof separator !== "string") return null;
  const c = Math.trunc(count);
  if (c <= 0) return "";
  return Array(c).fill(source).join(separator);
}

// str.tostring — pine2py str_funcs.tostring 소스 대조(format_str 없음/integer/percent/volume/
// mintick/pattern("#.##" 류) 6분기). value는 numeric na(NaN)만 있고 pine2py의 None 분기와 함께
// "NaN" 문자열로 합쳐 반환(대문자 — pine2py가 명시적으로 "NaN" 리터럴을 반환하지 소문자 "nan"이
// 아님을 소스로 직접 확인 — PROGRESS C86 next_hint의 "소문자 nan" 추측은 틀렸다, MEMORY.md
// "next_hint도 틀릴 수 있다" 재확인 사례). format_str이 na(null)면 pine2py `if not format_str`가
// None도 빈 문자열과 동일하게 기본 분기로 떨어뜨리므로 JS `if (!format_str)`로 literal port.
// array.join(C88)이 숫자 원소 포맷팅에 재사용한다(pine2py array.py의 join도 str.tostring과
// 동일하게 default-branch `str(value)`에 의존 — 아래 join 관련 주석 참조).
export function pyFloatStr(value: number): string {
  // Python str(float) 재현 — 두 언어 모두 "shortest round-trip" 자릿수 알고리즘을 쓰지만(자릿수
  // 자체는 일치) 정수값 소수점 표기(JS는 없음, Python은 ".0")와 지수 표기 전환 임계값(decpt<=-4
  // 또는 decpt>16 — Python 1e-4/1e16, JS 1e-6/1e21)·지수부 zero-padding(Python만 2자리 패딩)이
  // 다르다. toExponential()(인자 없음 = shortest round-trip)로 자릿수/decpt를 뽑아 Python
  // format_float_short의 고정/지수 분기 규칙으로 재조립 — node/python 10,035건(경계값+랜덤 퍼즈)
  // 교차 실측 0건 불일치 확인(scratch/probe_pyfloatstr.mjs).
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  const neg = value < 0;
  const exp = Math.abs(value).toExponential();
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(exp)!;
  const digits = m[1] + (m[2] ?? "");
  const exponent = parseInt(m[3]!, 10);
  const decpt = exponent + 1;
  let out: string;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) {
      out = "0." + "0".repeat(-decpt) + digits;
    } else if (decpt >= digits.length) {
      out = digits + "0".repeat(decpt - digits.length) + ".0";
    } else {
      out = digits.slice(0, decpt) + "." + digits.slice(decpt);
    }
  } else {
    const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits[0]!;
    const esign = exponent < 0 ? "-" : "+";
    const eabs = String(Math.abs(exponent)).padStart(2, "0");
    out = `${mantissa}e${esign}${eabs}`;
  }
  return neg ? "-" + out : out;
}

function formatVolume(value: number): string {
  const absVal = Math.abs(value);
  if (absVal >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (absVal >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (absVal >= 1e3) return (value / 1e3).toFixed(2) + "K";
  return String(Math.trunc(value));
}

// isInt(C201, 셋째 인자 — pine2js 고유, pine2py 대응 없음)는 codegen이 analyzer의 isStaticIntExpr
// 판별(정수 리터럴/for 루프 카운터, analyzer.ts 주석 참조)로 정적 확정했을 때만 true로 실어
// format_str 없는 기본 분기를 pyFloatStr(항상 소수점) 대신 정수 포맷으로 낸다 — pine2py `str(value)`가
// Python 실제 타입(int/float)을 그대로 보존하는 것의 근사 재현(LIMITATIONS.md 잔여 스코프: UDF int
// 매개변수/int() 캐스팅/'=' 로컬 전파는 여전히 isInt=false로 떨어짐).
export function tostring(
  value: number | boolean | string | null | undefined,
  format_str: string | null = "",
  isInt: boolean = false,
): string {
  // C808: 참조형 na(null)와 문자열 인자 — 시그니처가 number|boolean만 상정해 둘 다 아래 숫자
  // 경로로 흘러들어 조용한 오답을 냈다(pyFloatStr의 `Number.isFinite` 가드가 비-number를 전부
  // 무한대로 오분류 → `str.tostring("Fast")`="-inf" / `str.tostring("12")`="inf" /
  // `str.tostring(<string na>)`="-inf", 포맷 인자가 붙으면 `value.toFixed is not a function` 크래시).
  // pine2py str_funcs.tostring(python 직접 실행으로 실측) 대조:
  //   None → 포맷 유무와 무관하게 "NaN"(`value is None` 검사가 포맷 분기보다 먼저) — 그대로 이식.
  //   문자열 + 포맷 없음 → `str(value)` = 원문 그대로 — 그대로 이식.
  //   문자열 + 포맷 있음 → int("Fast") ValueError / f"{'x':.2f}" ValueError로 **크래시** —
  //     GOAL.md na 안전성 원칙(크래시 흡수)에 따라 원문 반환으로 통일한다. TV str.tostring의
  //     string 오버로드에는 애초에 format 매개변수가 없어 "포맷은 숫자에만 적용"이 자연스럽지만
  //     TV 미검증(가설) — DIVERGENCES 등재.
  // undefined("미초기화", GOAL na 3분할)도 null과 같이 "NaN"으로 흡수한다.
  if (value == null) return "NaN";
  if (typeof value === "string") return value;
  // bool 인자(C207, bare string(x) 캐스트가 이 함수를 재사용하며 처음 노출된 기존 gap — 기존
  // str.tostring(bool) 호출부는 오라클/테스트가 전무해 미검증 상태였다) — pine2py 실측 확인
  // (scratch 프로브): format_str 없으면 Python str(bool) 그대로 "True"/"False"(대문자), format_str이
  // 있으면 bool이 Python int 서브클래스라 그 형식의 숫자 분기로 흘러 1/0으로 계산된다
  // (`str.tostring(false,"integer")`="0", `str.tostring(true,"percent")`="1.00%"). 그 외 로직은
  // value가 항상 진짜 number이므로(기존 호출부 전부 무변화) 아래로 그대로 흘러가면 된다.
  if (typeof value === "boolean") {
    if (!format_str) return value ? "True" : "False";
    value = value ? 1 : 0;
  }
  if (Number.isNaN(value)) return "NaN";
  if (!format_str) return isInt ? String(Math.trunc(value)) : pyFloatStr(value);
  if (format_str === "integer") return String(Math.trunc(value));
  if (format_str === "percent") return value.toFixed(2) + "%";
  if (format_str === "volume") return formatVolume(value);
  if (format_str === "mintick") return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  // C730: 숫자 패턴 + 문자 접미사("###M"/"##W"/"#D" 등) — wild auto-HTF 관용구가
  // `str.tostring(timeframe.multiplier * mult, '###M')`로 tf 문자열("8M"/"8W"/"8D")을 만드는 데
  // 쓴다. pine2py `_apply` 분기(#/0+. 판별)는 접미사를 버리고 "8"만 내지만, 그 값이면 이 관용구가
  // TV에서 tf 문자열로 전혀 기능하지 않으므로(관용구의 목적 자체가 접미사 포함 tf 생성 — 다수 독립
  // 저자가 동일 형태 반복, C560급 정황) TV DecimalFormat 계열 "패턴 밖 문자는 리터럴 보존"을
  // 채택한다. TV 미검증(가설) — DIVERGENCES #220. toFixed(0)은 형제 분기(아래 decimals=0)와 동일한
  // 반올림 규칙 유지. 접두사('M###')는 wild 실사용 0건이라 범위 밖(C283 큐레이션 원칙).
  const suffixMatch = /^(#+)([A-Za-z]+)$/.exec(format_str);
  if (suffixMatch) return value.toFixed(0) + suffixMatch[2]!;
  // 패턴 포맷("#.##"/"0.000" 등) — pine2py는 "#"/"0"+"." 존재 여부로만 판별, 자릿수는 "." 뒤
  // 길이. 그 외 인식 불가 패턴은 기본 분기(pyFloatStr)로 폴백(pine2py `return str(value)`와 동치).
  if (format_str.includes("#") || (format_str.includes("0") && format_str.includes("."))) {
    let decimals = 0;
    if (format_str.includes(".")) {
      decimals = format_str.split(".").pop()!.length;
    }
    return value.toFixed(decimals);
  }
  return pyFloatStr(value);
}

// str.split — pine2py str_funcs.split(source, separator): `source.split(separator)`. 반환이
// array<string>(참조형)이라 na는 null. 크래시 경계는 python 직접 실행으로 확인: source===None은
// AttributeError, separator===""(빈 문자열)는 Python str.split()이 명시적으로 거부하는
// ValueError("empty separator") — 둘 다 GOAL.md na 안전성 원칙에 따라 na(null)로 흡수.
// separator===na(None)는 pine2py 자체에서 크래시하지 않고 Python str.split(None)의 "구분자 생략 시
// 공백 기준 분할" 특수 시맨틱을 그대로 트리거하지만(python 직접 실행으로 확인:
// split("  a  b  ", None) == ["a","b"]), 이는 Python 표준 라이브러리가 None을 "인자 생략" 센티널로
// 이중 사용하는 API 관례의 부작용일 뿐 TV가 의도한 na 시맨틱이라는 근거가 전혀 없다(TV str.split의
// separator는 "simple string" 필수 인자 — na를 의미 있게 받는다는 문서/코드 근거 없음) — GOAL.md
// "pine2py의 알려진 버그는 따르지 않는다"를 적용해 나머지 두 크래시 지점과 동일하게 na(null)로
// 통일(DIVERGENCES.md 신규, TV 미검증 가설). JS String.split()은 두 경계 모두 Python과 다르게
// 크래시 없이 값을 반환해버리므로(""는 문자 단위 분할, null은 리터럴 "null" 문자열 탐색으로
// coercion) 명시적 가드 없이는 위 정책이 성립하지 않는다 — node 직접 실행으로 재확인.
export function split(source: string | null, separator: string | null): string[] | null {
  if (typeof source !== "string" || typeof separator !== "string" || separator === "") return null;
  return source.split(separator);
}

// str.replace — pine2py str_funcs.replace(source,target,replacement,occurrence=0)(L93-114):
// occurrence===0이면 첫 발생만 치환(`source.replace(target,replacement,1)`), occurrence!==0이면
// count가 몇 번째 발생인지 세는 수동 스캔 루프(찾은 발생 전까지는 원본 그대로 복사, count===
// occurrence인 발생만 교체, 못 찾으면 나머지 그대로 — target 미발견/occurrence 범위초과/음수/
// 정수아님/na(NaN)는 전부 "교체 없이 원본 그대로" 동일 결과로 수렴함을 python 직접 실행으로
// 확인, replace_all(C77)의 String.replaceAll 한 줄 위임과 달리 상태 추적 루프가 필요).
// source/target/replacement가 na(null)면 pine2py가 가드 없이 크래시(AttributeError/TypeError)해
// str.*(C76/77)와 동일하게 na(null) 전파로 결정. occurrence=na(NaN)는 `count(int)===occurrence`
// 비교가 JS/Python 양쪽에서 자연히 항상 false라(NaN 특수 가드 불필요) "발생 없음"과 동일하게
// 원본 그대로 반환 — well-defined literal port(C101 원칙, None-이중오버로드 함정과 무관, occurrence는
// 참조형이 아니라 numeric이라 C107 예외 클래스에 해당 안 됨).
// **크래시 아닌 진짜 무한루프 함정(target==="" + occurrence가 양의 정수로 절대 도달 못하는 값)**:
// pine2py 루프는 target===""이면 idx=source.find("",i)===i가 항상 성립해 i=idx+len(target)=i로
// 절대 전진하지 않는다 — count만 매 반복 +1되므로 occurrence가 도달 가능한 양의 정수(1,2,3,...)면
// 결국 count===occurrence에서 멈추지만(그 결과는 i가 항상 0이라 occurrence 값과 무관하게 항상
// `replacement+source`로 수렴 — python 직접 실행으로 재확인), occurrence가 음수/비정수/NaN이면
// count가 그 값에 절대 도달하지 못해 pine2py 자체가 무한 루프에 빠진다(python -c로 실제 hang 확인,
// timeout으로 강제 종료). GOAL.md "알려진 버그는 따르지 않는다"를 적용해 이 경계를 루프 진입 전
// 분석적으로 해소(target==="" 전용 분기) — 양의 정수 occurrence는 위에서 유도한 `replacement+
// source`를 루프 없이 바로 반환하고, 도달 불가능한 occurrence는 "발생 없음"과 동일하게 원본 그대로
// 반환(pine2py처럼 실제 무한 대기하지 않음, DIVERGENCES.md 신규 등재). node/python 1,343건 fuzz
// (target 비어있지 않은 케이스, scratch/gen_replace_cases.mjs+compare_replace_fuzz.mjs) 전부 일치.
export function replace(
  source: string | null,
  target: string | null,
  replacement: string | null,
  occurrence: number = 0,
): string | null {
  if (typeof source !== "string" || typeof target !== "string" || typeof replacement !== "string") return null;
  if (occurrence === 0) return source.replace(target, replacement);
  if (target === "") {
    if (Number.isInteger(occurrence) && occurrence >= 1) return replacement + source;
    return source;
  }
  let count = 0;
  let result = "";
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf(target, i);
    if (idx === -1) {
      result += source.slice(i);
      break;
    }
    count++;
    if (count === occurrence) {
      result += source.slice(i, idx) + replacement + source.slice(idx + target.length);
      break;
    }
    result += source.slice(i, idx + target.length);
    i = idx + target.length;
  }
  return result;
}

// str.match — C574 정정: DIVERGENCES.md #44가 C109부터 "가설"로 남겨뒀던 반환형 의문이 wild
// corpus 실증으로 확정됐다. corpus/wild/scripts_v56에 독립 저자 3+건이 `str.tonumber(str.match(
// timeframe.period, '[0-9]*'))` 관용구를 쓰는데, TV 컴파일러가 실제로 이 스크립트를 통과시켰다는
// 사실 자체가 str.match의 반환형이 string이어야 함을 증명한다(bool을 str.tonumber에 넘기면 TV
// 컴파일 타임에 타입 에러). pine2py str_funcs.match(`bool(re.search(...))`)는 이름과 반대로
// "매치 여부"만 bool로 뭉개는 자체 버그(MEMORY.md C2류) — TV 공식 시그니처는 첫 매치 부분문자열
// (없으면 "")을 반환한다. GOAL.md 원칙대로 TV 규칙으로 정정, pine2py 오라클(bool golden)은 이제
// 이 시맨틱을 검증할 수 없어 hand-verified로 전환(오라클 case/golden 파일 자체는 불변 유지).
// source/pattern na(null)는 string 반환 함수라 GOAL.md 3분할 규약대로 na=null(NaN이 아님) —
// contains류(bool 반환)와 다른 계층. 패턴 컴파일 실패(JS SyntaxError)는 "매치 없음"과 동일하게
// "" 반환(pine2py의 `except re.error` catch 취지 유지, 값만 string으로 교체).
// 정규식 방언 격차: Python re와 JS RegExp는 기본 구문(문자 클래스/수량자/앵커/OR/이스케이프)이
// 15개 케이스 교차 실측(scratch/probe_match.mjs, scratch/c574_match_probe.mjs)으로 전부 일치했으나,
// named group 문법(Python (?P<name>...) vs JS (?<name>...)) 등 Python 전용 확장 구문은 다르다 —
// GOAL.md 런타임 의존성 0 원칙상 커스텀 정규식 엔진 없이 JS 네이티브 RegExp만 사용(LIMITATIONS.md 등재).
export function match(source: string | null, pattern: string | null): string | null {
  if (typeof source !== "string" || typeof pattern !== "string") return null;
  try {
    const m = new RegExp(pattern).exec(source);
    return m ? m[0] : "";
  } catch {
    return "";
  }
}

// str.tonumber — pine2py `try: float(value) except: nan`. Python float()는 전체 문자열이
// 유효해야 하고(JS parseFloat의 "접두사만 파싱"과 달라 Number()를 씀), "inf"/"infinity"(대소문자
// 무관, 부호 허용)를 인정하지만 JS Number()는 "Infinity"(대문자 I, 전체 단어)만 인정 — 정규식으로
// 보정. Python float()는 "0x.."/"0b.."/"0o.." 16진/2진/8진 프리픽스를 거부하지만 JS Number()는
// 파싱해버려(예: Number("0x1A")===26) 별도 가드 필요. 언더스코어 자릿수 구분자(Python 3.6+
// `float("1_000.5")`)는 JS Number()가 지원하지 않아 미이식(LIMITATIONS.md 등재 — tonumber는 보통
// 외부 문자열 파싱 용도라 소스코드 스타일 언더스코어 리터럴은 실사용 빈도가 낮다고 판단).
// python/node 59개 경계 케이스(공백/부호/inf 대소문자/진법 프리픽스/쓰레기 접미사 등) 교차 실측 —
// 언더스코어 1건 제외 전부 일치(scratch/probe_tonumber 계열).
// C575: value가 null(정상 na)뿐 아니라 array.get() 범위밖 sentinel(NaN, 타입 무관 — C572/
// codegen.ts 주석 참조)로도 흘러들 수 있다(wild `str.tonumber(array.get(stringArr, oobIdx))`
// 관용구) — `typeof value !== "string"`으로 null/NaN/undefined 전부 한 번에 걸러 na 전파.
export function tonumber(value: string | null): number {
  if (typeof value !== "string") return NaN;
  const trimmed = value.trim();
  if (trimmed === "") return NaN;
  if (/^[+-]?(inf|infinity)$/i.test(trimmed)) return trimmed[0] === "-" ? -Infinity : Infinity;
  if (/^[+-]?0[xXoObB]/.test(trimmed)) return NaN;
  return Number(trimmed);
}

type FormatArg = number | string | boolean | null;

// Python round() = half-to-even(banker's rounding, `round(2.5)===2`) — JS Math.round은 항상
// half-up이라 별도 구현 필요. node/python 2,013건 fuzz(정수 tie 포함) 전부 일치
// (scratch/probe_format.mjs) 확인.
function pyRoundHalfEven(x: number): number {
  const flr = Math.floor(x);
  const diff = x - flr;
  if (diff < 0.5) return flr;
  if (diff > 0.5) return flr + 1;
  return flr % 2 === 0 ? flr : flr + 1;
}

// Python float(str) 파싱 성공/실패를 명시적으로 구분(tonumber처럼 실패를 NaN 하나로 뭉개면 "파싱된
// nan"과 "파싱 실패"를 구별 못해 _apply_number_format의 "실패 시 원본 문자열 반환" 분기가 불가능).
// tonumber(C87)와 동일한 파싱 규칙(공백 trim/inf·nan 텍스트/16진수 프리픽스 거부) — PEP515
// 언더스코어 구분자 미지원도 tonumber(#27)와 동일한 의도적 결정 재적용.
function parseFloatLoose(s: string): { ok: boolean; value: number } {
  const t = s.trim();
  if (t === "") return { ok: false, value: NaN };
  if (/^[+-]?nan$/i.test(t)) return { ok: true, value: NaN };
  if (/^[+-]?(inf|infinity)$/i.test(t)) return { ok: true, value: t[0] === "-" ? -Infinity : Infinity };
  if (/^[+-]?0[xXoObB]/.test(t)) return { ok: false, value: NaN };
  const n = Number(t);
  if (Number.isNaN(n)) return { ok: false, value: NaN };
  return { ok: true, value: n };
}

// f"{num:.{decimals}f}" vs JS toFixed — 일반 값 10,000건 fuzz 전부 일치하나 값이 정확히 literal
// -0일 때만 Python은 부호를 보존("-0.00")하고 JS toFixed는 버린다("0.00", C45 Pitfalls와 동일
// 클래스의 negative-zero 함정) — 명시적으로 보정.
function toFixedPy(num: number, decimals: number): string {
  const s = num.toFixed(decimals);
  if (Object.is(num, -0) && !s.startsWith("-")) return "-" + s;
  return s;
}

function formatSimple(val: number | string | boolean): string {
  if (typeof val === "number") {
    if (Number.isNaN(val)) return "nan";
    return pyFloatStr(val);
  }
  if (typeof val === "boolean") return val ? "True" : "False";
  return val;
}

function applyNumberFormat(val: number | string | boolean, pattern: string): string {
  let num: number;
  if (typeof val === "number") num = val;
  else if (typeof val === "boolean") num = val ? 1 : 0;
  else {
    const parsed = parseFloatLoose(val);
    if (!parsed.ok) return val;
    num = parsed.value;
  }
  if (Number.isNaN(num)) return "NaN";
  if (!Number.isFinite(num)) return num > 0 ? "inf" : "-inf";
  const dotIdx = pattern.indexOf(".");
  if (dotIdx === -1) return String(pyRoundHalfEven(num));
  const decimals = pattern.length - dotIdx - 1;
  return toFixedPy(num, decimals);
}

// str.format — pine2py str_funcs.format(template, *args): `{idx}` 단순 치환 + `{idx,number,pattern}`
// 숫자 포맷 치환. 정규식 `\{(\d+)(?:,number,([^}]+))?\}` — python re와 JS RegExp 교차 실측
// (scratch/probe_format.py+.mjs, 31개 수동 케이스 전부 + 데시멀 포맷 2,000건 + round-half-even
// 2,013건 전부 일치) 확인 후 착수(match(C109)와 동일 사전 검증 관행). idx>=args.length는 매치
// 텍스트 그대로 보존(pine2py `return m.group(0)`).
// **발견 1(int/float 문자열 표현 우연성, array.join #28a와 동일 클래스)**: 단순 {idx} 치환은
// Python `str(val)`에 위임 — val이 소스에 정수 리터럴로 쓰였으면(우연) 소수점 없이, 소수점
// 리터럴이면(우연) pyFloatStr 스타일(".0" 포함)로 나온다. JS Number는 이 구분이 없어 항상
// pyFloatStr로 통일(#28a 원칙 재적용, 정수 리터럴 인자는 오라클 채널 제외).
// **발견 2(NaN 대소문자 비대칭, array.join #28c와 동일 클래스)**: 단순 {idx} 치환은 isnan 가드가
// 없어 `str(nan)`="nan"(소문자)이 그대로 나오지만, {idx,number,...} 포맷 치환은
// _apply_number_format 안에 명시적 `math.isnan(num): return "NaN"`(대문자) 가드가 있다 — 같은
// NaN 값이 치환 형태에 따라 대소문자가 갈리는 pine2py 자체의 비일관성을 literal port.
// **발견 3(정수 패턴의 round 방식, TV 미검증)**: 패턴에 "."이 없으면(`{0,number,#}`)
// `str(int(round(num)))` — Python round()는 half-to-even(bankers rounding)이라 GOAL.md의
// "math.round는 half-away-from-zero"(TV 실제 규칙, 서로 다른 함수)와 다르다. 이 내부 포맷
// 헬퍼의 round가 TV str.format 실제 표시 규칙과 같은지 검증 근거가 없어(WebSearch 권한 부재)
// literal port + TV 미검증 가설로 등재(DIVERGENCES.md 신규) — half-away-from-zero로 보정하지 않음.
// **발견 4(무한대 크래시 흡수)**: "." 없는 패턴에서 값이 ±Infinity면 pine2py `int(round(inf))`가
// OverflowError로 크래시한다(python 직접 실행 확인) — GOAL.md "알려진 버그는 따르지 않는다" 적용,
// "." 있는 분기가 이미 자연스럽게 내는 "inf"/"-inf" 텍스트로 통일해 크래시 회피(DIVERGENCES.md 신규).
// **발견 5(문자열 인자의 느슨한 float 파싱)**: {idx,number,...} 포맷에 string 인자가 오면 Python
// `float(value)`로 파싱 시도 — 성공하면 숫자로 포맷, 실패(ValueError)하면 원본 문자열 그대로
// 반환(`except: return str(value)`) — parseFloatLoose로 이식.
// na 규칙(pine2js 고유 결정, pine2py 오라클로 검증 불가 — pine2py 자신이 `var string x = na`조차
// 항상 float('nan')으로 컴파일해 이 경로에 실제 None 인자가 구조적으로 도달 못함, C107류 "Python
// None 이중 오버로드"와는 다른 이유의 "literal port 불가" 사례): template이 na(null)면 na(null)
// 전파. 개별 치환 인자가 na(null, string na)면 GOAL.md na 안전성 원칙에 따라 전체 결과를 na(null)로
// 통일(hand-verified, LIMITATIONS.md 신규 등재).
export function format(template: string | null, ...args: FormatArg[]): string | null {
  if (typeof template !== "string") return null;
  let naArg = false;
  const result = template.replace(
    /\{(\d+)(?:,number,([^}]+))?\}/g,
    (whole: string, idxStr: string, fmtSpec: string | undefined) => {
      const idx = parseInt(idxStr, 10);
      if (idx >= args.length) return whole;
      const val = args[idx]!;
      if (val === null) {
        naArg = true;
        return whole;
      }
      if (fmtSpec === undefined) return formatSimple(val);
      return applyNumberFormat(val, fmtSpec);
    },
  );
  return naArg ? null : result;
}

// str.format_number(value, format_str="") — pine2py str_funcs.format_number(L218-225): value가
// None/NaN이면 "NaN"(format_str이 무엇이든 이 체크가 무조건 먼저 return해 format_str은 아예
// 평가되지 않는다 — python 직접 실행으로 `format_number(nan, nan)`==="NaN" 확인, na value가 na
// format_str의 크래시를 자동으로 가린다), 그 다음에야 format_str이 truthy면
// _apply_number_format(value, format_str) — str.format(C110)의 {idx,number,pattern} 분기와
// **완전히 동일한 함수**를 그대로 호출하므로 위에서 이미 검증된 applyNumberFormat/pyRoundHalfEven/
// toFixedPy(round-half-even 정수 패턴 TV 미검증 가설, ±Infinity crash 회피 "inf"/"-inf" 통일 포함
// C110 발견 3/4 전부 승계)을 재사용 — format_str 없으면 pine2py `str(value)`와 동치인 pyFloatStr.
// value는 시그니처가 항상 number(FormatArg의 string/bool 분기 불필요 — format()의 val 파싱과
// 다른 지점, applyNumberFormat이 문자열 인자도 받아들이지만 여기선 항상 number를 넘긴다).
// **format_str=na(null) 크래시 확인(value가 NaN이 아닐 때만 도달)**: value와 달리 format_str은
// string 매개변수라 pine2py에 `float('nan')`이 그대로 전달된다(str.format(C110)의 "구조적으로
// None을 못 만든다"는 예외가 아니라 — format_str은 함수 시그니처 자체가 string이고 na 리터럴이
// 타입 무관하게 항상 float('nan')으로 컴파일되는데, 그 float가 실제로 함수 인자 자리에 *도달*해
// `pattern.find(".")` 호출에서 AttributeError로 크래시함을 python 직접 실행으로 확인, C107/C110과
// 다른 세 번째 "na 인자가 실제로 만들어지긴 하지만 크래시하는" 경우) — contains/startswith(#16)와
// 동일한 "가드 없는 크래시 → na 전파" 패턴 적용, null(string na) 통일. 이 채널은 pine2py 자체가
// 크래시해 오라클 생성이 불가능 — runtime.test.ts hand-verified 대체(LIMITATIONS.md).
export function format_number(value: number, format_str: string | null = ""): string | null {
  if (Number.isNaN(value)) return "NaN";
  if (typeof format_str !== "string") return null;
  if (!format_str) return pyFloatStr(value);
  return applyNumberFormat(value, format_str);
}

const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

// str.format_time(time_ms, format_str="yyyy-MM-dd'T'HH:mm:ssZ", timezone="") — pine2py
// str_funcs.py L194-215: time_ms/1000를 datetime.fromtimestamp(tz=UTC)로 변환 후 Pine 포맷 토큰을
// 순차 .replace() 체인(yyyy->yy->MMMM->MMM->MM->dd->HH->hh->mm->ss->'T'->Z 순, 긴 토큰부터)으로
// strftime 코드로 바꿔 datetime.strftime() 호출. GOAL.md 런타임 의존성 0 원칙상 JS엔 표준
// strftime이 없어(Intl.DateTimeFormat은 옵션 체계가 근본적으로 달라 직접 매핑 불가) 중간 strftime
// 코드를 거치지 않고 pine2py와 동일한 순서로 Date getUTC* 값을 직접 문자열 치환한다(각 단계의
// 치환값이 뒤따르는 토큰 문자열을 우연히 포함하지 않아 순서 안전성이 동일하게 성립함을 node로
// 재확인). timezone 인자는 python 직접 실행으로 함수 본문에서 전혀 참조되지 않음을 재확인(항상
// UTC 고정) — 시그니처만 받고 no-op으로 그대로 이식.
// MMMM/MMM(영문 월 이름)은 이 환경의 Python이 시스템 로케일(Korean_Korea) 설정과 무관하게 항상
// 영어 이름을 반환함을 python 직접 실행으로 확인(strftime %B/%b가 로케일 미설정 시 C 기본
// 로케일에 고정) — 로케일 의존 없이 12개 영문 배열 하드코딩으로 안전하게 이식.
// **na 처리**: time_ms가 NaN/±Infinity/JS Date 표현 범위(약 ±273,790년) 밖이면 Date가 자연히
// Invalid Date(getTime()===NaN)가 돼 pine2py의 "NaN" 문자열 반환과 동일하게 수렴(별도 가드 없이
// 하나의 판정으로 세 경계 전부 흡수). format_str이 na(null)면 str.format/format_number(C110/C111)와
// 동일한 "string 매개변수 na가 pine2py를 실제로 크래시시키는" 패턴(python 직접 실행으로
// AttributeError 확인, time_ms 유효성 체크가 먼저라 time_ms=NaN이면 이 크래시가 가려짐 — C111과
// 동일한 순서 함정) — na(null) 전파로 결정.
// **신규 발견(divergence)**: pine2py가 OverflowError(±Infinity, except절에 없어 미포착)로 실제
// 크래시하는 지점과 별개로, 이 Windows/Python 3.11 환경은 1970-01-01 이전 타임스탬프에서도
// datetime.fromtimestamp가 OSError로 크래시한다(python 직접 실행으로 -7200초는 성공, -86399초부터
// 실패하는 좁은 창을 확인 — Windows CRT gmtime의 time_t 범위 산출물로 추정, Python 언어나 TV
// 시맨틱과 무관한 플랫폼 아티팩트). JS Date는 이 범위에서 크래시 없이 정상 계산되므로 GOAL.md
// "알려진 버그는 따르지 않는다"를 적용해 이 플랫폼 특유의 크래시를 이식하지 않고 JS Date 계산
// 결과를 그대로 사용(음수 타임스탬프 채널은 pine2py 오라클과 일치하지 않음 — DIVERGENCES.md 신규,
// hand-verified로 대체).
export function format_time(
  time_ms: number,
  format_str: string | null = "yyyy-MM-dd'T'HH:mm:ssZ",
  timezone: string | null = "",
): string | null {
  void timezone;
  const dt = new Date(time_ms);
  if (Number.isNaN(dt.getTime())) return "NaN";
  if (typeof format_str !== "string") return null;
  const year = dt.getUTCFullYear();
  const month = dt.getUTCMonth();
  const day = dt.getUTCDate();
  const hours24 = dt.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = dt.getUTCMinutes();
  const seconds = dt.getUTCSeconds();
  return format_str
    .replaceAll("yyyy", pad2(year, 4))
    .replaceAll("yy", pad2(((year % 100) + 100) % 100, 2))
    .replaceAll("MMMM", MONTH_FULL[month]!)
    .replaceAll("MMM", MONTH_ABBR[month]!)
    .replaceAll("MM", pad2(month + 1, 2))
    .replaceAll("dd", pad2(day, 2))
    .replaceAll("HH", pad2(hours24, 2))
    .replaceAll("hh", pad2(hours12, 2))
    .replaceAll("mm", pad2(minutes, 2))
    .replaceAll("ss", pad2(seconds, 2))
    .replaceAll("'T'", "T")
    .replaceAll("Z", "+0000");
}
