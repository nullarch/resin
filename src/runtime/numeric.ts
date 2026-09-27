// 안전 수치 연산. GOAL.md 아키텍처 불변 원칙: `/`->pineDiv, `%`->pineMod (0-나눗셈 -> NaN).

import { MINTICK } from "./syminfo";

export function pineDiv(a: number, b: number): number {
  if (b === 0) return NaN;
  return a / b;
}

// `%` is the floored modulo, not JS's truncated remainder: language_operators.txt "The % operator
// calculates the modulo by rounding down the quotient to the lowest possible value"
// (a - b * math.floor(a/b)), so the result takes the divisor's sign: (-1) % 100 = 99,
// 7 % -3 = -2, -5.5 % 2 = 0.5. JS `%` is the exact truncated remainder; when it is non-zero and
// its sign differs from the divisor's, adding the divisor once floors the quotient (the same
// correction CPython's float_rem makes, so float results are exact, not a - b*floor(a/b) rounding).
export function pineMod(a: number, b: number): number {
  if (b === 0) return NaN;
  const r = a % b;
  if (r === 0) return 0;
  return r < 0 !== b < 0 ? r + b : r;
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
