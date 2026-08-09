// PineScript matrix.* 네임스페이스 — pine2py wavealgo/builtins/matrix.py의 JS 이식(C90: 첫
// 슬라이스, 생성자+기본 접근자 new/get/set/rows/columns/elements_count 6종. pine2py 코퍼스
// (tests/test_full_pipeline.py 등) 전수 grep 결과 이 6종이 최다 빈도(set 46/new 46/get 20/
// rows 10/columns 9/elements_count 6) — array.*(C79)가 new_float/get/set/push/pop/size로
// 시작한 것과 동일하게 "생성자+기본 접근자" 묶음을 첫 슬라이스로 잡음. C91이 row/col 2종,
// C92가 add_row/add_col/remove_row/remove_col/swap_rows/swap_columns 6종을 추가해 14/49, C93이
// copy/fill/concat/submatrix/reshape/reverse/sort/diff 8종을 추가해 22/49, C94가 is_square 등
// 구조 검사 10종을 추가해 32/49, C95가 sum/avg/min/max/median/mode 6종을 추가해 38/49, C96이
// transpose 1종을 추가해 39/49, C97이 mult 1종(행렬 대수 11종의 두 번째 항목)을 추가해 40/49 완료.
// **C95 발견(총 개수 정정)**: `grep '^def ' matrix.py`로 private 헬퍼(_flat_valid/_is_nan) 제외
// 실제 공개 함수를 전수 세어보니 49개 — C90부터 반복 인용된 "42개"는 오검(원인 불명, 재검증 없이
// 구두 전승됐던 것으로 추정, MEMORY.md Pitfalls "메모 재검증" 원칙의 재확인 사례)였다. 이후 이
// 파일과 ROADMAP/PROGRESS/METRICS는 49를 분모로 쓴다(과거 사이클 로그의 "22/42" 등은 역사 기록이라
// 수정하지 않음). C98이 det 1종을 추가해 41/49, C99가 trace 1종을 추가해 42/49, C100이 inv
// 1종을 추가해 43/49, C101이 rank 1종을 추가해 44/49, C102가 pow 1종을 추가해 45/49, C103이
// kron 1종을 추가해 46/49, C104가 pinv 1종을 추가해 47/49, C105가 eigenvalues 1종을 추가해
// 48/49, C106이 eigenvectors 1종(행렬 대수 마지막 항목)을 추가해 49/49 완주 — matrix.* 전체 완료.
//
// pine2py matrix.py는 list[list]로 표현하고 원소 타입을 Any로 둔다 — array.*처럼 타입별
// new_int/new_bool/... suffix가 없고 matrix.new<T>(rows, columns, initial_value)는 항상
// 같은 시그니처(제네릭 타입 인자는 파서가 스킵, 런타임에 안 씀 — map.new(C89)와 동일 원칙)라
// pine2js도 단일 unknown[][] 표현으로 충분(공용 접근자가 `new Function` 생성 코드 안에서
// 실행돼 TS 컴파일 시점 타입 검사를 받지 않는 것도 array.new_int 등(C84)과 동일 근거).
//
// na 처리(python 직접 실행으로 실측):
// - pine2py matrix.py의 get/set/rows/columns는 array.py(0<=index<len 가드)와 달리 아무 가드가
//   없다 — get은 `m[row][column]`(범위 밖이면 IndexError), set도 동일, rows/columns는 None
//   인자에서 len(None) 크래시. array.*(#19)가 이미 확립한 "읽기는 na, 쓰기는 no-op" 원칙을
//   그대로 재적용(새 판단 없음) — get은 범위 밖/na 인자 전부 NaN, set은 no-op, rows/columns/
//   elements_count는 na 행렬에서 NaN.
// - new의 rows/columns가 na(NaN)면 pine2py `range(nan)`이 TypeError 크래시 — new_float(#19)와
//   동일하게 na(null) 행렬 전파로 결정. 음수 rows/columns는 Python이 크래시 없이 빈 결과를 내는
//   정의된 동작(`[x]*-1`==[], `range(-1)`==빈 range)이라 literal port(0으로 클램프와 동치).
// - **발견(map.put과 동일 계열의 latent 버그, DIVERGENCES.md #29 재확인 사례)**: matrix.py의
//   set()도 map_funcs.py의 put()과 마찬가지로 `_scalar()` Series-해소 가드가 없다(array.py
//   set()에는 있음) — `matrix.set(m, 0, 0, close)`를 var 행렬에 매 바 반복하면 pine2py에서
//   Series 참조가 그대로 저장돼 다음 조회 시 '지금 이 바'의 값이 나오는 동일한 latent 버그가
//   있다. pine2js는 GOAL.md 아키텍처 불변 원칙(함수 인자 위치의 Series는 codegen이 항상 먼저
//   .get(0)으로 스칼라 해소)상 이 버그 클래스를 구조적으로 재현할 수 없다(map.put과 동일 근거).

export type PineMatrix = unknown[][];

// matrix.new<T>(rows=0, columns=0, initial_value=na) — pine2py
// `[[initial_value]*columns for _ in range(rows)]`와 동치. rows<=0은 빈 행렬([]), columns<=0은
// "rows개의 빈 행"(행 자체는 존재, 열이 0개)이 되는 것까지 Python 시맨틱 그대로.
export function newMatrix(rows: number = 0, columns: number = 0, initialValue: unknown = NaN): PineMatrix | null {
  if (Number.isNaN(rows) || Number.isNaN(columns)) return null;
  const nr = Math.trunc(rows);
  if (nr <= 0) return [];
  const nc = Math.trunc(columns);
  const ncClamped = nc <= 0 ? 0 : nc;
  const m: PineMatrix = new Array(nr);
  for (let i = 0; i < nr; i++) m[i] = new Array(ncClamped).fill(initialValue);
  return m;
}

// matrix.get(id, row, column) — 범위 밖/na 행렬은 NaN(array.get(#19)과 동일 원칙, pine2py엔
// 없는 가드를 새로 추가). 가드는 array.ts get(#19)과 동일하게 긍정형(`i>=0 && i<len`)으로 써야
// NaN 인덱스도 자동으로 걸러진다 — 부정형(`i<0 || i>=len`)은 NaN과의 모든 비교가 false라
// NaN이 통과해버려 다음 줄(`m[NaN]`=undefined)에서 `.length` 접근 시 크래시하는 실제 버그였다
// (C91에서 row/col 착수 중 발견, C90이 array.ts와 다른 부정형 가드를 써서 생긴 회귀 — 이 파일
// 안의 get/set 둘 다 해당, column만 NaN인 set은 크래시 없이 `rowArr[NaN]=value`로 조용히 배열
// 아닌 프로퍼티를 붙이는 은닉 오염이라 더 위험. zero_bug_streak 리셋 대상).
export function get(m: PineMatrix | null, row: number, column: number): unknown {
  if (m === null) return NaN;
  const r = Math.trunc(row);
  if (!(r >= 0 && r < m.length)) return NaN;
  const rowArr = m[r]!;
  const c = Math.trunc(column);
  if (!(c >= 0 && c < rowArr.length)) return NaN;
  return rowArr[c];
}

// matrix.set(id, row, column, value) — 범위 밖/na 행렬은 no-op(array.set(#19)과 동일 원칙).
// 가드는 get과 동일한 이유로 긍정형(C91 버그 수정 참조).
export function set(m: PineMatrix | null, row: number, column: number, value: unknown): void {
  if (m === null) return;
  const r = Math.trunc(row);
  if (!(r >= 0 && r < m.length)) return;
  const rowArr = m[r]!;
  const c = Math.trunc(column);
  if (!(c >= 0 && c < rowArr.length)) return;
  rowArr[c] = value;
}

// matrix.row(id, row_number) — 특정 행을 새 배열로 복사해 반환. pine2py `list(m[index])`는
// 가드 없이 Python 리스트 연산자를 그대로 써서 음수 인덱스가 "끝에서부터"로 우연히 동작하지만
// (python 직접 실행 실측: row(m,-1)==마지막 행), 형제 함수 matrix.get/set(C90/C91)은 이미
// "0<=index<size, 그 외 na"로 확정해뒀다 — 같은 파일 안에서도 함수마다 가드 유무가 다르다는
// C89/C90 교훈의 세 번째 사례로 판단해(matrix.set의 `_scalar()` 누락과 동일 계열), pine2py의
// 이 음수 래핑을 의도된 시맨틱이 아니라 가드 누락의 부산물로 보고 literal port하지 않는다 —
// row/col도 get/set과 동일하게 음수/범위밖을 na(배열이라 null)로 통일(DIVERGENCES.md 신규).
// 단, rows=0인 빈 행렬에서 row()는 pine2py가 `m[index]` 자체에서 항상 IndexError로 크래시하므로
// (음수/범위밖 무관, python 실측) 위 na 통일 원칙이 그대로 적용된다 — col()과 달리 별도 예외 없음.
export function row(m: PineMatrix | null, index: number): unknown[] | null {
  if (m === null) return null;
  const r = Math.trunc(index);
  if (!(r >= 0 && r < m.length)) return null;
  return m[r]!.slice();
}

// matrix.col(id, column_number) — 특정 열을 새 배열로 반환. pine2py `[r[index] for r in m]`는
// rows=0(빈 행렬)이면 컴프리헨션이 원소를 하나도 순회하지 않아 index 값과 완전히 무관하게 항상
// `[]`을 반환한다(음수/범위밖이어도 크래시하지 않음 — python 직접 실행으로 col(0행 행렬, 5)==
// col(0행 행렬, -5)==[] 확인) — 이건 row()의 "빈 행렬은 항상 크래시"와 달리 진짜 잘 정의된
// (크래시 아닌) pine2py 동작이라 literal port(new()의 음수 rows/columns 클램프와 동일 계열
// 판단, "크래시 회피용 na 변환"이 아니라 "원래도 정의된 값"). rows>0인 일반 경우는 row()와
// 동일하게 음수/범위밖을 na로 통일.
export function col(m: PineMatrix | null, index: number): unknown[] | null {
  if (m === null) return null;
  if (m.length === 0) return [];
  const c = Math.trunc(index);
  const ncols = m[0]!.length;
  if (!(c >= 0 && c < ncols)) return null;
  const result: unknown[] = new Array(m.length);
  for (let i = 0; i < m.length; i++) result[i] = m[i]![c]!;
  return result;
}

// ── 행/열 조작 (C92: 세 번째 슬라이스) ─────────────────
//
// pine2py 소스를 python 직접 실행으로 재확인한 결과 이 6종은 두 가지 판이한 무가드 성격으로
// 갈린다:
// - add_row/add_col: `index<0 or index>=len(...)` 명시적 append/insert 분기가 소스에 **실제로
//   존재**한다(row/col의 "가드 자체가 없음" accident와 다른 클래스) — 이 분기는 literal port
//   대상. 그러나 **발견(pine2py latent 버그)**: 이 분기를 통과한 유효 범위 index라도
//   `m.insert(index,...)`/`r.insert(index,...)`가 Python float(정수값이어도, 예: 1.0)를 거부해
//   TypeError로 크래시함(index 인자가 정수 리터럴이면 append 여부와 무관하게 append 분기로 안
//   빠지는 한 insert()가 실행되며 크래시, python 실측: add_row(m,1.0)도 add_row(m,1.5)도 동일하게
//   크래시). JS Number는 int/float 구분이 없어(GOAL.md/Pitfalls) 이 크래시를 재현할 기준 자체가
//   없다 — "pine2py의 알려진 버그는 따르지 않는다" 적용(DIVERGENCES.md #32). NaN index는 이
//   append/insert 조건(`idx<0||idx>=len`)이 부정형과 동일한 함정을 가짐(NaN과의 모든 비교가
//   false라 insert 분기로 새어 JS splice가 NaN을 0으로 취급해 조용히 index=0에 삽입) —
//   Pitfalls의 "긍정형 가드" 원칙대로 NaN은 함수 최상단에서 명시적으로 no-op 처리.
// - remove_row/remove_col/swap_rows/swap_columns: pine2py가 가드를 전혀 안 써서(`m.pop(index)`,
//   `m[row1],m[row2]=...`, `r.pop(index)`, `r[col1],r[col2]=...`) get/set/row/col(#30/#31)과
//   완전히 동일한 클래스 — C91이 확정한 "형제 함수 일관성" 원칙을 그대로 적용해 음수/범위밖
//   index를 na(read)/no-op(write)로 통일(literal port 안 함). remove_col은 col()과 동일한 0행
//   행렬 예외(`for r in m`이 원소를 순회하지 않아 index 무관 항상 `[]`, 잘 정의된 동작이라
//   literal port)를 가지며, remove_row는 row()와 동일하게 0행에서 index 무관 항상 크래시라
//   예외 없음. swap_columns는 0행 행렬에서 columns(m)=0이라 가드 조건이 항상 불성립해 별도
//   예외 분기 없이 자연히 no-op으로 수렴(col/remove_col과 달리 "반환값"이 없어 예외가 관측되지
//   않음).

// matrix.add_row(id, index=-1, row=na) — 행 추가(in-place, 반환값 없음). pine2py의 명시적
// append/insert 분기를 literal port하되 위 주석의 int/float 크래시(DIVERGENCES.md #32)는
// 재현하지 않는다. value가 na(null)면 columns(m) 길이의 NaN-채움 행을 새로 만든다 — value 길이가
// columns(m)과 다르면 rectangular 불변식이 깨질 수 있는데 pine2py도 아무 보정 없이 그대로
// list(value)를 쓰므로(python 실측) literal port(검증 없음).
export function add_row(m: PineMatrix | null, index: number = -1, value: unknown[] | null = null): void {
  if (m === null) return;
  if (Number.isNaN(index)) return;
  const idx = Math.trunc(index);
  const ncols = columns(m);
  const newRow: unknown[] = value !== null ? value.slice() : new Array(ncols).fill(NaN);
  if (idx < 0 || idx >= m.length) {
    m.push(newRow);
  } else {
    m.splice(idx, 0, newRow);
  }
}

// matrix.add_col(id, index=-1, column=na) — 열 추가(in-place, 반환값 없음). pine2py는 append/
// insert 분기를 **행마다** 그 행 자신의 길이(`len(r)`) 기준으로 판단한다(단일 columns(m) 값이
// 아님 — non-rectangular 행렬에서 갈릴 수 있어 pine2py 소스 그대로 per-row 판단 유지). value가
// nrows(=m.length)보다 짧으면 남는 행은 NaN으로 채운다(`vals[i] if i<len(vals) else nan`
// literal port).
export function add_col(m: PineMatrix | null, index: number = -1, value: unknown[] | null = null): void {
  if (m === null) return;
  if (Number.isNaN(index)) return;
  const idx = Math.trunc(index);
  const nrows = m.length;
  const vals: unknown[] = value !== null ? value.slice() : new Array(nrows).fill(NaN);
  for (let i = 0; i < m.length; i++) {
    const r = m[i] as unknown[];
    const v = i < vals.length ? vals[i] : NaN;
    if (idx < 0 || idx >= r.length) {
      r.push(v);
    } else {
      r.splice(idx, 0, v);
    }
  }
}

// matrix.remove_row(id, index) — 지정 행 제거 후 반환(in-place). pine2py `m.pop(index)`는 가드가
// 없어 음수 인덱스가 Python list.pop의 "끝에서부터" 시맨틱으로 우연히 동작하지만, get/set/row/col
// (#30/#31)이 이미 확정한 "0<=index<size, 그 외 na" 원칙과의 일관성을 위해 literal port하지
// 않고 na(null, 반환값이 배열이라 참조형)로 통일 — 0행 행렬은 index 무관 항상 크래시(row()와
// 동일)라 이 원칙이 예외 없이 적용된다.
export function remove_row(m: PineMatrix | null, index: number): unknown[] | null {
  if (m === null) return null;
  const idx = Math.trunc(index);
  if (!(idx >= 0 && idx < m.length)) return null;
  return m.splice(idx, 1)[0] as unknown[];
}

// matrix.remove_col(id, index) — 지정 열 제거 후 반환(각 행에서 pop). remove_row와 동일한 "가드
// 없음, 음수 우연동작" 패턴이라 na 통일(0<=index<columns, 그 외 na) — 단 col()(#31)과 동일한
// 예외: 0행 행렬은 `for r in m`이 원소를 순회하지 않아 index 값과 완전히 무관하게 항상 빈 배열
// (크래시 아닌 잘 정의된 동작, python 실측)이라 literal port.
export function remove_col(m: PineMatrix | null, index: number): unknown[] | null {
  if (m === null) return null;
  if (m.length === 0) return [];
  const idx = Math.trunc(index);
  const ncols = columns(m);
  if (!(idx >= 0 && idx < ncols)) return null;
  const result: unknown[] = new Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const r = m[i] as unknown[];
    result[i] = r.splice(idx, 1)[0];
  }
  return result;
}

// matrix.swap_rows(id, row1, row2) — 두 행 교환(in-place, 반환값 없음). pine2py 튜플 대입
// `m[row1],m[row2]=m[row2],m[row1]`도 가드가 없어 음수 인덱스가 우연히 동작 — remove_row와
// 동일한 이유로 na 통일: 둘 다 0<=idx<size일 때만 교환하고, 하나라도 범위 밖이면 부분 교환 없이
// 전체 no-op(matrix.set(#30)의 "쓰기는 no-op" 원칙과 동일).
export function swap_rows(m: PineMatrix | null, row1: number, row2: number): void {
  if (m === null) return;
  const r1 = Math.trunc(row1);
  const r2 = Math.trunc(row2);
  if (!(r1 >= 0 && r1 < m.length && r2 >= 0 && r2 < m.length)) return;
  const tmp = m[r1]!;
  m[r1] = m[r2]!;
  m[r2] = tmp;
}

// matrix.swap_columns(id, col1, col2) — 두 열 교환(각 행 내부에서 swap). swap_rows와 동일한 na
// 통일 원칙(0<=idx<columns, 아니면 no-op) — 0행 행렬은 columns(m)=0이라 조건이 항상 불성립해
// remove_col/col()과 달리 별도 예외 분기 없이 자연히 no-op으로 수렴(반환값이 없어 결과가 이미
// pine2py의 "0행이면 아무 일도 안 일어남"과 동일).
export function swap_columns(m: PineMatrix | null, col1: number, col2: number): void {
  if (m === null) return;
  const c1 = Math.trunc(col1);
  const c2 = Math.trunc(col2);
  const ncols = columns(m);
  if (!(c1 >= 0 && c1 < ncols && c2 >= 0 && c2 < ncols)) return;
  for (let i = 0; i < m.length; i++) {
    const r = m[i] as unknown[];
    const tmp = r[c1];
    r[c1] = r[c2]!;
    r[c2] = tmp!;
  }
}

// matrix.rows(id) — na 행렬은 NaN(array.size와 동일).
export function rows(m: PineMatrix | null): number {
  if (m === null) return NaN;
  return m.length;
}

// matrix.columns(id) — 첫 행 기준(전 행이 rectangular라는 전제, pine2py와 동일 가정). na 행렬은
// NaN, 빈 행렬(0행)은 0.
export function columns(m: PineMatrix | null): number {
  if (m === null) return NaN;
  if (m.length === 0) return 0;
  return m[0]!.length;
}

// matrix.elements_count(id) — rows*columns. na 행렬은 NaN.
export function elements_count(m: PineMatrix | null): number {
  if (m === null) return NaN;
  return rows(m) * columns(m);
}

// ── 행렬 변형 (C93: 네 번째 슬라이스 — copy/fill/concat/submatrix/reshape/reverse/sort/diff) ──
//
// array.*(C85: sort/reverse/slice/concat/copy) 동명 패턴 재사용 가능성부터 검토했으나, pine2py
// matrix.py는 array.py와 완전히 독립적으로 재구현돼(공유 헬퍼 없음) 있어 시그니처/NaN 경계를
// 이 8종 각각 python 직접 실행으로 재확인해야 했다(next_hint 지시대로). 크게 세 그룹으로 갈린다:
// - copy/concat/submatrix/reshape/diff: 새 행렬을 반환하는 생성자류(matrixVars 등재).
// - fill/reverse/sort: in-place 뮤테이터(반환값 없음, MUTATING_ARRAY_BUILTINS 등재).
// null(na) 행렬 인자는 전부 pine2py가 크래시하는 미정의 지점 — 기존 원칙(반환값이 참조형이면
// na(null) 전파, 뮤테이터는 no-op) 그대로 재적용.

// matrix.copy(id) — 깊은 복사. pine2py `copy.deepcopy(m)`은 원소가 전부 스칼라(number/string/
// bool/color — Pine matrix는 단일 스칼라 타입 T만 담아 원소 자체가 중첩 배열일 수 없음)라 "행마다
// 새 배열"(1단계 복사)이 진짜 깊은 복사와 동치(array.copy(C85)의 얕은 복사와 달리 행 배열까지
// 복제 — 원본 행 뮤테이션이 복사본에 전파되지 않아야 함). **null은 na 통일 예외**: python 직접
// 실행 결과 `copy.deepcopy(None)`은 크래시 없이 None을 그대로 반환하는 잘 정의된 동작이라(다른
// 생성자류의 "null 인자는 크래시→na" 패턴과 다름) literal port로 null 전파.
export function copy(m: PineMatrix | null): PineMatrix | null {
  if (m === null) return null;
  return m.map((r) => (r as unknown[]).slice());
}

// matrix.fill(id, value, from_row=0, to_row=-1, from_column=0, to_column=-1) — 범위 채우기
// (in-place). pine2py `r2 = nr if to_row<0 else to_row`/`c2 = nc if to_column<0 else to_column`는
// 음수(값 무관, -1 센티널뿔만 아니라)를 전부 "끝까지"로 치환 — array.slice(C85)의 index_to<0
// 센티널과 동일한 모양이라 literal port. **발견(python 직접 실행)**: from_row/from_column이
// 음수여도 Python 음수 인덱싱이 우연히 값을 전부 같은 value로 채우는 특성상 결과적으로 0부터
// 시작한 것과 동치(같은 값을 반복 기록하는 연산이라 순서가 결과에 영향 없음 — 단
// |from_row|<=nr을 벗어나면 크래시)라 array.fill(C85, DIVERGENCES #20)과 동일하게 0으로
// 클램프(음수 index_from 크래시를 방지하며 결과는 동일). to_row/to_column이 양수인데 nr/nc를
// 초과하면 pine2py는 IndexError로 크래시(python 실측 확인, array.fill의 `min(index_to,len)`과
// 달리 matrix.fill 소스엔 이 상한 클램프가 없음) — array.fill과 동일한 "크래시 유발 입력은 안전한
// 값으로 클램프" 원칙을 적용해 nr/nc로 상한 클램프(신규 divergence, array.fill DIVERGENCES #20과
// 동급). NaN 인자는 전부 no-op(add_row류의 NaN-index no-op 원칙과 동일).
export function fill(
  m: PineMatrix | null,
  value: unknown,
  fromRow: number = 0,
  toRow: number = -1,
  fromColumn: number = 0,
  toColumn: number = -1,
): void {
  if (m === null) return;
  if (Number.isNaN(fromRow) || Number.isNaN(toRow) || Number.isNaN(fromColumn) || Number.isNaN(toColumn)) return;
  const nr = m.length;
  const nc = columns(m);
  const r2 = Math.min(toRow < 0 ? nr : Math.trunc(toRow), nr);
  const c2 = Math.min(toColumn < 0 ? nc : Math.trunc(toColumn), nc);
  const rFrom = Math.max(0, Math.trunc(fromRow));
  const cFrom = Math.max(0, Math.trunc(fromColumn));
  for (let i = rFrom; i < r2; i++) {
    const row = m[i] as unknown[];
    for (let j = cFrom; j < c2; j++) row[j] = value;
  }
}

// matrix.concat(id1, id2, dimension="rows") — 두 행렬 결합(새 행렬 반환). dimension="columns"는
// 짧은 쪽 행 수에 맞춰 잘리는 Python `zip()` 시맨틱(python 실측: 3행+1행 결합 시 1행만 반환) —
// JS도 짧은 배열 기준으로 동일하게 잘라 literal port. 기본(rows)은 단순 행 이어붙이기, 열 개수가
// 서로 달라도 검증 없이 그대로 이어붙임(ragged 결과 허용, python 실측 확인). m1/m2 둘 중 하나라도
// null이면 Python `for r in None`이 크래시(미정의) — array.concat(C85)과 동일하게 na(null) 전파.
export function concat(m1: PineMatrix | null, m2: PineMatrix | null, dimension: string = "rows"): PineMatrix | null {
  if (m1 === null || m2 === null) return null;
  if (dimension === "columns") {
    const n = Math.min(m1.length, m2.length);
    const result: PineMatrix = new Array(n);
    for (let i = 0; i < n; i++) result[i] = (m1[i] as unknown[]).concat(m2[i] as unknown[]);
    return result;
  }
  return m1.map((r) => (r as unknown[]).slice()).concat(m2.map((r) => (r as unknown[]).slice()));
}

// matrix.submatrix(id, from_row, to_row, from_column, to_column) — 부분 행렬(새 행렬 반환).
// pine2py 소스에 기본값이 전혀 없다(analyzer.ts 주석 참조, matrix.* 중 유일). `m[from_row:to_row]`
// 후 각 행에 `r[from_column:to_column]` — 둘 다 Python 슬라이싱이고, array.slice(C85)가 이미
// "JS Array.prototype.slice(start,end)는 음수/범위밖 전부 Python 슬라이싱과 ECMA-262 알고리즘
// 수준에서 동치"임을 실증해뒀다(node/python 교차 실측, 이번 사이클도 재확인: 음수/범위밖 조합
// 전부 바이트 단위 일치) — 그대로 위임. NaN 인자는 Python 슬라이스 정수 변환이 크래시하는
// 지점이라 array.slice와 동일하게 na(null) 전파. null 행렬도 `m[nan:...]`류와 동일 계열의
// 미정의 크래시라 na(null) 전파.
export function submatrix(
  m: PineMatrix | null,
  fromRow: number,
  toRow: number,
  fromColumn: number,
  toColumn: number,
): PineMatrix | null {
  if (m === null) return null;
  if (Number.isNaN(fromRow) || Number.isNaN(toRow) || Number.isNaN(fromColumn) || Number.isNaN(toColumn)) return null;
  return m.slice(Math.trunc(fromRow), Math.trunc(toRow)).map((r) => (r as unknown[]).slice(Math.trunc(fromColumn), Math.trunc(toColumn)));
}

// matrix.reshape(id, nr, nc) — 형태 변경(새 행렬 반환). pine2py `flat=[v for r in m for v in r]`
// 후 `flat[i*nc:(i+1)*nc]`(i는 0..nr-1) — 원소 총수가 nr*nc와 달라도 검증 없이 그대로 자르거나
// (모자라면 마지막 행이 짧아지거나 빈 배열) 남는 원소를 버림(python 실측 확인, 별도 보정 없음).
// 이 슬라이스도 submatrix와 동일한 이유로 JS Array.prototype.slice에 그대로 위임 가능(nc<=0/
// 음수 조합까지 포함해 Python 슬라이싱과 동치) — `for(i=0;i<nrInt;i++)`가 nrInt<=0이면 자연히
// 0회 반복돼 range(음수/0)와 동치라 별도 클램프 불필요. NaN nr/nc 또는 null 행렬은 submatrix와
// 동일하게 na(null) 전파.
export function reshape(m: PineMatrix | null, nr: number, nc: number): PineMatrix | null {
  if (m === null) return null;
  if (Number.isNaN(nr) || Number.isNaN(nc)) return null;
  const flat: unknown[] = ([] as unknown[]).concat(...(m as unknown[][]));
  const nrInt = Math.trunc(nr);
  const ncInt = Math.trunc(nc);
  const result: PineMatrix = [];
  for (let i = 0; i < nrInt; i++) result.push(flat.slice(i * ncInt, (i + 1) * ncInt));
  return result;
}

// matrix.reverse(id) — 행 순서 반전(in-place, 반환값 없음). JS Array.prototype.reverse가 Python
// list.reverse()와 동일한 "그 자리에서 뒤집기" 시맨틱이라 그대로 위임(array.reverse(C85)와 동일
// 근거). null 행렬은 Python `None.reverse()`가 크래시(미정의) — "쓰기는 no-op" 원칙.
export function reverse(m: PineMatrix | null): void {
  if (m === null) return;
  m.reverse();
}

// matrix.sort(id, column=0, order=order.ascending) — 특정 열 값 기준 정렬(in-place, 반환값
// 없음). order.ascending/descending은 array.sort(C85)가 이미 확정해둔 boolean 시그니처를 그대로
// 재사용(analyzer.ts/codegen.ts DotAccess 상수 폴딩 인프라 공유, 새 인프라 불필요).
// **array.sort(C85)와 다른 지점(next_hint가 예고한 대로 python 직접 실행으로 재확인 완료)**:
// pine2py `key=lambda r: r[column] if not nan else float('inf')` + `reverse=rev`는 NaN을 +무한대
// 취급하는데, array.sort는 NaN을 "오름/내림차순과 무관하게 항상 끝"으로 강제하지만 matrix.sort는
// **reverse=True(내림차순)일 때 +무한대가 맨 앞으로 온다**(내림차순은 큰 값이 앞이므로) — python
// 실측: 오름차순 [1,2,3,nan], 내림차순 [nan,3,2,1]. 동률 원소의 상대 순서는 Python
// list.sort(reverse=True)가 "오름차순 정렬 후 전체 반전"이 아니라 **키 비교 부호만 뒤집는 진짜
// stable 정렬**이라 동률 원소는 원본 순서를 유지한다(python 실측: [[1,'a'],[1,'b'],[1,'d']]가
// 내림차순에서도 a,b,d 순서 그대로) — JS Array.prototype.sort도 ES2019+ stable이므로 comparator가
// 동률에 0을 반환하기만 하면 자동으로 동일하게 재현된다(별도 안정성 보정 불필요, array.sort와
// 동일 근거). **column 인자의 na/범위밖 처리**: pine2py `r[column]`은 가드가 없어 범위밖/NaN
// column이 IndexError/TypeError로 크래시하지만(python 실측), matrix.get/set/row/col(C90/C91)이
// 이미 확정한 "형제 함수 일관성" 원칙(음수/범위밖 인덱스는 na 통일, literal 우연동작 포트 안 함)을
// 그대로 적용해 유효 범위 밖이면 전체 no-op(sort 자체를 건너뜀 — swap_rows의 "부분 아닌 전체
// no-op"과 동일 원칙). 긍정형 가드(`c>=0 && c<nc`)라 NaN column도 자동으로 이 분기에 걸려 별도
// Number.isNaN 체크 없이 no-op(Pitfalls "긍정형 가드" 원칙).
export function sort(m: PineMatrix | null, column: number = 0, ascending: boolean = true): void {
  if (m === null) return;
  const c = Math.trunc(column);
  const nc = columns(m);
  if (!(c >= 0 && c < nc)) return;
  const key = (r: unknown[]): number => {
    const v = r[c];
    return typeof v === "number" && Number.isNaN(v) ? Infinity : (v as number);
  };
  m.sort((ra, rb) => {
    const a = key(ra as unknown[]);
    const b = key(rb as unknown[]);
    if (a === b) return 0;
    if (ascending) return a < b ? -1 : 1;
    return a > b ? -1 : 1;
  });
}

// matrix.diff(id) — 인접 행 간 원소별 차이(새 행렬 반환, 행 수는 원본-1). pine2py
// `m[i][j]-m[i-1][j]`(i=1..len(m)-1, j는 그 바 행의 길이 기준)를 그대로 이식 — NaN은 산술 뺄셈
// 자체가 IEEE754 전파를 이미 보장해 별도 처리 불필요(rt.pineDiv류의 0-나눗셈 특수 케이스와 달리
// 뺄셈은 안전 연산). null 행렬은 `len(None)`이 크래시(미정의) — na(null) 전파. 행이 1개 이하면
// range(1,len(m))가 공집합이라 빈 배열([])을 반환(literal, 별도 분기 불필요 — JS for 루프도
// m.length<2면 자연히 0회 반복).
export function diff(m: PineMatrix | null): PineMatrix | null {
  if (m === null) return null;
  const result: PineMatrix = [];
  for (let i = 1; i < m.length; i++) {
    const cur = m[i] as unknown[];
    const prev = m[i - 1] as unknown[];
    const row: unknown[] = new Array(cur.length);
    for (let j = 0; j < cur.length; j++) row[j] = (cur[j] as number) - (prev[j] as number);
    result.push(row);
  }
  return result;
}

// ── 구조 검사 (C94: 다섯 번째 슬라이스 — is_square/is_symmetric/is_antisymmetric/is_diagonal/
// is_antidiagonal/is_identity/is_triangular/is_stochastic/is_binary/is_zero 10종) ──
//
// 전부 순수 read-only 술어(뮤테이션 없음, 새 행렬 생성 없음)라 이전 슬라이스들과 달리
// MUTATING_ARRAY_BUILTINS/MATRIX_CONSTRUCTOR_METHODS 등재가 불필요하다(get/rows/columns와
// 동일한 '읽기 전용' 그룹, next_hint 지시대로). python 직접 실행으로 확인한 핵심 경계:
// - is_square: 0행 행렬은 `if m else True`(pine2py)가 rows==columns 비교 자체를 건너뛰고
//   무조건 true — 행이 있는데 열이 0인 행렬(3x0 등)은 이 예외에 안 걸려 일반 비교로 들어가 false.
// - is_symmetric/is_antisymmetric/is_diagonal/is_antidiagonal/is_identity는 전부 "먼저 정사각
//   아니면 false"로 시작(0x0은 is_square=true이므로 n=0 루프가 자동으로 true).
// - is_diagonal/is_antidiagonal/is_symmetric/is_antisymmetric은 **대각 원소 자체를 검사하지
//   않는다**(i==j 위치는 순회에서 제외) — 대각값이 NaN이어도 결과에 영향 없음(python 실측),
//   비대각에 NaN/불일치가 있으면 항상 false로 낙제.
// - is_triangular는 "하단(j<i) 전부 0"(upper) 또는 "상단(j>i) 전부 0"(lower) 중 하나만 만족하면
//   true — 대각선은 검사 안 하고, 통과하는 쪽이 있으면 반대쪽에 NaN이 있어도 true(python 실측).
// - is_stochastic은 is_square를 요구하지 않는다(직사각도 행별 합이 1이면 true) — 0행은 순회할
//   행이 없어 자동 true, 행은 있는데 열이 0인 행은 `sum([])===0`이라 항상 false.
// - is_binary/is_zero는 정사각 여부와 무관, 대각 예외 없이 모든 원소를 검사한다. is_binary는
//   0/1 정확 일치(엡실론 없음), is_zero는 |v|<1e-10 — 둘 다 NaN 원소가 하나라도 있으면 그
//   원소의 비교식이 IEEE754 규칙상 항상 false라 자동으로 전체 false(Pitfalls 긍정형 가드와 동일
//   계열, 별도 na 분기 불필요).
// null(na) 행렬은 pine2py가 `len(None)`/`m[i][j]`류로 크래시하는 미정의 지점 — 반환형이
// boolean이라 array.every/some(#19)이 이미 확립한 "boolean|number 반환, na 입력은 NaN" 관례를
// 그대로 재사용(JS엔 별도 'boolean na' 표현이 없어 숫자 NaN을 그 대역으로 씀).

// pine2py `rows(m) == columns(m) if m else True`의 "정사각 판정" 부분만 분리 — is_symmetric 등
// 나머지 9종이 내부에서 non-null 전제로 재사용(공개 is_square는 null 가드 후 이 헬퍼에 위임).
function isSquareValue(m: PineMatrix): boolean {
  if (m.length === 0) return true;
  return m.length === columns(m);
}

function isUpperTriangular(m: PineMatrix, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const row = m[i] as unknown[];
    for (let j = 0; j < i; j++) {
      if (!(Math.abs(row[j] as number) < 1e-10)) return false;
    }
  }
  return true;
}

function isLowerTriangular(m: PineMatrix, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const row = m[i] as unknown[];
    for (let j = i + 1; j < n; j++) {
      if (!(Math.abs(row[j] as number) < 1e-10)) return false;
    }
  }
  return true;
}

// matrix.is_square(id) — na 행렬은 NaN.
export function is_square(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  return isSquareValue(m);
}

// matrix.is_symmetric(id) — m[i][j] == m[j][i] (i<j 전 쌍, 대각 제외, 1e-10 엡실론).
export function is_symmetric(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  if (!isSquareValue(m)) return false;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const rowI = m[i] as unknown[];
    for (let j = i + 1; j < n; j++) {
      const a = rowI[j] as number;
      const b = (m[j] as unknown[])[i] as number;
      if (!(Math.abs(a - b) < 1e-10)) return false;
    }
  }
  return true;
}

// matrix.is_antisymmetric(id) — m[i][j] == -m[j][i] (i<j 전 쌍, 대각 제외, 1e-10 엡실론).
export function is_antisymmetric(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  if (!isSquareValue(m)) return false;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const rowI = m[i] as unknown[];
    for (let j = i + 1; j < n; j++) {
      const a = rowI[j] as number;
      const b = (m[j] as unknown[])[i] as number;
      if (!(Math.abs(a + b) < 1e-10)) return false;
    }
  }
  return true;
}

// matrix.is_diagonal(id) — 비대각(i!=j) 원소가 전부 0(1e-10 엡실론).
export function is_diagonal(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  if (!isSquareValue(m)) return false;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const row = m[i] as unknown[];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (!(Math.abs(row[j] as number) < 1e-10)) return false;
    }
  }
  return true;
}

// matrix.is_antidiagonal(id) — 반대각(i+j != n-1) 원소가 전부 0(1e-10 엡실론).
export function is_antidiagonal(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  if (!isSquareValue(m)) return false;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const row = m[i] as unknown[];
    for (let j = 0; j < n; j++) {
      if (i + j === n - 1) continue;
      if (!(Math.abs(row[j] as number) < 1e-10)) return false;
    }
  }
  return true;
}

// matrix.is_identity(id) — 대각=1, 비대각=0 (둘 다 1e-10 엡실론).
export function is_identity(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  if (!isSquareValue(m)) return false;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    const row = m[i] as unknown[];
    for (let j = 0; j < n; j++) {
      const expected = i === j ? 1.0 : 0.0;
      if (!(Math.abs((row[j] as number) - expected) < 1e-10)) return false;
    }
  }
  return true;
}

// matrix.is_triangular(id) — 상삼각 또는 하삼각(대각선 자체는 검사 안 함).
export function is_triangular(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  if (!isSquareValue(m)) return false;
  const n = m.length;
  return isUpperTriangular(m, n) || isLowerTriangular(m, n);
}

// matrix.is_stochastic(id) — 행 합이 모두 1(1e-10 엡실론). 정사각 요구 없음(python 실측).
export function is_stochastic(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  for (const r of m) {
    let sum = 0;
    for (const v of r as unknown[]) sum += v as number;
    if (!(Math.abs(sum - 1.0) < 1e-10)) return false;
  }
  return true;
}

// matrix.is_binary(id) — 모든 원소가 정확히 0 또는 1(엡실론 없음).
export function is_binary(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  for (const r of m) {
    for (const v of r as unknown[]) {
      const n = v as number;
      if (!(n === 0 || n === 1)) return false;
    }
  }
  return true;
}

// matrix.is_zero(id) — 모든 원소가 0(1e-10 엡실론).
export function is_zero(m: PineMatrix | null): boolean | number {
  if (m === null) return NaN;
  for (const r of m) {
    for (const v of r as unknown[]) {
      if (!(Math.abs(v as number) < 1e-10)) return false;
    }
  }
  return true;
}

// ── 통계 (C95: 여섯 번째 슬라이스 — sum/avg/min/max/median/mode 6종, 38/49 완료) ──
//
// pine2py matrix.py의 `_flat_valid`(NaN 제외 평탄화) 위에서 갈리는 stateless read-only 통계가
// array.py `_valid_nums` 기반 통계(array.ts C81)와 **로직이 완전히 동일**함을 소스 대조로 확인
// (next_hint 지시대로 착수 전 검증) — sum은 빈 리스트에서도 Python `sum([])==0`(avg/min/max/
// median/mode와 다른 지점, array.sum과 동일한 갈림, DIVERGENCES.md #21 재적용, 새 판단 없음).
// median은 pine2py가 정렬 후 n//2 수동 분기(짝수 개는 가운데 두 값 평균)로 Python
// `statistics.median`과 동치, mode는 `Counter.most_common(1)`(최초 등장값 승 tie-break)로
// `statistics.mode`와 동치 — 둘 다 array.ts median/mode(C81)의 기존 알고리즘 그대로 재사용
// (flatten 1단계만 추가, 새 알고리즘 유도 불필요). na(null) 행렬은 array.*(#19)의 "읽기는 na"
// 원칙 재적용.
function flatValid(m: PineMatrix): number[] {
  const result: number[] = [];
  for (const r of m) for (const v of r as unknown[]) if ((v as number) === (v as number)) result.push(v as number);
  return result;
}

// matrix.sum(id) — 유효 원소 합계. 유효값 0개(전부 na 또는 빈 행렬)도 na가 아니라 0(literal port).
// matrix.sum(id1, id2)(C656, 배치33 (6) argcount 재조사 잔여 3건 중 하나) — 두 행렬의 원소별
// 덧셈(새 행렬 반환). wild f493f6963fd0.pine의 `kso_P := kso_F.mult(kso_P.mult(kso_F.transpose()))
// .sum(kso_Q)`(Kalman 공분산 예측 P=FPF'+Q)가 TV facade 컴파일러 실측 accept(scratch/
// tv_validation/results.jsonl) — pine2py matrix.py에는 1-인자 집계뿐이라 이 오버로드가 없어
// 오라클 구조적 불가(다른 hand-verified 신규 matrix 함수와 동일 클래스). 반환값 자체는 TV
// 미실측(호출이 accept됨만 확인) — 선형대수 표준 의미(elementwise add)로 구현, DIVERGENCES #201
// "TV 미검증(가설)". `+`가 자연히 na(NaN) 전파(CONFIRMED, VERIFIED_SEMANTICS.md)를 재현하므로
// 별도 na 분기 불필요. 차원 불일치(other가 더 작음)는 크래시 대신 NaN로 안전 낙하(GOAL.md 안전
// 연산 원칙, 실제 corpus 사용은 항상 동일 차원).
export function sum(m: PineMatrix | null): number;
export function sum(m: PineMatrix | null, other: PineMatrix | null): PineMatrix | null;
export function sum(m: PineMatrix | null, other?: PineMatrix | null): number | PineMatrix | null {
  if (other === undefined) {
    if (m === null) return NaN;
    let total = 0;
    for (const v of flatValid(m)) total += v;
    return total;
  }
  if (m === null || other === null) return null;
  const result: PineMatrix = new Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const row = m[i] as unknown[];
    const otherRow = other[i] as unknown[] | undefined;
    const outRow: unknown[] = new Array(row.length);
    for (let j = 0; j < row.length; j++) {
      outRow[j] = (row[j] as number) + (otherRow !== undefined ? (otherRow[j] as number) : NaN);
    }
    result[i] = outRow;
  }
  return result;
}

// matrix.avg(id) — 유효 원소 평균. 유효값 0개면 na.
export function avg(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const vals = flatValid(m);
  if (vals.length === 0) return NaN;
  let total = 0;
  for (const v of vals) total += v;
  return total / vals.length;
}

// matrix.min/matrix.max(id) — 유효 원소 최소/최대값. 유효값 0개면 na.
export function min(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const vals = flatValid(m);
  if (vals.length === 0) return NaN;
  let result = vals[0]!;
  for (const v of vals) if (v < result) result = v;
  return result;
}

export function max(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const vals = flatValid(m);
  if (vals.length === 0) return NaN;
  let result = vals[0]!;
  for (const v of vals) if (v > result) result = v;
  return result;
}

// matrix.median(id) — array.median(C81)과 동일 알고리즘(정렬 후 중앙값, 짝수 개는 가운데 두
// 값 평균). 유효값 0개면 na.
export function median(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const vals = flatValid(m).sort((a, b) => a - b);
  if (vals.length === 0) return NaN;
  const mid = vals.length >> 1;
  if (vals.length % 2 === 1) return vals[mid]!;
  return (vals[mid - 1]! + vals[mid]!) / 2;
}

// matrix.mode(id) — array.mode(C81)와 동일 알고리즘(등장 순서 보존 Map, 동률이면 최초 등장값
// 승). 유효값 0개면 na.
export function mode(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const vals = flatValid(m);
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

// ── 행렬 대수 (C96: 일곱 번째 슬라이스 — transpose, 행렬 대수 11종의 첫 항목, 38/49 -> 39/49) ──
//
// pine2py wavealgo/ta/matrix.py의 `if not m: return []`는 None과 0행 리스트를 파이썬 falsy로
// 함께 잡아 둘 다 빈 배열을 반환한다(python 직접 실행 실측: transpose(None)==transpose([])==[]) —
// matrix.col(#31)의 "0행이면 index 무관 항상 []"과 동일 급의 잘 정의된(크래시 아닌) 동작이라
// na(null) 전파가 아니라 literal port(빈 배열 반환, PROGRESS 참조). 열이 0개인 행렬(rows=3,
// columns=0, `[[],[],[]]`)은 `not m`엔 안 걸리지만 nc=columns(m)=0이라 결과 루프가 0회 실행돼
// 똑같이 []에 수렴함을 python 직접 실행으로 확인(별도 분기 불필요, m.length===0 체크 하나로
// 두 케이스 모두 커버됨).

// matrix.transpose(id) — 전치 행렬(새 행렬 반환).
export function transpose(m: PineMatrix | null): PineMatrix {
  if (m === null || m.length === 0) return [];
  const nc = (m[0] as unknown[]).length;
  const result: PineMatrix = new Array(nc);
  for (let c = 0; c < nc; c++) {
    const newRow: unknown[] = new Array(m.length);
    for (let r = 0; r < m.length; r++) newRow[r] = (m[r] as unknown[])[c];
    result[c] = newRow;
  }
  return result;
}

// matrix.mult(id1, id2) — 행렬×스칼라/벡터/행렬 3분기(C97, 행렬 대수 11종의 두 번째 항목,
// 39/49 -> 40/49). matrix.* 중 유일하게 **반환 컨테이너 타입이 두 번째 인자의 타입에 따라
// 갈리는** 함수라(스칼라/행렬 인자 -> matrix, 벡터 인자 -> array) analyzer.ts가 메서드 이름만
// 보고 정하는 기존 MATRIX_CONSTRUCTOR_METHODS 패턴을 못 쓰고 별도 분류 함수(classifyMultResult)를
// 둔다(analyzer.ts 주석 참조).
//
// pine2py mult()의 분기 순서를 python 직접 실행으로 실측(scratch 없이 인터프리터 직접 호출):
// (1) other가 int/float(Python `isinstance(nan, float)`가 True라 na 스칼라도 이 분기로 들어감,
//     실측: mult(m, nan) == 전 원소가 nan인 행렬 — literal port) -> 스칼라 곱.
// (2) other가 비어있지 않고 other[0]이 list가 아니면(Python은 빈 리스트가 falsy라 `other`
//     truthy 체크에서 이미 걸러짐, 실측: mult(m, []) -> IndexError 크래시, 빈 벡터가 스칼라
//     분기가 아니라 (3)의 행렬 분기로 새어 크래시함을 확인) -> 벡터(각 행과 내적).
// (3) 그 외(other가 행렬) -> 표준 행렬곱.
// m===null/other===null/other가 빈 배열(빈 벡터·빈 행렬 구분 불가라 어느 쪽으로도 잘 정의될 수
// 없는 degenerate 입력)은 pine2py가 전부 크래시하는 미정의 지점(실측: mult(None,5)/mult(m,None)/
// mult(m,[]) 전부 TypeError/IndexError) — na(null) 전파로 대체(기존 크래시 회피 원칙 재적용,
// DIVERGENCES 신규). 차원 불일치(m의 행이 other의 행/벡터 길이보다 짧음)는 pine2py라면
// IndexError지만, JS는 배열 밖 접근이 `undefined * number` = NaN으로 자연 전파돼 별도 가드 없이
// 크래시를 피한다(node 직접 실행으로 mat*mat/mat*vec/mat*scalar 정상값과 rectangular 비정사각
// 조합까지 pine2py 수치와 일치 확인 완료, mismatch 조합은 pine2py CRASH 대비 JS는 NaN 반환 —
// 실사용에 없는 완전 degenerate 입력이라 hand-verified로만 확인).
export function mult(
  m: PineMatrix | null,
  other: PineMatrix | unknown[] | number | null,
): PineMatrix | unknown[] | null {
  if (m === null || other === null) return null;
  if (typeof other === "number") {
    return m.map((r) => (r as unknown[]).map((v) => (v as number) * other));
  }
  const arr = other as unknown[];
  if (arr.length === 0) return null;
  if (!Array.isArray(arr[0])) {
    const result: unknown[] = new Array(m.length);
    for (let i = 0; i < m.length; i++) {
      const row = m[i] as unknown[];
      let s = 0;
      for (let j = 0; j < arr.length; j++) s += (row[j] as number) * (arr[j] as number);
      result[i] = s;
    }
    return result;
  }
  const mat = arr as unknown[][];
  const nc = (mat[0] as unknown[]).length;
  const k = mat.length;
  const result: PineMatrix = new Array(m.length);
  for (let i = 0; i < m.length; i++) {
    const row = m[i] as unknown[];
    const outRow: unknown[] = new Array(nc);
    for (let j = 0; j < nc; j++) {
      let s = 0;
      for (let p = 0; p < k; p++) s += (row[p] as number) * ((mat[p] as unknown[])[j] as number);
      outRow[j] = s;
    }
    result[i] = outRow;
  }
  return result;
}

// matrix.det(id) — 행렬식(det, C98, 행렬 대수 11종의 세 번째 항목, 40/49 -> 41/49). pine2py
// det()의 n=0(0.0)/n=1(m[0][0])/n=2(공식)/n>=3(Gaussian elimination, pivot 탐색+행 교환 시
// sign*=-1) 4분기를 literal port. python 직접 실행으로 확인한 경계:
// (a) singular(피벗 열 전체가 0) — pivotRow를 못 찾으면 크래시가 아니라 즉시 0.0을 반환하는
//     잘 정의된 동작(예: 행이 선형종속인 3x3도 소거 과정에서 마지막 대각이 0으로 수렴해 동일하게
//     0.0). pivotRow===-1이면 즉시 0 반환.
// (b) NaN 원소 — pivot 탐색의 `!= 0`(python)/`!== 0`(JS) 비교는 NaN과 비교하면 둘 다 "같지
//     않음"이 true라(`nan != 0`=True, `NaN !== 0`=true) 언어에 상관없이 동일하게 NaN을 유효
//     피벗으로 오인한다(divergence 아님) — 이후 모든 산술에 NaN이 섞여 결과가 NaN으로 수렴.
//     NaN이 col=0의 첫 후보(오인된 피벗)에 있는 경우/피벗이 아닌 다른 행에 있는 경우 둘 다
//     python 실측으로 NaN 확인(oracle H/I 그룹이 두 경로를 각각 검증).
// (c) 비정사각 — rows<columns(n=len(m)이 columns보다 작음, 예 2x3)는 여분 열을 아예 안 건드려
//     python도 JS도 왼쪽 nxn 부분행렬의 행렬식을 그대로 반환(literal port로 자동 일치, 실측
//     -3.0 == -3 확인, oracle J 그룹). rows>columns(예 3x2)는 python이 열 범위를 넘는 인덱스
//     접근으로 IndexError 크래시하지만, JS는 배열 밖 접근이 undefined로 읽히고 `undefined!==0`이
//     true라 그 값이 그대로 피벗으로 오인된 뒤 이후 모든 산술에 undefined가 섞여 최종 곱셈에서
//     자연히 NaN으로 수렴한다(mult(C97)의 "JS 배열의 관대함이 우연히 크래시를 피한다" 원칙과
//     동일 계열이라 별도 가드 불필요, node scratch로 확인 — runtime.test.ts hand-verified).
// m===null은 pine2py가 TypeError로 크래시하는 미정의 지점 — sum/avg/min/max 등 스칼라 반환
// matrix.* 함수와 동일하게 "읽기는 na" 원칙으로 NaN 반환. 유일한 예외는 m=[[]](1행 0열, n=1
// 분기)인데, python은 m[0][0] IndexError로 크래시하지만 JS `m[0][0]`은 크래시 없이 undefined를
// 그대로 반환해버린다(n=1 분기만 산술식이 아니라 값을 그대로 return하는 유일한 지점이라 (c)의
// 자연 NaN 수렴 경로가 없음) — GOAL.md na 3분할 규약상 숫자 na는 반드시 NaN이어야 하므로
// Number() 캐스팅으로 undefined -> NaN을 명시 보정(n=2/Gaussian은 이미 산술식 안이라 자동으로
// NaN 수렴, 캐스팅 불필요, runtime.test.ts hand-verified).
export function det(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const n = m.length;
  if (n === 0) return 0.0;
  if (n === 1) return Number((m[0] as unknown[])[0]);
  if (n === 2) {
    const r0 = m[0] as unknown[];
    const r1 = m[1] as unknown[];
    return (r0[0] as number) * (r1[1] as number) - (r0[1] as number) * (r1[0] as number);
  }
  const mat: unknown[][] = m.map((r) => (r as unknown[]).slice());
  let sign = 1;
  for (let col = 0; col < n; col++) {
    let pivotRow = -1;
    for (let r = col; r < n; r++) {
      if (((mat[r] as unknown[])[col] as number) !== 0) {
        pivotRow = r;
        break;
      }
    }
    if (pivotRow === -1) return 0;
    if (pivotRow !== col) {
      const tmp = mat[col] as unknown[];
      mat[col] = mat[pivotRow] as unknown[];
      mat[pivotRow] = tmp;
      sign *= -1;
    }
    for (let r = col + 1; r < n; r++) {
      if (((mat[col] as unknown[])[col] as number) === 0) continue;
      const factor = ((mat[r] as unknown[])[col] as number) / ((mat[col] as unknown[])[col] as number);
      for (let c = col; c < n; c++) {
        const row = mat[r] as unknown[];
        row[c] = (row[c] as number) - factor * ((mat[col] as unknown[])[c] as number);
      }
    }
  }
  let result = sign;
  for (let i = 0; i < n; i++) result *= (mat[i] as unknown[])[i] as number;
  return result;
}

// matrix.trace(id) — 대각합(trace, C99, 행렬 대수 11종의 네 번째 항목, 41/49 -> 42/49). pine2py
// trace()는 `sum(m[i][i] for i in range(min(len(m), len(m[0]) if m else 0)))` — min(rows,columns)
// 상한까지만 순회하는 단순 대각합이라 det의 Gaussian elimination과 완전히 무관, 비정사각도
// 크래시 없음(python 직접 실행으로 확인: rows<columns/rows>columns 둘 다 왼쪽-위 min(nr,nc)
// 정사각 부분의 대각만 합산). **C98 next_hint 정정**: next_hint는 "m===None도 `if m else 0`
// 분기로 크래시 없이 0을 반환"이라 예상했으나 실제로는 min()의 첫 인자가 `len(m)`으로 삼항 가드
// *앞*에서 무조건 평가돼(`len(m[0]) if m else 0`은 두 번째 인자일 뿐) m=None에서 `len(None)`이
// TypeError로 즉시 크래시함을 python 직접 실행으로 확인(MEMORY.md Pitfalls "next_hint도 틀릴 수
// 있다" 재확인 사례) — m=[](0행)만 `len(m)=0`이라 크래시 없이 0을 반환, m===None과 m=[]가 서로
// 다른 코드 경로였다. m=[[]](1행0열)는 nc=len(m[0])=0이라 min(1,0)=0으로 크래시 없이 0(python
// 실측 확인, det의 m=[[]] 크래시와 대조적이라는 next_hint (b) 예상이 적중 — trace는 n=1 분기처럼
// 값을 그대로 return하는 지점이 없어 undefined 누출 위험 자체가 없음). 대각에 na 원소가 있으면
// Python sum()이 NaN을 그대로 통과시켜 전체 na로 수렴(python 실측 확인, next_hint (c) 적중) — JS
// Number 덧셈도 NaN 전파가 IEEE754 공통 규칙이라 별도 분기 불필요. 비대각 na는 애초에 순회 대상이
// 아니라 결과에 전혀 영향 없음(is_symmetric류(C94)의 "대각 무관 술어"와 반대로, trace는 "비대각
// 무관" — 두 계열이 서로 거울상). m===null 자체는 pine2py가 크래시하는 지점이지만, det/sum/avg
// 등 스칼라 반환 matrix.* 함수 전체가 이미 "읽기는 na" 원칙(m===null이면 무조건 NaN)으로
// 통일돼 있어 pine2py의 개별 크래시/논크래시 여부와 무관하게 그대로 재적용(det(C98)와 동일 근거).
export function trace(m: PineMatrix | null): number {
  if (m === null) return NaN;
  const nr = m.length;
  const nc = nr > 0 ? (m[0] as unknown[]).length : 0;
  const n = Math.min(nr, nc);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (m[i] as unknown[])[i] as number;
  return sum;
}

// pine2py `rows(m) == columns(m)` 정사각 판정 — is_square의 isSquareValue와 동일 로직이지만
// 이 파일 안 위치 순서상(is_square는 아래쪽 구조검사 섹션) 여기서 독립적으로 재정의한다(inv가
// 먼저 필요, 중복은 사소해 공유 헬퍼로 승격하지 않음 — 함수 1개짜리 로직이라 추출 이득 없음).
function isSquareMatrix(m: PineMatrix): boolean {
  if (m.length === 0) return true;
  return m.length === (m[0] as unknown[]).length;
}

// matrix.inv(id) — 역행렬(Gauss-Jordan, C100, 열한 번째 슬라이스 — 행렬 대수 11종의 다섯 번째
// 항목, 42/49 -> 43/49). pine2py inv()는 `n=len(m)`(rows 수)만으로 항등행렬 크기를 정해 아예
// 정사각 전제를 검증하지 않는다 — python 직접 실행으로 경계 실측(scratch/probe_inv.mjs로 JS
// literal port와 교차 검증):
// (a) singular(피벗 열 전체가 정확히 0) — pine2py는 `raise ValueError("Matrix is singular")`로
//     명시적 크래시(det의 "잘 정의된 0.0 반환"과 다른 지점 — det는 결과가 0이라는 사실 자체가
//     이미 유효한 답이지만, inv는 애초에 존재하지 않는 역행렬을 만들어야 해서 예외를 던진다).
//     pine2js는 예외를 던지지 않는 아키텍처라 na(null, matrix 반환이라 참조형)로 대체 — det/mult
//     등이 이미 확립한 "pine2py 크래시 지점은 na로 흡수" 원칙의 재적용(DIVERGENCES.md #37).
// (b) n=1 — det(C98)와 달리 `return m[0][0]`처럼 값을 그대로 반환하는 지점이 없다. n=1도
//     Gauss-Jordan 루프를 그대로 통과해(aug=[[m[0][0], 1.0]] -> 나눗셈으로 정규화) 항상 산술식
//     결과를 반환하므로 undefined-leak 위험 자체가 없다(python 실측: inv([[2.0]])==[[0.5]],
//     Number() 캐스팅 불필요 — det의 함정이 inv엔 재발하지 않음을 실행으로 확인).
// (c) 비정사각 — python 직접 실행으로 실측한 결과 rows>columns(예 3x2)는 증강 폭
//     (columns+n)이 소거에 필요한 2n보다 좁아 IndexError로 크래시하지만, rows<columns(예 2x3)는
//     크래시하지 않고 "그럴듯해 보이지만 수학적으로 무의미한" 값을 반환한다(원본 데이터 열 일부가
//     항등행렬 자리로 오인되거나 반대로 항등행렬 일부가 누락된 채 뒤섞임 — det의 "왼쪽 nxn
//     부분행렬 det를 그대로 반환"처럼 독립적으로 의미가 있는 결과가 전혀 아니다, 두 코드 경로
//     모두 알고리즘이 애초에 정사각을 전제하는 데서 오는 부수적 사고이지 설계된 동작이 아님).
//     GOAL.md "pine2py의 알려진 버그는 따르지 않는다"를 적용해 이번엔 JS의 "관대함"에 기대는
//     대신(mult/det처럼 undefined 자연 전파로 크래시만 피하는 것과 달리, 결과 자체가 수학적으로
//     틀렸으므로 자연 전파에 맡겨선 안 됨) isSquareMatrix 가드를 명시적으로 앞단에 추가해
//     비정사각이면 크래시 여부와 무관하게 일괄 na(null)로 통일(DIVERGENCES.md #37, TV 미검증
//     "가설" — inv는 수학적으로 정사각에서만 정의되므로 TV도 비정사각 입력에 런타임 에러를 낼
//     것이라는 추정이지만 1차 소스로 검증되지 않았음).
// m===null은 다른 matrix.* 생성자류(mult/concat/submatrix 등)와 동일하게 na(null) 전파.
// n=0(m=[])은 pine2py가 크래시 없이 빈 리스트를 반환하는 잘 정의된 동작(python 실측) —
// isSquareMatrix([])===true이므로 자연히 루프 0회 통과해 []를 반환(literal, 별도 분기 불필요).
export function inv(m: PineMatrix | null): PineMatrix | null {
  if (m === null) return null;
  if (!isSquareMatrix(m)) return null;
  const n = m.length;
  const aug: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = m[i] as unknown[];
    const r = new Array(2 * n);
    for (let j = 0; j < n; j++) r[j] = row[j] as number;
    for (let j = 0; j < n; j++) r[n + j] = i === j ? 1.0 : 0.0;
    aug[i] = r;
  }
  for (let col = 0; col < n; col++) {
    let pivot = -1;
    for (let r = col; r < n; r++) {
      if (aug[r]![col] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot === -1) return null;
    const tmp = aug[col]!;
    aug[col] = aug[pivot]!;
    aug[pivot] = tmp;
    const d = aug[col]![col]!;
    for (let c = 0; c < 2 * n; c++) aug[col]![c] = aug[col]![c]! / d;
    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const factor = aug[r]![col]!;
        for (let c = 0; c < 2 * n; c++) aug[r]![c] = aug[r]![c]! - factor * aug[col]![c]!;
      }
    }
  }
  return aug.map((r) => r.slice(n));
}

// matrix.rank(id) — 랭크(Gauss-Jordan 소거 후 유효 pivot 개수, C101, 열두 번째 슬라이스 —
// 행렬 대수 11종의 여섯 번째 항목, 43/49 -> 44/49). pine2py rank()(matrix.py L265-290)는 inv와
// 골격은 같은 Gauss-Jordan이지만 세 가지가 근본적으로 다르다(python 직접 실행 + fuzz 3,000샘플로
// scratch/probe_rank.mjs 사전 검증 완료, 전부 일치):
// (a) `if not m: return 0`가 **m===None도** Python truthy 규칙(`not None`==True)으로 정상 걸러
//     크래시 없이 0을 반환(det/trace/inv와 정반대 — 저 셋은 m===null에서 pine2py 자체가
//     크래시하는 미정의 지점이라 "읽기는 na" 정책으로 NaN을 채워 넣은 것이지만, rank는 pine2py가
//     이미 well-defined 0을 반환하므로 그 값을 literal port하는 것이 맞다. na 정책은 "크래시
//     지점을 pine2js가 대신 결정하는" 경우에만 적용되고, pine2py가 이미 정의해둔 값이 있으면
//     그대로 따른다 — MEMORY.md 참조).
// (b) pivot 판정이 det/inv의 `!=0`(NaN도 "다르다"=true라 유효 피벗으로 오인)과 정반대로
//     `abs(v)>1e-10`(양성 임계값 비교, NaN에서 항상 false)라 NaN이 있는 열은 "비유효 pivot"으로
//     건너뛰어(continue) rank를 오히려 낮춘다(det/inv의 "NaN이 전체를 오염" 방향과 반대).
// (c) 정사각을 전제하지 않는다(pivot 탐색이 열 단위라 rows/columns 수가 달라도 자연히 안전) —
//     isSquareMatrix 가드 불필요, inv와 달리 비정사각도 오라클로 그대로 트리거 가능.
// m=[](0행)/m=[[]](1행0열)은 각각 `not m`/`range(nc=0)` 공회전으로 크래시 없이 0.
export function rank(m: PineMatrix | null): number {
  if (m === null || m.length === 0) return 0;
  const mat: unknown[][] = m.map((row) => (row as unknown[]).slice());
  const nr = mat.length;
  const nc = (mat[0] as unknown[]).length;
  let r = 0;
  for (let col = 0; col < nc; col++) {
    let pivot = -1;
    for (let i = r; i < nr; i++) {
      if (Math.abs((mat[i] as unknown[])[col] as number) > 1e-10) {
        pivot = i;
        break;
      }
    }
    if (pivot === -1) continue;
    const tmp = mat[r]!;
    mat[r] = mat[pivot]!;
    mat[pivot] = tmp;
    const d = (mat[r] as unknown[])[col] as number;
    for (let c = 0; c < nc; c++) (mat[r] as unknown[])[c] = ((mat[r] as unknown[])[c] as number) / d;
    for (let i = 0; i < nr; i++) {
      if (i !== r && Math.abs((mat[i] as unknown[])[col] as number) > 1e-10) {
        const factor = (mat[i] as unknown[])[col] as number;
        for (let c = 0; c < nc; c++) {
          (mat[i] as unknown[])[c] = ((mat[i] as unknown[])[c] as number) - factor * ((mat[r] as unknown[])[c] as number);
        }
      }
    }
    r++;
  }
  return r;
}

// matrix.pow(id, exponent) — 행렬 거듭제곱(C102, 열세 번째 슬라이스 — 행렬 대수 11종의 일곱 번째
// 항목, 44/49 -> 45/49). pine2py pow()는 identity를 시드로 square-and-multiply(반복제곱, e=abs(
// exponent)를 2로 나누며 축소)를 수행하고, exponent<0이면 그 반복제곱이 전부 끝난 뒤 **맨 마지막에
// 한 번만** result=inv(result)를 적용한다 — 이미 완료된 rt.matrix.mult(C97)/rt.matrix.inv(C100)를
// 새 알고리즘 유도 없이 그대로 재호출하는 합성(hma/linreg/stoch/cog/tsi류 "이미 구현된 TA/행렬 함수
// 합성" 원칙의 matrix.* 첫 적용 사례). inv를 먼저 구해 거듭제곱하는 순서(수학적으로는 (A^-1)^n =
// (A^n)^-1로 동치)가 아니라 pine2py의 실제 연산 순서를 literal port(부동소수점 반올림 순서가 달라
// byte-level 골든이 갈릴 수 있음, C36/C41의 "부동소수점 캔슬레이션" 교훈과 같은 급).
//
// python 직접 실행 + node fuzz 5,000샘플(scratch/gen_pow_cases.mjs+compare_pow_fuzz.mjs, 정사각
// 2x2/3x3 + 정수 지수 -4..4 + 10% NaN 임베딩, 전부 1e-9 이내 일치)로 착수 전 검증한 핵심 경계:
// (a) exponent가 NaN이면 `e=abs(NaN)=NaN`이라 `while(e>0)` 자체가 python/JS 둘 다 NaN 비교가
//     항상 false라 즉시 통과(별도 분기 불필요) — identity를 그대로 반환(m의 값과 무관, 착수 전
//     next_hint 우려가 자동으로 해소되는 사례).
// (b) exponent===0은 루프가 0회 실행돼 identity 그대로 반환 — m이 na를 포함해도 결과는 항상 순수
//     identity(python 실측 확인, next_hint 적중).
// (c) exponent가 정수가 아닌 float(예 2.5)여도 별도 캐스팅 없이 `e%2===1`/`Math.floor(e/2)`가
//     python `e%2==1`/`e//=2`와 동일하게 동작해(fuzz로 확인) 정수 부분만 반영된 거듭제곱으로
//     자연히 수렴(literal port, 별도 trunc 불필요).
// (d) **새 isSquareMatrix 가드(inv(C100)와 동일 결정, DIVERGENCES.md #37 확장)**: pine2py pow()는
//     `n=len(m)`(rows 수)만으로 identity 크기를 정해 정사각을 전혀 검증하지 않는다 — python 직접
//     실행 결과 비정사각 입력에서 crash 여부가 exponent의 홀/짝 및 "마지막에 계산된 base가 실제로
//     쓰이는지"에 따라 불규칙하게 갈렸다(예: 3x2 행렬은 exponent=0만 크래시 없음, exponent=1도
//     내부에서 무조건 실행되는 `base=mult(base,base)`가 크래시하지만 그 결과가 버려지는 것과
//     무관하게 예외가 먼저 터짐 — 반면 2x3 행렬은 exponent=-1에서 크래시 없이 "그럴듯해 보이지만
//     수학적으로 무의미한" 값을 반환, inv(C100)가 비정사각에서 이미 확인한 것과 동일 현상). JS는
//     undefined 산술의 관대함 때문에 이 불규칙성이 또 다르게 갈려(크래시 없이 NaN 오염되거나, 심지어
//     사용되지 않는 제곱 결과 덕분에 우연히 "올바른" 값까지 나옴) 이중으로 예측 불가능함을 실측
//     확인했다 — inv와 동일한 "정사각을 전제하는 알고리즘은 비정사각에서 독립적 의미가 없다" 원칙을
//     그대로 적용해 크래시 여부와 무관하게 비정사각은 일괄 na(null)로 통일(TV 미검증 "가설").
// m===null은 다른 matrix.* 생성자류(mult/inv/concat 등)와 동일하게 na(null) 전파.
export function pow(m: PineMatrix | null, exponent: number): PineMatrix | null {
  if (m === null) return null;
  if (!isSquareMatrix(m)) return null;
  const n = m.length;
  let result: PineMatrix = new Array(n);
  for (let i = 0; i < n; i++) {
    const row: unknown[] = new Array(n).fill(0.0);
    row[i] = 1.0;
    result[i] = row;
  }
  let base: PineMatrix = m.map((r) => (r as unknown[]).slice());
  let e = Math.abs(exponent);
  while (e > 0) {
    if (e % 2 === 1) result = mult(result, base) as PineMatrix;
    base = mult(base, base) as PineMatrix;
    e = Math.floor(e / 2);
  }
  if (exponent < 0) result = inv(result) as PineMatrix;
  return result;
}

// matrix.kron(id1, id2) — 크로네커 곱(C103, 열네 번째 슬라이스 — 행렬 대수 11종의 여덟 번째 항목,
// 45/49 -> 46/49). pine2py kron()(matrix.py L310-320)은 mult/pow(C97/C102)처럼 이미 구현된
// 함수를 재호출하는 합성이 아니라 새 알고리즘(단 4중 루프뿐, 상태 없는 순수 함수) —
// r1,c1=len(m1),len(m1[0]) / r2,c2=len(m2),len(m2[0])로 결과 크기(r1*r2 x c1*c2)를 정한 뒤
// result[i*r2+p][j*c2+q]=m1[i][j]*m2[p][q]. mult처럼 반환 타입이 인자에 따라 갈리지 않고 항상
// matrix 고정, 결과 크기가 두 인자 모두에 의존하는 첫 matrix.* 이항 함수.
//
// python 직접 실행 + node fuzz 3,000샘플(scratch/gen_kron_cases.mjs+compare_kron_fuzz.mjs, 크기
// 1~3 x 1~3 + 10% NaN 임베딩, 전부 1e-9 이내 일치)로 착수 전 크래시 경계 실측:
// (a) m1===null/m2===null — pine2py `len(None)` TypeError로 즉시 크래시(det/mult/inv 등이 이미
//     확립한 "크래시 지점은 na로 흡수" 원칙 재적용) -> na(null).
// (b) m1/m2가 0행(`[]`) — `len(m1[0])`가 `m1[0]` 자체 IndexError로 크래시(python 실측). **이번엔
//     JS도 동일하게 크래시한다**(node 직접 실행 확인) — mult/pow/det가 반복 확인해온 "JS의 undefined
//     산술 관대함이 우연히 크래시를 피한다" 패턴이 여기선 성립하지 않는다: c1/c2를 구하는 연산이
//     산술식(`x*y`)이 아니라 프로퍼티 접근(`m1[0].length`)이라 `undefined.length`가 JS에서도 즉시
//     TypeError이기 때문(자연 NaN 전파 경로 자체가 없음) — python과 동일하게 na(null)로 흡수.
// (c) m1/m2가 0열(`[[]]`, 1행0열) — `not m`엔 안 걸리고(1행 있음) `len(m1[0])`도 `[]`의 len=0이라
//     크래시 없이 well-defined `[[]]`(결과 행 수는 r1*r2, 각 행은 c1*c2=0열) 반환(python/JS 둘 다
//     확인) — literal port, 별도 분기 불필요(길이 0 배열이 자연히 빈 행으로 채워짐).
// na-embedded 원소는 곱셈(`v1*v2`)이 자동으로 NaN 전파(별도 분기 불필요).
export function kron(m1: PineMatrix | null, m2: PineMatrix | null): PineMatrix | null {
  if (m1 === null || m2 === null) return null;
  if (m1.length === 0 || m2.length === 0) return null;
  const r1 = m1.length;
  const c1 = (m1[0] as unknown[]).length;
  const r2 = m2.length;
  const c2 = (m2[0] as unknown[]).length;
  const result: PineMatrix = new Array(r1 * r2);
  for (let k = 0; k < r1 * r2; k++) result[k] = new Array(c1 * c2).fill(0.0);
  for (let i = 0; i < r1; i++) {
    const row1 = m1[i] as unknown[];
    for (let j = 0; j < c1; j++) {
      const v1 = row1[j] as number;
      for (let p = 0; p < r2; p++) {
        const row2 = m2[p] as unknown[];
        const outRow = result[i * r2 + p] as unknown[];
        for (let q = 0; q < c2; q++) {
          outRow[j * c2 + q] = v1 * (row2[q] as number);
        }
      }
    }
  }
  return result;
}

// matrix.pinv(id) — Moore-Penrose 유사역행렬(C104, 열다섯 번째 슬라이스 — 행렬 대수 11종의 아홉
// 번째 항목, 46/49 -> 47/49). pine2py pinv()(matrix.py L323-329)는 `mt=transpose(m)` 후
// `mult(mt, inv(mult(m, mt)))`(오른쪽 유사역행렬 공식)를 시도하고, `inv` 내부에서
// ValueError(singular)가 나면 except로 `mult(inv(mult(mt, m)), mt)`(왼쪽 유사역행렬 공식)로
// 대체한다 — 새 알고리즘 유도 없이 이미 구현된 rt.matrix.mult(C97)/rt.matrix.inv(C100)/
// rt.matrix.transpose(C96)를 그대로 재호출하는 합성(hma/linreg/stoch/cog/tsi/pow류 원칙의
// matrix.* 재적용, C102 next_hint 예고대로). pine2js는 예외를 던지지 않는 아키텍처(GOAL.md)라
// try/except를 재현하지 않고, inv가 singular에서 이미 null을 반환하므로(C100) "mult(mt,inv(...))가
// null이면 formula2로 폴백"하는 조건 분기로 대체 — 별도 null 가드 코드가 필요 없다: m===null이면
// transpose(null)=[](C96, literal port)를 거쳐도 mult(null, [])가 최상단에서 즉시 null을
// 반환(C97)하고, 그 null이 inv/mult 체인을 그대로 관통해 최종 결과도 null로 자연 수렴한다(m=[]/
// m=[[]]도 동일 경로, python 직접 실행 결과 이 셋 전부 IndexError로 크래시하는 미정의 지점이라 na
// 흡수 원칙과 일치).
//
// python 직접 실행 + node fuzz 666케이스(scratch/gen_pinv_cases.mjs+compare_pinv_fuzz.mjs, 정사각/
// 와이드/톨 각 형태 60트라이얼 + 명시적 특이/degenerate 6종, 10% NaN 임베딩)로 착수 전 전수 검증
// (전부 일치, crashAbsorbed=6). **핵심 발견**: rank(AA^T)=rank(A^TA)=rank(A) 항등식은 수학적으로
// 항상 성립하지만, Gauss-Jordan의 정확-0 pivot 판정(`!==0`)은 "일반적인"(행 사이에 구조적 관계가
// 없는) 톨/와이드 행렬에서는 부동소수점 나눗셈 잔차 때문에 이 이론적 특이성을 검출하지 못한다
// (bar-derived 톨/와이드 행렬은 실측으로 매번 formula1 성공, oracle B그룹 참조) — 오직 행 사이에
// **명시적** 정확 스칼라배 관계(리터럴로 구성, 나눗셈 없이 곱셈/뺄셈만으로 정확히 0에 도달)가 있을
// 때만 폴백(formula2)이 실제로 트리거된다(oracle F그룹, `[[1,2],[2,4],[3,5]]`). 정사각 특이/랭크
// 결핍 행렬은 두 공식 모두 같은 이유로 실패해(rank(A)<n이면 AA^T/A^TA 둘 다 특이) 크래시하는
// 미정의 지점 — na 흡수, 오라클 트리거 불가(runtime.test.ts hand-verified 대체). 정의상 비정사각도
// 다루는 함수라 inv/pow(C100/C102)와 반대로 isSquareMatrix 가드는 불필요(python 직접 실행으로
// rows!=columns 케이스가 크래시가 아니라 정상 계산됨을 확인).
export function pinv(m: PineMatrix | null): PineMatrix | null {
  const mt = transpose(m);
  const c1 = mult(mt, inv(mult(m, mt) as PineMatrix | null)) as PineMatrix | null;
  if (c1 !== null) return c1;
  return mult(inv(mult(mt, m) as PineMatrix | null), mt) as PineMatrix | null;
}

// matrix.eigenvalues(id) — 고유값(C105, 열여섯 번째 슬라이스 — 행렬 대수 11종의 열 번째 항목,
// 47/49 -> 48/49). pine2py eigenvalues()(matrix.py L332-348)의 docstring/주석("2x2 신뢰, 큰 행렬은
// 근사"/"QR iteration for larger matrices (simplified)")은 반복/수렴 알고리즘을 암시하지만
// **실제 코드는 완전 closed-form**(C104 next_hint가 미리 확인해둔 대로, 실행 흐름은 항상 소스
// 자체로 재확인할 것 — MEMORY.md Pitfalls "주석이 아니라 실행되는 코드를 볼 것" 재확인 사례):
// n=1은 m[0][0] 그대로, n=2는 trace/det로 판별식(disc=tr^2-4*det) 계산 후 disc>=0이면
// [(tr+sqrt(disc))/2, (tr-sqrt(disc))/2], disc<0(복소 고유값)이면 허수부를 버리고 [tr/2, tr/2]
// 중복 반환(TV 미검증 "가설"로 literal port — pine2py가 복소수 미지원이라 실수부만 남기는 의도적
// 근사, VERIFIED_SEMANTICS.md에 해당 없음), n>=3은 주석과 무관하게 그냥 대각 원소를 그대로
// 반환(`[m[i][i] for i in range(n)]`, QR iteration이 전혀 아니고 수학적으로 틀린 근사이지만
// 결정론적 코드 3줄).
//
// python 직접 실행(standalone matrix.py import) + node fuzz 487케이스(scratch/
// gen_eigenvalues_cases.mjs+compare_eigenvalues_fuzz.mjs, 정사각 n=1~5 각 60트라이얼 + 비정사각
// rows<columns/rows>columns 6개 조합 각 30트라이얼 + 8% NaN 임베딩 + disc==0/disc<0 명시 케이스)로
// 착수 전 전수 검증 — 전부 일치(mismatches=0, crashAbsorbed=92, JS는 단 한 번도 throw 안 함).
// 핵심 경계:
// (a) m===null — pine2py `len(None)` TypeError로 크래시(미정의) — 반환형이 array(참조형)라 det/
//     trace/rank의 "읽기는 na"(NaN, 스칼라)와 달리 na(null)로 흡수(row/col(#31)과 동일 반환형 원칙).
// (b) n=1 분기(`m[0][0]` 그대로 반환) — det(C98) n=1과 동일한 함정: m=[[]](1행0열)에서 python은
//     IndexError로 크래시하지만 JS `m[0][0]`은 undefined를 그대로 반환해버려(값을 그대로 return하는
//     유일한 지점) na 3분할 규약 위반 위험 — det과 동일하게 Number() 캐스팅으로 명시 보정.
// (c) n>=3 분기(`m[i][i]` 그대로 반환)도 (b)와 동일하게 산술식이 아니라 값을 그대로 읽는 지점이라
//     **det에는 없던 새 위험**: rows>columns(예 3x2)에서 m[i]가 짧아 m[i][i]가 범위 밖이면 undefined가
//     그대로 새어나간다(예: fuzz id 450~479 IndexError 크래시 케이스) — (b)와 동일하게 루프 안에서도
//     Number() 캐스팅 필요(캐스팅이 undefined->NaN 변환까지 자동으로 흡수해 별도 가드 불필요, fuzz로
//     확인).
// (d) 비정사각 — isSquareMatrix 가드를 **추가하지 않는다**(inv/pow(C100/C102)와 다른 결정): rows<
//     columns(예 2x3)는 여분 열을 안 건드려 왼쪽 nxn 부분행렬의 고유값을 그대로 반환하는 det의
//     "왼쪽 nxn 부분행렬" 패턴과 동일한 잘 정의된 값(python도 크래시 없음, fuzz id 420~449 확인).
//     rows>columns(예 3x2)는 python이 크래시하지만 JS는 (c)의 Number() 캐스팅이 undefined를 NaN으로
//     흡수해 "일부는 유효값, 일부는 NaN"인 배열로 자연 수렴(예 [1,4,NaN]) — inv/pow가 가드를 추가한
//     이유(비정사각 결과가 "그럴듯해 보이지만 수학적으로 무의미한" 비-NaN 값이라 위험)와 달리, 여기선
//     계산 불가능한 위치가 그대로 NaN으로 드러나(det의 자연 NaN 수렴과 동일 계열) 별도 가드가 주는
//     이득이 없다고 판단.
// n=0(m=[])은 n>=3 분기로 떨어져 루프 0회라 크래시 없이 []([]는 array이므로 matrixVars 아닌
// arrayVars 반환, analyzer.ts 참조).
export function eigenvalues(m: PineMatrix | null): number[] | null {
  if (m === null) return null;
  const n = m.length;
  if (n === 1) return [Number((m[0] as unknown[])[0])];
  if (n === 2) {
    const r0 = m[0] as unknown[];
    const r1 = m[1] as unknown[];
    const a = r0[0] as number;
    const b = r0[1] as number;
    const c = r1[0] as number;
    const d = r1[1] as number;
    const tr = a + d;
    const detVal = a * d - b * c;
    const disc = tr * tr - 4 * detVal;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      return [(tr + sq) / 2, (tr - sq) / 2];
    }
    return [tr / 2, tr / 2];
  }
  const result: number[] = new Array(n);
  for (let i = 0; i < n; i++) result[i] = Number((m[i] as unknown[])[i]);
  return result;
}

// matrix.eigenvectors(id) — 고유벡터(C106, matrix.* 열일곱 번째이자 마지막 슬라이스 — 행렬 대수
// 11종의 열한 번째 항목, 48/49 -> 49/49 완주). pine2py eigenvectors()(matrix.py L351-372)는
// evals=eigenvalues(m)을 먼저 호출(이미 구현된 rt.matrix.eigenvalues를 그대로 내부 재호출하는
// hma/linreg류 합성 원칙 — C105 next_hint가 미리 확인해둔 대로)한 뒤 (A-λI)v=0의 null space를
// "첫 행으로 비율 계산"하는 closed-form: n=2는 mat[0][0]=m[0][0]-ev가 |·|>1e-10이면
// [-mat[0][1]/mat[0][0], 1.0], 아니면 [1.0,0.0]. pine2py 소스는 elif abs(mat[0][1])>1e-10과
// else 두 분기를 따로 두지만 둘 다 정확히 [1.0,0.0]을 반환해 사실상 무의미(python 직접 실행으로
// 재확인) — 관측 가능한 차이가 없어 literal 3분기 대신 단순 if/else 2분기로 정리했다. n!=2(1
// 포함, n>=3 포함)는 evals의 "값"과 무관하게 "개수"만큼 고정 벡터 [1.0,0.0,...,0.0](길이 n)을
// 반복 반환.
//
// **반환 타입은 matrix<float>**(eigenvalues의 array<float>와 정반대 — pine2py가
// result.append(vec)로 list의 list를 구성) — MATRIX_CONSTRUCTOR_METHODS 편입(analyzer.ts 참조,
// eigenvalues가 isArrayConstructorCall의 matrix 분기에 편입된 것과 반대 방향).
//
// 크래시 경계(python 직접 실행 전수 확인):
// (a) m===null — eigenvalues(m) 호출 자체가 python `len(None)` TypeError로 크래시(미정의). 이미
//     구현된 rt.matrix.eigenvalues(null)===null이므로 `evals===null` 체크 하나로 자연 흡수(별도
//     m===null 가드 불필요 — pinv(C104)가 mult/inv의 null 전파만으로 try/except를 대체한 것과
//     동일 원칙, "하위 함수의 흡수를 그대로 승계").
// (b) m=[[]](1행0열, n=1) — pine2py는 eigenvalues(m) 호출 안에서 이미 IndexError로 크래시하지만,
//     rt.matrix.eigenvalues가 이 케이스를 [NaN]으로 흡수해뒀다(C105) — eigenvectors는 크래시
//     없이 evals=[NaN]을 받고, n=1은 n!==2 분기라 ev 값 자체를 전혀 읽지 않아 고정 [1.0]을 그대로
//     반환한다(하위 함수 흡수가 "공짜로" 승계되는 사례, hand-verified: python은 크래시, JS는
//     [[1.0]]).
// (c) rows>columns(예 3x2, n=3) — eigenvalues 내부 n>=3 분기가 이미 Number() 캐스팅으로 범위밖을
//     NaN으로 부분 흡수해두므로(예 evals=[1,4,NaN]), eigenvectors는 n!==2 분기라 ev 값과 무관하게
//     고정 [1,0,0]을 evals.length번 반복 — 여기서도 하위 흡수를 그대로 승계(hand-verified: python은
//     크래시, JS는 크래시 없이 정상 반환).
// (d) n=2에서 mat[0][0]/mat[0][1] 읽기는 뺄셈 산술식 안(`m[0][0]-ev`, `m[0][1]-0`)에 있어(det/
//     eigenvalues n=2 분기와 동일 구조) undefined가 섞여도(예: rows=2,columns=0인 2x0 행렬) JS가
//     산술로 자연히 NaN 전파한다(C103 pitfall "산술식 안의 undefined leniency") — 값을 그대로
//     return하는 지점(det/eigenvalues n=1/n>=3의 함정)이 이 분기엔 없어 Number() 명시 캐스팅이
//     불필요.
// isSquareMatrix 가드는 두지 않는다 — 위 (a)~(d) 전부 하위 eigenvalues의 흡수를 그대로 승계해
// 크래시 없이 well-defined 값 또는 NaN으로 자연 수렴하므로 inv/pow와 다른 방향, det/trace/
// eigenvalues 계열의 "자연 literal port 신뢰" 원칙 재적용. n=0(m=[])은 evals=[]이라 result=[]로
// 루프 0회, 크래시 없음.
export function eigenvectors(m: PineMatrix | null): PineMatrix | null {
  const evals = eigenvalues(m);
  if (evals === null) return null;
  const n = (m as PineMatrix).length;
  const result: PineMatrix = new Array(evals.length);
  for (let k = 0; k < evals.length; k++) {
    const ev = evals[k]!;
    if (n === 2) {
      const r0 = (m as PineMatrix)[0] as unknown[];
      const mat00 = (r0[0] as number) - ev;
      const mat01 = r0[1] as number;
      result[k] = Math.abs(mat00) > 1e-10 ? [-mat01 / mat00, 1.0] : [1.0, 0.0];
    } else {
      const vec: number[] = new Array(n).fill(0.0);
      vec[0] = 1.0;
      result[k] = vec;
    }
  }
  return result;
}
