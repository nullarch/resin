// DotAccess/IndexAccess 분석 유틸(analyzer.ts 파일 분할 일곱 번째 슬라이스, C147) -- 순수 이동,
// 신규 검증 로직 0줄. describeDotAccess/analyzeIndexAccess는 analyzer.ts의 analyzeExpr(DotAccess/
// IndexAccess 케이스)에서만 소비되는 module-private 헬퍼이고, resolveUdtObjectType은 그와 별개로
// analyzer/call-expr.ts와 analyzer/udt-decls.ts가 값으로 import하는 외부 소비처가 있어(analyzer.ts가
// 재수출) 셋 다 export한다. analyzeExpr을 값으로 import해 진짜 순환 import가 생기지만 참조가
// analyzeIndexAccess 본문 안(지연 평가)이라 안전(C142 ta.ts가 확립한 패턴 재적용).
import type { Assignment, CallExpr, Expr, IndexAccess, TupleDestructure } from "../ast";
import type { AnalyzedProgram, FuncInfo, LexScope } from "../analyzer";
import {
  BAR_INDEX_NAME,
  BAR_SERIES_NAMES,
  BARSTATE_PROPS,
  CHART_POINT_FIELD_TYPE,
  DERIVED_PRICE_NAMES,
  SESSION_PROPS,
  STRATEGY_RUNTIME_PROPS,
  TIME_FUNC_NAMES,
  TIME_VAR_NAMES,
  analyzeExpr,
  isStringExpr,
  resolveAmbiguousNestedVarDeclStmt,
  resolveContainerExprKind,
  resolveDrawingExprKind,
  resolveMatrixExprKind,
  resolveUdtFieldTypeHint,
} from "../analyzer";
import {
  DRAWING_ALL_NAMESPACES,
  isArrayConstructorCall,
  isDrawingConstructorCall,
  isMapConstructorCall,
  isMatrixConstructorCall,
  isUdtConstructorCall,
} from "./constructors";
import { arrayNumericElemTypeHint } from "./udt-types";

export function describeDotAccess(expr: Expr & { kind: "DotAccess" }): string {
  const objName = expr.obj.kind === "Identifier" ? expr.obj.name : "?";
  return `${objName}.${expr.attr}`;
}

// resolveLocalContainerKind(analyzer.ts)와 동일한 체인 탐색을 udtKindHints에 적용(C224, '=' 로컬
// UDT 인스턴스 판별 전용).
function resolveLocalUdtKind(scope: LexScope, name: string): string | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.udtKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalUdtKind와 동일한 체인 탐색을 stringLocalHints에 적용(C363, top-level '=' 로컬
// 히스토리 슬라이스의 string 가드 전용 — LexScope.stringLocalHints 주석 참조).
function resolveLocalStringHint(scope: LexScope, name: string): boolean {
  let s: LexScope | null = scope;
  while (s) {
    if (s.stringLocalHints.has(name)) return true;
    s = s.parent;
  }
  return false;
}

// 중첩 블록(script top-level, depth>0) '=' 로컬 히스토리(C450, C714로 대입문 노드 키잉으로 전환)의
// 무모호 선언 해석 — resolveFuncInternalRole(func 경계 안에서 s.func===func 조건으로 조상-스코프를
// 거슬러 오르는 것)과 동일 원칙이지만 여기는 func 경계가 아니라 "script top-level scope 체인 전체"가
// 대상이다(s.func===null인 동안 계속 거슬러 오름 — pushScope가 부모의 func를 그대로 물려주므로
// top-level 스코프는 항상 func===null). 읽기 지점(scope)에서 시작해 부모로 거슬러 오르며 각 스코프
// 자신이 직접 선언한 대입문(nestedEqLocalDeclStmts, names와 달리 "이 스코프가 직접"만 담음)을 찾는
// 구조 자체가 "선언 스코프가 읽기 지점의 조상(또는 자기 자신)"임을 보장해 JS let 블록 스코프 가시성과
// 정확히 같은 안전 조건이 된다 — 형제 블록은 서로의 조상이 아니므로 같은 이름이 여러 블록에 각각
// 선언돼도(C369 "TV는 섀도우 로컬의 독립 시리즈") 이 탐색은 읽기 지점마다 최대 하나만 찾아낸다.
// 선언 블록 전부의 조상이 아닌 위치(형제/이후 문장, 또는 애초에 이 이름이 전혀 없음)면 null(호출부가
// 하드 에러로 폴백).
// C748부터 반환 타입에 TupleDestructure가 추가됐다(nestedEqLocalDeclStmts가 '='와 튜플 디스트럭처
// 선언을 공유하는 값 타입으로 확장 — LexScope.nestedEqLocalDeclStmts 주석 참조). 호출부가
// declStmt.kind로 분기해 원소 kind 조회 방식(resolveEqLocalNonNumericKind vs
// AnalyzedProgram.nestedTupleElemKinds)만 갈라 쓴다.
function resolveAmbiguousNestedEqLocalDeclStmt(scope: LexScope, name: string): Assignment | TupleDestructure | null {
  let s: LexScope | null = scope;
  while (s !== null && s.func === null) {
    const stmt = s.nestedEqLocalDeclStmts.get(name);
    if (stmt !== undefined) return stmt;
    s = s.parent;
  }
  return null;
}

// resolveAmbiguousNestedEqLocalDeclStmt의 함수 경계 판(C714 UDF 확장, next_hint(C715)) — 함수
// 안(s.func===func인 동안)에서만 조상 스코프를 거슬러 오르며 각 스코프가 직접 선언한
// nestedEqLocalDeclStmts를 찾는다. udf-body 루트 스코프는 이 맵에 등록하지 않으므로(그 축은
// func.eqLocalNames 이름-키가 담당) 이 탐색은 항상 "중첩(non-root)" 선언만 대상이다 — 원본과
// 동일하게 형제 블록은 서로의 조상이 아니라 항상 무모호.
function resolveAmbiguousFuncNestedEqLocalDeclStmt(func: FuncInfo, scope: LexScope, name: string): Assignment | null {
  let s: LexScope | null = scope;
  while (s !== null && s.func === func) {
    const stmt = s.nestedEqLocalDeclStmts.get(name);
    // C748: nestedEqLocalDeclStmts는 이제 script top-level 튜플 디스트럭처(scope.func===null 전용
    // 등록, analyzeTupleDestructure 참조)도 담을 수 있지만 이 UDF 경계 판은 s.func===func인 스코프만
    // 훑으므로 그런 항목을 절대 만나지 않는다 — 방어적 타입 좁히기(never true).
    if (stmt !== undefined) return stmt.kind === "TupleDestructure" ? null : stmt;
    s = s.parent;
  }
  return null;
}

// 명시 typeHint 문자열("series float"/"array<int>"/"MyType" 등)이 Float64Array 히스토리 슬롯에
// 담을 수 없는 참조형/문자열 타입이면 그 종류 문구를, 아니면 null을 반환한다(C364, UDF 매개변수/
// 내부 var 히스토리 타입 가드 — 읽기 시점 lazy 분류라 UDT/enum forward-ref 등록 순서와 무관하게
// 안전, FuncInfo.paramTypeHints 주석 참조).
function classifyNonNumericTypeHint(hint: string | null, prog: AnalyzedProgram): string | null {
  if (hint === null) return null;
  const parts = hint.trim().split(/\s+/);
  const first = parts[0]!;
  const base = parts.length > 1 && (first === "series" || first === "simple" || first === "const") ? parts[1]! : first;
  if (base === "string") return "string";
  if (base === "array" || base.startsWith("array<")) return "array";
  if (base === "map" || base.startsWith("map<")) return "map";
  if (base === "matrix" || base.startsWith("matrix<")) return "matrix";
  if (DRAWING_ALL_NAMESPACES.has(base)) return "drawing handle";
  if (prog.udtTypes.has(base)) return "UDT";
  if (prog.enumTypes.has(base)) return "enum";
  return null;
}

// '=' 로컬(top-level/UDF 내부 공통)이 히스토리 슬롯에 담을 수 없는 값을 담고 있으면 그 종류 문구를
// 반환한다 — C363이 (a)슬라이스에 쓴 5종 구조 판별 리졸버(전부 스코프 체인 기반이라 UDF 본문
// 스코프에서도 동일하게 동작 — analyzeAssignment의 isNewLocal 힌트 기입이 func 게이트 없이
// 균일함을 재확인)를 한 번에 묶은 (b)슬라이스용 헬퍼.
function resolveEqLocalNonNumericKind(obj: Expr, prog: AnalyzedProgram, scope: LexScope, name: string): string | null {
  if (resolveLocalStringHint(scope, name)) return "string";
  if (resolveContainerExprKind(obj, prog, scope) !== null) return "array/map";
  if (resolveMatrixExprKind(obj, prog, scope)) return "matrix";
  if (resolveDrawingExprKind(obj, prog, scope) !== null) return "drawing handle";
  if (resolveUdtObjectType(obj, prog, scope) !== undefined) return "UDT";
  return null;
}

// UDF/method 튜플 반환의 원소 하나가 Float64Array 히스토리 슬롯에 담을 수 없는 값이면 그 종류
// 문구를 반환한다(C369, top-level 튜플 디스트럭처 히스토리 슬라이스 — FuncInfo.tupleElemNonNumericKinds
// 주석 참조). 분석은 본문 스코프(힌트 전부 누적된 시점)에서 호출된다. Identifier 원소는 C364의
// 3-role 가드(param/var/'=' 로컬)와 동일한 신호를 역할별로 적용하고, 자유 이름(top-level 참조)은
// prog.varTypeHints(리졸버가 못 보는 var string/enum 힌트) 폴백 후 C363 리졸버 5종으로 판별한다.
// 비-Identifier 원소는 같은 리졸버 배터리를 원소 식에 직접 적용(순수 구조 판별 — 값 흐름 추적
// 없음, 못 잡는 복합식은 기존 '=' 로컬 가드와 동일한 노출면으로 LIMITATIONS에 문서화).
export function classifyTupleElemNonNumericKind(el: Expr, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (el.kind === "Identifier") {
    const func = scope.func;
    if (func !== null) {
      const role = resolveFuncInternalRole(func, scope, el.name);
      if (role !== null && role.role === "param") {
        const k = classifyNonNumericTypeHint(func.paramTypeHints.get(el.name) ?? null, prog);
        if (k !== null) return k;
        return resolveUdtObjectType(el, prog, scope) !== undefined ? "UDT" : null;
      }
      if (role !== null && role.role === "var") {
        return (
          classifyNonNumericTypeHint(func.localVarTypeHints.get(el.name) ?? null, prog) ??
          func.localVarValueKinds.get(el.name) ??
          (func.localVarDrawingKinds.has(el.name) ? "drawing handle" : null)
        );
      }
    }
    const varHintKind = classifyNonNumericTypeHint(prog.varTypeHints.get(el.name) ?? null, prog);
    if (varHintKind !== null) return varHintKind;
    return resolveEqLocalNonNumericKind(el, prog, scope, el.name);
  }
  if (isStringExpr(el)) return "string";
  // 원소가 생성자 콜 자체인 형태(`[label.new(...), x]`류) — 리졸버는 Identifier/UDT 필드만 보므로
  // analyzeAssignment가 '=' 로컬 힌트 기입에 쓰는 순수 구조 판별을 원소 식에 직접 적용한다.
  if (isArrayConstructorCall(el, prog, scope) || isMapConstructorCall(el, prog, scope)) return "array/map";
  if (isMatrixConstructorCall(el)) return "matrix";
  if (isDrawingConstructorCall(el) !== null) return "drawing handle";
  if (isUdtConstructorCall(el, prog, scope) !== null) return "UDT";
  if (resolveContainerExprKind(el, prog, scope) !== null) return "array/map";
  if (resolveMatrixExprKind(el, prog, scope)) return "matrix";
  if (resolveDrawingExprKind(el, prog, scope) !== null) return "drawing handle";
  if (resolveUdtObjectType(el, prog, scope) !== undefined) return "UDT";
  return null;
}

// classifyNonNumericTypeHint와 동일한 qualifier-접두 파싱이지만 "UDT면 실제 타입명, 아니면 null"만
// 반환한다(C387, resolveTupleElemUdtType 전용 — classifyNonNumericTypeHint는 문구("string"/"UDT" 등)만
// 반환해 실제 타입명이 필요한 이 소비처엔 재사용 불가).
function resolveUdtTypeHintName(hint: string | null, prog: AnalyzedProgram): string | null {
  if (hint === null) return null;
  const parts = hint.trim().split(/\s+/);
  const first = parts[0]!;
  const base = parts.length > 1 && (first === "series" || first === "simple" || first === "const") ? parts[1]! : first;
  return prog.udtTypes.has(base) ? base : null;
}

// UDF/method 튜플 반환의 원소 하나가 UDT 인스턴스로 확정되면 그 실제 타입명을, 아니면 null을
// 반환한다(C387, wild `[top, btm] = swings(length)` — swings() 내부의 `var swing top = swing.new(...)`
// 처럼 원소가 UDT일 때 top-level 튜플 디스트럭처 대상도 그 타입을 알아야 이후 `top.y` 같은 필드
// 접근이 analyzeExpr(DotAccess)의 resolveUdtObjectType 판별을 통과한다). classifyTupleElemNonNumericKind
// (바로 위)와 호출 지점이 완전히 같지만(analyzeFuncDecl/analyzeMethodDecl의 튜플 반환 분기, 원소당
// analyzeExpr 직후) 저건 "히스토리 슬롯에 담을 수 없는 종류" 문구만 필요해 "UDT"로 뭉뚱그리는 반면
// 이건 실제 타입명이 필요한 소비처(analyzeTupleDestructure의 scope.udtKindHints 등록)용이라 별도
// 함수로 분리 — 판별 분기 구조는 그대로 대칭 유지.
export function resolveTupleElemUdtType(el: Expr, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (el.kind === "Identifier") {
    const func = scope.func;
    if (func !== null) {
      const role = resolveFuncInternalRole(func, scope, el.name);
      if (role !== null && role.role === "param") {
        const hintType = resolveUdtTypeHintName(func.paramTypeHints.get(el.name) ?? null, prog);
        if (hintType !== null) return hintType;
        return resolveUdtObjectType(el, prog, scope) ?? null;
      }
      if (role !== null && role.role === "var") {
        // C454: 명시 typeHint가 없고 생성자 콜로만 UDT가 추론된 경우(`var new_fvg = fvg.new(...)`,
        // wild 튜플-반환 관용구) func.localVarTypeHints에는 raw typeHint(null)만 있어 못 잡는다 —
        // param 분기(위)와 대칭으로 func.localVarUdtTypes(analyzeVarDecl의 isUdtConstructorCall
        // 추론 결과, C392)까지 조회하는 resolveUdtObjectType 폴백을 추가한다.
        const hintType = resolveUdtTypeHintName(func.localVarTypeHints.get(el.name) ?? null, prog);
        if (hintType !== null) return hintType;
        return resolveUdtObjectType(el, prog, scope) ?? null;
      }
    }
    const varHintType = resolveUdtTypeHintName(prog.varTypeHints.get(el.name) ?? null, prog);
    if (varHintType !== null) return varHintType;
    return resolveUdtObjectType(el, prog, scope) ?? null;
  }
  return isUdtConstructorCall(el, prog, scope) ?? resolveUdtObjectType(el, prog, scope) ?? null;
}

// UDF/method 본문 안에서 name이 함수-내부 이름(매개변수/내부 var/내부 '=' 로컬)으로 해석되는지
// 판별한다(C364). 반환값: 함수-내부가 아니면 null(호출부가 기존 top-level 경로로 폴스루 — 이
// 우선 판별 자체가 C363의 잠재 섀도잉 갭(UDF 내부 '=' 로컬이 동명 top-level '=' 로컬의 전역
// 히스토리 슬롯을 잘못 집던 것)을 수정한다), 함수-내부면 역할 태그. '=' 로컬은 isEqLocal도 함께
// 반환한다 — 매개변수도 scope.names에 들어 있어(analyzeFuncDecl) param 판별을 먼저 한다. 이 탐색이
// scope(읽기 지점)에서 시작해 s.parent로 거슬러 올라가며 찾는 구조 자체가 "선언 스코프가 읽기
// 지점의 조상(또는 자기 자신)"임을 이미 보장한다(C388) — 그래서 '=' 로컬 선언이 udf-body 루트든
// if/for 중첩 블록이든 깊이 제약 없이 안전(JS let 블록 스코프 가시성과 정확히 같은 조건).
function resolveFuncInternalRole(
  func: FuncInfo,
  scope: LexScope,
  name: string,
): { role: "param" } | { role: "var" } | { role: "local"; isEqLocal: boolean } | null {
  if (func.paramNames.includes(name)) return { role: "param" };
  if (func.localVarIndex.has(name)) return { role: "var" };
  for (let s: LexScope | null = scope; s !== null && s.func === func; s = s.parent) {
    // C714 UDF 확장: nestedEqLocalNames/nestedHistShadowedNames(중첩 블록 '=' 로컬, 단일/복수 선언
    // 자리 모두 포함)도 isEqLocal로 인정 — 그래야 아래 소비처(analyzeIndexAccess)가 "튜플/for-in
    // 대상" 블랭킷 거부 대신 새 노드-키잉 분기로 들어간다(그 분기 자신이 진짜 모호성을 다시 판정).
    if (s.names.has(name)) {
      return {
        role: "local",
        isEqLocal:
          func.eqLocalNames.has(name) ||
          func.tupleEqLocalNames.has(name) ||
          func.nestedEqLocalNames.has(name) ||
          func.nestedHistShadowedNames.has(name),
      };
    }
  }
  return null;
}

// obj 표현식이 정적으로 "UDT 인스턴스"임이 확정됐다면 그 타입명을, 아니면 undefined를 반환한다
// (C123, 중첩 UDT 필드 체이닝). 단일 레벨(Identifier)의 조회 순서(inferQualifier의 scope-chain
// 우선 순서와 동일 원칙, C224): (1) scope 체인의 udtKindHints('=' 로컬, top-level 포함) -> (2)
// scope.func.paramUdtTypes(C124, 현재 함수/method 본문 안의 매개변수 — method의 첫 매개변수가
// 필수 소비처) -> (3) scope.func.localVarUdtTypes(C392, 함수 내부 `var Type x = ...` — 함수 자신의
// returnUdtType 추론(inferReturnStmtUdtType)이 마지막 문장으로 이 var를 bare 반환하는 형태의
// 필수 소비처) -> (4) prog.udtVarTypes(top-level `var` 전용). (1)이 잡히면 codegen이 scope 체인
// 없이도 같은 답을 낼 수 있도록 prog.udtFieldAccessTypes(원래 DotAccess 체이닝 전용이지만 키 타입이
// Expr이라 Identifier도 캐싱 가능)에 이 특정 노드 기준으로 캐싱해둔다(이름 기반이 아니라 노드
// 기준이라 서로 다른 스코프의 동명 '=' 로컬이 있어도 충돌 없음). 중첩 레벨(DotAccess)은 먼저
// udtFieldAccessTypes 캐시를 조회 — analyzeExpr(DotAccess)이 그 노드를 값 위치로 먼저 방문해
// 등록해둔 통상 경로(analyzeFieldAssignment/analyzeExpr DotAccess 케이스)에서는 이걸로 충분하다.
// 단 캐시가 비어 있으면(C505, UDT method 콜 수신자 — call-expr.ts의 공용 꼬리
// `analyzeExpr(callee.obj, ...)`가 dispatch 판별 "이후"에야 실행돼 판별 시점엔 이 DotAccess 노드가
// 아직 방문 전이라 캐시 자체가 없음) resolveUdtFieldTypeHint(analyzer.ts, C495 임의 깊이 재귀)로
// 캐시 없이 직접 재계산한다 — 그 필드의 typeHint가 등록된 UDT 타입명일 때만(prog.udtTypes.has)
// 값을 인정해, array<T>/map<K,V> 같은 비-UDT 컨테이너 필드는 여기서 자연히 걸러진다.
export function resolveUdtObjectType(obj: Expr, prog: AnalyzedProgram, scope: LexScope): string | undefined {
  if (obj.kind === "Identifier") {
    const localType = resolveLocalUdtKind(scope, obj.name);
    if (localType !== undefined) {
      prog.udtFieldAccessTypes.set(obj, localType);
      return localType;
    }
    const paramType = scope.func?.paramUdtTypes.get(obj.name);
    if (paramType !== undefined) return paramType;
    const funcLocalVarType = scope.func?.localVarUdtTypes.get(obj.name);
    if (funcLocalVarType !== undefined) return funcLocalVarType;
    return prog.udtVarTypes.get(obj.name);
  }
  if (obj.kind === "DotAccess") {
    const cached = prog.udtFieldAccessTypes.get(obj);
    if (cached !== undefined) return cached;
    const fieldType = resolveUdtFieldTypeHint(obj, prog, scope);
    return fieldType !== undefined && prog.udtTypes.has(fieldType) ? fieldType : undefined;
  }
  // (recv[N]).field류(C637, wild "네임스페이스 접근은 호출식만 지원" objKind=IndexAccess 축) —
  // 히스토리 인덱스가 obj 자신을 감싸는 역순 폼. 인덱싱은 타입을 바꾸지 않으므로(recv[N]도 recv와
  // 같은 UDT 타입) 감싸인 Identifier의 타입을 그대로 재사용한다 — pine2py 오라클 실측(scratch
  // c637 probe, 이 세션 로컬 검증)으로 확인: recv가 재대입 없이 필드만 mutate되면 recv[N]은 항상
  // 같은 참조(현재 필드값 그대로 반영), recv가 매 바 새 객체로 재대입되면 recv[N]이 진짜 그 바의
  // 객체를 돌려준다 — 두 경우 모두 "그 바에 recv가 가리키던 참조를 그대로 읽고 필드 접근"이라는
  // 하나의 메커니즘(참조형 원형 버퍼, RefSeries)으로 자동 정합된다. Identifier 한정(현재 지원
  // 축인 top-level var/'=' 로컬만 analyzeIndexAccess가 실제로 등록 — 그 외 폼은 거기서 이미 에러).
  if (obj.kind === "IndexAccess" && obj.obj.kind === "Identifier") {
    return resolveUdtObjectType(obj.obj, prog, scope);
  }
  return undefined;
}

// math.* 순수(stateless) 함수 22종(call-expr.ts analyzeCallExpr의 math 전용 분기와 이름 목록을
// 그대로 미러 — 별도 export된 레지스트리가 없어 여기 재선언, 두 목록이 갈리면 이 함수가 조용히
// 과소/과대 허용하니 새 math.* 메서드 추가 시 함께 갱신할 것).
const MATH_PURE_METHODS: ReadonlySet<string> = new Set([
  "round", "abs", "max", "min", "avg", "floor", "ceil", "sqrt", "pow",
  "log", "log10", "exp", "sign", "sin", "cos", "tan", "asin", "acos",
  "atan", "atan2", "todegrees", "toradians", "round_to_mintick",
]);

// array.*(C712) 중 원소 타입과 무관하게 항상 plain number/bool 스칼라를 반환하는 순수 집계
// 메서드만(pine2py src/wavealgo/builtins/array.py 반환형 주석 직접 대조 확인: sum/avg/min/max/
// median/mode/stdev/variance/size/range/covariance/percentile_*/percentrank/includes/indexof/
// lastindexof/binary_search*/every/some 전부 `-> float|int|bool`). abs/standardize(원소별 -> list)/
// copy/concat/slice(-> list)/join(-> str)는 스칼라가 아니므로 제외 — array.get(container,idx)[N]
// (C702 arrayNumericElemTypeHint)과 달리 이 메서드들은 컨테이너 원소 타입 확정 없이도 항상 안전.
const ARRAY_PURE_SCALAR_METHODS: ReadonlySet<string> = new Set([
  "sum", "avg", "min", "max", "median", "mode", "stdev", "variance",
  "size", "range", "covariance", "percentile_nearest_rank",
  "percentile_linear_interpolation", "percentrank", "includes", "indexof",
  "lastindexof", "binary_search", "binary_search_leftmost", "binary_search_rightmost",
  "every", "some",
]);

// request.financial/earnings/dividends/splits/quandl(C747, wild hist-index(all) 잔여 — 22건 재조사
// 결과 `request.financial(...)[N]`류 2건 확인). runtime/request.ts 확인: 다섯 함수 전부 인자/바와
// 무관하게 항상 같은 상수(financial=NaN, 나머지=0.0)만 반환하는 순수 스텁(캐싱/실데이터 스캔 없음,
// request.security류 C176 함정과 무관) — MATH_PURE_METHODS와 동일 근거로 안전. request.security/
// security_lower_tf는 이 목록에 없음(위 CallExpr 분기 앞부분에서 securityCallSlots 등으로 이미
// 별도 처리되므로 여기 도달 시점엔 항상 실데이터 집계가 필요한 콜이 아님이 보장됨).
const REQUEST_STUB_METHODS: ReadonlySet<string> = new Set([
  "financial", "earnings", "dividends", "splits", "quandl",
]);

// C470: 히스토리 인덱싱을 stateCallSlots(ta.*)/request.security 밖으로 넓히되, Float64Array 기반
// histSlots에 안전하게 담을 수 있는 값(항상 plain number, 참조형 불가)만 허용한다 — math.*
// 순수함수(바마다 독립 상태 없음, call-expr.ts 분기 주석 참조)와 time/time_close/timestamp/
// year·month·...·weekofyear(TIME_FUNC_NAMES) 호출형은 전부 pine2py에서도 스칼라 float(ms 또는 정수
// 컴포넌트, na 가능)만 반환해 UDT/array/map/drawing 핸들과 달리 이 슬롯에 안전하게 기록 가능하다.
// UDF 호출은 C470 당시 반환 타입(문자열/UDT/array 등)을 정적으로 확정할 수단이 없어(GOAL.md na
// 안전 원칙) 의도적으로 제외됐었다 — C520이 FuncInfo.returnIsScalarSafe(아래 isUserFuncScalarSafeHistoryCall)
// 로 이 gap을 채운다.
function isNumericPureBuiltinHistoryCall(callExpr: CallExpr, prog: AnalyzedProgram): boolean {
  const callee = callExpr.callee;
  if (callee.kind === "DotAccess") {
    if (callee.obj.kind !== "Identifier") return false;
    if (callee.obj.name === "math") return MATH_PURE_METHODS.has(callee.attr);
    if (callee.obj.name === "array") return ARRAY_PURE_SCALAR_METHODS.has(callee.attr);
    if (callee.obj.name === "request") return REQUEST_STUB_METHODS.has(callee.attr);
    return false;
  }
  // na(x)/nz(x[,y])(C712, wild "히스토리 인덱스는 stateful TA 콜에만 지원" 잔여 최다 서브그룹) —
  // 둘 다 call-expr.ts analyzeCallExpr이 namespace 없는 bare Identifier 콜로 dispatch하는 stateless
  // 순수함수(runtime/numeric.ts na()는 bool, nz()는 인자와 동형 number를 반환, 상태 없음 —
  // MATH_PURE_METHODS와 동일 근거). prog.funcs.has() 가드: call-expr.ts analyzeCallExpr(line ~3620)이
  // "na"/"nz"라는 이름의 UDF 선언을 이 bare-dispatch보다 먼저 가로채므로(동일 섀도잉 정책, 그 파일
  // 주석 참조) 그런 UDF가 실제로 존재하면 이 콜은 이미 사용자 함수 콜로 등록돼 있다 — 그 경우
  // isUserFuncScalarSafeHistoryCall(FuncInfo.returnIsScalarSafe)이 대신 판별해야 하므로 여기서
  // 블라인드로 true를 주면 UDT/array 반환 가능성을 놓친다.
  if ((callee.name === "na" || callee.name === "nz") && !prog.funcs.has(callee.name)) return true;
  if (callee.name === "time" || callee.name === "time_close" || callee.name === "timestamp") return true;
  return TIME_FUNC_NAMES.has(callee.name);
}

// array.get(container, idx)[N](C702, LIMITATIONS C701 hist-stateful 잔여 최다 서브그룹 — wild
// `prevVolume = array.get(combinedVolumes, idx)[1]`류, `var float[] combinedVolumes = array.new_float(...)`).
// container Identifier의 typeHint가 "array<float/int/bool>"(또는 T[] 대체 표기, parser.ts가 정규화)로
// 확정될 때만 안전 — 원소가 UDT/string/array/map/matrix/drawing/color/enum이거나 typeHint 자체가
// 없으면(값 흐름 추적 없이 안전 확정 불가, 과욕 금지) false로 아래 stateful-TA-only 에러로 폴스루한다.
// resolveFuncInternalRole(이 파일 상단)과 동일하게 UDF 매개변수/내부 var 축까지 대칭 지원 — top-level과
// UDF 본문 양쪽 다 이 콜 자체는 아래 공용 CallExpr 히스토리 경로(top-level 무조건/forbidden-kind ->
// condCallHistorySlots, UDF 무조건/forbidden-kind -> localCallHistSlots/localCondCallHistSlots)를
// 그대로 타므로 이 판별 함수는 "안전한가"만 답하면 충분하다. pop/shift/first/last/remove(다른 원소
// 반환 array 메서드)는 wild 실사용 근거가 없어 이번 슬라이스는 get 하나로 좁게 유지.
function resolveArrayContainerNumericSafe(container: Expr, prog: AnalyzedProgram, scope: LexScope): boolean {
  if (container.kind !== "Identifier") return false;
  const name = container.name;
  const func = scope.func;
  if (func !== null) {
    const role = resolveFuncInternalRole(func, scope, name);
    if (role !== null) {
      if (role.role === "param") {
        const hint = func.paramTypeHints.get(name) ?? null;
        return hint !== null && arrayNumericElemTypeHint(hint) !== null;
      }
      if (role.role === "var") {
        const hint = func.localVarTypeHints.get(name) ?? null;
        return hint !== null && arrayNumericElemTypeHint(hint) !== null;
      }
      return false; // '=' 로컬은 array typeHint 추적 축이 없음(과욕 금지) -- 미확정으로 취급.
    }
  }
  const hint = prog.varTypeHints.get(name) ?? null;
  return hint !== null && arrayNumericElemTypeHint(hint) !== null;
}

function isArrayElemNumericSafeHistoryCall(callExpr: CallExpr, prog: AnalyzedProgram, scope: LexScope): boolean {
  const callee = callExpr.callee;
  if (callee.kind !== "DotAccess" || callee.obj.kind !== "Identifier" || callee.obj.name !== "array" || callee.attr !== "get") {
    return false;
  }
  const container = callExpr.args[0];
  return container !== undefined && resolveArrayContainerNumericSafe(container, prog, scope);
}

// f()[N](C520, wild "히스토리 인덱스는 stateful TA 콜에만 지원" 클러스터 잔여 — 사용자 정의 함수
// 콜 결과 히스토리 인덱싱). method-call sugar(`obj.method()[N]`)는 범위 밖(callee가 DotAccess인
// 경우 제외 — receiver 타입 해석까지 필요해 별도 슬라이스, corpus 근거 재확인 필요). FuncInfo.
// returnIsScalarSafe(analyzer.ts)가 마지막 문장 단일 ExprStmt + classifyTupleElemNonNumericKind
// null(비-참조형 확정)일 때만 true라 string/array/map/matrix/drawing/UDT 반환은 여전히 아래
// stateful-TA-only 에러로 막힌다.
function isUserFuncScalarSafeHistoryCall(callExpr: CallExpr, prog: AnalyzedProgram): boolean {
  const callee = callExpr.callee;
  return callee.kind === "Identifier" && (prog.funcs.get(callee.name)?.returnIsScalarSafe ?? false);
}

// index가 컴파일타임에 알려진 정수 리터럴이면 그 값을, 아니면(런타임 expr) null을 반환한다
// (genForStmt의 literalStepValue와 동일 원칙 — 부호 있는 리터럴까지 인식).
export function literalOffsetValue(expr: Expr): number | null {
  if (expr.kind === "NumberLiteral") return expr.value;
  if (expr.kind === "UnaryOp" && expr.op === "-" && expr.operand.kind === "NumberLiteral") {
    return -expr.operand.value;
  }
  return null;
}

// series[n] 히스토리 참조. 지원 스코프(연혁: 리터럴 var/bar series → C339 strategy.prop → C340
// ta콜 결과 → C363 top-level '=' 로컬 → C364 UDF param/'=' 로컬/내부 var → C365 위 대상 전부에
// 동적(런타임) 오프셋, LIMITATIONS.md에 잔여 미지원 축 문서화):
// - index: 0 이상의 정수 리터럴 또는 임의 런타임 int 표현식(동적 — 음수/na/범위밖은 런타임 NaN 가드)
// - obj: bar series/파생 가격/bar_index, top-level var/varip·'=' 로컬, UDF param/'=' 로컬/내부 var,
//   strategy.<prop>(리터럴 전용), top-level 무조건 stateful 콜 결과. 임의 표현식([obj][n])은 미지원
// offset===0(x[0])은 항상 "현재 값"과 동치이므로 히스토리 슬롯 없이 그냥 identifier로 취급한다 —
// 히스토리 슬롯은 이 bar의 record()가 아직 실행되기 전(top-level 문장들 다 끝난 뒤에 실행됨)이라
// get(0)이 그 시점엔 아직 "이전 바"의 값을 담고 있다(Architecture Decisions 참조). 동적 오프셋은
// 이 0-분기를 컴파일타임에 못 하므로 codegen이 rt.histGet(현재값, slot, off)으로 런타임 이관.
export function analyzeIndexAccess(expr: IndexAccess, prog: AnalyzedProgram, scope: LexScope): void {
  analyzeExpr(expr.index, prog, scope, false);

  // C501: array[i] 브라켓 원소 접근 -- 아래의 "obj[]는 히스토리 인덱스" 결정 트리를 타기 전에
  // 먼저 걸러낸다. pine2py `_gen_index_access`가 obj[idx]를 그대로 Python list subscript로
  // 방출함을(별도 array-vs-history 분기 자체가 없음, python 직접 실행으로 확인) literal port한
  // 것 -- wild `(v[j]).size()`(request.security_lower_tf 튜플 원소, array<float>)류가 지금까지
  // "히스토리 인덱스는 array 값을 받은 로컬에는 지원 안 함"으로 하드 거부되던 것은 [] 연산자를
  // 히스토리 오프셋으로만 해석한 결과였다. obj.kind==="CallExpr"는 제외 -- 그 케이스는 아래
  // ta.*/request.security 스테이트풀 히스토리 전용 분기가 이미 처리하며, 그 분기와 섞이면
  // 서로 다른 메커니즘이 충돌한다(array.new<float>(...)[0]류 CallExpr 수신자 배열 리터럴은
  // wild 실사용 0건이라 범위 밖으로 유지). 인덱스는 히스토리와 달리 리터럴/음수 제약이 없다
  // (rt.array.get이 Math.trunc+범위 가드로 완전 안전 -- runtime/array.ts get() 참조).
  if (expr.obj.kind !== "CallExpr" && resolveContainerExprKind(expr.obj, prog, scope) === "array") {
    analyzeExpr(expr.obj, prog, scope, false);
    prog.arrayIndexReads.add(expr);
    return;
  }

  // offset === null이 곧 "동적(런타임) 오프셋" 마커다(C228 bar series → C305 bar_index → C365
  // histSlot 대상 전체로 게이트 확장, ROADMAP P4 🔴🔴 (c)). C228/C305가 확인해 둔 사실: runtime/
  // series.ts Series.get()이 임의 런타임 오프셋을 받아 trunc + 긍정형 NaN 가드 + 범위밖 NaN으로
  // 완전 가드하므로(bar_index는 rt.barIndexHistory 산술 동형) 이 제약은 순수 analyzer 정책
  // 게이트였다. C365부터 동적 오프셋은 별도 조기 분기 없이 아래 리터럴 경로와 같은 분기(같은 타입
  // 가드/슬롯 배정)를 그대로 지나가되 마지막에 historyOffsets 대신 dynamicHistoryOffsets에 등록한다
  // — 리터럴 전용 offset===0 컴파일타임 분기(현재 값 identifier vs 히스토리 슬롯)는 null !== 0이라
  // 자연히 스킵되고, codegen이 rt.histGet(현재값, slot, off) 런타임 분기로 이관한다(series.ts
  // histGet 주석 참조). pine2py는 함수 모드 히스토리를 ctx.param()[i] Python 리스트 인덱싱으로
  // 처리해 동적 오프셋을 자연 지원 — bar series 동적(C228/C305) 선례 그대로 오라클 대조 가능.
  const offset = literalOffsetValue(expr.index);
  if (offset !== null && (offset < 0 || !Number.isInteger(offset))) {
    prog.errors.push(
      `history index '[]' supports only integer literals >= 0 (dynamic offset not implemented): (L${expr.line}:${expr.col})`,
    );
    return;
  }

  // strategy.<prop>[N](C339, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 서브그룹 67건 —
  // strategy.position_size/opentrades/netprofit/losstrades/closedtrades 최다) -- obj가
  // strategy.* 런타임 속성 DotAccess(analyzer.ts STRATEGY_RUNTIME_PROPS)면 top-level var와 동일한
  // $.histSlots[]/record()/get() 메커니즘을 슬롯 키만 varSlot(number) 대신 propName(string)으로
  // 바꿔 재사용한다. analyzeExpr(expr.obj)를 먼저 호출해 strategy() 지시어 선행 체크(builtinRuntimeExprs
  // 등록)를 그대로 태운다 — 등록 실패(지시어 없음/미지원 속성)면 그 안에서 이미 에러가 쌓였으니
  // 추가 에러 없이 반환.
  if (
    expr.obj.kind === "DotAccess" &&
    expr.obj.obj.kind === "Identifier" &&
    expr.obj.obj.name === "strategy" &&
    STRATEGY_RUNTIME_PROPS.has(expr.obj.attr)
  ) {
    analyzeExpr(expr.obj, prog, scope, false);
    if (!prog.builtinRuntimeExprs.has(expr.obj)) return;
    if (offset === null) {
      // strategy.<prop>[동적]은 wild 실측 0건(scratch/probe_c364_dynoff_target.mjs dot-access 4건은
      // 전부 ta.tr/UDT 필드)이라 C365 게이트 확장 범위 밖 — C339 리터럴 전용을 보수 유지.
      prog.errors.push(
        `history index '[]' on strategy.* properties supports only integer literal offsets >= 0 (dynamic offset not supported): (L${expr.line}:${expr.col})`,
      );
      return;
    }
    if (offset === 0) {
      prog.historyOffsets.set(expr, 0);
      return;
    }
    const propName = expr.obj.attr;
    if (!prog.strategyPropHistorySlots.has(propName)) {
      prog.strategyPropHistorySlots.set(propName, prog.historySlotCount);
      prog.historySlotCount += 1;
    }
    prog.historyOffsets.set(expr, offset);
    return;
  }

  // barstate.*/session.* 히스토리(C521, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 서브그룹
  // 바레 네임스페이스 변수 10건 — barstate.ishistory/isfirst/islast/isconfirmed, session.ispremarket/
  // ispostmarket/isfirstbar/islastbar_regular). BARSTATE_PROPS/SESSION_PROPS(analyzer.ts)에 등록된 값은
  // $.idx/$.barCount만의 순수 함수 또는 상수(배치 리플레이 고정 가정, 두 맵의 주석 참조)라 bar_index/
  // time과 동일하게 histSlot 없이 codegen이 $.idx를 ($.idx-N)으로 치환해 직접 합성한다(genIndexAccess
  // DotAccess 분기 참조). pine2py 자신은 이 속성들을 Series가 아니라 매 바 재계산되는 plain bool
  // property로 구현해 `[]` subscript 자체가 런타임 크래시(`'bool' object is not subscriptable`,
  // gen_oracle.py 실측 확인 — c521 스크래치 케이스, 오라클 채널로는 승격 불가)라 오라클 대조가 원천
  // 불가한 pine2py 자체 latent 버그(MEMORY C9/C14/C18과 동일 패턴)로 판단, hand-verified 유닛
  // 테스트만으로 구현한다. 동적 오프셋은 wild 실사용 0건(전부 리터럴 [1])이라 strategy.<prop>
  // (C339)와 동일하게 리터럴 전용 보수 유지.
  if (
    expr.obj.kind === "DotAccess" &&
    expr.obj.obj.kind === "Identifier" &&
    (expr.obj.obj.name === "barstate" || expr.obj.obj.name === "session") &&
    (expr.obj.obj.name === "barstate" ? BARSTATE_PROPS : SESSION_PROPS).has(expr.obj.attr)
  ) {
    analyzeExpr(expr.obj, prog, scope, false);
    if (!prog.builtinRuntimeExprs.has(expr.obj)) return;
    if (offset === null) {
      prog.errors.push(
        `history index '[]' on barstate.*/session.* values supports only integer literal offsets >= 0 (dynamic offset not implemented): (L${expr.line}:${expr.col})`,
      );
      return;
    }
    prog.historyOffsets.set(expr, offset);
    return;
  }

  // UDT 인스턴스 스칼라 필드 히스토리 obj.field[N](C523, wild "히스토리 인덱스는 식별자에만 지원"
  // 클러스터 잔여 최다 서브그룹 — b.h[1]/t.price[1]/top.time[1]류, 동적 오프셋 포함). TV 공식
  // 문서를 이 세션에서 검증할 수 없고(웹 접근 없음, VERIFIED_SEMANTICS 근거 없음) pine2py는
  // _gen_index_access가 obj가 Identifier가 아니면 plain subscript를 방출해 크래시(C522 실측)라
  // 오라클도 원천 불가 — "필드 값의 바 종료 커밋 시리즈"(top-level var 히스토리 C363과 동일
  // 시맨틱)로 hand-verified 구현하고 DIVERGENCES에 "TV 미검증(가설)"로 등재한다. 값의 발생원이
  // named 저장소(수신자 객체)라 CallExpr류 인라인 record 제약(C340/C146)이 아니라 var류 바-종료
  // record 루프가 맞는 축 — 읽기 위치(조건부/삼항/UDF 본문)는 var 히스토리와 동일하게 제약 없음.
  if (expr.obj.kind === "DotAccess" && expr.obj.obj.kind === "Identifier") {
    const recvName = expr.obj.obj.name;
    const recvType = resolveUdtObjectType(expr.obj.obj, prog, scope);
    if (recvType !== undefined) {
      const fieldAttr = expr.obj.attr;
      // 표준 필드 검증(없는 필드/체이닝 캐시 등록)을 먼저 그대로 태운다 — 에러가 쌓였으면 그걸로 충분.
      const errCountBefore = prog.errors.length;
      analyzeExpr(expr.obj, prog, scope, false);
      if (prog.errors.length > errCountBefore) return;
      // chart.point 특수 값 타입(C486)은 필드가 number|null(na가 NaN이 아니라 null)이라 record의
      // Float64Array 강제변환에서 null → 0으로 조용히 오염된다 — 범위 밖(하드 에러).
      if (recvType === CHART_POINT_FIELD_TYPE) {
        prog.errors.push(
          `history index '[]' not supported on chart.point fields (field na is null and would corrupt to 0 in the Float64Array history slot): '${recvName}.${fieldAttr}' (L${expr.line}:${expr.col})`,
        );
        return;
      }
      // 수신자가 UDF/method 내부 이름(매개변수/내부 var/'=' 로컬)이면 콜사이트별 독립 히스토리
      // (slotBase/__histBase 전파)가 필요한 별도 축. 매개변수(role==="param")는 C364 스칼라
      // 매개변수 히스토리와 동일 원칙으로 지원 가능하다(C750) — Pine 매개변수는 본문에서 ':='
      // 재대입이 불가능해 함수 진입 시점 값이 곧 이 호출의 확정값이므로, 함수 진입 직후 1회
      // record하면 되고 바-종료 전역 record 루프(호출 스택 밖이라 값을 못 봄)가 필요 없다. 내부
      // var/'=' 로컬(role==="var"/"local")은 필드가 본문 여러 지점에서 재대입될 수 있어 "record
      // 시점" 자체가 모호해지므로 이번 슬라이스 범위 밖으로 유지(하드 에러).
      const func = scope.func;
      const funcRole = func !== null ? resolveFuncInternalRole(func, scope, recvName) : null;
      if (funcRole !== null && funcRole.role !== "param") {
        prog.errors.push(
          `history index '[]' not supported on fields of UDF/method-internal UDT receivers (parameter/internal var/'=' local) (per-callsite independent history not implemented): '${recvName}.${fieldAttr}' (L${expr.line}:${expr.col})`,
        );
        return;
      }
      // 수신자 축 판별(top-level 전용, C750: funcRole!==null이면 매개변수 진입-record 축이라 이
      // 검사 자체가 해당 없음): top-level var/varip(udtVarTypes, $.vars 슬롯) 또는 depth-0 무조건
      // '=' 로컬(topLevelLocalNames, JS `var` 함수 스코프) — 둘 다 바-종료 record 루프가 볼 수
      // 있는 저장소. 중첩 블록 '=' 로컬(JS let, record 루프에서 불가시)/이름 섀도잉(record 대상
      // 모호)/양축 중복은 C364 3갈래 오염 원칙 그대로 거부.
      if (funcRole === null) {
        const isVarRecv = prog.udtVarTypes.has(recvName);
        const isEqLocalRecv = prog.topLevelLocalNames.has(recvName);
        if (
          prog.nestedTopLevelEqLocalNames.has(recvName) ||
          prog.nestedTopLevelHistShadowedNames.has(recvName) ||
          isVarRecv === isEqLocalRecv
        ) {
          prog.errors.push(
            `history index '[]' supported only on fields of top-level var/varip or unconditional (depth-0) '=' local UDT receivers (nested-block '='/shadowing/tuple receivers not supported): '${recvName}.${fieldAttr}' (L${expr.line}:${expr.col})`,
          );
          return;
        }
      }
      // 필드 타입 가드: Float64Array 히스토리 슬롯에 담을 수 있는 수치/bool만. color(이 엔진에서
      // string 값)와 chart.point(number|null)는 classifyNonNumericTypeHint가 분류하지 않는 별도
      // 오염 축이라 여기서 직접 배제한다(공용 헬퍼 확장은 C364 param/var 가드의 기존 수용 범위를
      // 바꾸는 별개 축이라 이번 슬라이스에서 손대지 않음 — ROADMAP 이월).
      const fieldHint = resolveUdtFieldTypeHint(expr.obj, prog, scope) ?? null;
      let kind = classifyNonNumericTypeHint(fieldHint, prog);
      if (kind === null && fieldHint !== null) {
        const parts = fieldHint.trim().split(/\s+/);
        const base = parts.length > 1 && (parts[0] === "series" || parts[0] === "simple" || parts[0] === "const") ? parts[1]! : parts[0]!;
        if (base === "color") kind = "color";
        else if (base === CHART_POINT_FIELD_TYPE) kind = "chart.point";
      }
      const fieldKey = `${recvName}.${fieldAttr}`;
      // drawing 핸들 타입 필드(C718, wild `phl.top[1]`류 — line.new() 등으로 재대입되는 UDT 필드)는
      // Float64Array가 아니라 top-level var 드로잉 핸들(C652)/UDT 인스턴스 var(C637)와 동일한 물리
      // 배열($.refHistSlots, RefSeries object 원형 버퍼)로 담을 수 있어 그 둘과 나란히 허용한다.
      // funcRole!==null(매개변수)이면 물리 배열은 같되 콜사이트별 함수-상대 슬롯(C750, C541
      // localRefHistSlots와 동일한 __refHistBase 카운터 공유)에 배정한다.
      if (kind === "drawing handle") {
        if (offset === 0) {
          prog.historyOffsets.set(expr, 0);
          return;
        }
        if (funcRole !== null) {
          if (!func!.localFieldRefHistSlots.has(fieldKey)) {
            func!.localFieldRefHistSlots.set(fieldKey, func!.localRefHistSlotCount);
            func!.localRefHistSlotCount += 1;
          }
        } else if (!prog.udtFieldRefHistorySlots.has(fieldKey)) {
          prog.udtFieldRefHistorySlots.set(fieldKey, prog.refHistorySlotCount);
          prog.refHistorySlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (fieldHint === null || kind !== null) {
        prog.errors.push(
          `history index '[]' not supported on UDT fields of ${kind ?? "undetermined"} type (type cannot be stored in a Float64Array-based history slot): '${recvName}.${fieldAttr}' (L${expr.line}:${expr.col})`,
        );
        return;
      }
      if (offset === 0) {
        prog.historyOffsets.set(expr, 0);
        return;
      }
      if (funcRole !== null) {
        if (!func!.localFieldHistSlots.has(fieldKey)) {
          func!.localFieldHistSlots.set(fieldKey, func!.localHistSlotCount);
          func!.localHistSlotCount += 1;
        }
      } else if (!prog.udtFieldHistorySlots.has(fieldKey)) {
        prog.udtFieldHistorySlots.set(fieldKey, prog.historySlotCount);
        prog.historySlotCount += 1;
      }
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    // recvType 미확정(ta.tr 등 네임스페이스 접근/미지원 수신자)은 아래 기존 에러 경로로 폴스루.
  }

  // ta.<fn>(...)[N](C340, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 잔여 CallExpr 축, 104건 —
  // ta.highest 66/ta.lowest 14/ta.atr 9/ta.ema 6/ta.rsi 4/ta.pivothigh 3 등, wild 소스 샘플링 결과
  // 실사용 전부가 스크립트 top-level의 무조건 '=' 로컬 대입문). analyzeExpr(expr.obj)를 먼저
  // 호출해 일반 CallExpr 분석(TA_REGISTRY 등록/인자 검증/조건부 위치 검사)을 그대로 태운다 —
  // 등록 실패(TA_REGISTRY 콜이 아니거나 이미 다른 이유로 거부됨)면 그 안에서 이미 에러가 쌓였으니
  // 추가 에러 없이 반환. AnalyzedProgram.taCallHistorySlots 주석 참조 — var/strategy prop과 달리
  // 이 값의 유일한 발생원이 그 콜 자신뿐이라 record()가 그 콜의 codegen과 같은 자리(인라인)에서
  // 일어나야 한다(genIndexAccess 참조). 이 인라인 record는 "그 코드 위치가 이 바에 실제로
  // 실행되는가"에 그대로 종속되므로, 스크립트 top-level의 무조건 위치(scope 체인에 kind가 하나도
  // 없고 UDF 밖)에서만 안전이 보장된다:
  // - lazy-expr(삼항/and·or 우변): hoistLazyStatefulCalls가 콜 자체는 문장 앞으로 매 바 무조건
  //   실행되도록 eager 호이스팅하지만(C66), 우리 인라인 record는 원래 표현식 위치(그 삼항 분기 안)에
  //   그대로 남아 그 분기가 선택된 바에만 실행된다 — "콜은 매 바 전진하는데 그 출력 히스토리는
  //   분기가 선택된 바에만 기록"으로 어긋난다.
  // - cond-body/condition/loop-body(if 분기 본문·elif 조건 등·for/while 본문): 콜 자체는 C64/C161이
  //   확정한 대로 "호출된 바에서만 상태 전진"이 TV 정합이지만, 호출이 스킵된 바의 $.histSlots는
  //   Series.preallocate 기본값(NaN)에 그대로 남는다 — TV 실제 시맨틱(VERIFIED_SEMANTICS.md
  //   CONFIRMED "History doesn't advance uniformly")이 스킵된 바에서 이전 값을 유지(persist)하는
  //   것인지 NaN이 되는 것인지 이 세션에서 실측/문서 검증을 못 했다(잠재 오답 축, LIMITATIONS.md
  //   참조) — wild 샘플(scratch 조사)엔 이 패턴이 없어 이번 슬라이스는 보수적으로 배제한다.
  // - udf-body(UDF/method 본문): $.histSlots[]는 var 슬롯의 slotBase 콜사이트별 인덱싱이 없는 전역
  //   배열이라, 이 노드가 여러 콜사이트에서 공유되면 상태가 뒤섞인다.
  if (expr.obj.kind === "CallExpr") {
    const errCountBefore = prog.errors.length;
    analyzeExpr(expr.obj, prog, scope, false);
    // request.security(...)[N](C448, wild "히스토리 인덱스는 stateful TA 콜에만 지원" 클러스터 잔여
    // CallExpr 축 — index-dynamic-or-negative TernaryOp 서브클러스터의 2차 에러로 발견, next_hint(C447)).
    // bare field(securityCallSlots)/expression(securityExprCallSlots) 콜 결과는 ta.*와 달리 record()
    // 인라인이 필요 없다 — 트랜스파일 시점에 이미 전체 바 범위로 집계된 배열(securityCache/
    // securityExprCache, engine.ts Context 생성자)을 codegen이 $.idx - offset으로 재조회하기만 하면
    // "N바 전 시점의 결과"가 그대로 나온다(runtime/security.ts getHist/getFromArrayHist). 그래서 아래
    // ta.* 전용 "top-level 무조건 위치" 제약(인라인 record 타이밍 문제)이 이 두 슬롯에는 애초에
    // 성립하지 않는다 — if/for/UDF 본문 등 어디서 읽어도 안전(단 그 request.security 콜 자신의
    // 위치 제약은 위 analyzeExpr(expr.obj)가 이미 별도로 검증/등록했다).
    // C699: securityParamExprCalls(C453/C534 — UDF 매개변수 다중 콜사이트 tf, __secIdx 서수)도
    // securityExprCallSlots와 동일한 "전체 바 범위 집계 배열" 계약이라(codegen genCallExpr
    // securityParamCall 분기와 동일 getFromArray 계열) 히스토리 인덱싱이 안전하다 — 이 두 맵과
    // 나란히 검사가 누락돼 있었다(wild `f_sec(_market,_res,_exp) => request.security(_market,_res,
    // _exp[cond?1:0])[cond?0:1]`류 non-repaint 관용구, tf가 콜사이트마다 달라 securityParamExprCalls로
    // 등록되는 축).
    // C703: 위 securityParamExprCalls.has()는 즉시-치환(C695 "실인자 전원 동일") 경로만 잡는다.
    // expression 인자가 콜사이트마다 다른 값이면 secParamMultiSite/secParamMultiSiteGeneric이
    // 이 CallExpr을 securityParamExprPending 큐에 넣고(analyzeExpr(expr.obj) 호출 시 이미 push됨 —
    // 위 analyzeExpr 한 줄이 analyzeCallExpr을 동기 호출하므로 이 시점엔 push가 끝나 있다),
    // processPendingSecurityParamExprs가 메인 분석 루프 종료 후 securityParamExprCalls로 승격한다
    // (call-expr.ts processPendingSecurityParamExprs). codegen은 analyze() 전체 완료 후 실행되므로
    // 그 시점엔 승격이 끝나 있어 securityParamExprCalls.get(expr.obj)가 정상적으로 값을 낸다 —
    // 즉 outer IndexAccess 판정을 지금 당장 확정하지 않고 "pending 큐에 있으니 나중에 채워진다"만
    // 신뢰하면 되고, LIMITATIONS C699가 우려한 "처리 순서 재설계"는 불필요(pending 등록 여부는
    // 이미 이 시점에 알 수 있다 — 값 자체가 아니라 존재 여부만 필요). 승격이 실패하면(진짜 순환 등)
    // processPendingSecurityParamExprs 자신이 별도 에러를 쌓아 트랜스파일이 어차피 실패하므로 조용한
    // 오답 위험 없음.
    if (
      prog.securityCallSlots.has(expr.obj) ||
      prog.securityExprCallSlots.has(expr.obj) ||
      prog.securityParamExprCalls.has(expr.obj) ||
      prog.securityParamExprPending.some((p) => p.expr === expr.obj)
    ) {
      if (offset === 0) {
        prog.historyOffsets.set(expr, 0);
        return;
      }
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    // drawing 생성자 콜(line.new/label.new/box.new/table.new 등)의 인라인 히스토리 인덱싱(C700, wild
    // "히스토리 인덱스는 stateful TA 콜에만 지원" 클러스터 최다 서브그룹 — `line.delete(line.new(...)[1])`류
    // "직전 바에 만든 도형을 지운다" 관용구). 반환값이 DrawingHandle object(runtime/drawing.ts)라
    // Float64Array 기반 taCallHistorySlots/condCallHistorySlots에는 못 담기지만, GOAL.md "drawing
    // 객체는 no-op + 발생 카운트 기록" 원칙대로 이 핸들은 어디서도 실제 렌더링 값으로 소비되지
    // 않는 죽은 채널이라(소비처 delete/set_* 전부 no-op) call-count 압축 인덱스만 정확하면 충분하다
    // — condCallHistorySlots(C671)와 동일한 push() 시맨틱을 object 원형 버퍼(series.ts RefSeries.push,
    // context.ts condCallRefHistSlots)로 재사용한다. 조건부/무조건 위치 구분이 불필요하다(무조건
    // 위치도 "바마다 1개 생성 = 콜마다 1개 생성"이라 bar-index와 call-count가 우연히 일치 —
    // taCallHistorySlots의 record 기반 분기가 굳이 필요 없음). scope.func!==null(UDF 본문, C701)은
    // C672(numeric 판)와 동형으로 함수-상대 압축 인덱스(FuncInfo.localCondCallRefHistSlots)를
    // 별도 배정 — 콜사이트별 독립이어야 하는 GOAL.md "UDF의 var/TA 상태는 call-site별 독립" 원칙
    // 그대로. scope.kind(if/for/while) 구분이 top-level과 동일하게 불필요하다.
    if (isDrawingConstructorCall(expr.obj) !== null) {
      if (offset === 0) {
        prog.historyOffsets.set(expr, 0);
        return;
      }
      if (scope.func !== null) {
        const func = scope.func;
        if (!func.localCondCallRefHistSlots.has(expr.obj)) {
          func.localCondCallRefHistSlots.set(expr.obj, func.localCondRefHistSlotCount);
          func.localCondRefHistSlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (!prog.condCallRefHistorySlots.has(expr.obj)) {
        prog.condCallRefHistorySlots.set(expr.obj, prog.condCallRefHistorySlotCount);
        prog.condCallRefHistorySlotCount += 1;
      }
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    // C470: math.abs(x)[1]류(위 예전 주석이 지목했던 정확한 그 사례) — non-stateful이지만 항상
    // plain number를 반환하는 순수 builtin 콜은 stateCallSlots 대신 이 별도 화이트리스트로 허용한다.
    // 아래는 ta.*와 완전히 같은 taCallHistorySlots record+get 경로를 그대로 탄다(codegen은 이 콜이
    // ta.*인지 math.*인지 구분하지 않는 범용 메커니즘, genIndexAccess CallExpr 분기 참조).
    if (
      !prog.stateCallSlots.has(expr.obj) &&
      !isNumericPureBuiltinHistoryCall(expr.obj, prog) &&
      !isUserFuncScalarSafeHistoryCall(expr.obj, prog) &&
      !isArrayElemNumericSafeHistoryCall(expr.obj, prog, scope) &&
      // C711(hist-index 잔여, wild `request.security(sym, tf, someUdfCall(...))[N]`류): 이 콜이
      // securityScalarBareUdfCallSlots(C436/C442 — 값이 HTF 캐시 없이 내부 UDF 콜로 완전히 붕괴하는
      // passthrough)에 등록돼 있으면, genExpr(expr.obj)가 codegen.ts genCallExpr에서 이미
      // genExpr(securityScalarBareUdf)로 리다이렉트한다(3697행) — 즉 이 콜의 "record 시점 값 계산"이
      // 내부 UDF 호출 결과와 정확히 같아 아래 taCallHistorySlots(및 UDF본문/조건부 상대 슬롯) 범용
      // record+get 메커니즘을 그대로 태워도 안전하다(codegen 쪽 추가 배선 불필요, genExpr 리다이렉트가
      // 이미 값 생성을 흡수). scalarBareUdfInner 자신의 analyzeExpr는 registration 시점에 이미 끝나
      // 있다(call-expr.ts securityScalarBareUdfCallSlots.set 직후).
      !prog.securityScalarBareUdfCallSlots.has(expr.obj)
    ) {
      // analyzeExpr가 이 콜 자체를 이미 다른 이유로 거부했으면(예: 알 수 없는 함수) 그 에러로 충분 —
      // 그 외(예: UDF 호출 등 반환 타입을 정적으로 확정할 수 없는 non-stateful 콜)는 여기서 직접
      // 에러를 쌓아야 한다. stateCallSlots 미등록 상태로 조용히 반환하면 historyOffsets가 안 채워져
      // codegen이 "analyzer 통과 후 발생 불가"로 문서화해둔 internal throw를 실제로 밟는다(에러 없는
      // 프로그램이 codegen 단계에서 크래시하는 회귀).
      if (prog.errors.length === errCountBefore) {
        prog.errors.push(
          `history index '[]' supported only on stateful TA call (ta.*)/request.security results/pure numeric builtins (math.*, time, time_close, timestamp, year·month·...·weekofyear) — other function calls (UDF etc.) not supported: (L${expr.line}:${expr.col})`,
        );
      }
      return;
    }
    if (offset === 0) {
      prog.historyOffsets.set(expr, 0);
      return;
    }
    // UDF 본문 안(C483, ROADMAP 🔴🔴 (b)슬라이스의 CallExpr 변형 — wild 최다 서브그룹 187/65파일,
    // scratch 계측으로 확정): 함수 경계 안에서만 스코프 체인을 스캔한다(resolveFuncInternalRole과
    // 동일 원칙 — s.func===func인 동안만 조상으로 거슬러 오름). "udf-body"(그 함수 본문의 루트
    // 스코프 자신) 이외의 kind가 하나도 없으면(if/for/while로 감싸이지 않은 무조건 위치) FuncInfo.
    // localCallHistSlots에 콜사이트-상대 슬롯을 배정한다 — named locals(C364 "var" 역할)와 같은
    // __histBase 콜사이트 블록을 공유(localHistSlotCount 카운터 공유)해 codegen의 __histBase 인자
    // 배선(genBaseParams/genCallExpr)을 그대로 재사용, 별도 배선 불필요. record는 named locals의
    // "local"(= 로컬) 역할과 동일하게 그 콜 자신의 codegen 위치에서 인라인(codegen.ts genIndexAccess
    // CallExpr 분기 참조). cond-body/loop-body가 섞이면(조건부 호출) top-level과 동일한 미검증 TV
    // 시맨틱(스킵된 바의 히스토리 슬롯이 NaN인지 이전 값 유지인지) 축이라 여전히 거부. lazy-expr
    // (삼항/and·or 우변)만 있는 체인은 C484부터 top-level C468 hoist 메커니즘(walkForLazyHoist)을
    // __histBase 콜사이트 슬롯까지 확장해 허용한다 — prog.lazyHistCallSites에 등록해두면 codegen이
    // funcCtx.localCallHistSlots 유무로 top-level 전역 슬롯과 UDF __histBase-relative 슬롯을 구분해
    // 같은 eager-hoist-to-prelude 경로를 탄다(codegen.ts walkForLazyHoist IndexAccess 분기 참조).
    if (scope.func !== null) {
      const func = scope.func;
      let hasFuncForbiddenKind = false;
      let hasFuncLazyKind = false;
      for (let s: LexScope | null = scope; s !== null && s.func === func; s = s.parent) {
        if (s.kind === "lazy-expr") hasFuncLazyKind = true;
        else if (s.kind !== null && s.kind !== "udf-body") hasFuncForbiddenKind = true;
      }
      if (hasFuncForbiddenKind) {
        // C672(배치34 hist-stateful UDF 서브그룹): cond-body/loop-body/condition — top-level의
        // C671 condCallHistorySlots와 동일한 압축(call-count) 인덱스로 허용하되, UDF 안이라
        // 슬롯이 콜사이트별 독립이어야 해 함수-상대 인덱스(FuncInfo.localCondCallHistSlots)로
        // 배정한다(실제 $.condCallHistSlots 인덱스는 콜사이트별 __condHistBase + 상대 슬롯 —
        // allocateFuncHistSlots/genBaseParams/genCallExpr 배선). push()가 그 콜의 codegen 위치
        // 인라인이라 "이 정확한 코드 위치가 실행될 때만 커서 전진"이 top-level과 동일하게 성립
        // (VERIFIED_SEMANTICS.md CONFIRMED 근거 — kind 종류 구분 불필요, C671 주석 참조).
        // lazy-expr이 섞인 체인도 top-level과 동일하게 이 경로가 우선한다(#204 시맨틱 공유).
        if (!func.localCondCallHistSlots.has(expr.obj)) {
          func.localCondCallHistSlots.set(expr.obj, func.localCondHistSlotCount);
          func.localCondHistSlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (!func.localCallHistSlots.has(expr.obj)) {
        func.localCallHistSlots.set(expr.obj, func.localHistSlotCount);
        func.localHistSlotCount += 1;
      }
      if (hasFuncLazyKind) prog.lazyHistCallSites.add(expr);
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    // C468: "lazy-expr"(삼항/and·or 우변)만 있는 체인은 이제 허용 — codegen이 C66과 동일한
    // eager-hoist-to-prelude(walkForLazyHoist IndexAccess 분기)로 record 타이밍을 맞춘다.
    // cond-body/condition/loop-body가 하나라도 섞이면 여전히 하드 에러(잠재 오답 축,
    // LIMITATIONS.md 참조 — lazyHistCallSites 주석과 동일 근거). scope.func===null이 위에서
    // 이미 보장돼 있으므로(그 분기가 항상 return) 아래는 top-level 전용 원 로직 그대로.
    let hasForbiddenKind = false;
    let hasLazyKind = false;
    for (let s: LexScope | null = scope; s !== null; s = s.parent) {
      if (s.kind === "lazy-expr") hasLazyKind = true;
      else if (s.kind !== null) hasForbiddenKind = true;
    }
    if (hasForbiddenKind) {
      // C671: cond-body/loop-body/condition(하나라도 lazy-expr 아닌 kind) — 압축(call-count)
      // 인덱스 전용 별도 슬롯(condCallHistorySlots 주석 참조)으로 허용. VERIFIED_SEMANTICS.md
      // CONFIRMED(execution-model 문서 "함수 내부 series는 조건이 참인 바에서만 갱신") 그대로
      // 이 콜 자신의 series가 "호출된 횟수"로만 전진하므로, "이 정확한 코드 위치가 실제로 실행될
      // 때만 커서가 전진"하는 codegen.ts genIndexAccess의 push() 경로가 그 정의 그대로다 — scope.kind가
      // condition/cond-body/loop-body 중 무엇이든(중첩 조합 포함) 항상 안전(taCallHistorySlots 위
      // hasForbiddenKind 판정과 달리 이 새 경로는 kind 종류를 더 구분할 필요가 없다).
      if (!prog.condCallHistorySlots.has(expr.obj)) {
        prog.condCallHistorySlots.set(expr.obj, prog.condCallHistorySlotCount);
        prog.condCallHistorySlotCount += 1;
      }
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    if (!prog.taCallHistorySlots.has(expr.obj)) {
      prog.taCallHistorySlots.set(expr.obj, prog.historySlotCount);
      prog.historySlotCount += 1;
    }
    if (hasLazyKind) prog.lazyHistCallSites.add(expr);
    // 동적 오프셋(C365)도 같은 인라인 record+get 메커니즘이 그대로 안전하다: codegen이
    // `(slot.record(call), slot.get(off))`를 내는데 record 직후엔 get(0)이 방금 기록한 현재 콜
    // 값이라 rt.histGet의 "0 → 현재 값" 분기 자체가 필요 없고(인라인 record가 이미 끝난 뒤 읽음),
    // 음수/NaN 오프셋은 Series.get() 가드가 처리한다. 평가 순서도 원본과 일치 — comma 식이 콜을
    // 먼저, 오프셋 식을 나중에 평가하는데 Pine 소스 `f(...)[off]`의 obj→index 순서 그대로다.
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }

  // (high-low)[1]류 산술식 히스토리(C522, wild "히스토리 인덱스는 식별자에만 지원" 클러스터
  // paren-expr 서브그룹, next_hint(C521)). Pine 문법상 BinOp는 '+' 외 연산자(-,*,/,%,비교,and/or)가
  // 배열/UDT/문자열 피연산자를 허용하지 않고(원본이 유효한 Pine이라는 전제), UnaryOp(-/not)도 항상
  // 숫자/불린만 받는다 — 즉 이 두 kind는 '+' 문자열 결합(isStringExpr, C20 리터럴 기반 판별)만
  // 배제하면 그 결과가 항상 Float64Array에 담을 수 있는 scalar(number/bool, na=NaN)로 보장된다.
  // record 인라인 타이밍 제약은 CallExpr(taCallHistorySlots)과 완전히 동일(이 식 자신이 유일한 값
  // 발생원 -- 조건부/UDF/lazy 위치 제약도 그대로 재사용, 키 타입만 Expr로 넓혀 같은 맵을 공유한다.
  // C717(wild `0[1]`/`1[2]`류): NumberLiteral/BoolLiteral/NaLiteral obj도 이 경로를 그대로 공유한다
  // — 컴파일타임 상수라 해서 "오프셋과 무관하게 항상 자기 자신"으로 즉시 접어버리지 않는다. history-
  // referencing은 "N바 전 값"을 찾는 연산이고, 아직 N바가 지나지 않았으면(Series.get() idx<0) 값의
  // 종류와 무관하게 na를 반환하는 것이 이미 검증된 일반 워밍업 규칙(다른 모든 obj kind와 동일 가드) —
  // 리터럴만 이 워밍업을 건너뛴다는 것은 TV 1차 소스로 검증된 바 없는 별도의(더 강한) 가정이라
  // 채택하지 않는다(pine2py는 이 패턴을 raw Python subscript `1[2]`로 그대로 방출해 TypeError로
  // 크래시하는 latent 버그라 오라클 대조 불가, python 직접 실행 확인 — hand-verified로 대체).
  // record되는 값이 리터럴이라 콜사이트와 무관하게 항상 동일해 이 공유(top-level 전역) 슬롯도 안전.
  // StringLiteral/ColorLiteral은 Float64Array에 못 담아 제외(wild 실사용도 0건 — 범위 밖 유지).
  if (
    expr.obj.kind === "BinOp" ||
    expr.obj.kind === "UnaryOp" ||
    expr.obj.kind === "NumberLiteral" ||
    expr.obj.kind === "BoolLiteral" ||
    expr.obj.kind === "NaLiteral"
  ) {
    const errCountBefore = prog.errors.length;
    analyzeExpr(expr.obj, prog, scope, false);
    if (prog.errors.length > errCountBefore) return;
    if (expr.obj.kind === "BinOp" && expr.obj.op === "+" && isStringExpr(expr.obj)) {
      prog.errors.push(
        `history index '[]' not supported on string concatenation (+) arithmetic expressions (Float64Array-based history slot cannot hold strings): (L${expr.line}:${expr.col})`,
      );
      return;
    }
    if (offset === 0) {
      prog.historyOffsets.set(expr, 0);
      return;
    }
    // C720(hist-index(all) 잔여 재분류, next_hint(C719) "top-level 산술식(괄호 표현식) UDF 본문
    // 확장" 서브그룹): CallExpr의 scope.func!==null 분기(위 C483/C672)와 완전히 동형 — 이 obj가
    // 함수 안이라는 것만 다를 뿐, 값 발생원이 obj 자신 하나뿐이라는 성질은 top-level과 동일하다.
    // 함수 경계 안에서만 스코프 체인을 스캔해(s.func===func) FuncInfo.localCallHistSlots/
    // localCondCallHistSlots(C720에서 키 타입을 CallExpr->Expr로 넓힘, 동일 카운터 공유)에 함수-상대
    // 슬롯을 배정한다.
    if (scope.func !== null) {
      const func = scope.func;
      let hasFuncForbiddenKind = false;
      let hasFuncLazyKind = false;
      for (let s: LexScope | null = scope; s !== null && s.func === func; s = s.parent) {
        if (s.kind === "lazy-expr") hasFuncLazyKind = true;
        else if (s.kind !== null && s.kind !== "udf-body") hasFuncForbiddenKind = true;
      }
      if (hasFuncForbiddenKind) {
        if (!func.localCondCallHistSlots.has(expr.obj)) {
          func.localCondCallHistSlots.set(expr.obj, func.localCondHistSlotCount);
          func.localCondHistSlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (!func.localCallHistSlots.has(expr.obj)) {
        func.localCallHistSlots.set(expr.obj, func.localHistSlotCount);
        func.localHistSlotCount += 1;
      }
      if (hasFuncLazyKind) prog.lazyHistCallSites.add(expr);
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    let hasForbiddenKind = false;
    let hasLazyKind = false;
    for (let s: LexScope | null = scope; s !== null; s = s.parent) {
      if (s.kind === "lazy-expr") hasLazyKind = true;
      else if (s.kind !== null) hasForbiddenKind = true;
    }
    if (hasForbiddenKind) {
      // C679(hist-top 축): CallExpr의 C671과 동일한 압축(call-count) 인덱스로 허용한다.
      // VERIFIED_SEMANTICS.md CONFIRMED 원문이 "변수 또는 식(expressions)"을 명시해(ta.* 콜만이
      // 아님) 산술식에도 동일 근거가 적용된다 — condCallHistorySlots는 이미 Map<Expr, number>로
      // CallExpr과 BinOp/UnaryOp가 같은 물리 배열/카운터를 공유하도록 설계돼 있어(analyzer.ts
      // 필드 선언 참조) 새 상태/런타임 변경 없이 그대로 재사용 가능.
      if (!prog.condCallHistorySlots.has(expr.obj)) {
        prog.condCallHistorySlots.set(expr.obj, prog.condCallHistorySlotCount);
        prog.condCallHistorySlotCount += 1;
      }
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    if (!prog.taCallHistorySlots.has(expr.obj)) {
      prog.taCallHistorySlots.set(expr.obj, prog.historySlotCount);
      prog.historySlotCount += 1;
    }
    if (hasLazyKind) prog.lazyHistCallSites.add(expr);
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }

  if (expr.obj.kind !== "Identifier") {
    prog.errors.push(
      `history index '[]' supported only on identifiers (bar series or top-level var) (L${expr.line}:${expr.col})`,
    );
    analyzeExpr(expr.obj, prog, scope, false);
    return;
  }

  const name = expr.obj.name;
  // hl2/hlc3/ohlc4/hlcc4/bar_index(DERIVED_PRICE_NAMES/BAR_INDEX_NAME)는 BAR_SERIES_NAMES와 동일하게
  // 별도 히스토리 슬롯이 필요 없다 — codegen이 open/high/low/close의 같은 offset을 합성하거나
  // ($.idx - offset) 산술로 직접 계산하므로 Float64Array 저장 자체가 불필요하다(analyzer.ts
  // DERIVED_PRICE_NAMES 주석 참조).
  if (BAR_SERIES_NAMES.has(name) || DERIVED_PRICE_NAMES.has(name) || name === BAR_INDEX_NAME) {
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }
  // time 계열 빌트인 히스토리(C368, wild 1위 클러스터 슬라이스 (i) — time 412파일/단독 113,
  // scratch/probe_c368_hist_cluster.mjs 실측). Context가 time 전체 배열을 이미 쥐고 있어(배치
  // 리플레이, MEMORY C172) histSlot record 없이 (idx-n) 직접 인덱싱으로 합성한다 — bar series/
  // bar_index와 같은 "상태 없는 파생" 축이라 조건부/UDF/lazy 위치 제약도, 타입 가드도 불필요.
  // 이 분기가 스코프 로컬 조회보다 먼저 오는 것은 genIdentifier의 빌트인-우선 순서(TIME 분기가
  // funcCtx/locals보다 앞, C341이 문서화한 기존 전례)와 정합을 맞추기 위함 — 동명 사용자 변수가
  // 있어도 bare 읽기와 히스토리 읽기가 같은 빌트인 값 축을 본다.
  if (TIME_VAR_NAMES.has(name)) {
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }
  if (offset === 0) {
    analyzeExpr(expr.obj, prog, scope, false);
    prog.historyOffsets.set(expr, offset);
    return;
  }

  const isFuncLocalVar = scope.func !== null && scope.func.localVarIndex.has(name);
  // C728: 중첩 top-level var(depth>0)도 물리적으로는 flat var와 동일한 $.vars[] 슬롯 배열을 쓰므로
  // (analyzer.ts LexScope.nestedVarDeclStmts 주석 참조) 슬롯만 정확히 찾으면 아래 모든 히스토리
  // 가드(string/array/map/matrix/drawing/UDT/enum, name 키 그대로 재사용 가능 — analyzeVarDecl이
  // 그 aux map들을 flat/nested 공통 꼬리 로직으로 채워둠)가 그대로 적용된다.
  const nestedVarDecl = scope.func === null ? resolveAmbiguousNestedVarDeclStmt(scope, name) : null;
  const slot = nestedVarDecl !== null ? prog.nestedVarDeclSlots.get(nestedVarDecl) : prog.varIndex.get(name);
  // codegen은 scope 없이 이 IndexAccess 노드(expr)만으로 슬롯을 다시 찾아야 하므로(다른
  // ambiguousNested* 축과 동일 원칙) 여기서 확정해둔다 — read 쪽 name 기반 program.varIndex 조회는
  // nestedVarDecl일 때 항상 undefined라 codegen에 이 기록이 없으면 못 찾는다.
  if (nestedVarDecl !== null && slot !== undefined) prog.nestedVarReadSlots.set(expr, slot);
  if (isFuncLocalVar || slot === undefined) {
    // UDF 매개변수/내부 '=' 로컬/내부 var 히스토리(C364, ROADMAP 🔴🔴 (b)슬라이스 — wild 1위/2위
    // 클러스터 재스캔 실측에서 (b)대상 497건이 최대 레버로 확정). 함수-내부 이름이면 함수-상대
    // hist 슬롯(FuncInfo.localHistSlots)을 배정하고, 실제 $.histSlots 인덱스는 콜사이트마다
    // __histBase(funcHistBases)를 더해 만든다(slotBase/__taBase와 동형 — GOAL.md "call-site별
    // 독립"). record 시점은 역할별로 다르다(FuncInfo.localHistKinds 주석): param=진입 직후 1회,
    // '=' 로컬=대입문 직후마다(마지막 대입 승리 = (a)의 바 확정값 시맨틱), var=top-level 바 종료
    // 루프($.fnVars 직접 읽기 — 호출 안 된 바에도 var는 안 변해 TV per-call 압축 히스토리와 일치).
    // 조건부 호출 콜사이트의 param/'=' 로컬 히스토리는 호출 안 된 바가 NaN 갭으로 남는다 — ROADMAP
    // (b) 설계("조건부 호출 바에서는 기록이 없으므로 갭") 그대로이나 TV 압축(per-call) 히스토리와는
    // 어긋날 수 있는 미검증 축(DIVERGENCES 등재, 이 세션 웹 접근 없음).
    if (scope.func !== null) {
      const func = scope.func;
      const role = resolveFuncInternalRole(func, scope, name);
      if (role !== null) {
        // C714 UDF 확장(next_hint(C715)) — 이 이름이 함수 안에서 둘 이상의 '=' 로컬 선언 자리를
        // 가지면(형제 if/for 블록마다 독립 선언, analyzeAssignment의 nestedEqLocalNames/
        // nestedHistShadowedNames 등록 주석 참조) 이름 키 슬롯(아래 func.localHistSlots) 대신
        // 읽기 지점이 정확히 어느 선언의 자손인지부터 확인한다(resolveAmbiguousFuncNestedEqLocalDeclStmt
        // — resolveAmbiguousNestedEqLocalDeclStmt의 함수 경계 판) — 형제는 서로의 조상이 아니므로
        // 무모호하게 하나만 찾히거나(그 선언 노드로 슬롯을 키잉해 독립 시리즈 보존), 어느 선언의
        // 자손도 아니면 하드 에러. C715의 "udf-body 루트 무조건 재선언으로 폴백"은 의도적으로 이식
        // 안 함(범위 밖) — 그 폴백은 root+nested가 공존할 때 root 쪽 record가 nested 선언의 대입문도
        // 이름으로 함께 덮어써 두 축이 뒤섞일 위험이 있어(top-level엔 이런 이중 record 경로가 없어
        // 문제 없지만 UDF는 함수-상대 슬롯 카운터를 공유), 이번 슬라이스는 "형제끼리만 충돌"(next_hint가
        // 지목한 실제 wild 패턴)로 좁혀 안전하게 간다.
        if (role.role === "local" && (func.nestedEqLocalNames.has(name) || func.nestedHistShadowedNames.has(name))) {
          const declStmt = resolveAmbiguousFuncNestedEqLocalDeclStmt(func, scope, name);
          if (declStmt === null) {
            prog.errors.push(
              func.nestedHistShadowedNames.has(name)
                ? `history index '[]' target '${name}' is declared/shadowed with '=' multiple times in function '${func.name}' — cannot determine which declaration the history refers to: (L${expr.line}:${expr.col})`
                : `history index '[]' not supported outside the nested block where this name is declared (JS let block scope — referable only from descendants of the declaring scope): '${name}' (L${expr.line}:${expr.col})`,
            );
            return;
          } else {
            const kind = resolveEqLocalNonNumericKind(expr.obj, prog, scope, name);
            // 배치25 (1)/C541과 동형 — drawing 핸들만 별도 object 원형 버퍼($.refHistSlots)로 허용
            // (기존 C541 UDF drawing-핸들 '=' 로컬 지원을 단일 선언 케이스까지 이 새 경로로 통일한
            // 만큼 반드시 함께 이식해야 함 — 없으면 wild 실사용 다수가 회귀한다). 그 외(string/
            // array/map/matrix/UDT)는 여전히 Float64Array 슬롯에 담을 수 없어 하드 에러 유지.
            if (kind !== null && kind !== "drawing handle") {
              prog.errors.push(
                `history index '[]' not supported on nested-block '=' local holding ${kind} value (type cannot be stored in a Float64Array-based history slot): '${name}' (L${expr.line}:${expr.col})`,
              );
              return;
            }
            if (kind === "drawing handle") {
              if (!func.localAmbiguousNestedRefDeclSlots.has(declStmt)) {
                func.localAmbiguousNestedRefDeclSlots.set(declStmt, func.localRefHistSlotCount);
                func.localRefHistSlotCount += 1;
              }
              func.localAmbiguousNestedRefReadSlots.set(expr, func.localAmbiguousNestedRefDeclSlots.get(declStmt)!);
              if (offset === null) prog.dynamicHistoryOffsets.add(expr);
              else prog.historyOffsets.set(expr, offset);
              return;
            }
            if (!func.localAmbiguousNestedHistDeclSlots.has(declStmt)) {
              func.localAmbiguousNestedHistDeclSlots.set(declStmt, func.localHistSlotCount);
              func.localHistSlotCount += 1;
            }
            func.localAmbiguousNestedHistReadSlots.set(expr, func.localAmbiguousNestedHistDeclSlots.get(declStmt)!);
            if (offset === null) prog.dynamicHistoryOffsets.add(expr);
            else prog.historyOffsets.set(expr, offset);
            return;
          }
        }
        if (role.role === "local" && !role.isEqLocal) {
          // '=' Assignment가 아닌 이름(튜플 디스트럭처/for-in 등 — codegen record 주입 지점이 없어
          // 슬롯이 영영 NaN으로 남는 조용한 오답이 되므로) 또는 매개변수/같은 함수 안 재선언과
          // 충돌해 모호한 이름(FuncInfo.histShadowedNames, C364/C388)은 하드 에러로 거부. '=' 로컬
          // 선언 자체는 깊이(udf-body 루트/if/for 중첩) 제약 없음(C388, resolveFuncInternalRole
          // 주석 참조 — 조상-스코프 탐색이 JS let 가시성과 같은 안전 조건을 이미 보장).
          prog.errors.push(
            `history index '[]' in UDF bodies supported only on '=' Assignment locals (tuple/for-in targets and names colliding with parameters/redeclaration not supported): '${name}' (L${expr.line}:${expr.col})`,
          );
          return;
        }
        // Float64Array 히스토리 슬롯에 담을 수 없는 타입 가드 — (a)슬라이스의 4종 가드와 동일
        // 원칙을 역할별 가용 신호로 적용: param은 선언 typeHint(lazy 분류) + paramUdtTypes
        // (resolveUdtObjectType이 함께 커버), '=' 로컬은 C363 리졸버 5종, var는 선언 typeHint +
        // 초기값 구조 판별(localVarValueKinds) + drawing kind 맵.
        let kind: string | null = null;
        if (role.role === "param") {
          kind = classifyNonNumericTypeHint(func.paramTypeHints.get(name) ?? null, prog);
          if (kind === null && resolveUdtObjectType(expr.obj, prog, scope) !== undefined) kind = "UDT";
        } else if (role.role === "local") {
          // C535: TupleDestructure 대상(tupleEqLocalNames)은 '=' 로컬과 달리 이름별 값 표현식이
          // 없어(analyzeTupleDestructure의 localTupleElemKinds 등록 주석 참조) resolveEqLocalNonNumericKind
          // (Assignment 값 표현식을 스코프에서 찾는 리졸버)를 쓸 수 없다 — 선언 시점에 미리 확정해둔
          // localTupleElemKinds를 먼저 조회한다.
          kind = func.tupleEqLocalNames.has(name)
            ? (func.localTupleElemKinds.get(name) ?? null)
            : resolveEqLocalNonNumericKind(expr.obj, prog, scope, name);
        } else {
          kind =
            classifyNonNumericTypeHint(func.localVarTypeHints.get(name) ?? null, prog) ??
            func.localVarValueKinds.get(name) ??
            (func.localVarDrawingKinds.has(name) ? "drawing handle" : null);
        }
        // 배치25 (1) 잔여(C541): drawing 핸들 값을 담은 UDF 내부 var/'=' 로컬은 콜사이트별
        // $.refHistSlots 블록(__refHistBase 전파, funcRefHistBases)으로 허용 — localHistSlots와
        // 슬롯배정/record 타이밍(var=바 종료 루프, local=대입문 직후)이 완전히 동형이고 물리 배열/
        // 카운터만 분리(RefSeries). 튜플 디스트럭처 대상(C719)도 이제 포함 —
        // genFuncTupleHistRecords가 codegen 쪽 record 주입 지점을 localRefHistKinds "local"까지
        // 대칭 확장했다(genTupleDestructure/codegen.ts 참조), 슬롯 등록 자체는 '=' 로컬과 동일.
        // C749: string도 같은 물리 배열에 포함 — top-level '=' 로컬(C675/C690, line ~1311)이 이미
        // 증명한 대로 RefSeries.data가 Float64Array가 아니라 plain unknown[]라 물리적 제약이 없다
        // (drawing 핸들 전용으로 좁혀둔 것은 C541 당시 아직 top-level string 지원이 없었을 뿐).
        // C751: 매개변수(role==="param") + UDT kind만 좁게 추가 — wild `id[i]`(id: series
        // MoreCandleInfo 타입 매개변수, "id 자체"의 N바 전 값을 배열로 모으는 관용구) 실측 확인,
        // C541이 "wild 실측 0건"이라 미루던 근거가 해소됐다. record 타이밍은 param 스칼라 히스토리
        // (C364)와 동일한 함수 진입 직후 1회(genParamHistRecords) — param은 본문에서 ':=' 재대입
        // 불가라 var/local과 달리 대입문 훅이 필요 없다(C750 필드 히스토리와 동일 원칙). var/local +
        // UDT(비-param) 및 param + drawing/string(비-UDT)은 이 실측 범위 밖 — 과욕 금지 원칙(C232)
        // 상 미확장 유지(각 조합은 wild 근거가 나오면 별도 슬라이스로).
        if (
          ((kind === "drawing handle" || kind === "string") && (role.role === "var" || role.role === "local")) ||
          (kind === "UDT" && role.role === "param")
        ) {
          if (!func.localRefHistSlots.has(name)) {
            func.localRefHistSlots.set(name, func.localRefHistSlotCount);
            func.localRefHistSlotCount += 1;
            func.localRefHistKinds.set(name, role.role);
          }
          if (offset === null) prog.dynamicHistoryOffsets.add(expr);
          else prog.historyOffsets.set(expr, offset);
          return;
        }
        if (kind !== null) {
          const roleWord =
            role.role === "param"
              ? "parameter"
              : role.role === "var"
                ? "internal var"
                : func.tupleEqLocalNames.has(name)
                  ? "internal tuple destructure local"
                  : "internal '=' local";
          prog.errors.push(
            `history index '[]' not supported on UDF ${roleWord} holding ${kind} value (type cannot be stored in a Float64Array-based history slot): '${name}' (L${expr.line}:${expr.col})`,
          );
          return;
        }
        if (!func.localHistSlots.has(name)) {
          func.localHistSlots.set(name, func.localHistSlotCount);
          func.localHistSlotCount += 1;
          func.localHistKinds.set(name, role.role);
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
    }
    // 중첩 블록(script top-level, depth>0) '=' 로컬 히스토리(C450, C363/C364·C388이 UDF 본문에만
    // 허용했던 "깊이 무관 '=' 로컬"을 script top-level까지 대칭 확장). scope.func===null인 경우만
    // 대상 — func!==null인데 여기 도달했다는 것은 위 UDF 분기의 role===null(함수-내부 선언이 아닌
    // 자유 이름)이므로 이 이름은 애초에 script top-level을 가리키는 것이라도 그 참조 지점이 UDF 본문
    // 안(별도 JS 함수 스코프)이라 이 중첩 축의 let 가시성 보장이 적용되지 않는다(아래 depth-0
    // topLevelLocalNames 폴백으로 넘어감, 그쪽은 JS `var`라 함수 경계를 넘어도 안전).
    // C714: 예전엔 "섀도잉된 이름(nestedTopLevelHistShadowedNames)은 무조건 거부"와 "단일 선언
    // (nestedTopLevelEqLocalNames)만 이름 키 슬롯 허용" 두 분기였으나, 이름 하나에 슬롯 하나뿐인
    // 구조라 (a) 형제 블록마다 독립적으로 같은 이름을 선언하는 wild 관용구(LIMITATIONS C369 "TV는
    // 섀도우 로컬의 독립 시리즈")를 항상 거부했고 (b) 소스 순서상 첫 읽기가 두 번째 선언보다 먼저
    // 분석되면 그 순간엔 "아직 안 섀도잉"이라 이름 키로 등록된 뒤 나중에야 섀도잉이 발각되는
    // 순서의존 버그(analyzeProgram 사후검사가 뒤늦게 잡아 결국 하드 에러)까지 있었다. 이제는 선언이
    // 하나든 여럿이든 항상 "이 읽기 지점이 정확히 어느 대입문의 자손인가"부터 확인 —
    // resolveAmbiguousNestedEqLocalDeclStmt(스코프 조상 탐색)가 정확히 하나만 찾으면 그 대입문
    // 노드로 슬롯을 키잉해(이름이 아니라) 형제 선언과 섞일 일이 없고, 처리 순서와도 무관해진다.
    if (scope.func === null && (prog.nestedTopLevelEqLocalNames.has(name) || prog.nestedTopLevelHistShadowedNames.has(name))) {
      const declStmt = resolveAmbiguousNestedEqLocalDeclStmt(scope, name);
      if (declStmt === null) {
        // C715: 읽기 지점이 어느 중첩 선언의 자손도 아니면서 이 이름이 depth-0(조건부 아님) 재선언도
        // 갖고 있으면(wild `lastPivotBar` 관용구 — if-블록 조건부 선언 + 파일 뒤쪽 무조건 재선언 공존,
        // PROGRESS.md C714 next_hint 참조) depth-0 선언은 바마다 무조건 실행돼 이 읽기 시점엔 항상 그
        // 값이 유효하다 — 무모호. 에러 없이 아래 topLevelLocalNames 분기(C363, 이름-키 named slot)로
        // 넘긴다. depth-0 무조건 선언 자체가 없으면(중첩 선언끼리만 충돌하거나, 선언 스코프 밖에서
        // 읽는 경우) 기존 두 에러 그대로 유지.
        if (!prog.topLevelLocalNames.has(name)) {
          if (prog.nestedTopLevelHistShadowedNames.has(name)) {
            prog.errors.push(
              `history index '[]' target '${name}' is declared/shadowed with '=' multiple times at top level (nested-block redeclaration or name collision with another top-level '=' local) — cannot determine which declaration the history refers to: '${name}' (L${expr.line}:${expr.col})`,
            );
          } else {
            prog.errors.push(
              `history index '[]' not supported outside the nested block where this name is declared (JS let block scope — referable only from descendants of the declaring scope): '${name}' (L${expr.line}:${expr.col})`,
            );
          }
          return;
        }
      } else if (declStmt.kind === "TupleDestructure") {
        // C748: 튜플 디스트럭처 선언 노드 — 원소별 값 표현식이 없어 resolveEqLocalNonNumericKind
        // (Assignment 전용, 값 expr을 스코프에서 찾는 리졸버)를 못 쓴다. 선언 시점에 노드+인덱스로
        // 미리 확정해둔 nestedTupleElemKinds에서 조회(analyzeTupleDestructure C748 분기 참조).
        const elemKinds = prog.nestedTupleElemKinds.get(declStmt);
        const kind = elemKinds?.[declStmt.names.indexOf(name)] ?? null;
        // 배치25 (1)/C714와 동형 — drawing 핸들만 별도 object 원형 버퍼($.refHistSlots)로 허용, 그
        // 외(string/array/map/matrix/UDT)는 여전히 Float64Array 슬롯에 담을 수 없어 하드 에러 유지.
        if (kind !== null && kind !== "drawing handle") {
          prog.errors.push(
            `history index '[]' not supported on nested-block tuple destructure local receiving ${kind} value (type cannot be stored in a Float64Array-based history slot): '${name}' (L${expr.line}:${expr.col})`,
          );
          return;
        }
        // 노드 하나가 여러 이름을 동시에 선언하므로(declStmt만으로는 원소 구분 불가) declStmt+name
        // 2단 맵(ambiguousNestedTupleHistDeclSlots/RefDeclSlots)으로 슬롯을 배정 — 위 Assignment
        // 분기의 declStmt 단일 키와 달리 이름별 독립 슬롯이 필요하다(AnalyzedProgram 주석 참조).
        if (kind === "drawing handle") {
          let slots = prog.ambiguousNestedTupleRefDeclSlots.get(declStmt);
          if (slots === undefined) {
            slots = new Map();
            prog.ambiguousNestedTupleRefDeclSlots.set(declStmt, slots);
          }
          if (!slots.has(name)) {
            slots.set(name, prog.refHistorySlotCount);
            prog.refHistorySlotCount += 1;
          }
          prog.ambiguousNestedRefReadSlots.set(expr, slots.get(name)!);
          if (offset === null) prog.dynamicHistoryOffsets.add(expr);
          else prog.historyOffsets.set(expr, offset);
          return;
        }
        let slots = prog.ambiguousNestedTupleHistDeclSlots.get(declStmt);
        if (slots === undefined) {
          slots = new Map();
          prog.ambiguousNestedTupleHistDeclSlots.set(declStmt, slots);
        }
        if (!slots.has(name)) {
          slots.set(name, prog.historySlotCount);
          prog.historySlotCount += 1;
        }
        prog.ambiguousNestedHistReadSlots.set(expr, slots.get(name)!);
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      } else {
        const kind = resolveEqLocalNonNumericKind(expr.obj, prog, scope, name);
        // 배치25 (1): drawing 핸들만 별도 object 원형 버퍼($.refHistSlots)로 허용 — 그 외(string/
        // array/map/matrix/UDT)는 여전히 Float64Array 슬롯에 담을 수 없어 하드 에러 유지.
        if (kind !== null && kind !== "drawing handle") {
          prog.errors.push(
            `history index '[]' not supported on nested-block '=' local holding ${kind} value (type cannot be stored in a Float64Array-based history slot): '${name}' (L${expr.line}:${expr.col})`,
          );
          return;
        }
        if (kind === "drawing handle") {
          if (!prog.ambiguousNestedRefDeclSlots.has(declStmt)) {
            prog.ambiguousNestedRefDeclSlots.set(declStmt, prog.refHistorySlotCount);
            prog.refHistorySlotCount += 1;
          }
          prog.ambiguousNestedRefReadSlots.set(expr, prog.ambiguousNestedRefDeclSlots.get(declStmt)!);
          if (offset === null) prog.dynamicHistoryOffsets.add(expr);
          else prog.historyOffsets.set(expr, offset);
          return;
        }
        if (!prog.ambiguousNestedHistDeclSlots.has(declStmt)) {
          prog.ambiguousNestedHistDeclSlots.set(declStmt, prog.historySlotCount);
          prog.historySlotCount += 1;
        }
        prog.ambiguousNestedHistReadSlots.set(expr, prog.ambiguousNestedHistDeclSlots.get(declStmt)!);
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
    }
    // top-level '=' 로컬 히스토리(C363, ROADMAP P4 "wild 최우선 [hard]: 로컬 히스토리" (a)슬라이스) --
    // var/varip가 아니고(slot===undefined) UDF 로컬도 아닌 이 이름이 스크립트 top-level에서 조건부
    // 없이 '='로 선언된 것이면(topLevelLocalNames) named histSlot을 배정한다. C369부터 top-level
    // 무조건 튜플 디스트럭처 이름(topLevelTupleElemKinds — 같은 JS `var name` 방출/같은 바-종료
    // record 루프라 메커니즘 전체를 그대로 공유)도 동일하게 배정한다. 튜플 로컬(중첩 블록 포함,
    // topLevelTupleElemKinds 미등록)은 계속 거부. UDF 매개변수/내부
    // 로컬은 C364부터 위의 함수-내부 분기가 먼저 처리한다(이 폴스루에 도달하는 함수 안 이름은
    // 함수-내부 선언이 없는 자유 이름 — top-level '=' 로컬 참조).
    if (!isFuncLocalVar && (prog.topLevelLocalNames.has(name) || prog.topLevelTupleElemKinds.has(name))) {
      // top-level 튜플 디스트럭처 이름(C369, 히스토리 (ii)슬라이스): 원소 kind는 선언 시점에
      // topLevelTupleElemKinds가 확정해 뒀다('=' 로컬과 달리 이름별 값 표현식이 없어 아래 리졸버가
      // 스코프 힌트로 못 잡는 축 — analyzeTupleDestructure 등록 주석 참조). '='와 튜플이 같은
      // 이름을 재선언하는 혼합 축은 양쪽 가드를 모두 통과해야 한다(보수 방향).
      const tupleKind = prog.topLevelTupleElemKinds.get(name);
      // C719: 튜플 디스트럭처 대상이 UDT/drawing 핸들이면 '=' 로컬(C637/배치25 (1))과 동일한
      // 참조형 원형 버퍼($.refHistSlots, 이름 키 공유)로 허용 — 튜플이든 '='든 물리 코드젠은
      // 똑같이 top-level 맨몸 `var name`이라 바-종료 record 루프(program.refHistorySlots)가
      // 코드젠 변경 없이 그대로 커버한다. C749: string도 이 축에 포함 — 바로 아래(C675) top-level
      // '=' 로컬 string 분기와 동일한 물리 배열/무제약 근거(RefSeries는 plain unknown[]). 그 외
      // kind(array-map/matrix/판별 불가)는 여전히 Float64Array 슬롯에 담을 수 없어 하드 에러 유지.
      if (tupleKind === "UDT" || tupleKind === "drawing handle" || tupleKind === "string") {
        if (!prog.refHistorySlots.has(name)) {
          prog.refHistorySlots.set(name, prog.refHistorySlotCount);
          prog.refHistorySlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (tupleKind !== undefined && tupleKind !== null) {
        prog.errors.push(
          `history index '[]' not supported on tuple destructure local receiving ${tupleKind} value (type cannot be stored in a Float64Array-based history slot): '${name}' (L${expr.line}:${expr.col})`,
        );
        return;
      }
      // Float64Array 기반 histSlot에 담을 수 없는 타입 가드 — var의 4종 가드(string/array/map/
      // matrix/UDT/enum, 아래 참조)와 동일 원칙이지만 '=' 로컬은 명시 typeHint가 없어(Assignment
      // AST에 typeHint 필드 자체가 없음, C355) 구조 판별 리졸버(scope 체인)로 대체한다.
      if (resolveLocalStringHint(scope, name)) {
        // string 값 top-level '=' 로컬 히스토리(wild "string-hist 잔여" 클러스터, C675가 var에
        // 적용한 것과 동일 근거) — drawing 핸들/UDT 인스턴스(바로 아래 두 분기)와 같은 참조형
        // 원형 버퍼($.refHistSlots, RefSeries)로 지원. Float64Array가 아니라 plain unknown[]라
        // string도 그대로 왕복 가능(C675 주석 참조, 물리적 제약 없음).
        if (!prog.refHistorySlots.has(name)) {
          prog.refHistorySlots.set(name, prog.refHistorySlotCount);
          prog.refHistorySlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (resolveContainerExprKind(expr.obj, prog, scope) !== null) {
        prog.errors.push(
          `history index '[]' not supported on '=' local holding array/map value (Float64Array-based history slot cannot hold references): '${name}' (L${expr.line}:${expr.col})`,
        );
        return;
      }
      if (resolveMatrixExprKind(expr.obj, prog, scope)) {
        prog.errors.push(
          `history index '[]' not supported on '=' local holding matrix value (Float64Array-based history slot cannot hold references): '${name}' (L${expr.line}:${expr.col})`,
        );
        return;
      }
      if (resolveDrawingExprKind(expr.obj, prog, scope) !== null) {
        // 배치25 (1): top-level '=' 로컬 drawing 핸들 히스토리 — 별도 object 원형 버퍼
        // ($.refHistSlots, series.ts RefSeries)로 허용. 바-종료 record 루프는 localHistorySlots와
        // 동일한 자리(generateCode)에 나란히 배정(codegen.ts 참조).
        if (!prog.refHistorySlots.has(name)) {
          prog.refHistorySlots.set(name, prog.refHistorySlotCount);
          prog.refHistorySlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (resolveUdtObjectType(expr.obj, prog, scope) !== undefined) {
        // C637: top-level '=' 로컬 UDT 인스턴스 히스토리 — drawing 핸들(바로 위 분기)과 동일한
        // 참조형 원형 버퍼($.refHistSlots)를 공유(이름 키, 카운터도 동일). (recv[N]).field 형태로만
        // 실제 소비되지만(resolveUdtObjectType의 IndexAccess 분기), recv[N] 단독 읽기도 이 슬롯을
        // 그대로 재사용해 정합적으로 값을 낸다.
        if (!prog.refHistorySlots.has(name)) {
          prog.refHistorySlots.set(name, prog.refHistorySlotCount);
          prog.refHistorySlotCount += 1;
        }
        if (offset === null) prog.dynamicHistoryOffsets.add(expr);
        else prog.historyOffsets.set(expr, offset);
        return;
      }
      if (!prog.localHistorySlots.has(name)) {
        prog.localHistorySlots.set(name, prog.historySlotCount);
        prog.historySlotCount += 1;
      }
      if (offset === null) prog.dynamicHistoryOffsets.add(expr);
      else prog.historyOffsets.set(expr, offset);
      return;
    }
    prog.errors.push(
      `history index '[]' supported only on top-level var/varip variables or bar series (nested-block '='/tuple locals/undeclared·builtin names not supported): '${name}' (L${expr.line}:${expr.col})`,
    );
    return;
  }
  // string 타입 top-level var(C675, wild "string-hist" 클러스터) — drawing 핸들/UDT 인스턴스
  // (바로 위 두 분기)와 동일한 참조형 원형 버퍼($.refHistSlots, RefSeries)로 지원한다. Float64Array
  // 슬롯(historySlots)은 문자열을 담을 수 없지만 RefSeries.data는 plain unknown[]라 string도 그대로
  // 왕복 가능 — object 전용이라 예단했던 이전 판정(C79 Pitfalls 3종 가드)이 string까지 넓게 잡아
  // 막고 있었을 뿐, 물리적 제약은 없었다.
  if (prog.varTypeHints.get(name) === "string") {
    if (!prog.varRefHistorySlots.has(slot)) {
      prog.varRefHistorySlots.set(slot, prog.refHistorySlotCount);
      prog.refHistorySlotCount += 1;
    }
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }
  // array를 담는 var도 같은 이유(Float64Array 히스토리 슬롯이 배열 참조를 담을 수 없음)로 차단(C79).
  // offset===0(`arr[0]` — 현재 배열 그 자체)은 위의 조기 반환이 이미 identifier 읽기로 처리해 허용.
  if (prog.arrayVars.has(name)) {
    prog.errors.push(
      `history index '[]' not supported on array-type top-level var (Float64Array-based history slot cannot hold array references): '${name}' (L${expr.line}:${expr.col})`,
    );
    return;
  }
  // map을 담는 var도 동일한 이유로 차단(C89, arrayVars 판단과 나란히 적용).
  if (prog.mapVars.has(name)) {
    prog.errors.push(
      `history index '[]' not supported on map-type top-level var (Float64Array-based history slot cannot hold map references): '${name}' (L${expr.line}:${expr.col})`,
    );
    return;
  }
  // matrix를 담는 var도 동일한 이유로 차단(C90, arrayVars/mapVars 판단과 나란히 적용).
  if (prog.matrixVars.has(name)) {
    prog.errors.push(
      `history index '[]' not supported on matrix-type top-level var (Float64Array-based history slot cannot hold matrix references): '${name}' (L${expr.line}:${expr.col})`,
    );
    return;
  }
  // label/line/box/table/polyline/linefill 핸들을 담는 var(C652, `(lab[1]).delete()`류) — UDT
  // 인스턴스 var(C637, 바로 아래)와 완전히 동일한 원칙, varRefHistorySlots를 그대로 공유(RefSeries가
  // object를 값 종류 구분 없이 담는 범용 원형 버퍼라 drawing/UDT 전용 물리 배열을 나눌 이유가 없음).
  // 지금까지 이 분기가 없어 이 var 종류만 3종 가드(array#79/map#89/matrix#90 나열, UDT#637은 이미
  // 있었음)에서 빠진 채 아래 기본 Float64Array 슬롯(숫자 전용)으로 조용히 떨어지던 비대칭이었다 —
  // drawing 핸들(plain object)을 Float64Array에 기록하면 Number(handle)=NaN으로 뭉개져 `lab[1]`이
  // 항상 na가 되는 latent 오답(GOAL.md na 참조형 규약과 별개로, "값이 있는데 항상 na로 읽힘").
  if (prog.drawingVarKinds.has(name)) {
    if (!prog.varRefHistorySlots.has(slot)) {
      prog.varRefHistorySlots.set(slot, prog.refHistorySlotCount);
      prog.refHistorySlotCount += 1;
    }
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }
  // UDT 인스턴스를 담는 var(C637, `(ts[N]).field`류) — array/map/matrix와 달리 참조형 원형 버퍼
  // ($.refHistSlots, drawing 핸들과 동일 물리 배열)로 지원한다. var/varip는 $.vars[slot] 물리
  // 저장이라 이름이 아니라 슬롯 번호가 키(historySlots와 동일 원칙) — varRefHistorySlots가 그
  // 전용 축(codegen.ts record 루프 참조, refHistorySlots를 그대로 쓰면 이름 기반 safeLocalName()이
  // 방출돼 버그가 된다).
  if (prog.udtVarTypes.has(name)) {
    if (!prog.varRefHistorySlots.has(slot)) {
      prog.varRefHistorySlots.set(slot, prog.refHistorySlotCount);
      prog.refHistorySlotCount += 1;
    }
    if (offset === null) prog.dynamicHistoryOffsets.add(expr);
    else prog.historyOffsets.set(expr, offset);
    return;
  }
  // enum 타입 var도 동일한 이유(Float64Array 히스토리 슬롯이 문자열 상수를 담을 수 없음)로 차단 —
  // string 타입 var 차단과 동일 원칙(C121 "새 참조형 3종 가드" Pitfalls 재적용).
  const enumTypeHint = prog.varTypeHints.get(name);
  if (enumTypeHint != null && prog.enumTypes.has(enumTypeHint)) {
    prog.errors.push(
      `history index '[]' not supported on enum-type top-level var (Float64Array-based history slot cannot hold string constants): '${name}' (L${expr.line}:${expr.col})`,
    );
    return;
  }
  if (!prog.historySlots.has(slot)) {
    prog.historySlots.set(slot, prog.historySlotCount);
    prog.historySlotCount += 1;
  }
  if (offset === null) prog.dynamicHistoryOffsets.add(expr);
  else prog.historyOffsets.set(expr, offset);
}
