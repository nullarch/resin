// UDT 필드 타입 유틸(제네릭 타입 힌트 파싱/필드 타입 허용 판정) + method 이름 mangle --
// analyzer.ts 파일 분할 네 번째 슬라이스(collections.ts(C141)/ta.ts(C142)/constructors.ts(C143)에
// 이은 네 번째 파일). C143 next_hint가 지적한 대로 이 후보(구 next_hint의 "(a)")는 analyzer.ts상
// L68-297에서 연속 구간이 아니다 -- 사이에 낀 BAR_SERIES_NAMES/MATH_CONSTANTS/COLOR_CONSTANTS/
// ORDER_CONSTANTS/Qualifier·mergeQualifiers·extractQualifierFromHint/FuncInfo는 UDT와 무관한
// 별개 축(한정자 추론+UDF 시그니처)이라 analyzer.ts에 그대로 남긴다. mangleMethodName은 그 뒤
// (구 L260)에 더 떨어져 있지만 UDT method 이름 결정이라는 같은 주제라 함께 옮긴다 -- 유일한
// 소비처(analyzeMethodDecl/analyzeUserFuncCall)는 여전히 analyzer.ts에 남아 이름을 그대로
// import해 호출하므로 이동 자체가 그 함수들의 동작을 바꾸지 않는다(순수 이동, 신규 검증 로직 없음).

import type { CallExpr, Expr } from "../ast";
import type { AnalyzedProgram, FuncInfo } from "../analyzer";
import { DRAWING_ALL_NAMESPACES } from "./constructors";
import type { DrawingKind } from "./constructors";

// UDT 필드 스칼라 타입 화이트리스트. 중첩 UDT 필드(C123)는 analyzeTypeDecl이 이 Set과 별도로
// prog.udtTypes에 이미 등록된 타입명인지를 추가로 확인해 허용한다(아래 isUdtFieldTypeAllowed 참조).
const UDT_SCALAR_FIELD_TYPES: ReadonlySet<string> = new Set(["float", "int", "bool", "string", "color"]);

// drawing 핸들 타입(label/line/box/table/polyline/linefill, C318 wild 실사용 -- 대부분
// `line[] ln_handle`류 배열 필드로 여러 핸들을 보관). DRAWING_ALL_NAMESPACES(constructors.ts)를
// 그대로 재사용 -- 이미 이 6종의 정확한 네임스페이스 목록이라 별도 Set을 새로 정의할 필요 없음.
// pine2py codegen.py _pine_type_to_python도 이 6종을 전부 "object"로 매핑해 UDT 필드 타입으로
// 허용함을 확인(literal port).
const DRAWING_FIELD_TYPES: ReadonlySet<string> = DRAWING_ALL_NAMESPACES;

// chart.point(C486, wild 33건 "type X \n chart.point field"류) — 좌표 3개(x/y/time/price)를
// 담는 값 객체로 chart.point.new/from_index/from_time/copy/now(call-expr.ts)로만 생성되는 참조형.
// DRAWING_ALL_NAMESPACES에 넣지 않은 이유: 그 Set은 drawing kind 판별(resolveDrawingExprKind 등
// no-op 카운트/method 디스패치 전용 소비처가 여러 곳)에도 재사용되는데 chart.point는 drawing
// 핸들이 아니라 순수 좌표 값이라 그 의미론에 안 맞는다 — 별도 상수로 분리. pine2py
// _pine_type_to_python은 미매핑 타입명을 그대로 통과시키고 _type_default가 그 경우 "None"을
// 반환함을 python 직접 실행 없이 소스 대조로 확인(매핑 표에 없는 모든 타입명이 공유하는 마지막
// 분기라 chart.point도 예외 없이 이 경로 — string/color 등 명시 매핑된 것만 다른 기본값을 받음).
export const CHART_POINT_FIELD_TYPE = "chart.point";

// chart.point의 스칼라 필드 3종(runtime/drawing.ts ChartPoint 인터페이스와 정확히 동일 -- TV
// 문서/pine2py wavealgo 양쪽 다 x/y가 아니라 time/index/price임을 확인, LIMITATIONS.md C486
// 잔여 항목의 "x/y" 표기는 부정확했던 것으로 재확인).
export const CHART_POINT_FIELDS: ReadonlySet<string> = new Set(["time", "index", "price"]);

// 제네릭 컨테이너 필드(array<T>/map<K,V> C126, matrix<T> C128)의 베이스 이름. matrix<T>는 array<T>와
// 동일한 단항(args.length===1) 제약 — pine2py도 _GENERIC_TYPE_MAP에서 matrix를 array와 함께 "list"로
// 매핑해(codegen.py 소스 대조 확인) 필드 타입 화이트리스트/기본값 생성 경로가 array와 완전히 동일함을
// 실측 확인(런타임 표현은 pine2js PineMatrix가 그냥 unknown[][]라 빈 배열 `[]`이 그대로 유효한 0행
// 행렬 — 표현 조사 완료, 더 이상 "미조사" 아님).
const UDT_GENERIC_FIELD_BASES: ReadonlySet<string> = new Set(["array", "map", "matrix"]);

// 제네릭 타입 인자 문자열을 최상위(depth 0) 콤마 기준으로 분해 — pine2py codegen.py
// `_split_type_args`와 동일한 괄호 깊이 카운터(C127). "string, float" -> ["string","float"],
// "map<string, float>" 하나만 있는 인자열은 내부 콤마가 depth 1이라 분해되지 않고 그대로 단일
// 원소로 남는다("map<string, float>"). 각 조각은 parser.ts가 ", "(콤마+공백)으로 join해뒀으므로
// trim으로 앞 공백만 제거하면 원래 인자 문자열이 복원된다.
function splitGenericTypeArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      args.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return args;
}

// 제네릭 필드 타입 문자열("array<float>"/"map<string, float>", parser.ts parseFieldTypeHint가
// 조립)을 base와 타입 인자로 분해. base는 첫 '<' 앞부분, 인자는 splitGenericTypeArgs로 괄호 깊이를
// 추적해 분해한다(C127 — 이전엔 naive `.split(", ")`라 중첩 제네릭의 내부 콤마까지 함께 잘려
// args 개수가 실제보다 많아졌으나, 이제 "array<map<string, float>>"도 base="array"/
// args=["map<string, float>"] 하나로 정확히 분해된다). 방어선은 여전히 호출부
// isUdtFieldTypeAllowed의 args.length 체크(array는 정확히 1개, map은 정확히 2개) — 다만 이제는
// 이 개수 검증을 실제로 만족하는 임의 깊이 중첩 제네릭도 재귀적으로 허용된다.
function parseGenericFieldType(typeHint: string): { base: string; args: string[] } | null {
  const idx = typeHint.indexOf("<");
  if (idx === -1 || !typeHint.endsWith(">")) return null;
  const base = typeHint.slice(0, idx);
  const args = splitGenericTypeArgs(typeHint.slice(idx + 1, -1));
  return { base, args };
}

// UDT 필드 타입으로 허용되는지: 스칼라 5종이거나, drawing 핸들 6종(C318, DRAWING_FIELD_TYPES)이거나,
// 다른 UDT 타입명(C123, 중첩 UDT 필드 — 이미
// 완전히 분석된(prog.udtTypes) 타입뿐 아니라 forward-ref/자기참조(C130, prog.declaredTypeNames)
// 대상도 포함)이거나, enum 타입명(C273, prog.enumTypes — EnumDecl prepass가 TypeDecl prepass보다
// 먼저 실행되도록 순서가 바뀌어(analyzer.ts analyze() 참조) 이 시점에 이미 완전히 채워져 있음)이거나,
// 원소 타입이 이 규칙을 재귀적으로 만족하는 array<T>/map<K,V>(C126, UDT_GENERIC_FIELD_BASES).
// analyzer는 top-level 문장을 소스 순서 그대로 단일 패스 처리해 prog.udtTypes를 그때그때
// 채우지만(analyzeTypeDecl 참조), declaredTypeNames는 그 단일 패스가 시작되기 전에 모든 top-level
// TypeDecl 이름을 미리 훑어 채워두는 별도 집합이라(analyze() 참조) 아직 처리 안 된(forward) 타입도,
// 지금 막 처리 중인 자기 자신(self)의 타입명도 이 시점에 이미 보인다 — 링크드리스트류 자기참조/
// 상호참조 타입(C130)이 이 두 번째 사전 스캔 하나로 해결됨.
export function isUdtFieldTypeAllowed(typeHint: string, prog: AnalyzedProgram): boolean {
  if (
    UDT_SCALAR_FIELD_TYPES.has(typeHint) ||
    DRAWING_FIELD_TYPES.has(typeHint) ||
    typeHint === CHART_POINT_FIELD_TYPE ||
    prog.udtTypes.has(typeHint) ||
    prog.declaredTypeNames.has(typeHint) ||
    prog.enumTypes.has(typeHint)
  )
    return true;
  const generic = parseGenericFieldType(typeHint);
  if (generic === null || !UDT_GENERIC_FIELD_BASES.has(generic.base)) return false;
  if ((generic.base === "array" || generic.base === "matrix") && generic.args.length !== 1) return false;
  if (generic.base === "map" && generic.args.length !== 2) return false;
  return generic.args.every((arg) => isUdtFieldTypeAllowed(arg, prog));
}

// GOAL.md na 3분할 규약: string/color, drawing 핸들 6종(C318 — runtime/drawing.ts DrawingHandle이
// 순수 object 참조값, na=null), (C123) 중첩 UDT 필드, (C273) enum 필드(멤버가
// builtinStringConstants로 접히는 문자열이라 string/color와 동일 참조형 클래스), (C126)
// array<T>/map<K,V> 필드는 참조형 na=null. UDT 필드 기본값/대입 값의 na 리터럴은 필드 선언 타입에
// 따라 이 규약을 그대로 적용한다(genValueCode의 var string 특수화와 동일 원칙이나 UDT 필드는 var가
// 아니라 자체 맵이라 별도 헬퍼로 분리 — codegen.ts genUdtValueForFieldType 참조). prog가 필요해진
// 이유는 필드 타입명이 UDT/enum 타입인지 조회해야 해서.
export function isUdtReferenceFieldType(typeHint: string, prog: AnalyzedProgram): boolean {
  if (
    typeHint === "string" ||
    typeHint === "color" ||
    DRAWING_FIELD_TYPES.has(typeHint) ||
    typeHint === CHART_POINT_FIELD_TYPE ||
    prog.udtTypes.has(typeHint) ||
    prog.enumTypes.has(typeHint)
  )
    return true;
  const generic = parseGenericFieldType(typeHint);
  return generic !== null && UDT_GENERIC_FIELD_BASES.has(generic.base);
}

export interface UdtFieldInfo {
  name: string;
  typeHint: string;
  default: Expr | null;
}

export interface UdtTypeInfo {
  fields: UdtFieldInfo[];
}

// UDT 타입명 + method 이름 -> 프리앰블에 실제로 생성되는 top-level 함수 이름(C124). pine2py는 모든
// method를 flat top-level 함수로 내려 서로 다른 UDT에 동일 이름 method가 있으면 나중 선언이 앞선
// 선언을 완전히 덮어쓰는 latent 버그가 있다(Explore 조사로 확인, LIMITATIONS.md 참조) — pine2js는
// enum(C122)의 "EnumName.MemberName" qualified 문자열 패턴과 동일한 아이디어로 타입명을 이름에
// 섞어(mangle) 서로 다른 UDT의 동명 method가 항상 별개 top-level 함수로 분리되게 한다. codegen도
// 동일한 순수 함수를 그대로 재사용(analyzer/codegen 양쪽에서 import) — 맵이 아니라 문자열 결정론적
// 조합이라 저장할 필요 없이 항상 다시 계산 가능.
export function mangleMethodName(typeName: string, methodName: string): string {
  return `${typeName}$${methodName}`;
}

// arity-disjoint method 오버로드(C687, C686 FuncDecl 오버로드의 method판 — wild tv_verdict_v2
// "이미 정의된 method" 클러스터, 대표: a14303e258ac.pine `init(SessionTime this, int)` /
// `(this, int, int)` / `(this, int, int, string)` 3-오버로드). FuncDecl과 달리 method 콜사이트는
// DotAccess sugar(receiver 타입이 analyze 시점에야 확정)라 C686의 AST rename prepass를 못 쓴다 —
// 대신 analyzeMethodDecl이 충돌 시 [required, max] arity 범위(receiver 포함)가 전부 서로소일
// 때만 두 번째 이후를 `${base}$ov$k`로 등록하고 prog.methodOverloads에 이 표를 남긴다. 모든 조회
// 지점(analyzer/call-expr/codegen)은 base 이름 직접 get 대신 아래 lookupMethodOverload로 콜사이트
// 인자 개수(receiver 포함) 기준 선택한다 — analyzer/codegen이 같은 순수 함수를 공유해 mangled
// 이름이 어긋나는 C135 함정(한쪽만 수정 시 "internal: FuncInfo missing" 크래시)을 원천 차단.
export interface MethodOverloadEntry {
  // prog.funcs 등록 키 — 첫 선언은 base mangled 이름 그대로, 두 번째부터 `${base}$ov$k`(k=2,3..).
  name: string;
  // receiver를 포함한 [필수 인자 수, 전체 매개변수 수] (analyzeMethodDecl requiredParamCount와
  // 동일 계산 — 기본값 없는 마지막 매개변수의 1-기반 인덱스).
  min: number;
  max: number;
  // C688: same-arity 오버로드 판별자 — receiver가 array<drawing 6종>일 때 그 원소 kind, 그 외 null.
  // arity 범위가 겹치는 등록은 겹치는 상대 전부와 이 판별자가 서로 다를 때만 허용된다
  // (analyzeMethodDecl 게이트 — wild `method clear_aLabLin(label[] l)` / `(line[] l)` 쌍).
  elemKind: DrawingKind | null;
}

// C688: method receiver typeHint(한정자 접두어 포함 가능, FuncParam.typeHint 원문)로부터
// array<drawing> 원소 kind를 뽑는다 — 등록(analyzeMethodDecl)과 첫-선언 지연 등록(paramTypeHints
// 역조회) 양쪽이 같은 스트립 규칙을 쓰도록 stripParamQualifierPrefix를 여기서 함께 적용.
export function methodReceiverElemDrawingKind(typeHint: string | null | undefined): DrawingKind | null {
  if (typeHint == null) return null;
  return arrayDrawingElemType(stripParamQualifierPrefix(typeHint));
}

// argTotal: 콜사이트가 제공한 값 개수(위치+키워드, dot-sugar는 receiver 몫 +1 포함). 어느 범위에도
// 안 맞으면 base(첫 선언)로 폴백해 표준 arity 에러가 첫 선언에 귀속된다(C686 콜사이트 재배선의
// "어느 범위에도 안 맞는 콜사이트는 개명하지 않는다"와 동일 원칙). 오버로드가 아예 없는 이름은
// 기존 prog.funcs.get(base)와 완전히 동일 동작(표가 비어 있어 폴백 한 줄만 실행).
// C688 same-arity 확장: arity 범위에 2개 이상이 맞으면(등록 게이트상 전원이 서로 다른 elemKind를
// 가진 array<drawing> 쌍일 때만 가능) — (1) node가 주어지고 analyzer dispatch가 이미 확정한
// 결과(prog.methodOverloadResolutions)가 있으면 그걸 그대로 반환(C224 노드-캐시: codegen은 scope
// 체인이 없어 elemKind를 재유도할 수 없으므로 analyzer의 결정을 재사용해야 C135 발산이 없다),
// (2) elemKind 인자가 주어지면 그 kind와 일치하는 엔트리로 확정, (3) 둘 다 없으면 undefined —
// 소비처가 명시 처리한다(peek 지점들은 전부 undefined-관용이라 보수적 스킵, 실제 dispatch는
// call-expr.ts array extension 분기가 elemKind를 직접 유도해 확정하거나 명시 에러).
export function lookupMethodOverload(
  prog: AnalyzedProgram,
  typeName: string,
  methodName: string,
  argTotal: number,
  node?: CallExpr,
  elemKind?: DrawingKind | null,
): FuncInfo | undefined {
  if (node !== undefined) {
    const resolved = prog.methodOverloadResolutions.get(node);
    if (resolved !== undefined) return prog.funcs.get(resolved);
  }
  const base = mangleMethodName(typeName, methodName);
  const entries = prog.methodOverloads.get(base);
  if (entries !== undefined) {
    const matches = entries.filter((e) => argTotal >= e.min && argTotal <= e.max);
    if (matches.length === 1) return prog.funcs.get(matches[0]!.name);
    if (matches.length > 1) {
      if (elemKind !== undefined && elemKind !== null) {
        const kindMatch = matches.find((e) => e.elemKind === elemKind);
        return kindMatch !== undefined ? prog.funcs.get(kindMatch.name) : undefined;
      }
      return undefined;
    }
  }
  return prog.funcs.get(base);
}

// method 첫 매개변수 타입힌트로부터 mangleMethodName에 쓸 typeName을 결정한다(C327, wild 실측
// 251건 -- method 첫 매개변수가 UDT가 아니라 array<T>/map<K,V>/matrix<T> 제네릭 컨테이너인
// extension method, `method flush(array<float> this) => ...`류). UDT 타입명은 기존과 동일하게
// 그대로 typeName으로 쓰지만, 제네릭 컨테이너는 원소 타입(T)을 접어(base 이름만, 예: "array")
// dispatch한다 -- pine2js는 array/map/matrix 변수의 원소 타입을 값 흐름으로 추적하지 않아
// (resolveContainerExprKind가 "array"|"map"|null만 반환) 호출부에서 정확한 T를 알 수 없으므로
// TV의 컴파일타임 제네릭 오버로드 해석(같은 이름을 서로 다른 T로 여러 번 선언)은 지원 범위 밖 --
// 같은 base에 동명 method가 두 번 선언되면 analyzeMethodDecl의 기존 "이미 정의된 method" 중복
// 검사가 안전하게 거부한다(조용한 오답이 아니라 명시적 컴파일 에러, wild 실측 140개 (file,method)
// 그룹 중 128개는 단일 오버로드라 이 좁은 지원으로 충분 -- 나머지 12개는 LIMITATIONS.md 등재).
// C328: 스칼라 5종(float/int/bool/string/color, wild 실측 38건, `method normalize(float src) =>
// ...`류)도 받아들인다 -- 컨테이너와 달리 원소 타입 폴딩이 필요 없어(스칼라는 이미 원자적) typeHint
// 문자열을 그대로 typeName으로 쓴다. 같은 스칼라 타입에 동명 method를 두 번 선언하면(예: 둘 다
// "float") mangledName이 겹쳐 기존 "이미 정의된 method" 검사가 그대로 거부한다. 서로 다른 스칼라
// 타입에 동명 method를 선언하는 것(TV 컴파일타임 오버로드, wild 실측 2건)은 이 함수 자체는 각각을
// 별개 mangledName("float$f"/"int$f")으로 정상 등록하지만, 호출부(call-expr.ts
// resolveScalarMethodInfo)가 receiver의 정확한 스칼라 타입을 알 수 없어 별도로 거부한다.
// analyzer(analyzeMethodDecl)와 codegen(genMethodDecl) 양쪽이 이 순수 함수를 그대로 재사용해
// 항상 동일한 typeName/mangledName을 계산한다(mangleMethodName 자신과 동일한 재사용 원칙).
// FuncParam.typeHint 전용 한정자 접두어 제거("series Pivot" -> "Pivot", "series chart.point" ->
// "chart.point", "series map<string, float>" -> "map<string, float>" -- 앞 단어 하나만 잘라내
// 나머지(제네릭 인자 내부 콤마+공백 포함)는 그대로 보존한다. analyzer.ts extractQualifierFromHint의
// 짝 함수이나 그건 qualifier 자체를 반환하고 이건 그 뒤 남는 타입명을 반환한다는 점만 다르다 -- 이
// 함수가 신설되기 전엔 UDT_SCALAR_FIELD_TYPES/prog.udtTypes 조회가 전부 raw(한정자 포함) 문자열로
// 이뤄져 `series Pivot this`/`series Settings s`류 한정자 명시 매개변수가 UDT로 전혀 인식되지 않는
// 실제 버그였다(wild 29b3b91c4388.pine 실측 -- method 8개 전부 첫 매개변수 거부 + 무관 UDF의
// 한정자 명시 UDT 매개변수 필드 읽기 전부 거부, C486 후속 조사로 발견).
function stripParamQualifierPrefix(typeHint: string): string {
  const trimmed = typeHint.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return trimmed;
  const first = trimmed.slice(0, spaceIdx);
  return first === "series" || first === "simple" || first === "const" ? trimmed.slice(spaceIdx + 1).trim() : trimmed;
}

export function resolveMethodReceiverTypeName(typeHint: string, prog: AnalyzedProgram): string | undefined {
  const hint = stripParamQualifierPrefix(typeHint);
  if (prog.udtTypes.has(hint)) return hint;
  if (prog.enumTypes.has(hint)) return hint;
  if (UDT_SCALAR_FIELD_TYPES.has(hint)) return hint;
  if (DRAWING_FIELD_TYPES.has(hint)) return hint;
  const generic = parseGenericFieldType(hint);
  if (generic !== null && UDT_GENERIC_FIELD_BASES.has(generic.base)) return generic.base;
  return undefined;
}

// registerFuncSignature/analyzeMethodDecl의 매개변수별 FuncInfo.paramUdtTypes 등록 전용(C486 후속).
// resolveMethodReceiverTypeName과 동일한 한정자 스트립을 거치되, 스칼라/제네릭 컨테이너는 이 맵의
// 대상이 아니다(paramUdtTypes는 "obj.field" DotAccess 판별 전용 -- resolveUdtObjectType 소비처).
// chart.point는 UDT는 아니지만 동일한 "obj.field 읽기" 소비 패턴(time/index/price)을 공유해 여기
// 함께 인정한다(analyzer.ts DotAccess 케이스가 typeName===CHART_POINT_FIELD_TYPE을 별도 분기).
export function resolveParamUdtTypeHint(typeHint: string | null, prog: AnalyzedProgram): string | undefined {
  if (typeHint === null) return undefined;
  const hint = stripParamQualifierPrefix(typeHint);
  if (prog.udtTypes.has(hint)) return hint;
  if (hint === CHART_POINT_FIELD_TYPE) return hint;
  return undefined;
}

// typeHint 문자열("array<Foo>", parser.ts parseFieldTypeHint/parseVarDecl이 조립한 그대로)이 정확히
// array<UDT등록명> 형태면 그 UDT 타입명을 반환한다(C341, wild "네임스페이스 접근은 호출식만 지원"
// 클러스터의 장꼬리 -- `x = array.get(arrUdtVar, i)` 뒤 `x.field` 읽기가 arrUdtVar의 원소 타입을
// 몰라 거부되던 것). resolveMethodReceiverTypeName과 달리 base가 반드시 "array"여야 하고(map/matrix
// 제외 -- map.get은 값 하나가 아니라 키 조회라 별개 축, matrix<UDT> 원소 접근 corpus 실측 0건) 원소
// 타입도 반드시 등록된 UDT이거나 chart.point(C488, wild `lowPivots.get(lIndex).index`류 --
// chart.point는 prog.udtTypes에 없는 값 타입(C486)이라 별도로 인정. 반환값이 그대로
// resolveArrayGetElemUdtType -> analyzer.ts DotAccess 케이스의 objTypeName===CHART_POINT_FIELD_TYPE
// 분기(C486/C487에서 이미 배선됨)로 흘러 들어가 신규 분기 없이 필드 읽기가 성립한다)여야 한다
// (스칼라/컨테이너 중첩은 필드 접근 대상이 아니므로 제외).
export function arrayUdtElemType(typeHint: string, prog: AnalyzedProgram): string | null {
  const generic = parseGenericFieldType(typeHint);
  if (generic === null || generic.base !== "array" || generic.args.length !== 1) return null;
  const elem = generic.args[0]!;
  return prog.udtTypes.has(elem) || elem === CHART_POINT_FIELD_TYPE ? elem : null;
}

// typeHint 문자열이 정확히 "array<label/line/box/table/polyline/linefill>" 형태면 그 drawing
// kind를 반환한다(C352, arrayUdtElemType의 drawing 버전 -- UDT 대신 DRAWING_ALL_NAMESPACES로
// 원소 타입을 확정). UDT 필드 `array<box> boxes`류(for-in 루프 변수가 그 원소를 받는 경우)
// 판별 전용, prog가 필요 없다는 점만 arrayUdtElemType과 다르다(등록된 타입 집합 대신 고정
// 네임스페이스 6종 화이트리스트라 동적 조회가 불필요).
export function arrayDrawingElemType(typeHint: string): DrawingKind | null {
  const generic = parseGenericFieldType(typeHint);
  if (generic === null || generic.base !== "array" || generic.args.length !== 1) return null;
  const elem = generic.args[0]!;
  return DRAWING_ALL_NAMESPACES.has(elem) ? (elem as DrawingKind) : null;
}

// arrayUdtElemType/arrayDrawingElemType의 numeric 버전(C702, LIMITATIONS C701 hist-stateful 잔여
// 최다 서브그룹 -- wild `prevVolume = array.get(combinedVolumes, idx)[1]`류, container typeHint
// `float[]`가 parser.ts에서 `array<float>`로 정규화됨). typeHint가 정확히 "array<float/int/bool>"
// 형태일 때만 그 원소 base 타입명을 반환한다 -- Float64Array 기반 히스토리 슬롯에 안전하게 담을 수
// 있는 3종만 인정(string/UDT/array/map/matrix/drawing/color/chart.point/enum 원소는 전부 null,
// index-access.ts의 isArrayElemNumericSafeHistoryCall 전용 소비처).
export function arrayNumericElemTypeHint(typeHint: string): "float" | "int" | "bool" | null {
  const generic = parseGenericFieldType(typeHint);
  if (generic === null || generic.base !== "array" || generic.args.length !== 1) return null;
  const elem = generic.args[0]!;
  return elem === "float" || elem === "int" || elem === "bool" ? elem : null;
}

// arrayDrawingElemType의 map 버전(C500, wild `lineDraw.rTFdraw.get("High").set_xy1(...)` --
// `map<string, line>` UDT 필드에서 값을 꺼내자마자 바로 method-call sugar를 체이닝하는 패턴).
// typeHint가 정확히 "map<K, label/line/box/table/polyline/linefill>" 형태면 그 값 타입의 drawing
// kind를 반환한다 -- 키 타입(K)은 무관, 값 타입(V, args[1])만 검사.
export function mapValueDrawingElemType(typeHint: string): DrawingKind | null {
  const generic = parseGenericFieldType(typeHint);
  if (generic === null || generic.base !== "map" || generic.args.length !== 2) return null;
  const valueType = generic.args[1]!;
  return DRAWING_ALL_NAMESPACES.has(valueType) ? (valueType as DrawingKind) : null;
}

// arrayUdtElemType의 map 버전(C502, wild `data.get(key).v.avg()`류 -- `map<K, UDT>` UDT 필드에서
// 값을 꺼내자마자 바로 필드 읽기/method-call sugar를 체이닝하는 패턴. mapValueDrawingElemType이
// C500에서 이미 이 비대칭을 drawing 쪽만 해소했던 것을 UDT 쪽에도 대칭 적용). typeHint가 정확히
// "map<K, UDT등록명>" 형태면 그 값 타입명을 반환한다 -- 키 타입(K)은 무관, 값 타입(V, args[1])만
// 검사하고 arrayUdtElemType과 동일하게 등록된 UDT이거나 chart.point여야 한다.
export function mapValueUdtElemType(typeHint: string, prog: AnalyzedProgram): string | null {
  const generic = parseGenericFieldType(typeHint);
  if (generic === null || generic.base !== "map" || generic.args.length !== 2) return null;
  const valueType = generic.args[1]!;
  return prog.udtTypes.has(valueType) || valueType === CHART_POINT_FIELD_TYPE ? valueType : null;
}

// 호출부(call-expr.ts analyzeCallExpr 최종 catch-all 직전)에서 스칼라 receiver extension method를
// 디스패치하기 위한 후보 조회(C328). resolveContainerExprKind/resolveMatrixExprKind 같은 "수신자
// 종류 판별" 인프라가 스칼라엔 없다 -- 스칼라 var/식은 값 흐름 추적 없이는 5종 중 정확히 어느
// 타입인지 알 수 없으므로, 호출부는 5종 전부를 순회해 mangleMethodName으로 매칭되는 선언을 전부
// 모아 반환한다. 정확히 1개만 매칭되면 그 base로 확정 디스패치(wild 실측 38건 중 36건이 이 경우 --
// 같은 이름을 두 스칼라 타입에 동시 선언하는 경우가 드묾), 2개 이상 매칭되면(wild 실측 2개 파일 --
// `method f(float/int/bool/string)` 4-오버로드, `method getType(int/float/string)` 3-오버로드) TV
// 컴파일타임 타입 오버로드 해석을 값 흐름 추적 없이는 판별 불가하므로 호출부가 명시적으로 거부한다
// (조용한 오답 대신 명시적 컴파일 에러, C327의 컨테이너 다중 오버로드 정책과 동일 원칙).
export function resolveScalarMethodInfo(
  method: string,
  prog: AnalyzedProgram,
  argTotal: number,
): { base: string; info: FuncInfo }[] {
  const matches: { base: string; info: FuncInfo }[] = [];
  for (const base of UDT_SCALAR_FIELD_TYPES) {
    // C687: 같은 스칼라 base 안 arity-disjoint 오버로드도 콜사이트 인자 개수로 선택(lookupMethodOverload
    // 주석 참조) — 오버로드가 없으면 기존 base 직접 조회와 완전히 동일.
    const info = lookupMethodOverload(prog, base, method, argTotal);
    if (info !== undefined) matches.push({ base, info });
  }
  return matches;
}
