// TA 빌트인: 전부 incremental O(1)/bar (바당 히스토리 재계산 금지 - GOAL.md 불변 원칙).
// 상태는 클로저가 아닌 plain object 슬롯(ctx.taSlots[i])에 저장 - Context가 생성해 전달한다.
// fixnan은 Pine 네임스페이스상 ta.*가 아닌 bare 빌트인이지만, 동일한 taSlots 상태 슬롯 메커니즘을
// 재사용하므로(analyzer.ts TA_REGISTRY.fixnan이 stateCallSlots+taSlotCount 풀을 sma와 공유) 이 파일에 둔다.

import { runtimeError } from "./log";

export interface SmaState {
  buffer?: number[];
  writeIdx?: number;
  sum?: number;
}

// ta.sma - 고정폭 순환 버퍼(NaN 프라임) + 오염 시 전체 재계산.
// pine2py wavealgo/ta/sma.py의 rolling-window 알고리즘과 동일한 결과를 내도록 검증됨:
// 버퍼를 NaN으로 채워 시작하면 첫 (length-1)바는 NaN, 이후 오염 전파도 동일하게 재현된다.
export function sma(state: SmaState, value: number, length: number): number {
  // C569: length는 TV에서 항상 'int' 타입이지만, analyzer.ts의 int/int idiv 판별(idivBinOps, C201
  // 잔여 범위)이 UDF 매개변수·삼항 체인처럼 top-level 리터럴 밖의 int 값을 못 잡으면 codegen이
  // 그 자리에 float division(rt.pineDiv)을 내려 여기 도달하는 length가 실제로는 정수인데 정수가
  // 아닌 값(예: 21/2=10.5)으로 보일 수 있다 - new Array(length)가 그대로 RangeError를 던지므로
  // (wild HMA(_src,_length)=>ta.wma(...,_length/2,...) 관용구, 배치27 exec 최다 클러스터) 여기서
  // 진짜 int 값으로 되돌린다(*VarLen 계열이 이미 쓰는 Math.trunc(length) 전례와 동일 원칙).
  length = Math.trunc(length);
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sum = NaN;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(value) || Number.isNaN(oldVal) || Number.isNaN(state.sum!)) {
    let total = 0;
    let hasNaN = false;
    for (const v of buffer) {
      if (Number.isNaN(v)) {
        hasNaN = true;
        break;
      }
      total += v;
    }
    state.sum = hasNaN ? NaN : total;
  } else {
    state.sum = state.sum! - oldVal + value;
  }
  return state.sum / length;
}

export interface EmaState {
  initCount?: number;
  initSum?: number;
  prevEma?: number;
}

// ta.ema - 처음 length바는 합계를 축적하고, length번째 바에서 SMA로 시드한 뒤 이후부터
// alpha=2/(length+1)로 지수 스무딩(GOAL.md "EMA는 SMA seed"). pine2py wavealgo/ta/ema.py와
// 동일한 2단계 상태 전이 검증됨 — na 입력은 상태를 건드리지 않고 그대로 NaN 통과(초기화 진행이
// 멈춘 것처럼 취급, 이후 non-na가 오면 이어서 계속).
export function ema(state: EmaState, value: number, length: number): number {
  if (state.initCount === undefined) {
    state.initCount = 0;
    state.initSum = 0;
    state.prevEma = NaN;
  }
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
  const emaVal = alpha * value + (1 - alpha) * state.prevEma!;
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

export interface RsiState {
  initCount?: number;
  prevValue?: number;
  initGainSum?: number;
  initLossSum?: number;
  avgGain?: number;
  avgLoss?: number;
}

// ta.rsi - avgGain/avgLoss를 Wilder's smoothing(alpha=1/length)으로 갱신 후
// 100 - 100/(1+avgGain/avgLoss). pine2py wavealgo/ta/rsi.py는 초기화 구간(첫 length개 변화량)의
// gain/loss를 리스트에 모았다가 sum()으로 평균을 내는데, 리스트 전체가 합계 하나로만 쓰이므로
// pine2js는 리스트 없이 러닝 합계(initGainSum/initLossSum) 두 값으로 단순화했다(GOAL.md "bar loop
// 안 할당 제로" 원칙에 더 잘 맞음 — 매 바 배열 push 대신 스칼라 누적, 수학적으로 완전히 동치).
// 첫 non-na 바는 "이전 값"이 없어 변화량을 계산할 수 없으므로 prevValue만 시드하고 NaN 반환.
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
  if (Number.isNaN(prev)) {
    state.initCount += 1;
    return NaN;
  }

  const change = value - prev;
  const gain = Math.max(change, 0);
  const loss = Math.max(-change, 0);
  state.initCount += 1;

  if (state.initCount <= length) {
    state.initGainSum! += gain;
    state.initLossSum! += loss;
    if (state.initCount === length) {
      state.avgGain = state.initGainSum! / length;
      state.avgLoss = state.initLossSum! / length;
      if (state.avgLoss === 0) return 100;
      return 100 - 100 / (1 + state.avgGain / state.avgLoss);
    }
    return NaN;
  }

  state.avgGain = (state.avgGain! * (length - 1) + gain) / length;
  state.avgLoss = (state.avgLoss! * (length - 1) + loss) / length;
  if (state.avgLoss === 0) return 100;
  return 100 - 100 / (1 + state.avgGain / state.avgLoss);
}

export interface RmaState {
  initCount?: number;
  initSum?: number;
  prevRma?: number;
}

// ta.rma - Wilder's smoothing(alpha=1/length). ta.ema와 완전히 동일한 2단계 상태 전이 구조
// (처음 length바 축적 후 SMA로 시드, 이후 지수 스무딩)이고 alpha 공식만 다르다. pine2py
// wavealgo/ta/rma.py의 인크리멘탈 모드는 매 바 length폭 윈도우를 처음부터 재스캔해 SMA를
// 구하는 방식이지만(초기화 구간에 한해 O(length) 재계산), 그 결과는 "처음 length개 non-na
// 값의 합계/length"와 동치이므로(연속 데이터에 embedded na gap이 없는 한) ta.ema와 동일한
// 러닝 합계(initSum/initCount) O(1) incremental로 이식했다(GOAL.md "바당 히스토리 재계산 금지").
export function rma(state: RmaState, value: number, length: number): number {
  if (state.initCount === undefined) {
    state.initCount = 0;
    state.initSum = 0;
    state.prevRma = NaN;
  }
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

  const alpha = 1 / length;
  const rmaVal = alpha * value + (1 - alpha) * state.prevRma!;
  state.prevRma = rmaVal;
  return rmaVal;
}

export interface CrossState {
  aPrev?: number;
  bPrev?: number;
}

// ta.crossover(a, b) - a가 이전 바에서 b 이하였다가 현재 바에서 b 초과로 전환됐는지.
// pine2py wavealgo/ta/crossover.py는 인자를 ensure_series()로 승격하는데, context가 있으면
// (오라클 실행은 항상 context가 있음) 스칼라도 context.param()으로 growable Series로 승격돼
// 항상 "Series 모드"(a.get(0)/a.get(1) 직접 비교) 분기를 타서 "context 있으면 상태로 추적"하는
// elif 분기는 실행되지 않는다 — 하지만 매 바 한 번만 호출된다는 전제(HoistingPass 미구현 동안의
// 동일 제약) 하에서는 "직전 호출에 전달된 값을 기억"하는 것과 "한 바 전 히스토리를 조회"하는 것이
// 완전히 동치이므로, 단일 상태 슬롯(aPrev/bPrev)으로 그대로 이식 가능하다. 첫 호출은 aPrev/bPrev가
// 아직 없어 NaN으로 초기화되고, NaN 비교는 항상 false라 pine2py의 "state.get(..., nan)" 기본값과
// 동일하게 false로 떨어진다(별도의 "첫 호출" 분기 불필요).
export function crossover(state: CrossState, a: number, b: number): boolean {
  if (state.aPrev === undefined) {
    state.aPrev = NaN;
    state.bPrev = NaN;
  }
  const aPrev = state.aPrev;
  const bPrev = state.bPrev!;
  state.aPrev = a;
  state.bPrev = b;
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(aPrev) || Number.isNaN(bPrev)) return false;
  return aPrev <= bPrev && a > b;
}

// ta.crossunder(a, b) - crossover와 대칭(a가 이전 바에서 b 이상이었다가 현재 바에서 b 미만으로 전환).
export function crossunder(state: CrossState, a: number, b: number): boolean {
  if (state.aPrev === undefined) {
    state.aPrev = NaN;
    state.bPrev = NaN;
  }
  const aPrev = state.aPrev;
  const bPrev = state.bPrev!;
  state.aPrev = a;
  state.bPrev = b;
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(aPrev) || Number.isNaN(bPrev)) return false;
  return aPrev >= bPrev && a < b;
}

// ta.cross(a, b) - crossover OR crossunder(방향 무관 교차). pine2py wavealgo/ta/cross.py 소스 대조로
// crossover/crossunder와 완전히 동일한 CrossState(aPrev/bPrev 단일 상태 슬롯)를 쓰지만 반환식만 두
// 부울식의 OR로 합쳐져 있음을 확인(cross.py L54-55) — 상태 모양은 같아도 반환 로직이 달라 alias
// 재사용(mom처럼)은 불가하고 별도 함수가 필요(roc/change와 동일 원칙).
export function cross(state: CrossState, a: number, b: number): boolean {
  if (state.aPrev === undefined) {
    state.aPrev = NaN;
    state.bPrev = NaN;
  }
  const aPrev = state.aPrev;
  const bPrev = state.bPrev!;
  state.aPrev = a;
  state.bPrev = b;
  if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(aPrev) || Number.isNaN(bPrev)) return false;
  return (aPrev <= bPrev && a > b) || (aPrev >= bPrev && a < b);
}

export interface WmaState {
  buffer?: number[];
  writeIdx?: number;
  sum?: number;
  weightedSum?: number;
}

// ta.wma - Weighted Moving Average: weight(oldest)=1 ... weight(newest)=length, WMA = weightedSum/weightTotal
// (weightTotal = length*(length+1)/2). pine2py wavealgo/ta/wma.py recomputes the weighted sum from a
// list window every bar (O(length)); pine2js reuses ta.sma's fixed-width circular buffer (single
// allocation on first call, GOAL.md "bar loop 안 할당 제로") plus an O(1) incremental update derived
// algebraically from the rolling-window recurrence:
//   S_{t+1} = S_t - Sum_t + newValue*length   (S=weighted sum, Sum=plain sum of the window before this bar)
// Derivation: dropping the oldest element a_1 (weight 1) shifts every remaining element's weight down by
// 1 and appends newValue at weight=length: S_{t+1} = sum_{i=2..L} a_i*(i-1) + newValue*L
// = (S_t - a_1) - (Sum_t - a_1) + newValue*L = S_t - Sum_t + newValue*L (a_1 cancels — same NaN-recompute
// pattern as ta.sma's `sum`, using `state.writeIdx` post-increment as the new oldest-element position).
export function wma(state: WmaState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sum = NaN;
    state.weightedSum = NaN;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(value) || Number.isNaN(oldVal) || Number.isNaN(state.sum!)) {
    let total = 0;
    let weightedTotal = 0;
    let hasNaN = false;
    const oldestPos = state.writeIdx;
    for (let i = 0; i < length; i++) {
      const v = buffer[(oldestPos + i) % length]!;
      if (Number.isNaN(v)) {
        hasNaN = true;
        break;
      }
      total += v;
      weightedTotal += v * (i + 1);
    }
    state.sum = hasNaN ? NaN : total;
    state.weightedSum = hasNaN ? NaN : weightedTotal;
  } else {
    const prevSum = state.sum!;
    state.sum = prevSum - oldVal + value;
    state.weightedSum = state.weightedSum! - prevSum + value * length;
  }

  const weightTotal = (length * (length + 1)) / 2;
  return state.weightedSum! / weightTotal;
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
export function alma(state: AlmaState, value: number, length: number, offsetMult: number, sigma: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조). offsetMult/sigma는 TV 자체가 simple float라 대상 아님
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    const m = offsetMult * (length - 1);
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
  inner?: WmaState;
}

// ta.cog - Center of Gravity oscillator: cog = -num/denom over a fixed window, where (pine2py
// wavealgo/ta/cog.py, get(i) 표기, i=0=현재바(최신)..i=length-1=가장 오래된 바)
// num=Σ source.get(i)*(i+1) (newest weight=1, oldest weight=length), denom=Σ source.get(i)(=state.sum).
// This positional weighting is the exact mirror of ta.wma's own weight(oldest)=1..weight(newest)=length
// convention (get(i) 표기로는 wma_weight(i)=length-i) — same "compose from an already-implemented TA"
// principle as linreg (C41): rather than deriving a new O(1) recurrence, reuse rt.ta.wma's internal
// running totals (state.sum=Σv_i, state.weightedSum=Σv_i*(length-i)) via the identity
//   weightedSum = Σv_i*(length-i) = length*S - Σ(v_i*i)  =>  Σ(v_i*i) = length*S - weightedSum
//   num = Σv_i*(i+1) = Σ(v_i*i) + S = (length+1)*S - weightedSum
// (derivation verified against a brute-force port with scratch/probe_cog.mjs — sample10/tie/
// zero-sum-denom/embedded-NaN/length=1/5,000-sample fuzz). denom(=S)===0 → NaN (distinct zero-sum
// guard, same shape as cmo's denom===0 but returns NaN here instead of cmo's 0.0-return case).
export function cog(state: CogState, value: number, length: number): number {
  if (state.inner === undefined) {
    state.inner = {};
  }
  const wmaVal = wma(state.inner, value, length);
  if (Number.isNaN(wmaVal)) return NaN;
  const sum = state.inner.sum!;
  if (sum === 0) return NaN;
  const num = (length + 1) * sum - state.inner.weightedSum!;
  return -num / sum;
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
// Rather than deriving a new O(1) recurrence, this reuses rt.ta.wma three times (half/full/outer)
// inside one taSlot's state object (VwmaState/StdevState precedent — multiple sub-buffers of
// differing roles nested in a single slot). pine2py only appends to `diff_window` (the outer WMA's
// input) when *both* inner WMAs are non-NaN (hma.py L55-56 early-return before the append) — so the
// outer wma() call is skipped entirely on bars where either inner WMA is still NaN (warm-up or
// poison-recompute), instead of being fed a poisoned/NaN diff. This is the same "conditional
// advance" shape as cmo's gains/losses append-on-non-NaN (C31), just applied to a whole nested TA
// call instead of a buffer push. The outer window's weight direction (oldest=1..newest=sqrt_len)
// matches wma's own oldest=1..newest=length convention (hma.py's diff_window is append-only, so
// window[-sqrt_len:] is oldest-to-newest) — confirmed by hand-tracing hma.py before implementing.
export function hma(state: HmaState, value: number, length: number): number {
  if (state.half === undefined) {
    state.half = {};
    state.full = {};
    state.outer = {};
  }
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
// 동일). sma()는 NaN을 버퍼에 그대로 채워 넣고 오염 시 NaN을 반환하는 자체 처리를 이미 갖고 있어
// (sma() 참조) 별도 가드 없이 뺄셈이 자연히 NaN을 전파한다.
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
  inner?: WmaState;
}

// ta.linreg - Linear Regression: least-squares fit of `value` over `length` bars, projected forward by
// `offset` bars. pine2py wavealgo/ta/linreg.py recomputes sum_y (Σv) and sum_xy (Σi*v, i=0-based
// oldest..length-1 newest) from a fresh oldest-to-newest window every bar (O(length)). sum_x/sum_x2
// depend only on n(=length), a compile-time-fixed constant (same lengthArgIndex hard-error premise as
// sma/wma), so the only per-bar work pine2py actually needs is sum_y/sum_xy — and those are
// algebraically identical to ta.wma's own running totals: wma's weightedSum uses 1-based weights
// (oldest=1..newest=length), so Σ(i+1)*v = Σ(i*v) + Σv, i.e. sum_xy = weightedSum - sum(=sum_y). Rather
// than deriving a new O(1) recurrence, this reuses rt.ta.wma's internal state (same "compose from an
// already-implemented TA" principle as hma, C40) — a call to wma() populates state.inner.sum/
// weightedSum, and linreg reads them back instead of maintaining its own buffer.
// offset defaults to 0 (pine2py linreg.py `offset: int = 0`, C252 2-arg call form) — same JS default-
// parameter idiom as change()'s length=1; no codegen padding needed since offset is the trailing arg.
export function linreg(state: LinregState, value: number, length: number, offset: number = 0): number {
  if (state.inner === undefined) {
    state.inner = {};
  }
  const wmaVal = wma(state.inner, value, length);
  if (Number.isNaN(wmaVal)) return NaN;

  const n = length;
  const sumY = state.inner.sum!;
  const sumXY = state.inner.weightedSum! - sumY;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-15) return sumY / n;

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return intercept + slope * (n - 1 + offset);
}

export interface VwmaState {
  priceBuffer?: number[];
  volBuffer?: number[];
  writeIdx?: number;
  pvSum?: number;
  vSum?: number;
}

// ta.vwma - Volume-Weighted Moving Average: VWMA = Σ(price*volume)/Σ(volume) over a fixed window.
// Unlike ta.wma, every bar in the window gets equal *position* weight (only volume differs each bar's
// contribution) — so this is two ta.sma-style rolling sums (Σprice*volume and Σvolume) run in parallel,
// not a derived weighted recurrence like wma. pine2py wavealgo/ta/vwma.py recomputes both sums from a
// list window every bar (O(length)); pine2js reuses ta.sma's fixed-width circular buffer pattern twice
// (one buffer per signal, single allocation on first call) for O(1) incremental updates.
export function vwma(state: VwmaState, price: number, volume: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.priceBuffer === undefined) {
    state.priceBuffer = new Array(length).fill(NaN);
    state.volBuffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.pvSum = NaN;
    state.vSum = NaN;
  }
  const priceBuffer = state.priceBuffer;
  const volBuffer = state.volBuffer!;
  const writeIdx = state.writeIdx!;
  const oldPrice = priceBuffer[writeIdx]!;
  const oldVol = volBuffer[writeIdx]!;
  priceBuffer[writeIdx] = price;
  volBuffer[writeIdx] = volume;
  state.writeIdx = (writeIdx + 1) % length;

  if (
    Number.isNaN(price) ||
    Number.isNaN(volume) ||
    Number.isNaN(oldPrice) ||
    Number.isNaN(oldVol) ||
    Number.isNaN(state.pvSum!)
  ) {
    let pvTotal = 0;
    let vTotal = 0;
    let hasNaN = false;
    for (let i = 0; i < length; i++) {
      const p = priceBuffer[i]!;
      const v = volBuffer[i]!;
      if (Number.isNaN(p) || Number.isNaN(v)) {
        hasNaN = true;
        break;
      }
      pvTotal += p * v;
      vTotal += v;
    }
    state.pvSum = hasNaN ? NaN : pvTotal;
    state.vSum = hasNaN ? NaN : vTotal;
  } else {
    state.pvSum = state.pvSum! - oldPrice * oldVol + price * volume;
    state.vSum = state.vSum! - oldVol + volume;
  }

  if (state.vSum === 0) return NaN;
  return state.pvSum! / state.vSum!;
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
  gainsBuffer?: number[];
  lossesBuffer?: number[];
  writeIdx?: number;
  sumGains?: number;
  sumLosses?: number;
}

// ta.cmo - Chande Momentum Oscillator: CMO = 100*(sumGains-sumLosses)/(sumGains+sumLosses), 두
// 신호(gain/loss, momentum=value-prevValue에서 파생)의 고정폭 length 윈도우 합계(가중치 없는 단순
// 합계, RSI의 Wilder 스무딩과 다름). pine2py wavealgo/ta/cmo.py는 momentum을 `source.get(0)`/
// `source.get(1)`(진짜 Series 히스토리)로 계산하고, 둘 중 하나라도 NaN이면 gains_win/losses_win을
// 건드리지 않고(append 자체를 안 함) 즉시 NaN을 반환한다 — sma/wma/vwma의 "NaN도 버퍼에 push해
// 오염시키는" 패턴과 달리 "유효한 momentum만 조건부로 push"하는 새 변형이다. prevValue 상태 슬롯은
// crossover/swma와 동일한 "1회/바 호출 전제 하 직전 호출 값 기억 = 1바 전 히스토리 조회" 동치
// 근거로 매 호출 무조건 갱신한다(RSI의 prevValue와 달리 NaN이어도 갱신 — RSI의 prevValue는
// pine2py 자체 구현이 skip-on-NaN 상태이지만, cmo는 진짜 Series.get(1) 원값을 그대로 반영해야
// 하므로 RSI와 다른 갱신 규칙 필요). 이 gate를 통과하면 mom/gain/loss는 항상 유한값이라 버퍼에는
// NaN이 push될 일이 없고, sma와 동일한 "버퍼가 아직 NaN-프라임으로 덜 찬" 워밍업만 recompute-on-
// pollution으로 처리하면 된다.
export function cmo(state: CmoState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.prevValue === undefined) {
    state.prevValue = NaN;
    state.gainsBuffer = new Array(length).fill(NaN);
    state.lossesBuffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sumGains = NaN;
    state.sumLosses = NaN;
  }
  const prevVal = state.prevValue;
  state.prevValue = value;
  if (Number.isNaN(value) || Number.isNaN(prevVal)) return NaN;

  const mom = value - prevVal;
  const gain = mom >= 0 ? mom : 0;
  const loss = mom < 0 ? -mom : 0;

  const gainsBuffer = state.gainsBuffer!;
  const lossesBuffer = state.lossesBuffer!;
  const writeIdx = state.writeIdx!;
  const oldGain = gainsBuffer[writeIdx]!;
  const oldLoss = lossesBuffer[writeIdx]!;
  gainsBuffer[writeIdx] = gain;
  lossesBuffer[writeIdx] = loss;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(oldGain) || Number.isNaN(state.sumGains!)) {
    let totalGain = 0;
    let totalLoss = 0;
    let hasNaN = false;
    for (let i = 0; i < length; i++) {
      const g = gainsBuffer[i]!;
      if (Number.isNaN(g)) {
        hasNaN = true;
        break;
      }
      totalGain += g;
      totalLoss += lossesBuffer[i]!;
    }
    state.sumGains = hasNaN ? NaN : totalGain;
    state.sumLosses = hasNaN ? NaN : totalLoss;
  } else {
    state.sumGains = state.sumGains! - oldGain + gain;
    state.sumLosses = state.sumLosses! - oldLoss + loss;
  }

  if (Number.isNaN(state.sumGains!)) return NaN;

  const denom = state.sumGains! + state.sumLosses!;
  if (denom === 0) return 0;
  return (100 * (state.sumGains! - state.sumLosses!)) / denom;
}

export interface CciState {
  buffer?: number[];
  writeIdx?: number;
  initialized?: boolean;
}

// ta.cci - Commodity Channel Index: CCI = (source - SMA(source,length)) / (0.015 * MeanDeviation),
// MeanDeviation = average(|v - SMA|) over the window. **두 번째 명시적 GOAL.md "TA는 전부
// incremental O(1)/bar" 예외** (첫 번째는 alma, C113) - pine2py wavealgo/ta/cci.py의 `_calc_cci`는
// 매 호출 sum(window)와 mean_dev를 처음부터 재계산한다. alma와 달리 이건 캐시 가능한 정적 부분조차
// 없다: sum은 sma처럼 러닝 합계(`sum - old + new`)로 O(1) 유지할 수 있어 보이지만, 실측(node
// fuzz)으로 그 running-sum이 반복 갱신을 거치며 미세한 부동소수점 오차를 누적해 `meanDev===0`이어야
// 하는 정확한 tie(window의 모든 값이 동일)에서 `meanDev`가 정확히 0이 아닌 아주 작은 epsilon으로
// 새는 실제 정확성 버그를 만든다는 걸 확인(stdev/variance C36의 캔슬레이션과 같은 급, 이번엔
// 반대 방향 - 합계를 매번 그 자리에서 새로 더하면 없는 오차). pine2py 자신도 sum을 매 호출
// `sum(window)`로 그 자리에서 재계산하므로(러닝 합계 최적화 자체가 없음), sum도 O(length)로 매
// 바 다시 더해 이 오차를 원천 차단한다 - 즉 sma/wma류와 달리 sum조차 캐시하지 않는 완전한 매 바
// 재계산. 착수 전 300건 python(pine2py cci() 직접 호출) vs node 크로스 퍼즈로 0 mismatch 확인
// (scratch/verify_cci_fuzz.mjs, tie 유도 위해 상수 5.0 값을 섞은 케이스 포함).
//
// 상태 모양은 두 국면으로 나뉜다(pine2py last_idx<0 분기 vs 인크리멘탈 분기의 리터럴 포트):
// **국면 1(초기화 전)**: pine2py가 `data_len>=length`가 되는 매 바마다 source 히스토리에서 최근
// length개를 통째로 다시 읽어(get(length-1)..get(0)) NaN이 하나라도 있으면 버리고(상태 미저장)
// 다음 바 다시 시도한다 - 이건 "매 바 원값 1개를 순환 버퍼에 push하고 NaN이 하나라도 남아있으면
// 실패"와 정확히 동치(순환 버퍼는 항상 '최근 length개 원값'의 집합과 일치하므로). sma의 NaN-프라임
// 순환 버퍼와 같은 메커니즘을 "아직 초기화 안 됨" 판정에 재사용. **국면 2(초기화 후)**: pine2py의
// `if isnan(current): return nan`이 window.pop/append 자체를 건너뛴다 - sma류의 "NaN도 push해
// 오염시키는" 패턴이 아니라 cmo(C31)류의 "조건 불충족 시 버퍼를 아예 건드리지 않고 그 바만 NaN"
// skip-freeze 패턴(윈도우가 그대로 얼어붙고, 다음 정상 바부터 그 얼어붙은 윈도우 기준으로 재개).
export function cci(state: CciState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.initialized = false;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;

  if (!state.initialized) {
    buffer[writeIdx] = value;
    state.writeIdx = (writeIdx + 1) % length;
    for (const v of buffer) {
      if (Number.isNaN(v)) return NaN;
    }
    state.initialized = true;
    return cciFromBuffer(buffer, length, value);
  }

  if (Number.isNaN(value)) return NaN;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  return cciFromBuffer(buffer, length, value);
}

function cciFromBuffer(buffer: number[], length: number, current: number): number {
  let sum = 0;
  for (const v of buffer) sum += v;
  const smaVal = sum / length;
  let meanDevSum = 0;
  for (const v of buffer) meanDevSum += Math.abs(v - smaVal);
  const meanDev = meanDevSum / length;
  if (meanDev === 0) return 0;
  return (current - smaVal) / (0.015 * meanDev);
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

// ta.rising - source가 length 바 연속 상승(엄격 증가)했는지. pine2py wavealgo/ta/cross.py의
// rising()은 매 호출 source.get(0..length)(진짜 Series 히스토리)를 O(length) 재스캔해 인접한 모든
// 쌍이 엄격 증가(curr>prev, 둘 다 non-na)인지 확인하고, data_len<=length(아직 충분한 바가 없음)면
// 즉시 false를 반환한다. "최근 length번의 바-대-바 전이가 전부 엄격 증가"는 O(1) streak
// 카운터(직전 바 대비 현재 값이 엄격히 컸던 연속 횟수)와 정확히 동치다: 이번 바 값이 직전 바 값보다
// 크면(둘 다 non-na) streak을 이어서 +1, 아니면(NaN 포함) 0으로 리셋 — 반환은 streak>=length.
// data_len<=length로 인한 false도 streak가 아직 length에 못 미쳤다는 사실 하나로 자연스럽게
// 통합된다(swma/change의 NaN-프라임 워밍업 통합과 동일 원칙). prevValue는 crossover/swma/change와
// 동일한 raw-passthrough(항상 갱신, NaN이어도 기억)로 갱신한다 — pine2py가 진짜 source.get(1) 원값을
// 그대로 비교하므로(cmo의 파생 집계값 skip-on-NaN과 다름). 고정폭 버퍼를 전혀 쓰지 않으므로 length가
// 바마다 달라져도(series) 안전 — TA_REGISTRY.lengthArgIndex는 null(sma류와 달리 하드 에러 불필요).
export function rising(state: StreakState, value: number, length: number): boolean {
  if (state.prevValue === undefined) {
    state.prevValue = NaN;
    state.streak = 0;
  }
  const prev = state.prevValue;
  state.prevValue = value;
  if (Number.isNaN(value) || Number.isNaN(prev) || value <= prev) {
    state.streak = 0;
  } else {
    state.streak = state.streak! + 1;
  }
  return state.streak >= length;
}

// ta.falling - rising과 대칭(연속 하락, curr<prev). 상세는 rising 주석 참조.
export function falling(state: StreakState, value: number, length: number): boolean {
  if (state.prevValue === undefined) {
    state.prevValue = NaN;
    state.streak = 0;
  }
  const prev = state.prevValue;
  state.prevValue = value;
  if (Number.isNaN(value) || Number.isNaN(prev) || value >= prev) {
    state.streak = 0;
  } else {
    state.streak = state.streak! + 1;
  }
  return state.streak >= length;
}

export interface StdevState {
  buffer?: number[];
  writeIdx?: number;
  sum?: number;
  sumSq?: number;
}

// ta.variance - population variance over a fixed window (no Bessel correction — divides by
// length, not length-1). pine2py wavealgo/ta/stdev.py recomputes mean/variance from a fresh
// list window every bar (O(length)): mean=Σv/length, variance=Σ(v-mean)²/length. pine2js reuses
// ta.sma's fixed-width NaN-primed circular buffer (single allocation on first call) plus a
// second running sum of squares (Σv²) and derives variance via the standard identity
// E[X²]-(E[X])² = Σv²/length - (Σv/length)² for O(1) incremental updates (GOAL.md "바당 히스토리
// 재계산 금지") — same "two sma-style running sums in parallel" shape as ta.vwma (no positional
// weighting involved, unlike ta.wma). Verified numerically against the direct Σ(v-mean)² formula
// on realistic price magnitudes: floating-point cancellation stays within ~1e-12, well inside
// GOAL.md's oracle tolerance (1e-9) and pine2py's own precision(10 decimals) rounding. Near-constant
// windows can push this identity slightly below 0 (verified: up to ~1e-11 for a near-flat window) —
// pine2py's direct Σ(v-mean)² formula can never go negative (it's a literal sum of squares), so a
// negative result here is purely a cancellation artifact and is clamped to 0. This clamp also
// prevents ta.stdev's sqrt() from producing a spurious NaN on an otherwise-near-zero variance.
// C296: biased (default true) selects population variance (divide by length, the pine2py-ported
// formula above) vs. unbiased/sample variance with Bessel's correction (divide by length-1). TV's
// official ta.variance/ta.stdev signature has this as an optional 3rd positional arg, but pine2py
// wavealgo/ta/stdev.py's variance(source, length, **kwargs) is fixed 2-positional (a 3rd positional
// arg is a Python TypeError) — this parameter is structurally impossible to oracle-verify, so it's
// hand-verified only ("TV 미검증(가설)", DIVERGENCES #110). Derived from the already-clamped
// population variance via the standard identity Σ(v-mean)²/(n-1) = [Σ(v-mean)²/n]·n/(n-1) — reusing
// the clamp (rather than re-deriving from sumSq) keeps the same floating-point-cancellation safety
// net C36 established. length=1 with biased=false divides by zero (0/0=NaN when v=0, otherwise
// Infinity) — a natural IEEE754 fallout, not a special-cased guard (GOAL.md 안전 연산 principle
// applies to user-facing '/' only; this is an internal runtime helper's own division, MEMORY.md
// Pitfalls C113 precedent).
export function variance(state: StdevState, value: number, length: number, biased: boolean = true): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조) — stdev/bb는 이 함수를 경유해 함께 해결됨
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sum = NaN;
    state.sumSq = NaN;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(value) || Number.isNaN(oldVal) || Number.isNaN(state.sum!)) {
    let total = 0;
    let totalSq = 0;
    let hasNaN = false;
    for (const v of buffer) {
      if (Number.isNaN(v)) {
        hasNaN = true;
        break;
      }
      total += v;
      totalSq += v * v;
    }
    state.sum = hasNaN ? NaN : total;
    state.sumSq = hasNaN ? NaN : totalSq;
  } else {
    state.sum = state.sum! - oldVal + value;
    state.sumSq = state.sumSq! - oldVal * oldVal + value * value;
  }

  if (Number.isNaN(state.sum!)) return NaN;
  const mean = state.sum! / length;
  const v = state.sumSq! / length - mean * mean;
  const population = v < 0 ? 0 : v;
  return biased ? population : (population * length) / (length - 1);
}

// ta.stdev - sqrt(ta.variance). pine2py wavealgo/ta/stdev.py duplicates variance's entire
// mean/sum-of-squared-deviations computation independently (not a call to variance()), but since
// both are byte-identical up to the final sqrt, pine2js's stdev() simply calls variance() on its
// own StdevState (each ta.stdev call site still owns its own independent taSlots slot — this is
// plain function composition, not state sharing across call sites, so the "call-site-independent
// state" invariant is untouched). biased passthrough — see variance() comment (C296).
export function stdev(state: StdevState, value: number, length: number, biased: boolean = true): number {
  const v = variance(state, value, length, biased);
  return Number.isNaN(v) ? NaN : Math.sqrt(v);
}

export interface BbState {
  inner?: StdevState;
}

// ta.bb(source, length, mult) - Bollinger Bands, the second multi-return TA
// ([middle, upper, lower] tuple, after ta.macd/C50). pine2py wavealgo/ta/bb.py computes
// middle=SMA(source,length) and stdev=population stdev of the same window (no Bessel correction -
// byte-identical formula to ta.variance/ta.stdev, C36), then upper/lower=middle±mult*stdev.
// Poison window: data_len<length or any NaN in the window -> (NaN, NaN, NaN), the same class as
// ta.highest (C42). Rather than allocating an independent SMA buffer alongside a stdev buffer
// (two circular buffers), bb() calls variance() once on a single nested StdevState and reads
// state.inner.sum (already = length*mean as a side effect of that call) to derive middle - the
// "call for its side effect, read the internal running sum" composition from linreg/cog (C41/C47)
// generalized here to cover all three outputs from one shared buffer. Verified against a literal
// bb.py port via scratch/probe_bb.mjs (sample10 + constant/near-constant windows + embedded NaN +
// length=1 degenerate + mult sign variations + 5,000-sample fuzz, all PASS) - the near-constant
// case uses C36-scale (not C36's outer numerical-precision floor) magnitudes since variance's
// sum-of-squares identity is a known, already-accepted precision limit independent of bb.
export function bb(
  state: BbState,
  value: number,
  length: number,
  mult: number,
  scratch: Float64Array,
): void {
  if (state.inner === undefined) state.inner = {};
  const v = variance(state.inner, value, length);
  if (Number.isNaN(v)) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }
  const middle = state.inner.sum! / length;
  const sd = Math.sqrt(v);
  scratch[0] = middle;
  scratch[1] = middle + mult * sd;
  scratch[2] = middle - mult * sd;
}

// ta.bbw(source, length, mult) - Bollinger Bands Width: (upper-lower)/basis*100. pine2py
// wavealgo/ta/bbw.py calls bb(source, length, mult) to get (basis, upper, lower), then returns
// NaN if basis is NaN or exactly 0, else (upper-lower)/basis*100. Unlike ta.bb (returnArity: 3,
// scratch-array output), bbw returns a single scalar, so it follows the standard single-return
// TA_REGISTRY pattern from before macd/bb (C50/C51) - it reuses the same BbState{inner:StdevState}
// and calls variance() for its side effect (state.inner.sum), but inlines the bb math into local
// variables consumed immediately by the arithmetic instead of writing to a shared scratch array
// (the "call for its side effect, read the internal running sum" composition from linreg/cog/bb,
// applied here without the scratch-array leg since there's only one output).
// Verified against a literal bbw.py+bb.py port via scratch/probe_bbw.mjs (sample10 + constant +
// basis===0-exactly + near-constant + embedded NaN + length=1 + mult sign variations + 5,000-
// sample symmetric-range fuzz, all PASS). Precision note: bbw's percentage form divides out
// basis's magnitude, which strips away the "large basis dominates" masking that let ta.bb (C51)
// tolerate the variance sum-of-squares identity's cancellation error at 1e-3-unit near-constant
// windows - bbw exposes that same cancellation directly (verified floor: 1e-3-unit deltas fail at
// oracle tolerance, 1e-2-unit deltas pass), a tighter-but-same-class instance of C36's documented
// precision limit, not a new bug.
export function bbw(
  state: BbState,
  value: number,
  length: number,
  mult: number,
): number {
  if (state.inner === undefined) state.inner = {};
  const v = variance(state.inner, value, length);
  if (Number.isNaN(v)) return NaN;
  const basis = state.inner.sum! / length;
  if (basis === 0) return NaN;
  const sd = Math.sqrt(v);
  const upper = basis + mult * sd;
  const lower = basis - mult * sd;
  return ((upper - lower) / basis) * 100;
}

export interface CumState {
  sum?: number;
}

// ta.cum(source) - 누적(러닝) 합계. pine2py wavealgo/ta/cum.py 소스 대조 결과 인자 1개(length 없음)
// 짜리 단일 러닝 합계 상태 하나뿐이라 지금까지 나온 TA 중 가장 단순하지만, NaN 처리가 지금까지의
// 모든 패턴(raw-passthrough로 버퍼를 오염시키거나 그대로 NaN을 반환하는 sma/wma/change류, momentum이
// NaN이면 스킵하는 cmo류)과 다른 세 번째 방식이다: cum.py L43-44는 `math.isnan(val): val = 0.0`로
// NaN 입력을 조용히 0으로 바꿔치기한 뒤 누적하므로, cum은 NaN 입력에도 절대 NaN을 반환하지 않고
// 직전 누적값을 그대로 유지한다(초기 상태 자체가 NaN이 아니라 0.0 — sma/wma/swma의 "NaN-프라임"
// 워밍업과 근본적으로 다름, 워밍업 구간 자체가 없다).
export function cum(state: CumState, value: number): number {
  if (state.sum === undefined) {
    state.sum = 0;
  }
  state.sum += Number.isNaN(value) ? 0 : value;
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

export interface ExtremeState {
  seq?: number;
  buffer?: number[];
  writeIdx?: number;
  nanCount?: number;
  dequeSeq?: number[];
  dequeVal?: number[];
  dequeHead?: number;
  dequeSize?: number;
}

// ta.highest/ta.lowest(source, length) - 최근 length바(현재 포함) 중 최댓값/최솟값. pine2py
// wavealgo/ta/highest.py는 매 호출 source.get(0..length-1) 전체를 O(length) 재스캔해 그 중 하나라도
// NaN이면 즉시 NaN을 반환하고(위치 가중이 없어 wma식 대수 유도 불가), 아니면 max()/min()을 취한다.
// O(1) amortized 갱신은 monotonic deque(단조 감소/증가 순서를 유지하는 인덱스 큐)로: 새 값이 들어오면
// 뒤에서부터 자신보다 덜 극단적인(highest면 <=, lowest면 >=) 원소를 전부 pop한 뒤 append(그 원소들은
// 새 값이 창에 남아있는 한 절대 극값이 될 수 없다 - 더 최근이면서 최소 그만큼 극단적이므로), 맨 앞
// 원소가 창 밖(seq 기준 length바 초과)으로 밀려나면 evict. sma와 동일한 "NaN-프라임 순환 버퍼"로
// nanCount(창 안 NaN 개수)를 병행 추적해 data_len<length(버퍼가 아직 NaN으로 덜 밀림)와 "창 안에
// 진짜 na가 있음"(pine2py의 즉시 NaN 반환)을 게이트 하나로 통합한다 - nanCount>0이면 항상 NaN, 0이면
// deque 맨 앞이 곧 창의 극값이다(NaN은 애초에 deque에 push하지 않는다 - nanCount가 0이 아닌 한 결과가
// 어차피 NaN이라 deque 안에서 NaN의 위치를 추적할 필요가 없기 때문). deque의 backing array도 sma의
// buffer처럼 최초 1회만 length 크기로 할당하고 push/shift 대신 head+size 정수 인덱스로 순환시켜
// GOAL.md "bar loop 안 할당 제로"를 지킨다 - 고전적 sliding-window-maximum 증명(창 크기 length 안에서
// deque가 담을 수 있는 원소 수는 항상 length 이하)이 capacity=length로도 오버플로가 없음을 보장한다.
export function highest(state: ExtremeState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조) — pivothigh는 이 함수를 경유해 함께 해결됨
  if (state.buffer === undefined) {
    state.seq = -1;
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.nanCount = length;
    state.dequeSeq = new Array(length).fill(0);
    state.dequeVal = new Array(length).fill(0);
    state.dequeHead = 0;
    state.dequeSize = 0;
  }
  const seq = state.seq! + 1;
  state.seq = seq;

  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  if (Number.isNaN(oldVal)) state.nanCount = state.nanCount! - 1;
  if (Number.isNaN(value)) state.nanCount = state.nanCount! + 1;

  const dequeSeq = state.dequeSeq!;
  const dequeVal = state.dequeVal!;
  let head = state.dequeHead!;
  let size = state.dequeSize!;
  while (size > 0 && dequeSeq[head]! <= seq - length) {
    head = (head + 1) % length;
    size--;
  }
  if (!Number.isNaN(value)) {
    while (size > 0 && dequeVal[(head + size - 1) % length]! <= value) {
      size--;
    }
    const tail = (head + size) % length;
    dequeSeq[tail] = seq;
    dequeVal[tail] = value;
    size++;
  }
  state.dequeHead = head;
  state.dequeSize = size;

  if (state.nanCount! > 0) return NaN;
  return dequeVal[head]!;
}

// ta.lowest - highest와 대칭(뒤에서 자신보다 크거나 같은 원소를 pop, deque 맨 앞이 최솟값). 상세는
// highest 주석 참조.
export function lowest(state: ExtremeState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조) — pivotlow는 이 함수를 경유해 함께 해결됨
  if (state.buffer === undefined) {
    state.seq = -1;
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.nanCount = length;
    state.dequeSeq = new Array(length).fill(0);
    state.dequeVal = new Array(length).fill(0);
    state.dequeHead = 0;
    state.dequeSize = 0;
  }
  const seq = state.seq! + 1;
  state.seq = seq;

  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  if (Number.isNaN(oldVal)) state.nanCount = state.nanCount! - 1;
  if (Number.isNaN(value)) state.nanCount = state.nanCount! + 1;

  const dequeSeq = state.dequeSeq!;
  const dequeVal = state.dequeVal!;
  let head = state.dequeHead!;
  let size = state.dequeSize!;
  while (size > 0 && dequeSeq[head]! <= seq - length) {
    head = (head + 1) % length;
    size--;
  }
  if (!Number.isNaN(value)) {
    while (size > 0 && dequeVal[(head + size - 1) % length]! >= value) {
      size--;
    }
    const tail = (head + size) % length;
    dequeSeq[tail] = seq;
    dequeVal[tail] = value;
    size++;
  }
  state.dequeHead = head;
  state.dequeSize = size;

  if (state.nanCount! > 0) return NaN;
  return dequeVal[head]!;
}

export interface ExtremeVarLenState {
  buffer?: Float64Array;
  writeIdx?: number;
  lastBarIdx?: number;
}

// ta.highest/ta.lowest(source, length) - length가 series(바마다 값이 바뀜)인 변형. 위 highest/lowest의
// monotonic deque(C42)는 첫 호출의 length로 버퍼 크기를 굳혀 series length에서 상태가 깨진다
// (analyzer.ts TA_REGISTRY.highest/lowest 주석의 하드 에러 근거) - 그러나 pine2py
// wavealgo/ta/highest.py를 직접 실행해 대조한 결과(scratch/length_series_probe.mjs, 2026-08-01)
// 원본이 애초에 상태를 안 두고 매 호출 `source.get(0..length-1)`을 O(length) 재스캔하는 방식이라
// length가 바뀌어도 그 자체로는 깨지지 않음을 확인 - 이 변형은 pine2py를 오라클로 그대로 이식한다
// (hand-verified 아님, oracle/cases/ta_highest_lowest_varlen.pine 골든으로 수치 확정). 콜사이트별로
// barCount(전체 바 수, $.barCount) 크기의 평평한 버퍼를 최초 1회만 할당(GOAL.md "bar loop 안 할당
// 제로" 준수 - 매 바 재할당 없음, Series.preallocate와 동일 원칙)하고 순서대로 채운다 - source 인자가
// Series로 백업돼 있는지 여부와 무관하게(임의 표현식이어도) 이 콜사이트가 실제로 받은 스칼라 값의
// 히스토리를 자체적으로 추적한다. **바 인덱스 중복 호출(같은 바 안에서 for/while 루프로 여러 번
// 호출)은 push가 아니라 덮어쓰기다** - pine2py context.param()(wavealgo/context.py L179)을 직접
// 읽어 확인: `if len(s) <= self.idx: s.push(...) else: s._data[-1] = ...` - 즉 "이미 이 바에서
// push했으면 마지막 슬롯을 갱신"이라 같은 바 반복 호출은 데이터 길이를 늘리지 않는다(corpus_diff
// 회귀 플로어 실측으로 최초 설계의 "매 호출마다 전진" 가정이 틀렸음을 발견 - `for period=3 to 5`
// 루프 안에서 ta.highest(high,period)를 매 바 3회 호출하는 116e6a965746.pine이 대조 불일치를 내
// barIdx 인자를 추가해 바로잡음, 2026-08-01). barIdx($.idx)가 이전 호출과 같으면 buffer[writeIdx]를
// 덮어쓰기만 하고 writeIdx는 그대로 - 다르면(새 바) writeIdx를 전진시킨 뒤 쓴다. length<1(0 또는
// 음수)은 pine2py highest.py가 `range(length)`를 빈 루프로 통과시켜 초기값(highest: -inf, lowest:
// +inf)을 그대로 반환하는 실측 버그를 그대로 이식(python 직접 실행 확인, 2026-08-01) - DIVERGENCES에
// "pine2py 원본 버그 이식" 등재. length가 NaN이면 pine2py는 `range(nan)`에서 TypeError로 크래시해
// 오라클이 성립하지 않으므로, 그 지점만 VERIFIED_SEMANTICS "산술 연산자 na 전파"를 인자 위치로
// 외삽해 NaN을 반환한다(hand-verified, DIVERGENCES에 "TV 미검증(가설)"로 별도 등재).
export function highestVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return -Infinity;
  if (len > writeIdx + 1) return NaN;
  let result = -Infinity;
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    if (v > result) result = v;
  }
  return result;
}

// ta.lowest series-length 변형 - highest와 대칭(최솟값, length<1은 +Infinity). 상세는 highestVarLen
// 주석 참조.
export function lowestVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return Infinity;
  if (len > writeIdx + 1) return NaN;
  let result = Infinity;
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    if (v < result) result = v;
  }
  return result;
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
// -inf처럼 "크래시 없이 정의된 동작"이 아예 없음)이라 na 반환으로 자체 결정. 창 안 NaN 하나면
// 결과 NaN(고정 length sma의 오염 시맨틱과 동일), 워밍업(len > 관측 바 수)도 NaN.
export function smaVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return NaN;
  if (len > writeIdx + 1) return NaN;
  let total = 0;
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    total += v;
  }
  return total / len;
}

// ta.highestbars/ta.lowestbars(source, length) - 최근 length바 중 최댓값/최솟값이 발생한 바의
// 오프셋(0=현재바, -1=1바 전 ...). pine2py wavealgo/ta/highest.py의 highestbars()/lowestbars()는
// 매 호출 source.get(0..length-1)을 새로(i=0=현재바 -> length-1=가장 오래된 바 순서로) 스캔해
// `val > max_val`(엄격 부등호, lowestbars는 `val < min_val`)일 때만 극값 인덱스를 갱신한다 - 동률이면
// 나중 i(더 오래된 바)는 갱신 조건을 통과 못 해 **먼저 만난(더 작은 i = 더 최근 바)** 인덱스가 남는다.
// C42의 monotonic deque(highest/lowest)는 새 값 push 시 뒤에서부터 자신 이하인 원소를 pop하는
// 정책이라 동률이 항상 더 최근 원소로 대체됨(scratch/probe_highestbars.mjs로 5,000샘플 랜덤 퍼즈 +
// 동률 다발 데이터까지 pine2py 방식과 완전히 동일한 결과임을 확인) - 결국 두 정책이 "동률이면 가장
// 최근 바가 이긴다"는 동일한 규칙으로 수렴한다. ExtremeState.dequeSeq[dequeHead]는 현재 극값이
// **기록된 시점의 seq**이므로 `state.seq - dequeSeq[dequeHead]`가 정확히 "몇 바 전에 극값이
// 나왔는가"(pine2py의 max_idx/min_idx)와 같다 - 새 상태 모양 없이 highest()/lowest()를 그대로
// 호출해 advance시킨 뒤 이 부수 정보만 읽으면 되는 합성(hma/linreg/stoch과 동일 "이미 구현된 TA
// 재사용" 원칙). highest()/lowest()가 이미 nanCount>0일 때 NaN을 반환하므로 NaN 전파는 자동.
// bars===0(현재 바가 극값)일 때 `-bars`는 JS negative zero(-0)를 만든다 — pine2py의 정수 `-max_idx`엔
// 이 개념이 없으므로(Python int는 -0을 갖지 않음) 0 분기를 명시적으로 분리해 항상 +0을 반환한다.
export function highestbars(state: ExtremeState, value: number, length: number): number {
  const maxVal = highest(state, value, length);
  if (Number.isNaN(maxVal)) return NaN;
  const bars = state.seq! - state.dequeSeq![state.dequeHead!]!;
  return bars === 0 ? 0 : -bars;
}

export function lowestbars(state: ExtremeState, value: number, length: number): number {
  const minVal = lowest(state, value, length);
  if (Number.isNaN(minVal)) return NaN;
  const bars = state.seq! - state.dequeSeq![state.dequeHead!]!;
  return bars === 0 ? 0 : -bars;
}

// ta.highestbars/ta.lowestbars(source, length) - length가 series인 변형(배치25 (4) 세 번째, C549).
// 버퍼/writeIdx/barIdx 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용).
// 위 고정 length highestbars()는 deque 부수 정보(seq)에서 오프셋을 유도하지만 deque는 첫 호출
// length로 backing 크기를 굳혀 series length에서 못 쓴다 - pine2py highest.py의 highestbars()/
// lowestbars() 원본은 highest()와 동일하게 상태 없이 매 호출 source.get(0..length-1)을 O(length)
// 재스캔(get_ta_state 미사용)이라 length가 바뀌어도 깨지지 않음 - highest/lowest(C547)와 동일하게
// pine2py를 오라클로 그대로 이식한다(oracle/cases/ta_highestbars_lowestbars_varlen.pine 골든).
// 스캔은 i=0(현재바=buffer[writeIdx])부터 len-1(가장 오래된 바)까지 엄격 부등호(`>` / `<`)로
// 극값 인덱스를 갱신 - 동률이면 먼저 만난(더 최근) 인덱스가 남는다(위 고정 length 버전의 deque
// 정책과 동일 규칙으로 수렴함을 scratch/probe_highestbars.mjs가 이미 확인). 엣지(전부 pine2py
// highestbars() 직접 대조): 워밍업(len > 관측 바 수)은 NaN(`data_len < length` 게이트), length<1은
// `range(length)` 빈 루프로 max_idx=0이 그대로 남아 `-max_idx`=0 반환(highest의 -inf와 달리 0 -
// 크래시 없는 정의된 동작이라 이식, DIVERGENCES #178 계열), length=NaN은 pine2py가 `range(nan)`
// TypeError 크래시라 오라클 불가 - highestVarLen과 동일하게 na 전파(TV 미검증 가설). 창 안 NaN
// 하나면 즉시 NaN(poison window). bars===0일 때 `-maxIdx`의 negative zero(-0)는 고정 length
// 버전과 동일하게 0 분기 분리로 회피(MEMORY C45).
export function highestbarsVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len > writeIdx + 1) return NaN;
  let maxVal = -Infinity;
  let maxIdx = 0;
  for (let i = 0; i < len; i++) {
    const v = state.buffer[writeIdx - i]!;
    if (Number.isNaN(v)) return NaN;
    if (v > maxVal) {
      maxVal = v;
      maxIdx = i;
    }
  }
  return maxIdx === 0 ? 0 : -maxIdx;
}

// ta.lowestbars series-length 변형 - highestbarsVarLen과 대칭(최솟값 오프셋, `<` 엄격 부등호).
// 상세는 highestbarsVarLen 주석 참조.
export function lowestbarsVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len > writeIdx + 1) return NaN;
  let minVal = Infinity;
  let minIdx = 0;
  for (let i = 0; i < len; i++) {
    const v = state.buffer[writeIdx - i]!;
    if (Number.isNaN(v)) return NaN;
    if (v < minVal) {
      minVal = v;
      minIdx = i;
    }
  }
  return minIdx === 0 ? 0 : -minIdx;
}

// ta.median(source, length) - length가 series인 변형(배치25 (4) 네 번째 묶음, C550). 버퍼/writeIdx/
// barIdx 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용). pine2py
// wavealgo/ta/median.py는 상태 없이 매 호출 source.get(0..length-1)을 현재 length로 재구축·정렬한다
// (get_ta_state 미사용, python 직접 실행으로 가변 length 정상 동작 확인 2026-08-01) - highest/lowest
// (C547)와 동일하게 pine2py를 오라클로 그대로 이식한다(oracle/cases/ta_median_linreg_varlen.pine
// 골든). 값 계산은 고정 length median()과 동일(창 정렬 후 가운데, 짝수면 두 값 평균 - 매 바 창
// 복사+정렬 할당은 고정 버전이 이미 GOAL.md O(1)/bar 예외로 확정한 트레이드오프라 그대로 따른다,
// median() 주석 참조). 엣지: 워밍업(len > 관측 바 수)은 NaN(`len(source) < length` 게이트 이식),
// length<1은 pine2py가 빈 window의 가운데 인덱싱에서 IndexError 크래시(0/음수 모두 python 직접
// 확인)라 "크래시 없이 정의된 동작"이 없음 - smaVarLen과 동일하게 na 반환 자체 결정(DIVERGENCES
// #181). length=NaN은 highestVarLen과 동일하게 na 전파(TV 미검증 가설). 창 안 NaN 하나면 즉시
// NaN(정렬 comparator에 NaN을 태우지 않는 고정 버전과 동일 게이트).
export function medianVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return NaN;
  if (len > writeIdx + 1) return NaN;
  const window: number[] = [];
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    window.push(v);
  }
  window.sort((a, b) => a - b);
  const mid = Math.floor(len / 2);
  if (len % 2 === 0) return (window[mid - 1]! + window[mid]!) / 2;
  return window[mid]!;
}

// ta.linreg(source, length, offset) - length가 series인 변형(C550, medianVarLen과 같은 묶음). 버퍼
// 메커니즘은 highestVarLen과 완전 동형. pine2py wavealgo/ta/linreg.py도 상태 없이 매 호출 현재
// length로 창을 재구축하는 무상태 재스캔(get_ta_state 미사용, 가변 length 정상 동작 python 직접
// 확인)이라 오라클 성립 - 값 계산(최소제곱 회귀 + offset 투영)은 고정 length linreg()와 동일한
// pine2py 공식 literal port다(고정 버전은 wma 상태 재사용 최적화를 얹었지만 여기선 창 재스캔이라
// 원본 공식 그대로가 더 단순). 엣지(전부 python 직접 실행 확정 2026-08-01): 워밍업은 NaN,
// length=0은 pine2py가 `sum_y/n` ZeroDivisionError 크래시라 na 자체 결정(DIVERGENCES #181),
// **length<0은 크래시가 아니라 +0.0 반환**(빈 창에서 sum_y=sum_xy=0 → slope=0/intercept=±0,
// precision()이 +0.0으로 정규화 - highest -inf(C547 #178)와 동일한 "크래시 없는 정의된 동작"
// literal port, -0은 MEMORY C45대로 0 분기 분리로 +0 고정). length=NaN은 na 전파(TV 미검증 가설).
// 창 안 NaN 하나면 즉시 NaN(length<0은 창 자체가 비어 이 게이트를 안 탐 - pine2py 동일).
export function linregVarLen(state: ExtremeVarLenState, value: number, length: number, offset: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len === 0) return NaN;
  if (len > writeIdx + 1) return NaN;
  let sumY = 0;
  let sumXY = 0;
  const start = writeIdx - len + 1;
  for (let i = start; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    sumY += v;
    sumXY += (i - start) * v;
  }
  const n = len;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-15) {
    const mean = sumY / n;
    return mean === 0 ? 0 : mean;
  }
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const result = intercept + slope * (n - 1 + offset);
  return result === 0 ? 0 : result;
}

// ta.wma(source, length) - length가 series인 변형(C550, 같은 묶음). 버퍼 메커니즘은 highestVarLen과
// 완전 동형 - 값 계산만 선형 가중 평균(창 안 위치 가중치 oldest=1..newest=len, 분모
// len*(len+1)/2). **median/linreg와 달리 pine2py는 이 축의 오라클이 못 된다**: wavealgo/ta/wma.py는
// context 모드에서 첫 성공 호출의 length로 state["window"] 크기를 영구 고정하는 인크리멘탈이고
// (이후 length가 변해도 창 크기는 그대로, _calc_wma가 창 자체 길이로 가중치를 매겨 무의미한 값),
// last_idx를 갱신만 하고 비교하지 않아 같은 바 반복 호출마다 pop/append로 창이 다중 전진하는
// latent 버그도 sma.py와 동일하게 보유한다(소스 직접 확인 2026-08-01 - smaVarLen #179와 완전히
// 같은 패턴). GOAL.md "알려진 버그는 따르지 않는다" 원칙에 따라 TV 문서 정의(선형 가중 이동평균)
// 대로 hand-verified 구현하고 DIVERGENCES #181에 등재 - 오라클은 "series 한정자 + 값은 상수" 퇴화
// 케이스(oracle/cases/ta_wma_varlen.pine)로만 버퍼/워밍업/NaN 메커니즘을 대조한다. 엣지:
// length<1은 pine2py가 빈 창 가중합 0/0 ZeroDivisionError 크래시(python 직접 확인)라 na 자체
// 결정, length=NaN은 na 전파(TV 미검증 가설), 창 안 NaN 하나면 즉시 NaN(고정 wma()와 동일).
export function wmaVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return NaN;
  if (len > writeIdx + 1) return NaN;
  let weightedTotal = 0;
  const start = writeIdx - len + 1;
  for (let i = start; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    weightedTotal += v * (i - start + 1);
  }
  return weightedTotal / ((len * (len + 1)) / 2);
}

// ta.stdev(source, length[, biased]) - length가 series인 변형(배치25 (4) 다섯 번째 묶음, C551).
// 버퍼 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용). pine2py
// wavealgo/ta/stdev.py의 stdev()/variance() 둘 다 상태 없이 매 호출 source.get(0..length-1)을
// 현재 length로 재구축해 mean/variance를 처음부터 다시 계산하는 무상태 재스캔이다
// (get_ta_state 미사용, python 직접 실행 확인 2026-08-01) - median/linreg(#181)와 동일 축이라
// 오라클 성립. 고정 length variance()가 쓰는 "sumSq 러닝 합 + E[X²]-(E[X])² 항등식"(C36) 대신
// 직접 Σ(v-mean)²를 매 호출 재계산하므로(median/linreg처럼 O(length) 재스캔 - GOAL.md O(1)/bar
// 예외에 이미 편입된 트레이드오프) 그 항등식이 유발하던 부동소수점 캔슬레이션 자체가 없어
// population variance 음수 클램프가 불필요(각 항이 (v-mean)² ≥ 0인 순수 제곱합이라 캔슬레이션이
// 구조적으로 발생할 수 없음). biased(기본 true)는 pine2py stdev.py에 아예 없는 파라미터라
// (2-positional 고정, DIVERGENCES #110 고정 length판과 동일 근거) 3번째 인자 패스스루는
// hand-verified 확장 - 고정 length variance()와 동일한 population→Bessel 보정 공식을 재사용한다.
// 엣지(전부 python 직접 실행 확인 2026-08-01): length=0은 pine2py `sum(values)/length`의
// ZeroDivisionError 크래시라 na 자체 결정, **length<0은 크래시 없이 0.0 반환**(range(length) 빈
// 루프 → mean=0/length=-0.0, variance도 -0.0 → precision()이 round(-0.0*1e10)/1e10=0/1e10=+0.0으로
// 정규화됨을 python 직접 확인 - highest -inf(#178)와 달리 이쪽은 +0 literal port, MEMORY C45대로
// JS도 `result===0` 분기로 +0 고정), length=NaN은 highestVarLen과 동일 na 전파 외삽(TV 미검증
// 가설). 창 안 NaN 하나면 즉시 NaN(고정 stdev()/variance()와 동일 게이트).
export function stdevVarLen(
  state: ExtremeVarLenState,
  value: number,
  length: number,
  biased: boolean,
  barCount: number,
  barIdx: number,
): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len === 0) return NaN;
  if (len > writeIdx + 1) return NaN;
  const start = writeIdx - len + 1;
  let sum = 0;
  for (let i = start; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    sum += v;
  }
  const mean = sum / len;
  let sumSqDev = 0;
  for (let i = start; i <= writeIdx; i++) {
    const d = state.buffer[i]! - mean;
    sumSqDev += d * d;
  }
  const population = sumSqDev / len;
  const variance = biased ? population : (population * len) / (len - 1);
  const result = Math.sqrt(variance);
  return result === 0 ? 0 : result;
}

// math.sum(source, length) - length가 series인 변형(배치25 (4) 다섯 번째 묶음, stdevVarLen과 같은
// ⚡번들, C551). 버퍼 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용). pine2py
// wavealgo/math/__init__.py sum()은 Series 분기(source가 실제 Series 객체일 때만, DIVERGENCES #15
// 참조)에서 상태 없이 매 호출 `for i in range(min(length, len(source))): total += source.get(i)`로
// 재스캔한다(get_ta_state 미사용, python 직접 실행 확인 2026-08-01) - **median/linreg/stdev와 달리
// 워밍업 NaN 게이트 자체가 없다**: length가 지금까지 관측한 바 수보다 커도 그냥 있는 만큼만 합산
// (min(length, dataLen) — 부족분은 조용히 무시, na 반환 없음). NaN 원소는 median/linreg/stdev처럼
// poison하지 않고 항상 기여 0(고정 length sum() 주석 참조와 동일 규칙). length<=0은 range(<=0)가
// 빈 루프라 크래시 없이 0.0(python 직접 확인 - length=0/-2 둘 다 0.0, 순양수/NaN 항만 더하는
// 산술이라 stdevVarLen과 달리 -0 정규화 자체가 불필요). length=NaN만 pine2py `min(nan, dataLen)`이
// 모든 대소비교가 False로 nan을 그대로 반환해 `range(nan)` TypeError로 크래시(python 직접 확인) -
// highestVarLen과 동일 na 전파 외삽(TV 미검증 가설).
export function sumVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  const count = writeIdx + 1;
  const iterCount = Math.max(0, Math.min(len, count));
  let total = 0;
  for (let i = 0; i < iterCount; i++) {
    const v = state.buffer[writeIdx - i]!;
    if (!Number.isNaN(v)) total += v;
  }
  return total;
}

// pivothighVarLen/pivotlowVarLen 전용 - idx가 [0, writeIdx] 밖(음수 = 아직 안 쌓인 과거, writeIdx
// 초과 = 아직 안 온 미래)이면 NaN. pine2py Series.get()의 out-of-range 판정(series.py L49-51,
// `real_index<0 or real_index>=len(data)`이면 NaN)과 완전 동형이라, 이 하나로 pine2py의
// "data_len < total" 사전 게이트를 대체한다(아래 pivothighVarLen 주석 참조).
function pivotBufGet(buffer: Float64Array, writeIdx: number, idx: number): number {
  if (idx < 0 || idx > writeIdx) return NaN;
  return buffer[idx]!;
}

// ta.pivothigh/ta.pivotlow(source, left, right) - left/right가 series(바마다 값이 바뀌는) 변형
// (배치25 (4) 계속, next_hint(C551) 1순위). pine2py wavealgo/ta/pivot.py의 pivothigh()/pivotlow()도
// highest.py와 동일하게 상태 없이 매 호출 source.get(0..left+right)를 재구축하는 무상태 재스캔
// (ensure_series -> context.param(), get_ta_state 미사용 - python 직접 실행 확인 2026-08-01)이라
// #178과 같은 축으로 가변 length 골든 오라클이 성립한다(oracle/cases/ta_pivot_varlen.pine). 버퍼/
// writeIdx/barIdx 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용) - 단
// length 하나가 아니라 left/right 두 값이 창의 좌/우 폭을 각각 결정하므로, 고정 length 버전(위
// pivothigh())처럼 rt.ta.highest/lowest를 재호출하는 합성이 아니라 pine2py 원본처럼
// candidate=buffer[writeIdx-right]를 직접 인덱싱해 왼쪽(더 오래된 값)/오른쪽(더 최근 값) 두 구간을
// 따로 스캔한다. left<=0/right<=0은 Python range(1,left+1)/range(right)가 빈 루프가 되는 것과
// 동일하게 JS for 루프 조건이 자연히 스킵한다(별도 분기 불필요) - negative left/right/0/과대
// length 6개 조합을 python 직접 실행으로 대조해 pivotBufGet의 범위 판정 하나로 전부 재현됨을 확인
// (음수 right가 candidate를 미래 바로 밀어 out-of-range NaN을 내는 경로까지 포함). left 또는
// right가 NaN이면 pine2py가 range(nan)류에서 TypeError로 크래시해(python 직접 실행 확인) 오라클
// 불가 - #178과 동일하게 na 전파로 외삽한다(hand-verified, TV 미검증 가설).
export function pivothighVarLen(
  state: ExtremeVarLenState,
  value: number,
  left: number,
  right: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const l = Math.trunc(left);
  const r = Math.trunc(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return NaN;
  const candIdx = writeIdx - r;
  const candidate = pivotBufGet(state.buffer, writeIdx, candIdx);
  if (Number.isNaN(candidate)) return NaN;
  for (let i = 1; i <= l; i++) {
    const v = pivotBufGet(state.buffer, writeIdx, candIdx - i);
    if (Number.isNaN(v) || v > candidate) return NaN;
  }
  for (let i = 0; i < r; i++) {
    const v = pivotBufGet(state.buffer, writeIdx, writeIdx - i);
    if (Number.isNaN(v) || v > candidate) return NaN;
  }
  return candidate;
}

// ta.pivotlow series-length 변형 - pivothighVarLen과 대칭(최솟값 쪽 조건 `<`). 상세는
// pivothighVarLen 주석 참조.
export function pivotlowVarLen(
  state: ExtremeVarLenState,
  value: number,
  left: number,
  right: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const l = Math.trunc(left);
  const r = Math.trunc(right);
  if (Number.isNaN(l) || Number.isNaN(r)) return NaN;
  const candIdx = writeIdx - r;
  const candidate = pivotBufGet(state.buffer, writeIdx, candIdx);
  if (Number.isNaN(candidate)) return NaN;
  for (let i = 1; i <= l; i++) {
    const v = pivotBufGet(state.buffer, writeIdx, candIdx - i);
    if (Number.isNaN(v) || v < candidate) return NaN;
  }
  for (let i = 0; i < r; i++) {
    const v = pivotBufGet(state.buffer, writeIdx, writeIdx - i);
    if (Number.isNaN(v) || v < candidate) return NaN;
  }
  return candidate;
}

// ta.range(source, length) - length가 series인 변형(배치25 (4) 계속, next_hint(C552) 잔여 싱글턴
// 1순위). pine2py wavealgo/ta/range_func.py도 highest.py/lowest.py와 동일하게 상태 없이 매 호출
// source.get(0..length-1)을 재스캔한다(get_ta_state 미사용, python 직접 실행으로 가변 length 정상
// 동작 확인 2026-08-01: context 모드와 length 무관 direct 모드가 매 바 완전히 일치) - highest/lowest
// (C547)와 동일 축으로 오라클 성립(oracle/cases/ta_range_percentile_varlen.pine). 버퍼/writeIdx/
// barIdx 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(ExtremeVarLenState 재사용) - 값 계산은 고정
// range()처럼 highest/lowest를 재호출하는 합성이 아니라, 버퍼 하나를 한 번 스캔하며 hi/lo를 동시에
// 구하는 highestVarLen+lowestVarLen 통합판(고정폭 버퍼 하나를 두 sub-state로 이중 관리할 필요가
// 없어 series 축에서는 오히려 더 단순). 엣지(python 직접 실행 확인 2026-08-01): length<1(0/음수 둘
// 다)은 `len(source) < length`가 length<=0에서 항상 False라 워밍업 게이트 자체가 안 걸리고
// `range(length<=0)` 빈 루프로 hi=-inf/lo=+inf가 그대로 남아 hi-lo=-inf(크래시 없는 정의된 동작,
// highest -inf(#178)와 동일 literal port - median/percentile류의 "length<1 크래시라 na 자체 결정"과
// 다른 축이니 혼동 금지). length=NaN은 pine2py `range(nan)` TypeError 크래시라 highestVarLen과
// 동일하게 na 전파 외삽(TV 미검증 가설). 창 안 NaN 하나면 즉시 NaN(고정 range()와 동일 poison
// window).
export function rangeVarLen(state: ExtremeVarLenState, value: number, length: number, barCount: number, barIdx: number): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return -Infinity;
  if (len > writeIdx + 1) return NaN;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  return hi - lo;
}

export interface RangeState {
  hi?: ExtremeState;
  lo?: ExtremeState;
}

// ta.range(source, length) - 최근 length바(현재 포함) 중 최댓값-최솟값. pine2py
// wavealgo/ta/range_func.py(wavealgo/ta/__init__.py L76 TA_REGISTRY에 등록된 진짜 TA 함수 —
// array.range(id)와는 별개)는 매 호출 source.get(0..length-1) 전체를 O(length) 재스캔해 그 중
// 하나라도 NaN이면 즉시 NaN, 아니면 max-min을 반환한다(highest.py/lowest.py와 동일한 poison
// window). stoch()과 동일한 합성 원칙 — highest()/lowest()를 두 독립 ExtremeState로 재호출해
// hi/lo를 얻은 뒤 뺄셈(hi/lo 각각의 nanCount 게이트가 이미 NaN을 반환하므로 전파는 자동, 둘 다
// 같은 source/length로 매 바 무조건 호출돼 두 sub-state가 항상 동기 전진).
export function range(state: RangeState, value: number, length: number): number {
  if (state.hi === undefined) {
    state.hi = {};
    state.lo = {};
  }
  const hi = highest(state.hi, value, length);
  const lo = lowest(state.lo!, value, length);
  return hi - lo;
}

export interface StochState {
  hh?: ExtremeState;
  ll?: ExtremeState;
}

// ta.stoch(source, high, low, length) - Stochastic %K = 100*(source-ll)/(hh-ll), hh=highest(high,
// length)/ll=lowest(low,length) (pine2py wavealgo/ta/stoch.py). Reuses rt.ta.highest/rt.ta.lowest
// (C42) as two independent ExtremeState nested in one taSlot (HmaState/LinregState precedent -
// "already-built TA reused inside a new TA's body" over deriving a fresh recurrence). Unlike hma's
// conditional outer-wma skip, hh/ll here are stoch's *primary* window state (not a derived append
// gated on an inner TA being non-NaN) - pine2py calls highest()/lowest() unconditionally every bar,
// so both sub-calls must always advance regardless of whether source(close) is itself NaN this bar.
// pine2py's branch order (stoch.py L44-55) matters and must be replicated exactly: hh/ll NaN check
// first -> if diff(hh-ll)===0 return 50.0 **before** checking source for NaN (a flat hh===ll window
// returns 50.0 even when the current bar's source/close happens to be NaN) -> only then check source
// NaN -> divide.
export function stoch(state: StochState, source: number, high: number, low: number, length: number): number {
  if (state.hh === undefined) {
    state.hh = {};
    state.ll = {};
  }
  const hh = highest(state.hh, high, length);
  const ll = lowest(state.ll!, low, length);
  if (Number.isNaN(hh) || Number.isNaN(ll)) return NaN;
  const diff = hh - ll;
  if (diff === 0) return 50.0;
  if (Number.isNaN(source)) return NaN;
  return (100.0 * (source - ll)) / diff;
}

export interface WprState {
  hh?: ExtremeState;
  ll?: ExtremeState;
}

// ta.wpr(length) - Williams %R = -100*(hh-close)/(hh-ll) (equivalently 100*(close-hh)/(hh-ll)),
// hh=highest(high,length)/ll=lowest(low,length). Pine syntax takes only length; high/low/close come
// from the implicit bar series (codegen injects $.close.get(0)/$.high.get(0)/$.low.get(0), vwma's
// volume-injection precedent).
//
// **Deliberate divergence from pine2py** (DIVERGENCES.md): pine2py wavealgo/ta/wpr.py implements its
// own high_win/low_win list (append + pop(0) on overflow) instead of reusing highest()/lowest(). That
// custom window only NaN-checks the *current* bar's high/low/close before appending - a NaN bar returns
// NaN for itself but is never appended, so the window silently skips NaN bars rather than being poisoned
// by them (unlike highest.py, which NaN-poisons the whole window if any of the trailing `length` bars is
// NaN). TradingView's actual built-in "Williams %R" script is documented to compose from
// `ta.highest(length)`/`ta.lowest(length)` (the same poison-window semantics already implemented and
// oracle-verified for C42's rt.ta.highest/rt.ta.lowest), so pine2py's own window here is treated as a
// latent inconsistency, not a semantic to port (GOAL.md "pine2py의 알려진 버그는 따르지 않는다" - same
// precedent as rt.max/rt.min, C13). Reuses StochState's two-ExtremeState shape (C43) and its
// unconditional-advance rule (hh/ll are wpr's primary window state, not a derived append gated on
// another TA being non-NaN, so both sub-calls must run every bar).
//
// Branch order mirrors stoch (C43) rather than pine2py's own close-NaN-first order (which was only
// correct for pine2py's particular skip-window design): hh/ll NaN check first -> flat window
// (diff(hh-ll)===0) returns 0.0 **regardless of close's NaN state** (pine2py wpr.py L68-69 confirms 0.0,
// not stoch's 50.0) -> only then check close for NaN -> divide.
export function wpr(state: WprState, close: number, high: number, low: number, length: number): number {
  if (state.hh === undefined) {
    state.hh = {};
    state.ll = {};
  }
  const hh = highest(state.hh, high, length);
  const ll = lowest(state.ll!, low, length);
  if (Number.isNaN(hh) || Number.isNaN(ll)) return NaN;
  const diff = hh - ll;
  if (diff === 0) return 0.0;
  if (Number.isNaN(close)) return NaN;
  return (100.0 * (close - hh)) / diff;
}

// ta.tr(handle_na) - True Range = max(high-low, |high-prevClose|, |low-prevClose|); prevClose가
// NaN(첫 바 포함 - Series.get(1)이 워밍업 중 NaN을 자연히 반환하는 관례와 동치, pine2py atr.py의
// `data_len<2` 분기를 별도 이식할 필요가 없다)일 때 handleNa(기본 true, TV 실제 파라미터명
// handle_na)가 true면 hl 그대로, false면 NaN(C291 — TV 공식 시그니처 `ta.tr(handle_na)`, pine2py
// tr()은 이 파라미터 자체가 없어(analyzer.ts TA_REGISTRY.tr 주석 참조) 오라클 불가, TV 미검증
// 가설 hand-verified). Pine 문법에 high/low/close 인자가 없어 codegen이 $.high.get(0)/
// $.low.get(0)/$.close.get(1)(prevClose)을 handle_na 앞에 암묵 주입한다. 완전히 stateless인
// 순수 함수라 첫 state 인자는 TA_REGISTRY 디스패치 경로의 일관성을 위해서만 받고 내부에서 전혀
// 쓰지 않는다("상태가 진짜로 불필요한 첫 사례").
export function tr(_state: unknown, high: number, low: number, prevClose: number, handleNa: boolean = true): number {
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
  const trVal = tr(undefined, high, low, prevClose);
  return rma(state.rma, trVal, length);
}

export interface MfiState {
  prevTp?: number;
  posBuffer?: number[];
  negBuffer?: number[];
  writeIdx?: number;
  sumPos?: number;
  sumNeg?: number;
}

// ta.mfi(source, length) - Money Flow Index = 100*posSum/(posSum+negSum) over a fixed-width window
// of per-bar money flow (source*volume) split into positive/negative buckets by the direction of
// source vs the previous bar's source. Pine syntax omits volume; codegen injects $.volume.get(0)
// between source and length (vwma's implicit-arg precedent, C29).
//
// pine2py wavealgo/ta/mfi.py's prevTp update is gated on **both** source and volume being non-NaN
// this bar (`if isnan(current_tp): return NaN` then `if isnan(current_vol): return NaN`, both
// *before* `state["prev_tp"] = current_tp`) - unlike cmo's prevValue (C31), which is unconditional
// raw-passthrough every call regardless of the value's own NaN-ness. A bar with a NaN volume (source
// still valid) leaves prevTp untouched, not overwritten with this bar's tp - scratch/probe_mfi.mjs
// confirmed this against a literal brute-force port of mfi.py (including a volume-NaN-gap case where
// naively always-updating prevTp would silently diverge from pine2py).
//
// Once past that gate (source, volume, and prevTp all non-NaN), pine2py *always* pushes to
// pos_flows/neg_flows every bar - (moneyFlow,0) if tp rose, (0,moneyFlow) if it fell, (0,0) on a tie
// - unlike cmo's "skip push on NaN momentum" (there is no NaN-momentum case here, since both operands
// of the tp comparison are already guaranteed non-NaN by the gate above). This makes the window a
// plain fixed-width running sum exactly like sma's buffer - no derived-append skip needed - so it's
// wired the same way as cmo's gains/losses buffers (NaN-primed circular buffer + recompute-on-
// pollution), just without cmo's extra "skip the whole push" branch. pine2py's explicit `count<length`
// warmup gate is redundant with this buffer's own NaN-priming (a skipped bar never advances writeIdx,
// so the buffer can't be mistaken for "full" until `length` real pushes have landed) - scratch/
// probe_mfi.mjs cross-checked this NaN-priming-only design (no separate count field) against a literal
// count-gated port of mfi.py across sample10, tie, NaN-gap, length=1, and 5,000-sample fuzz cases.
//
// negSum===0 guards the division (pine2py mfi.py: return 100.0 in that case, same shape as cmo's
// denom===0 guard but a different fallback value).
export function mfi(state: MfiState, source: number, volume: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.prevTp === undefined) {
    state.prevTp = NaN;
    state.posBuffer = new Array(length).fill(NaN);
    state.negBuffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sumPos = NaN;
    state.sumNeg = NaN;
  }
  if (Number.isNaN(source)) return NaN;
  if (Number.isNaN(volume)) return NaN;

  const prevTp = state.prevTp;
  state.prevTp = source;
  if (Number.isNaN(prevTp!)) return NaN;

  const moneyFlow = source * volume;
  let posFlow: number;
  let negFlow: number;
  if (source > prevTp!) {
    posFlow = moneyFlow;
    negFlow = 0;
  } else if (source < prevTp!) {
    posFlow = 0;
    negFlow = moneyFlow;
  } else {
    posFlow = 0;
    negFlow = 0;
  }

  const posBuffer = state.posBuffer!;
  const negBuffer = state.negBuffer!;
  const writeIdx = state.writeIdx!;
  const oldPos = posBuffer[writeIdx]!;
  const oldNeg = negBuffer[writeIdx]!;
  posBuffer[writeIdx] = posFlow;
  negBuffer[writeIdx] = negFlow;
  state.writeIdx = (writeIdx + 1) % length;

  if (Number.isNaN(oldPos) || Number.isNaN(state.sumPos!)) {
    let totalPos = 0;
    let totalNeg = 0;
    let hasNaN = false;
    for (let i = 0; i < length; i++) {
      const p = posBuffer[i]!;
      if (Number.isNaN(p)) {
        hasNaN = true;
        break;
      }
      totalPos += p;
      totalNeg += negBuffer[i]!;
    }
    state.sumPos = hasNaN ? NaN : totalPos;
    state.sumNeg = hasNaN ? NaN : totalNeg;
  } else {
    state.sumPos = state.sumPos! - oldPos + posFlow;
    state.sumNeg = state.sumNeg! - oldNeg + negFlow;
  }

  if (Number.isNaN(state.sumPos!)) return NaN;
  if (state.sumNeg === 0) return 100.0;

  const mfRatio = state.sumPos! / state.sumNeg!;
  return 100.0 - 100.0 / (1.0 + mfRatio);
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
  xBuffer?: number[];
  yBuffer?: number[];
  writeIdx?: number;
  sumX?: number;
  sumY?: number;
  sumXY?: number;
  sumX2?: number;
  sumY2?: number;
}

// ta.correlation(source1, source2, length) - Pearson correlation coefficient over a fixed window.
// pine2py wavealgo/ta/correlation.py recomputes five running sums (Σx, Σy, Σxy, Σx², Σy²) from a
// fresh list window every bar (O(length)): numerator = n*Σxy - Σx*Σy, denom_x = n*Σx² - (Σx)²,
// denom_y = n*Σy² - (Σy)², result = numerator/sqrt(denom_x*denom_y). This is ta.vwma's "two signals,
// parallel running sums" shape (C29) combined with ta.variance/ta.stdev's "sum of squares alongside
// sum" identity (C36) — two ta.sma-style circular buffers (one per signal) plus a cross-product
// running sum (Σxy) added alongside each signal's own sum-of-squares, all maintained O(1) incremental
// instead of pine2py's O(length) recompute (GOAL.md "바당 히스토리 재계산 금지"). Window NaN detection
// mirrors ta.stdev's recompute-on-pollution: any NaN in either signal poisons both denominators, so a
// single hasNaN scan covers both x and y in lockstep. denom_x<=0 or denom_y<=0 guards against both the
// exact-zero case (a perfectly flat window, mathematically undefined correlation) and floating-point
// cancellation pushing a near-zero denominator slightly negative (Cauchy-Schwarz guarantees denom>=0
// in exact arithmetic, same class of artifact as ta.stdev's variance clamp, C36) — pine2py's own guard
// is `<=0`, not `==0`, so this is ported byte-for-byte rather than narrowed. Verified against a literal
// port of correlation.py via scratch/probe_correlation.mjs (sample10 + perfectly-correlated/
// anti-correlated + exact-zero-variance + near-constant cancellation risk + embedded-NaN gaps in each
// signal independently + length=1 degenerate + 5,000-sample fuzz per length) before implementing.
export function correlation(
  state: CorrelationState,
  x: number,
  y: number,
  length: number
): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.xBuffer === undefined) {
    state.xBuffer = new Array(length).fill(NaN);
    state.yBuffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sumX = NaN;
    state.sumY = NaN;
    state.sumXY = NaN;
    state.sumX2 = NaN;
    state.sumY2 = NaN;
  }
  const xBuffer = state.xBuffer;
  const yBuffer = state.yBuffer!;
  const writeIdx = state.writeIdx!;
  const oldX = xBuffer[writeIdx]!;
  const oldY = yBuffer[writeIdx]!;
  xBuffer[writeIdx] = x;
  yBuffer[writeIdx] = y;
  state.writeIdx = (writeIdx + 1) % length;

  if (
    Number.isNaN(x) ||
    Number.isNaN(y) ||
    Number.isNaN(oldX) ||
    Number.isNaN(oldY) ||
    Number.isNaN(state.sumX!)
  ) {
    let sx = 0;
    let sy = 0;
    let sxy = 0;
    let sx2 = 0;
    let sy2 = 0;
    let hasNaN = false;
    for (let i = 0; i < length; i++) {
      const vx = xBuffer[i]!;
      const vy = yBuffer[i]!;
      if (Number.isNaN(vx) || Number.isNaN(vy)) {
        hasNaN = true;
        break;
      }
      sx += vx;
      sy += vy;
      sxy += vx * vy;
      sx2 += vx * vx;
      sy2 += vy * vy;
    }
    state.sumX = hasNaN ? NaN : sx;
    state.sumY = hasNaN ? NaN : sy;
    state.sumXY = hasNaN ? NaN : sxy;
    state.sumX2 = hasNaN ? NaN : sx2;
    state.sumY2 = hasNaN ? NaN : sy2;
  } else {
    state.sumX = state.sumX! - oldX + x;
    state.sumY = state.sumY! - oldY + y;
    state.sumXY = state.sumXY! - oldX * oldY + x * y;
    state.sumX2 = state.sumX2! - oldX * oldX + x * x;
    state.sumY2 = state.sumY2! - oldY * oldY + y * y;
  }

  if (Number.isNaN(state.sumX!)) return NaN;
  const n = length;
  const numerator = n * state.sumXY! - state.sumX! * state.sumY!;
  const denomX = n * state.sumX2! - state.sumX! * state.sumX!;
  const denomY = n * state.sumY2! - state.sumY! * state.sumY!;
  if (denomX <= 0 || denomY <= 0) return NaN;
  return numerator / Math.sqrt(denomX * denomY);
}

export interface MedianState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.median(source, length) - 최근 length바(현재 포함) 중 중앙값(짝수개면 가운데 두 값 평균).
// pine2py wavealgo/ta/median.py는 매 호출 source.get(0..length-1) 전체를 재구축해 정렬한다(위치
// 가중치 없는 highest/lowest의 monotonic deque 트릭이 여기선 적용 안 됨 - 극값이 아니라 "가운데
// 순서통계"라, 원소 하나가 창에서 빠지면 나머지 원소들의 상대 순위가 전부 흔들릴 수 있어 O(1)/bar로
// 유지할 단조 구조가 없다). O(log n)/bar로 낮추려면 임의 원소를 지울 수 있는 "제거 가능한" 두-힙
// (+ lazy deletion 해시)이 필요하지만, 이는 균형/동기화 불변식이 늘어 정확성 버그 표면이 커지는
// 반면 이 리포의 실사용 length 범위(수십~수백)에서 O(length log length) 정렬은 10k바 기준으로도
// 무시할 수준(V8 native sort) - **GOAL.md "TA는 전부 incremental O(1)/bar" 원칙의 세 번째 명시적
// 예외**(alma C113/cci C114에 이은, 이번엔 "캐시 가능한 정적 부분이 없다"가 아니라 "정렬 자체가
// incremental 구조를 허용하지 않는다"는 새 이유). sma/change와 동일한 NaN-프라임 순환 버퍼
// (raw-passthrough - source 원값 그대로 저장)를 쓰되, 버퍼 자체는 정렬하지 않고(다음 바 writeIdx
// 계산이 순환 버퍼의 인덱스 순서에 의존) 매 바 얕은 복사본만 정렬해 중앙값을 뽑는다. NaN 판정은
// 정렬 comparator에 맡기지 않는다 - `(a,b)=>a-b`는 a/b 중 하나라도 NaN이면 NaN을 반환해 유효하지
// 않은 비교 함수가 되고(ECMA sort는 이런 경우 결과 순서를 명시하지 않음), highest/lowest와 동일한
// "정렬 전에 버퍼를 먼저 훑어 NaN이 하나라도 있으면 즉시 NaN" 게이트로 이 문제를 원천 차단한다.
export function median(state: MedianState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  for (let i = 0; i < length; i++) {
    if (Number.isNaN(buffer[i]!)) return NaN;
  }
  const sorted = buffer.slice().sort((a, b) => a - b);
  const mid = Math.floor(length / 2);
  if (length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

export interface ModeState {
  buffer?: number[];
  writeIdx?: number;
  count?: number;
}

// ta.mode(source, length) - 최근 length바(현재 포함) 중 최빈값(동률이면 최솟값).
// pine2py wavealgo/ta/mode.py는 median과 게이트/NaN 처리가 둘 다 다르다:
// (1) 워밍업 게이트가 median의 "버퍼에 NaN-프라임 슬롯이 남아있는가"(source.get 결과 자체로 판정)가
//     아니라 context.get_ta_state로 관리하는 순수 호출 횟수 카운터(`count`) - length바 미만 호출이면
//     그 바의 값이 NaN이든 아니든 무조건 NaN. 순환 버퍼의 NaN-프라임만으로는 이 게이트를 재현할 수
//     없다(예: length=3, 2번째 호출까지 값이 전부 유효해도 median 방식이면 버퍼에 미기록 슬롯이 없어
//     워밍업 종료로 오판) - 그래서 median과 달리 buffer와 별개인 count 필드가 필요하다.
// (2) 창 안의 개별 NaN은 median처럼 "하나라도 있으면 전체 NaN"이 아니라 집계에서 제외(스킵)하고,
//     유효값이 하나도 없을 때만 NaN을 반환한다(mode.py `vals` 리스트가 NaN을 건너뛰며 채워짐).
// 정렬이 아닌 빈도 집계라 O(1)/bar 유지가 median보다도 더 불가능(원소 하나가 빠지고 들어올 때마다
// 전체 빈도 분포가 흔들릴 수 있음) - median(C115)에 이은 GOAL.md incremental O(1)/bar 네 번째 명시적
// 예외. 매 바 O(length) 집계는 이 리포 실사용 length 범위에서 무시할 수준(median과 동일 트레이드오프).
// 동률 tie-break는 `min(candidates)`(pine2py mode.py Counter 기반) - array.mode(Python
// statistics.mode, 최초 등장값 tie-break)와 알고리즘이 다르므로 재사용하지 않는다.
export function mode(state: ModeState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.count = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  state.count = state.count! + 1;
  if (state.count < length) return NaN;

  const counts = new Map<number, number>();
  for (let i = 0; i < length; i++) {
    const v = buffer[i]!;
    if (Number.isNaN(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size === 0) return NaN;
  let maxFreq = 0;
  for (const c of counts.values()) if (c > maxFreq) maxFreq = c;
  let result = Infinity;
  for (const [v, c] of counts) {
    if (c === maxFreq && v < result) result = v;
  }
  return result;
}

export interface PercentrankState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.percentrank(source, length) - 최근 length바(현재 **제외**) 중 현재값 이하인 값의 비율(%).
// pine2py wavealgo/ta/percentrank.py는 median/mode(둘 다 현재 바 포함 length개 창)와 달리 창이
// i=1..length(현재 바로부터 1~length바 전, 현재 자신은 창에서 빠짐)라 median(C115)/mode(C116)에
// 이어 percentrank가 여섯 번째 순환 버퍼 변형이자 처음으로 "읽기가 쓰기보다 먼저" 오는 사례다:
// median/mode/sma/wma류는 현재 값을 먼저 버퍼에 push한 뒤 그 버퍼(현재 포함)를 읽어 결과를 내지만,
// percentrank는 이번 바 push **이전**의 버퍼 내용(=1~length바 전 값들)으로 먼저 결과를 낸 다음에야
// 현재 값을 버퍼에 push한다(다음 호출이 "1바 전" 값으로 이걸 보게 하기 위해). 이 순서 자체가
// pine2py의 표면적인 "이중 게이트"(len(source)<length면 조기 NaN + 루프 안에서 i>=len(source)면
// 재차 NaN)를 설명한다 — 실제로는 버그가 아니라 "length바 전 값까지 읽으려면 length+1바째부터
// 값이 나온다"는 산식 자체의 필연적 결과임을 python(scratch, gitignored) 직접 실행으로 확인:
// length=3일 때 워밍업이 끝나는 시점은 median/mode처럼 바2(0-index)가 아니라 바3이었다. NaN 처리는
// 두 갈래: (1) 현재값이 NaN이면 버퍼 내용과 무관하게 즉시 NaN(버퍼는 현재값을 담지 않으므로 버퍼
// NaN 스캔이 이 케이스를 못 잡음 — 별도 체크 필수), (2) 그 외엔 median과 동일하게 버퍼(1~length바
// 전 창)에 NaN-프라임 잔존 슬롯이든 실제 NaN이든 하나라도 있으면 즉시 NaN(mode처럼 개별 스킵이
// 아님). 두 게이트 모두 "버퍼에 하나라도 NaN이 있는가" 단일 스캔으로 워밍업/오염을 통합
// 처리하므로(median과 동일 원칙) mode(C116)가 필요했던 별도 count 필드는 불필요 — 버퍼가 아직
// 안 찼으면 NaN-프라임 슬롯 자체가 그 스캔에 자연히 걸린다. 현재값은 결과 계산 후 무조건 버퍼에
// push(raw-passthrough, NaN도 그대로 기록 — change/crossover/median과 동일). python 300건
// fuzz(length 1~10, NaN 12% 혼입, 최대 40바, scratch 검증 후 삭제) 0 mismatch로 확인.
export function percentrank(state: PercentrankState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  let result: number;
  if (Number.isNaN(value)) {
    result = NaN;
  } else {
    let hasNaN = false;
    for (let i = 0; i < length; i++) {
      if (Number.isNaN(buffer[i]!)) {
        hasNaN = true;
        break;
      }
    }
    if (hasNaN) {
      result = NaN;
    } else {
      let count = 0;
      for (let i = 0; i < length; i++) {
        if (buffer[i]! <= value) count++;
      }
      result = (count / length) * 100;
    }
  }
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  return result;
}

export interface PercentileNearestRankState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.percentile_nearest_rank(source, length, percentage=50) - 최근 length바(현재 포함) 중
// nearest-rank 방식 백분위. pine2py wavealgo/ta/percentrank.py의 percentile_nearest_rank는
// median.py와 창 수집 로직이 완전히 동일하다(source.get(0..length-1), 하나라도 NaN이면 즉시 NaN) -
// median(C115)의 raw-passthrough 순환 버퍼를 그대로 재사용하고 정렬 후 선택 인덱스만 다르다.
// idx = clamp(ceil((percentage/100)*length) - 1, 0, length-1) (pine2py 그대로 literal port).
export function percentileNearestRank(state: PercentileNearestRankState, value: number, length: number, percentage = 50): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조). percentage는 TV simple float라 대상 아님
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  for (let i = 0; i < length; i++) {
    if (Number.isNaN(buffer[i]!)) return NaN;
  }
  const sorted = buffer.slice().sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(length - 1, Math.ceil((percentage / 100) * length) - 1));
  return sorted[idx]!;
}

export interface PercentileLinearInterpolationState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.percentile_linear_interpolation(source, length, percentage=50) - percentileNearestRank와
// 동일한 창 수집(median 순환 버퍼 재사용)에 선형 보간만 다르다: pos = (percentage/100)*(length-1),
// lo/hi 인접 두 순서통계량 사이를 frac만큼 보간(pine2py wavealgo/ta/percentrank.py 그대로 literal port).
export function percentileLinearInterpolation(state: PercentileLinearInterpolationState, value: number, length: number, percentage = 50): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조). percentage는 TV simple float라 대상 아님
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  for (let i = 0; i < length; i++) {
    if (Number.isNaN(buffer[i]!)) return NaN;
  }
  const sorted = buffer.slice().sort((a, b) => a - b);
  const pos = (percentage / 100) * (length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, length - 1);
  const frac = pos - lo;
  return sorted[lo]! + frac * (sorted[hi]! - sorted[lo]!);
}

// ta.percentile_nearest_rank/ta.percentile_linear_interpolation(source, length, percentage=50) -
// length가 series인 변형(배치25 (4) 계속, next_hint(C552) 잔여 싱글턴, range와 같은 묶음). pine2py
// wavealgo/ta/percentrank.py의 두 percentile_* 함수도 median.py와 동일하게 상태 없이 매 호출
// source.get(0..length-1)을 재구축·정렬한다(get_ta_state 미사용, python 직접 실행으로 가변 length
// 정상 동작 확인 2026-08-01) - median(#181)과 동일 축으로 오라클 성립
// (oracle/cases/ta_range_percentile_varlen.pine). 버퍼/writeIdx/barIdx 메커니즘은 highestVarLen과
// 완전 동형(ExtremeVarLenState 재사용), 값 계산은 각각 고정 percentileNearestRank/
// percentileLinearInterpolation과 동일한 정렬 후 선택/보간. 엣지(python 직접 실행 확인
// 2026-08-01): length<1(0/음수 둘 다)은 빈 window를 인덱싱하는 pine2py IndexError 크래시(range와
// 달리 "크래시 없이 정의된 동작"이 없음) - median/wma와 동일하게 na 자체 결정. length=NaN은
// `range(nan)` TypeError 크래시라 highestVarLen과 동일 na 전파 외삽(TV 미검증 가설). 창 안 NaN
// 하나면 즉시 NaN(고정판과 동일 poison window). percentage는 이 축(length)과 무관해 고정판 그대로
// 패스스루한다.
export function percentileNearestRankVarLen(
  state: ExtremeVarLenState,
  value: number,
  length: number,
  percentage: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return NaN;
  if (len > writeIdx + 1) return NaN;
  const window: number[] = [];
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    window.push(v);
  }
  window.sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(len - 1, Math.ceil((percentage / 100) * len) - 1));
  return window[idx]!;
}

// ta.percentile_linear_interpolation series-length 변형 - percentileNearestRankVarLen과 창 수집이
// 동일하고 선형 보간만 다르다. 상세는 percentileNearestRankVarLen 주석 참조.
export function percentileLinearInterpolationVarLen(
  state: ExtremeVarLenState,
  value: number,
  length: number,
  percentage: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.buffer === undefined) {
    state.buffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.buffer[writeIdx] = value;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return NaN;
  if (len > writeIdx + 1) return NaN;
  const window: number[] = [];
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const v = state.buffer[i]!;
    if (Number.isNaN(v)) return NaN;
    window.push(v);
  }
  window.sort((a, b) => a - b);
  const pos = (percentage / 100) * (len - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, len - 1);
  const frac = pos - lo;
  return window[lo]! + frac * (window[hi]! - window[lo]!);
}

export interface VwmaVarLenState {
  priceBuffer?: Float64Array;
  volBuffer?: Float64Array;
  writeIdx?: number;
  lastBarIdx?: number;
}

// ta.vwma(source, length) — length가 series인 변형(배치25 (4) 마지막 항목, C555). 버퍼/writeIdx/
// barIdx 덮어쓰기 메커니즘은 highestVarLen과 완전 동형(단일 Float64Array 대신 price/volume 두
// 버퍼를 나란히 관리 — 위 고정 vwma()의 "두 신호 병렬" 구조를 O(length) 재스캔으로 바꾼 것).
// **가변 축은 pine2py 버그 불추종(hand-verified, sma #179/wma #181과 동일 패턴)**: pine2py
// wavealgo/ta/vwma.py도 첫 성공 호출의 length로 state["price_window"]/["vol_window"] 크기를
// 영구 고정한 채(같은-바 반복 호출도 last_idx 미검사로 pop/append가 매 호출 일어나는 latent 버그
// 동반, python 직접 실행 확인 2026-08-01 — DIVERGENCES #184가 이미 이 축을 "hand-verified 필요"로
// 예고). GOAL.md "알려진 버그 불추종" 원칙에 따라 TV 문서 정의(VWMA = Σ(price·volume, length) /
// Σ(volume, length))대로 구현한다. 오라클은 sma/wma와 동일하게 "series 한정자 + 값은 상수"인
// 퇴화 케이스(oracle/cases/ta_vwma_varlen.pine)로만 버퍼/워밍업/NaN 메커니즘을 대조하고, 값이
// 실제로 변하는 축(wild min(barssince,l)/loop-body 패턴)은 hand-verified(tests/unit/runtime.test.ts
// vwmaVarLen + 파이프라인 E2E)로 검증한다. 엣지: length<1은 pine2py가 두 번째 호출부터 빈 리스트
// pop(0) IndexError로 크래시(첫 호출만 v_sum==0→NaN, 그다음 바에서 무조건 깨짐 — highest의 ±inf처럼
// "크래시 없이 정의된 동작"이 없어 이식 불가) → na 자체 결정(sma/wma와 동일 논리). length=NaN은
// highestVarLen과 동일 na 전파 외삽(TV 미검증 가설). 창 안 price/volume 어느 한쪽이라도 NaN이면
// 결과 NaN(고정 vwma()의 오염 시맨틱과 동일), vSum===0도 NaN(0-나눗셈 방지, 고정 버전과 동일).
export function vwmaVarLen(
  state: VwmaVarLenState,
  price: number,
  volume: number,
  length: number,
  barCount: number,
  barIdx: number,
): number {
  if (state.priceBuffer === undefined) {
    state.priceBuffer = new Float64Array(barCount).fill(NaN);
    state.volBuffer = new Float64Array(barCount).fill(NaN);
    state.writeIdx = -1;
    state.lastBarIdx = -1;
  }
  if (barIdx !== state.lastBarIdx) {
    state.writeIdx = state.writeIdx! + 1;
    state.lastBarIdx = barIdx;
  }
  const writeIdx = state.writeIdx!;
  state.priceBuffer[writeIdx] = price;
  state.volBuffer![writeIdx] = volume;

  const len = Math.trunc(length);
  if (Number.isNaN(len)) return NaN;
  if (len < 1) return NaN;
  if (len > writeIdx + 1) return NaN;
  let pvSum = 0;
  let vSum = 0;
  for (let i = writeIdx - len + 1; i <= writeIdx; i++) {
    const p = state.priceBuffer[i]!;
    const v = state.volBuffer![i]!;
    if (Number.isNaN(p) || Number.isNaN(v)) return NaN;
    pvSum += p * v;
    vSum += v;
  }
  if (vSum === 0) return NaN;
  return pvSum / vSum;
}

export interface DevState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.dev(source, length) - Mean Absolute Deviation: MAD = average(|v - mean|) over the window,
// mean = average(v) over the same window (a plain arithmetic mean, not ta.sma's O(1) state).
// pine2py wavealgo/ta/dev.py accepts context/state_key kwargs but never calls
// context.get_ta_state — unlike every other TA in this file (including cci, which at least uses
// context for its phase1/phase2 distinction), dev() is a pure function that re-reads
// source.get(0..length-1) directly from the Series on every single call, with zero persisted
// state across calls (confirmed by grep: no state usage in dev.py body at all). This means dev
// has no cci-style "skip-freeze on NaN" phase — the window is always exactly the literal last
// `length` bars, so it collapses to a plain raw-passthrough circular buffer (sma/change/median
// style: always push, NaN poisons that read but the buffer keeps rolling forward regardless).
// GOAL.md O(1)/bar 원칙의 여섯 번째 명시적 예외(alma/cci/median/mode/percentrank에 이음) — MAD는
// mean 자체가 매 바 바뀌므로 sum처럼 러닝 합계로 캐시할 수 없다(cci C114와 동일 이유로 sum도 함께
// O(length) 재계산해 러닝 합계 캔슬레이션 함정을 원천 차단).
export function dev(state: DevState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;

  let sum = 0;
  for (const v of buffer) {
    if (Number.isNaN(v)) return NaN;
    sum += v;
  }
  const mean = sum / length;
  let madSum = 0;
  for (const v of buffer) madSum += Math.abs(v - mean);
  return madSum / length;
}

export interface RciState {
  buffer?: number[];
  writeIdx?: number;
}

// ta.rci(source, length) - Rank Correlation Index: Spearman rank correlation between price and
// time over a length-bar window (current bar included), scaled to [-100, 100]. pine2py
// wavealgo/에 대응 구현이 전혀 없어(전수 grep 0건) 오라클 대조 자체가 불가한 hand-verified
// 신규 함수(배치25 (3), DIVERGENCES.md #177) — TV native builtin화 이전부터 통용되던 표준 정의
// RCI = (1 - 6*sum(d_i^2) / (n*(n^2-1))) * 100, d_i = timeRank_i - priceRank_i를 그대로 구현한다.
// 창은 median/dev(C115/C119)와 동일하게 raw-passthrough 순환 버퍼(현재 바 포함 length개, 하나라도
// NaN이면 즉시 NaN) — 단 median/dev와 달리 정렬만으로는 부족하고 "몇 바 전 값인가"(시간 순위)가
// 필요해 writeIdx 자체를 순위 계산에 쓴다: 이번 바 push 직후의 writeIdx가 곧 현재 바(timeRank=0)의
// 슬롯이므로, 임의 슬롯 k의 timeRank는 (curIdx - k + length) % length로 역산된다. priceRank_i는
// "i보다 값이 큰 원소 개수"(동률은 세지 않는 strict-greater 카운트 — Spearman 표준의 average-rank
// tie-break가 아니다, TV 실제 tie 처리는 미검증이라 DIVERGENCES에 가설로 등재). alma/cci/median/
// mode/percentrank/dev에 이은 GOAL.md O(1)/bar 원칙의 일곱 번째 명시적 예외(순위 계산 자체가
// O(length^2)/bar — 정렬 기반 median/mode보다도 비싸지만 이 리포 실사용 length 범위에서는 무시
// 가능한 수준, cci/dev와 동일 트레이드오프 판단). 완전 상승(가장 최근 값이 창 안에서 최댓값)이면
// timeRank와 priceRank가 항등이라 sum(d_i^2)=0 -> RCI=+100, 완전 하락이면 -100이 되도록 손으로
// 유도해 검증(scratch/rci_probe.mjs, gitignored). length=1은 분모 n*(n^2-1)=0이라 0/0=NaN으로
// 자연 낙착(별도 가드 불필요 — IEEE754가 이미 na-safe한 값을 냄).
export function rci(state: RciState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
  }
  const buffer = state.buffer;
  const curIdx = state.writeIdx!;
  buffer[curIdx] = value;
  state.writeIdx = (curIdx + 1) % length;

  for (let k = 0; k < length; k++) {
    if (Number.isNaN(buffer[k]!)) return NaN;
  }

  let sumDsq = 0;
  for (let k = 0; k < length; k++) {
    const timeRank = (curIdx - k + length) % length;
    let priceRank = 0;
    for (let j = 0; j < length; j++) {
      if (buffer[j]! > buffer[k]!) priceRank++;
    }
    const d = timeRank - priceRank;
    sumDsq += d * d;
  }
  return (1 - (6 * sumDsq) / (length * (length * length - 1))) * 100;
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
// was NaN - only value being NaN skips the update. e2AbsVal===0 returns 0.0 (not NaN), matching
// tsi.py L128-129.
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
  if (e2AbsVal === 0) return 0.0;
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
  atr?: AtrState;
}

// ta.kc(source, length, mult, useTrueRange) - Keltner Channels, the third multi-return TA
// ([basis, upper, lower] tuple, after ta.macd/ta.bb). pine2py wavealgo/ta/kc.py computes
// basis=ema(source,length); if useTrueRange (default true), range=atr(high,low,close,length)
// (the already-implemented rt.ta.atr, C53); upper/lower=basis±mult*range.
//
// pine2py kc.py early-returns (nan,nan,nan) the instant basis is NaN, and in that branch never
// calls atr() at all that bar - unlike ema/atr, which are two *independent* length-bar warmups
// that must both advance every bar to finish in parallel (both warm up over exactly `length` bars
// starting from bar 0). Gating atr's call on basis's NaN-ness delays atr's own RMA warmup until
// ema's has already finished, pushing atr's first valid value out by another `length` bars instead
// of matching ema's warmup end - scratch/probe_kc.mjs confirmed this gated port literally diverges
// from a straight ema()+atr() composition from bar `length` onward (not just during warmup). So kc()
// calls ema() and atr() unconditionally every bar (the same "let the inner TA's own NaN gate handle
// skip logic" principle as ta.tsi/ta.macd, C49/C50) and only then checks both results for NaN.
//
// **Compounding divergence discovered via direct pine2py probing** (DIVERGENCES.md #9): kc.py's
// own structure returns the *entire* (nan,nan,nan) triple - not just range-dependent fields -
// whenever `range_src` (atr's output) is NaN, even if `basis_val` (ema's output) was already
// valid that bar. Probing pine2py's internal ta_state directly confirmed ema's own prev_ema is
// already seeded correctly at the bar where a standalone ta.ema(source,length) would first go
// non-NaN, but kc()'s *return value* stays NaN one extra bar because atr's warmup (#8's
// documented off-by-one) hasn't finished yet - the golden's basis is not itself delayed, it's
// masked by atr's bug leaking through kc.py's shared NaN gate. Since pine2js's rt.ta.atr doesn't
// carry that off-by-one (#8), useTrueRange=true's basis/upper/lower/kcw are all one bar earlier
// than golden - not just range-derived fields. useTrueRange=false never triggers this (see below,
// its range is a plain non-NaN 0 whenever source is valid), so only that branch's basis is safe to
// compare against golden (oracle/golden/ta_kc_kcw.json onlyKeys, tests/oracle/ta_kc_kcw.test.ts).
//
// **Intentional divergence from pine2py** (DIVERGENCES.md #9): when useTrueRange is false, pine2py
// kc.py reads `h = source.get(0)` and `l_val = source.get(0)` (both from `source`, not the bar's
// actual high/low) so `range = abs(h - l_val)` is always exactly 0 (unless source is NaN) - a
// latent pine2py bug (same class as wpr/atr, C44/C53). The TradingView Script Reference for
// `ta.kc` states the useTrueRange=false formula is literally "high - low", so pine2js implements
// that instead of the pine2py bug (GOAL.md "pine2py의 알려진 버그는 따르지 않는다"). NaN in high or
// low propagates through the plain subtraction automatically (no explicit guard needed - IEEE754
// NaN arithmetic already yields NaN).
//
// Pine syntax has no high/low/close parameters (only source/length/mult/useTrueRange); codegen
// injects $.high.get(0)/$.low.get(0)/$.close.get(1)(prevClose) ahead of the user args, the same
// implicit-injection pattern as ta.atr (analyzer.ts TA_REGISTRY.kc comment).
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
    state.atr = {};
  }
  const basis = ema(state.ema, value, length);
  const atrVal = atr(state.atr!, high, low, prevClose, length);
  const range = useTrueRange ? atrVal : high - low;
  if (Number.isNaN(basis) || Number.isNaN(range)) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }
  scratch[0] = basis;
  scratch[1] = basis + mult * range;
  scratch[2] = basis - mult * range;
}

// ta.kcw(source, length, mult, useTrueRange) - Keltner Channels Width: (upper-lower)/basis*100.
// pine2py wavealgo/ta/kcw.py calls kc(...) to get (basis, upper, lower) then returns NaN if basis
// is NaN or exactly 0, else (upper-lower)/basis*100 - the same "call kc for its side effect, inline
// the arithmetic instead of writing to scratch" composition as ta.bbw over ta.bb (C52). Reuses the
// same KcState{ema,atr} shape (this call site owns its own independent taSlots slot, same as
// ta.stdev calling ta.variance on its own StdevState).
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
    state.atr = {};
  }
  const basis = ema(state.ema, value, length);
  const atrVal = atr(state.atr!, high, low, prevClose, length);
  const range = useTrueRange ? atrVal : high - low;
  if (Number.isNaN(basis) || Number.isNaN(range) || basis === 0) return NaN;
  const upper = basis + mult * range;
  const lower = basis - mult * range;
  return ((upper - lower) / basis) * 100;
}

export interface ObvState {
  prevObv?: number;
  prevClose?: number;
}

// ta.obv() - On Balance Volume. Pine 문법상 인자가 없고(close/volume은 bar series 암묵 사용,
// tr/atr과 동일한 implicit unshift 패턴) codegen이 $.close.get(0)/$.volume.get(0)을 앞에 끼워
// 넣는다(TA_REGISTRY.obv argCount:0). pine2py wavealgo/ta/obv.py 소스 대조 결과 지금까지 나온 TA
// 중 가장 단순한 여섯 번째 NaN 처리 패턴: close 또는 volume이 NaN이면 state를 **전혀 건드리지
// 않고** 즉시 NaN을 반환한다(barssince의 "카운터 자체는 갱신 시도"와도 다름 — obv는 정말 아무것도
// 안 씀). 그래서 state.prevObv가 아직 없는(="prev_obv" not in state와 동치) "최초 유효 바"에서
// prevObv=0.0으로 시드하고 0.0을 반환하는데, 이 시드는 그 이전에 몇 개의 NaN 바가 있었든 항상
// 그대로 0.0이다 — sma/ema/rma류처럼 "N바 워밍업 후 값이 나온다"는 개념 자체가 없다(scratch/
// probe_obv.mjs "leading NaN close" 케이스로 확인). 이후 매 바 close를 prevClose와 비교해 오르면
// +volume, 내리면 -volume, tie면 유지 — NaN 갭이 있었다면 갭 이전 마지막 유효 prevClose와 비교됨
// (갭 바가 state를 안 건드리므로, probe_obv.mjs "mid-stream NaN gap" 케이스로 확인).
export function obv(state: ObvState, close: number, volume: number): number {
  if (Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  if (state.prevObv === undefined) {
    state.prevObv = 0;
    state.prevClose = close;
    return 0;
  }
  const prevClose = state.prevClose!;
  const prevObv = state.prevObv;
  let currentObv: number;
  if (close > prevClose) currentObv = prevObv + volume;
  else if (close < prevClose) currentObv = prevObv - volume;
  else currentObv = prevObv;
  state.prevObv = currentObv;
  state.prevClose = close;
  return currentObv;
}

export interface AccDistState {
  cum?: number;
}

// ta.accdist() - Accumulation/Distribution. Pine 문법상 인자가 없고(close/high/low/volume은 bar
// series 암묵 사용, obv와 동일한 implicit unshift 패턴) codegen이 넷을 앞에 끼워 넣는다
// (TA_REGISTRY.accdist argCount:0). pine2py wavealgo/ta/accdist.py 소스 대조 결과 상태 없는 순수
// mfv=((close-low)-(high-close))/(high-low)*volume(high===low면 mfv=0.0) 계산 후 러닝 합계에
// 누적하는 ta.cum(C37)과 같은 모양이지만, NaN 처리는 cum과 다르다 — cum은 NaN 입력을 0으로
// 치환해 누적을 계속 이어가지만, accdist는 넷 중 하나라도 NaN이면 mfv 계산 자체를 건너뛰고 cum을
// 갱신하지 않은 채 그대로 NaN을 반환한다(cum의 "NaN→0 치환" 패턴이 아니라 ema/rma류의 "NaN이면
// 상태 불변" 패턴과 같은 부류 — probe_obv.mjs "accdist NaN gap" 케이스로 cum이 갭 이전 값을 그대로
// 유지함을 확인).
export function accdist(state: AccDistState, close: number, high: number, low: number, volume: number): number {
  if (Number.isNaN(close) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(volume)) return NaN;
  const hlRange = high - low;
  const mfv = hlRange === 0 ? 0 : ((close - low) - (high - close)) / hlRange * volume;
  if (state.cum === undefined) state.cum = 0;
  state.cum += mfv;
  return state.cum;
}

export interface PvtState {
  cum?: number;
  prevClose?: number;
}

// ta.pvt() - Price Volume Trend. Pine 문법상 인자가 없고(close/volume은 bar series 암묵 사용,
// obv와 동일한 implicit unshift 패턴) codegen이 $.close.get(0)/$.volume.get(0)을 뒤에 끼워 넣는다
// (TA_REGISTRY.pvt argCount:0). pine2py wavealgo/ta/pvt.py 소스 대조 결과 obv(C55)와 완전히 동일한
// 여섯 번째 NaN 패턴: close 또는 volume이 NaN이면 state를 **전혀 건드리지 않고** 즉시 NaN 반환,
// state.cum이 아직 없는(="cum" not in state와 동치) "최초 유효 바"에서 cum=0.0/prevClose=close로
// 시드하고 0.0 반환(obv와 마찬가지로 워밍업 구간 없음). 이후 change_pct=(close-prevClose)/prevClose
// (**prevClose===0이면 change_pct=0.0** — obv엔 없던 나눗셈 가드, pvt.py 고유), cum += change_pct*
// volume으로 누적(scratch/probe_pvt_wad.mjs로 이 나눗셈 가드를 포함해 브루트포스 대조 완료).
export function pvt(state: PvtState, close: number, volume: number): number {
  if (Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  if (state.cum === undefined) {
    state.cum = 0;
    state.prevClose = close;
    return 0;
  }
  const prevClose = state.prevClose!;
  const changePct = prevClose === 0 ? 0 : (close - prevClose) / prevClose;
  state.cum += changePct * volume;
  state.prevClose = close;
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

// ta.wvad() - Williams Variable Accumulation/Distribution. Pine 문법상 인자가 없고(open/high/low/
// close/volume은 bar series 암묵 사용) codegen이 다섯을 끼워 넣는다(TA_REGISTRY.wvad argCount:0,
// 지금까지의 implicit-push 그룹 중 인자 개수가 가장 많음). pine2py wavealgo/ta/wvad.py 소스 대조
// 결과 obv/pvt/wad/nvi/pvi(TA_IMPLICIT_CALL bare 그룹)와 달리 **완전히 stateless**인 순수 함수 —
// tr(C53)과 동일 부류라 state 인자는 TA_REGISTRY 디스패치 일관성을 위해서만 받고 내부에서 전혀
// 안 쓴다. open/high/low/close/volume 중 하나라도 NaN이면 즉시 NaN, high===low(range 0)이면
// **0.0**(NaN 아님), 아니면 ((close-open)/(high-low))*volume(scratch/probe_wvad_iii.mjs로
// 브루트포스 대조 완료).
export function wvad(_state: unknown, open: number, high: number, low: number, close: number, volume: number): number {
  if (Number.isNaN(open) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  const denom = high - low;
  if (denom === 0) return 0;
  return ((close - open) / denom) * volume;
}

// ta.iii() - Intraday Intensity Index. Pine 문법상 인자가 없고(high/low/close/volume은 bar series
// 암묵 사용) codegen이 넷을 끼워 넣는다(TA_REGISTRY.iii argCount:0). pine2py wavealgo/ta/iii.py
// 소스 대조 결과 wvad와 동일하게 **완전히 stateless**(tr류) — high/low/close/volume 중 하나라도
// NaN이면 즉시 NaN, (high-low)*volume===0(range가 0이거나 volume이 0)이면 **0.0**(NaN 아님, wvad와
// 달리 volume===0만으로도 분모가 0이 될 수 있음 — scratch/probe_wvad_iii.mjs로 별도 검증),
// 아니면 (2*close-high-low)/((high-low)*volume).
export function iii(_state: unknown, high: number, low: number, close: number, volume: number): number {
  if (Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close) || Number.isNaN(volume)) return NaN;
  const denom = (high - low) * volume;
  if (denom === 0) return 0;
  return (2 * close - high - low) / denom;
}

export interface VwapState {
  cumPv?: number;
  cumVol?: number;
  // Σ(volume·source²) — 3-인자 밴드 폼(C362)의 분산 계산용. 폼과 무관하게 항상 함께 유지한다
  // (분기 제거 — 1/2-인자 폼에서는 읽히지 않는 여분 러닝 합계일 뿐 반환값에 영향 없음).
  cumPv2?: number;
}

// ta.vwap(source[, anchor[, stdev_mult]]) - Volume Weighted Average Price. Pine 문법상 volume
// 인자가 없고 내장 bar series volume을 암묵 사용한다(vwma/mfi와 동일 — codegen이 $.volume.get(0)을
// source 바로 뒤에 splice, TA_REGISTRY.vwap 주석 참조).
//
// [1-인자 폼, C59 — 오라클 검증] pine2py wavealgo/ta/vwap.py 소스 대조: cum_pv(Σ price*vol)/
// cum_vol(Σ vol) 러닝 합계의 전체 누적, **세션/anchor 리셋 없음**('no session reset in backtest
// mode' — LIMITATIONS.md "ta.vwap 세션 리셋" 참조). NaN 처리는 obv류(price/vol 어느 쪽이든 NaN이면
// state를 전혀 건드리지 않고 즉시 NaN)이지만 cum_vol===0(거래량 0 프리픽스)일 때는 **누적은 이미
// 반영한 채** NaN만 반환(vwap.py의 cum_vol==0 가드가 state 대입 뒤 — scratch/probe_vwap.mjs
// 브루트포스 대조 완료). 워밍업 구간 없음: 바0부터 유효(vol>0이면). anchor 기본값 false라 이 폼의
// 동작은 C362 이후에도 바이트 동일.
//
// [2/3-인자 폼, C362 — TV 미검증(가설), DIVERGENCES 참조] pine2py에 anchor 개념 자체가 없어 오라클
// 구조적 불가 — TV 공식 VWAP 지표의 공개 소스 패턴(`sumSrcVol := isNewPeriod ? src*volume :
// src*volume + sumSrcVol[1]`)을 hand-verified 이식:
// - anchor(series bool)가 true인 바에서 세 러닝 합계를 0으로 리셋하고 **그 바 자신이 새 누적의 첫
//   원소**가 된다. na(NaN) anchor는 false 취급(리셋 아님). NaN 데이터 바에서도 리셋 자체는 수행해
//   (아래 NaN-skip은 누적 접기만 건너뜀) 리셋 신호가 조용히 유실되지 않게 한다.
// - 3-인자 폼(stdevMult + scratch 존재)은 반환 대신 scratch[0..2]=[vwap, upper, lower]를 쓴다
//   (다중 반환 TA 공유 스크래치 규약, GOAL.md). 분산은 TV 소스와 동일한 volume-가중 모멘트 공식
//   Var = Σ(vol·src²)/Σvol − vwap² (음수는 0으로 클램프 — TV 소스 자체가 동일 클램프 보유),
//   upper/lower = vwap ± stdevMult·sqrt(Var). vwap가 NaN이면 밴드도 전부 NaN.
// 튜플 순서 [vwap, upper, lower]는 TV 레퍼런스 시그니처 및 wild 실사용
// (`[vwap, upper, lower] = ta.vwap(...)` 변수명 관행)과 일치 — 웹 미검증이라 가설로 등재.
export function vwap(
  state: VwapState,
  value: number,
  volume: number,
  anchor: boolean | number = false,
  stdevMult: number = NaN,
  scratch?: Float64Array,
): number {
  if (state.cumPv === undefined || anchor === true) {
    state.cumPv = 0;
    state.cumVol = 0;
    state.cumPv2 = 0;
  }
  if (Number.isNaN(value) || Number.isNaN(volume)) {
    if (scratch !== undefined) {
      scratch[0] = NaN;
      scratch[1] = NaN;
      scratch[2] = NaN;
    }
    return NaN;
  }
  const cumPv = state.cumPv + value * volume;
  const cumVol = state.cumVol! + volume;
  const cumPv2 = state.cumPv2! + volume * value * value;
  state.cumPv = cumPv;
  state.cumVol = cumVol;
  state.cumPv2 = cumPv2;
  const v = cumVol === 0 ? NaN : cumPv / cumVol;
  if (scratch !== undefined) {
    if (Number.isNaN(v)) {
      scratch[0] = NaN;
      scratch[1] = NaN;
      scratch[2] = NaN;
    } else {
      let variance = cumPv2 / cumVol - v * v;
      if (variance < 0) variance = 0;
      const sd = Math.sqrt(variance);
      scratch[0] = v;
      scratch[1] = v + stdevMult * sd;
      scratch[2] = v - stdevMult * sd;
    }
  }
  return v;
}

export interface PivotState {
  extreme?: ExtremeState;
}

// ta.pivothigh/ta.pivotlow(source, left, right) - candidate=source.get(right)(right바 지연)가 창
// [0..left+right] 전체(길이 left+right+1)에서 최댓값/최솟값이면 그 값을, 아니면 NaN을 반환한다
// (pine2py wavealgo/ta/pivot.py: 왼쪽 source.get(right+1..right+left)/오른쪽 source.get(0..right-1)
// 둘 다 NaN이거나 candidate보다 **엄격히** 더 극단이면 NaN — 동률은 pivot 성립을 막지 않는다,
// highest류와 동일한 poison window로 창 안 NaN/데이터 부족도 즉시 NaN).
//
// 새 자료구조 없이 length=left+right+1짜리 rt.ta.highest/rt.ta.lowest(C42 ExtremeState)를 그대로
// 호출하는 합성(hma/stoch류 "이미 구현된 TA 재사용" 원칙) — 창 [0..left+right]가 정확히
// highest(source, left+right+1)의 창과 일치하므로 windowMax===candidate(둘 다 non-NaN)가 곧
// "candidate 이외의 모든 원소가 candidate 이하"(동률 허용, 엄격 부등호만 거부)와 동치다.
// candidate(=right바 전 값) 조회는 별도 순환 버퍼를 새로 두지 않고 ExtremeState의 raw backing
// buffer(state.buffer — tie-break 방향이 있는 deque가 아니라 push된 원값을 위치 그대로 순환 저장할
// 뿐이라 동률과 무관하게 안전)를 offset=right로 직접 인덱싱해 재사용한다: highest()/lowest() 호출
// 직후 writeIdx는 방금 쓴 값의 "다음" 슬롯을 가리키므로, right바 전 값은
// buffer[(writeIdx-1-right) mod length]에 있다. windowMax가 non-NaN이면(nanCount===0) 그 창 전체가
// 실측값이므로 candidate도 항상 non-NaN — 별도 NaN 체크 불필요. scratch/probe_pivot.mjs로
// tie/창NaN/left=0/right=0(지연 없음)/5,000샘플 퍼즈(5개 (left,right) 조합) 전부 대조 완료.
export function pivothigh(state: PivotState, source: number, left: number, right: number): number {
  // C569: left/right int 복원(상세는 sma() 주석 참조) — highest()도 length를 자체 trunc하지만
  // 여기 아래의 idx 계산(% length)이 별도로 untruncated length를 쓰면 둘이 어긋나므로 이 함수
  // 자신의 스코프에서도 먼저 truncate해 length 파생값 전체를 일관되게 정수로 고정한다.
  left = Math.trunc(left);
  right = Math.trunc(right);
  if (state.extreme === undefined) {
    state.extreme = {};
  }
  const length = left + right + 1;
  const windowMax = highest(state.extreme, source, length);
  if (Number.isNaN(windowMax)) return NaN;
  const idx = (((state.extreme.writeIdx! - 1 - right) % length) + length) % length;
  const candidate = state.extreme.buffer![idx]!;
  return windowMax === candidate ? candidate : NaN;
}

export function pivotlow(state: PivotState, source: number, left: number, right: number): number {
  left = Math.trunc(left); // C569: left/right int 복원(상세는 pivothigh() 주석 참조)
  right = Math.trunc(right);
  if (state.extreme === undefined) {
    state.extreme = {};
  }
  const length = left + right + 1;
  const windowMin = lowest(state.extreme, source, length);
  if (Number.isNaN(windowMin)) return NaN;
  const idx = (((state.extreme.writeIdx! - 1 - right) % length) + length) % length;
  const candidate = state.extreme.buffer![idx]!;
  return windowMin === candidate ? candidate : NaN;
}

export interface SupertrendState {
  atr?: AtrState;
  upper?: number;
  lower?: number;
  direction?: number;
  prevClose?: number;
}

// ta.supertrend(factor, atrPeriod) - Supertrend, the fourth multi-return TA (returnArity: 2,
// [supertrendValue, direction]) and the first non-3-arity use of the multi-return infra (C50/C51/C54
// were all arity 3) — confirms the infra generalizes to arbitrary arity with 0 analyzer/codegen
// changes, exactly as C51's next_hint predicted. pine2py wavealgo/ta/supertrend.py's incremental
// (context-present) branch: basicUpper/basicLower = hl2 ± factor*ATR(atrPeriod) (already-implemented
// rt.ta.atr, C53, reused via SupertrendState{atr:AtrState} - hma/stoch/tsi/kc "reuse an already-built
// TA" principle), then a band-hold/direction-flip state machine layered on top.
//
// Unlike kc/macd/tsi (which call every inner TA unconditionally every bar and let *that* TA's own
// top-of-function NaN gate handle skip logic, C49/C50/C54), supertrend has its *own* extra persistent
// fields beyond atr's internal state (upper/lower/direction/prevClose) - and pine2py's early return
// (`if math.isnan(atr_val): return (nan, 0)`) happens *before* even fetching/touching that state dict.
// So rt.ta.atr is still called unconditionally every bar (required for its own O(1) RMA warmup to
// advance), but supertrend's own state fields are left completely untouched whenever atrVal is NaN -
// obv's sixth NaN pattern (C55) applied to a multi-field state instead of a single scalar. A transient
// mid-stream NaN (embedded NaN in high/low/close after warmup) behaves the same way: that bar returns
// (NaN, 0) and the *next* valid bar resumes from the last-good upper/lower/direction/prevClose as if
// the gap bar never happened (scratch/probe_supertrend.mjs "NaN gaps" case).
//
// pine2py's `state.get("upper", basic_upper)` (and the analogous lower/direction/prev_close defaults)
// mean the *first* bar where atrVal is valid seeds prevUpper/prevLower with *that same bar's own*
// basicUpper/basicLower (not a sentinel), prevDir defaults to 1, and prevClose defaults to *that bar's
// own* close (not NaN or 0) - `state.upper === undefined` doubles as this "first valid bar" flag since
// pine2py's state dict is otherwise never touched before this point. Direction transition compares
// against prevUpper/prevLower (the *old* band, pre-this-bar), not the just-computed finalUpper/
// finalLower - swapping these silently changes flip timing (scratch/probe_supertrend.mjs cross-checked
// a literal line-by-line port of the python incremental branch against this design across sample10,
// a zigzag series engineered to force direction flips, individual/leading NaN gaps, atrPeriod=1,
// factor=0/negative, and 5,000-sample fuzz across 4 (factor,atrPeriod) pairs - all PASS).
//
// Pine syntax has no high/low/close parameters; codegen injects $.high.get(0)/$.low.get(0)/
// $.close.get(0)(current close)/$.close.get(1)(prevClose for the inner atr call) ahead of the two
// user args (factor, atrPeriod) - the same implicit-injection pattern as ta.atr/ta.kc, just with an
// extra current-close slot since supertrend's own direction logic needs both current and prior close.
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
  if (Number.isNaN(atrVal)) {
    scratch[0] = NaN;
    scratch[1] = 0;
    return;
  }
  const hl2 = (high + low) / 2;
  const basicUpper = hl2 + factor * atrVal;
  const basicLower = hl2 - factor * atrVal;

  let prevUpper: number;
  let prevLower: number;
  let prevDir: number;
  let prevCloseState: number;
  if (state.upper === undefined) {
    prevUpper = basicUpper;
    prevLower = basicLower;
    prevDir = 1;
    prevCloseState = close;
  } else {
    prevUpper = state.upper;
    prevLower = state.lower!;
    prevDir = state.direction!;
    prevCloseState = state.prevClose!;
  }

  const finalUpper = basicUpper < prevUpper || prevCloseState > prevUpper ? basicUpper : prevUpper;
  const finalLower = basicLower > prevLower || prevCloseState < prevLower ? basicLower : prevLower;

  let direction: number;
  if (prevDir === -1 && close > prevUpper) direction = 1;
  else if (prevDir === 1 && close < prevLower) direction = -1;
  else direction = prevDir;

  state.upper = finalUpper;
  state.lower = finalLower;
  state.direction = direction;
  state.prevClose = close;

  scratch[0] = direction === 1 ? finalLower : finalUpper;
  scratch[1] = direction;
}

export interface SarState {
  barIndex?: number;
  result?: number;
  maxMin?: number;
  acceleration?: number;
  isBelow?: boolean;
  prevHigh?: number;
  prevLow?: number;
  prevHigh2?: number;
  prevLow2?: number;
  prevClose?: number;
}

// ta.sar(start, inc, maxAf) - Parabolic SAR (Wilder). pine2py wavealgo/ta/sar.py's
// _sar_incremental() is a self-contained 9-field state machine (bar_index/result/max_min/
// acceleration/is_below/prev_high·low·close/prev_high2·low2) - unlike every other ta.* ported so
// far, it doesn't reuse any other already-built TA (no atr/ema/wma call inside), so this is a
// literal line-by-line port rather than a composition (hma/stoch/tsi/kc principle doesn't apply
// here). Any NaN among high/low/close returns NaN *without touching state at all* (obv's sixth
// NaN pattern, C55, applied here too - state.get_ta_state() itself doesn't mutate).
//
// bar_idx counts *successful* (non-NaN) calls only, starting at 0. The very first successful call
// only seeds prevHigh/prevLow/prevClose and returns NaN (result/maxMin/acceleration/isBelow stay
// at their untouched defaults) - a 2-bar delay before the first real value, unlike obv's "seed on
// first valid bar" (MEMORY.md). The *second* successful call (barIndex read as 1) both initializes
// the trend (isBelow/maxMin/result from close vs prevClose) *and* immediately re-runs the same
// "compute result, check reversal, clamp against prior extremes" block that every later bar runs -
// pine2py does not skip this recompute for the init bar, so a volatile first pair of bars can
// re-flip isBelow within the same call (confirmed possible via scratch/probe_sar.mjs case 2b - not
// unreachable dead code). This looks unusual but is pine2py's literal algorithm; this session had
// no WebSearch grant to cross-check TV's Script Reference/real chart values as the PROGRESS
// next_hint asked, so per that next_hint's own fallback ("포트 그대로 이식할 것 확신 없으면") this
// is a byte-for-byte port, not a divergence - scratch/probe_sar.mjs cross-checks a literalPort
// (snake_case, matching sar.py line order exactly) against this candidate across sample10, forced
// re-reversal on bar 1, mid-stream/leading NaN gaps, start/inc/maxAf degenerate values (0, and
// maxAf==start), and 5,000-sample fuzz across 4 (start,inc,maxAf) tuples - all PASS. Penetration
// clamp against prevHigh2/prevLow2 (the bar *before* the previous one) only applies once
// barIndex > 1, i.e. never on the bar that performs the trend init.
//
// Pine syntax takes only (start, inc, maxAf) - high/low/close are the implicit bar series
// (analyzer.ts TA_REGISTRY.sar comment), codegen injects $.high.get(0)/$.low.get(0)/$.close.get(0)
// ahead of the three user args. Unlike ta.atr/ta.supertrend, no $.close.get(1) injection is needed
// - sar tracks prevClose itself in state (it isn't calling another TA that needs it as a parameter).
export function sar(
  state: SarState,
  high: number,
  low: number,
  close: number,
  start: number,
  inc: number,
  maxAf: number,
): number {
  if (Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close)) return NaN;

  const barIndex = state.barIndex ?? 0;
  let result = state.result ?? NaN;
  let maxMin = state.maxMin ?? NaN;
  let acceleration = state.acceleration ?? NaN;
  let isBelow = state.isBelow ?? false;

  const prevHigh = state.prevHigh ?? NaN;
  const prevLow = state.prevLow ?? NaN;
  const prevHigh2 = state.prevHigh2 ?? NaN;
  const prevLow2 = state.prevLow2 ?? NaN;
  const prevClose = state.prevClose ?? NaN;

  let isFirstTrendBar = false;

  if (barIndex === 1) {
    if (close > prevClose) {
      isBelow = true;
      maxMin = high;
      result = prevLow;
    } else {
      isBelow = false;
      maxMin = low;
      result = prevHigh;
    }
    isFirstTrendBar = true;
    acceleration = start;
  }

  if (barIndex >= 1) {
    result = result + acceleration * (maxMin - result);

    if (isBelow) {
      if (result > low) {
        isFirstTrendBar = true;
        isBelow = false;
        result = Math.max(high, maxMin);
        maxMin = low;
        acceleration = start;
      }
    } else {
      if (result < high) {
        isFirstTrendBar = true;
        isBelow = true;
        result = Math.min(low, maxMin);
        maxMin = high;
        acceleration = start;
      }
    }

    if (!isFirstTrendBar) {
      if (isBelow) {
        if (high > maxMin) {
          maxMin = high;
          acceleration = Math.min(acceleration + inc, maxAf);
        }
      } else {
        if (low < maxMin) {
          maxMin = low;
          acceleration = Math.min(acceleration + inc, maxAf);
        }
      }
    }

    if (isBelow) {
      if (!Number.isNaN(prevLow)) result = Math.min(result, prevLow);
      if (barIndex > 1 && !Number.isNaN(prevLow2)) result = Math.min(result, prevLow2);
    } else {
      if (!Number.isNaN(prevHigh)) result = Math.max(result, prevHigh);
      if (barIndex > 1 && !Number.isNaN(prevHigh2)) result = Math.max(result, prevHigh2);
    }
  }

  state.barIndex = barIndex + 1;
  state.result = result;
  state.maxMin = maxMin;
  state.acceleration = acceleration;
  state.isBelow = isBelow;
  state.prevHigh2 = prevHigh;
  state.prevLow2 = prevLow;
  state.prevHigh = high;
  state.prevLow = low;
  state.prevClose = close;

  if (barIndex < 1) return NaN;
  return result;
}

export interface DmiState {
  callCount?: number;
  smoothTr?: number;
  smoothPlus?: number;
  smoothMinus?: number;
  adx?: RmaState;
}

// ta.dmi(diLength, adxSmoothing) - Directional Movement Index, returnArity:3 ([plusDi, minusDi,
// adx]). pine2py wavealgo/ta/dmi.py: +DI/-DI = 100*RMA(+DM/-DM, diLength)/RMA(TR, diLength) (its
// own single-value-seeded Wilder smoothing, NOT rt.ta.rma's SMA-seeded warmup - see below), ADX =
// RMA(|+DI--DI|/(+DI+-DI)*100, adxSmoothing).
//
// **data_len<diLength+1 gate (dmi.py L66-68) - re-verified this cycle, correcting the prior
// next_hint (C62)**: that hint claimed this gate is "a static condition on the whole dataset
// length" and therefore not a real per-bar warmup barrier. Directly reading pine2py's execution
// loop (wavealgo/runtime.py Runner.execute L148-157) shows `context.push_bar()` is called once per
// bar *before* the transpiled function runs, and `context.push_bar` (context.py L135-155) does
// `self.data.close.push(close)` - Series.push() appends to a plain Python list (series.py). A
// direct python run (Context() + 10x push_bar) confirms `len(ctx.data.close)` is exactly
// `bar_index+1` and grows every bar - **not** a fixed whole-run constant. So this gate genuinely
// blocks output until `bar_index >= diLength` (0-indexed), which for the realistic default
// diLength=14 is a *much* stronger constraint than the h/l/c/prevH/prevL/prevC NaN check below (that
// alone would only need bar_index>=1). Ported here as `state.callCount` - a plain per-callsite
// invocation counter - which is exactly equivalent to pine2py's growing `len(close)` *because* this
// callsite is guaranteed to execute exactly once per bar starting at bar 0 (same "no conditional
// stateful calls" architecture invariant every other ta.* already relies on, GOAL.md/analyzer
// conditionalForbidden) - verified byte-for-byte against dmi.py's literal `len(close)` growth via
// scratch/probe_dmi.mjs case 3 (gate opens at exactly bar_index===diLength for diLength in
// [1,2,3,5,9]). No $.close.length / total-bar-count plumbing needed - the counter alone suffices,
// and unlike a "check the whole dataset length upfront" read this stays true streaming O(1)/bar
// (GOAL.md "바당 히스토리 재계산 금지" - this isn't a recompute, just a monotonic counter).
//
// After the gate opens, any NaN among h/l/c/prevH/prevL/prevC returns the NaN triple *without*
// touching state at all (obv's sixth NaN pattern, C55) - note this NaN check runs *after* the gate,
// so the gate's own counter still advances even on NaN bars (matches pine2py: `data_len` is
// unconditional, the NaN check is a separate branch below it).
//
// The very first call that clears both gates seeds smoothTr/smoothPlus/smoothMinus from that bar's
// raw TR/+DM/-DM values (a *single-value* seed, not rt.ta.rma's length-bar SMA seed - dmi.py's Wilder
// smoothing here is its own inline recurrence, structurally distinct from rt.ta.rma's warmup) and
// returns the NaN triple without touching adx-related fields at all. Every call after that blends
// smoothTr/smoothPlus/smoothMinus with alpha=1/diLength (unconditionally - this happens even if the
// blended smoothTr comes out to exactly 0, checked *after* the blend/state-write, matching dmi.py
// L104-112's partial-state-update order: smoothTr/smoothPlus/smoothMinus/bar_count are already
// written by the time the str_val===0 early return fires, but adx_values/adx are not touched that
// bar - the same "gate splits which fields update" shape as ta.kc's basis/range gate, C54).
//
// dx (the per-bar ADX input) is only ever computed once smoothTr is confirmed nonzero, so it is
// always a finite number by the time it reaches the ADX step - never NaN. This means the ADX
// warmup (dmi.py L121-129: accumulate dx into a list until adxSmoothing values collected, seed with
// their plain average, then switch to alpha=1/adxSmoothing exponential blending) is *exactly*
// rt.ta.rma's own two-phase warmup (accumulate `length` values -> seed with sum/length -> alpha
// blend) applied to the dx sequence - confirmed by direct comparison in scratch/probe_dmi.mjs
// (tsi/macd/kc "reuse an already-built TA by composition" principle, C49/C50/C54): feeding dx into
// `rma(state.adx, dx, adxSmoothing)` on exactly the bars where dmi.py would have appended to its own
// adx_values list reproduces the identical seed-then-blend sequence with zero new logic, since rma's
// own "value is never NaN here" fast path never triggers its NaN early-return.
export function dmi(
  state: DmiState,
  high: number,
  low: number,
  close: number,
  prevHigh: number,
  prevLow: number,
  prevClose: number,
  diLength: number,
  adxSmoothing: number,
  scratch: Float64Array,
): void {
  state.callCount = (state.callCount ?? 0) + 1;
  if (state.callCount < diLength + 1) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }

  if (
    Number.isNaN(high) ||
    Number.isNaN(low) ||
    Number.isNaN(close) ||
    Number.isNaN(prevHigh) ||
    Number.isNaN(prevLow) ||
    Number.isNaN(prevClose)
  ) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }

  const trVal = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  const upMove = high - prevHigh;
  const downMove = prevLow - low;
  const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
  const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;

  if (state.smoothTr === undefined) {
    state.smoothTr = trVal;
    state.smoothPlus = plusDm;
    state.smoothMinus = minusDm;
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }

  const alpha = 1 / diLength;
  state.smoothTr = alpha * trVal + (1 - alpha) * state.smoothTr;
  state.smoothPlus = alpha * plusDm + (1 - alpha) * state.smoothPlus!;
  state.smoothMinus = alpha * minusDm + (1 - alpha) * state.smoothMinus!;

  const strVal = state.smoothTr;
  if (strVal === 0) {
    scratch[0] = NaN;
    scratch[1] = NaN;
    scratch[2] = NaN;
    return;
  }

  const plusDi = (100 * state.smoothPlus!) / strVal;
  const minusDi = (100 * state.smoothMinus!) / strVal;
  const diSum = plusDi + minusDi;
  const dx = diSum > 0 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0;

  if (state.adx === undefined) state.adx = {};
  const adxVal = rma(state.adx, dx, adxSmoothing);

  scratch[0] = plusDi;
  scratch[1] = minusDi;
  scratch[2] = adxVal;
}

export interface SumState {
  buffer?: number[];
  writeIdx?: number;
  sum?: number;
}

// math.sum(source, length) - 고정폭 순환 버퍼(NaN 프라임), sma와 달리 오염(poison) 없음.
// pine2py wavealgo/math.sum(source, length)의 실제(Series 인자일 때만 도달하는) 분기
// `total=0.0; for v in source[0:min(length,len)]: if not isnan(v): total += v`와 동치 —
// na는 항상 기여 0(창이 전부 na이거나 아직 안 채워졌어도 결과는 na가 아니라 0.0). NaN-프라임
// 버퍼의 초기 슬롯(아직 안 쓰인 자리)도 값이 NaN이라 자연히 기여 0이 되므로
// min(length, 지금까지 처리한 바 수)를 별도로 추적할 필요가 없다(sma의 nanCount/전체 재스캔
// 포이즌 감지 로직 자체가 불필요 — 매 호출 O(1), 재스캔 없음).
// **의도적 divergence**(analyzer.ts TA_REGISTRY.sum 주석 + DIVERGENCES.md #15 참조): pine2py
// math.sum은 source가 실제 Series 객체(bare open/high/low/close/volume 등)일 때만 이 윈도우
// 로직을 타고, 계산된 변수(스칼라)면 `builtins.sum((source, length))`로 폴백해 `source+length`를
// 반환하는 별개의(잘못된) 값을 낸다 — pine2js는 모든 인자가 애초에 스칼라라 이 구분 자체가 없고
// 항상 올바른 윈도우 합계를 계산한다(TV 실제 시맨틱과 일치, latent pine2py 버그는 미추종).
export function sum(state: SumState, value: number, length: number): number {
  length = Math.trunc(length); // C569: length int 복원(상세는 sma() 주석 참조)
  if (state.buffer === undefined) {
    state.buffer = new Array(length).fill(NaN);
    state.writeIdx = 0;
    state.sum = 0;
  }
  const buffer = state.buffer;
  const writeIdx = state.writeIdx!;
  const oldVal = buffer[writeIdx]!;
  buffer[writeIdx] = value;
  state.writeIdx = (writeIdx + 1) % length;
  state.sum = state.sum! - (Number.isNaN(oldVal) ? 0 : oldVal) + (Number.isNaN(value) ? 0 : value);
  return state.sum;
}

export interface RandomState {
  state?: number; // xorshift32 32bit 상태 (0이면 무효 — mixSeed가 0을 1로 승격해 항상 보장)
}

// xorshift32 — Marsaglia 표준 3-shift 변형. 32bit 부호 없는 산술 유지를 위해 매 단계 `>>> 0`.
function xorshift32(x: number): number {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

// SplitMix32 스타일 믹싱 — 임의 float seed(음수/소수/큰 값 포함)를 잘 분산된 32bit 상태로 접는다.
// xorshift는 low-order 상관관계에 약해 seed를 그대로 초기 상태로 쓰면 안 됨(표준 관행).
function mixSeed(seed: number): number {
  let h = (Math.trunc(seed) | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  h = h >>> 0;
  return h === 0 ? 1 : h; // xorshift는 0 상태에서 영원히 0만 냄 — 0 도달 시 1로 승격
}

// math.random(min=0, max=1, seed) — analyzer.ts TA_REGISTRY.random 주석 참조: pine2py는 Python
// 표준 random(전역 Mersenne Twister)에 위임해 bit-parity 오라클 이식이 구조적으로 불가능한 첫
// TA류 함수(alma의 sigma=0처럼 경계 하나가 아니라 값 도메인 전체) — pine2js는 콜사이트별 독립
// xorshift32를 자체 채택했다(값 자체는 오라클/hand-verified 비교 대상 아님, LIMITATIONS.md).
// seed가 na가 아니면 매 호출 그 값으로 상태를 재시드해 "같은 seed → 같은 값" 재현성을 보장하고,
// seed가 한 번도 안 주어졌으면 site(콜사이트 slot, codegen이 숨은 4번째 인자로 주입)로 1회만
// 시드해 콜사이트마다 다른 결정론적 시퀀스를 이어간다(진짜 엔트로피 없음 — GOAL.md 백테스트
// 재현성과 일관). min/max가 na면 별도 가드 없이 `min + unit*(max-min)` 산술 자체가 na를 자연
// 전파한다(GOAL.md 산술 연산자 na 전파, CONFIRMED — VERIFIED_SEMANTICS.md).
export function random(
  state: RandomState,
  min: number = 0,
  max: number = 1,
  seed: number = NaN,
  site: number = 0,
): number {
  if (!Number.isNaN(seed)) {
    state.state = mixSeed(seed);
  } else if (state.state === undefined) {
    state.state = mixSeed(site);
  }
  state.state = xorshift32(state.state!);
  const unit = state.state / 4294967296; // [0, 1)
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
    runtimeError(`ta.pivot_point_levels: developing=true는 '${type}' 타입에서 지원되지 않음`);
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
