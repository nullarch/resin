// 참조형(array/map/matrix/UDT) 생성자 콜 판별 술어 -- analyzer.ts 파일 분할 세 번째 슬라이스
// (analyzer/collections.ts(C141)/analyzer/ta.ts(C142)에 이은 세 번째 파일). analyzeVarDecl이
// `var x = <expr>`의 RHS가 새 컨테이너/UDT 인스턴스를 만드는 콜인지 구조만으로 판별해
// arrayVars/mapVars/matrixVars에 등재한다(GOAL.md "히스토리 인덱싱 차단" #19 원칙의 전제 조건).
// 순수 구조 검사라 analyzeExpr 등록 여부와 무관하게 호출 가능하다(inferQualifier의 DotAccess
// 구조 재검사와 동일 원칙, C72).

import type { Expr } from "../ast";
import type { AnalyzedProgram, LexScope } from "../analyzer";
import {
  resolveArrayElemUdtType,
  resolveContainerExprKind,
  resolveMatrixExprKind,
  resolveUdtObjectType,
  CHART_POINT_FIELD_TYPE,
} from "../analyzer";
import { TA_REGISTRY } from "./ta";

// array 객체를 새로 만들어 반환하는 콜인지 구조만 본다(C79) -- 현재 생성자는 new_float뿐이고,
// 향후 new_int/from/copy 등 array 반환 메서드가 늘면 이 목록만 확장하면 된다. analyzeExpr 등록
// 여부와 무관하게 호출 가능해야 해서(analyzeVarDecl이 값 분석 전에 호출) 순수 구조 검사로 구현
// (inferQualifier의 DotAccess 구조 재검사와 동일 원칙, C72). standardize(C83)는 원본을 뮤테이션하는
// 게 아니라 항상 **새 배열**을 반환하는 첫 통계류라 여기 등재(`var z = array.standardize(arr)`가
// array var로 추적돼야 히스토리 인덱싱 차단(#19 원칙)이 z에도 적용됨). abs/sort_indices(C86)도
// 동일 원칙 -- 둘 다 원본을 바꾸지 않고 항상 새 배열을 반환한다.
const ARRAY_CONSTRUCTOR_METHODS = new Set([
  "new_float",
  "standardize",
  "new_int",
  "new_bool",
  "new_string",
  "new_color",
  "new_generic", // array.new<UDT/label/chart.point 등>(C230) — parser.ts가 attr을 이 이름으로 재작성
  "new_label", // v4식 명명 typed 생성자 5종(C236) — new_generic과 동일 연산(runtime/array.ts 참조)
  "new_line",
  "new_box",
  "new_table",
  "new_linefill",
  "from",
  "slice",
  "concat",
  "copy",
  "abs",
  "sort_indices",
]);

// matrix.row/col/remove_row/remove_col/eigenvalues(C91/C92/C105) -- 새 array를 반환하는 matrix
// 메서드 5종. 리터럴 `matrix.row(m, i)` 폼과 method-call sugar `m.row(i)` 폼(C494) 양쪽에서 공유.
const MATRIX_ARRAY_RETURNING_METHODS = new Set(["row", "col", "remove_row", "remove_col", "eigenvalues"]);

// map.keys/map.values(C89)도 array 참조를 반환해 같은 히스토리 차단이 필요하다 -- namespace가
// "array"가 아니라 "map"이라 ARRAY_CONSTRUCTOR_METHODS에 그냥 편입할 수 없어 별도 분기로 확인.
// matrix.row/matrix.col(C91)도 동일 원칙 -- 행/열을 새 배열로 반환한다. matrix.remove_row/
// matrix.remove_col(C92)도 제거한 행/열을 새 배열로 반환해 동일하게 편입. matrix.eigenvalues
// (C105)도 고유값을 새 array<float>로 반환해(TV 실제 시그니처가 array<float> -- pine2py는
// list[float]로 표현 방식만 다를 뿐 개념도 동일) 동일하게 편입(matrixVars 아닌 arrayVars).
// str.split(C107)이 array/map/matrix 세 네임스페이스 밖에서 처음으로 array<string>을 반환하는
// 사례 -- namespace가 "str"이라 신규 분기 추가(다른 str.* 전부 스칼라/string 반환이라 이 분기가
// 여태 불필요했음).
// prog+scope(옵션, C223 신규)가 주어지면, 리터럴 네임스페이스 분기가 전부 실패한 뒤
// method-call 스타일로 체이닝된 생성자 반환 콜(`b = a.slice(0,3)`)도 추가로 인정한다 -- 수신자
// (callee.obj)가 resolveContainerExprKind(C216/C222가 이미 구축해둔 '=' 로컬/top-level var 정적
// 판별 인프라)로 array로 확정되고 메서드가 ARRAY_CONSTRUCTOR_METHODS에 있으면 이 콜도 array를
// 새로 반환하는 것으로 취급 -- corpus 실측(C222 next_hint 1순위, 3b049a16e6a1.pine `b = a.slice(0,3)`
// 후 `b.concat(c)`)이 이 갭을 발견. prog/scope 생략 호출부(isMatrixMultVectorArg 등)는 기존 리터럴
// 전용 동작 그대로 유지.
export function isArrayConstructorCall(value: Expr, prog?: AnalyzedProgram, scope?: LexScope): boolean {
  if (value.kind !== "CallExpr") return false;
  // bare UDF 콜이 array<UDT>를 반환하는 형태(C458, wild `broken_levels = check_level_breaks()` —
  // isUdtConstructorCall L149-152의 단일 UDT 버전과 나란함). FuncInfo.returnArrayElemUdtType이
  // non-null이면 이미 그 함수 본문 마지막 문장이 "원소 타입이 등록된 UDT인 array"로 확정된 것.
  if (value.callee.kind === "Identifier") {
    if (prog === undefined) return false;
    const funcInfo = prog.funcs.get(value.callee.name);
    return funcInfo !== undefined && funcInfo.returnArrayElemUdtType !== null;
  }
  if (value.callee.kind !== "DotAccess") return false;
  const method = value.callee.attr;
  if (value.callee.obj.kind === "Identifier") {
    const ns = value.callee.obj.name;
    if (ns === "array" && ARRAY_CONSTRUCTOR_METHODS.has(method)) return true;
    if (ns === "map" && (method === "keys" || method === "values")) return true;
    if (ns === "matrix" && MATRIX_ARRAY_RETURNING_METHODS.has(method)) return true;
    if (ns === "str" && method === "split") return true;
    // request.security_lower_tf(신규, C694) — pine2py wavealgo request_security_lower_tf(L103-114)가
    // 튜플이 아닌 단일 expression 인자를 항상 원소 1개짜리 리스트로 감싸 반환(`return [expression]`,
    // securityLowerTf 자신도 동일 -- src/runtime/request.ts L59-69 `T[]`). 튜플 디스트럭처
    // 대상(`[a,b]=...`)은 별도 경로(analyzer.ts C434/C493, securityLowerTfBareUdfCallSlots)로 처리돼
    // 이 분기와 안 겹친다 -- 여긴 단일 '=' 로컬/top-level var 대입 대상만(wild `arr =
    // request.security_lower_tf(sym, tf, expr)` 후 `arr.size()`/`for v in arr`).
    if (ns === "request" && method === "security_lower_tf") return true;
    // array<float> 핸들을 반환하는 stateful TA(C653, 첫 사례 ta.pivot_point_levels) — 판별 원천을
    // TA_REGISTRY.returnsArrayHandle 한 곳에 두어(C393 "공유 헬퍼 원천 확장" 패턴) 이 술어의 모든
    // 소비처(analyzeVarDecl arrayVars/analyzeAssignment containerKindHints/resolveContainerExprKind
    // CallExpr 분기/for-in 이터러블)가 자동으로 같은 판정을 받는다. TA_REGISTRY 참조는 함수 본문 안
    // 지연 평가라 constructors.ts↔ta.ts 간 모듈 top-level 순환 위험 없음(C142 원칙).
    if (ns === "ta" && TA_REGISTRY[method]?.returnsArrayHandle === true) return true;
  }
  if (
    prog !== undefined &&
    scope !== undefined &&
    ARRAY_CONSTRUCTOR_METHODS.has(method) &&
    resolveContainerExprKind(value.callee.obj, prog, scope) === "array"
  ) {
    return true;
  }
  // map.keys()/map.values()의 method-call 스타일 체이닝(C455, wild `m.values().size()`/
  // `m.keys().get(i)`류) — 위 리터럴 ns==="map" 분기는 `map.values(m)` 형태만 인정하고, 수신자가
  // resolveContainerExprKind로 "map"으로 확정된 '=' 로컬/top-level var/UDT 필드에 sugar 체이닝된
  // `m.values()` 형태는 여기까지 안 떨어진다(method가 ARRAY_CONSTRUCTOR_METHODS에 없어 위 분기도
  // 통과 못 함 — keys/values는 array가 아니라 map을 받는 메서드라 그 집합에 애초에 없음).
  if (
    prog !== undefined &&
    scope !== undefined &&
    (method === "keys" || method === "values") &&
    resolveContainerExprKind(value.callee.obj, prog, scope) === "map"
  ) {
    return true;
  }
  // matrix.row()/col()/remove_row()/remove_col()/eigenvalues()의 method-call 스타일 체이닝(C494,
  // wild `dataPoints.row(i).get(0)`류) — 위 리터럴 ns==="matrix" 분기는 `matrix.row(m, i)` 형태만
  // 인정하고, 수신자가 resolveMatrixExprKind로 matrix로 확정된 '=' 로컬/top-level var/matrix 체이닝
  // 결과에 sugar 체이닝된 `m.row(i)` 형태는 여기까지 안 떨어진다(map.keys/values와 동일 원칙).
  if (
    prog !== undefined &&
    scope !== undefined &&
    MATRIX_ARRAY_RETURNING_METHODS.has(method) &&
    resolveMatrixExprKind(value.callee.obj, prog, scope)
  ) {
    return true;
  }
  return false;
}

// map 객체를 새로 만들어 반환하는 콜인지 구조만 본다(C89, isArrayConstructorCall과 동일 원칙) --
// new는 항상 빈 맵, copy는 얕은 복사(둘 다 새 Map 참조).
const MAP_CONSTRUCTOR_METHODS = new Set(["new", "copy"]);

// isArrayConstructorCall과 동일한 method-call 확장(옵션 prog+scope) -- `m2 = m1.copy()`처럼 map
// 수신자에서 체이닝된 생성자 반환 콜도 인정.
export function isMapConstructorCall(value: Expr, prog?: AnalyzedProgram, scope?: LexScope): boolean {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess") return false;
  const method = value.callee.attr;
  if (value.callee.obj.kind === "Identifier" && value.callee.obj.name === "map" && MAP_CONSTRUCTOR_METHODS.has(method)) {
    return true;
  }
  if (
    prog !== undefined &&
    scope !== undefined &&
    MAP_CONSTRUCTOR_METHODS.has(method) &&
    resolveContainerExprKind(value.callee.obj, prog, scope) === "map"
  ) {
    return true;
  }
  return false;
}

// UDT 인스턴스를 새로 만드는 콜인지 구조만 본다(arrayVars/mapVars와 동일 원칙) -- `TypeName.new(...)`
// 형태이고 TypeName이 이미 등록된 UDT 타입명일 때만 그 타입명을 반환, 아니면 null. prog가
// 필요한 이유는(다른 isXConstructorCall과 달리) 판별 기준이 고정 네임스페이스 문자열이 아니라
// 동적으로 등록된 타입명 집합이기 때문.
// scope가 함께 주어지면(옵션, C225) `obj.copy()`(컴파일러 내장 pseudo-method, C125/DIVERGENCES.md
// #57 -- 실제 TV 문법, corpus가 쓰는 정적 `TypeName.copy(instance)` 워크어라운드와는 다름)도
// 인정한다 -- obj가 resolveUdtObjectType(index-access.ts, C224가 확립한 scope 체인/매개변수/
// top-level var 조회 순서)로 이미 UDT 인스턴스로 확정돼 있으면 그 타입을 그대로 반환(복사본은
// 원본과 동일 타입). isArrayConstructorCall/isMapConstructorCall의 옵션 prog+scope 확장(C222/C223)과
// 동일 원칙 -- scope 생략 호출부는 기존 `.new()` 전용 동작 그대로 무변화.
// UDF 호출(C253, corpus "네임스페이스 접근은 호출식만 지원" 클러스터 -- `sig = calcSignal()` 후
// `sig.value`)도 인정한다 -- callee가 Identifier이고 prog.funcs에 등록된 UDF/method이며 그
// FuncInfo.returnUdtType(analyzer.ts inferFuncBodyReturnUdtType이 그 UDF 자신의 마지막 본문 문장에서
// 미리 추론해둔 값)이 non-null이면 그 타입을 그대로 인정 -- scope 없이도 성립(prog.funcs는 전역
// 레지스트리, 이름 충돌 없음). UDF 본문 안에서 다른 UDF를 호출하는 것 자체가 별도로 하드 에러이므로
// (analyzer/call-expr.ts) 이 경로가 재귀 호출과 뒤섞일 걱정은 없다.
// 삼항(TernaryOp, C253)도 scope가 주어지면 인정한다 -- `cond ? A.new(...) : A.new(...)`처럼 두 분기가
// 재귀적으로 같은 UDT 타입일 때만(하나라도 null이거나 서로 다른 타입이면 전체 null).
export function isUdtConstructorCall(value: Expr, prog: AnalyzedProgram, scope?: LexScope): string | null {
  if (
    value.kind === "CallExpr" &&
    value.callee.kind === "DotAccess" &&
    value.callee.obj.kind === "Identifier" &&
    value.callee.attr === "new" &&
    prog.udtTypes.has(value.callee.obj.name)
  ) {
    return value.callee.obj.name;
  }
  // chart.point.new/from_index/from_time/copy/now(...)(C639, wild "네임스페이스 접근은 호출식만
  // 지원" 클러스터 Identifier-root 서브버킷 다수 원인 — `var secondHighPoint = chart.point.new(...)`/
  // `var ath = chart.point.now(...)`/func-local `x = chart.point.new(...)`류 명시 typeHint 없는
  // 초기값). call-expr.ts analyzeCallExpr가 이 3-level DotAccess(obj가 다시 DotAccess인 chart.point)
  // 콜 자체는 이미 인식하지만(C486/C487), isUdtConstructorCall은 그 결과값이 CHART_POINT_FIELD_TYPE을
  // 담는다는 것을 몰라 var/'=' 로컬/func-local var 등록 경로(analyzeVarDecl explicitUdtType??
  // inferredUdtType, L4539/L4616 주석이 이미 이 대칭을 기대하고 있었음)가 전부 조용히 실패했다.
  // 위 Type.new() 분기와 달리 obj가 Identifier가 아니라 "chart.point" 자신이 DotAccess라 별도 분기 필요.
  if (
    value.kind === "CallExpr" &&
    value.callee.kind === "DotAccess" &&
    value.callee.obj.kind === "DotAccess" &&
    value.callee.obj.obj.kind === "Identifier" &&
    value.callee.obj.obj.name === "chart" &&
    value.callee.obj.attr === "point" &&
    (value.callee.attr === "new" ||
      value.callee.attr === "from_index" ||
      value.callee.attr === "from_time" ||
      value.callee.attr === "copy" ||
      value.callee.attr === "now")
  ) {
    return CHART_POINT_FIELD_TYPE;
  }
  if (scope !== undefined && value.kind === "CallExpr" && value.callee.kind === "DotAccess" && value.callee.attr === "copy") {
    const objType = resolveUdtObjectType(value.callee.obj, prog, scope);
    if (objType !== undefined) return objType;
  }
  if (value.kind === "CallExpr" && value.callee.kind === "Identifier") {
    const funcInfo = prog.funcs.get(value.callee.name);
    if (funcInfo !== undefined && funcInfo.returnUdtType !== null) return funcInfo.returnUdtType;
  }
  // request.security(sym, tf, f()) 스칼라 bare-UDF passthrough(C436) 결과 UDT 힌트(C621, wild
  // "네임스페이스 접근은 호출식만 지원" 클러스터 재조사 — `biasRaw = request.security(tk, tf,
  // f_bias_engine())` 뒤 `biasRaw.biasFlag`). codegen(C436, genCallExpr)이 바깥 request.security
  // 노드를 완전히 버리고 내부 UDF 콜을 그 자리에서 그대로 genExpr하므로(HTF 캐시/프리패스 없음),
  // 런타임 값은 이미 그 UDF의 진짜 반환값(UDT 인스턴스)과 동일하다 — 정적 UDT 분류도 동일하게
  // 물려받아야 필드 접근이 이 오탐으로 막히지 않는다. securityScalarBareUdfCallSlots는
  // analyzeCallExpr의 request.security 분기가 값 분석 시점에 이미 등록해둔 것(analyzeVarDecl 등
  // 모든 호출부가 udtTypeName을 계산하기 전에 항상 stmt.value를 먼저 analyzeExpr하므로 조회
  // 시점엔 이미 채워져 있다). 내부 콜이 var-subst 폼(Identifier)이면 그 변수 자신이 이미 UDT로
  // 확정돼 있는지 resolveUdtObjectType(scope 체인/매개변수/top-level var 조회, C224)로 재조회한다.
  if (
    value.kind === "CallExpr" &&
    value.callee.kind === "DotAccess" &&
    value.callee.obj.kind === "Identifier" &&
    value.callee.obj.name === "request" &&
    value.callee.attr === "security"
  ) {
    const scalarInner = prog.securityScalarBareUdfCallSlots.get(value);
    if (scalarInner !== undefined) {
      if (scalarInner.kind === "CallExpr" && scalarInner.callee.kind === "Identifier") {
        const funcInfo = prog.funcs.get(scalarInner.callee.name);
        if (funcInfo !== undefined && funcInfo.returnUdtType !== null) return funcInfo.returnUdtType;
      } else if (scope !== undefined) {
        const t = resolveUdtObjectType(scalarInner, prog, scope);
        if (t !== undefined) return t;
      }
    }
  }
  // C636: 삼항 양쪽 분기가 생성자 콜 자신이 아니라 "이미 UDT로 확정된 값을 그대로 참조"하는 형태도
  // 인정한다(wild `plan1 = not na(planRaw1) ? planRaw1 : defaultPlan`류 — 양쪽 다 bare Identifier가
  // 이미 다른 경로(request.security 스칼라 bare-UDF passthrough/`var X = T.new(...)`)로 UDT 확정된
  // 변수). isUdtConstructorCall만으로는 각 분기 자신이 새 생성자 콜이어야 해서(재귀는 중첩 삼항만
  // 커버) 이 형태를 놓쳤다 — resolveUdtObjectType(Identifier/DotAccess 조회, C224)를 분기별 폴백으로
  // 추가, 기존 "양쪽 다 확정 + 서로 같은 타입" 불변식은 그대로 유지.
  if (scope !== undefined && value.kind === "TernaryOp") {
    const trueType = isUdtConstructorCall(value.trueExpr, prog, scope) ?? resolveUdtObjectType(value.trueExpr, prog, scope) ?? null;
    const falseType = isUdtConstructorCall(value.falseExpr, prog, scope) ?? resolveUdtObjectType(value.falseExpr, prog, scope) ?? null;
    if (trueType !== null && trueType === falseType) return trueType;
  }
  return null;
}

// matrix 객체를 새로 만들어 반환하는 콜인지 구조만 본다(C90, isMapConstructorCall과 동일 원칙) --
// C90은 new 하나뿐이었으나 C93(네 번째 슬라이스)이 새 행렬을 반환하는 copy/concat/submatrix/
// reshape/diff 5종을 추가(fill/reverse/sort는 in-place 뮤테이터라 반환값이 없어 여기 해당 없음 --
// MUTATING_ARRAY_BUILTINS 쪽에 등재). C96(행렬 대수 첫 항목)이 transpose를 추가.
const MATRIX_CONSTRUCTOR_METHODS = new Set([
  "new",
  "copy",
  "concat",
  "submatrix",
  "reshape",
  "diff",
  "transpose",
  "inv",
  "pow",
  "kron",
  "pinv",
  // eigenvectors(C106, 행렬 대수 마지막 항목) -- eigenvalues와 반대로 array가 아니라 matrix<float>를
  // 반환한다(matrix.ts rt.matrix.eigenvectors 주석 참조).
  "eigenvectors",
]);

export function isMatrixConstructorCall(value: Expr): boolean {
  return (
    value.kind === "CallExpr" &&
    value.callee.kind === "DotAccess" &&
    value.callee.obj.kind === "Identifier" &&
    value.callee.obj.name === "matrix" &&
    MATRIX_CONSTRUCTOR_METHODS.has(value.callee.attr)
  );
}

// matrix.mult(id1, id2)인지 구조만 본다(C97) -- MATRIX_CONSTRUCTOR_METHODS에 못 넣는 이유는 반환
// 컨테이너 타입이 두 번째 인자(id2) 타입에 따라 갈리기 때문(matrix.ts rt.matrix.mult 주석 참조:
// 스칼라/행렬 인자 -> matrix, 벡터 인자 -> array). 이 구조 판별과 별개로 classifyMultResultIsArray가
// id2를 검사해 실제 분류를 정한다.
export function isMatrixMultCall(value: Expr): boolean {
  return (
    value.kind === "CallExpr" &&
    value.callee.kind === "DotAccess" &&
    value.callee.obj.kind === "Identifier" &&
    value.callee.obj.name === "matrix" &&
    value.callee.attr === "mult"
  );
}

// matrix.sum(id1, id2)인지 구조만 본다(C658) -- isMatrixMultCall과 동일한 이유로
// MATRIX_CONSTRUCTOR_METHODS에 못 넣는다: matrix.sum(id1)(1-인자)은 스칼라 집계(전체 원소 합)를
// 반환하지만 matrix.sum(id1, id2)(2-인자, C656 신규 오버로드)는 원소별 덧셈으로 matrix를 반환한다
// -- mult처럼 값에 따라 반환 컨테이너 종류가 갈리는 게 아니라 **인자 개수** 자체가 신호이므로
// args.length===2만 확인하면 충분(id2 타입 분기 불필요, mult의 isMatrixMultVectorArg 대응물 없음).
export function isMatrixSumCall(value: Expr): boolean {
  return (
    value.kind === "CallExpr" &&
    value.callee.kind === "DotAccess" &&
    value.callee.obj.kind === "Identifier" &&
    value.callee.obj.name === "matrix" &&
    value.callee.attr === "sum" &&
    value.args.length === 2
  );
}

// matrix.mult(id1, id2)의 두 번째 인자(id2)가 벡터(array)로 판별되는지 검사한다(C97) -- Identifier면
// resolveContainerExprKind로 판별(matrixVars면 명시적으로 false, 즉 matrix 취급),
// array.from(...) 등 배열 생성자 콜이 인자 자리에 직접 오면 isArrayConstructorCall로 구조 판별.
// 그 외(숫자 리터럴/산술식/미상 identifier 등)는 전부 false(matrix 취급) -- pine2py의 스칼라 분기와
// 행렬 분기가 둘 다 matrix를 반환하므로 "array라는 적극적 증거가 없으면 matrix"가 안전한 기본값
// (반대로 잘못 분류하면 array인데 matrix로 취급 → 존재하지 않는 히스토리 차단 오탐만 발생하는
// matrix보다, matrix인데 array로 잘못 분류하는 쪽이 더 위험하므로 이 비대칭 기본값이 안전한 방향).
// C503: Identifier 판별을 prog.arrayVars(top-level 전용) 직접 조회에서 resolveContainerExprKind로
// 교체 -- wild `Y = array.new_float(len)`(top-level '=' 로컬) 후 `.mult(Y)`가 scope.containerKindHints에만
// 등록돼 arrayVars 조회로는 안 잡혀 matrix로 오분류되던 비대칭 해소(LIMITATIONS C502 (2)). '=' 로컬/
// func-local var/UDF 매개변수까지 조회가 넓어지지만 array 힌트가 이미 확정된 경우에만 참을 반환하는
// 기존 관용구를 그대로 재사용할 뿐이라 과욕 확장 아님(C232 원칙 재확인).
export function isMatrixMultVectorArg(other: Expr, prog: AnalyzedProgram, scope: LexScope): boolean {
  if (other.kind === "Identifier") return resolveContainerExprKind(other, prog, scope) === "array";
  return isArrayConstructorCall(other);
}

// matrix method-call 스타일 체이닝(`m.transpose().mult(other)`류, C494)의 수신자가 matrix를
// 새로 반환하는 콜인지 판별 -- isMatrixConstructorCall/isMatrixMultCall(위)은 리터럴 `matrix.foo(...)`
// 폼만 인정하므로, 수신자(callee.obj)가 이미 resolveMatrixExprKind로 matrix로 확정된 '=' 로컬/
// top-level var/matrix 체이닝 결과(재귀)일 때 method가 MATRIX_CONSTRUCTOR_METHODS에 있거나
// mult이면서 두 번째 인자가 벡터가 아닌 경우도 matrix 반환으로 인정한다(map.keys/values의
// C455 method-call 체이닝과 동일 원칙). literal `matrix.foo(...)` 수신자는 위 두 함수가 이미
// 다루므로 여기서는 제외(중복 판정 방지).
export function isMatrixReturningMethodSugarCall(value: Expr, prog: AnalyzedProgram, scope: LexScope): boolean {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess") return false;
  const recv = value.callee.obj;
  if (recv.kind === "Identifier" && recv.name === "matrix") return false;
  if (!resolveMatrixExprKind(recv, prog, scope)) return false;
  const method = value.callee.attr;
  if (MATRIX_CONSTRUCTOR_METHODS.has(method)) return true;
  if (method === "mult") {
    // sugar 폼(`recv.mult(other)`)은 리터럴 폼(`matrix.mult(recv, other)`)과 달리 receiver가
    // args에 끼워지지 않아 "other"가 args[1]이 아니라 args[0]이다(literal 전용 isMatrixMultCall
    // 소비처의 args[1] 관례와 혼동 금지).
    const other = value.args[0];
    return other !== undefined && !isMatrixMultVectorArg(other, prog, scope);
  }
  if (method === "sum") {
    // C658: sugar 폼(`recv.sum(other)`)의 1-인자 형태는 matrix.sum(id1,id2) 2-인자 원소별 덧셈
    // 오버로드(C656)와 동형 — mult와 마찬가지로 receiver가 args에 끼워지지 않아 args[0]이 그
    // "other". 인자 없는 `recv.sum()`은 스칼라 집계(matrix.sum(id1) 1-인자 폼)라 matrix 반환이
    // 아니므로 제외.
    return value.args.length === 1;
  }
  return false;
}

// label/line/box/table/polyline/linefill 핸들을 새로 만드는 콜인지 구조만 본다(C232, ROADMAP P3
// next_hint 1순위 -- corpus 실측 lbl.set_text/ln.set_color/b.set_lefttop/t.cell_set_text류
// method-call sugar. linefill은 C238이 추가 -- corpus b7dde3c9d51e.pine의 `lf = linefill.new(...)`
// 1건). array/map/matrix와 달리 반환 kind가 리터럴 네임스페이스 하나로 고정되지 않고 6종으로
// 갈리므로(isArrayConstructorCall류의 boolean이 아니라) 성공한 kind 문자열 자체 | null을 반환한다.
// label/line/box는 new/copy 둘 다 같은 kind의 새 핸들을 반환하지만(DRAWING_METHODS의 각 Set에
// "copy"가 등재된 3종과 정확히 일치) table/polyline/linefill은 copy 자체가 없다(DRAWING_METHODS에
// 미등재 -- call-expr.ts DRAWING_METHODS 주석 참조, pine2py FUNC_MAP도 linefill.copy가 없음).
export type DrawingKind = "label" | "line" | "box" | "table" | "polyline" | "linefill";
const DRAWING_COPY_KINDS: ReadonlySet<DrawingKind> = new Set(["label", "line", "box"]);
export function isDrawingConstructorCall(value: Expr): DrawingKind | null {
  if (value.kind !== "CallExpr") return null;
  // 타입캐스트 bare 콜 폼(`box(na)`/`line(na)`/`label(na)`/`table(na)`, call-expr.ts C301 drawingCast
  // 분기와 동일 4종): 아직 실제 핸들을 안 만든 drawing 변수를 선언할 때 쓰는 관용구(wild 111파일,
  // `var box1 = box(na)` 후 `box1 := box.new(...)`)로 `.new()`/`.copy()`와 마찬가지로 흔하다. 캐스트는
  // 값 변환이 없으므로(GOAL.md drawing 핸들 no-op) 반환 kind는 인자와 무관하게 콜 대상 타입 자신으로
  // 고정 -- 이 힌트가 없으면 이후 `box1.set_right(...)` 같은 method-call sugar가 drawingKindHints
  // 미등재로 "지원하지 않는 호출"에 걸린다.
  if (value.callee.kind === "Identifier") {
    const ns = value.callee.name;
    if (ns === "label" || ns === "line" || ns === "box" || ns === "table") return ns;
    return null;
  }
  if (value.callee.kind !== "DotAccess" || value.callee.obj.kind !== "Identifier") {
    return null;
  }
  const ns = value.callee.obj.name;
  if (ns !== "label" && ns !== "line" && ns !== "box" && ns !== "table" && ns !== "polyline" && ns !== "linefill") return null;
  const method = value.callee.attr;
  if (method === "new") return ns;
  if (method === "copy" && DRAWING_COPY_KINDS.has(ns)) return ns;
  return null;
}

// array<label/line/box/table/linefill> 원소 kind 추적(C352, wild "지원하지 않는 호출" 클러스터 --
// `heatmap = array.new_box()` 뒤 `for b in heatmap \n b.delete()`류 -- for-in 루프 변수가 이 배열의
// 원소이므로 drawing 핸들 method-call sugar(위 isDrawingConstructorCall과 동일한 DRAWING_METHODS
// 디스패치)를 받을 자격이 있다). isArrayConstructorCall이 이미 이 5종 typed 생성자를 "array를
// 반환하는 콜"로만 인정할 뿐 원소 kind는 버렸던 것의 보완 -- polyline은 array.new_polyline이
// pine2py/TV 양쪽에 없어 제외(ARRAY_CONSTRUCTOR_METHODS와 동일 5종 대응).
const ARRAY_DRAWING_CONSTRUCTOR_KIND: Readonly<Record<string, DrawingKind>> = {
  new_label: "label",
  new_line: "line",
  new_box: "box",
  new_table: "table",
  new_linefill: "linefill",
};
// array.new<box>() 등 제네릭 폼(C357, wild 452파일 실측 -- next_hint가 예고한 arrayUdtConstructorElemType
// 대칭 배선). parser.ts가 attr을 T와 무관하게 "new_generic" 하나로 뭉개므로(C230) 위 5종 전용 attr
// 리터럴 분기로는 이 폼을 못 잡는다 -- 보존해둔 DotAccess.genericElemType(C355)이 DRAWING_ALL_NAMESPACES
// 6종(위 literal 5종 + polyline, array.new_polyline 자체는 없지만 제네릭 폼 `array.new<polyline>()`은
// 가능) 중 하나일 때만 인정.
// prog(옵션, C683 -- arrayUdtConstructorElemType의 bare UDF 콜 분기(C458)와 대칭)이 주어지고
// value가 `helper()`류 bare UDF 콜(Identifier callee)이면 FuncInfo.returnArrayElemDrawingKind를
// 그대로 인정한다 -- wild `fvgDn = fvg(-3)`(fvg()의 마지막 문장이 array<box> 로컬을 그대로 반환)
// 뒤 `fvgDn.get(i).get_top()`류. prog 생략 호출부(scope 없는 순수 정적 스캔)는 기존 동작 그대로.
export function arrayDrawingConstructorElemKind(value: Expr, prog?: AnalyzedProgram): DrawingKind | null {
  if (value.kind !== "CallExpr") return null;
  if (value.callee.kind === "Identifier") {
    return prog?.funcs.get(value.callee.name)?.returnArrayElemDrawingKind ?? null;
  }
  if (value.callee.kind !== "DotAccess" || value.callee.obj.kind !== "Identifier") {
    return null;
  }
  if (value.callee.obj.name !== "array") return null;
  const literalKind = ARRAY_DRAWING_CONSTRUCTOR_KIND[value.callee.attr];
  if (literalKind !== undefined) return literalKind;
  if (value.callee.attr === "new_generic" && value.callee.genericElemType !== undefined) {
    const t = value.callee.genericElemType;
    return DRAWING_ALL_NAMESPACES.has(t) ? (t as DrawingKind) : null;
  }
  return null;
}

// array<UDT> 원소 타입 추적(C355, arrayDrawingConstructorElemKind의 UDT 버전 -- 나란한 구조) --
// `var allGaps = array.new<Gap>()`(명시 typeHint 없는 top-level var)의 T를 구조만으로 판별한다.
// 5종 원시 타입/drawing 타입과 달리 UDT는 parser.ts가 attr을 "new_generic" 하나로 뭉개(C230) T별
// 전용 attr이 없으므로, 대신 파서가 소비 도중 보존해둔 DotAccess.genericElemType(C355, ast.ts 참조)을
// 읽고 그 이름이 실제 등록된 UDT 타입명일 때만 인정한다(등록 안 된 이름 -- label/chart.point의 첫
// dotted 세그먼트 "chart" 등 -- 은 prog.udtTypes.has()가 자연히 걸러냄). arrayUdtElemType(typeHint
// 문자열 파싱, udt-types.ts)과 나란한 "생성자 콜 자체에서 직접 판별" 경로 -- 명시 typeHint가 있는
// 경우는 여전히 그쪽이 담당(analyzeVarDecl이 두 경로를 `??`로 합성).
// scope(옵션, C457 -- wild `sorted_levels = array.copy(sr_levels)` 후 `level1 = array.get(sorted_levels,
// j)` / `level1.strength`류, level.* 잔존 1건)가 주어지면 canonical `array.copy(container)`와
// method-sugar `container.copy()`도 인정한다 -- copy는 항상 원본과 같은 원소 타입의 새 배열을
// 반환하므로, container 자신이 이미 resolveArrayElemUdtType(scope 체인의 arrayElemUdtKindHints ->
// top-level arrayElemUdtType -> 매개변수 typeHint, analyzer.ts)로 확정된 array<UDT>면 그 타입을
// 그대로 물려받는다. scope 생략 호출부(prepassInferParamUdtTypesFromCallSites, scope 없는 순수
// 정적 스캔)는 기존 new_generic 전용 동작 그대로 무변화.
export function arrayUdtConstructorElemType(value: Expr, prog: AnalyzedProgram, scope?: LexScope): string | null {
  if (value.kind !== "CallExpr") return null;
  // isArrayConstructorCall의 bare UDF 콜 분기(C458)와 짝 -- 원소 타입명 자체는 FuncInfo에 이미
  // 확정돼 있다.
  if (value.callee.kind === "Identifier") {
    return prog.funcs.get(value.callee.name)?.returnArrayElemUdtType ?? null;
  }
  if (value.callee.kind !== "DotAccess") return null;
  const callee = value.callee;
  if (callee.obj.kind === "Identifier" && callee.obj.name === "array") {
    if (callee.attr === "new_generic") {
      const typeName = callee.genericElemType;
      return typeName !== undefined && (prog.udtTypes.has(typeName) || typeName === CHART_POINT_FIELD_TYPE)
        ? typeName
        : null;
    }
    if (callee.attr === "copy" && scope !== undefined) {
      const container = value.args[0];
      return container !== undefined ? resolveArrayElemUdtType(container, prog, scope) : null;
    }
    return null;
  }
  if (callee.attr === "copy" && scope !== undefined && resolveContainerExprKind(callee.obj, prog, scope) === "array") {
    return resolveArrayElemUdtType(callee.obj, prog, scope);
  }
  return null;
}

// matrix<drawing> 원소 kind 추적(C618, arrayDrawingConstructorElemKind와 동일 원칙 -- wild
// `var Ang = matrix.new<line>(4,13,line(na))` 뒤 `Ang.get(0,i).delete()`). matrix엔 array의
// new_box 등 typed suffix 생성자 자체가 없어(MATRIX_REGISTRY는 "new" 하나뿐, matrix.ts 참조)
// 리터럴 분기가 불필요 -- 파서가 보존한 DotAccess.genericElemType(matrix.new<T>() 전용 lookahead,
// parser.ts 참조)이 DRAWING_ALL_NAMESPACES 6종 중 하나일 때만 인정하는 제네릭 분기 하나로 충분.
export function matrixDrawingConstructorElemKind(value: Expr): DrawingKind | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess" || value.callee.obj.kind !== "Identifier") {
    return null;
  }
  if (value.callee.obj.name !== "matrix" || value.callee.attr !== "new") return null;
  const t = value.callee.genericElemType;
  if (t === undefined) return null;
  return DRAWING_ALL_NAMESPACES.has(t) ? (t as DrawingKind) : null;
}

// matrix<UDT> 원소 타입 추적(C618, arrayUdtConstructorElemType과 동일 원칙 -- matrixDrawingConstructorElemKind
// 바로 위와 나란한 UDT 버전). '=' 로컬/copy 상속 경로는 array 쪽도 wild 근거가 옅어(C355) matrix는
// 아예 두지 않는다 -- 필요해지면 추가(과욕 금지).
export function matrixUdtConstructorElemType(value: Expr, prog: AnalyzedProgram): string | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess" || value.callee.obj.kind !== "Identifier") {
    return null;
  }
  if (value.callee.obj.name !== "matrix" || value.callee.attr !== "new") return null;
  const t = value.callee.genericElemType;
  if (t === undefined) return null;
  return prog.udtTypes.has(t) || t === CHART_POINT_FIELD_TYPE ? t : null;
}

// map<K, drawing> 값 kind 추적(C684, matrixDrawingConstructorElemKind와 동일 원칙 -- wild
// `var aoeLevels = map.new<string, box>()` 뒤 `getHighBox = aoeLevels.get("High")` \
// `getHighBox.get_top()`류). map엔 array의 new_box 등 typed suffix 생성자 자체가 없어 리터럴
// 분기가 불필요 -- 파서가 보존한 DotAccess.genericElemType(map.new<K,V>()의 V,
// parser.ts consumeMapNewGenericValueTypeArg)이 DRAWING_ALL_NAMESPACES 6종 중 하나일 때만 인정.
export function mapDrawingConstructorValueKind(value: Expr): DrawingKind | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess" || value.callee.obj.kind !== "Identifier") {
    return null;
  }
  if (value.callee.obj.name !== "map" || value.callee.attr !== "new") return null;
  const t = value.callee.genericElemType;
  if (t === undefined) return null;
  return DRAWING_ALL_NAMESPACES.has(t) ? (t as DrawingKind) : null;
}

// map<K, UDT> 값 타입 추적(C684, mapDrawingConstructorValueKind 바로 위와 나란한 UDT 버전 --
// matrixUdtConstructorElemType과 동일 원칙). copy/별칭 상속 경로는 map엔 두지 않는다(과욕 금지,
// 필요해지면 arrayUdtConstructorElemType의 C457 copy 분기를 대칭 이식).
export function mapUdtConstructorValueType(value: Expr, prog: AnalyzedProgram): string | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess" || value.callee.obj.kind !== "Identifier") {
    return null;
  }
  if (value.callee.obj.name !== "map" || value.callee.attr !== "new") return null;
  const t = value.callee.genericElemType;
  if (t === undefined) return null;
  return prog.udtTypes.has(t) || t === CHART_POINT_FIELD_TYPE ? t : null;
}

// label.all/line.all/box.all/table.all/polyline.all/linefill.all(C244, ROADMAP P3 next_hint 1순위 --
// C238이 스코프를 확인해둠) -- pine2py codegen.py IDENTIFIER_MAP이 6종 전부 "[]"(빈 리스트 리터럴)로
// 접는다(백테스팅 환경엔 실제로 그려진 객체를 추적하는 채널이 없어 항상 빈 배열, drawing 객체
// no-op + 카운트만 기록하는 GOAL.md 원칙과 정합). isDrawingConstructorCall과 달리 CallExpr이 아니라
// 인자 없는 값 위치 DotAccess(order.ascending/math.pi류와 같은 구조)라 여기서는 별도 병렬 맵
// (analyzer.ts builtinArrayConstants)에 등록하는 쪽이 analyzer.ts 담당이고, 이 함수는 그와 별개로
// `var lbls = label.all`처럼 top-level var 초기값으로 쓰일 때 arrayVars 등록 여부를 구조만으로
// 판별한다(isArrayConstructorCall과 동일한 "analyzeVarDecl이 값 분석 전에 호출" 원칙 — 6종 모두
// 같은 [] 값이라 kind를 구분해 반환할 필요가 없어 boolean으로 충분).
export const DRAWING_ALL_NAMESPACES: ReadonlySet<string> = new Set(["label", "line", "box", "table", "polyline", "linefill"]);
export function isDrawingAllConstant(value: Expr): boolean {
  return (
    value.kind === "DotAccess" &&
    value.attr === "all" &&
    value.obj.kind === "Identifier" &&
    DRAWING_ALL_NAMESPACES.has(value.obj.name)
  );
}
