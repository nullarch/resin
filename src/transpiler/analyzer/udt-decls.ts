// UDT/enum 선언 분석(analyzeEnumDecl/analyzeTypeDecl/analyzeFieldAssignment) -- analyzer.ts 파일
// 분할 다섯 번째 슬라이스(collections.ts(C141)/ta.ts(C142)/constructors.ts(C143)/udt-types.ts(C144)에
// 이은 다섯 번째 파일). C144 next_hint가 예고한 "선언 분석" 후보(b) 중 UDT/enum 타입 자체를 다루는
// 3종(analyzeEnumDecl/analyzeTypeDecl/analyzeFieldAssignment, 구 L589-685 연속 구간)만 이번에
// 이전한다 -- analyzeMethodDecl(구 L837)은 next_hint가 예상 못 한 추가 의존(pushScope/
// extractQualifierFromHint/FuncInfo, analyzeFuncDecl과 거의 동일한 UDF 시그니처 처리 로직)이 착수
// 전 재검토로 드러나 이번 슬라이스에서 제외하고 다음 사이클로 이월한다(PROGRESS.md next_hint 참조).
// analyzeTupleDestructure(구 L690)/analyzeFuncDecl(구 L755)은 UDT와 무관해(각각 튜플 디스트럭처링·
// 일반 UDF 선언) analyzer.ts에 그대로 남는다.
//
// analyzeExpr/resolveUdtObjectType은 analyzer.ts에 남아 있는(다른 다수 함수가 공유하는) 핵심 재귀
// 함수라 값으로 되참조해야 한다 -- analyzer.ts <-> 이 파일 사이에 진짜 순환 import가 생기지만
// (analyzer.ts의 analyzeStmt가 이 파일의 세 함수를 호출하고, 이 파일은 analyzer.ts의 analyzeExpr/
// resolveUdtObjectType을 호출) 모든 참조가 함수 본문 안에서만 일어나 안전하다(ta.ts가 이미 확립한
// 패턴, C142 -- MEMORY.md Pitfalls 참조).

import type { EnumDecl, FieldAssignment, TypeDecl } from "../ast";
import type { AnalyzedProgram, LexScope } from "../analyzer";
import { analyzeControlFlowOrExpr, analyzeExpr, resolveUdtObjectType } from "../analyzer";
import type { UdtFieldInfo } from "./udt-types";
import { CHART_POINT_FIELD_TYPE } from "./udt-types";
import { isUdtFieldTypeAllowed } from "./udt-types";

// enum Name 선언: type과 동일하게 top-level 전용(중첩 시맨틱이 Pine 문법에 없음). 이번 슬라이스는
// "리터럴 멤버만"(파서가 title 할당을 애초에 파싱하지 않음) — 여기선 이름 충돌(기존 type/UDF/var/
// 다른 enum)과 중복 멤버명만 검증한다.
//
// C255부터 이 로직도 TypeDecl(C233)과 동일하게 두 단계로 나뉜다 — corpus 실측 3건이 `Dir.Up`(enum
// 멤버 DotAccess 읽기)을 `enum Dir` 선언보다 앞서 참조하는 forward-reference 패턴이었다(python
// 직접 실행으로 pine2py도 enum 멤버는 선언 순서 무관하게 참조 가능함을 확인). EnumDecl은 TypeDecl과
// 달리 본문에 표현식 분석이 전혀 없어(멤버는 정적 이름 + title 문자열뿐, default 값 같은 개념이
// 없음) "시그니처"와 "본문"을 나눌 필요가 없다 — prepassEnumDecl이 통째로 완전히 등록한다.
// C273부터 이 prepass는 TypeDecl prepass보다도 먼저 실행된다(analyzer.ts analyze() 참조 — UDT
// 필드가 enum 타입일 때 필드 타입 검증과 default 값의 enum 멤버 DotAccess 분석 둘 다 prog.enumTypes가
// 미리 채워져 있어야 함) — 그래서 이 시점엔 udtTypes/funcs가 항상 비어있어(Type/Func prepass가
// 이 뒤에 옴) 신뢰할 수 없다.
// (1) registerEnumMembers — prepass가 소스 순서대로 호출. 멤버 등록 + enum-vs-enum(이 루프 안에서
//     먼저 등록된 다른 enum)만 판정한다(TypeDecl의 registerTypeDeclFields와 동일 원칙 — udtTypes/
//     funcs/varIndex와의 충돌은 이 시점에 신뢰 불가, 그 충돌은 아래 checkEnumDeclConflict가 재검사).
// (2) checkEnumDeclConflict — 메인 패스가 EnumDecl의 원래 소스 위치에서 호출, udtTypes/funcs/
//     varIndex를 재검사(그 시점엔 세 prepass 전부 완료라 신뢰 가능, checkTypeDeclConflict와 대칭 —
//     단 enumTypes 자기 충돌은 위 (1)이 이미 검사했으므로 제외).
function registerEnumMembers(stmt: EnumDecl, prog: AnalyzedProgram): void {
  if (prog.enumTypes.has(stmt.name)) {
    prog.errors.push(`이미 사용 중인 이름과 충돌하는 'enum' 선언: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  const seenMembers = new Set<string>();
  const members: string[] = [];
  const titles = new Map<string, string>();
  for (const m of stmt.members) {
    if (seenMembers.has(m.name)) {
      prog.errors.push(`중복 enum 멤버: '${stmt.name}.${m.name}' (L${m.line}:${m.col})`);
      continue;
    }
    seenMembers.add(m.name);
    members.push(m.name);
    titles.set(m.name, m.title ?? m.name);
  }
  prog.enumTypes.set(stmt.name, { members, titles });
}

function checkEnumDeclConflict(stmt: EnumDecl, prog: AnalyzedProgram): void {
  if (prog.udtTypes.has(stmt.name) || prog.funcs.has(stmt.name) || prog.varIndex.has(stmt.name)) {
    prog.errors.push(`이미 사용 중인 이름과 충돌하는 'enum' 선언: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
  }
}

// analyzer.ts analyze()의 prepass가 top-level EnumDecl마다 소스 순서대로 호출한다.
export function prepassEnumDecl(stmt: EnumDecl, prog: AnalyzedProgram): void {
  registerEnumMembers(stmt, prog);
}

export function analyzeEnumDecl(stmt: EnumDecl, prog: AnalyzedProgram, scope: LexScope): void {
  if (scope.depth !== 0) {
    prog.errors.push(`'enum' 선언은 top-level에서만 가능: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  // depth===0이면 이 stmt는 script.body 직속이라 prepass가 이미 멤버까지 완전히 등록했다 — 여기선
  // 그 원래 소스 위치 기준 udtTypes/funcs/var 충돌만 재검사한다(enumTypes 자기 충돌은
  // registerEnumMembers가 prepass에서 이미 검사했으므로 제외, checkTypeDeclConflict와 대칭 패턴 —
  // C273: EnumDecl prepass가 Type/Func prepass보다 먼저 실행돼 udtTypes/funcs는 이 시점에 아직
  // 비어있으므로 그 충돌은 여기서 판정할 수 없었던 것과 정확히 반대 — 이제 메인 루프 시점엔 세
  // prepass가 전부 끝나 있어 신뢰 가능).
  checkEnumDeclConflict(stmt, prog);
}

// type Name 선언: top-level 전용(pine2py도 statement 레벨 전용 — 함수/블록 안에 중첩되는 시맨틱
// 자체가 Pine 문법에 없음). 필드 타입은 스칼라 5종, 다른 UDT 타입명(C123 — forward-ref/자기참조도
// C130부터 포함), enum 타입명(C273), 또는 array<T>/map<K,V>(C126/C127, 원소 타입·중첩 깊이 모두
// 재귀적으로 동일 규칙)만 통과(isUdtFieldTypeAllowed), 중복 필드명/이름 충돌(기존 var/UDF/다른
// type과)은 하드 에러.
//
// C233부터 이 로직은 두 단계로 나뉜다(analyzer.ts analyze()의 prepass 참조 — top-level
// `TypeName.new(...)` forward-reference를 지원하려면 단일 패스가 시작되기 전에 모든 top-level
// TypeDecl의 필드를 미리 알아야 한다):
// (1) registerTypeDeclFields — prepass가 소스 순서대로 호출. 필드 검증/등록 + type-vs-type 이름
//     충돌(같은 이름의 type이 두 번 선언)만 검사한다 — 이 시점엔 아직 어떤 FuncDecl/VarDecl도
//     분석되지 않아 그 맵들(funcs/varIndex)이 항상 비어있으므로 그 충돌은 여기서 판정할 수 없다
//     (둘 다 아직 없다고 나와 거짓음성이 됨). enumTypes는 예외 — C273부터 EnumDecl prepass가 이
//     prepass보다 먼저 실행돼 이 시점에 이미 완전히 채워져 있다(isUdtFieldTypeAllowed의 enum 필드
//     타입 검증과 필드 default 값의 enum 멤버 DotAccess 분석 둘 다 이 순서에 의존).
// (2) checkTypeDeclConflict — 메인 패스가 TypeDecl의 원래 소스 위치에서 호출. 그 지점까지
//     실제로 분석된 funcs/varIndex/enumTypes 상태로 이름 충돌만 재검사한다(udtTypes는 검사하지
//     않음 — prepass가 이미 전부 채워놔 항상 true이므로 신호가 안 됨, type-vs-type은 (1)이 이미
//     소스 순서대로 정확히 판정했다).
// analyzeTypeDecl 자신은 이제 nested(scope.depth !== 0, 문법상 무효) 경로 전용 — 그 경로는
// prepass가 절대 보지 않는 통계(script.body 바깥)라 원래 로직 그대로 유지한다.
function registerTypeDeclFields(stmt: TypeDecl, prog: AnalyzedProgram, scope: LexScope): void {
  if (prog.udtTypes.has(stmt.name)) {
    prog.errors.push(`이미 사용 중인 이름과 충돌하는 'type' 선언: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  const seenFields = new Set<string>();
  const fields: UdtFieldInfo[] = [];
  for (const f of stmt.fields) {
    if (seenFields.has(f.name)) {
      prog.errors.push(`중복 UDT 필드: '${stmt.name}.${f.name}' (L${f.line}:${f.col})`);
      continue;
    }
    seenFields.add(f.name);
    if (!isUdtFieldTypeAllowed(f.typeHint, prog)) {
      prog.errors.push(
        `UDT 필드 타입은 float/int/bool/string/color, 다른 UDT 타입(forward-ref/자기참조 포함), enum 타입, 또는 array<T>/map<K,V>(원소·중첩도 동일 규칙)만 지원: '${stmt.name}.${f.name}: ${f.typeHint}' (L${f.line}:${f.col})`,
      );
      continue;
    }
    if (f.default !== null) analyzeExpr(f.default, prog, scope, false);
    fields.push({ name: f.name, typeHint: f.typeHint, default: f.default });
  }
  prog.udtTypes.set(stmt.name, { fields });
}

function checkTypeDeclConflict(stmt: TypeDecl, prog: AnalyzedProgram): void {
  // C710: prog.funcs와의 충돌은 더 이상 여기서 막지 않는다 — TV는 `TypeName.new(...)`(값 위치)와
  // `TypeName(...)`(호출 위치)을 문법으로 완전히 분리해 type과 동명 UDF가 실제로 공존한다(wild
  // `type dwm_hl` + `dwm_hl(tf, use, hl, n, col, tf_limit) =>`류, tv_verdict_v2 accept 21건 실증).
  // codegen funcCodegenName(C413과 동일 원리)이 UDF 쪽 JS 바인딩만 "$fn"으로 물러나 실제 출력
  // 충돌은 없다 — analyzeCallExpr의 isUdtConstructorCall(DotAccess-only)/isUserFuncCall
  // (Identifier-only)도 AST 형태로만 갈려 이름이 같아도 디스패치 모호성이 없다.
  if (prog.enumTypes.has(stmt.name) || prog.varIndex.has(stmt.name)) {
    prog.errors.push(`이미 사용 중인 이름과 충돌하는 'type' 선언: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
  }
}

// analyzer.ts analyze()의 prepass가 top-level TypeDecl마다 소스 순서대로 호출한다.
export function prepassTypeDecl(stmt: TypeDecl, prog: AnalyzedProgram, scope: LexScope): void {
  registerTypeDeclFields(stmt, prog, scope);
}

export function analyzeTypeDecl(stmt: TypeDecl, prog: AnalyzedProgram, scope: LexScope): void {
  if (scope.depth !== 0) {
    prog.errors.push(`'type' 선언은 top-level에서만 가능: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  // depth===0이면 이 stmt는 script.body 직속이라 prepass가 이미 필드까지 완전히 등록했다 — 여기선
  // 그 원래 소스 위치 기준 이름 충돌만 재검사한다(중복 처리 방지, analyzer.ts 메인 루프 참조).
  checkTypeDeclConflict(stmt, prog);
}

// `obj.field := value` — object는 UDT var/​'=' 로컬로 추적된 단순 Identifier(단일 레벨, C224부터
// '=' 로컬도 포함)이거나, 그 자체가 UDT 필드 접근으로 확정되는 DotAccess(중첩 체이닝, C123 —
// `outer.inner.x := v`)만 허용. 필드 존재 여부만 검증하고 codegen이 na 리터럴을 필드 타입에 맞춰
// 재코드젠한다(genUdtValueForFieldType). value는 analyzeExpr이 아니라 analyzeControlFlowOrExpr로
// 분석한다(C265) — VarDecl/Assignment의 값 위치와 동일하게 if/for/while/switch 제어문-식도 허용해야
// `p.state := switch ... => "X"`(corpus 실측)가 통과한다. analyzeControlFlowOrExpr는 값이 이
// 4종이 아니면 그대로 analyzeExpr로 위임하므로 기존 스칼라 값 경로는 동작 변화가 없다.
export function analyzeFieldAssignment(stmt: FieldAssignment, prog: AnalyzedProgram, scope: LexScope): void {
  if (stmt.object.kind !== "Identifier" && stmt.object.kind !== "DotAccess") {
    prog.errors.push(
      `UDT 필드 대입 대상은 UDT 인스턴스 식별자 또는 그 필드 경로만 지원: (L${stmt.line}:${stmt.col})`,
    );
    analyzeControlFlowOrExpr(stmt.value, prog, scope);
    return;
  }
  // object가 DotAccess면(중첩 경로) 먼저 그 자신을 analyzeExpr로 방문해 udtFieldAccessTypes에
  // 타입을 등록시켜야 resolveUdtObjectType이 찾아낼 수 있다(analyzeExpr의 DotAccess 케이스와
  // 동일한 순서 규약).
  if (stmt.object.kind === "DotAccess") analyzeExpr(stmt.object, prog, scope, false);
  const typeName = resolveUdtObjectType(stmt.object, prog, scope);
  if (typeName === undefined) {
    const desc = stmt.object.kind === "Identifier" ? `'${stmt.object.name}'` : "대입 대상 경로";
    prog.errors.push(
      `${desc}는 UDT 인스턴스로 추적되지 않음(항상 'var Type x = Type.new(...)'로 선언할 것): (L${stmt.line}:${stmt.col})`,
    );
    analyzeControlFlowOrExpr(stmt.value, prog, scope);
    return;
  }
  // chart.point(C486)는 prog.udtTypes에 없는 값 타입이라 아래 typeInfo 조회가 성립하지 않는다 --
  // 필드 단위 재대입(`point.price := ...`) 지원 근거가 wild에 없어 범위 밖으로 명시 거부.
  if (typeName === CHART_POINT_FIELD_TYPE) {
    prog.errors.push(`'chart.point' 필드는 개별 재대입 미지원(전체 값을 다시 대입할 것): (L${stmt.line}:${stmt.col})`);
    analyzeControlFlowOrExpr(stmt.value, prog, scope);
    return;
  }
  const typeInfo = prog.udtTypes.get(typeName)!;
  if (!typeInfo.fields.some((f) => f.name === stmt.field)) {
    prog.errors.push(`'${typeName}'에 없는 필드: '${stmt.field}' (L${stmt.line}:${stmt.col})`);
  }
  analyzeControlFlowOrExpr(stmt.value, prog, scope);
}
