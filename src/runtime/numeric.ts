// 안전 수치 연산. GOAL.md 아키텍처 불변 원칙: `/`->pineDiv, `%`->pineMod (0-나눗셈 -> NaN).

import { warnRuntime } from "./diagnostics";
import { MINTICK } from "./syminfo";
import { zoneOffsetMs } from "./datetime";

export function pineDiv(a: number, b: number): number {
  if (b === 0) return NaN;
  return a / b;
}

// `%` is the truncated remainder, which takes the sign of the dividend: (-7) % 3 = -1, 7 % -3 = 1,
// -7.5 % 2 = -1.5, and -6.0 % 3 is -0. Measured on TradingView (CAPITALCOM:EURUSD 60) by the oracle's
// tests/t01_lib/t04_math/test_023_pine_remainder.py: `(z - 7) % 3` is -1, `(z + 7) % -3` is 1,
// `(z - 7.5) % 2` is -1.5, `1 / ((z - 6.0) % 3)` is -inf, `(z + 1e17) % 3` is 1; a zero divisor and a na
// operand give na. That is JS's own `%`. The operators manual's sentence ("calculates the modulo by
// rounding down the quotient to the lowest possible value") reads as the floored modulo, which resin
// implemented until this measurement: it gave 2, -2 and 0.5 for the first three.
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

// na(x). The empty string is the string na: "TradingView answers na(\"\") true" (the oracle's
// lib is_na; its tests/t01_lib/t05_string/test_001_str.py: "A na string is the empty string ...
// MEASURED on TradingView, v5 and v6"). A request.security of a string the requested context has
// not set yet reads as na for that reason (resin-harness probe L42).
export function na(x: unknown): boolean {
  return typeof x === "number" ? x !== x : x === null || x === "";
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

// Comparison operators (</>/<=/>=, and ==/!= below). A na operand makes the comparison false, not
// na: "The == , != operators, and all other comparison operators always return false if at least
// one of the operands is a variable with an na value" (language_type-system.txt, "na value"); in v6
// a bool "is never na" (rn.txt), so `not (f > 1)` with f na is true. The oracle does the same
// (pynecore types/na.py: "Comparisons — all False (Pine semantics)"); lang probes L17
// (not_gt_na_v6, eqfalse_v6, not_hist_first, flag_v6) and L19 (ne_na). pine2py propagated na here
// (DIVERGENCES.md #4), which turned `not (close[1] > 0)` on bar 0 and `x != x[1]` on bar 0 wrong.
//
// The comparison itself is tolerant, as TradingView's is: "comparison operators automatically
// round “float” operands to nine fractional digits" (language_type-system.txt, "float"). The
// oracle measured the rule on TradingView as an absolute band on the difference, the boundary
// belonging to equality: operands at most 1e-10 apart are equal at every magnitude (pynecore
// core/pine_compare.py EPSILON, transformers/float_tolerance.py: `a < b` -> `-1e-10 > a - b`,
// `a <= b` -> `a <= b or 1e-10 >= a - b`, `a == b` -> `a == b or -1e-10 <= a - b <= 1e-10`).
// Tier 1 math_004_sum_flat_exact: TradingView's rolling sum leaves ~1e-14 of dust in a window of
// zeros, and its own `==` still reports ta.sma(ta.sma(v, 3), 3) == ta.sma(v, 3) there. An int
// difference is 0 or at least 1, so ints stay exact. The raw test in front of the non-strict forms
// keeps two equal infinities equal (their difference is NaN).
const CMP_EPS = 1e-10;

export function pineLt(a: number, b: number): boolean {
  return -CMP_EPS > a - b;
}

export function pineGt(a: number, b: number): boolean {
  return CMP_EPS < a - b;
}

// The strict forms above are false on a na operand by themselves (the NaN difference fails the
// band); here the raw test cannot pass on NaN either.
export function pineLe(a: number, b: number): boolean {
  return a <= b || CMP_EPS >= a - b;
}

export function pineGe(a: number, b: number): boolean {
  return a >= b || -CMP_EPS <= a - b;
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

// Pine v6 `and`/`or` (codegen genBinOp for //@version=6): the right operand is a thunk, evaluated
// only when the left one does not decide the result. rn.txt (Pine v6): "If the first expression of
// an or operation is true, or the first expression of an and operation is false, the script does
// not evaluate the second expression"; mig6.txt "Lazy evaluation of conditions": a skipped
// `ta.rsi()` "is not evaluated on every bar, which interferes with the internal history that the
// RSI function stores". A na left operand of `and` is false in v6 ("Values of the bool type are
// now strictly true or false. They are never na in v6", rn.txt), so it skips the right one too;
// otherwise the value is pineAnd/pineOr's.
export function pineAndLazy(a: boolean | number, b: () => boolean | number): boolean | number {
  if (a === false || a === 0 || a !== a) return false;
  return pineAnd(a, b());
}

export function pineOrLazy(a: boolean | number, b: () => boolean | number): boolean | number {
  if (a === true || a === 1) return true;
  return pineOr(a, b());
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
// Two numbers compare with the tolerance of pineLt & co. (see there). A na operand (NaN, or null for
// a reference type) makes both == and != false, as every comparison with na is (see pineLt): two
// na strings are not equal, and `x != x[1]` is false on bar 0. (`x == na` is rt.na, genEquality.)
export function pineEq(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return false;
  if (typeof a === "boolean") {
    if (typeof b === "number") return b === (a ? 1 : 0);
  } else if (typeof b === "boolean" && typeof a === "number") {
    return a === (b ? 1 : 0);
  }
  if (a === b) return true;
  if (typeof a !== "number" || typeof b !== "number") return false;
  const d = a - b;
  return -CMP_EPS <= d && d <= CMP_EPS;
}

export function pineNeq(a: unknown, b: unknown): boolean {
  if (a !== a || b !== b || a === null || b === null) return false;
  return !pineEq(a, b);
}

// A finite non-negative double as an exact fraction n / d (Python's float.as_integer_ratio, not
// reduced): the mantissa over a power of two, or the whole integer over 1.
function doubleRatio(x: number): [bigint, bigint] {
  if (x === 0) return [0n, 1n];
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
  return exponent >= 0 ? [mantissa << BigInt(exponent), 1n] : [mantissa, 1n << BigInt(-exponent)];
}

// `0.5 - 1e-10` as the exact fraction ROUND_TIE_HALF / ROUND_TIE_SCALE: the point from which a
// remainder rounds away from zero in math.round (with a precision) and math.round_to_mintick.
const ROUND_TIE_SCALE = 10n ** 10n;
const ROUND_TIE_HALF = 5n * 10n ** 9n - 1n;

// math.round — ties away from zero, on TradingView's arithmetic (the oracle's pynecore lib/math.py
// round, whose comments cite the TradingView measurements: probes roundprobe, mr1-mr14, mrp1,
// mrp2 on FX:EURUSD and BINANCE:BTCUSDT). The manual says "rounded to the nearest integer, with
// ties rounding up. If the `precision` parameter is used, returns a float value rounded to that
// amount of decimal places" (ref_v6_ta_math.txt math.round); "up" is away from zero (-2.5 -> -3).
// - No precision (or na), or a precision of zero or less: the integer nearest to the value,
//   compared exactly (a negative precision does not round to tens: 1234.5678 @ -2 -> 1235).
// - A positive precision rounds only the fraction: `int + round(frac * scale) / scale`, where the
//   scale is `1 / 10^-precision` (99999.99999999999 at 5, not 1e5), a precision above 16 acting as
//   16. A tie is decided on the EXACT product frac * scale with a 1e-10 tolerance: a product within
//   1e-10 below .5 rounds away from zero. So math.round(1.005, 2) is 1.01 although the double
//   1.005 is 1.00499999999999989..., and 101.37 * 1.005 = 101.87684999999999 is 101.8769 at 4
//   decimals where a double `x * 10^4 + 0.5` floored it to 101.8768 (repros resin-harness
//   lang.probes L29 rprec2, state/repros/ta.math-seed-24.json).
export function round(value: number, precision: number = NaN): number {
  if (value !== value) return NaN; // NaN은 그대로 통과 (na 시맨틱)
  const hasPrecision = precision === precision;
  if (!Number.isFinite(value)) return hasPrecision ? value : NaN;
  const negative = value < 0;
  const magnitude = negative ? -value : value;
  if (!hasPrecision || precision <= 0) {
    // From 2^52 up every double is an integer, and `magnitude + 0.5` would round to even there.
    if (magnitude >= 2 ** 52) return value;
    const units = Math.floor(magnitude + 0.5);
    // `0 - units`: a negative value rounded to nothing is 0, not -0.
    return negative ? 0 - units : units;
  }
  const scale = 1 / Math.pow(10, -(precision <= 16 ? precision : 16));
  const fraction = magnitude % 1;
  const scaled = fraction * scale;
  let units = Math.floor(scaled);
  const offset = scaled - units - 0.5;
  // Only a near-tie needs the exact product; the window covers the double's own error.
  const slack = 1e-9 + scaled * 1.8e-15;
  if (-slack < offset && offset < slack) {
    const [fn, fd] = doubleRatio(fraction);
    const [sn, sd] = doubleRatio(scale);
    const denominator = fd * sd;
    const remainder = fn * sn - BigInt(units) * denominator;
    if (remainder * ROUND_TIE_SCALE >= ROUND_TIE_HALF * denominator) units += 1;
  } else if (offset > 0) {
    units += 1;
  }
  const rounded = magnitude - fraction + units / scale;
  return negative ? 0 - rounded : rounded;
}

// math.round_to_mintick — "the nearest value that can be divided by syminfo.mintick, without the
// remainder, with ties rounding up" (ref_v6_ta_math.txt), ties away from zero, on TradingView's
// arithmetic (the oracle's pynecore lib/math.py round_to_mintick, measured on BINANCE:BTCUSDT
// 30m: 19999.585 rounds up, 16384.245 down, -1.075 -> -1.08). The position on the tick grid is
// `value * pricescale / minmove` (mintick = minmove / pricescale), a tie decided on its EXACT value
// with math.round's 1e-10 tolerance, and the result is `units * minmove / pricescale`, not
// `units * mintick` (repro resin-harness state/repros/ta.math-seed-4.json: 111 * 1.005 =
// 111.55499999999999 is 111.56, where a double `value / 0.01` floored it to 111.55). codegen
// passes the chart symbol's grid; a
// resin-only explicit `mintick` argument (not in Pine) takes the grid `1 / mintick` with minmove 1.
// A mintick <= 0 returns the value.
export function round_to_mintick(
  value: number,
  mintick: number = MINTICK,
  pricescale: number = 1 / mintick,
  minmove: number = 1,
): number {
  if (value !== value) return NaN;
  if (mintick <= 0) return value;
  const negative = value < 0;
  const magnitude = negative ? -value : value;
  const scaled = (magnitude * pricescale) / minmove;
  let units = Math.trunc(scaled);
  const offset = scaled - units - 0.5;
  const slack = 1e-6 + scaled * 1.8e-15;
  if (-slack < offset && offset < slack) {
    const [mn, md] = doubleRatio(magnitude);
    const [pn, pd] = doubleRatio(pricescale);
    const [vn, vd] = doubleRatio(minmove);
    const numerator = mn * pn * vd;
    const denominator = md * pd * vn;
    units = Number(numerator / denominator);
    if ((numerator % denominator) * ROUND_TIE_SCALE >= ROUND_TIE_HALF * denominator) units += 1;
  } else if (offset > 0) {
    units += 1;
  }
  return ((negative ? 0 - units : units) * minmove) / pricescale;
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

// math.avg — the manual only says "Calculates average of all given series" (ref_v6_ta_math.txt),
// but TradingView runs two different sums, and its last bit shows (tier 1
// tv/math_005_avg_exact, TradingView Pine Logs; the oracle's lib/math.py avg): up to two terms
// are added plainly, from three on they go through a Kahan compensated sum whose pending
// correction is flushed back into the total before the division. A plain sum is one ulp off
// there once the terms differ in magnitude (68.33080369485288 = avg(60.48816185259965,
// 66.50424923195895, 78.0)), and so is bare Kahan without the flush (b3/a4/a5 of the scenario).
// na arguments are still skipped and the rest averaged (pine2py's policy; na only when every
// argument is na).
export function avg(...values: number[]): number {
  let count = 0;
  for (const v of values) if (v === v) count++;
  if (count === 0) return NaN;
  let total = 0;
  if (count <= 2) {
    for (const v of values) if (v === v) total += v;
    return total / count;
  }
  let compensation = 0;
  for (const v of values) {
    if (v !== v) continue;
    const y = v - compensation;
    const t = total + y;
    compensation = t - total - y;
    total = t;
  }
  return (total - compensation) / count;
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

// UTC epoch milliseconds of a calendar date and clock time. Month, day and clock components roll
// over as Pine's do (hour 26 is the next day's 02:00, month 13 the next January), and a year of 0 to
// 99 is that year (Date.UTC would read it as 1900 + year). A NaN component gives NaN.
function utcMs(y: number, m: number, d: number, h: number, mi: number, s: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(h, mi, s, 0);
  return t.getTime();
}

const DAY_MS = 86400000;

// The UTC instant at which `timezone`'s wall clock reads `wallMs` (the wall clock written as if it
// were UTC). A fixed UTC/GMT offset subtracts itself. A named zone is resolved the way Python's
// datetime(..., tzinfo=ZoneInfo) with fold=0 does, which is what the oracle measured against
// TradingView: a wall time that occurs twice (clocks going back) is its first occurrence, one that
// never occurs (clocks going forward) is read with the offset in force before the change. An empty,
// na or unrecognised timezone is UTC, like the time-component functions.
function zonedToUtcMs(wallMs: number, timezone: string | null | undefined): number {
  if (!Number.isFinite(wallMs) || !timezone || timezone === "UTC" || timezone === "GMT") return wallMs;
  const before = zoneOffsetMs(wallMs - DAY_MS, timezone);
  const after = zoneOffsetMs(wallMs + DAY_MS, timezone);
  if (before === after) return wallMs - before;
  for (const offset of [before, after]) {
    const instant = wallMs - offset;
    if (zoneOffsetMs(instant, timezone) === offset) return instant;
  }
  return wallMs - before;
}

// Month names a date string may carry: the English abbreviation or the full name, any letter case.
const MONTH_NAMES: Record<string, number> = {};
["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].forEach((name, i) => {
  MONTH_NAMES[name] = i + 1;
  MONTH_NAMES[name.slice(0, 3)] = i + 1;
});

// A date string's trailing zone as UTC offset minutes: RFC 2822 zone names and "Z", or an offset with
// an optional UTC/GMT prefix ("GMT+5", "UTC-05:30", "+0200", "-6"). `named` is true for a zone with a
// name or a UTC/GMT prefix, false for a bare offset (the two differ on a date without a time, see
// parseDateString). Anything else is not a zone.
const ZONE_NAME_OFFSETS: Record<string, number> = {
  UT: 0, UTC: 0, GMT: 0, Z: 0,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};
const ZONE_OFFSET_RE = /^(UTC|GMT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;

function parseZone(token: string): { minutes: number; named: boolean } | null {
  const upper = token.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(ZONE_NAME_OFFSETS, upper)) return { minutes: ZONE_NAME_OFFSETS[upper]!, named: true };
  const m = ZONE_OFFSET_RE.exec(token);
  if (m === null) return null;
  const minutes = Number(m[3]) * 60 + (m[4] === undefined ? 0 : Number(m[4]));
  return { minutes: m[2] === "-" ? -minutes : minutes, named: m[1] !== undefined };
}

// ISO-style "yyyy-MM-dd[THH:mm[:ss]]" with an optional trailing offset.
const ISO_DATE_STRING_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i;
// A date spelled with a month name, either order: "Feb 01 2020 22:10:05", "04 Dec 1995 00:12:00 GMT+5".
const NAMED_MONTH_FIRST_RE = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s+(\S+))?$/;
// The day may touch the month name ("15Aug 2022 20:00 +0000": written by published scripts, not
// measured on TradingView).
const NAMED_DAY_FIRST_RE = /^(\d{1,2})\s*([A-Za-z]{3,9})\.?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s+(\S+))?$/;
const NAMED_MONTH_YEAR_RE = /^([A-Za-z]{3,9})\.?\s+(\d{4})$/;
// Numeric dates are MONTH-first ("03-04-2023" is March 4th) with '-', '/', '.' or ' ' between the
// parts; a day-first one such as "13-04-2023" is not a date.
const NUMERIC_MONTH_FIRST_RE = /^(\d{1,2})[ /.-](\d{1,2})[ /.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s+(\S+))?$/;
const YEAR_MONTH_RE = /^(\d{4})(?:[-/.](\d{1,2}))?$/;

// UTC milliseconds of a calendar date and clock time, or NaN when the date does not exist (February
// 30th) or the clock is out of range.
function validUtcMs(y: number, mo: number, d: number, h: number, mi: number, sec: number, offsetMin: number): number {
  if (!(mo >= 1 && mo <= 12 && d >= 1 && h <= 23 && mi <= 59 && sec <= 59)) return NaN;
  const t = utcMs(y, mo, d, h, mi, sec);
  const check = new Date(t);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return NaN;
  return t - offsetMin * 60000;
}

// timestamp(dateString): the date a string spells, in UTC unless the string carries a zone ("No
// timezone means UTC, not the exchange timezone", measured on TradingView by the oracle's
// core/datetime.py parse_datestring). Not a date: NaN (na).
//   - ISO "yyyy-MM-dd[THH:mm[:ss]]" and a trailing "Z"/"UTC"/"+HH:mm"/"+HHMM";
//   - a month NAME in either order, "Feb 01 2020 22:10:05" / "04 Dec 1995 00:12:00 GMT+5" / "Jan 2025",
//     with the zone names of RFC 2822 or an offset ("GMT+5", "+0200") after the time. A name-month date
//     WITHOUT a time ignores a named zone ("01 Jan 2022 GMT+3" is midnight UTC) and refuses a bare
//     offset ("01 Jan 2022 +0300"): measured on TradingView;
//   - numeric month-first "03-04-2023", "03/04/2023", "03.04.2023", "3 4 2023" (their zone counts);
//   - "2025" and "2025-06" (the first of the month).
// Not covered: the "yyyy-MM-dd:HH:mm" spelling.
function parseDateString(raw: string): number {
  // Words in front of the date carry no meaning: a weekday, a zone name, anything digit-free that is
  // not a month name ("UTC 01 Jan 2022 00:00", "Sat, 01 Jan 2022" and "Foo 01 Jan 2022" are all
  // 2022-01-01 00:00 UTC; measured on TradingView by the oracle, core/datetime.py parse_datestring).
  // After such a word the ISO date-and-time form is refused while a bare ISO date is not.
  let s = raw.trim();
  let words = 0;
  for (;;) {
    const lead = /^([^\s\d+-]\S*)\s+/.exec(s);
    if (lead === null || MONTH_NAMES[lead[1]!.toLowerCase().replace(/[.,]$/, "")] !== undefined) break;
    s = s.slice(lead[0].length);
    words++;
  }
  const ms = words > 0 && /^\d{4}-\d{2}-\d{2}[T ]/.test(s) ? NaN : readDateString(s);
  // A date that silently became na turns `time >= start and time <= stop` false on every bar, and
  // the script runs to the end doing nothing: say so.
  if (Number.isNaN(ms)) {
    warnRuntime(`timestamp-date:${raw}`, `timestamp('${raw}') is not a date string resin can read, so it is na; a date window built on it is never open`);
  }
  return ms;
}

function readDateString(s: string): number {
  const iso = ISO_DATE_STRING_RE.exec(s);
  if (iso) {
    const [, y, mo, d, h, mi, sec, off] = iso;
    const zone = off === undefined ? null : parseZone(off);
    return validUtcMs(Number(y), Number(mo), Number(d), h ? Number(h) : 0, mi ? Number(mi) : 0, sec ? Number(sec) : 0, zone?.minutes ?? 0);
  }
  const named = NAMED_MONTH_FIRST_RE.exec(s) ?? NAMED_DAY_FIRST_RE.exec(s);
  if (named) {
    const monthFirst = /^[A-Za-z]/.test(s);
    const monName = (monthFirst ? named[1] : named[2])!.toLowerCase();
    const day = Number(monthFirst ? named[2] : named[1]);
    const mo = MONTH_NAMES[monName];
    if (mo === undefined) return NaN;
    // groups 3..7 are year, hour, minute, second and zone in both spellings
    const [h, mi, sec, zoneToken] = [named[4], named[5], named[6], named[7]];
    let offsetMin = 0;
    if (zoneToken !== undefined) {
      const zone = parseZone(zoneToken);
      if (zone === null) return NaN;
      if (h === undefined) {
        // no clock time: a named zone is ignored, a bare offset is refused
        if (!zone.named) return NaN;
      } else {
        offsetMin = zone.minutes;
      }
    }
    return validUtcMs(Number(named[3]), mo, day, h ? Number(h) : 0, mi ? Number(mi) : 0, sec ? Number(sec) : 0, offsetMin);
  }
  const monthYear = NAMED_MONTH_YEAR_RE.exec(s);
  if (monthYear) {
    const mo = MONTH_NAMES[monthYear[1]!.toLowerCase()];
    return mo === undefined ? NaN : validUtcMs(Number(monthYear[2]), mo, 1, 0, 0, 0, 0);
  }
  const numeric = NUMERIC_MONTH_FIRST_RE.exec(s);
  if (numeric) {
    const [, mo, d, y, h, mi, sec, zoneToken] = numeric;
    let offsetMin = 0;
    if (zoneToken !== undefined) {
      const zone = parseZone(zoneToken);
      if (zone === null) return NaN;
      offsetMin = zone.minutes;
    }
    return validUtcMs(Number(y), Number(mo), Number(d), h ? Number(h) : 0, mi ? Number(mi) : 0, sec ? Number(sec) : 0, offsetMin);
  }
  const yearMonth = YEAR_MONTH_RE.exec(s);
  if (yearMonth) return validUtcMs(Number(yearMonth[1]), yearMonth[2] === undefined ? 1 : Number(yearMonth[2]), 1, 0, 0, 0, 0);
  return NaN;
}

// timestamp(...), three overloads:
//   timestamp(dateString)                                         parseDateString above;
//   timestamp(timezone, year, month, day[, hour, minute, second])  the wall clock of `timezone` (an IANA
//                                                                  name or "GMT+6"/"UTC-5:30");
//   timestamp(year, month, day[, hour, minute, second])            the wall clock of the exchange
//                                                                  timezone, `defaultTimezone`.
// (ref_v6_lang.txt timestamp: "timezone ... Optional. The default is syminfo.timezone"; tier 1
// base_001_time: timestamp("GMT+6", 2016, 1, 19, 9, 30) is 2016-01-19 03:30 UTC on TradingView.)
// The overload is told by the first argument's type at run time (a timezone may be a variable). An
// omitted day is 1 in the timezone overload only (the oracle's own asymmetry, kept). Fewer than 3
// arguments of either kind is 0. A NaN component is NaN.
export function timestampIn(defaultTimezone: string, ...args: (number | string)[]): number {
  if (args.length === 1 && typeof args[0] === "string") {
    return parseDateString(args[0]);
  }
  let timezone: string = defaultTimezone;
  let y: number, m: number, d: number, h: number, mi: number, s: number;
  if (args.length >= 3 && typeof args[0] === "string") {
    timezone = args[0];
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
  return zonedToUtcMs(utcMs(y, m, d, h, mi, s), timezone);
}

// timestamp(...) with the default symbol timezone, UTC; a script on another chart timezone calls
// timestampIn with it (codegen).
export function timestamp(...args: (number | string)[]): number {
  return timestampIn("UTC", ...args);
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
