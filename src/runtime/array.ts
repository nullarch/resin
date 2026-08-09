// PineScript array.* 네임스페이스 — pine2py wavealgo/builtins/array.py의 JS 이식(C79:
// new_float/get/set/push/pop/size, C80: first/last/shift/unshift/insert/remove/clear/fill,
// C81: sum/avg/min/max/median/mode/stdev/variance, C82: includes/indexof/lastindexof,
// C83: covariance/percentile_nearest_rank/percentile_linear_interpolation/percentrank/standardize,
// C84: new_int/new_bool/new_string/new_color/from, C85: sort/reverse/slice/concat/copy,
// C86: abs/every/some/range/binary_search·leftmost·rightmost/sort_indices.
// 잔여 항목은 ROADMAP array.* 항목 참조).
//
// Pine의 array는 진짜 참조 타입이다: 값은 JS 배열 객체 그 자체이고, var 슬롯($.vars)/UDF 인자
// 전달은 참조를 그대로 담고/넘긴다(pine2py도 Python list 참조를 그대로 다룸 — 뮤테이션이
// 호출자에게 보이는 시맨틱까지 동형). na는 참조형 규약대로 null(GOAL.md na 3분할).
//
// GOAL.md "bar loop 안 할당 제로"는 런타임 내부 인프라(TA 상태/스크래치)에 대한 원칙이다 —
// new_float가 사용자 Pine 코드의 의미론적 요구(매 바 새 배열)로 할당하는 것은 TV 자체의
// 시맨틱이라 예외이며, 런타임이 몰래 추가 할당을 하지 않는 것으로 원칙을 지킨다.
//
// na 처리(python 실측, C79):
// - pop은 pine2py가 `arr.pop() if arr else nan`으로 None(na)/빈 배열 둘 다 falsy 가드에
//   걸려 nan을 반환하는 **정의된 동작**이라 literal port.
// - get/set/push/size는 None 인자에서 가드 없이 크래시(TypeError/AttributeError)하는 미정의
//   동작(str.*/color.*의 C76~C78과 동일 사정) — GOAL.md na 안전성 원칙에 따라 "읽기(get/size)는
//   na(NaN) 반환, 쓰기(set/push)는 no-op"으로 새로 결정(DIVERGENCES.md #19).
// - new_float의 size가 na(NaN)면 pine2py `[v]*nan`이 TypeError 크래시 — na(null) 배열 전파로
//   새로 결정. 비정수 size/index도 Python이 TypeError 크래시하는 미정의 동작이라 Math.trunc로
//   결정(MEMORY.md Pitfalls "array index는 Math.trunc 필수" 규약 재사용, DIVERGENCES.md #19).
// - NaN 인덱스의 get/set은 pine2py 체인 비교(`0 <= nan < len`)가 False라 크래시 없이
//   get→nan/set→no-op — JS도 `Math.trunc(NaN)=NaN`이 아래 범위 비교에서 자연히 false가 되어
//   동일 경로로 literal port(별도 분기 불필요).

import { pyFloatStr } from "./str";

export type PineArray = number[];

// array.new_float(size=0, initial_value=na) — Python `[initial_value]*size`와 동치.
// size<=0은 Python이 빈 리스트를 주는 정의된 동작이라 literal port([]).
export function new_float(size: number = 0, initialValue: number = NaN): PineArray | null {
  if (Number.isNaN(size)) return null;
  const n = Math.trunc(size);
  if (n <= 0) return [];
  return new Array<number>(n).fill(initialValue);
}

// array.get(id, index) — 범위 밖은 pine2py 가드 그대로 nan(literal port).
export function get(arr: PineArray | null, index: number): number {
  if (arr === null) return NaN;
  const i = Math.trunc(index);
  if (i >= 0 && i < arr.length) return arr[i]!;
  return NaN;
}

// array.set(id, index, value) — 범위 밖은 pine2py 가드 그대로 조용히 no-op(literal port).
export function set(arr: PineArray | null, index: number, value: number): void {
  if (arr === null) return;
  const i = Math.trunc(index);
  if (i >= 0 && i < arr.length) arr[i] = value;
}

// array.push(id, value) — 끝에 추가(in-place 뮤테이션).
export function push(arr: PineArray | null, value: number): void {
  if (arr === null) return;
  arr.push(value);
}

// array.pop(id) — 마지막 제거 & 반환. null/빈 배열 → nan은 pine2py `if arr` falsy 가드의
// literal port(둘 다 정의된 동작 — na 신규 결정이 아님).
export function pop(arr: PineArray | null): number {
  if (arr === null || arr.length === 0) return NaN;
  return arr.pop()!;
}

// array.size(id) — 원소 개수.
export function size(arr: PineArray | null): number {
  if (arr === null) return NaN;
  return arr.length;
}

// ── C80 잔여 슬라이스: first/last/shift/unshift/insert/remove/clear/fill ──
// na 처리(python 실측, C80):
// - first/last/shift는 pine2py `arr[0]/arr[-1]/arr.pop(0) if arr else nan`으로 pop과 동일한
//   falsy 가드(None/빈 배열 둘 다 nan) — literal port(na 신규 결정 아님).
// - unshift/insert/remove/clear/fill은 pine2py가 배열 인자에 가드가 없어 None에서 크래시(미정의
//   동작) — get/set/push(C79, DIVERGENCES #19)와 동일하게 "쓰기는 no-op"으로 결정(#19 확장).
//   remove만 "읽기+쓰기" 성격이지만 반환값도 있는 pine2py `if 0<=index<len(arr)` 명시적 범위
//   가드(get과 동일 패턴)라 na 배열은 자연히 이 가드가 커버(literal port).
// - insert의 index가 na(NaN)면 Python list.insert가 TypeError로 크래시(미정의) — JS
//   Array.splice(NaN,...)이 조용히 index=0으로 치환해버리는 걸 막기 위해 명시적으로 no-op
//   (DIVERGENCES #20 신규, "쓰기 no-op" 원칙 재적용). 유효 정수 index는 Python list.insert와 JS
//   Array.splice의 클램프 동작(범위 밖/음수/음수 초과 전부)이 완전히 동일함을 node/python 교차
//   대조로 확인(literal port) — remove도 get과 동일한 명시적 범위 가드라 NaN이 자연히 그 가드로
//   떨어진다(별도 분기 불필요).
// - fill의 index_from/index_to가 na(NaN)면 Python range()가 TypeError로 크래시(미정의) — 위와
//   동일하게 "쓰기 no-op"으로 결정. index_from이 -배열길이보다 더 음수면 pine2py 자체가
//   IndexError로 크래시하는 latent 버그(python 실측: fill([1..5],v,-10) 크래시) — TV 실제
//   시맨틱(index_from은 [0,size) 범위가 문서화된 계약)을 따라 0으로 클램프하는 안전한 값으로 새로
//   결정(DIVERGENCES #20, "pine2py의 알려진 버그는 따르지 않는다").

// array.first(id) — 첫 원소. pop과 동일한 falsy 가드(null/빈 배열 → nan) literal port.
export function first(arr: PineArray | null): number {
  if (arr === null || arr.length === 0) return NaN;
  return arr[0]!;
}

// array.last(id) — 마지막 원소. first와 동일한 falsy 가드 literal port.
export function last(arr: PineArray | null): number {
  if (arr === null || arr.length === 0) return NaN;
  return arr[arr.length - 1]!;
}

// array.shift(id) — 첫 원소 제거 & 반환(in-place). pop과 동일한 falsy 가드 literal port.
export function shift(arr: PineArray | null): number {
  if (arr === null || arr.length === 0) return NaN;
  return arr.shift()!;
}

// array.unshift(id, value) — 앞에 추가(in-place). null 배열은 크래시하는 미정의 동작이라 no-op.
export function unshift(arr: PineArray | null, value: number): void {
  if (arr === null) return;
  arr.unshift(value);
}

// array.insert(id, index, value) — 지정 위치 삽입(in-place). null 배열/na 인덱스는 no-op.
export function insert(arr: PineArray | null, index: number, value: number): void {
  if (arr === null || Number.isNaN(index)) return;
  arr.splice(Math.trunc(index), 0, value);
}

// array.remove(id, index) — 지정 위치 제거 & 반환. get과 동일한 명시적 범위 가드 literal port.
export function remove(arr: PineArray | null, index: number): number {
  if (arr === null) return NaN;
  const i = Math.trunc(index);
  if (i >= 0 && i < arr.length) return arr.splice(i, 1)[0]!;
  return NaN;
}

// array.clear(id) — 전부 제거(in-place). null 배열은 크래시하는 미정의 동작이라 no-op.
export function clear(arr: PineArray | null): void {
  if (arr === null) return;
  arr.length = 0;
}

// array.fill(id, value, index_from=0, index_to=-1) — 범위 채우기(in-place). null 배열/na
// index_from·index_to는 no-op. index_to<0(기본값 포함)은 배열 길이로 literal port. index_from이
// 음수면 pine2py 자체가 크래시하는 latent 버그라 0으로 클램프(DIVERGENCES #20).
export function fill(arr: PineArray | null, value: number, indexFrom: number = 0, indexTo: number = -1): void {
  if (arr === null || Number.isNaN(indexFrom) || Number.isNaN(indexTo)) return;
  let to = Math.trunc(indexTo);
  if (to < 0) to = arr.length;
  const from = Math.max(0, Math.trunc(indexFrom));
  const end = Math.min(to, arr.length);
  for (let i = from; i < end; i++) arr[i] = value;
}

// ── C81 통계류: sum/avg/min/max/median/mode/stdev/variance ──
// pine2py array.py L200-256 전부 `_valid_nums`(NaN 원소 스킵) 공통 원칙 위에서 갈라진다 — 상태
// 없는 순수 읽기(뮤테이션 없음)라 C79/80과 동일하게 MUTATING_ARRAY_BUILTINS 등재 불필요. null
// 배열은 get/size(C79, DIVERGENCES #19)와 동일한 "읽기는 na(NaN)" 원칙 확장(새 divergence
// 아님 — #19가 이미 세운 "읽기 vs 쓰기" 이분을 이 8종에 그대로 재적용).
function validNums(arr: PineArray): number[] {
  return arr.filter((v) => v === v);
}

// array.sum(id) — 유효 원소 합계. pine2py `builtins.sum(_valid_nums(arr))`는 빈 리스트에서도
// 0.0을 주는 정의된 동작이라 유효값 0개(전부 na 또는 빈 배열)도 na가 아니라 0(avg/min/max와
// 다른 지점 — literal port).
export function sum(arr: PineArray | null): number {
  if (arr === null) return NaN;
  let total = 0;
  for (const v of arr) if (v === v) total += v;
  return total;
}

// array.avg(id) — 유효 원소 평균. 유효값 0개면 na(math.avg C74와 동일한 na-skip 원칙).
export function avg(arr: PineArray | null): number {
  if (arr === null) return NaN;
  let total = 0;
  let count = 0;
  for (const v of arr) {
    if (v === v) {
      total += v;
      count++;
    }
  }
  return count === 0 ? NaN : total / count;
}

// array.min/array.max(id[, nth]) — 유효 원소 최소/최대값. 유효값 0개면 na. nth(C297, TV 공식
// 선택 인자 -- pine2py array.py는 min(arr)/max(arr) 고정 1-positional이라 오라클 구조적 불가,
// hand-verified 설계, DIVERGENCES #111)는 "n번째로 작은/큰 값"을 0-기반으로 센다(기본 0 =
// 최솟값/최댓값 그 자체, 1 = 두 번째로 작은/큰 값, ...) -- wild 소스 주석 실측(`array.max(arr, 1)`
// = "second highest value")과 일치. 범위 밖 nth(음수 또는 유효 원소 개수 이상)는 na.
// nth===0(기본, 인자 생략)이 압도적 다수 실사용(TV array.max(id)/array.min(id) 단일 인자 폼)이라
// 그 경로만 O(n) 단일 스캔으로 처리 — sort()는 nth!==0(n번째 값 조회)일 때만 필요(C586, wild
// 실측: for-loop 안에서 매 바/매 반복 array.max(id)를 호출하는 관용구가 O(n) 배열에 O(n log n)
// sort+할당을 반복시켜 5000바 실데이터에서만 timeout 발현 — 500바 합성에선 안 드러남).
export function min(arr: PineArray | null, nth: number = 0): number {
  if (arr === null) return NaN;
  const idx = Math.trunc(nth);
  if (idx === 0) {
    let best = Infinity;
    let found = false;
    for (const v of arr) {
      if (v === v) {
        found = true;
        if (v < best) best = v;
      }
    }
    return found ? best : NaN;
  }
  const vals = validNums(arr).sort((a, b) => a - b);
  if (idx < 0 || idx >= vals.length) return NaN;
  return vals[idx]!;
}

export function max(arr: PineArray | null, nth: number = 0): number {
  if (arr === null) return NaN;
  const idx = Math.trunc(nth);
  if (idx === 0) {
    let best = -Infinity;
    let found = false;
    for (const v of arr) {
      if (v === v) {
        found = true;
        if (v > best) best = v;
      }
    }
    return found ? best : NaN;
  }
  const vals = validNums(arr).sort((a, b) => b - a);
  if (idx < 0 || idx >= vals.length) return NaN;
  return vals[idx]!;
}

// array.median(id) — 유효 원소 정렬 후 중앙값(짝수 개면 가운데 두 값 평균) — Python
// `statistics.median(sorted(vals))`와 동치. 유효값 0개면 na.
export function median(arr: PineArray | null): number {
  if (arr === null) return NaN;
  const vals = validNums(arr).sort((a, b) => a - b);
  if (vals.length === 0) return NaN;
  const mid = vals.length >> 1;
  if (vals.length % 2 === 1) return vals[mid]!;
  return (vals[mid - 1]! + vals[mid]!) / 2;
}

// array.mode(id) — 최빈값. Python `statistics.mode`(3.8+)는 Counter(원본 등장 순서 보존) +
// most_common(1)(동률 시 첫 등장값 승, sorted()의 안정 정렬과 동치)로 "동률이면 최초 등장값"이라
// vals(정렬 안 함, 원본 순서)를 그대로 순회하며 등장 순서를 보존하는 Map으로 이식(strict `>`
// 비교라 이후 동률이 먼저 채워진 값을 덮어쓰지 않음). 유효값 0개면 na.
export function mode(arr: PineArray | null): number {
  if (arr === null) return NaN;
  const vals = validNums(arr);
  if (vals.length === 0) return NaN;
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  let bestVal = NaN;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      bestVal = v;
    }
  }
  return bestVal;
}

// array.variance(id) — 모집단 분산. 두 패스 직접 계산(Σ(v-mean)²/n) — 배열 통계는 바 루프
// incremental 상태가 아니라 호출마다 스냅샷 전체를 새로 훑는 stateless 연산이라, ta.variance
// (C36)처럼 O(1) 유지를 위해 E[X²]-(E[X])² 항등식을 쓸 이유가 없다. 각 항이 제곱이라 음수
// 캔슬레이션 자체가 불가능해(C36 클램프 불필요) 오히려 더 정확하다. 유효값 2개 미만이면 na.
export function variance(arr: PineArray | null): number {
  if (arr === null) return NaN;
  const vals = validNums(arr);
  if (vals.length < 2) return NaN;
  let total = 0;
  for (const v of vals) total += v;
  const mean = total / vals.length;
  let sq = 0;
  for (const v of vals) sq += (v - mean) * (v - mean);
  return sq / vals.length;
}

// array.stdev(id) — 모집단 표준편차 = sqrt(variance). variance가 이미 null/na-count 가드를
// 전부 처리해 NaN을 반환하므로 그 위에 sqrt만 씌우면 그대로 na 전파(C36 stdev-calls-variance와
// 동일한 "반환식만 다른 alias 불가 케이스"의 내부 함수 재사용 원칙).
export function stdev(arr: PineArray | null): number {
  return Math.sqrt(variance(arr));
}

// ── C82 검색: includes/indexof/lastindexof ──
// pine2py array.py L134-154: includes는 `value in arr`, indexof는 `arr.index(value)`(미발견 시
// -1), lastindexof는 역방향 순회 + `==`. 셋 다 순수 읽기(뮤테이션 없음) — null 배열은 get/size
// (#19)와 동일한 "읽기는 na(NaN)" 원칙(includes도 bool 반환이지만 str.contains류(C76)처럼
// numeric-na로 통일).
//
// **NaN 검색값의 divergence(#22, python/node 교차 실측)**: Python `in`/`.index()`는 "identity
// 우선, 그 다음 `==`" 순서로 비교한다(CPython list.__contains__/list.index 공통 구현) — 새
// `float('nan')`끼리는 `==`가 항상 False라 못 찾지만, **배열에서 그대로 읽어온 것과 동일한 객체
// 참조**(예: `array.includes(arr, array.get(arr,0))`)를 검색값으로 넘기면 identity가 매치돼
// 찾아진다(python으로 `nan in [nan_같은_객체]`→True, `float('nan') in [...]`→False 직접 확인).
// JS 숫자는 프리미티브라 이런 "동일 객체 재사용" 개념 자체가 없다 — `Array.prototype.includes`는
// SameValueZero라 NaN을 항상 찾고(모든 NaN이 무조건 매치), `indexOf`/`lastIndexOf`는 strict
// equality라 NaN을 항상 못 찾는다(node 실측). Python의 identity 예외는 CPython 객체 모델의
// 구현 디테일이지 PineScript가 의도한 na 시맨틱이 아니라고 판단(GOAL.md "pine2py의 알려진
// 버그는 따르지 않는다"에 준하는 근거 — 이 저장소의 na 비교 관례(DIVERGENCES #4류: 일반 `==`은
// na를 찾지 못한다)와도 일관됨) — includes를 strict equality 기반으로 구현해 NaN이 항상
// "못 찾음"으로 수렴하도록 결정(indexOf/lastIndexOf는 이미 strict equality라 그대로 매핑,
// includes만 SameValueZero를 우회하는 커스텀 구현 필요).
export function includes(arr: PineArray | null, value: number): boolean | number {
  if (arr === null) return NaN;
  return arr.indexOf(value) !== -1;
}

// array.indexof(id, value) — 미발견 시 -1(NaN 아님, pine2py `except ValueError: return -1`
// literal port). JS Array.indexOf가 이미 strict equality라 그대로 매핑.
export function indexof(arr: PineArray | null, value: number): number {
  if (arr === null) return NaN;
  return arr.indexOf(value);
}

// array.lastindexof(id, value) — 마지막 일치 인덱스, 미발견 시 -1. JS Array.lastIndexOf도
// strict equality라 그대로 매핑.
export function lastindexof(arr: PineArray | null, value: number): number {
  if (arr === null) return NaN;
  return arr.lastIndexOf(value);
}

// ── C83: covariance/percentile_nearest_rank/percentile_linear_interpolation/percentrank/
// standardize (pine2py array.py L314-370) ──
// null 배열은 sum/avg류(C81, DIVERGENCES #21)와 동일한 "읽기는 na" 원칙 재적용 — 단
// standardize만 참조형(배열) 반환이라 na가 NaN이 아니라 null(GOAL.md na 3분할, get(C79)의
// "읽기 na"를 참조형 반환에 적용한 첫 사례).
//
// **percentage 클램프의 NaN 함정(python 직접 실행으로 확정)**: pine2py는
// `max(0.0, min(100.0, percentage))`로 클램프하는데, Python 내장 min(100.0, percentage)은
// "첫 인자를 기본값으로 두고 두 번째가 그보다 작을 때만 교체"하는 구현이라 percentage가 NaN이면
// `NaN < 100.0`이 False라 100.0이 그대로 살아남는다(교체가 안 일어남) — 즉 pine2py는
// percentile_nearest_rank(arr, na)를 크래시도 NaN 전파도 아니라 **100%로 조용히 클램프**한다
// (python 실측: percentile_nearest_rank([1..5], nan) == 5.0). 이건 인자 순서에 따라 결과가
// 달라지는 rt.max/min(C13)의 "순서-의존" 버그와 달라서(percentage는 항상 같은 위치에 고정) 그
// 버그 판정 기준에 해당하지 않는다고 판단 — TV 실제 시맨틱을 확인할 WebSearch 권한이 없는 이
// 세션에서는 MEMORY.md Pitfalls의 폴백 원칙(확신 없으면 pine2py 문자 그대로 포트)을 적용해
// literal port. 단 **Math.min/Math.max로 그대로 옮기면 안 된다** — JS Math.min/max는 NaN이
// 섞이면 무조건 NaN을 반환해(Python min/max와 반대 방향 함정) clampPercentage가 100 대신 NaN을
// 내놓는 조용한 오답이 된다. 대신 Python의 원시 비교 흐름(대입 후 `<`/`>` 조건부 교체)을 그대로
// 재현하면 JS `NaN < 100`도 False이므로 자연히 100이 살아남는다(node 교차 실측으로 python과
// 바이트 단위 일치 확인 완료 — scratch/probe_array_stats2.mjs).
function clampPercentage(percentage: number): number {
  let minResult = 100;
  if (percentage < 100) minResult = percentage;
  let maxResult = 0;
  if (minResult > 0) maxResult = minResult;
  return maxResult;
}

// array.percentile_nearest_rank(id, percentage) — 가장 가까운 순위 백분위(보간 없음).
export function percentile_nearest_rank(arr: PineArray | null, percentage: number): number {
  if (arr === null) return NaN;
  const vals = validNums(arr).sort((a, b) => a - b);
  if (vals.length === 0) return NaN;
  const p = clampPercentage(percentage);
  const idx = Math.max(0, Math.ceil((p / 100) * vals.length) - 1);
  return vals[idx]!;
}

// array.percentile_linear_interpolation(id, percentage) — 선형 보간 백분위.
export function percentile_linear_interpolation(arr: PineArray | null, percentage: number): number {
  if (arr === null) return NaN;
  const vals = validNums(arr).sort((a, b) => a - b);
  if (vals.length === 0) return NaN;
  if (vals.length === 1) return vals[0]!;
  const p = clampPercentage(percentage);
  const rank = (p / 100) * (vals.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.min(lower + 1, vals.length - 1);
  const frac = rank - lower;
  return vals[lower]! + frac * (vals[upper]! - vals[lower]!);
}

// array.percentrank(id, value) — value 미만인 유효 원소의 비율(%). value가 NaN이면 모든 `<`
// 비교가 False라(Python도 동일) 자연히 0.0 — 별도 가드 불필요(literal port).
export function percentrank(arr: PineArray | null, value: number): number {
  if (arr === null) return NaN;
  const vals = validNums(arr);
  if (vals.length === 0) return NaN;
  let countBelow = 0;
  for (const v of vals) if (v < value) countBelow++;
  return (countBelow / vals.length) * 100;
}

// array.standardize(id) — Z-score 정규화, **새 배열을 반환**(지금까지의 통계류 8종(C81)과 달리
// 첫 array-returning read — ARRAY_CONSTRUCTOR_METHODS에 등재해 `var x = array.standardize(...)`가
// array var로 추적되도록 함, analyzer.ts 참조). 유효값 2개 미만이면 pine2py `return arr[:]`(원본
// 그대로, na 포함) literal port. sd===0(전부 동일값)이면 pine2py 고유 분기로 원소 전부 1.0(길이는
// vals가 아니라 **arr** 전체 길이). 그 외엔 mean/sd를 array.avg/array.stdev(C81)로 재사용해
// 원소별 z-score, 원본이 na인 자리는 na 유지(bb가 variance를 재사용하는 것과 동일한 "반환값 재사용"
// 원칙 — mean=avg(arr)와 sd=stdev(arr) 둘 다 이미 validNums 위에서 계산되므로 vals와 별개로 다시
// 구할 필요 없음).
export function standardize(arr: PineArray | null): PineArray | null {
  if (arr === null) return null;
  const vals = validNums(arr);
  if (vals.length < 2) return arr.slice();
  const m = avg(arr);
  const sd = stdev(arr);
  if (sd === 0) return new Array<number>(arr.length).fill(1.0);
  return arr.map((x) => (x === x ? (x - m) / sd : NaN));
}

// ── C84: new_int/new_bool/new_string/new_color/from — 원소 타입별 생성자 4종 + 가변인자
// 생성자 1종 (pine2py array.py L32-54 소스 대조) ──
// new_int/new_bool/new_string/new_color는 pine2py `[initial_value]*size` 몸통이 new_float(C79)와
// 완전히 동일하고 기본값/원소 타입만 다르다 — size가 na(NaN)면 크래시(미정의) -> na(null) 전파,
// 비정수 size는 Math.trunc, size<=0은 빈 배열(literal port) — 전부 new_float가 이미 결정한 것의
// 재적용(DIVERGENCES.md #19, 새 하위 결정 없음). initial_value 자체가 na여도(예: new_int(3, na))
// pine2py `[v]*size`는 v의 값과 무관하게 크래시하지 않으므로 그대로 채워 넣는다(가드 불필요).
// PineArray(number[])는 new_float/new_int 공용 — new_bool/new_string/new_color는 원소 타입이
// 달라 각각 boolean[]/string[]로 별도 반환 타입을 쓴다(JS는 런타임에 완전히 동적 타입이라
// array.get/set/size 등 기존 공용 접근자는 타입 파라미터 변경 없이도 이 배열들을 그대로 다룰 수
// 있음 — TS 시그니처가 number로 좁아 보이는 건 `new Function`으로 실행되는 생성 코드가 TS
// 검사를 받지 않기 때문, ROADMAP array.* 잔여 목록 참조). color는 색상값이 hex 문자열(C78
// rt.color.rgb/new/from_gradient와 동일 표현)이라 string[]과 같은 타입.
export function new_int(size: number = 0, initialValue: number = 0): number[] | null {
  if (Number.isNaN(size)) return null;
  const n = Math.trunc(size);
  if (n <= 0) return [];
  return new Array<number>(n).fill(initialValue);
}

export function new_bool(size: number = 0, initialValue: boolean = false): boolean[] | null {
  if (Number.isNaN(size)) return null;
  const n = Math.trunc(size);
  if (n <= 0) return [];
  return new Array<boolean>(n).fill(initialValue);
}

export function new_string(size: number = 0, initialValue: string = ""): string[] | null {
  if (Number.isNaN(size)) return null;
  const n = Math.trunc(size);
  if (n <= 0) return [];
  return new Array<string>(n).fill(initialValue);
}

export function new_color(size: number = 0, initialValue: string = ""): string[] | null {
  if (Number.isNaN(size)) return null;
  const n = Math.trunc(size);
  if (n <= 0) return [];
  return new Array<string>(n).fill(initialValue);
}

// array.new<T>(size, initial_value) — T가 5종 원시 타입 밖(사용자 UDT 타입명 또는 label/
// chart.point 같은 built-in 특수 타입)일 때의 무타입 단일 생성자(C230, parser.ts
// isArrayNewGenericTypeArg가 attr을 'new_generic'으로 재작성 — corpus 4건 실측: label/Level/
// Entry/chart.point, 전부 size=0 빈 배열). pine2py는 이 경우도 T와 무관하게 정확히 같은 무타입
// 단일 생성자(wa.builtins.array.new)로 라우팅하지만, 그 함수의 initial_value 기본값은 Python이
// "타입 무관 정수 0"을 채우는 관행일 뿐(python 직접 실행으로 확인: array.new<float>(3)조차 no-op
// 정수 0 리스트를 낸다 — pine2py 자신의 타입 무시 라우팅 특성) — 참조형 슬롯에 정수를 두는 것은
// GOAL.md na 3분할(참조형 na=null) 위반이라 literal port 대상이 아니다(corpus 4건 전부 size=0이라
// 이 기본값 차이 자체는 오라클로 검증 불가 — DIVERGENCES.md 신규 등재). 참조형 안전 원칙대로
// default를 null(na)로 결정. size=na(NaN)는 new_float와 동일하게 null 배열 전파.
export function new_generic(size: number = 0, initialValue: unknown = null): unknown[] | null {
  if (Number.isNaN(size)) return null;
  const n = Math.trunc(size);
  if (n <= 0) return [];
  return new Array(n).fill(initialValue);
}

// array.new_label/new_line/new_box/new_table/new_linefill(size, initial_value) — v4식 명명
// typed 생성자(drawing 핸들 전용, C230 제네릭 `array.new<label>()` 등장 이전부터 있던 문법, corpus
// 5건 실측: label/line/box/table 각 1~2건). pine2py codegen.py는 5종 전부(linefill 포함) T와
// 무관하게 array.new<T>와 정확히 같은 무타입 단일 생성자 wa.builtins.array.new로 라우팅한다
// (L1497-1501) — 즉 이 함수들은 new_generic(C230)과 완전히 동일한 연산이라 별도 구현 없이 그대로
// alias. DIVERGENCES.md #94(참조형 슬롯 기본값 null vs pine2py 정수 0)도 동일하게 적용된다.
export const new_label = new_generic;
export const new_line = new_generic;
export const new_box = new_generic;
export const new_table = new_generic;
export const new_linefill = new_generic;

// array.from(...items) — 가변 인자로 배열 생성(pine2py 소스는 `from_items`라는 이름을 쓰는데,
// Python에서 `from`이 예약어라 못 쓴 것뿐 — TV 메서드명은 array.from, pine2py codegen 레지스트리도
// "array.from" -> "wa.builtins.array.from_items"로 매핑함을 확인). JS에서 "from"은 import/export
// 구문에서만 의미를 갖는 contextual keyword라 함수 식별자로 그대로 쓸 수 있다(color.new(C78)의
// "new"와 달리 rt.ts 프로퍼티 리매핑 불필요 — `import * as array`가 자동으로 rt.array.from을
// 노출). Python `list(args)`는 인자가 몇 개든(0개 포함) 크래시하지 않아 na 결정 자체가 없다.
export function from<T>(...items: T[]): T[] {
  return items;
}

// ── C85: sort/reverse/slice/concat/copy (pine2py array.py L159-195) ──
// sort/reverse는 in-place 뮤테이터(MUTATING_ARRAY_BUILTINS 등재), slice/concat/copy는 새 배열을
// 반환하는 constructor류(ARRAY_CONSTRUCTOR_METHODS 등재, standardize(C83)와 동일 원칙). 전부 null
// 배열에서 pine2py가 가드 없이 크래시(TypeError/AttributeError — python 실측)하는 미정의 동작 —
// sort/reverse는 "쓰기는 no-op"(#19/#20 확장), slice/concat/copy는 참조형 반환이라 "읽기는
// na(null)"을 standardize와 동일하게 적용.
//
// **sort의 order 인자**: pine2py `is_desc = not order if isinstance(order,bool) else order != "ascending"`는
// bool/문자열 두 타입을 받는 이중 분기지만, TV 표면 문법은 order.ascending/order.descending
// 상수만 허용한다(pine2py codegen.py IDENTIFIER_MAP: order.ascending->True, order.descending->
// False). pine2js는 이 이중성을 재현할 필요가 없어 시그니처를 boolean 하나로 단순화(ascending=true
// 기본값 — order.ascending과 동치). NaN은 오름/내림차순과 무관하게 항상 끝(pine2py `_sort_key`의
// `(1,0)` 키) — comparator에서 NaN을 우선 분리하고 나머지만 비교. 동률 원소의 상대 순서는 Python
// list.sort()가 stable이고 JS Array.prototype.sort도 ES2019+ stable이 보장돼(comparator가 NaN
// 아닌 두 값에 대해 0을 반환하는 경우는 애초에 없음 — 실측: node/python 교차 대조로 동률 2개
// 포함 배열의 정렬 결과가 바이트 단위 일치, scratch 없이 Bash 직접 검증) 별도 안정성 보정 불필요.
export function sort(arr: PineArray | null, ascending: boolean = true): void {
  if (arr === null) return;
  arr.sort((a, b) => {
    const aNaN = a !== a;
    const bNaN = b !== b;
    if (aNaN && bNaN) return 0;
    if (aNaN) return 1;
    if (bNaN) return -1;
    return ascending ? a - b : b - a;
  });
}

// array.reverse(id) — in-place 역순. JS Array.prototype.reverse가 Python list.reverse()와 동일한
// "그 자리에서 뒤집기" 시맨틱이라 그대로 위임(원소 값과 무관 — NaN 특수 처리 불필요).
export function reverse(arr: PineArray | null): void {
  if (arr === null) return;
  arr.reverse();
}

// array.slice(id, index_from=0, index_to=-1) — 부분 배열(새 배열 반환). pine2py는 index_to<0을
// "index_to=len(arr)"의 **부호와 무관한 센티널**로 취급한다(-1뿐 아니라 -5 등 어떤 음수든 전체
// 길이로 대체 — 진짜 "끝에서 5번째"가 아님, python 실측: slice([10..50],0,-2)가 여전히 전체
// 배열을 반환). 그 뒤 `arr[index_from:index_to]`는 Python 슬라이싱 시맨틱인데, JS
// `Array.prototype.slice(start,end)`의 ECMA-262 알고리즘(음수는 length+start로 클램프, 범위
// 밖은 조용히 클램프)이 Python list slicing과 완전히 동치라 index_from은 그대로 전달 가능(node/
// python 교차 실측: slice(-2)/slice(-100,3)/slice(10,20) 전부 바이트 단위 일치). index_from/
// index_to가 na(NaN)면 Python이 크래시하는 미정의 지점 — get/size(#19)를 참조형 반환에 적용한
// standardize(C83)와 동일하게 na(null) 전파로 결정.
export function slice(arr: PineArray | null, indexFrom: number = 0, indexTo: number = -1): PineArray | null {
  if (arr === null) return null;
  const from = Math.trunc(indexFrom);
  let to = Math.trunc(indexTo);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  if (to < 0) to = arr.length;
  return arr.slice(from, to);
}

// array.concat(id1, id2) — 두 배열을 이어붙인 새 배열(pine2py `arr1+arr2`). 둘 중 하나라도
// null이면 Python `None+list`가 크래시(미정의) — slice와 동일하게 na(null) 전파.
export function concat(arr1: PineArray | null, arr2: PineArray | null): PineArray | null {
  if (arr1 === null || arr2 === null) return null;
  return arr1.concat(arr2);
}

// array.copy(id) — 얕은 복사(새 배열, 원본과 독립 — python 실측으로 뮤테이션 비전파 확인).
// null이면 Python `None[:]`가 크래시(미정의) — na(null) 전파.
export function copy(arr: PineArray | null): PineArray | null {
  if (arr === null) return null;
  return arr.slice();
}

// ── C86: abs/every/some/range/binary_search·leftmost·rightmost/sort_indices
// (pine2py array.py L260-392) ──
// null 배열은 전부 pine2py가 가드 없이 크래시(`for x in arr`/`len(arr)` — python 실측)하는
// 미정의 동작 — abs/sort_indices는 참조형 반환이라 "읽기는 na(null)"(slice/standardize와 동일
// 원칙), every/some/range/binary_search류는 스칼라 반환이라 "읽기는 na(NaN)"(includes가 세운
// "bool 반환도 numeric-na로 통일" 원칙 재적용 — sum/avg류 #21과 동일 이분).

// array.abs(id) — 각 원소 절대값(새 배열 반환). pine2py는 `isinstance(x,(int,float)) and not
// isnan(x)`일 때만 abs()를 적용하고 NaN은 그대로 통과시키지만, Math.abs(NaN)도 이미 NaN이라
// 별도 분기 없이 Math.abs를 전 원소에 매핑하는 것만으로 literal port 동치(python/node 교차
// 실측: abs(-0.0)==0.0(양의 0)도 Math.abs(-0)===+0으로 일치).
export function abs(arr: PineArray | null): PineArray | null {
  if (arr === null) return null;
  return arr.map(Math.abs);
}

// array.every(id) — 모든 원소가 truthy. pine2py는 Python `nan`이 truthy라 별도 isnan 분기로
// False를 강제하지만, JS는 NaN이 이미 falsy라(`!NaN`===true) 그 특수 분기 자체가 불필요 —
// 일반 `if(!x) return false` 하나로 python의 (isnan 분기 + not-x 분기) 둘을 동시에 재현한다
// (MEMORY.md Pitfalls "Python nan은 truthy, JS NaN은 falsy" 참조). 빈 배열은 순회가 없어
// true(pine2py와 동일, python 실측).
export function every(arr: PineArray | null): boolean | number {
  if (arr === null) return NaN;
  for (const v of arr) if (!v) return false;
  return true;
}

// array.some(id) — 하나 이상의 원소가 truthy. every와 동일한 이유로 NaN 특수 분기 불필요
// (JS `if(x) return true`가 NaN에서 자연히 skip). 빈 배열은 false.
export function some(arr: PineArray | null): boolean | number {
  if (arr === null) return NaN;
  for (const v of arr) if (v) return true;
  return false;
}

// array.range(id) — 유효 원소 최대값-최소값. min/max(C81)를 그대로 내부 재호출(반환값 재사용
// 원칙, bb/standardize와 동일). 유효값 0개면 na.
export function range(arr: PineArray | null): number {
  if (arr === null) return NaN;
  if (validNums(arr).length === 0) return NaN;
  return max(arr) - min(arr);
}

// pine2py `bisect.bisect_left`/`bisect.bisect_right`(array.py binary_search류) 이식 — 둘 다
// `<` 비교만 쓰는 알고리즘이라 NaN 비교가 항상 false인 IEEE754 규칙이 Python/JS 양쪽에서
// 동일하게 적용돼(비교 연산자 자체의 언어별 차이가 없음), 배열/검색값에 NaN이 섞여도 알고리즘을
// 특수 분기 없이 그대로 literal port할 수 있다(python 교차 실측으로 확인 — value=NaN/배열에
// NaN 포함 두 경우 다 바이트 단위 일치).
function bisectLeft(arr: PineArray, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function bisectRight(arr: PineArray, value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (value < arr[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// array.binary_search(id, value) — 정렬된 배열 전제, 발견 인덱스 또는 -1(pine2py
// `bisect_left`+동치 확인, 미발견은 -1). NaN 검색값은 bisectLeft가 항상 lo=0으로 수렴한 뒤
// arr[0]===value가 false라 자연히 -1(별도 가드 불필요).
export function binary_search(arr: PineArray | null, value: number): number {
  if (arr === null) return NaN;
  const idx = bisectLeft(arr, value);
  return idx < arr.length && arr[idx] === value ? idx : -1;
}

// array.binary_search_leftmost(id, value) — 삽입 위치(왼쪽, 동률의 첫 인덱스).
export function binary_search_leftmost(arr: PineArray | null, value: number): number {
  if (arr === null) return NaN;
  return bisectLeft(arr, value);
}

// array.binary_search_rightmost(id, value) — 삽입 위치(오른쪽, 동률 다음 인덱스).
export function binary_search_rightmost(arr: PineArray | null, value: number): number {
  if (arr === null) return NaN;
  return bisectRight(arr, value);
}

// array.sort_indices(id, order=order.ascending) — 정렬된 인덱스 배열 반환(원본 비변형, 새 배열
// 반환이라 ARRAY_CONSTRUCTOR_METHODS 등재). order 인자는 sort(C85)의 builtinBooleanConstants를
// 재사용해 boolean 시그니처로 단순화(sort와 동일 이유). pine2py는 유효 원소만 정렬한 인덱스 뒤에
// NaN 원소 인덱스를 원본 순서 그대로 이어붙인다. 동률 tie-break는 Python `list.sort(reverse=True)`
// 가 "전체를 뒤집는 게 아니라 동률 원소의 상대 순서를 원본 그대로 유지"하는 stable 성질을
// 가지는데, JS Array.prototype.sort(ES2019+ stable)도 comparator 안에 방향을 인코딩하면
// (`ascending ? a-b : b-a`) 동률(comparator 0)에서 원본 상대 순서를 그대로 보존해 별도 보정 없이
// 동치(python 교차 실측: 오름/내림 둘 다 동률 인덱스 순서 일치 확인).
export function sort_indices(arr: PineArray | null, ascending: boolean = true): number[] | null {
  if (arr === null) return null;
  const validPairs: Array<[number, number]> = [];
  const nanIndices: number[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]!;
    if (v === v) validPairs.push([i, v]);
    else nanIndices.push(i);
  }
  validPairs.sort((a, b) => (ascending ? a[1] - b[1] : b[1] - a[1]));
  return validPairs.map((p) => p[0]).concat(nanIndices);
}

// array.covariance(id1, id2) — 두 배열의 공분산(같은 인덱스끼리 짝, 둘 다 유효한 짝만). n=두 배열
// 길이 중 작은 쪽(pine2py `min(len(arr1),len(arr2))`) — 짧은 쪽 밖의 원소는 애초에 순회 대상이
// 아니므로 na 취급이 필요 없다. 유효한 짝이 2개 미만이면 na.
export function covariance(arr1: PineArray | null, arr2: PineArray | null): number {
  if (arr1 === null || arr2 === null) return NaN;
  const n = Math.min(arr1.length, arr2.length);
  const pairsA: number[] = [];
  const pairsB: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = arr1[i]!;
    const b = arr2[i]!;
    if (a === a && b === b) {
      pairsA.push(a);
      pairsB.push(b);
    }
  }
  if (pairsA.length < 2) return NaN;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < pairsA.length; i++) {
    sumA += pairsA[i]!;
    sumB += pairsB[i]!;
  }
  const meanA = sumA / pairsA.length;
  const meanB = sumB / pairsB.length;
  let total = 0;
  for (let i = 0; i < pairsA.length; i++) total += (pairsA[i]! - meanA) * (pairsB[i]! - meanB);
  return total / pairsA.length;
}

// array.join(id, separator=" ") — pine2py `separator.join(str(x) for x in arr)`. 원소가 number/
// string/bool 셋 중 무엇이든 담길 수 있어(new_int/new_bool/new_string/new_color(C84)가 만든
// 배열들도 array.join의 대상) 이 파일에서 유일하게 원소 타입을 런타임에 분기하는 함수다.
// **na(null) 배열/separator**: pine2py는 `for x in None`(TypeError)와 `None.join(...)`
// (AttributeError) 둘 다 가드 없이 크래시하는 미정의 동작 — get/size(#19)류의 "읽기는 na" 원칙을
// 참조형 반환에 적용해 na(null) 전파로 결정(slice/standardize와 동일 패턴, DIVERGENCES.md 신규).
//
// **원소별 포맷 — pine2py `str(x)`를 타입별로 재현**:
// - string 원소: 그대로 통과.
// - number 원소: pine2py에서 원소가 Python int(예: new_int로 만든 배열에 정수 리터럴만 push)면
//   `str(x)`가 소수점 없이 나오고, float면 str.tostring(C87)의 기본 분기와 동일한 pyFloatStr
//   포맷(정수값도 ".0" 표기)이 나온다 — 그런데 이 int/float 구분은 pine2py 자신도 안정적이지
//   않다: 배열의 선언 타입(array<int> vs array<float>)이 아니라 **그 값이 소스 코드에 정수
//   리터럴로 쓰였는지 소수점 리터럴로 쓰였는지**(codegen.py `_gen_number_literal`)에 좌우되는
//   우연한 성질이다(예: `array.push(floatArr, 5)`처럼 float 배열에 정수 리터럴을 넣으면 Python
//   str(5)=='5'로 소수점이 사라짐 — 선언 타입과 무관). pine2js는 애초에 GOAL.md대로 JS Number에
//   int/float 구분이 없어(Pitfalls) 이 우연한 구분 자체를 재현할 안정적인 기준이 없다 — 모든
//   number 원소를 pyFloatStr(항상 float 스타일)로 통일한다. **TV 미검증(가설)**: array<int>
//   원소가 소수점 없이 렌더링돼야 하는지는 VERIFIED_SEMANTICS.md에 근거가 없어 확인 못 함
//   (LIMITATIONS.md 신규 등재 — array.new_int/원소 자체가 정수 리터럴인 array.join은 오라클
//   대상에서 제외, hand-verified만).
// - number 원소가 NaN이면 pine2py `str(float('nan'))=='nan'`(소문자) — str.tostring(C87)의
//   명시적 "NaN"(대문자) 가드와 달리 join()엔 그런 가드가 없어 그냥 `str(x)`를 타므로 다른
//   결과(소문자)가 나온다. python 직접 실행으로 확인(`array.join([float('nan'),1.0],',')` ==
//   'nan,1.0') — 오라클로 직접 검증 가능(na 리터럴을 array.push로 밀어넣으면 pine2py도 코드젠상
//   항상 float('nan')이 되므로 크래시 없이 재현됨).
// - boolean 원소: pine2py `str(True)/str(False)`는 Python 관례상 대문자('True'/'False') —
//   Pine 언어 자체의 리터럴 표기(소문자 true/false)와 다르지만, 이 세션은 TV 실제 표시 규칙을
//   확인할 WebSearch 권한이 없어(VERIFIED_SEMANTICS.md 근거 없음) CLAUDE.md STEP1 폴백 원칙대로
//   추측 없이 pine2py 그대로 literal port(오라클로 바이트 단위 검증 가능 — array.from(true,false)
//   같은 리터럴 bool 배열은 int/float 원소와 달리 코드젠 경로가 결정적이라 애매함이 없다).
// - null 원소: 현재 codegen은 array.push 등 일반 호출 인자 위치의 na 리터럴을 항상 NaN으로
//   내려(genExpr의 NaLiteral 분기, `var string x = na` 최상위 선언 전용 null 특수화와 별개
//   경로) 실제로는 도달하지 않는 경로지만, GOAL.md na 3분할 원칙(참조형 na=null)과 향후 codegen
//   보강에 대비해 방어적으로 NaN과 동일하게 "nan"을 반환한다.
type JoinElement = number | string | boolean | null;

function joinElement(x: JoinElement): string {
  if (x === null) return "nan";
  if (typeof x === "string") return x;
  if (typeof x === "boolean") return x ? "True" : "False";
  if (Number.isNaN(x)) return "nan";
  return pyFloatStr(x);
}

export function join(arr: JoinElement[] | null, separator: string | null = " "): string | null {
  if (arr === null || separator === null) return null;
  return arr.map(joinElement).join(separator);
}
