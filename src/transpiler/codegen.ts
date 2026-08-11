// CodeGen: AnalyzedProgram -> plain JS 2-layer 모듈 문자열 (ROADMAP P2-0 "codegen 2-layer 출력").
// 출력 구조: 프리앰블(1회 실행 — UDF 함수 선언 + UDF가 클로저로 붙잡는 top-level '=' 로컬의
// `var` 선언) 뒤에 `return function () { <per-bar 문장들> };`이 이어진다.
// `new Function('$', 'rt', code)`가 만든 팩토리를 ctx당 1회 호출하면(프리앰블 실행) per-bar 함수가
// 반환되고, 엔진은 그 함수만 매 바 호출한다 — UDF 함수 객체가 매 바 재생성되던 기존 구조(GOAL.md
// "bar loop 안 할당 제로" 위반)를 해소한다(engine.compile 참조).
// GOAL.md 불변 원칙: Series 산술은 명시적 .get(0) 생성(Proxy/valueOf 금지), 상태는 정수 슬롯
// ($.vars[i] / $.taSlots[i] / $.fnVars[slotBase+i]), 안전 나눗셈은 rt.pineDiv.

import type { AnalyzedProgram, SecurityVarSliceStmt } from "./analyzer";
import {
  BAR_INDEX_NAME,
  BAR_SERIES_NAMES,
  BID_ASK_NAMES,
  CHART_POINT_FIELD_TYPE,
  DERIVED_PRICE_NAMES,
  INPUT_DISCARD_SLOT_NAMES,
  INPUT_PARAM_NAMES,
  isUdtReferenceFieldType,
  lookupMethodOverload,
  mangleMethodName,
  MATH_KWARG_PARAM_NAMES,
  COLOR_KWARG_PARAM_NAMES,
  detectTupleReturnArityFromLastStmt,
  detectTupleReturnArityFromTailExpr,
  NZ_KWARG_PARAM_NAMES,
  resolveMethodReceiverTypeName,
  resolveTaKwargPositions,
  resolveTimestampKwargSlots,
  RUNTIME_KWARG_PARAM_NAMES,
  STRATEGY_RUNTIME_PROPS,
  SYMINFO_NUMBER_PROPS,
  EARNINGS_NUMBER_PROPS,
  DAYOFWEEK_CONSTANTS,
  DRAWING_STATE_PARAM_NAMES,
  TA_REGISTRY,
  taCallReturnArity,
  TICKER_KWARG_PARAM_NAMES,
  TIME_CALL_KWARG_PARAM_NAMES,
  TIME_FUNC_NAMES,
  TIME_VAR_NAMES,
  TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES,
  timeframeBooleanPropValue,
} from "./analyzer";
import { DRAWING_ALL_NAMESPACES } from "./analyzer/constructors";
import { ARRAY_KWARG_PARAM_NAMES, STR_KWARG_PARAM_NAMES } from "./analyzer/collections";
import type {
  Assignment,
  BinOp,
  CallExpr,
  Expr,
  ExprStmt,
  FieldAssignment,
  ForInStmt,
  ForStmt,
  FuncDecl,
  FuncParam,
  IfStmt,
  IndexAccess,
  MethodDecl,
  Stmt,
  SwitchCase,
  SwitchStmt,
  TernaryOp,
  TupleDestructure,
  TupleExpr,
  TypeDecl,
  TypeField,
  WhileStmt,
} from "./ast";

// GOAL.md: while/for 루프 안전 제한 10,000회/bar (무한루프 방지 — pine2py _gen_while과 동일 규칙,
// for도 매 바 반복되므로 동일 캡을 공유한다)
const LOOP_LIMIT = 10000;

// JS ReservedWord(ECMA-262) 중 Pine 키워드(tokens.ts KEYWORDS)가 아닌 것만 — 즉 Pine 렉서가
// IDENTIFIER로 토큰화해 사용자가 var/method-param/for-loop-var/'=' 로컬/튜플 대상 이름으로 그대로
// 쓸 수 있지만, 그 이름을 codegen이 여기(program.locals)서 JS 바인딩 식별자로 literal 방출하면
// 항상(strict 모드 무관) SyntaxError인 것들(C270 corpus_scan `new Function` 실측 -- method
// receiver 매개변수명이 `this`인 경우 38건 발견). arguments/eval/yield/static 등 strict-mode-only
// 제약 단어는 제외(genned 코드는 'use strict' 없음, sloppy 모드에서 legal).
// "rt"는 SyntaxError 대상이 아니지만 `new Function("$", "rt", code)`로 주입되는 런타임 파라미터와
// 이름이 겹친다 — Pine 로컬이 이 이름을 그대로 쓰면 모든 빌트인 콜(`rt.xxx(...)`)이 하드코딩
// 리터럴이라 그 지점부터 로컬 자신을 가리키게 되고, block-scope `let rt = rt.array.get(...)`처럼
// 초기값 식 안에서 자기 자신을 참조하면 TDZ ReferenceError로 크래시한다(C576, exec 클러스터
// "Cannot access 'rt' before initialization" 실증). 같은 안전장치(접미사 rename)로 충분해 여기
// 포함.
const JS_RESERVED_LOCAL_NAMES: ReadonlySet<string> = new Set([
  "case", "catch", "class", "debugger", "default", "delete", "do", "extends", "finally",
  "function", "in", "instanceof", "new", "null", "return", "rt", "super", "this", "throw",
  "try", "typeof", "void", "with",
]);

// program.locals(=' 로컬/UDF·method 매개변수/for·for-in 루프 변수/튜플 디스트럭처링 대상)에 속하는
// Pine 이름을 JS 바인딩 식별자 위치(선언/참조 양쪽)에 안전하게 내리는 단일 변환점 — Set 멤버십
// 검사(program.locals/funcCtx.localVarIndex/promoted 등)는 원래 Pine 이름 그대로 쓰고, 최종
// 출력 문자열에 꽂는 이 지점에서만 치환한다(pine2py의 `open_` 접미 관행과 동일 원칙, MEMORY.md
// Pitfalls 참조).
function safeLocalName(name: string): string {
  return JS_RESERVED_LOCAL_NAMES.has(name) ? `${name}_` : name;
}

// 순수 UDF(mangle 없이 raw 이름을 그대로 JS 함수 선언명으로 쓰는 것)의 JS 바인딩 이름을 계산하는
// 단일 변환점(C413, wild "이미 함수로 선언된 이름은 top-level '=' 변수로 재사용할 수 없음" 42건
// 지원 — analyzer.ts FuncInfo.shadowedByTopLevelLocal 주석 참조). 이 함수와 이름이 같은 top-level
// '=' 로컬이 있으면(TV는 call-vs-value 문법으로 두 네임스페이스를 분리하지만 top-level '=' 로컬은
// raw JS 식별자로 내려가므로 `function name(){}` 선언과 그대로 충돌한다) "$fn" 접미사로 이 함수
// 자신의 JS 바인딩만 분리한다 — 콜사이트(genCallExpr)도 반드시 이 헬퍼로 같은 이름을 계산해야
// 함수 선언과 호출이 항상 짝을 이룬다. 충돌이 없는 절대다수 함수는 safeLocalName과 완전히 동일해
// 기존 codegen 출력이 한 글자도 안 바뀐다.
// C710: 같은 이름의 `type X`가 있는 경우(TV는 `X.new(...)`/`X(...)` call-vs-value 문법으로 type과
// UDF 네임스페이스를 분리 — wild `type dwm_hl` + `dwm_hl(tf, use, hl, ...) =>` 실증)도 동일 원리로
// 이 함수 자신의 JS 바인딩만 분리한다 — genTypeDecl의 팩토리는 항상 비-mangled `function
// <typeName>(...)`을 방출하므로(udtConstructorCalls 콜사이트가 program.udtTypes 키를 그대로 JS
// 식별자로 쓴다) type 쪽은 그대로 두고 UDF만 "$fn" 접미사로 물러나야 충돌하지 않는다.
function funcCodegenName(name: string, program: AnalyzedProgram): string {
  const safe = safeLocalName(name);
  const needsMangle = program.funcs.get(name)?.shadowedByTopLevelLocal || program.udtTypes.has(name);
  return needsMangle ? `${safe}$fn` : safe;
}

// UDF 본문을 generate 중일 때만 채워지는 컨텍스트: 그 함수의 var/varip 이름 -> 함수-상대 슬롯
// 인덱스. genIdentifier/VarDecl/':=' 세 곳 모두 이 맵을 최우선으로 조회해 `$.fnVars[__slotBase+i]`
// 로 내린다(analyzer.ts의 scope.func와 정확히 같은 모양으로 재귀 호출마다 그대로 전달된다 —
// 두 파일이 서로 다른 메커니즘(스코프 체인 vs 명시적 파라미터)을 쓰지만 "함수 본문 안인가"라는
// 동일한 질문에 항상 같은 답을 내야 하므로 AST 순회 구조를 analyzer와 동일하게 유지한다).
interface FuncGenContext {
  localVarIndex: Map<string, number>;
  // 이 함수의 매개변수 이름 집합(C414) — genIdentifier/resolveAssignTarget이 program.varIndex(top-level
  // var)보다 먼저 확인해야 한다. 매개변수는 funcCtx.localVarIndex(함수 '내부' var 전용)에 전혀
  // 등록되지 않아, 이 필드가 없으면 매개변수명이 top-level var와 같을 때 그 var의 현재 값
  // ($.vars[slot])으로 잘못 컴파일되고 실제 인자값은 영영 안 읽힌다(analyzer.ts analyzeFuncDecl
  // C414 주석 참조 — 이 우선순위 버그가 실제 해당 조합의 하드 에러 사유였다).
  paramNames: ReadonlySet<string>;
  // 함수 본문 안(어느 깊이든) '=' Assignment/튜플 디스트럭처로 새로 선언된 이름(analyzer.ts
  // FuncInfo.eqLocalNames/histShadowedNames/tupleEqLocalNames 합집합, C568) — paramNames와 동일한
  // 이유로 program.varIndex(top-level var)보다 먼저 확인해야 한다. 이 필드가 없으면 func-local '='
  // 로컬이 top-level var와 이름이 같을 때(예: `f() => arr = array.new<T>() ... arr` 함수 안 로컬과
  // `var array<T> arr = f()` top-level var가 동명, wild 실사용) JS는 `let arr = ...`로 로컬을 올바르게
  // 선언해두고도 이후 모든 읽기/쓰기가 top-level var 슬롯($.vars[slot])으로 잘못 컴파일된다 —
  // "UDF 본문 '=' 로컬은 JS let 블록 스코프 섀도잉이라 안전"이라는 기존 가정(analyzer.ts
  // analyzeAssignment 주석)은 이름이 top-level **var**와 겹치지 않을 때만 성립했다(top-level '='
  // 로컬끼리는 둘 다 이 program.locals bare-name 경로를 타 자연히 안전, var만 별도 슬롯 경로라 문제).
  bodyLocalNames: ReadonlySet<string>;
  // 매개변수명 -> UDT 타입명(analyzer.ts FuncInfo.paramUdtTypes 미러, C124) — resolveUdtObjectType이
  // 함수/method 본문 안에서 매개변수의 obj.field 읽기/쓰기를 찾아낼 때 조회한다.
  paramUdtTypes: Map<string, string>;
  // 함수 내부 var 이름 -> UDT 타입명(analyzer.ts FuncInfo.localVarUdtTypes 미러, C392) —
  // paramUdtTypes와 동일한 소비처(resolveUdtObjectType)가 함수-내부 `var Type x = ...`의 obj.field
  // 읽기/쓰기를 찾아낼 때 조회한다(func-local var를 '=' 로컬으로 다시 감싸지 않고 직접 필드 접근하는
  // 형태 전용 — 그 외 형태는 analyzer의 scope 체인 캐시(udtFieldAccessTypes)가 이미 커버).
  localVarUdtTypes: Map<string, string>;
  // 함수 내부 var 이름 -> 선언 typeHint 원문(analyzer.ts FuncInfo.localVarTypeHints 미러, C572) —
  // genStmt의 func-local VarDecl 분기가 `var box/label/UDT/array<T>/... x = na`를 top-level
  // genValueCode와 동일하게 참조형 na=null로 낮추는 데 쓴다(isUdtReferenceFieldType 재사용). 이
  // 필드가 없으면 func-local reference-typed var는 na가 항상 NaN(스칼라)으로 낮아져, 이후 그
  // 값을 읽는 참조형 전용 함수(예: rt.box.get_right)가 원시값에서 프로퍼티를 읽다가 크래시한다.
  localVarTypeHints: Map<string, string | null>;
  // 함수-내부 히스토리(C364, FuncInfo.localHistSlots/localHistKinds 미러) — genIndexAccess가
  // `$.histSlots[__histBase + rel].get(n)`을 내고, genStmt(Assignment)가 '=' 로컬("local" kind)
  // 대입문 직후 record를 방출할 때 조회한다.
  localHistSlots: Map<string, number>;
  localHistKinds: Map<string, "param" | "local" | "var">;
  // C714 UDF 확장(FuncInfo.localAmbiguousNestedHistDeclSlots/localAmbiguousNestedHistReadSlots
  // 미러, next_hint(C715)) — 형제 if/for 블록마다 독립 선언된 '=' 로컬은 이름이 아니라 대입문/읽기
  // 노드 identity로 키잉된다. genStmt(Assignment)가 declSlots를, genIndexAccess가 readSlots를 조회.
  localAmbiguousNestedHistDeclSlots: Map<Assignment, number>;
  localAmbiguousNestedHistReadSlots: Map<IndexAccess, number>;
  // 함수-내부 drawing 핸들 히스토리(C541, FuncInfo.localRefHistSlots/localRefHistKinds 미러) —
  // localHistSlots와 동형이나 물리 배열이 $.refHistSlots(__refHistBase 인자)로 분리된다.
  // genIndexAccess 읽기와 genStmt(Assignment) "local" kind 대입문 직후 record가 조회. C751:
  // "param" kind는 대입문이 없어 genParamHistRecords가 함수 진입 직후 1회 record.
  localRefHistSlots: Map<string, number>;
  localRefHistKinds: Map<string, "local" | "var" | "param">;
  // C714 UDF 확장의 drawing 핸들 판(FuncInfo.localAmbiguousNestedRefDeclSlots/
  // localAmbiguousNestedRefReadSlots 미러) — localAmbiguousNestedHistDeclSlots/ReadSlots와 동형이나
  // 물리 배열이 $.refHistSlots(__refHistBase 인자)로 분리된다.
  localAmbiguousNestedRefDeclSlots: Map<Assignment, number>;
  localAmbiguousNestedRefReadSlots: Map<IndexAccess, number>;
  // ta.<fn>(...)[N] 등 CallExpr 히스토리(C483, FuncInfo.localCallHistSlots 미러) — genIndexAccess의
  // CallExpr 분기가 funcCtx 안에서 우선 조회해 `$.histSlots[__histBase + rel]`로 인라인 record+get을
  // 방출한다(named locals의 "local" 역할과 동일한 인라인 타이밍, 단 이름이 아니라 AST 노드가 키).
  // C720: 산술식(BinOp/UnaryOp/리터럴) 히스토리도 이 맵을 공유(FuncInfo 미러와 동일하게 Expr로
  // 확장) — genIndexAccess BinOp/UnaryOp/리터럴 분기가 funcCtx 안에서 우선 조회.
  localCallHistSlots: Map<Expr, number>;
  // UDF 본문 조건부 위치 stateful 콜 압축 히스토리(C672, FuncInfo.localCondCallHistSlots 미러) —
  // genIndexAccess CallExpr 분기가 조회해 `$.condCallHistSlots[__condHistBase + rel]`로 인라인
  // push+get을 방출한다(top-level condCallHistorySlots(C671)의 콜사이트별 독립 판). C720: 산술식
  // 판도 공유(Expr로 확장).
  localCondCallHistSlots: Map<Expr, number>;
  // UDF 본문 조건부 위치 drawing 생성자 콜 압축 히스토리(C701, FuncInfo.localCondCallRefHistSlots
  // 미러) — genIndexAccess CallExpr 분기가 조회해 `$.condCallRefHistSlots[__condRefHistBase + rel]`로
  // 인라인 push+get을 방출한다(top-level condCallRefHistorySlots(C700)의 콜사이트별 독립 판).
  localCondCallRefHistSlots: Map<CallExpr, number>;
  // UDF/method 매개변수(UDT) 필드 히스토리(C750, FuncInfo.localFieldHistSlots/localFieldRefHistSlots
  // 미러) — 키는 "매개변수이름.필드이름" 문자열. genIndexAccess의 DotAccess 분기가 top-level
  // udtFieldHistorySlots/udtFieldRefHistorySlots보다 먼저 조회해 `$.histSlots[__histBase + rel]`/
  // `$.refHistSlots[__refHistBase + rel]`로 읽고, genFuncDecl/genMethodDecl이 함수 진입 직후
  // 1회 record를 방출한다(genParamHistRecords의 "param" kind와 동일 타이밍).
  localFieldHistSlots: Map<string, number>;
  localFieldRefHistSlots: Map<string, number>;
}

// request.security 셋째 슬라이스 서브슬라이스 3b(ROADMAP [hard->분할], C181) — securityExprCallSlots
// (3a, C180)에 등록된 표현식을 HTF 프리패스 함수(genSecurityExprPreamble) 본문 안에서 codegen할
// 때만 채워지는 컨텍스트. FuncGenContext(UDF 매개변수 바인딩)와 유사한 "새 바인딩 종류"이지만
// 완전히 별개 축이라 별도 타입으로 분리한다(UDF 콜은 이 표현식 문법에서 애초에 하드 에러라 두
// 컨텍스트가 동시에 non-null일 일이 없음). cacheVar/loopVar는 genSecurityExprPreamble이 실제로
// 방출하는 프리패스 함수의 로컬 변수 이름과 반드시 일치해야 한다(genBarRef가 이 이름으로 코드를
// 조립).
interface SecurityExprGenContext {
  cacheVar: string;
  loopVar: string;
  // C370 hist-on-expr: analyzer histReads의 IndexAccess 클론 → 프리패스 버퍼 인덱스(배열 순서).
  // genIndexAccess가 노드 identity로 조회해 `(h >= n ? __secHistK[h - n] : NaN)`으로 방출한다 —
  // bare/파생 시리즈 히스토리(캐시 배열 직접 읽기)는 여기 등록되지 않아 기존 출력 불변.
  histBufs: ReadonlyMap<Expr, number>;
  // C738: top-level var 상태 변수 리플레이 슬라이스(analyzer SecurityVarSlice)의 이름 → 프리패스
  // 함수 로컬(__svN). genIdentifier가 최우선으로 조회한다 — 미설정(기존 전 경로)이면 출력 불변.
  sliceLocals?: ReadonlyMap<string, string>;
}

// 프리패스 함수 로컬 히스토리 버퍼 이름 — 선언(generateSecurityExprPreamble)과 읽기(genIndexAccess)
// 두 지점이 반드시 같은 문자열을 조립해야 한다. 사용자 식별자는 프리패스 본문에 bare/파생 시리즈
// 로컬(open/high/low/close/volume)로만 등장하므로(치환 변수는 정의식으로 대체됨) 충돌 없음.
function secHistBufName(idx: number): string {
  return `__secHist${idx}`;
}

// bar series(open/high/low/close/volume) 참조를 두 모드로 방출하는 단일 지점 — 기존 하드코딩된
// `$.<field>.get(<offset>)` 문자열(암묵 series 주입 캐스케이드 다수 + genIdentifier)을 이 헬퍼로
// 교체해, secCtx===null(기존 메인 타임프레임 경로)일 때는 한 글자도 다르지 않은 출력을 내고
// secCtx!==null(HTF 프리패스 안)일 때만 로컬 스칼라(offset 0, 그 행 자신) 또는 캐시 배열의
// 이전 HTF 행(offset 1 — ta.tr/atr/kc/supertrend/dmi류의 prevClose/prevHigh/prevLow, 그 함수가
// 이 HTF 프리패스에서도 "직전 HTF 바"를 가리키도록 재해석 — TV 미검증 순수 신규 설계,
// DIVERGENCES.md 참조)로 방출한다. offset>=2는 이 코드베이스의 어떤 암묵 주입도 쓰지 않아 다루지
// 않는다.
function genBarRef(
  field: "open" | "high" | "low" | "close" | "volume",
  offset: 0 | 1,
  secCtx: SecurityExprGenContext | null,
): string {
  if (secCtx === null) return `$.${field}.get(${offset})`;
  if (offset === 0) return field;
  return `(${secCtx.loopVar} > 0 ? ${secCtx.cacheVar}.${field}[${secCtx.loopVar} - 1] : NaN)`;
}

// hl2/hlc3/ohlc4/hlcc4(DERIVED_PRICE_NAMES) 합성 — pine2py wavealgo/context.py push_bar()의
// 리터럴 공식(L150-153: hl2=(h+l)/2, hlc3=(h+l+c)/3, ohlc4=(o+h+l+c)/4, hlcc4=(h+l+c+c)/4)을 그대로
// 이식. 이미 codegen된 open/high/low/close 코드 문자열(genBarRef 또는 `$.<field>.get(offset)`)을
// 받아 조립하는 순수 문자열 함수라 secCtx(HTF 프리패스) 유무와 무관하게 재사용 가능 — 호출부가
// 각자의 문맥에 맞는 4개 피연산자 문자열을 먼저 만들어 넘긴다.
function genDerivedPriceExpr(name: "hl2" | "hlc3" | "ohlc4" | "hlcc4", o: string, h: string, l: string, c: string): string {
  switch (name) {
    case "hl2":
      return `((${h} + ${l}) / 2)`;
    case "hlc3":
      return `((${h} + ${l} + ${c}) / 3)`;
    case "ohlc4":
      return `((${o} + ${h} + ${l} + ${c}) / 4)`;
    case "hlcc4":
      return `((${h} + ${l} + ${c} + ${c}) / 4)`;
  }
}

// 삼항/and·or의 lazy 위치(단락 평가로 스킵될 수 있는 피연산자) 아래의 stateful 콜(ta.*/fixnan)은
// TV v5가 양쪽을 항상 평가하므로(MEMORY.md Pitfalls, C24) JS ?:/&&/||로 그대로 내리면 조건 false
// 바에 상태 갭이 생긴다 — 콜 자체를 소유 문장 바로 앞 `let __lazyN = rt....(...)`로 eager
// 호이스팅하고(hoistLazyStatefulCalls), 본식에서는 그 임시변수를 읽는다(C66, ROADMAP P2 조건부
// stateful call lazy 슬라이스). 값을 결합하는 구조 자체는 그대로 유지(삼항은 네이티브 `?:`, and/or는
// rt.pineAnd/pineOr 호출 — C69) — 임시변수는 이미 평가가 끝난 뒤라 단락 평가는 값 선택에만 남고
// 상태 전진은 문장당 무조건 1회가 된다. 프리루드가 문장과 같은 블록(if 분기 본문/VarDecl 게이트 안
// 등)에 붙으므로 per-call 시맨틱(C64/C65 — 문장이 실행되는 바에서만 호출)은 그대로 유지된다.
// 콜사이트 AST 노드 identity는 프로그램 전체에서 유일하므로 노드→임시변수명 맵은 generateCode당
// 하나로 충분하다(중첩 문장 간 저장/복원 불필요).
let lazyTempCounter = 0;
const lazyTemps = new Map<Expr, string>();

// 제어문-식 결과 임시변수(`let __cfrN = NaN`) 이름 카운터 — lazyTempCounter와 동일하게
// generateCode 호출 단위로 리셋한다. 임시변수를 거치는 이유(C266): target에 NaN을 선대입한 뒤
// 분기가 target을 직접 덮어쓰는 이전 구조는, 분기 값 표현식이 대입 대상 자기 자신을 읽는 조합
// (`x := if cond \n x+1 \n else \n x-1`)에서 그 읽기가 이미 NaN으로 덮인 뒤라 항상 NaN을 내는
// 버그였다(C265 발견, MEMORY.md Pitfalls). pine2py는 단일 표현식 if/else만 인라인 삼항
// 패스트패스(`x = (x+1 if cond else x-1)` — RHS 전체 평가 후 1회 대입)로 올바르고 나머지는
// target=None 선대입이라 자기참조 시 크래시하는데(GOAL.md "알려진 버그는 따르지 않는다"),
// 임시변수 방식은 그 패스트패스의 "이전 값 읽기 → 완료 후 1회 대입" 시맨틱을 5종 제어문-식
// 전부로 일반화한다. 중첩(분기 본문 안의 또 다른 제어문-식 대입)에서 이름이 겹치면 안쪽 let이
// 바깥 임시변수를 섀도잉해 바깥 결과가 소실되므로 카운터로 유일성을 보장한다.
let cfrTempCounter = 0;

// 튜플 디스트럭처링의 '_' 플레이스홀더(analyzer가 같은 문장 안 반복을 허용, TV 문서화된 "버림"
// 관용구)가 두 번째부터 방출될 때 쓰는 유일 임시 이름 카운터 — lazyTempCounter/cfrTempCounter와
// 동일하게 generateCode 호출 단위로 리셋한다. 첫 '_'는 이름 그대로 유지(analyzer가 scope에 등록한
// 것과 codegen 출력이 일치해야 그 뒤의 '_' 읽기가 정확히 "첫 튜플 원소"를 가리킴), 두 번째부터는
// `let`/`var` 어느 쪽으로 방출되든 같은 문장 안에서 동일 식별자를 재선언하지 않도록 새 이름이
// 필요하다(`let _ = a, _ = b;`는 JS SyntaxError — 자세한 내용은 genTupleDestructure 참조).
let tupleDiscardCounter = 0;

// C434: request.security_lower_tf 튜플 디스트럭처의 bare UDF 콜 폼(`[a,b,...] =
// request.security_lower_tf(sym, tf, udfCall())`)이 udfCall()을 정확히 1회만 실행하도록 담아두는
// 임시변수 이름 카운터 — tupleDiscardCounter와 동일하게 generateCode 호출 단위로 리셋한다(genTupleDestructure
// 참조, 같은 함수 스코프 안에 이 폼이 여러 번 나와도 이름이 겹치지 않게 함).
let secLtfTempCounter = 0;

// VarDecl/Assignment 값 위치의 제어문-식(analyzer가 이 4종 외의 위치를 전부 에러로 막았으므로
// 여기 도달하면 항상 이 중 하나 — TupleExpr와 동일한 "analyzer가 좁혀둔 안전한 캐스팅" 패턴).
type ControlFlowExpr = IfStmt | ForStmt | WhileStmt | SwitchStmt;

function isControlFlowExpr(expr: Expr): expr is ControlFlowExpr {
  return (
    expr.kind === "IfStmt" || expr.kind === "ForStmt" || expr.kind === "WhileStmt" || expr.kind === "SwitchStmt"
  );
}

export function generateCode(program: AnalyzedProgram): string {
  if (program.errors.length > 0) {
    throw new Error(`codegen 호출 전 analyzer 에러 필요: ${program.errors.join("; ")}`);
  }
  // lazy 호이스팅 상태는 generateCode 호출 단위로 초기화한다(모듈 상태를 쓰는 유일한 이유는
  // genExpr 재귀 전체에 파라미터를 새로 꿰지 않기 위해서 — 위 lazyTemps 주석 참조).
  lazyTempCounter = 0;
  lazyTemps.clear();
  cfrTempCounter = 0;
  tupleDiscardCounter = 0;
  secLtfTempCounter = 0;
  // UDF는 pine2py _HOISTABLE_TYPES와 동일하게 소스상 위치와 무관하게 항상 프리앰블(1회 실행
  // 영역)에 생성한다 — 2-layer 구조에서는 이것이 단순한 가독성 배치가 아니라 실제 시맨틱이다:
  // 프리앰블은 ctx당 딱 한 번 실행되므로 UDF 함수 객체가 매 바 재생성되지 않는다.
  // type 선언(UDT)도 UDF와 동일하게 항상 프리앰블에 생성한다 — ctx당 1회만 정의되면 되는
  // 컴파일타임 팩토리 함수라 per-bar 재생성이 불필요하다(UDF와 동일 이유, 상태 자체가 없어
  // collectPreambleLocals의 클로저 캡처 분석 대상도 아니다).
  const typeDecls = program.script.body.filter((s): s is TypeDecl => s.kind === "TypeDecl");
  const funcDecls = program.script.body.filter((s): s is FuncDecl => s.kind === "FuncDecl");
  // method 선언(MethodDecl)도 UDF와 동일하게 항상 프리앰블에 생성한다(genMethodDecl) — mangled
  // top-level 함수라는 점만 다르고 나머지(ctx당 1회, per-bar 재생성 없음) 이유는 FuncDecl과 동일.
  const methodDecls = program.script.body.filter((s): s is MethodDecl => s.kind === "MethodDecl");
  // enum 선언(EnumDecl)은 순수 컴파일타임 구성물이라 type/UDF와 달리 프리앰블에도 아무것도
  // 방출하지 않는다 — 멤버 접근이 analyzer 단계에서 이미 리터럴 문자열로 완전히 접혀서(DotAccess
  // builtinStringConstants) codegen이 볼 시점엔 원래의 EnumDecl 참조가 하나도 남아있지 않다.
  const others = program.script.body.filter(
    (s) => s.kind !== "FuncDecl" && s.kind !== "TypeDecl" && s.kind !== "EnumDecl" && s.kind !== "MethodDecl",
  );

  // UDF 본문이 클로저로 붙잡는 top-level '=' 로컬은 per-bar 함수 안의 `var`로 두면 프리앰블
  // 스코프의 UDF에서 보이지 않는다(클로저는 바깥→안 방향만) — 그런 이름만 프리앰블에 `var name;`으로
  // 선언해 UDF와 per-bar 함수가 같은 바인딩을 공유하게 하고, per-bar 함수는 매 바 맨몸 대입으로
  // 재초기화한다. analyzer가 선언-후-사용을 강제하므로(그리고 그 이름을 읽는 UDF는 반드시 그 선언
  // 뒤에 선언되므로) 어떤 읽기도 그 바의 대입보다 먼저 올 수 없다 — 이전 바 값이 새는 경로 없음.
  // method 본문도 UDF와 동일한 캡처 위험이 있어(둘 다 프리앰블의 top-level 함수) funcDecls와
  // 합쳐서 검사한다(collectPreambleLocals는 params/body 모양만 보므로 타입 무관하게 재사용 가능).
  const promoted = collectPreambleLocals([...funcDecls, ...methodDecls], others);

  const lines: string[] = [];
  for (const td of typeDecls) lines.push(genTypeDecl(td, program));
  for (const fd of funcDecls) lines.push(genFuncDecl(fd, program));
  for (const md of methodDecls) lines.push(genMethodDecl(md, program));
  for (const name of promoted) lines.push(`var ${safeLocalName(name)};`);
  // strategy() default_qty_value/pyramiding(C164) + initial_capital(C165) 메타데이터 — 지시어
  // 문장 자체는 여전히 no-op이지만 이 값들만 프리앰블(ctx당 1회 실행)에서 브로커 상태로 주입한다
  // (엔진 run()/Context 시그니처 변경 0). 전부 미지정이면 configure 방출 자체를 생략하고,
  // initial_capital만 미지정이면 세 번째 인자를 생략(StrategyState 기본 파라미터 100000)해
  // C164까지의 기존 입력 패턴 출력이 한 글자도 안 바뀐다(C129 "지정된 가장 뒤쪽 슬롯까지만 방출").
  if (
    program.strategyDefaultQty !== null ||
    program.strategyPyramiding !== null ||
    program.strategyInitialCapital !== null ||
    program.strategyQtyIsPercent ||
    program.strategyQtyIsCash
  ) {
    // default_qty_type=percent_of_equity(C171)/cash(C330)는 각각 네 번째/다섯 번째 슬롯 — 지정되면
    // 그 앞의 슬롯들도 기본값으로 채워 방출한다(C129 "지정된 가장 뒤쪽 슬롯까지만 방출" — 둘 다
    // 미지정 스크립트의 기존 출력은 한 글자도 안 바뀜). 두 플래그는 call-expr.ts의 if/else-if
    // 구조상 상호 배타이므로 cash일 때 percent 슬롯은 항상 명시적 false로 채운다.
    const capArg =
      program.strategyInitialCapital !== null || program.strategyQtyIsPercent || program.strategyQtyIsCash
        ? `, ${program.strategyInitialCapital ?? 100000}`
        : "";
    const tailArgs = program.strategyQtyIsCash ? ", false, true" : program.strategyQtyIsPercent ? ", true" : "";
    lines.push(
      `$.strategy.configure(${program.strategyDefaultQty ?? 1}, ${program.strategyPyramiding ?? 1}${capArg}${tailArgs});`,
    );
  }
  // viz S1 — 동적 plot 색 채널 preallocate(ctx당 1회). 슬롯 수를 생성 코드 자신이 나르므로
  // Context/run의 positional 시그니처는 그대로다(viz S0 결정). 동적 색이 없는 스크립트는
  // 아무것도 방출하지 않아 기존 출력이 한 글자도 안 바뀐다(C129 원칙).
  if (program.plotColorSlotCount > 0) {
    lines.push(`$.initPlotColors(${program.plotColorSlotCount});`);
  }
  // viz S3 — 마커 계열 수치/조건 채널 preallocate. initPlotColors와 동일 원칙.
  if (program.vizSeriesSlotCount > 0) {
    lines.push(`$.initVizSeries(${program.vizSeriesSlotCount});`);
  }
  // request.security 셋째 슬라이스 3b(ROADMAP [hard->분할], C181) — securityExprCallSlots(3a)
  // 콜사이트마다 HTF 프리패스 함수를 프리앰블에 심는다. UDF/type/method 선언과 동일 층(ctx당 1회
  // 실행)에 두는 이유도 동일(GOAL.md "bar loop 안 할당 제로") — 결과 Float64Array는 바 루프
  // 시작 전에 한 번만 계산되면 충분하다. 스크립트에 이 패턴이 없으면(대다수) 빈 배열이라 lines에
  // 아무것도 추가하지 않아 기존 출력이 한 글자도 안 바뀐다.
  // request.security 컴파일타임 상수 전파 가드(C366, C707부터 tf 전용→gaps/lookahead 겸용) —
  // tf/gaps/lookahead가 input.* 상수 변수에서 폴딩된 경우, 그 폴딩값은 트랜스파일 시점의 defval로
  // codegen에 리터럴로 이미 굳어 있으므로(tf는 HTF 집계 캐시 구조, gaps/lookahead는 rt.security.get
  // 호출부 리터럴 인자 — analyzer securityTfConstGuards 주석 참조) 런타임 입력 오버라이드($.inputs)가
  // 다른 값을 주면 변수값과 실제 굳은 값이 어긋나는 조용한 오답이 된다 — 프리앰블(ctx당 1회)에서
  // 같은 input 콜을 재평가해 불일치 시 즉시 throw로 전환한다. genExpr 재사용이라 per-bar 대입문이
  // 계산하는 값과 바이트 단위로 같은 식이 방출됨. 리터럴/timeframe.period 출처 상수는 런타임에
  // 변할 수 없어 애초에 가드 대상이 아니다. 스크립트에 이 패턴이 없으면 기존 출력 무변화.
  for (const [name, guard] of program.securityTfConstGuards) {
    lines.push(
      `if (${genExpr(guard.inputCall, program, null)} !== ${JSON.stringify(guard.literal)}) throw new Error(${JSON.stringify(
        `request.security의 입력 '${name}'은 트랜스파일 시점에 '${guard.literal}'로 고정됨 — 입력 오버라이드로 값 변경 불가(request.security의 HTF 관련 인자는 컴파일타임 확정)`,
      )});`,
    );
  }
  // request.security 배치31 (a, C597) — securityRuntimeTfSlots(analyzer 주석 참조)에 등록된
  // 슬롯마다 tf 식을 정확히 1회 evaluate해 Context 생성자가 자리표시(chartTf)로 미리 채워둔
  // $.securityCache[slot]을 실제 값으로 다시 빌드한다. 반드시 바 루프 시작 전(이 지점)에서 끝나야
  // securityExprCallSlots 프리패스(위 3b, 바로 아래)와 바 루프 본문이 항상 최종 값을 읽는다.
  // 스크립트에 이 패턴이 없으면(대다수) 빈 맵이라 기존 출력 무변화.
  for (const [slot, tfExpr] of program.securityRuntimeTfSlots) {
    lines.push(`$.rebuildSecurityCache(${slot}, ${genExpr(tfExpr, program, null)});`);
  }
  for (const line of generateSecurityExprPreamble(program)) lines.push(line);
  lines.push("return function () {");
  for (const stmt of others) {
    const line = genStmt(stmt, program, /* nested */ false, /* funcCtx */ null, promoted);
    if (line) lines.push(line);
  }
  // 히스토리 참조가 있는 top-level var마다, 이 바의 모든 문장이 실행을 마친 뒤 그 최종 값을
  // $.histSlots[]에 기록한다(analyzer의 analyzeIndexAccess 주석 참조) — 다음 바의 x[1]이 정확히
  // "이 바가 끝난 시점의 x 값"을 읽도록 하는 지점은 여기 단 한 곳뿐이다.
  for (const [varSlot, histIdx] of program.historySlots) {
    lines.push(`$.histSlots[${histIdx}].record($.vars[${varSlot}]);`);
  }
  // strategy.<prop>[N](C339) — 같은 지점, 같은 $.histSlots[] 배열의 다른 슬롯 구간(varSlot 기반이
  // 아니라 propName 기반). record 인자는 var 슬롯 조회가 아니라 STRATEGY_RUNTIME_PROPS의 JS 식
  // 문자열 그대로(analyzer가 이 슬롯을 배정한 시점에 이미 builtinRuntimeExprs 등록/isStrategy
  // 검증을 마쳤으므로 여기선 조회만 한다).
  for (const [propName, histIdx] of program.strategyPropHistorySlots) {
    lines.push(`$.histSlots[${histIdx}].record(${STRATEGY_RUNTIME_PROPS.get(propName)});`);
  }
  // top-level '=' 로컬 히스토리(C363, ROADMAP P4 "wild 최우선 [hard]: 로컬 히스토리" (a)슬라이스) —
  // 같은 지점, 같은 $.histSlots[] 배열의 또 다른 슬롯 구간(이번엔 이름 문자열이 키). var와 완전히
  // 같은 타이밍(바의 모든 top-level 문장이 끝난 뒤 최종값 기록)이지만, '=' 로컬은 $.vars[] 슬롯이
  // 없어(GOAL.md 설계상 JS bare `var name`으로 컴파일) safeLocalName(name)을 직접 참조한다.
  for (const [name, histIdx] of program.localHistorySlots) {
    lines.push(`$.histSlots[${histIdx}].record(${safeLocalName(name)});`);
  }
  // drawing 핸들 top-level '=' 로컬 히스토리(배치25 (1)) — 같은 타이밍(바-종료), 별도 물리 배열
  // ($.refHistSlots, series.ts RefSeries — Float64Array가 아니라 object 원형 버퍼).
  for (const [name, refHistIdx] of program.refHistorySlots) {
    lines.push(`$.refHistSlots[${refHistIdx}].record(${safeLocalName(name)});`);
  }
  // UDT 타입 top-level var 히스토리(C637, `(recv[N]).field`류) — 같은 물리 배열($.refHistSlots)의
  // 또 다른 슬롯 구간이지만, var/varip는 $.vars[slot]에 저장되므로(historySlots와 동일 원칙)
  // 이름이 아니라 슬롯 번호로 값을 읽는다.
  for (const [varSlot, refHistIdx] of program.varRefHistorySlots) {
    lines.push(`$.refHistSlots[${refHistIdx}].record($.vars[${varSlot}]);`);
  }
  // UDT 인스턴스 스칼라 필드 히스토리(C523) — 같은 지점, 같은 $.histSlots[] 배열의 또 다른 슬롯
  // 구간(키는 "수신자이름.필드이름"). 수신자가 na(null/undefined)인 바는 `?.`가 undefined를 내고
  // Float64Array 강제변환(ToNumber(undefined)=NaN)이 na로 기록한다 — 이 무조건 record 루프가
  // na-가드된 스크립트(`if not na(s)` 안에서만 필드를 읽는 폼)에서도 크래시하지 않기 위한 유일한
  // 가드 지점. 수신자는 analyzer가 top-level var($.vars 슬롯)/depth-0 '=' 로컬(JS var)로 한정해뒀다.
  for (const [key, histIdx] of program.udtFieldHistorySlots) {
    const dot = key.indexOf(".");
    const recvName = key.slice(0, dot);
    const attr = key.slice(dot + 1);
    const recvSlot = program.varIndex.get(recvName);
    const recvJS = recvSlot !== undefined ? `$.vars[${recvSlot}]` : safeLocalName(recvName);
    lines.push(`$.histSlots[${histIdx}].record(${recvJS}?.${attr});`);
  }
  // drawing 핸들 타입 UDT 필드 히스토리(C718) — 같은 타이밍, 별도 물리 배열($.refHistSlots, RefSeries
  // — record()가 자체적으로 `?? null` 정규화하므로 undefined 수신자도 na(null) 그대로 안전).
  for (const [key, refHistIdx] of program.udtFieldRefHistorySlots) {
    const dot = key.indexOf(".");
    const recvName = key.slice(0, dot);
    const attr = key.slice(dot + 1);
    const recvSlot = program.varIndex.get(recvName);
    const recvJS = recvSlot !== undefined ? `$.vars[${recvSlot}]` : safeLocalName(recvName);
    lines.push(`$.refHistSlots[${refHistIdx}].record(${recvJS}?.${attr});`);
  }
  // UDF 함수-내부 var 히스토리(C364, ROADMAP 🔴🔴 (b)슬라이스 — FuncInfo.localHistKinds "var") —
  // 같은 지점, 콜사이트별 절대 인덱스 쌍(analyzer allocateFuncHistSlots가 사전 계산). param/'='
  // 로컬과 달리 var는 함수 밖($.fnVars)에서 값이 살아 있고 호출 안 된 바에도 변하지 않으므로,
  // 이 바-종료 기록이 "이전 실행의 최종값"과 항상 일치한다(TV per-call 압축 히스토리와 등가 —
  // index-access.ts 주석 참조). 첫 호출 전($.fnVars undefined)은 record(undefined)→NaN이라 na 정합.
  for (const { histIdx, fnVarIdx } of program.funcHistVarRecords) {
    lines.push(`$.histSlots[${histIdx}].record($.fnVars[${fnVarIdx}]);`);
  }
  // UDF 함수-내부 var drawing 핸들 히스토리(C541) — 바로 위 funcHistVarRecords의 $.refHistSlots 판
  // (참조를 그대로 기록). 첫 호출 전($.fnVars undefined)은 RefSeries.record의 `?? null` 정규화로
  // na(null) 정합(series.ts 참조).
  for (const { refHistIdx, fnVarIdx } of program.funcRefHistVarRecords) {
    lines.push(`$.refHistSlots[${refHistIdx}].record($.fnVars[${fnVarIdx}]);`);
  }
  lines.push("};");
  return lines.join("\n");
}

// request.security 셋째 슬라이스 서브슬라이스 3b(ROADMAP [hard->분할], 상세 설계는 C179/C180) —
// securityExprCallSlots(3a)에 등록된 콜사이트마다 HTF 프리패스 함수(`__secExprN`)를 생성한다.
// 콜사이트가 표시해둔 ta.* 콜(analyzeStatefulCall로 이미 정식 등록 — $.taSlots[slot] state는
// 메인 타임프레임의 다른 ta.* 콜과 동일한 전역 풀에서 물리적으로 분리됨, C180 확인)을 HTF 캐시의
// 각 행(h=0..cache.close.length-1)에 대해 한 번씩 순서대로 재실행해, 그 함수 자신의 incremental
// 상태가 "HTF 바 단위 시퀀스"를 따라 전진하게 한다 — pine2py처럼 차트 타임프레임 기준 단발
// eager 평가(GOAL.md 대상 버그, ROADMAP 참조)가 아니라 진짜 재실행. cacheVar/loopVar 이름은
// genBarRef가 그대로 조립에 쓰므로 아래 리터럴과 반드시 일치해야 한다.
//
// export 이유: generateCode()는 아직 request.security(...) 호출 자신을 codegen하지 못한다(3c의
// 몫 — genCallExpr 맨 끝 안전장치 throw가 그대로 걸린다, PROGRESS.md C180/C181 참조) — 이 콜이
// 소스 어딘가에 등장하는 한 generateCode() 전체가 여전히 던지므로, 이 프리패스 생성 자체를
// 독립적으로(전체 스크립트 codegen 없이) 검증하려면 별도 진입점이 필요하다.
export function generateSecurityExprPreamble(program: AnalyzedProgram): string[] {
  const lines: string[] = [];
  // C453: udf-param 다중 콜사이트 프리패스(securityParamExprPrepasses — 노드 키가 없는 배열이라
  // 맵과 별도, 값 구조는 동일)도 같은 방출 로직을 그대로 탄다. 순회 순서는 슬롯 번호와 무관하게
  // 안전하다 — 각 프리패스 함수가 자기 슬롯만 읽고 쓴다.
  for (const info of [...program.securityExprCallSlots.values(), ...program.securityParamExprPrepasses]) {
    const fnName = `__secExpr${info.slot}`;
    // C370 hist-on-expr: histReads(안쪽 서브식 먼저 순서)의 배열 인덱스가 곧 버퍼 인덱스 —
    // 콜사이트마다 프리패스 함수가 독립이라 secCtx도 콜사이트별로 새로 만든다(버퍼 맵 격리).
    const histBufs = new Map<Expr, number>();
    info.histReads.forEach((hr, i) => histBufs.set(hr.node, i));
    // C738: var 슬라이스 — closure var마다 함수 스코프 로컬(__svN, 행을 넘어 상태 유지)을 배정.
    let sliceLocals: Map<string, string> | undefined;
    if (info.varSlice !== null) {
      sliceLocals = new Map();
      info.varSlice.varNames.forEach((n, i) => sliceLocals!.set(n, `__sv${i}`));
    }
    const secCtx: SecurityExprGenContext = { cacheVar: "cache", loopVar: "h", histBufs, sliceLocals };
    // fill 문: 행마다 서브식을 정확히 1회 평가해 버퍼에 기록(ta 상태 전진과 히스토리 기록이 이
    // 한 지점에서 동시에 일어남 — bodyExpr 안의 해당 IndexAccess 노드는 genIndexAccess가 버퍼
    // 읽기로 치환하므로 서브식이 본식에서 이중 평가되지 않는다). 중첩 히스토리는 안쪽 버퍼가 앞
    // 인덱스라 fill이 항상 이미 채워진(같은 행) 앞 버퍼만 읽는다.
    const fillLines = info.histReads.map(
      (hr, i) => `${secHistBufName(i)}[${secCtx.loopVar}] = ${genExpr(hr.obj, program, null, secCtx)};`,
    );
    // C738: 슬라이스 항목(선언 h===0 게이트 + 갱신 문장, 소스 라인 오름차순) — fill 뒤·out 대입
    // 앞에 방출한다. fill 서브식은 closure 참조가 금지돼(analyzer IndexAccess 가드) 순서 무관,
    // out(샘플)은 모든 갱신 뒤 = 콜 위치가 모든 갱신 문장보다 소스에서 뒤라는 analyzer 검증과 일치.
    const sliceLines: string[] = [];
    if (info.varSlice !== null) {
      for (const item of info.varSlice.items) {
        if (item.kind === "init") {
          sliceLines.push(
            `if (${secCtx.loopVar} === 0) { ${sliceLocals!.get(item.name)!} = ${genExpr(item.value, program, null, secCtx)}; }`,
          );
        } else {
          genSecuritySliceStmt(item.stmt, program, secCtx, sliceLines);
        }
      }
    }
    const bodyCode = genExpr(info.bodyExpr, program, null, secCtx);
    lines.push(`function ${fnName}() {`, `const ${secCtx.cacheVar} = $.securityCache[${info.slot}];`);
    lines.push(`const out = new Float64Array(${secCtx.cacheVar}.close.length);`);
    // 히스토리 버퍼는 프리패스 함수 로컬 Float64Array — 바 루프 밖 1회 할당(GOAL.md 무저촉).
    for (let i = 0; i < info.histReads.length; i++) {
      lines.push(`const ${secHistBufName(i)} = new Float64Array(out.length);`);
    }
    if (info.varSlice !== null) {
      for (const n of info.varSlice.varNames) lines.push(`let ${sliceLocals!.get(n)!} = NaN;`);
    }
    lines.push(
      `for (let ${secCtx.loopVar} = 0; ${secCtx.loopVar} < out.length; ${secCtx.loopVar}++) {`,
      `const open = ${secCtx.cacheVar}.open[${secCtx.loopVar}], high = ${secCtx.cacheVar}.high[${secCtx.loopVar}], low = ${secCtx.cacheVar}.low[${secCtx.loopVar}], close = ${secCtx.cacheVar}.close[${secCtx.loopVar}], volume = ${secCtx.cacheVar}.volume[${secCtx.loopVar}];`,
      ...fillLines,
      ...sliceLines,
      `out[${secCtx.loopVar}] = ${bodyCode};`,
      `}`,
      `return out;`,
      `}`,
      `$.securityExprCache[${info.slot}] = ${fnName}();`,
    );
  }
  return lines;
}

// C738: var 슬라이스 문장 방출 — Pine if 시맨틱과 JS if가 정확히 동형(조건 na→NaN falsy = 본문
// 스킵, elif는 앞 조건 거짓일 때만 평가)이라 구조 그대로 옮긴다. 값/조건은 이미 analyzer가 빌드한
// 트리라 genExpr(secCtx)만 필요.
function genSecuritySliceStmt(
  stmt: SecurityVarSliceStmt,
  program: AnalyzedProgram,
  secCtx: SecurityExprGenContext,
  out: string[],
): void {
  if (stmt.kind === "assign") {
    out.push(`${secCtx.sliceLocals!.get(stmt.name)!} = ${genExpr(stmt.value, program, null, secCtx)};`);
    return;
  }
  out.push(`if (${genExpr(stmt.cond, program, null, secCtx)}) {`);
  for (const s of stmt.then) genSecuritySliceStmt(s, program, secCtx, out);
  for (const e of stmt.elifs) {
    out.push(`} else if (${genExpr(e.cond, program, null, secCtx)}) {`);
    for (const s of e.body) genSecuritySliceStmt(s, program, secCtx, out);
  }
  if (stmt.els !== null) {
    out.push(`} else {`);
    for (const s of stmt.els) genSecuritySliceStmt(s, program, secCtx, out);
  }
  out.push(`}`);
}

// 프리앰블로 승격할 top-level '=' 로컬(튜플 디스트럭처링 대상 포함) 이름 집합을 계산한다.
// 수집은 의도적으로 과대추정이다: UDF 서브트리(매개변수 기본값 + 본문)에 등장하는 모든 이름을
// 모은 뒤 top-level '=' 이름과의 교집합만 승격한다 — UDF 자신의 매개변수/로컬과 이름이 겹쳐
// 실제로는 전역을 안 읽는 경우도 승격되지만, 승격된 이름의 시맨틱은 승격 전과 완전히 동일하다
// (프리앰블 `var name;` + 매 바 무조건 재대입 = 매 바 `var name = ...` — 값이 바를 넘어 읽히려면
// 그 바의 대입보다 먼저 읽어야 하는데 analyzer의 선언-후-사용 규칙이 그 경로를 막는다). 반대로
// 과소추정은 UDF 호출 시 ReferenceError이므로, 정밀한 스코프 재구성 대신 안전한 쪽을 택했다.
function collectPreambleLocals(funcDecls: (FuncDecl | MethodDecl)[], others: Stmt[]): Set<string> {
  const promoted = new Set<string>();
  if (funcDecls.length === 0) return promoted;
  const captured = new Set<string>();
  for (const fd of funcDecls) {
    for (const p of fd.params) {
      if (p.default !== null) collectNamesInExpr(p.default, captured);
    }
    for (const s of fd.body) collectNamesInStmt(s, captured);
  }
  for (const stmt of others) {
    if (stmt.kind === "Assignment" && stmt.operator === "=" && captured.has(stmt.name)) {
      promoted.add(stmt.name);
    } else if (stmt.kind === "TupleDestructure" && stmt.names.some((n) => captured.has(n))) {
      // 튜플은 이름 단위로 쪼갤 수 없다(맨몸 `[a, b] = ...`는 모든 대상이 선언돼 있어야 암묵
      // 전역 생성이 없다) — 하나라도 캡처됐으면 그 튜플의 모든 이름을 함께 승격한다.
      for (const n of stmt.names) promoted.add(n);
    }
  }
  return promoted;
}

// AST 서브트리의 모든 이름 수집(collectPreambleLocals 전용). ast.ts의 Stmt/Expr 유니온을 전수
// switch로 다뤄 노드가 추가되면 컴파일 에러로 이 워커의 갱신을 강제한다.
function collectNamesInStmt(stmt: Stmt, out: Set<string>): void {
  switch (stmt.kind) {
    case "VarDecl":
      collectNamesInExpr(stmt.value, out);
      return;
    case "Assignment":
      out.add(stmt.name);
      collectNamesInExpr(stmt.value, out);
      return;
    case "ExprStmt":
      collectNamesInExpr(stmt.expr, out);
      return;
    case "IfStmt":
    case "ForStmt":
    case "WhileStmt":
    case "SwitchStmt":
      // Expr 유니온에도 속하는 노드 — 식 워커 한 곳에서 처리
      collectNamesInExpr(stmt, out);
      return;
    case "ForInStmt":
      // ForStmt와 달리 Expr 유니온에 없어 collectNamesInExpr로 위임 못 함(C215 ast.ts 주석 참조) —
      // 이 case가 실제 프리앰블 승격 수집 경로다(C216부터 analyzer가 통과시킴).
      out.add(stmt.varName);
      if (stmt.indexName !== null) out.add(stmt.indexName);
      collectNamesInExpr(stmt.iterable, out);
      for (const s of stmt.body) collectNamesInStmt(s, out);
      return;
    case "BreakStmt":
    case "ContinueStmt":
      return;
    case "FuncDecl":
    case "MethodDecl":
    case "TypeDecl":
    case "EnumDecl":
      // 중첩 FuncDecl/MethodDecl/TypeDecl/EnumDecl은 analyzer가 에러로 막음(scope.depth!==0에서
      // 거부, 도달 불가) — 수집할 것 없음
      return;
    case "TupleDestructure":
      for (const n of stmt.names) out.add(n);
      collectNamesInExpr(stmt.value, out);
      return;
    case "FieldAssignment":
      // `obj.field := value`가 UDF/method 본문 안에 있으면 object/value 양쪽에 top-level '='
      // 로컬 참조가 등장할 수 있다(C197에서 발견 — 이 case 누락으로 그 이름이 프리앰블 승격
      // 대상에서 빠져 ReferenceError가 발생했다).
      collectNamesInExpr(stmt.object, out);
      collectNamesInExpr(stmt.value, out);
      return;
  }
}

function collectNamesInExpr(expr: Expr, out: Set<string>): void {
  switch (expr.kind) {
    case "NumberLiteral":
    case "StringLiteral":
    case "BoolLiteral":
    case "NaLiteral":
    case "ColorLiteral":
      return;
    case "Identifier":
      out.add(expr.name);
      return;
    case "UnaryOp":
      collectNamesInExpr(expr.operand, out);
      return;
    case "BinOp":
      collectNamesInExpr(expr.left, out);
      collectNamesInExpr(expr.right, out);
      return;
    case "TernaryOp":
      collectNamesInExpr(expr.condition, out);
      collectNamesInExpr(expr.trueExpr, out);
      collectNamesInExpr(expr.falseExpr, out);
      return;
    case "CallExpr":
      collectNamesInExpr(expr.callee, out);
      for (const a of expr.args) collectNamesInExpr(a, out);
      for (const kw of expr.kwargs) collectNamesInExpr(kw.value, out);
      return;
    case "DotAccess":
      collectNamesInExpr(expr.obj, out);
      return;
    case "IndexAccess":
      collectNamesInExpr(expr.obj, out);
      collectNamesInExpr(expr.index, out);
      return;
    case "TupleExpr":
      for (const el of expr.elements) collectNamesInExpr(el, out);
      return;
    case "IfStmt":
      collectNamesInExpr(expr.condition, out);
      for (const s of expr.thenBody) collectNamesInStmt(s, out);
      for (const clause of expr.elifClauses) {
        collectNamesInExpr(clause.condition, out);
        for (const s of clause.body) collectNamesInStmt(s, out);
      }
      if (expr.elseBody !== null) for (const s of expr.elseBody) collectNamesInStmt(s, out);
      return;
    case "ForStmt":
      out.add(expr.varName);
      collectNamesInExpr(expr.start, out);
      collectNamesInExpr(expr.end, out);
      if (expr.step !== null) collectNamesInExpr(expr.step, out);
      for (const s of expr.body) collectNamesInStmt(s, out);
      return;
    case "WhileStmt":
      collectNamesInExpr(expr.condition, out);
      for (const s of expr.body) collectNamesInStmt(s, out);
      return;
    case "SwitchStmt":
      if (expr.subject !== null) collectNamesInExpr(expr.subject, out);
      for (const c of expr.cases) {
        if (c.values !== null) for (const v of c.values) collectNamesInExpr(v, out);
        for (const s of c.body) collectNamesInStmt(s, out);
      }
      return;
  }
}

// funcCtx.bodyLocalNames 계산(C568) — FuncInfo.eqLocalNames('=' 로컬)/histShadowedNames(동명
// 재선언이라 eqLocalNames 대신 여기로 갈라진 이름)/tupleEqLocalNames(튜플 디스트럭처 대상)의
// 합집합. 셋 다 "이 함수 본문 안(어느 깊이든) '=' 계열로 새로 선언된 이름"이라는 점은 같고,
// histShadowedNames로 갈라졌다고 top-level var 우선순위 버그에서 자유로운 건 아니므로 함께 합친다.
// nestedEqLocalNames/nestedHistShadowedNames(C714 UDF 확장, 중첩 블록 노드-키잉 축)도 동일하게
// "'=' 계열로 새로 선언된 이름"이므로 함께 합친다 — 빠지면 그 이름만 이 우선순위 가드에서 새
// top-level var 동명 충돌 버그(C568)가 재발한다.
function funcBodyLocalNames(func: {
  eqLocalNames: ReadonlySet<string>;
  histShadowedNames: ReadonlySet<string>;
  tupleEqLocalNames: ReadonlySet<string>;
  nestedEqLocalNames: ReadonlySet<string>;
  nestedHistShadowedNames: ReadonlySet<string>;
}): ReadonlySet<string> {
  return new Set([
    ...func.eqLocalNames,
    ...func.histShadowedNames,
    ...func.tupleEqLocalNames,
    ...func.nestedEqLocalNames,
    ...func.nestedHistShadowedNames,
  ]);
}

// UDF 함수 선언: function <name>(__slotBase, p0, p1, ...) { ... }.
// $/rt는 별도 파라미터로 받지 않고 바깥 `new Function('$','rt',code)` 스코프를 클로저로 그대로
// 참조한다(모든 UDF가 프리앰블에 top-level로 같이 생성되므로 자연스러운 JS 함수-in-함수 스코프 —
// pine2py도 `def name(...):`을 pine_fn(ctx) 안에 중첩해 동일한 이유로 outer 지역 변수에 접근한다).
// 상태는 여전히 전부 $.fnVars[] 슬롯에 있으므로 "클로저 금지"(GOAL.md) 원칙이 막는 대상인
// "상태를 클로저 변수에 저장"에는 해당하지 않는다. 2-layer 전환(C27)으로 프리앰블은 ctx당 1회만
// 실행되므로 함수 객체가 매 바 재생성되던 기존 비용은 해소됐다.
function genFuncDecl(stmt: FuncDecl, program: AnalyzedProgram): string {
  const func = program.funcs.get(stmt.name);
  if (!func) throw new Error(`internal: FuncInfo missing for '${stmt.name}' (analyzer 통과 후 발생 불가)`);
  const paramNameSet = new Set(stmt.params.map((p) => p.name));
  const funcCtx: FuncGenContext = {
    localVarIndex: func.localVarIndex,
    paramNames: paramNameSet,
    bodyLocalNames: funcBodyLocalNames(func),
    paramUdtTypes: func.paramUdtTypes,
    localVarUdtTypes: func.localVarUdtTypes,
    localVarTypeHints: func.localVarTypeHints,
    localHistSlots: func.localHistSlots,
    localHistKinds: func.localHistKinds,
    localAmbiguousNestedHistDeclSlots: func.localAmbiguousNestedHistDeclSlots,
    localAmbiguousNestedHistReadSlots: func.localAmbiguousNestedHistReadSlots,
    localAmbiguousNestedRefDeclSlots: func.localAmbiguousNestedRefDeclSlots,
    localAmbiguousNestedRefReadSlots: func.localAmbiguousNestedRefReadSlots,
    localRefHistSlots: func.localRefHistSlots,
    localRefHistKinds: func.localRefHistKinds,
    localCallHistSlots: func.localCallHistSlots,
    localCondCallHistSlots: func.localCondCallHistSlots,
    localCondCallRefHistSlots: func.localCondCallRefHistSlots,
    localFieldHistSlots: func.localFieldHistSlots,
    localFieldRefHistSlots: func.localFieldRefHistSlots,
  };
  // 기본값 표현식은 함수 자신의 로컬 슬롯이 아니라 선언 시점(top-level) 스코프에서 codegen한다
  // (analyzeFuncDecl이 p.default를 top-level scope로 analyze한 것과 대응 — funcCtx=null).
  const paramsCode = stmt.params.map((p) => genFuncParam(p, program)).join(", ");
  // 본문에 stateful 콜(C162)이 있을 때만 __taBase, 함수-내부 히스토리(C364)가 있을 때만 __histBase
  // 파라미터를 추가한다 — 없는 함수의 시그니처는 기존과 한 글자도 달라지지 않는다
  // (analyzeUserFuncCall의 funcTaBases/funcHistBases 조건부 등록과 짝).
  const baseParams = genBaseParams(func);
  const paramList = paramsCode.length > 0 ? `${baseParams}, ${paramsCode}` : baseParams;
  const bodyCode = genFuncBody(stmt.body, program, funcCtx, paramNameSet);
  // 매개변수 히스토리(C364, localHistKinds "param")는 함수 진입 직후 1회 record — Pine 매개변수는
  // 본문에서 ':=' 재대입이 불가라 진입 시점 값이 곧 이 호출의 확정값이다(같은 바 다중 호출은
  // Series.record 현재 바 커서 덮어쓰기로 마지막 호출 값 — ROADMAP (b) 설계 그대로).
  const entryRecords = genParamHistRecords(func);
  // UDF 이름 자체가 JS 예약어(예: "function")면 `function function(...)`은 항상 SyntaxError다
  // (C319 corpus invalid_js — program.locals 대상인 매개변수/'=' 로컬과 달리 함수 선언 이름은
  // safeLocalName의 기존 8개 적용 지점에 없었던 갭). method는 mangleMethodName이 "TypeName$name"
  // 으로 결합해 "$"가 낀 문자열이 예약어 자체가 될 수 없어(genMethodDecl) 해당 없음 — 순수 UDF
  // (mangle 없이 raw 이름을 그대로 JS 식별자로 쓰는) 선언 자리만 이 치환이 필요하다. funcCodegenName이
  // safeLocalName을 감싸므로(C413) top-level '=' 로컬과 이름이 겹치는 함수는 여기서 함께 mangle된다.
  return `function ${funcCodegenName(stmt.name, program)}(${paramList}) {\n${entryRecords}${bodyCode}\n}`;
}

// __slotBase 뒤에 __taBase(C162)/__histBase(C364)/__secIdx(C453)를 각각 해당 카운트/플래그가
// 있을 때만 덧붙인다 — genCallExpr의 콜사이트 인자 방출(funcTaBases/funcHistBases/funcSecIdxArgs
// 조건부 조회)과 항상 짝이 맞는다. __secIdx는 베이스가 아니라 "이 호출이 몇 번째 콜사이트에서
// 왔는가"(0-based 서수) — body의 udf-param request.security가 `$.securityExprCache[base + __secIdx]`
// 로 콜사이트별 독립 HTF 프리패스 슬롯을 읽는다(FuncInfo.hasSecParamCalls 주석 참조).
function genBaseParams(func: {
  localTaSlotCount: number;
  localHistSlotCount: number;
  localRefHistSlotCount: number;
  localCondHistSlotCount: number;
  localCondRefHistSlotCount: number;
  hasSecParamCalls: boolean;
}): string {
  let base = "__slotBase";
  if (func.localTaSlotCount > 0) base += ", __taBase";
  if (func.localHistSlotCount > 0) base += ", __histBase";
  if (func.localRefHistSlotCount > 0) base += ", __refHistBase";
  if (func.localCondHistSlotCount > 0) base += ", __condHistBase";
  if (func.localCondRefHistSlotCount > 0) base += ", __condRefHistBase";
  if (func.hasSecParamCalls) base += ", __secIdx";
  return base;
}

function genParamHistRecords(func: {
  localHistSlots: Map<string, number>;
  localHistKinds: Map<string, "param" | "local" | "var">;
  localFieldHistSlots: Map<string, number>;
  localFieldRefHistSlots: Map<string, number>;
  localRefHistSlots: Map<string, number>;
  localRefHistKinds: Map<string, "local" | "var" | "param">;
}): string {
  const lines: string[] = [];
  for (const [name, relIdx] of func.localHistSlots) {
    if (func.localHistKinds.get(name) !== "param") continue;
    lines.push(`$.histSlots[__histBase + ${relIdx}].record(${safeLocalName(name)});`);
  }
  // 매개변수(UDT) 필드 히스토리(C750) — 키 "매개변수이름.필드이름"을 첫 '.'에서 분리(매개변수
  // 이름은 '.'을 포함할 수 없어 안전). receiver는 항상 매개변수라 위 name 루프와 동일하게 함수
  // 진입 직후 1회 record.
  for (const [key, relIdx] of func.localFieldHistSlots) {
    const dotIdx = key.indexOf(".");
    const paramName = key.slice(0, dotIdx);
    const attr = key.slice(dotIdx + 1);
    lines.push(`$.histSlots[__histBase + ${relIdx}].record(${safeLocalName(paramName)}.${attr});`);
  }
  for (const [key, relIdx] of func.localFieldRefHistSlots) {
    const dotIdx = key.indexOf(".");
    const paramName = key.slice(0, dotIdx);
    const attr = key.slice(dotIdx + 1);
    lines.push(`$.refHistSlots[__refHistBase + ${relIdx}].record(${safeLocalName(paramName)}.${attr});`);
  }
  // 매개변수(UDT/drawing 핸들/string) 자신 전체의 히스토리(C751) — localRefHistKinds "param"만
  // 골라 함수 진입 직후 1회 record(위 localHistSlots "param" 루프와 동일 타이밍, 물리 배열만 분리).
  for (const [name, relIdx] of func.localRefHistSlots) {
    if (func.localRefHistKinds.get(name) !== "param") continue;
    lines.push(`$.refHistSlots[__refHistBase + ${relIdx}].record(${safeLocalName(name)});`);
  }
  return lines.length > 0 ? lines.join("\n") + "\n" : "";
}

// method name(params) => body -> mangled top-level 함수(genFuncDecl과 동일 구조이나 이름이
// TypeName$methodName이다, analyzer.ts mangleMethodName 참조). 첫 매개변수의 typeHint가 analyzer
// 검증을 통과했으므로(이미 등록된 UDT 타입명이거나 array<T>/map<K,V>/matrix<T> 컨테이너, C327)
// resolveMethodReceiverTypeName으로 analyzeMethodDecl과 동일한 typeName을 재계산한다(순수 함수
// 재사용 — 컨테이너 receiver는 raw typeHint 문자열("array<float>")이 아니라 base("array")로
// mangle돼야 analyzer가 등록해둔 FuncInfo 이름과 일치한다).
function genMethodDecl(stmt: MethodDecl, program: AnalyzedProgram): string {
  const typeName = resolveMethodReceiverTypeName(stmt.params[0]!.typeHint!, program)!;
  // C687: arity-disjoint 오버로드 선언은 analyzer가 `${base}$ov$k`로 등록했다 — 선언 노드별 확정
  // 이름 맵을 우선 조회(재계산만 쓰면 오버로드 선언들이 같은 JS 함수명으로 겹쳐 last-wins 오답).
  const mangledName = program.methodDeclMangledNames.get(stmt) ?? mangleMethodName(typeName, stmt.name);
  const func = program.funcs.get(mangledName);
  if (!func) throw new Error(`internal: FuncInfo missing for '${mangledName}' (analyzer 통과 후 발생 불가)`);
  const paramNameSet = new Set(stmt.params.map((p) => p.name));
  const funcCtx: FuncGenContext = {
    localVarIndex: func.localVarIndex,
    paramNames: paramNameSet,
    bodyLocalNames: funcBodyLocalNames(func),
    paramUdtTypes: func.paramUdtTypes,
    localVarUdtTypes: func.localVarUdtTypes,
    localVarTypeHints: func.localVarTypeHints,
    localHistSlots: func.localHistSlots,
    localHistKinds: func.localHistKinds,
    localAmbiguousNestedHistDeclSlots: func.localAmbiguousNestedHistDeclSlots,
    localAmbiguousNestedHistReadSlots: func.localAmbiguousNestedHistReadSlots,
    localAmbiguousNestedRefDeclSlots: func.localAmbiguousNestedRefDeclSlots,
    localAmbiguousNestedRefReadSlots: func.localAmbiguousNestedRefReadSlots,
    localRefHistSlots: func.localRefHistSlots,
    localRefHistKinds: func.localRefHistKinds,
    localCallHistSlots: func.localCallHistSlots,
    localCondCallHistSlots: func.localCondCallHistSlots,
    localCondCallRefHistSlots: func.localCondCallRefHistSlots,
    localFieldHistSlots: func.localFieldHistSlots,
    localFieldRefHistSlots: func.localFieldRefHistSlots,
  };
  const paramsCode = stmt.params.map((p) => genFuncParam(p, program)).join(", ");
  // __taBase/__histBase 조건부 추가는 genFuncDecl과 동일(C162/C364 — method 본문도 같은 메커니즘).
  const baseParams = genBaseParams(func);
  const paramList = paramsCode.length > 0 ? `${baseParams}, ${paramsCode}` : baseParams;
  const bodyCode = genFuncBody(stmt.body, program, funcCtx, paramNameSet);
  const entryRecords = genParamHistRecords(func);
  return `function ${mangledName}(${paramList}) {\n${entryRecords}${bodyCode}\n}`;
}

function genFuncParam(param: FuncParam, program: AnalyzedProgram): string {
  const name = safeLocalName(param.name);
  return param.default !== null ? `${name} = ${genExpr(param.default, program, null)}` : name;
}

// UDT 필드 생략 시 암시 기본값 — pine2py codegen._type_default(float/int/bool/str 리터럴) 그대로
// literal port(color도 str과 동일 취급, pine2py _pine_type_to_python이 둘 다 "str"로 매핑) —
// TV 실제 규칙은 이 세션에서 검증 불가(WebSearch 미승인, VERIFIED_SEMANTICS.md 근거 없음)라
// "TV 미검증 가설"로 DIVERGENCES.md 등재. 주의: string/color도 na(null)가 아니라 빈 문자열 ""이다
// (pine2py가 필드 기본값을 na로 두지 않는 자체 결정 — explicit `= na` 대입과는 다른 경로). 중첩
// UDT 필드(C123)는 이 표에 없다 — pine2py _type_default가 매핑에 없는 타입명(=UDT 타입명)엔
// "None"으로 떨어지는 것과 동일하게(codegen.py 소스 대조 확인) genUdtFieldDefault가 별도 분기.
const UDT_IMPLICIT_FIELD_DEFAULTS: Readonly<Record<string, string>> = {
  float: "0",
  int: "0",
  bool: "false",
  string: '""',
  color: '""',
};

// TypeField 기본값/obj.field := value 양쪽이 공유하는 na 리터럴 특수화 — genValueCode(var 전용)와
// 동일 원칙이나 UDT 필드는 var가 아니라 udtTypes 맵에 있어 별도 헬퍼로 분리했다(analyzer.ts
// isUdtReferenceFieldType 참조: string/color/중첩 UDT 필드의 na는 GOAL.md 참조형 규약대로 null,
// 그 외(float/int/bool)는 기존과 동일하게 genExpr의 범용 NaN).
function genUdtValueForFieldType(
  value: Expr,
  fieldTypeHint: string,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  if (isUdtReferenceFieldType(fieldTypeHint, program) && value.kind === "NaLiteral") return "null";
  return genExpr(value, program, funcCtx);
}

// type Name -> JS 팩토리 함수. 필드는 위치 파라미터(p0, p1, ...)로 받아 명시적 `field: pN`
// 객체 리터럴을 반환한다 — 필드 자체를 파라미터 이름으로 쓰면 JS 예약어 필드명(class 등)에서
// 파라미터 선언이 깨지지만, object 리터럴의 key/`.field` 프로퍼티 접근은 ES5+에서 예약어를
// 그대로 허용하므로 이 간접 한 단계로 그 문제 전체를 피한다. 각 파라미터의 JS 기본값이 그
// 필드의 기본값 표현식이라(생략 시 UDT_IMPLICIT_FIELD_DEFAULTS) `TypeName.new(a)`처럼 뒤쪽 인자를
// 생략해도 JS 기본 파라미터가 자연히 그 필드의 기본값으로 채운다(math.random C120과 동일 원칙 —
// "누락"과 "명시적 undefined 전달" 둘 다 기본값을 적용하는 JS 성질을 그대로 활용).
function genTypeDecl(stmt: TypeDecl, program: AnalyzedProgram): string {
  const params = stmt.fields.map((f, i) => `p${i} = ${genUdtFieldDefault(f, program)}`);
  const fieldEntries = stmt.fields.map((f, i) => `${JSON.stringify(f.name)}: p${i}`);
  return `function ${stmt.name}(${params.join(", ")}) {\n  return { ${fieldEntries.join(", ")} };\n}`;
}

function genUdtFieldDefault(field: TypeField, program: AnalyzedProgram): string {
  if (field.default !== null) return genUdtValueForFieldType(field.default, field.typeHint, program, null);
  // 중첩 UDT 필드(C123)/enum 필드(C273)/drawing 핸들 필드(C318, `line`/`label`/`box`/`table`/
  // `polyline`/`linefill`)는 UDT_IMPLICIT_FIELD_DEFAULTS 표에 없다 — pine2py
  // _pine_type_to_python이 이 타입명들도 매핑 없이(drawing 6종은 "object"로) 그대로 통과시키고
  // _type_default가 매핑 안 된 타입명에 떨어지는 "None"과 동일하게 null(GOAL.md 참조형 규약,
  // python 직접 실행으로 확인).
  if (
    program.udtTypes.has(field.typeHint) ||
    program.enumTypes.has(field.typeHint) ||
    DRAWING_ALL_NAMESPACES.has(field.typeHint) ||
    field.typeHint === CHART_POINT_FIELD_TYPE
  )
    return "null";
  // array<T>/map<K,V> 필드(C126)/matrix<T> 필드(C128)의 암시 기본값은 na가 아니라 빈 컨테이너 —
  // pine2py `field(default_factory=list/dict)`와 동치(mutable-default 공유 버그 회피 목적이었으나 JS
  // 기본 파라미터는 호출마다 새로 평가돼 그 문제가 구조적으로 없음, C123에서 이미 확인). matrix는
  // PineMatrix가 그냥 unknown[][]라 array와 동일한 빈 배열 `[]`이 0행 행렬로 그대로 유효(matrix.rows/
  // columns/elements_count가 빈 배열을 0/0/0으로 처리 — matrix.ts 소스 확인).
  const genericBase = udtGenericFieldBase(field.typeHint);
  if (genericBase === "array" || genericBase === "matrix") return "[]";
  if (genericBase === "map") return "new Map()";
  return UDT_IMPLICIT_FIELD_DEFAULTS[field.typeHint]!;
}

// "array<float>" -> "array", "map<string, float>" -> "map", 비-제네릭 타입힌트는 null.
function udtGenericFieldBase(typeHint: string): string | null {
  const idx = typeHint.indexOf("<");
  return idx === -1 ? null : typeHint.slice(0, idx);
}

// PineScript: 함수 본문의 마지막 문장이 반환값(암시 return). ExprStmt/IfStmt/SwitchStmt만
// return으로 변환하고, 그 외(마지막이 Assignment/VarDecl/루프 등)는 그냥 실행만 하고 undefined를
// 암시 반환한다 — pine2py _emit_implicit_return과 정확히 동일한 3-분기(_gen_func_decl 소스 대조).
function genFuncBody(body: Stmt[], program: AnalyzedProgram, funcCtx: FuncGenContext, paramNames: ReadonlySet<string>): string {
  // UDF 본문 전체(마지막 문장 포함)가 하나의 JS 함수 스코프라 findRedeclaredAssignments도 body
  // 전체(슬라이스 전)를 봐야 한다 — 마지막 문장 자신이 재선언인 경우(`f(x) => y = 1, y = 2`)도
  // genImplicitReturn의 폴백(line 597 방향)이 이 정보를 필요로 한다. paramNames로 매개변수와
  // 동명인 본문 최상위 재선언도 함께 잡는다(findRedeclaredAssignments seedNames 주석 참조).
  const redeclared = findRedeclaredAssignments(body, paramNames);
  const lines: string[] = [];
  for (const stmt of body.slice(0, -1)) {
    const line = genStmt(stmt, program, /* nested */ true, funcCtx, null, redeclared);
    if (line) lines.push(line);
  }
  const last = body[body.length - 1]!;
  // C530: security-튜플 반환(마지막 문장이 request.security(sym, tf, [e1, e2, ...]) — analyzer
  // analyzeFuncDecl의 동명 분기가 securityTupleCallSlots를 등록해뒀다). genExpr가 방출하는
  // comma-식($.taScratch[0..N-1] 순차 대입)을 문장으로 1회 실행한 뒤 스크래치를 배열 리터럴로
  // return한다 — 아래 bare-TupleExpr 분기와 동일한 "UDF 튜플 반환 = 배열 리터럴" 계약이라
  // 콜사이트(`[a, b] = f()`)는 일반 UDF 배열 구조분해 폴백을 무변경으로 재사용한다.
  const lastSecurityTuple =
    last.kind === "ExprStmt" && last.expr.kind === "CallExpr"
      ? program.securityTupleCallSlots.get(last.expr)
      : undefined;
  if (last.kind === "ExprStmt" && lastSecurityTuple !== undefined) {
    hoistLazyStatefulCalls(last.expr, program, funcCtx, lines);
    lines.push(`${genExpr(last.expr, program, funcCtx)};`);
    lines.push(`return [${lastSecurityTuple.fields.map((_, i) => `$.taScratch[${i}]`).join(", ")}];`);
    return lines.join("\n");
  }
  // C611: 마지막 문장이 request.security(sym, tf, tupleUdf(...)) bare UDF 콜(analyzer
  // analyzeFuncDecl의 동명 분기가 securityBareUdfCallSlots에 등록해뒀다) — genTupleDestructure의
  // C432 처리와 동일하게 바깥 request.security 노드를 완전히 무시하고 내부 UDF 콜을 곧장 return
  // 한다(내부 콜 자신이 "UDF 튜플 반환 = 배열 리터럴" 계약의 배열을 반환하므로 위 C530처럼
  // taScratch를 거칠 필요가 없다). HTF 슬롯/프리패스 산출물 0.
  const lastSecurityBareUdf =
    last.kind === "ExprStmt" && last.expr.kind === "CallExpr"
      ? program.securityBareUdfCallSlots.get(last.expr)
      : undefined;
  if (last.kind === "ExprStmt" && lastSecurityBareUdf !== undefined) {
    hoistLazyStatefulCalls(lastSecurityBareUdf, program, funcCtx, lines);
    lines.push(`return ${genExpr(lastSecurityBareUdf, program, funcCtx)};`);
    return lines.join("\n");
  }
  // C531: 마지막 문장이 `[a, b] = request.security(sym, tf, [e1, e2, ...])` 튜플 디스트럭처인
  // 암시 재반환 폼(analyzer analyzeFuncDecl의 동명 분기가 tupleArity를 확정해뒀다) — 디스트럭처
  // 문장은 일반 genStmt로 그대로 실행한 뒤(genTupleDestructure의 securityTupleCall 분기가
  // comma-식 실행 + 이름 복사를 방출하고 원소 값은 $.taScratch에 그대로 남는다), 위 C530과 동일한
  // "UDF 튜플 반환 = 배열 리터럴" 계약으로 스크래치를 return한다. 대상 이름 대신 스크래치를 읽는
  // 이유: '_' discard 대상/재선언 mangling과 무관하게 항상 전체 원소를 재반환할 수 있고,
  // 디스트럭처가 마지막 문장이라 그 사이에 스크래치를 덮는 코드가 없다.
  const lastSecurityTupleDestructure =
    last.kind === "TupleDestructure" && last.value.kind === "CallExpr"
      ? program.securityTupleCallSlots.get(last.value)
      : undefined;
  if (last.kind === "TupleDestructure" && lastSecurityTupleDestructure !== undefined) {
    const line = genStmt(last, program, /* nested */ true, funcCtx, null, redeclared);
    if (line) lines.push(line);
    lines.push(`return [${lastSecurityTupleDestructure.fields.map((_, i) => `$.taScratch[${i}]`).join(", ")}];`);
    return lines.join("\n");
  }
  // C752: 마지막 문장이 TA 다중반환/UDF 체인 콜을 튜플 디스트럭처하는 암시 재반환 폼(analyzer
  // analyzeFuncDecl/analyzeMethodDecl의 동명 분기가 funcBodyTailTupleDestructures에 등록해뒀다,
  // 위 C531 security 변형의 non-security 자매 축). 위와 달리 taScratch를 거치지 않는 폼(UDF 체인은
  // 배열 구조분해로 직접 대입)도 있어 대상 이름 자체가 유일한 공용 데이터 소스 — computeTupleTargetNames가
  // '_' 중복을 이미 유일한 임시명으로 치환해두므로 그대로 재사용한다.
  if (last.kind === "TupleDestructure" && program.funcBodyTailTupleDestructures.has(last)) {
    const line = genStmt(last, program, /* nested */ true, funcCtx, null, redeclared);
    if (line) lines.push(line);
    lines.push(`return [${computeTupleTargetNames(last).join(", ")}];`);
    return lines.join("\n");
  }
  // 튜플 반환: 마지막 문장이 `[a, b]`면 JS 배열 리터럴로 return한다 (analyzer가 이 위치에서만
  // TupleExpr를 허용 — genExpr는 이 노드를 다루지 않으므로 원소를 직접 genExpr한다).
  if (last.kind === "ExprStmt" && last.expr.kind === "TupleExpr") {
    // 튜플 원소의 lazy 위치(삼항/and·or) 아래 stateful 콜은 return 직전으로 eager 호이스팅한다
    // (C162 — udf-body 허용 전에는 이 경로에 호이스팅 대상이 생길 수 없어 불필요했음).
    for (const e of last.expr.elements) hoistLazyStatefulCalls(e, program, funcCtx, lines);
    const elements = last.expr.elements.map((e) => genExpr(e, program, funcCtx));
    lines.push(`return [${elements.join(", ")}];`);
  } else {
    lines.push(...genImplicitReturn(last, program, funcCtx, redeclared));
  }
  return lines.join("\n");
}

function genImplicitReturn(
  stmt: Stmt,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext,
  redeclared: RedeclareInfo | null = null,
): string[] {
  if (stmt.kind === "ExprStmt" && stmt.expr.kind === "TupleExpr") {
    // if-표현식 튜플 반환(analyzer detectIfTupleReturnArity/tryFuncBodyIfTupleReturn) 분기 안의
    // 튜플 리터럴 — genFuncBody 최상위 bare-TupleExpr 분기와 동일한 처리를 재귀 위치(genReturnBlock
    // 경유)에서도 적용한다. genExpr는 TupleExpr를 다루지 않으므로(analyzer가 이 위치만 허용) 원소를
    // 직접 genExpr해 배열 리터럴로 return한다.
    const pre: string[] = [];
    for (const e of stmt.expr.elements) hoistLazyStatefulCalls(e, program, funcCtx, pre);
    const elements = stmt.expr.elements.map((e) => genExpr(e, program, funcCtx));
    return [...pre, `return [${elements.join(", ")}];`];
  }
  // C612: if/switch 분기 꼬리(genReturnBlock 경유)가 C611 두 꼬리 폼일 수 있다 — genFuncBody의
  // C530/C611 flat 분기와 동일한 방출을 재귀 위치에서도 미러한다(analyzer resolveTupleValueBranch의
  // security 튜플/bare-UDF 리프 대응). genExpr(security 튜플 콜)는 comma-식($.taScratch 순차 대입)
  // 이라 그대로 return하면 마지막 원소 스칼라가 새므로 문장 실행 후 스크래치를 배열로 return한다.
  if (stmt.kind === "ExprStmt" && stmt.expr.kind === "CallExpr") {
    const secTuple = program.securityTupleCallSlots.get(stmt.expr);
    if (secTuple !== undefined) {
      const pre: string[] = [];
      hoistLazyStatefulCalls(stmt.expr, program, funcCtx, pre);
      return [
        ...pre,
        `${genExpr(stmt.expr, program, funcCtx)};`,
        `return [${secTuple.fields.map((_, i) => `$.taScratch[${i}]`).join(", ")}];`,
      ];
    }
    const secBareUdf = program.securityBareUdfCallSlots.get(stmt.expr);
    if (secBareUdf !== undefined) {
      // 외부 request.security 노드는 완전히 discard하고 내부 UDF 콜을 직접 return(C432 passthrough,
      // genFuncBody C611 분기와 동일 — 내부 콜 자신이 "UDF 튜플 반환 = 배열 리터럴" 계약을 충족).
      const pre: string[] = [];
      hoistLazyStatefulCalls(secBareUdf, program, funcCtx, pre);
      return [...pre, `return ${genExpr(secBareUdf, program, funcCtx)};`];
    }
    // C629: 마지막 문장이 다중 반환 TA 콜(`ta.macd(...)` 등, analyzer analyzeFuncDecl 동명 분기가
    // tupleStateCalls에 선등록해뒀다) — genExpr(ta 다중반환 콜)는 $.taScratch[0..N-1]에 쓰기만 하고
    // 스칼라 반환값은 무의미하므로(analyzer.ts taMultiReturnTailArity 주석 참조) 위 secTuple과
    // 동일하게 문장으로 1회 실행한 뒤 스크래치를 배열 리터럴로 return한다.
    if (
      stmt.expr.callee.kind === "DotAccess" &&
      stmt.expr.callee.obj.kind === "Identifier" &&
      stmt.expr.callee.obj.name === "ta" &&
      program.tupleStateCalls.has(stmt.expr)
    ) {
      const entry = TA_REGISTRY[stmt.expr.callee.attr];
      const callArity = entry && entry.dispatch === "ta" ? taCallReturnArity(entry, stmt.expr.args.length) : undefined;
      if (callArity !== undefined) {
        const pre: string[] = [];
        hoistLazyStatefulCalls(stmt.expr, program, funcCtx, pre);
        return [
          ...pre,
          `${genExpr(stmt.expr, program, funcCtx)};`,
          `return [${Array.from({ length: callArity }, (_, i) => `$.taScratch[${i}]`).join(", ")}];`,
        ];
      }
    }
  }
  // C612: 마지막 문장이 튜플 삼항(`cond ? [a,b] : request.security(..., [o,c])`류 — analyzer
  // analyzeFuncDecl 동명 분기가 수용)이면 genTernaryTupleDestructure와 동일한 "임시변수 NaN 선대입 +
  // if/else 분기 채움" 뼈대로 방출 후 배열 리터럴을 return한다(genExpr(TernaryOp)는 TupleExpr
  // 원소를 다루지 못해 internal throw — 이 분기가 선행 차단). 판별은 analyzer와 동일한
  // detectTupleReturnArityFromTailExpr 재실행(C609 detectTupleReturnArityFromLastStmt 선례).
  if (stmt.kind === "ExprStmt" && stmt.expr.kind === "TernaryOp") {
    const ternaryArity = detectTupleReturnArityFromTailExpr(stmt.expr, program);
    if (ternaryArity !== null) {
      const tempBase = `__cfr${cfrTempCounter}`;
      cfrTempCounter += 1;
      const temps = Array.from({ length: ternaryArity }, (_, i) => `${tempBase}_${i}`);
      const pre: string[] = [];
      hoistLazyStatefulCalls(stmt.expr.condition, program, funcCtx, pre);
      const condCode = genExpr(stmt.expr.condition, program, funcCtx);
      const trueBlock = genTupleValueIntoTargets(temps, stmt.expr.trueExpr, program, funcCtx);
      const falseBlock = genTupleValueIntoTargets(temps, stmt.expr.falseExpr, program, funcCtx);
      return [
        ...pre,
        `let ${temps.map((t) => `${t} = NaN`).join(", ")};`,
        `if (${condCode}) ${trueBlock} else ${falseBlock}`,
        `return [${temps.join(", ")}];`,
      ];
    }
  }
  // C765: 단문 화살표 UDF/method 본문이 '=>' 직후 INDENT 없이 같은 줄에서 바로 if/switch로
  // 시작하는 폼(analyzer.ts analyzeFuncBodyTailWrappedCtrlFlow 주석 참조) — 파서가
  // ExprStmt{IfStmt|SwitchStmt}로 감싸둔 것을 여기서 헤제해 아래 직접-IfStmt/SwitchStmt 분기와
  // 동일하게 처리한다(genReturnIfStmt/genReturnSwitchStmt가 튜플/스칼라 모두 자체 판별).
  if (stmt.kind === "ExprStmt" && stmt.expr.kind === "IfStmt") {
    return [genReturnIfStmt(stmt.expr, program, funcCtx)];
  }
  if (stmt.kind === "ExprStmt" && stmt.expr.kind === "SwitchStmt") {
    return [genReturnSwitchStmt(stmt.expr, program, funcCtx)];
  }
  if (stmt.kind === "ExprStmt") {
    // 암시 return 식의 lazy 위치 아래 stateful 콜도 문장(return) 직전으로 호이스팅(C162 —
    // genStmt의 ExprStmt 경로와 동일한 처리, 이 경로만 별도 함수라 따로 건다).
    const pre: string[] = [];
    hoistLazyStatefulCalls(stmt.expr, program, funcCtx, pre);
    return [...pre, `return ${genExpr(stmt.expr, program, funcCtx)};`];
  }
  if (stmt.kind === "IfStmt") {
    return [genReturnIfStmt(stmt, program, funcCtx)];
  }
  if (stmt.kind === "SwitchStmt") {
    return [genReturnSwitchStmt(stmt, program, funcCtx)];
  }
  // C571: 마지막 문장이 신규 '=' 선언/재대입(Assignment) 또는 var/varip 선언(VarDecl)이면 —
  // Pine에서 대입문 자신도 값(대입된 값)을 가지므로, 그게 마지막 문장이면 UDF의 암시 반환값이다
  // (wild `f(x) =>\n  y = x + 1` 관용구, 대입 다음 줄에 별도로 `y`를 다시 쓰지 않는 실전 패턴).
  // 이전까지는 대입 자체만 실행하고 아무 return도 안 내 undefined가 새 나갔다(corpus_scan --exec
  // "Cannot read properties of undefined" 클러스터 최다 서브축, 9/13 — UDT 생성자 결과를 받는
  // '=' 로컬/함수-내부 var 게이트 양쪽 다 실측). pine2py도 동일 결함(python 직접 실행 확인,
  // `def f(x): y = (x + 1)`에 return 없음)이나 GOAL.md "pine2py의 알려진 버그는 따르지 않는다"에
  // 따라 TV 공식 규칙(마지막 문장의 값)대로 정정한다 — genIdentifier가 이미 이 이름이 func-local
  // var/파라미터/'=' 로컬/top-level var 중 어디에 있는지 판별해두므로 그대로 재사용.
  if (stmt.kind === "Assignment" || stmt.kind === "VarDecl") {
    const line = genStmt(stmt, program, /* nested */ true, funcCtx, null, redeclared);
    const ref = genIdentifier(stmt.name, program, funcCtx);
    return line ? [line, `return ${ref};`] : [`return ${ref};`];
  }
  const line = genStmt(stmt, program, /* nested */ true, funcCtx, null, redeclared);
  return line ? [line] : [];
}

// genIfStmt와 동일한 분기 구조이나 각 분기의 마지막 문장에 암시 return을 삽입한다.
// C573: else가 없고 조건이 전부 불일치하면 반드시 na 폴백을 명시적으로 return해야 한다 — JS가
// 자연스럽게 흘려보내는 값은 실제 값이 아닌 "미초기화" undefined이고(GOAL.md na 시맨틱: 참조형=null/
// 숫자=NaN, undefined는 전용 아님), rt.na()는 undefined를 na로 인식하지 않는다(numeric.ts na():
// number면 자기부등, 아니면 `=== null`만 검사 — undefined는 둘 다 걸리지 않음). 이전 주석은 이걸
// "Python의 else 없으면 None과 동치"로 착각했으나 Python None과 달리 JS undefined는 그런 보편
// sentinel이 아니다(wild ZigZag 라이브러리 실측, LIMITATIONS C573 — findPivotPoint가 암시
// undefined를 반환하자 `not na(point)`가 그걸 "na 아님"으로 오판해 그대로 다음 단계로 흘려보내
// null 필드 역참조 크래시). 폴백 리터럴은 실제 반환 타입(숫자/참조형)을 몰라도 안전한 NaN 하나로
// 통일한다 — array.get() 범위밖 sentinel(C572)과 동일 관례로, rt.na()가 타입 무관하게 NaN을
// 인식하고(numeric.ts na() 자기부등 분기) 참조형 접근 가드(isHandle 등)도 NaN을 "핸들 아님"으로
// 안전하게 걸러낸다. C519 튜플 반환(analyzer detectIfTupleReturnArity가 else 없이도 then/elif
// arity 일치로 채택한 경우)만은 스칼라 NaN이 아니라 배열 [NaN,...] 폴백이 필요 — JS 배열
// 구조분해(`[a,b]=f()`)는 스칼라 NaN에서도 즉시 throw하므로 별도 분기 유지.
function genReturnIfStmt(stmt: IfStmt, program: AnalyzedProgram, funcCtx: FuncGenContext): string {
  const branches: string[] = [
    `if (${genExpr(stmt.condition, program, funcCtx)}) ${genReturnBlock(stmt.thenBody, program, funcCtx)}`,
  ];
  for (const clause of stmt.elifClauses) {
    branches.push(
      `else if (${genExpr(clause.condition, program, funcCtx)}) ${genReturnBlock(clause.body, program, funcCtx)}`,
    );
  }
  if (stmt.elseBody !== null) {
    branches.push(`else ${genReturnBlock(stmt.elseBody, program, funcCtx)}`);
  } else {
    // C609: lastThen이 TupleExpr 리터럴이 아니라 다시 중첩 IfStmt/SwitchStmt일 수 있다 — 단순
    // "ExprStmt+TupleExpr" 체크만으로는 그 경우를 놓쳐 스칼라 NaN 폴백으로 떨어지고, 튜플
    // 디스트럭처 호출부(`[a,b]=f()`)가 `NaN is not iterable`로 크래시한다(wild 010436c260ec.pine
    // 실측). detectTupleReturnArityFromLastStmt(analyzer의 arity 추론과 동일한 재귀)로 판별.
    const lastThen = stmt.thenBody[stmt.thenBody.length - 1];
    const tupleArity = detectTupleReturnArityFromLastStmt(lastThen, program);
    if (tupleArity !== null) {
      branches.push(`else { return [${new Array(tupleArity).fill("NaN").join(", ")}]; }`);
    } else {
      branches.push(`else { return NaN; }`);
    }
  }
  return branches.join(" ");
}

function genReturnSwitchStmt(stmt: SwitchStmt, program: AnalyzedProgram, funcCtx: FuncGenContext): string {
  const lines: string[] = [];
  let subjectVar: string | null = null;
  if (stmt.subject !== null) {
    subjectVar = "__switchSubject";
    // subject의 lazy 위치 아래 stateful 콜 호이스팅 — top-level genSwitchStmt와 동일(C162부터
    // UDF 본문 마지막 문장 switch에도 대상이 생길 수 있다).
    hoistLazyStatefulCalls(stmt.subject, program, funcCtx, lines);
    lines.push(`let ${subjectVar} = ${genExpr(stmt.subject, program, funcCtx)};`);
  }

  const cases = reorderSwitchCases(stmt.cases);
  const branches = cases.map((c, i) => {
    if (c.values === null) {
      return i === 0 ? `if (true) ${genReturnBlock(c.body, program, funcCtx)}` : `else ${genReturnBlock(c.body, program, funcCtx)}`;
    }
    const test = genSwitchCaseTest(subjectVar, c.values, program, funcCtx);
    return `${i === 0 ? "if" : "else if"} (${test}) ${genReturnBlock(c.body, program, funcCtx)}`;
  });

  // C573(genReturnIfStmt와 동형): default 없이 case가 전부 불일치하면 na 폴백을 명시적으로
  // return해야 한다 — JS 자연 낙하는 undefined이고 rt.na()가 이를 na로 인식하지 않는다. 튜플
  // 반환(C519, analyzer detectSwitchTupleReturnArity가 default 없이도 case arity 일치로 채택한
  // 경우)만 배열 [NaN,...] 폴백, 그 외 스칼라는 NaN 하나로 통일(genReturnIfStmt 주석 참조). C609:
  // lastOfFirst가 다시 중첩 IfStmt/SwitchStmt일 수 있어 detectTupleReturnArityFromLastStmt로
  // 판별한다(genReturnIfStmt와 동일한 버그 클래스 — 위 주석 참조).
  const hasDefault = cases.some((c) => c.values === null);
  if (!hasDefault && cases.length > 0) {
    const firstBody = cases[0]!.body;
    const lastOfFirst = firstBody[firstBody.length - 1];
    const tupleArity = detectTupleReturnArityFromLastStmt(lastOfFirst, program);
    if (tupleArity !== null) {
      branches.push(`else { return [${new Array(tupleArity).fill("NaN").join(", ")}]; }`);
    } else {
      branches.push(`else { return NaN; }`);
    }
  }

  return `{\n${[...lines, ...branches].join("\n")}\n}`;
}

function genReturnBlock(body: Stmt[], program: AnalyzedProgram, funcCtx: FuncGenContext): string {
  if (body.length === 0) return "{\nreturn undefined;\n}";
  const redeclared = findRedeclaredAssignments(body);
  const lines: string[] = [];
  for (const stmt of body.slice(0, -1)) {
    const line = genStmt(stmt, program, /* nested */ true, funcCtx, null, redeclared);
    if (line) lines.push(line);
  }
  lines.push(...genImplicitReturn(body[body.length - 1]!, program, funcCtx, redeclared));
  return `{\n${lines.join("\n")}\n}`;
}

// nested=true: if-블록 등 중첩 스코프 안 — '=' 로컬은 JS `let`으로 내보내 진짜 블록 스코프를
// 갖게 한다(Pine의 섀도잉 규칙과 일치시키기 위함). top-level '=' 로컬은 per-bar 함수 스코프의
// `var`가 기본이고, UDF가 클로저로 붙잡아 프리앰블로 승격된 이름(promoted)만 선언 키워드 없는
// 맨몸 대입으로 내린다(선언은 프리앰블의 `var name;`이 담당 — generateCode 참조).
// promoted는 top-level(generateCode의 직접 호출)에서만 non-null이다 — 중첩 재귀는 항상 `let`
// 경로라 승격과 무관하므로 전달하지 않는다.
// funcCtx!==null: UDF 본문 안 — var/varip는 $.vars[]가 아니라 $.fnVars[__slotBase+i]로 내린다.
// 문장이 소유한 표현식 하나를 걸어 lazy 위치(삼항 분기/and·or 우변) 아래의 stateful 콜 전부를
// `let __lazyN = <콜>;` 프리루드 줄로 out에 수집하고 lazyTemps에 노드→임시변수명을 등록한다
// (파일 상단 lazyTemps 주석 참조 — 이후 이 문장의 본식을 genExpr로 렌더링하면 등록된 콜 노드가
// 임시변수명으로 대체된다). 호출 지점: 표현식을 소유한 모든 문장 생성부 중 stateful 콜이 허용될
// 수 있는 곳(VarDecl 게이트 안/Assignment/ExprStmt/TupleDestructure/genBodyWithResult 마지막 식/
// for 헤더/switch subject + UDF 본문의 암시 return 식/튜플 반환 원소(C162)). 조건식(if/while
// 조건·switch case 값)은 analyzer가 lazy 위치의 stateful 콜을 여전히 거부하므로 호이스팅 대상이
// 생길 수 없다.
function hoistLazyStatefulCalls(
  expr: Expr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  out: string[],
): void {
  walkForLazyHoist(expr, /* inLazy */ false, program, funcCtx, out);
}

// lazy 위치 아래 var-stateful UDF 콜(ROADMAP "(C66 발견) lazy 위치의 var-stateful UDF 콜")도
// ta.*/fixnan과 동일하게 문장 직전으로 호이스팅해야 한다 — analyzer의 analyzeUserFuncCall은
// scope.func(UDF 본문 안인가)만 검사할 뿐 ScopePushKind 체인(lazy-expr 포함)을 전혀 보지 않아 UDF
// 콜의 위치는 애초에 제약된 적이 없다(ta.*처럼 "허용 위치를 넓히며 호이스팅을 추가"가 아니라 "원래
// 무제약이던 위치에 뒤늦게 eager 보정을 추가"하는 것 — 그래서 이 판정은 analyzer 변경 없이 순수
// codegen 책임으로 완결된다). var/varip도 stateful 콜(C162의 localTaSlotCount)도 전혀 없는
// UDF는 상태가 없어 lazy 평가와 eager 평가가 관측 동치이므로 호이스팅 대상에서 제외한다(C66이
// 이미 확립한 "콜만 최소 단위로 끌어올린다" 원칙 재적용 — 불필요한 임시변수를 만들지 않음).
// 본문에 ta 상태만 있는 UDF(var 0개 + localTaSlotCount > 0)도 lazy로 두면 그 콜사이트의 ta
// 상태가 조건이 갈리는 바에서 조용히 전진을 건너뛰므로 반드시 포함해야 한다.
// 사용자 선언 method 콜(`obj.method(args)`, callee가 DotAccess)도 일반 UDF와 완전히 동일한
// funcCallSlots/localVarSlots/localTaSlotCount 메커니즘으로 상태를 갖는다(analyzer.ts
// analyzeCallExpr의 method 분기 참조) — DotAccess 분기 부재로 lazy 위치의 stateful method 콜이
// 호이스팅되지 않아 조건이 갈리는 바에서 상태 전진이 조용히 멈추던 실제 버그(C197에서 발견, UDF
// 콜은 이미 정확했음).
function isVarStatefulUdfCall(expr: CallExpr, program: AnalyzedProgram): boolean {
  if (expr.callee.kind === "Identifier") {
    if (!program.funcCallSlots.has(expr)) return false;
    // bare method(receiver, ...) 콜(C267)도 실제 top-level 함수는 mangled 이름이라 그쪽으로 조회
    // 해야 한다 — program.funcs.get(callee.name)만 쓰면 method는 항상 undefined로 떨어져(C197과
    // 동일 급의 미호이스팅 버그) lazy 위치에서 상태 전진이 조용히 멈춘다.
    const bareMethodType = program.udtMethodCallTypes.get(expr);
    // C687: 오버로드는 analyzer와 동일한 공유 헬퍼(lookupMethodOverload)로 콜사이트 인자 개수 기준
    // 선택 — bare 콜은 receiver가 args[0]에 이미 포함(오버로드 없는 이름은 기존 base 조회와 동일).
    const func =
      bareMethodType !== undefined
        ? lookupMethodOverload(program, bareMethodType, expr.callee.name, expr.args.length + expr.kwargs.length, expr)
        : program.funcs.get(expr.callee.name);
    return func !== undefined && (func.localVarSlots.length > 0 || func.localTaSlotCount > 0);
  }
  if (expr.callee.kind === "DotAccess") {
    const methodTypeName = program.udtMethodCallTypes.get(expr);
    if (methodTypeName === undefined) return false;
    // C687: dot-sugar는 receiver(callee.obj) 몫 +1.
    const func = lookupMethodOverload(program, methodTypeName, expr.callee.attr, 1 + expr.args.length + expr.kwargs.length, expr);
    return func !== undefined && (func.localVarSlots.length > 0 || func.localTaSlotCount > 0);
  }
  return false;
}

// lazy 위치의 array 뮤테이터(push/pop/set(C79), shift/unshift/insert/remove/clear/fill(C80))도
// eager 호이스팅 대상이다 — TV는 삼항/and·or 양쪽을 항상 평가하므로(C66과 동일 근거) 관측 가능한
// 뮤테이션이 있는 콜을 JS lazy 그대로 두면 조건이 갈리는 바에서 배열 내용이 TV와 조용히 갈린다.
// new_float/get/size/first/last는 순수(결과를 버리면 관측 불가)라 C66 "콜만 최소 호이스팅" 원칙대로
// 제외 — UDF의 "var 없으면 제외"와 같은 구분.
// map.put/remove/clear/put_all(C89)도 같은 이유로 여기 포함된다 — put/remove는 array.remove와
// 동일하게 "쓰기+읽기"(반환값이 있어도 관측 가능한 뮤테이션이면 호이스팅 대상, C66 원칙).
const MUTATING_ARRAY_BUILTINS = new Set([
  "array.push",
  "array.pop",
  "array.set",
  "array.shift",
  "array.unshift",
  "array.insert",
  "array.remove",
  "array.clear",
  "array.fill",
  "array.sort",
  "array.reverse",
  "map.put",
  "map.remove",
  "map.clear",
  "map.put_all",
  // matrix.set(C90)도 같은 이유로 여기 포함(array.set과 동일한 in-place 인덱스 대입).
  "matrix.set",
  // matrix.add_row/add_col/remove_row/remove_col/swap_rows/swap_columns(C92)도 관측 가능한
  // 뮤테이션 — remove_row/remove_col은 array.remove와 동일하게 "쓰기+읽기"(반환값이 있어도
  // 호이스팅 대상).
  "matrix.add_row",
  "matrix.add_col",
  "matrix.remove_row",
  "matrix.remove_col",
  "matrix.swap_rows",
  "matrix.swap_columns",
  // matrix.fill/reverse/sort(C93, 네 번째 슬라이스)도 in-place 뮤테이터라 동일 원칙 — copy/
  // concat/submatrix/reshape/diff는 새 행렬을 반환하는 순수 생성자라(호출 자체를 버려도 관측
  // 불가) 여기 등재하지 않는다(analyzer.ts MATRIX_CONSTRUCTOR_METHODS 참조).
  "matrix.fill",
  "matrix.reverse",
  "matrix.sort",
]);

function isMutatingArrayCall(expr: CallExpr, program: AnalyzedProgram): boolean {
  const name = program.builtinCalls.get(expr);
  return name !== undefined && MUTATING_ARRAY_BUILTINS.has(name);
}

// array/map/matrix.* 호출에서 "컨테이너 자기 자신"(참조형 self 인자, id 파라미터)이 na 리터럴로
// 채워질 때는 GOAL.md 참조형 na 규약(null)대로 코드젠해야 한다 — genExpr(NaLiteral)의 범용 경로는
// 항상 스칼라 NaN을 내므로(C216 부수 발견, array.copy(na)/map.copy(na) 등에서 `new Map(NaN)`류로
// 실제 런타임 크래시 재현 확인), 이 특정 인자 위치만 여기서 미리 null로 낮춘다. array.new_float(na)
// 류(인자가 값 자체)는 무관 — 문제는 인자 자신이 컨테이너 참조인 함수뿐이다. 기본값은 position
// 0(모든 array/map/matrix 메서드의 첫 인자가 컨테이너 자신) — 예외(컨테이너 인자가 없는 순수
// 생성자/두 번째 컨테이너 인자가 있는 이항 메서드)만 아래 두 테이블로 재정의한다.
const NO_CONTAINER_ARG_BUILTINS = new Set([
  "array.new_float",
  "array.new_int",
  "array.new_bool",
  "array.new_string",
  "array.new_color",
  "array.new_generic", // UDT/label/chart.point 등 참조형 T의 무타입 생성자(C230) — 순수 생성자 원칙 동일
  "array.new_label", // v4식 명명 typed 생성자 5종(C236) — new_generic과 완전히 동일한 순수 생성자
  "array.new_line",
  "array.new_box",
  "array.new_table",
  "array.new_linefill",
  "array.from", // 가변 인자 전부 원소 값(스칼라) — 컨테이너 참조 아님
  "map.new",
  "matrix.new",
]);
// matrix.add_row/add_col의 세 번째 인자(value)는 PineMatrix가 아니라 unknown[]|null(행/열 값
// 배열)이지만, 참조형 na=null 원칙은 컨테이너 종류에 무관하게 동일하게 적용된다. matrix.mult/pow의
// 두 번째 인자는 `PineMatrix | unknown[] | number | null` 유니온이라 na가 "스칼라 na로 곱한다"는
// 유효한 분기(NaN)로 이미 해석 가능하므로 여기 포함하지 않는다(mult(m, na) === 스칼라 NaN 곱).
const MULTI_CONTAINER_REF_ARGS: Readonly<Record<string, readonly number[]>> = {
  "array.concat": [0, 1],
  "array.covariance": [0, 1],
  "map.put_all": [0, 1],
  "matrix.concat": [0, 1],
  "matrix.kron": [0, 1],
  "matrix.sum": [0, 1], // C656: 2-인자 오버로드(원소별 덧셈)만 해당 — 1-인자 집계 호출은 위치 1이 없어 무관.
  "matrix.add_row": [0, 2],
  "matrix.add_col": [0, 2],
};
function containerRefArgPositions(builtinName: string): readonly number[] {
  if (!builtinName.startsWith("array.") && !builtinName.startsWith("map.") && !builtinName.startsWith("matrix.")) {
    return [];
  }
  if (NO_CONTAINER_ARG_BUILTINS.has(builtinName)) return [];
  return MULTI_CONTAINER_REF_ARGS[builtinName] ?? [0];
}

// inLazy: 조상 중에 lazy 위치가 하나라도 있으면 true — 그 아래의 stateful 콜은 깊이/중간 구조와
// 무관하게 전부(중첩 삼항의 조건 포함 — TV는 그 안까지 매 바 평가) 문장 레벨로 끌어올린다.
// 인자를 먼저 걷고 자신을 나중에 등록하므로(post-order) 중첩 콜(`c ? ta.sma(ta.ema(...),n) : x`)은
// 안쪽 임시변수가 먼저 선언되고 바깥 콜의 인자 렌더링이 그 이름을 참조한다.
function walkForLazyHoist(
  expr: Expr,
  inLazy: boolean,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  out: string[],
): void {
  switch (expr.kind) {
    case "TernaryOp":
      walkForLazyHoist(expr.condition, inLazy, program, funcCtx, out);
      walkForLazyHoist(expr.trueExpr, true, program, funcCtx, out);
      walkForLazyHoist(expr.falseExpr, true, program, funcCtx, out);
      return;
    case "BinOp":
      walkForLazyHoist(expr.left, inLazy, program, funcCtx, out);
      walkForLazyHoist(expr.right, inLazy || expr.op === "and" || expr.op === "or", program, funcCtx, out);
      return;
    case "UnaryOp":
      walkForLazyHoist(expr.operand, inLazy, program, funcCtx, out);
      return;
    case "IndexAccess": {
      // C468: ta.<fn>(...)[N]이 lazy-expr(삼항/and·or 우변) 위치에 있으면(analyzer.ts
      // lazyHistCallSites) record+get 전체를 comma 식 하나로 문장 앞 prelude에 끌어올린다 —
      // 원 표현식 위치엔 이미 계산된 임시변수만 남겨(genExpr의 lazyTemps 우선 조회, 파일 상단
      // 주석 참조) genIndexAccess가 아예 호출되지 않게 한다. inLazy가 false면(top-level 무조건
      // 위치) analyzer가 애초에 이 Set에 등록하지 않으므로 기존 인라인 경로 그대로 유지된다.
      if (inLazy && expr.obj.kind === "CallExpr" && program.lazyHistCallSites.has(expr)) {
        for (const a of expr.obj.args) walkForLazyHoist(a, inLazy, program, funcCtx, out);
        walkForLazyHoist(expr.index, inLazy, program, funcCtx, out);
        // C484: UDF 본문 콜사이트는 funcCtx.localCallHistSlots(__histBase-relative, C483)를
        // top-level 전역 슬롯(program.taCallHistorySlots, C468)보다 먼저 조회한다 —
        // genIndexAccess CallExpr 분기(비-lazy 인라인 경로)와 동일한 우선순위.
        const funcCallHistIdx = funcCtx?.localCallHistSlots.get(expr.obj);
        let slotRef: string;
        if (funcCallHistIdx !== undefined) {
          slotRef = `$.histSlots[__histBase + ${funcCallHistIdx}]`;
        } else {
          const histIdx = program.taCallHistorySlots.get(expr.obj);
          if (histIdx === undefined) throw new Error("internal: ta call history slot missing for lazy hoist (analyzer 통과 후 발생 불가)");
          slotRef = `$.histSlots[${histIdx}]`;
        }
        const isDynamic = program.dynamicHistoryOffsets.has(expr);
        const offset = isDynamic ? undefined : program.historyOffsets.get(expr);
        if (!isDynamic && offset === undefined) {
          throw new Error("internal: lazy hist IndexAccess에 확정된 오프셋 없음 (analyzer 통과 후 발생 불가)");
        }
        const offsetCode = isDynamic ? genExpr(expr.index, program, funcCtx) : String(offset);
        const callCode = genCallExpr(expr.obj, program, funcCtx);
        const name = `__lazy${lazyTempCounter}`;
        lazyTempCounter += 1;
        out.push(`let ${name} = (${slotRef}.record(${callCode}), ${slotRef}.get(${offsetCode}));`);
        lazyTemps.set(expr, name);
        return;
      }
      // C522: (high-low)[1]류 산술식(BinOp/UnaryOp) 히스토리도 같은 lazy-hoist가 필요하다 — obj
      // 자신을 먼저 걸어(중첩된 stateful 콜이 있으면 그것부터 lazyTemps에 등록) 이후 genExpr(expr.obj)가
      // 그 임시변수 이름을 그대로 참조하게 한다(위 CallExpr 분기가 args를 먼저 거니는 것과 동형 —
      // 여기는 obj 자체가 유일한 재귀 진입점이라 obj를 직접 walk). C720: UDF-body(funcCtx) 대상도
      // 이제 analyzer가 허용하므로(index-access.ts scope.func!==null 확장), CallExpr의 위 분기와
      // 동일하게 funcCtx.localCallHistSlots(__histBase-relative)를 top-level 전역 슬롯보다 먼저 조회.
      if (inLazy && (expr.obj.kind === "BinOp" || expr.obj.kind === "UnaryOp") && program.lazyHistCallSites.has(expr)) {
        walkForLazyHoist(expr.obj, inLazy, program, funcCtx, out);
        walkForLazyHoist(expr.index, inLazy, program, funcCtx, out);
        const funcArithHistIdx = funcCtx?.localCallHistSlots.get(expr.obj);
        let arithSlotRef: string;
        if (funcArithHistIdx !== undefined) {
          arithSlotRef = `$.histSlots[__histBase + ${funcArithHistIdx}]`;
        } else {
          const histIdx = program.taCallHistorySlots.get(expr.obj);
          if (histIdx === undefined) throw new Error("internal: arith expr history slot missing for lazy hoist (analyzer 통과 후 발생 불가)");
          arithSlotRef = `$.histSlots[${histIdx}]`;
        }
        const isDynamic = program.dynamicHistoryOffsets.has(expr);
        const offset = isDynamic ? undefined : program.historyOffsets.get(expr);
        if (!isDynamic && offset === undefined) {
          throw new Error("internal: lazy hist IndexAccess에 확정된 오프셋 없음 (analyzer 통과 후 발생 불가)");
        }
        const offsetCode = isDynamic ? genExpr(expr.index, program, funcCtx) : String(offset);
        const objCode = genExpr(expr.obj, program, funcCtx);
        const name = `__lazy${lazyTempCounter}`;
        lazyTempCounter += 1;
        out.push(`let ${name} = (${arithSlotRef}.record(${objCode}), ${arithSlotRef}.get(${offsetCode}));`);
        lazyTemps.set(expr, name);
        return;
      }
      walkForLazyHoist(expr.obj, inLazy, program, funcCtx, out);
      walkForLazyHoist(expr.index, inLazy, program, funcCtx, out);
      return;
    }
    case "CallExpr": {
      for (const a of expr.args) walkForLazyHoist(a, inLazy, program, funcCtx, out);
      if (inLazy && (program.stateCallSlots.has(expr) || isVarStatefulUdfCall(expr, program) || isMutatingArrayCall(expr, program))) {
        const name = `__lazy${lazyTempCounter}`;
        lazyTempCounter += 1;
        out.push(`let ${name} = ${genCallExpr(expr, program, funcCtx)};`);
        lazyTemps.set(expr, name);
      }
      return;
    }
    default:
      // 리터럴/Identifier: 하위 없음. math.pi 등 콜 없는 DotAccess(C72)도 인자가 없는 리프라 하위
      // 없음(호이스팅할 콜 자체가 없음). TupleExpr/제어문-식은 analyzer가 표현식 내부 위치를 거부해
      // 도달 불가.
      return;
  }
}

function withLazyPrelude(pre: string[], stmtCode: string): string {
  return pre.length === 0 ? stmtCode : `${pre.join("\n")}\n${stmtCode}`;
}

// 같은 문장 목록(if/UDF 본문 등 단일 블록, 중첩 블록은 별도 스코프라 재귀하지 않음) 안에서 '='가
// 같은 이름을 두 번 이상 새로 선언하면(Pine은 이를 "재선언"이 아니라 그 지점부터의 재대입으로
// 취급 — `y = 1, y = 2, y + x`처럼 콤마로 이어 쓰는 실전 패턴, C319 corpus invalid_js) nested 블록의
// 매 Assignment를 그대로 `let`으로 내리면 두 번째부터 JS `let` 동일 스코프 재선언 SyntaxError다
// (top-level `var`는 재선언이 합법이라 이 문제가 없다 — genStmt의 nested 분기만 해당). 이 목록의
// 첫 등장만 실제 선언(let)이고, 그 뒤 같은 이름은 이미 선언된 바인딩에 맨몸 대입만 하면 된다.
// seedNames(genFuncBody 전용, C319 후속): UDF 매개변수와 동명인 '='를 함수 본문 최상위에서 다시
// 선언(`f(x) => x = 1 ...`, Pine에서는 매개변수를 가리는 새 로컬)하는 것도 같은 부류의 SyntaxError
// 다 — 매개변수와 함수 본문 최상위 `let`은 JS에서 같은 스코프를 공유해 `function f(x) { let x=1; }`
// 자체가 항상 SyntaxError이기 때문(중첩 블록 안이면 별도 스코프라 문제 없음 — genBlock/
// genReturnBlock은 이 인자를 넘기지 않는다).
// C365 확장: TupleDestructure 대상 이름도 같은 축이다 — 두 튜플 문장이 같은 스코프에서 '_'(또는
// 일반 이름)를 공유하면(`[_, a] = f()` 뒤 `[_, b] = g()`, wild 476323868c34 실측 invalid_js) 두
// 번째 `let [...]`가 동일한 SyntaxError를 낸다. 튜플은 문장 단위가 아니라 **이름 단위 부분 재선언**
// 이 가능하므로(새 이름과 기선언 이름이 한 문장에 섞임) Assignment처럼 문장 집합이 아니라 문장별
// "이미 선언된 이름 부분집합" 맵(tupleSeen)으로 기록하고, genTupleDestructure가 그 부분집합을 뺀
// 나머지만 선행 let으로 선언한 뒤 맨몸 배열 구조분해 대입으로 내린다.
interface RedeclareInfo {
  assigns: Set<Assignment>;
  tupleSeen: Map<TupleDestructure, Set<string>>;
}

function findRedeclaredAssignments(body: Stmt[], seedNames: ReadonlySet<string> = new Set()): RedeclareInfo {
  const seen = new Set<string>(seedNames);
  const assigns = new Set<Assignment>();
  const tupleSeen = new Map<TupleDestructure, Set<string>>();
  for (const stmt of body) {
    if (stmt.kind === "Assignment" && stmt.operator === "=") {
      if (seen.has(stmt.name)) assigns.add(stmt);
      else seen.add(stmt.name);
    } else if (stmt.kind === "TupleDestructure") {
      const already = new Set<string>();
      for (const n of stmt.names) if (seen.has(n)) already.add(n);
      if (already.size > 0) tupleSeen.set(stmt, already);
      for (const n of stmt.names) seen.add(n);
    }
  }
  return { assigns, tupleSeen };
}

function genStmt(
  stmt: Stmt,
  program: AnalyzedProgram,
  nested: boolean,
  funcCtx: FuncGenContext | null,
  promoted: ReadonlySet<string> | null = null,
  redeclared: RedeclareInfo | null = null,
): string | null {
  switch (stmt.kind) {
    case "VarDecl": {
      if (funcCtx) {
        const localSlot = funcCtx.localVarIndex.get(stmt.name);
        if (localSlot === undefined) throw new Error(`internal: 함수-로컬 var 슬롯 없음 '${stmt.name}'`);
        const target = `$.fnVars[__slotBase + ${localSlot}]`;
        if (isControlFlowExpr(stmt.value)) {
          return `if (${target} === undefined) {\n${genControlFlowExprValue(stmt.value, program, funcCtx, (temp) => `${target} = ${temp};`)}\n}`;
        }
        if (stmt.value.kind === "BinOp" && (isControlFlowExpr(stmt.value.left) || isControlFlowExpr(stmt.value.right))) {
          const { pre: cfPre, code: cfCode } = hoistBinOpControlFlowOperands(stmt.value, program, funcCtx);
          return `if (${target} === undefined) {\n${cfPre}\n${target} = ${cfCode};\n}`;
        }
        const initCode = genFuncLocalValueCode(stmt.value, stmt.name, program, funcCtx);
        return `if (${target} === undefined) { ${target} = ${initCode}; }`;
      }
      // C728: 중첩 top-level var(if/for/while 등 depth>0)는 이름이 아니라 이 VarDecl 노드로
      // 슬롯을 찾는다 — 형제 블록의 동명 선언과 물리적으로 다른 슬롯(analyzer.ts
      // nestedVarDeclSlots/LexScope.nestedVarDeclStmts 주석 참조).
      const slot = program.nestedVarDeclSlots.get(stmt) ?? program.varIndex.get(stmt.name);
      if (slot === undefined) throw new Error(`internal: var slot missing for '${stmt.name}'`);
      const target = `$.vars[${slot}]`;
      if (isControlFlowExpr(stmt.value)) {
        // var/varip 슬롯은 "한 번만 초기화" 게이트 안에서만 값을 받는다 — pine2py의
        // _gen_control_flow_expr는 var_type 인자를 실제로는 쓰지 않아 `var x = if...`가 매 바
        // 재평가되는 버그가 있다(scratch/probe_var_if.py로 직접 실행해 재현 확인, C14). GOAL.md
        // "pine2py의 알려진 버그는 따르지 않는다" 원칙에 따라 여기서는 다른 VarDecl 값과 동일하게
        // 게이트 안에서 딱 한 번만 분기를 평가하도록 올바르게 구현한다(오라클로 검증 불가 —
        // MEMORY.md Pitfalls 참조, tests/unit/runtime.test.ts에 hand-verified 테스트로 대체).
        return `if (${target} === undefined) {\n${genControlFlowExprValue(stmt.value, program, funcCtx, (temp) => `${target} = ${temp};`)}\n}`;
      }
      if (stmt.value.kind === "BinOp" && (isControlFlowExpr(stmt.value.left) || isControlFlowExpr(stmt.value.right))) {
        const { pre: cfPre, code: cfCode } = hoistBinOpControlFlowOperands(stmt.value, program, funcCtx);
        return `if (${target} === undefined) {\n${cfPre}\n${target} = ${cfCode};\n}`;
      }
      // lazy 호이스팅 프리루드는 초기화 게이트 **안**에 붙인다 — var 초기값은 첫 바에만 평가되므로
      // TV eager 시맨틱("문장이 실행되는 바마다 양쪽 평가")도 그 첫 바 1회로 한정된다.
      const pre: string[] = [];
      hoistLazyStatefulCalls(stmt.value, program, funcCtx, pre);
      const initCode = genValueCode(stmt.value, stmt.name, program, funcCtx);
      if (pre.length > 0) {
        return `if (${target} === undefined) {\n${pre.join("\n")}\n${target} = ${initCode};\n}`;
      }
      return `if (${target} === undefined) { ${target} = ${initCode}; }`;
    }
    case "Assignment": {
      // UDF 내부 '=' 로컬 히스토리(C364, localHistKinds "local"): 이 이름으로의 모든 대입('='/':=',
      // 제어문-식 값 포함) 직후에 record를 덧붙인다 — Series.record가 현재 바 커서를 덮어쓰므로
      // 마지막으로 실행된 대입의 값이 남는다(= (a)슬라이스 "바 확정값 기록"과 동일한 최종값 시맨틱,
      // 읽기(get(n>=1))는 이전 바 커서라 같은 호출 안의 record에 영향받지 않음). var kind는 여기가
      // 아니라 top-level 바 종료 루프(generateCode), param kind는 함수 진입부(genFuncDecl)가 담당.
      // 중첩 블록(script top-level, depth>0) '=' 로컬 히스토리(C450, C714부터 program.
      // ambiguousNestedHistDeclSlots — 이름이 아니라 이 Assignment 노드 자신으로 키를 잡아 형제
      // 블록의 동명 선언과 절대 섞이지 않는다)도 같은 same-site 타이밍을 공유 — UDF 판과 정확히
      // 같은 이유(JS let 블록 스코프라 대입 직후 그 자리에서만 값이 안전하게 살아있음, 바-종료
      // 루프로 미룰 수 없음).
      // 중첩 블록 drawing 핸들 '=' 로컬(배치25 (1), C714부터 ambiguousNestedRefDeclSlots)도 같은
      // same-site 타이밍이지만 별도 물리 배열($.refHistSlots) — analyzer가 kind로 상호 배타 분기.
      // UDF 내부 drawing 핸들 '=' 로컬(C541, localRefHistKinds "local")도 같은 same-site 타이밍 —
      // 물리 배열만 $.refHistSlots(__refHistBase 콜사이트 블록)로 분리(이름은 numeric 판과 kind
      // 분기로 상호 배타라 체인 순서 무관).
      const histRecord =
        funcCtx !== null && funcCtx.localHistKinds.get(stmt.name) === "local"
          ? `\n$.histSlots[__histBase + ${funcCtx.localHistSlots.get(stmt.name)}].record(${safeLocalName(stmt.name)});`
          : funcCtx !== null && funcCtx.localRefHistKinds.get(stmt.name) === "local"
            ? `\n$.refHistSlots[__refHistBase + ${funcCtx.localRefHistSlots.get(stmt.name)}].record(${safeLocalName(stmt.name)});`
            : funcCtx !== null && funcCtx.localAmbiguousNestedHistDeclSlots.has(stmt)
              ? `\n$.histSlots[__histBase + ${funcCtx.localAmbiguousNestedHistDeclSlots.get(stmt)}].record(${safeLocalName(stmt.name)});`
              : funcCtx !== null && funcCtx.localAmbiguousNestedRefDeclSlots.has(stmt)
                ? `\n$.refHistSlots[__refHistBase + ${funcCtx.localAmbiguousNestedRefDeclSlots.get(stmt)}].record(${safeLocalName(stmt.name)});`
                : funcCtx === null && program.ambiguousNestedHistDeclSlots.has(stmt)
                  ? `\n$.histSlots[${program.ambiguousNestedHistDeclSlots.get(stmt)}].record(${safeLocalName(stmt.name)});`
                  : funcCtx === null && program.ambiguousNestedRefDeclSlots.has(stmt)
                    ? `\n$.refHistSlots[${program.ambiguousNestedRefDeclSlots.get(stmt)}].record(${safeLocalName(stmt.name)});`
                    : "";
      if (isControlFlowExpr(stmt.value)) {
        return genControlFlowAssignment(stmt, stmt.value, program, nested, funcCtx, promoted, redeclared) + histRecord;
      }
      // 복합 대입 데슈가링(`disp /= switch i ...` -> Assignment{operator: ":=", value: BinOp{...,
      // right: SwitchStmt}}, parser.ts COMPOUND_ASSIGN_OPS) — hoistBinOpControlFlowOperands 주석
      // 참조. 좌변이 원래 대상의 단순 읽기(부작용 없음)라 lazy 호이스팅과 무관하게 항상 안전하다.
      if (stmt.value.kind === "BinOp" && (isControlFlowExpr(stmt.value.left) || isControlFlowExpr(stmt.value.right))) {
        const { pre: cfPre, code: cfCode } = hoistBinOpControlFlowOperands(stmt.value, program, funcCtx);
        if (stmt.operator === ":=") {
          return `${cfPre}\n${resolveAssignTarget(stmt.name, program, funcCtx, stmt)} = ${cfCode};` + histRecord;
        }
        const safeName = safeLocalName(stmt.name);
        if ((!nested && promoted?.has(stmt.name)) || redeclared?.assigns.has(stmt)) return `${cfPre}\n${safeName} = ${cfCode};` + histRecord;
        return `${cfPre}\n${nested ? "let" : "var"} ${safeName} = ${cfCode};` + histRecord;
      }
      const pre: string[] = [];
      hoistLazyStatefulCalls(stmt.value, program, funcCtx, pre);
      if (stmt.operator === ":=") {
        const valueCode = genValueCode(stmt.value, stmt.name, program, funcCtx);
        return withLazyPrelude(pre, `${resolveAssignTarget(stmt.name, program, funcCtx, stmt)} = ${valueCode};`) + histRecord;
      }
      const valueCode = genExpr(stmt.value, program, funcCtx);
      const safeName = safeLocalName(stmt.name);
      if ((!nested && promoted?.has(stmt.name)) || redeclared?.assigns.has(stmt)) return withLazyPrelude(pre, `${safeName} = ${valueCode};`) + histRecord;
      return withLazyPrelude(pre, `${nested ? "let" : "var"} ${safeName} = ${valueCode};`) + histRecord;
    }
    case "ExprStmt": {
      if (stmt.expr.kind === "CallExpr" && program.directives.has(stmt.expr)) {
        return null; // indicator()/strategy() - no-op
      }
      if (stmt.expr.kind === "CallExpr" && program.noopStmtCalls.has(stmt.expr)) {
        // hline/bgcolor/barcolor/plotshape/plotchar/plotarrow/plotcandle/plotbar/alertcondition/
        // alert/max_bars_back(C208) - 시각화/알림 전용, directives와 동일한 no-op. 단
        // fill(plot(...), plot(...))(C346)처럼 인자 자리에 plotCallSlots 등록된 진짜 plot() 콜이
        // 중첩돼 있으면, 이 문장 전체를 통째로 스킵할 때 그 plot()의 .record() 부작용까지 함께
        // 사라져(Float64Array 출력 채널이 매 바 안 채워짐) 조용한 데이터 유실이 된다 — 중첩 plot
        // 인자만 골라 별도 표현식 문장으로 방출(hline 등 나머지는 fill 자신처럼 진짜 무해 no-op).
        const nestedPlotArgs = [...stmt.expr.args, ...stmt.expr.kwargs.map((kw) => kw.value)].filter(
          (arg): arg is CallExpr => arg.kind === "CallExpr" && program.plotCallSlots.has(arg),
        );
        const noopParts = nestedPlotArgs.map((arg) => `${genExpr(arg, program, funcCtx)};`);
        // viz S2 — bgcolor/barcolor의 런타임 색: 문장 자체는 여전히 제거하되 색 기록만 방출한다
        // (plot S1과 같은 채널·같은 rt.vizColor 정규화 — na 색 분기는 null로 낮아진다).
        const noopColorWrite = program.noopColorWrites.get(stmt.expr);
        if (noopColorWrite !== undefined) {
          noopParts.push(
            `$.plotColors[${noopColorWrite.slot}][$.idx] = rt.vizColor(${genExpr(noopColorWrite.expr, program, funcCtx)});`,
          );
        }
        // viz S3 — 마커 계열의 조건/수치 기록. 이 방출로 마커 인자 표현식이 처음으로 매 바
        // 실행된다(TV 정합 방향의 시맨틱 이동 — resin-viz-plan.md §4 재실측 프로토콜 적용).
        const noopSeriesWrites = program.noopSeriesWrites.get(stmt.expr);
        if (noopSeriesWrites !== undefined) {
          for (const w of noopSeriesWrites) {
            noopParts.push(
              `$.vizSeries[${w.slot}][$.idx] = rt.${w.kind === "flag" ? "vizFlag" : "vizNum"}(${genExpr(w.expr, program, funcCtx)});`,
            );
          }
        }
        if (noopParts.length === 0) return null;
        return noopParts.join("\n");
      }
      // C610(배치32(2)): 문장 위치(값 폐기) bare 튜플 리터럴 — analyzer(analyzeStmt ExprStmt
      // 분기)가 원소별 값 위치로 수용한 노드. TV/pine2py 동일하게 원소를 평가만 하고 값은
      // 버린다(early-exit 가드 관용구). 배열 리터럴 방출은 bar loop 안 할당 제로 원칙 위반이라
      // 원소별 표현식 문장으로 방출 — void 접두는 원소 코드가 어떤 형태든(선행 `[`/`(` 포함)
      // ExpressionStatement로 파싱되게 하는 안전장치. genExpr는 TupleExpr를 다루지 않으므로
      // (값 위치 전용 internal throw) 반드시 여기서 원소 단위로 내려보낸다.
      if (stmt.expr.kind === "TupleExpr") {
        const tuplePre: string[] = [];
        for (const el of stmt.expr.elements) hoistLazyStatefulCalls(el, program, funcCtx, tuplePre);
        const discards = stmt.expr.elements.map((el) => `void (${genExpr(el, program, funcCtx)});`);
        return withLazyPrelude(tuplePre, discards.join("\n"));
      }
      const pre: string[] = [];
      hoistLazyStatefulCalls(stmt.expr, program, funcCtx, pre);
      return withLazyPrelude(pre, `${genExpr(stmt.expr, program, funcCtx)};`);
    }
    case "IfStmt":
      return genIfStmt(stmt, program, funcCtx);
    case "WhileStmt":
      return genWhileStmt(stmt, program, funcCtx);
    case "ForStmt":
      return genForStmt(stmt, program, funcCtx);
    case "ForInStmt":
      return genForInStmt(stmt, program, funcCtx);
    case "BreakStmt":
      return "break;";
    case "ContinueStmt":
      return "continue;";
    case "SwitchStmt":
      return genSwitchStmt(stmt, program, funcCtx);
    case "TupleDestructure":
      return genTupleDestructure(stmt, program, nested, funcCtx, promoted, redeclared?.tupleSeen.get(stmt) ?? null);
    case "FieldAssignment":
      return genFieldAssignment(stmt, program, funcCtx);
    case "FuncDecl":
    case "TypeDecl":
    case "EnumDecl":
    case "MethodDecl":
      // top-level FuncDecl/TypeDecl/MethodDecl은 generateCode()가 먼저 걸러 genFuncDecl/genTypeDecl/
      // genMethodDecl로 직접 생성하고(EnumDecl은 아무것도 생성하지 않고 그냥 걸러지기만 함), 중첩된
      // 것은 analyzer가 errors를 채워 generateCode()가 위에서 throw했어야 함(도달 불가).
      throw new Error(`internal: '${stmt.kind}' codegen 미구현 (analyzer 통과 후 발생 불가)`);
  }
}

// obj 표현식이 정적으로 "UDT 인스턴스"임이 확정됐다면 그 타입명을, 아니면 undefined를 반환한다
// (analyzer.ts resolveUdtObjectType과 완전히 동일한 판별 — analyzer가 udtFieldAccessTypes를 이미
// 다 채워둔 뒤 codegen이 실행되므로 여기선 재귀 방문 없이 조회만 하면 된다). Identifier는
// udtFieldAccessTypes 노드 캐시(C224, '=' 로컬 UDT — analyzer의 scope 체인 판정 결과가 이 노드
// 기준으로 캐싱돼 있음)를 funcCtx.paramUdtTypes(C124)/funcCtx.localVarUdtTypes(C392)/top-level
// udtVarTypes보다 먼저 확인한다 — analyzer의 조회 순서(scope 체인 -> paramUdtTypes ->
// localVarUdtTypes -> udtVarTypes)와 동일해야 '=' 로컬이 매개변수/func-local var/top-level var와
// 동명일 때도 analyzer와 같은 답을 낸다(이름이 아니라 노드 identity 캐시라 순서를 지키지 않으면
// 섀도잉 케이스에서 갈릴 수 있음).
function resolveUdtObjectType(obj: Expr, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string | undefined {
  if (obj.kind === "Identifier") {
    return (
      program.udtFieldAccessTypes.get(obj) ??
      funcCtx?.paramUdtTypes.get(obj.name) ??
      funcCtx?.localVarUdtTypes.get(obj.name) ??
      program.udtVarTypes.get(obj.name)
    );
  }
  if (obj.kind === "DotAccess") return program.udtFieldAccessTypes.get(obj);
  // array<UDT>에서 원소 하나를 꺼내는 CallExpr(C390, `sequence.first().dir`류) — analyzer가
  // resolveArrayGetElemUdtType(scope 체인 필요, codegen엔 없음)으로 판별한 결과를 이 노드 자신에
  // udtFieldAccessTypes로 캐싱해뒀다(analyzer.ts DotAccess 케이스 참조, C224 원칙 그대로 적용).
  if (obj.kind === "CallExpr") return program.udtFieldAccessTypes.get(obj);
  // (recv[N]).field류(C637) — 인덱싱은 타입을 바꾸지 않으므로 감싸인 Identifier의 타입을 그대로
  // 재사용(analyzer.ts index-access.ts의 동형 분기와 원칙 동일, scope 체인이 없어 Identifier
  // 한정만 재귀).
  if (obj.kind === "IndexAccess" && obj.obj.kind === "Identifier") return resolveUdtObjectType(obj.obj, program, funcCtx);
  return undefined;
}

// `obj.field := value` — object는 analyzer가 UDT 인스턴스로 확정된 Identifier 또는 DotAccess
// 체인만 허용해뒀으므로(analyzeFieldAssignment, C123 중첩 체이닝 참조) 여기 도달하면 항상 그
// 형태다. 값은 필드 선언 타입에 맞춰 na 리터럴을 재코드젠한다(genUdtValueForFieldType — string/
// color/중첩 UDT 필드는 null, 그 외는 기존 NaN). 값이 제어문-식(if/for/while/switch)이면 genStmt의
// Assignment 분기(genControlFlowAssignment)와 동일한 `let __cfrN = NaN` 임시변수 + 최종 1회 대입
// 뼈대를 그대로 재사용한다(C265 신설, C266에서 자기참조 보존 방식으로 재설계 — target이 슬롯/
// 변수명 대신 `obj.field` 프로퍼티 접근 문자열이라는 점만 다르다. obj는 analyzer가 부작용 없는
// Identifier/DotAccess로 제한해뒀으므로 최종 대입에서 1회 평가로 충분하다).
function genFieldAssignment(stmt: FieldAssignment, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const typeName = resolveUdtObjectType(stmt.object, program, funcCtx);
  if (typeName === undefined) {
    throw new Error("internal: FieldAssignment.object는 UDT 인스턴스로 확정돼야 함 (analyzer 통과 후 발생 불가)");
  }
  const typeInfo = program.udtTypes.get(typeName)!;
  const field = typeInfo.fields.find((f) => f.name === stmt.field);
  if (!field) throw new Error(`internal: '${typeName}'에 없는 필드 '${stmt.field}' (analyzer 통과 후 발생 불가)`);
  const objCode = genExpr(stmt.object, program, funcCtx);
  const target = `${objCode}.${stmt.field}`;
  if (isControlFlowExpr(stmt.value)) {
    return genControlFlowExprValue(stmt.value, program, funcCtx, (temp) => `${target} = ${temp};`);
  }
  // 복합 대입 데슈가링(`obj.field /= switch ...`) — hoistBinOpControlFlowOperands 주석 참조.
  if (stmt.value.kind === "BinOp" && (isControlFlowExpr(stmt.value.left) || isControlFlowExpr(stmt.value.right))) {
    const { pre: cfPre, code: cfCode } = hoistBinOpControlFlowOperands(stmt.value, program, funcCtx);
    return `${cfPre}\n${target} = ${cfCode};`;
  }
  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.value, program, funcCtx, pre);
  const valueCode = genUdtValueForFieldType(stmt.value, field.typeHint, program, funcCtx);
  return withLazyPrelude(pre, `${target} = ${valueCode};`);
}

// [a, b] = f() — Assignment의 '=' 로컬과 동일한 var/let/승격 규칙(top-level은 var, 중첩 블록은
// let, 프리앰블 승격 시 맨몸 구조 분해 대입 — 승격은 튜플 전체 단위라 이름 일부만 선언이 빠지는
// 경우가 없다, collectPreambleLocals 참조). f()는 analyzer가 이미 튜플 반환 UDF 호출임을
// 검증했으므로 genExpr(stmt.value)가 그대로 `fnName(slotBase, ...)` 콜을 내고, 그 반환값(JS
// 배열)을 네이티브 구조 분해로 받는다.
// analyzer는 '_' 플레이스홀더의 문장 내 반복을 허용하지만(analyzeTupleDestructure 참조), 첫
// 번째를 뺀 나머지를 그대로 두면 이 문장이 방출하는 단일 var/let 목록 또는 배열 구조분해 패턴
// 안에 동일 식별자가 두 번 나타나 `let _ = a, _ = b;`/`let [_, _] = arr;` 둘 다 JS SyntaxError다
// (`var`는 재선언을 허용해 무해하지만 nested(함수 본문)는 let이라 방식과 무관하게 항상 안전한
// 쪽을 택함). 첫 '_'는 scope 등록과 일치시키기 위해 이름을 유지하고, 두 번째부터는 유일한 임시
// 이름으로 치환한다 — 그 값은 정의상 버려지므로 이름이 달라져도 시맨틱에 영향 없다. genTupleDestructure/
// genSwitchTupleDestructure(switch-튜플, C410) 공용.
function computeTupleTargetNames(stmt: TupleDestructure): string[] {
  let underscoreSeen = false;
  return stmt.names.map((n) => {
    if (n !== "_") return safeLocalName(n);
    if (!underscoreSeen) {
      underscoreSeen = true;
      return n;
    }
    const temp = `__tupleDiscard${tupleDiscardCounter}`;
    tupleDiscardCounter += 1;
    return temp;
  });
}

// C535: UDF 본문 '[a,b]=f()' 대상 이름의 히스토리 record 주입 — genStmt Assignment 분기의
// histRecord(funcCtx.localHistKinds.get(stmt.name)==="local")와 정확히 같은 조건/타이밍을 이름별로
// 반복 적용한다. analyzer가 eqLocalNames/tupleEqLocalNames를 상호 배타로 등록해두므로(analyzeAssignment/
// analyzeTupleDestructure의 histShadowedNames 충돌 검사) localHistKinds에 "local"로 잡힌 이름은 이
// TupleDestructure 문장이 유일한 선언 자리임이 보장된다 — 별도 tupleEqLocalNames 조회 없이 재사용 가능.
// 원본 stmt.names(분석기 키)와 codegenNames(safeLocalName 적용, 인덱스 대응)를 나란히 순회한다.
// C719: drawing 핸들 값을 받은 튜플 원소는 localHistKinds가 아니라 localRefHistKinds "local"로
// 등록되므로(index-access.ts, localHistSlots와 상호 배타) 별도 물리 배열($.refHistSlots)에 기록 —
// genStmt Assignment 분기(1552행 부근)의 동일 두 갈래와 같은 원칙.
// C748: script top-level 중첩 블록(funcCtx===null, program.ambiguousNestedTupleHistDeclSlots/
// ambiguousNestedTupleRefDeclSlots — analyzer.ts C748 분기가 stmt.value.kind==="CallExpr"일 때만
// 등록해두므로 다른 값 형태는 두 맵 모두 미조회로 자연히 스킵됨) 판도 같은 same-site 타이밍으로 여기서
// 함께 처리한다 — depth-0(JS `var`, 바-종료 루프가 커버)는 이 두 맵에 등록되지 않아 항상 빈 문자열.
function genFuncTupleHistRecords(
  stmt: TupleDestructure,
  codegenNames: readonly string[],
  funcCtx: FuncGenContext | null,
  program: AnalyzedProgram,
): string {
  const parts: string[] = [];
  if (funcCtx === null) {
    const histSlots = program.ambiguousNestedTupleHistDeclSlots.get(stmt);
    const refSlots = program.ambiguousNestedTupleRefDeclSlots.get(stmt);
    stmt.names.forEach((name, i) => {
      const histSlot = histSlots?.get(name);
      const refSlot = refSlots?.get(name);
      if (histSlot !== undefined) {
        parts.push(`$.histSlots[${histSlot}].record(${codegenNames[i]});`);
      } else if (refSlot !== undefined) {
        parts.push(`$.refHistSlots[${refSlot}].record(${codegenNames[i]});`);
      }
    });
    return parts.length > 0 ? "\n" + parts.join("\n") : "";
  }
  stmt.names.forEach((name, i) => {
    if (funcCtx.localHistKinds.get(name) === "local") {
      parts.push(`$.histSlots[__histBase + ${funcCtx.localHistSlots.get(name)}].record(${codegenNames[i]});`);
    } else if (funcCtx.localRefHistKinds.get(name) === "local") {
      parts.push(`$.refHistSlots[__refHistBase + ${funcCtx.localRefHistSlots.get(name)}].record(${codegenNames[i]});`);
    }
  });
  return parts.length > 0 ? "\n" + parts.join("\n") : "";
}

// 이 문장 이전에 같은 let-스코프에서 이미 선언된 이름이 섞여 있으면(findRedeclaredAssignments
// tupleSeen, C365 — wild 476323868c34 `[_, a] = f()` 뒤 `[_, b] = g()` invalid_js 실측) 문장
// 전체를 `let [...]`로 내릴 수 없다(기선언 이름의 let 재선언 SyntaxError). 아직 선언 안 된
// 이름(+ '_' 치환 임시명은 항상 신규)만 선행 let으로 선언하고 패턴 자체는 맨몸 배열 구조분해
// 대입으로 내린다 — promoted 경로(아래)가 이미 같은 맨몸 패턴을 쓰므로 문법 형태는 검증된 것.
// genTupleDestructure/genSwitchTupleDestructure 공용.
function computeTupleRedeclPrefix(
  stmt: TupleDestructure,
  names: string[],
  alreadySeen: ReadonlySet<string> | null,
): string | null {
  const newDeclNames = alreadySeen === null || alreadySeen.size === 0
    ? null
    : names.filter((m, i) => m !== stmt.names[i] || !alreadySeen.has(stmt.names[i]!));
  return newDeclNames === null ? null : newDeclNames.length > 0 ? `let ${newDeclNames.join(", ")};\n` : "";
}

function genTupleDestructure(
  stmt: TupleDestructure,
  program: AnalyzedProgram,
  nested: boolean,
  funcCtx: FuncGenContext | null,
  promoted: ReadonlySet<string> | null,
  alreadySeen: ReadonlySet<string> | null = null,
): string {
  // switch/if 각 분기가 튜플 값(TupleExpr 리터럴/ta.* 다중반환/request.security 튜플/UDF tupleArity
  // 일치 콜, C508부터 삼항과 동일 4종)으로 끝나는 폼(C410 switch / C411 if — 형제 폼,
  // analyzeSwitchTupleValue/analyzeIfTupleValue가 이미 검증) — 분기별로 직접 N개 임시변수에
  // 대입하는 형태라 이 함수의 나머지(비-lazy 콜 전제의 hoistLazyStatefulCalls/genExpr(stmt.value))를
  // 전혀 타지 않고 완전히 별도로 처리한다(genExpr의 SwitchStmt/IfStmt case는 애초에 "제어문-식은
  // var/대입문 값 위치에서만 지원" 내부 에러용 안전장치라 호출하면 안 됨).
  if (stmt.value.kind === "SwitchStmt") {
    return genSwitchTupleDestructure(stmt, stmt.value, program, nested, funcCtx, promoted, alreadySeen);
  }
  if (stmt.value.kind === "IfStmt") {
    return genIfTupleDestructure(stmt, stmt.value, program, nested, funcCtx, promoted, alreadySeen);
  }
  // switch/if-튜플의 세 번째 형제 폼(C416, `[a,b]=cond ? valA : valB`) — analyzer가 각 분기의
  // "튜플 반환 값"을 이미 검증했다(analyzeTernaryTupleValue). switch/if와 달리 분기가 문장 블록이
  // 아니라 단일 표현식이라 전용 진입점으로 분리.
  if (stmt.value.kind === "TernaryOp") {
    return genTernaryTupleDestructure(stmt, stmt.value, program, nested, funcCtx, promoted, alreadySeen);
  }
  // C631: `[a, b] = [e1, e2]` 직접 튜플 리터럴 값(analyzer resolveTupleValueBranch TupleExpr 케이스가
  // 이미 검증). genExpr는 TupleExpr를 codegen 못 함(값 위치 하드 에러 케이스, "internal: TupleExpr는
  // 함수 반환 위치 전용")이라 여기서 원소별로 직접 genExpr해 JS 배열 리터럴 문자열을 조립한 뒤 네이티브
  // 배열 구조분해 대입으로 내린다 — RHS 배열 리터럴 전체가 먼저 평가되고 나서 각 이름에 분해되므로
  // (Python 튜플 언팩과 동형) `[a, b] = [b, a]`류 스왑도 원소별 순차 대입과 달리 안전하게 처리된다.
  if (stmt.value.kind === "TupleExpr") {
    const elems = stmt.value.elements;
    const pre: string[] = [];
    elems.forEach((el) => hoistLazyStatefulCalls(el, program, funcCtx, pre));
    const valueCode = `[${elems.map((el) => genExpr(el, program, funcCtx)).join(", ")}]`;
    const names = computeTupleTargetNames(stmt);
    const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);
    const histRecords = genFuncTupleHistRecords(stmt, names, funcCtx, program);
    if (redeclPrefix !== null) {
      return withLazyPrelude(pre, `${redeclPrefix}[${names.join(", ")}] = ${valueCode};${histRecords}`);
    }
    if (!nested && stmt.names.some((n) => promoted?.has(n))) {
      return withLazyPrelude(pre, `[${names.join(", ")}] = ${valueCode};${histRecords}`);
    }
    return withLazyPrelude(pre, `${nested ? "let" : "var"} [${names.join(", ")}] = ${valueCode};${histRecords}`);
  }
  // C434: request.security_lower_tf(sym, tf, [e1, e2, ...]) 튜플 리터럴 expression
  // (securityLowerTfTupleElemSlots, AnalyzedProgram 주석 참조) — HTF 캐시가 없어 request.security의
  // taScratch 배선(securityTupleCallSlots)을 재사용하지 않는다. 원소마다 독립적으로 genExpr한 뒤
  // pine2py 오라클 규칙(값 1개를 원소 1개짜리 배열로 감싸기, C310 스칼라 케이스를 원소별로 확장)대로
  // 개별 배열 리터럴을 대입한다.
  const securityLowerTfTupleElems =
    stmt.value.kind === "CallExpr" ? program.securityLowerTfTupleElemSlots.get(stmt.value) : undefined;
  if (securityLowerTfTupleElems !== undefined) {
    const pre: string[] = [];
    for (const el of securityLowerTfTupleElems) hoistLazyStatefulCalls(el, program, funcCtx, pre);
    const elemCodes = securityLowerTfTupleElems.map((el) => genExpr(el, program, funcCtx));
    const names = computeTupleTargetNames(stmt);
    const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);
    const reads = names.map((n, i) => `${n} = [${elemCodes[i]}]`);
    if (redeclPrefix !== null) {
      return withLazyPrelude(pre, `${redeclPrefix}${reads.join("; ")};`);
    }
    if (!nested && stmt.names.some((n) => promoted?.has(n))) {
      return withLazyPrelude(pre, `${reads.join("; ")};`);
    }
    return withLazyPrelude(pre, `${nested ? "let" : "var"} ${reads.join(", ")};`);
  }
  // C434: request.security_lower_tf(sym, tf, udfCall()) bare UDF 콜(securityLowerTfBareUdfCallSlots
  // 주석 참조) — udfCall()을 정확히 1회 호출해 임시변수에 담은 뒤, 원소마다 독립적으로 1개짜리
  // 배열로 재포장한다(securityBareUdf(C432)와 달리 값을 그대로 통과시키지 않음 — 위 TupleExpr
  // 분기와 동일한 "원소당 배열 감싸기" 규칙).
  const securityLowerTfBareUdf =
    stmt.value.kind === "CallExpr" ? program.securityLowerTfBareUdfCallSlots.get(stmt.value) : undefined;
  if (securityLowerTfBareUdf !== undefined) {
    const pre: string[] = [];
    hoistLazyStatefulCalls(securityLowerTfBareUdf, program, funcCtx, pre);
    const udfCode = genExpr(securityLowerTfBareUdf, program, funcCtx);
    const names = computeTupleTargetNames(stmt);
    const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);
    const tempName = `__secLtf${secLtfTempCounter}`;
    secLtfTempCounter += 1;
    const declStmt = `let ${tempName} = ${udfCode};`;
    const reads = names.map((n, i) => `${n} = [${tempName}[${i}]]`);
    if (redeclPrefix !== null) {
      return withLazyPrelude(pre, `${declStmt}\n${redeclPrefix}${reads.join("; ")};`);
    }
    if (!nested && stmt.names.some((n) => promoted?.has(n))) {
      return withLazyPrelude(pre, `${declStmt}\n${reads.join("; ")};`);
    }
    return withLazyPrelude(pre, `${declStmt}\n${nested ? "let" : "var"} ${reads.join(", ")};`);
  }
  // C432: request.security(sym, tf, myFunc(...)) bare UDF 콜(securityBareUdfCallSlots, AnalyzedProgram
  // 주석 참조) — HTF 슬롯/프리패스가 아예 없으므로 codegen은 바깥 request.security 노드를 완전히
  // 무시하고 등록해둔 내부 UDF CallExpr에서 곧장 genExpr한다(일반 `[a,b]=myFunc(...)`와 동일 산출물).
  // C433: request.security(sym, tf, ta.macd(...)) bare 다중 반환 ta.* 콜(securityBareTaCallSlots,
  // AnalyzedProgram 주석 참조) — securityBareUdf와 자매 메커니즘, 동일하게 바깥 request.security
  // 노드를 완전히 무시하고 내부 ta.* CallExpr에서 곧장 genExpr한다.
  const securityBareUdf = stmt.value.kind === "CallExpr" ? program.securityBareUdfCallSlots.get(stmt.value) : undefined;
  const securityBareTa = stmt.value.kind === "CallExpr" ? program.securityBareTaCallSlots.get(stmt.value) : undefined;
  const valueSourceExpr = securityBareUdf ?? securityBareTa ?? stmt.value;
  // 값 콜 자체는 비-lazy 위치(호이스팅 안 됨)지만 그 인자 안의 삼항/and·or lazy 위치는 프리루드로
  // 끌어올린다(hoistLazyStatefulCalls 주석 참조).
  const pre: string[] = [];
  hoistLazyStatefulCalls(valueSourceExpr, program, funcCtx, pre);
  const valueCode = genExpr(valueSourceExpr, program, funcCtx);
  const names = computeTupleTargetNames(stmt);
  const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);
  // C535: UDF 본문 튜플 디스트럭처 대상의 히스토리 record — 아래 3개 분기(다중 반환 TA/
  // request.security 튜플/일반 UDF 콜) 모두 이 "names에 최종값이 대입된 직후" 지점에서 동일하게
  // 안전(genFuncTupleHistRecords 주석 참조). 위 3개 security_lower_tf 분기는 원소가 항상 array로
  // 감싸여(analyzer가 kind="array"로 등록) localHistKinds에 아예 안 잡히므로 손대지 않아도 된다.
  const histRecords = genFuncTupleHistRecords(stmt, names, funcCtx, program);
  // securityBareTa일 때는 stateCallSlots가 내부 ta.* 노드(valueSourceExpr)로 등록돼 있다(analyzer.ts
  // analyzeTupleDestructure의 C433 분기 — 바깥 request.security 노드는 stateCallSlots에 없음) —
  // valueSourceExpr로 조회해야 두 경로(plain ta.macd 직접 호출/bareTa wrapped) 모두 커버된다.
  const stateCall = valueSourceExpr.kind === "CallExpr" ? program.stateCallSlots.get(valueSourceExpr) : undefined;
  // C362: 인자 개수 의존 arity(vwap의 returnArityByArgCount)는 콜사이트의 사용자 인자 개수로 판정 —
  // 고정 returnArity 항목(macd/bb 등)은 taCallReturnArity가 그 값을 그대로 돌려줘 동작 불변.
  // (stateCall !== undefined면 valueSourceExpr는 항상 CallExpr이지만 TS 내로잉이 표현식 경계를 못
  // 넘어서 인자 개수만 같은 가드로 별도 추출한다.)
  const stateCallUserArgCount = valueSourceExpr.kind === "CallExpr" ? valueSourceExpr.args.length : 0;
  if (stateCall !== undefined && taCallReturnArity(TA_REGISTRY[stateCall.fn]!, stateCallUserArgCount) !== undefined) {
    // 다중 반환 TA(ta.macd 등): 콜을 문장으로 정확히 1회 실행해 $.taScratch[0..N-1]에 쓰게 한 뒤
    // (valueCode에는 genCallExpr가 이미 $.taScratch 마지막 인자를 붙여 놨다), 각 대상 이름에
    // 인덱스 읽기로 즉시 복사한다. UDF 경로의 네이티브 배열 디스트럭처링을 재사용하지 않는 이유:
    // rt 함수가 배열을 반환하면 bar loop 안 배열 생성이라 GOAL.md "할당 제로" 위반 — 스크래치
    // 기록 + 명시적 인덱스 읽기가 그 원칙의 다중 반환 형태다(analyzer가 arity 일치를 이미 검증).
    const reads = names.map((n, i) => `${n} = $.taScratch[${i}]`);
    if (redeclPrefix !== null) {
      return withLazyPrelude(pre, `${valueCode};\n${redeclPrefix}${reads.join("; ")};${histRecords}`);
    }
    if (!nested && stmt.names.some((n) => promoted?.has(n))) {
      return withLazyPrelude(pre, `${valueCode};\n${reads.join("; ")};${histRecords}`);
    }
    return withLazyPrelude(pre, `${valueCode};\n${nested ? "let" : "var"} ${reads.join(", ")};${histRecords}`);
  }
  const securityTupleCall = stmt.value.kind === "CallExpr" ? program.securityTupleCallSlots.get(stmt.value) : undefined;
  if (securityTupleCall !== undefined) {
    // C306: request.security 튜플 리터럴 expression — 위 stateCall(ta.macd) 분기와 동일 구조.
    // valueCode는 genCallExpr가 이미 $.taScratch[0..N-1]에 쓰는 comma-식으로 방출해뒀다.
    const reads = names.map((n, i) => `${n} = $.taScratch[${i}]`);
    if (redeclPrefix !== null) {
      return withLazyPrelude(pre, `${valueCode};\n${redeclPrefix}${reads.join("; ")};${histRecords}`);
    }
    if (!nested && stmt.names.some((n) => promoted?.has(n))) {
      return withLazyPrelude(pre, `${valueCode};\n${reads.join("; ")};${histRecords}`);
    }
    return withLazyPrelude(pre, `${valueCode};\n${nested ? "let" : "var"} ${reads.join(", ")};${histRecords}`);
  }
  if (redeclPrefix !== null) {
    return withLazyPrelude(pre, `${redeclPrefix}[${names.join(", ")}] = ${valueCode};${histRecords}`);
  }
  if (!nested && stmt.names.some((n) => promoted?.has(n))) {
    return withLazyPrelude(pre, `[${names.join(", ")}] = ${valueCode};${histRecords}`);
  }
  return withLazyPrelude(pre, `${nested ? "let" : "var"} [${names.join(", ")}] = ${valueCode};${histRecords}`);
}

// 최초 if 조건은 analyzer(analyzeIfStmt, C246)가 kind:"condition"을 push하지 않아 stateful 콜이
// 허용된다 — "이 문장에 도달하면 무조건 1회 평가"라 VarDecl/Assignment 값 위치와 동형으로 lazy
// 호이스팅 프리루드를 문장(if 전체) 직전에 안전하게 붙일 수 있다(elif 조건은 여전히 거부라
// hoistLazyStatefulCalls 대상 없음 — 호출해도 no-op).
function genIfStmt(stmt: IfStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.condition, program, funcCtx, pre);
  const branches: string[] = [
    `if (${genExpr(stmt.condition, program, funcCtx)}) ${genBlock(stmt.thenBody, program, [], funcCtx)}`,
  ];
  for (const clause of stmt.elifClauses) {
    branches.push(
      `else if (${genExpr(clause.condition, program, funcCtx)}) ${genBlock(clause.body, program, [], funcCtx)}`,
    );
  }
  if (stmt.elseBody !== null) {
    branches.push(`else ${genBlock(stmt.elseBody, program, [], funcCtx)}`);
  }
  return withLazyPrelude(pre, branches.join(" "));
}

function genWhileStmt(stmt: WhileStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const condCode = genExpr(stmt.condition, program, funcCtx);
  // __whileLimit은 while문마다 자신만의 `{ }` 래핑 블록 안에 선언되므로, 중첩/형제 while 모두
  // 같은 이름을 재사용해도 JS 블록 스코프가 서로 분리해준다 (충돌 없음).
  const loopBody = genBlock(stmt.body, program, ["__whileLimit -= 1;"], funcCtx);
  return `{\nlet __whileLimit = ${LOOP_LIMIT};\nwhile (${condCode} && __whileLimit > 0) ${loopBody}\n}`;
}

// 숫자 range for만 지원(ast.ts ForStmt 참조): `for i = start to end [by step]`.
// start/end/step은 루프 진입 시 단 한 번만 평가된다(while 조건과 달리 반복마다 재평가되지 않음).
// 방향(오름/내림)은 pine2py _gen_for_range_args와 동일한 시맨틱으로 결정하되, Python range()를
// 흉내 내지 않고 JS 네이티브 for(;;)로 직접 내린다(GOAL.md):
//  - step이 컴파일타임에 음수 리터럴로 확정되면 방향은 항상 내림차순으로 고정(start<=end인
//    실제 값과 무관 — start<end이면 자연히 0회 반복됨. pine2py의 range(start, end-1, step) 분기와 동치)
//  - 그 외(step 없음/양수 리터럴/런타임 expr)는 진입 시 start<=end로 방향을 감지하고
//    |step|을 그 방향의 크기로 사용한다(step 없으면 1)
// while과 동일하게 자신만의 `{ }` 블록에 안전 카운터(__forLimit)를 선언해 step이 0이 되는
// 런타임 상황에서도 무한루프를 막는다(GOAL.md 10,000회/bar 제한, ForStmt도 동일 적용).
function genForStmt(stmt: ForStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  // start/end/step은 진입 시 1회 평가되는 for 헤더 표현식(조건식이 아니라 stateful 콜 허용 위치,
  // analyzeForStmt 주석 참조) — 그 안의 lazy 위치는 래핑 블록 선두로 호이스팅한다.
  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.start, program, funcCtx, pre);
  hoistLazyStatefulCalls(stmt.end, program, funcCtx, pre);
  if (stmt.step) hoistLazyStatefulCalls(stmt.step, program, funcCtx, pre);
  const preCode = pre.length === 0 ? "" : `${pre.join("\n")}\n`;
  const startCode = genExpr(stmt.start, program, funcCtx);
  const endCode = genExpr(stmt.end, program, funcCtx);
  const v = safeLocalName(stmt.varName);
  const loopBody = genBlock(stmt.body, program, ["__forLimit -= 1;"], funcCtx);
  const literalStep = stmt.step ? literalStepValue(stmt.step) : null;

  if (stmt.step !== null && literalStep !== null && literalStep < 0) {
    const stepCode = genExpr(stmt.step, program, funcCtx);
    return (
      `{\n${preCode}let __forStart = ${startCode};\nlet __forEnd = ${endCode};\nlet __forLimit = ${LOOP_LIMIT};\n` +
      `for (let ${v} = __forStart; ${v} >= __forEnd && __forLimit > 0; ${v} += (${stepCode})) ${loopBody}\n}`
    );
  }

  const stepCode = stmt.step ? genExpr(stmt.step, program, funcCtx) : "1";
  return (
    `{\n${preCode}let __forStart = ${startCode};\nlet __forEnd = ${endCode};\nlet __forStep = ${stepCode};\n` +
    `let __forFwd = __forStart <= __forEnd;\n` +
    `let __forDelta = __forFwd ? Math.abs(__forStep) : -Math.abs(__forStep);\n` +
    `let __forLimit = ${LOOP_LIMIT};\n` +
    `for (let ${v} = __forStart; (__forFwd ? ${v} <= __forEnd : ${v} >= __forEnd) && __forLimit > 0; ${v} += __forDelta) ${loopBody}\n}`
  );
}

// for-in 루프(C216) — analyzer(resolveForInIterableKind)가 확정한 컨테이너 종류로 정적으로
// 분기한다(pine2py _gen_for_in의 런타임 isinstance(dict) 분기와 달리 JS는 제네릭 이터레이션
// 프로토콜로 array/map 어느 쪽이든 `for...of`가 되지만, GOAL.md "bar loop 안 할당 제로" 원칙상
// array는 이터레이터 객체를 새로 만들지 않는 인덱스 for로 데슈가링하고(genForStmt와 동일 기조),
// map은 이미 참조형 JS Map(rt.map.new — map.ts 주석 참조)이라 네이티브 for...of(entries/keys)를
// 그대로 재사용한다(추가 자료구조 할당 없음).
// 이터러블이 na(null)면 0회 순회로 안전 처리한다(GOAL.md #19 "읽기는 na 안전" 원칙의 루프 버전) —
// pine2py는 `for v in None`이 크래시하지만, 이 조합은 pine2py 자신의 `var array<float> x = na`가
// array 타입 힌트를 무시하고 스칼라 na로 컴파일하는 latent 버그 경로에서만 나온다(python 직접
// 실행으로 확인, C216) — GOAL.md "알려진 버그는 따르지 않는다" 적용.
function genForInStmt(stmt: ForInStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const kind = program.forInKinds.get(stmt);
  if (kind === undefined) throw new Error("internal: ForInStmt kind missing (analyzer가 항상 먼저 채움)");

  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.iterable, program, funcCtx, pre);
  const preCode = pre.length === 0 ? "" : `${pre.join("\n")}\n`;
  const iterCode = genExpr(stmt.iterable, program, funcCtx);

  if (kind === "array" || kind === "matrix") {
    // indexName이 없으면(`for v in arr`) 내부 전용 카운터를 쓴다 — 다른 for(-in) 임시변수(__forStart
    // 등)와 동일하게 자기 자신의 `{ }` 블록에 갇혀 중첩/형제 for-in과 충돌하지 않는다(JS let 블록
    // 스코프, genForStmt와 동일 관례).
    // __forInLen을 루프 진입 전 한 번만 캡처하면 안 된다: 본문이 array.remove() 등으로 같은
    // 배열을 in-place로 줄이면(splice) 캡처된 길이가 실제 길이보다 커져 `__forInArr[idx]`가
    // undefined를 반환해 `p.field` 역참조가 크래시한다(C577). pine2py는 Python `for x in list`를
    // 그대로 이식하는데, CPython 리스트 이터레이터는 매 스텝 **현재** len(list)를 재확인하므로
    // 원소가 밀려도 크래시 없이 (한 원소를 건너뛰는) 동일 결과로 well-defined하다 — `.length`를
    // 조건식에서 매번 재평가해 이 재확인 시맨틱을 literal port한다.
    // C709: matrix도 완전히 동일한 코드 모양(PineMatrix가 이미 unknown[][], 행 = 원소 -- 별도
    // rt.matrix.row() 호출 없이 네이티브 인덱싱으로 충분, add_row/remove_row 중 in-place 변형도
    // 위와 동일한 이유로 `.length` 매 반복 재평가가 그대로 커버).
    const idx = stmt.indexName !== null ? safeLocalName(stmt.indexName) : "__forInIdx";
    // seedNames=varName(C599): 본문 직속 '='가 루프 변수를 재선언하는 wild 관용구(`tf = str.trim(tf)`)
    // 가 같은 블록 `let` 이중 선언 SyntaxError를 내던 것을 맨몸 재대입으로 내린다(genBlock 주석 참조).
    const loopBody = genBlock(stmt.body, program, [`let ${safeLocalName(stmt.varName)} = __forInArr[${idx}];`], funcCtx, new Set([stmt.varName]));
    return (
      `{\n${preCode}let __forInArr = ${iterCode};\n` +
      `for (let ${idx} = 0; __forInArr !== null && ${idx} < __forInArr.length; ${idx}++) ${loopBody}\n}`
    );
  }

  // map: indexName이 있으면 `[key, val] in map`(entries), 없으면 `val in map`은 pine2py가
  // Python dict 이터레이션 그대로 키만 순회한다(literal port, C216 — 코퍼스 실사용 0건이나 완전성
  // 위해 구현).
  const safeVarName = safeLocalName(stmt.varName);
  const bindings = stmt.indexName !== null ? `[${safeLocalName(stmt.indexName)}, ${safeVarName}]` : safeVarName;
  const source = stmt.indexName !== null ? "entries" : "keys";
  const loopBody = genBlock(stmt.body, program, [], funcCtx);
  return (
    `{\n${preCode}let __forInMap = ${iterCode};\n` +
    `if (__forInMap !== null) {\nfor (const ${bindings} of __forInMap.${source}()) ${loopBody}\n}\n}`
  );
}

// step이 컴파일타임에 알려진 리터럴 숫자면 그 값을, 아니면(런타임 expr) null을 반환한다
// (pine2py CodeGen._try_int 이식 — 부호 있는 리터럴(UnaryOp('-', NumberLiteral))까지 인식).
function literalStepValue(step: Expr): number | null {
  if (step.kind === "NumberLiteral") return step.value;
  if (step.kind === "UnaryOp" && step.op === "-" && step.operand.kind === "NumberLiteral") {
    return -step.operand.value;
  }
  return null;
}

// subject가 있으면 진입 시 단 한 번만 평가해 임시변수(__switchSubject)에 담고 각 case 값과
// 비교, 없으면 각 case 값 자체가 boolean 조건인 if/else-if 체인으로 내린다(GOAL.md 제어문
// 임시변수 방식과 동일 원칙). default(bare '=>')는 소스상 위치와 무관하게 항상 마지막으로 옮겨
// JS if/else-if 체인에서 `else` 뒤에 `else if`가 오는 문법 오류를 방지한다(pine2py
// _reorder_switch_cases와 동일 시맨틱 — "매치하는 case가 없을 때"라는 의미는 순서와 무관).
function genSwitchStmt(stmt: SwitchStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const lines: string[] = [];
  let subjectVar: string | null = null;
  if (stmt.subject !== null) {
    // subject는 진입 시 1회 평가(조건식 아님 — analyzeSwitchStmt 주석 참조): 그 안의 lazy 위치는
    // subject 임시변수 선언 앞으로 호이스팅한다. case 값은 condition 위치라 호이스팅 대상 없음.
    hoistLazyStatefulCalls(stmt.subject, program, funcCtx, lines);
    subjectVar = "__switchSubject";
    lines.push(`let ${subjectVar} = ${genExpr(stmt.subject, program, funcCtx)};`);
  }

  const cases = reorderSwitchCases(stmt.cases);
  const branches = cases.map((c, i) => {
    if (c.values === null) {
      return i === 0 ? `if (true) ${genBlock(c.body, program, [], funcCtx)}` : `else ${genBlock(c.body, program, [], funcCtx)}`;
    }
    const test = genSwitchCaseTest(subjectVar, c.values, program, funcCtx);
    return `${i === 0 ? "if" : "else if"} (${test}) ${genBlock(c.body, program, [], funcCtx)}`;
  });

  return `{\n${[...lines, ...branches].join("\n")}\n}`;
}

function reorderSwitchCases(cases: SwitchCase[]): SwitchCase[] {
  const nonDefault = cases.filter((c) => c.values !== null);
  const defaults = cases.filter((c) => c.values === null);
  return [...nonDefault, ...defaults];
}

function genSwitchCaseTest(
  subjectVar: string | null,
  values: Expr[],
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  return values
    .map((v) => {
      if (subjectVar === null) return genExpr(v, program, funcCtx);
      // `subject == na`와 동일 원리 — NaN===NaN이 false이므로 na case 값은 rt.na로 우회
      if (v.kind === "NaLiteral") return `rt.na(${subjectVar})`;
      // C812: subject == case 값 비교도 genEquality와 같은 rt.pineEq로 — `switch b[1]`의 subject가
      // 히스토리 슬롯을 왕복한 bool(1/0)이면 `__switchSubject === true`가 false라 매칭 arm을 건너뛰고
      // default로 떨어지던 같은 조용한 오답이었다(실측 확인, numeric.ts pineEq 주석 참조).
      return `rt.pineEq(${subjectVar}, ${genExpr(v, program, funcCtx)})`;
    })
    .join(" || ");
}

// seedNames(C599): prefixLines가 이미 이 블록 스코프에 `let <이름>`으로 선언해 둔 이름 집합 —
// for-in(array) 루프 변수(`let v = __forInArr[idx]`)가 유일한 사용처. 본문 직속 '='가 같은 이름을
// 다시 선언하면(`for tf in a` + `tf = str.trim(tf)`, wild 96697dead9 실측 invalid_js) 같은 블록
// `let` 이중 선언 SyntaxError였다 — genFuncBody의 매개변수 seedNames(C319)와 동일 원리로 맨몸
// 재대입으로 내린다(pine2py는 Python 평면 재대입이라 시맨틱 동일 — 루프 헤드가 매 반복
// `__forInArr[idx]`를 다시 읽어 다음 반복에 오염 없음). 주의: for-head 괄호 스코프 바인딩(range
// 카운터/map kind의 const [k,v])은 body 블록과 스코프가 달라 shadow `let`이 합법이고, 특히 map
// kind는 const라 맨몸 대입으로 내리면 오히려 TypeError — 시드 대상은 array kind varName뿐이다.
function genBlock(
  body: Stmt[],
  program: AnalyzedProgram,
  prefixLines: string[],
  funcCtx: FuncGenContext | null,
  seedNames: ReadonlySet<string> = new Set(),
): string {
  const redeclared = findRedeclaredAssignments(body, seedNames);
  const lines: string[] = [...prefixLines];
  for (const stmt of body) {
    const line = genStmt(stmt, program, /* nested */ true, funcCtx, null, redeclared);
    if (line) lines.push(line);
  }
  return `{\n${lines.join("\n")}\n}`;
}

// 재대입(':=') 대상 저장 위치를 식별자 이름 하나로부터 계산 — UDF 로컬 슬롯 > 전역 var 슬롯 >
// 바깥 스코프의 '=' 로컬(analyzer가 이미 검증 완료) 순으로 동일하게 우선한다(genIdentifier와
// 같은 우선순위, 기존 Assignment ':=' 분기에서 그대로 추출한 헬퍼 — 동작 변경 없음).
function resolveAssignTarget(
  name: string,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  assignStmt: Assignment | null = null,
): string {
  // C728: 중첩 top-level var(depth>0) ':=' 재대입 — analyzer가 이 Assignment 노드 자신에 이미
  // 확정해둔 슬롯을 그대로 쓴다(scope 정보 없이 codegen이 재해석할 필요 없음, analyzer.ts
  // nestedVarAssignSlots 주석 참조). funcCtx 우선순위보다도 먼저 확인해도 안전 — 이 축은
  // func===null 전용이라(analyzeAssignment) funcCtx!==null이면 이 맵에 애초에 없다.
  if (assignStmt !== null) {
    const nestedSlot = program.nestedVarAssignSlots.get(assignStmt);
    if (nestedSlot !== undefined) return `$.vars[${nestedSlot}]`;
    // C729(배치37(2) 2차 슬라이스): 이 ':='가 var보다 가까운 '=' 섀도를 재대입하면(analyzer.ts
    // eqLocalShadowedVarAssigns 주석 참조) 아래 program.varIndex 우선조회를 건너뛰고 그 섀도의
    // bare 식별자를 직접 대상으로 삼는다.
    if (program.eqLocalShadowedVarAssigns.has(assignStmt)) return safeLocalName(name);
  }
  if (funcCtx) {
    const localSlot = funcCtx.localVarIndex.get(name);
    if (localSlot !== undefined) return `$.fnVars[__slotBase + ${localSlot}]`;
    // C414: genIdentifier와 동일한 우선순위 수정 — 매개변수가 top-level var와 이름이 같아도
    // ':=' 재대입 대상은 그 매개변수 자신이어야 한다(파라미터는 Pine에서 본문 안 재대입 가능한
    // 일반 지역값).
    if (funcCtx.paramNames.has(name)) return safeLocalName(name);
    // C568: 위와 동일한 이유로 func-local '=' 로컬(선언된 뒤 ':='로 재대입되는 경우)도 top-level
    // var보다 먼저 확인 — genIdentifier의 동형 분기 주석 참조.
    if (funcCtx.bodyLocalNames.has(name)) return safeLocalName(name);
  }
  const slot = program.varIndex.get(name);
  if (slot !== undefined) return `$.vars[${slot}]`;
  return safeLocalName(name);
}

// Assignment 값이 제어문-식일 때: GOAL.md "제어문-식은 임시변수+제어문으로"(IIFE 금지) —
// `let __cfrN = NaN` 임시변수에 매치된 분기의 마지막 표현식을 담은 뒤 마지막에 1회만 target에
// 대입한다(아무 분기도 매치하지 않으면 na — cfrTempCounter 주석 참조. target 선대입이 아니라
// 임시변수를 거치는 이유: 분기 값 표현식이 target 자신을 읽는 자기참조 조합에서 이전 값을
// 보존해야 한다, C266. C10 등 기존 '=' 신규 로컬/':=' 재대입 규칙은 최종 대입 줄에 그대로 재사용).
function genControlFlowAssignment(
  stmt: Assignment,
  value: ControlFlowExpr,
  program: AnalyzedProgram,
  nested: boolean,
  funcCtx: FuncGenContext | null,
  promoted: ReadonlySet<string> | null,
  redeclared: RedeclareInfo | null = null,
): string {
  if (stmt.operator === ":=") {
    const target = resolveAssignTarget(stmt.name, program, funcCtx, stmt);
    return genControlFlowExprValue(value, program, funcCtx, (temp) => `${target} = ${temp};`);
  }
  // 프리앰블 승격된 top-level '=' 로컬은 선언 키워드 없이 대입한다(genStmt Assignment 분기와
  // 동일 규칙 — 선언은 프리앰블 담당). 중첩 '=' 로컬(let)이 바깥 동명 변수를 값 표현식에서 읽는
  // 조합은 JS TDZ로 크래시할 수 있으나 이는 비-제어문-식 '=' 경로(`let x = <x 참조 식>;`)와 동일한
  // 기존 한계다(자기 이름 참조가 없는 일반 섀도잉은 안전 — C5). nested 블록 안에서 같은 이름이
  // 이미 '='로 선언된 뒤라면(findRedeclaredAssignments, C319) 두 번째 `let`은 JS SyntaxError라
  // 선언 키워드를 생략한다(genStmt Assignment 분기의 redeclared 처리와 동일 원칙).
  const decl = (!nested && promoted?.has(stmt.name)) || redeclared?.assigns.has(stmt) ? "" : nested ? "let " : "var ";
  return genControlFlowExprValue(value, program, funcCtx, (temp) => `${decl}${safeLocalName(stmt.name)} = ${temp};`);
}

// 제어문-식 값 생성의 공용 뼈대(C266): `let __cfrN = NaN;` + 분기들이 __cfrN에 결과를 담는 제어문
// + finalLine(temp)가 만드는 최종 대입 1줄. 모든 소비처(VarDecl/Assignment/FieldAssignment)가
// 이 모양을 공유한다 — target이 분기 실행 중에는 절대 쓰이지 않으므로 분기 값 표현식이 target을
// 읽어도 항상 대입 이전 값을 본다.
function genControlFlowExprValue(
  value: ControlFlowExpr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  finalLine: (temp: string) => string,
): string {
  const temp = `__cfr${cfrTempCounter}`;
  cfrTempCounter += 1;
  return `let ${temp} = NaN;\n${genControlFlowBranches(temp, value, program, funcCtx)}\n${finalLine(temp)}`;
}

function genControlFlowBranches(
  target: string,
  node: ControlFlowExpr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  switch (node.kind) {
    case "IfStmt":
      return genIfWithResult(target, node, program, funcCtx);
    case "WhileStmt":
      return genWhileWithResult(target, node, program, funcCtx);
    case "ForStmt":
      return genForWithResult(target, node, program, funcCtx);
    case "SwitchStmt":
      return genSwitchWithResult(target, node, program, funcCtx);
  }
}

// 복합 대입 데슈가링(`disp /= switch i ...` -> Assignment{value: BinOp{op:"/", left: disp,
// right: SwitchStmt}}, parser.ts COMPOUND_ASSIGN_OPS + analyzer.ts isControlFlowValueKind)이 만드는
// 형태를 위한 codegen 대응. VarDecl/Assignment/FieldAssignment 값이 직접 제어문-식이면
// genControlFlowExprValue를 쓰지만, 이 형태는 BinOp 한 겹 아래 있어 그 헬퍼로 못 잡는다 — 좌/우
// 피연산자 중 제어문-식인 쪽만 각각 `__cfrN` 임시변수로 호이스팅(genControlFlowBranches 재사용)한 뒤,
// 최종 식 문자열을 직접 조립해 반환한다(합성 Identifier AST 노드를 만들어 genExpr에 재투입하는
// 방식은 시도했으나 genIdentifier가 program.locals/funcCtx 등록 여부를 검증해 "알 수 없는 식별자"로
// 크래시함 — 임시변수는 애초에 그 표들에 없으므로 문자열을 직접 짜맞추는 이 방식이 맞다). analyzer가
// isControlFlowValueKind로 허용하는 op는 COMPOUND_ASSIGN_OPS와 동일한 산술 5종(+,-,*,/,%)뿐이라
// genBinOp 전체(==/!=/비교/and·or의 na-세이프 우회, genEquality 등)를 재구현할 필요가 없다 —
// 제어문-식 피연산자는 inferNumType이 "unknown"으로 떨어져(analyzer.ts) idiv/concat 특수분기 대상이
// 될 수 없으므로 항상 기본 분기(rt.pineDiv/rt.pineMod, `+`/`-`/`*`는 그대로)와 동일하다.
function hoistBinOpControlFlowOperands(
  value: BinOp,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): { pre: string; code: string } {
  const preParts: string[] = [];
  const operandCode = (operand: Expr): string => {
    if (!isControlFlowExpr(operand)) return genExpr(operand, program, funcCtx);
    const temp = `__cfr${cfrTempCounter}`;
    cfrTempCounter += 1;
    preParts.push(`let ${temp} = NaN;\n${genControlFlowBranches(temp, operand, program, funcCtx)}`);
    return temp;
  };
  const l = operandCode(value.left);
  const r = operandCode(value.right);
  const pre = preParts.join("\n");
  switch (value.op) {
    case "+":
      return { pre, code: `(${l} + ${r})` };
    case "-":
      return { pre, code: `(${l} - ${r})` };
    case "*":
      return { pre, code: `(${l} * ${r})` };
    case "/":
      return { pre, code: `rt.pineDiv(${l}, ${r})` };
    case "%":
      return { pre, code: `rt.pineMod(${l}, ${r})` };
    default:
      throw new Error(`internal: 제어문-식 피연산자 BinOp에 지원하지 않는 연산자 '${value.op}' (analyzer 통과 후 발생 불가)`);
  }
}

// genBlock과 동일하나, 블록의 마지막 문장이 ExprStmt면 `target = <값>;`으로 덮어써 그 분기의
// 결과를 담는다(그 외 마지막 문장 종류는 genReturnBody와 달리 재귀 특별 취급 없이 그냥 실행만
// 하고 target은 이전 값 그대로 유지 — pine2py _gen_body_with_result와 동일 범위, 분기 본문 안에
// 중첩된 if/switch를 마지막 문장으로 쓴 결과 전파는 범위 밖(LIMITATIONS.md 참조)).
function genBodyWithResult(
  target: string,
  body: Stmt[],
  prefixLines: string[],
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  const lines: string[] = [...prefixLines];
  if (body.length === 0) return `{\n${lines.join("\n")}\n}`;
  for (const stmt of body.slice(0, -1)) {
    const line = genStmt(stmt, program, /* nested */ true, funcCtx);
    if (line) lines.push(line);
  }
  const last = body[body.length - 1]!;
  if (last.kind === "ExprStmt") {
    // 마지막 표현식은 genStmt를 거치지 않고 직접 렌더링하므로 lazy 호이스팅도 여기서 직접 건다
    // (if-표현식 분기 본문의 `cond ? ta.sma(...) : x` 같은 조합 — hoistLazyStatefulCalls 주석 참조).
    const pre: string[] = [];
    hoistLazyStatefulCalls(last.expr, program, funcCtx, pre);
    for (const p of pre) lines.push(p);
    lines.push(`${target} = ${genExpr(last.expr, program, funcCtx)};`);
  } else {
    const line = genStmt(last, program, /* nested */ true, funcCtx);
    if (line) lines.push(line);
  }
  return `{\n${lines.join("\n")}\n}`;
}

// genIfStmt와 동일한 분기 구조이나 각 분기 본문이 genBodyWithResult를 거쳐 target에 결과를 담는다.
// 최초 조건의 lazy 호이스팅도 genIfStmt와 동일 근거로 동일하게 적용(C246).
function genIfWithResult(target: string, stmt: IfStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.condition, program, funcCtx, pre);
  const branches: string[] = [
    `if (${genExpr(stmt.condition, program, funcCtx)}) ${genBodyWithResult(target, stmt.thenBody, [], program, funcCtx)}`,
  ];
  for (const clause of stmt.elifClauses) {
    branches.push(
      `else if (${genExpr(clause.condition, program, funcCtx)}) ${genBodyWithResult(target, clause.body, [], program, funcCtx)}`,
    );
  }
  if (stmt.elseBody !== null) {
    branches.push(`else ${genBodyWithResult(target, stmt.elseBody, [], program, funcCtx)}`);
  }
  return withLazyPrelude(pre, branches.join(" "));
}

// genWhileStmt와 동일한 __whileLimit 안전 카운터 패턴이나 본문이 genBodyWithResult를 거친다 —
// 마지막으로 실행된 반복의 마지막 표현식이 결과(반복이 한 번도 안 돌면 target은 NaN 그대로).
function genWhileWithResult(target: string, stmt: WhileStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const condCode = genExpr(stmt.condition, program, funcCtx);
  const loopBody = genBodyWithResult(target, stmt.body, ["__whileLimit -= 1;"], program, funcCtx);
  return `{\nlet __whileLimit = ${LOOP_LIMIT};\nwhile (${condCode} && __whileLimit > 0) ${loopBody}\n}`;
}

// genForStmt와 동일한 3-분기 방향 시맨틱이나 본문이 genBodyWithResult를 거친다 — 마지막 반복의
// 마지막 표현식이 결과(0회 반복이면 target은 NaN 그대로).
function genForWithResult(target: string, stmt: ForStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  // genForStmt와 동일한 for 헤더 lazy 호이스팅(그쪽 주석 참조).
  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.start, program, funcCtx, pre);
  hoistLazyStatefulCalls(stmt.end, program, funcCtx, pre);
  if (stmt.step) hoistLazyStatefulCalls(stmt.step, program, funcCtx, pre);
  const preCode = pre.length === 0 ? "" : `${pre.join("\n")}\n`;
  const startCode = genExpr(stmt.start, program, funcCtx);
  const endCode = genExpr(stmt.end, program, funcCtx);
  const v = safeLocalName(stmt.varName);
  const loopBody = genBodyWithResult(target, stmt.body, ["__forLimit -= 1;"], program, funcCtx);
  const literalStep = stmt.step ? literalStepValue(stmt.step) : null;

  if (stmt.step !== null && literalStep !== null && literalStep < 0) {
    const stepCode = genExpr(stmt.step, program, funcCtx);
    return (
      `{\n${preCode}let __forStart = ${startCode};\nlet __forEnd = ${endCode};\nlet __forLimit = ${LOOP_LIMIT};\n` +
      `for (let ${v} = __forStart; ${v} >= __forEnd && __forLimit > 0; ${v} += (${stepCode})) ${loopBody}\n}`
    );
  }

  const stepCode = stmt.step ? genExpr(stmt.step, program, funcCtx) : "1";
  return (
    `{\n${preCode}let __forStart = ${startCode};\nlet __forEnd = ${endCode};\nlet __forStep = ${stepCode};\n` +
    `let __forFwd = __forStart <= __forEnd;\n` +
    `let __forDelta = __forFwd ? Math.abs(__forStep) : -Math.abs(__forStep);\n` +
    `let __forLimit = ${LOOP_LIMIT};\n` +
    `for (let ${v} = __forStart; (__forFwd ? ${v} <= __forEnd : ${v} >= __forEnd) && __forLimit > 0; ${v} += __forDelta) ${loopBody}\n}`
  );
}

// genSwitchStmt와 동일한 subject 1회 평가 + default 재정렬이나 각 case 본문이 genBodyWithResult를
// 거친다 — 매치된 case의 마지막 표현식이 결과(매치 없으면 target은 NaN 그대로).
function genSwitchWithResult(target: string, stmt: SwitchStmt, program: AnalyzedProgram, funcCtx: FuncGenContext | null): string {
  const lines: string[] = [];
  let subjectVar: string | null = null;
  if (stmt.subject !== null) {
    // genSwitchStmt와 동일한 subject lazy 호이스팅(그쪽 주석 참조).
    hoistLazyStatefulCalls(stmt.subject, program, funcCtx, lines);
    subjectVar = "__switchSubject";
    lines.push(`let ${subjectVar} = ${genExpr(stmt.subject, program, funcCtx)};`);
  }

  const cases = reorderSwitchCases(stmt.cases);
  const branches = cases.map((c, i) => {
    if (c.values === null) {
      return i === 0
        ? `if (true) ${genBodyWithResult(target, c.body, [], program, funcCtx)}`
        : `else ${genBodyWithResult(target, c.body, [], program, funcCtx)}`;
    }
    const test = genSwitchCaseTest(subjectVar, c.values, program, funcCtx);
    return `${i === 0 ? "if" : "else if"} (${test}) ${genBodyWithResult(target, c.body, [], program, funcCtx)}`;
  });

  return `{\n${[...lines, ...branches].join("\n")}\n}`;
}

// [a, b] = switch subject \n case1 => [v1, v2] \n ... (C410) 전용 진입점 — genTupleDestructure가
// stmt.value.kind==="SwitchStmt"일 때 여기로 보낸다. 일반 스칼라 제어문-식(genControlFlowExprValue)
// 과 동일한 "let __cfrN = NaN + 분기들이 채움 + 최종 대입 1줄" 뼈대이나, 대상이 하나가 아니라
// N개라 임시변수도 N개(`${temp}_0..${temp}_{N-1}`)를 쓴다 — analyzer(analyzeSwitchTupleValue)가
// 이미 모든 분기의 마지막 문장이 resolveTupleValueBranch가 인정하는 튜플 값(C508부터 TupleExpr
// 리터럴뿐 아니라 ta.*/request.security/UDF 튜플 콜도 포함)임을 보장했으므로 genTupleBodyWithResult가
// 그에 맞는 코드(taScratch 읽기 또는 배열 구조분해)를 각 분기에 방출한다.
function genSwitchTupleDestructure(
  stmt: TupleDestructure,
  switchExpr: SwitchStmt,
  program: AnalyzedProgram,
  nested: boolean,
  funcCtx: FuncGenContext | null,
  promoted: ReadonlySet<string> | null,
  alreadySeen: ReadonlySet<string> | null,
): string {
  const names = computeTupleTargetNames(stmt);
  const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);

  const tempBase = `__cfr${cfrTempCounter}`;
  cfrTempCounter += 1;
  const temps = names.map((_, i) => `${tempBase}_${i}`);
  const scaffold = `let ${temps.map((t) => `${t} = NaN`).join(", ")};\n${genSwitchTupleBranches(temps, switchExpr, program, funcCtx)}`;
  const reads = names.map((n, i) => `${n} = ${temps[i]}`);

  if (redeclPrefix !== null) {
    return `${scaffold}\n${redeclPrefix}${reads.join("; ")};`;
  }
  if (!nested && stmt.names.some((n) => promoted?.has(n))) {
    return `${scaffold}\n${reads.join("; ")};`;
  }
  return `${scaffold}\n${nested ? "let" : "var"} ${reads.join(", ")};`;
}

// genSwitchWithResult와 동일한 subject 1회 평가 + default 재정렬 뼈대이나 각 case 본문이
// genTupleBodyWithResult(다중 target)를 거친다.
function genSwitchTupleBranches(
  targets: string[],
  stmt: SwitchStmt,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  const lines: string[] = [];
  let subjectVar: string | null = null;
  if (stmt.subject !== null) {
    hoistLazyStatefulCalls(stmt.subject, program, funcCtx, lines);
    subjectVar = "__switchSubject";
    lines.push(`let ${subjectVar} = ${genExpr(stmt.subject, program, funcCtx)};`);
  }

  const cases = reorderSwitchCases(stmt.cases);
  const branches = cases.map((c, i) => {
    if (c.values === null) {
      return i === 0
        ? `if (true) ${genTupleBodyWithResult(targets, c.body, program, funcCtx)}`
        : `else ${genTupleBodyWithResult(targets, c.body, program, funcCtx)}`;
    }
    const test = genSwitchCaseTest(subjectVar, c.values, program, funcCtx);
    return `${i === 0 ? "if" : "else if"} (${test}) ${genTupleBodyWithResult(targets, c.body, program, funcCtx)}`;
  });

  return `{\n${[...lines, ...branches].join("\n")}\n}`;
}

// [a, b] = if cond \n [v1, v2] \n else \n [v3, v4] (C411, switch-튜플 C410의 형제 폼) 전용 진입점 —
// genTupleDestructure가 stmt.value.kind==="IfStmt"일 때 여기로 보낸다. genSwitchTupleDestructure와
// 완전히 동형의 "let __cfrN_0..N-1 = NaN + 분기들이 채움 + 최종 대입 1줄" 뼈대.
function genIfTupleDestructure(
  stmt: TupleDestructure,
  ifExpr: IfStmt,
  program: AnalyzedProgram,
  nested: boolean,
  funcCtx: FuncGenContext | null,
  promoted: ReadonlySet<string> | null,
  alreadySeen: ReadonlySet<string> | null,
): string {
  const names = computeTupleTargetNames(stmt);
  const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);

  const tempBase = `__cfr${cfrTempCounter}`;
  cfrTempCounter += 1;
  const temps = names.map((_, i) => `${tempBase}_${i}`);
  const scaffold = `let ${temps.map((t) => `${t} = NaN`).join(", ")};\n${genIfTupleBranches(temps, ifExpr, program, funcCtx)}`;
  const reads = names.map((n, i) => `${n} = ${temps[i]}`);

  if (redeclPrefix !== null) {
    return `${scaffold}\n${redeclPrefix}${reads.join("; ")};`;
  }
  if (!nested && stmt.names.some((n) => promoted?.has(n))) {
    return `${scaffold}\n${reads.join("; ")};`;
  }
  return `${scaffold}\n${nested ? "let" : "var"} ${reads.join(", ")};`;
}

// genIfWithResult와 동일한 분기 구조(최초 조건의 lazy 호이스팅 포함, C246)이나 각 분기 본문이
// genTupleBodyWithResult(다중 target)를 거친다.
function genIfTupleBranches(
  targets: string[],
  stmt: IfStmt,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  const pre: string[] = [];
  hoistLazyStatefulCalls(stmt.condition, program, funcCtx, pre);
  const branches: string[] = [
    `if (${genExpr(stmt.condition, program, funcCtx)}) ${genTupleBodyWithResult(targets, stmt.thenBody, program, funcCtx)}`,
  ];
  for (const clause of stmt.elifClauses) {
    branches.push(
      `else if (${genExpr(clause.condition, program, funcCtx)}) ${genTupleBodyWithResult(targets, clause.body, program, funcCtx)}`,
    );
  }
  if (stmt.elseBody !== null) {
    branches.push(`else ${genTupleBodyWithResult(targets, stmt.elseBody, program, funcCtx)}`);
  }
  return withLazyPrelude(pre, branches.join(" "));
}

// genBodyWithResult(단일 target)의 다중-target 버전 — analyzer(analyzeSwitchTupleValue/
// analyzeIfTupleValue)가 body의 마지막 문장이 항상 resolveTupleValueBranchStmt가 인정하는 튜플 값
// (TupleExpr 리터럴/ta.* 다중반환/request.security 튜플/UDF tupleArity 일치, C508부터 삼항과
// 동일 4종 + C609부터 중첩 IfStmt/SwitchStmt)임을 이미 보장했으므로(genTupleDestructure 분기
// 진입 자체가 그 보장의 전제) genTupleValueLines(genTernaryTupleDestructure 전용으로 시작했으나
// C508에서 공용화)가 만드는 문장 라인을 선행 문장과 같은 평평한 블록에 이어붙인다. C609: 마지막
// 문장이 다시 IfStmt/SwitchStmt(중첩)면 같은 targets로 genIfTupleBranches/genSwitchTupleBranches를
// 재귀 호출한다(analyzer resolveTupleValueBranchStmt의 codegen 대응 — 신규 기구 없이 기존 두
// 함수의 상호 재귀만 추가, genImplicitReturn↔genReturnIfStmt/genReturnSwitchStmt와 동형).
function genTupleBodyWithResult(
  targets: string[],
  body: Stmt[],
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  const lines: string[] = [];
  for (const s of body.slice(0, -1)) {
    const line = genStmt(s, program, /* nested */ true, funcCtx);
    if (line) lines.push(line);
  }
  const last = body[body.length - 1]!;
  if (last.kind === "IfStmt") {
    lines.push(genIfTupleBranches(targets, last, program, funcCtx));
    return `{\n${lines.join("\n")}\n}`;
  }
  if (last.kind === "SwitchStmt") {
    lines.push(genSwitchTupleBranches(targets, last, program, funcCtx));
    return `{\n${lines.join("\n")}\n}`;
  }
  lines.push(...genTupleValueLines(targets, (last as ExprStmt).expr, program, funcCtx));
  return `{\n${lines.join("\n")}\n}`;
}

// [a, b] = cond ? trueVal : falseVal (C416, switch-튜플(C410)/if-튜플(C411)의 세 번째 형제 폼) —
// genTupleDestructure가 stmt.value.kind==="TernaryOp"일 때 여기로 보낸다. genSwitchTupleDestructure/
// genIfTupleDestructure와 동일한 "let __cfrN_0..N-1 = NaN + 분기들이 채움 + 최종 대입 1줄" 뼈대이나,
// 분기가 문장 블록이 아니라 단일 표현식이라(analyzer.ts resolveTupleValueBranch가 검증한 3+1종:
// TupleExpr 리터럴/ta.* 다중반환/request.security 튜플 리터럴/UDF tupleArity 일치) 각 분기를
// genTupleValueIntoTargets로 targets에 직접 채운다.
function genTernaryTupleDestructure(
  stmt: TupleDestructure,
  ternaryExpr: TernaryOp,
  program: AnalyzedProgram,
  nested: boolean,
  funcCtx: FuncGenContext | null,
  promoted: ReadonlySet<string> | null,
  alreadySeen: ReadonlySet<string> | null,
): string {
  const names = computeTupleTargetNames(stmt);
  const redeclPrefix = computeTupleRedeclPrefix(stmt, names, alreadySeen);

  const tempBase = `__cfr${cfrTempCounter}`;
  cfrTempCounter += 1;
  const temps = names.map((_, i) => `${tempBase}_${i}`);

  const pre: string[] = [];
  hoistLazyStatefulCalls(ternaryExpr.condition, program, funcCtx, pre);
  const condCode = genExpr(ternaryExpr.condition, program, funcCtx);
  const trueBlock = genTupleValueIntoTargets(temps, ternaryExpr.trueExpr, program, funcCtx);
  const falseBlock = genTupleValueIntoTargets(temps, ternaryExpr.falseExpr, program, funcCtx);
  const scaffold = withLazyPrelude(
    pre,
    `let ${temps.map((t) => `${t} = NaN`).join(", ")};\nif (${condCode}) ${trueBlock} else ${falseBlock}`,
  );
  const reads = names.map((n, i) => `${n} = ${temps[i]}`);

  if (redeclPrefix !== null) {
    return `${scaffold}\n${redeclPrefix}${reads.join("; ")};`;
  }
  if (!nested && stmt.names.some((n) => promoted?.has(n))) {
    return `${scaffold}\n${reads.join("; ")};`;
  }
  return `${scaffold}\n${nested ? "let" : "var"} ${reads.join(", ")};`;
}

// genTernaryTupleDestructure 전용으로 시작했으나 C508에서 genTupleBodyWithResult(switch/if 분기
// 본문의 마지막 문장)에도 공용화됨 — 값 표현식 하나를 targets에 채워 넣는 코드를 만든다.
// analyzer.ts resolveTupleValueBranch가 검증한 3+1종을 그대로 미러: (1) TupleExpr 리터럴 — 원소별
// 직접 대입. (2) ta.* 다중반환(program.stateCallSlots)/(3) request.security 튜플 리터럴
// (program.securityTupleCallSlots) — 둘 다 genTupleDestructure의 동명 분기와 동일하게 콜을 문장으로
// 1회 실행한 뒤 $.taScratch[0..N-1]에서 읽는다. (4) 그 외(UDF tupleArity 일치 콜) — genExpr가 이미
// 실제 JS 배열을 반환하도록 방출하므로 배열 구조분해 대입 그대로("[t0,t1]=valueCode", genTupleDestructure의
// 기본 폴백과 동일 원칙).
// genTupleValueIntoTargets(삼항, 항상 자체 `{...}` 블록으로 감쌈)와 genTupleBodyWithResult(switch/if
// 분기 본문, 선행 문장들과 같은 평평한 블록을 공유해야 함, C508) 공용 — 감싸지 않은 문장 라인
// 배열을 반환해 호출부가 원하는 블록 구조에 이어붙이게 한다.
function genTupleValueLines(
  targets: string[],
  valueExpr: Expr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string[] {
  if (valueExpr.kind === "TupleExpr") {
    const lines: string[] = [];
    valueExpr.elements.forEach((el) => hoistLazyStatefulCalls(el, program, funcCtx, lines));
    valueExpr.elements.forEach((el, i) => {
      lines.push(`${targets[i]} = ${genExpr(el, program, funcCtx)};`);
    });
    return lines;
  }
  // C612: 분기 값이 다시 삼항이면(analyzer resolveTupleValueBranch의 TernaryOp 재귀 대응) targets가
  // 이미 대입 가능한 임시변수들이므로 새 temp 없이 if/else로 양 분기를 targets에 직접 채운다.
  if (valueExpr.kind === "TernaryOp") {
    const pre: string[] = [];
    hoistLazyStatefulCalls(valueExpr.condition, program, funcCtx, pre);
    const condCode = genExpr(valueExpr.condition, program, funcCtx);
    const trueBlock = genTupleValueIntoTargets(targets, valueExpr.trueExpr, program, funcCtx);
    const falseBlock = genTupleValueIntoTargets(targets, valueExpr.falseExpr, program, funcCtx);
    return [withLazyPrelude(pre, `if (${condCode}) ${trueBlock} else ${falseBlock}`)];
  }
  // C612: security bare-UDF passthrough(analyzer resolveTupleValueBranch가 securityBareUdfCallSlots에
  // 등록) — 외부 request.security 노드를 genExpr에 태우면 등록된 분기가 없어 크래시하므로 반드시
  // 여기서 선행 분기해 내부 UDF 콜(실제 JS 배열 반환)을 구조분해 대입한다(genTupleDestructure의
  // C432 분기와 동일 원칙).
  const securityBareUdf = valueExpr.kind === "CallExpr" ? program.securityBareUdfCallSlots.get(valueExpr) : undefined;
  if (securityBareUdf !== undefined) {
    const pre: string[] = [];
    hoistLazyStatefulCalls(securityBareUdf, program, funcCtx, pre);
    return [withLazyPrelude(pre, `[${targets.join(", ")}] = ${genExpr(securityBareUdf, program, funcCtx)};`)];
  }
  const pre: string[] = [];
  hoistLazyStatefulCalls(valueExpr, program, funcCtx, pre);
  const valueCode = genExpr(valueExpr, program, funcCtx);
  const stateCall = valueExpr.kind === "CallExpr" ? program.stateCallSlots.get(valueExpr) : undefined;
  const stateCallUserArgCount = valueExpr.kind === "CallExpr" ? valueExpr.args.length : 0;
  if (stateCall !== undefined && taCallReturnArity(TA_REGISTRY[stateCall.fn]!, stateCallUserArgCount) !== undefined) {
    const reads = targets.map((t, i) => `${t} = $.taScratch[${i}]`);
    return [withLazyPrelude(pre, `${valueCode};\n${reads.join("; ")};`)];
  }
  const securityTupleCall = valueExpr.kind === "CallExpr" ? program.securityTupleCallSlots.get(valueExpr) : undefined;
  if (securityTupleCall !== undefined) {
    const reads = targets.map((t, i) => `${t} = $.taScratch[${i}]`);
    return [withLazyPrelude(pre, `${valueCode};\n${reads.join("; ")};`)];
  }
  return [withLazyPrelude(pre, `[${targets.join(", ")}] = ${valueCode};`)];
}

function genTupleValueIntoTargets(
  targets: string[],
  valueExpr: Expr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  return `{\n${genTupleValueLines(targets, valueExpr, program, funcCtx).join("\n")}\n}`;
}

// VarDecl 초기값/':=' 재대입 값 생성 전용("na/수치 2c-ii" concat) — GOAL.md na 시맨틱은 참조형
// (string/color/UDT/array/map 등)의 na를 null로 규정하지만, genExpr(NaLiteral)은 항상 NaN을 내는
// 범용 경로다(다른 모든 위치에서는 숫자 na가 맞다). 그래서 이 특수화는 top-level 식별자 이름
// (varName) 하나로 두 좁은 신호만 조회한다: (a) 명시적 타입 힌트가 참조형 계열임(program.
// varTypeHints, 식별자 기반 값 흐름 추적 없이 선언 시점 힌트만 본다 — isUdtReferenceFieldType이
// string/color/drawing 핸들 6종/UDT/enum/array<T>·map<K,V>·matrix<T> 전부를 단일 판정으로 통합,
// C311이 발견한 "color 하나만 빠짐" 비대칭의 근본 수정), (b) UDT 인스턴스를 담는 var로 확정됐음
// (program.udtVarTypes — analyzeVarDecl이 명시적 타입 힌트 또는 생성자 콜 추론으로 채운다, 힌트
// 없이 `var p = Foo.new(...)`로만 추론된 경우까지 커버하려면 (a)만으론 부족해 별도 유지). 이 값이
// 리터럴 na 그 자체인 경우만 null로 내리고, 그 외(신호가 없거나 값이 na 리터럴이 아닌 임의
// 표현식)는 기존 genExpr 그대로 — UDF 내부 var(funcCtx, varTypeHints 미추적)와 '=' 로컬(애초에
// 타입 힌트/udtVarTypes 추적 자체가 없음)의 na 처리는 이번 범위 밖(LIMITATIONS.md 참조).
function genValueCode(
  value: Expr,
  varName: string,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
): string {
  const typeHint = program.varTypeHints.get(varName);
  const isUdtRef = program.udtVarTypes.has(varName) || (typeHint != null && program.udtTypes.has(typeHint));
  const isReferenceTypeHint = typeHint != null && isUdtReferenceFieldType(typeHint, program);
  if ((isReferenceTypeHint || isUdtRef) && value.kind === "NaLiteral") return "null";
  return genExpr(value, program, funcCtx);
}

// genValueCode의 func-local 대응(C572) — top-level var는 program.varTypeHints(scope 전역
// 1개 맵)를 보지만 func-local var의 typeHint는 함수별로 분리된 funcCtx.localVarTypeHints에
// 있다(analyzer.ts FuncInfo.localVarTypeHints 미러). `var box b = na`류가 이 분기 없이는
// isControlFlowExpr가 아닌 일반 genExpr(NaLiteral) 경로로 떨어져 항상 스칼라 "NaN"을 내
// (GOAL.md 참조형 na=null 규약 위반), 이후 그 값을 읽는 참조형 전용 소비처(rt.box.get_right 등,
// C572)가 원시값에서 프로퍼티를 읽다가 크래시했다.
function genFuncLocalValueCode(value: Expr, varName: string, program: AnalyzedProgram, funcCtx: FuncGenContext): string {
  const typeHint = funcCtx.localVarTypeHints.get(varName) ?? null;
  const isReferenceTypeHint = typeHint != null && isUdtReferenceFieldType(typeHint, program);
  if (isReferenceTypeHint && value.kind === "NaLiteral") return "null";
  return genExpr(value, program, funcCtx);
}

// 렉서(readString)는 pine2py와 동일하게 raw-passthrough(백슬래시+다음글자를 그대로 2글자 보존,
// ROADMAP.md L1186/DIVERGENCES.md #44 참조)라 여기서 명시적으로 디코딩해야 한다. pine2py는
// _gen_string_literal이 raw 텍스트를 실제 Python 소스에 그대로 재방출해 Python 자신의 문자열
// 리터럴 문법이 부수적으로 이스케이프를 해석해버리는데(모든 C-style 이스케이프를 무차별
// 재해석 — `\b`가 word-boundary 정규식을 백스페이스로 오염시키는 실제 버그가 그 예, DIVERGENCES
// #44), TV/Python/JS 세 언어가 이견 없이 일치하는 코어 4종(`\n`/`\\`/`\'`/`\"`)만 여기서 명시적으로
// 디코딩하고 나머지(`\t`/`\b`/`\d` 등 정규식 이스케이프 포함)는 raw 그대로 보존한다 — TV의 실제
// 확장 이스케이프 집합은 아직 미확정(WebSearch 권한 거부, C62)이라 추측 디코딩 금지.
function decodePineStringEscapes(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      if (next === "n" || next === "\\" || next === "'" || next === '"') {
        out += next === "n" ? "\n" : next;
        i += 1;
        continue;
      }
      out += ch + next;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function genExpr(
  expr: Expr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  secCtx: SecurityExprGenContext | null = null,
): string {
  // lazy 위치에서 문장 레벨로 호이스팅된 stateful 콜은 이미 프리루드에서 평가됐다 — 본식에서는
  // 임시변수 읽기로 대체한다(hoistLazyStatefulCalls / 파일 상단 lazyTemps 주석 참조).
  const lazyTemp = lazyTemps.get(expr);
  if (lazyTemp !== undefined) return lazyTemp;
  switch (expr.kind) {
    case "NumberLiteral":
      return expr.raw;
    case "BoolLiteral":
      return expr.value ? "true" : "false";
    case "NaLiteral":
      return "NaN";
    case "StringLiteral": {
      // array.sort/sort_indices/matrix.sort order 위치의 원시 문자열 리터럴("ascending"/
      // "descending", C203) — analyzer가 이 노드를 builtinBooleanConstants(C85 병렬 맵, order.*
      // DotAccess 콘스탄트와 동일 맵)에 등록해뒀으면 문자열이 아니라 boolean 리터럴을 방출한다.
      // false(descending)도 유효한 값이라 존재 여부는 반드시 !==undefined로 확인.
      const strBoolConstVal = program.builtinBooleanConstants.get(expr);
      if (strBoolConstVal !== undefined) return String(strBoolConstVal);
      return JSON.stringify(decodePineStringEscapes(expr.value));
    }
    case "ColorLiteral":
      // #RRGGBB/#RRGGBBAA -- COLOR_CONSTANTS(color.red 등)와 동일하게 hex 문자열 그대로 방출
      // (이스케이프 해석 대상 아님, 항상 [0-9a-fA-F]만 담음 -- decodePineStringEscapes 불필요).
      return JSON.stringify(expr.value);
    case "Identifier": {
      // C728: 중첩 top-level var(depth>0) 읽기 — analyzer가 이 Identifier 노드 자신에 이미
      // 확정해둔 슬롯을 그대로 쓴다(scope 정보 없이 codegen이 재해석할 필요 없음, analyzer.ts
      // nestedVarReadSlots 주석 참조).
      const nestedSlot = program.nestedVarReadSlots.get(expr);
      if (nestedSlot !== undefined) return `$.vars[${nestedSlot}]`;
      // C729(배치37(2) 2차 슬라이스): 이 읽기가 var보다 가까운 '=' 섀도를 가리키면(analyzer.ts
      // eqLocalShadowedVarReads 주석 참조) genIdentifier의 top-level program.varIndex 우선조회를
      // 건너뛰고 bare 식별자로 직접 방출 — JS 네이티브 블록 스코프가 나머지를 처리한다.
      if (program.eqLocalShadowedVarReads.has(expr)) return safeLocalName(expr.name);
      return genIdentifier(expr.name, program, funcCtx, secCtx);
    }
    case "UnaryOp":
      // C733: 'not' 분기도 secCtx 스레딩(C444/C446과 동일 계열 갭 — request.security narrow-grammar
      // 가 이번에 'not'을 리프로 허용하면서 이 경로가 처음 secCtx!==null로 실행된다. 기존 전
      // 호출부는 secCtx===null이라 출력 불변).
      return expr.op === "not"
        ? `rt.pineNot(${genExpr(expr.operand, program, funcCtx, secCtx)})`
        : `(-${genExpr(expr.operand, program, funcCtx, secCtx)})`;
    case "BinOp":
      return genBinOp(expr, program, funcCtx, secCtx);
    case "TernaryOp":
      // C446: secCtx 스레딩(C444 nz()가 고친 것과 동일 계열 갭 — 이 세 genExpr 호출이 secCtx를
      // 안 물려주면 request.security narrow-grammar 안 삼항(offset 위치, buildSecurityExprNode
      // TernaryOp case)의 조건/분기가 프리패스 로컬 대신 메인 컨텍스트 경로로 codegen된다.
      // secCtx===null(기존 전 호출부)이면 genExpr 기본 파라미터와 동치라 출력 불변.
      return `(${genExpr(expr.condition, program, funcCtx, secCtx)} ? ${genExpr(expr.trueExpr, program, funcCtx, secCtx)} : ${genExpr(expr.falseExpr, program, funcCtx, secCtx)})`;
    case "DotAccess": {
      // C446: barstate.isrealtime, request.security narrow-grammar 오프셋 위치(buildSecurityExprNode
      // DotAccess case, call-expr.ts) 전용 leaf — 이 서브트리는 일반 analyzeExpr를 안 거쳐(C180)
      // analyzer.ts BARSTATE_PROPS의 builtinRuntimeExprs 등록("$.idx === $.barCount - 1", 메인
      // 컨텍스트의 현재 바 인덱스)이 애초에 없다. 설령 있어도 그 문자열은 프리패스 루프 h와
      // 무관해 틀린 값이 된다 — 프리패스는 전체 원본 바를 한 번에 훑는 별도 루프이므로 "마지막
      // 바인가"는 h와 캐시 길이(barCount 동형, generateSecurityExprPreamble의 out.length와 동일
      // 산식)로 다시 판정해야 한다. 다른 barstate.* 프로퍼티는 이 위치 wild 근거가 없어 미포함.
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "barstate" && expr.attr === "isrealtime") {
        return `(${secCtx.loopVar} === ${secCtx.cacheVar}.close.length - 1)`;
      }
      // C481: barstate.isconfirmed는 BARSTATE_PROPS에서 위치 무관 상수 "true"(배치 리플레이 엔진
      // 전제, analyzer.ts 주석 참조) — isrealtime과 달리 secCtx.loopVar 재작성이 필요 없다.
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "barstate" && expr.attr === "isconfirmed") {
        return "true";
      }
      // C628: barstate.ishistory — isrealtime과 정확히 대칭인 재작성("$.idx < $.barCount-1", 메인
      // BARSTATE_PROPS 산식과 동형)의 프리패스 h/cacheVar 버전. wild `ds[barstate.ishistory ? 0 : 1]`.
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "barstate" && expr.attr === "ishistory") {
        return `(${secCtx.loopVar} < ${secCtx.cacheVar}.close.length - 1)`;
      }
      // C669: barstate.islast — 메인 BARSTATE_PROPS 산식이 isrealtime과 완전히 동일한 문자열
      // ("$.idx === $.barCount - 1")이라 프리패스 재작성도 동일 공식 재사용(analyzer.ts 주석 참조).
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "barstate" && expr.attr === "islast") {
        return `(${secCtx.loopVar} === ${secCtx.cacheVar}.close.length - 1)`;
      }
      // C669: session.ismarket — SESSION_PROPS에서 위치 무관 상수 "true"(barstate.isconfirmed와 동일
      // 근거, 세션 인프라 없는 백테스트 모드 전제).
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "session" && expr.attr === "ismarket") {
        return "true";
      }
      // C669: session.isfirstbar_regular — SESSION_PROPS 산식 "$.idx === 0"의 프리패스 h 버전.
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "session" && expr.attr === "isfirstbar_regular") {
        return `(${secCtx.loopVar} === 0)`;
      }
      // C669: session.islastbar_regular — isrealtime/islast와 동일 산식("$.idx === $.barCount - 1",
      // SESSION_PROPS도 이 두 barstate 프로퍼티와 문자열까지 동일).
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "session" && expr.attr === "islastbar_regular") {
        return `(${secCtx.loopVar} === ${secCtx.cacheVar}.close.length - 1)`;
      }
      // C481: syminfo.* — SYMINFO_NUMBER_PROPS만(문자열 상수는 call-expr.ts buildSecurityExprNode
      // DotAccess case 주석 참조 — 이 좁은 문법의 프리패스 캐시가 Float64Array 전용이라 문자열은
      // 배제). 이 서브트리(일반 analyzeExpr 미경유, C180)에서도 맵 값을 그대로 리터럴로 방출한다.
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "syminfo") {
        const numConst = SYMINFO_NUMBER_PROPS.get(expr.attr);
        if (numConst !== undefined) return String(numConst);
      }
      // C482: earnings.future_eps/future_period_end_time/future_revenue/future_time — syminfo.*
      // 바로 위 분기와 동일 이유(이 서브트리는 일반 analyzeExpr 미경유라 builtinConstants가 비어있음).
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "earnings") {
        const numConst = EARNINGS_NUMBER_PROPS.get(expr.attr);
        if (numConst !== undefined) return String(numConst);
      }
      // C517: timeframe.isintraday/isdaily/isweekly/ismonthly/isseconds/isminutes/isdwm — syminfo/
      // earnings 바로 위 분기와 동일 이유(이 서브트리는 일반 analyzeExpr 미경유라 builtinBooleanConstants가
      // 비어있음, call-expr.ts buildSecurityExprNode DotAccess case 주석 참조). period/main_period는
      // 문자열이라(Float64Array 캐시 제약) 여전히 배제. 값은 program.chartTf 기준(배치30 (1) C591).
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "timeframe") {
        const boolConst = timeframeBooleanPropValue(expr.attr, program.chartTf);
        if (boolConst !== undefined) return String(boolConst);
      }
      // C604: dayofweek.sunday~saturday — syminfo/earnings/timeframe 바로 위 분기와 동일 이유
      // (이 서브트리는 일반 analyzeExpr 미경유라 builtinConstants가 비어있음, analyzer.ts
      // DAYOFWEEK_CONSTANTS 주석 참조).
      if (secCtx !== null && expr.obj.kind === "Identifier" && expr.obj.name === "dayofweek") {
        const numConst = DAYOFWEEK_CONSTANTS.get(expr.attr);
        if (numConst !== undefined) return String(numConst);
      }
      // math.pi/e/phi/rphi(C72) — analyzer가 이미 리터럴 숫자로 접어 builtinConstants에 등록해뒀다
      // (analyzer.ts MATH_CONSTANTS 주석 참조). 런타임 조회 없이 숫자 리터럴을 그대로 방출.
      const constVal = program.builtinConstants.get(expr);
      if (constVal !== undefined) return String(constVal);
      // color.* 상수 17종(C78) — 값이 string이라 builtinConstants와 별도인 builtinStringConstants
      // 조회. JSON.stringify로 따옴표 있는 JS 문자열 리터럴을 방출(String()은 따옴표 없는 원본
      // 텍스트를 그대로 내려 문법 오류가 난다).
      const strConstVal = program.builtinStringConstants.get(expr);
      if (strConstVal !== undefined) return JSON.stringify(strConstVal);
      // order.ascending/descending(C85) — 값이 boolean이라 builtinBooleanConstants(세 번째 병렬 맵)
      // 조회. String()이 그대로 "true"/"false" JS 리터럴을 내려 별도 직렬화 불필요.
      const boolConstVal = program.builtinBooleanConstants.get(expr);
      if (boolConstVal !== undefined) return String(boolConstVal);
      // label.all/line.all 등(C244) — 값이 항상 빈 배열이라 다섯 번째 병렬 맵(builtinArrayConstants,
      // 값 없는 Set) 조회. JSON.stringify 없이 리터럴 배열 문법을 직접 방출(color 등 string 상수와
      // 달리 따옴표를 씌우면 안 됨 — analyzer.ts 주석 참조).
      if (program.builtinArrayConstants.has(expr)) return "[]";
      // barstate.*/session.*(ROADMAP P2 첫 슬라이스) — 값이 아니라 JS 식 문자열이 등록돼 있다
      // (analyzer.ts BARSTATE_PROPS/SESSION_PROPS 주석 참조). 괄호로 감싸 상위 연산자 우선순위에
      // 안전하게 끼워 넣는다(예: `!barstate.isfirst`가 `!($.idx===0)`이 되어야지 `(!$.idx)===0`으로
      // 잘못 묶이면 안 됨 — 다른 세 상수 맵은 원자적 리터럴이라 이 문제가 없었다).
      const runtimeExprVal = program.builtinRuntimeExprs.get(expr);
      if (runtimeExprVal !== undefined) return `(${runtimeExprVal})`;
      // UDT 필드 읽기: obj가 var로 추적된 UDT 인스턴스(단일 레벨)이거나 그 자체가 UDT 필드 접근으로
      // 확정된 DotAccess(중첩 체이닝, C123 — outer.inner.x)일 때만(analyzer.ts resolveUdtObjectType과
      // 동일한 판별, udtFieldAccessTypes 참조) — plain object 프로퍼티 접근이 재귀적으로 그대로
      // 내려간다(na는 construction/대입 시점에 이미 올바른 JS 값(NaN/null)으로 저장돼 있어 읽기
      // 쪽 특수 처리 불필요).
      const objTypeName = resolveUdtObjectType(expr.obj, program, funcCtx);
      if (objTypeName !== undefined) {
        // (recv[N]).field류(C637)는 obj 자신이 참조형 원형 버퍼(RefSeries) 조회라 워밍업 구간
        // (아직 N바 전 기록이 없음, 예: bar 0에서 [1])엔 na(null)를 정직하게 돌려준다. 그 na 위에
        // 곧장 `.attr`를 물리면 JS는 `null.attr`에서 TypeError를 던지고(Float64Array 산술처럼
        // 조용히 NaN으로 흡수되지 않음), `?.`만 쓰면 undefined가 새 나가 GOAL.md의 3분할 na 규약
        // (숫자=NaN/참조형=null, undefined는 "미초기화" 전용)을 깨고 var 슬롯 재초기화 가드
        // (`$.vars[n]===undefined`)를 오염시킬 수 있다 — null을 그 UDT 타입의 필드별 정확한 na
        // 기본값(genTypeDecl 팩토리를 인자 0개로 호출하면 각 파라미터의 JS 기본값이 그대로 그 na
        // 값)으로 대체해 `.attr`가 항상 안전하게 그 na 값 자체를 읽도록 한다. 나머지(Identifier/
        // DotAccess 체이닝)는 na 리터럴이 이미 construction 시점에 값으로 정착돼 있어 이 위험이 없다.
        const objExpr =
          expr.obj.kind === "IndexAccess" ? `(${genExpr(expr.obj, program, funcCtx)} ?? ${objTypeName}())` : genExpr(expr.obj, program, funcCtx);
        return `${objExpr}.${expr.attr}`;
      }
      throw new Error(`internal: DotAccess는 CallExpr 없이 codegen될 수 없음 (${expr.attr})`);
    }
    case "IndexAccess":
      return genIndexAccess(expr, program, funcCtx, secCtx);
    case "CallExpr":
      return genCallExpr(expr, program, funcCtx, secCtx);
    case "TupleExpr":
      // 유일하게 허용되는 위치(UDF 마지막 문장)는 genFuncBody가 이 함수를 거치지 않고 직접
      // 처리한다 — 여기 도달했다면 analyzer가 TupleExpr를 다른 위치에서 막지 못한 버그.
      throw new Error("internal: TupleExpr는 함수 반환 위치 전용 (analyzer 통과 후 발생 불가)");
    case "IfStmt":
    case "ForStmt":
    case "WhileStmt":
    case "SwitchStmt":
      // 유일하게 허용되는 위치(VarDecl/Assignment 값)는 genStmt가 isControlFlowExpr로 먼저
      // 가로채 genControlFlowBranches/genControlFlowAssignment로 보낸다 — 여기 도달했다면
      // analyzer가 다른 위치에서 막지 못한 버그(TupleExpr와 동일한 internal throw 패턴).
      throw new Error(`internal: '${expr.kind}'는 VarDecl/Assignment 값 위치 전용 (analyzer 통과 후 발생 불가)`);
  }
}

// series[n] 히스토리 참조. analyzer가 이미 offset을 확정해뒀으므로(historyOffsets, 또는
// dynamicHistoryOffsets — 런타임 오프셋, index-access.ts analyzeIndexAccess 주석 참조)
// 여기선 그 값과 obj의 종류만으로 분기한다: bar series는 이미 전체 히스토리를 가진 $.<name> Series라
// 그대로 .get(offset), offset===0은 히스토리 슬롯 없이 identifier와 동일, 그 외(top-level var,
// offset>=1)는 analyzer가 할당해둔 $.histSlots[] 인덱스로 조회한다. 동적 오프셋(C365 게이트 확장 —
// bar-like 한정이던 C228/C305에서 histSlot 대상 전부로): histSlot 경로는 offset===0 컴파일타임
// 분기(현재 값 identifier vs slot.get)를 할 수 없으므로 rt.histGet(현재값, slot, off)(series.ts)
// 런타임 분기로 이관한다 — 현재값 인자는 offset===0 리터럴 경로가 내는 genIdentifier와 동일한
// 부수효과 없는 읽기 식이라 eager 평가가 무해하다. strategy.<prop>만 리터럴 전용(analyzer가 거부).
function genIndexAccess(
  expr: IndexAccess,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  secCtx: SecurityExprGenContext | null = null,
): string {
  // C501: array[i] 브라켓 원소 접근 — analyzer가 이미 array 원소 접근으로 확정해둔 노드(analyzer/
  // index-access.ts analyzeIndexAccess 최상단 분기 참조). 아래 secCtx/오프셋 결정 트리 전부를
  // 건너뛰고 array.get() method-call sugar와 동일한 rt.array.get 호출로 방출한다(genExpr가
  // Identifier/DotAccess 등 obj의 실제 kind를 알아서 처리 — Identifier 전용 제약 없음).
  if (program.arrayIndexReads.has(expr)) {
    const objCode = genExpr(expr.obj, program, funcCtx, secCtx);
    const idxCode = genExpr(expr.index, program, funcCtx, secCtx);
    return `rt.array.get(${objCode}, ${idxCode})`;
  }
  // C367: security HTF 프리패스 서브트리 전용 경로 — buildSecurityExpr가 obj를 bare/파생 시리즈,
  // index를 음수 아닌 정수 리터럴로 이미 확정한 "빌드된" 클론 노드라 historyOffsets/histSlots 등
  // 메인 타임프레임 등록이 아예 없다(아래 공용 경로의 슬롯 조회를 타면 internal throw — 반드시
  // 여기서 가로챈다). n행 전 HTF 캐시 읽기는 genBarRef offset-1 선례(ta.tr류 prevClose)의 일반화:
  // TV에서 요청 tf 문맥의 close[n]은 "그 tf의 n바 전"이므로 캐시 행 h-n이 정확한 대응이고,
  // 워밍업(h<n)은 히스토리 참조 관례 그대로 NaN.
  if (secCtx !== null) {
    // C370 hist-on-expr: analyzer histReads에 등록된 IndexAccess 클론(obj가 bare/파생이 아닌 유효
    // 서브식)은 프리패스 로컬 히스토리 버퍼 읽기 — 서브식 자신은 fill 문에서만 평가된다
    // (generateSecurityExprPreamble 참조). 사용자 소스의 [0] 리터럴은 analyzer가 서브식을 직접
    // 반환해 여기 안 오지만(동적 오프셋은 런타임에야 0 여부를 알 수 있어 항상 버퍼 경유), C601
    // 값위치 삼항의 eager 분기 래퍼(wrapSecurityEagerBranch)는 합성 n=0으로 등록돼 여기로 온다 —
    // 아래 리터럴 경로가 n=0에서 `(h >= 0 ? buf[h - 0] : NaN)`(항상 buf[h])을 내 정확히 "그 행의
    // 무조건 평가값 읽기"가 된다.
    const bufIdx = secCtx.histBufs.get(expr);
    if (bufIdx !== undefined) {
      const bufName = secHistBufName(bufIdx);
      if (expr.index.kind === "NumberLiteral") {
        const n = expr.index.value;
        return `(${secCtx.loopVar} >= ${n} ? ${bufName}[${secCtx.loopVar} - ${n}] : NaN)`;
      }
      // C437: 동적 오프셋 — offsetCode는 buildSecurityExprNode가 이미 좁은 문법(ta.* 콜 금지)으로
      // 검증해뒀으므로 부수효과 없이 안전하게 재평가 가능(genDerivedPriceExpr 분기가 최대 4회
      // 재방출해도 값 동일).
      const offsetCode = genExpr(expr.index, program, funcCtx, secCtx);
      return `rt.secHistGet(${bufName}, ${secCtx.loopVar}, ${offsetCode})`;
    }
    if (expr.obj.kind !== "Identifier") {
      throw new Error("internal: security 프리패스 IndexAccess는 bare/파생 시리즈만 (analyzer 통과 후 발생 불가)");
    }
    const name = expr.obj.name;
    if (!BAR_SERIES_NAMES.has(name) && !DERIVED_PRICE_NAMES.has(name)) {
      throw new Error(`internal: security 프리패스 IndexAccess obj '${name}' 미지원 (analyzer 통과 후 발생 불가)`);
    }
    if (expr.index.kind === "NumberLiteral") {
      const n = expr.index.value;
      if (n === 0) return genExpr(expr.obj, program, funcCtx, secCtx);
      const arr = (f: string): string => `${secCtx.cacheVar}.${f}[${secCtx.loopVar} - ${n}]`;
      const core = BAR_SERIES_NAMES.has(name)
        ? arr(name)
        : genDerivedPriceExpr(name as "hl2" | "hlc3" | "ohlc4" | "hlcc4", arr("open"), arr("high"), arr("low"), arr("close"));
      return `(${secCtx.loopVar} >= ${n} ? ${core} : NaN)`;
    }
    // C437 동적 오프셋(bare/파생 시리즈 obj): rt.secHistGet이 trunc+음수 가드 후 캐시 열을
    // h-off로 직접 인덱싱 — literal n===0 단축과 동치(off===0이면 arr[h] == 그 행 자신).
    const offsetCode = genExpr(expr.index, program, funcCtx, secCtx);
    const arrDyn = (f: string): string => `rt.secHistGet(${secCtx.cacheVar}.${f}, ${secCtx.loopVar}, ${offsetCode})`;
    return BAR_SERIES_NAMES.has(name)
      ? arrDyn(name)
      : genDerivedPriceExpr(name as "hl2" | "hlc3" | "ohlc4" | "hlcc4", arrDyn("open"), arrDyn("high"), arrDyn("low"), arrDyn("close"));
  }
  const isDynamic = program.dynamicHistoryOffsets.has(expr);
  const offset = isDynamic ? undefined : program.historyOffsets.get(expr);
  if (!isDynamic && offset === undefined) {
    throw new Error("internal: IndexAccess에 확정된 오프셋 없음 (analyzer 통과 후 발생 불가)");
  }
  const offsetCode = isDynamic ? genExpr(expr.index, program, funcCtx) : String(offset);
  // strategy.<prop>[N](C339) — obj가 DotAccess인 유일한 허용 형태. offset===0은 var와 동일하게
  // 히스토리 슬롯 없이 그 자리에서 바로 genExpr(genExpr가 builtinRuntimeExprs를 조회해 그대로
  // "($.strategy.posSize)"류를 낸다). offset>=1은 analyzer가 배정해둔 strategyPropHistorySlots.
  if (expr.obj.kind === "DotAccess") {
    if (offset === 0) return genExpr(expr.obj, program, funcCtx);
    // barstate.*/session.* 히스토리(C521, index-access.ts 분기 주석 참조) — strategy.<prop>과 달리
    // histSlot이 없다: builtinRuntimeExprs에 등록된 $.idx만의 순수 식/상수 문자열을 그대로 재사용해
    // $.idx를 ($.idx-N)으로 치환하는 것만으로 "N바 전 값"이 합성된다(bar_index/time과 동일 원칙).
    if (expr.obj.obj.kind === "Identifier" && (expr.obj.obj.name === "barstate" || expr.obj.obj.name === "session")) {
      const baseExpr = program.builtinRuntimeExprs.get(expr.obj);
      if (baseExpr === undefined) {
        throw new Error(`internal: barstate/session runtime expr missing for '${expr.obj.attr}' (analyzer 통과 후 발생 불가)`);
      }
      const shifted = baseExpr.replace(/\$\.idx\b/g, `($.idx - ${offset})`);
      return `($.idx >= ${offset} ? (${shifted}) : NaN)`;
    }
    // UDT 인스턴스 스칼라 필드 히스토리(C523) — analyzer가 "수신자이름.필드이름" 키로 배정해둔
    // named 슬롯(바-종료 record 루프는 genBarFn 참조). 리터럴 오프셋은 var/'=' 로컬과 동일한
    // slot.get, 동적 오프셋은 rt.histGet(현재값, slot, off) — 현재값 인자는 수신자 na 가드
    // (`?.` + `?? NaN`)를 붙인 읽기 식이라 수신자가 지금 null이어도 과거 값 조회가 크래시하지
    // 않는다(off===0 런타임 분기에서만 이 값이 그대로 반환됨, series.ts histGet 주석 참조).
    if (expr.obj.obj.kind === "Identifier") {
      const fieldKey = `${expr.obj.obj.name}.${expr.obj.attr}`;
      // UDF/method 매개변수(UDT) 필드 히스토리(C750) — 콜사이트별 함수-상대 슬롯(funcCtx.
      // localFieldHistSlots/localFieldRefHistSlots)을 top-level 전역 슬롯보다 먼저 조회한다
      // (analyzer가 두 맵을 상호 배타적으로 채우므로 순서 자체는 무관, 함수-내부 우선 관례와
      // 정합만 맞춤). 수신자는 항상 매개변수(재대입 불가)라 현재값 식은 safeLocalName만으로 충분.
      const funcFieldHistIdx = funcCtx?.localFieldHistSlots.get(fieldKey);
      if (funcFieldHistIdx !== undefined) {
        if (!isDynamic) return `$.histSlots[__histBase + ${funcFieldHistIdx}].get(${offsetCode})`;
        const recvJS = safeLocalName(expr.obj.obj.name);
        return `rt.histGet((${recvJS}?.${expr.obj.attr} ?? NaN), $.histSlots[__histBase + ${funcFieldHistIdx}], ${offsetCode})`;
      }
      const funcFieldRefHistIdx = funcCtx?.localFieldRefHistSlots.get(fieldKey);
      if (funcFieldRefHistIdx !== undefined) {
        if (!isDynamic) return `$.refHistSlots[__refHistBase + ${funcFieldRefHistIdx}].get(${offsetCode})`;
        const recvJS = safeLocalName(expr.obj.obj.name);
        return `rt.refHistGet((${recvJS}?.${expr.obj.attr} ?? null), $.refHistSlots[__refHistBase + ${funcFieldRefHistIdx}], ${offsetCode})`;
      }
      const fieldHistIdx = program.udtFieldHistorySlots.get(fieldKey);
      if (fieldHistIdx !== undefined) {
        if (!isDynamic) return `$.histSlots[${fieldHistIdx}].get(${offsetCode})`;
        const recvSlot = program.varIndex.get(expr.obj.obj.name);
        const recvJS = recvSlot !== undefined ? `$.vars[${recvSlot}]` : safeLocalName(expr.obj.obj.name);
        return `rt.histGet((${recvJS}?.${expr.obj.attr} ?? NaN), $.histSlots[${fieldHistIdx}], ${offsetCode})`;
      }
      // drawing 핸들 타입 UDT 필드 히스토리(C718) — 같은 named 키, 별도 물리 배열($.refHistSlots)과
      // currentValue-fallback(rt.refHistGet, na 정규화는 `?? null` — series.ts 참조).
      const fieldRefHistIdx = program.udtFieldRefHistorySlots.get(fieldKey);
      if (fieldRefHistIdx !== undefined) {
        if (!isDynamic) return `$.refHistSlots[${fieldRefHistIdx}].get(${offsetCode})`;
        const recvSlot = program.varIndex.get(expr.obj.obj.name);
        const recvJS = recvSlot !== undefined ? `$.vars[${recvSlot}]` : safeLocalName(expr.obj.obj.name);
        return `rt.refHistGet((${recvJS}?.${expr.obj.attr} ?? null), $.refHistSlots[${fieldRefHistIdx}], ${offsetCode})`;
      }
    }
    const histIdx = program.strategyPropHistorySlots.get(expr.obj.attr);
    if (histIdx === undefined) {
      throw new Error(`internal: strategy prop history slot missing for '${expr.obj.attr}' (analyzer 통과 후 발생 불가)`);
    }
    return `$.histSlots[${histIdx}].get(${offset})`;
  }
  // ta.<fn>(...)[N](C340) — obj가 CallExpr인 유일한 허용 형태(analyzer.ts taCallHistorySlots 주석
  // 참조). offset===0은 var/strategy prop과 동일하게 그 자리에서 바로 genExpr(호출을 정확히 1회
  // 실행 — 인덱싱 없는 bare 콜과 글자 하나 다르지 않다). offset>=1은 record+get을 comma 식 하나로
  // 묶어 "이 콜이 실행되는 바로 그 자리"에서 인라인 처리한다 — var/strategy prop처럼 문장 종료 후
  // 별도 루프에서 값을 다시 읽을 수 없다(이 콜 자체가 유일한 값 발생원이라 재호출하면 상태가 두 번
  // 전진한다). genExpr(expr.obj)가 lazyTemps에 등록된 노드면(호이스팅된 삼항/and·or 좌변 밖 콜)
  // 이미 계산된 임시변수 이름을 그대로 반환하므로 이중 호출 위험은 없다 — 단 그 경로 자체는
  // analyzer가 하드 에러로 막아뒀다(lazy-expr 위치는 인라인 record 시점이 호이스팅된 실행 시점과
  // 어긋남).
  if (expr.obj.kind === "CallExpr") {
    if (offset === 0) return genExpr(expr.obj, program, funcCtx);
    // drawing 생성자 콜(line.new 등)의 인라인 히스토리 인덱싱(C700, analyzer/index-access.ts
    // condCallRefHistorySlots 주석 참조) — condCallHistorySlots(C671)와 동일한 push+get comma 식이되
    // 물리 배열이 $.condCallRefHistSlots(RefSeries, object 원형 버퍼)다.
    const drawingHistIdx = program.condCallRefHistorySlots.get(expr.obj);
    if (drawingHistIdx !== undefined) {
      const callCode = genExpr(expr.obj, program, funcCtx);
      return `($.condCallRefHistSlots[${drawingHistIdx}].push(${callCode}), $.condCallRefHistSlots[${drawingHistIdx}].get(${offsetCode}))`;
    }
    // UDF 본문 조건부(if/for/while) 위치 drawing 생성자 콜 압축 히스토리(C701, FuncInfo.
    // localCondCallRefHistSlots 주석 참조) — 위 top-level drawingHistIdx와 동일한 $.condCallRefHistSlots
    // push+get이되 콜사이트별 __condRefHistBase 상대 인덱스(genBaseParams/genCallExpr 배선).
    const funcCondRefHistIdx = funcCtx?.localCondCallRefHistSlots.get(expr.obj);
    if (funcCondRefHistIdx !== undefined) {
      const callCode = genExpr(expr.obj, program, funcCtx);
      return `($.condCallRefHistSlots[__condRefHistBase + ${funcCondRefHistIdx}].push(${callCode}), $.condCallRefHistSlots[__condRefHistBase + ${funcCondRefHistIdx}].get(${offsetCode}))`;
    }
    // request.security(...)[N](C448) — securityCallSlots(bare field)/securityExprCallSlots(expression)
    // 콜 결과는 ta.*와 달리 histSlot record가 필요 없다: securityCache/securityExprCache가 이미
    // 트랜스파일 시점에 전체 바 범위로 집계돼 있으므로, 메인 bar index($.idx)에서 offset을 뺀 값으로
    // 그 자리에서 다시 조회하기만 하면 된다(runtime/security.ts getHist/getFromArrayHist가 trunc +
    // 음수 가드 후 get()/getFromArray()에 위임 — analyzeIndexAccess CallExpr 분기 주석 참조).
    const securityCall = program.securityCallSlots.get(expr.obj);
    if (securityCall !== undefined) {
      // multiSite(C529)는 genCallExpr의 동명 분기와 동일하게 `slot + __secIdx`(콜사이트별 tf 블록).
      const secSlotRef = securityCall.multiSite ? `${securityCall.slot} + __secIdx` : `${securityCall.slot}`;
      return `rt.security.getHist($.securityCache[${secSlotRef}], $.idx, "${securityCall.field}", ${securityCall.gaps}, ${securityCall.lookahead}, ${offsetCode})`;
    }
    const securityExprCall = program.securityExprCallSlots.get(expr.obj);
    if (securityExprCall !== undefined) {
      return `rt.security.getFromArrayHist($.securityExprCache[${securityExprCall.slot}], $.securityCache[${securityExprCall.slot}], $.idx, ${securityExprCall.gaps}, ${securityExprCall.lookahead}, ${offsetCode})`;
    }
    // C699: securityParamExprCalls(C453/C534 — UDF 매개변수 다중 콜사이트, __secIdx 서수) 슬롯 —
    // 위 securityExprCall과 동일한 getFromArrayHist 읽기지만 슬롯이 `base + __secIdx`(genCallExpr의
    // 동명 분기와 동일 배선). 이 맵은 UDF 본문 안 노드에만 등록되므로 __secIdx는 항상 스코프에 있다.
    const securityParamCall = program.securityParamExprCalls.get(expr.obj);
    if (securityParamCall !== undefined) {
      const slotRef = `${securityParamCall.base} + __secIdx`;
      return `rt.security.getFromArrayHist($.securityExprCache[${slotRef}], $.securityCache[${slotRef}], $.idx, ${securityParamCall.gaps}, ${securityParamCall.lookahead}, ${offsetCode})`;
    }
    // UDF 본문 안 CallExpr 히스토리(C483) — funcCtx.localCallHistSlots(콜사이트-상대 슬롯)를
    // program.taCallHistorySlots(top-level 전역 슬롯)보다 먼저 조회한다(analyzer의 함수-내부 우선
    // 순서, index-access.ts scope.func 분기와 짝). __histBase는 genBaseParams가 이미 함수 시그니처에
    // 조건부로 실어뒀다(localHistSlotCount 카운터 공유 — named locals와 동일 배선, 별도 인자 불필요).
    const funcCallHistIdx = funcCtx?.localCallHistSlots.get(expr.obj);
    if (funcCallHistIdx !== undefined) {
      const callCode = genExpr(expr.obj, program, funcCtx);
      return `($.histSlots[__histBase + ${funcCallHistIdx}].record(${callCode}), $.histSlots[__histBase + ${funcCallHistIdx}].get(${offsetCode}))`;
    }
    // UDF 본문 조건부(if/for/while) 위치 stateful 콜 압축 히스토리(C672, FuncInfo.
    // localCondCallHistSlots 주석 참조) — 아래 top-level condCallHistorySlots(C671)와 같은
    // $.condCallHistSlots push+get이되 콜사이트별 __condHistBase 상대 인덱스(genBaseParams/
    // genCallExpr 배선). analyzer가 네 맵을 상호 배타적으로 채우므로 조회 순서 자체는 무관.
    const funcCondHistIdx = funcCtx?.localCondCallHistSlots.get(expr.obj);
    if (funcCondHistIdx !== undefined) {
      const callCode = genExpr(expr.obj, program, funcCtx);
      return `($.condCallHistSlots[__condHistBase + ${funcCondHistIdx}].push(${callCode}), $.condCallHistSlots[__condHistBase + ${funcCondHistIdx}].get(${offsetCode}))`;
    }
    // 조건부(if/for/while) 위치 stateful 콜 히스토리(C671, analyzer.ts condCallHistorySlots 주석
    // 참조) — Context.advance()가 건드리지 않는 별도 배열에 push()(호출될 때만 스스로 커서 전진)로
    // 기록해 압축(call-count) 인덱스를 구현한다. taCallHistorySlots보다 먼저 조회(analyzer가 두 맵을
    // 상호 배타적으로 채우므로 순서 자체는 무관하나, 신규 경로를 먼저 배치).
    const condHistIdx = program.condCallHistorySlots.get(expr.obj);
    if (condHistIdx !== undefined) {
      const callCode = genExpr(expr.obj, program, funcCtx);
      return `($.condCallHistSlots[${condHistIdx}].push(${callCode}), $.condCallHistSlots[${condHistIdx}].get(${offsetCode}))`;
    }
    const histIdx = program.taCallHistorySlots.get(expr.obj);
    if (histIdx === undefined) {
      throw new Error("internal: ta call history slot missing (analyzer 통과 후 발생 불가)");
    }
    // 동적 오프셋(C365)도 같은 문자열 그대로다 — 인라인 record가 comma 식에서 먼저 실행되므로
    // get(0)이 방금 기록한 현재 콜 값이라 rt.histGet의 0-분기가 필요 없고, 음수/NaN/범위밖은
    // Series.get() 가드가 처리한다(analyzeIndexAccess CallExpr 분기 주석 참조).
    const callCode = genExpr(expr.obj, program, funcCtx);
    return `($.histSlots[${histIdx}].record(${callCode}), $.histSlots[${histIdx}].get(${offsetCode}))`;
  }
  // (high-low)[1]류 산술식 히스토리(C522) — obj가 BinOp/UnaryOp인 형태. analyzer.ts의 새 분기가
  // CallExpr과 동일한 taCallHistorySlots(top-level 전역 슬롯, 키 타입만 Expr로 확장)에 배정해뒀다 —
  // offset===0은 CallExpr과 동일하게 그 자리에서 바로 genExpr(이 식 자신이 유일한 값 발생원),
  // offset>=1/동적은 record+get을 comma 식으로 그 자리에서 인라인한다.
  // C717(wild `0[1]`/`1[2]`류, index-access.ts 동일 분기 확장 주석 참조): Number/Bool/na 리터럴도
  // 이 경로를 그대로 공유한다 — "컴파일타임 상수라 항상 자기 자신"으로 즉시 접어버리지 않고 일부러
  // 매 바 record+get을 거치게 둔다. 이유: history-referencing은 "N바 전 값"을 찾는 연산이고, 아직
  // N바가 지나지 않았으면(Series.get() idx<0) 그 값의 종류와 무관하게 na를 반환하는 것이
  // 이미 검증된 일반 워밍업 규칙(다른 모든 obj kind와 동일 Series.get 가드) — 리터럴만 예외로
  // 워밍업을 건너뛴다는 것은 TV 1차 소스로 검증된 바 없는 별도의(그리고 더 강한) 가정이라 채택하지
  // 않는다. record되는 값이 리터럴이라 콜사이트마다 달라질 수 없으므로(항상 동일 값) 이 공유 경로가
  // top-level 전역 슬롯이어도 안전.
  if (
    expr.obj.kind === "BinOp" ||
    expr.obj.kind === "UnaryOp" ||
    expr.obj.kind === "NumberLiteral" ||
    expr.obj.kind === "BoolLiteral" ||
    expr.obj.kind === "NaLiteral"
  ) {
    if (offset === 0) return genExpr(expr.obj, program, funcCtx);
    // C720(next_hint(C719) "top-level 산술식 UDF 본문 확장"): UDF 본문 안 산술식 히스토리도
    // CallExpr의 funcCtx.localCallHistSlots/localCondCallHistSlots(C483/C672)와 동일한 우선순위로
    // 먼저 조회한다(index-access.ts scope.func!==null 확장과 짝, __histBase/__condHistBase는
    // 카운터 공유라 별도 배선 불필요).
    const funcArithHistIdx = funcCtx?.localCallHistSlots.get(expr.obj);
    if (funcArithHistIdx !== undefined) {
      const objCode = genExpr(expr.obj, program, funcCtx);
      return `($.histSlots[__histBase + ${funcArithHistIdx}].record(${objCode}), $.histSlots[__histBase + ${funcArithHistIdx}].get(${offsetCode}))`;
    }
    const funcCondArithHistIdx = funcCtx?.localCondCallHistSlots.get(expr.obj);
    if (funcCondArithHistIdx !== undefined) {
      const objCode = genExpr(expr.obj, program, funcCtx);
      return `($.condCallHistSlots[__condHistBase + ${funcCondArithHistIdx}].push(${objCode}), $.condCallHistSlots[__condHistBase + ${funcCondArithHistIdx}].get(${offsetCode}))`;
    }
    // 조건부(if/for/while) 위치 산술식 히스토리(C679, analyzer/index-access.ts condCallHistorySlots
    // 확장 주석 참조) — CallExpr의 C671과 동일한 $.condCallHistSlots push+get 압축 인덱스.
    const condHistIdx = program.condCallHistorySlots.get(expr.obj);
    if (condHistIdx !== undefined) {
      const objCode = genExpr(expr.obj, program, funcCtx);
      return `($.condCallHistSlots[${condHistIdx}].push(${objCode}), $.condCallHistSlots[${condHistIdx}].get(${offsetCode}))`;
    }
    const histIdx = program.taCallHistorySlots.get(expr.obj);
    if (histIdx === undefined) {
      throw new Error("internal: arith expr history slot missing (analyzer 통과 후 발생 불가)");
    }
    const objCode = genExpr(expr.obj, program, funcCtx);
    return `($.histSlots[${histIdx}].record(${objCode}), $.histSlots[${histIdx}].get(${offsetCode}))`;
  }
  if (expr.obj.kind !== "Identifier") throw new Error("internal: IndexAccess.obj는 Identifier만 지원 (analyzer 통과 후 발생 불가)");
  const name = expr.obj.name;
  if (BAR_SERIES_NAMES.has(name)) return `$.${name}.get(${offsetCode})`;
  // hl2[n] 등 — 히스토리 인덱싱도 security HTF 프리패스 서브트리에는 절대 등장하지 않으므로
  // (analyzeIndexAccess가 그 문법 자체를 하드 에러로 막음, ROADMAP 참조) secCtx 없이 항상
  // $.<field>.get(offset) 4개로 그 자리에서 합성한다 — genIdentifier(offset 0, secCtx 스레딩)와
  // 별개 경로.
  if (DERIVED_PRICE_NAMES.has(name)) {
    return genDerivedPriceExpr(
      name as "hl2" | "hlc3" | "ohlc4" | "hlcc4",
      `$.open.get(${offsetCode})`,
      `$.high.get(${offsetCode})`,
      `$.low.get(${offsetCode})`,
      `$.close.get(${offsetCode})`,
    );
  }
  // bar_index[n] — pine2py bar_index는 다른 top-level 값처럼 Series에 push되므로, 아직 그만큼
  // 과거 바가 없는 시점(idx < offset, 예: bar 0에서 bar_index[1])엔 다른 히스토리 참조와 동일하게
  // na를 반환한다(python 직접 실행으로 확인 — 단순 `$.idx - offset` 산술은 이 워밍업 시점에 음수
  // 정수를 조용히 내 오답이 된다, oracle/cases/derived_bar_vars_basic.pine으로 실측 발견). 리터럴
  // 오프셋은 analyzer가 이미 0 이상 정수로 확정해뒀으니(literalOffsetValue) 그 삼항 그대로 유지
  // (기존 exact-string 테스트 보존, codegen.test.ts). 동적(런타임) 오프셋은 C305부터 지원
  // (index-access.ts BAR_INDEX_NAME 동적 허용 주석 참조, wild 51건) — offsetCode가 trunc 안 된
  // 임의 표현식일 수 있어 Series.get()과 동일한 trunc+음수 가드를 rt.barIndexHistory(numeric.ts)로
  // 위임한다(리터럴 경로는 이미 정수로 확정돼 이 가드가 불필요, 그대로 분기 유지).
  if (name === BAR_INDEX_NAME) {
    return isDynamic ? `rt.barIndexHistory($.idx, ${offsetCode})` : `($.idx >= ${offsetCode} ? ($.idx - ${offsetCode}) : NaN)`;
  }
  if (offset === 0) return genIdentifier(name, program, funcCtx);
  // time 계열 빌트인 히스토리(C368, analyzeIndexAccess TIME_VAR_NAMES 분기와 짝) — Context가
  // time 전체 배열을 쥐고 있어 $.barTimeAt(off)이 (idx-off) 직접 인덱싱으로 값을 합성한다
  // (trunc/음수·NaN/워밍업 가드 내장이라 리터럴/동적 오프셋이 같은 문자열 — rt.barIndexHistory의
  // 시각 배열판). 컴포넌트(year~weekofyear)는 bare 방출(genIdentifier)과 동일한 rt.datetime.*에
  // 워밍업 NaN이 자연 전파된다(new Date(NaN), tradingDayStart는 명시 NaN 분기). 리플레이 상수
  // 3종(last_bar_index/last_bar_time/timenow)은 "n바 전 값"도 같은 상수지만 워밍업 NaN 가드가
  // 필요해 bar_index 리터럴 삼항 선례/rt.histConst(동적)로 감싼다. 이 분기는 funcCtx 조회보다
  // 앞이다 — analyzer와 같은 빌트인-우선 순서(genIdentifier의 TIME 분기 위치와 동일, C341).
  if (TIME_VAR_NAMES.has(name)) {
    if (name === "time") return `$.barTimeAt(${offsetCode})`;
    if (name === "time_close") return `$.timeCloseAt(${offsetCode})`;
    if (name === "time_tradingday") return `rt.datetime.tradingDayStart($.barTimeAt(${offsetCode}))`;
    if (name === "last_bar_index" || name === "last_bar_time" || name === "timenow") {
      const constExpr = name === "last_bar_index" ? "($.barCount - 1)" : name === "last_bar_time" ? "$.lastBarTimeMs" : "$.timenowMs";
      return isDynamic ? `rt.histConst(${constExpr}, $.idx, ${offsetCode})` : `($.idx >= ${offsetCode} ? ${constExpr} : NaN)`;
    }
    return `rt.datetime.${name}($.barTimeAt(${offsetCode}))`;
  }
  // UDF 함수-내부 히스토리(C364) — analyzer의 판별 순서(함수-내부 우선, resolveFuncInternalRole)와
  // 동일하게 funcCtx를 top-level 맵보다 먼저 조회한다(함수 '=' 로컬이 동명 top-level '=' 로컬을
  // 섀도잉하는 경우에도 analyzer와 같은 답 — C363의 잠재 섀도잉 갭 수정과 짝).
  const funcHistIdx = funcCtx?.localHistSlots.get(name);
  if (funcHistIdx !== undefined) {
    return isDynamic
      ? `rt.histGet(${genIdentifier(name, program, funcCtx)}, $.histSlots[__histBase + ${funcHistIdx}], ${offsetCode})`
      : `$.histSlots[__histBase + ${funcHistIdx}].get(${offsetCode})`;
  }
  // C714 UDF 확장(next_hint(C715)) — 형제 if/for 블록마다 독립 선언된 '=' 로컬은 이름이 아니라 읽기
  // 지점 자신(expr)으로 analyzer가 이미 확정해둔 함수-상대 슬롯을 조회한다(funcCtx.
  // localAmbiguousNestedHistReadSlots — top-level program.ambiguousNestedHistReadSlots의 UDF 판).
  const funcAmbigHistIdx = funcCtx?.localAmbiguousNestedHistReadSlots.get(expr);
  if (funcAmbigHistIdx !== undefined) {
    return isDynamic
      ? `rt.histGet(${genIdentifier(name, program, funcCtx)}, $.histSlots[__histBase + ${funcAmbigHistIdx}], ${offsetCode})`
      : `$.histSlots[__histBase + ${funcAmbigHistIdx}].get(${offsetCode})`;
  }
  // UDF 함수-내부 drawing 핸들 히스토리(C541) — 바로 위 localHistSlots와 동일한 함수-내부 우선
  // 순서, 물리 배열($.refHistSlots, __refHistBase 콜사이트 블록)과 동적 오프셋 fallback 함수
  // (rt.refHistGet — offset 0은 "지금 변수에 든 값" 자체)만 다르다.
  const funcRefHistIdx = funcCtx?.localRefHistSlots.get(name);
  if (funcRefHistIdx !== undefined) {
    return isDynamic
      ? `rt.refHistGet(${genIdentifier(name, program, funcCtx)}, $.refHistSlots[__refHistBase + ${funcRefHistIdx}], ${offsetCode})`
      : `$.refHistSlots[__refHistBase + ${funcRefHistIdx}].get(${offsetCode})`;
  }
  // C714 UDF 확장의 drawing 핸들 판(funcAmbigHistIdx와 동형) — 형제 블록마다 독립 선언된 drawing
  // 핸들 '=' 로컬은 읽기 지점 자신(expr)으로 확정해둔 함수-상대 ref-hist 슬롯을 조회한다.
  const funcAmbigRefHistIdx = funcCtx?.localAmbiguousNestedRefReadSlots.get(expr);
  if (funcAmbigRefHistIdx !== undefined) {
    return isDynamic
      ? `rt.refHistGet(${genIdentifier(name, program, funcCtx)}, $.refHistSlots[__refHistBase + ${funcAmbigRefHistIdx}], ${offsetCode})`
      : `$.refHistSlots[__refHistBase + ${funcAmbigRefHistIdx}].get(${offsetCode})`;
  }
  // C728: 중첩 top-level var(depth>0)는 이름이 아니라 이 IndexAccess 노드(expr)로 슬롯을 찾는다
  // (analyzer.ts index-access.ts nestedVarReadSlots 주석 참조) — program.varIndex는 이 축을 절대
  // 등록하지 않으므로 이 조회가 우선.
  const slot = program.nestedVarReadSlots.get(expr) ?? program.varIndex.get(name);
  // slot이 없으면(var/varip가 아님) top-level '=' 로컬 히스토리(C363) — localHistorySlots는 이름을
  // 직접 키로 쓴다(historySlots의 varSlot 기반과 대칭, strategyPropHistorySlots와 동일 패턴).
  // 중첩 블록(depth>0, C450/C714) 축은 이름이 아니라 읽기 지점(expr) 자신으로 analyzer가 이미
  // 무모호하게 확정해둔 슬롯을 폴백으로 조회한다(program.ambiguousNestedHistReadSlots — 형제
  // 블록마다 독립적으로 같은 이름을 선언해도 섞이지 않음).
  const histIdx =
    slot !== undefined ? program.historySlots.get(slot) : (program.localHistorySlots.get(name) ?? program.ambiguousNestedHistReadSlots.get(expr));
  if (histIdx !== undefined) {
    return isDynamic
      ? `rt.histGet(${genIdentifier(name, program, funcCtx)}, $.histSlots[${histIdx}], ${offsetCode})`
      : `$.histSlots[${histIdx}].get(${offsetCode})`;
  }
  // drawing 핸들/UDT '=' 로컬 히스토리(배치25 (1)/C637) — 위와 동일한 depth-0/중첩 폴백 체인이지만
  // 별도 물리 배열($.refHistSlots)과 별도 currentValue-fallback 함수(rt.refHistGet, series.ts 참조).
  // UDT 타입 top-level var(C637)는 이름이 아니라 슬롯 번호가 키(historySlots와 동일 원칙)라
  // varRefHistorySlots를 슬롯으로 조회하는 세 번째 폴백이 필요하다.
  const refHistIdx =
    program.refHistorySlots.get(name) ??
    (slot !== undefined ? program.varRefHistorySlots.get(slot) : undefined) ??
    program.ambiguousNestedRefReadSlots.get(expr);
  if (refHistIdx === undefined) throw new Error(`internal: history slot missing for '${name}' (analyzer 통과 후 발생 불가)`);
  return isDynamic
    ? `rt.refHistGet(${genIdentifier(name, program, funcCtx)}, $.refHistSlots[${refHistIdx}], ${offsetCode})`
    : `$.refHistSlots[${refHistIdx}].get(${offsetCode})`;
}

function genIdentifier(
  name: string,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  secCtx: SecurityExprGenContext | null = null,
): string {
  // C738: var 슬라이스 로컬(__svN) — HTF 프리패스 안에서 closure var 이름은 메인 컨텍스트의
  // $.vars[slot]이 아니라 프리패스 자신의 리플레이 로컬을 읽어야 한다(최우선 — 다른 어떤 조회보다
  // 앞. closure 이름은 사용자 변수라 bar series/시간류 예약 이름과 겹치지 않는다).
  if (secCtx !== null && secCtx.sliceLocals !== undefined) {
    const sliceLocal = secCtx.sliceLocals.get(name);
    if (sliceLocal !== undefined) return sliceLocal;
  }
  if (BAR_SERIES_NAMES.has(name)) {
    return genBarRef(name as "open" | "high" | "low" | "close" | "volume", 0, secCtx);
  }
  // hl2/hlc3/ohlc4/hlcc4 — genBarRef를 그대로 재사용해 secCtx(HTF 프리패스) 유무에 따라 자동으로
  // 올바른 4개 피연산자를 얻는다(secCtx===null이면 $.<field>.get(0), secCtx!==null이면 프리패스
  // 루프의 로컬 스칼라 — request.security 표현식 콜사이트는 현재 BAR_SERIES_NAMES 5종만 허용해
  // 이 분기가 secCtx!==null로 실제 도달하는 경로는 아직 없지만, genIdentifier가 모든 Identifier의
  // 단일 진입점이라 두 문맥 모두 정확한 출력을 내도록 대비해둔다).
  if (DERIVED_PRICE_NAMES.has(name)) {
    return genDerivedPriceExpr(
      name as "hl2" | "hlc3" | "ohlc4" | "hlcc4",
      genBarRef("open", 0, secCtx),
      genBarRef("high", 0, secCtx),
      genBarRef("low", 0, secCtx),
      genBarRef("close", 0, secCtx),
    );
  }
  // bar_index — pine2py Context.idx와 동형(analyzer.ts BAR_INDEX_NAME 주석 참조). C441부터
  // request.security 표현식 콜사이트도 이 이름을 허용해(SECURITY_EXPR_TIME_BAR_NAMES) secCtx가
  // non-null일 수 있다 — 그 경우 프리패스 loopVar 자신이 곧 "HTF 시퀀스 내 0-based 위치"라
  // (runtime/security.ts SecurityField 'bar_index' 주석과 동형) 그대로 반환, secCtx===null(메인
  // 타임프레임)은 기존 "$.idx" 그대로(exact-string 테스트 보존).
  if (name === BAR_INDEX_NAME) return secCtx === null ? "$.idx" : secCtx.loopVar;
  // TV 시각 변수(analyzer.ts TIME_VAR_NAMES 주석 참조, C242) — bar_index와 동일한 "top-level bare
  // 식별자, 별도 Series 없이 매 바 그 자리에서 파생" 원칙. year/month/.../second는 Context.barTimeMs
  // (this.time 채널 파생, context.ts 참조)를 공통 입력으로 rt.datetime.*에 위임한다. time/time_close는
  // C441부터 request.security 표현식에서도 허용되어(bar_index와 동일한 이유) secCtx일 때 HTF
  // 프리패스 캐시의 timeOpen/timeClose 배열을 그 행(loopVar) 인덱스로 직접 읽는다 — 로컬 변수로
  // 미리 뽑아두지 않고 그때그때 인라인하는 이유는 open/high/low/close/volume(genSecurityExprPreamble
  // 루프 헤더 상수 선언)과 달리 이 두 필드는 등장 빈도가 낮아 별도 로컬 선언의 이점이 없기 때문.
  if (name === "time") return secCtx === null ? "$.barTimeMs" : `${secCtx.cacheVar}.timeOpen[${secCtx.loopVar}]`;
  if (name === "time_close")
    return secCtx === null ? "$.timeCloseMs" : `${secCtx.cacheVar}.timeClose[${secCtx.loopVar}]`;
  if (name === "last_bar_time") return "$.lastBarTimeMs";
  if (name === "last_bar_index") return "($.barCount - 1)";
  if (name === "timenow") return "$.timenowMs";
  if (name === "time_tradingday") return "rt.datetime.tradingDayStart($.barTimeMs)";
  // C604: year/month/dayofmonth/dayofweek/hour/minute/second/weekofyear — time(위)과 동일하게
  // secCtx일 때는 HTF 프리패스 캐시의 timeOpen[loopVar]를 barTimeMs 대신 입력으로 쓴다(request.security
  // 표현식 콜사이트, TIME_FUNC_NAMES 리프 신설. call-expr.ts buildSecurityExprNode Identifier case
  // 참조 — 이전엔 이 8종이 그 좁은 문법에서 아예 거부돼 secCtx!==null로 도달하는 경로가 없었다).
  // bid/ask(C767, analyzer.ts BID_ASK_NAMES 주석 참조) — 실시간 호가 데이터가 없는 배치 리플레이라
  // 상시 NaN 상수로 근사(na 전파로 비교/산술이 안전하게 흡수됨).
  if (BID_ASK_NAMES.has(name)) return "NaN";
  if (TIME_FUNC_NAMES.has(name)) {
    const barTimeMsExpr = secCtx === null ? "$.barTimeMs" : `${secCtx.cacheVar}.timeOpen[${secCtx.loopVar}]`;
    return `rt.datetime.${name}(${barTimeMsExpr})`;
  }
  if (funcCtx) {
    const localSlot = funcCtx.localVarIndex.get(name);
    if (localSlot !== undefined) return `$.fnVars[__slotBase + ${localSlot}]`;
    // C414: 매개변수는 top-level var 슬롯보다 먼저 확인 — 매개변수명이 top-level var와 같아도
    // 이 함수 본문 안에서는 항상 그 매개변수(호출 시 넘어온 인자값)를 가리켜야 한다(TV shadow
    // 규칙, FuncGenContext.paramNames 주석 참조).
    if (funcCtx.paramNames.has(name)) return safeLocalName(name);
    // C568: func-local '=' 로컬도 동일한 이유로 top-level var 슬롯보다 먼저 확인(FuncGenContext.
    // bodyLocalNames 주석 참조) — wild `f() => arr = array.new<T>() ... arr` 패턴(콜사이트가
    // `var array<T> arr = f()`처럼 동명 top-level var로 결과를 받는 관용구, corpus_scan --exec
    // "Cannot read properties of undefined" 클러스터의 최다 서브축).
    if (funcCtx.bodyLocalNames.has(name)) return safeLocalName(name);
  }
  const slot = program.varIndex.get(name);
  if (slot !== undefined) return `$.vars[${slot}]`;
  if (program.locals.has(name)) return safeLocalName(name);
  throw new Error(`internal: 알 수 없는 식별자 '${name}' (analyzer 통과 후 발생 불가)`);
}

function genBinOp(
  expr: Expr & { kind: "BinOp" },
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  secCtx: SecurityExprGenContext | null = null,
): string {
  const { op, left, right } = expr;
  // `x == na`/`x != na`는 NaN===NaN이 false이므로 rt.na()로 우회 (MEMORY.md Pitfalls 참조)
  if (op === "==") return genEquality(false, left, right, program, funcCtx, secCtx);
  if (op === "!=") return genEquality(true, left, right, program, funcCtx, secCtx);

  const l = genExpr(left, program, funcCtx, secCtx);
  const r = genExpr(right, program, funcCtx, secCtx);
  switch (op) {
    case "+":
      // analyzer.ts isStringExpr가 문자열 연결로 판별한 '+'만 rt.concat으로(na-safe — MEMORY.md
      // Pitfalls "string + null → 'xnull'"), 그 외는 기존 숫자 덧셈 그대로("na/수치 2c-ii").
      return program.concatBinOps.has(expr) ? `rt.concat(${l}, ${r})` : `(${l} + ${r})`;
    case "-":
      return `(${l} - ${r})`;
    case "*":
      return `(${l} * ${r})`;
    case "/":
      return program.idivBinOps.has(expr) ? `rt.idiv(${l}, ${r})` : `rt.pineDiv(${l}, ${r})`;
    case "%":
      return `rt.pineMod(${l}, ${r})`;
    // na가 하나라도 있으면 결과도 na — JS 네이티브 </>/<=/>=는 NaN에서 항상 false를 반환해 na가
    // 조용히 사라지므로(DIVERGENCES.md #4, C25 pineNot과 같은 클래스) rt.pineLt/pineGt/pineLe/pineGe로
    // 우회(ROADMAP P2 "C25 발견" 항목).
    case "<":
      return `rt.pineLt(${l}, ${r})`;
    case ">":
      return `rt.pineGt(${l}, ${r})`;
    case "<=":
      return `rt.pineLe(${l}, ${r})`;
    case ">=":
      return `rt.pineGe(${l}, ${r})`;
    // na가 하나라도 있으면 무조건 na인 pineLt류와 달리 and/or는 진짜 Kleene 3치 논리(false가
    // AND를, true가 OR를 다른 피연산자의 na 여부와 무관하게 결정) — JS 네이티브 &&/||는 NaN을
    // falsy로만 취급해 `na && false`(NaN 반환, true 이면 false여야 함) 등 여러 조합에서 어긋나므로
    // rt.pineAnd/pineOr로 우회(numeric.ts 주석 참조, ROADMAP P2 "C67 발견" 항목).
    case "and":
      return `rt.pineAnd(${l}, ${r})`;
    case "or":
      return `rt.pineOr(${l}, ${r})`;
  }
}

function genEquality(
  negate: boolean,
  left: Expr,
  right: Expr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  // C602: request.security expression 좁은 문법(call-expr.ts SECURITY_EXPR_EQUALITY_OPS)이 이
  // 함수까지 재귀로 도달한다 — secCtx===null(기존 전 호출부)이면 default 파라미터와 동치라 출력
  // 불변, secCtx!==null이면 genExpr을 HTF 프리패스 로컬(cache/loopVar)로 재작성한다(C444 nz()가
  // 고친 것과 동일 계열의 secCtx 스레딩 갭).
  secCtx: SecurityExprGenContext | null = null,
): string {
  if (left.kind === "NaLiteral" || right.kind === "NaLiteral") {
    const operand = left.kind === "NaLiteral" ? right : left;
    const naCheck = `rt.na(${genExpr(operand, program, funcCtx, secCtx)})`;
    return negate ? `(!${naCheck})` : naCheck;
  }
  const l = genExpr(left, program, funcCtx, secCtx);
  const r = genExpr(right, program, funcCtx, secCtx);
  // C812: 네이티브 `===`/`!==` 대신 rt.pineEq/pineNeq — Float64Array 히스토리 슬롯을 왕복한 bool은
  // 1/0이 되어 `b[1] == true`가 `1 === true`(false)로 떨어지던 조용한 오답을 닫는다(C602, C811 실측
  // 확정). 그 외 타입은 pineEq 안에서 `===`로 그대로 떨어져 기존 동작 보존(numeric.ts 주석 참조).
  return negate ? `rt.pineNeq(${l}, ${r})` : `rt.pineEq(${l}, ${r})`;
}

// strategy.closedtrades.<method>/strategy.opentrades.<method>(index)(C173 entry_comment/
// exit_comment → C308 확장) — builtinName("strategy.<namespace>.<method>", dot 두 개)을
// StrategyState의 평평한 메서드 이름으로 매핑한다(call-expr.ts STRATEGY_TRADE_ACCESSOR_METHODS와
// 대칭 표 — 아래 `$.${builtinName}(...)` 일반형은 프로퍼티 경로를 그대로 따라가므로 그 값 그대로
// 쓰면 존재하지 않는 `$.strategy.closedtrades.entry_price`가 되어버려 이 매핑이 필요하다). C309부터
// "트레이드 접근자"뿐 아니라 같은 dot-두-개 모양을 쓰는 strategy.risk.* setter도 이 표를 공유한다
// (call-expr.ts strategy.risk.allow_entry_in 분기와 대칭).
const STRATEGY_TRADE_ACCESSOR_RT_METHODS: Readonly<Record<string, string>> = {
  "strategy.closedtrades.entry_comment": "closedTradeEntryComment",
  "strategy.closedtrades.exit_comment": "closedTradeExitComment",
  "strategy.closedtrades.entry_price": "closedTradeEntryPrice",
  "strategy.closedtrades.exit_price": "closedTradeExitPrice",
  "strategy.closedtrades.entry_bar_index": "closedTradeEntryBarIndex",
  "strategy.closedtrades.exit_bar_index": "closedTradeExitBarIndex",
  "strategy.closedtrades.entry_id": "closedTradeEntryId",
  "strategy.closedtrades.exit_id": "closedTradeExitId",
  "strategy.closedtrades.profit": "closedTradeProfit",
  "strategy.closedtrades.size": "closedTradeSize",
  "strategy.opentrades.entry_price": "openTradeEntryPrice",
  "strategy.opentrades.entry_bar_index": "openTradeEntryBarIndex",
  "strategy.opentrades.entry_id": "openTradeEntryId",
  "strategy.opentrades.size": "openTradeSize",
  // C312: closedtrades/opentrades.max_drawdown/max_runup/profit_percent + opentrades.profit
  // (C308이 범위 밖으로 보류했던 4종).
  "strategy.closedtrades.profit_percent": "closedTradeProfitPercent",
  "strategy.closedtrades.max_drawdown": "closedTradeMaxDrawdown",
  "strategy.closedtrades.max_runup": "closedTradeMaxRunup",
  "strategy.opentrades.profit": "openTradeProfit",
  "strategy.opentrades.profit_percent": "openTradeProfitPercent",
  "strategy.opentrades.max_drawdown": "openTradeMaxDrawdown",
  "strategy.opentrades.max_runup": "openTradeMaxRunup",
  // C418: entry_time/exit_time/commission(wild "지원하지 않는 호출" '?.' 서브클러스터).
  "strategy.closedtrades.entry_time": "closedTradeEntryTime",
  "strategy.closedtrades.exit_time": "closedTradeExitTime",
  "strategy.closedtrades.commission": "closedTradeCommission",
  "strategy.opentrades.entry_time": "openTradeEntryTime",
  "strategy.opentrades.commission": "openTradeCommission",
  "strategy.risk.allow_entry_in": "setAllowEntryIn",
  // strategy.risk.max_position_size(value)(C324) — analyzer가 위치 인자 정확히 1개만(kwargs 0개)
  // 검증해(call-expr.ts 해당 분기 참조) allow_entry_in과 동일하게 "kwargs 없음, 위치 인자 그대로
  // 통과" 계약을 만족하므로 별도 분기 없이 이 표에 바로 등록 가능.
  "strategy.risk.max_position_size": "setMaxPositionSize",
  // strategy.risk.max_cons_loss_days(count)(C325) — analyzer가 위치 인자 정확히 1개만(kwargs 0개)
  // 검증해(call-expr.ts 해당 분기 참조) max_position_size와 동일한 "kwargs 없음, 위치 인자 그대로
  // 통과" 계약을 만족하므로 별도 분기 없이 이 표에 바로 등록 가능.
  "strategy.risk.max_cons_loss_days": "setMaxConsLossDays",
  // strategy.default_entry_qty(price)(C429) — 2-level 콜(analyzer.ts 별도 분기, stmtCalls 게이트
  // 없음)이지만 "kwargs 없음, 위치 인자(price 1개) 그대로 통과" 계약이 트레이드 접근자와 동일해
  // 같은 표에 바로 등록 가능(OPEN_TRADE_CLOSE_PRICE_METHODS 암묵 주입 대상 아님 — price는 이미
  // 사용자가 명시).
  "strategy.default_entry_qty": "defaultEntryQty",
};

// strategy.opentrades.profit/profit_percent(C312)는 다른 트레이드 접근자와 달리 미실현 손익
// 계산에 현재 종가가 추가로 필요하다(strategy.openprofit이 analyzer.ts STRATEGY_RUNTIME_PROPS에서
// `$.close.get(0)`을 직접 문자열로 박아 넣는 것과 동일 구조 — 단 이쪽은 index 인자가 있는 CallExpr
// 라 그 인자 앞에 종가를 끼워 넣어야 한다). strategy.* 콜은 request.security HTF 프리패스(secCtx)
// 안에 올 수 없어(narrow 표현식 문법에 strategy.*가 없음) genBarRef 없이 항상 메인 타임프레임의
// `$.close.get(0)` 리터럴로 충분하다.
const OPEN_TRADE_CLOSE_PRICE_METHODS: ReadonlySet<string> = new Set([
  "strategy.opentrades.profit",
  "strategy.opentrades.profit_percent",
]);

// series length 변형 rtPath 표 (배치25 (4), C547 highest/lowest → C548 sma → C549 highestbars/
// lowestbars → C550 median/linreg/wma → C551 stdev/sum → C552 pivothigh/pivotlow → C553 range/
// percentile_nearest_rank/percentile_linear_interpolation → C555 vwma, 배치25 (4) 전체 종결) —
// TA_REGISTRY의 seriesLengthOk:true 항목과 1:1로 유지할 것(genCallExpr의 stateCall.seriesLength
// 분기 주석 참조).
const VARLEN_RT_PATHS: Readonly<Record<string, string>> = {
  highest: "rt.ta.highestVarLen",
  lowest: "rt.ta.lowestVarLen",
  sma: "rt.ta.smaVarLen",
  highestbars: "rt.ta.highestbarsVarLen",
  lowestbars: "rt.ta.lowestbarsVarLen",
  median: "rt.ta.medianVarLen",
  linreg: "rt.ta.linregVarLen",
  wma: "rt.ta.wmaVarLen",
  stdev: "rt.ta.stdevVarLen",
  sum: "rt.ta.sumVarLen",
  pivothigh: "rt.ta.pivothighVarLen",
  pivotlow: "rt.ta.pivotlowVarLen",
  range: "rt.ta.rangeVarLen",
  percentile_nearest_rank: "rt.ta.percentileNearestRankVarLen",
  percentile_linear_interpolation: "rt.ta.percentileLinearInterpolationVarLen",
  vwma: "rt.ta.vwmaVarLen",
};

function genCallExpr(
  expr: CallExpr,
  program: AnalyzedProgram,
  funcCtx: FuncGenContext | null,
  secCtx: SecurityExprGenContext | null = null,
): string {
  // C605: securityExprTupleTaReads(analyzer.ts uniqueTopEqTuples 치환 주석 참조) — 합성 CallExpr
  // 래퍼는 원본 소스에 대응이 없어 아래 stateCallSlots 등 어떤 조회에도 안 걸린다(fresh 객체라
  // Map 키로도 절대 안 겹침). 안의 실제 다중 반환 ta.* 클론을 genExpr해(스스로 stateCallSlots
  // 표준 경로를 타 $.taScratch에 쓰는 문자열이 된다) JS comma-식으로 즉시 그 index를 읽는다 —
  // 이 래퍼가 트리 안에서 유일한 임베딩 지점이라 클론이 텍스트 중복 없이 정확히 1회만 평가된다.
  const tupleTaRead = program.securityExprTupleTaReads.get(expr);
  if (tupleTaRead !== undefined) {
    const callCode = genExpr(tupleTaRead.taCall, program, funcCtx, secCtx);
    return `(${callCode}, $.taScratch[${tupleTaRead.index}])`;
  }
  const stateCall = program.stateCallSlots.get(expr);
  if (stateCall !== undefined) {
    const entry = TA_REGISTRY[stateCall.fn]!;
    // C400: kwargs(source=/length=/source1=/source2=... — entry.kwargParamNames 참조)를 위치 인자로
    // 정규화한 뒤 genExpr — analyzer(analyzeStatefulCall)가 이미 이름/중복/구멍을 전부 검증해 여기
    // 도달한 콜사이트는 항상 구멍 없는 완전한 배열이다(에러가 있었으면 pipeline이 codegen 전에
    // 멈춘다). kwargs가 없으면 resolveTaKwargPositions가 expr.args를 그대로 반환해 기존 출력과
    // 바이트 동일(회귀 없음).
    const args = resolveTaKwargPositions(expr, entry).map((a) => genExpr(a!, program, funcCtx, secCtx));
    // series length(analyzer.ts TA_REGISTRY.seriesLengthOk, stateCall.seriesLength) — 해당 콜사이트만
    // state-fixed rtPath(고정폭 버퍼/윈도우)를 우회해 자체 히스토리 버퍼로 매 호출 재스캔하는 변형
    // (runtime/ta.ts highestVarLen/lowestVarLen/smaVarLen)으로 낸다. $.barCount(메인 타임프레임
    // 전체 바 수)는 security HTF 프리패스 경로(secCtx!==null)에서도 호출 횟수의 안전한 상한이다 —
    // HTF 콜사이트 호출 횟수는 항상 메인 타임프레임 바 수 이하이므로 과할당은 되어도 범위 밖 접근은
    // 없다. 이 표는 TA_REGISTRY.seriesLengthOk가 true인 항목과 1:1이어야 한다(analyzer/ta.ts
    // seriesLengthOk 필드 주석 참조 — 표에 없는 fn에 seriesLengthOk를 놓으면 여기서 undefined가
    // 새므로 non-null 단언 대신 명시 폴백 없이 lookup 실패를 tsc가 못 잡는다, 추가 시 나란히 갱신).
    let rtPath = entry.rtPath;
    if (stateCall.seriesLength) {
      rtPath = VARLEN_RT_PATHS[stateCall.fn]!;
    }
    // 아래 암묵 series 주입 캐스케이드는 전부 genBarRef를 거친다 — secCtx===null(메인 타임프레임
    // 경로, 지금까지의 유일한 호출자)이면 genBarRef가 기존 `$.<field>.get(<offset>)` 문자열을
    // 한 글자도 안 바꾸고 그대로 낸다(C129류 "출력 불변" 회귀 안전 원칙). secCtx!==null(request.
    // security 셋째 슬라이스 3b, HTF 프리패스 함수 본문)일 때만 로컬 스칼라/캐시 배열 참조로
    // 갈라진다 — 이 함수들이 3a에서 security expr 콜사이트로 허용된 이유는 matchSecurityExprTaCall이
    // dispatch/다중반환/kwargs만 보고 이 암묵 인자 유무는 안 가리기 때문(narrow 문법이지만 이
    // 함수들도 구조적으로는 통과함, PROGRESS.md C181 참조).
    if (stateCall.fn === "highest" || stateCall.fn === "lowest") {
      // ta.highest(length) / ta.lowest(length) — source 생략 1-인자 축약형(analyzer.ts TA_REGISTRY
      // sourceOmittable 주석 참조, C250) — pine2py highest.py/lowest.py의 런타임
      // `isinstance(source,(int,float))` 스니핑을 컴파일타임 인자 개수 판정으로 이식. 2-인자 폼
      // (source, length)은 그대로 두고, 1-인자 폼만 length(index 0) 앞에 암묵 소스를 끼워 넣어
      // 런타임 시그니처 (state, source, length)를 맞춘다.
      if (args.length === 1) {
        args.unshift(genBarRef(stateCall.fn === "highest" ? "high" : "low", 0, secCtx));
      }
    }
    if (stateCall.fn === "highestbars" || stateCall.fn === "lowestbars") {
      // ta.highestbars(length) / ta.lowestbars(length) — source 생략 1-인자 축약형(analyzer.ts
      // TA_REGISTRY sourceOmittable 주석 참조, C655) — highest/lowest(C250)와 동일한 unshift 패턴.
      // 2-인자 폼(source, length)은 그대로 두고, 1-인자 폼만 length(index 0) 앞에 암묵 소스를
      // 끼워 넣어 런타임 시그니처 (state, source, length)를 맞춘다.
      if (args.length === 1) {
        args.unshift(genBarRef(stateCall.fn === "highestbars" ? "high" : "low", 0, secCtx));
      }
    }
    if (stateCall.fn === "pivothigh" || stateCall.fn === "pivotlow") {
      // ta.pivothigh(leftbars, rightbars) / ta.pivotlow(leftbars, rightbars) — source 생략 2-인자
      // 축약형(analyzer.ts TA_REGISTRY sourceOmittable 주석 참조, C509) — highest/lowest(C250)와
      // 동일한 unshift 패턴, 다만 최소 인자 개수가 2(leftbars/rightbars)라는 점만 다르다. 3-인자
      // (source, leftbars, rightbars) 폼은 그대로 두고, 2-인자 폼만 leftbars(index 0) 앞에 암묵
      // 소스를 끼워 넣어 런타임 시그니처 (state, source, left, right)를 맞춘다.
      if (args.length === 2) {
        args.unshift(genBarRef(stateCall.fn === "pivothigh" ? "high" : "low", 0, secCtx));
      }
    }
    if (stateCall.fn === "vwma" || stateCall.fn === "mfi") {
      // ta.vwma(source, length) / ta.mfi(source, length) — Pine 문법에 volume 인자가 없고
      // 내장 bar series volume을 암묵 사용한다(analyzer.ts TA_REGISTRY.vwma/mfi 주석 참조).
      // source(index 0) 다음, length 앞에 끼워 넣어 런타임 시그니처 (state, source, volume,
      // length)를 맞춘다 — 두 함수 모두 동일한 2-인자 표준 시그니처 + volume 주입 패턴.
      args.splice(1, 0, genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "vwap") {
      // ta.vwap(source[, anchor[, stdev_mult]]) — Pine 문법에 volume 인자가 없고 내장 bar series
      // volume을 암묵 사용한다(analyzer.ts TA_REGISTRY.vwap 주석 참조). C243의 1-인자 폼은 source가
      // 마지막 인자라 push로 충분했지만 C362의 2/3-인자 폼은 anchor/stdev_mult가 뒤에 오므로 push가
      // volume을 그 뒤로 밀어 순서가 깨진다 — vwma/mfi와 동일하게 source(index 0) 바로 뒤에 splice로
      // 끼워 넣어 런타임 시그니처 (state, source, volume[, anchor[, stdevMult[, scratch]]])를 맞춘다.
      // 1-인자 폼에서는 splice(1,0,·)===push라 기존 방출 문자열과 바이트 동일(회귀 없음).
      args.splice(1, 0, genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "wpr") {
      // ta.wpr(length) — Pine 문법에 close/high/low 인자가 없고 내장 bar series를 암묵 사용한다
      // (analyzer.ts TA_REGISTRY.wpr 주석 참조). 유일한 사용자 인자 length(index 0) 앞에 셋을 끼워
      // 넣어 런타임 시그니처 (state, close, high, low, length)를 맞춘다.
      args.unshift(genBarRef("close", 0, secCtx), genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx));
    }
    if (stateCall.fn === "tr" || stateCall.fn === "atr") {
      // ta.tr(handle_na) / ta.atr(length) — Pine 문법에 high/low/close 인자가 없고 내장 bar series를
      // 암묵 사용한다(analyzer.ts TA_REGISTRY.tr/atr 주석 참조). tr()의 유일한 실제 사용처는 prevClose
      // (close.get(1))뿐 — 현재 바 close는 안 쓴다(runtime/ta.ts tr() 주석 참조). tr의 유일한 사용자
      // 인자는 handle_na(선택, 0~1개, C291)이고 atr은 length 하나뿐이라 앞에 셋을 끼워 넣어 런타임
      // 시그니처 (state, high, low, prevClose[, handle_na|length])를 맞춘다 — unshift는 항상 배열
      // 앞에만 추가하므로 handle_na(있다면)는 그대로 맨 뒤에 남아 순서가 저절로 맞는다. secCtx!==null
      // 일 때 prevClose는 "직전 HTF 바의 close"(genBarRef offset 1, h===0이면 NaN)로 재해석된다.
      args.unshift(genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx), genBarRef("close", 1, secCtx));
    }
    if (stateCall.fn === "kc" || stateCall.fn === "kcw") {
      // ta.kc(source, length, mult, useTrueRange) / ta.kcw(...) — Pine 문법에 high/low/close 인자가
      // 없고 내장 bar series를 암묵 사용한다(analyzer.ts TA_REGISTRY.kc/kcw 주석 참조, atr과 동일
      // 패턴). useTrueRange(4번째 사용자 인자)는 TV 기본값 true라 생략 가능(TA_REGISTRY.minArgCount:3,
      // C227) — kcw는 아래 unshift 뒤 그대로 트레일링 생략(JS 기본 파라미터가 자연히 채움)이 안전하지만,
      // kc만은 아래 returnArity 처리가 user args 뒤에 "$.taScratch"를 push하므로 생략된 useTrueRange
      // 자리를 여기서 명시적 "undefined"로 먼저 채우지 않으면 scratch가 그 자리로 밀려들어가 런타임
      // 시그니처가 한 칸씩 어긋난다(math.random의 패딩과 동일 원칙, kc 전용).
      if (stateCall.fn === "kc") {
        while (args.length < 4) args.push("undefined");
      }
      // 유일한 사용자 인자들(source, length, mult, useTrueRange) 앞에 셋을 끼워 넣어 런타임 시그니처
      // (state, high, low, prevClose, source, length, mult, useTrueRange[, scratch])를 맞춘다.
      args.unshift(genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx), genBarRef("close", 1, secCtx));
    }
    if (stateCall.fn === "obv") {
      // ta.obv() — Pine 문법에 인자가 없고 close/volume을 내장 bar series로 암묵 사용한다
      // (analyzer.ts TA_REGISTRY.obv 주석 참조). 런타임 시그니처 (state, close, volume)를 맞춘다.
      args.push(genBarRef("close", 0, secCtx), genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "accdist") {
      // ta.accdist() — Pine 문법에 인자가 없고 close/high/low/volume을 내장 bar series로 암묵
      // 사용한다(analyzer.ts TA_REGISTRY.accdist 주석 참조). 런타임 시그니처
      // (state, close, high, low, volume)를 맞춘다.
      args.push(genBarRef("close", 0, secCtx), genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx), genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "pvt") {
      // ta.pvt() — Pine 문법에 인자가 없고 close/volume을 내장 bar series로 암묵 사용한다
      // (analyzer.ts TA_REGISTRY.pvt 주석 참조). 런타임 시그니처 (state, close, volume)를 맞춘다.
      args.push(genBarRef("close", 0, secCtx), genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "wad") {
      // ta.wad() — Pine 문법에 인자가 없고 high/low/close를 내장 bar series로 암묵 사용한다
      // (analyzer.ts TA_REGISTRY.wad 주석 참조). 런타임 시그니처 (state, high, low, close)를 맞춘다.
      args.push(genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx), genBarRef("close", 0, secCtx));
    }
    if (stateCall.fn === "nvi" || stateCall.fn === "pvi") {
      // ta.nvi() / ta.pvi() — Pine 문법에 인자가 없고 close/volume을 내장 bar series로 암묵
      // 사용한다(analyzer.ts TA_REGISTRY.nvi/pvi 주석 참조). 런타임 시그니처
      // (state, close, volume)를 맞춘다(obv/pvt와 동일 패턴).
      args.push(genBarRef("close", 0, secCtx), genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "wvad") {
      // ta.wvad() — Pine 문법에 인자가 없고 open/high/low/close/volume을 내장 bar series로 암묵
      // 사용한다(analyzer.ts TA_REGISTRY.wvad 주석 참조, 지금까지의 implicit-push 그룹 중 인자
      // 개수가 가장 많음). 런타임 시그니처 (state, open, high, low, close, volume)를 맞춘다.
      args.push(
        genBarRef("open", 0, secCtx),
        genBarRef("high", 0, secCtx),
        genBarRef("low", 0, secCtx),
        genBarRef("close", 0, secCtx),
        genBarRef("volume", 0, secCtx),
      );
    }
    if (stateCall.fn === "iii") {
      // ta.iii() — Pine 문법에 인자가 없고 high/low/close/volume을 내장 bar series로 암묵
      // 사용한다(analyzer.ts TA_REGISTRY.iii 주석 참조). 런타임 시그니처
      // (state, high, low, close, volume)를 맞춘다(accdist와 동일 인자 구성).
      args.push(genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx), genBarRef("close", 0, secCtx), genBarRef("volume", 0, secCtx));
    }
    if (stateCall.fn === "ao") {
      // ta.ao() — Pine 문법에 인자가 없고 hl2((high+low)/2)를 내장 파생 bar series로 암묵
      // 사용한다(analyzer.ts TA_REGISTRY.ao 주석 참조, obv/accdist와 동일 implicit-injection
      // 패턴이나 파생값 하나뿐). genDerivedPriceExpr로 hl2 문자열을 조립해 push — genBarRef를
      // 거치므로 secCtx(HTF 프리패스) 유무와 무관하게 genIdentifier의 hl2 분기와 동일한 값을 낸다.
      args.push(
        genDerivedPriceExpr(
          "hl2",
          genBarRef("open", 0, secCtx),
          genBarRef("high", 0, secCtx),
          genBarRef("low", 0, secCtx),
          genBarRef("close", 0, secCtx),
        ),
      );
    }
    if (stateCall.fn === "supertrend") {
      // ta.supertrend(factor, atrPeriod) — Pine 문법에 high/low/close 인자가 없고 내장 bar series를
      // 암묵 사용한다(analyzer.ts TA_REGISTRY.supertrend 주석 참조, atr/kc와 동일 패턴 + 현재 close
      // 슬롯 하나 추가). 유일한 사용자 인자들(factor, atrPeriod) 앞에 넷을 끼워 넣어 런타임 시그니처
      // (state, high, low, close, prevClose, factor, atrPeriod[, scratch])를 맞춘다.
      args.unshift(
        genBarRef("high", 0, secCtx),
        genBarRef("low", 0, secCtx),
        genBarRef("close", 0, secCtx),
        genBarRef("close", 1, secCtx),
      );
    }
    if (stateCall.fn === "sar") {
      // ta.sar(start, inc, maxAf) — Pine 문법에 high/low/close 인자가 없고 내장 bar series를
      // 암묵 사용한다(analyzer.ts TA_REGISTRY.sar 주석 참조, atr과 동일 패턴이나 prevClose 주입은
      // 불필요 — sar 자신이 state로 prevClose를 추적).
      args.unshift(genBarRef("high", 0, secCtx), genBarRef("low", 0, secCtx), genBarRef("close", 0, secCtx));
    }
    if (stateCall.fn === "dmi") {
      // ta.dmi(diLength, adxSmoothing) — Pine 문법에 high/low/close 인자가 없고 내장 bar series를
      // 암묵 사용한다(analyzer.ts TA_REGISTRY.dmi 주석 참조). 유일한 사용자 인자들(diLength,
      // adxSmoothing) 앞에 여섯 개(현재 바 + 1바 전 high/low/close, 지금까지 최다)를 끼워 넣어
      // 런타임 시그니처 (state, high, low, close, prevHigh, prevLow, prevClose, diLength,
      // adxSmoothing, scratch)를 맞춘다. dmi는 다중 반환이라 3a가 security expr 콜사이트에서 이미
      // 하드 에러로 거부해(matchSecurityExprTaCall의 returnArity 체크) secCtx는 항상 null인 채로만
      // 도달한다 — genBarRef가 그 경우 기존 출력과 동일하므로 이 분기도 그대로 통일해 안전하다.
      args.unshift(
        genBarRef("high", 0, secCtx),
        genBarRef("low", 0, secCtx),
        genBarRef("close", 0, secCtx),
        genBarRef("high", 1, secCtx),
        genBarRef("low", 1, secCtx),
        genBarRef("close", 1, secCtx),
      );
    }
    if (stateCall.fn === "pivot_point_levels") {
      // ta.pivot_point_levels(type, anchor, developing=false) — Pine 문법에 open/high/low/close
      // 인자가 없고 내장 bar series를 암묵 사용한다(analyzer.ts TA_REGISTRY.pivot_point_levels
      // 주석 참조). developing(3번째 사용자 인자)이 생략된 2-인자 폼은 "false"로 명시 패딩해
      // (math.random의 누락-슬롯 패딩과 동일 원리) 뒤에 붙는 bar series 4개가 그 자리를 침범하지
      // 않게 한 뒤, 런타임 시그니처 (state, type, anchor, developing, open, high, low, close)를
      // 맞춘다. 반환값이 array<float> 핸들이라 security expr 콜사이트는 analyzer가 이미
      // 거부(matchSecurityExprTaCall의 returnsArrayHandle 체크)해 secCtx는 항상 null로만 도달한다.
      while (args.length < 3) args.push("false");
      args.push(
        genBarRef("open", 0, secCtx),
        genBarRef("high", 0, secCtx),
        genBarRef("low", 0, secCtx),
        genBarRef("close", 0, secCtx),
      );
    }
    if (stateCall.fn === "random") {
      // math.random(min=0, max=1, seed=na) — 사용자 인자가 0~3개 가변이라(TA_REGISTRY.minArgCount:0,
      // analyzer.ts TA_REGISTRY.random 주석 참조) 누락분을 명시적 "undefined" 리터럴로 채워, 콜사이트
      // slot(런타임 함수의 site 파라미터 — seed 미지정 시 기본 시퀀스를 콜사이트마다 다르게 만드는
      // 용도)이 항상 고정된 4번째 위치에 오도록 맞춘다. JS 기본 파라미터는 "누락"뿐 아니라 "명시적
      // undefined 전달"에도 적용되므로 이 패딩이 안전하다(runtime/ta.ts random() 주석 참조).
      while (args.length < 3) args.push("undefined");
      // UDF 본문 안(C162)이면 site도 실제 전역 슬롯(__taBase + 상대슬롯)으로 — 콜사이트마다
      // 달라야 하는 site의 존재 이유(기본 시퀀스 분리)와 정합.
      args.push(stateCall.inUdf ? `__taBase + ${stateCall.slot}` : String(stateCall.slot));
    }
    if (taCallReturnArity(entry, expr.args.length) !== undefined) {
      // 다중 반환 TA(ta.macd 등) — rt 함수는 반환값 대신 Context의 공유 스크래치 배열
      // $.taScratch[0..N-1]에 쓴다(GOAL.md "다중 반환 TA는 재사용 스크래치 배열"). 이 콜 식은
      // genTupleDestructure만 문장으로 소비한다(표현식 위치는 analyzer가 이미 거부).
      // C362: 인자 개수 의존 arity(vwap)는 **사용자 인자 개수**(expr.args.length — 위 암묵 주입으로
      // 변형된 args가 아니라 원본 AST)로 판정한다 — 3-인자 vwap만 스크래치를 받고 1/2-인자 폼은
      // 스칼라 반환 그대로(taCallReturnArity 주석 참조).
      args.push("$.taScratch");
    }
    if (stateCall.seriesLength) {
      // *VarLen 변형(VARLEN_RT_PATHS)의 마지막 두 인자 — barCount는 자체 히스토리 버퍼를 최초 1회
      // 할당하기 위한 상한(runtime/ta.ts 주석 참조). barIdx는 "같은 바 안 반복 호출은 push가 아니라
      // 덮어쓰기"를 판별하는 기준(pine2py context.param()의 `len(s) <= self.idx` 이식 — 바로 위
      // 함수 주석의 corpus_diff 회귀 참조) — bar_index 식별자 codegen과 동일하게 secCtx===null이면
      // 메인 타임프레임 $.idx, security HTF 프리패스면 그 루프 자신의 현재 위치(secCtx.loopVar)를
      // 쓴다. 다른 암묵 주입/returnArity 패딩이 전부 끝난 뒤 맨 끝에 붙여야 (state, source, length,
      // barCount, barIdx) 시그니처가 그대로 유지된다. linreg(C550)는 length 뒤에 선택 인자 offset이
      // 있어(minArgCount 2) 고정 경로에서는 JS 기본 파라미터(offset=0)로 처리되지만, varlen 경로는
      // 뒤에 barCount/barIdx가 더 붙어 그 자리를 침범하므로 2-인자 폼만 기본값 0을 명시적으로 패딩해
      // 런타임 시그니처 (state, value, length, offset, barCount, barIdx)를 맞춘다(math.random의
      // 누락-슬롯 명시 패딩과 동일 원리 — 3-인자 폼과 고정 경로 출력은 바이트 불변).
      if (stateCall.fn === "linreg" && args.length === 2) {
        args.push("0");
      }
      // stdev(C551) — length 뒤에 선택 인자 biased(기본 true)가 있어(minArgCount 2) linreg의
      // offset 패딩과 동일 원리로 2-인자 폼만 명시적으로 true를 패딩해 런타임 시그니처
      // (state, value, length, biased, barCount, barIdx)를 맞춘다.
      if (stateCall.fn === "stdev" && args.length === 2) {
        args.push("true");
      }
      // percentile_nearest_rank/percentile_linear_interpolation(C553) — length 뒤에 선택 인자
      // percentage(기본 50)가 있어(minArgCount 2) linreg/stdev와 동일 원리로 2-인자 폼만 명시적으로
      // 50을 패딩해 런타임 시그니처 (state, value, length, percentage, barCount, barIdx)를 맞춘다.
      if (
        (stateCall.fn === "percentile_nearest_rank" || stateCall.fn === "percentile_linear_interpolation") &&
        args.length === 2
      ) {
        args.push("50");
      }
      args.push("$.barCount", secCtx === null ? "$.idx" : secCtx.loopVar);
    }
    // UDF/method 본문 안(C162)의 stateful 콜은 함수-상대 슬롯이라 콜사이트가 인자로 전달한
    // __taBase에 더해 실제 전역 슬롯을 만든다 — $.fnVars[__slotBase + i]와 동형.
    const slotRef = stateCall.inUdf ? `__taBase + ${stateCall.slot}` : String(stateCall.slot);
    return `${rtPath}($.taSlots[${slotRef}], ${args.join(", ")})`;
  }
  if (program.noopStmtCalls.has(expr)) {
    // hline/bgcolor/.../alert(...)(C208) 콜이 문장 위치가 아니라 식 위치(대입 RHS 등)에서 genExpr로
    // 도달하는 드문 경로 — analyzer가 topLevel 필수 대상은 이미 거부하지만 alert()는 예외라(위
    // NOOP_BUILTIN_ANY 주석) 이론상 `x = alert(...)` 같은 잘못된 Pine도 analyzer를 통과할 수 있다.
    // ExprStmt 분기(genStmt)가 이 경로를 대부분 가로채므로 실사용에서 거의 안 닿지만, TV에서도 이
    // 함수들은 전부 void 반환이라 "값이 필요한 위치에서 안전한 자리표시자"로 undefined가 정확하다.
    return "undefined";
  }
  const plotSlot = program.plotCallSlots.get(expr);
  if (plotSlot !== undefined) {
    // plot(series, title)(C135) — title은 analyze-time에 이미 prog.plotTitles로 소비된 순수
    // 메타데이터라 codegen은 series 값만 record한다. Series.record()가 preallocate된
    // 슬롯의 현재 cursor 위치(=이번 바, Context.advance()가 barFn() 실행 전에 이미 전진시켜둠)에
    // 쓴다 — histSlots의 var 히스토리 record()와 달리 문장이 실행되는 그 시점에 바로 기록해도
    // 안전하다(plot 슬롯은 write-only 출력 채널이라 같은 바 안에서 다시 읽는 코드가 없음).
    // series는 위치 인자(args[0]) 또는 `series=` 키워드 인자(C313) 둘 중 하나 — analyzer가
    // 이미 정확히 하나만 존재함을 보장(둘 다/둘 다 없음은 analyzer 에러로 codegen에 안 옴).
    const seriesExpr = expr.args.length > 0 ? expr.args[0]! : expr.kwargs.find((kw) => kw.name === "series")!.value;
    const record = `$.plots[${plotSlot}].record(${genExpr(seriesExpr, program, funcCtx)})`;
    const colorEntry = program.plotColorExprs.get(expr);
    if (colorEntry !== undefined) {
      // viz S1 — 색이 런타임 표현식인 콜사이트: 값 record와 같은 바에서 색을 평가해 CSS
      // 문자열(na 색은 null)을 직접 인덱스로 기록한다. plot은 v5 제약상 항상 top-level이라
      // 매 바 실행이 보장되고, 쉼표식은 이 반환값이 ExprStmt/fill-구제 어느 위치에 놓여도
      // 단일 표현식으로 안전하다.
      return `(${record}, void ($.plotColors[${colorEntry.slot}][$.idx] = rt.vizColor(${genExpr(colorEntry.expr, program, funcCtx)})))`;
    }
    return record;
  }
  const securityCall = program.securityCallSlots.get(expr);
  if (securityCall !== undefined) {
    // request.security — symbol(args[0])/timeframe(args[1])은 analyze-time에 이미 검증/소비된
    // 컴파일타임 정보(slot 배정에만 쓰임)라 codegen은 방출하지 않는다. field는 analyzer가 정적으로
    // 확정한 BAR_SERIES_NAMES 문자열이라 리터럴로 그대로 내린다($.idx는 Context.advance()가 매 바
    // 미리 전진시켜둔 현재 바 인덱스, GOAL.md 배치 리플레이 원칙). gaps/lookahead(둘째 슬라이스,
    // C177)도 analyze-time에 boolean으로 확정되므로 리터럴로 방출(get() 안 런타임 분기 없음).
    // multiSite(C529): slot은 콜사이트별 tf 블록의 시작 — __secIdx(C453 서수, 이 맵의 multiSite
    // 항목은 UDF 본문 안 노드에만 등록되므로 항상 스코프에 존재)를 더해 콜사이트별 슬롯을 읽는다.
    const secSlotRef = securityCall.multiSite ? `${securityCall.slot} + __secIdx` : `${securityCall.slot}`;
    return `rt.security.get($.securityCache[${secSlotRef}], $.idx, "${securityCall.field}", ${securityCall.gaps}, ${securityCall.lookahead})`;
  }
  const securityExprCall = program.securityExprCallSlots.get(expr);
  if (securityExprCall !== undefined) {
    // request.security 셋째 슬라이스 서브슬라이스 3c(ROADMAP [hard->분할], C182) — 3b가 프리앰블에
    // 심어둔 $.securityExprCache[slot](HTF-네이티브 시퀀스 위에서 재실행된 결과 Float64Array)를
    // $.securityCache[slot]의 barMap과 함께 getFromArray로 lookup — get()의 field 분기 대신
    // 배열 자체를 인덱싱한다는 점만 다르고 gaps/lookahead 처리(analyze-time 확정 리터럴)는 동일.
    return `rt.security.getFromArray($.securityExprCache[${securityExprCall.slot}], $.securityCache[${securityExprCall.slot}], $.idx, ${securityExprCall.gaps}, ${securityExprCall.lookahead})`;
  }
  const securityFieldOffsetCall = program.securityFieldOffsetCalls.get(expr);
  if (securityFieldOffsetCall !== undefined) {
    // C739(배치37(3) 9차) — bare 필드 + 요청 tf 문맥 런타임 오프셋(HTF 행 단위). 오프셋식은 읽기
    // 지점의 스코프(UDF 본문 funcCtx — 매개변수가 JS 함수 인자로 실존)에서 그대로 genExpr한다 —
    // 프리패스/치환이 전혀 없는 순수 읽기라 rt.security.get(bare 분기)과 동일한 무상태 O(1) 조회.
    const offsetCode = genExpr(securityFieldOffsetCall.offsetExpr, program, funcCtx, secCtx);
    return `rt.security.getFieldHtfOffset($.securityCache[${securityFieldOffsetCall.slot}], $.idx, "${securityFieldOffsetCall.field}", ${securityFieldOffsetCall.gaps}, ${securityFieldOffsetCall.lookahead}, ${offsetCode})`;
  }
  const securityParamCall = program.securityParamExprCalls.get(expr);
  if (securityParamCall !== undefined) {
    // C453(udf-param 다중 콜사이트) — 위 securityExprCall과 동일한 getFromArray 읽기지만 슬롯이
    // 고정 리터럴이 아니라 `base + __secIdx`(연속 블록 시작 + 콜사이트 서수, 함수 파라미터 —
    // genBaseParams/funcSecIdxArgs 주석 참조). 이 맵은 UDF 본문 안 노드에만 등록되므로 __secIdx는
    // 항상 스코프에 존재한다.
    const slotRef = `${securityParamCall.base} + __secIdx`;
    return `rt.security.getFromArray($.securityExprCache[${slotRef}], $.securityCache[${slotRef}], $.idx, ${securityParamCall.gaps}, ${securityParamCall.lookahead})`;
  }
  const securityTupleCall = program.securityTupleCallSlots.get(expr);
  if (securityTupleCall !== undefined) {
    // C306(bare 필드) + C349b(ta.* 콜 혼합) — ta.macd 등 다중 반환 TA와 동일한 "공유 스크래치
    // 배열에 쓰기" 패턴(GOAL.md "bar loop 안 할당 제로", 배열 리터럴 생성 대신 $.taScratch[i]
    // 순차 대입하는 comma-식). bare 원소는 별도 HTF 캐시 없이 기존 rt.security.get을 그대로
    // 재사용(순수 함수라 같은 $.securityCache[slot]을 필드만 바꿔 N번 읽어도 안전). ta.* 콜 원소는
    // 스칼라 exprMatch 콜사이트와 동일하게 자신만의 slot(securityExprCache/securityCache)을 가져
    // rt.security.getFromArray로 lookup한다(genTupleDestructure가 이 comma-식을 문장으로 1회
    // 실행한 뒤 $.taScratch를 읽는다).
    // multiSite(C532): slot/expr 필드 slot이 콜사이트별 tf 블록의 시작 — __secIdx(C453 서수, 이
    // 맵의 multiSite 항목은 UDF 본문 안 노드에만 등록되므로 항상 스코프에 존재)를 더해 읽는다.
    const tupleSlotRef = securityTupleCall.multiSite
      ? `${securityTupleCall.slot} + __secIdx`
      : `${securityTupleCall.slot}`;
    const writes = securityTupleCall.fields.map((field, i) => {
      let readExpr: string;
      if (field.kind === "bare") {
        readExpr = `rt.security.get($.securityCache[${tupleSlotRef}], $.idx, "${field.field}", ${securityTupleCall.gaps}, ${securityTupleCall.lookahead})`;
      } else {
        const fieldSlotRef = securityTupleCall.multiSite ? `${field.slot} + __secIdx` : `${field.slot}`;
        readExpr = `rt.security.getFromArray($.securityExprCache[${fieldSlotRef}], $.securityCache[${fieldSlotRef}], $.idx, ${securityTupleCall.gaps}, ${securityTupleCall.lookahead})`;
      }
      return `$.taScratch[${i}] = ${readExpr}`;
    });
    return `(${writes.join(", ")})`;
  }
  const securityScalarBareUdf = program.securityScalarBareUdfCallSlots.get(expr);
  if (securityScalarBareUdf !== undefined) {
    // C436: securityScalarBareUdfCallSlots 주석 참조 — 외부 request.security 노드는 완전히 무시하고
    // 내부 UDF 콜을 그 자리에서 그대로 genExpr(HTF 캐시/프리패스 없음, C432 bareUdfInner의 스칼라
    // 자매 경로와 동일 원칙).
    return genExpr(securityScalarBareUdf, program, funcCtx, secCtx);
  }
  const builtinName = program.builtinCalls.get(expr);
  if (builtinName !== undefined) {
    if (builtinName.startsWith("input.")) {
      // input.*(C131)는 Pine 문법에 없는 외부 오버라이드 dict를 첫 인자로 암묵 주입한다 —
      // ta.vwma/ta.mfi가 volume을 splice하는 것과 동일한 원리(analyzer.ts input 분기 주석 참조).
      // 키워드 인자(title=/minval=/maxval=/step=, C132)는 UDT `.new()`(C129)와 동일한 기법으로
      // 위치 슬롯에 낮춘다: INPUT_PARAM_NAMES(analyzer.ts, analyze-time에 이미 검증 완료)로 값이
      // 실제로 지정된 가장 뒤쪽 슬롯까지만 인자를 방출하고, 그 범위 안에서 kwargs가 건너뛴 중간
      // 슬롯만 리터럴 "undefined"로 채운다(JS 기본 파라미터가 "생략"과 "명시적 undefined"를 동일
      // 취급 — genUdtValueForFieldType 같은 필드 타입별 na 재코드젠이 필요 없어 UDT보다 단순).
      const method = builtinName.slice("input.".length);
      const paramNames = INPUT_PARAM_NAMES[method]!;
      const kwargsByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
      let lastSetIndex = expr.args.length - 1;
      paramNames.forEach((name, i) => {
        // options/tooltip/inline/group(INPUT_DISCARD_SLOT_NAMES, C258 options 원칙을 C292가
        // bool/string의 새 위치 슬롯까지 일반화) 자체는 kwarg로 왔을 때 lastSetIndex를 밀지 않는다
        // — pine2py의 대응 함수가 값을 전혀 소비하지 않는 순수 통과 메타데이터라(analyzer.ts 주석
        // 참조) rt.input.*로 방출할 이유가 없고, options는 튜플 리터럴 값이라 genExpr(TupleExpr
        // 위치 제약, "함수 반환 전용")에 넘기면 internal throw가 난다 — 아래 메인 루프의 discard
        // 분기가 항상 "undefined"로 대신한다. 위치 인자로 도달한 discard 슬롯(예:
        // `input.bool(true,"T","tooltip")`)은 여기서 trim하지 않는다(기존 enum "options" 정책과
        // 동일하게 유지 — lastSetIndex 초기값이 이미 expr.args.length-1이라 트레일링 "undefined"
        // 패딩이 남지만, JS는 여분 인자를 조용히 무시하므로 런타임 안전).
        if (INPUT_DISCARD_SLOT_NAMES.has(name)) return;
        if (i > lastSetIndex && kwargsByName.has(name)) lastSetIndex = i;
      });
      const args: string[] = [];
      for (let i = 0; i <= lastSetIndex; i++) {
        if (INPUT_DISCARD_SLOT_NAMES.has(paramNames[i]!)) {
          args.push("undefined");
          continue;
        }
        if (i < expr.args.length) {
          args.push(genExpr(expr.args[i]!, program, funcCtx));
          continue;
        }
        const kwValue = kwargsByName.get(paramNames[i]!);
        args.push(kwValue !== undefined ? genExpr(kwValue, program, funcCtx) : "undefined");
      }
      args.unshift("$.inputs");
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    if (builtinName.startsWith("strategy.")) {
      // strategy.closedtrades/opentrades.<method>(index)(C173/C308) — 3-level 체이닝이라
      // builtinName에 dot이 두 개 들어있다("strategy.closedtrades.entry_price") — 아래
      // `$.${builtinName}(...)` 일반형은 프로퍼티 경로를 그대로 따라가므로(entry/close 등과 동일
      // 관례) 이 값 그대로 쓰면 존재하지 않는 `$.strategy.closedtrades.entry_price`가 되어 버려
      // STRATEGY_TRADE_ACCESSOR_RT_METHODS로 평평한 메서드 이름으로 매핑해야 한다. kwargs가 없어
      // (analyzer가 이미 차단) 위치 인자 그대로 통과.
      if (builtinName === "strategy.convert_to_account" || builtinName === "strategy.convert_to_symbol") {
        // strategy.convert_to_account/convert_to_symbol(value)(C763) — currency= 미지정을
        // 항등으로 단순화(analyzer 분기 주석 참조, FX 데이터 부재라 런타임 호출 자체가 불필요 —
        // 인자 표현식을 그대로 통과시킨다).
        return genExpr(expr.args[0]!, program, funcCtx);
      }
      if (builtinName === "strategy.risk.max_intraday_filled_orders") {
        // strategy.risk.max_intraday_filled_orders(count)(C320) — analyzer가 위치 인자 1개 또는
        // `count=` 키워드 인자 단독만 허용(call-expr.ts C320 분기 참조). 위 STRATEGY_TRADE_ACCESSOR_RT_METHODS
        // 표는 "kwargs 없음, 위치 인자 그대로 통과"만 지원해(closedtrades/opentrades 접근자 전용
        // 계약) 이 콜은 kwarg 해석이 추가로 필요해 별도 분기로 뺀다.
        const countArg =
          expr.args.length === 1
            ? genExpr(expr.args[0]!, program, funcCtx)
            : genExpr(expr.kwargs[0]!.value, program, funcCtx);
        return `$.strategy.setMaxIntradayFilledOrders(${countArg})`;
      }
      if (builtinName === "strategy.risk.max_intraday_loss" || builtinName === "strategy.risk.max_drawdown") {
        // strategy.risk.max_intraday_loss/max_drawdown(value, type)(C322) — analyzer
        // (analyzeStrategyRiskThresholdCall)가 이미 "value"/"type" 각각 위치 또는 동명 키워드
        // 인자로 정확히 하나씩만 존재함을 검증했으므로, 여기서는 어느 쪽에서 왔든 값 하나만
        // 뽑아 두 슬롯짜리 런타임 호출로 낮춘다(max_intraday_filled_orders와 동일한 "여기서
        // kwarg 해석" 분리 이유).
        const kwByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
        const valueExpr = expr.args.length >= 1 ? expr.args[0]! : kwByName.get("value")!;
        const typeExpr = expr.args.length >= 2 ? expr.args[1]! : kwByName.get("type")!;
        const rtMethod = builtinName === "strategy.risk.max_intraday_loss" ? "setMaxIntradayLoss" : "setMaxDrawdown";
        return `$.strategy.${rtMethod}(${genExpr(valueExpr, program, funcCtx)}, ${genExpr(typeExpr, program, funcCtx)})`;
      }
      const tradeAccessorRtMethod = STRATEGY_TRADE_ACCESSOR_RT_METHODS[builtinName];
      if (tradeAccessorRtMethod !== undefined) {
        const args = expr.args.map((a) => genExpr(a, program, funcCtx));
        if (OPEN_TRADE_CLOSE_PRICE_METHODS.has(builtinName)) {
          args.unshift("$.close.get(0)");
        }
        return `$.strategy.${tradeAccessorRtMethod}(${args.join(", ")})`;
      }
      // strategy.entry/close(C163) + cancel/cancel_all(C166) + close_all(C168) — rt 경유 없이
      // Context의 브로커 상태 객체(StrategyState) 메서드를 직접 호출한다($.plots[n].record와 동일한
      // "Context 채널 직결" 관례). builtinName이 "strategy.entry" 그대로 프로퍼티 경로가 되어
      // `$.strategy.entry(...)`로 방출된다. entry/exit(C167)/close(C168)/close_all의 kwargs는 각각
      // StrategyState.entry(id, direction, qty, limit, stop, comment)/exit(id, fromEntry, limit,
      // stop, qty, trailPoints, trailOffset, comment, trailPrice, profit, loss)/close(id, qty, comment)/
      // close_all(comment, when) 시그니처의 위치 슬롯으로 낮춘다 — 값이 실제로 지정된 가장 뒤쪽 슬롯까지만
      // 방출하고 그 안의 빈 슬롯만 리터럴 "undefined"로 채우는 C129 원칙(UDT .new() kwargs와 동일:
      // 순수 위치 호출/qty=만 쓰는 기존 출력은 한 글자도 안 바뀐다. exit의 qty 슬롯도 기존 슬롯들
      // **뒤**에 붙여 qty= 없는 기존 출력이 불변. JS 기본 파라미터는 "생략"과 "명시적 undefined"를
      // 동일 취급하므로 undefined 슬롯은 defaultQty/NaN/""/Infinity 기본값으로 떨어진다).
      // comment=는 C173부터 실소비 — entry/order/exit/close는 마지막 슬롯(기존 슬롯 전부 **뒤**에
      // 붙여 comment= 없는 기존 출력 무변화), close_all은 유일한 슬롯(위치 인자 0개 고정이라 항상
      // slot 0). trail_price=(C178)는 exit의 그 뒤 슬롯(comment보다도 뒤 — 기존 comment= 전용
      // 출력도 무변화), profit=/loss=(hand-verified)는 그보다도 뒤(9~10번 슬롯 — 기존 trail_price=
      // 전용 출력도 무변화). when=(C372, entry/order — close의 when=(C293)과 동일 게이트, C378이
      // close_all에도 이식)는 entry/order comment 뒤 6번 슬롯·close_all comment 뒤 1번 슬롯(둘 다
      // 기존 comment= 전용 출력 무변화). qty_percent=(C373, exit/close 공유
      // 메커니즘 — qty= 부분청산과 같은 슬롯에 콜타임 계산값이 실려 codegen은 맨 뒤 슬롯 하나 추가로
      // 끝난다)는 exit 11번(loss 뒤)/close 4번(when 뒤) — 둘 다 기존 마지막 슬롯 전용 출력 무변화.
      // comment_loss=/comment_profit=(C375, hand-verified)는 qty_percent=보다도 뒤(exit 12~13번) —
      // 값은 그대로 넘기고 트리거별 선택은 runtime/strategy.ts가 체결 시점에 수행(codegen은 위치만).
      // comment_trailing=(C673, hand-verified)는 when=보다도 뒤(exit 15번, C129 "실제 지정된 가장
      // 뒤쪽 슬롯까지만" 원칙 — 기존 when= 전용 출력도 무변화) — 값은 그대로 넘기고 트리거별 선택은
      // comment_loss/profit과 동일하게 runtime/strategy.ts가 체결 시점에 수행.
      // immediately=(C379, hand-verified)는 close 5번(qty_percent 뒤)/close_all 2번(when 뒤) — 값
      // 자체는 그대로 넘기되, 이 kwarg가 실제로 쓰였을 때만 이어서 currentClose/currentBarIndex를
      // 암묵 추가 슬롯으로 붙인다(아래 별도 블록, C129 "실제 지정된 가장 뒤쪽 슬롯까지만" 원칙 —
      // immediately 없는 기존 콜사이트는 바이트 무변화). exit의 when=(C380)은 entry/order/close/
      // close_all(C372/C293/C378)과 동일 게이트를 comment_profit= 뒤 14번 슬롯으로 마저 이식(기존
      // 마지막 슬롯 전용 출력 무변화). cancel의 when=(C708)은 id 뒤 1번 슬롯(기존 id 전용 출력
      // 무변화) — runtime StrategyState.cancel(id, when)이 함수 최상단에서 게이팅(hand-verified,
      // pine2py cancel()엔 이 게이트가 없음 — DIVERGENCES.md 신규 항목 참조).
      // analyzer가 이름/중복/위치-키워드 충돌을 이미 검증했다.
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      if (builtinName === "strategy.close" && expr.args.length === 2) {
        // C345: Pine 위치 슬롯 1(comment)은 런타임 StrategyState.close(id, qty, comment, when)의
        // 슬롯 2 — qty 슬롯(1)을 건너뛰어야 하므로 위 공용 1:1 매핑을 재배치로 덮어쓴다.
        const posComment = args[1]!;
        args[1] = "undefined";
        args[2] = posComment;
      }
      if (builtinName === "strategy.exit" && expr.args.length === 3) {
        // C424: TV 위치 인자 3번째(qty)는 런타임 StrategyState.exit(id, fromEntry, limit, stop,
        // qty, ...)의 슬롯 4 — entry/order와 달리 exit는 limit=/stop=이 qty=보다 먼저 kwarg로
        // 도입돼(C167/C168) 그 사이에 끼어있다. 위 공용 1:1 매핑(args[2]가 그대로 slot 2=limit로
        // 떨어짐)을 재배치로 덮어쓴다(strategy.close의 comment 재배치와 동일 원칙).
        const posQty = args[2]!;
        args[2] = "undefined";
        args[3] = "undefined";
        args[4] = posQty;
      }
      if (
        builtinName === "strategy.entry" ||
        builtinName === "strategy.order" ||
        builtinName === "strategy.exit" ||
        builtinName === "strategy.close" ||
        builtinName === "strategy.close_all" ||
        builtinName === "strategy.cancel"
      ) {
        // order(C169)는 entry와 시그니처가 동일해 같은 슬롯 표를 공유한다(StrategyState.order(id,
        // direction, qty, limit, stop, comment)).
        const KWARG_SLOTS: Record<string, number> =
          builtinName === "strategy.entry" || builtinName === "strategy.order"
            ? { id: 0, direction: 1, qty: 2, limit: 3, stop: 4, comment: 5, when: 6 } // id=/direction=(C423, strategy.close의 id=(C293)와 동일 원리 — 위치 인자가 있으면 이 슬롯을 안 건드려 기존 콜사이트 출력 무변화) + when=(C372, comment 뒤 새 트레일링 슬롯)
            : builtinName === "strategy.exit"
              ? {
                  id: 0, // id=(C424, strategy.close의 id=(C293)와 동일 원리 — 위치 인자가 있으면 이 슬롯을 안 건드려 기존 콜사이트 출력 무변화)
                  from_entry: 1, limit: 2, stop: 3, qty: 4, trail_points: 5, trail_offset: 6, comment: 7,
                  trail_price: 8, profit: 9, loss: 10, qty_percent: 11, comment_loss: 12, comment_profit: 13,
                  when: 14, // when=(C380, comment_profit 뒤 새 트레일링 슬롯 — 기존 콜사이트 출력 무변화)
                  comment_trailing: 15, // comment_trailing=(C673, when= 뒤 새 슬롯 — 기존 콜사이트 출력 무변화)
                }
              : builtinName === "strategy.close"
                ? { id: 0, qty: 1, comment: 2, when: 3, qty_percent: 4, immediately: 5 } // id=(C293, 위치 슬롯 0을 kwarg로도 채움)
                : builtinName === "strategy.close_all"
                  ? { comment: 0, when: 1, immediately: 2 } // comment(위치 0) + when=(C378) + immediately=(C379)
                  : { id: 0, when: 1 }; // strategy.cancel(C382, when=은 C708 — id 뒤 새 슬롯, 기존 id 전용 출력 무변화)
        for (const kw of expr.kwargs) {
          const slot = KWARG_SLOTS[kw.name];
          if (slot === undefined) continue; // 방어적 fallback(현재 전 kwargs가 슬롯을 가짐)
          while (args.length < slot) args.push("undefined");
          args[slot] = genExpr(kw.value, program, funcCtx);
        }
        if (
          (builtinName === "strategy.close" || builtinName === "strategy.close_all") &&
          expr.kwargs.some((kw) => kw.name === "immediately")
        ) {
          // immediately=(C379) — 런타임이 "이 바의 close가로 지금 체결"하려면 codegen이 현재 바의
          // close 가격/인덱스를 암묵 주입해야 한다(트레이드 접근자 OPEN_TRADE_CLOSE_PRICE_METHODS의
          // $.close.get(0) unshift와 동일 원리). immediately가 안 쓰이면 이 세 슬롯 자체가 안 생겨
          // 기존 출력 무변화(C129). $.barTimeMs(C418)는 이 즉시 체결 경로의 closedtrades.exit_time
          // 스냅샷 소스 — time() 빌트인(위 "time" 분기)이 쓰는 것과 동일한 Context 필드.
          args.push("$.close.get(0)", "$.idx", "$.barTimeMs");
        }
      }
      return `$.${builtinName}(${args.join(", ")})`;
    }
    if (builtinName === "time" || builtinName === "timeClose") {
      // time(timeframe[, session[, timezone[, bars_back]]])(C299/C727)/time_close(...)(C400) — Pine
      // 문법에 barTimeMs 인자가 없고 현재 바 자신의 시각을 암묵 사용한다(runtime/time.ts 헤더 참조,
      // ta.vwma의 volume 주입과 동일한 "내장 값 암묵 주입" 원리). timeframe=/session=/timezone=/
      // bars_back= 키워드 폼(C475/C727, analyzer/call-expr.ts TIME_CALL_KWARG_PARAM_NAMES 참조) —
      // math.*(C404)와 동일한 위치 슬롯 병합(kwargs 없는 기존 콜사이트는 이 루프가 no-op이라 출력
      // 무변화). 4번째 슬롯(bars_back)은 barTimeMs 자체를 바꾸는 인자라 병합 후 따로 뽑아
      // $.timeAtBarsBack(...)으로 감싸고(runtime/context.ts 참조), 없으면 기존과 동일하게
      // $.barTimeMs — 런타임 시그니처 (barTimeMs, timeframe[, session[, timezone]])는 그대로다.
      // C575: timeframe/session/timezone 세 슬롯은 참조형(string)이라 na 리터럴은 GOAL.md 규약대로
      // null로 낮춰야 하는데 genExpr(NaLiteral)의 범용 경로는 항상 스칼라 NaN을 낸다(colorCast
      // 분기와 동일 사정) — wild `time(na)` 관용구가 NaN을 그대로 rt.time.resolve의 timeframe
      // 인자로 흘려 parseTfMinutes(NaN).trim()이 "tf.trim is not a function"으로 죽었다
      // (corpus_scan --exec 실측). bars_back(슬롯 3)은 숫자형이라 이 낮춤 대상이 아니다 — genExpr의
      // 범용 NaN 방출이 정확한 값이므로 예외 없이 그대로 둔다.
      const argCodeAt = (a: Expr, slot: number) =>
        a.kind === "NaLiteral" && slot < 3 ? "null" : genExpr(a, program, funcCtx, secCtx);
      const args = expr.args.map((a, i) => argCodeAt(a, i));
      for (const kw of expr.kwargs) {
        const slot = TIME_CALL_KWARG_PARAM_NAMES.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = argCodeAt(kw.value, slot);
      }
      const barsBackCode = args.length > 3 ? args.pop() : undefined;
      // C735: request.security expression 좁은 문법의 time()/time_close() 세션 콜 리프(call-expr.ts
      // buildSecurityExprNode CallExpr case) — 프리패스(secCtx) 안에서는 "현재 바"가 차트 바가
      // 아니라 HTF 행이므로 암묵 barTimeMs 주입을 HTF 캐시 timeOpen[loopVar]로 갈아탄다(bare
      // `time` 식별자의 genIdentifier secCtx 분기와 동일 원천 — timeClose 캐시가 아니라 timeOpen인
      // 이유는 이 인자가 "그 바 자신의 시각"이고 period 시작/끝 재계산은 rt.time.resolve/resolveClose
      // 자신이 tf 인자로 수행하기 때문). bars_back(4번째 슬롯)은 좁은 문법이 1~3 인자만 통과시켜
      // secCtx에서 구조적으로 도달 불가 — 기존 $.timeAtBarsBack 분기는 메인 경로 전용 그대로.
      const barTimeCode =
        secCtx !== null
          ? `${secCtx.cacheVar}.timeOpen[${secCtx.loopVar}]`
          : barsBackCode !== undefined
            ? `$.timeAtBarsBack(${barsBackCode})`
            : "$.barTimeMs";
      args.unshift(barTimeCode);
      return builtinName === "time" ? `rt.time.resolve(${args.join(", ")})` : `rt.time.resolveClose(${args.join(", ")})`;
    }
    if (builtinName === "colorCast") {
      // color(x[, transp])(C300) — colorNew(rt.new, color.new의 rtPath)와 완전히 동일한 시맨틱으로
      // 판정(analyzer.ts 주석 참조), 별도 런타임 함수 없이 그대로 재사용한다. 단 첫 인자(색상 값)는
      // 참조형이라 na 리터럴이면 GOAL.md 규약대로 null로 내려야 하는데(wild 1,388/1,431건이
      // color(na)), genExpr(NaLiteral)의 범용 경로는 항상 스칼라 NaN을 낸다 — containerRefArgPositions
      // (array/map/matrix 전용 테이블, "컨테이너 참조 인자"라는 전제)를 확장하는 대신 이 전용 분기에서
      // 직접 가로챈다.
      const colorArg = expr.args[0]!.kind === "NaLiteral" ? "null" : genExpr(expr.args[0]!, program, funcCtx);
      const args = [colorArg];
      if (expr.args.length > 1) args.push(genExpr(expr.args[1]!, program, funcCtx));
      return `rt.new(${args.join(", ")})`;
    }
    if (builtinName === "new") {
      // color.new(colorVal[, transp])(C371) — colorCast(위)와 동일 이유로 na 색상 인자를 null로
      // 낮춘다(genExpr(NaLiteral)의 범용 경로는 항상 스칼라 NaN — 이 전용 분기가 신설되기 전까지
      // 일반 fallback을 그대로 탔던 color.new(na, ...)는 rt.new(NaN, ...)를 방출해 colorNew()가
      // "NaN"을 진짜 hex 문자열인 양 이어붙인 조용한 오답이었다, 기존 기능 버그 C371에서 발견).
      // 첫 인자(색상)는 위치(args[0]) 또는 kwarg 'color='(C377, analyzer가 이미 상호 배타/이름 검증
      // 완료 — 위치와 kwarg 동시 지정은 하드 에러라 args[0] 우선이면 충분), transp는 위치(args[1])
      // 또는 kwarg 'transp='(C371) 둘 중 하나.
      const colorExpr = expr.args.length > 0 ? expr.args[0]! : expr.kwargs.find((kw) => kw.name === "color")!.value;
      const colorArg = colorExpr.kind === "NaLiteral" ? "null" : genExpr(colorExpr, program, funcCtx);
      const transpExpr = expr.args.length > 1 ? expr.args[1]! : expr.kwargs.find((kw) => kw.name === "transp")?.value;
      const args = [colorArg];
      if (transpExpr !== undefined) args.push(genExpr(transpExpr, program, funcCtx));
      return `rt.new(${args.join(", ")})`;
    }
    if (builtinName === "drawingCast") {
      // line(x)/label(x)/box(x)/table(x)(C301) — colorCast(C300)와 달리 drawing 핸들은 값 변환이
      // 아니라 GOAL.md 참조형 na 규약 그 자체: na 리터럴만 명시적으로 "null"로 낮추고(genExpr(NaLiteral)의
      // 범용 경로는 항상 스칼라 NaN이라 그대로 두면 안 됨, colorCast와 동일 이유) 그 외 값은 이미
      // 순수 참조값(DrawingHandle | null)이라 변환 없이 그대로 통과시킨다(항등 캐스트, 런타임 함수 0개).
      return expr.args[0]!.kind === "NaLiteral" ? "null" : genExpr(expr.args[0]!, program, funcCtx);
    }
    if (builtinName.startsWith("datetime.")) {
      // year/month/dayofmonth/dayofweek/hour/minute/second/weekofyear(time[, timezone])
      // 함수-호출 오버로드(C245/C326) — analyzer가 이미 "time"(필수)/"timezone"(선택) 각각
      // 위치 또는 동명 키워드 인자로 존재함을 검증했으므로, 여기서는 위치 우선으로 값을 뽑아
      // rt.datetime.*(time[, timezone]) 호출로 낮춘다(strategy.risk.* threshold, C322와 동일한
      // "여기서 kwarg 해석" 분리 이유). timezone이 아예 없으면(1-인자 폼) 인자 자체를 생략해
      // 기존 rt.datetime.*(time) 출력과 완전히 동일하게 유지한다.
      const kwByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
      const timeExpr = expr.args.length >= 1 ? expr.args[0]! : kwByName.get("time")!;
      const timezoneExpr = expr.args.length >= 2 ? expr.args[1]! : kwByName.get("timezone");
      const args = [genExpr(timeExpr, program, funcCtx)];
      if (timezoneExpr !== undefined) args.push(genExpr(timezoneExpr, program, funcCtx));
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    if (builtinName === "tostring" && (expr.kwargs.length > 0 || program.tostringIntArgCalls.has(expr))) {
      // str.tostring(value=/format=) kwargs(C403) + int/float 갭 수정(C201, LIMITATIONS.md) 병합
      // 분기 — analyzer(analyzeStrCall)가 이미 이름/중복/위치·키워드 충돌을 검증했다. 먼저
      // STR_KWARG_PARAM_NAMES 순서(value, format)로 kwargs를 위치 슬롯에 낮춘다(array.*(id=...)
      // (C382)와 동일한 C129 원칙 — kwargs 없으면 이 루프가 그대로 no-op이라 args===
      // expr.args.map(genExpr)와 바이트 동일). 그 다음 isStaticIntExpr로 정적 확정된 콜사이트만
      // 셋째 인자 isInt=true를 추가로 싣는다 — format 슬롯(둘째 인자)이 비어 있으면 "undefined"
      // 리터럴로 채워 위치를 맞춘다(JS 기본 파라미터가 "생략"과 "명시적 undefined"를 동일
      // 취급하므로 rt.tostring 쪽 동작은 그대로, C129 원칙과 동일한 위치 패딩 기법).
      const paramNames = STR_KWARG_PARAM_NAMES["tostring"]!;
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = paramNames.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      if (program.tostringIntArgCalls.has(expr)) {
        while (args.length < 2) args.push("undefined");
        args.push("true");
      }
      return `rt.tostring(${args.join(", ")})`;
    }
    if (builtinName === "format_time" && expr.kwargs.length > 0) {
      // str.format_time(time=/format=/timezone=) kwargs(C478, STR_KWARG_PARAM_NAMES 참조) —
      // tostring(C403)과 동일한 "위치/키워드 슬롯 병합" 패턴. kwargs 없으면 이 분기 자체를 안 타
      // 기존 출력 불변.
      const paramNames = STR_KWARG_PARAM_NAMES["format_time"]!;
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = paramNames.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.format_time(${args.join(", ")})`;
    }
    if (builtinName === "request.security_lower_tf") {
      // request.security_lower_tf(symbol, timeframe, expression, ignore_invalid_symbol, currency,
      // ignore_invalid_timeframe, calc_bars_count)(C381) — analyzer가 이미 이름/중복/위치·키워드
      // 충돌을 검증했으므로 여기서는 pine2py 시그니처 순서(runtime/request.ts securityLowerTf) 그대로
      // 위치 슬롯에 낮춘다(strategy.entry류 KWARG_SLOTS와 동일한 C129 원칙 — 값이 실제로 지정된 가장
      // 뒤쪽 슬롯까지만 채우고 그 안의 빈 슬롯만 "undefined"로 채움). currency(슬롯 4)는 이번 슬라이스
      // kwarg 미지원(wild 실사용 0건, analyzer가 이미 이 이름을 화이트리스트에서 제외)이라 표에 없음 —
      // 위치 인자로만 채워질 수 있다. kwargs가 없는 기존 콜사이트는 이 분기를 타도 args가 그대로
      // expr.args.map(genExpr)와 동일해 출력 불변.
      const KWARG_SLOTS: Record<string, number> = {
        symbol: 0,
        timeframe: 1,
        expression: 2,
        ignore_invalid_symbol: 3,
        ignore_invalid_timeframe: 5,
        calc_bars_count: 6,
      };
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = KWARG_SLOTS[kw.name];
        if (slot === undefined) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    const arrayKwargParamNames = builtinName.startsWith("array.")
      ? ARRAY_KWARG_PARAM_NAMES[builtinName.slice("array.".length)]
      : undefined;
    if (arrayKwargParamNames !== undefined && expr.kwargs.length > 0) {
      // array.*(id=...) 계열(C382, analyzer/collections.ts ARRAY_KWARG_PARAM_NAMES 참조) — analyzer
      // (analyzeArrayCall)가 이미 이름/개수/위치·키워드 충돌을 검증했다(receiver-sugar 콜은 kwargs
      // 자체가 blanket 거부돼 이 분기에 도달 안 함, C222 원칙 — receiverExpr unshift 분기와 무관).
      // TV 시그니처 순서를 그대로 위치 슬롯에 낮춘다(request.security_lower_tf류와 동일한 C129
      // 원칙) — kwargs 없는 기존 콜사이트는 이 분기 자체를 안 타 출력 무변화. na→null 낮춤은
      // containerRefArgPositions(covariance의 [0,1] 등 method별 실제 컨테이너 참조 위치)를 그대로
      // 재사용해 일반 fallback과 동일하게 처리한다.
      const refPositions = containerRefArgPositions(builtinName);
      const genArrayKwargArg = (a: Expr, slot: number): string =>
        refPositions.includes(slot) && a.kind === "NaLiteral" ? "null" : genExpr(a, program, funcCtx);
      const args = expr.args.map((a, i) => genArrayKwargArg(a, i));
      for (const kw of expr.kwargs) {
        const slot = arrayKwargParamNames.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genArrayKwargArg(kw.value, slot);
      }
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    const tickerKwargParamNames = builtinName.startsWith("ticker.")
      ? TICKER_KWARG_PARAM_NAMES[builtinName.slice("ticker.".length)]
      : undefined;
    if (tickerKwargParamNames !== undefined && expr.kwargs.length > 0) {
      // ticker.new/modify/renko(...) kwargs(C385, analyzer/call-expr.ts TICKER_KWARG_PARAM_NAMES
      // 참조) — analyzer가 이미 이름/중복/위치·키워드 충돌을 검증했다. 표 순서 그대로 위치 슬롯에
      // 낮춘다(array.* kwargs와 동일한 C129 원칙) — kwargs 없는 기존 콜사이트는 이 분기 자체를
      // 안 타 출력 무변화.
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = tickerKwargParamNames.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    const mathKwargParamNames = MATH_KWARG_PARAM_NAMES[builtinName];
    if (mathKwargParamNames !== undefined && expr.kwargs.length > 0) {
      // math.abs/round/sign(number=/precision=) kwargs(C404, analyzer/call-expr.ts
      // MATH_KWARG_PARAM_NAMES 참조) — analyzer가 이미 이름/중복/위치·키워드 충돌을 검증했다.
      // 표 순서 그대로 위치 슬롯에 낮춘다(str.tostring/array.*(id=...)와 동일한 C129 원칙 —
      // kwargs 없는 기존 콜사이트는 이 분기 자체를 안 타 출력 무변화).
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = mathKwargParamNames.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    if (builtinName === "from_gradient" && expr.kwargs.length > 0) {
      // color.from_gradient(value=/bottom_value=/top_value=/bottom_color=/top_color=) kwargs(C479,
      // analyzer/call-expr.ts COLOR_KWARG_PARAM_NAMES 참조) — math.*(C404)와 동일한 "위치/키워드
      // 슬롯 병합" 패턴. kwargs 없는 기존 콜사이트는 이 분기 자체를 안 타 출력 무변화.
      const colorKwargParamNames = COLOR_KWARG_PARAM_NAMES["from_gradient"]!;
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = colorKwargParamNames.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    if (builtinName === "nz" && expr.kwargs.length > 0) {
      // nz(source=/replacement=) kwargs(C405, analyzer/call-expr.ts NZ_KWARG_PARAM_NAMES 참조) —
      // analyzer가 이미 이름/중복/위치·키워드 충돌을 검증했다. math.*와 동일한 C129 원칙 —
      // kwargs 없는 기존 콜사이트는 이 분기 자체를 안 타 출력 무변화.
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = NZ_KWARG_PARAM_NAMES.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.nz(${args.join(", ")})`;
    }
    if (builtinName === "timestamp" && expr.kwargs.length > 0) {
      // timestamp(...) kwargs(C406, analyzer/call-expr.ts resolveTimestampKwargSlots 참조) —
      // timezone 유무로 슬롯 표 자체가 동적으로 바뀌어(주석 참조) math.*/nz처럼 고정 표 하나를
      // 그대로 못 쓰고 analyzer와 동일한 리졸버를 codegen도 호출해 같은 표를 재계산한다(analyzer가
      // 이미 통과시킨 콜사이트만 여기 도달하므로 재계산은 안전 — resolveTaKwargPositions와 동일 원칙).
      const slots = resolveTimestampKwargSlots(expr);
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = slots.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.timestamp(${args.join(", ")})`;
    }
    if (builtinName === "timeframe.in_seconds" && expr.kwargs.length > 0) {
      // timeframe.in_seconds(timeframe=) kwarg(C405, analyzer/call-expr.ts
      // TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES 참조) — 단일 파라미터라 슬롯 0 하나뿐이지만
      // math.*/nz와 동일한 표 기반 패턴을 그대로 재사용(일관성).
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.timeframe.in_seconds(${args.join(", ")})`;
    }
    if ((builtinName === "runtimeError" || builtinName === "runtimeWarning") && expr.kwargs.length > 0) {
      // runtime.error/warning(message=) kwarg(C472, analyzer/call-expr.ts RUNTIME_KWARG_PARAM_NAMES
      // 참조) — 단일 파라미터라 timeframe.in_seconds(C405)와 동일한 표 기반 패턴을 그대로 재사용.
      const args = expr.args.map((a) => genExpr(a, program, funcCtx));
      for (const kw of expr.kwargs) {
        const slot = RUNTIME_KWARG_PARAM_NAMES.indexOf(kw.name);
        if (slot === -1) continue; // 방어적 fallback(analyzer가 이미 이 이름만 허용)
        while (args.length < slot) args.push("undefined");
        args[slot] = genExpr(kw.value, program, funcCtx);
      }
      return `rt.${builtinName}(${args.join(", ")})`;
    }
    const drawingStateParamNames = expr.kwargs.length > 0 ? DRAWING_STATE_PARAM_NAMES[builtinName] : undefined;
    if (drawingStateParamNames !== undefined) {
      // drawing.* state kwarg 낮추기(C813, LIMITATIONS C572 수정 — analyzer/call-expr.ts
      // DRAWING_STATE_PARAM_NAMES 주석 참조). 아래 범용 폴백이 expr.kwargs를 통째로 버려
      // `box.new(top=99.0)`의 top이 조용히 사라지던 결함을 UDT `.new()`(C129)/input.*(C132)와 완전히
      // 같은 패턴으로 닫는다: 값이 실제로 지정된 가장 뒤쪽 슬롯까지만 방출하고 그 범위 안에서
      // kwargs가 건너뛴 슬롯만 리터럴 "undefined"로 채운다(runtime/drawing.ts numArg/strArg가
      // undefined를 GOAL.md na 규약대로 NaN/null로 읽는다).
      // **표에 없는 kwarg 이름(color/style/size... 및 오타/미지원 이름)은 lastSetIndex를 밀지 않고
      // 방출도 안 한다** — 그래서 state kwarg가 하나도 없는 콜사이트는 lastSetIndex가 초기값
      // (expr.args.length-1) 그대로라 아래 범용 폴백과 출력이 완전히 동일하다(회귀 0).
      // method-call sugar(`b.set_top(top=5)`, C232)는 receiver가 표의 'id' 슬롯을 이미 차지하므로
      // slice(1)로 -1 오프셋을 준다(UDT method kwargs C408의 paramNames.slice(1)과 동일 원리).
      const sugarReceiver = program.methodCallReceivers.get(expr);
      const slotNames = sugarReceiver !== undefined ? drawingStateParamNames.slice(1) : drawingStateParamNames;
      const kwargsByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
      let lastSetIndex = expr.args.length - 1;
      slotNames.forEach((name, i) => {
        if (i > lastSetIndex && kwargsByName.has(name)) lastSetIndex = i;
      });
      const drawingArgs: string[] = [];
      for (let i = 0; i <= lastSetIndex; i++) {
        if (i < expr.args.length) {
          drawingArgs.push(genExpr(expr.args[i]!, program, funcCtx, secCtx));
          continue;
        }
        const slotName = slotNames[i];
        const kwValue = slotName !== undefined ? kwargsByName.get(slotName) : undefined;
        drawingArgs.push(kwValue !== undefined ? genExpr(kwValue, program, funcCtx, secCtx) : "undefined");
      }
      if (sugarReceiver !== undefined) drawingArgs.unshift(genExpr(sugarReceiver, program, funcCtx, secCtx));
      return `rt.${builtinName}(${drawingArgs.join(", ")})`;
    }
    const refPositions = containerRefArgPositions(builtinName);
    // method-call 스타일 array/map 콜(C222, `arr.push(x)` == `array.push(arr, x)`)의 수신자는
    // expr.args에 없다 — analyzer가 methodCallReceivers 병렬 맵에 따로 실어둔 Expr을 여기서 맨 앞에
    // 끼워 넣는다(analyzer/call-expr.ts 주석 참조). refPositions는 항상 "최종 rt.* 인자 위치"
    // 기준이라 receiver가 있으면 원래 expr.args의 인덱스를 +1만큼 밀어서 검사해야 한다 — receiver
    // 자신은 항상 실제 변수 Identifier이지 na 리터럴일 수 없으므로(resolveContainerExprKind가
    // Identifier만 인정) position 0의 na→null 치환 대상이 될 일이 없다.
    // C444: secCtx를 인자 genExpr에 그대로 물려준다 — 이전에는 이 폴백이 항상 main-timeframe
    // 경로(secCtx===null)로만 도달해 누락이 관측되지 않았으나(request.security expression 좁은
    // 문법이 이 분기까지 떨어지는 CallExpr을 지금까지 하나도 허용하지 않았음), nz() 좁은 문법
    // 리프 케이스(call-expr.ts buildSecurityExprNode)가 이 분기에 처음으로 secCtx!==null인 채
    // 도달한다 — 안 물려주면 nz(hlc3, 0) 같은 인자 안 bar series 참조가 HTF 프리패스 루프
    // 로컬(cache 배열) 대신 메인 타임프레임 $.field.get(0)으로 조용히 잘못 방출된다. secCtx===null
    // (기존 모든 호출부)일 때는 genExpr 기본 파라미터와 동일해 출력 불변.
    const receiverExpr = program.methodCallReceivers.get(expr);
    const args =
      receiverExpr !== undefined
        ? [
            genExpr(receiverExpr, program, funcCtx, secCtx),
            ...expr.args.map((a, i) => (refPositions.includes(i + 1) && a.kind === "NaLiteral" ? "null" : genExpr(a, program, funcCtx, secCtx))),
          ]
        : expr.args.map((a, i) => (refPositions.includes(i) && a.kind === "NaLiteral" ? "null" : genExpr(a, program, funcCtx, secCtx)));
    return `rt.${builtinName}(${args.join(", ")})`;
  }
  const userSlotBase = program.funcCallSlots.get(expr);
  if (userSlotBase !== undefined && expr.callee.kind === "Identifier") {
    // bare method(receiver, ...) 콜(C267, analyzer가 udtMethodCallTypes에 등록해뒀다) — 실제
    // top-level 함수 이름은 mangleMethodName(typeName, calleeName)이지 callee.name 그대로가
    // 아니다. expr.args는 이미 receiver를 포함한 전체 인자 목록이라(DotAccess 경로와 달리 obj를
    // 따로 끼워 넣을 필요 없음) 그대로 순서대로 넘기면 method 시그니처(p0=receiver, p1...)와 맞다.
    const bareMethodType = program.udtMethodCallTypes.get(expr);
    // 순수 UDF 콜(mangle 없음)만 genFuncDecl과 동일하게 funcCodegenName을 거친다(C413) — mangled
    // method 이름은 "TypeName$name" 결합이라 top-level '=' 로컬과의 충돌이 구조적으로 불가능하다
    // (genFuncDecl 주석 참조).
    // C687: 오버로드 선택은 analyzer와 동일한 공유 헬퍼로 재계산(순수 함수 + 동일 인자 개수 입력이라
    // 항상 같은 결과 — C135 "독립 사본 발산" 함정 없음). info.name이 실제 등록 키(base 또는 $ov$k).
    const funcName =
      bareMethodType !== undefined
        ? lookupMethodOverload(program, bareMethodType, expr.callee.name, expr.args.length + expr.kwargs.length, expr)!.name
        : funcCodegenName(expr.callee.name, program);
    // C396: 키워드 인자 — UDT `.new()`(라인 ~2700 주석)와 완전히 동일한 원리로 값이 실제로 지정된
    // 가장 뒤쪽 슬롯까지만 채우고, 그 범위 안에서 kwargs가 건너뛴 슬롯만 리터럴 "undefined"로
    // 채운다(JS 기본 파라미터가 "생략"과 "명시적 undefined"를 동일 취급 — genFuncParam 라인 609가
    // 이미 매개변수 기본값을 JS 네이티브 default param으로 방출해두었으므로 함수 선언부 변경 0줄로
    // 충분하다). bareMethodType이 있는 호출(bare method-as-function)은 analyzer가 kwargs를 계속
    // 거부하므로 expr.kwargs는 항상 비어있어 아래 분기가 안전하게 fast-path로 떨어진다.
    const args: string[] =
      expr.kwargs.length === 0
        ? expr.args.map((a) => genExpr(a, program, funcCtx))
        : (() => {
            const func =
              bareMethodType !== undefined
                ? lookupMethodOverload(program, bareMethodType, expr.callee.name, expr.args.length + expr.kwargs.length, expr)!
                : program.funcs.get(expr.callee.name)!;
            const kwargsByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
            let lastSetIndex = expr.args.length - 1;
            func.paramNames.forEach((name, i) => {
              if (i > lastSetIndex && kwargsByName.has(name)) lastSetIndex = i;
            });
            const out: string[] = [];
            for (let i = 0; i <= lastSetIndex; i++) {
              if (i < expr.args.length) {
                out.push(genExpr(expr.args[i]!, program, funcCtx));
                continue;
              }
              const kwValue = kwargsByName.get(func.paramNames[i]!);
              out.push(kwValue !== undefined ? genExpr(kwValue, program, funcCtx) : "undefined");
            }
            return out;
          })();
    // 함수 본문에 stateful 콜(C162)이 있는 콜사이트만 taBase가, 함수-내부 히스토리(C364)가 있는
    // 콜사이트만 histBase가 등록돼 있다 — 함수 시그니처의 __taBase/__histBase 조건부 파라미터
    // (genFuncDecl/genBaseParams)와 항상 짝이 맞는다(없으면 기존 출력 그대로). __secIdx(C453,
    // udf-param 다중 콜사이트 security)도 동일 원리 — funcSecIdxArgs에 등록된 콜사이트만 서수를
    // 전달한다(등록은 함수 단위 all-or-nothing이라 시그니처와 항상 짝이 맞는다).
    const taBase = program.funcTaBases.get(expr);
    const histBase = program.funcHistBases.get(expr);
    const refHistBase = program.funcRefHistBases.get(expr);
    const condHistBase = program.funcCondHistBases.get(expr);
    const condRefHistBase = program.funcCondRefHistBases.get(expr);
    const secIdx = program.funcSecIdxArgs.get(expr);
    const baseArgs = [String(userSlotBase)];
    if (taBase !== undefined) baseArgs.push(String(taBase));
    if (histBase !== undefined) baseArgs.push(String(histBase));
    if (refHistBase !== undefined) baseArgs.push(String(refHistBase));
    if (condHistBase !== undefined) baseArgs.push(String(condHistBase));
    if (condRefHistBase !== undefined) baseArgs.push(String(condRefHistBase));
    if (secIdx !== undefined) baseArgs.push(String(secIdx));
    return `${funcName}(${[...baseArgs, ...args].join(", ")})`;
  }
  // `TypeName.new(...)` — 팩토리 함수를 그대로 호출(genTypeDecl). 인자마다 대응하는 필드 타입에
  // 맞춰 na 리터럴을 재코드젠해야 하므로(genUdtValueForFieldType) 일반 genExpr map이 아니라
  // 필드 선언 순서(=팩토리 파라미터 순서) 그대로 슬롯을 채운다: 위치 인자가 앞쪽 슬롯을 채우고,
  // 남은 슬롯은 키워드 인자(C129)를 필드 이름으로 찾아 채운다. 실제로 값이 지정된 가장 뒤쪽
  // 슬롯까지만 인자를 방출(그 뒤는 아예 생략 — 기존 위치 인자 전용 동작과 출력이 동일하게 유지됨,
  // 순수 위치 호출은 "undefined" 토큰이 전혀 안 붙는다)하고, 그 범위 **안**에서 kwargs가 건너뛴
  // 중간 슬롯만 리터럴 "undefined"로 채운다 — JS 기본 파라미터는 "생략"과 "명시적 undefined
  // 전달"을 똑같이 취급하므로(analyzer가 이미 인자 개수/필드명/중복을 검증해뒀다) 안전하게 그
  // 필드의 기본값으로 떨어진다.
  const udtTypeName = program.udtConstructorCalls.get(expr);
  if (udtTypeName !== undefined) {
    const typeInfo = program.udtTypes.get(udtTypeName)!;
    const kwargsByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
    let lastSetIndex = expr.args.length - 1;
    typeInfo.fields.forEach((field, i) => {
      if (i > lastSetIndex && kwargsByName.has(field.name)) lastSetIndex = i;
    });
    const args: string[] = [];
    for (let i = 0; i <= lastSetIndex; i++) {
      const field = typeInfo.fields[i]!;
      if (i < expr.args.length) {
        args.push(genUdtValueForFieldType(expr.args[i]!, field.typeHint, program, funcCtx));
        continue;
      }
      const kwValue = kwargsByName.get(field.name);
      args.push(kwValue !== undefined ? genUdtValueForFieldType(kwValue, field.typeHint, program, funcCtx) : "undefined");
    }
    return `${udtTypeName}(${args.join(", ")})`;
  }
  // `obj.copy()` — analyzer가 obj의 UDT 타입명을 udtCopyCallTypes에 등록해뒀다(C125,
  // DIVERGENCES.md #57). 사용자 method가 아니라 컴파일러가 자동 제공하는 내장 pseudo-method라
  // mangleMethodName 조회/funcCallSlots 없이 rt.udtCopy 런타임 헬퍼로 바로 내린다 — 이 분기를
  // udtMethodCallTypes보다 먼저 확인해야 하는 이유는 없다(analyzer가 CallExpr당 둘 중 하나에만
  // 배타적으로 등록하므로 순서 무관, 가독성상 constructor 콜 바로 다음에 배치).
  const copyTypeName = program.udtCopyCallTypes.get(expr);
  if (copyTypeName !== undefined) {
    // `TypeName.copy(instance)`(정적 폼, C645) — analyzer가 인자 1개로 검증해뒀으므로 복사 대상은
    // expr.args[0]. 인스턴스 점호출 `obj.copy()`(C125, 인자 0개)는 기존과 동일하게 callee.obj.
    if (expr.args.length === 1) {
      return `rt.udtCopy(${genExpr(expr.args[0]!, program, funcCtx)})`;
    }
    if (expr.callee.kind === "DotAccess") {
      const objCode = genExpr(expr.callee.obj, program, funcCtx);
      return `rt.udtCopy(${objCode})`;
    }
  }
  // `obj.methodName(args)` — analyzer가 obj의 UDT 타입명을 udtMethodCallTypes에 등록해뒀다(C124).
  // 실제 top-level 함수 이름은 mangleMethodName(typeName, methodName)으로 재계산(genMethodDecl과
  // 동일한 순수 함수라 저장 없이 항상 다시 계산 가능) — 일반 UDF 콜과 동일하게 funcCallSlots의
  // slotBase를 그대로 재사용하고, 객체 자신(callee.obj)을 codegen이 인자 맨 앞에 끼워 넣는다.
  const methodTypeName = program.udtMethodCallTypes.get(expr);
  if (methodTypeName !== undefined && expr.callee.kind === "DotAccess") {
    // C687: 오버로드는 receiver 몫 +1로 선택(analyzer dispatch와 동일 공유 헬퍼·동일 입력) —
    // 오버로드 없는 method는 기존 mangleMethodName 재계산과 완전히 같은 이름이 나온다.
    const mangledName = lookupMethodOverload(program, methodTypeName, expr.callee.attr, 1 + expr.args.length + expr.kwargs.length, expr)!.name;
    const slotBase = program.funcCallSlots.get(expr)!;
    const objCode = genExpr(expr.callee.obj, program, funcCtx);
    // C408: 키워드 인자 — bare UDF 콜(line ~2778 주석)과 완전히 동일한 원리로 값이 실제로 지정된
    // 가장 뒤쪽 슬롯까지만 채우고, 그 범위 안에서 kwargs가 건너뛴 슬롯만 리터럴 "undefined"로
    // 채운다. receiver(paramNames[0])는 objCode로 이미 고정돼 args 슬롯 계산에서 제외되므로
    // paramNames[i+1]로 -1 오프셋만 다르다(analyzer dispatchUdtMethodCall과 동일 오프셋).
    const args: string[] =
      expr.kwargs.length === 0
        ? expr.args.map((a) => genExpr(a, program, funcCtx))
        : (() => {
            const func = program.funcs.get(mangledName)!;
            const kwargsByName = new Map(expr.kwargs.map((kw) => [kw.name, kw.value]));
            let lastSetIndex = expr.args.length - 1;
            func.paramNames.slice(1).forEach((name, i) => {
              if (i > lastSetIndex && kwargsByName.has(name)) lastSetIndex = i;
            });
            const out: string[] = [];
            for (let i = 0; i <= lastSetIndex; i++) {
              if (i < expr.args.length) {
                out.push(genExpr(expr.args[i]!, program, funcCtx));
                continue;
              }
              const kwValue = kwargsByName.get(func.paramNames[i + 1]!);
              out.push(kwValue !== undefined ? genExpr(kwValue, program, funcCtx) : "undefined");
            }
            return out;
          })();
    // __taBase/__histBase/__refHistBase 조건부 전달은 일반 UDF 콜과 동일(C162/C364/C541 —
    // genMethodDecl의 조건부 파라미터와 짝).
    const taBase = program.funcTaBases.get(expr);
    const histBase = program.funcHistBases.get(expr);
    const refHistBase = program.funcRefHistBases.get(expr);
    const condHistBase = program.funcCondHistBases.get(expr);
    const condRefHistBase = program.funcCondRefHistBases.get(expr);
    const baseArgs = [String(slotBase)];
    if (taBase !== undefined) baseArgs.push(String(taBase));
    if (histBase !== undefined) baseArgs.push(String(histBase));
    if (refHistBase !== undefined) baseArgs.push(String(refHistBase));
    if (condHistBase !== undefined) baseArgs.push(String(condHistBase));
    if (condRefHistBase !== undefined) baseArgs.push(String(condRefHistBase));
    return `${mangledName}(${[...baseArgs, objCode, ...args].join(", ")})`;
  }
  throw new Error("internal: 알 수 없는 CallExpr (analyzer 통과 후 발생 불가)");
}
