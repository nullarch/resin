// TA 빌트인: 전부 incremental O(1)/bar (바당 히스토리 재계산 금지 - GOAL.md 불변 원칙).
// 상태는 클로저가 아닌 plain object 슬롯(ctx.taSlots[i])에 저장 - Context가 생성해 전달한다.
// fixnan은 Pine 네임스페이스상 ta.*가 아닌 bare 빌트인이지만, 동일한 taSlots 상태 슬롯 메커니즘을
// 재사용하므로(analyzer.ts TA_REGISTRY.fixnan이 stateCallSlots+taSlotCount 풀을 sma와 공유) 이 파일에 둔다.

import { runtimeError } from "./log";

export interface SmaState {
  buffer?: number[]; // ring of the last `length` non-na values, raw
  entries?: number[]; // the same slots' realized entries: what an eviction subtracts
  writeIdx?: number;
  count?: number; // non-na values stored so far, capped at the length
  sum?: number;
  comp?: number; // the compensation register
}

// The rolling sum ta.sma and math.sum share: the sum of the last `length` NON-na values of the
// source, na until that many have arrived. The reference says so for both ("`na` values in the
// `source` series are ignored; the function calculates on the `length` quantity of non-`na`
// values", ref_v6_ta_math.txt "math.sum"; "ta.sma": "`na` values in the `source` series are
// ignored"), and the oracle builds ta.sma as math.sum / length on exactly this window (pynecore
// lib/_math_stateful.py sum: "The window is na-compacted: an na bar returns na and is not stored,
// so the sum always covers the last ``length`` non-na values"; an na bar after the warm-up reports
// the standing sum, "MEASURED, probe sumlen4"). So an na bar neither enters the ring nor evicts
// from it, and a warm-up counts non-na values, not bars (math.sum used to return the partial sum
// of the first bars, ta.sma used to poison its whole window for `length` bars after one na).
//
// The arithmetic is TradingView's, not a plain `sum - oldest + value`: a rolling COMPENSATED sum
// that each bar evicts the entry stored `length` values ago and adds the new value in one fused
// two-round step (y1 = -d0 - c; t = s + y1; e1 = (t - s) - y1; y2 = value - e1; s = t + y2;
// c = (s - t) - y2), storing the realized y2 as the slot's entry, so a later eviction subtracts
// exactly what was added. On a bar where adding the compensation's magnitude to the value rounds
// down (the fixed-order Fast2Sum residue of fl(value + |c|) is positive) it re-baselines instead:
// the sum becomes the plain newest-first linear sum of the raw window, the compensation clears
// and the raw value is stored. The warm-up runs the same machine with nothing to evict (oracle
// pynecore lib/_math_stateful.py sum and core/rolling_sum.py sum_fires, "Validated bit-for-bit
// against TV output on dense probes for lengths 2..14 (~330k displayed bars)"). Tier 1
// math_004_sum_flat_exact shows it: after a window of 100s gives way to 0s,
// ta.sma(ta.sma(v, 3), 3) equals ta.sma(v, 3) again (TV "k_eq_d: true" on bar 24) although the
// window of zeros keeps rounding dust (see pineEq's tolerance, numeric.ts). A flat window's
// ta.stdev is whatever the machine's p and q leave, 0 or a residue (resin-harness
// state/repros/ta.volatility-seed-13.json: ta.stdev(hlc3, 4) is exactly 0 on bar 79, where the
// plain rolling sum gave 2.7e-6).
function naSkipSum(state: SmaState, value: number, length: number): number {
  // C569: length는 TV에서 항상 'int' 타입이지만, analyzer.ts의 int/int idiv 판별(idivBinOps, C201
  // 잔여 범위)이 UDF 매개변수·삼항 체인처럼 top-level 리터럴 밖의 int 값을 못 잡으면 codegen이
  // 그 자리에 float division(rt.pineDiv)을 내려 여기 도달하는 length가 실제로는 정수인데 정수가
  // 아닌 값(예: 21/2=10.5)으로 보일 수 있다 - new Array(length)가 그대로 RangeError를 던지므로
  // (wild HMA(_src,_length)=>ta.wma(...,_length/2,...) 관용구, 배치27 exec 최다 클러스터) 여기서
  // 진짜 int 값으로 되돌린다(*VarLen 계열이 이미 쓰는 Math.trunc(length) 전례와 동일 원칙).
  length = Math.trunc(length);
  if (!(length >= 1)) return NaN;
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(0);
    state.entries = new Array(length).fill(0);
    state.writeIdx = 0;
    state.count = 0;
    state.sum = 0;
    state.comp = 0;
  }
  if (Number.isNaN(value)) return state.count! < length ? NaN : state.sum!;
  const buffer = state.buffer;
  const entries = state.entries!;
  const at = state.writeIdx!;
  const prevW = state.count!;
  const full = prevW >= length;
  const c = state.comp!;
  let s = state.sum!;
  // sum_fires: c == 0 or value == 0 never fire; `r - r === 0` rejects a NaN or infinite r.
  let fires = false;
  if (c !== 0 && value !== 0) {
    const b = c > 0 ? c : -c;
    const r = value + b;
    if (r !== 0 && r - r === 0) fires = b - (r - value) > 0;
  }
  if (fires) {
    // value + src[1] + src[2] + ... in that order; slot `at` holds the value leaving the window.
    const newW = full ? length : prevW + 1;
    let i = at;
    s = value;
    for (let k = 1; k < newW; k++) {
      i = i === 0 ? length - 1 : i - 1;
      s += buffer[i]!;
    }
    state.comp = 0;
    entries[at] = value;
  } else {
    const y1 = -(full ? entries[at]! : 0) - c;
    const t = s + y1;
    const e1 = t - s - y1;
    const y2 = value - e1;
    s = t + y2;
    state.comp = s - t - y2;
    entries[at] = y2;
  }
  buffer[at] = value;
  state.sum = s;
  state.writeIdx = at + 1 === length ? 0 : at + 1;
  if (!full) state.count = prevW + 1;
  return state.count! < length ? NaN : s;
}

// ta.sma = the na-skipping rolling sum (naSkipSum) / length.
export function sma(state: SmaState, value: number, length: number): number {
  return naSkipSum(state, value, length) / Math.trunc(length);
}

export interface EmaState {
  initCount?: number;
  initSum?: number;
  prevEma?: number;
}

// ta.ema - seeded with the SMA of the first `length` non-na values, then smoothed with
// alpha = 2 / (length + 1). An na source is skipped whole: na on its bar, state untouched
// (ref_v6_ta_math.txt ta.ema: "`na` values in the `source` series are ignored; the function
// calculates on the `length` quantity of non-`na` values").
// The manual writes the step as `alpha * source + (1 - alpha) * EMA[1]`; that is the algebra, not
// TradingView's floating-point order. TradingView computes `prev + alpha * (source - prev)`: tier 1
// ta_245_ema_rma_exact logs ema(a, 5) at exactly 100.79423868312757 on bar 10, which the manual's
// order misses by one ulp (oracle pynecore lib/ta.py ema, "Measured law (probes m558 ...)": the
// algebraically equal forms "drift from TradingView on more than half of the bars").
// Length 1 is the identity (the oracle's shortcut): `prev + (source - prev)` is not always
// `source` in doubles.
export function ema(state: EmaState, value: number, length: number): number {
  if (state.initCount === undefined) {
    state.initCount = 0;
    state.initSum = 0;
    state.prevEma = NaN;
  }
  if (length === 1) return value;
  if (Number.isNaN(value)) return NaN;

  if (state.initCount < length) {
    state.initCount += 1;
    state.initSum! += value;
    if (state.initCount === length) {
      state.prevEma = state.initSum! / length;
      return state.prevEma;
    }
    return NaN;
  }

  const alpha = 2 / (length + 1);
  const emaVal = state.prevEma! + alpha * (value - state.prevEma!);
  state.prevEma = emaVal;
  return emaVal;
}

export interface DemaState {
  ema1?: EmaState;
  ema2?: EmaState;
}

// ta.dema(source, length) - Double Exponential Moving Average: DEMA = 2*EMA(source,length) -
// EMA(EMA(source,length),length) (표준 TV 공식 정의, analyzer.ts TA_REGISTRY.dema 주석 참조).
// pine2py wavealgo/ta/에 대응 구현이 전혀 없어(전수 grep 0건) 오라클 대조 자체가 불가능한
// hand-verified 신규 함수(DIVERGENCES.md #175) — 새 O(1) 재귀식을 유도하지 않고 이미 오라클로
// 검증된 ema()를 두 겹 내부 재호출로 구성한다(hma()가 wma()를 세 겹 재사용하는 것과 동일 원칙).
// ema()는 NaN 입력에서 상태를 전혀 안 건드리고 즉시 NaN을 반환하므로(위 ema() 참조), ema1이 아직
// NaN이면(초기 length바 워밍업 또는 na 갭) ema2 호출 자체를 건너뛰어 그 상태도 전진시키지 않는다
// (hma()가 outer wma 호출을 조건부로 건너뛰는 것과 동형). ema2 자신의 워밍업 구간(ema1이 non-NaN인
// 이후로도 추가 length바)은 ema2Val이 NaN을 반환해 최종 뺄셈이 자연히 NaN을 전파한다.
export function dema(state: DemaState, value: number, length: number): number {
  if (state.ema1 === undefined) {
    state.ema1 = {};
    state.ema2 = {};
  }
  const ema1Val = ema(state.ema1, value, length);
  if (Number.isNaN(ema1Val)) return NaN;
  const ema2Val = ema(state.ema2!, ema1Val, length);
  return 2 * ema1Val - ema2Val;
}

// Pine's comparison tolerance: two floats at most 1e-10 apart compare equal (the EPS of the
// manual's pine_stdev reference, ref_v6_ta_math.txt "ta.stdev"; PyneCore core/pine_compare.py).
const PINE_EPS = 1e-10;

export interface RsiState {
  initCount?: number;
  prevValue?: number;
  initGainSum?: number;
  initLossSum?: number;
  avgGain?: number;
  avgLoss?: number;
}

// ta.rsi - the manual's reference (ref_v6_ta_math.txt "ta.rsi"): u = math.max(x - x[1], 0),
// d = math.max(x[1] - x, 0), 100 - 100 / (1 + ta.rma(u, y) / ta.rma(d, y)). avgGain/avgLoss are
// the two rmas: seeded by the SMA of the first `length` changes, then (prev*(length-1)+v)/length.
// The first non-na bar has no x[1]: u and d are na there, and rma ignores na, so that bar only
// seeds prevValue and does NOT count toward the seed; the first value lands on the bar holding
// the (length+1)-th non-na source (tier 1 ta_211_mfi_rsi_stoch: rsi(close, 14) na on bar 13,
// 35.699373695 on bar 14 over the changes of bars 1..14). An na source is skipped entirely
// ("`na` values in the `source` series are ignored").
// A side within 1e-10 of zero saturates instead of dividing, the down side tested first (both
// dormant is 100): PyneCore lib/ta.py rsi, measured on TradingView (probe rsiconst_probe).
export function rsi(state: RsiState, value: number, length: number): number {
  if (state.initCount === undefined) {
    state.initCount = 0;
    state.prevValue = NaN;
    state.initGainSum = 0;
    state.initLossSum = 0;
    state.avgGain = 0;
    state.avgLoss = 0;
  }
  if (Number.isNaN(value)) return NaN;

  const prev = state.prevValue!;
  state.prevValue = value;
  if (Number.isNaN(prev)) return NaN;

  const change = value - prev;
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);
  state.initCount += 1;

  if (state.initCount <= length) {
    state.initGainSum! += gain;
    state.initLossSum! += loss;
    if (state.initCount < length) return NaN;
    state.avgGain = state.initGainSum! / length;
    state.avgLoss = state.initLossSum! / length;
  } else {
    state.avgGain = (state.avgGain! * (length - 1) + gain) / length;
    state.avgLoss = (state.avgLoss! * (length - 1) + loss) / length;
  }
  if (state.avgLoss <= PINE_EPS) return 100;
  if (state.avgGain <= PINE_EPS) return 0;
  return 100 - 100 / (1 + state.avgGain / state.avgLoss);
}

export interface RmaState {
  initCount?: number;
  initSum?: number;
  prevRma?: number;
}

// ta.rma - Wilder's smoothing: ta.ema's seed and na handling (ref_v6_ta_math.txt pine_rma seeds
// with `ta.sma(src, length)`; "`na` values in the `source` series are ignored"), alpha = 1 / length.
// The manual writes the step as `alpha * src + (1 - alpha) * nz(sum[1])`; TradingView computes
// `(prev * (length - 1) + source) / length`, a different rounding: tier 1 ta_245_ema_rma_exact logs
// rma(a, 3) and rma(a, 5) at exactly their probe values, which the alpha form misses by one and two
// ulps (oracle pynecore lib/ta.py rma, "Measured law (probes m558)": "This is NOT ``ema`` with
// alpha = 1 / length -- both alpha shapes drift from TradingView on the majority of bars").
// Length 1 is the identity (the oracle's shortcut).
export function rma(state: RmaState, value: number, length: number): number {
  if (state.initCount === undefined) {
    state.initCount = 0;
    state.initSum = 0;
    state.prevRma = NaN;
  }
  if (length === 1) return value;
  if (Number.isNaN(value)) return NaN;

  if (state.initCount < length) {
    state.initCount += 1;
    state.initSum! += value;
    if (state.initCount === length) {
      state.prevRma = state.initSum! / length;
      return state.prevRma;
    }
    return NaN;
  }

  const rmaVal = (state.prevRma! * (length - 1) + value) / length;
  state.prevRma = rmaVal;
  return rmaVal;
}

export interface CrossState {
  // crossover: source1 <= source2 on the last bar where both were defined (crossunder: >=).
  was?: boolean;
  // ta.cross: the last tolerantly unequal relation, -1 below, +1 above, 0 none yet.
  armed?: number;
}

// The three crosses compare against the last bar where both sources were defined, not the
// previous bar: a bar with an na source returns a bool na and leaves the state alone (tier 1
// ta_374_cross_bool_na: `up` na on bar 5, 0 on bar 4 and 2 on bar 6, `ta.crossover(up, 1.0)` is na
// on bar 5 and true on bar 6; oracle pynecore lib/ta.py crossover: "TV compares against the last
// bar where both sources were defined, so na gaps must not reset it"). A bool na exists up to v5
// only ("Values of the bool type are now strictly true or false. They are never na in v6", rn.txt),
// so `naBool` (codegen: the script's version is below 6) chooses NaN, resin's bool na, over false.
//
// ta.crossover: "on the current bar, the value of `source1` is greater than the value of `source2`,
// and on the previous bar, the value of `source1` was less than or equal to the value of `source2`"
// (ref_v6_ta_math.txt). The comparison is raw, not the operators' tolerant one: TradingView fires
// and blocks on a 5e-11 step (oracle lib/ta.py crossover, "Measured EXACT rule", probes S1-S9).
// The first defined bar has no previous relation and yields false.
export function crossover(state: CrossState, a: number, b: number, naBool = false): boolean | number {
  if (a !== a || b !== b) return naBool ? NaN : false;
  const res = a > b && state.was === true;
  state.was = a <= b;
  return res;
}

// ta.crossunder, the mirror of crossover: "the value of `source1` is less than the value of
// `source2`, and on the previous bar, the value of `source1` was greater than or equal to the value
// of `source2`" (ref_v6_ta_math.txt).
export function crossunder(state: CrossState, a: number, b: number, naBool = false): boolean | number {
  if (a !== a || b !== b) return naBool ? NaN : false;
  const res = a < b && state.was === true;
  state.was = a >= b;
  return res;
}

// ta.cross is not `crossover or crossunder`: it remembers the last relation that was unequal beyond
// the comparison tolerance (1e-10, as pineLt & co.) and fires on a strict move to the other side of
// it. It starts with no relation, so a plateau of equality from the first bar never fires, and an
// equality run keeps the relation from before it, so a move back to the side it came from does not
// fire either (tier 1 ta_113_cross_plateau: 1,1,…,2 against 1 fires ta.crossover but not ta.cross;
// 0,0,0,1,1,1,0 against 1 fires ta.crossunder but not ta.cross; 0,0,0,1,1,1,2 fires both; oracle
// pynecore lib/ta.py cross, "Measured: ta.cross is NOT crossover or crossunder", probes U-I).
export function cross(state: CrossState, a: number, b: number, naBool = false): boolean | number {
  if (a !== a || b !== b) return naBool ? NaN : false;
  const armed = state.armed ?? 0;
  const res = (armed < 0 && a > b) || (armed > 0 && a < b);
  const diff = a - b;
  if (diff < -CROSS_EPS) state.armed = -1;
  else if (diff > CROSS_EPS) state.armed = 1;
  return res;
}

// The equality band ta.cross shares with the comparison operators (numeric.ts CMP_EPS; oracle
// core/pine_compare.py EPSILON).
const CROSS_EPS = 1e-10;

export interface WmaState {
  buffer?: number[];
  writeIdx?: number;
  count?: number;
  last?: number;
}

// ta.wma - Weighted Moving Average, weight(oldest)=1 ... weight(newest)=length. The reference only
// says "`na` values in the `source` series are ignored" (ref_v6_ta_math.txt ta.wma); TradingView
// runs it as the oracle measured it (pynecore lib/ta.py wma, probes m560):
//   - an na source is na on its bar and does NOT compact the window: the call still advances it by
//     one, carrying the last non-na value forward ("an na bar carries the previous value forward, so
//     the average runs over the last `length` bars, not over the last `length` non-na values");
//   - na until `length` non-na values have arrived (a leading na stays out of every window);
//   - the window advances once per execution of the call site, not once per bar (a builtin's own
//     series count its executions: pynecore core/series.py `compacted`, set for the lib machines,
//     turns off the per-bar fill script series get), so a gated call averages its own last `length`
//     executions (twin gated_wma); a loop site re-derives each same-bar execution from the bar-start
//     state (rt.ta.loopState);
//   - the weighted sum is re-run over the whole window on every bar, oldest first
//     (`summ = summ + y * weight`, weight 1, 2, ... length): "summing newest-first, or weighting
//     with (length - i) * length the way the reference pseudocode does, drifts on more than half of
//     the bars ... an O(1) rolling update gives different last bits" (tier 1 ta_246_wma_exact
//     prints the difference to TradingView's value times 1e15). The divisor is 1 + 2 + ... + length,
//     an integer the double holds exactly.
export function wma(state: WmaState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (!(length >= 1)) return NaN; // the oracle asserts length > 0: no answer to follow
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.count = 0;
    state.last = NaN;
  }
  const sourceNa = Number.isNaN(value);
  if (!sourceNa) {
    state.count! += 1;
    state.last = value;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = state.last!;
  state.writeIdx = (writeIdx + 1) % length;
  if (sourceNa || state.count! < length) return NaN;

  // The oldest slot is the one written next.
  const oldest = state.writeIdx;
  let summ = 0;
  let weight = 0;
  for (let i = 0; i < length; i++) {
    weight += 1;
    summ = summ + buffer[(oldest + i) % length]! * weight;
  }
  return summ / ((length * (length + 1)) / 2);
}

export interface AlmaState {
  buffer?: number[];
  writeIdx?: number;
  weights?: number[];
  weightSum?: number;
}

// ta.alma - Arnaud Legoux Moving Average: Gaussian-weighted moving average,
// weight(i) = exp(-((i-m)^2)/(2*s*s)) with m=offset*(length-1), s=length/sigma
// (i=0=oldest in window .. i=length-1=newest). **명시적 GOAL.md 예외**(사이클 조사로 확정,
// MEMORY.md Architecture Decisions 참조): ta.wma(C28)의 선형 가중치(1..length)는 창이 한 바
// 밀릴 때 대수적 재귀식(S_{t+1}=S_t-Sum_t+newValue*length)으로 O(1) 갱신되지만, ALMA의 임의(비-
// 등차/비-등비) Gaussian 가중치는 원소 하나가 빠지고 들어올 때 나머지 원소 전원의 가중치 인덱스가
// 함께 밀리므로(w_i가 상수 배율/오프셋 관계가 아님) 그런 재귀식이 존재하지 않는다 — 매 바
// weightedTotal을 O(length) 재스캔해야 한다(pine2py wavealgo/ta/alma.py도 매 바 전체 재계산).
// 단 weight 배열 자체는 length/offset/sigma가 콜사이트 최초 호출 값으로 고정되므로(sma의 length
// 버퍼 크기 고정과 동일 전제) 최초 1회만 계산해 캐시(GOAL.md "bar loop 안 할당 제로" 준수). 값
// 버퍼는 sma/wma와 동일한 NaN-프라임 순환 버퍼(poison window — 창 안 하나라도 NaN이면 전체 NaN,
// 워밍업 미달도 이 버퍼가 아직 NaN 슬롯을 갖고 있는 것으로 동일하게 흡수). python 2,000건 fuzz로
// 검증(scratch 삭제됨, PROGRESS C113 참조). **의도적 divergence**: pine2py는 sigma=0에서
// `length/sigma`가 ZeroDivisionError로 크래시하지만, JS는 0-나눗셈이 Infinity를 내고
// (i-m)^2/Infinity가 0으로 수렴해 모든 weight가 1.0(균등 가중 — SMA와 동치)이 되는 well-defined
// 값을 낸다 — GOAL.md "알려진 버그는 따르지 않는다" 적용, DIVERGENCES.md 신규 항목 참조.
// `floor` (the optional fifth argument, default false) floors the Gaussian's centre before the
// weights are built: ref_v6_ta_math.txt "ta.alma" "ARG floor [simple bool]: An optional parameter.
// Specifies whether the offset calculation is floored before ALMA is calculated. Default value is
// false", pine_alma "m = math.floor(offset * (windowsize - 1)) // Used as m when math.floor=true"
// (oracle lib/ta.py alma `math.floor(offset * (length - 1))`).
export function alma(state: AlmaState, value: number, length: number, offsetMult: number, sigma: number, floor: boolean = false): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조). offsetMult/sigma는 TV 자체가 simple float라 대상 아님
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    const m = floor ? Math.floor(offsetMult * (length - 1)) : offsetMult * (length - 1);
    const s = length / sigma;
    const weights = new Array(length);
    let weightSum = 0;
    for (let i = 0; i < length; i++) {
      const w = Math.exp(-((i - m) ** 2) / (2 * s * s));
      weights[i] = w;
      weightSum += w;
    }
    state.weights = weights;
    state.weightSum = weightSum;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  if (state.weightSum === 0) return NaN;

  const oldestPos = state.writeIdx;
  const weights = state.weights!;
  let weightedTotal = 0;
  for (let i = 0; i < length; i++) {
    const v = buffer[(oldestPos + i) % length]!;
    if (Number.isNaN(v)) return NaN;
    weightedTotal += v * weights[i]!;
  }
  return weightedTotal / state.weightSum!;
}

export interface CogState {
  buffer?: number[];
  writeIdx?: number;
  count?: number;
  sum?: number;
  weightedSum?: number;
  value?: number;
}

// ta.cog - Center of Gravity: -num / sum over the window, num = Σ source[i] * (i + 1) with i = 0 the
// newest value (ref_v6_ta_math.txt pine_cog: `num := num + price * (i + 1)`, `-num / sum`).
// The window is the last `length` NON-na values: "`na` values in the `source` series are ignored"
// (ref_v6_ta_math.txt ta.cog). An na bar stores nothing and answers the value the window held; the
// warm-up lasts until `length` non-na values exist (state/repros/cog-na-window.json, oracle lib/ta.py
// cog "NA values are NOT stored in the buffer, only skipped"). The ring holds those values, so the one
// leaving is the one `length` non-na values back. Running sums in the oracle's arithmetic:
// weightedSum = Σ source[i] * i, and each new value shifts every weight up by one, i.e.
// weightedSum += sum - length * leaving; the result is -weightedSum / sum - 1. A zero sum gives na.
export function cog(state: CogState, value: number, length: number): number {
  length = Math.trunc(length);
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.count = 0;
    state.sum = 0;
    state.weightedSum = 0;
    state.value = NaN;
  }
  if (Number.isNaN(value)) return state.count! < length ? NaN : state.value!;
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  if (state.count! < length) {
    state.count! += 1;
    state.sum! += value;
    state.weightedSum! += value * (length - state.count!);
    buffer[writeIdx] = value;
    state.writeIdx = (writeIdx + 1) % length;
    if (state.count! < length) return NaN;
  } else {
    const leaving = buffer[writeIdx]!;
    const sum = state.sum!;
    state.weightedSum = state.weightedSum! + sum - length * leaving;
    state.sum = sum + value - leaving;
    buffer[writeIdx] = value;
    state.writeIdx = (writeIdx + 1) % length;
  }
  const sum = state.sum!;
  state.value = sum === 0 ? NaN : -state.weightedSum! / sum - 1;
  return state.value;
}

export interface HmaState {
  half?: WmaState;
  full?: WmaState;
  outer?: WmaState;
}

// ta.hma - Hull Moving Average: HMA = WMA(2*WMA(src,half_len) - WMA(src,length), sqrt_len), where
// half_len=max(1,trunc(length/2)) and sqrt_len=max(1,trunc(sqrt(length))) (pine2py
// wavealgo/ta/hma.py). Both are pure derivations of `length`, so — exactly like sma's buffer size
// (C16) — they're safe to fix from the first call's `length` value only; TA_REGISTRY.lengthArgIndex
// hard-errors a series length the same way it does for sma, guaranteeing this.
// It runs rt.ta.wma three times (half/full/outer) inside one taSlot's state object, the way the
// oracle does (pynecore lib/ta.py hma): an na source returns na before either inner wma runs, and
// the outer wma runs only when both inner ones are valued. A wma that does not run does not advance
// (a builtin's window counts its executions), so an na source leaves all three windows where they
// were — unlike ta.wma's own na, which advances its window with the last value carried forward.
export function hma(state: HmaState, value: number, length: number): number {
  if (state.half === undefined) {
    state.half = {};
    state.full = {};
    state.outer = {};
  }
  if (Number.isNaN(value)) return NaN;
  const halfLen = Math.max(1, Math.trunc(length / 2));
  const sqrtLen = Math.max(1, Math.trunc(Math.sqrt(length)));

  const wmaHalf = wma(state.half, value, halfLen);
  const wmaFull = wma(state.full!, value, length);
  if (Number.isNaN(wmaHalf) || Number.isNaN(wmaFull)) return NaN;

  const diff = 2 * wmaHalf - wmaFull;
  return wma(state.outer!, diff, sqrtLen);
}

export interface AoState {
  fast?: SmaState;
  slow?: SmaState;
}

// ta.ao() - Awesome Oscillator: AO = SMA(hl2,5) - SMA(hl2,34) (표준 TV 공식 정의, analyzer.ts
// TA_REGISTRY.ao 주석 참조). Pine 문법상 인자가 없고 hl2를 내장 파생 bar series로 암묵 사용한다
// (codegen.ts genCallExpr의 obv/accdist implicit-injection 그룹과 동일 패턴). pine2py wavealgo/ta/에
// 대응 구현이 전혀 없어 오라클 대조 자체가 불가능한 hand-verified 신규 함수(DIVERGENCES.md #175) —
// 이미 오라클로 검증된 sma()를 두 겹(5바/34바) 독립 상태로 재사용한다(hma()의 다중 서브버퍼 패턴과
// 동일). sma()가 na hl2를 자체적으로 건너뛰고(naSkipSum 참조) 워밍업 중엔 NaN을 반환하므로 별도
// 가드 없이 뺄셈이 워밍업 NaN을 자연히 전파한다.
export function ao(state: AoState, hl2: number): number {
  if (state.fast === undefined) {
    state.fast = {};
    state.slow = {};
  }
  const fastVal = sma(state.fast, hl2, 5);
  const slowVal = sma(state.slow!, hl2, 34);
  return fastVal - slowVal;
}

export interface LinregState {
  buf?: Float64Array; // the non-na sources in arrival order, read modulo buf.length
  size?: number; // non-na sources stored so far
  count?: number; // warm-up counter: one more per stored source while it is below the length
  val?: number; // the last full-window value, held while the source is na
  constLen?: number; // the length sumX/denom were accumulated for
  sumX?: number;
  denom?: number;
}

// ta.linreg - TradingView's least-squares line. ref_v6_ta_math.txt "ta.linreg": "linreg = intercept +
// slope * (length - 1 - offset), where intercept and slope are the values calculated with the least
// squares method on `source` series" — the line is evaluated `offset` bars BACK from the newest bar
// (resin had pine2py's `n - 1 + offset`, projecting forward; tier 1 resin-harness
// suites/indicators/tv/ta_181_linreg: linreg(close, 20, 10) is 1.06784563158 on bar 19, resin had
// 1.06596036842). The rest is the oracle's TradingView-measured machine (PyneCore lib/ta.py linreg):
// - length (and offset) are truncated to ints; length 1 returns the source as is and stores nothing;
// - an na source is skipped: nothing is stored and the last full-window value is held (na while
//   warming up), so the window is the last `length` NON-na sources;
// - the value is na until `length` sources have been stored;
// - TradingView recomputes the window every bar, oldest first with x = 1..length ("its distance from
//   the exact rational result stays flat over 22k bars ... while a rolling update of the two sums
//   drifts"), and anchors the line one step short: intercept = sumY / length - slope * sumX / length
//   + slope ("the algebraically equal intercept + slope * (length - offset) rounds differently and
//   misses TradingView on a quarter to a half of the bars"). The arithmetic below is in that order.
// A length below 1 is na here (the oracle rejects it with an assertion).
function linregStep(state: LinregState, value: number, length: number, offset: number): number {
  length = Math.trunc(length);
  offset = Math.trunc(offset);
  if (!(length >= 1)) return NaN;
  if (length === 1) return value;
  if (Number.isNaN(value)) return state.count! < length ? NaN : state.val!;

  const buf = state.buf!;
  const cap = buf.length;
  buf[state.size! % cap] = value;
  state.size = state.size! + 1;
  if (state.count! < length) {
    state.count = state.count! + 1;
    if (state.count < length) return NaN;
  }

  if (state.constLen !== length) {
    let sx = 0;
    let sx2 = 0;
    for (let i = 1; i <= length; i++) {
      sx = sx + i;
      sx2 = sx2 + i * i;
    }
    state.constLen = length;
    state.sumX = sx;
    state.denom = length * sx2 - sx * sx;
  }
  const sumX = state.sumX!;

  let sumY = 0;
  let sumXY = 0;
  let per = 0;
  for (let i = state.size - length; i < state.size; i++) {
    const y = buf[i % cap]!;
    per = per + 1;
    sumY = sumY + y;
    sumXY = sumXY + y * per;
  }
  const slope = (length * sumXY - sumX * sumY) / state.denom!;
  const average = sumY / length;
  const intercept = average - (slope * sumX) / length + slope;
  state.val = intercept + slope * (length - 1 - offset);
  return state.val;
}

// Fixed length: a ring of `length` slots holds the window. offset defaults to 0 (C252 2-arg form).
export function linreg(state: LinregState, value: number, length: number, offset: number = 0): number {
  const len = Math.trunc(length);
  if (state.buf === undefined) {
    if (!(len >= 1)) return NaN;
    state.buf = new Float64Array(len);
    state.size = 0;
    state.count = 0;
    state.val = NaN;
  } else if (len > state.buf.length) {
    // A longer length than the ring holds (a fixed-length call site never does this): keep the
    // stored sources, oldest first, in a ring of the new size.
    const old = state.buf;
    const grown = new Float64Array(len);
    const kept = Math.min(state.size!, old.length);
    for (let k = 0; k < kept; k++) grown[k] = old[(state.size! - kept + k) % old.length]!;
    state.buf = grown;
    state.size = kept;
  }
  return linregStep(state, value, length, offset);
}

export interface VwmaState {
  pv?: SmaState; // ta.sma(source * volume, length)
  v?: SmaState; // ta.sma(volume, length)
}

// ta.vwma - Volume-Weighted Moving Average, literally the reference's quotient of two ta.sma calls:
// "It is the same as: sma(source * volume, length) / sma(volume, length)" (ref_v6_ta_math.txt
// ta.vwma, REMARKS "`na` values in the `source` series are ignored"; the oracle's lib/ta.py vwma is
// that one line). So the two averages keep their own na-skipping windows (naSkipSum): an na source
// makes source * volume na, which the numerator skips while the denominator still takes the bar's
// volume. The value is therefore not a single window's Σ(p·v)/Σ(v): resin had pine2py's poison
// window (na for `length` bars after one na source; resin-harness state/repros/ta.serieslen-seed-2.json,
// source na every third bar, oracle 103.84687083695336 on bar 16 where resin had na). The quotient is
// Pine's `/`: a window of zero volume is 0 / 0 = na (see iii below).
export function vwma(state: VwmaState, price: number, volume: number, length: number): number {
  if (state.pv === undefined) {
    state.pv = {};
    state.v = {};
  }
  return sma(state.pv, price * volume, length) / sma(state.v!, volume, length);
}

export interface SwmaState {
  v0?: number;
  v1?: number;
  v2?: number;
  v3?: number;
}

// ta.swma - Symmetrically Weighted Moving Average: length 인자가 없는 고정 4-tap 가중평균
// (weights=[1,2,2,1]/6, v0=현재 바 ~ v3=3바 전). pine2py wavealgo/ta/swma.py는 source.get(0..3)로
// 진짜 Series 히스토리를 스캔하는데, 1바 1회 호출 전제(ta.* 조건부 블록 금지와 동일 이유) 하에서는
// "직전 3회 호출 값을 기억"하는 것과 "3바 전까지 히스토리 조회"가 완전히 동치다(crossover의
// aPrev/bPrev와 같은 원리). 창 폭이 컴파일타임에 고정 4라 sma/wma처럼 순환 버퍼+모듈로 인덱싱이
// 필요 없이 4개 스칼라 shift register만으로 충분하다(GOAL.md "바당 히스토리 재계산 금지"). pine2py는
// data_len<4(첫 3바)와 window 안 NaN 값을 별도 분기로 검사하지만 둘 다 결과는 동일하게 NaN이므로,
// NaN-프라임 shift register 하나로 두 경우를 자연스럽게 통합했다(별도 카운터 불필요 — sma의
// NaN-프라임 버퍼와 동일한 원칙).
export function swma(state: SwmaState, value: number): number {
  if (state.v0 === undefined) {
    state.v0 = NaN;
    state.v1 = NaN;
    state.v2 = NaN;
    state.v3 = NaN;
  }
  const oldV0 = state.v0!;
  const oldV1 = state.v1!;
  const oldV2 = state.v2!;
  state.v3 = oldV2;
  state.v2 = oldV1;
  state.v1 = oldV0;
  state.v0 = value;

  if (Number.isNaN(value) || Number.isNaN(oldV0) || Number.isNaN(oldV1) || Number.isNaN(oldV2)) return NaN;
  return (state.v3 * 1 + state.v2 * 2 + state.v1 * 2 + state.v0 * 1) / 6;
}

export interface CmoState {
  prevValue?: number;
  up?: SmaState; // math.sum of the rising momenta
  down?: SmaState; // math.sum of the falling momenta, negated
}

// ta.cmo(series, length), the manual's reference (ref_v6_ta_math.txt f_cmo): mom = ta.change(src),
// sm1 = math.sum(mom >= 0 ? mom : 0.0, length), sm2 = math.sum(mom >= 0 ? 0.0 : -mom, length),
// 100 * (sm1 - sm2) / (sm1 + sm2) — the same rule as cmoVarLen, on a fixed length.
// - The momentum is the change from the previous bar, na when either bar is na; an na momentum
//   returns na and feeds neither sum (oracle lib/ta.py cmo).
// - The sign test is tolerant: a momentum within Pine's 1e-10 of zero counts as rising (tier 1
//   ta_241_tolerant_compare, TradingView probe m548: `ta.cmo(r, 4)` over a series stepping by 1e-12
//   is NaN, both sums collapsing to 0 as the up side takes the negative steps too; resin's exact
//   `mom >= 0` gave 0). A sub-tolerance negative momentum in an otherwise flat window leaves sm1
//   alone nonzero, so the oscillator is 100, not -100.
// - Both sums are math.sum itself (naSkipSum: TradingView's rolling compensated sum), not a plain
//   `sum - old + new`.
// - Both sums zero is 0/0: na, not 0 (oracle lib/ta.py cmo "TradingView's 0/0 is nan").
export function cmo(state: CmoState, value: number, length: number): number {
  if (state.up === undefined) {
    state.prevValue = NaN;
    state.up = {};
    state.down = {};
  }
  const mom = value - state.prevValue!;
  state.prevValue = value;
  if (Number.isNaN(mom)) return NaN;
  const rising = mom >= -PINE_EPS;
  const sum1 = naSkipSum(state.up, rising ? mom : 0, length);
  const sum2 = naSkipSum(state.down!, rising ? 0 : -mom, length);
  const total = sum1 + sum2;
  if (total === 0) return NaN;
  return (100 * (sum1 - sum2)) / total;
}

// ta.cci(source, length) (lib/ta.py cci): mean = ta.sma(source, length), mdev = ta.dev(source,
// length) around that mean (0 for length 1), (source - mean) / (0.015 * mdev) — the same rule as
// cciVarLen, on a fixed length. The mean is ta.sma's machine, not a plain sum of the window: on a
// flat window the machine can keep one ulp of dust, which the deviation then divides by itself
// (resin-harness state/repros/ta.osc-seed-50.json, ta.cci(hl2, 3) on bar 114: 66.67 on the oracle,
// 0/0 with a plain sum). The deviation reads the last `length` bars as ta.dev does, so an na bar
// makes it na until it leaves the window (state/repros/ta.osc-seed-6.json: after 28 na bars,
// ta.cci(s, 21) is na on the next bar, where a window frozen across the gap gave 443.96). A zero
// deviation divides to a non-finite value, na on a plot, not 0 (see "Division by zero" at ta.iii).
export function cci(state: DevState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (!(length >= 1)) return NaN;
  const mean = sma((state.mean ??= {}), value, length);
  recordLastBars(state, value, length);
  const mdev = length === 1 ? 0 : Number.isNaN(mean) ? NaN : lastBarsMeanAbsDev(state, length, mean);
  if (Number.isNaN(mdev)) return NaN;
  return (value - mean) / (0.015 * mdev);
}

export interface ChangeState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.change/ta.mom - 현재 값과 length바 전 값의 차이(source.get(0) - source.get(length)).
// pine2py wavealgo/ta/change.py에서 mom()이 change()에 인자를 그대로 전달해 호출하는 완전한
// 별칭임을 확인 — TA_REGISTRY.mom은 별도 rt 함수 없이 이 change()를 rtPath로 그대로 재사용한다
// (analyzer.ts TA_REGISTRY 참조). value를 그대로 기억하는 고정폭 length 순환 버퍼로 이식했다 —
// sma/wma처럼 "항상 push"하되(cmo의 "momentum NaN이면 스킵"과 다름: change/mom은 파생 집계값이
// 아니라 원본 source 값 자체를 히스토리로 저장해야 하므로, crossover/swma와 동일한 raw-passthrough
// 원칙 적용), sum 누산이 필요 없어 sma보다 더 단순하다(그냥 evict되는 old값을 반환값 계산에만
// 쓰고 버린다). 버퍼가 NaN-프라임이라 pine2py의 두 분기 — "아직 length바 전 값이 없음"
// (data_len<=length) 과 "그 위치의 값이 실제 na"(isnan(prev)) — 가 old===NaN 검사 하나로
// 자연스럽게 통합된다(sma와 동일 원칙). length 기본값 1(TV/pine2py 둘 다 동일) — mom은 length가
// 필수인 별도 TV 시그니처라 이 기본값은 change 경유 호출에만 실질적으로 쓰인다(TA_REGISTRY.change
// minArgCount:1, C227).
export function change(state: ChangeState, value: number, length: number = 1): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(value) || Number.isNaN(oldVal)) return NaN;
  return value - oldVal;
}

export interface RocState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.roc - Rate of Change: 100*(curr-prev)/prev, prev=source.get(length). pine2py
// wavealgo/ta/roc.py 소스 대조 결과 change()와 완전히 동일한 NaN-프라임 순환 버퍼 상태(value를
// 그대로 저장하는 raw-passthrough, crossover/swma/change와 동일 원칙)를 쓰지만 반환 산식이 달라
// alias 재사용(mom처럼 rtPath 공유)이 불가능하다 — 반환 로직 자체가 change와 다르므로 별도 함수로
// 이식. change엔 없는 prev===0 나눗셈 가드가 change()의 두 NaN 검사(현재/직전 값)와 같은 분기에
// 있어(pine2py roc.py) 셋 다 동일하게 NaN을 반환한다.
export function roc(state: RocState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(value) || Number.isNaN(oldVal) || oldVal === 0) return NaN;
  return (100 * (value - oldVal)) / oldVal;
}

export interface StreakState {
  prevValue?: number;
  streak?: number;
}

// ta.rising(source, length): the source rose on each of the last `length` bar-to-bar steps
// (ref_v6_ta_math.txt "ta.rising": "Test if the `source` series is now rising for `length` bars
// long"). A streak counter: a step up continues it, anything else (a flat or falling step, an na on
// either side) resets it to 0; true once it reaches `length`. The counter keeps no window, so a
// series length is safe (TA_REGISTRY lengthArgIndex null).
// The step test is tolerant: a rise of at most Pine's 1e-10 is not a rise, while ta.highest and
// ta.crossover stay bit-exact (tier 1 ta_241_tolerant_compare, TradingView probes m547/m548:
// `ta.rising(r, 1)` and `ta.falling(r, 1)` are false on every bar of a series stepping by 1e-12
// around 100, true for the 1e-8 control; oracle lib/ta.py rising `source - last_val > _EPSILON`).
// resin-harness state/repros/ta.extremes-seed-32.json: ta.rising(ohlc4, 5) on bar 299, where bar
// 297's ohlc4 sits one ulp (1.4e-14) above bar 296's: false on the oracle, true bit-exact.
export function rising(state: StreakState, value: number, length: number): boolean {
  if (state.prevValue === undefined) {
    state.prevValue = NaN;
    state.streak = 0;
  }
  const prev = state.prevValue;
  state.prevValue = value;
  // An na on either side makes the difference NaN, and NaN > PINE_EPS is false: a reset.
  state.streak = value - prev > PINE_EPS ? state.streak! + 1 : 0;
  return state.streak >= length;
}

// ta.falling(source, length): rising's mirror, a step down by more than Pine's 1e-10 (see rising;
// oracle lib/ta.py falling `last_val - source > _EPSILON`).
export function falling(state: StreakState, value: number, length: number): boolean {
  if (state.prevValue === undefined) {
    state.prevValue = NaN;
    state.streak = 0;
  }
  const prev = state.prevValue;
  state.prevValue = value;
  state.streak = prev - value > PINE_EPS ? state.streak! + 1 : 0;
  return state.streak >= length;
}

export interface StdevState {
  p?: SmaState; // math.sum(source, length)
  q?: SmaState; // math.sum(source * source, length)
  sum?: number; // the last bar's p: ta.bb's basis is it / length
}

// ta.variance(source, length, biased): "`na` values in the `source` series are ignored; the
// function calculates on the `length` quantity of non-`na` values" (ref_v6_ta_math.txt
// "ta.variance", "ta.stdev"). The oracle's measured law (pynecore lib/ta.py variance, probes m556):
// p = math.sum(source, length), q = math.sum(source * source, length), m = p / length; biased
// max(0, q / length - m * m), unbiased max(0, q / (length - 1) - p * m / (length - 1)), an
// unbiased length 1 na. Both sums are naSkipSum windows, so an na bar neither enters nor evicts
// and reports the standing variance (repro state/repros/ta.volatility-seed-10.json, probe I01).
// resin used to keep pine2py's window, na for `length` bars after one na source. varianceVarLen
// is the same law with a series length.
export function variance(state: StdevState, value: number, length: number, biased: boolean = true): number {
  const len = Math.trunc(length);
  if (state.p === undefined) {
    state.p = {};
    state.q = {};
  }
  const p = naSkipSum(state.p, value, len);
  const q = naSkipSum(state.q!, value * value, len);
  state.sum = p;
  if (!(len >= 1) || Number.isNaN(p) || Number.isNaN(q)) return NaN;
  if (!biased && len === 1) return NaN;
  const m = p / len;
  const v = biased ? q / len - m * m : q / (len - 1) - (p * m) / (len - 1);
  // Python's max(0.0, var): the clamp keeps 0.0 unless var is greater.
  return v > 0 ? v : 0;
}

// ta.stdev(source, length[, biased]) = sqrt(ta.variance) (lib/ta.py stdev, "TradingView's stdev
// is exactly sqrt of its variance on both paths", probes m556).
export function stdev(state: StdevState, value: number, length: number, biased: boolean = true): number {
  return Math.sqrt(variance(state, value, length, biased));
}

export interface BbState {
  inner?: StdevState;
}

// ta.bb(series, length, mult) (lib/ta.py bb): basis = ta.sma(series, length), deviation = mult *
// ta.stdev(series, length); a na basis is the na triple. The sma's window is the variance's first
// sum, so the basis is read from it.
export function bb(
  state: BbState,
  value: number,
  length: number,
  mult: number,
  scratch: Float64Array,
): void {
  if (state.inner === undefined) state.inner = {};
  const sd = Math.sqrt(variance(state.inner, value, length));
  const len = Math.trunc(length);
  const middle = len >= 1 ? state.inner.sum! / len : NaN;
  if (Number.isNaN(middle)) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }
  const dev = sd * mult;
  scratch[0] = middle;
  scratch[1] = middle + dev;
  scratch[2] = middle - dev;
}

// ta.bbw(series, length, mult) (lib/ta.py bbw): ((upper - lower) / basis) * 100 of ta.bb, na when
// the basis is na or zero.
export function bbw(
  state: BbState,
  value: number,
  length: number,
  mult: number,
): number {
  if (state.inner === undefined) state.inner = {};
  const sd = Math.sqrt(variance(state.inner, value, length));
  const len = Math.trunc(length);
  const basis = len >= 1 ? state.inner.sum! / len : NaN;
  if (Number.isNaN(basis) || basis === 0) return NaN;
  const dev = sd * mult;
  return ((basis + dev - (basis - dev)) / basis) * 100;
}

export interface CumState {
  sum?: number;
}

// ta.cum(source) - the running total of `source` since the first bar, starting from 0 (no warm-up).
// An na source is na on its own bar and leaves the total alone, so the next bar continues from the
// standing sum. TradingView measures it: ta.obv and ta.pvt are na on bar 0 (tier 1 ta_051_iii_nvi_obv,
// ta_341_accdist_pvi_pvt_wad_wvad), where the manual defines them as `ta.cum(...)` of an expression
// whose `ta.change(close)` is na (ref_v6_ta_math.txt "f_obv() => ta.cum(math.sign(ta.change(close))
// * volume)"). Oracle pynecore lib/ta.py cum: `if not (source == source): return na_float`. pine2py
// summed an na as 0 and returned the standing sum.
export function cum(state: CumState, value: number): number {
  if (state.sum === undefined) {
    state.sum = 0;
  }
  if (Number.isNaN(value)) return NaN;
  state.sum += value;
  return state.sum;
}

export interface CumExtremeState {
  extreme?: number;
}

// ta.max(source)/ta.min(source) — 소스 전체(첫 바부터 현재 바까지) 누적 극값. Pine v6에서 신설된
// 것으로 추정되는 함수(배치25 (3), DIVERGENCES.md #176) — pine2py wavealgo/에 대응 구현이 전혀
// 없어(전수 grep 0건) cum(C37)의 형제 함수로 hand-verified. NaN 입력은 cum과 동일하게 "무시하고
// 직전 값 유지"하지만, cum의 항등원 0(덧셈)과 달리 max/min에는 자연스러운 항등원이 없어 첫 유효값을
// 만나기 전까지는 NaN을 유지한다(cum처럼 임의의 초기값으로 극값 상태를 오염시키지 않음).
export function cumMax(state: CumExtremeState, value: number): number {
  if (Number.isNaN(value)) return state.extreme === undefined ? NaN : state.extreme;
  if (state.extreme === undefined || value > state.extreme) state.extreme = value;
  return state.extreme;
}

export function cumMin(state: CumExtremeState, value: number): number {
  if (Number.isNaN(value)) return state.extreme === undefined ? NaN : state.extreme;
  if (state.extreme === undefined || value < state.extreme) state.extreme = value;
  return state.extreme;
}

export interface BarsSinceState {
  count?: number;
}

// ta.barssince(condition) - 마지막으로 condition이 true였던 이후 바 수(한 번도 true였던 적 없으면
// NaN). pine2py wavealgo/ta/barssince.py 소스 대조 결과 카운터 하나(state["count"]) 뿐인 단일
// 상태 — cum(C37)만큼 단순하지만 NaN 처리는 또 다른(다섯 번째) 모양이다: 초기값이 NaN-프라임(cum의
// 0.0 초기값과 다름)이고, val이 truthy면 count=0으로 리셋, falsy면 count가 NaN이 아닐 때만 +1(count가
// 이미 NaN이면 "한 번도 true였던 적 없음"을 나타내며 그대로 NaN 유지 — sma/wma의 "버퍼가 덜 참"
// 워밍업과 달리 워밍업 종료 조건 자체가 없고 오직 condition의 최초 true 여부로만 NaN이 풀린다).
export function barssince(state: BarsSinceState, val: boolean): number {
  if (state.count === undefined) {
    state.count = NaN;
  }
  if (val) {
    state.count = 0;
  } else if (!Number.isNaN(state.count)) {
    state.count = state.count + 1;
  }
  return state.count;
}

export interface ValueWhenState {
  buffer?: number[];
  writeIdx?: number;
  filled?: number;
}

// ta.valuewhen(condition, source, occurrence) - condition이 true였던 occurrence번째(0=가장 최근)
// 시점의 source 값. pine2py wavealgo/ta/barssince.py의 valuewhen() 소스 대조 결과 "history.insert(0,
// val) 후 occurrence+1개로 truncate"하는 bounded 리스트 상태 — sma의 순환 버퍼와 동일한 발상으로
// occurrence+1 크기 고정폭 버퍼(buffer/writeIdx)에 filled(유효 원소 수, size 상한)를 더해 이식했다.
// occurrence는 TA_REGISTRY.lengthArgIndex(analyzer.ts)로 series면 하드 에러 처리 — sma의 length와
// 동일하게 첫 호출 값으로 버퍼 크기를 한 번만 굳히므로(other TA와 동일 원칙) series는 위험하다.
// condition이 true인 바에서만 buffer[writeIdx]=value로 덮어쓰고 writeIdx를 전진시키며(false인 바는
// 버퍼를 전혀 건드리지 않음 — pine2py가 insert 자체를 생략하는 것과 동치), filled가 아직 size에
// 못 미치면 occurrence 인덱스가 아직 채워지지 않은 것이므로 NaN(pine2py `len(history) > occurrence`
// 가드와 동치). 가장 최근 삽입 위치는 writeIdx-1이므로, occurrence-th 최근 값은 거기서 occurrence만큼
// 역행한 위치(size로 wrap)에 있다.
export function valuewhen(state: ValueWhenState, condition: boolean, value: number, occurrence: number): number {
  occurrence = Math.trunc(occurrence); // C569: occurrence int 복원(상세는 sma() 주석 참조 — 동일 클래스, size가 버퍼 크기를 결정)
  const size = occurrence + 1;
  if (state.buffer === undefined) {
    state.buffer = new Array(size).fill(NaN);
    state.writeIdx = 0;
    state.filled = 0;
  }
  if (condition) {
    state.buffer[state.writeIdx!] = value;
    state.writeIdx = (state.writeIdx! + 1) % size;
    if (state.filled! < size) state.filled = state.filled! + 1;
  }
  if (state.filled! < size) return NaN;
  const mostRecentIdx = (state.writeIdx! - 1 + size) % size;
  const idx = (mostRecentIdx - occurrence + size) % size;
  return state.buffer[idx]!;
}

export interface ExtremeVarLenState {
  buffer?: Float64Array;
  writeIdx?: number;
  lastBarIdx?: number;
}

// ta.highest/ta.lowest/ta.highestbars/ta.lowestbars(source, length), with a literal or a series
// length: one machine, the oracle's, which reads `length` on every call (pynecore lib/ta.py
// highest/lowest; extremeRing below). Each of its rules is a TradingView measurement quoted there:
//   - an na source RESETS the machine: na on its bar (the bars form: 0 once past the warm-up), and
//     the window restarts with the next non-na value ("A na input RESETS the machine ... the reset
//     model matches TradingView on every bar ... while skipping na or keeping the window diverges
//     from the first na on", probes hina_probe/hina2_probe). This is the manual's "`na` values in the
//     `source` series are ignored" (ref_v6_ta_math.txt ta.highest): an na never becomes the extreme
//     and never blanks the next `length` bars (repro state/repros/ta.extremes-seed-7.json, probe I01);
//   - the window is a ring of `length + 1` slots addressed by bar_index and written only on the bars
//     the call runs, so a gated call serves the stale slots of its own window (tier 1
//     ta_370_gated_lowest_window);
//   - the kept extreme ages in bars, not calls: a loop call site rewrites the bar's slot;
//   - na while bar_index < length - 1;
//   - of equal extremes the offset names the OLDEST (tier 1 ta_141_highest_lowest: bar 20
//     ta.highestbars(close, 10) is -9, the tied 1.06839 at bars 11 and 13 reported at bar 11).
// An na length is na. A length below 1 runs the machine as the oracle does, which leaves nothing to
// rescan and returns the source (bars form 0; twin state/repros/extreme-varlen-sample10.json, length
// bar_index % 3); TradingView's answer there is not measured. Clamping to 0 changes no output.
export function highest(state: ExtremeRingState, value: number, length: number, barIdx: number): number {
  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  return extremeRing(state, value, Math.max(len, 0), barIdx, false);
}

export function lowest(state: ExtremeRingState, value: number, length: number, barIdx: number): number {
  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  return extremeRing(state, value, Math.max(len, 0), barIdx, true);
}

// The bars form reads the kept extreme's age. An na source reset it to 0, which is what the oracle
// returns on that bar ("the bars form returns 0 (measured, subject to the same warmup gate as any
// other bar)"). A zero offset is +0, never -0.
function extremeBars(state: ExtremeRingState, value: number, length: number, barIdx: number, low: boolean): number {
  const len = Math.max(Math.trunc(length), 0);
  if (Number.isNaN(len)) return NaN;
  extremeRing(state, value, len, barIdx, low);
  if (barIdx < len - 1) return NaN;
  const age = state.extremeIndex!;
  return age === 0 ? 0 : -age;
}

export function highestbars(state: ExtremeRingState, value: number, length: number, barIdx: number): number {
  return extremeBars(state, value, length, barIdx, false);
}

export function lowestbars(state: ExtremeRingState, value: number, length: number, barIdx: number): number {
  return extremeBars(state, value, length, barIdx, true);
}

// The series-length entry points (codegen VARLEN_RT_PATHS, which appends the bar count and index to
// every series-length call): the same machine; the ring sizes itself, so the bar count is unused.
export function highestVarLen(state: ExtremeRingState, value: number, length: number, _barCount: number, barIdx: number): number {
  return highest(state, value, length, barIdx);
}

export function lowestVarLen(state: ExtremeRingState, value: number, length: number, _barCount: number, barIdx: number): number {
  return lowest(state, value, length, barIdx);
}

export function highestbarsVarLen(state: ExtremeRingState, value: number, length: number, _barCount: number, barIdx: number): number {
  return highestbars(state, value, length, barIdx);
}

export function lowestbarsVarLen(state: ExtremeRingState, value: number, length: number, _barCount: number, barIdx: number): number {
  return lowestbars(state, value, length, barIdx);
}

// ta.sma(source, length) - length가 series인 변형(배치25 (4) 두 번째, C548). 버퍼/writeIdx/barIdx
// 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용) - 값 계산만 극값 스캔
// 대신 최근 len개 산술평균. **highest/lowest와 달리 pine2py는 이 축의 오라클이 못 된다**: pine2py
// wavealgo/ta/sma.py는 첫 성공 호출의 length로 윈도우 크기를 영구히 굳힌 채(state["window"]) 이후
// 호출은 pop/append + "현재 length"로 나누는 인크리멘탈이라, length가 바뀌면 "L0개 합 / L"이라는
// 무의미한 값이 나오고(직접 실행 실측 2026-08-01: len=[3,3,4,5,2,3,4,5]에서 bar5부터 오답), 같은 바
// 반복 호출(loop-body)은 window pop이 호출마다 일어나 상태가 바당 여러 칸 전진하는 별개 latent
// 버그도 있다(동일 실측). GOAL.md "알려진 버그는 따르지 않는다" 원칙(당일 close 체결/rt.max/#8
// atr와 동일 축)에 따라 TV 문서 정의("length바 동안의 source 산술평균")대로 hand-verified 구현하고
// DIVERGENCES에 등재한다 - 오라클은 "값이 상수로 고정된 series length"(pine2py 윈도우가 안 깨지는
// 퇴화 케이스, oracle/cases/ta_sma_varlen.pine)로만 버퍼/워밍업/NaN 메커니즘을 대조한다. 엣지:
// length=NaN은 highestVarLen과 동일하게 na 전파(TV 미검증 가설), length<1은 pine2py가 크래시하는
// 지점(len=0은 ZeroDivisionError, 음수는 다음 호출에서 빈 window pop IndexError - highest의
// -inf처럼 "크래시 없이 정의된 동작"이 아예 없음)이라 na 반환으로 자체 결정.
// The window is the last `len` NON-na values, na until that many have arrived: the fixed-length
// rule (naSkipSum), which the oracle keeps across length changes (pynecore lib/_math_stateful.py
// sum). See naSkipSumVarLen.
export function smaVarLen(state: NaSkipVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  const len = Math.trunc(length);
  const total = naSkipSumVarLen(state, value, len, barCount, barIdx);
  return len < 1 ? NaN : total / len;
}

export interface NaSkipVarLenState {
  buffer?: Float64Array; // the non-na values in arrival order
  count?: number; // values stored, this bar's included
  barStart?: number; // values stored before this bar
  lastBarIdx?: number;
  // naSkipSumVarLen's rolling machine; `entries` is indexed like `buffer` (a value's realized entry)
  entries?: Float64Array;
  sum?: number;
  comp?: number;
  window?: number; // values the sum covers
  calls?: number;
  prevLen?: number; // the last call's length, 0 before any (and after a length below 1 or na)
  chgAt?: number; // the call on which the length last changed
  bar?: number[]; // [sum, comp, window, calls, prevLen, chgAt] as the bar began
  undo?: number[]; // (position, old entry) pairs written on this bar, for a same-bar re-execution
}

// Appends a non-na value to the call site's na-compacted history (an na stores nothing) and
// returns how many values it holds. A same-bar re-execution (a loop call site) replaces the bar's
// own value instead of advancing, like the other *VarLen machines.
function recordNonNa(state: NaSkipVarLenState, value: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(Math.max(1, barCount));
    state.count = 0;
    state.barStart = 0;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.barStart = state.count;
    state.lastBarIdx = barIdx;
  }
  let count = state.barStart!;
  if (!Number.isNaN(value)) state.buffer[count++] = value;
  state.count = count;
  return count;
}

// naSkipSum with a series length: the same rolling compensated machine, which follows the length
// without restarting (pynecore lib/_math_stateful.py sum: "Pine's machine does not restart when the
// length moves (MEASURED, probe sumlen2: a length grown 1..610 reproduces a constant 610
// bit-for-bit on all 28746 bars)"). A plain linear sum of the window is not TradingView's value: on
// a flat window it gives the exact mean where the machine keeps one ulp of dust, and ta.cci divides
// that dust by itself (resin-harness state/repros/ta.serieslen-seed-14.json, ta.cci(ohlc4,
// math.min(bar_index + 1, 6)) on bar 171: -66.67 on the oracle, 0/0 before). Every non-na value is
// kept (the window may grow again), and `entries` holds each one's realized entry by position.
// Offset k (0 = this bar's value, or on an na bar the newest stored one) is position n - 1 - k.
// A moved length is walked as the oracle measured it:
//   - offsets leaving the window, oldest first, each an eviction-only step with its RAW value, the
//     newest of them (offset newW) fused with this bar's step as the steady-state eviction
//     ("MEASURED, probes sumlen3/6: the isolated 8->1, 100->1, 300->150, 610->100 and 5->3 events
//     are all bit-exact only this way");
//   - offsets entering it, oldest first, each an addition-only step whose residue becomes that
//     value's entry ("probes sumlen6/sumlen7: a 5->6, 6->7, 4->10 or 6->5 step is bit-exact");
//   - a length that changes on two calls in a row (a RUNNING length) re-baselines to the
//     newest-first raw sum of the window, raw entries, compensation cleared, once the history is
//     longer than the length ("the dense path re-baselines", probe columns saw20/50/200).
// An na bar that does not move the window reports the standing sum ("probe sumlen4"). The machine
// is bar-keyed like the other *VarLen variants: a same-bar re-execution (a loop call site) starts
// again from the bar-start state, as the oracle's loop-site rollback does. A length below 1 has no
// answer in the oracle (it asserts `length > 0`): resin keeps its na for a NaN length and 0 for an
// empty window, and the next valid length rebuilds the window from the stored history.
function naSkipSumVarLen(state: NaSkipVarLenState, value: number, len: number, barCount: number, barIdx: number): number {
  if (state.entries === undefined) {
    state.entries = new Float64Array(Math.max(1, barCount));
    state.sum = 0;
    state.comp = 0;
    state.window = 0;
    state.calls = 0;
    state.prevLen = 0;
    state.chgAt = -Infinity;
    state.bar = [0, 0, 0, 0, 0, -Infinity];
    state.undo = [];
  }
  const entries = state.entries;
  const bar = state.bar!;
  const undo = state.undo!;
  if (barIdx !== state.lastBarIdx) {
    bar[0] = state.sum!;
    bar[1] = state.comp!;
    bar[2] = state.window!;
    bar[3] = state.calls!;
    bar[4] = state.prevLen!;
    bar[5] = state.chgAt!;
  } else {
    for (let i = undo.length - 2; i >= 0; i -= 2) entries[undo[i]!] = undo[i + 1]!;
    state.sum = bar[0];
    state.comp = bar[1];
    state.window = bar[2];
    state.calls = bar[3];
    state.prevLen = bar[4];
    state.chgAt = bar[5];
  }
  undo.length = 0;
  const n = recordNonNa(state, value, barCount, barIdx);
  if (!(len >= 1)) {
    state.sum = 0;
    state.comp = 0;
    state.window = 0;
    state.prevLen = 0;
    return Number.isNaN(len) ? NaN : 0;
  }
  const buffer = state.buffer!;
  const sourceNa = Number.isNaN(value);
  const calls = state.calls! + 1;
  state.calls = calls;
  const changed = state.prevLen !== 0 && len !== state.prevLen;
  const dense = changed && calls - state.chgAt! <= 1;
  if (changed) state.chgAt = calls;
  state.prevLen = len;

  const prevW = state.window!;
  const newW = n >= len ? len : n;
  if (sourceNa && prevW === newW) return newW >= len ? state.sum! : NaN;
  const top = n - 1;
  if (dense && n > len) {
    let rebuilt = buffer[top]!;
    for (let k = 1; k < newW; k++) rebuilt += buffer[top - k]!;
    for (let k = 0; k < newW; k++) putEntry(state, top - k, buffer[top - k]!);
    state.sum = rebuilt;
    state.comp = 0;
    state.window = newW;
    return rebuilt;
  }

  let s = state.sum!;
  let c = state.comp!;
  const shift = sourceNa ? 0 : 1;
  const v = sourceNa ? 0 : value;
  let d0 = 0;
  if (prevW + shift > newW) {
    for (let k = prevW - 1 + shift; k > newW; k--) {
      const y1 = -buffer[top - k]! - c;
      const t = s + y1;
      const e1 = t - s - y1;
      const y2 = -e1;
      s = t + y2;
      c = s - t - y2;
    }
    d0 = entries[top - newW]!;
  } else if (newW > prevW + shift) {
    for (let k = newW - 1; k >= prevW + shift; k--) {
      const y1 = -c;
      const t = s + y1;
      const e1 = t - s - y1;
      const y2 = buffer[top - k]! - e1;
      s = t + y2;
      c = s - t - y2;
      putEntry(state, top - k, y2);
    }
  }

  // sum_fires, as in naSkipSum.
  let fires = false;
  if (c !== 0 && v !== 0) {
    const b = c > 0 ? c : -c;
    const r = v + b;
    if (r !== 0 && r - r === 0) fires = b - (r - v) > 0;
  }
  if (fires) {
    s = v;
    for (let k = 1; k < newW; k++) s += buffer[top - k]!;
    c = 0;
    putEntry(state, top, v);
  } else {
    const y1 = -d0 - c;
    const t = s + y1;
    const e1 = t - s - y1;
    const y2 = v - e1;
    s = t + y2;
    c = s - t - y2;
    if (!sourceNa) putEntry(state, top, y2);
  }
  state.sum = s;
  state.comp = c;
  state.window = newW;
  return newW >= len ? s : NaN;
}

// Writes a realized entry, logging the old one so a same-bar re-execution can restore it.
function putEntry(state: NaSkipVarLenState, pos: number, entry: number): void {
  state.undo!.push(pos, state.entries![pos]!);
  state.entries![pos] = entry;
}

export interface MedianVarLenState extends NaSkipVarLenState {
  win?: number; // window size: the last `win` values of the history up to winEnd
  winEnd?: number;
  prevLen?: number; // the length the window was built for; 0 before any, -1 after an na length
  barWin?: number; // win/winEnd/prevLen as the bar began
  barWinEnd?: number;
  barPrevLen?: number;
}

// ta.median(source, length) with a series length: the oracle's machine (pynecore lib/ta.py median)
// with the length read every bar, on the same window as median() above: the last `length` NON-na
// values (ref_v6_ta_math.txt ta.median, "ARG length [series int]"). The window is kept across bars
// and rebuilt from the call site's na-compacted history when the length moves (oldest first, the
// current value last), so after a change it holds the last `length` non-na values again. An na bar
// stores nothing and does not touch the length bookkeeping: it answers from the window as it
// stands, na while that window is shorter than the bar's length. A na length is na and forces a
// rebuild on the next valid one; length 1 returns the source and empties the window; a length
// below 1 is na (the oracle asserts `length > 0`) and also forces a rebuild. Bar-keyed like the
// other *VarLen machines: a same-bar re-execution starts again from the bar-start window.
export function medianVarLen(state: MedianVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (barIdx !== state.lastBarIdx) {
    state.barWin = state.win ?? 0;
    state.barWinEnd = state.winEnd ?? 0;
    state.barPrevLen = state.prevLen ?? 0;
  }
  const count = recordNonNa(state, value, barCount, barIdx);
  let win = state.barWin!;
  let winEnd = state.barWinEnd!;
  let prevLen = state.barPrevLen!;
  const len = Math.trunc(length);
  let result = NaN;
  if (!(len >= 1)) {
    prevLen = -1;
  } else if (Number.isNaN(value)) {
    if (win >= len) result = medianOf(state.buffer!, winEnd - win, win);
  } else {
    if (len !== prevLen && prevLen !== 0) {
      // Rebuild from the non-na values before this bar's, at most len - 1 of them.
      win = Math.min(len - 1, count - 1);
      winEnd = count - 1;
    }
    prevLen = len;
    if (len === 1) {
      result = value;
    } else {
      win = Math.min(win + 1, len);
      winEnd = count;
      if (win >= len) result = medianOf(state.buffer!, winEnd - win, win);
    }
  }
  state.win = win;
  state.winEnd = winEnd;
  state.prevLen = prevLen;
  return result;
}

interface LinregVarLenState extends LinregState {
  lastBar?: number;
  barSize?: number; // size/count/val as the bar began
  barCount?: number;
  barVal?: number;
}

// ta.linreg with a series length: the same machine as linreg() above (linregStep), over every non-na
// source stored so far, so a length that grows reads the sources it already skipped past. The warm-up
// counter only steps while it is below the CURRENT length, one stored source at a time (PyneCore
// lib/ta.py linreg `count`), so a length that grows past it is na again until it catches up, and a
// length-1 bar stores nothing. The machine is bar-keyed like the other *VarLen variants: a second
// execution on the same bar (a loop call site) starts again from the bar-start size/count/val.
export function linregVarLen(state: LinregVarLenState, value: number, length: number, offset: number, barCount: number, barIdx: number): number {
  if (state.buf === undefined) {
    state.buf = new Float64Array(Math.max(1, barCount));
    state.size = 0;
    state.count = 0;
    state.val = NaN;
    state.lastBar = -1;
  }
  if (barIdx !== state.lastBar) {
    state.lastBar = barIdx;
    state.barSize = state.size;
    state.barCount = state.count;
    state.barVal = state.val;
  } else {
    state.size = state.barSize;
    state.count = state.barCount;
    state.val = state.barVal;
  }
  return linregStep(state, value, length, offset);
}

export interface WmaVarLenState {
  buffer?: Float64Array;
  writeIdx?: number;
  lastBarIdx?: number;
  count?: number;
  last?: number;
  barCount?: number;
  barLast?: number;
}

// ta.wma(source, length) with a series length: the fixed-length machine above (the oracle's, lib/ta.py
// wma, which reads `length` on every call) over the call site's whole forward-filled history, so a
// length that grows reads values the window of a shorter length already passed. The history holds
// one slot per execution of the call site, like the fixed ring; the variant is bar-keyed (no
// rt.ta.loopState copy): a second execution on the same bar rewrites that bar's slot from the
// bar-start count and last value. The oracle asserts length > 0 (no answer for 0, a negative or an
// na length): resin answers na and keeps advancing the history.
export function wmaVarLen(state: WmaVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
    state.count = 0;
    state.last = NaN;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
    state.barCount = state.count;
    state.barLast = state.last;
  } else {
    state.count = state.barCount;
    state.last = state.barLast;
  }
  const sourceNa = Number.isNaN(value);
  if (!sourceNa) {
    state.count! += 1;
    state.last = value;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = state.last!;

  const len = Math.trunc(length);
  if (!(len >= 1)) return NaN;
  if (sourceNa || state.count! < len) return NaN;
  let summ = 0;
  let weight = 0;
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    weight += 1;
    summ = summ + state.buffer[i]! * weight;
  }
  return summ / ((len * (len + 1)) / 2);
}

// math.sum(source, length) - length가 series인 변형(배치25 (4) 다섯 번째 묶음, C551): the
// na-skipping rolling sum of the fixed-length math.sum (naSkipSum) with a series length
// (naSkipSumVarLen). pine2py's variant counted na as 0 and summed whatever prefix it had during the
// warm-up; the reference and the oracle do neither (see naSkipSum). length<=0 keeps its
// empty-window 0.0, length=NaN its na.
export function sumVarLen(state: NaSkipVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  return naSkipSumVarLen(state, value, Math.trunc(length), barCount, barIdx);
}

// ── Series lengths: the oracle's machines, with the length read on every bar ──────────────────
//
// The v6 reference types the length of these builtins `series int` (ref_v6_ta_math.txt, "ARG
// length [series int]" under ta.change, ta.mom, ta.roc, ta.cmo, ta.cci, ta.dev, ta.variance,
// ta.stdev, ta.bb, ta.bbw, ta.mfi, ta.stoch, ta.wpr, ta.percentrank, ta.mode, ta.correlation), so a
// length that changes from bar to bar is valid Pine and every bar computes with its own. The oracle
// runs one machine for a literal and a series length alike (pynecore lib/ta.py reads `length` on
// every call), built from three parts, each ported here once:
//   - the call site's own bar history of its source, na included (`source[i]` of a Pine function
//     parameter): recordVarLen;
//   - math.sum's rolling window over the last `length` NON-na values, which follows the length
//     without restarting (lib/_math_stateful.py sum: "Pine's machine does not restart when the
//     length moves (MEASURED, probe sumlen2: a length grown 1..610 reproduces a constant 610
//     bit-for-bit)"): naSkipSumVarLen;
//   - ta.highest/ta.lowest's bar-addressed ring (lib/ta.py highest: "a GROWING length re-reads the
//     whole window ... Probed on the wild script "Ichimoku Kinko hyo" ... whose adaptive Senkou
//     length dips to 50 and climbs back"): extremeRing.
// Every machine is bar-keyed like the other *VarLen variants: a second execution on the same bar
// (a loop call site) replaces the bar's entry. A length below 1 or na is na (the oracle asserts
// `length > 0`).

// Records the call site's value for this bar in its history of every bar it ran on (na included)
// and returns the bar's position in it.
function recordVarLen(state: ExtremeVarLenState, value: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(Math.max(1, barCount)).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  state.buffer[state.writeIdx!] = value;
  return state.writeIdx!;
}

// ta.change/ta.mom(source, length) with a series length: source - source[length], na when either is
// na or the history is shorter than the length (lib/ta.py change; ta.mom "is exactly the same as
// change function").
export function changeVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  const w = recordVarLen(state, value, barCount, barIdx);
  const len = Math.trunc(length);
  if (!(len >= 1) || Number.isNaN(value) || len > w) return NaN;
  return value - state.buffer![w - len]!;
}

export interface RocVarLenState {
  src?: ExtremeVarLenState;
  chg?: ExtremeVarLenState;
}

// ta.roc(source, length) with a series length: "100 * change(src, length) / src[length]"
// (ref_v6_ta_math.txt ta.roc), as the oracle runs it (lib/ta.py roc): an na source returns first,
// so the inner ta.change call site only sees the non-na bars and its `src[length]` counts those,
// while the divisor src[length] is roc's own history of every bar. A zero divisor gives a
// non-finite value, na on a plot, as the oracle's safe division does.
export function rocVarLen(state: RocVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.src === undefined) {
    state.src = {};
    state.chg = {};
  }
  const w = recordVarLen(state.src, value, barCount, barIdx);
  const len = Math.trunc(length);
  if (!(len >= 1) || Number.isNaN(value)) return NaN;
  const prev = len > w ? NaN : state.src.buffer![w - len]!;
  const chg = changeVarLen(state.chg!, value, len, barCount, barIdx);
  return (100 * chg) / prev;
}

export interface CmoVarLenState {
  chg?: ExtremeVarLenState;
  up?: NaSkipVarLenState;
  down?: NaSkipVarLenState;
}

// ta.cmo(series, length) with a series length (lib/ta.py cmo; ref_v6_ta_math.txt f_cmo): the
// momentum is ta.change(src), taken every bar; an na momentum is na and feeds neither sum; a
// momentum within Pine's tolerance of zero counts as rising (probe m548); the rising and falling
// momenta go to two math.sum windows of `length`; both sums zero is 0/0, na.
export function cmoVarLen(state: CmoVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.chg === undefined) {
    state.chg = {};
    state.up = {};
    state.down = {};
  }
  const mom = changeVarLen(state.chg, value, 1, barCount, barIdx);
  if (Number.isNaN(mom)) return NaN;
  const len = Math.trunc(length);
  const rising = mom >= -PINE_EPS;
  const sum1 = naSkipSumVarLen(state.up!, rising ? mom : 0, len, barCount, barIdx);
  const sum2 = naSkipSumVarLen(state.down!, rising ? 0 : -mom, len, barCount, barIdx);
  const total = sum1 + sum2;
  if (total === 0) return NaN;
  return (100 * (sum1 - sum2)) / total;
}

// The mean absolute deviation of the last `len` bars of a history around `mean`, summed newest
// first (lib/ta.py dev: "TradingView computes the plain newest-first loop ``sum(abs(source[i] -
// sma)) / length``"). A na bar in the window, or a window longer than the history, is na.
function meanAbsDev(buffer: Float64Array, w: number, len: number, mean: number): number {
  if (len > w + 1) return NaN;
  let sum = 0;
  for (let i = w; i > w - len; i--) sum += Math.abs(buffer[i]! - mean);
  return sum / len;
}

export interface DevVarLenState {
  src?: ExtremeVarLenState;
  mean?: NaSkipVarLenState;
}

// ta.dev(source, length) with a series length (ref_v6_ta_math.txt pine_dev: mean = ta.sma(source,
// length), then sum |source[i] - mean| over i = 0..length-1, / length; lib/ta.py dev). Length 1 is 0
// without running the sma, so that bar never enters the sma's window (the oracle returns first).
export function devVarLen(state: DevVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.src === undefined) {
    state.src = {};
    state.mean = {};
  }
  const w = recordVarLen(state.src, value, barCount, barIdx);
  const len = Math.trunc(length);
  if (len === 1) return 0;
  if (!(len >= 1)) return NaN;
  const mean = naSkipSumVarLen(state.mean!, value, len, barCount, barIdx) / len;
  if (Number.isNaN(mean)) return NaN;
  return meanAbsDev(state.src.buffer!, w, len, mean);
}

// ta.cci(source, length) with a series length (lib/ta.py cci): mean = ta.sma(source, length), mdev
// = ta.dev(source, length) around that mean (0 for length 1), (source - mean) / (0.015 * mdev). The
// sma runs every bar here, length 1 included; a zero deviation divides to a non-finite value, na on
// a plot, like the oracle's safe division.
export function cciVarLen(state: DevVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.src === undefined) {
    state.src = {};
    state.mean = {};
  }
  const len = Math.trunc(length);
  if (!(len >= 1)) return NaN;
  const mean = naSkipSumVarLen(state.mean!, value, len, barCount, barIdx) / len;
  const w = recordVarLen(state.src, value, barCount, barIdx);
  const mdev = len === 1 ? 0 : Number.isNaN(mean) ? NaN : meanAbsDev(state.src.buffer!, w, len, mean);
  if (Number.isNaN(mdev)) return NaN;
  return (value - mean) / (0.015 * mdev);
}

export interface VarianceVarLenState {
  p?: NaSkipVarLenState;
  q?: NaSkipVarLenState;
  sum?: number; // the last bar's math.sum(source, length): ta.bb's basis is it / length
}

// ta.variance(source, length, biased) with a series length (lib/ta.py variance, "Measured law
// (probes m556 ...)"): p = math.sum(source, length), q = math.sum(source * source, length), m = p /
// length; biased max(0, q / length - m * m), unbiased max(0, q / (length - 1) - p * m / (length -
// 1)), an unbiased length 1 na. Both sums skip na ("`na` values in the `source` series are ignored;
// the function calculates on the `length` quantity of non-`na` values", ref_v6_ta_math.txt
// ta.variance).
export function varianceVarLen(
  state: VarianceVarLenState,
  value: number,
  length: number,
  biased: boolean,
  barCount: number,
  barIdx: number,
): number {
  if (state.p === undefined) {
    state.p = {};
    state.q = {};
  }
  const len = Math.trunc(length);
  const p = naSkipSumVarLen(state.p, value, len, barCount, barIdx);
  const q = naSkipSumVarLen(state.q!, value * value, len, barCount, barIdx);
  state.sum = p;
  if (!(len >= 1) || Number.isNaN(p) || Number.isNaN(q)) return NaN;
  if (!biased && len === 1) return NaN;
  const m = p / len;
  const v = biased ? q / len - m * m : q / (len - 1) - (p * m) / (len - 1);
  // Python's max(0.0, var): the clamp keeps 0.0 unless var is greater.
  return v > 0 ? v : 0;
}

// ta.stdev(source, length[, biased]) with a series length: the square root of ta.variance
// (lib/ta.py stdev, "TradingView's stdev is exactly sqrt of its variance on both paths", probes
// m556). pine2py's window, which went na for `length` bars after one na source, is not the rule.
export function stdevVarLen(
  state: VarianceVarLenState,
  value: number,
  length: number,
  biased: boolean,
  barCount: number,
  barIdx: number,
): number {
  return Math.sqrt(varianceVarLen(state, value, length, biased, barCount, barIdx));
}

// ta.bb(series, length, mult) with a series length (lib/ta.py bb): basis = ta.sma(series, length),
// deviation = mult * ta.stdev(series, length); na basis is the na triple. The sma's window is the
// variance's first sum, so the basis is read from it.
export function bbVarLen(
  state: VarianceVarLenState,
  value: number,
  length: number,
  mult: number,
  scratch: Float64Array,
  barCount: number,
  barIdx: number,
): void {
  const sd = Math.sqrt(varianceVarLen(state, value, length, true, barCount, barIdx));
  const len = Math.trunc(length);
  const middle = len >= 1 ? state.sum! / len : NaN;
  if (Number.isNaN(middle)) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }
  const dev = sd * mult;
  scratch[0] = middle;
  scratch[1] = middle + dev;
  scratch[2] = middle - dev;
}

// ta.bbw(series, length, mult) with a series length (lib/ta.py bbw): ((upper - lower) / basis) *
// 100 of ta.bb, na when the basis is na or zero.
export function bbwVarLen(
  state: VarianceVarLenState,
  value: number,
  length: number,
  mult: number,
  barCount: number,
  barIdx: number,
): number {
  const sd = Math.sqrt(varianceVarLen(state, value, length, true, barCount, barIdx));
  const len = Math.trunc(length);
  const basis = len >= 1 ? state.sum! / len : NaN;
  if (Number.isNaN(basis) || basis === 0) return NaN;
  const dev = sd * mult;
  return ((basis + dev - (basis - dev)) / basis) * 100;
}

export interface MfiVarLenState {
  chg?: ExtremeVarLenState;
  up?: NaSkipVarLenState;
  down?: NaSkipVarLenState;
}

// ta.mfi(series, length) with a series length: the rule of the fixed-length mfi() (see there; lib/ta.py
// mfi) on math.sum windows that follow the length. An na source returns first, so neither the change
// nor the sums see that bar.
export function mfiVarLen(state: MfiVarLenState, source: number, volume: number, length: number, barCount: number, barIdx: number): number {
  if (state.chg === undefined) {
    state.chg = {};
    state.up = {};
    state.down = {};
  }
  if (Number.isNaN(source)) return NaN;
  const len = Math.trunc(length);
  const chg = changeVarLen(state.chg, source, 1, barCount, barIdx);
  const chgNa = Number.isNaN(chg);
  let upper = naSkipSumVarLen(state.up!, volume * (!chgNa && chg <= PINE_EPS ? 0 : source), len, barCount, barIdx);
  let lower = naSkipSumVarLen(state.down!, volume * (!chgNa && chg >= -PINE_EPS ? 0 : source), len, barCount, barIdx);
  if (Number.isNaN(upper) || Number.isNaN(lower)) return NaN;
  if (Math.abs(upper) <= PINE_EPS) upper = 0;
  if (Math.abs(lower) <= PINE_EPS) lower = 0;
  if (lower === 0) return 100.0;
  return 100.0 - 100.0 / (1.0 + upper / lower);
}

export interface ExtremeRingState {
  capacity?: number;
  window?: number[];
  extreme?: number;
  extremeIndex?: number;
  lastBar?: number;
  avail?: number;
  prevLength?: number;
}

// Python's modulo: the result takes the divisor's sign.
function floorMod(a: number, n: number): number {
  const r = a % n;
  return r !== 0 && r < 0 !== n < 0 ? r + n : r;
}

// ta.highest/ta.lowest as the oracle measured them on TradingView (lib/ta.py highest/lowest; the
// value form, source given): a ring of `length + 1` slots addressed by bar_index and written only on
// the bars the call runs (a skipped bar leaves the slot of a whole ring earlier), grown - never
// shrunk - when the length reaches it, each slot remapped onto the bar it was written on; the kept
// extreme ages in bars and is rescanned when it leaves the window or the length grows ("a GROWING
// length re-reads the whole window"); a later equal value moves the index back; an na source resets
// the extreme and the rescan's reach ("A na input RESETS the machine"); na while bar_index <
// length - 1. `low` selects ta.lowest. The ring is per-call: several executions on one bar rewrite
// one slot and keep the extreme an earlier one found (the oracle's `per_call`). `checkEq` is the
// oracle's `_check_eq`, the pivots' variant: of equal extremes the index names the NEWEST (a new
// equal value takes the index, the rescan does not move it back to an older equal one).
function extremeRing(state: ExtremeRingState, value: number, len: number, bi: number, low: boolean, checkEq = false): number {
  if (state.capacity === undefined) {
    state.capacity = 0;
    state.window = [];
    state.extreme = NaN;
    state.extremeIndex = 0;
    state.lastBar = -1;
    state.avail = 0;
    state.prevLength = 0;
  }
  let capacity = state.capacity;
  if (len >= capacity) {
    const grown = len + 1;
    const next: number[] = new Array(grown).fill(NaN);
    for (let j = 0; j < capacity; j++) {
      const b = bi - floorMod(bi - j, capacity);
      next[floorMod(b, grown)] = state.window![j]!;
    }
    state.window = next;
    state.capacity = capacity = grown;
  }
  const window = state.window!;
  const gap = bi - state.lastBar!;
  if (state.lastBar! >= 0 && gap > 0) {
    state.extremeIndex = state.extremeIndex! + gap;
    state.avail = Math.min(state.avail! + gap, capacity - 1);
  }
  state.lastBar = bi;
  window[floorMod(bi, capacity)] = value;
  if (Number.isNaN(value)) {
    state.extreme = NaN;
    state.extremeIndex = 0;
    state.avail = 0;
    return NaN;
  }
  let extreme = state.extreme!;
  let extremeIndex = state.extremeIndex!;
  if (Number.isNaN(extreme) || (low ? value < extreme : value > extreme) || (checkEq && value === extreme)) {
    extreme = value;
    extremeIndex = 0;
  }
  const grownLength = len > state.prevLength!;
  state.prevLength = len;
  if (extremeIndex >= len || grownLength) {
    extreme = value;
    extremeIndex = 0;
    const end = state.avail! >= len ? len : state.avail! + 1;
    for (let i = 1; i < end; i++) {
      const s = window[floorMod(bi - i, capacity)]!;
      if (low ? s < extreme : s > extreme) {
        extreme = s;
        extremeIndex = i;
      } else if (!checkEq && s === extreme) {
        extremeIndex = i;
      }
    }
  }
  state.extreme = extreme;
  state.extremeIndex = extremeIndex;
  return bi < len - 1 ? NaN : extreme;
}

export interface StochState {
  hh?: ExtremeRingState;
  ll?: ExtremeRingState;
}

// ta.percentrank(source, length), one machine for a literal and a series length (lib/ta.py
// percentrank: array.percentrank of source[0..length], index 0): na when the source is na or
// bar_index < length; otherwise the share of the `length` previous values within Pine's tolerance at
// or below the current one ("Percent rank is the percents of how many previous values was less than
// or equal to the current value", ref_v6_ta_math.txt), counting the current value too,
// (count - 1) * 100 / length. A past na counts toward the length and not toward the rank
// (lib/array.py percentrank: "na elements are ignored when counting values at or below the target,
// but still count toward the array length"; resin-harness state/repros/ta.stats-seed-9.json,
// ta.percentrank(s0, 3) on bar 3 after an na bar 0: 66.67 on the oracle). The manual's remark "`na`
// values in the `source` series are included in calculations and will produce an `na` result" is not
// an na for any na in the window: ta.percentile_linear_interpolation carries the same remark, and
// TradingView answers it with an na in the window (tier 1 ta_372_rolling_na_rank_order: bar 4 of
// `bar_index < 3 ? na : float(bar_index)`, length 5, gives 3.25 at 75 and 4 at 100). The history is
// the call site's, bar-keyed like the other *VarLen machines, so a loop call site needs no bar-start
// rollback (codegen BAR_KEYED_TA_FNS).
export function percentrank(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  const w = recordVarLen(state, value, barCount, barIdx);
  const len = Math.trunc(length);
  if (!(len >= 1) || Number.isNaN(value) || barIdx < len) return NaN;
  const n = Math.min(len + 1, w + 1);
  if (n < 2) return NaN;
  const buffer = state.buffer!;
  let count = 0;
  for (let i = w; i > w - n; i--) {
    const x = buffer[i]!;
    if (x <= value || x - value <= PINE_EPS) count++;
  }
  return ((count - 1) * 100) / (n - 1);
}

// The series-length entry point (codegen VARLEN_RT_PATHS): the same machine.
export const percentrankVarLen = percentrank;

// ta.mode(source, length) with a series length (lib/ta.py mode): the most frequent of the last
// `length` NON-na values, the smallest on a tie ("If there are several values with the same
// frequency, it returns the smallest value"); na until `length` non-na values exist; an na bar
// answers from the values already held ("an na bar neither enters the window nor blanks the
// answer").
export function modeVarLen(state: NaSkipVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  const count = recordNonNa(state, value, barCount, barIdx);
  const len = Math.trunc(length);
  if (!(len >= 1) || len > count) return NaN;
  return modeOf(state.buffer!, count - len, len);
}

export interface CorrelationVarLenState {
  sx?: NaSkipVarLenState;
  sy?: NaSkipVarLenState;
  sxy?: NaSkipVarLenState;
  sx2?: NaSkipVarLenState;
  sy2?: NaSkipVarLenState;
}

// ta.correlation(source1, source2, length) with a series length (lib/ta.py correlation, "Measured
// law (probes m557 ...)"): five math.sum windows of `length` (each skipping its own na), cov = sxy /
// length - mx * my, 0 when the covariance is within Pine's tolerance of zero, otherwise cov /
// sqrt(vx * vy) with each variance clamped at 0, na when that product is 0.
export function correlationVarLen(
  state: CorrelationVarLenState,
  x: number,
  y: number,
  length: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.sx === undefined) {
    state.sx = {};
    state.sy = {};
    state.sxy = {};
    state.sx2 = {};
    state.sy2 = {};
  }
  const len = Math.trunc(length);
  const sx = naSkipSumVarLen(state.sx, x, len, barCount, barIdx);
  const sy = naSkipSumVarLen(state.sy!, y, len, barCount, barIdx);
  const sxy = naSkipSumVarLen(state.sxy!, x * y, len, barCount, barIdx);
  const sx2 = naSkipSumVarLen(state.sx2!, x * x, len, barCount, barIdx);
  const sy2 = naSkipSumVarLen(state.sy2!, y * y, len, barCount, barIdx);
  if (!(len >= 1) || Number.isNaN(sx) || Number.isNaN(sy) || Number.isNaN(sxy) || Number.isNaN(sx2) || Number.isNaN(sy2)) {
    return NaN;
  }
  const mx = sx / len;
  const my = sy / len;
  const cov = sxy / len - mx * my;
  if (cov >= -PINE_EPS && cov <= PINE_EPS) return 0;
  const vx = sx2 / len - mx * mx;
  const vy = sy2 / len - my * my;
  const product = (vx > 0 ? vx : 0) * (vy > 0 ? vy : 0);
  if (product === 0) return NaN;
  return cov / Math.sqrt(product);
}

// ta.pivothigh/ta.pivotlow with a series leftbars/rightbars (the v6 reference types both "series
// int/float"): the same machine as the literal form below, which reads both on every call (the
// oracle has one function; its ring grows with the window).
export function pivothighVarLen(state: PivotState, value: number, left: number, right: number, _barCount: number, barIdx: number): number {
  return pivothigh(state, value, left, right, barIdx);
}

export function pivotlowVarLen(state: PivotState, value: number, left: number, right: number, _barCount: number, barIdx: number): number {
  return pivotlow(state, value, left, right, barIdx);
}

export interface RangeState {
  hi?: ExtremeRingState;
  lo?: ExtremeRingState;
}

// ta.range(source, length), with a literal or a series length: the oracle's composition (pynecore
// lib/ta.py range), `ta.highest(source, length) - ta.lowest(source, length)` on the extremes' own
// machine (extremeRing), with its own na rule: an na source is na on its bar and does NOT run the
// extremes, so it neither resets them nor writes its slot of their rings - the window carries on
// over the valued bars (ref_v6_ta_math.txt ta.range: "`na` values in the `source` series are
// ignored; the function calculates on the `length` quantity of non-`na` values"; repro
// resin-harness state/repros/ta.serieslen-seed-36.json, where pine2py's poison window gave na for
// `length` bars after each na). So a skipped bar's slot is whatever the ring held there, exactly as
// for a gated ta.highest call (tier 1 ta_370_gated_lowest_window). na while bar_index < length - 1.
// A length below 1 or na is na: the oracle asserts `length > 0`.
export function range(state: RangeState, value: number, length: number, barIdx: number): number {
  if (state.hi === undefined) {
    state.hi = {};
    state.lo = {};
  }
  const len = Math.trunc(length);
  if (!(len >= 1) || Number.isNaN(value)) return NaN;
  const hi = extremeRing(state.hi, value, len, barIdx, false);
  const lo = extremeRing(state.lo!, value, len, barIdx, true);
  return hi - lo;
}

// The series-length entry point (codegen VARLEN_RT_PATHS): the same machine; the rings size
// themselves, so the bar count is unused.
export function rangeVarLen(state: RangeState, value: number, length: number, _barCount: number, barIdx: number): number {
  return range(state, value, length, barIdx);
}

// ta.stoch(source, high, low, length), with a literal or a series length: one machine, the oracle's
// composition (pynecore lib/ta.py stoch): na when any input is na, and then the extremes do not run
// that bar, so its high and low never enter the window (ref_v6_ta_math.txt ta.stoch: "`na` values
// in the `source` series are ignored"; repro state/repros/ta.osc-seed-3.json: the na source on bar
// 12 keeps that bar's high out of bar 17's window); hh = ta.highest(high, length), ll =
// ta.lowest(low, length) on the extremes' ring (extremeRing: a gated call serves its own stale slots,
// a loop call site advances per execution); na while bar_index < length - 1; 100 * (source - ll) /
// (hh - ll), unclamped ("Measured law (probes m561)"), a flat window dividing to a non-finite value,
// na on a plot (see "Division by zero" at ta.iii). pine2py's port ran a call-counted poison window
// on every bar, the high and low of an na source's bar included.
export function stoch(state: StochState, source: number, high: number, low: number, length: number, barIdx: number): number {
  if (state.hh === undefined) {
    state.hh = {};
    state.ll = {};
  }
  const len = Math.trunc(length);
  if (!(len >= 1) || Number.isNaN(source) || Number.isNaN(high) || Number.isNaN(low)) return NaN;
  const hh = extremeRing(state.hh, high, len, barIdx, false);
  const ll = extremeRing(state.ll!, low, len, barIdx, true);
  if (barIdx < len - 1) return NaN;
  return (100 * (source - ll)) / (hh - ll);
}

// The series-length entry point (codegen VARLEN_RT_PATHS): the same machine; the rings size
// themselves, so the bar count is unused.
export function stochVarLen(
  state: StochState,
  source: number,
  high: number,
  low: number,
  length: number,
  _barCount: number,
  barIdx: number,
): number {
  return stoch(state, source, high, low, length, barIdx);
}

// ta.wpr(length), with a literal or a series length (pynecore lib/ta.py wpr): length 1 is the close
// (the extremes do not run that bar); otherwise 100 * (close - hh) / (hh - ll) over
// ta.highest(high, length) / ta.lowest(low, length) on the extremes' ring, so an na high or low
// resets them as it resets ta.highest/ta.lowest (ref_v6_ta_math.txt ta.wpr: "`na` values in the
// `source` series are ignored") instead of blanking the next `length` bars (pine2py's poison
// window). Pine syntax takes only the length; codegen injects close/high/low. A flat window divides
// to a non-finite value, na on a plot (see "Division by zero" at ta.iii).
export function wpr(state: StochState, close: number, high: number, low: number, length: number, barIdx: number): number {
  if (state.hh === undefined) {
    state.hh = {};
    state.ll = {};
  }
  const len = Math.trunc(length);
  if (!(len >= 1)) return NaN;
  if (len === 1) return close;
  const hh = extremeRing(state.hh, high, len, barIdx, false);
  const ll = extremeRing(state.ll!, low, len, barIdx, true);
  return (100 * (close - hh)) / (hh - ll);
}

export function wprVarLen(
  state: StochState,
  close: number,
  high: number,
  low: number,
  length: number,
  _barCount: number,
  barIdx: number,
): number {
  return wpr(state, close, high, low, length, barIdx);
}

// ta.tr(handle_na) - True Range = max(high-low, |high-prevClose|, |low-prevClose|); prevClose가
// NaN(첫 바 포함 - Series.get(1)이 워밍업 중 NaN을 자연히 반환하는 관례와 동치, pine2py atr.py의
// `data_len<2` 분기를 별도 이식할 필요가 없다)일 때 handleNa(TV 실제 파라미터명 handle_na)가
// true면 hl 그대로, false면 NaN. Pine 문법에 high/low/close 인자가 없어 codegen이 $.high.get(0)/
// $.low.get(0)/$.close.get(1)(prevClose)을 handle_na 앞에 암묵 주입한다. 완전히 stateless인
// 순수 함수라 첫 state 인자는 TA_REGISTRY 디스패치 경로의 일관성을 위해서만 받고 내부에서 전혀
// 쓰지 않는다("상태가 진짜로 불필요한 첫 사례").
//
// handle_na defaults to false: the bare variable `ta.tr` (the parser desugars it to `ta.tr()`) is
// ta.tr(false), na on the first bar (ref_v6_ta_math.txt "VAR ta.tr": "True range, equivalent to
// `ta.tr(handle_na = false)`"; "ta.tr": "ta.tr(false) is exactly the same as ta.tr"; tier 1
// tv-ta_031_tr bar 0 plot "ta.tr" is na; oracle lib/ta.py `def tr(handle_na: bool = False)`).
// resin had true (C291 hypothesis). ta.atr is the one caller that wants true (see atr below).
export function tr(_state: unknown, high: number, low: number, prevClose: number, handleNa: boolean = false): number {
  const hl = high - low;
  if (Number.isNaN(prevClose)) return handleNa ? hl : NaN;
  return Math.max(hl, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

export interface AtrState {
  rma?: RmaState;
}

// ta.atr(length) - Average True Range = RMA(TR, length)(GOAL.md "RSI/ATR는 RMA(Wilder)"가 이미
// 명시한 그대로). 매 바 tr()을 호출해 그 값을 O(1) 스트리밍 rt.ta.rma에 흘려 넣는 합성
// (hma/stoch/tsi류와 동일 "이미 구현된 TA 재호출" 원칙) - Pine 문법상 length 1개뿐이라 codegen이
// $.high.get(0)/$.low.get(0)/$.close.get(1)을 앞에 끼워 넣는다(wpr과 동일한 암묵 주입 패턴).
//
// **의도적 divergence from pine2py**(DIVERGENCES.md): pine2py wavealgo/ta/atr.py는 이 O(1) 합성을
// 쓰지 않고 매 호출 tr_values를 length+10 폭까지 재스캔한 뒤 앞쪽 length개를 SMA로 시드, 나머지를
// 역순 Wilder 스무딩하는 독자 구현이다(C47/C49 next_hint가 반복 지적한 "off-by-one 미해결" 지점).
// scratch/probe_atr.mjs + oracle/golden/ta_atr_tr.json(length=3, sample10.json)으로 직접 대조한
// 결과 이 재스캔 방식은 (1) `data_len < length+1`을 조기 반환 조건으로 써서 실제로 필요한
// `data_len < length`보다 워밍업이 한 바 항상 늦고(길이/데이터 무관하게 모든 케이스에서 재현됨 -
// length=3 golden이 바0~2 NaN, 바3부터 유효값을 보임: dataLen>=length+1=4, 즉 t>=3), (2) 창이
// length+10바로 잘려 있어 그보다 긴 시리즈에서 무한 히스토리 스트리밍 RMA와 수치 자체가 갈린다
// (Wilder 스무딩의 decay factor((length-1)/length)^10가 length=14에서 ~0.46로 전혀 무시할 수
// 없는 크기 - scratch로 실측 확인). 둘 다 pine2py 자체의 latent 버그로 판단(wpr C44/rt.max·min
// C13과 동일 계열, GOAL.md "pine2py의 알려진 버그는 따르지 않는다" 적용) - 오라클 골든과는
// 의도적으로 갈리므로 golden 비교는 __obs_tr 채널만 하고(compareToGolden onlyKeys), __obs_atr은
// hand-verified 테스트로 대체(runtime.test.ts).
export function atr(state: AtrState, high: number, low: number, prevClose: number, length: number): number {
  if (state.rma === undefined) state.rma = {};
  // ta.atr smooths ta.tr(true): the first bar enters the rma as high - low (ref_v6_ta_math.txt
  // "ta.atr": "trueRange = na(high[1])? high-low : ..."; oracle lib/ta.py `rma(tr(True), length)`).
  const trVal = tr(undefined, high, low, prevClose, true);
  return rma(state.rma, trVal, length);
}

export interface MfiState {
  prevSource?: number;
  up?: SmaState;
  down?: SmaState;
}

// ta.mfi(source, length) - the manual's reference (ref_v6_ta_math.txt "ta.mfi"):
//   upper = math.sum(volume * (ta.change(src) <= 0.0 ? 0.0 : src), length)
//   lower = math.sum(volume * (ta.change(src) >= 0.0 ? 0.0 : src), length)
//   mfi = 100.0 - (100.0 / (1.0 + upper / lower))
// Pine syntax omits volume; codegen injects $.volume.get(0) between source and length (C29).
// - An na source returns na and leaves the state alone ("`na` values in the `source` series are
//   ignored; the function calculates on the `length` quantity of non-`na` values"), so the change
//   is taken against the previous non-na source.
// - On the first non-na bar ta.change is na, both comparisons are false, and the bar's money flow
//   enters BOTH sums: the first value lands on the bar holding the length-th non-na source (tier 1
//   ta_211_mfi_rsi_stoch bar 13 of mfi(close, 14): 46.173185267; the window of bars 1..14 on).
// - The direction test is tolerant: a change within PINE_EPS counts as neither side (PyneCore
//   lib/ta.py mfi, TradingView probes m548/m549).
// - Both sums are math.sum itself (naSkipSum: TradingView's rolling compensated sum on the
//   na-compacted window; the oracle's lib/ta.py mfi calls lib_math.sum for each side). An na volume
//   makes both terms na, so the bar stores nothing and reports the standing sums (na while fewer
//   than length terms are stored).
// - A side within PINE_EPS of zero is zero, and a zero lower side is 100 (both sides zero
//   included; probe m550). The rolling sums keep dust when their window turns to zeros (probe
//   m566), and on large money flows that dust exceeds PINE_EPS and stays: resin-harness
//   state/repros/ta.osc-seed-25.json, ta.mfi(hlc3, 11) on a flat stretch, where the oracle plots
//   1.56e-13 on bar 245 (upper window all zeros, its sum 2.3e-10) and 0, not 100, on bar 247
//   (both windows all zeros: upper 2.9e-11 counts as 0, lower 3.8e-10 does not). resin's plain
//   running sums, reset to an exact 0 when a window held only zeros, gave 0, 0 and 100.
export function mfi(state: MfiState, source: number, volume: number, length: number): number {
  if (state.up === undefined) {
    state.prevSource = NaN;
    state.up = {};
    state.down = {};
  }
  if (Number.isNaN(source)) return NaN;

  const change = source - state.prevSource!;
  state.prevSource = source;

  // NaN <= x is false: the na change of the first bar takes `src` on both sides.
  let upper = naSkipSum(state.up, volume * (change <= PINE_EPS ? 0 : source), length);
  let lower = naSkipSum(state.down!, volume * (change >= -PINE_EPS ? 0 : source), length);
  if (Number.isNaN(upper) || Number.isNaN(lower)) return NaN;
  if (Math.abs(upper) <= PINE_EPS) upper = 0;
  if (Math.abs(lower) <= PINE_EPS) lower = 0;
  if (lower === 0) return 100.0;
  return 100.0 - 100.0 / (1.0 + upper / lower);
}

export interface FixnanState {
  last?: number;
}

// fixnan(value) - value가 non-na면 그대로 반환하고 상태 슬롯에 기억, na면 마지막으로 기억해둔
// non-na 값을 반환(한 번도 non-na가 없었으면 na). pine2py wavealgo.builtins.core.fixnan은 매 호출
// 시 Series 히스토리를 처음부터(offset 0) 역방향으로 스캔해 첫 non-na 값을 찾는데, 이는 상태
// 슬롯 하나로 "마지막 non-na 값"만 유지하는 것과 동치다(현재 바가 non-na면 즉시 그 값 반환 -
// 스캔의 offset 0 히트와 동일, na면 이전에 저장해둔 마지막 non-na 값 반환 - 스캔이 이어서 찾아낼
// 값과 동일). O(n) 재스캔 대신 O(1) incremental 갱신으로 이식(GOAL.md "히스토리 재계산 금지").
export function fixnan(state: FixnanState, value: number): number {
  if (!Number.isNaN(value)) {
    state.last = value;
    return value;
  }
  return state.last ?? NaN;
}

export interface CorrelationState {
  sx?: SmaState; // math.sum(source1, length)
  sy?: SmaState; // math.sum(source2, length)
  sxy?: SmaState; // math.sum(source1 * source2, length)
  sx2?: SmaState; // math.sum(source1 * source1, length)
  sy2?: SmaState; // math.sum(source2 * source2, length)
}

// ta.correlation(source1, source2, length): the oracle's measured law (pynecore lib/ta.py
// correlation, "Measured law (probes m557 ...)"), the same as correlationVarLen on a fixed length.
// Five naSkipSum windows of `length` run every bar: both sources, their product and their squares.
// cov = sxy / length - mx * my is 0 when within Pine's tolerance of zero (so a constant source and
// length 1 are 0); otherwise cov / sqrt(vx * vy), each variance clamped at 0, na when that product
// is 0. Each sum skips its own na bars, so with an na in one source the windows cover different
// bars and the quotient leaves [-1, 1]: tier 1 ta_244_correlation_exact logs
// ta.correlation(g, b, 4) = -110.27480824437345 on bar 9 for `g = bar_index % 3 == 0 ? na : a`,
// and 0 for a constant source and for length 1 (TV "0/0/0/0/1/0"). The manual's remark ("`na`
// values in the `source` series are ignored", ref_v6_ta_math.txt "ta.variance", the family's
// wording) is per sum. resin used to keep pine2py's window: na while any na sat in either source
// and a plain rolling sum (resin-harness state/repros/ta.stats-seed-1.json, bar 23:
// ta.correlation(low, s2, 22) is 11.4696 on the oracle, na in resin).
export function correlation(
  state: CorrelationState,
  x: number,
  y: number,
  length: number
): number {
  const len = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.sx === undefined) {
    state.sx = {};
    state.sy = {};
    state.sxy = {};
    state.sx2 = {};
    state.sy2 = {};
  }
  const sx = naSkipSum(state.sx, x, len);
  const sy = naSkipSum(state.sy!, y, len);
  const sxy = naSkipSum(state.sxy!, x * y, len);
  const sx2 = naSkipSum(state.sx2!, x * x, len);
  const sy2 = naSkipSum(state.sy2!, y * y, len);
  if (!(len >= 1) || Number.isNaN(sx) || Number.isNaN(sy) || Number.isNaN(sxy) || Number.isNaN(sx2) || Number.isNaN(sy2)) {
    return NaN;
  }
  const mx = sx / len;
  const my = sy / len;
  const cov = sxy / len - mx * my;
  if (cov >= -PINE_EPS && cov <= PINE_EPS) return 0;
  const vx = sx2 / len - mx * mx;
  const vy = sy2 / len - my * my;
  const product = (vx > 0 ? vx : 0) * (vy > 0 ? vy : 0);
  if (product === 0) return NaN;
  return cov / Math.sqrt(product);
}

export interface MedianState {
  buffer?: number[]; // ring of the last `length` non-na values
  writeIdx?: number;
  count?: number; // non-na values stored so far, capped at the length
}

// The median of `n` window values (the mean of the two middle ones for an even n). The window
// holds no na, so the comparator is a valid one.
function medianOf(values: ArrayLike<number>, from: number, n: number): number {
  const sorted = Array.prototype.slice.call(values, from, from + n) as number[];
  sorted.sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  if (n % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

// ta.median(source, length): the median of the last `length` NON-na values of the source, na
// until that many have arrived (ref_v6_ta_math.txt ta.median: "`na` values in the `source` series
// are ignored; the function calculates on the `length` quantity of non-`na` values"). The oracle's
// machine (pynecore lib/ta.py median) keeps that window and, on an na bar, stores nothing and
// answers from the window as it stands ("measured: TradingView keeps answering across an na bar
// (a window of [2,3,4,5,6] answers 4 on the na bar that follows it)"); length 1 returns the
// source and keeps no window, so its na bar is na. pine2py rebuilt the window from the last
// `length` BARS and poisoned it for `length` bars after one na (probe I01: ta.median(src, 20)
// with one na on bar 100 is 102.145 there, not na). Sorting a copy of the window each bar is
// O(length log length); no incremental structure keeps a middle order statistic in O(1).
export function median(state: MedianState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (!(length >= 1)) return NaN; // the oracle asserts length > 0
  if (Number.isNaN(value)) return (state.count ?? 0) < length ? NaN : medianOf(state.buffer!, 0, length);
  if (length === 1) return value;
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.count = 0;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  if (state.count! < length) state.count = state.count! + 1;
  return state.count! < length ? NaN : medianOf(state.buffer, 0, length);
}

export interface ModeState {
  buffer?: number[]; // ring of the last `length` non-na values
  writeIdx?: number;
  count?: number; // non-na values stored so far, capped at the length
}

// The mode of `n` window values from `from`: the most frequent one, the smallest on a tie
// (ref_v6_ta_math.txt ta.mode: "If there are several values with the same frequency, it returns
// the smallest value"). The window holds no na. Sorting a copy is O(n log n) per bar; a frequency
// distribution shifts with every value entering and leaving, so no O(1) update exists.
function modeOf(values: ArrayLike<number>, from: number, n: number): number {
  const sorted = Array.prototype.slice.call(values, from, from + n) as number[];
  sorted.sort((a, b) => a - b);
  let mode = sorted[0]!;
  let current = sorted[0]!;
  let maxFreq = 1;
  let freq = 1;
  for (let i = 1; i < n; i++) {
    if (sorted[i] === current) {
      freq++;
      if (freq > maxFreq) {
        maxFreq = freq;
        mode = current;
      }
    } else {
      current = sorted[i]!;
      freq = 1;
    }
  }
  return mode;
}

// ta.mode(source, length): the mode of the last `length` NON-na values of the source, na until
// that many have arrived (ref_v6_ta_math.txt ta.mode: "`na` values in the `source` series are
// ignored; the function calculates on the `length` quantity of non-`na` values"). An na bar stores
// nothing and answers from the window as it stands (pynecore lib/ta.py mode: "an na bar neither
// enters the window nor blanks the answer — the machine keeps answering from the non-na values it
// already holds — and the warm-up lasts until ``length`` NON-NA values exist"). Unlike ta.median,
// length 1 is no special case there: its na bar answers the last non-na value. Tier 1:
// ta_051_mode_typed_na (`bar_index % 2 == 0 ? na : 1`, length 4: na through bar 6, 1 from bar 7)
// and ta_372_rolling_na_rank_order (`bar_index < 3 ? na : float(bar_index)`, length 5: na on bars
// 4-6). pine2py counted the last `length` BARS and skipped the na among them (resin-harness
// state/repros/ta.stats-seed-1.json: ta.mode(s0, 17) on bar 139, seven na bars into a gap, is
// 100.76 on the oracle, the mode of bars 116-132, and was 100.87, the mode of bars 123-132).
export function mode(state: ModeState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  // An na length is na on every bar, as for the percentile machines and ta.median (tier 1
  // ta_362_percentile_na_length "mode_na_len"; pynecore lib/ta.py: "percentile_nearest_rank,
  // percentile_linear_interpolation, median and mode all export an all-na plot").
  if (!(length >= 1)) return NaN;
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.count = 0;
  }
  if (!Number.isNaN(value)) {
    const writeIdx = state.writeIdx!;
    state.buffer[writeIdx] = value;
    state.writeIdx = (writeIdx + 1) % length;
    if (state.count! < length) state.count = state.count! + 1;
  }
  return state.count! < length ? NaN : modeOf(state.buffer, 0, length);
}

export interface PercentileState {
  hist?: ExtremeVarLenState; // the call site's history of its source: `source[i]`
  window?: number[]; // the window in arrival order, oldest first
  ranks?: number[]; // the same values in rank order, na elements at slots of their own
}

// ta.percentile_nearest_rank / ta.percentile_linear_interpolation(source, length, percentage), with a
// literal or a series length ("ARG length [series int]", ref_v6_ta_math.txt): one machine, the
// oracle's (pynecore lib/ta.py percentile_nearest_rank / percentile_linear_interpolation), whose
// rules are TradingView measurements quoted there and pinned by tier 1 ta_221_percentiles,
// ta_242_percentile_change_exact, ta_247_percentile_na_percentage, ta_362_percentile_na_length and
// ta_372_rolling_na_rank_order:
//   - the window holds the last `length` executions of the call, na included: every call pushes its
//     source, tops an underfull window up from the call site's history ("source[i] for i =
//     len(window)..length - 1, na beyond the buffer", prepended as older entries that persist), and
//     evicts the oldest while over the CURRENT call's length;
//   - the values are kept in a rank order that na elements take part in ("the window holds it like
//     any other element and the rank order decides"). The order is Pine's tolerant one
//     (rankInsertPos). So a window with na in it still answers, and answers na where the rank lands
//     on one (tier 1 ta_372: the warm-up window [na, na, na, 3, 4] reads na at 20..60 %, 3 at 80 %);
//     the manual's "`na` values in the `source` series are ignored" (ta.percentile_nearest_rank) is
//     not the measured behaviour, while its "are included in calculations and will produce an `na`
//     result" (ta.percentile_linear_interpolation) holds for the two ranks interpolated;
//   - na while bar_index < length - 1;
//   - nearest rank reads rank ceil(percentage * n / 100), clamped to 1..n, an na percentage counting
//     as 0 (tier 1 ta_247: "rank_na" equals "rank_zero");
//   - linear interpolation reads the 1-based position n * percentage / 100 + 0.5 and weighs its two
//     neighbours (tier 1 ta_221, ta_242); an na percentage is na;
//   - an na length is na and leaves the window alone (tier 1 ta_362: an all-na plot); a length below
//     1, which the oracle asserts against, is na too.
// The window advances once per execution of the call site (a loop call site too; codegen
// PER_EXECUTION_TA_FNS), while the history is bar-keyed like the other *VarLen machines.
function percentileStep(state: PercentileState, value: number, length: number, barCount: number, barIdx: number): number[] | null {
  if (state.hist === undefined) {
    state.hist = {};
    state.window = [];
    state.ranks = [];
  }
  const w = recordVarLen(state.hist, value, barCount, barIdx);
  const len = Math.trunc(length);
  if (!(len >= 1)) return null;
  const window = state.window!;
  const ranks = state.ranks!;
  window.push(value);
  ranks.splice(rankInsertPos(ranks, value), 0, value);
  if (window.length < len) {
    const history = state.hist.buffer!;
    for (let i = window.length; i < len; i++) {
      const v = i <= w ? history[w - i]! : NaN;
      window.unshift(v);
      // A top-up entry is older than everything in the window, so an na one takes the front of the
      // rank order, the slot a warm-up na holds.
      ranks.splice(Number.isNaN(v) ? 0 : rankInsertPos(ranks, v), 0, v);
    }
  }
  while (window.length > len) {
    ranks.splice(rankRemovePos(ranks, window.shift()!), 1);
  }
  if (barIdx < len - 1) return null;
  return ranks;
}

// The slot a value takes in the rank order: in front of the values it ties with (Pine's 1e-10
// tolerance), and an na never holds a value back: the search steps past an na, and an na being
// inserted steps past everything, so a warm-up na stays at the front while an na arriving into a
// filled window lands at the back (pynecore lib/ta.py _rank_insert_pos, "Measured on TradingView ...
// [na, na, na, 3, 4] ... [3, 4, 5, 6, na] ... [4, 5, 6, na, 8]").
function rankInsertPos(ranks: number[], value: number): number {
  const valueNa = Number.isNaN(value);
  let lo = 0;
  let hi = ranks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const other = ranks[mid]!;
    if (valueNa || Number.isNaN(other) || other - value < -PINE_EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// The slot an evicted value leaves: the last of its ties, found by the same na-transparent search; an
// evicted na takes the oldest na slot (pynecore lib/ta.py _rank_remove_pos).
function rankRemovePos(ranks: number[], value: number): number {
  if (Number.isNaN(value)) {
    const i = ranks.findIndex((other) => Number.isNaN(other));
    return i >= 0 ? i : 0;
  }
  let lo = 0;
  let hi = ranks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const other = ranks[mid]!;
    if (Number.isNaN(other) || value - other >= -PINE_EPS) lo = mid + 1;
    else hi = mid;
  }
  const ties = (other: number) => !Number.isNaN(other) && -PINE_EPS <= value - other && value - other <= PINE_EPS;
  const pos = lo - 1;
  if (pos >= 0 && pos < ranks.length && ties(ranks[pos]!)) return pos;
  // With an na in the window the search can step past the value's own slot: take the last of its
  // ties directly. A chain of ties can drift until none is left within tolerance: the closest slot.
  for (let i = ranks.length - 1; i >= 0; i--) {
    if (ties(ranks[i]!)) return i;
  }
  return pos > 0 ? pos : 0;
}

export function percentileNearestRank(
  state: PercentileState,
  value: number,
  length: number,
  percentage: number,
  barCount: number,
  barIdx: number,
): number {
  const ranks = percentileStep(state, value, length, barCount, barIdx);
  if (ranks === null) return NaN;
  const p = Number.isNaN(percentage) ? 0 : percentage;
  const n = ranks.length;
  const rank = Math.max(1, Math.min(Math.ceil((p * n) / 100), n));
  return ranks[rank - 1]!;
}

export function percentileLinearInterpolation(
  state: PercentileState,
  value: number,
  length: number,
  percentage: number,
  barCount: number,
  barIdx: number,
): number {
  const ranks = percentileStep(state, value, length, barCount, barIdx);
  if (ranks === null || Number.isNaN(percentage)) return NaN;
  const n = ranks.length;
  let pos = (n * percentage) / 100 + 0.5;
  // Floating-point noise just shy of an exact rank snaps to it.
  const nearest = Math.round(pos);
  if (Math.abs(pos - nearest) < 1e-9) pos = nearest;
  if (pos <= 1) return ranks[0]!;
  if (pos >= n) return ranks[n - 1]!;
  const lower = Math.floor(pos);
  const frac = pos - lower;
  // The weighted average, not lo + frac * (hi - lo): the two round differently and TradingView
  // follows this one (pynecore lib/ta.py _rank_linear, probe m580).
  return ranks[lower - 1]! * (1 - frac) + ranks[lower]! * frac;
}

// The series-length entry points (codegen VARLEN_RT_PATHS): the same machine.
export const percentileNearestRankVarLen = percentileNearestRank;
export const percentileLinearInterpolationVarLen = percentileLinearInterpolation;
export interface VwmaVarLenState {
  pv?: NaSkipVarLenState; // ta.sma(source * volume, length)
  v?: NaSkipVarLenState; // ta.sma(volume, length)
}

// ta.vwma(source, length) with a series length ("ARG length [series int]"): the same quotient as
// vwma() above, sma(source * volume, length) / sma(volume, length), on the series-length ta.sma
// (smaVarLen), each average over its own last `length` non-na values. A length below 1 or na is na.
export function vwmaVarLen(
  state: VwmaVarLenState,
  price: number,
  volume: number,
  length: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.pv === undefined) {
    state.pv = {};
    state.v = {};
  }
  return smaVarLen(state.pv, price * volume, length, barCount, barIdx) / smaVarLen(state.v!, volume, length, barCount, barIdx);
}

export interface DevState {
  mean?: SmaState; // ta.sma(source, length)
  buffer?: number[]; // ring of the last `length` bars' raw values, na included
  writeIdx?: number;
}

// Stores this bar's raw value, na included, in the ring of the last `length` bars. The ring starts
// full of na: a bar before the first one reads na, as `source[i]` does.
function recordLastBars(state: DevState, value: number, length: number): void {
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const at = state.writeIdx!;
  state.buffer[at] = value;
  state.writeIdx = at + 1 === length ? 0 : at + 1;
}

// The mean absolute deviation of the last `length` bars around `mean`, summed newest first (lib/ta.py
// dev: "TradingView computes the plain newest-first loop ``sum(abs(source[i] - sma)) / length``").
// An na bar in the window is na.
function lastBarsMeanAbsDev(state: DevState, length: number, mean: number): number {
  const buffer = state.buffer!;
  let i = state.writeIdx!;
  let sum = 0;
  for (let k = 0; k < length; k++) {
    i = i === 0 ? length - 1 : i - 1;
    sum += Math.abs(buffer[i]! - mean);
  }
  return sum / length;
}

// ta.dev(source, length): the manual's own Pine for it, which the oracle runs (ref_v6_ta_math.txt
// ta.dev, "the same on pine": `mean = ta.sma(source, length)`, then `sum := sum + math.abs(source[i]
// - mean)` for i = 0 to length - 1, `sum/length`; lib/ta.py dev). So the mean is ta.sma's
// na-skipping compensated machine, not a plain average of the window, and the deviation reads the
// last `length` bars, an na one making it na. Length 1 is 0 without running the sma, as in the
// oracle (and devVarLen).
export function dev(state: DevState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (length === 1) return 0;
  if (!(length >= 1)) return NaN;
  recordLastBars(state, value, length);
  const mean = sma((state.mean ??= {}), value, length);
  if (Number.isNaN(mean)) return NaN;
  return lastBarsMeanAbsDev(state, length, mean);
}

export interface RciState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.rci(source, length) - Rank Correlation Index: Spearman's rank correlation between the source
// and the bar index over `length` bars, scaled to [-100, 100] (ref_v6_ta_math.txt ta.rci: "evaluates
// the monotonic relationship between a `source` series and the bar index over `length` bars using
// Spearman's rank correlation coefficient"). This is the oracle's TradingView-exact pipeline
// (pynecore lib/ta.py rci, "validated bit-for-bit on 333k synthetic windows ... including ties"),
// ported in its operation order:
//   - na while the current source is na, and while bar_index < length (tier 1 ta_251_rci:
//     ta.rci(close, 5) is na on bars 0-4 and first valued on bar 5); the value still enters the
//     window;
//   - the window is the call site's last `length` values, newest first (x = 0 is the current bar);
//   - ranks: values are swept ascending and grouped into ties, a group taking every value closer
//     than 1e-10 to its smallest member; each group gets its 0-based average rank, descending by
//     value (the largest value ranks 0, so a steady rise correlates +100);
//   - Pearson correlation of (x, rank): moment-form variances E[v^2] - mean^2 (na when either is
//     not positive: length 1, or every value tied), covariance from deviation products,
//     100 * cov / (sd_x * sd_y).
// A past na in the window gives na (the oracle has no answer there: its tie sweep never advances
// past a nan). barIdx is bar_index (the request.security prepass passes its own row).
export function rci(state: RciState, value: number, length: number, barIdx: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const curIdx = state.writeIdx!;
  buffer[curIdx] = value;
  state.writeIdx = (curIdx + 1) % length;
  if (Number.isNaN(value) || barIdx < length) return NaN;

  const values = new Array<number>(length);
  const order = new Array<number>(length);
  for (let k = 0; k < length; k++) {
    const v = buffer[(curIdx - k + length) % length]!;
    if (Number.isNaN(v)) return NaN;
    values[k] = v;
    order[k] = k;
  }
  // Stable ascending sort by value, as Python's sorted(key=...).
  order.sort((a, b) => (values[a]! < values[b]! ? -1 : values[a]! > values[b]! ? 1 : 0));
  const ranks = new Array<number>(length);
  let pos = 0;
  let i = 0;
  while (i < length) {
    const anchor = values[order[i]!]!;
    let j = i;
    while (j < length && values[order[j]!]! - anchor < 1e-10) j++;
    const avgRank = length - 1 - (pos + pos + (j - i) - 1) / 2.0;
    for (let t = i; t < j; t++) ranks[order[t]!] = avgRank;
    pos += j - i;
    i = j;
  }
  let sumX = 0;
  let sumY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (let k = 0; k < length; k++) {
    const y = ranks[k]!;
    sumX += k;
    sumY += y;
    sumX2 += k * k;
    sumY2 += y * y;
  }
  const meanX = sumX / length;
  const meanY = sumY / length;
  const varX = sumX2 / length - meanX * meanX;
  const varY = sumY2 / length - meanY * meanY;
  if (varX <= 0 || varY <= 0) return NaN;
  let cov = 0;
  for (let k = 0; k < length; k++) cov += (k - meanX) * (ranks[k]! - meanY);
  cov /= length;
  return (100.0 * cov) / (Math.sqrt(varX) * Math.sqrt(varY));
}

export interface TsiState {
  prevSource?: number;
  e1Pc?: EmaState;
  e1Abs?: EmaState;
  e2Pc?: EmaState;
  e2Abs?: EmaState;
}

// ta.tsi(source, short_length, long_length) - True Strength Index. pine2py wavealgo/ta/tsi.py
// inlines its own _ema_step helper (count/running_sum/prev_ema) rather than reusing ema.py, but
// the step logic is identical to rt.ta.ema's 2-stage transition (accumulate `length` bars, seed
// with the SMA, then alpha=2/(length+1) exponential smoothing) - so this ports as a composition of
// the already-implemented ema() called four independent times (e1 over pc/abs(pc) with
// long_length, e2 over e1's outputs with short_length), the same "reuse an existing TA's state
// machine" principle as hma/linreg/stoch/cog. pine2py explicitly skips the e2 _ema_step calls when
// e1 is still NaN (early return before calling them); pine2js calls e2's ema() unconditionally
// every bar instead, relying on ema()'s own top-of-function `if (Number.isNaN(value)) return NaN`
// gate (ta.ts, see ema() above) to leave e2's state untouched when fed a NaN e1 output - proven
// equivalent to pine2py's call-skip via scratch/probe_tsi.mjs (sample10 + flat-series e2AbsVal===0
// + short=long=1 degenerate + source NaN gaps + zigzag + 5,000-sample fuzz across several
// short/long pairs, all PASS). prevSource is raw-passthrough (mirrors change/cmo/crossover): it is
// overwritten with the current value whenever value itself is non-NaN, even if the old prevSource
// was NaN - only value being NaN skips the update. e2AbsVal===0 (a flat source) divides to a
// non-finite value, na on a plot, not pine2py's 0.0 (see "Division by zero" at ta.iii; oracle
// lib/ta.py tsi returns `tsi_value / abs_value` unguarded).
export function tsi(state: TsiState, value: number, shortLength: number, longLength: number): number {
  if (state.prevSource === undefined) {
    state.prevSource = NaN;
    state.e1Pc = {};
    state.e1Abs = {};
    state.e2Pc = {};
    state.e2Abs = {};
  }
  if (Number.isNaN(value)) return NaN;

  const prevSource = state.prevSource;
  state.prevSource = value;
  if (Number.isNaN(prevSource)) return NaN;

  const pc = value - prevSource;
  const absPc = Math.abs(pc);

  const e1PcVal = ema(state.e1Pc!, pc, longLength);
  const e1AbsVal = ema(state.e1Abs!, absPc, longLength);
  const e2PcVal = ema(state.e2Pc!, e1PcVal, shortLength);
  const e2AbsVal = ema(state.e2Abs!, e1AbsVal, shortLength);

  if (Number.isNaN(e2PcVal) || Number.isNaN(e2AbsVal)) return NaN;
  return e2PcVal / e2AbsVal;
}

export interface MacdState {
  fast?: EmaState;
  slow?: EmaState;
  signal?: EmaState;
}

// ta.macd(source, fast_length, slow_length, signal_length) - the first multi-return TA
// ([macdLine, signalLine, histLine] tuple). pine2py wavealgo/ta/macd.py computes
// macd_line = ema(source, fast) - ema(source, slow) via the real wavealgo ema (identical to
// rt.ta.ema, C19), then inlines the signal EMA (signal_init_count/signal_init_sum/prev_signal)
// whose transition is again identical to rt.ta.ema's 2-stage machine (accumulate signal_length
// macd values, seed with their SMA, then alpha=2/(signal_length+1) smoothing) - so this ports as
// three independent ema() calls, the same composition principle as tsi (C49, four ema calls).
// pine2py early-returns (nan, nan, nan) when fast/slow is still NaN, skipping the whole signal
// block; pine2js instead feeds the NaN macdLine into ema() unconditionally and relies on its
// top-of-function NaN gate to leave the signal state untouched - proven equivalent to the
// call-skip by scratch/probe_macd.mjs (sample10 + fast==slow/fast>slow/all-1/signal-1 degenerates
// + flat series + NaN gaps in early/mid/late warmup + 5,000-sample fuzz, all PASS).
// Multi-return contract (GOAL.md "다중 반환 TA는 재사용 스크래치 배열"): instead of returning a
// per-bar tuple/array (allocation in the bar loop), the caller passes the Context's preallocated
// shared scratch array and macd() writes macdLine/signalLine/histogram into scratch[0..2].
// pine2py's macd_history list is dead state (appended, never read) and is not ported.
export function macd(
  state: MacdState,
  value: number,
  fastLength: number,
  slowLength: number,
  signalLength: number,
  scratch: Float64Array,
): void {
  if (state.fast === undefined) {
    state.fast = {};
    state.slow = {};
    state.signal = {};
  }
  const fastVal = ema(state.fast, value, fastLength);
  const slowVal = ema(state.slow!, value, slowLength);
  const macdLine = fastVal - slowVal; // 한쪽이라도 NaN이면 NaN
  const signalLine = ema(state.signal!, macdLine, signalLength);
  scratch[0] = macdLine;
  scratch[1] = signalLine;
  scratch[2] = macdLine - signalLine; // signal이 NaN이면 hist도 NaN (macd.py의 명시적 nan 반환과 동치)
}

export interface KcState {
  ema?: EmaState;
  rangeEma?: EmaState;
}

// ta.kc(source, length, mult, useTrueRange) - Keltner Channels, [basis, upper, lower]. The
// reference's own Pine equivalent (ref_v6_ta_math.txt "ta.kc", "// the same on pine"):
//   basis = ta.ema(src, length)
//   span = useTrueRange ? ta.tr : (high - low)
//   rangeEma = ta.ema(span, length)
//   [basis, basis + rangeEma * mult, basis - rangeEma * mult]
// The span is the bare `ta.tr`, i.e. ta.tr(false): na on the first bar, so the range ema, which
// skips na like every ema, reaches its seed one bar after the basis does. Both emas run every
// bar; an na basis is the na triple, a valued basis with an na range ema is [basis, na, na]
// (oracle pynecore lib/ta.py kc; tier 1 ta_171_kc; probe I04 bar 19: basis valued, upper na).
// resin used pine2py's rma-based ta.atr (tr(true)) for the range and plain high - low without the
// ema for useTrueRange = false.
//
// Pine syntax has no high/low/close parameters (only source/length/mult/useTrueRange); codegen
// injects $.high.get(0)/$.low.get(0)/$.close.get(1)(prevClose) ahead of the user args, the same
// implicit-injection pattern as ta.atr (analyzer.ts TA_REGISTRY.kc comment).
function kcSpan(high: number, low: number, prevClose: number, useTrueRange: boolean): number {
  return useTrueRange ? tr(undefined, high, low, prevClose, false) : high - low;
}

export function kc(
  state: KcState,
  high: number,
  low: number,
  prevClose: number,
  value: number,
  length: number,
  mult: number,
  useTrueRange: boolean = true,
  scratch: Float64Array,
): void {
  if (state.ema === undefined) {
    state.ema = {};
    state.rangeEma = {};
  }
  const basis = ema(state.ema, value, length);
  const rangeEma = ema(state.rangeEma!, kcSpan(high, low, prevClose, useTrueRange), length);
  scratch[0] = basis;
  if (Number.isNaN(basis) || Number.isNaN(rangeEma)) {
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }
  const range = rangeEma * mult;
  scratch[1] = basis + range;
  scratch[2] = basis - range;
}

// ta.kcw(source, length, mult, useTrueRange) - Keltner Channels Width: (upper - lower) / basis, a
// ratio, not a percentage (ref_v6_ta_math.txt "ta.kcw": "the difference between the upper and the
// lower Keltner Channels divided by the middle channel", f_kcw `((basis + rangeEma * mult) -
// (basis - rangeEma * mult)) / basis`; oracle lib/ta.py kcw, na on a zero basis; probe I04 kcw
// 0.0866 where resin's pine2py port printed 8.66). Its own call site, its own two emas.
export function kcw(
  state: KcState,
  high: number,
  low: number,
  prevClose: number,
  value: number,
  length: number,
  mult: number,
  useTrueRange: boolean = true,
): number {
  if (state.ema === undefined) {
    state.ema = {};
    state.rangeEma = {};
  }
  const basis = ema(state.ema, value, length);
  const rangeEma = ema(state.rangeEma!, kcSpan(high, low, prevClose, useTrueRange), length);
  if (Number.isNaN(basis) || basis === 0) return NaN;
  const range = rangeEma * mult;
  const upper = basis + range;
  const lower = basis - range;
  return (upper - lower) / basis;
}

export interface ObvState {
  prevObv?: number;
  prevClose?: number;
}

// ta.obv - On Balance Volume. No arguments: codegen passes $.close.get(0)/$.volume.get(0)
// (TA_REGISTRY.obv argCount:0). The manual's definition, "f_obv() => ta.cum(math.sign(ta.change(close))
// * volume)" (ref_v6_ta_math.txt ta.obv), is what TradingView computes: bar 0 has no previous close, so
// it is na, not 0 (tier 1 ta_051_iii_nvi_obv; oracle pynecore lib/ta.py obv). ta.change(close) reads
// the previous bar's close even when that is na, so the bar after an na close is na too; an na change or
// volume is na and leaves the total alone (ta.cum). prevClose is written on every bar for that reason.
// pine2py seeded 0 on the first valid bar and compared with the last valid close.
export function obv(state: ObvState, close: number, volume: number): number {
  const prevClose = state.prevClose;
  state.prevClose = close;
  if (state.prevObv === undefined) state.prevObv = 0;
  const chg = prevClose === undefined ? NaN : close - prevClose;
  if (Number.isNaN(chg) || Number.isNaN(volume)) return NaN;
  if (chg > 0) state.prevObv += volume;
  else if (chg < 0) state.prevObv -= volume;
  return state.prevObv;
}

export interface AccDistState {
  cum?: number;
}

// ta.accdist() - Accumulation/Distribution. No arguments: codegen passes close/high/low/volume
// (TA_REGISTRY.accdist argCount:0). A running total of the money flow volume
// mfv = ((close - low) - (high - close)) / (high - low) * volume. A flat bar (high == low) is not
// pine2py's mfv 0: it divides (see "Division by zero" at ta.iii), and a NaN mfv (0/0, or ±inf times
// a zero volume) leaves the total alone while ±inf enters it (oracle lib/ta.py accdist:
// `if mfv == mfv: ad += mfv`). An na input is na on its bar and leaves the total alone.
export function accdist(state: AccDistState, close: number, high: number, low: number, volume: number): number {
  if (Number.isNaN(close) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(volume)) return NaN;
  const mfv = (((close - low) - (high - close)) / (high - low)) * volume;
  if (state.cum === undefined) state.cum = 0;
  if (!Number.isNaN(mfv)) state.cum += mfv;
  return state.cum;
}

export interface PvtState {
  cum?: number;
  prevClose?: number;
}

// ta.pvt - Price Volume Trend. No arguments: codegen passes $.close.get(0)/$.volume.get(0)
// (TA_REGISTRY.pvt argCount:0). The manual's definition, "f_pvt() => ta.cum((ta.change(close) /
// close[1]) * volume)" (ref_v6_ta_math.txt ta.pvt), is what TradingView computes: bar 0 has no
// previous close, so it is na, not 0 (tier 1 ta_341_accdist_pvi_pvt_wad_wvad; oracle pynecore
// lib/ta.py pvt). close[1] is the previous bar's close even when that is na; an na term (na close on
// either bar, na volume, a zero previous close: Pine's division by zero is na) is na and leaves the
// total alone (ta.cum). pine2py seeded 0 on the first valid bar and read a zero previous close as 0%.
export function pvt(state: PvtState, close: number, volume: number): number {
  const prevClose = state.prevClose;
  state.prevClose = close;
  if (state.cum === undefined) state.cum = 0;
  if (prevClose === undefined || prevClose === 0) return NaN;
  const term = ((close - prevClose) / prevClose) * volume;
  if (Number.isNaN(term)) return NaN;
  state.cum += term;
  return state.cum;
}

export interface WadState {
  prevClose?: number;
  cumWad?: number;
}

// ta.wad() - Williams Accumulation/Distribution. Pine 문법상 인자가 없고(high/low/close는 bar
// series 암묵 사용, obv와 동일한 implicit unshift 패턴) codegen이 셋을 뒤에 끼워 넣는다
// (TA_REGISTRY.wad argCount:0). pine2py wavealgo/ta/wad.py 소스 대조 결과 obv/pvt와 같은 "최초
// 유효 바 0.0 시드, NaN이면 state 전혀 안 건드림" 부류이지만, 누적하는 값 자체가 obv의 "오르면
// +volume/내리면 -volume/tie면 유지"가 아니라 그 바의 range로 계산한 파생값(gain)이라는 점이
// 다르다 — trueHigh=max(high,prevClose)/trueLow=min(low,prevClose)로 그 바의 실질 변동폭을 구한 뒤
// close>prevClose면 gain=close-trueLow, close<prevClose면 gain=close-trueHigh, tie면 gain=0을
// cumWad에 누적(scratch/probe_pvt_wad.mjs로 브루트포스 대조 완료).
export function wad(state: WadState, high: number, low: number, close: number): number {
  if (Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close)) return NaN;
  if (state.prevClose === undefined) {
    state.prevClose = close;
    state.cumWad = 0;
    return 0;
  }
  const prevClose = state.prevClose;
  const trueHigh = Math.max(high, prevClose);
  const trueLow = Math.min(low, prevClose);
  let gain: number;
  if (close > prevClose) gain = close - trueLow;
  else if (close < prevClose) gain = close - trueHigh;
  else gain = 0;
  state.cumWad = state.cumWad! + gain;
  state.prevClose = close;
  return state.cumWad;
}

export interface NviState {
  prevNvi?: number;
  prevClose?: number;
  prevVolume?: number;
}

// ta.nvi() - Negative Volume Index. Pine 문법상 인자가 없고(close/volume은 bar series 암묵 사용,
// obv/pvt/wad와 동일한 implicit unshift 패턴) codegen이 둘을 끼워 넣는다(TA_REGISTRY.nvi
// argCount:0). pine2py wavealgo/ta/nvi.py 소스 대조 결과 obv류와 같은 "NaN이면 state 전혀 안
// 건드리고 즉시 NaN" 부류이지만 초기 시드가 **1.0**(obv/pvt/wad의 0.0과 다름)이고, prevClose===0
// 가드가 elif 체인의 **최상단**이라 volume<prevVolume 조건과 완전히 무관하게 무조건
// hold(current=prev)한다는 점이 pvt의 "가드 시 change_pct=0.0으로 대체하고 계속 갱신"과 다르다
// (scratch/probe_nvi_pvi.mjs로 이 우선순위를 포함해 브루트포스 대조 완료). volume이 직전 바보다
// **작을 때만**(엄격 부등호, tie는 hold) 복리 갱신.
export function nvi(state: NviState, close: number, volume: number): number {
  if (Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  if (state.prevNvi === undefined) {
    state.prevNvi = 1;
    state.prevClose = close;
    state.prevVolume = volume;
    return 1;
  }
  const prevClose = state.prevClose!;
  const prevVolume = state.prevVolume!;
  const prevNvi = state.prevNvi;
  let currentNvi: number;
  if (prevClose === 0) currentNvi = prevNvi;
  else if (volume < prevVolume) currentNvi = prevNvi + ((close - prevClose) / prevClose) * prevNvi;
  else currentNvi = prevNvi;
  state.prevNvi = currentNvi;
  state.prevClose = close;
  state.prevVolume = volume;
  return currentNvi;
}

export interface PviState {
  prevPvi?: number;
  prevClose?: number;
  prevVolume?: number;
}

// ta.pvi() - Positive Volume Index. nvi와 완전 대칭(volume이 직전 바보다 **클 때만**, 엄격 부등호,
// 복리 갱신) — 상세는 nvi 주석 참조.
export function pvi(state: PviState, close: number, volume: number): number {
  if (Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  if (state.prevPvi === undefined) {
    state.prevPvi = 1;
    state.prevClose = close;
    state.prevVolume = volume;
    return 1;
  }
  const prevClose = state.prevClose!;
  const prevVolume = state.prevVolume!;
  const prevPvi = state.prevPvi;
  let currentPvi: number;
  if (prevClose === 0) currentPvi = prevPvi;
  else if (volume > prevVolume) currentPvi = prevPvi + ((close - prevClose) / prevClose) * prevPvi;
  else currentPvi = prevPvi;
  state.prevPvi = currentPvi;
  state.prevClose = close;
  state.prevVolume = volume;
  return currentPvi;
}

// ta.wvad() - Williams Variable Accumulation/Distribution, stateless. No arguments: codegen passes
// open/high/low/close/volume (TA_REGISTRY.wvad argCount:0). The manual's
// "f_wvad() => (close - open) / (high - low) * volume" (ref_v6_ta_math.txt ta.wvad), so a flat bar
// divides by zero (see "Division by zero" at ta.iii; oracle lib/ta.py wvad), not pine2py's 0.
export function wvad(_state: unknown, open: number, high: number, low: number, close: number, volume: number): number {
  if (Number.isNaN(open) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  return ((close - open) / (high - low)) * volume;
}

// ta.iii() - Intraday Intensity Index, stateless. No arguments: codegen passes high/low/close/volume
// (TA_REGISTRY.iii argCount:0). TradingView divides by the volume, (2 * close - high - low) /
// ((high - low) * volume) (tier 1 ta_051_iii_nvi_obv; oracle lib/ta.py iii), although the manual's
// f_iii multiplies by it (ref_v6_ta_math.txt ta.iii).
//
// Division by zero. Pine's `/` on a zero denominator is IEEE-754: x / 0 is +inf or -inf by x's sign
// and 0 / 0 is NaN, and `na()` reads all three as na, so a plot shows none of them (oracle
// pynecore core/safe_convert.py safe_div: "division by zero returns raw inf/-inf/nan, the `na()`
// predicate (`not isfinite`) reports them as na"; lib/ta.py cmo: "TradingView's 0/0 is nan, so the
// oscillator is na").
// A builtin the reference defines as a quotient therefore returns that quotient, never pine2py's 0:
// here a flat bar (high == low) or a zero-volume bar is na (indicators probe I07, bars 95 and 97,
// volume 0). The same holds for ta.wvad, ta.accdist, ta.cmo, ta.cci, ta.stoch, ta.wpr and ta.tsi.
export function iii(_state: unknown, high: number, low: number, close: number, volume: number): number {
  if (Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  return (2 * close - high - low) / ((high - low) * volume);
}

export interface VwapState {
  cumPv?: number;
  cumVol?: number;
  // Σ(source²·volume) for the 3-argument band form (C362). Kept whatever the form (the
  // 1/2-argument forms never read it, so it cannot change their value).
  cumPv2?: number;
  // The anchor has been true once: the sums hold a period.
  anchored?: boolean;
}

// ta.vwap(source[, anchor[, stdev_mult]]) - Volume Weighted Average Price. Pine 문법상 volume
// 인자가 없고 내장 bar series volume을 암묵 사용한다(vwma/mfi와 동일 — codegen이 $.volume.get(0)을
// source 바로 뒤에 splice, TA_REGISTRY.vwap 주석 참조).
//
// - anchor(series bool)가 true인 바에서 세 러닝 합계가 그 바 자신에서 새로 시작한다. na(NaN)
//   anchor는 false 취급(리셋 아님). (The earlier 1-argument form, pine2py's never-reset running sum,
//   and the reset on a na-source bar are gone: see the anchor contract below.)
// - 3-인자 폼(stdevMult + scratch 존재)은 반환 대신 scratch[0..2]=[vwap, upper, lower]를 쓴다
//   (다중 반환 TA 공유 스크래치 규약, GOAL.md). 분산은 TV 소스와 동일한 volume-가중 모멘트 공식
//   Var = Σ(vol·src²)/Σvol − vwap² (음수는 0으로 클램프 — TV 소스 자체가 동일 클램프 보유),
//   upper/lower = vwap ± stdevMult·sqrt(Var). vwap가 NaN이면 밴드도 전부 NaN.
// 튜플 순서 [vwap, upper, lower]는 TV 레퍼런스 시그니처 및 wild 실사용
// (`[vwap, upper, lower] = ta.vwap(...)` 변수명 관행)과 일치 — 웹 미검증이라 가설로 등재.
//
// The anchor contract (ref_v6_ta_math.txt ta.vwap): "Calculations only begin the first time the
// anchor condition becomes true. Until then, the function returns na." The value is na, and
// nothing is accumulated, until an anchor bar; an anchor bar starts the sums from its own
// source·volume. A bar whose source is na returns na and leaves the sums and the anchor alone
// (it neither resets nor accumulates); a na volume turns the sums na until the next anchor.
// codegen passes session.isfirstbar when the call gives no anchor. pynecore lib/ta.py vwap
// implements exactly this; tier 1 ta_301_vwap (timeframe.change("240"/"360") anchors are na
// until the first 4h/6h boundary).
export function vwap(
  state: VwapState,
  value: number,
  volume: number,
  anchor: boolean | number = false,
  stdevMult: number = NaN,
  scratch?: Float64Array,
): number {
  const na = (): number => {
    if (scratch !== undefined) {
      scratch[0] = NaN;
      scratch[1] = NaN;
      scratch[2] = NaN;
    }
    return NaN;
  };
  if (Number.isNaN(value)) return na();
  // A numeric anchor (v5 casts int/float to bool) is true when non-zero; na is false.
  if (anchor) {
    state.cumPv = value * volume;
    state.cumVol = volume;
    state.cumPv2 = 0;
    state.anchored = true;
  } else if (state.anchored === true) {
    state.cumPv! += value * volume;
    state.cumVol! += volume;
  } else {
    return na();
  }
  const cumVol = state.cumVol!;
  const v = state.cumPv! / cumVol;
  if (Number.isNaN(v)) return na();
  // Σ(source²·volume) takes a bar only once its vwap is known, and each term is
  // (source * source) * volume in that order: the oracle's sum (pynecore lib/ta.py vwap,
  // `sum_ppv += src * src * volume` after the na-vwap return). The product order is not
  // algebra only: on an anchor bar (volume * source) * source / volume can land one ulp
  // above source², so the band's variance came out ~1e-12 instead of 0 and sqrt spread it
  // to ~1e-6 (repro ta.volume-seed-7: bar 0 upper band 99.42666801536582, oracle
  // 99.42666666666666 = the vwap).
  state.cumPv2! += value * value * volume;
  if (scratch !== undefined) {
    let variance = state.cumPv2! / cumVol - v * v;
    if (variance < 0) variance = 0;
    const sd = Math.sqrt(variance);
    scratch[0] = v;
    scratch[1] = v + stdevMult * sd;
    scratch[2] = v - stdevMult * sd;
  }
  return v;
}

export interface PivotState {
  ring?: ExtremeRingState;
}

// ta.pivothigh/ta.pivotlow(source, leftbars, rightbars), a literal or a series strength: the
// oracle's composition (pynecore lib/ta.py pivothigh/pivotlow), ta.highest/ta.lowest(source,
// leftbars + rightbars + 1) on the extremes' bar-addressed ring (extremeRing), a pivot when the
// window's extreme sits `rightbars` bars back:
//   - an na source is na on its bar WITHOUT running the ring (`if not (source == source): return
//     na_float` precedes the `highest` call). The na bar neither resets the window nor is written
//     to it, so its slot serves what was written a whole ring earlier, as for a gated ta.highest.
//     pine2py's poison window (na for the next `leftbars + rightbars + 1` bars after one na source)
//     missed every pivot there (repro state/repros/ta.extremes-seed-13.json: ta.pivotlow(s0, 5, 4)
//     with s0 na on every 4th bar reports bar 26's 100.48 at bar 30);
//   - ties are asymmetric: the bar `rightbars` back is a pivot only when it holds the NEWEST
//     occurrence of the window's extreme (`_check_eq=True`): an equal value on the left (older
//     bars) does not break it, one on the right (newer bars) does. Tier 1
//     ta_369_pivot_zero_strength (BINANCE:BTCUSDT 30m) bar 208: ta.pivothigh(high, 0, 5) is na
//     although bar 203's high 98500 is the window's maximum, because bar 205 reaches 98500 again;
//     at bar 210 the same call reports bar 205's 98500 with the equal bar 203 on its left;
//   - na while bar_index < leftbars + rightbars (the ring's warm-up).
// A zero strength is legal on that side ("TradingView rejects only a NEGATIVE strength (RE10001,
// "must be >= 0")", measured there). The manual (ref_v6_ta_math.txt ta.pivothigh) says only
// "returns price of the pivot high point. It returns 'NaN', if there was no pivot high point".
function pivot(state: PivotState, source: number, left: number, right: number, barIdx: number, low: boolean): number {
  const l = Math.trunc(left);
  const r = Math.trunc(right);
  if (!(l >= 0 && r >= 0) || Number.isNaN(source)) return NaN;
  if (state.ring === undefined) state.ring = {};
  const extreme = extremeRing(state.ring, source, l + r + 1, barIdx, low, true);
  return !Number.isNaN(extreme) && state.ring.extremeIndex === r ? extreme : NaN;
}

export function pivothigh(state: PivotState, source: number, left: number, right: number, barIdx: number): number {
  return pivot(state, source, left, right, barIdx, false);
}

export function pivotlow(state: PivotState, source: number, left: number, right: number, barIdx: number): number {
  return pivot(state, source, left, right, barIdx, true);
}

export interface SupertrendState {
  atr?: AtrState;
  called?: boolean;
  upper?: number;
  lower?: number;
  close?: number;
  direction?: number;
  value?: number;
}

// ta.supertrend(factor, atrPeriod) -> [supertrend, direction]. Direction is 1 in a downtrend (the
// line is the upper band) and -1 in an uptrend (the line is the lower band): TradingView's built-in
// "Supertrend Strategy" enters long on `ta.change(direction) < 0` and short on `> 0`, and its tier 1
// List of Trades export opens long first (harness suites/strategy/tv/supertrend, trade #1 long at
// bar 62); the oracle agrees (PyneCore lib/ta.py supertrend: "Direction: 1=down, -1=up"). The rule
// is the reference pine_supertrend():
//   upper/lower = hl2 ± factor * ta.atr(atrPeriod)
//   lower := lower > lower[1] or close[1] < lower[1] ? lower : lower[1]   (upper mirrored)
//   direction := na(atr[1]) ? 1 : supertrend[1] == upper[1] ? (close > upper ? -1 : 1)
//                                                           : (close < lower ? 1 : -1)
//   supertrend := direction == -1 ? lower : upper
// so the flip is judged against this bar's adjusted bands, and the previous line's band (not a
// stored trend flag) picks which band is tested. The first bar returns (0, 1): close[1] is na there,
// so the upper band falls back to nz(upper[1]) = 0. Warm-up bars (ATR na) return (na, 1), and the
// first valid bar returns (upper, 1). Harness repro state/repros/supertrend-direction.json.
//
// Pine syntax has no high/low/close parameters; codegen injects $.high.get(0)/$.low.get(0)/
// $.close.get(0)(current close)/$.close.get(1)(prevClose for the inner atr call) ahead of the two
// user args (factor, atrPeriod). The band adjustment's close[1] is the close stored at the last
// valid bar (the oracle's prev_close; the same bar unless high/low had a gap).
export function supertrend(
  state: SupertrendState,
  high: number,
  low: number,
  close: number,
  prevClose: number,
  factor: number,
  atrPeriod: number,
  scratch: Float64Array,
): void {
  if (state.atr === undefined) state.atr = {};
  const atrVal = atr(state.atr, high, low, prevClose, atrPeriod);

  // The first bar: close[1] is na, so the upper band falls back to nz(upperBand[1]) = 0 and the
  // line reads 0 with direction 1. The ATR above still advances.
  if (state.called !== true) {
    state.called = true;
    scratch[0] = 0;
    scratch[1] = 1;
    return;
  }

  const src = (high + low) / 2;
  if (Number.isNaN(src) || Number.isNaN(atrVal)) {
    // Warm-up (or a gap): no line, direction holds (1 before the first valid bar); state untouched.
    scratch[0] = NaN;
    scratch[1] = state.direction ?? 1;
    return;
  }
  const upper = src + factor * atrVal;
  const lower = src - factor * atrVal;

  if (state.direction === undefined) {
    // na(atr[1]): the first valid bar starts in a downtrend, on the upper band.
    state.upper = upper;
    state.lower = lower;
    state.close = close;
    state.direction = 1;
    state.value = upper;
    scratch[0] = upper;
    scratch[1] = 1;
    return;
  }

  const prevUpper = state.upper!;
  const prevLower = state.lower!;
  const prevClose1 = state.close!;
  const currLower = lower > prevLower || prevClose1 < prevLower ? lower : prevLower;
  const currUpper = upper < prevUpper || prevClose1 > prevUpper ? upper : prevUpper;
  // The previous line sat on the upper band (downtrend): flip up when the close crosses above this
  // bar's upper band. Otherwise flip down when the close crosses below this bar's lower band.
  const direction =
    state.value === prevUpper ? (close > currUpper ? -1 : 1) : close < currLower ? 1 : -1;
  const value = direction === 1 ? currUpper : currLower;

  state.upper = currUpper;
  state.lower = currLower;
  state.close = close;
  state.direction = direction;
  state.value = value;

  scratch[0] = value;
  scratch[1] = direction;
}

export interface SarState {
  // The call site's own window of high/low, one and two calls back.
  high1?: number;
  high2?: number;
  low1?: number;
  low2?: number;
  // The recurrence, seeded by the first call made after bar 0.
  seeded?: boolean;
  posLong?: boolean;
  af?: number;
  sar?: number;
  ep?: number;
}

// Python's builtins.max/min: the first argument is kept unless a later one compares greater (less),
// so an na first argument stays na and an na later one is skipped (every comparison with na is
// false). ta.sar's clips are written that way in the oracle, and Math.max/min would differ on both.
function pyMax(a: number, b: number, c = NaN, d = NaN): number {
  let m = a;
  if (b > m) m = b;
  if (c > m) m = c;
  if (d > m) m = d;
  return m;
}

function pyMin(a: number, b: number, c = NaN, d = NaN): number {
  let m = a;
  if (b < m) m = b;
  if (c < m) m = c;
  if (d < m) m = d;
  return m;
}

// ta.sar(start, inc, maxAf) - Parabolic SAR (Wilder). The manual gives no formula
// (ref_v6_ta_math.txt "ta.sar": "Parabolic SAR (parabolic stop and reverse) is a method devised by
// J. Welles Wilder, Jr., to find potential reversals in the market price direction of traded
// goods."), so the rule is the PyneCore oracle's, certified against TradingView (pynecore lib/ta.py
// sar; tier 1 ta_261_sar, ta_366_conditional_sar):
//   - bar_index 0 is na;
//   - bar_index 1 starts the trend: short from high[1] with the bar's low as the extreme point when
//     high[1] > high, otherwise long from low[1] with the bar's high as the extreme point; that
//     start is the bar's value;
//   - later bars project sar + af * (ep - sar); a long reverses when low < the projection (strict:
//     "a bar whose ... low equals the long stop does NOT reverse", measured there), restarting at
//     max(ep, high, high[1], high[2]) with af = start and ep = low; otherwise the projection is
//     clipped to min(low[1], low[2]) and a new high raises ep and af by inc up to maxAf. A short
//     mirrors it. high[2]/low[2] fall back to high[1]/low[1] when na.
// bar_index is the global one, and high[1]/high[2] come from the call site's own window, which
// advances per call (oracle: "a ta.sar() inside an `if` is na on TradingView for the whole run,
// even when only every 100th bar is skipped ... The first gated call has no history yet, so
// high[1] is na and the recurrence below carries that na forward for good"; tier 1
// ta_366_conditional_sar). A call first made after bar 1 never starts a trend and stays na too.
// af is seeded with start by the first call made after bar 0 (the oracle's lazy Persistent
// initializer). None of start/inc/maxAf is validated: "TradingView validates NONE of the three
// arguments -- it runs the recurrence with whatever it is given" (oracle, measured).
//
// Pine syntax takes only (start, inc, maxAf); codegen injects the bar's high and low ahead of them
// and bar_index after (analyzer TA_REGISTRY.sar).
export function sar(
  state: SarState,
  high: number,
  low: number,
  start: number,
  inc: number,
  maxAf: number,
  barIdx: number,
): number {
  const high1 = state.high1 ?? NaN;
  const high2 = state.high2 ?? NaN;
  const low1 = state.low1 ?? NaN;
  const low2 = state.low2 ?? NaN;
  state.high2 = high1;
  state.high1 = high;
  state.low2 = low1;
  state.low1 = low;

  if (barIdx === 0) return NaN;

  if (state.seeded !== true) {
    state.seeded = true;
    state.posLong = true;
    state.af = start;
    state.sar = NaN;
    state.ep = NaN;
  }

  if (barIdx === 1) {
    if (high1 > high) {
      state.posLong = false;
      state.sar = high1;
      state.ep = low;
    } else {
      state.posLong = true;
      state.sar = low1;
      state.ep = high;
    }
    return state.sar;
  }

  const prev = state.sar!;
  let ep = state.ep!;
  let af = state.af!;
  let next = prev + af * (ep - prev);
  if (state.posLong) {
    if (low < next) {
      state.posLong = false;
      af = start;
      next = pyMax(ep, high, high1, high2 === high2 ? high2 : high1);
      ep = low;
    } else {
      next = pyMin(next, low1, low2 === low2 ? low2 : low1);
      if (high > ep) {
        ep = high;
        af = pyMin(af + inc, maxAf);
      }
    }
  } else {
    if (high > next) {
      state.posLong = true;
      af = start;
      next = pyMin(ep, low, low1, low2 === low2 ? low2 : low1);
      ep = high;
    } else {
      next = pyMax(next, high1, high2 === high2 ? high2 : high1);
      if (low < ep) {
        ep = low;
        af = pyMin(af + inc, maxAf);
      }
    }
  }
  state.sar = next;
  state.ep = ep;
  state.af = af;
  return next;
}

export interface DmiState {
  tr?: RmaState;
  plus?: RmaState;
  minus?: RmaState;
  adx?: RmaState;
}

// ta.dmi(diLength, adxSmoothing) - Directional Movement Index, returnArity:3 ([+DI, -DI, ADX]).
// The manual gives no formula (ref_v6_ta_math.txt "ta.dmi" only names the three series); the rule
// is TradingView's built-in "Directional Movement Index" script, as the PyneCore oracle measured it
// (pynecore lib/ta.py dmi):
//   up = ta.change(high), down = -ta.change(low)
//   +DM = up if up > down and up > 0, else 0; -DM mirrored; both na while up or down is na
//   +DI = 100 * ta.rma(+DM, diLength) / ta.rma(ta.tr, diLength), -DI mirrored
//   ADX = ta.rma(|+DI - -DI| / (sum == 0 ? 1 : sum), adxSmoothing) * 100, sum = +DI + -DI
// Every rma is entered on every bar, the first included, and seeds on its first diLength non-na
// values like any ta.rma. ta.tr here is ta.tr(false): na on the first bar (no close[1]), exact from
// the second; +DM/-DM are na there too, so all three seed over bars 1..diLength and the DIs start on
// bar diLength (tier 1 resin-harness suites/indicators/tv/ta_121_dmi: ta.dmi(17, 14) +DI na on bar
// 16, 11.454965358 on bar 17). resin had pine2py's variant (seeded on one raw value, one bar late).
// The DM selection compares with Pine's 1e-10 tolerance: a bar whose high and low moved by the same
// quantized amount has no directional movement even when the float differences land ~1e-18 apart
// (PyneCore, measured on TradingView). A bar where any rma is na or the true-range rma is 0 returns
// the na triple and does not feed the ADX rma.
export function dmi(
  state: DmiState,
  high: number,
  low: number,
  _close: number,
  prevHigh: number,
  prevLow: number,
  prevClose: number,
  diLength: number,
  adxSmoothing: number,
  scratch: Float64Array,
): void {
  if (state.tr === undefined) {
    state.tr = {};
    state.plus = {};
    state.minus = {};
    state.adx = {};
  }
  const up = high - prevHigh;
  const down = -(low - prevLow);
  const trRma = rma(state.tr, tr(undefined, high, low, prevClose, false), diLength);
  const dmNa = Number.isNaN(up) || Number.isNaN(down);
  const plusDm = dmNa ? NaN : up - down > PINE_EPS && up > PINE_EPS ? up : 0;
  const minusDm = dmNa ? NaN : down - up > PINE_EPS && down > PINE_EPS ? down : 0;
  const plusRma = rma(state.plus!, plusDm, diLength);
  const minusRma = rma(state.minus!, minusDm, diLength);
  if (Number.isNaN(trRma) || Number.isNaN(plusRma) || Number.isNaN(minusRma) || trRma === 0) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }
  const plusDi = (100 * plusRma) / trRma;
  const minusDi = (100 * minusRma) / trRma;
  const sum = plusDi + minusDi;
  scratch[0] = plusDi;
  scratch[1] = minusDi;
  scratch[2] = rma(state.adx!, Math.abs(plusDi - minusDi) / (sum !== 0 ? sum : 1), adxSmoothing) * 100;
}

export type SumState = SmaState;

// math.sum(source, length) - the na-skipping rolling sum ta.sma is built on (naSkipSum): the sum
// of the last `length` non-na values, na until that many have arrived. pine2py's math.sum counted
// na as 0 and summed whatever prefix it had during the warm-up (0.0 over an all-na window); both
// contradict the reference and the oracle (see naSkipSum).
export function sum(state: SumState, value: number, length: number): number {
  return naSkipSum(state, value, length);
}

export interface RandomState {
  // java.util.Random's 48-bit state as two 24-bit halves, so every step is exact in a double.
  // Unset until the call site's first execution seeds it.
  hi?: number;
  lo?: number;
}

const RANDOM_MULT_HI = 0x5de; // 0x5DEECE66D, java.util.Random's multiplier, split at bit 24
const RANDOM_MULT_LO = 0xece66d;
const TWO_24 = 16777216;

// java.util.Random(seed): the initial scramble (seed ^ 0x5DEECE66D) mod 2^48. The seed is an
// "int" argument, so a fractional one is truncated; BigInt keeps a negative or large seed's
// two's-complement low 48 bits exact.
function randomSeed(state: RandomState, seed: number): void {
  const s = (BigInt(Math.trunc(seed)) ^ 0x5deece66dn) & 0xffffffffffffn;
  state.hi = Number(s >> 24n);
  state.lo = Number(s & 0xffffffn);
}

// java.util.Random.next(bits): state = (0x5DEECE66D * state + 0xB) mod 2^48, then its top `bits`
// bits. Each partial product stays below 2^49, exact in a double.
function randomNext(state: RandomState, bits: number): number {
  const lo = state.lo!;
  const hi = state.hi!;
  const p = RANDOM_MULT_LO * lo + 0xb;
  const nextLo = p % TWO_24;
  const nextHi = (RANDOM_MULT_HI * lo + RANDOM_MULT_LO * hi + Math.floor(p / TWO_24)) % TWO_24;
  state.hi = nextHi;
  state.lo = nextLo;
  return Math.floor((nextHi * TWO_24 + nextLo) / 2 ** (48 - bits));
}

// The seed of a call site given none: TradingView uses the clock, resin the call-site slot, spread
// by a SplitMix32-style mix, because java.util.Random seeded with neighbouring integers starts
// with nearly equal draws (new Random(0) and new Random(1) both begin at 0.7309...).
function mixSite(site: number): number {
  let h = (Math.trunc(site) | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// math.random(min=0, max=1, seed). Each call site owns one generator, seeded on its first
// execution and advanced by one draw on every execution after that, so a seed gives a repeatable
// sequence, not one repeated value (ref_v6_ta_math.txt "math.random": "Using the same value for
// the optional seed argument will produce a repeatable sequence"; the seed "allows successive
// calls to the function to produce a repeatable set of values"). The generator is Java's
// java.util.Random and the draw is its nextDouble(): tier 1 math_003_random, TradingView's Pine
// Logs of two math.random(0, 1, 42) call sites on bars 0-9, logs 0.727563680032868,
// 0.683223471759845, 0.30871945533266, ... for both sites (new Random(42).nextDouble() in turn),
// the oracle's core/random.py PineRandom. A seed passed on later executions is not read again
// (the oracle's lazily created Persistent generator). Without a seed TradingView starts from the
// clock; resin seeds from the call-site slot `site` instead (mixSite), so a run is reproducible.
// na min/max propagate through the arithmetic, and the draw is still taken.
export function random(
  state: RandomState,
  min: number = 0,
  max: number = 1,
  seed: number = NaN,
  site: number = 0,
): number {
  if (state.hi === undefined) randomSeed(state, Number.isFinite(seed) ? seed : mixSite(site));
  const unit = (randomNext(state, 26) * 134217728 + randomNext(state, 27)) / 9007199254740992; // 2^27, 2^53
  return min + unit * (max - min);
}

// ta.pivot_point_levels(type, anchor, developing=false) — 지정한 방식(type 문자열)의 피벗 포인트
// 레벨 11종을 [P, R1, S1, R2, S2, R3, S3, R4, S4, R5, S5] 순서의 array<float>로 반환한다(C653,
// hand-verified — pine2py wavealgo/ta/·codegen.py 전수 grep 0건이라 오라클 골든 생성 자체가 불가능,
// ta.dema/ao(C544)/ta.rci(C546)와 동일한 배치25 (3) 트랙. 반환 계약(11슬롯 고정, 해당 type에 없는
// 레벨은 na)과 6종 type 문자열은 wild 코퍼스의 TV 공식 문서 스크레이프(86e04be3ab6c.pine
// "RETURNS:: An array of floats: [P, R1, S1, ...]")와 TV Pivot Points Standard 지표 사본
// (0785fa2bf2c7.pine의 numOfPivotLevels: Traditional/Camarilla=11, Woodie/Classic=9, Fibonacci=7,
// DM=3 + 6종 공식 원문)으로 교차 확정 — 단 이 세션은 웹 접근이 없어 1차 검증은 아니다,
// DIVERGENCES.md "TV 미검증(가설)" 참조).
//
// anchor(series bool)가 true인 바에서 "직전 anchor부터 그 직전 바까지"(직전 구간)의 누적
// high/low/구간 첫 바 open/구간 마지막 바 close로 레벨을 계산해 고정하고, 새 구간 누적을 그 바부터
// 다시 시작한다. 첫 anchor 이전 바들은 전부 na(TV 문서 "values calculated the last time the anchor
// condition was true"). developing=true면 매 바 "마지막 anchor(없으면 bar 0)부터 현재 바까지"의
// 누적치 + 현재 close로 재계산한다 — Woodie/DM은 TV가 developing을 지원하지 않아(공식 레퍼런스
// "It cannot be true when type is set to 'Woodie' or 'DM'") runtime.error와 동일한 예외를 던진다.
//
// 반환 배열은 GOAL.md "bar loop 안 할당 제로" 원칙대로 상태에 1회 할당해 매 호출 같은 핸들을
// 채워 반환한다(다중 반환 TA의 재사용 스크래치 배열과 동일 원리 — TV는 매 바 새 배열일 수 있으나
// 사용자 뮤테이션이 다음 바까지 관측되는 시나리오는 wild 전무, length=11 재고정으로 push 오염만
// 방어). 누적은 NaN-skip(na 바가 구간 극값을 오염시키지 않음), close가 na인 바는 "구간 마지막
// close" 갱신도 스킵한다(모두 hand-verified 결정 — pine2py 대응 부재로 오라클 불가).
export interface PivotPointLevelsState {
  levels?: number[]; // 재사용 11슬롯 반환 핸들
  accHigh?: number; // 진행 중 구간 누적 극값 (NaN-skip)
  accLow?: number;
  accOpen?: number; // 진행 중 구간 첫 바 open (DM의 OPENprev / Woodie 계산엔 새 구간 open을 씀)
  lastClose?: number; // 직전 유효 close (anchor 바에서 "직전 구간 마지막 close"로 소비)
  hasPeriod?: boolean; // 진행 중 구간에 바가 1개 이상 쌓였는가
}

// type별 공식 — arr[0..10]을 전부 덮어쓴다(해당 type에 없는 레벨은 NaN). curOpen은 Woodie 전용
// (새 구간 첫 바 open), prevOpen은 DM 전용(직전 구간 첫 바 open). Camarilla R5/S5는 TV 표준 지표의
// 옛 수동 계산 사본(wild 9ee27e65bc9d.pine, H5 = H4 + 1.168*(H4-H3))을 채택 — 커뮤니티 변형이
// 둘 존재해(H5=(H/L)*C 형) 이 서브공식만 가설 신뢰도가 한 단계 낮다(DIVERGENCES 참조).
function fillPivotLevels(
  arr: number[],
  type: string,
  prevOpen: number,
  high: number,
  low: number,
  close: number,
  curOpen: number,
): void {
  for (let i = 0; i < 11; i++) arr[i] = NaN;
  const range = high - low;
  if (type === "Traditional") {
    const p = (high + low + close) / 3;
    arr[0] = p;
    arr[1] = p * 2 - low;
    arr[2] = p * 2 - high;
    arr[3] = p + range;
    arr[4] = p - range;
    arr[5] = p * 2 + (high - 2 * low);
    arr[6] = p * 2 - (2 * high - low);
    arr[7] = p * 3 + (high - 3 * low);
    arr[8] = p * 3 - (3 * high - low);
    arr[9] = p * 4 + (high - 4 * low);
    arr[10] = p * 4 - (4 * high - low);
  } else if (type === "Fibonacci") {
    const p = (high + low + close) / 3;
    arr[0] = p;
    arr[1] = p + 0.382 * range;
    arr[2] = p - 0.382 * range;
    arr[3] = p + 0.618 * range;
    arr[4] = p - 0.618 * range;
    arr[5] = p + range;
    arr[6] = p - range;
  } else if (type === "Woodie") {
    const p = (high + low + 2 * curOpen) / 4;
    arr[0] = p;
    arr[1] = 2 * p - low;
    arr[2] = 2 * p - high;
    arr[3] = p + range;
    arr[4] = p - range;
    const r3 = high + 2 * (p - low);
    const s3 = low - 2 * (high - p);
    arr[5] = r3;
    arr[6] = s3;
    arr[7] = r3 + range;
    arr[8] = s3 - range;
  } else if (type === "Classic") {
    const p = (high + low + close) / 3;
    arr[0] = p;
    arr[1] = 2 * p - low;
    arr[2] = 2 * p - high;
    arr[3] = p + range;
    arr[4] = p - range;
    arr[5] = p + 2 * range;
    arr[6] = p - 2 * range;
    arr[7] = p + 3 * range;
    arr[8] = p - 3 * range;
  } else if (type === "DM") {
    let x: number;
    if (prevOpen === close) {
      x = high + low + 2 * close;
    } else if (close > prevOpen) {
      x = 2 * high + low + close;
    } else {
      x = 2 * low + high + close;
    }
    // prevOpen이 NaN이면 위 비교가 전부 false로 떨어져 else(2L+H+C) 분기가 잡히지만 x 산술이
    // close/high/low 유효 여부와 무관하게 prevOpen을 안 쓰므로 NaN 오염은 없다 — 단 TV 계약상
    // 비교 기준 자체가 미정의라 prevOpen NaN이면 전부 NaN으로 통일한다.
    if (Number.isNaN(prevOpen)) x = NaN;
    arr[0] = x / 4;
    arr[1] = x / 2 - low;
    arr[2] = x / 2 - high;
  } else if (type === "Camarilla") {
    arr[0] = (high + low + close) / 3;
    const r3 = close + (1.1 * range) / 4;
    const s3 = close - (1.1 * range) / 4;
    const r4 = close + (1.1 * range) / 2;
    const s4 = close - (1.1 * range) / 2;
    arr[1] = close + (1.1 * range) / 12;
    arr[2] = close - (1.1 * range) / 12;
    arr[3] = close + (1.1 * range) / 6;
    arr[4] = close - (1.1 * range) / 6;
    arr[5] = r3;
    arr[6] = s3;
    arr[7] = r4;
    arr[8] = s4;
    arr[9] = r4 + 1.168 * (r4 - r3);
    arr[10] = s4 - 1.168 * (s3 - s4);
  }
  // 그 외 type 문자열(na 포함)은 전부 NaN 유지 — TV는 컴파일/런타임 에러일 수 있으나 미검증이라
  // 조용한 na가 더 안전한 쪽(C97 원칙: 오판 방향 중 안전한 기본값).
}

export function pivotPointLevels(
  state: PivotPointLevelsState,
  type: string,
  anchor: boolean,
  developing: boolean,
  open: number,
  high: number,
  low: number,
  close: number,
): number[] {
  if (state.levels === undefined) {
    state.levels = [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN];
    state.accHigh = NaN;
    state.accLow = NaN;
    state.accOpen = NaN;
    state.lastClose = NaN;
    state.hasPeriod = false;
  }
  const levels = state.levels;
  levels.length = 11; // 사용자 push 오염 방어 (핸들 재사용 원칙 주석 참조)
  if (developing === true && (type === "Woodie" || type === "DM")) {
    // TV 공식 레퍼런스: developing은 Woodie/DM에서 불가 — runtime.error(log.ts)와 동일한 예외
    // 클래스로 던져 엔진의 self-halt 채널로 잡히게 한다.
    runtimeError(`ta.pivot_point_levels: developing=true is not supported for type '${type}'`);
  }
  if (anchor === true) {
    if (developing !== true && state.hasPeriod === true) {
      // 직전 구간 [이전 anchor .. 직전 바] 데이터로 레벨 고정 — curOpen(Woodie)은 새 구간 첫 바
      // (= 이번 anchor 바)의 open.
      fillPivotLevels(levels, type, state.accOpen!, state.accHigh!, state.accLow!, state.lastClose!, open);
    }
    // 새 구간 시작 — 이번 바가 첫 바.
    state.accHigh = high;
    state.accLow = low;
    state.accOpen = open;
    state.hasPeriod = true;
  } else if (state.hasPeriod !== true) {
    state.accHigh = high;
    state.accLow = low;
    state.accOpen = open;
    state.hasPeriod = true;
  } else {
    // NaN-skip 누적: na 바가 구간 극값/첫 open을 오염시키지 않는다.
    if (!Number.isNaN(high) && !(state.accHigh! >= high)) state.accHigh = high;
    if (!Number.isNaN(low) && !(state.accLow! <= low)) state.accLow = low;
    if (Number.isNaN(state.accOpen!)) state.accOpen = open;
  }
  if (developing === true) {
    // 매 바 "마지막 anchor(없으면 bar 0)부터 현재 바까지" + 현재 close로 재계산. Woodie/DM은 위에서
    // 이미 예외 처리됐으므로 curOpen/prevOpen 인자는 실사용되지 않는 자리(NaN 전달).
    fillPivotLevels(levels, type, NaN, state.accHigh!, state.accLow!, close, NaN);
  }
  if (!Number.isNaN(close)) state.lastClose = close;
  return levels;
}

// A builtin call site inside a loop body keeps ONE state, shared by every iteration, but the
// machine is bar-keyed: each execution on the same bar re-derives from the state the bar started
// with (the last execution of the previous bar), fed this execution's own arguments, and the state
// carried to the next bar is the last execution's. PyneCore (the tier-2 oracle, certified against
// TradingView) implements exactly this in core/instance_state.py `__loop_state__`: "TradingView
// keeps one state per call site no matter how many times a loop body executes it on a bar ... the
// builtin machines in the callee's subtree are rolled back to their bar-start state before every
// same-bar re-execution", measured there as "ta.sma inside a loop reproduces 86292/86292 values on
// the shared-window model". The machines TradingView advances once per execution instead
// (ta.highest/lowest and everything built on them, the percentiles, math.random) are not routed
// here (codegen PER_EXECUTION_TA_FNS), nor are the *VarLen variants, which are bar-keyed already
// (a same-bar call overwrites the bar's slot instead of advancing).
//
// codegen wraps the state argument of such a call site: `rt.ta.sma(rt.ta.loopState($.taSlots[k],
// $.idx), …)`. The first execution of a bar snapshots the state; every later one on that bar
// restores it. Both copies reuse the containers already there, so the bar loop stays
// allocation-free once the state's shape settles, and the live state keeps its identity (a handle
// such as pivot_point_levels' array stays the one the script holds).
const LOOP_SITE = Symbol("loopSite");

interface LoopSiteCell {
  bar: number;
  snapshot: Record<string, unknown>;
}

export function loopState(state: Record<string, unknown>, bar: number): Record<string, unknown> {
  const holder = state as Record<string | symbol, unknown>;
  const cell = holder[LOOP_SITE] as LoopSiteCell | undefined;
  if (cell === undefined) {
    const snapshot: Record<string, unknown> = {};
    copyStateInto(snapshot, state);
    holder[LOOP_SITE] = { bar, snapshot } satisfies LoopSiteCell;
  } else if (cell.bar !== bar) {
    cell.bar = bar;
    copyStateInto(cell.snapshot, state);
  } else {
    copyStateInto(state, cell.snapshot);
  }
  return state;
}

// Deep copy of a machine state (numbers, booleans, strings, arrays, typed arrays, nested state
// objects) into `dst`, reusing dst's own containers. for...in skips the symbol-keyed loop cell.
function copyStateInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const key in dst) {
    if (!(key in src)) delete dst[key];
  }
  for (const key in src) dst[key] = copyStateValue(dst[key], src[key]);
}

function copyStateValue(prev: unknown, value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ArrayBuffer.isView(value)) {
    const src = value as Float64Array;
    if (prev instanceof (src.constructor as Float64ArrayConstructor) && (prev as Float64Array).length === src.length) {
      (prev as Float64Array).set(src);
      return prev;
    }
    return src.slice();
  }
  if (Array.isArray(value)) {
    const out: unknown[] = Array.isArray(prev) ? prev : [];
    out.length = value.length;
    for (let i = 0; i < value.length; i++) out[i] = copyStateValue(out[i], value[i]);
    return out;
  }
  const out =
    prev !== null && typeof prev === "object" && !Array.isArray(prev) && !ArrayBuffer.isView(prev)
      ? (prev as Record<string, unknown>)
      : {};
  copyStateInto(out, value as Record<string, unknown>);
  return out;
}
