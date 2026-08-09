// PineScript map.* 네임스페이스 — pine2py wavealgo/builtins/map_funcs.py의 JS 이식(C89:
// new/put/get/remove/contains/keys/values/size/clear/copy/put_all 11종 전체).
//
// Pine의 map은 array와 마찬가지로 진짜 참조 타입이다: 값은 JS Map 객체 그 자체이고, var 슬롯/UDF
// 인자 전달은 참조를 그대로 담고/넘긴다. na는 참조형 규약대로 null(GOAL.md na 3분할). 키/값은
// map<K,V>의 K,V 조합과 무관하게 완전히 동적으로 다뤄(array.new_string 등(C84)이 별도 원소 타입
// 배열을 두면서도 공용 접근자를 그대로 재사용한 것과 동일 원칙 — 생성 코드가 `new Function`으로
// 실행돼 TS 컴파일 시점 타입 검사를 받지 않는다) PineMap을 Map<unknown, unknown>으로 통일한다.
//
// na 처리 (python 직접 실행으로 실측, C89):
// - pine2py map_funcs.py는 맵 인자에 가드가 없어 None에서 전부 크래시(AttributeError) —
//   array.*(#19)와 동일하게 "읽기는 na, 쓰기는 no-op"으로 새로 결정(DIVERGENCES.md 신규).
// - get(m, key[, default])은 pine2py 시그니처가 `default: Any = float("nan")`를 실제로 지원한다
//   (C241, C240 next_hint — corpus 전수 재확인 결과 161개 파일이 `map.get(m, key, default)` 3-인자
//   폼을 직접 씀, 이전 사이클(C89)의 "Pine 표면은 2개 인자만 노출" 판단은 당시 표본(pine2py
//   테스트 픽스처만)이 좁았던 오판이었음 — DIVERGENCES.md #29/LIMITATIONS.md 해당 항목 정정).
//   na map을 "키가 없는 빈 맵"과 동치로 취급해 get(null, key[, default])도 동일한 default를 반환
//   — #19 원칙의 확장.
// - put/remove는 array.remove(#19)처럼 "쓰기+읽기" 성격이라 na map에서 (no-op, NaN 반환).
// - contains는 boolean 반환이라 na가 없어 na map → false(빈 맵과 동치).
// - keys/values/copy는 참조형(새 배열/맵) 반환이라 na map → null(array.standardize(#19)와
//   동일 계열).
// - size는 스칼라 반환이라 na map → NaN(array.size와 동일).
// - clear/put_all은 순수 쓰기(반환값 없음) → na map은 no-op.
// - put_all(m, other)의 other가 na map이면 "추가할 항목이 없다"로 취급해 no-op(읽기 na 원칙의
//   반복형 적용 — array.concat/join의 na 인자 전파와 같은 계열).

export type PineMap = Map<unknown, unknown>;

// map.new<K,V>() — 항상 빈 맵. `new`는 JS 예약어라 함수 선언 식별자로 쓸 수 없어(프로퍼티 접근
// `rt.map.new`는 유효) rt.ts에서 `new: newMap`으로 매핑한다(color.new(C78)의 colorNew와 동일 패턴).
export function newMap(): PineMap {
  return new Map();
}

// map.put(id, key, value) — 이전 값 반환(없으면 NaN) 후 대입(in-place 뮤테이션).
export function put(m: PineMap | null, key: unknown, value: unknown): unknown {
  if (m === null) return NaN;
  const prev = m.has(key) ? m.get(key) : NaN;
  m.set(key, value);
  return prev;
}

// map.get(id, key[, default]) — 없으면 default(3번째 인자 생략 시 na, pine2py map_funcs.py
// get(m, key, default=nan) literal port, C241). na map은 "키 없음"과 동치로 취급해 같은 default를 반환.
export function get(m: PineMap | null, key: unknown, defaultValue: unknown = NaN): unknown {
  if (m === null) return defaultValue;
  return m.has(key) ? m.get(key) : defaultValue;
}

// map.remove(id, key) — 키 제거 & 이전 값 반환(없으면 NaN). na map은 제거할 것도 없어 NaN.
export function remove(m: PineMap | null, key: unknown): unknown {
  if (m === null) return NaN;
  if (!m.has(key)) return NaN;
  const prev = m.get(key);
  m.delete(key);
  return prev;
}

// map.contains(id, key) — na map은 빈 맵과 동치라 false.
export function contains(m: PineMap | null, key: unknown): boolean {
  if (m === null) return false;
  return m.has(key);
}

// map.keys(id) — 키 목록(새 배열). na map → na(null, 참조형 반환 — array.standardize(#19)와 동일).
export function keys(m: PineMap | null): unknown[] | null {
  if (m === null) return null;
  return Array.from(m.keys());
}

// map.values(id) — 값 목록(새 배열). keys와 동일한 na 원칙.
export function values(m: PineMap | null): unknown[] | null {
  if (m === null) return null;
  return Array.from(m.values());
}

// map.size(id) — na map → NaN(array.size와 동일).
export function size(m: PineMap | null): number {
  if (m === null) return NaN;
  return m.size;
}

// map.clear(id) — na map은 no-op.
export function clear(m: PineMap | null): void {
  if (m === null) return;
  m.clear();
}

// map.copy(id) — 얕은 복사(새 Map). na map → na(null).
export function copy(m: PineMap | null): PineMap | null {
  if (m === null) return null;
  return new Map(m);
}

// map.put_all(id1, id2) — id2의 모든 항목을 id1에 병합(in-place). id1이 na면 no-op, id2가 na면
// "추가할 항목이 없다"로 취급해 역시 no-op(둘 다 #19 "쓰기는 no-op" 원칙의 재적용).
export function put_all(m: PineMap | null, other: PineMap | null): void {
  if (m === null || other === null) return;
  for (const [k, v] of other) m.set(k, v);
}
