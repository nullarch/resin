// str.* 네임스페이스. 전부 순수(stateless) 함수 — math.*와 동일하게 builtinCalls 패턴으로 디스패치
// (조건부 블록 제약 없음). GOAL.md na 3분할 규약: string na = null.
//
// C575: 아래 모든 `string | null` 매개변수 가드는 `x === null`이 아니라 `typeof x !== "string"`로
// 통일한다 — array.get() 범위밖 sentinel(NaN, 타입 무관, C572)이 string 배열에서 흘러나오면
// null이 아니라 NaN이라 `=== null` 가드를 그냥 통과해버려 `.trim()`류 메서드 호출에서
// "X.trim is not a function"으로 크래시했다(wild `str.tonumber(array.get(stringArr, oobIdx))`
// 관용구 실측). typeof 가드는 null/NaN/undefined를 전부 동일하게 na로 흡수해 기존 null 경로의
// 동작은 그대로 유지한다.

import { runtimeError } from "./log";

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

// Python's str(float) ("1.0", "nan" is left to the callers). Not a Pine formatter: str.tostring and
// str.format use TradingView's (see "Pine's number formatters" below). It remains for the pine2py
// ports that still print Python's text: array.join's number elements, str.format's array elements
// (the oracle prints list numbers with str(), pynecore lib/string.py _format_value) and
// str.format_number.
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

// ── Pine's number formatters ─────────────────────────────────────────────────────────────────
//
// TradingView turns a number into text with two engines, and the oracle reproduces both (pynecore
// lib/string.py, measured on TradingView per its docstrings): str.tostring uses the chart's number
// formatter, str.format Java's MessageFormat/DecimalFormat. Both read a DecimalFormat mask — '#' an
// optional digit, '0' a required one, '.', a ';' negative subpattern, literal affixes, quotes — and
// differ in how they round: str.tostring rounds the SHORTEST round-trip digits of the double half-up
// (Java's Double.toString; `str.tostring(2.675, '#.##')` is "2.68"), str.format the double's EXACT
// binary value half-even (2.675 is 2.67499..., "2.67"). Either keeps at most 16 fraction digits
// once |x| >= 1e-3. Neither prints Python's "1.0" or "True": "The formatting of float values will
// also round those values when necessary ... To display trailing zeros, use '0' instead of '#'",
// "Bool type arguments return "true" or "false"", "When x is na, the function returns "NaN"",
// "The default value is '#.##########'" (ref_v6_lang.txt str.tostring).

// A finite non-negative double's shortest round-trip digits (Python repr, Java Double.toString) in
// plain decimal notation: "123.456", "0.00012", "10000000000000000".
function shortestDecimal(x: number): string {
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential())!;
  const digits = m[1]! + (m[2] ?? "");
  const exponent = parseInt(m[3]!, 10);
  if (exponent < 0) return "0." + "0".repeat(-exponent - 1) + digits;
  if (digits.length <= exponent + 1) return digits + "0".repeat(exponent + 1 - digits.length);
  return digits.slice(0, exponent + 1) + "." + digits.slice(exponent + 1);
}

// A finite non-negative double's exact binary value in plain decimal notation (x = m * 2^e).
function exactDecimal(x: number): string {
  if (x === 0) return "0";
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const biased = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(view.getUint32(4));
  let exponent = -1074;
  if (biased !== 0) {
    mantissa |= 1n << 52n;
    exponent = biased - 1075;
  }
  if (exponent >= 0) return (mantissa << BigInt(exponent)).toString();
  const fracDigits = -exponent;
  const digits = (mantissa * 5n ** BigInt(fracDigits)).toString().padStart(fracDigits + 1, "0");
  return digits.slice(0, digits.length - fracDigits) + "." + digits.slice(digits.length - fracDigits);
}

// Rounds a plain non-negative decimal to exactly `decimals` fraction digits (Decimal.quantize),
// half-up or half-even.
function roundDecimal(plain: string, decimals: number, halfEven: boolean): string {
  const dot = plain.indexOf(".");
  const intPart = dot < 0 ? plain : plain.slice(0, dot);
  const frac = dot < 0 ? "" : plain.slice(dot + 1);
  let keep = intPart + frac.slice(0, decimals).padEnd(decimals, "0");
  const next = decimals < frac.length ? frac.charCodeAt(decimals) - 48 : 0;
  let up = next > 5;
  if (next === 5) {
    if (!halfEven || /[1-9]/.test(frac.slice(decimals + 1))) up = true;
    else up = (keep.charCodeAt(keep.length - 1) - 48) % 2 === 1;
  }
  if (up) keep = (BigInt(keep) + 1n).toString().padStart(keep.length, "0");
  if (decimals === 0) return keep;
  return keep.slice(0, keep.length - decimals) + "." + keep.slice(keep.length - decimals);
}

// The oracle's _round_digits: a non-negative value (or -0, whose sign survives as in Decimal)
// rounded to `decimals` places by either engine.
function roundDigits(value: number, decimals: number, decimalFormat: boolean): string {
  if (value >= 1e-3) decimals = Math.min(decimals, 16);
  const r = roundDecimal(decimalFormat ? exactDecimal(value) : shortestDecimal(value), decimals, decimalFormat);
  return Object.is(value, -0) ? "-" + r : r;
}

// Python's f"{x:.{decimals}f}": the exact value rounded half-even, the sign kept on a negative
// value that rounds to zero.
function fixedExact(x: number, decimals: number): string {
  const r = roundDecimal(exactDecimal(Math.abs(x)), decimals, true);
  return x < 0 || Object.is(x, -0) ? "-" + r : r;
}

// A DecimalFormat subpattern cut into literal prefix, digit pattern and literal suffix. Only an
// unquoted '#', '0', '.' or ',' belongs to the digits; '' is a literal quote, and a quoted run is
// literal ("'#'.##" prints "#1.23"). The oracle's _split_number_pattern.
function splitNumberPattern(pattern: string): [string, string, string] {
  const chars: string[] = [];
  const isDigit: boolean[] = [];
  let inQuote = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "'") {
      if (pattern[i + 1] === "'") {
        chars.push("'");
        isDigit.push(false);
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    chars.push(ch);
    isDigit.push(!inQuote && "#0.,".includes(ch));
  }
  const lo = isDigit.indexOf(true);
  if (lo < 0) return [chars.join(""), "", ""];
  const hi = isDigit.lastIndexOf(true);
  return [chars.slice(0, lo).join(""), chars.slice(lo, hi + 1).join(""), chars.slice(hi + 1).join("")];
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function stripTrailing(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}

// A finite double through a digit mask (the oracle's _format_number_general mask path): the
// subpattern the sign picks (without a negative one, '-' goes in front of the positive one's
// prefix), optional places lose their trailing zeros, required places are kept (optional places
// after them dropped), required integer digits are zero filled, and a mask with required decimals
// but no required integer digit drops a zero integer part ('#.0' formats 0.5 as ".5").
function formatMask(value: number, pattern: string, decimalFormat: boolean): string {
  let prefix = "";
  const subpatterns = pattern.split(";");
  let chosen = subpatterns[0]!;
  if (value < 0) {
    value = -value;
    if (subpatterns.length > 1) chosen = subpatterns[1]!;
    else prefix = "-";
  }
  const [affix, digits, suffix] = splitNumberPattern(chosen);
  prefix += affix;
  const sides = digits.split(".");
  if (sides.length > 2) runtimeError(`Multiple decimal separators in pattern "${pattern}"`);
  const before = sides[0]!;
  const after = sides[1] ?? "";
  const requiredBefore = countChar(before, "0");
  const requiredDecimals = countChar(after, "0");
  const maxDecimals = after.length;

  let result: string;
  if (maxDecimals === 0) {
    result = roundDigits(value, 0, decimalFormat);
  } else {
    let formatted = roundDigits(value, maxDecimals, decimalFormat);
    if (requiredDecimals === 0) {
      formatted = stripTrailing(stripTrailing(formatted, "0"), ".");
    } else {
      const [intText, decimalPart] = formatted.split(".") as [string, string];
      if (decimalPart.length > requiredDecimals) {
        const kept = stripTrailing(decimalPart.slice(0, requiredDecimals), "0");
        formatted = kept ? `${intText}.${kept}` : intText;
      }
    }
    if (formatted.includes(".") && requiredDecimals > 0) {
      const [intText, decimalPart] = formatted.split(".") as [string, string];
      result = `${intText}.${decimalPart.padEnd(requiredDecimals, "0")}`;
    } else {
      result = formatted;
    }
  }
  if (requiredBefore > 0) {
    const [intText, decimalPart] = result.split(".") as [string, string | undefined];
    const padded = intText.padStart(requiredBefore, "0");
    result = decimalPart === undefined ? padded : `${padded}.${decimalPart}`;
  } else if (requiredDecimals > 0 && result.startsWith("0.")) {
    result = result.slice(1);
  }
  return prefix + result + suffix;
}

const TOSTRING_DEFAULT_FORMAT = "#.##########";
const DECIMAL_FORMAT_DEFAULT = "#.###";

// str.tostring(value, format): the chart number formatter above on the mask (default
// '#.##########', so 1.0 is "1" and 1.23456789012 is "1.2345678901"), "true"/"false" for a bool
// whatever the format, "NaN" for na and, the oracle adds, for an infinity (pynecore lib/string.py
// tostring/_format_number: the chart formatter has no infinity). tier 1: str_001_functions
// (`str.tostring(123, '#.00')` "123.00", `str.tostring(-123, '00000.00')` "-00123.00") and the
// strategy scenario slippage_pyramiding (`"Long " + str.tostring(entryNum)` with the v6 float
// entryNum 1.0 is the order id "Long 1"). An explicit "" is a mask without fraction places (the
// oracle rounds to an integer); an omitted or na format is the default.
// Not covered here: the format.percent / format.volume / format.mintick / format.inherit constants
// keep their earlier renderings (the mintick grid and the script precision do not reach this
// runtime), and array arguments. `isInt` (the analyzer's static int proof, C201) no longer changes
// anything: the default mask prints an integral value without a fraction either way.
export function tostring(
  value: number | boolean | string | null | undefined,
  format_str: string | null = TOSTRING_DEFAULT_FORMAT,
  isInt: boolean = false,
): string {
  void isInt;
  if (value == null) return "NaN";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Number.isNaN(value)) return "NaN";
  if (format_str === "integer") return String(Math.trunc(value));
  if (format_str === "percent") return value.toFixed(2) + "%";
  if (format_str === "volume") return formatVolume(value);
  if (format_str === "mintick") return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  if (!Number.isFinite(value)) return "NaN";
  // format.price and format.inherit are not str.tostring formats (the reference accepts
  // format.mintick, format.percent and format.volume): the default applies.
  const mask = typeof format_str === "string" && format_str !== "price" && format_str !== "inherit" ? format_str : TOSTRING_DEFAULT_FORMAT;
  return formatMask(value, mask, false);
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

// A str.format pattern as literal text and (index, type, style) placeholders, scanned as Java's
// MessageFormat.applyPattern does (the oracle's _parse_format_pattern): in literal text '' is one
// quote, a lone ' toggles quoting and quoted braces are literal; an unquoted } outside a placeholder
// is literal; inside a placeholder quotes are copied through to the style, ',' moves to the next
// segment, nested braces nest, and a space is dropped only ahead of the type. Patterns are
// compile-time constants in practice, so the parse is cached.
type FormatPiece = string | [string, string, string];
const formatPatternCache = new Map<string, FormatPiece[]>();

function parseFormatPattern(pattern: string): FormatPiece[] {
  const cached = formatPatternCache.get(pattern);
  if (cached !== undefined) return cached;
  const RAW = 0;
  const INDEX = 1;
  const TYPE = 2;
  const STYLE = 3;
  const parts: FormatPiece[] = [];
  const seg = ["", "", "", ""];
  let part = RAW;
  let inQuote = false;
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (part === RAW) {
      if (ch === "'") {
        if (pattern[i + 1] === "'") {
          seg[RAW] += ch;
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === "{" && !inQuote) {
        if (seg[RAW]) {
          parts.push(seg[RAW]);
          seg[RAW] = "";
        }
        seg[INDEX] = seg[TYPE] = seg[STYLE] = "";
        part = INDEX;
      } else {
        seg[RAW] += ch;
      }
    } else if (inQuote) {
      seg[part] += ch;
      if (ch === "'") inQuote = false;
    } else if (ch === ",") {
      if (part < STYLE) part++;
      else seg[part] += ch;
    } else if (ch === "{") {
      braceDepth++;
      seg[part] += ch;
    } else if (ch === "}") {
      if (braceDepth) {
        braceDepth--;
        seg[part] += ch;
      } else {
        parts.push([seg[INDEX]!, seg[TYPE]!, seg[STYLE]!]);
        part = RAW;
      }
    } else if (ch === "'") {
      inQuote = true;
      seg[part] += ch;
    } else if (!(ch === " " && part === TYPE && !seg[TYPE])) {
      seg[part] += ch;
    }
  }
  // An unclosed placeholder is an error, except with a brace still open inside it (Java drops
  // that one silently).
  if (part !== RAW && !braceDepth) runtimeError("Format pattern ends inside a placeholder");
  if (seg[RAW]) parts.push(seg[RAW]);
  if (formatPatternCache.size >= 256) formatPatternCache.clear();
  formatPatternCache.set(pattern, parts);
  return parts;
}

// The style keywords of a `number` placeholder, matched case-insensitively ignoring surrounding
// space; any other style is a DecimalFormat pattern taken verbatim (a leading space is a literal
// affix: `{0, number, #.#}` of 1.34 prints " 1.3", tier 1 str_010_format).
const NUMBER_STYLES = new Set(["integer", "currency", "percent", "mintick", "volume", "price", "inherit"]);

// A `number` placeholder with a keyword style, DecimalFormat's renderings (the oracle's
// _format_number_general with decimal_format): integer rounds half-even, currency and price are
// "$" with grouping and two places rounded half-up on the shortest digits, percent multiplies by
// 100 without places (tier 1 str_010_format: 1.34 "1", 1.52 "2", 1.34 "$1.34", 1340000
// "$1,340,000.00", 0.5 "50%"). An infinity keeps the style's affixes around "∞".
// Not covered: mintick and inherit need the symbol's tick and the script precision, which do not
// reach this runtime; they take the default pattern.
function formatNumberStyle(value: number, keyword: string): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) {
    if (keyword === "price" || keyword === "currency") return (value < 0 ? "-$" : "$") + "∞";
    if (keyword === "percent") return (value < 0 ? "-" : "") + "∞%";
    return (value < 0 ? "-" : "") + "∞";
  }
  if (keyword === "volume") {
    if (value >= 1e9) return fixedExact(value / 1e9, 2) + "B";
    if (value >= 1e6) return fixedExact(value / 1e6, 2) + "M";
    if (value >= 1e3) return fixedExact(value / 1e3, 2) + "K";
    return String(Math.trunc(value));
  }
  if (keyword === "integer") {
    const r = roundDecimal(exactDecimal(Math.abs(value)), 0, true);
    return value < 0 && r !== "0" ? "-" + r : r;
  }
  if (keyword === "percent") return fixedExact(value * 100, 0) + "%";
  if (keyword === "price" || keyword === "currency") {
    const [intText, decimalPart] = roundDecimal(shortestDecimal(Math.abs(value)), 2, false).split(".") as [string, string];
    const grouped = intText.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return "$" + (value < 0 || Object.is(value, -0) ? "-" : "") + grouped + "." + decimalPart;
  }
  return formatDecimal(value, DECIMAL_FORMAT_DEFAULT);
}

// A number through a DecimalFormat pattern (the exact value, half-even); na is "NaN", an infinity
// "∞" between the chosen subpattern's affixes.
function formatDecimal(value: number, pattern: string): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) {
    const subpatterns = pattern.split(";");
    const negativeSubpattern = value < 0 && subpatterns.length > 1;
    const [affix, , suffix] = splitNumberPattern(negativeSubpattern ? subpatterns[1]! : subpatterns[0]!);
    return (value < 0 && !negativeSubpattern ? "-" : "") + affix + "∞" + suffix;
  }
  return formatMask(value, pattern, true);
}

type FormatArg = number | string | boolean | null | undefined | unknown[];

// An argument of a placeholder without the `number` type (the oracle's _format_value): a string
// as is, a number through DecimalFormat's default pattern '#.###' (`str.format("{0}", 1.23456789)`
// is "1.235", tier 1 str_010_format), a bool "true"/"false", na "NaN", an array "[a, b]" (tier 1
// str_001_functions: `str.split("Hello World!", " ")` prints "[Hello, World!]"; the oracle prints
// the numbers of a list with Python's str()).
function formatValue(value: FormatArg): string {
  if (value === null || value === undefined) return "NaN";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatDecimal(value, DECIMAL_FORMAT_DEFAULT);
  if (Array.isArray(value)) {
    return "[" + value.map((x) => {
      if (x === null || x === undefined || (typeof x === "number" && Number.isNaN(x))) return "NaN";
      if (typeof x === "string") return x;
      if (typeof x === "boolean") return x ? "true" : "false";
      if (typeof x === "number") return pyFloatStr(x);
      return String(x);
    }).join(", ") + "]";
  }
  return String(value);
}

// The number a `number` placeholder formats (the oracle's safe_float): a bool is 1 or 0, a string
// is parsed as Python's float() parses it and is an error when it does not parse, anything else
// that is not a number is na.
function numberArg(value: FormatArg): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = parseFloatLoose(value);
    if (!parsed.ok) runtimeError(`could not convert string to float: '${value}'`);
    return parsed.value;
  }
  return NaN;
}

// str.format(formatString, arg0, ...): Java's MessageFormat as the oracle runs it (pynecore
// lib/string.py format). A placeholder's index is digits with an optional '+' (anything else is an
// error); an index without an argument is echoed as "{n}"; an na argument prints "NaN" (the result
// is not na); a placeholder without the `number` type formats its argument with formatValue; a
// `number` one takes a style keyword (formatNumberStyle), a DecimalFormat pattern, or none (the
// default '#.###'). A na pattern is na. Log messages are this function too (log.info(formatString,
// ...)). tier 1: str_010_format, math_001_functions ("{0}" of math.abs(-1) is "1",
// "{0,number,#.##########}" of math.acos(0.5) "1.0471975512"), str_001_functions (bools "true").
export function format(template: string | null, ...args: FormatArg[]): string | null {
  if (typeof template !== "string") return null;
  let out = "";
  for (const piece of parseFormatPattern(template)) {
    if (typeof piece === "string") {
      out += piece;
      continue;
    }
    const [index, argType, style] = piece;
    if (!/^\+?\d+$/.test(index)) runtimeError(`Invalid argument index: ${index}`);
    const position = parseInt(index, 10);
    if (position >= args.length) {
      out += `{${position}}`;
      continue;
    }
    const value = args[position];
    if (value === null || value === undefined) {
      out += "NaN";
    } else if (argType.trim().toLowerCase() !== "number") {
      out += formatValue(value);
    } else {
      const keyword = style.trim().toLowerCase();
      const number = numberArg(value);
      if (NUMBER_STYLES.has(keyword)) out += formatNumberStyle(number, keyword);
      else out += formatDecimal(number, keyword ? style : DECIMAL_FORMAT_DEFAULT);
    }
  }
  return out;
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
