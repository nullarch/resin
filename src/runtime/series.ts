// Series: 내부 순방향 저장([oldest→newest]), 외부 역방향 접근(get(0)=현재 바).
// pine2py/wavealgo/series.py의 검증된 인덱싱 시맨틱을 이식 (get(0)=현재, get(1)=이전, ...).
// 스트리밍 bar 루프에 맞춰 cursor 포인터 방식으로 구현 (매 바 advance() 호출).

export class Series {
  private data: Float64Array;
  private cursor = -1;

  constructor(values: ArrayLike<number>) {
    this.data = Float64Array.from(values);
  }

  // 사용자 var 히스토리 슬롯용: 바 개수를 미리 알 때(배치 실행) NaN으로 미리 채운 고정 크기
  // 버퍼를 만든다 — record()가 바마다 현재 cursor 위치에 값을 채워나간다. bar 실행 도중 배열을
  // growable하게 만들지 않는 이유는 GOAL.md "bar loop 안 할당 제로" 원칙(pine2py의 Series.push()는
  // 매 바 리스트를 늘리는 방식이라 이 원칙과 맞지 않아 그대로 이식하지 않았다).
  static preallocate(length: number): Series {
    return new Series(new Float64Array(length).fill(NaN));
  }

  advance(): void {
    this.cursor += 1;
  }

  // offset은 대부분 codegen이 박아넣은 컴파일타임 정수 리터럴이지만, 동적(런타임) 히스토리
  // 오프셋(analyzer의 dynamicHistoryOffsets, 예: `high[i]` — i가 for 루프 카운터)도 그대로
  // 여기로 흘러든다 — analyzer가 리터럴에 대해서만 강제하던 "0 이상의 정수"를 런타임에도 지켜야
  // 하므로 명시적으로 가드한다. 음수 offset을 그대로 허용하면 idx가 cursor를 넘어 아직 오지 않은
  // 미래 바 데이터를 조용히 반환하는 lookahead 버그가 된다(배치 엔진이 전체 배열을 미리 쥐고
  // 있어 범위 체크만으로는 못 막음) — Math.trunc는 비정수 offset(부동소수점 오차 등)이 타입드
  // 배열 인덱싱에서 조용히 undefined를 내는 것을 방지(MEMORY.md Pitfalls "array index는 Math.trunc
  // 필수" 원칙 재적용). 가드는 긍정형(`>= 0`)으로 쓴다 — offset이 na 전파로 NaN이 되는 경우
  // (i 자체가 na 등) `truncated < 0`(부정형)은 `NaN < 0`이 false라 통과시켜버리지만
  // `truncated >= 0`(긍정형)은 `NaN >= 0`이 false라 자동으로 걸러진다(MEMORY.md Pitfalls C91
  // "인덱스 범위 가드는 긍정형으로" 원칙 재적용 — matrix.ts에서 실제 크래시로 발견된 것과 동일 클래스).
  get(offset = 0): number {
    const truncated = Math.trunc(offset);
    if (!(truncated >= 0)) return NaN;
    const idx = this.cursor - truncated;
    if (idx < 0 || idx >= this.data.length) return NaN;
    return this.data[idx]!;
  }

  // 현재 cursor 위치(이번 바)에 값을 기록한다 — 사용자 var 히스토리 슬롯 전용(codegen이 top-level
  // 문장을 모두 실행한 뒤 딱 한 번 호출, analyzeIndexAccess/genIndexAccess 주석 참조).
  record(value: number): void {
    if (this.cursor >= 0 && this.cursor < this.data.length) {
      this.data[this.cursor] = value;
    }
  }

  get length(): number {
    return this.data.length;
  }

  // 전체 기록 히스토리를 [oldest→newest] 순으로 뽑아낸다(plot 수집 채널 전용 -- 바 루프가 끝난 뒤
  // engine.ts run()이 RunResult.plots로 노출할 때만 쓴다, get(offset)류 역방향 접근과는 별개 용도).
  toArray(): number[] {
    return Array.from(this.data);
  }

  // 조건부(if/for/while) 위치 stateful 콜 히스토리 전용(C671, analyzer.ts condCallHistorySlots
  // 주석 참조) — advance()가 아니라 이 메서드 자신이 커서를 전진시킨다. Context.advance()의 매 바
  // 무조건 전진(record()가 안 불려도 커서는 미는 바-인덱스 시맨틱)과 달리, push()는 "호출된 만큼만"
  // 전진해 VERIFIED_SEMANTICS.md CONFIRMED("함수 내부 series는 조건이 참인 바에서만 갱신")가
  // 요구하는 압축(call-count) 인덱스를 그대로 구현한다. 이 메서드를 쓰는 Series 인스턴스는
  // Context.advance()의 histSlots 순회 대상이 아니어야 한다(runtime/context.ts condCallHistSlots).
  push(value: number): void {
    this.cursor += 1;
    if (this.cursor >= 0 && this.cursor < this.data.length) {
      this.data[this.cursor] = value;
    }
  }
}

// histSlot 대상(top-level var/varip·'=' 로컬·UDF param/'=' 로컬/내부 var)의 동적(런타임) 히스토리
// 오프셋 전용(C365, ROADMAP P4 🔴🔴 (c) — rt.barIndexHistory(numeric.ts)와 같은 "런타임 가드 위임"
// 선례). 리터럴 오프셋은 analyzer가 컴파일타임에 offset===0(현재 값 identifier 읽기)/offset>=1
// (slot.get)로 분기하지만 런타임 오프셋은 그 분기를 여기서 해야 한다: histSlot의 record()는
// top-level 문장이 모두 끝난 뒤(또는 UDF 진입/대입 직후)라 읽는 시점의 slot.get(0)은 아직 이전
// 바(또는 이전 record)의 값이고, 오프셋 0의 올바른 값은 "지금 변수에 든 값" 그 자체다
// (analyzeIndexAccess offset===0 조기 반환 주석과 동일 근거). trunc + 긍정형 NaN/음수 가드는
// Series.get()과 동일 원칙 — 0 초과는 get()이 자체 가드를 다시 지나지만 이중 trunc는 무해하다.
export function histGet(currentValue: number, slot: Series, offset: number): number {
  const t = Math.trunc(offset);
  if (!(t >= 0)) return NaN;
  if (t === 0) return currentValue;
  return slot.get(t);
}

// drawing 핸들(line/label/box/table) 값을 담은 '=' 로컬의 히스토리 인덱싱 전용(배치25 (1), wild
// "히스토리 인덱스는 drawing 핸들 로컬 미지원" 3형제 클러스터). Series(Float64Array)는 object
// 참조를 담을 수 없어 별도 object 원형 버퍼로 신설 — cursor/advance/preallocate/record 전부 Series와
// 동형이나 기본값이 NaN 대신 null(GOAL.md na 3분할 규약 — 참조형 na=null)이고 데이터 배열이
// unknown[](object 원형 버퍼)다. drawing 핸들은 GOAL.md/runtime/drawing.ts 주석대로 "어디서도 값으로
// 소비되지 않는 죽은 채널"이라 이 클래스는 참조 그 자체를 왕복시키는 것 이상을 보장하지 않는다.
export class RefSeries {
  private data: unknown[];
  private cursor = -1;

  constructor(length: number) {
    this.data = new Array(length).fill(null);
  }

  static preallocate(length: number): RefSeries {
    return new RefSeries(length);
  }

  advance(): void {
    this.cursor += 1;
  }

  // Series.get()과 동일한 trunc + 긍정형 NaN/음수 가드(C91) — offset이 na 전파로 NaN이 되는 경우도
  // 동일하게 안전(`truncated >= 0`이 `NaN >= 0`에서 자동으로 false).
  get(offset = 0): unknown {
    const truncated = Math.trunc(offset);
    if (!(truncated >= 0)) return null;
    const idx = this.cursor - truncated;
    if (idx < 0 || idx >= this.data.length) return null;
    return this.data[idx];
  }

  record(value: unknown): void {
    if (this.cursor >= 0 && this.cursor < this.data.length) {
      this.data[this.cursor] = value ?? null;
    }
  }

  // Series.push()(C671)의 object 원형 버퍼 판 — drawing 생성자 콜(line.new 등) 인라인 히스토리
  // 인덱싱 전용(C700, index-access.ts condCallRefHistorySlots 주석 참조). record()와 달리 이
  // 메서드 자신이 커서를 전진시켜 "호출된 만큼만" 전진하는 압축(call-count) 인덱스를 구현한다 —
  // Context.advance()의 refHistSlots 순회 대상이 아니어야 한다(context.ts condCallRefHistSlots).
  push(value: unknown): void {
    this.cursor += 1;
    if (this.cursor >= 0 && this.cursor < this.data.length) {
      this.data[this.cursor] = value ?? null;
    }
  }

  get length(): number {
    return this.data.length;
  }
}

// RefSeries 대상의 동적(런타임) 히스토리 오프셋 전용 — histGet(수치)의 참조형 판. offset===0의
// 올바른 값은 "지금 변수에 든 값" 그 자체라는 histGet과 동일 근거(record 타이밍이 문장 종료 후/대입
// 직후라 slot.get(0)은 아직 이전 기록).
export function refHistGet(currentValue: unknown, slot: RefSeries, offset: number): unknown {
  const t = Math.trunc(offset);
  if (!(t >= 0)) return null;
  if (t === 0) return currentValue;
  return slot.get(t);
}

// request.security 프리패스(HTF 캐시 Float64Array 직접 인덱싱) 전용 동적 오프셋 가드(C437,
// ROADMAP P4 클러스터 index-dynamic-or-negative — call-expr.ts buildSecurityExprNode의
// IndexAccess 리터럴 전용 제약 해제). histGet과 원칙은 같으나(trunc + 긍정형 가드) 여긴 Series
// 객체가 아니라 프리패스가 이미 들고 있는 평평한 배열(HTF 캐시 열 또는 __secHistK 서브식 버퍼)을
// h(행 커서) 기준으로 직접 인덱싱한다 — offset===0도 arr[h]가 곧 "그 행 자신"이라 histGet의
// currentValue 특례(레코드 타이밍 어긋남 보정)가 여기선 필요 없다(배치 리플레이가 전체 배열을
// 미리 쥐고 있어 record()류 타이밍 개념 자체가 없음).
export function secHistGet(arr: Float64Array, h: number, offset: number): number {
  const off = Math.trunc(offset);
  if (!(off >= 0)) return NaN;
  const idx = h - off;
  if (idx < 0) return NaN;
  return arr[idx]!;
}
