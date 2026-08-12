// array/map/matrix/str 컬렉션 네임스페이스 레지스트리 + dispatch — analyzer.ts에서 분리
// (ROADMAP "컬렉션 네임스페이스 레지스트리화 + analyzer.ts 분할", C137~C140에서 레지스트리화한
// 4개 테이블을 이번 슬라이스가 순수 이동만 수행. 신규 검증 로직 없음, analyzer.ts의 else-if
// 조건 자체(namespace/hasOwnProperty 체크)는 그대로 두고 각 분기 본문만 이 파일의 함수로 위임한다.

import type { CallExpr } from "../ast";
import type { AnalyzedProgram, LexScope } from "../analyzer";
import { ORDER_CONSTANTS, isStaticIntExpr, analyzeExpr } from "../analyzer";
import { isHarmlessArgDup } from "./arg-dup";

// map.*(C89) 인자 개수 검증 전용 데이터 주도 테이블 — ROADMAP "컬렉션 네임스페이스 레지스트리화"
// 항목의 첫 번째 슬라이스(array/matrix/str은 동일 패턴으로 후속 사이클에서 처리 예정, 네임스페이스당
// 1사이클 권장을 그대로 따름). TA_REGISTRY와 달리 map.*는 전부 상태 없는 stateless 콜(HoistingPass
// 제약 대상 아님, C89)이고 인자 개수도 전부 고정(가변 범위 케이스 없음)이라 argCount 하나만으로
// 기존 else-if 체인(11개 분기)을 대체할 수 있다. 뮤테이션 여부(codegen.ts MUTATING_ARRAY_BUILTINS)와
// 생성자 판별(analyzeVarDecl의 isMapConstructorCall)은 이 분기보다 이르거나(var 선언 시점) 별도
// 소비 지점(codegen)이라 이 테이블에 편입하지 않는다 — array/matrix까지 레지스트리화된 뒤 공통
// 스키마로 재평가할 것(순수 이동 원칙, 이번 슬라이스에서 새 필드를 미리 만들지 않음).
interface MapMethodEntry {
  argCount: number; // 최대(=기본, minArgCount 생략 시 정확히 이 개수) 인자 개수
  minArgCount?: number; // 지정하면 [minArgCount, argCount] 범위 허용
}
export const MAP_REGISTRY: Readonly<Record<string, MapMethodEntry>> = {
  new: { argCount: 0 },
  put: { argCount: 3 },
  // get(id, key[, default]) — C241, C240 next_hint. pine2py map_funcs.py get(m, key,
  // default=nan)이 3번째 선택 인자를 실제로 지원(corpus 161개 파일이 직접 사용, C89 당시 판단은
  // 표본이 좁았던 오판 — DIVERGENCES.md #29/LIMITATIONS.md 정정). ta.change/kc(C227)와 동일한
  // minArgCount 패턴.
  get: { argCount: 3, minArgCount: 2 },
  remove: { argCount: 2 },
  contains: { argCount: 2 },
  put_all: { argCount: 2 },
  keys: { argCount: 1 },
  values: { argCount: 1 },
  size: { argCount: 1 },
  clear: { argCount: 1 },
  copy: { argCount: 1 },
};

// str.*(C76~112 완주, 19종) 인자 개수 검증 전용 데이터 주도 테이블 — ROADMAP "컬렉션 네임스페이스
// 레지스트리화" 슬라이스 2/4(map C137에 이어). map과 동일하게 전부 stateless(HoistingPass 제약
// 대상 아님, 뮤테이션/생성자 추적 필드 불필요)지만, substring/repeat/tostring/format_number/
// format_time/replace처럼 마지막 인자에 기본값이 있는 항목이 map보다 많아 TA_REGISTRY.random과
// 동일한 minArgCount(선택, 지정 시 [minArgCount, argCount] 범위 허용) 필드로 확장한다. format
// (template, *args)만 상한이 없는 진짜 가변 인자라 argCount: Infinity로 표현(JS number가 Infinity를
// 그대로 담아 인터페이스 변경 없이 "상한 없음"을 표현 — expr.args.length는 항상 유한하므로 상한
// 비교(> Infinity)가 자연히 항상 false).
interface StrMethodEntry {
  argCount: number; // 최대(=기본, minArgCount 생략 시 정확히 이 개수) 인자 개수. format만 Infinity(상한 없음)
  minArgCount?: number; // 지정하면 [minArgCount, argCount] 범위 허용
}
export const STR_REGISTRY: Readonly<Record<string, StrMethodEntry>> = {
  length: { argCount: 1 },
  lower: { argCount: 1 },
  upper: { argCount: 1 },
  trim: { argCount: 1 },
  tonumber: { argCount: 1 },
  contains: { argCount: 2 },
  startswith: { argCount: 2 },
  endswith: { argCount: 2 },
  pos: { argCount: 2 },
  split: { argCount: 2 },
  match: { argCount: 2 },
  replace_all: { argCount: 3 },
  replace: { argCount: 4, minArgCount: 3 },
  tostring: { argCount: 2, minArgCount: 1 },
  format_number: { argCount: 2, minArgCount: 1 },
  format_time: { argCount: 3, minArgCount: 1 },
  substring: { argCount: 3, minArgCount: 2 },
  repeat: { argCount: 3, minArgCount: 2 },
  format: { argCount: Infinity, minArgCount: 1 },
};

// array.*(C79~88 완주, 49종) 인자 개수 검증 전용 데이터 주도 테이블 — ROADMAP "컬렉션 네임스페이스
// 레지스트리화" 슬라이스 3/4(map C137, str C138에 이어). map/str과 동일하게 전부 stateless(HoistingPass
// 제약 대상 아님, 조건부 블록 제약 없음) — 뮤테이션 호이스팅 대상 판별(codegen.ts
// MUTATING_ARRAY_BUILTINS)과 생성자 판별(analyzeVarDecl의 isArrayConstructorCall)은 이 dispatch보다
// 이르거나(var 선언 시점) 별도 소비 지점이라 map/str 슬라이스와 동일한 원칙으로 이 테이블에 편입하지
// 않는다. 기존 else-if 체인을 정독한 결과 8개 그룹(str과 우연히 같은 개수)으로 나뉘고 STR_REGISTRY의
// {argCount, minArgCount?} 스키마 그대로로 전부 표현 가능 — new_float/new_int/new_bool/new_string/
// new_color(0~2), from(하한 1·상한 없음 -> argCount: Infinity), get~binary_search_rightmost 15종
// (정확히 2), sort/sort_indices/join(1~2), slice(1~3), set/insert(정확히 3), fill(2~4), 나머지 21종
// (정확히 1). array.from의 에러 문구가 기존 "1개 이상 필요"에서 STR_REGISTRY와 동일한 생성 로직이
// 내는 "최소 1개 필요"로 미세하게 바뀌지만, 기존 테스트는 `.includes("array.from")`만 검사해(다른
// array.* 전 메서드도 동일하게 method 이름만 확인) 회귀 없음(analyzer.test.ts 확인 완료).
interface ArrayMethodEntry {
  argCount: number; // 최대(=기본, minArgCount 생략 시 정확히 이 개수) 인자 개수. from만 Infinity(상한 없음)
  minArgCount?: number; // 지정하면 [minArgCount, argCount] 범위 허용
}
export const ARRAY_REGISTRY: Readonly<Record<string, ArrayMethodEntry>> = {
  new_float: { argCount: 2, minArgCount: 0 },
  new_int: { argCount: 2, minArgCount: 0 },
  new_bool: { argCount: 2, minArgCount: 0 },
  new_string: { argCount: 2, minArgCount: 0 },
  new_color: { argCount: 2, minArgCount: 0 },
  // array.new<T>에서 T가 5종 원시 타입 밖(UDT/label/chart.point 등 참조형)일 때의 무타입 단일
  // 생성자(C230, parser.ts isArrayNewGenericTypeArg가 attr을 이 이름으로 재작성) — new_float 등과
  // 인자 개수 스키마는 동일(size, initial_value 둘 다 선택).
  new_generic: { argCount: 2, minArgCount: 0 },
  // array.new_label/new_line/new_box/new_table/new_linefill(C236) — v4식 명명 typed 생성자
  // (drawing 핸들 전용). pine2py가 5종 전부 new_generic과 동일한 무타입 단일 생성자로 라우팅해
  // (runtime/array.ts 주석 참조) 인자 스키마도 new_generic과 동일(size, initial_value 둘 다 선택).
  new_label: { argCount: 2, minArgCount: 0 },
  new_line: { argCount: 2, minArgCount: 0 },
  new_box: { argCount: 2, minArgCount: 0 },
  new_table: { argCount: 2, minArgCount: 0 },
  new_linefill: { argCount: 2, minArgCount: 0 },
  from: { argCount: Infinity, minArgCount: 1 },
  get: { argCount: 2 },
  push: { argCount: 2 },
  unshift: { argCount: 2 },
  remove: { argCount: 2 },
  includes: { argCount: 2 },
  indexof: { argCount: 2 },
  lastindexof: { argCount: 2 },
  covariance: { argCount: 2 },
  percentile_nearest_rank: { argCount: 2 },
  percentile_linear_interpolation: { argCount: 2 },
  percentrank: { argCount: 2 },
  concat: { argCount: 2 },
  binary_search: { argCount: 2 },
  binary_search_leftmost: { argCount: 2 },
  binary_search_rightmost: { argCount: 2 },
  sort: { argCount: 2, minArgCount: 1 },
  sort_indices: { argCount: 2, minArgCount: 1 },
  join: { argCount: 2, minArgCount: 1 },
  slice: { argCount: 3, minArgCount: 1 },
  set: { argCount: 3 },
  insert: { argCount: 3 },
  fill: { argCount: 4, minArgCount: 2 },
  pop: { argCount: 1 },
  size: { argCount: 1 },
  first: { argCount: 1 },
  last: { argCount: 1 },
  shift: { argCount: 1 },
  clear: { argCount: 1 },
  sum: { argCount: 1 },
  avg: { argCount: 1 },
  // min/max(id[, nth]) — nth(C297, wild 실사용 `array.max(arr, 1)` 소스 주석이 TV 공식 "second
  // highest value"를 직접 설명). pine2py array.py의 min(arr)/max(arr)는 고정 1-positional이라
  // 2번째 위치 인자를 주면 pine2py 자신도 TypeError -- 오라클 구조적 불가, hand-verified 설계
  // (DIVERGENCES #111).
  min: { argCount: 2, minArgCount: 1 },
  max: { argCount: 2, minArgCount: 1 },
  median: { argCount: 1 },
  mode: { argCount: 1 },
  stdev: { argCount: 1 },
  variance: { argCount: 1 },
  standardize: { argCount: 1 },
  reverse: { argCount: 1 },
  copy: { argCount: 1 },
  abs: { argCount: 1 },
  every: { argCount: 1 },
  some: { argCount: 1 },
  range: { argCount: 1 },
};

// matrix.*(C90~106 완주, 49종) 인자 개수 검증 전용 데이터 주도 테이블 — ROADMAP "컬렉션 네임스페이스
// 레지스트리화" 슬라이스 4/4(마지막, map C137/str C138/array C139에 이어). map/str/array와 동일하게
// 전부 stateless(HoistingPass 제약 대상 아님, 조건부 블록 제약 없음) — 뮤테이션 호이스팅 대상 판별
// (codegen.ts MUTATING_ARRAY_BUILTINS)과 생성자 판별(analyzeVarDecl의 isMatrixConstructorCall)은 이
// dispatch보다 이르거나(var 선언 시점) 별도 소비 지점이라 array/map/str 슬라이스와 동일한 원칙으로 이
// 테이블에 편입하지 않는다. 기존 else-if 체인을 정독한 결과 15개 그룹으로 나뉘고 ARRAY_REGISTRY/
// STR_REGISTRY의 {argCount, minArgCount?} 스키마 그대로로 전부 표현 가능(matrix.py는 array.py와 독립
// 재구현이라 그룹 경계를 예단하지 않고 개별 대조 — analyzer.ts 기존 주석 참조) — new(0~3),
// get(정확히 3), set(정확히 4), row/col/remove_row/remove_col(정확히 2), add_row/add_col(1~3),
// swap_rows/swap_columns(정확히 3), submatrix(정확히 5), reshape(정확히 3), concat(2~3),
// fill(2~6), sort(1~3), mult/pow/kron(정확히 2), 나머지 30종(정확히 1 — rows/columns/
// elements_count/copy/reverse/diff/is_*10종/sum·avg·min·max·median·mode/transpose/det/trace/
// inv/rank/pinv/eigenvalues/eigenvectors).
interface MatrixMethodEntry {
  argCount: number; // 최대(=기본, minArgCount 생략 시 정확히 이 개수) 인자 개수
  minArgCount?: number; // 지정하면 [minArgCount, argCount] 범위 허용
}
export const MATRIX_REGISTRY: Readonly<Record<string, MatrixMethodEntry>> = {
  new: { argCount: 3, minArgCount: 0 },
  get: { argCount: 3 },
  set: { argCount: 4 },
  row: { argCount: 2 },
  col: { argCount: 2 },
  remove_row: { argCount: 2 },
  remove_col: { argCount: 2 },
  add_row: { argCount: 3, minArgCount: 1 },
  add_col: { argCount: 3, minArgCount: 1 },
  swap_rows: { argCount: 3 },
  swap_columns: { argCount: 3 },
  submatrix: { argCount: 5 },
  reshape: { argCount: 3 },
  concat: { argCount: 3, minArgCount: 2 },
  fill: { argCount: 6, minArgCount: 2 },
  sort: { argCount: 3, minArgCount: 1 },
  mult: { argCount: 2 },
  pow: { argCount: 2 },
  kron: { argCount: 2 },
  rows: { argCount: 1 },
  columns: { argCount: 1 },
  elements_count: { argCount: 1 },
  copy: { argCount: 1 },
  reverse: { argCount: 1 },
  diff: { argCount: 1 },
  is_square: { argCount: 1 },
  is_symmetric: { argCount: 1 },
  is_antisymmetric: { argCount: 1 },
  is_diagonal: { argCount: 1 },
  is_antidiagonal: { argCount: 1 },
  is_identity: { argCount: 1 },
  is_triangular: { argCount: 1 },
  is_stochastic: { argCount: 1 },
  is_binary: { argCount: 1 },
  is_zero: { argCount: 1 },
  // sum(id[, id2]) — C656: 2-인자 오버로드(원소별 덧셈) 신설, matrix.ts rt.matrix.sum 주석
  // 참조(DIVERGENCES #201). 1-인자(집계)는 기존 그대로.
  sum: { argCount: 2, minArgCount: 1 },
  avg: { argCount: 1 },
  min: { argCount: 1 },
  max: { argCount: 1 },
  median: { argCount: 1 },
  mode: { argCount: 1 },
  transpose: { argCount: 1 },
  det: { argCount: 1 },
  trace: { argCount: 1 },
  inv: { argCount: 1 },
  rank: { argCount: 1 },
  pinv: { argCount: 1 },
  eigenvalues: { argCount: 1 },
  eigenvectors: { argCount: 1 },
};

// map.new/put/get/remove/contains/keys/values/size/clear/copy/put_all(C89, map.* 11종 전체) —
// pine2py wavealgo/builtins/map_funcs.py 소스 대조 결과 전부 dict에 위임하는 stateless
// 함수(런타임 숨은 슬롯 상태 없음, array.*와 동일한 부류)라 조건부 블록 제약이 없다. 인자
// 개수 검증은 MAP_REGISTRY 데이터 주도 테이블로 통합(구 else-if 체인, ROADMAP "컬렉션
// 네임스페이스 레지스트리화" 슬라이스 1/4) — get(id, key[, default])은 pine2py 시그니처의 3번째
// default 인자를 STR_REGISTRY/ARRAY_REGISTRY와 동일한 minArgCount 범위 검증으로 그대로 노출한다
// (C241 — C89 당시 "Pine 표면은 2개만 노출" 판단은 표본이 좁았던 오판, corpus 161개 파일이 3-인자
// 폼을 직접 씀, DIVERGENCES.md #29/LIMITATIONS.md 정정).
// put/remove/clear/put_all은 관측 가능한 뮤테이션이라 lazy 위치(삼항/and·or)에서 codegen이
// eager 호이스팅한다(C66 원칙 — codegen.ts MUTATING_ARRAY_BUILTINS 참조, array.remove와
// 동일하게 "쓰기+읽기"도 포함). new/copy는 map을 새로 만들어 반환하는 콜이라 mapVars로 추적
// (MAP_CONSTRUCTOR_METHODS 주석 참조), keys/values는 array를 새로 만들어 반환하는 콜이라
// arrayVars로 추적(isArrayConstructorCall의 map 분기 참조) — 둘 다 이 분기보다 이른(var 선언
// 시점) 별도 지점이라 MAP_REGISTRY에 편입하지 않는다. builtinCalls 값은 array.*와 동일하게
// flat 이름이 아니라 "map.<method>" 점 경로(rt.map 중첩 네임스페이스로 방출 — get/size/remove/
// clear/copy가 array와 이름이 겹치는 것을 rt.ts 주석이 예고한 대로 원천 차단).
// receiverOffset(C222, method-call 스타일 `m.put(k, v)` == `map.put(m, k, v)`): 기본 0(기존
// namespace 형태 호출은 인자 개수/에러 문구가 한 글자도 안 바뀜). 1이면 호출부(call-expr.ts)가
// 이미 수신자를 methodCallReceivers에 별도로 등록해뒀다는 뜻이라, expr.args 자체는 손대지 않고
// 인자 개수 검증에만 +1을 더해 receiver를 감안한다.
export function analyzeMapCall(expr: CallExpr, method: string, prog: AnalyzedProgram, receiverOffset: number = 0): void {
  const entry = MAP_REGISTRY[method]!;
  const minArgCount = entry.minArgCount ?? entry.argCount;
  const effectiveArgCount = expr.args.length + receiverOffset;
  if (effectiveArgCount < minArgCount || effectiveArgCount > entry.argCount) {
    const need = minArgCount === entry.argCount ? `${entry.argCount}` : `${minArgCount}~${entry.argCount}`;
    prog.errors.push(
      `'map.${method}' call argument count mismatch: ${need} required, ${effectiveArgCount} passed (L${expr.line}:${expr.col})`,
    );
  }
  prog.builtinCalls.set(expr, `map.${method}`);
}

// str.length/contains/startswith/endswith/pos(C76) + lower/upper/trim/replace_all/substring/
// repeat(C77) + tostring/tonumber(C87) + split(C107) + replace(C108) + match(C109) +
// format(C110) + format_number(C111) + format_time(C112) — 전부 순수 함수(상태 없음)라
// math.*(C12/C13 이후 전례)와 동일한 stateless builtinCalls 패턴 그대로 재사용(namespace만
// 다름, 새 디스패치 메커니즘 불필요 — split만 반환 타입이 array라 isArrayConstructorCall에
// 별도 등재, analyzer.ts 참조). 인자 개수 검증은 STR_REGISTRY 데이터 주도 테이블로 통합(구 else-if
// 체인, ROADMAP "컬렉션 네임스페이스 레지스트리화" 슬라이스 2/4 — map(C137)과 동일 원칙).
// builtinCalls 값은 map.*(C89, "map.<method>" 접두어)와 달리 flat 메서드 이름 그대로(rt.ts가
// str.* 19종을 rt.<method> top-level export로 이미 매핑해둔 기존 관례, 변경하지 않음).
// str.tostring(value=/format=) kwargs(C403, next_hint(C402) 1순위 — wild 최다 서브클러스터).
// ARRAY_KWARG_PARAM_NAMES(C382)와 동일한 "위치/키워드 슬롯 병합" 스키마 — 두 번째 슬롯 이름은
// TV 공식 kwarg 이름 그대로 'format'을 쓴다(python inspect.signature 직접 확인 결과 pine2py
// wavealgo/builtins/str_funcs.py tostring의 실제 파라미터명은 'format_str'이라 'format='을 그대로
// 넘기면 TypeError — 오라클 불가, DIVERGENCES 참조, C401이 발견한 함정 재확인). 'value='는 이름이
// 일치해 오라클 가능.
// str.format_time(time=/format=/timezone=) kwargs(C478, next_hint(C477) — 잔여 '키워드 인자'
// 블랑켓 최다빈도, wild 4개 파일). python inspect.signature 재확인 결과 pine2py
// wavealgo/builtins/str_funcs.py format_time의 실제 파라미터명은 time_ms/format_str/timezone —
// tostring(C403)과 동일하게 'timezone'만 이름이 일치해 오라클 가능(2942202a2b71/82212d1b1679/
// c6df7b067b6f 3파일이 이 패턴), 'time'/'format'은 TV 공식 이름 그대로 써서 codegen 위치 매핑용
// (rt.format_time은 위치 인자만 받는 순수 함수라 이름 불일치가 codegen에는 영향 없음, hand-verified
// — fab0b2ffba07.pine의 완전 키워드 폼 해소용).
export const STR_KWARG_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  tostring: ["value", "format"],
  format_time: ["time", "format", "timezone"],
};
export function analyzeStrCall(expr: CallExpr, method: string, prog: AnalyzedProgram, scope: LexScope): void {
  const entry = STR_REGISTRY[method]!;
  const paramNames = STR_KWARG_PARAM_NAMES[method];
  if (paramNames !== undefined && expr.kwargs.length > 0) {
    // array.*(id=...)(C382, analyzeArrayCall)와 동일한 이름/중복/위치·키워드 충돌 검증 — str.*는
    // method-call sugar(receiver 축약)가 없어 receiverOffset 보정이 불필요하다는 점만 다르다.
    const requiredCount = entry.minArgCount ?? entry.argCount;
    const paramIndex = new Map(paramNames.map((name, i) => [name, i]));
    if (expr.args.length > paramNames.length) {
      prog.errors.push(
        `'str.${method}' call argument count mismatch: ${paramNames.length} (${paramNames.join(", ")}) required, ${expr.args.length} passed (L${expr.line}:${expr.col})`,
      );
    }
    const seen = new Set<string>();
    for (let i = 0; i < expr.args.length && i < paramNames.length; i++) seen.add(paramNames[i]!);
    for (const kw of expr.kwargs) {
      const idx = paramIndex.get(kw.name);
      if (idx === undefined) {
        prog.errors.push(`unknown argument name for 'str.${method}': '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (seen.has(kw.name)) {
        const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
        if (!isHarmlessArgDup(posArg, kw.value)) {
          prog.errors.push(`argument '${kw.name}' given as both positional and keyword argument (L${kw.line}:${kw.col})`);
        }
      } else {
        seen.add(kw.name);
      }
      analyzeExpr(kw.value, prog, scope, false);
    }
    const missing = paramNames.slice(0, requiredCount).filter((name) => !seen.has(name));
    if (missing.length > 0) {
      prog.errors.push(`'str.${method}' call requires all of the ${paramNames.slice(0, requiredCount).join("/")} arguments (L${expr.line}:${expr.col})`);
    }
    // tostring int/float 갭(C201) — value가 kwarg로 지정된 경우도 위치 인자와 동일하게 판별한다.
    // value 자체가 누락된 경우(위 missing 에러가 이미 보고됨)는 valueExpr이 undefined로 남아 스킵.
    if (method === "tostring") {
      const valueExpr = expr.args.length >= 1 ? expr.args[0]! : expr.kwargs.find((kw) => kw.name === "value")?.value;
      if (valueExpr !== undefined && isStaticIntExpr(valueExpr, prog, scope)) prog.tostringIntArgCalls.add(expr);
    }
    prog.builtinCalls.set(expr, method);
    return;
  }
  const minArgCount = entry.minArgCount ?? entry.argCount;
  if (expr.args.length < minArgCount || expr.args.length > entry.argCount) {
    const need =
      entry.argCount === Infinity
        ? `at least ${minArgCount}`
        : minArgCount === entry.argCount
          ? `${entry.argCount}`
          : `${minArgCount}~${entry.argCount}`;
    prog.errors.push(
      `'str.${method}' call argument count mismatch: ${need} required, ${expr.args.length} passed (L${expr.line}:${expr.col})`,
    );
  }
  // tostring(value[, format_str]) 기본 포맷의 int/float 갭 수정(C201) — value가 정적으로 int로
  // 확정되면 codegen이 isInt=true를 추가 인자로 실어 정수 포맷을 낸다(isStaticIntExpr 주석 참조).
  if (method === "tostring" && expr.args.length >= 1 && isStaticIntExpr(expr.args[0]!, prog, scope)) {
    prog.tostringIntArgCalls.add(expr);
  }
  prog.builtinCalls.set(expr, method);
}

// array.new_float/get/set/push/pop/size(C79) + first/last/shift/unshift/insert/remove/
// clear/fill(C80) + sum/avg/min/max/median/mode/stdev/variance(C81) +
// includes/indexof/lastindexof(C82) + covariance/percentile_nearest_rank/
// percentile_linear_interpolation/percentrank/standardize(C83) +
// new_int/new_bool/new_string/new_color/from(C84) +
// sort/reverse/slice/concat/copy(C85) +
// abs/every/some/range/binary_search·leftmost·rightmost/sort_indices(C86) + join(C88, 문자열
// 반환 — array.* 49종 소진) — 상태는 사용자에게
// 보이는 배열 객체 자체에 있고 런타임엔 숨은 슬롯 상태가
// 없어(str.*/math.*와 같은 stateless builtinCalls 부류) 조건부 블록 제약이 없다. 단
// push/pop/set/shift/unshift/insert/remove/clear/fill/sort/reverse는 관측 가능한 뮤테이션이라
// lazy 위치(삼항/and·or)에서는 codegen이 eager 호이스팅한다(C66 원칙 — codegen.ts
// MUTATING_ARRAY_BUILTINS 참조, 이 dispatch와는 별도 지점이라 ARRAY_REGISTRY에 편입 안 함,
// map/str 슬라이스와 동일 원칙). first/last/slice/concat/copy는 원본을 바꾸지 않는 순수
// 읽기/새 배열 반환이라 제외. builtinCalls 값은 flat
// 이름이 아니라 "array.<method>" 점 경로 — rt.array 중첩 네임스페이스로 방출해 향후
// map.*/matrix.*의 get/set/size 동명 메서드와의 충돌을 차단(rt.ts 주석). 인자 개수 검증은
// ARRAY_REGISTRY 데이터 주도 테이블로 통합(구 else-if 8-그룹 체인, ROADMAP "컬렉션 네임스페이스
// 레지스트리화" 슬라이스 3/4 — map(C137)/str(C138)과 동일한 {argCount, minArgCount?} 스키마
// 재사용, 새 필드 불필요).
// receiverOffset(C222, analyzeMapCall과 동일 원칙) — method-call 스타일 `arr.sort(order)` ==
// `array.sort(arr, order)`에서는 order가 expr.args[0](receiver가 args에서 빠져 한 칸씩 당겨짐)이라
// 아래 order 폴딩의 인덱스도 `1 - receiverOffset`로 같이 보정한다.
// array.* 'id=' 계열 키워드 인자(C382, wild gate(220) 재분포 1위). C381 next_hint는 size/get/set
// 3종만 지목했으나 착수 전 scratch로 전체 ARRAY_REGISTRY를 재스캔한 결과 TV가 사실상 모든
// array.* accessor/mutator의 첫 인자 이름을 동일하게 'id'로 문서화해(컨테이너 참조 인자라는
// 공통 관례) wild가 push/set/get/size/unshift/pop/clear/copy/sum/avg/stdev/shift/reverse/slice/
// insert/max/min/covariance/indexof/remove 20종 전부에서 키워드 폼을 쓰고 있음을 발견 —
// 3종만으로는 같은 파일 안에서 바로 다음 줄의 array.copy(id=)/array.new_float(size=) 등에
// 걸려 순재이(net-gain)가 거의 안 나는 것도 직접 확인(첫 에러만 고치면 두 번째 에러가 바로
// 드러나는 "같은 파일, 다른 콜사이트" 패턴 — MEMORY 신규 교훈). 생성자(new_float 등, size/
// initial_value 명명 — id 계열과 무관)와 sort/sort_indices(order= kwarg는 ORDER_CONSTANTS
// 컴파일타임 폴딩이 위치 인자 전용이라 kwarg 경로로 오면 그 폴딩을 우회해버리는 별도 위험 —
// 이번 슬라이스 범위 밖 유지)/concat(wild 매치가 전부 인접 input.*(inline=/group=) 콜의 오탐)은
// 제외. 각 배열은 슬롯 순서 그대로(codegen KWARG_SLOTS로 재사용 — 아래 export).
export const ARRAY_KWARG_PARAM_NAMES: Readonly<Record<string, readonly string[]>> = {
  // array.new_* 생성자 11종(C383, next_hint(C382) 1순위) — 컨테이너 참조가 아니라 순수 생성자라
  // 'id' 계열과 무관한 별도 스키마(size, initial_value 둘 다 선택 — ARRAY_REGISTRY minArgCount: 0
  // 재사용). pine2py wavealgo/builtins/array.py가 new_float/new_int/new_bool/new_string/new_color
  // 전부 `def new_X(size: int = 0, initial_value: ... = ...)`로 Pine 키워드 이름과 파라미터명이
  // 정확히 일치함을 python 소스로 직접 재확인(C382가 겪은 'id' vs 'arr' 불일치가 여기선 없음 —
  // 오라클 케이스 신설 가능). new_generic/new_label/new_line/new_box/new_table/new_linefill은
  // wild 실사용 0건이나 NO_CONTAINER_ARG_BUILTINS가 이미 이 11종을 "동일 순수 생성자" 축으로
  // 묶어뒀고(codegen.ts) 스키마도 동일(size, initial_value)이라 함께 등재 — id= 계열(C382)이
  // "대표 콜사이트만 보면 저평가"였던 교훈을 반대 방향(균일 스키마는 실사용 없어도 함께 확장)으로
  // 적용.
  new_float: ["size", "initial_value"],
  new_int: ["size", "initial_value"],
  new_bool: ["size", "initial_value"],
  new_string: ["size", "initial_value"],
  new_color: ["size", "initial_value"],
  new_generic: ["size", "initial_value"],
  new_label: ["size", "initial_value"],
  new_line: ["size", "initial_value"],
  new_box: ["size", "initial_value"],
  new_table: ["size", "initial_value"],
  new_linefill: ["size", "initial_value"],
  size: ["id"],
  get: ["id", "index"],
  set: ["id", "index", "value"],
  push: ["id", "value"],
  unshift: ["id", "value"],
  pop: ["id"],
  clear: ["id"],
  copy: ["id"],
  sum: ["id"],
  avg: ["id"],
  stdev: ["id"],
  shift: ["id"],
  reverse: ["id"],
  slice: ["id", "index_from", "index_to"],
  insert: ["id", "index", "value"],
  max: ["id"],
  min: ["id"],
  covariance: ["id1", "id2"],
  indexof: ["id", "value"],
  remove: ["id", "index"],
};
export function analyzeArrayCall(
  expr: CallExpr,
  method: string,
  prog: AnalyzedProgram,
  scope: LexScope,
  receiverOffset: number = 0,
): void {
  const entry = ARRAY_REGISTRY[method]!;
  const paramNames = ARRAY_KWARG_PARAM_NAMES[method];
  if (paramNames !== undefined && expr.kwargs.length > 0 && receiverOffset === 0) {
    // strategy.risk.max_intraday_loss/max_drawdown(analyzeStrategyRiskThresholdCall)과 동일한
    // "이름별로 위치 또는 키워드 중 하나" 패턴 — receiverOffset은 항상 0(sugar 콜은 kwargs 자체가
    // 도달 불가, 위 주석 참조)이라 별도로 감안하지 않는다. 필수 개수는 ARRAY_REGISTRY의
    // minArgCount(slice처럼 뒤쪽 인자가 선택인 경우 대비)를 그대로 재사용 — paramNames 자체가
    // entry.argCount보다 짧을 수 있다(max/min의 'nth'처럼 wild 키워드 실사용이 없는 뒤쪽 선택
    // 인자는 이름표를 안 붙여 그 이름으로는 여전히 거부됨, 위치 인자로는 계속 지원).
    const requiredCount = entry.minArgCount ?? entry.argCount;
    const paramIndex = new Map(paramNames.map((name, i) => [name, i]));
    if (expr.args.length > paramNames.length) {
      prog.errors.push(
        `'array.${method}' call argument count mismatch: ${paramNames.length} (${paramNames.join(", ")}) required, ${expr.args.length} passed (L${expr.line}:${expr.col})`,
      );
    }
    const seen = new Set<string>();
    for (let i = 0; i < expr.args.length && i < paramNames.length; i++) seen.add(paramNames[i]!);
    for (const kw of expr.kwargs) {
      const idx = paramIndex.get(kw.name);
      if (idx === undefined) {
        prog.errors.push(`unknown argument name for 'array.${method}': '${kw.name}' (L${kw.line}:${kw.col})`);
      } else if (seen.has(kw.name)) {
        const posArg = idx < expr.args.length ? expr.args[idx] : undefined;
        if (!isHarmlessArgDup(posArg, kw.value)) {
          prog.errors.push(`argument '${kw.name}' given as both positional and keyword argument (L${kw.line}:${kw.col})`);
        }
      } else {
        seen.add(kw.name);
      }
      analyzeExpr(kw.value, prog, scope, false);
    }
    const missing = paramNames.slice(0, requiredCount).filter((name) => !seen.has(name));
    if (missing.length > 0) {
      prog.errors.push(`'array.${method}' call requires all of the ${paramNames.slice(0, requiredCount).join("/")} arguments (L${expr.line}:${expr.col})`);
    }
    prog.builtinCalls.set(expr, `array.${method}`);
    return;
  }
  const minArgCount = entry.minArgCount ?? entry.argCount;
  const effectiveArgCount = expr.args.length + receiverOffset;
  if (effectiveArgCount < minArgCount || effectiveArgCount > entry.argCount) {
    const need =
      entry.argCount === Infinity
        ? `at least ${minArgCount}`
        : minArgCount === entry.argCount
          ? `${entry.argCount}`
          : `${minArgCount}~${entry.argCount}`;
    prog.errors.push(
      `'array.${method}' call argument count mismatch: ${need} required, ${effectiveArgCount} passed (L${expr.line}:${expr.col})`,
    );
  }
  // sort/sort_indices의 order 위치(두 번째 인자) 원시 문자열 리터럴 폴딩(C203, LIMITATIONS.md
  // 참조) — order.ascending/descending(C85) DotAccess 콘스탄트만 컴파일타임 boolean으로 접히던
  // 것을, 같은 값의 원시 문자열 리터럴("ascending"/"descending")에도 좁게(이 method + 이 인자
  // 위치일 때만) 확장한다. 노드 자체를 키로 등록하므로 다른 위치의 동일 문자열 값(예: source
  // 배열 원소)은 전혀 영향받지 않는다.
  if ((method === "sort" || method === "sort_indices") && effectiveArgCount >= 2) {
    const orderArg = expr.args[1 - receiverOffset]!;
    if (orderArg.kind === "StringLiteral" && ORDER_CONSTANTS.has(orderArg.value)) {
      prog.builtinBooleanConstants.set(orderArg, ORDER_CONSTANTS.get(orderArg.value)!);
    }
  }
  prog.builtinCalls.set(expr, `array.${method}`);
}

// matrix.new/get/set/rows/columns/elements_count(C90) + row/col(C91) + add_row/add_col/
// remove_row/remove_col/swap_rows/swap_columns(C92) + copy/fill/concat/submatrix/reshape/
// reverse/sort/diff(C93) + is_square~is_zero 10종(C94) + sum/avg/min/max/median/mode(C95) +
// transpose/mult/det/trace/inv/rank/pow/kron/pinv/eigenvalues/eigenvectors(C96~C106, 행렬
// 대수 11종 — matrix.* 49/49 완주). map.*(C89)와 동일하게 상태는 사용자에게 보이는 행렬 객체
// 자체에 있고 런타임엔 숨은 슬롯 상태가 없어 조건부 블록 제약이 없다. set/add_row/add_col/
// remove_row/remove_col/swap_rows/swap_columns/fill/reverse/sort는 관측 가능한 뮤테이션이라
// lazy 위치에서 codegen이 eager 호이스팅한다(C66 원칙 — codegen.ts MUTATING_ARRAY_BUILTINS
// 참조, 이 dispatch와는 별도 지점이라 MATRIX_REGISTRY에 편입 안 함, array/map/str 슬라이스와
// 동일 원칙). new/copy/concat/submatrix/reshape/diff/transpose/inv/pow/kron/pinv/eigenvectors는
// matrix를 새로 만들어 반환하는 콜이라 matrixVars로 추적(MATRIX_CONSTRUCTOR_METHODS 참조).
// row/col/remove_row/remove_col/eigenvalues는 array를 새로 만들어 반환하는 콜이라 arrayVars로
// 추적(isArrayConstructorCall의 matrix 분기 참조) — mult는 반환 타입이 other 인자 타입에 따라
// 갈려 전용 분기(isMatrixMultCall/isMatrixMultVectorArg)를 따로 둔다. 이 셋 다 이 dispatch보다
// 이른(var 선언 시점) 별도 지점이라 MATRIX_REGISTRY에 편입하지 않는다. 인자 개수 검증은
// MATRIX_REGISTRY 데이터 주도 테이블로 통합(구 else-if 15-그룹 체인, ROADMAP "컬렉션 네임스페이스
// 레지스트리화" 슬라이스 4/4 — map(C137)/str(C138)/array(C139)와 동일한 {argCount,
// minArgCount?} 스키마 재사용, 새 필드 불필요). builtinCalls 값은 array.*/map.*와 동일하게
// "matrix.<method>" 점 경로(rt.matrix 중첩 네임스페이스로 방출).
// receiverOffset(C237, analyzeArrayCall/analyzeMapCall과 동일 원칙 — method-call 스타일
// `m.det()` == `matrix.det(m)`): 기본 0(기존 namespace 형태 호출은 인자 개수/에러 문구가 한 글자도
// 안 바뀜). 1이면 호출부(call-expr.ts)가 이미 수신자를 methodCallReceivers에 별도로 등록해뒀다는
// 뜻이라, expr.args 자체는 손대지 않고 인자 개수 검증에만 +1을 더해 receiver를 감안한다.
export function analyzeMatrixCall(expr: CallExpr, method: string, prog: AnalyzedProgram, receiverOffset: number = 0): void {
  const entry = MATRIX_REGISTRY[method]!;
  const minArgCount = entry.minArgCount ?? entry.argCount;
  const effectiveArgCount = expr.args.length + receiverOffset;
  if (effectiveArgCount < minArgCount || effectiveArgCount > entry.argCount) {
    const need =
      minArgCount === entry.argCount
        ? `${entry.argCount}`
        : `${minArgCount}~${entry.argCount}`;
    prog.errors.push(
      `'matrix.${method}' call argument count mismatch: ${need} required, ${effectiveArgCount} passed (L${expr.line}:${expr.col})`,
    );
  }
  // sort의 order 위치(세 번째 인자) 원시 문자열 리터럴 폴딩 — analyzeArrayCall의 동일 조치(C203)
  // 참조, matrix.sort(id, column, order)만 order 인자를 갖는다. receiverOffset이 1이면 method-call
  // 스타일(`m.sort(column, order)`)이라 order는 args[1]로 한 칸 당겨진다(array.sort와 동일 보정).
  if (method === "sort" && effectiveArgCount >= 3) {
    const orderArg = expr.args[2 - receiverOffset]!;
    if (orderArg.kind === "StringLiteral" && ORDER_CONSTANTS.has(orderArg.value)) {
      prog.builtinBooleanConstants.set(orderArg, ORDER_CONSTANTS.get(orderArg.value)!);
    }
  }
  prog.builtinCalls.set(expr, `matrix.${method}`);
}
