// Analyzer: var 슬롯 인덱스 부여, TA 콜사이트 슬롯 인덱스 부여, 식별자 스코프 검증,
// const/simple/series 한정자 추론(pine2py analyzer.py의 _infer_qualifier/_merge_qualifiers 이식 —
// scope.py의 TypeQualifier CONST/SIMPLE/SERIES 3단계, UNKNOWN은 이식하지 않고 대신 미선언 위치는
// "simple" 기본값으로 단순화했다: pine2js는 merge 시 UNKNOWN을 SIMPLE과 동일 순위로 취급하는
// pine2py와 값 상 동치이면서 4번째 상태를 따로 관리할 필요가 없어서다). 이번 슬라이스의 유일한
// 소비처는 ta.sma의 length 인자 — series면 하드 에러(런타임 rt.ta.sma가 첫 호출의 length로
// 고정폭 순환 버퍼를 한 번만 할당하므로, length가 바마다 바뀌면 조용히 틀린 값을 낸다. pine2py는
// 이를 경고만 하지만 pine2js의 incremental 알고리즘은 이 조건에서 실제로 깨지므로 에러로 승격 —
// GOAL.md "pine2py의 알려진 버그는 따르지 않는다"의 반대 방향 적용: pine2py가 관대한 지점을
// pine2js가 구조적으로 더 엄격하게 막는 사례).
//
// IfStmt는 실제 블록 스코프로 분석한다(pine2py scope.py의 ScopeManager 이식): '='로 선언된
// 로컬은 자신이 속한 블록+하위 블록에서만 보이고(섀도잉), ':='는 var 슬롯뿐 아니라 바깥 스코프의
// 로컬도 재대입 대상이 될 수 있다(if 안에서 바깥 local을 갱신하는 것이 Pine의 핵심 관용구).
// codegen이 블록을 JS `{ let ... }`로 내보내 실제 스코프를 갖게 되므로, 여기서 스코프 검증을
// 정확히 하지 않으면 런타임에 조용히 틀린 값을 읽거나 ReferenceError가 난다.

import type {
  Assignment,
  BinOp,
  CallExpr,
  DotAccess,
  Expr,
  ForInStmt,
  ForStmt,
  FuncDecl,
  IfStmt,
  IndexAccess,
  MethodDecl,
  Script,
  Stmt,
  StringLiteral,
  SwitchStmt,
  TernaryOp,
  TupleDestructure,
  TupleExpr,
  VarDecl,
  WhileStmt,
} from "./ast";
import {
  ARRAY_REGISTRY,
  MAP_REGISTRY,
  MATRIX_REGISTRY,
  STR_REGISTRY,
  analyzeArrayCall,
  analyzeMapCall,
  analyzeMatrixCall,
  analyzeStrCall,
} from "./analyzer/collections";
import { TA_REGISTRY, analyzeStatefulCall, taCallReturnArity } from "./analyzer/ta";
export { TA_REGISTRY, taCallReturnArity, resolveTaKwargPositions } from "./analyzer/ta";
import {
  isArrayConstructorCall,
  isMapConstructorCall,
  isMatrixConstructorCall,
  isMatrixMultCall,
  isMatrixMultVectorArg,
  isMatrixReturningMethodSugarCall,
  isMatrixSumCall,
  isUdtConstructorCall,
  isDrawingConstructorCall,
  isDrawingAllConstant,
  arrayDrawingConstructorElemKind,
  arrayUdtConstructorElemType,
  matrixDrawingConstructorElemKind,
  matrixUdtConstructorElemType,
  mapDrawingConstructorValueKind,
  mapUdtConstructorValueType,
  DRAWING_ALL_NAMESPACES,
} from "./analyzer/constructors";
import type { DrawingKind } from "./analyzer/constructors";
import type { UdtTypeInfo, MethodOverloadEntry } from "./analyzer/udt-types";
import {
  arrayUdtElemType,
  arrayDrawingElemType,
  mapValueDrawingElemType,
  mapValueUdtElemType,
  lookupMethodOverload,
  mangleMethodName,
  methodReceiverElemDrawingKind,
  resolveMethodReceiverTypeName,
  resolveParamUdtTypeHint,
  resolveScalarMethodInfo,
  CHART_POINT_FIELD_TYPE,
  CHART_POINT_FIELDS,
} from "./analyzer/udt-types";
export { isUdtReferenceFieldType, lookupMethodOverload, mangleMethodName, resolveMethodReceiverTypeName, CHART_POINT_FIELD_TYPE } from "./analyzer/udt-types";
export type { UdtFieldInfo, UdtTypeInfo, MethodOverloadEntry } from "./analyzer/udt-types";
import {
  analyzeEnumDecl,
  analyzeFieldAssignment,
  analyzeTypeDecl,
  prepassEnumDecl,
  prepassTypeDecl,
} from "./analyzer/udt-decls";
import { resolveArityDisjointOverloads } from "./analyzer/func-overloads";
import {
  analyzeCallExpr,
  detectRecursiveFuncCalls,
  processPendingSecurityParamExprs,
  resolvePendingFuncCallSlots,
  resolveUdtMethodReceiverType,
} from "./analyzer/call-expr";
export {
  INPUT_DISCARD_SLOT_NAMES,
  INPUT_PARAM_NAMES,
  TICKER_KWARG_PARAM_NAMES,
  DRAWING_STATE_PARAM_NAMES,
  MATH_KWARG_PARAM_NAMES,
  COLOR_KWARG_PARAM_NAMES,
  NZ_KWARG_PARAM_NAMES,
  TIMEFRAME_IN_SECONDS_KWARG_PARAM_NAMES,
  RUNTIME_KWARG_PARAM_NAMES,
  TIME_CALL_KWARG_PARAM_NAMES,
  resolveTimestampKwargSlots,
} from "./analyzer/call-expr";
import {
  analyzeIndexAccess,
  classifyTupleElemNonNumericKind,
  describeDotAccess,
  resolveTupleElemUdtType,
  resolveUdtObjectType,
} from "./analyzer/index-access";
export { resolveUdtObjectType } from "./analyzer/index-access";

// enum 타입명 -> 멤버 이름 목록(선언 순서) + 멤버별 title(C136, 표시 전용 메타데이터). 값 자체는
// codegen 표현이 필요 없다 — 멤버 접근(Direction.long)이 analyzer에서 바로 "EnumName.MemberName"
// qualified 문자열로 접히므로(DotAccess 케이스, builtinStringConstants 재사용) 별도 런타임 상수
// 테이블이 불필요하다. titles는 모든 멤버가 항상 채워짐(명시 title 없으면 pine2py 기본값 규약과
// 동일하게 bare 멤버 이름 자체가 title) — 아직 이를 읽는 런타임 채널은 없고(파싱+저장만, ROADMAP
// 'enum' 항목 참조) 향후 UI 채널이 생기면 이 맵을 그대로 소비하면 된다.
export interface EnumTypeInfo {
  members: string[];
  titles: Map<string, string>;
}

export const BAR_SERIES_NAMES: ReadonlySet<string> = new Set(["open", "high", "low", "close", "volume"]);

// hl2/hlc3/ohlc4/hlcc4 — open/high/low/close 파생 bare 식별자(pine2py CONTEXT_DATA_VARS 격차,
// DIVERGENCES.md #15, C176/C182가 발견/재확인). pine2py는 push_bar()마다 별도 Series로 저장하지만
// (wavealgo/context.py L150-153), pine2js는 이미 open/high/low/close Series를 갖고 있어 별도 저장
// 없이 codegen이 그 자리에서 합성 방출한다(GOAL.md "bar loop 안 할당 제로"에 더 부합, 새 Context
// 필드/precompute 단계 불필요 — codegen.ts genDerivedPriceExpr/genBarRef 참조). request.security의
// bare/표현식 콜사이트 화이트리스트(call-expr.ts, 여전히 BAR_SERIES_NAMES 5종 전용)는 이번 이식의
// 스코프 밖 — 이 세트를 거기 추가하지 않는다(별도 항목).
export const DERIVED_PRICE_NAMES: ReadonlySet<string> = new Set(["hl2", "hlc3", "ohlc4", "hlcc4"]);

// bar_index — pine2py Context.idx와 동형인 0-based 현재 바 인덱스(wavealgo/context.py L154:
// `self.data.bar_index.push(index)`, L155: `self.idx = index`). 값 자체가 가격 평균이 아니라
// 정수 스칼라라 DERIVED_PRICE_NAMES와 분리 — pine2js Context.idx(barstate/session이 이미 확립한
// 필드, C148)를 그대로 재사용해 `$.idx - offset` 산술로 충분(별도 Series/precompute 불필요).
export const BAR_INDEX_NAME = "bar_index";

// TV 시각 변수(pine2py wavealgo/context.py SERIES_BUILTINS 계열, C242 — ROADMAP P3 next_hint
// 1순위) — bar_index와 동일하게 top-level bare 식별자로 매 바 다른 값을 내는 진짜 series지만
// 별도 Series 저장 없이 Context.barTimeMs(request.security HTF용으로 이미 있던 this.time 채널
// 재사용, context.ts 참조)에서 그때그때 파생한다(GOAL.md "bar loop 안 할당 제로"). 히스토리
// 인덱스([n])는 corpus 실측 0건이라 미지원 유지(index-access.ts가 이 세트를 참조하지 않아
// bar_index/BAR_SERIES_NAMES와 달리 자동으로 "미지원" 에러 경로를 탄다). pine2py는 타임존을
// UTC로 고정(exchange 타임존 없음) — VERIFIED_SEMANTICS.md에 근거 없어 추측 금지, 그대로 이식
// 후 DIVERGENCES 가설 등재(runtime/datetime.ts 주석 참조). dayofweek.sunday류 이름있는 상수는
// pine2py 자신의 ctx.dayofweek(1~7, Sunday=1) 공식과 codegen 상수 테이블(0~6)이 서로 다른 값
// 체계를 쓰는 실제 내부 불일치가 직접 실행으로 확인돼(C242) 이번 슬라이스에서 제외 — 별도 사이클
// 필요(ROADMAP 참조). weekofyear(C302)는 C242 당시 이 7종 목록에서 누락된 실제 gap이었음 —
// pine2py는 ctx.weekofyear(bare)/weekofyear_func(호출형) 양쪽을 이미 완전히 지원한다.
// time_close/timenow(C342, wild "알 수 없는 식별자" 클러스터 1/2위 합산 61%) — pine2py
// context.py에 프로퍼티 자체는 있으나 둘 다 구조적으로 dead: _time_close_data는 push_bar()를
// 포함해 전체 코드베이스 어디서도 채워지지 않아 time_close가 항상 0을 반환하고(grep 재확인),
// timenow는 실제 벽시계(`time.time()`)라 오라클/재현 대상이 될 수 없다(LIMITATIONS.md 기존
// 결정) — 둘 다 literal port 불가, hand-verified 신규 설계(DIVERGENCES 'TV 미검증(가설)').
// pine2js는 이미 전체 OHLCV 배열을 쥔 배치 리플레이라 pine2py보다 나은 근사가 가능: time_close는
// 다음 바의 time(gapless 데이터 가정, context.ts timeCloseMs)로, timenow는 C239/C287 "환경값"
// 축과 동일하게 결정적 고정값(마지막 바 시각, lastBarTimeMs 재사용)으로 설계한다 — wild 실사용
// (`barstate.isrealtime ? timenow : time_close` 등)도 이 값이 barstate.isrealtime===false인
// 절대다수 바에서는 아예 안 읽히는 분기라 정확한 수치보다 "컴파일 통과"가 더 중요함을 뒷받침한다.
export const TIME_VAR_NAMES: ReadonlySet<string> = new Set([
  "time",
  "time_close",
  "time_tradingday",
  "last_bar_index",
  "last_bar_time",
  "timenow",
  "year",
  "month",
  "dayofmonth",
  "dayofweek",
  "hour",
  "minute",
  "second",
  "weekofyear",
]);

// bid/ask(C767, pure_gap 'other' 재분류 실측 3건, wild `ask - bid`/`close == bid` 관용구) — TV
// 실시간 Level 1 호가 변수. pine2py에 대응 구현이 전혀 없어(python 직접 grep 0건) 오라클 대조
// 불가 — time_close/timenow(C342)와 동일하게 hand-verified 설계 대상. 이 엔진은 OHLCV 배치
// 리플레이라 실제 호가 데이터 자체가 없고(quant\data_cache는 OHLCV뿐), TV 공식 문서상 이 두
// 변수는 실시간 피드 없이는(즉 과거 바 리플레이에서는) 의미 있는 값을 못 낸다는 것이 널리 알려진
// 제약이라 상시 NaN(na)로 근사한다 — wild 관용구가 전부 `close == bid`류 비교/차분이라 na
// 전파(C67 비교 na 전파)로 안전하게 false/NaN에 흡수되고 크래시하지 않는다. 히스토리 인덱스
// ([n])는 corpus 실측 0건이라 미지원 유지(index-access.ts가 이 세트를 참조하지 않아 hl2류와
// 달리 자동으로 "미지원" 경로를 탐). TV 미검증(가설) — DIVERGENCES.md 등재.
export const BID_ASK_NAMES: ReadonlySet<string> = new Set(["bid", "ask"]);

// TV 시간 컴포넌트 함수-호출 오버로드(C245, ROADMAP P3 next_hint 1순위, C244가 재확인한 corpus
// 실사용 — 739b34bc9adb.pine `h = hour(time)`, 1-인자 폼만) — TIME_VAR_NAMES 7종(bar_index류
// bare 식별자로 이미 지원 중인 이름) 중 시각 자체를 나타내는 4종(time/time_tradingday/
// last_bar_index/last_bar_time)을 뺀 "시간 컴포넌트 추출" 7종만 pine2py codegen.py FUNC_MAP
// 주석 그대로 "dual-use: variable + function"이다(wavealgo/__init__.py hour_func 등 7개 모두
// `(time_ms=None, timezone="", context=None)` 동일 시그니처). corpus 실사용은 hour 1건뿐이나
// 나머지 6종도 같은 rt.datetime.* 함수가 이미 존재해(C242) 이 호출-형 오버로드 하나로 7종 전부
// 공짜로 커버된다(linefill(C238)/chart.is_*(C239) 선례와 동일 원칙 — 형제 그룹은 구현 비용이
// 이미 0에 가까우면 한 번에). weekofyear(C302)는 C245 당시 이 7종에서 누락됐던 8번째 형제 —
// 시그니처/제약 전부 동일해 TIME_VAR_NAMES와 나란히 추가. 2-인자 timezone 오버로드는 C244
// 당시 corpus 근거가 없어 범위 밖이었으나 wild 코퍼스에서 175건(hour 138/year 26/dayofweek 5/
// month 3/dayofmonth 2/minute 1)이 발현해 C326이 지원 추가(analyzer/call-expr.ts TIME_FUNC_NAMES
// 분기 + runtime/datetime.ts zonedWallClockMs 참조).
export const TIME_FUNC_NAMES: ReadonlySet<string> = new Set([
  "year",
  "month",
  "dayofmonth",
  "dayofweek",
  "hour",
  "minute",
  "second",
  "weekofyear",
]);

// dayofweek.sunday~saturday 이름있는 상수(C497, wild "네임스페이스 접근은 호출식만 지원" 클러스터
// 1위 서브그룹 90/177건, DIVERGENCES #96이 미구현으로 남겨뒀던 항목) — pine2py 자신이 두 값 체계로
// 내부 불일치를 가진다: ctx.dayofweek 공식(wavealgo/context.py, 원문 주석 "PineScript: 1=Sunday ~
// 7=Saturday")은 1~7이지만 codegen.py IDENTIFIER_MAP의 dayofweek.sunday~saturday 리터럴 폴딩은
// 0~6이다(DIVERGENCES #96). 이 세션은 웹 접근이 없어 TV 실측 불가하지만, 독립 블랙박스 구현체
// PineTS(AGPL, 시맨틱 참조 전용 — src/namespaces/Types.ts dayofweek enum + Time.ts EXTRACTORS.dayofweek
// 둘 다 1=Sunday~7=Saturday)가 ctx.dayofweek 공식과 정확히 일치해 교차검증됨 — literal-port 대신
// GOAL.md "pine2py 알려진 버그는 따르지 않는다" 원칙 적용, bare dayofweek(rt.datetime.dayofweek,
// 이미 1~7로 이식됨, C242)와 자기일관적인 1~7 채택. DIVERGENCES에 "TV 미검증(가설, PineTS 교차검증)"
// 로 등재.
export const DAYOFWEEK_CONSTANTS: ReadonlyMap<string, number> = new Map([
  ["sunday", 1],
  ["monday", 2],
  ["tuesday", 3],
  ["wednesday", 4],
  ["thursday", 5],
  ["friday", 6],
  ["saturday", 7],
]);

// math.*의 인자 없는 네임스페이스 상수(pi/e/phi/rphi) — CallExpr가 아니라 순수 DotAccess라
// analyzeCallExpr 경로가 아예 안 맞는다(analyzeExpr의 DotAccess 분기에서 직접 리터럴로 접어
// 등록). 값은 pine2py wavealgo/math/__init__.py L173-176 그대로(pi=math.pi, e=math.e,
// phi=(1+sqrt(5))/2, rphi=(1-sqrt(5))/2+1) — node/python 양쪽 IEEE754 double 대조 결과 4개 전부
// 비트 단위로 동일함을 확인해(둘 다 같은 표준 근사값을 공유) override 불필요. Map을 쓰는 이유:
// plain object였다면 `"toString" in obj`처럼 Object.prototype 상속 프로퍼티가 attr 이름과 우연히
// 충돌할 여지가 있다(hasOwnProperty 없이 `in`으로 체크하면 함정).
export const MATH_CONSTANTS: ReadonlyMap<string, number> = new Map([
  ["pi", Math.PI],
  ["e", Math.E],
  ["phi", (1 + Math.sqrt(5)) / 2],
  ["rphi", (1 - Math.sqrt(5)) / 2 + 1],
]);

// color.*의 인자 없는 네임스페이스 상수(17종, C78) — math.pi류(MATH_CONSTANTS)와 동일한 컴파일타임
// 폴딩 대상이지만 값이 number가 아니라 hex string이라 별도 Map + 별도 AnalyzedProgram 필드
// (builtinStringConstants)가 필요하다(golden.ts의 compareStringToGolden 병렬 신설과 동일한 이유 —
// 기존 number 전용 경로에 타입을 얹지 않고 병렬 구조로 확장). 값은 pine2py
// wavealgo/builtins/color.py L13-29 그대로.
export const COLOR_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["aqua", "#00BCD4"],
  ["black", "#000000"],
  ["blue", "#2196F3"],
  ["fuchsia", "#E040FB"],
  ["gray", "#787B86"],
  ["green", "#4CAF50"],
  ["lime", "#00E676"],
  ["maroon", "#880E4F"],
  ["navy", "#311B92"],
  ["olive", "#808000"],
  ["orange", "#FF9800"],
  ["purple", "#9C27B0"],
  ["red", "#FF5252"],
  ["silver", "#B2B5BE"],
  ["teal", "#00897B"],
  ["white", "#FFFFFF"],
  ["yellow", "#FFEB3B"],
]);

// order.ascending/descending(C85, array.sort/sort_indices 두 번째 인자) — math.pi/color.red와
// 동일한 컴파일타임 폴딩 대상이지만 값이 boolean이라 세 번째 병렬 Map(builtinBooleanConstants)이
// 필요하다. pine2py codegen.py IDENTIFIER_MAP은 order.ascending->Python True, order.descending->
// False로 매핑(array.py sort()의 `is_desc = not order`가 그 뒤를 이음) — pine2js는 rt.array.sort의
// 시그니처를 ascending:boolean 하나로 단순화했으므로 이 값이 곧 그 인자 그대로 쓰인다(order.py
// 원본의 bool/문자열 이중 분기는 재현 대상이 아님, runtime/array.ts sort 주석 참조).
export const ORDER_CONSTANTS: ReadonlyMap<string, boolean> = new Map([
  ["ascending", true],
  ["descending", false],
]);

// barmerge.gaps_on/gaps_off/lookahead_on/lookahead_off(request.security 둘째 슬라이스, C177) —
// order.ascending/descending과 동일한 컴파일타임 boolean 폴딩(pine2py codegen.py IDENTIFIER_MAP
// L1927-1930이 넷 다 "True"/"False" 리터럴로 직결 매핑). 소비처(request.security의 gaps=/lookahead=
// kwargs)는 어느 상수든 값만 boolean으로 받으면 되므로 이름과 kwarg 의도(gaps vs lookahead)가
// 어긋나도(예: gaps=barmerge.lookahead_on) analyzer가 막지 않는다 — pine2py도 동일(전부 그냥 True).
export const BARMERGE_CONSTANTS: ReadonlyMap<string, boolean> = new Map([
  ["gaps_on", true],
  ["gaps_off", false],
  ["lookahead_on", true],
  ["lookahead_off", false],
]);

// adjustment.none/splits/dividends + backadjustment.on/off/inherit(C615, wild "네임스페이스 접근은
// 호출식만 지원" 클러스터 재조사 — ticker.modify()의 session=/adjustment=/backadjustment= 값).
// TICKER_KWARG_PARAM_NAMES.modify(call-expr.ts)가 이미 이 두 kwarg **이름**은 받아들이는데(C385),
// 그 값(DotAccess)이 컴파일타임 상수로 안 접혀 여기서 막혀 있었다 — order.ascending/descending과
// 동일한 컴파일타임 문자열 폴딩. 둘 다 pine2py ticker.modify(tickerid,session,adjustment)엔
// backadjustment 파라미터 자체가 없어 이미 discard 취급(TICKER_KWARG_PARAM_NAMES 주석 "어차피
// discard라 runtime에 4번째 인자로만 추가" 참조) — 값 자체가 codegen에 실리지 않으므로 이 폴딩의
// 유일한 역할도 이 에러를 막는 것뿐이다. PineTS Types.ts의 adjustment/backadjustment enum
// (docs/api-coverage/types.md "Backadjustment" 표와 교차확인)으로 real TV 상수 확인, pine2py 본체엔
// 미구현이라 hand-verified, DIVERGENCES 'TV 미검증(가설)' 등재 불필요(값이 어차피 무해).
export const ADJUSTMENT_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["none", "none"],
  ["splits", "splits"],
  ["dividends", "dividends"],
]);
export const BACKADJUSTMENT_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["on", "on"],
  ["off", "off"],
  ["inherit", "inherit"],
]);

// alert.freq_once_per_bar/freq_once_per_bar_close/freq_all(C208, alert()의 freq 인자) +
// shape.*(12종, plotshape 스타일)/location.*(5종, plotshape/plotchar 위치)/hline.style_solid·dotted·
// dashed(hline 선 스타일) — 전부 order.ascending/descending과 동일한 컴파일타임 문자열 폴딩이지만,
// alert()/alertcondition()/plotshape()/plotchar()/hline() 자신이 noopStmtCalls(아래)로 전부
// discard되는 인자라 값 자체는 어디에도 codegen되지 않는다(pine2py codegen.py IDENTIFIER_MAP
// L1827-1948 문자열 그대로 옮김 — 실제로 쓰이진 않지만 명시적 폴딩이 없으면 이 DotAccess가
// "네임스페이스 접근은 호출식만 지원" 최종 에러로 떨어져 알 수 없는 함수 호출과 별개로 코퍼스
// 스크립트를 막는다).
export const ALERT_FREQ_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["freq_once_per_bar", "freq_once_per_bar"],
  ["freq_once_per_bar_close", "freq_once_per_bar_close"],
  ["freq_all", "freq_all"],
]);
export const SHAPE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["xcross", "shape_xcross"],
  ["cross", "shape_cross"],
  ["triangleup", "shape_triangleup"],
  ["triangledown", "shape_triangledown"],
  ["circle", "shape_circle"],
  ["flag", "shape_flag"],
  ["diamond", "shape_diamond"],
  ["arrowup", "shape_arrowup"],
  ["arrowdown", "shape_arrowdown"],
  ["square", "shape_square"],
  ["labelup", "shape_labelup"],
  ["labeldown", "shape_labeldown"],
]);
export const LOCATION_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["abovebar", "abovebar"],
  ["belowbar", "belowbar"],
  ["top", "top"],
  ["bottom", "bottom"],
  ["absolute", "absolute"],
]);
export const HLINE_STYLE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["style_solid", "solid"],
  ["style_dotted", "dotted"],
  ["style_dashed", "dashed"],
]);
// plot.style_*(7종)/display.*(5종)(C254, ROADMAP P4 "네임스페이스 접근" 클러스터 잔여 —
// 실제 TV 문법인데 값이 plot()의 style=/display= kwarg 자리에서만 쓰이는 렌더링 전용 no-op
// 메타데이터라 alert.freq_*/shape.*/location.*/hline.style_*(C208)와 완전히 동일한 컴파일타임
// 문자열 폴딩 패턴 — pine2py pine2wave/codegen.py IDENTIFIER_MAP(L1900-1908, L1938-1944)의
// 문자열 값을 그대로 옮긴다. PLOT_PARAM_NAMES가 이미 style/display를 유효 kwarg 이름으로
// 등록해뒀으므로(call-expr.ts) 이 두 맵이 없으면 그 값(DotAccess)이 analyzeExpr를 거치며 최종
// "네임스페이스 접근은 호출식만 지원" 에러로 떨어진다 — codegen은 plot()의 series(첫 위치 인자)
// 하나만 record()하고 나머지 kwargs 값은 title처럼 전부 discard하므로(codegen.ts genExpr plotSlot
// 분기 참조) 이 폴딩의 유일한 역할도 그 에러를 막는 것뿐이다.
// style_linebr/style_stepline_diamond(C285, ROADMAP P4 wild 잔여 233-클러스터 1위, 70+2건) --
// pine2py pine2wave/codegen.py IDENTIFIER_MAP(L1901-1907)에는 7종뿐이지만 pine2py 자신의
// docs/pinescript_visualization_reference.md 9.5절 "상수 미매핑" 표가 이 둘을 TV 공식 plot.style_*
// 9종 중 매핑 누락분으로 명시(price_scale/label 4종과 나란히, 동일 표) -- currency/format.price
// (C284)와 동일한 "pine2py 갭이지 TV 미검증 가설이 아님" 근거. style_areabr(같은 표의 세 번째
// 미매핑 항목)은 wild 실측 0건이라 C283 "실측에 나온 이름만 큐레이션" 원칙으로 이번엔 제외.
export const PLOT_STYLE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["style_line", "line"],
  ["style_linebr", "linebr"],
  ["style_stepline", "stepline"],
  ["style_stepline_diamond", "stepline_diamond"],
  ["style_histogram", "histogram"],
  ["style_cross", "cross"],
  ["style_area", "area"],
  ["style_areabr", "areabr"],
  ["style_columns", "columns"],
  ["style_circles", "circles"],
  // style_steplinebr(C336, wild 59파일) -- pine2py 참조문서 1.1절 plot.style_* 표(10종)에도 없는
  // 완전 신규 갭(style_areabr과 달리 문서 근거 전무). PineTS pinescript-v6/types.json plot
  // 네임스페이스 교차확인(real TV 상수로 열거됨)만으로 hand-verified 채택, DIVERGENCES 'TV
  // 미검증(가설)' 등재.
  ["style_steplinebr", "steplinebr"],
]);
// plot.linestyle_*(C670, wild "네임스페이스 접근은 호출식만 지원" 클러스터 최다 서브그룹 32건,
// 전량 //@version=6) — TV v6에서 plot()에 신규 추가된 linestyle= kwarg 값(call-expr.ts
// "linestyle" kwarg-only 분기 참조). hline.style_*(C208)와 이름만 다를 뿐 값(solid/dotted/
// dashed)은 동일 — pine2py엔 plot() 쪽 대응이 없어(wavealgo/builtins/plot.py, pine2wave
// codegen.py IDENTIFIER_MAP 둘 다 부재) 이식 대상이 없는 순수 v6 신규 갭이지만, TV 실측 대장
// (tv_verdict_v2.jsonl) 32/32 accept로 가설이 아니라 확정 사실.
export const PLOT_LINESTYLE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["linestyle_solid", "solid"],
  ["linestyle_dotted", "dotted"],
  ["linestyle_dashed", "dashed"],
]);
// price_scale(C285, wild 9건) -- 위 style_linebr과 동일 근거(pine2py 참조문서 9.5절 "상수
// 미매핑" 표, pine2py codegen.py IDENTIFIER_MAP L1940-1944에는 5종뿐). 그 문서는 이 6종이
// `display.all - display.price_scale` 같은 산술 조합(+/-)이 TV 실제 문법임도 명시하지만, plot()의
// display= 값은 title 제외 전부 discard(PLOT_PARAM_NAMES 주석 참조)라 이 폴딩의 유일한 역할도
// "네임스페이스 접근은 호출식만 지원" 에러를 막는 것뿐 -- 산술 결과(문자열 뺄셈이 NaN이 되는 것)는
// 애초에 codegen에 실리지 않아 무해.
export const DISPLAY_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["none", "none"],
  ["all", "all"],
  ["data_window", "data_window"],
  ["pane", "pane"],
  ["status_line", "status_line"],
  ["price_scale", "price_scale"],
]);
// label/line/box/table 드로잉 객체(신규, call-expr.ts DRAWING_METHODS 참조)의 kwarg 값으로 쓰이는
// 네임스페이스 상수군 — alert.freq_*/shape.*/location.*/hline.style_*(C208)와 동일한 이유(값은
// 전부 discard되는 no-op 콜 인자라 실제로 codegen에 실리지 않음, 이 폴딩의 유일한 역할은 "네임스페이스
// 접근은 호출식만 지원" 에러로 안 떨어지게 막는 것)로 pine2py pine2wave/codegen.py IDENTIFIER_MAP
// (L1950-2013)의 문자열 값을 그대로 옮긴다. box.set_border_style은 별도 상수 없이 LINE_STYLE_CONSTANTS를
// 공유(pine2py도 box 전용 style 상수가 없음 — TV가 line/box border style을 같은 enum으로 공유).
// style_label_upper_left/upper_right/lower_left/lower_right(C285, wild 4+1+3+7=15건, "label"
// obj group 전량) -- 위 style_linebr/price_scale과 동일 근거(pine2py 참조문서 9.5절 "상수
// 미매핑" 표가 이 4종을 정확히 명시, pine2py codegen.py IDENTIFIER_MAP L1957-1973에는 없음).
export const LABEL_STYLE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["style_none", "none"],
  ["style_label_up", "label_up"],
  ["style_label_down", "label_down"],
  ["style_label_left", "label_left"],
  ["style_label_right", "label_right"],
  ["style_label_upper_left", "label_upper_left"],
  ["style_label_upper_right", "label_upper_right"],
  ["style_label_lower_left", "label_lower_left"],
  ["style_label_lower_right", "label_lower_right"],
  ["style_cross", "cross"],
  ["style_circle", "circle"],
  ["style_diamond", "diamond"],
  ["style_label_center", "label_center"],
  ["style_triangleup", "triangleup"],
  ["style_triangledown", "triangledown"],
  ["style_flag", "flag"],
  ["style_arrowup", "arrowup"],
  ["style_arrowdown", "arrowdown"],
  ["style_square", "square"],
  ["style_text_outline", "text_outline"],
  ["style_xcross", "xcross"],
]);
export const LINE_STYLE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["style_solid", "solid"],
  ["style_dotted", "dotted"],
  ["style_dashed", "dashed"],
  ["style_arrow_left", "arrow_left"],
  ["style_arrow_right", "arrow_right"],
  ["style_arrow_both", "arrow_both"],
]);
export const SIZE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["auto", "auto"],
  ["tiny", "tiny"],
  ["small", "small"],
  ["normal", "normal"],
  ["large", "large"],
  ["huge", "huge"],
]);
export const POSITION_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["top_left", "top_left"],
  ["top_center", "top_center"],
  ["top_right", "top_right"],
  ["middle_left", "middle_left"],
  ["middle_center", "middle_center"],
  ["middle_right", "middle_right"],
  ["bottom_left", "bottom_left"],
  ["bottom_center", "bottom_center"],
  ["bottom_right", "bottom_right"],
]);
export const EXTEND_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["none", "none"],
  ["left", "left"],
  ["right", "right"],
  ["both", "both"],
]);
export const XLOC_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["bar_index", "bar_index"],
  ["bar_time", "bar_time"],
]);
export const YLOC_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["price", "price"],
  ["abovebar", "abovebar"],
  ["belowbar", "belowbar"],
]);
export const TEXT_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["align_left", "left"],
  ["align_center", "center"],
  ["align_right", "right"],
  ["wrap_none", "none"],
  ["wrap_auto", "auto"],
  // align_top/align_bottom(C335, ROADMAP P4) — pine2py 참조문서(docs/pinescript_visualization_
  // reference.md "text.align_* 상수" 표)에 align_left/center/right와 나란히 문서화된 TV 공식
  // 상수인데 codegen.py IDENTIFIER_MAP에서만 누락(align_left/center/right는 이미 있음) — C285/C286과
  // 동일한 "문서엔 있으나 pine2py 포트가 누락한 상수" 갭이라 같은 lowercase 리터럴 관례로 채움.
  ["align_top", "top"],
  ["align_bottom", "bottom"],
  // format_bold/format_italic/format_none(C335) — pine2py 문서/codegen.py 어디에도 근거가 전혀
  // 없는 신규 갭(align_*/wrap_*와 달리 참조문서에도 없음) — TV 미검증(가설), DIVERGENCES 참조.
  // label.new()/table.cell()의 text_formatting=/text_font_style= kwarg 값으로만 관측됨(둘 다
  // no-op 드로잉 콜이라 값 자체는 어디에도 실행에 영향 없이 discard) — 값이 서로 distinct하고
  // 소스 내 재비교(`fmt == text.format_bold`)에도 안전하기만 하면 되므로 TV 통설(Pine 문자열
  // 결합으로 포맷을 합성하는 관행, `text.format_bold + text.format_italic`)에 따라 lowercase
  // 문자열/빈 문자열로 채택.
  ["format_bold", "bold"],
  ["format_italic", "italic"],
  ["format_none", ""],
]);
// font.family_default/family_monospace(C335, ROADMAP P4 wild 재실측 신규 후보) — pine2py
// codegen.py IDENTIFIER_MAP L2024-2025에 이미 'default'/'monospace' 리터럴로 포트돼 있는 값
// 그대로 가져옴(currency/format(C284)과 동일한 직접 literal-port, TV 미검증 아님). table.cell()의
// text_font_family= kwarg 값으로만 관측(no-op 드로잉 콜 discard).
export const FONT_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["family_default", "default"],
  ["family_monospace", "monospace"],
]);
// dividends.gross/net · splits.numerator/denominator(신규, request.dividends/request.splits의
// field 인자) — alert.freq_*/shape.*류와 동일한 컴파일타임 문자열 폴딩(pine2py pine2wave/codegen.py
// IDENTIFIER_MAP L2030-2033 문자열 값 그대로 옮김). request.dividends/splits 스텁(runtime/request.ts,
// wavealgo/__init__.py L122-128 literal port)이 field 인자 자체를 무시하고 항상 0.0을 반환하므로
// 이 값은 어디에도 codegen에 실리지 않는다 — 이 폴딩의 유일한 역할도 alert.freq_*류와 동일하게
// "네임스페이스 접근은 호출식만 지원" 에러를 막는 것.
export const DIVIDENDS_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["gross", "gross"],
  ["net", "net"],
]);
export const SPLITS_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["numerator", "numerator"],
  ["denominator", "denominator"],
]);
// earnings.actual/estimate/standardized(신규, C397 — request.earnings의 field 인자) —
// dividends.gross/net과 동일한 컴파일타임 문자열 폴딩(pine2py pine2wave/codegen.py IDENTIFIER_MAP
// L2027-2029 문자열 값 그대로 옮김). request.earnings 스텁(runtime/request.ts)이 field 인자
// 자체를 무시하고 항상 0.0을 반환하므로 이 값도 어디에도 codegen에 실리지 않는다.
export const EARNINGS_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["actual", "actual"],
  ["estimate", "estimate"],
  ["standardized", "standardized"],
]);
// earnings.future_eps/future_period_end_time/future_revenue/future_time(신규, C482 —
// next_hint(C481) 지시대로 namespace-access 178-클러스터 미확인분 개별 샘플링 중 발견). 위
// EARNINGS_CONSTANTS(request.earnings의 field 인자용 문자열 3종)와 달리 이 4종은 bare 변수로 직접
// 읽히는 series 숫자값(wild 실사용: `earningsTime = earnings.future_time`, request.security 표현식
// 배열 원소 등) — pine2py wavealgo/__init__.py에 이 4종 매핑 자체가 아예 없어(grep 0건) literal
// port 불가. PineTS(AGPL, 시맨틱 참조만) docs/api-coverage/types.md가 이 4종을 real TV 상수로
// 문서화(actual/estimate/standardized와 같은 표)해 C391/C337과 동일한 "PineTS 교차확인 hand-verified"
// 근거 성립. 실 예정 실적 데이터를 헤드리스 배치 엔진이 낼 수 없으므로 GOAL.md na 시맨틱(숫자=NaN)
// 그대로 고정값 NaN.
export const EARNINGS_NUMBER_PROPS: ReadonlyMap<string, number> = new Map([
  ["future_eps", NaN],
  ["future_period_end_time", NaN],
  ["future_revenue", NaN],
  ["future_time", NaN],
]);
// currency.*/format.*(C284, ROADMAP P4 wild 클러스터 1위 "네임스페이스 접근" 서브클러스터 —
// currency 428건/format 317건, 합쳐 78%) — strategy()의 currency=/indicator()·strategy()의
// format= kwarg 값으로만 쓰이는 렌더링·회계 표시 전용 no-op 메타데이터라 alert.freq_*/shape.*류
// (C208)와 완전히 동일한 컴파일타임 문자열 폴딩. pine2py pine2wave/codegen.py IDENTIFIER_MAP
// (L1931-1935, L2034-2044)의 문자열 값을 그대로 옮긴 것은 10종(USD/EUR/GBP/JPY/AUD/CAD/CHF/CNY/
// KRW/NONE)뿐 — format.price는 TV 실제 상수(TV 문서 5종 중 하나, wild 실측 184건으로 format
// 서브클러스터 최다)인데 pine2py IDENTIFIER_MAP엔 아예 없다(누락 시 bare "format" 식별자가
// 미등록이라 codegen.py가 NameError를 내는 진짜 pine2py 갭 — syminfo.country/volumetype과 동일
// 급, 오라클 대조 불가). currency의 USDT/INR/SEK/AED/TRY 5종도 동일하게 pine2py 갭이지만 wild
// corpus 실제 등장(C283 "wild 실측에 나온 이름만 큐레이션" 원칙 재적용, 블랙리스트 추측 확장 아님)
// 근거로만 추가 — 값 자체는 어디에도 codegen에 실리지 않아(STRATEGY_PARAM_NAMES/INDICATOR_PARAM_
// NAMES/PLOT_PARAM_NAMES 전부 discard) 이 폴딩의 유일한 역할도 "네임스페이스 접근은 호출식만
// 지원" 에러를 막는 것뿐이다.
export const CURRENCY_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["USD", "USD"],
  ["EUR", "EUR"],
  ["GBP", "GBP"],
  ["JPY", "JPY"],
  ["AUD", "AUD"],
  ["CAD", "CAD"],
  ["CHF", "CHF"],
  ["CNY", "CNY"],
  ["KRW", "KRW"],
  ["NONE", ""],
  ["USDT", "USDT"],
  ["INR", "INR"],
  ["SEK", "SEK"],
  ["AED", "AED"],
  ["TRY", "TRY"],
]);
export const FORMAT_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["mintick", "mintick"],
  ["percent", "percent"],
  ["volume", "volume"],
  ["inherit", "inherit"],
  ["price", "price"],
]);
// scale.right/left/none(C286, ROADMAP P4 wild 잔여 138건 서브클러스터 2위, 23건) —
// indicator()/strategy()의 scale= kwarg 값(Y축 위치 지정, INDICATOR_PARAM_NAMES/
// STRATEGY_PARAM_NAMES에 이미 등록된 no-op discard 파라미터, call-expr.ts 참조)으로만 쓰여
// currency/format(C284)과 완전히 동일한 컴파일타임 문자열 폴딩. pine2py codegen.py
// IDENTIFIER_MAP엔 매핑이 아예 없지만(grep 0건) pine2py 자신의
// docs/pinescript_visualization_reference.md 17.3절 "미매핑 상수" 표가 이 3종을 TV v5
// indicator()/strategy() scale= 파라미터의 공식 값으로 명시(format.price/C284와 동일 급
// "pine2py 갭이지 TV 미검증 가설 아님" 근거) — 값 자체는 directive가 전부 discard해 codegen에
// 안 실리므로 폴딩의 유일한 역할은 "네임스페이스 접근은 호출식만 지원" 에러를 막는 것.
export const SCALE_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["right", "right"],
  ["left", "left"],
  ["none", "none"],
]);
// session.regular/extended(C286, ROADMAP P4 wild 잔여 138건 서브클러스터 3위, 17건) —
// ticker.modify()의 session 인자 등에 쓰이는 문자열 리터럴 상수. session.ismarket 등
// (SESSION_PROPS, 위)은 바마다 값이 바뀔 수 있는 런타임 식이라 builtinRuntimeExprs로 등록되지만
// regular/extended는 그 자체로 고정 문자열이라 이름이 겹치지 않는 별도 맵(SESSION_STRING_CONSTANTS)에
// 컴파일타임 문자열로 폴딩 — pine2py codegen.py IDENTIFIER_MAP L2021-2022의
// "session.regular": "'regular'" / "session.extended": "'extended'" 문자열 값을 그대로 옮김
// (literal-port, currency/format과 동일 패턴).
export const SESSION_STRING_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["regular", "regular"],
  ["extended", "extended"],
]);

// chart.*(C287, ROADMAP P4 wild 잔여 98건 1위 클러스터 25건) — pine2py엔 매핑/문서 근거가 전혀
// 없어(codegen.py IDENTIFIER_MAP grep 0건 + docs/pinescript_visualization_reference.md 0건, C286이
// Explore 에이전트 독립 조사로 교차검증) 오라클 불가. currency/scale류 "pine2py 갭 literal-port"가
// 아니라 "뷰포트/테마 개념이 없는 헤드리스 배치 리플레이 엔진에서 이 값이 무엇을 의미해야 하는가"의
// 설계 결정이다(C239 rt.chart.is_standard=true 선례의 연장, LIMITATIONS.md C287/DIVERGENCES 참조):
// (1) 뷰포트 없음 — 배치 리플레이는 전체 바 배열을 항상 갖고 있으므로 "보이는 범위" = 전체 배열.
//     left_visible_bar_index는 첫 바의 bar_index인 0 고정(컴파일타임 number 폴딩),
//     left/right_visible_bar_time은 첫/마지막 바의 time(unix ms) — 값이 로드된 데이터에 의존하므로
//     barstate류 builtinRuntimeExprs($.firstBarTimeMs 신설/$.lastBarTimeMs 기존, context.ts getter).
//     right_visible_bar_time은 last_bar_time과 의도적으로 동일값($.lastBarTimeMs 재사용).
// (2) 테마 없음 — TV 기본 라이트 테마로 고정: bg_color="#FFFFFF"(COLOR_CONSTANTS white와 동일),
//     fg_color="#000000"(black — TV 정의 "bg 대비 최적 대비색"의 흰 배경 대응값). color.white/
//     color.black 리터럴과 문자열이 정확히 같아 비교/합성 시에도 일관된다.
// right_visible_bar_index는 wild 0건이라 미추가(C283 "wild 실측에 나온 이름만 큐레이션" 원칙).
export const CHART_COLOR_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["fg_color", "#000000"],
  ["bg_color", "#FFFFFF"],
]);
export const CHART_NUMBER_CONSTANTS: ReadonlyMap<string, number> = new Map([
  ["left_visible_bar_index", 0],
]);
export const CHART_RUNTIME_PROPS: ReadonlyMap<string, string> = new Map([
  ["left_visible_bar_time", "$.firstBarTimeMs"],
  ["right_visible_bar_time", "$.lastBarTimeMs"],
]);
// bare chart.is_*(wild is_standard 3건) — C239가 호출형(chart.is_standard() → rt.chart.is_*)으로
// 이미 확정한 하드코딩 값(로드된 심볼은 항상 "표준" 차트: is_standard만 true, 합성 바 변환 6종
// 전부 false)을 괄호 없는 bare 변수형(TV 실제 문법)으로도 노출 — 값 미러라 새 시맨틱 결정 0.
export const CHART_IS_BOOLEAN_PROPS: ReadonlyMap<string, boolean> = new Map([
  ["is_standard", true],
  ["is_heikinashi", false],
  ["is_renko", false],
  ["is_kagi", false],
  ["is_linebreak", false],
  ["is_pnf", false],
  ["is_range", false],
]);

// syminfo.*(17종, ROADMAP P2 "barstate/session/syminfo/timeframe" 두 번째 슬라이스 + C337 확장) —
// math.pi/color.red/order.ascending과 동일한 "인자 없는 네임스페이스 상수" bare DotAccess지만,
// barstate.*/session.*(builtinRuntimeExprs, 바마다 바뀌는 진짜 런타임 값)와 달리 값 자체가
// 컴파일타임 리터럴이다 — pine2py wavealgo/builtins/syminfo.py가 DataProvider/사용자 설정 없이는
// 전부 @dataclass 기본값 그대로 고정(스크립트 실행 중 바뀔 여지가 없음)이라 math/color/order와
// 같은 컴파일타임 폴딩(builtinConstants/builtinStringConstants 재사용, 새 병렬 맵 불필요)이 정확하다.
// pine2py codegen.py IDENTIFIER_MAP(L1830-1844)이 원래 14종만 syminfo.* 전체 경로를 직결 매핑하고
// 나머지 2개 필드(country/volumetype)는 매핑이 없어 bare "syminfo" 식별자 자체가 미등록이라
// 조용히 깨진 코드(NameError)를 낸다는 것을 소스 대조로 확인(오라클 불가 — 이 두 필드는 여전히
// 제외, LIMITATIONS.md 참조). mincontract/sector/industry(C337, wild 실사용 33건)는 pine2py
// Syminfo dataclass 자체에 필드가 아예 없어 literal port 불가 — PineTS(AGPL, 시맨틱 참조만)
// docs/api-coverage/syminfo.md가 이 3종을 실제 TV 상수로 문서화(mincontract: number "Minimum
// contract size", sector/industry: string "N/A for crypto, returns \"\"")해 real TV 상수임만
// 교차확인, 값은 chart.*(C287)와 동일한 "헤드리스 배치 엔진 고정값" hand-verified 설계 —
// mincontract=1(minmove/pointvalue 기존 1.0 관례와 동일한 "1주" 기준선), sector/industry=""(회사
// 메타데이터 없음, PineTS의 "N/A" 기본값과 동일). syminfo.exchange(wild 3건)는 PineTS의 이
// 문서가 employees/shareholders/recommendations_*/target_price_* 등 훨씬 obscure한 필드까지
// 전부 커버하면서도 "exchange"는 목록에 없어(실제 TV exchange 식별자는 별도 필드 prefix가 문서화
// 자체 원문 "Exchange identifier") 진짜 TV 상수인지 근거 부족 — 이번 슬라이스에서 제외(계속
// 미착수, 웹 검증 세션에 위임). 문자열 12종 + 숫자 5종으로 값 타입이 갈려 COLOR_CONSTANTS(string)/
// MATH_CONSTANTS(number)와 동일하게 두 Map으로 분리.
// C391: current_contract/isin/main_tickerid(문자열) + shares_outstanding_float/total(숫자) 4차
// 확장 — wild "네임스페이스 접근은 호출식만 지원" 클러스터 재조사(scratch/namespace_cluster.mjs,
// C390 이후 syminfo 10건)에서 실사용 확인. C337과 동일 근거: pine2py Syminfo dataclass에 이
// 필드들 자체가 없어(mincontract/sector/industry와 동일 축) literal port 불가 — PineTS(AGPL,
// 시맨틱 참조만) docs/api-coverage/syminfo.md(Symbol Identification/Company Data 표)가 이
// 5종을 real TV 상수로 문서화해 교차확인, 값은 C337과 동일한 "헤드리스 배치 엔진 고정값"
// hand-verified 설계(current_contract/isin/main_tickerid=""(문서 "N/A for crypto"/기존
// ticker류 빈 문자열 관례와 동일), shares_outstanding_float/total=0(문서 "N/A for crypto,
// returns 0" — employees/shareholders 등 나머지 회사 데이터 필드와 동일 패턴이나 이번엔
// wild 실사용 0건이라 제외, next_hint 참조). syminfo.exchange(wild 4건, 이번 재조사에서 2건
// 추가 확인)는 C337이 이미 "그 전수 문서에도 없어 근거 부족"으로 제외 확정한 것 재확인 —
// 여전히 미착수.
// C395: syminfo.country(wild 1건) 5차 확장 — C391이 "기존 거부 테스트 flip 필요"로 보류해뒀던
// 항목. PineTS docs/api-coverage/syminfo.md 34행이 "Country code (empty for crypto)"로 real TV
// 상수임을 재확인, pine2py wavealgo/builtins/syminfo.py Syminfo dataclass에 country: str = ""
// 필드 자체는 있지만(volumetype과 동일하게 dataclass엔 존재) pine2py pine2wave/codegen.py
// IDENTIFIER_MAP에 매핑이 없어(grep 0건) bare "syminfo" 식별자가 미등록 NameError를 내는 것도
// 재확인(오라클 불가, C337/C391과 동일 급). 값은 dataclass 기본값이자 PineTS 문서 문구와 일치하는
// ""(hand-verified). volumetype은 이번에도 wild 실사용 0건이라 계속 거부 상태 유지(거부 테스트는
// country만 분리해 남김).
export const SYMINFO_STRING_PROPS: ReadonlyMap<string, string> = new Map([
  ["ticker", ""],
  ["tickerid", ""],
  ["prefix", ""],
  ["root", ""],
  ["description", ""],
  ["type", "stock"],
  ["basecurrency", "USD"],
  ["currency", "USD"],
  ["timezone", "UTC"],
  ["session", "regular"],
  ["sector", ""],
  ["industry", ""],
  ["current_contract", ""],
  ["isin", ""],
  ["main_tickerid", ""],
  ["country", ""],
]);

export const SYMINFO_NUMBER_PROPS: ReadonlyMap<string, number> = new Map([
  ["mintick", 0.01],
  ["minmove", 1.0],
  ["pointvalue", 1.0],
  ["pricescale", 100],
  ["mincontract", 1],
  ["shares_outstanding_float", 0],
  ["shares_outstanding_total", 0],
]);

// barstate.*(7종)/session.*(7종) — math.pi/color.red/order.ascending과 같은 "인자 없는 네임스페이스
// bare DotAccess" 구문이지만, 값이 컴파일타임 리터럴이 아니라 **바마다 바뀌는 런타임 값**이라
// builtinConstants류(값을 미리 계산해 리터럴로 접음)에 넣을 수 없다 — 대신 값 자체가 아니라 그
// 값을 계산하는 JS 식 문자열을 등록해두고 codegen이 그 식을 그대로 방출한다(builtinRuntimeExprs,
// 네 번째 병렬 맵). $.idx(Context, 0-based 현재 바 인덱스, C1xx)와 $.barCount(기존 getter, close.length
// 고정값)만으로 pine2py wavealgo/builtins/barstate.py·session.py의 ctx.idx/ctx.length 판정을 그대로
// 재현(오라클 실측: gen_oracle.py가 매 바 push_bar 시 index를 0,1,2,...로 순증가시켜 idx 의미가
// 정확히 동형임을 codegen 소스 대조로 확인). 백테스트 모드 전제(pine2py 주석 그대로)라 isnew/
// isconfirmed/ismarket은 항상 true, ispremarket/ispostmarket은 항상 false — 세션 인프라가 없어도
// (ta.vwap의 LIMITATIONS.md 결정과 동일 근거) 정확히 pine2py와 동치.
export const BARSTATE_PROPS: ReadonlyMap<string, string> = new Map([
  ["isfirst", "$.idx === 0"],
  ["islast", "$.idx === $.barCount - 1"],
  ["ishistory", "$.idx < $.barCount - 1"],
  ["isrealtime", "$.idx === $.barCount - 1"],
  ["isnew", "true"],
  ["isconfirmed", "true"],
  ["islastconfirmedhistory", "$.idx === $.barCount - 2"],
]);

export const SESSION_PROPS: ReadonlyMap<string, string> = new Map([
  ["ismarket", "true"],
  ["ispremarket", "false"],
  ["ispostmarket", "false"],
  ["isfirstbar", "$.idx === 0"],
  ["isfirstbar_regular", "$.idx === 0"],
  ["islastbar", "$.idx === $.barCount - 1"],
  ["islastbar_regular", "$.idx === $.barCount - 1"],
]);

// timeframe.*(9종 속성 + main_period 별칭, ROADMAP P2 "barstate/session/syminfo/timeframe" 세 번째
// (마지막) 슬라이스) — syminfo.*와 동일한 근거로 컴파일타임 리터럴: pine2py Context.timeframe이
// DataProvider/사용자 설정 없이는 항상 `Timeframe(period="D")` 고정(wavealgo/context.py L116-121,
// 오버라이드 setter는 있지만 실제로 쓰는 소비처가 없음을 소스 대조로 확인)이라 barstate/session의
// builtinRuntimeExprs(바마다 바뀌는 진짜 런타임 식)와 달리 매 바 동일한 값이다. pine2py
// wavealgo/builtins/timeframe.py Timeframe 클래스의 9개 프로퍼티(+ main_period는 period의 단순
// 별칭, codegen.py IDENTIFIER_MAP L1846-1855)를 원래 period="D" 고정값으로 직접 계산해 폴딩했다.
// **배치30 (1), C591**: 'D' 고정이 corpus_scan --exec --data=1h 실행과 불일치(0-트레이드/self-halt
// 왜곡, ROADMAP P4 배치30)해 analyze()의 `options.chartTf`(기본 "D" — 옵션 생략 시 기존 동작
// 100% 보존)로 설정화했다. 아래 세 맵은 여전히 "이 attr 이름이 timeframe.* 폴딩 대상인가"라는
// **키 존재 여부**(.has())만 쓰이는 곳에 한해 default("D" 계산값) 참조로 남겨두고, 실제 **값**을
// 접는 모든 지점(.get())은 이 밑의 timeframeStringPropValue/timeframeNumberPropValue/
// timeframeBooleanPropValue(attr, chartTf 문자열) 순수 함수로 교체했다 — 키 집합 자체는 period
// 문자열과 무관해 정적 유지가 안전하다. 문자열 2종(period/main_period) + 숫자 1종(multiplier) +
// 불리언 7종으로 세 갈래라 syminfo(문자열/숫자 두 갈래)보다 한 갈래 더 많아 order.ascending(C85)이
// 이미 만들어둔 builtinBooleanConstants(세 번째 병렬 맵)까지 재사용한다(새 병렬 맵 불필요).
export const TIMEFRAME_STRING_PROPS: ReadonlyMap<string, string> = new Map([
  ["period", "D"],
  ["main_period", "D"],
]);

export const TIMEFRAME_NUMBER_PROPS: ReadonlyMap<string, number> = new Map([["multiplier", 1]]);

export const TIMEFRAME_BOOLEAN_PROPS: ReadonlyMap<string, boolean> = new Map([
  ["isseconds", false],
  ["isminutes", false],
  ["isintraday", false],
  ["isdaily", true],
  ["isweekly", false],
  ["ismonthly", false],
  ["isdwm", true],
  // C745(배치37(1)(a) 승인 잔여, wild 3건): tick 차트(N틱 단위, 시간 무관 바 생성) 전용 속성 —
  // pine2py Timeframe 클래스에 대응 프로퍼티가 아예 없다(mintick 수 기준 차트 자체가 미구현, 시간
  // 기반 OHLCV 리플레이만 지원). 이 엔진은 tick 차트를 절대 생성할 수 없으므로 chartTf 값과 무관하게
  // 항상 상수 false로 폴딩(barstate.ispremarket=false 등과 동일한 "미구현 환경값은 상시 고정값"
  // 원칙, LIMITATIONS 재조사 판정 그대로).
  ["isticks", false],
]);

// pine2py wavealgo/builtins/timeframe.py Timeframe 클래스(multiplier/isseconds/isminutes/
// isintraday/isdaily/isweekly/ismonthly/isdwm property, python 소스 literal port)의 순수 함수화 —
// period 문자열 하나로 파생값을 계산한다. chartTf 기본값("D")에서는 위 정적 맵과 완전히 동일한
// 값을 낸다(회귀 없음), 다른 period(예: corpus_scan --data 유도값 "60")를 넘기면 그 값에 맞게
// 재계산된다.
export const DEFAULT_CHART_TF = "D";

function timeframeMultiplierOf(period: string): number {
  const m = /^\d+/.exec(period);
  return m ? Number(m[0]) : 1;
}
function timeframeIsSecondsOf(period: string): boolean {
  return period.endsWith("S");
}
function timeframeIsMinutesOf(period: string): boolean {
  return /^\d+$/.test(period);
}
function timeframeIsIntradayOf(period: string): boolean {
  return timeframeIsMinutesOf(period) || timeframeIsSecondsOf(period);
}
function timeframeIsDailyOf(period: string): boolean {
  return period === "D" || period === "1D";
}
function timeframeIsWeeklyOf(period: string): boolean {
  return period === "W" || period === "1W";
}
function timeframeIsMonthlyOf(period: string): boolean {
  return period === "M" || period === "1M";
}
function timeframeIsDwmOf(period: string): boolean {
  return timeframeIsDailyOf(period) || timeframeIsWeeklyOf(period) || timeframeIsMonthlyOf(period);
}

export function timeframeStringPropValue(attr: string, chartTf: string): string | undefined {
  return attr === "period" || attr === "main_period" ? chartTf : undefined;
}
export function timeframeNumberPropValue(attr: string, chartTf: string): number | undefined {
  return attr === "multiplier" ? timeframeMultiplierOf(chartTf) : undefined;
}
export function timeframeBooleanPropValue(attr: string, chartTf: string): boolean | undefined {
  switch (attr) {
    case "isseconds":
      return timeframeIsSecondsOf(chartTf);
    case "isminutes":
      return timeframeIsMinutesOf(chartTf);
    case "isintraday":
      return timeframeIsIntradayOf(chartTf);
    case "isdaily":
      return timeframeIsDailyOf(chartTf);
    case "isweekly":
      return timeframeIsWeeklyOf(chartTf);
    case "ismonthly":
      return timeframeIsMonthlyOf(chartTf);
    case "isdwm":
      return timeframeIsDwmOf(chartTf);
    case "isticks":
      return false;
    default:
      return undefined;
  }
}

// strategy.* 런타임 속성(C163 첫 슬라이스, C165에서 계좌 속성 추가) — barstate.*와 동일한
// builtinRuntimeExprs 패턴(바마다 바뀌는 진짜 런타임 값이라 컴파일타임 폴딩 불가).
// Context.strategy(StrategyState) 필드를 직접 읽는 JS 식으로 낮춘다. posSize는 부호 있는 값
// (>0 롱/<0 숏, C164), position_avg_price는 flat일 때 NaN(TV: na). openprofit/equity는 브로커
// 상태만으로는 못 구하고 **현재 바 close**가 필요해 순수 프로퍼티 식이 아니라 메서드 호출 식
// `$.strategy.openProfit($.close.get(0))`으로 등록한다 — builtinRuntimeExprs의 값은 임의 JS 식
// 문자열이라 barstate와 등록 메커니즘이 완전히 동일하고 식 내용만 다르다(codegen 변경 0).
// opentrades는 pine2py 프로퍼티(flat=0, 아니면 1)를 삼항식으로 그대로 폴딩. grossloss는
// pine2py와 동일하게 음수 합(DIVERGENCES #68 — TV 미검증 가설, 절댓값일 가능성 있음).
export const STRATEGY_RUNTIME_PROPS: ReadonlyMap<string, string> = new Map([
  ["position_size", "$.strategy.posSize"],
  ["position_avg_price", "$.strategy.posAvgPrice"],
  ["netprofit", "$.strategy.realizedPnl"],
  ["openprofit", "$.strategy.openProfit($.close.get(0))"],
  ["equity", "$.strategy.equity($.close.get(0))"],
  ["initial_capital", "$.strategy.initialCapital"],
  ["closedtrades", "$.strategy.closedTrades"],
  ["opentrades", "$.strategy.posSize === 0 ? 0 : 1"],
  ["wintrades", "$.strategy.winTrades"],
  ["losstrades", "$.strategy.lossTrades"],
  ["grossprofit", "$.strategy.grossProfit"],
  ["grossloss", "$.strategy.grossLoss"],
  // max_drawdown(C172) — netprofit/closedtrades와 동일한 순수 프로퍼티 식(메서드 호출 아님):
  // Context.advance()가 barFn 실행 전에 이미 매 바 갱신을 마쳐 두므로(runtime/strategy.ts
  // updateDrawdown) 여기서 close를 다시 넘길 필요가 없다 — equity/openprofit과 다른 이유.
  ["max_drawdown", "$.strategy.maxDrawdown"],
  // C331(wild 신규, next_hint(C330) 재조사) — default_qty_value는 pine2py에 대응 프로퍼티가
  // 아예 없으나(StrategyConfig.default_qty가 entry/order 내부 소비 전용, 읽기 접근자 부재) 이미
  // 존재하는 defaultQty 필드를 그대로 노출하면 되는 값 자체는 모호성이 없는 항등 매핑(TV 미검증
  // 가설 아님 — strategy(default_qty_value=N)에 넘긴 값 그대로).
  ["default_qty_value", "$.strategy.defaultQty"],
  // netprofit_percent/openprofit_percent(TV 표준 정의 — 순이익/미실현손익을 initial_capital 대비
  // %로 정규화, DIVERGENCES #68 계좌 속성 슬라이스에 이어지는 파생값이라 새 상태 불필요·순수 계산).
  // eventrades는 DIVERGENCES #68 (c)가 "TV eventrades 상당 속성은 미구현"으로 미리 지적해 둔
  // gap을 채운다 — closeAt()의 profit===0 분기(win/lossTrades 어느 쪽도 안 세던 나머지 축)에
  // evenTrades 카운터 신설.
  ["netprofit_percent", "$.strategy.realizedPnl / $.strategy.initialCapital * 100"],
  ["openprofit_percent", "$.strategy.openProfit($.close.get(0)) / $.strategy.initialCapital * 100"],
  ["eventrades", "$.strategy.evenTrades"],
  // max_drawdown_percent(C333, next_hint(C331/C332) 1순위) — max_drawdown(통화 절대값)을 그
  // 최댓값이 갱신된 시점의 peakEquity(peakEquityAtMaxDrawdown, runtime/strategy.ts updateDrawdown)
  // 대비 %로 정규화. 현재(라이브) peakEquity로 나누면 그 이후 신고점 갱신 시 과거 최대낙폭의 퍼센트가
  // 조용히 줄어들어 틀린다 — strategy.risk.max_drawdown(percent_of_equity 타입, C322)이 "지금 이
  // 순간의 낙폭율"이라는 별개 질문(라이브 peakEquity가 정답)인 것과 다른 축.
  ["max_drawdown_percent", "$.strategy.maxDrawdown / $.strategy.peakEquityAtMaxDrawdown * 100"],
  // max_contracts_held_all/long/short(C334, next_hint(C333) 1순위) — updateMaxContractsHeld()가
  // 매 바 갱신하는 순수 러닝 최댓값 프로퍼티(max_drawdown과 동일하게 메서드 호출 아님).
  ["max_contracts_held_all", "$.strategy.maxContractsHeldAll"],
  ["max_contracts_held_long", "$.strategy.maxContractsHeldLong"],
  ["max_contracts_held_short", "$.strategy.maxContractsHeldShort"],
  // avg_winning_trade/avg_losing_trade(C674, wild 신규) — pine2py에 대응 구현 전무(grep 0건)이나
  // grossProfit/grossLoss와 win/lossTrades가 이미 있어 새 런타임 상태 없이 순수 나눗셈만으로
  // 충분(0-나눗셈은 TV 관례대로 0 — 트레이드 0건일 때 na가 아니라 0을 반환하는 다른 속성들과 동형).
  ["avg_winning_trade", "$.strategy.winTrades === 0 ? 0 : $.strategy.grossProfit / $.strategy.winTrades"],
  ["avg_losing_trade", "$.strategy.lossTrades === 0 ? 0 : $.strategy.grossLoss / $.strategy.lossTrades"],
  // avg_winning_trade_percent/avg_losing_trade_percent(C674) — closeAt()이 트레이드마다 누적하는
  // sumWinProfitPercent/sumLossProfitPercent(closedTradeProfitPercent와 동일 공식)를 카운트로 나눈
  // 평균 — "각 트레이드 percent 손익의 평균"이지 "합계 손익을 initial_capital로 정규화"가 아니다
  // (TV 공식 문구 "average percentage gained by winning trades"와 정합하는 유일한 해석).
  ["avg_winning_trade_percent", "$.strategy.winTrades === 0 ? 0 : $.strategy.sumWinProfitPercent / $.strategy.winTrades"],
  ["avg_losing_trade_percent", "$.strategy.lossTrades === 0 ? 0 : $.strategy.sumLossProfitPercent / $.strategy.lossTrades"],
  // position_entry_name(C674, 오라클 검증: pine2py engine.py position_entry_name = position.entry_id,
  // types.py Position.entry_id 기본값 "") — entryId(flat=null)를 pine2py와 동일하게 빈 문자열로 치환.
  ["position_entry_name", '$.strategy.entryId ?? ""'],
  // max_runup/max_runup_percent(C674) — max_drawdown_percent와 완전히 동일한 설계(troughEquityAtMaxRunup
  // 스냅샷 분모, runtime/strategy.ts updateDrawdown() 주석 참조). TV 미검증(가설), DIVERGENCES #75.
  ["max_runup", "$.strategy.maxRunup"],
  ["max_runup_percent", "$.strategy.maxRunup / $.strategy.troughEquityAtMaxRunup * 100"],
]);

// strategy.commission.*(C288, wild 1위 클러스터 지배 서브군 — 1,023/1,034건)는 strategy()의
// commission_type= kwarg 값 전용 2단 중첩 네임스페이스 상수 — pine2py
// wavealgo/strategy/constants.py COMMISSION_PERCENT="percent"/COMMISSION_CASH_PER_ORDER=
// "cash_per_order"/COMMISSION_CASH_PER_CONTRACT="cash_per_contract" 리터럴 포트(python 소스 직접
// 확인). pine2py 엔진 자체는 이 값을 실제 커미션 계산에 쓰지만(_calc_commission) codegen이
// strategy() 선언 전체를 주석으로만 방출해 commission_type=/commission_value=를 엔진에 배선하지
// 않는 갭이 있음 — pine2js도 동일하게 순수 discard(commission 0 고정, C173 주석 참조)라 값
// 자체는 currency/format(C284)과 동일한 컴파일타임 문자열 폴딩이면 충분.
export const STRATEGY_COMMISSION_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["percent", "percent"],
  ["cash_per_order", "cash_per_order"],
  ["cash_per_contract", "cash_per_contract"],
]);

// strategy.direction.*(C309, next_hint 1순위 서브그룹 — strategy.risk.allow_entry_in의 유일한
// 인자값) — commission과 동일한 2단 중첩 컴파일타임 문자열 폴딩. pine2py에 대응 구현이 아예 없어
// (allow_entry_in 자체도 wavealgo/strategy 전체 grep 0건) 리터럴 포트 불가 — TV 공식 API로 잘 알려진
// 세 값 "all"/"long"/"short"를 그대로 문자열로 접는다(DIVERGENCES 신규 항목, "TV 미검증(가설)").
export const STRATEGY_DIRECTION_CONSTANTS: ReadonlyMap<string, string> = new Map([
  ["all", "all"],
  ["long", "long"],
  ["short", "short"],
]);

// strategy.oca.*(5건, C288 조사됨)는 이번 사이클 범위 밖 — commission과 달리 discard가
// 안전하지 않다. call-expr.ts의 strategy.entry/order kwarg 화이트리스트가 oca_name=/oca_type=을
// 의도적으로 하드 에러 처리 중인데(주석: "주문 시맨틱을 바꾸는 나머지 TV 파라미터는 파싱-후-버림이
// 조용한 오답"), OCA(One-Cancels-All)는 실제로 pine2js 런타임에 미구현이라 값을 조용히
// discard하면 그룹 내 한쪽 체결 시 반대쪽이 취소되는 TV 시맨틱이 사라져 체결 건수/P&L이 조용히
// 달라질 수 있다 — commission_type처럼 "애초에 아무 계산도 안 하는 무해한 값"이 아니다. next_hint
// 참조.

// PineScript 타입 한정자: const ⊂ simple ⊂ series (scope.py TypeQualifier 이식).
export type Qualifier = "const" | "simple" | "series";

const QUALIFIER_RANK: Record<Qualifier, number> = { const: 0, simple: 1, series: 2 };

// 두 qualifier 중 더 높은 쪽(전파 규칙: series op simple → series 등, _merge_qualifiers 이식).
function mergeQualifiers(a: Qualifier, b: Qualifier): Qualifier {
  return QUALIFIER_RANK[a] >= QUALIFIER_RANK[b] ? a : b;
}

// FuncParam.typeHint 문자열에서 명시적 qualifier 추출 ("series float" → series, "simple int" →
// simple, "float"처럼 접두어가 없으면 null — _extract_qualifier_from_hint 이식). parser.ts의
// parseFuncParam만 이 "한정자 + 타입명" 2-토큰 형태를 만들어내므로(VarDecl.typeHint는 항상 단일
// 토큰) 이 함수는 FuncParam에만 쓰인다.
function extractQualifierFromHint(hint: string | null): Qualifier | null {
  if (!hint) return null;
  const first = hint.trim().split(/\s+/)[0];
  if (first === "series") return "series";
  if (first === "simple") return "simple";
  if (first === "const") return "const";
  return null;
}

// UDF 시그니처 + 함수 내부 var/varip의 함수-상대 슬롯 배치(call-site와 무관, 함수 하나당 1벌).
// 실제 call-site별 독립 상태는 AnalyzedProgram.funcCallSlots(CallExpr -> slotBase)가 담당한다
// (GOAL.md "UDF의 var/TA 상태는 call-site별 독립(slotBase/callSiteId 전파)" — pine2py는 var 이름
// 문자열 하나로 모든 call-site가 공유하는 버그가 있음, 여기서 그 한계를 근본적으로 고친다).
export interface FuncInfo {
  name: string;
  paramNames: string[];
  requiredParamCount: number; // 마지막 기본값 없는 매개변수의 인덱스+1 (순수 위치 호출의 인자 개수 하한 —
  // C565: TV는 Python과 달리 기본값 있는 매개변수가 선두/중간에 와도 허용(wild `f(a, b=syminfo.timezone,
  // c) =>`류, 항상 전체 위치 인자로 호출). paramHasDefault로 각 인덱스가 실제 필수인지 판별.
  paramHasDefault: boolean[]; // 매개변수 인덱스 -> 기본값 존재 여부(선언 순서, requiredParamCount와 짝)
  localVarSlots: string[]; // 함수-상대 슬롯 인덱스 -> var/varip 이름 (선언 순서)
  localVarIndex: Map<string, number>;
  // 함수 본문 안 stateful 콜(TA_REGISTRY)의 함수-상대 슬롯 개수(C162, ROADMAP line 809 UDF 본문
  // 조각). localVarSlots와 정확히 같은 원리의 ta 버전: 본문 안 각 stateful 콜사이트는 0부터
  // 시작하는 함수-상대 슬롯을 받고(stateCallSlots의 inUdf:true 항목), 실제 $.taSlots 인덱스는
  // UDF 콜사이트마다 새로 할당된 베이스(funcTaBases)에 이 상대 슬롯을 더해 만든다 — GOAL.md
  // "UDF의 var/TA 상태는 call-site별 독립(slotBase/callSiteId 전파)"의 TA 절반. fnVars 풀이 아닌
  // taSlots 풀에 두는 이유: taSlots는 이미 콜사이트별 독립 state object({}) 풀이고 fnVars는
  // number 값 + undefined 미초기화 게이트 규약이라 state object와 섞이면 양쪽 규약이 다 깨진다.
  localTaSlotCount: number;
  tupleArity: number | null; // null=단일값 반환, N=마지막 문장이 N-요소 TupleExpr(튜플 반환)
  // 튜플 반환 원소별 "히스토리 슬롯에 담을 수 없는 종류" 문구(C369, tupleArity와 같은 지점에서 함께
  // 확정 — null=아직 튜플 반환 아님/미분석). top-level 튜플 디스트럭처 이름의 히스토리 타입 가드
  // (topLevelTupleElemKinds 주석 참조)가 유일한 소비처: 원소가 수치로 판별되면 그 자리는 null.
  tupleElemNonNumericKinds: (string | null)[] | null;
  // 튜플 반환 원소가 UDT 인스턴스로 확정되면 그 실제 타입명(C387, tupleElemNonNumericKinds와 같은
  // 지점에서 함께 확정 — 저건 "UDT"로 뭉뚱그린 문구만 담지만 이건 실제 타입명이 필요한 소비처
  // (analyzeTupleDestructure의 scope.udtKindHints 등록, top-level 튜플 디스트럭처 대상의 obj.field
  // 접근 지원)용). null=아직 튜플 반환 아님/미분석, 원소별 null=UDT 아님.
  tupleElemUdtTypes: (string | null)[] | null;
  // 튜플 반환 원소가 array/map 컨테이너로 확정되면 그 정확한 종류(C649, tupleElemNonNumericKinds와
  // 같은 지점에서 함께 확정) — 저건 "array/map"으로 뭉뚱그린 문구만 담을 수 있어(구조 판별
  // 두 분기가 둘을 구분 안 함) resolveContainerExprKind(array vs map을 정확히 구분해야 하는
  // method-call sugar 수신자 판별, `.size()`/`.get()` 등)의 소비처로 못 쓴다 — 원소 표현식 자체를
  // resolveContainerExprKind에 그대로 통과시켜 얻은 정확한 값을 별도 필드로 분리 보관.
  // null=아직 튜플 반환 아님/미분석, 원소별 null=array/map 아님(또는 판별 불가).
  tupleElemContainerKinds: ("array" | "map" | null)[] | null;
  // 튜플 반환 원소가 array<UDT>로 확정되면 그 원소 자신의(컨테이너가 아니라 컨테이너가 담는) UDT
  // 타입명(C650, tupleElemContainerKinds와 같은 지점에서 함께 확정 — wild `[fvgDn, fvgDnLines] =
  // fvg(-3)`류, fvg() 내부 `var fvgDrawings = array.new<box>()`를 튜플로 반환하는 관용구에서
  // fvgDn.get(i) 원소 자체의 kind를 알아야 `.field`/method-call sugar가 가능). resolveArrayElemUdtType을
  // 원소 표현식에 그대로 통과시켜 얻은 값 — null=아직 튜플 반환 아님/미분석, 원소별 null=array<UDT> 아님.
  tupleElemArrayUdtTypes: (string | null)[] | null;
  // 위와 나란한 drawing 버전(C650, arrayElemDrawingKindHints의 튜플 대응) — array<label/line/box/
  // table/linefill> 원소를 튜플로 반환하는 UDF(wild `fvg()`가 `array.new<box>()`를 반환)의 콜사이트가
  // `fvgDn.get(i).get_top()`처럼 drawing method-call sugar를 쓸 수 있으려면 원소 자신의 drawing kind가
  // 필요하다. resolveArrayElemDrawingKind를 원소 표현식에 그대로 통과시켜 얻은 값.
  tupleElemArrayDrawingKinds: (DrawingKind | null)[] | null;
  paramQualifiers: Map<string, Qualifier>; // 매개변수명 -> 한정자(명시 힌트 우선, 없으면 simple 기본)
  localVarQualifiers: Map<string, Qualifier>; // 함수 내부 var/varip 이름 -> 선언 시점 추론 한정자
  // 매개변수명 -> UDT 타입명(typeHint가 이미 등록된 UDT 타입일 때만, C124). resolveUdtObjectType이
  // scope.func를 통해 이 맵을 조회해 함수/method 본문 안에서 그 매개변수의 obj.field 읽기/쓰기를
  // 찾아낼 수 있게 한다 — method의 첫 매개변수(객체 자신)가 이 메커니즘의 필수 소비처이지만, 일반
  // UDF가 UDT 인자를 받는 경우도 동일하게 혜택을 받는다(기존엔 top-level var만 추적 대상이었던 gap).
  paramUdtTypes: Map<string, string>;
  // 매개변수명 -> array 원소 UDT 타입명(C469, paramUdtTypes의 array<UDT> 버전 — 매개변수 자신에
  // 명시 typeHint가 없어도 prepassInferParamUdtTypesFromCallSites가 콜사이트 인자로 넘어온
  // top-level array<UDT> 컨테이너 이름(arrayElemTypeByName)에서 원소 타입을 역추론해 채운다.
  // resolveArrayElemUdtType이 scope.func를 통해 이 맵을 조회한다 — `helper(levels) => ... =
  // array.get(levels, i) ... .field` 같은 무힌트 매개변수 관용구(wild 실사용)의 필수 소비처.
  paramArrayElemUdtTypes: Map<string, string>;
  // 매개변수명 -> array 원소 drawing kind(C505, paramArrayElemUdtTypes의 drawing 버전 — 매개변수
  // 자신에 명시 typeHint가 없어도 prepassInferParamUdtTypesFromCallSites가 콜사이트 인자로 넘어온
  // top-level array<label/line/box/...> 컨테이너 이름에서 원소 drawing kind를 역추론해 채운다.
  // resolveArrayElemDrawingKind가 scope.func를 통해 이 맵을 조회한다 — resolveArrayElemUdtType은
  // 이미 이 폴백(C469)을 갖췄으나 형제 함수인 drawing 버전엔 빠져 있던 비대칭(wild `flush(source) =>
  // ... source.get(i).delete()`류, 무힌트 매개변수가 array<label>/array<line> 콜사이트를 섞어 받음).
  paramArrayElemDrawingKinds: Map<string, DrawingKind>;
  // 매개변수명 -> 컨테이너 종류(array/map, UDT 원소 여부 무관, C492) — paramArrayElemUdtTypes와
  // 나란하지만 별개 축: 저건 "원소가 UDT일 때"만 채워지고 이건 원소 타입과 무관하게 매개변수
  // 자체가 array/map 인자를 받는지만 본다(wild `helper(arr) => for x in arr`류, arr이 콜사이트에서
  // 항상 top-level 순수 array/map var를 받는 경우). prepassInferParamUdtTypesFromCallSites의
  // topLevelContainerVars 축이 채운다. resolveContainerExprKind가 scope.func를 통해 조회—
  // for-in 이터러블 판별(analyzeForInStmt)의 매개변수 폴백.
  paramContainerKinds: Map<string, "array" | "map">;
  // 매개변수명 집합 -> matrix 핸들 확정(C709, paramContainerKinds의 matrix 버전 — matrix는 종류가
  // 하나뿐이라 모호성 축이 필요 없어 Set으로 충분). scanOwnParamMatrixUsage(본문 내부 canonical
  // matrix.*(param, ...) 자기참조, scanOwnParamContainerKindUsage의 matrix 판)가 채운다.
  // resolveMatrixExprKind가 scope.func를 통해 조회 — for-in 이터러블 판별(analyzeForInStmt)에서
  // matrix 콜사이트(Identifier 대신 params)로 넘어온 UDF 매개변수(`_extend(_x, _len) => for l in _x`
  // 류, _x는 matrix.rows/get/set(_x, ...)로만 종류가 드러남)의 폴백.
  paramMatrixKinds: Set<string>;
  // 매개변수명 -> drawing kind(C496, paramContainerKinds의 drawing 버전 — 매개변수 자신에 명시
  // typeHint가 없어도 prepassInferParamUdtTypesFromCallSites가 콜사이트 인자로 넘어온 UDT 필드
  // (top-level 인스턴스의 DotAccess, `f(c.line_mid1)`류)에서 drawing kind를 역추론해 채운다.
  // wild `color_lines(line_m, ...) => line_m.get_y1()`처럼 매개변수가 method-call sugar 수신자로
  // 쓰이는 형태의 필수 소비처. resolveDrawingExprKind가 scope.func를 통해 조회한다.
  paramDrawingKinds: Map<string, DrawingKind>;
  // 함수 내부 var/varip 이름 -> drawing kind(C358, paramUdtTypes와 나란한 C124 원칙의 var 축
  // 확장 -- `var box drawBox = na` 같은 func-local var는 top-level var(prog.drawingVarKinds)와
  // 달리 지금까지 어떤 참조형 판별 맵에도 등록되지 않았다). paramUdtTypes와 동일하게 스코프 체인과
  // 무관하게 함수 전체에서 조회 가능(analyzeVarDecl 선언 위치가 어느 중첩 블록이든 무관) --
  // resolveDrawingExprKind가 scope.func를 통해 조회한다.
  localVarDrawingKinds: Map<string, DrawingKind>;
  // 함수 내부 var/varip 이름 -> UDT 타입명(C392, paramUdtTypes/localVarDrawingKinds와 나란한 C124
  // 원칙의 var 축 확장 -- `var Swing s = na`처럼 func-local var가 명시 typeHint로 UDT를 선언하면
  // (초기값이 na라 생성자 콜 판별로는 못 잡음) 여기 실제 타입명을 기록한다. 지금까지
  // localVarValueKinds는 "UDT"라는 종류 문구만 담아(히스토리 슬롯 가드 전용) 실제 타입명이 필요한
  // resolveUdtObjectType 소비처(필드 읽기/쓰기, 이 함수 자신의 returnUdtType 추론)엔 재사용 불가했다
  // -- resolveUdtObjectType이 scope.func를 통해 이 맵을 조회한다.
  localVarUdtTypes: Map<string, string>;
  // func-local var 이름 -> array 원소 UDT 타입명(C638, paramArrayElemUdtTypes(C469)의 func-local var
  // 버전 — top-level var(prog.arrayElemUdtType)/'=' 로컬(scope.arrayElemUdtKindHints)/매개변수
  // (paramArrayElemUdtTypes) 셋 다 이미 있던 array<UDT> 원소 타입 추적이 func-local `var` 선언에만
  // 없던 3-way 비대칭(wild `var preValues [] valArr = array.from(preValues.new(...), ...)`가 method
  // 본문 안에 있으면 이후 `valArr.get(5).plTime`이 원소 타입을 못 찾아 거부됨). resolveArrayElemUdtType이
  // scope.func를 통해 이 맵을 조회한다.
  localVarArrayElemUdtTypes: Map<string, string>;
  // localVarArrayElemUdtTypes의 drawing 버전(C650) — top-level var(prog.arrayElemDrawingKind)/'='
  // 로컬(scope.arrayElemDrawingKindHints)/매개변수(paramArrayElemDrawingKinds) 셋 다 array<label/
  // line/box/table/linefill> 원소 kind 추적이 있는데 func-local `var` 선언에만 없던 3-way 비대칭
  // (wild `var fvgDrawings = array.new<box>()`가 튜플로 반환되는 관용구, `fvgDn.get(i).get_top()`가
  // 원소 kind를 못 찾아 거부됨 — localVarArrayElemUdtTypes와 완전히 나란한 재발현). resolveArrayElemDrawingKind가
  // scope.func를 통해 이 맵을 조회한다.
  localVarArrayElemDrawingKinds: Map<string, DrawingKind>;
  // localVarArrayElemUdtTypes/localVarArrayElemDrawingKinds의 map 버전(C684) — func-local `var`가
  // map<K, UDT>/map<K, drawing> 컨테이너를 선언하면(명시 typeHint "map<K,V>" 또는 map.new<K,V>()
  // 생성자 콜이 보존한 V, parser.ts consumeMapNewGenericValueTypeArg) 그 값 타입을 기록한다.
  // resolveMapValueUdtType/resolveMapValueDrawingKind가 scope.func를 통해 조회 — wild
  // `var aoeLevels = map.new<string, box>()`(UDF 본문 중첩 블록) 뒤 `getHighBox =
  // aoeLevels.get("High")` \ `getHighBox.get_top()` 관용구(next_hint(C683), getHighBox 축).
  localVarMapValueUdtTypes: Map<string, string>;
  localVarMapValueDrawingKinds: Map<string, DrawingKind>;
  // 이 함수/method의 반환값이 UDT 인스턴스로 확정되면 그 타입명(C253, corpus "네임스페이스 접근은
  // 호출식만 지원" 클러스터 — `sig = calcSignal()` 후 `sig.value` 패턴). 마지막 본문 문장이
  // (a) 생성자/copy 콜(isUdtConstructorCall) (b) 이미 UDT로 추적된 로컬/매개변수 Identifier
  // (c) 양쪽 분기가 같은 UDT 타입인 삼항(TernaryOp) 중 하나일 때만 채워진다 — 그 외(if/switch를
  // 암묵 반환으로 쓰는 제어문-식 형태)는 범위 밖(LIMITATIONS.md 참조)이라 null로 남는다.
  returnUdtType: string | null;
  // 이 함수/method의 반환값이 "원소 타입이 등록된 UDT인 array"로 확정되면 그 UDT 타입명(C458,
  // wild `broken_levels = check_level_breaks()` 후 `array.get(broken_levels, i).level_type` —
  // returnUdtType(단일 UDT, C253)과 나란한 배열 버전. inferFuncBodyReturnArrayElemUdtType이
  // 채운다. resolveUdtObjectType과 달리 이 필드는 constructors.ts의 isArrayConstructorCall/
  // arrayUdtConstructorElemType이 bare UDF 콜(`value.callee.kind==="Identifier"`)을 array
  // 생성자 콜과 동등하게 취급하는 유일한 소비처 — 이미 있는 두 함수에 분기만 추가해 '=' 로컬/
  // top-level var의 기존 containerKindHints/arrayElemUdtKindHints 배선을 그대로 재사용한다.
  returnArrayElemUdtType: string | null;
  // returnArrayElemUdtType과 완전히 나란한 drawing 버전(C683 — localVarArrayElemDrawingKinds(C650)가
  // 같은 함수 본문 안 지역 추적만 갖췄을 뿐, 그 함수의 반환값 자체가 이 종류로 확정되는 축은 UDT
  // 쪽(C458)에만 있던 비대칭). wild `fvgDn = fvg(-3)`(fvg()의 마지막 문장이 `var fvgDrawings =
  // array.new<box>()`를 그대로 반환) 뒤 `fvgDn.get(i).get_top()`류 — inferFuncBodyReturnArrayElemDrawingKind가
  // 채우고, constructors.ts의 arrayDrawingConstructorElemKind가 bare UDF 콜을 array 생성자 콜과
  // 동등하게 취급하는 분기에서 조회한다(returnArrayElemUdtType의 arrayUdtConstructorElemType 분기와
  // 동일한 소비 지점).
  returnArrayElemDrawingKind: DrawingKind | null;
  // 이 함수/method가 array/map 컨테이너 자체를 반환하면 그 종류(C651, wild `mean(data,weights,len)
  // .get(0)` — 마지막 문장이 `array.new<float>(...)` 생성자 콜을 직접 반환 / `getRootCodeMap()
  // .get(root)` — 마지막 문장이 func-local `var map<K,V> x = otherFunc()`의 bare Identifier 반환).
  // returnArrayElemUdtType(원소 UDT 타입)과 별개 축 — 이건 반환값 자신이 array냐 map이냐만 본다.
  // inferFuncBodyReturnContainerKind가 채우고, resolveContainerExprKind의 CallExpr 분기(bare UDF
  // 콜을 컨테이너 수신자로 직접 체이닝하는 형태)가 조회한다.
  returnContainerKind: "array" | "map" | null;
  // 이 함수/method의 반환값이 Float64Array 히스토리 슬롯에 안전하게 담을 수 있는 순수 스칼라로
  // 확정되면 true(C520, wild "히스토리 인덱스는 stateful TA 콜에만 지원" 클러스터 — UDF 콜 결과
  // f()[N] 확장). tupleArity!==null(튜플 반환)이면 즉시 false. 마지막 문장이 ExprStmt/Assignment
  // (C704)면 classifyTupleElemNonNumericKind(튜플 원소 참조형 판별기, C369)를 그 값 표현식에 재사용해
  // string/array/map/matrix/drawing/UDT를 배제하고, IfStmt/SwitchStmt(C712, genReturnIfStmt/
  // genReturnSwitchStmt와 동형 재귀 — 각 분기의 마지막 문장을 동일 판별기에 재귀 적용, else/default
  // 없는 분기는 codegen의 스칼라 NaN 폴백(C573)이 있어 안전)면 inferStmtReturnIsScalarSafe로 모든
  // 분기를 재귀 판정한다. 그 외 문장 종류(VarDecl 등)는 여전히 보수적으로 false — index-access.ts가
  // 기존 "stateful TA 콜에만 지원" 에러를 유지한다.
  returnIsScalarSafe: boolean;
  // C255: 이 함수 본문 분석이 끝났는가 — top-level FuncDecl은 이제 prepass(registerFuncSignature)가
  // 시그니처만 먼저 등록해(forward-reference 호출 지원), 본문(localVarSlots/localTaSlotCount)은
  // 그 선언의 원래 소스 위치에서만 채워진다. forward-ref 콜사이트(false일 때 발생)는 슬롯 배정을
  // analyzeUserFuncCall에서 즉시 못 하므로 prog.pendingFuncCallSlots에 미뤄 analyze() 메인 루프
  // 종료 후 일괄 배정한다(call-expr.ts resolvePendingFuncCallSlots 참조). method는 forward-ref
  // 대상이 아니라 생성 시점에 항상 true.
  bodyAnalyzed: boolean;
  // C267[part2]: 이 함수/method 본문이 (bare 또는 method 경로로) 직접 호출하는 다른 함수/method의
  // 이름(method는 mangleMethodName 결과, prog.funcs 키와 동일 네임스페이스) 집합 — analyzeUserFuncCall이
  // scope.func!==null(호출이 다른 UDF 본문 안에서 일어남)일 때마다 채운다. analyze() 메인 루프
  // 종료 후 detectRecursiveFuncCalls(call-expr.ts)가 이 그래프로 사이클(직접 자기재귀 포함, 상호
  // 재귀도 포함)을 DFS 탐지해 거부한다 — TV v5는 재귀 UDF를 지원하지 않는다(pine2py는 Python 함수로
  // 그대로 내려 재귀 자체를 막지 않지만, pine2py의 var 상태 자체가 이름 문자열 하나로 전역 공유돼
  // 있어 이 오라클로는 재귀의 올바른 상태 시맨틱을 검증할 수 없다 — MEMORY.md C9 참조. 비재귀
  // 콜그래프(DAG)만 이번 슬라이스로 지원).
  calls: Set<string>;
  // UDF 매개변수/내부 '=' 로컬/내부 var 히스토리(C364, ROADMAP 🔴🔴 (b)슬라이스): 이 함수 본문 안에서
  // 히스토리 인덱싱(x[n], n>=1)된 함수-내부 이름 -> 함수-상대 hist 슬롯 인덱스. localVarSlots/
  // localTaSlotCount와 정확히 같은 원리의 hist 버전 — 실제 $.histSlots 인덱스는 콜사이트마다 새로
  // 할당된 베이스(prog.funcHistBases)에 이 상대 슬롯을 더해 만든다(codegen `__histBase` 인자 전파,
  // GOAL.md "UDF의 var/TA 상태는 call-site별 독립"의 히스토리 절반). record 시점은 이름 종류
  // (localHistKinds)에 따라 다르다 — codegen.ts genFuncDecl/genStmt/generateCode 주석 참조.
  localHistSlots: Map<string, number>;
  // localHistSlots에 등록된 이름의 종류 — codegen의 record 방출 위치가 갈린다:
  // "param": 함수 진입 직후 1회(매개변수는 본문에서 ':=' 재대입 불가라 진입 시점 값이 곧 확정값),
  // "local": '='/':=' 대입문 직후마다(Series.record가 현재 바 커서 덮어쓰기라 마지막 대입이 승리 —
  //          top-level (a)슬라이스의 "바 확정값 기록"과 동일한 최종값 시맨틱),
  // "var":   함수 본문이 아니라 top-level 바 종료 record 루프에서 콜사이트별로($.fnVars[slotBase+i]
  //          읽기 — 호출 안 된 바에도 var 값은 변하지 않으므로 이 바-인덱스 기록이 TV per-call
  //          압축 히스토리와 정확히 일치한다, index-access.ts 주석 참조).
  localHistKinds: Map<string, "param" | "local" | "var">;
  localHistSlotCount: number;
  // ta.<fn>(...)[N] 등 CallExpr 히스토리(신규, C483, ROADMAP 🔴🔴 (b)의 CallExpr 변형): 이름이 없는
  // 콜사이트라 위 localHistSlots(문자열 키)와 나란한 별도 맵(CallExpr AST 노드 identity가 키) —
  // localHistSlotCount를 공유해 같은 __histBase 콜사이트-상대 블록 안에 함께 배정된다(그래서
  // 별도의 __histBase 인자 배선이 필요 없다, codegen.ts genBaseParams/genCallExpr 참조). record는
  // 항상 그 콜 자신의 codegen 위치에서 인라인(index-access.ts 무조건-위치 게이트 참조 — top-level
  // taCallHistorySlots와 동일 원칙, 단 UDF 안에서는 스코프가 함수 경계를 넘지 않아야 함).
  // C720: 산술식(BinOp/UnaryOp/리터럴) 히스토리(index-access.ts scope.func!==null 확장)도 이 맵을
  // 공유한다 — 키 타입을 CallExpr에서 Expr로 넓혔을 뿐, top-level taCallHistorySlots(Map<Expr,
  // number>)와 이미 동일한 카운터/배선을 쓰던 것과 정합.
  localCallHistSlots: Map<Expr, number>;
  // UDF 본문 안 조건부(if/for/while) 위치 stateful 콜 히스토리(C672, 배치34 hist-stateful UDF
  // 서브그룹): localCallHistSlots(무조건 위치, $.histSlots 바-인덱스)와 나란한 압축(call-count)
  // 버전 — top-level condCallHistorySlots(C671)와 동일한 Series.push()(호출될 때만 커서 전진)
  // 시맨틱이되, UDF 안이라 슬롯이 콜사이트별 독립이어야 해(GOAL.md "UDF의 var/TA 상태는 call-site별
  // 독립") 함수-상대 인덱스로 배정하고 실제 $.condCallHistSlots 인덱스는 콜사이트별 베이스
  // (prog.funcCondHistBases, `__condHistBase` 인자 전파)에 더해 만든다. 물리 배열이
  // $.condCallHistSlots(Context.advance() 미적용)로 분리돼 localHistSlotCount와 별도 카운터를 쓴다
  // — record류 바-종료 루프도 param 진입 record도 없다(콜 자신이 유일한 값 발생원, 항상 콜 위치
  // 인라인 push — codegen.ts genIndexAccess CallExpr 분기 참조).
  // C720: 산술식 히스토리의 조건부(if/for/while) 위치 판도 이 맵을 공유(위 localCallHistSlots와
  // 동일 근거로 Expr로 넓힘).
  localCondCallHistSlots: Map<Expr, number>;
  localCondHistSlotCount: number;
  // UDF 본문 안 조건부(if/for/while) 위치 drawing 생성자 콜(line.new 등) 압축 히스토리(C701, wild
  // "히스토리 인덱스는 stateful TA 콜에만 지원" 클러스터 UDF본문 서브그룹 — `label.delete(label.new(...)[1])`
  // 관용구가 UDF/method 본문 안에 있는 경우). localCondCallHistSlots(numeric 판)와 완전히 동형이나
  // 물리 배열이 top-level condCallRefHistorySlots(C700)와 같은 $.condCallRefHistSlots(RefSeries)로
  // 분리돼 별도 카운터를 쓴다 — 실제 인덱스는 콜사이트별 베이스(prog.funcCondRefHistBases,
  // `__condRefHistBase` 인자 전파)에 이 함수-상대 슬롯을 더해 만든다. top-level 분기(index-access.ts)와
  // 동일하게 조건부/무조건 위치 구분이 불필요하다(drawing 핸들은 렌더링 값으로 소비되지 않는 죽은
  // 채널이라 call-count 압축 인덱스 하나로 항상 정답).
  localCondCallRefHistSlots: Map<CallExpr, number>;
  localCondRefHistSlotCount: number;
  // UDF 내부 drawing 핸들 히스토리(배치25 (1) 잔여 슬라이스, C541): localHistSlots의 참조형 판 —
  // drawing 핸들 값은 Float64Array($.histSlots)에 못 담아 top-level의 refHistorySlots(RefSeries)와
  // 동일한 별도 object 원형 버퍼를 쓴다. 상대 슬롯/콜사이트별 베이스(prog.funcRefHistBases,
  // __refHistBase 인자 전파)/record 타이밍 전부 localHistSlots·localHistKinds와 동형이나 물리
  // 배열($.refHistSlots)과 카운터가 분리된다. C751: 매개변수 축도 포함 — wild `id[i]`(UDT 타입
  // 매개변수 자신의 히스토리) 실측 확인, record는 함수 진입 직후 1회(genParamHistRecords, param
  // 스칼라 히스토리 C364와 동일 타이밍).
  localRefHistSlots: Map<string, number>;
  localRefHistKinds: Map<string, "local" | "var" | "param">;
  localRefHistSlotCount: number;
  // UDF/method 매개변수(UDT)의 필드 히스토리(C750, index-access.ts scope.func 분기 — 위
  // localRefHistSlots 주석의 "매개변수 축은 범위 밖"은 매개변수 자신 전체의 히스토리 얘기이고,
  // 이건 매개변수가 가리키는 UDT 인스턴스의 필드 하나만 별도로 추적하는 별개 축이다). 키는
  // top-level udtFieldHistorySlots/udtFieldRefHistorySlots와 동일한 "매개변수이름.필드이름"
  // 문자열 — 매개변수는 본문에서 ':=' 재대입 불가라 함수 진입 시점 필드값이 곧 이 콜의 확정값
  // (genParamHistRecords의 "param" kind와 동일 원칙, 진입 직후 1회 record). 물리 배열/카운터는
  // localHistSlots·localHistSlotCount(수치)/localRefHistSlots·localRefHistSlotCount(drawing 핸들)를
  // 그대로 공유 — 별도 __base 인자 배선이 필요 없다.
  localFieldHistSlots: Map<string, number>;
  localFieldRefHistSlots: Map<string, number>;
  // 매개변수명 -> 선언된 raw typeHint("series float"/"array<int>" 등, 없으면 null) — 히스토리
  // 슬롯(Float64Array)에 못 담는 타입(string/array/map/matrix/drawing/UDT/enum) 가드를 읽기
  // 시점에 lazy 분류하기 위해 보존(C364 — prepass 시점엔 UDT/enum 등록이 미완일 수 있어 즉시
  // 분류하지 않는다).
  paramTypeHints: Map<string, string | null>;
  // 함수 내부 var 이름 -> raw typeHint 또는 초기값 구조 판별로 확정된 참조형 종류 문구(C364,
  // paramTypeHints와 동일 목적의 var 축 — 초기값 생성자 콜 판별(analyzeVarDecl)은 선언 시점에만
  // 가능해 그 결과를 종류 문구("array" 등)로 미리 접어 저장하고, typeHint는 raw로 lazy 분류).
  localVarTypeHints: Map<string, string | null>;
  localVarValueKinds: Map<string, string>;
  // 함수 본문 안(udf-body 루트든 if/for 등 중첩 블록이든, C364/C388) '=' Assignment로 새로 선언된
  // 이름 — 히스토리 대상 '=' 로컬 판별은 "스코프에서 발견됨"만으로는 부족하다(튜플 디스트럭처/for-in
  // 이름도 scope.names에 들어감 — 그 쪽은 codegen의 record 주입 지점(Assignment 문)이 없어 슬롯이
  // 영영 NaN으로 남는 조용한 오답이 되므로 하드 에러로 걸러야 함). 중첩 블록 '=' 선언도 이 Set에
  // 들어간다(C388) — genStmt의 Assignment 분기는 중첩 여부와 무관하게 항상 record를 주입하고,
  // 읽기 쪽 resolveFuncInternalRole의 조상-스코프 탐색이 "읽기 지점이 선언 스코프의 자손"을 이미
  // 구조적으로 보장해(JS let 블록 스코프 가시성과 동일 조건) 안전하다.
  eqLocalNames: Set<string>;
  // 함수 안에서 히스토리 슬롯의 대상 식별을 모호하게 만드는 '=' 재선언/섀도잉 이름(C364/C388):
  // (1) 매개변수와 동명인 '=' 재선언(entry record가 갱신 값을 놓침), (2) 같은 함수 안에서 같은
  // 이름으로 '=' 선언이 두 번째(이상) 등장(서로 다른 물리 로컬 — JS에서는 각자 독립된 let/var
  // 섀도잉이라 문제없지만, histSlot은 이름 하나만 추적해 어느 물리 로컬의 히스토리인지 모호해짐).
  // 본문 분석 종료 후 localHistSlots와 교집합이 있으면 하드 에러(analyzeFuncDecl/analyzeMethodDecl
  // 말미, checkHistShadowConflicts) — 선언/읽기 소스 순서와 무관하게 잡히도록 사후 교차 검사.
  histShadowedNames: Set<string>;
  // C714 UDF 확장(next_hint(C715)): udf-body 루트(무조건, scope.kind==="udf-body")가 아닌 중첩 블록
  // (if/for/while 등)에서 '='로 선언된 이름 중 이 함수 안 어딘가에 선언 자리가 둘 이상(형제 블록마다
  // 독립 선언, LIMITATIONS C369 "TV는 섀도우 로컬의 독립 시리즈"의 UDF 본문 판) 있는 이름 — 이
  // Set에 있으면 histSlot을 이름(func.localHistSlots)이 아니라 대입문 AST 노드로 재확인해야 한다
  // (resolveAmbiguousFuncNestedEqLocalDeclStmt, index-access.ts). 매개변수/튜플 디스트럭처와의 충돌은
  // node-keying으로 안 풀리는 진짜 충돌이라 여전히 histShadowedNames로 블랭킷 거부(단일 선언뿐인
  // 이름은 예전처럼 eqLocalNames 이름-키 축을 그대로 씀 — 이 Set엔 안 들어감).
  nestedEqLocalNames: Set<string>;
  // 위 nestedEqLocalNames 중 같은 이름이 이 함수의 udf-body 루트(무조건, func.eqLocalNames)에도
  // 있거나 중첩 선언 자리를 두 번째(이상) 가지는 경우(사후 진단 메시지 선택 전용 — 읽기 쪽 게이트는
  // resolveAmbiguousFuncNestedEqLocalDeclStmt의 조상 탐색 성공 여부만으로 이미 무모호하게 갈린다).
  nestedHistShadowedNames: Set<string>;
  // 중첩 블록 '=' 로컬 히스토리 대입문(Assignment 노드) -> 함수-상대 hist 슬롯(C714 UDF 확장,
  // localHistSlots·localCallHistSlots와 동일한 localHistSlotCount 카운터 공유 — 형제 선언마다
  // 물리적으로 다른 노드라 슬롯도 자동으로 분리돼 "독립 시리즈" 시맨틱을 보존한다).
  localAmbiguousNestedHistDeclSlots: Map<Assignment, number>;
  // 히스토리 읽기(IndexAccess) 노드 -> 위 declSlots에서 조상 탐색으로 이미 확정해둔 슬롯(codegen이
  // 노드 identity로 O(1) 조회 — declStmt를 codegen 시점에 재탐색할 필요 없음).
  localAmbiguousNestedHistReadSlots: Map<IndexAccess, number>;
  // 위 localAmbiguousNestedHistDeclSlots/ReadSlots의 drawing 핸들 판(C541 localRefHistSlots와 동일
  // 관계) — 물리 배열이 $.refHistSlots로 분리돼 localRefHistSlotCount 카운터를 공유한다. 단일
  // 선언(비-모호)도 top-level(C714)과 동형으로 이 경로로 통일되므로, 기존 C541 UDF drawing-핸들
  // '=' 로컬 지원(wild 실사용 다수 확인, corpus_scan 회귀 실측)이 이 새 메커니즘 없이는 깨진다.
  localAmbiguousNestedRefDeclSlots: Map<Assignment, number>;
  localAmbiguousNestedRefReadSlots: Map<IndexAccess, number>;
  // C535: eqLocalNames의 튜플 자매 축 — 함수 본문 안(어느 깊이든, eqLocalNames와 동일 원칙)
  // TupleDestructure('[a,b]=...') 대상으로 새로 등록된 이름. genTupleDestructure(codegen)에 record
  // 주입 지점이 있는 값 형태(값이 CallExpr인 경우만 — analyzeTupleDestructure 등록 지점 주석 참조.
  // switch/if/삼항 튜플 형제 폼은 codegen이 별도 함수라 범위 밖, 등록 자체를 안 해 기존 하드 에러 유지)만
  // 여기 들어간다.
  tupleEqLocalNames: Set<string>;
  // tupleEqLocalNames로 등록된 이름의 kind — topLevelTupleElemKinds와 동일 원칙(원소별 값 표현식이
  // 없어 선언 시점에 확정, null=Float64Array 히스토리 슬롯에 담을 수 있는 수치 안전).
  localTupleElemKinds: Map<string, string | null>;
  // '=' 로컬(top-level, C413) 또는 튜플 디스트럭처링 대상(모든 스코프, C668)이 이 함수와 같은
  // 이름을 재사용하는가(wild "이미 함수로 선언된 이름은 top-level '=' 변수로 재사용할 수 없음"
  // 42건 + get_pivot_resolution() adx() 튜플 템플릿류). pine2py 자신도 '=' 로컬 케이스를 오라클
  // 생성 시 런타임 크래시로 확인(TypeError: 'float' object is not callable — def가 매 바
  // module-level 이름을 재정의한 뒤 뒤이은 대입이 그 이름을 덮어써 이후 호출이 깨짐, 오라클 구조적
  // 불가) — 그러나 TV 자체는 call-vs-value 문법(괄호 유무)으로 두 네임스페이스를 분리해 실제로
  // 유효한 코드다(hand-verified로 지원). pine2js는 이런 로컬을 raw JS 식별자로 내리므로
  // (genIdentifier) 이 함수의 JS 선언 이름도 그대로 두면 동일하게 깨진다 — true면 codegen이
  // 이 함수의 JS 바인딩만 별도 접미사로 mangle해(funcCodegenName) 로컬의 raw 식별자와 분리한다.
  shadowedByTopLevelLocal: boolean;
  // C453: 이 함수 본문에 "request.security expression 인자가 UDF 매개변수(bare)이고 콜사이트가
  // 여러 개(전원 top-level)"인 콜이 하나라도 등록됐는가(prog.securityParamExprCalls) — true면
  // codegen이 시그니처에 `__secIdx`(이 호출이 몇 번째 콜사이트에서 왔는지, 0-based 서수)를 추가
  // 하고 각 콜사이트가 자기 서수를 전달한다(funcSecIdxArgs). __taBase/__histBase와 같은 GOAL.md
  // slotBase 패턴이지만 값이 "베이스 인덱스"가 아니라 "서수"인 이유: 슬롯 블록이 body 콜 단위로
  // 연속 배정되므로(base_k + 서수) 함수당 서수 하나로 body의 모든 해당 콜을 커버할 수 있다.
  hasSecParamCalls: boolean;
}

// "왜 depth가 늘었는가" 태그(C64, ROADMAP P2 조건부 stateful call 항목). stateful 콜(ta.*/fixnan)
// 허용 여부는 이 태그 체인으로 판정한다 — TV v5의 실제 시맨틱은 "호출된 바에서만 상태가 전진"
// (per-call)이고 pine2js의 슬롯+state 모델이 원래 per-call 전진이라, 문장 레벨 조건부 실행(if 분기
// 본문/switch case 본문)은 거부를 풀기만 하면 TV/pine2py와 동형이다(oracle/cases/cond_if_ta.pine +
// cond_switch_ta.pine으로 수치 확정, C65). switch case 본문도 cond-body로 태그한다 — pine2py가
// switch를 if/elif 체인으로 트랜스파일(codegen.py _gen_switch)해 if 분기 본문과 동형이기 때문.
// lazy-expr(삼항 분기/and·or 우변)도 C66부터 허용한다: TV v5는 양쪽을 모두 평가(C24)하므로 JS
// 단락 평가(?:/&&/||)로 그대로 내리면 갈리지만, codegen이 lazy 위치 아래의 stateful 콜을 문장
// 직전 `let __lazyN = ...` 임시변수로 eager 호이스팅해(codegen.ts hoistLazyStatefulCalls) "문장이
// 실행되는 바마다 무조건 1회 호출"을 복원한다 — 거부 판정에서는 cond-body와 동일 취급(체인에
// condition/loop-body/udf-body가 섞이면 여전히 그쪽에서 거부됨). 단 pine2py는 삼항/and·or를
// Python lazy 구문(`A if c else B`/`and`/`or`)으로 내리므로 조건이 변하는 시나리오는 오라클 검증
// 불가 — hand-verified로 대체(DIVERGENCES.md #12, C14 'var + 제어문-식' 오라클 무효와 같은 패턴).
// loop-body(for/while 본문)도 C161부터 허용한다: per-call 전진 모델에서 루프 안 콜은 "반복마다
// 같은 콜사이트 상태가 1회씩 전진"이며, pine2py도 루프를 Python for/while로 직결 트랜스파일 +
// state_key가 codegen 시점 정적 콜사이트 카운터(_taN)라 정확히 동형이다(oracle/cases/
// cond_loop_ta.pine 골든으로 수치 확정 — 단 pine2py 구현이 call-fed인 TA(ema류)에서만 오라클
// 일치가 보장된다는 DIVERGENCES #11 일반화는 루프에도 그대로 적용). TV 실측은 미검증 가설
// (DIVERGENCES.md — VERIFIED_SEMANTICS의 조건부 per-call CONFIRMED를 루프에 외삽).
// 루프 변수는 반복마다 값이 바뀌므로 qualifier를 'series'로 태그해 ta.* length 인자 오용
// (`ta.sma(close, i)` — 고정폭 상태가 조용히 깨짐)을 기존 length series 하드 에러로 차단한다
// (analyzeForStmt 참조).
// udf-body(UDF/method 본문)도 C162부터 허용한다: 본문 안 stateful 콜은 함수-상대 슬롯
// (FuncInfo.localTaSlotCount)을 받고, UDF 콜사이트마다 taSlots 베이스(funcTaBases)가 새로
// 배정돼 codegen이 `__taBase` 인자로 전파한다 — fnVars의 slotBase 메커니즘과 정확히 동형으로,
// GOAL.md "UDF의 var/TA 상태는 call-site별 독립"의 TA 절반이 완성된다. 상태 전진 자체는 다른
// 허용 위치와 동일한 per-call 모델(호출된 바/반복에서만 그 콜사이트 상태가 1회 전진). pine2py는
// UDF 본문 안 ta 콜도 정적 _taN 하나라 서로 다른 콜사이트가 상태를 공유(UDF var 이름-공유 버그와
// 동형, codegen.py _inject_stateful_kwargs의 _ta_call_counter 소스 재확인 C161/C162) — 단일
// 콜사이트는 오라클 유효(oracle/cases/cond_udf_ta.pine), 다중 콜사이트는 오라클 무효라
// hand-verified로 검증(DIVERGENCES.md #65).
// 나머지 위치는 여전히 거부(condition, C246부터 최초 if 조건은 제외 — analyzeIfStmt 참조):
// - condition: elif 조건·while 조건·switch case 값 — 진짜 short-circuit/반복 체인이라 평가
//   여부·횟수가 앞선 분기 매치 여부(elif/case) 또는 매 반복(while)에 달려 있어, 문장 직전
//   eager 호이스팅 프리루드로는 "매치하면 평가 안 함"/"반복마다 재평가"를 복원할 수 없다(별개
//   조사 필요, 범위 밖 확정 — 하위 comment 참조). 최초 if 조건은 이 문제가 없다(형제 분기 매치
//   여부와 무관하게 무조건 1회 평가)는 것을 C246이 확인해 kind:"condition" 대상에서 제외했다.
export type ScopePushKind = "cond-body" | "condition" | "loop-body" | "lazy-expr" | "udf-body";

// 블록 스코프 체인. kind는 이 스코프가 왜 만들어졌는지(위 ScopePushKind 주석), 루트만 null.
// stateful 콜은 체인상 모든 스코프가 cond-body(if 분기/switch case 본문), lazy-expr(삼항/
// and·or lazy 위치 — codegen eager 호이스팅 전제, C66), loop-body(for/while 본문 — per-call
// 전진, C161)일 때만 허용한다(firstForbiddenKind).
// inLoop은 while/for 본문 안에서만 true로 켜지고 하위 블록(if 등)에 그대로 상속된다 —
// break/continue가 실제로 반복문 안에 있는지 검증하는 데 쓴다.
// func는 UDF 본문 스코프 진입 시에만 새 FuncInfo로 설정되고 그 하위 모든 블록에 상속된다(널이면
// 스크립트 top-level) — UDF 본문의 최상위도 pushScope(kind:"udf-body")로 한 단계 들어가며,
// C162부터 stateful 콜은 이 func(FuncInfo)에 함수-상대 ta 슬롯을 등록한다(analyzeStatefulCall이
// scope.func로 "지금 UDF 본문 안인가"를 판정 — ScopePushKind 주석 참조).
export interface LexScope {
  parent: LexScope | null;
  depth: number;
  kind: ScopePushKind | null;
  names: Set<string>;
  qualifiers: Map<string, Qualifier>; // '=' 로컬 전용(names와 나란히, 같은 스코프 레벨에서만 채움)
  // for 루프 카운터 변수 전용(현재는) 컴파일타임 int/float 힌트, qualifiers와 나란한 별도 체인
  // (isStaticIntExpr 전용 — C201, str.tostring int/float 갭 수정). '=' 로컬/UDF 매개변수는
  // 의도적으로 미기입(과욕 금지, LIMITATIONS.md 잔여 스코프 참조) — 이 맵에 없으면 항상 "모른다"로
  // 보수 처리.
  numTypeHints: Map<string, NumType>;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — 과욕 금지 원칙은 numTypeHints와 동일)이 array/map
  // 생성자 콜을 대입받으면 여기 기록(C216, for-in 루프 이터러블 종류 정적 판별 전용 — qualifiers/
  // numTypeHints와 나란한 체인 조회). prog.arrayVars/mapVars는 top-level `var` 선언만 추적해
  // (analyzeVarDecl 주석 참조) '=' 로컬 이터러블(corpus 실측 다수)을 못 잡는다 — 그 갭을 메우는
  // 스코프 체인 전용 맵. 소비처는 resolveContainerExprKind 하나뿐(C216 for-in + C222 method-call
  // 스타일 콜 수신자 판별, 둘 다 동일한 "이 Identifier가 정적으로 array/map인가" 질문이라 같은
  // 조회를 공유) — 이 둘 외의 다른 기능(히스토리 차단 등)에 재사용하지 말 것(그건 여전히 top-level
  // var 전용 arrayVars/mapVars의 몫).
  containerKindHints: Map<string, "array" | "map">;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — containerKindHints와 동일한 과욕 금지 원칙)이
  // `TypeName.new(...)` UDT 생성자 콜을 대입받으면 여기 기록(C224, containerKindHints의 UDT
  // 버전 — resolveUdtObjectType(index-access.ts)이 prog.udtVarTypes(top-level `var` 전용) 조회
  // 전에 이 스코프 체인부터 확인한다). '=' 로컬로 담긴 UDT 인스턴스가 "네임스페이스 접근은
  // 호출식만 지원"/"UDT 인스턴스로 추적되지 않음" 에러로 거부되던 기존 갭(array/map의 C216 이전
  // 상태와 동일 클래스)을 메운다.
  udtKindHints: Map<string, string>;
  // '=' 로컬(top-level 포함, UDF 로컬 포함 — udtKindHints와 동일한 스코프 체인 전역 메커니즘, C224)이
  // array<UDT> 컨테이너를 대입받으면(명시 typeHint "array<등록된 UDT명>" 또는 `array.new<UDT>()`
  // 생성자 콜) 그 원소 타입을 기록한다(C393, arrayElemUdtType의 '=' 로컬 버전 — prog.arrayElemUdtType은
  // top-level `var` 전용이라(analyzeVarDecl 주석) '=' 로컬 컨테이너의 원소 타입은 resolveArrayElemUdtType이
  // 여전히 못 찾던 기존 갭, wild `arr = array.new<Pattern>()` 후 `c = array.get(arr,i)` \ `c.field`
  // 관용구). 소비처는 resolveArrayElemUdtType 하나뿐(containerKindHints와 마찬가지로 "array"라는
  // 사실을 넘어 "원소가 무슨 UDT인가"까지 답해야 하는 이 질문 전용).
  arrayElemUdtKindHints: Map<string, string>;
  // '=' 로컬(top-level 포함, UDF 로컬 포함 — arrayElemUdtKindHints와 동일한 스코프 체인 전역
  // 메커니즘)이 array<label/line/box/table/linefill> 컨테이너를 대입받으면(명시 typeHint
  // "array<등록된 drawing 이름>" 또는 array.new_box() 등 typed/제네릭 생성자 콜) 그 원소 drawing
  // kind를 기록한다(C620, arrayElemUdtKindHints의 drawing 버전 — prog.arrayElemDrawingKind는
  // top-level `var` 전용이라(analyzeVarDecl 주석) '=' 로컬 컨테이너의 원소 kind는
  // resolveArrayElemDrawingKind가 여전히 못 찾던 기존 갭, wild `array<box> b_oxes = internal ?
  // internalOrderBlocksBoxes : swingOrderBlocksBoxes` \ `box b_ox = b_oxes.get(index)` \
  // `b_ox.set_top_left_point(...)` 관용구, C619 발견). 소비처는 resolveArrayElemDrawingKind 하나뿐.
  arrayElemDrawingKindHints: Map<string, DrawingKind>;
  // arrayElemUdtKindHints/arrayElemDrawingKindHints의 map 버전(C684) — '=' 로컬(top-level 포함,
  // UDF 로컬 포함)이 map<K, UDT>/map<K, drawing> 컨테이너를 대입받으면(명시 typeHint "map<K,V>"
  // 또는 map.new<K,V>() 생성자 콜이 보존한 V) 그 값 타입을 기록한다. 소비처는
  // resolveMapValueUdtType/resolveMapValueDrawingKind 각 하나뿐.
  mapValueUdtKindHints: Map<string, string>;
  mapValueDrawingKindHints: Map<string, DrawingKind>;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — containerKindHints/udtKindHints와 동일한 과욕
  // 금지 원칙)이 label/line/box/table/polyline 생성자(new, label/line/box는 copy도)를 대입받으면
  // 여기 기록(C232, method-call 스타일 drawing 콜 `lbl.set_text(x)` == `label.set_text(lbl, x)`
  // 수신자 판별 전용 — resolveContainerExprKind/resolveUdtObjectType과 동일하게 array/map/UDT엔
  // 있는 top-level `var` 전용 대응 Set을 두지 않는다: corpus 실측(scratch/cluster_unsupported_call.mjs)
  // 전수가 '=' 로컬뿐이라 이 스코프 체인만으로 충분).
  drawingKindHints: Map<string, DrawingKind>;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — drawingKindHints와 동일한 과욕 금지 원칙)이
  // enum 인스턴스를 대입받으면 여기 기록(C677, drawingKindHints의 enum 버전 — method-call sugar
  // 수신자 판별 전용 `openTimeframeInput1.param()`). wild 실측 전량이 top-level '=' 로컬뿐이라
  // (057b3f316bf9.pine 등, 배치34 'UDT첫매개변수' 잔여 5건) 이 스코프 체인만으로 충분 — top-level
  // `var` 전용 대응은 prog.enumVarTypes.
  enumKindHints: Map<string, string>;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — 위 세 힌트 맵과 동일한 과욕 금지 원칙)이
  // matrix.new/copy/concat/submatrix/reshape/diff/transpose/inv/pow/kron/pinv/eigenvectors
  // (MATRIX_CONSTRUCTOR_METHODS) 콜을 대입받으면 여기 기록(C237, method-call 스타일 matrix 콜
  // `m.det()` == `matrix.det(m)` 수신자 판별 전용). drawingKindHints와 달리 matrix는 kind가
  // 하나뿐이라 값 타입 Map이 아니라 Set으로 충분 — top-level `var` 전용 대응은 이미 존재하는
  // prog.matrixVars를 그대로 재사용(resolveMatrixExprKind 참조, 새 prog 필드 불필요).
  matrixKindHints: Set<string>;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — matrixKindHints와 동일한 과욕 금지 원칙)이
  // `matrix.new<UDT>(...)` 리터럴 생성자 콜을 대입받으면 그 원소 UDT 타입명을 기록한다(C638,
  // arrayElemUdtKindHints의 matrix 버전 — prog.matrixElemUdtType은 top-level `var` 전용이라
  // (matrixUdtConstructorElemType 주석 참조) '=' 로컬 matrix 컨테이너의 원소 타입은
  // resolveMatrixValueUdtType이 여전히 못 찾던 기존 갭, wild `symbolMat = matrix.new<values>(2, 40)`
  // 후 `symbolMat.get(0, i).symbolData` 관용구). '=' 로컬/copy 상속 경로는 array 쪽도 wild 근거가
  // 옅어 matrixUdtConstructorElemType 자신이 아직 리터럴 `matrix.new<T>()` 콜 하나만 인식한다 — 이
  // 맵도 그 범위만 반영.
  matrixElemUdtKindHints: Map<string, string>;
  // '=' 로컬(top-level 포함, UDF 로컬은 미기입 — 위 네 힌트 맵과 동일한 과욕 금지 원칙)이 순수
  // 구문상 문자열식(isStringExpr — StringLiteral 또는 '+' 문자열 병합)을 대입받으면 여기 기록
  // (C363, ROADMAP P4 "wild 최우선 [hard]: 로컬 히스토리" (a)슬라이스 전용 — top-level '=' 로컬
  // 히스토리 슬롯이 Float64Array 기반이라 문자열을 담을 수 없다는 var 히스토리의 string 가드
  // (varTypeHints==="string")를 '=' 로컬에 미러링한 것. '=' 로컬은 Assignment AST에 typeHint
  // 필드 자체가 없어(C355) 선언 힌트 대신 순수 구문 판별로 근사 — 식별자 기반 문자열 추론(예:
  // `s = otherStringVar`)은 isStringExpr 자체가 의도적으로 커버하지 않아 여전히 통과할 수 있는
  // 잔여 갭(LIMITATIONS.md 참조, 과욕 금지 원칙).
  stringLocalHints: Set<string>;
  // 이 스코프 객체(블록) 자신이 직접 선언한 중첩 top-level '=' 로컬(depth>0, C450) 이름 -> 그 대입
  // 문 노드(C714, AnalyzedProgram.ambiguousNestedHistDeclSlots 주석 참조). 조상 스코프에서 물려받은
  // 것이 아니라 "이 스코프가 직접" 선언한 것만 담아야 형제 블록(서로의 조상이 아님)이 같은 이름을
  // 써도 절대 섞이지 않는다 — names(단순 존재 여부)와 달리 어느 대입문인지까지 구분해야 하는 질문
  // 전용. C748부터 TupleDestructure 대상도 같은 맵을 공유(값 타입 확장) — 히스토리 인덱싱 관점에서
  // "이 이름이 이 스코프에서 직접 선언됐다"는 사실 자체는 '='든 튜플이든 동일한 node-keying 원칙이라
  // resolveAmbiguousNestedEqLocalDeclStmt(조상 탐색)를 그대로 재사용할 수 있다 — 원소별 kind만
  // AnalyzedProgram.nestedTupleElemKinds(별도 맵, 이름별 값 표현식이 없어 노드+인덱스로 저장)에서
  // 갈라 조회한다(index-access.ts declStmt.kind 분기 참조).
  nestedEqLocalDeclStmts: Map<string, Assignment | TupleDestructure>;
  // nestedEqLocalDeclStmts의 var 버전(C728, 배치37 (2) 블록-스코프 변수 슬롯 추적 첫 슬라이스 —
  // "중복 var 선언" 오탐 클러스터: 서로소 형제 블록(if A/if not A 등)에 같은 이름의 var가 각각
  // 선언되면 물리적으로 별개 슬롯인데 기존 prog.varIndex는 이름 하나당 슬롯 하나뿐인 평면 맵이라
  // 진짜 충돌로 오판했다. '=' 로컬과 동일하게 "이 스코프가 직접" 선언한 var만 담아 형제 블록끼리
  // 절대 섞이지 않게 한다 — func===null(script top-level) 전용, func-local var 중첩(C679(c))은
  // 별도 축(미착수, ROADMAP 참조).
  nestedVarDeclStmts: Map<string, VarDecl>;
  // nestedEqLocalDeclStmts/nestedVarDeclStmts의 튜플 디스트럭처 대상 판(C745, 배치37(1)(a) 승인
  // 잔여): `var x = ...` 를 조상 스코프에서 이미 선언한 이름을 이 스코프(depth>0)의 TupleDestructure
  // 대상으로 재사용하는 wild 관용구(`if init\n [activeAnchorEnabled, ...] = f()`류, 8건) — 이 이름은
  // 히스토리 슬롯 배정이 필요 없어(하단 미지원 유지, LIMITATIONS "(i-b)") 노드 키잉 없이 이름만
  // 담는다. resolveNestedVarOrEqLocalKind가 eq-local과 동일하게 "var 슬롯 조회를 건너뛰고 이 스코프의
  // plain 로컬을 쓴다"로 취급하도록 이 Set만 있으면 충분(eq-local variant 자체가 노드 payload 없음).
  nestedTupleLocalNames: Set<string>;
  inLoop: boolean;
  func: FuncInfo | null;
}

function pushScope(
  parent: LexScope,
  kind: ScopePushKind,
  inLoop: boolean = parent.inLoop,
  func: FuncInfo | null = parent.func,
): LexScope {
  return {
    parent,
    depth: parent.depth + 1,
    kind,
    names: new Set(),
    qualifiers: new Map(),
    numTypeHints: new Map(),
    containerKindHints: new Map(),
    udtKindHints: new Map(),
    arrayElemUdtKindHints: new Map(),
    arrayElemDrawingKindHints: new Map(),
    mapValueUdtKindHints: new Map(),
    mapValueDrawingKindHints: new Map(),
    drawingKindHints: new Map(),
    enumKindHints: new Map(),
    matrixKindHints: new Set(),
    matrixElemUdtKindHints: new Map(),
    stringLocalHints: new Set(),
    nestedEqLocalDeclStmts: new Map(),
    nestedVarDeclStmts: new Map(),
    nestedTupleLocalNames: new Set(),
    inLoop,
    func,
  };
}

// stateful 콜(ta.*/fixnan) 거부 판정에 쓰는 firstForbiddenKind/FORBIDDEN_KIND_DESC는
// analyzer/ta.ts로 이전(analyzeStatefulCall과 나란히 이동 — analyzer.ts 파일 분할 두 번째 슬라이스).

function scopeHasLocal(scope: LexScope, name: string): boolean {
  let s: LexScope | null = scope;
  while (s) {
    if (s.names.has(name)) return true;
    s = s.parent;
  }
  return false;
}

// scope 체인을 타고 중첩 top-level var 선언을 찾는다(C728, LexScope.nestedVarDeclStmts 주석 —
// index-access.ts resolveAmbiguousNestedEqLocalDeclStmt의 var 버전과 동일 원칙: 각 스코프가
// "직접" 선언한 var만 담기므로 형제 블록은 서로의 조상이 아니라 항상 무모호). func 경계를 넘지
// 않는다(s.func===null인 동안만 거슬러 오름) — func-local var 중첩은 범위 밖.
export function resolveAmbiguousNestedVarDeclStmt(scope: LexScope, name: string): VarDecl | null {
  let s: LexScope | null = scope;
  while (s !== null && s.func === null) {
    const stmt = s.nestedVarDeclStmts.get(name);
    if (stmt !== undefined) return stmt;
    s = s.parent;
  }
  return null;
}

export type NestedVarOrEqLocalKind = { kind: "var"; decl: VarDecl } | { kind: "eq-local" };

// resolveAmbiguousNestedVarDeclStmt의 확장판(C729, 배치37(2) 2차 슬라이스) — 같은 조상-스코프 walk
// 한 번으로 var 선언과 '=' 로컬 선언(nestedEqLocalDeclStmts, C450/C714) 중 어느 쪽이 읽기/재대입
// 지점에 더 가까운지(scope 자신부터 시작해 먼저 만나는 쪽이 항상 승리) 판별한다. 두 종류가 같은
// 스코프에 공존할 수 없으므로(형제 충돌 검사가 이미 별도로 막음) 이 순서 검사만으로 무모호 —
// 이름이 var로 시작해도 그 var의 선언 스코프보다 얕은 자손 스코프에 '=' 섀도가 있으면 그 섀도가
// 이긴다(TV가 '='를 항상 현재 스코프의 새 선언으로 컴파일하는 규칙과 일치, analyzeAssignment
// C679(a)/이번 슬라이스 주석 참조). func 경계는 넘지 않는다(원본과 동일 제약).
export function resolveNestedVarOrEqLocalKind(scope: LexScope, name: string): NestedVarOrEqLocalKind | null {
  let s: LexScope | null = scope;
  while (s !== null && s.func === null) {
    const varStmt = s.nestedVarDeclStmts.get(name);
    if (varStmt !== undefined) return { kind: "var", decl: varStmt };
    // C745: 튜플 디스트럭처 대상(nestedTupleLocalNames)도 eq-local과 동일하게 "var 슬롯 조회를
    // 건너뛰는 plain 로컬"로 취급 — 노드 payload가 필요 없어(히스토리 인덱싱 미지원 유지) eq-local
    // variant를 그대로 재사용한다.
    if (s.nestedEqLocalDeclStmts.has(name) || s.nestedTupleLocalNames.has(name)) return { kind: "eq-local" };
    s = s.parent;
  }
  return null;
}

// scope 체인을 타고 '=' 로컬의 한정자를 조회(pine2py ScopeManager.resolve와 동일한 체인 탐색).
function resolveLocalQualifier(scope: LexScope, name: string): Qualifier | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const q = s.qualifiers.get(name);
    if (q !== undefined) return q;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalQualifier와 동일한 체인 탐색을 numTypeHints에 적용(isStaticIntExpr 전용, C201).
function resolveLocalNumType(scope: LexScope, name: string): NumType | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.numTypeHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalQualifier와 동일한 체인 탐색을 containerKindHints에 적용(for-in 이터러블 판별
// 전용, C216).
function resolveLocalContainerKind(scope: LexScope, name: string): "array" | "map" | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const k = s.containerKindHints.get(name);
    if (k !== undefined) return k;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalContainerKind와 동일한 체인 탐색을 arrayElemUdtKindHints에 적용(C393,
// resolveArrayElemUdtType 전용).
function resolveLocalArrayElemUdtKind(scope: LexScope, name: string): string | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.arrayElemUdtKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalArrayElemUdtKind와 완전히 동일한 체인 탐색을 matrixElemUdtKindHints에 적용
// (C638, resolveMatrixValueUdtType 전용).
function resolveLocalMatrixElemUdtKind(scope: LexScope, name: string): string | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.matrixElemUdtKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalArrayElemUdtKind와 완전히 동일한 체인 탐색을 arrayElemDrawingKindHints에 적용
// (C620, resolveArrayElemDrawingKind 전용).
function resolveLocalArrayElemDrawingKind(scope: LexScope, name: string): DrawingKind | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.arrayElemDrawingKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalArrayElemUdtKind와 완전히 동일한 체인 탐색을 mapValueUdtKindHints에 적용
// (C684, resolveMapValueUdtType 전용).
function resolveLocalMapValueUdtKind(scope: LexScope, name: string): string | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.mapValueUdtKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// resolveLocalArrayElemDrawingKind와 완전히 동일한 체인 탐색을 mapValueDrawingKindHints에 적용
// (C684, resolveMapValueDrawingKind 전용).
function resolveLocalMapValueDrawingKind(scope: LexScope, name: string): DrawingKind | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.mapValueDrawingKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// 표현식의 타입 한정자 추론(pine2py analyzer.py의 _infer_qualifier 이식). 순수 구조적 재귀라
// analyzeExpr의 스코프/식별자 검증과 독립적으로 어느 시점에서든 호출 가능하다.
export function inferQualifier(expr: Expr, prog: AnalyzedProgram, scope: LexScope): Qualifier {
  switch (expr.kind) {
    case "NumberLiteral":
    case "StringLiteral":
    case "BoolLiteral":
    case "NaLiteral":
    case "ColorLiteral":
      return "const";
    case "Identifier": {
      const name = expr.name;
      if (
        BAR_SERIES_NAMES.has(name) ||
        DERIVED_PRICE_NAMES.has(name) ||
        name === BAR_INDEX_NAME ||
        TIME_VAR_NAMES.has(name) ||
        BID_ASK_NAMES.has(name)
      )
        return "series";
      const localQ = resolveLocalQualifier(scope, name);
      if (localQ !== undefined) return localQ;
      const func = scope.func;
      if (func) {
        const paramQ = func.paramQualifiers.get(name);
        if (paramQ !== undefined) return paramQ;
        const localVarQ = func.localVarQualifiers.get(name);
        if (localVarQ !== undefined) return localVarQ;
      }
      const topQ = prog.varQualifiers.get(name);
      if (topQ !== undefined) return topQ;
      // 미선언 식별자는 이미 analyzeExpr가 별도로 에러를 낸다 — 여기선 보수적으로 series
      return "series";
    }
    case "UnaryOp":
      return inferQualifier(expr.operand, prog, scope);
    case "BinOp":
      return mergeQualifiers(inferQualifier(expr.left, prog, scope), inferQualifier(expr.right, prog, scope));
    case "TernaryOp": {
      const branchQ = mergeQualifiers(
        inferQualifier(expr.trueExpr, prog, scope),
        inferQualifier(expr.falseExpr, prog, scope),
      );
      return mergeQualifiers(inferQualifier(expr.condition, prog, scope), branchQ);
    }
    case "IndexAccess":
      // close[1] 등 히스토리 참조는 항상 series(_infer_qualifier의 IndexAccess 분기와 동일).
      return "series";
    case "TupleExpr": {
      let q: Qualifier = "const";
      for (const el of expr.elements) q = mergeQualifiers(q, inferQualifier(el, prog, scope));
      return q;
    }
    case "CallExpr": {
      const { callee } = expr;
      if (callee.kind === "DotAccess" && callee.obj.kind === "Identifier") {
        const namespace = callee.obj.name;
        if (namespace === "ta" || namespace === "request") return "series";
        if (namespace === "input" || namespace === "syminfo") return "simple";
      }
      // math.*/사용자 UDF 등 그 외 전부 — 인자 한정자를 병합해 전파(_propagate_args_qualifier 이식).
      let q: Qualifier = "const";
      for (const arg of expr.args) q = mergeQualifiers(q, inferQualifier(arg, prog, scope));
      return q;
    }
    case "DotAccess":
      // math.pi/e/phi/rphi(C72) — 컴파일타임에 접히는 리터럴 상수라 NumberLiteral과 동치인 const.
      // 구조적으로만 판별(prog.builtinConstants 등록 여부에 의존하지 않음 — 이 함수는 순수 구조적
      // 재귀라 analyzeExpr 실행 순서와 무관하게 어느 시점에서든 호출 가능해야 한다는 상단 주석의
      // 전제를 지킨다). 그 외 단독 DotAccess는 analyzeExpr가 별도 에러로 거부하는 위치 — 안전한 기본값.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "math" && MATH_CONSTANTS.has(expr.attr)) {
        return "const";
      }
      // dayofweek.sunday~saturday(C497) — math 상수와 동일한 구조적 판별(prog.builtinConstants 등록
      // 여부에 의존하지 않음).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "dayofweek" && DAYOFWEEK_CONSTANTS.has(expr.attr)) {
        return "const";
      }
      // color.* 상수 17종(C78) — math 상수와 동일한 구조적 판별(prog.builtinStringConstants 등록
      // 여부에 의존하지 않음, 위 math 분기와 동일 원칙).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "color" && COLOR_CONSTANTS.has(expr.attr)) {
        return "const";
      }
      // order.ascending/descending(C85) — math/color 상수와 동일한 구조적 판별(prog.
      // builtinBooleanConstants 등록 여부에 의존하지 않음).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "order" && ORDER_CONSTANTS.has(expr.attr)) {
        return "const";
      }
      // barmerge.gaps_on/gaps_off/lookahead_on/lookahead_off(C177) — order.ascending/descending과
      // 동일한 구조적 판별(prog.builtinBooleanConstants 등록 여부에 의존하지 않음).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "barmerge" && BARMERGE_CONSTANTS.has(expr.attr)) {
        return "const";
      }
      // chart.*(C287) 바-불변 3갈래(색상 2종/left_visible_bar_index/is_* 7종)는 컴파일타임에
      // 접히는 고정값이라 syminfo와 동일한 "simple"(환경값이지 리터럴 동급 const는 아님) —
      // left/right_visible_bar_time(CHART_RUNTIME_PROPS)은 여기 안 걸리고 아래 fallthrough
      // "series"로 떨어진다(런타임 데이터 의존값이라 barstate와 동일 분류, 실행 중엔 불변이지만
      // 유일한 소비처(ta length 하드 에러)에서 보수적인 쪽). 구조적 판별(등록 여부 비의존) 원칙 동일.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "chart" &&
        (CHART_COLOR_CONSTANTS.has(expr.attr) || CHART_NUMBER_CONSTANTS.has(expr.attr) ||
          CHART_IS_BOOLEAN_PROPS.has(expr.attr))) {
        return "simple";
      }
      // syminfo.*(14종) — pine2py `_infer_qualifier`가 SIMPLE_NAMESPACES({"input", "syminfo"})로
      // 명시 분류(scope.py TypeQualifier.SIMPLE, "바-불변"), math/color/order의 CONST와는 다른
      // 등급이다(값은 컴파일타임 상수라도 "리터럴과 동일"까지는 아니라는 pine2py 자신의 구분 —
      // literal port). 유일한 소비처(ta.sma 등 length series 하드 에러)는 const/simple 둘 다
      // series가 아니므로 통과라 실질 동작 차이는 없다.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "syminfo" &&
        (SYMINFO_STRING_PROPS.has(expr.attr) || SYMINFO_NUMBER_PROPS.has(expr.attr))) {
        return "simple";
      }
      // timeframe.*(9종+main_period) — pine2py `_infer_qualifier`는 SIMPLE_NAMESPACES에 "timeframe"을
      // 명시하지 않지만(syminfo와 달리), 미등록 네임스페이스는 UNKNOWN으로 떨어지고 pine2js의 C16
      // 결정(UNKNOWN을 SIMPLE과 동치로 병합)에 의해 결과적으로 syminfo와 동일한 "simple"이 된다 —
      // 값 자체가 syminfo와 동일하게 컴파일타임 리터럴(barstate/session의 진짜 런타임 값과 다름)이라
      // 여기서도 명시적으로 "simple"을 반환해 UNKNOWN 경유 없이 동일 결론에 바로 도달한다.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "timeframe" &&
        (TIMEFRAME_STRING_PROPS.has(expr.attr) || TIMEFRAME_NUMBER_PROPS.has(expr.attr) ||
          TIMEFRAME_BOOLEAN_PROPS.has(expr.attr))) {
        return "simple";
      }
      // C485: 그 외 전부(UDT 필드 접근 `config.length` 등)는 pine2py `_infer_qualifier`의 DotAccess
      // 분기 원문("point 접근 → 네임스페이스 체크"; SIMPLE_NAMESPACES가 아니면 무조건
      // `return self._infer_qualifier(node.obj)` — obj 자신의 qualifier로 재귀)을 그대로 포트한다.
      // 기존 pine2js 포트는 이 재귀 없이 무조건 "series"로 떨어뜨려 UDT 필드 length 인자(예:
      // `config.erLength`, config가 simple UDF 매개변수)를 부당하게 series로 오판했다(wild
      // corpus_scan 82건 length-series 클러스터 실측으로 발견). barstate.*/session.*는 그 obj
      // Identifier("barstate"/"session")가 어차피 스크립트 변수로 선언될 수 없어(예약 네임스페이스)
      // 위 Identifier case의 "미선언 시 보수적 series" 기본값으로 그대로 떨어져 기존 series 분류가
      // 유지된다(회귀 없음) — 즉 이 한 줄 변경으로 이전 동작을 보존하면서 UDT 필드만 정확해진다.
      return inferQualifier(expr.obj, prog, scope);
    case "SwitchStmt": {
      // C554: switch "표현식"의 한정자는 subject/case 값/각 암 결과의 병합 — TV는 simple subject +
      // 리터럴 암의 switch를 simple로 판정한다(wild 8f2aa9d0ea9d.pine 자체 주석 "Switch expressions
      // with literal arms return simple values"가 TV 동작을 명시 문서화, ta.ema CE10123 인용 프로브
      // 2건과 함께 C554 오프라인 확정 — DIVERGENCES #185). pine2py _infer_qualifier는 제어문 전부를
      // SERIES로 뭉개지만 거긴 경고 전용이라 무해하고, pine2js는 이 과대분류가 ta.ema류 length 하드
      // 에러의 오탐이 된다(암 선택이 바-불변이고 암 값도 바-불변이면 결과도 바-불변이라 런타임
      // 고정폭 상태와도 정합). 암 본문이 ExprStmt로 끝나지 않으면(중첩 제어문-식 등, C515: 파서는
      // 제어문-식을 ExprStmt로 안 감쌈) 보수적으로 series — 다문장 본문의 마지막 식이 본문 내부
      // 로컬을 참조하는 경우도 Identifier 미해결 폴백(series)으로 자연히 보수 처리된다.
      let q: Qualifier = "const";
      if (expr.subject !== null) q = mergeQualifiers(q, inferQualifier(expr.subject, prog, scope));
      for (const c of expr.cases) {
        if (c.values !== null) {
          for (const v of c.values) q = mergeQualifiers(q, inferQualifier(v, prog, scope));
        }
        const last = c.body.length > 0 ? c.body[c.body.length - 1]! : undefined;
        if (last === undefined || last.kind !== "ExprStmt") return "series";
        q = mergeQualifiers(q, inferQualifier(last.expr, prog, scope));
        if (q === "series") return "series";
      }
      return q;
    }
    case "IfStmt":
    case "ForStmt":
    case "WhileStmt":
      // 분기별 값을 추적하지 않고 보수적으로 series(_infer_qualifier의 동일 분기와 동일 원칙).
      // if-표현식도 TV는 switch와 같은 병합 규칙일 가능성이 높지만 wild length-series 클러스터
      // 실측(C554)에 if-표현식 사례가 0건이라 큐레이션 원칙(C283)대로 예방적 확장은 하지 않는다.
      return "series";
  }
}

// idiv 대상 판별을 위한 컴파일타임 int/float 타입("na/수치 (2c)", pine2py에는 대응이 없는 pine2js
// 고유 설계 — pine2py는 모든 수를 float로만 다뤄 int/float 구분 자체가 없다). 의도적으로 아주 좁게만
// 판별한다: (a) 정수 리터럴(소수점/지수 표기가 없는 NumberLiteral.raw), (b) 명시적으로
// `var int x = ...`로 선언된 top-level var(prog.varTypeHints). 그 외(UDF 매개변수, '=' 로컬,
// BinOp/TernaryOp/CallExpr 등 산술식 결과, UnaryOp 음수 리터럴)는 전부 "unknown"으로 보수 처리해
// genBinOp이 기존 rt.pineDiv(float)를 그대로 쓰게 한다 — 오판의 최악의 결과가 여전히 기존과 동일한
// float 나눗셈이지 잘못된 truncate가 되지 않도록(PROGRESS.md C19 next_hint의 권장 스코프 그대로).
export type NumType = "int" | "float" | "unknown";

export function inferNumType(expr: Expr, prog: AnalyzedProgram): NumType {
  if (expr.kind === "NumberLiteral") {
    return /[.eE]/.test(expr.raw) ? "float" : "int";
  }
  if (expr.kind === "Identifier") {
    const hint = prog.varTypeHints.get(expr.name);
    if (hint === "int") return "int";
    if (hint === "float") return "float";
    return "unknown";
  }
  return "unknown";
}

// str.tostring()의 기본(format_str 없음) 포맷 갈림 판별 전용(C201, LIMITATIONS.md "str.tostring
// int/float 갭" 근본 수정) — pine2py str_funcs.tostring이 `str(value)`로 Python 실제 타입(int면
// "5", float면 "5.0")을 그대로 보존하는데, pine2py가 실제로 진짜 Python int를 만드는 경우는 딱
// 둘: (a) 정수 리터럴(소수점/지수 없는 NumberLiteral — inferNumType이 이미 판별), (b) for 루프
// 카운터 변수(Pine 언어 자체가 for 루프 카운터를 항상 int 타입으로 고정 — pine2py도 range()가
// 항상 Python int를 내놓는다는 사실로 이를 재확인, codegen.py _gen_for_range_args 소스 대조).
// 의도적으로 이 둘만 다룬다 — UDF/method int 매개변수, int() 캐스팅 결과, '=' 로컬로의 전파는
// LIMITATIONS.md에 잔여 스코프로 명시(과욕 금지, PROGRESS.md C200 next_hint 원칙 그대로). '='
// 로컬은 numTypeHints에 아무것도 기입하지 않으므로 resolveLocalNumType이 항상 undefined를 반환해
// 자동으로 보수적 "false"로 떨어진다 — 새 오탐 경로가 아니다.
export function isStaticIntExpr(expr: Expr, prog: AnalyzedProgram, scope: LexScope): boolean {
  // 음수 정수 리터럴(`-7`)은 파서가 UnaryOp("-", NumberLiteral)로 감싼다(단항 +와 달리 -는 실제
  // AST 노드를 만듦, parser.ts) — pine2py도 `(- 7)` 형태로 이식해 Python 런타임에서 여전히 진짜
  // int이므로(codegen.py `_try_int`가 for 루프 bound에서 이 패턴을 특별 취급하는 것과 동일 근거)
  // 피연산자로 재귀한다.
  if (expr.kind === "UnaryOp" && expr.op === "-") return isStaticIntExpr(expr.operand, prog, scope);
  const t = inferNumType(expr, prog);
  if (t === "int") return true;
  if (t === "float") return false;
  if (expr.kind === "Identifier") return resolveLocalNumType(scope, expr.name) === "int";
  return false;
}

// concat 대상 판별("na/수치 (2c-ii)") — pine2py codegen.py `_is_string_expr`를 그대로 이식한 순수
// 구문 판별이다(prog/scope 불필요, 재귀 구조만 봄): StringLiteral 또는 '+' BinOp로 문자열이 재귀적
// 병합되는 경우만 true. **의도적으로 식별자를 전혀 조회하지 않는다** — pine2py 원본도 Identifier
// 분기가 없어 `s1 + s2`(둘 다 string 변수)처럼 리터럴이 하나도 없는 순수 식별자 연결은 이 판별을
// 통과하지 못하고 숫자 덧셈(`l + r`)으로 그대로 내려간다(식별자 기반 문자열 타입 추적은 별도
// 사이클로 분리 — PROGRESS.md C20 next_hint/LIMITATIONS.md 참조). str.* 콜(문자열 반환)은 pine2js에
// 아직 str.* 자체가 없어 이번 판별에서 생략(추가되면 이 분기에 이어 붙일 것).
export function isStringExpr(expr: Expr): boolean {
  if (expr.kind === "StringLiteral") return true;
  if (expr.kind === "BinOp" && expr.op === "+") {
    return isStringExpr(expr.left) || isStringExpr(expr.right);
  }
  return false;
}

// TaRegistryEntry 인터페이스 + TA_REGISTRY 테이블(ta.*/math.sum/math.random/bare fixnan) + 그
// dispatch 함수(analyzeStatefulCall)는 analyzer/ta.ts로 이전(ROADMAP "컬렉션 네임스페이스
// 레지스트리화 + analyzer.ts 분할" — collections.ts(C137~C141)에 이은 analyzer.ts 파일 분할
// 두 번째 슬라이스, 순수 이동만 수행). firstForbiddenKind/FORBIDDEN_KIND_DESC도 analyzeStatefulCall의
// 유일한 소비처라 함께 이전했다.

// array/map/matrix/str.* 인자 개수 검증 데이터 주도 테이블(MAP_REGISTRY/STR_REGISTRY/
// ARRAY_REGISTRY/MATRIX_REGISTRY)과 그 dispatch 함수(analyzeMapCall/analyzeStrCall/
// analyzeArrayCall/analyzeMatrixCall)는 analyzer/collections.ts로 이전(ROADMAP "컬렉션
// 네임스페이스 레지스트리화 + analyzer.ts 분할", C137~C140이 레지스트리화한 4개 테이블을 순수
// 이동만 수행 — 신규 검증 로직 없음, 아래 analyzeCallExpr의 else-if 조건/분기 구조는 그대로 유지).

// C738(배치37 (3) series-arg VAR_DECL 축): request.security expression이 top-level `var` 상태
// 변수를 참조할 때, 그 변수의 "선언 + top-level if 트리 안 ':=' 갱신" 문장 슬라이스를 HTF
// 프리패스 루프 안에 재현(리플레이)하기 위한 빌드 산출물. TV의 expression 시맨틱은 "요청 tf
// 문맥에서 스크립트를 재실행했을 때의 값"이므로, var의 바-간 상태 전이를 HTF 행 시퀀스 위에서
// 그대로 다시 돌리는 것이 정확한 대응이다(uniqueTopEqVars의 "정의식 치환"이 per-bar 순수 값의
// 대응이었던 것의 상태 변수판). 빌드/검증은 call-expr.ts buildSecurityVarSlice가, 방출은
// codegen.ts generateSecurityExprPreamble이 담당한다. cond/value/init Expr는 전부
// buildSecurityExprNode가 이미 검증·클론한 "빌드된" 트리다(ta 콜 슬롯/히스토리 버퍼 포함).
export type SecurityVarSliceStmt =
  | { kind: "assign"; name: string; value: Expr }
  | {
      kind: "if";
      cond: Expr;
      then: SecurityVarSliceStmt[];
      elifs: { cond: Expr; body: SecurityVarSliceStmt[] }[];
      els: SecurityVarSliceStmt[] | null;
    };
// line: 소스 라인 — 방출 순서(선언 게이트와 갱신 문장이 원본 소스 순서 그대로 실행돼야 var 읽기
// 시점 값이 보존된다). init 항목은 프리패스 첫 행(h===0)에서만 실행되는 once-only 게이트로 방출.
export type SecurityVarSliceItem = { line: number } & (
  | { kind: "init"; name: string; value: Expr }
  | { kind: "stmt"; stmt: SecurityVarSliceStmt }
);
export interface SecurityVarSlice {
  varNames: string[]; // 프리패스 로컬(__svN) 배정 순서 — codegen이 인덱스로 이름을 만든다
  items: SecurityVarSliceItem[]; // line 오름차순 정렬 완료 상태
}

export interface AnalyzedProgram {
  script: Script;
  // 배치30 (1), C591: analyze(script, {chartTf}) options.chartTf 그대로(기본 DEFAULT_CHART_TF="D") —
  // timeframe.* 폴딩(analyzeExpr DotAccess 분기)과 call-expr.ts의 request.security tf 상수 폴딩
  // 계열(resolveSecurityTfLiteral 등)이 공통으로 참조하는 단일 출처.
  chartTf: string;
  varSlots: string[]; // slot index -> 변수명 (선언 순서)
  varIndex: Map<string, number>;
  varTypeHints: Map<string, string | null>;
  locals: Set<string>; // var가 아닌 '=' 재계산 변수 (UDF 매개변수 + 함수 내부 '=' 로컬 포함)
  // TA_REGISTRY 콜사이트 -> {레지스트리 키, taSlots 인덱스}. inUdf:true(C162)면 slot은 전역
  // 인덱스가 아니라 그 함수의 함수-상대 슬롯(FuncInfo.localTaSlotCount 주석 참조)이고, codegen이
  // `$.taSlots[__taBase + slot]`로 내린다 — 실제 전역 슬롯은 UDF 콜사이트마다 funcTaBases가 할당.
  // seriesLength:true(TA_REGISTRY.seriesLengthOk 항목 — highest/lowest/sma/highestbars/lowestbars)면
  // length 인자가 series라 codegen이 state-fixed rtPath 대신 *VarLen 변형으로 분기한다.
  stateCallSlots: Map<CallExpr, { fn: string; slot: number; inUdf?: true; seriesLength?: true }>;
  taSlotCount: number;
  // 다중 반환 TA 콜사이트 중 튜플 디스트럭처링의 값 위치에 합법적으로 등장한 것들.
  // analyzeTupleDestructure가 stmt.value를 재귀 분석하기 전에 등록하고, analyzeCallExpr는
  // returnArity 있는 콜이 이 집합에 없으면(=표현식 위치) 에러를 낸다 — codegen genCallExpr가
  // 스칼라 식을 기대하므로 다중 반환 콜은 문장 레벨(genTupleDestructure)에서만 소비 가능.
  tupleStateCalls: Set<CallExpr>;
  // C752: UDF/method 본문의 마지막 문장이 TA 다중반환 콜 또는 이미 확정된 튜플 반환 UDF를
  // 튜플 디스트럭처하는 암시 재반환 폼(`f() =>\n ... \n [a,b,c] = ta.vwap(...)`류, C530/C531
  // security 튜플 디스트럭처 변형의 non-security 자매 축 — analyzeFuncDecl/analyzeMethodDecl의
  // 동명 분기 참조)일 때 그 TupleDestructure 문장 자신을 등록. 디스트럭처는 표준 analyzeStmt가
  // 그대로 검증/슬롯 등록하므로 여기서는 "이 문장이 함수의 암시 반환 위치"라는 사실만 codegen에
  // 전달한다 — genFuncBody가 이 집합을 조회해 문장 실행 후 대상 이름을 배열로 return한다(그렇지
  // 않으면 genImplicitReturn 기본 폴백이 return 없이 값을 흘려 undefined가 샌다, C571과 동일 급 버그).
  funcBodyTailTupleDestructures: Set<TupleDestructure>;
  // Context.taScratch(공유 스크래치 배열)에 필요한 크기 — 스크립트에 실제 등장하는 다중 반환
  // 콜의 returnArity 최댓값(없으면 0, Float64Array(0)은 무해).
  taScratchSize: number;
  builtinCalls: Map<CallExpr, string>; // 순수(stateless) 빌트인 콜사이트 -> rt.<이름> (조건부 블록 제약 없음)
  // method-call 스타일 array/map 콜(C222, `arr.push(x)` == `array.push(arr, x)`)의 수신자 Expr —
  // Pine v5 문법 sugar: 첫 인자가 컨테이너 자신인 array.*/map.* 함수는 `id.method(...)`로도 호출
  // 가능하다. builtinCalls엔 이미 "array.push"/"map.put" 같은 정규 이름으로 등록해두고(namespace
  // 형태 콜과 codegen 소비 지점을 100% 공유), 이 맵은 오직 "receiver를 args 맨 앞에 끼워 넣어야
  // 한다"는 codegen 전용 신호만 담는다 — expr.args 자체는 여전히 receiver를 뺀 나머지 인자만
  // 갖고 있다(analyzer가 AST를 재작성하지 않는 원칙 유지, C220 array.new<TYPE>의 attr 재작성과
  // 달리 이번엔 args 배열 자체를 건드리면 analyzeArrayCall/analyzeMapCall의 기존 인자개수 검증이
  // receiver를 이중 계산하게 되므로 별도 병렬 맵으로 분리).
  methodCallReceivers: Map<CallExpr, Expr>;
  // for-in 루프(C216)의 이터러블 컨테이너 종류 -- analyzeForInStmt가 정적으로 판별해 한 번만
  // 채우고 codegen(genForInStmt)이 그대로 소비한다(builtinCalls와 동일한 "analyzer가 결정,
  // codegen은 재판별하지 않는다" 원칙). array/map/matrix(C709, TV가 행 단위 array로 순회 —
  // matrix.ts PineMatrix가 이미 unknown[][]라 JS 네이티브 for-of가 그대로 동형) 중 하나로 판별
  // 안 되면(UDF 로컬/매개변수/복합식 등) analyzer가 명시 에러를 내고 여기 등록하지 않는다.
  forInKinds: Map<ForInStmt, "array" | "map" | "matrix">;
  builtinConstants: Map<DotAccess, number>; // math.pi 등 인자 없는 네임스페이스 상수 DotAccess -> 리터럴 값(C72)
  builtinStringConstants: Map<DotAccess, string>; // color.red 등 string 반환 네임스페이스 상수(C78, builtinConstants의 number 전용 제약을 피한 병렬 맵)
  // order.ascending/descending 등 boolean 반환 네임스페이스 상수(C85, 세 번째 병렬 맵). 키가
  // StringLiteral도 포함하는 이유(C203): array.sort/sort_indices/matrix.sort의 order 위치에
  // 원시 문자열 리터럴("ascending"/"descending")이 오면 DotAccess 폴딩 경로를 안 타 런타임에서
  // JS truthy 판정으로 항상 오름차순이 되는 버그가 있었다 — analyzer/collections.ts의
  // analyzeArrayCall/analyzeMatrixCall이 그 order 위치 StringLiteral만 좁게 이 맵에 등록한다
  // (LIMITATIONS.md 참조, 다른 위치의 동일 문자열 값은 이 맵에 없어 영향받지 않음 — 노드 identity
  // 키라 값 기반 오탐 불가).
  builtinBooleanConstants: Map<DotAccess | StringLiteral, boolean>;
  builtinRuntimeExprs: Map<DotAccess, string>; // barstate.*/session.* 등 바마다 바뀌는 런타임 값 DotAccess -> JS 식 문자열(네 번째 병렬 맵, 값이 아니라 식 자체를 등록)
  // label.all/line.all 등(C244) — 값이 항상 빈 배열 리터럴이라 builtinStringConstants(JSON.stringify로
  // 따옴표 문자열 방출)에 얹으면 리터럴 배열이 아니라 문자열 "[]"가 나와버린다(C238이 확인한 스코프) --
  // 다섯 번째 병렬 맵. 노드 identity만 필요해 값 없는 Set(다른 4개는 값을 실어야 하는 Map).
  builtinArrayConstants: Set<DotAccess>;
  // array(참조형)를 담는 top-level var 이름(C79) — 판별은 선언 시점 초기값이 array 생성 콜
  // (array.new_float)인 좁은 구문 신호만 본다(varTypeHints의 "string"이 선언 힌트만 보는 것과
  // 동일 원칙 — 값 흐름 추적 없음). 유일한 소비처는 analyzeIndexAccess의 히스토리 차단:
  // $.histSlots는 Series.preallocate(Float64Array) 기반이라 배열 참조를 담으면 조용히 NaN으로
  // 뭉개진다(string 차단과 같은 이유, LIMITATIONS.md 참조).
  arrayVars: Set<string>;
  // map(참조형)을 담는 top-level var 이름(C89) — arrayVars와 완전히 동일한 원칙(선언 시점 초기값이
  // map.new/map.copy 콜인지 구조만 보는 좁은 신호, 값 흐름 추적 없음). 유일한 소비처도 동일하게
  // analyzeIndexAccess의 히스토리 차단.
  mapVars: Set<string>;
  // matrix(참조형)를 담는 top-level var 이름(C90) — arrayVars/mapVars와 완전히 동일한 원칙
  // (선언 시점 초기값이 matrix.new 콜인지 구조만 보는 좁은 신호). 유일한 소비처도 동일하게
  // analyzeIndexAccess의 히스토리 차단.
  matrixVars: Set<string>;
  // label/line/box/table/polyline 핸들을 담는 top-level var 이름 -> 그 kind(C232, arrayVars/
  // mapVars/matrixVars/udtVarTypes와 완전히 동일한 원칙 — 선언 시점 초기값이 생성자 콜인 좁은
  // 구문 신호만 본다, 값 흐름 추적 없음). 이 필드가 필요했던 이유는 C232 1차 구현이 '=' 로컬만
  // 지원했다가(corpus 스캔 표본이 전부 '=' 였음) 재스캔에서 `var t = table.new(...)` 1건이 남아
  // 있는 것을 발견해서다 — array/map/matrix/UDT는 처음부터 var와 '=' 둘 다 지원했으므로 drawing만
  // var를 빠뜨리는 비대칭을 여기서 바로잡는다. 유일한 소비처는 resolveDrawingExprKind(method-call
  // 스타일 drawing 콜 수신자 판별).
  drawingVarKinds: Map<string, DrawingKind>;
  directives: Set<CallExpr>; // indicator()/strategy() - codegen에서 no-op
  // hline/bgcolor/barcolor/plotshape/plotchar/plotarrow/plotcandle/plotbar/alertcondition/alert/
  // max_bars_back(C208, ROADMAP corpus 스캔 최다빈도) — directives와 완전히 동일한 원칙: 시각화/알림
  // 전용이라 GOAL.md 사업 목적(대량 백테스트)엔 무의미해 codegen에서 statement 전체를 no-op 처리한다.
  // plot()과 달리 series 인자조차 record할 채널이 없다(fill()의 plot1/plot2 핸들 소비, 즉 plot()/
  // hline() 반환값을 변수에 담아 재사용하는 패턴은 이번 슬라이스 범위 밖 — LIMITATIONS.md 참조).
  noopStmtCalls: Set<CallExpr>;
  // strategy() 지시어가 등장했는가(C163) — strategy.* 사용(entry/close 콜 + long/position_size류
  // 속성)의 선행 조건. 단일 패스라 "선언이 소스에서 사용보다 먼저" 규칙이 자연히 강제된다
  // (TV도 declaration statement 필수 — 실전 스크립트는 항상 첫 문장이라 실질 제약 없음, LIMITATIONS.md).
  isStrategy: boolean;
  // strategy() 지시어에서 추출한 default_qty_value/pyramiding(C164) — null이면 미지정(StrategyState
  // 생성자 기본값 1/1 사용, codegen이 configure 방출 자체를 생략해 기존 출력과 한 글자도 안 달라짐
  // — C129 원칙). 지시어 no-op 원칙(값을 어디에도 안 실음)의 유일한 예외 메타데이터 두 개 —
  // 컴파일타임 숫자 리터럴만 지원(call-expr.ts 지시어 분기가 검증, LIMITATIONS.md).
  strategyDefaultQty: number | null;
  strategyPyramiding: number | null;
  // strategy() 지시어에서 추출한 initial_capital(C165) — 위 두 필드와 완전히 동일한 원칙(숫자
  // 리터럴 전용, null=미지정). 미지정이면 codegen이 configure 세 번째 인자 자체를 생략해 C164
  // 2-인자 출력이 한 글자도 안 바뀐다(StrategyState 기본 파라미터 100000 = TV/pine2py 기본값).
  strategyInitialCapital: number | null;
  // strategy(default_qty_type=strategy.percent_of_equity) 지정 여부(C171) — strategy.fixed/
  // 동치 문자열은 기존 동작(계약 수)이라 false 유지. true면 codegen이 configure 네 번째 인자(true)를
  // 방출하고 그 앞 initial_capital 슬롯도 기본값으로 채운다(C129 "지정된 가장 뒤쪽 슬롯까지만 방출"
  // — 미지정 스크립트 출력 무변화). qtyIsCash(아래)와는 call-expr.ts if/else-if 구조상 상호 배타.
  strategyQtyIsPercent: boolean;
  // strategy(default_qty_type=strategy.cash) 지정 여부(C330) — default_qty_value를 계약 수가 아니라
  // **통화 금액**으로 해석(qty = 금액/체결가, equity 무관 — percent_of_equity의 "잔고 비율"과 다른 축).
  // true면 codegen이 configure 다섯 번째 인자(true)를 방출하고 네 번째(percent) 슬롯도 명시적으로
  // false로 채운다(C129 원칙의 연장 — 두 슬롯 사이 skip 불가).
  strategyQtyIsCash: boolean;
  // strategy() 지시어의 currency= kwarg(C332, next_hint(C331) 1순위) — 위 세 숫자 필드와 달리
  // '지원하지 않는 strategy 속성' 에러를 내던 strategy.account_currency의 값 소스. TV 기본값은
  // currency.NONE("계좌 통화 = 심볼 통화")인데 이 엔진의 syminfo.currency/basecurrency가 이미
  // 컴파일타임 고정값 "USD"(SYMINFO_STRING_PROPS, C239/C287과 동일한 헤드리스 환경값 설계)라
  // 미지정 시에도 그 값을 그대로 재사용하면 된다 — 즉 이 필드는 default_qty_type처럼 "null=미지정"
  // 상태가 필요 없는 항상-확정 컴파일타임 문자열이라 STRATEGY_RUNTIME_PROPS(바마다 바뀌는 브로커
  // 상태) 패턴이 아니라 long/short/fixed와 동일한 builtinStringConstants 폴딩으로 충분(새 런타임
  // 상태/configure() 슬롯 불필요 — next_hint가 예상한 것보다 저비용). currency= 값이 currency.*
  // 상수/문자열 리터럴이 아니면(변수/식) call-expr.ts가 하드 에러 대신 조용히 discard(기본값
  // "USD" 유지) — 이 값은 실제 통화 환산/P&L 계산에 관여하지 않는 순수 표시용이라 default_qty_value
  // 류와 위험도가 다르다(wild 46e92d206cfa.pine 회귀 실측으로 확정). TV 미검증(가설), DIVERGENCES
  // 신규 항목 필요.
  strategyCurrency: string;
  // ExprStmt의 bare CallExpr 집합(C163) — "문장 위치 호출" 판별용. plot의 topLevel(scope.depth===0
  // 한정)과 달리 깊이 무관하게 모든 문장 위치를 커버한다. 소비처는 strategy.entry/close(void 반환
  // 이라 대입 RHS/식/인자 위치 호출을 하드 에러로 거부 — 값 위치에서 undefined가 조용히 새는 것 방지).
  stmtCalls: Set<CallExpr>;
  funcs: Map<string, FuncInfo>; // UDF 이름 -> 시그니처(매개변수/함수-상대 var 슬롯)
  // C452(wild "var-subst:udf-param" 서브클러스터): UDF 이름 -> 스크립트 전체에서 유일한 콜사이트의
  // CallExpr(그 함수를 부르는 다른 콜사이트가 하나라도 더 있거나, 유일한 콜사이트 자신이 다른
  // 함수/method 본문 안에 있으면 등록 안 됨 — prepassIndexSingleCallSites 참조). request.security
  // expression 좁은 문법(buildSecurityExprNode)의 Identifier case가 이 함수의 매개변수 이름을
  // 만나면, uniqueTopEqVars(top-level 유일 '=' 변수 치환)와 동일한 안전 근거로 이 유일 콜사이트의
  // 실인자로 치환한다 — 결과가 정확히 하나뿐이라 콜사이트별 독립 상태(GOAL.md)가 애초에 불필요.
  funcSingleCallSiteArgs: Map<string, CallExpr>;
  // C453: UDF 이름 -> 스크립트 전체 콜사이트 전수 목록(prepassIndexSingleCallSites가 위 단일
  // 콜사이트 판정과 같은 워크에서 함께 채움 — AST 워크 순서 = 결정적, 서수 배정의 기준 순서).
  // inFuncName: 그 콜사이트 자신이 다른 FuncDecl/MethodDecl 본문 안이면 그 함수의 이름, top-level이면
  // null (C539 — 예전 inFunc boolean에서 확장: tf-param 콜사이트 폴딩이 in-func 실인자를 접을 때
  // C526 매개변수 섀도잉 가드(constVarShadowFuncs)에 넘길 "그 참조가 위치한 함수" 이름이 필요.
  // 이름은 prescanConstVars의 paramOfFunc와 동일하게 decl.name 원문 — 두 맵의 키가 항상 일치).
  // expression 축(C453 secParamMultiSite/pending)은 in-func 콜사이트(inFuncName !== null)가 하나라도
  // 있으면 함수 전체 제외를 유지 — 함수 안 콜사이트의 series 실인자는 그 함수 스코프에 매여 있어
  // top-level 치환이 성립하지 않고, 일부만 지원하면 미지원 콜사이트 경유 호출이 __secIdx 없이
  // 들어와 조용한 오답이 된다.
  funcAllCallSites: Map<string, { call: CallExpr; inFuncName: string | null }[]>;
  // C453: request.security expression 인자가 UDF 매개변수(bare Identifier)이고 그 함수의 콜사이트가
  // 2개 이상(전원 top-level)인 콜의 지연 처리 큐 — 본문 분석 시점엔 함수 뒤에 오는 콜사이트의 인자
  // 서브트리가 참조하는 top-level 이름들이 아직 등록 전일 수 있어(선언-후-사용 line 검사 포함)
  // 메인 루프 종료 후 processPendingSecurityParamExprs(call-expr.ts)가 일괄 빌드/슬롯 배정한다.
  // gaps/lookahead/tfLiteral은 body 콜 자신의 인자라 큐잉 시점에 이미 확정돼 함께 싣는다.
  // tfLiteral이 배열이면(C529) tf 인자도 같은 UDF의 매개변수라 콜사이트별로 접힌 값 —
  // funcAllCallSites 순서 그대로라 큐 처리 시 서수(ordinal)별로 하나씩 소비한다. 배치31 (b)-2
  // (C600)부터 배열 원소가 런타임 tf 트리(Expr — 리터럴 폴딩 실패 사이트의 직접 input 콜/C598
  // 치환 트리)일 수 있다: 큐 처리가 그 서수 슬롯을 자리표시(chartTf)로 밀고
  // securityRuntimeTfSlots에 등록해 codegen 프리앰블 rebuildSecurityCache가 런타임 1회 확정한다.
  // C534: indexWrap — seriesArg가 매개변수 bare Identifier가 아니라 `paramName[index]`(IndexAccess)
  // 래핑이었으면 그 index 서브트리(콜사이트 무관, 원본 그대로 재사용)와 원 노드의 line/col — 큐
  // 처리(processPendingSecurityParamExprs)가 콜사이트별 실인자를 이 index로 다시 감싼 합성
  // IndexAccess를 만들어 빌드한다. bare 매개변수면 null(기존 C453 동작 그대로).
  // C542: paramSubstRoot — seriesArg가 bare 매개변수도 `paramName[index]` 래핑도 아니라 매개변수(들)를
  // 서브트리 안쪽 어딘가(예: `ta.rsi(src, length)`처럼 ta.* 콜의 인자)에 참조하는 일반 형태일 때만
  // non-null(seriesArg 원본 그대로). 이 경우 paramIdx/paramName/indexWrap은 미사용 sentinel(-1/"").
  // 처리(processPendingSecurityParamExprs)가 콜사이트마다 그 함수의 전 매개변수 -> 실인자 맵을
  // buildSecurityExprNode의 기존 paramEnv 치환 메커니즘(C516 UDF 인라인이 이미 쓰던 것)에 그대로
  // 먹여 재귀 빌드한다 — 단일 매개변수 케이스(paramIdx/indexWrap)는 출력 바이트 불변 위해 그대로 둔다.
  // C563: passthroughSeriesArg — 전 콜사이트의 실인자가 bare(단일 반환) UDF 콜에 도달하는 후보일
  // 때만 non-null(seriesArg 원본 — bare 매개변수 Identifier 또는 `paramName[index]` IndexAccess
  // 그대로). 이 경우 per-site 좁은문법 빌드가 아니라 C436 passthrough의 균일 붕괴로 처리된다
  // (값 = 매개변수 자신, 슬롯/프리패스/__secIdx 불필요 — call-expr.ts secParamAllBareUdf 주석 참조).
  securityParamExprPending: Array<{
    expr: CallExpr;
    funcName: string;
    paramIdx: number;
    paramName: string;
    indexWrap: { index: Expr; line: number; col: number } | null;
    paramSubstRoot: Expr | null;
    passthroughSeriesArg: Expr | null;
    tfLiteral: string | (string | Expr)[];
    gaps: boolean;
    lookahead: boolean;
  }>;
  // C453: 위 큐 처리 결과 (1) — 콜사이트별 프리패스 스펙 목록(securityExprCallSlots의 값과 동형,
  // 단 key가 없는 배열: body의 request.security 노드 하나가 콜사이트 수만큼 슬롯을 가져 노드 키
  // 맵에 못 싣는다). generateSecurityExprPreamble이 securityExprCallSlots 순회에 이어 이 배열도
  // 순회해 슬롯당 HTF 프리패스 함수를 방출한다.
  securityParamExprPrepasses: Array<{
    slot: number;
    gaps: boolean;
    lookahead: boolean;
    bodyExpr: Expr;
    histReads: { node: IndexAccess; obj: Expr }[];
    // C738: securityExprCallSlots.varSlice와 동형(SecurityVarSlice 주석 참조).
    varSlice: SecurityVarSlice | null;
  }>;
  // C453: 위 큐 처리 결과 (2) — body의 request.security CallExpr -> 연속 슬롯 블록의 시작(base).
  // codegen이 `$.securityExprCache[base + __secIdx]`로 방출한다(서수 __secIdx는 함수 파라미터).
  securityParamExprCalls: Map<CallExpr, { base: number; gaps: boolean; lookahead: boolean }>;
  // C453: 위 큐 처리 결과 (3) — 콜사이트 CallExpr -> 그 콜사이트의 서수(0-based, funcAllCallSites
  // 순서). codegen이 __slotBase/__taBase/__histBase 뒤에 리터럴로 전달한다.
  funcSecIdxArgs: Map<CallExpr, number>;
  funcCallSlots: Map<CallExpr, number>; // UDF 콜사이트 -> $.fnVars 안의 슬롯 베이스(call-site별 독립)
  fnVarSlotCount: number; // $.fnVars 배열 전체 크기(모든 UDF의 모든 콜사이트 슬롯 총합)
  // C255: forward-reference 콜사이트(callee FuncInfo.bodyAnalyzed===false 시점에 분석된 콜) —
  // localVarSlots.length/localTaSlotCount를 아직 몰라 즉시 슬롯 배정이 불가능하므로 analyze()의
  // 메인 루프가 끝난 뒤(모든 top-level FuncDecl 본문이 분석 완료된 시점) 일괄 배정한다.
  pendingFuncCallSlots: Array<{ expr: CallExpr; func: FuncInfo }>;
  // C412: forward-reference UDF 튜플 디스트럭처 콜사이트(analyzeTupleDestructure의 pendingUdfFunc
  // 주석 참조) — 함수 이름 -> 그 이름을 부르는 미해소 콜사이트 목록. analyzeFuncDecl이 그 이름의
  // 본문 분석을 마치는 즉시(bodyAnalyzed=true 직후) resolvePendingTupleDestructuresFor가 소비한다.
  pendingTupleDestructures: Map<string, Array<{ stmt: TupleDestructure; scope: LexScope; registeredNames: string[] }>>;
  // UDF/method 콜사이트 -> $.taSlots 안의 ta 슬롯 베이스(C162, funcCallSlots의 taSlots 판 —
  // callee의 localTaSlotCount > 0인 콜사이트만 등록되고, 그 콜사이트가 taSlotCount에서 연속
  // localTaSlotCount칸을 새로 배정받는다). codegen이 호출 인자 `__taBase`로 전달.
  funcTaBases: Map<CallExpr, number>;
  varQualifiers: Map<string, Qualifier>; // top-level var/varip 이름 -> 선언 시점 추론 한정자
  historySlots: Map<number, number>; // history 참조가 있는 top-level var 슬롯 -> $.histSlots 인덱스
  historySlotCount: number; // $.histSlots 배열 전체 크기
  // UDT 타입 top-level var 슬롯 -> $.refHistSlots 인덱스(C637, `(recv[N]).field`류 — 히스토리
  // 인덱스가 DotAccess.obj 위치에 오는 역순 폼). historySlots(Map<number,number>, 슬롯 키)와
  // 완전히 동형이나 물리 배열이 참조형 원형 버퍼($.refHistSlots, refHistorySlots/refHistorySlotCount
  // 공유 — '=' 로컬 drawing/UDT 판(이름 키)과 카운터만 나란히 공유, 물리 배열도 같음)로 분리된다.
  // var/varip는 $.vars[slot] 물리 저장이라 이름 문자열이 아니라 슬롯 번호가 키여야 codegen이
  // 정확한 값을 record할 수 있다(refHistorySlots를 그대로 재사용하면 이름 기반 safeLocalName()이
  // 방출돼 존재하지 않는 JS 로컬을 참조하는 버그가 남는다).
  varRefHistorySlots: Map<number, number>;
  historyOffsets: Map<IndexAccess, number>; // IndexAccess 노드 -> 컴파일타임에 확정된 정수 오프셋
  // 동적(런타임) 오프셋 IndexAccess 노드 집합(신규) -- obj가 bar series/파생 가격/bar_index일 때만
  // 허용(index-access.ts analyzeIndexAccess 주석 참조, Series.get()이 임의 런타임 오프셋을 안전하게
  // 받음). 이 집합에 있으면 historyOffsets는 채우지 않고, codegen이 리터럴 대신 genExpr(index)를 낸다.
  dynamicHistoryOffsets: Set<IndexAccess>;
  // array[i] 브라켓 원소 접근(C501, wild "?." 클러스터 재조사 파생 발견) -- `[]`는 히스토리
  // 오프셋만이 아니라 array 원소 접근도 겸한다(pine2py `_gen_index_access`가 obj[idx]를 그대로
  // Python list subscript로 방출 -- obj가 list면 원소 접근, ctx.param() 승격된 series면 히스토리,
  // 별도 분기 자체가 없음. index-access.ts analyzeIndexAccess 최상단 분기 참조). resolveContainerExprKind가
  // "array"로 판별하는 모든 기존 역할(top-level var/eq-local/tuple-local/UDF param/local, UDT 필드)에
  // 동일 적용 -- 배열 인덱스는 히스토리 리터럴/음수 제약이 없다(rt.array.get이 Math.trunc+범위
  // 가드로 이미 완전 안전).
  arrayIndexReads: Set<IndexAccess>;
  // strategy.<prop>[N](C339, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 서브그룹 67건) --
  // top-level var와 동일한 $.histSlots[]/record()/get() 메커니즘을 재사용하되 슬롯 배정 키가
  // varSlot(number)이 아니라 STRATEGY_RUNTIME_PROPS 이름(string)이다 — 이 프로퍼티들은 named var
  // 슬롯이 없는 순수 JS 식(builtinRuntimeExprs)이라 record() 인자도 varSlot 조회가 아니라 그 식
  // 문자열 자체(STRATEGY_RUNTIME_PROPS.get(propName))를 codegen이 직접 방출한다. historySlotCount는
  // var 슬롯과 동일 카운터를 공유(같은 $.histSlots 배열, 인덱스 공간만 나눠 쓸 뿐 의미 차이 없음).
  strategyPropHistorySlots: Map<string, number>;
  // ta.<fn>(...)[N](C340, wild "히스토리 인덱스는 식별자에만 지원" 클러스터 잔여 CallExpr 축, 104건
  // 중 top-level·비-lazy 서브셋) -- obj가 TA_REGISTRY stateful 콜(prog.stateCallSlots에 등록된
  // CallExpr)일 때, 그 콜 자신의 AST 노드를 키로 $.histSlots[]를 배정한다(strategyPropHistorySlots의
  // propName(string) 키를 CallExpr(node identity)로 바꾼 자매 맵 — historySlotCount 카운터 공유).
  // var/strategy prop과 근본적으로 다른 지점: 그 둘은 "이미 매 바 갱신되는 named 저장소"가 있어
  // 문장 종료 후 별도 record 루프가 한 번 더 읽기만 하면 됐지만, 이 콜은 그 자체가 유일한 값
  // 발생원이라 record가 반드시 그 콜의 codegen과 같은 자리(인라인)에서 일어나야 한다(genIndexAccess
  // 참조) -- 그래서 scope가 lazy-expr(삼항/and·or 우변, hoistLazyStatefulCalls가 콜을 문장 앞으로
  // eager 호이스팅하는 위치)이면 인라인 record가 그 호이스팅된 실제 실행 시점과 어긋나 조용히 틀린
  // 값을 낼 위험이 있어(예: `cond ? ta.lowest(...)[1] : x` -- 콜 자체는 매 바 무조건 실행되지만
  // 인라인 record는 cond가 true인 바에만 실행됨) index-access.ts가 이 경우 하드 에러로 거부한다
  // (LIMITATIONS.md 참조, 범용 해법은 hoistLazyStatefulCalls 확장 필요 -- 별도 설계 이관).
  // udf-body(scope.func!==null)도 배제 -- $.histSlots[]는 var 슬롯처럼 slotBase 콜사이트별 인덱싱이
  // 없는 전역 배열이라, UDF 안의 이 노드가 여러 콜사이트에서 공유되면 상태가 뒤섞인다(top-level
  // '='/UDF 내부 var 히스토리를 원천 배제하는 것과 동일한 이유).
  // C522: (high-low)[1]류 산술식(BinOp/UnaryOp) 히스토리도 이 맵을 그대로 재사용한다(키 타입만
  // CallExpr에서 임의 Expr로 확장) -- record 인라인 타이밍 제약이 CallExpr과 동일해 같은
  // top-level-무조건-위치/lazy-hoist 메커니즘을 그대로 탄다(index-access.ts BinOp/UnaryOp 분기 참조).
  taCallHistorySlots: Map<Expr, number>;
  // 위 taCallHistorySlots 중 scope 체인에 "lazy-expr"(삼항/and·or 우변, 다른 forbidden kind 없이
  // 이것만)만 있는 IndexAccess(C468 확장 — 이전엔 이 축 전체가 하드 에러였다). genBinOp이 and/or를
  // `rt.pineAnd(l, r)` **함수 호출**로 방출해(numeric.ts) l/r이 JS 함수 인자로 무조건 즉시 평가되므로
  // and/or 우변은 실제로는 JS 네이티브 단락(short-circuit)이 아니다 -- 반면 TernaryOp는 여전히 JS
  // 네이티브 `cond ? t : f`(진짜 단락)라 두 케이스를 codegen이 구분할 필요 없이 **둘 다** C66과
  // 동일한 eager-hoist-to-prelude로 통일 처리한다(walkForLazyHoist IndexAccess 특수 분기 참조) --
  // record+get comma 식 전체를 문장 앞 `let __lazyN = (...)`로 끌어올려 그 자리(원 lazy 위치)에서는
  // 이미 계산된 임시변수만 읽는다. cond-body/loop-body/udf-body는 이 필드 대상이 아니며(다른 kind가
  // 섞이면 여전히 하드 에러) 잠재 오답 축(LIMITATIONS.md 참조)이라 계속 거부한다.
  lazyHistCallSites: Set<IndexAccess>;
  // 스크립트 top-level의 조건부 위치(if/for/while 본문·elif 조건 등, cond-body/loop-body/condition
  // kind — lazy-expr 아님)에서 도달할 때만 실행되는 stateful 콜의 히스토리(C671, 배치34 6순위
  // 'hist-stateful'). taCallHistorySlots(위)는 $.histSlots[]의 record()+Context.advance()(매 바
  // 무조건 전진) 조합이라 이 콜이 스킵된 바에서 record가 안 불려도 커서는 전진해버려 그 바의 슬롯이
  // NaN 구멍으로 남는다(바-인덱스 시맨틱) — TV 공식 execution-model 문서 CONFIRMED("함수 내부
  // series는 조건이 참인 바에서만 갱신", VERIFIED_SEMANTICS.md)는 이 콜 자신의 series가 "그 바"가
  // 아니라 "실행된 횟수"로 전진함을 명시해, []는 "N바 전"이 아니라 "N번째 이전 호출"을 가리켜야
  // 한다(압축/call-count 인덱스). 이 맵에 등록된 노드는 codegen이 Context.advance()가 절대 건드리지
  // 않는 별도 배열($.condCallHistSlots, runtime/context.ts)에 Series.push()(호출될 때만 스스로
  // 커서를 전진)로 기록한다 — 무조건 위치에서 써도 바마다 정확히 1회 호출되니 taCallHistorySlots와
  // 결과가 동일해 기존 경로는 건드리지 않는다(순수 추가). pine2py는 이 정확한 리터럴 폼(중간 변수
  // 없는 콜 직접 인덱싱)을 크래시로 지원 안 해(오라클 구조적 불가, C176급) 콜 결과를 top-level
  // 변수에 담아 조건부 재대입하는 동형 패턴(ctx.param() 기반)으로 hand-verified 확인했다(scratch
  // c671 조사 — 정확히 이 압축 시맨틱을 보임). UDF 본문(scope.func!==null)은 범위 밖으로 유지
  // (call-site별 독립 히스토리 배선이 필요한 별도 축, next_hint로 이월).
  condCallHistorySlots: Map<Expr, number>;
  condCallHistorySlotCount: number; // $.condCallHistSlots 배열 전체 크기 — historySlotCount와 별도 카운터
  // drawing 생성자 콜(line.new/label.new/box.new/table.new 등) 결과의 인라인 히스토리 인덱싱
  // 전용(C700, wild `line.delete(line.new(...)[1])`류 "직전 도형 지우기" 관용구, index-access.ts
  // 분기 참조). condCallHistorySlots와 동일한 압축(call-count) 인덱스지만 반환값이 DrawingHandle
  // object(runtime/drawing.ts)라 Float64Array 기반 배열에 못 담아 별도 물리 배열($.condCallRefHistSlots,
  // RefSeries.push())로 분리한다. GOAL.md "drawing 객체는 no-op + 발생 카운트 기록" 원칙대로 이
  // 핸들은 어디서도 실제 렌더링 값으로 소비되지 않아 조건부/무조건 위치 구분 없이 이 압축 인덱스
  // 하나로 항상 정답(무조건 위치도 "바마다 1개 생성 = 콜마다 1개 생성"이라 bar-index와 call-count가
  // 우연히 일치). scope.func!==null(UDF 본문)은 콜사이트별 독립 슬롯 배선이 없어 범위 밖으로 유지.
  condCallRefHistorySlots: Map<Expr, number>;
  condCallRefHistorySlotCount: number; // $.condCallRefHistSlots 배열 전체 크기 — condCallHistorySlotCount와 별도 카운터
  // top-level(script 최상위, 조건부 아님) '='로 새로 선언된 이름 전체(C363, ROADMAP P4 "wild
  // 최우선 [hard]: 로컬 히스토리" (a)슬라이스) -- analyzeAssignment가 scope.func===null &&
  // scope.depth===0(codegen의 "others" top-level 문장 루프, nested=false와 정확히 대응하는 위치)
  // 일 때만 채운다. prog.locals(모든 '=' 로컬 + UDF 매개변수 + 중첩 블록 로컬까지 포함하는 평평한
  // 집합)와 달리 이 집합만 히스토리 슬롯 배정 대상 판별에 쓴다 -- 중첩 블록 '=' 로컬(JS let, 별도
  // 렉시컬 스코프)과 UDF 매개변수는 여전히 거부(GOAL.md Float64Array 슬롯 설계와 "Series 산술은
  // scalar" 원칙 양쪽과 계속 충돌하는 축이라 이번 슬라이스 범위 밖).
  topLevelLocalNames: Set<string>;
  // 히스토리 참조가 있는 top-level '=' 로컬 이름 -> $.histSlots 인덱스(C363, historySlots의 '='
  // 로컬 판. var는 slotBase(number)가 있어 varSlot으로 키를 잡지만 '=' 로컬은 GOAL.md 설계상
  // $.vars[] 슬롯 자체가 없어(JS bare `var name`으로 컴파일) 이름(string)을 직접 키로 쓴다 --
  // strategyPropHistorySlots(propName 키)와 동일한 패턴. historySlotCount는 var/strategy prop과
  // 같은 카운터를 공유(같은 $.histSlots 배열, 인덱스 공간만 나눠 쓸 뿐).
  localHistorySlots: Map<string, number>;
  // 중첩 블록(script top-level, depth>0) '=' 로컬 히스토리(C450 신규 — topLevelLocalNames가 위
  // 주석대로 depth===0만 등록해 UDF 본문(C364/C388, 깊이 무관)과 비대칭이던 것을 해소). '=' 선언이
  // if/for 등 조건부 블록 안에 있으면 여기 등록(analyzeAssignment) -- topLevelLocalNames와 이름
  // 공간을 공유하지 않는 별도 Set이라 "이 이름이 어느 축인지"가 곧 "record를 bar-종료 루프에서
  // 하는가(depth0, var 컴파일) vs 대입문 자리에서 즉시 하는가(중첩, let 컴파일)"를 가른다 -- UDF의
  // eqLocalNames/histShadowedNames와 동일한 섀도잉 검출도 이 축에 그대로 미러(아래 필드).
  nestedTopLevelEqLocalNames: Set<string>;
  // 위 nestedTopLevelEqLocalNames 중 같은 이름이 top-level에 두 번째(이상) 선언 자리를 갖거나
  // (서로 다른 중첩 블록에서 재선언, 또는 depth-0 '=' 로컬과 이름 충돌) 하면 등록(C450, FuncInfo.
  // histShadowedNames와 동일 원칙 -- record가 이름 기반이라 선언 자리가 둘 이상이면 어느 쪽을
  // 기록하는지 모호해져 히스토리 지원을 하드 에러로 거부해야 안전하다).
  nestedTopLevelHistShadowedNames: Set<string>;
  // drawing 핸들(line/label/box/table 등) 값을 담은 top-level '=' 로컬 히스토리(배치25 (1), wild
  // "히스토리 인덱스는 drawing 핸들 로컬 미지원" 3형제 클러스터 중 top-level 슬라이스). GOAL.md
  // 드로잉 핸들은 no-op+카운트뿐인 "죽은 채널"(runtime/drawing.ts)이라 값 자체는 어디서도
  // 관측되지 않지만, `line.delete(myLine[1])`류로 과거 바의 핸들 참조를 다시 넘기는 실사용 패턴은
  // 지원해야 한다. Float64Array 기반 histSlots는 참조를 못 담아 별도 object 원형 버퍼
  // ($.refHistSlots, series.ts RefSeries)를 신설. UDF 내부(var/'=' 로컬) 축은 C541부터 콜사이트별
  // __refHistBase 전파(funcRefHistBases, FuncInfo.localRefHistSlots)로 지원 — 매개변수 축만 wild
  // 실측 0건이라 하드 에러 유지. 중첩 블록(depth>0) 축은 C714부터 아래 ambiguousNestedRefDeclSlots로
  // 통합(이름이 아니라 대입문 노드로 키잉 — 바로 아래 주석 참조).
  refHistorySlots: Map<string, number>;
  refHistorySlotCount: number; // $.refHistSlots 배열 전체 크기 — historySlotCount와 별도 카운터
  // 중첩 블록(script top-level, depth>0) '=' 로컬 히스토리(C450 신규, C714부터 이름이 아니라 대입문
  // 노드로 슬롯을 키잉 — 원래는 nestedLocalHistorySlots/nestedRefHistorySlots라는 이름 키 Map
  // 이었으나, 이름 하나당 슬롯 하나뿐인 구조라 wild
  // `if timeframe.period=='15'\n    m15midline=line.new(...)\n    line.delete(m15midline[1])`류
  // (형제 if 블록마다 독립적으로 같은 이름을 '='로 선언 — LIMITATIONS C369 "TV는 섀도우 로컬의 독립
  // 시리즈"로 이미 확정된 시맨틱)를 전부 "섀도잉돼 모호함" 하드 에러로 거부했다. 각 선언은 자신의
  // JS `let` 블록 스코프에 갇혀 있고 그 블록 밖에서는 애초에 참조가 안 되므로 "선언 자리(Assignment
  // 노드) 단위로 독립 슬롯"이 정답 — 이름이 아니라 선언 AST 노드로 키를 잡아 스코프 조상 관계로
  // 무모호하게 매칭한다(index-access.ts resolveAmbiguousNestedEqLocalDeclStmt, 선언이 하나뿐인
  // 흔한 경우도 이 경로로 통일 — 결과는 동일하고 처리 순서 의존성만 사라진다). Decl 맵(대입 즉시
  // record, 물리 슬롯 배정)과 Read 맵(그 읽기 지점이 어느 slot을 참조하는지, analyzeIndexAccess가
  // 1회 확정)으로 나뉘며 카운터는 각각 historySlotCount/refHistorySlotCount를 공유(같은 물리 배열,
  // 인덱스 공간만 나눠 씀). 여러 선언 중 정확히 하나만 읽기 지점의 조상 스코프일 수 있으므로(형제
  // 블록은 서로의 조상이 아님) 항상 무모호 — 읽기 지점이 어느 선언의 자손도 아니면(예: 선언 블록
  // 밖) 여전히 하드 에러.
  ambiguousNestedHistDeclSlots: Map<Assignment, number>;
  ambiguousNestedHistReadSlots: Map<Expr, number>;
  ambiguousNestedRefDeclSlots: Map<Assignment, number>;
  ambiguousNestedRefReadSlots: Map<Expr, number>;
  // C748: 위 ambiguousNestedHist*/Ref* 쌍의 튜플 디스트럭처 판 — Assignment는 이름 하나당 노드 하나뿐
  // (declStmt 자체가 무모호 키)이지만 TupleDestructure는 한 노드가 여러 이름을 동시에 선언해 노드만으로
  // 키잉하면 같은 문장의 서로 다른 원소끼리 슬롯이 섞인다(예: `[_h, _l] = request.security(...)`에서
  // `_h[1]`과 `_l[1]`이 별개 슬롯이어야 함) — declStmt -> (이름 -> 슬롯) 2단 맵으로 원소별 독립.
  // Read 맵은 이름과 무관하게 읽기 지점(Expr)마다 슬롯 하나만 확정되므로 기존 ambiguousNestedHistReadSlots/
  // ambiguousNestedRefReadSlots를 그대로 공유(같은 물리 배열·카운터, analyzer/index-access.ts 참조).
  ambiguousNestedTupleHistDeclSlots: Map<TupleDestructure, Map<string, number>>;
  ambiguousNestedTupleRefDeclSlots: Map<TupleDestructure, Map<string, number>>;
  // C748: nestedTopLevelEqLocalNames와 동일한 이름-키 축이지만 튜플 디스트럭처 대상 kind 판별 전용
  // (topLevelTupleElemKinds의 중첩-블록 판 — 이름별 값 표현식이 없어 name-key가 아니라 선언 노드+
  // 원소 인덱스로 저장, stmt.names와 동일 순서 배열). '_' 플레이스홀더/미등록 자리는 null(읽기 자체가
  // 폴스루 거부라 값 무관).
  nestedTupleElemKinds: Map<TupleDestructure, (string | null)[]>;
  // 중첩 top-level var(C728, LexScope.nestedVarDeclStmts 주석 참조) — 위 ambiguousNestedHist* 쌍과
  // 동일한 Decl/Read 분리 원칙이지만 대상이 '=' 히스토리 인덱싱이 아니라 var의 **모든** 읽기/쓰기다
  // (var는 매 바 상태가 $.vars[] 슬롯에 살아야 해 JS let 네이티브 스코핑으로 "공짜로" 되는 '=' 로컬과
  // 달리 모든 참조가 슬롯 조회를 거쳐야 함). nestedVarDeclSlots: 선언(VarDecl 노드) -> 물리 슬롯
  // (varSlots 배열 공유, 인덱스 공간만 나눠 씀). nestedVarReadSlots: 일반 식별자 읽기(Identifier 노드,
  // analyzeExpr가 스코프 체인으로 1회 확정) -> 슬롯. nestedVarAssignSlots: ':=' 재대입 대상
  // (Assignment 노드) -> 슬롯. func-local var 중첩(C679(c))은 이번 슬라이스 범위 밖(미착수).
  nestedVarDeclSlots: Map<VarDecl, number>;
  nestedVarReadSlots: Map<Expr, number>;
  nestedVarAssignSlots: Map<Assignment, number>;
  // C729(배치37(2) 2차 슬라이스): var를 '='로 재대입하려는 시도가 선언 스코프 자신이 아니라
  // 그 자손 스코프에서 일어나면 TV는 이를 재대입이 아니라 그 이름의 새 지역 섀도(nestedEqLocalDeclStmts,
  // C450/C714와 동일한 '=' 로컬 인프라)로 컴파일한다(tv_verdict_v2.jsonl 실측 accept, wild
  // `var float entry_price = na` 후 중첩 if 안 `entry_price = (close+high)/2`류) — C679(a)가 UDF 본문
  // 전용으로 이미 구현해둔 원칙을 top-level 중첩 블록까지 대칭 확장한다. 문제는 genIdentifier/
  // resolveAssignTarget이 top-level(funcCtx===null)에서 이름만으로 항상 program.varIndex를 먼저
  // 확인해(그 우선순위가 UDF의 paramNames/bodyLocalNames 우선순위와 달리 아예 없음) 같은 이름의 flat
  // var가 존재하면 이 섀도 읽기/재대입도 무조건 그 var 슬롯으로 오인식한다는 것 — 이 두 Set은 analyzer가
  // (resolveNestedVarOrEqLocalKind로) "이 특정 읽기/재대입 지점은 var보다 가까운 섀도가 있다"고 이미
  // 확정해둔 노드만 담아 codegen이 program.varIndex를 건너뛰고 안전하게 bare 식별자로 방출하게 한다.
  eqLocalShadowedVarReads: Set<Expr>;
  eqLocalShadowedVarAssigns: Set<Assignment>;
  // UDT 인스턴스 스칼라 필드 히스토리 obj.field[N](C523, wild "히스토리 인덱스는 식별자에만 지원"
  // 클러스터 잔여 최다 서브그룹 — b.h[1]/t.price[1]류). 키는 "수신자이름.필드이름" 문자열(둘 다
  // 점 없는 식별자라 무모호) — localHistorySlots(이름 키)와 동일한 named-저장소 축이라 같은
  // 바-종료 record 루프를 재사용한다(값의 발생원이 수신자 객체 자신이라 CallExpr류 인라인 record
  // 제약(taCallHistorySlots)이 아니라 var류 바-종료 커밋이 맞는 축, MEMORY C146 구분 기준).
  // 수신자는 top-level var/varip UDT(udtVarTypes, $.vars 슬롯) 또는 depth-0 무조건 '=' 로컬
  // (topLevelLocalNames, JS `var` 방출)만 — 바-종료 record 루프가 볼 수 있는 저장소 한정
  // (index-access.ts 분기 주석 참조). record는 수신자가 na(null)인 바에 크래시하지 않도록
  // `recv?.field`로 방출된다(undefined → Float64Array ToNumber 강제변환 = NaN, na 정합).
  udtFieldHistorySlots: Map<string, number>;
  // drawing 핸들 타입 UDT 필드 히스토리 obj.field[N](C718, wild `phl.top[1]`류 — line.new() 등으로
  // 재대입되는 UDT 필드). 위 udtFieldHistorySlots와 동일한 "수신자이름.필드이름" 키 축이지만
  // Float64Array가 아니라 top-level var 드로잉 핸들(C652)/UDT 인스턴스 var(C637)와 같은 물리
  // 배열($.refHistSlots, RefSeries)·카운터(refHistorySlotCount)를 공유한다(object를 값 종류
  // 구분 없이 담는 범용 원형 버퍼라 전용 배열을 나눌 이유가 없음, 그 두 var 케이스와 동일 원칙).
  udtFieldRefHistorySlots: Map<string, number>;
  // top-level(조건부 아님) 튜플 디스트럭처로 선언된 이름 -> 그 원소의 "히스토리 슬롯에 담을 수 없는
  // 종류" 문구(null=수치 판별, C369 히스토리 (ii)슬라이스). topLevelLocalNames의 튜플 판 + 타입
  // 가드 정보를 한 맵에 겸한다 — 튜플 이름은 '=' 로컬과 달리 값 표현식이 이름별로 없어(전체 콜
  // 하나) C363 리졸버 5종이 스코프 힌트로 못 잡으므로, 선언 시점에 원소 kind를 직접 붙여 둔다.
  // 같은 이름 재선언(C365 tupleSeen 허용 축)은 마지막 등록이 이긴다 — 바-종료 record가 읽는 값도
  // 마지막 문장의 원소이므로 (a)의 "마지막 대입 승리" 시맨틱과 일치.
  topLevelTupleElemKinds: Map<string, string | null>;
  // UDF 매개변수/내부 '=' 로컬/내부 var 히스토리(C364, ROADMAP 🔴🔴 (b)슬라이스): UDF/method
  // 콜사이트 -> 그 콜사이트 전용 $.histSlots 베이스. funcTaBases(__taBase)와 정확히 동형인 hist
  // 버전 — callee의 localHistSlotCount > 0인 콜사이트만 등록되고, 그 콜사이트가 historySlotCount에서
  // 연속 localHistSlotCount칸을 새로 배정받는다(allocateFuncCallSlots/dispatchUdtMethodCall).
  // codegen이 호출 인자 `__histBase`로 전달. forward-ref 콜사이트는 pendingFuncCallSlots 경유
  // (기존 var/ta 슬롯과 동일한 지연 배정 경로를 그대로 공유).
  funcHistBases: Map<CallExpr, number>;
  // 함수-내부 var 히스토리(localHistKinds "var")의 바 종료 record 지점용 사전 계산 목록 —
  // 콜사이트별 (histBase+relIdx, slotBase+varSlot) 절대 인덱스 쌍. '='/param과 달리 var는 호출
  // 안 된 바에도 값이 변하지 않아, top-level 바 종료 루프에서 $.fnVars를 읽어 기록하면 TV per-call
  // 압축 히스토리와 정확히 일치한다(FuncInfo.localHistKinds 주석 참조). allocateFuncCallSlots가
  // 콜사이트마다 채운다 — codegen generateCode의 record 루프가 그대로 방출.
  funcHistVarRecords: Array<{ histIdx: number; fnVarIdx: number }>;
  // UDF 내부 drawing 핸들 히스토리(배치25 (1) 잔여, C541): funcHistBases/funcHistVarRecords의
  // $.refHistSlots 판 — 콜사이트별 __refHistBase 전파와 var-kind 바 종료 record 목록이 물리 배열/
  // 카운터(refHistorySlotCount)만 다르고 완전히 동형이다(FuncInfo.localRefHistSlots 주석 참조).
  funcRefHistBases: Map<CallExpr, number>;
  funcRefHistVarRecords: Array<{ refHistIdx: number; fnVarIdx: number }>;
  // UDF 본문 안 조건부 위치 stateful 콜 압축 히스토리(C672, FuncInfo.localCondCallHistSlots 주석
  // 참조): 콜사이트 -> 그 콜사이트 전용 $.condCallHistSlots 베이스. funcHistBases와 동형이나
  // 카운터가 condCallHistorySlotCount(별도 물리 배열)이고 var-kind 바 종료 record 목록이 없다
  // (콜 자신이 유일한 값 발생원 — 항상 콜 위치 인라인 push). codegen이 호출 인자 `__condHistBase`로
  // 전달(genBaseParams/genCallExpr — __refHistBase 뒤, __secIdx 앞 순서).
  funcCondHistBases: Map<CallExpr, number>;
  // UDF 본문 안 조건부 위치 drawing 생성자 콜 압축 히스토리(C701, FuncInfo.localCondCallRefHistSlots
  // 주석 참조): 콜사이트 -> 그 콜사이트 전용 $.condCallRefHistSlots 베이스. funcCondHistBases와
  // 동형이나 카운터가 condCallRefHistorySlotCount(별도 물리 배열)다. codegen이 호출 인자
  // `__condRefHistBase`로 전달(genBaseParams/genCallExpr — __condHistBase 뒤, __secIdx 앞 순서).
  funcCondRefHistBases: Map<CallExpr, number>;
  idivBinOps: Set<BinOp>; // '/' BinOp 노드 중 두 피연산자 모두 컴파일타임에 확실히 int인 것(rt.idiv 대상)
  concatBinOps: Set<BinOp>; // '+' BinOp 노드 중 isStringExpr가 문자열로 판별한 것(rt.concat 대상, na/수치 2c-ii)
  // str.tostring(value[, format_str]) 콜사이트 중 value가 isStaticIntExpr로 확정된 것(C201,
  // LIMITATIONS.md "str.tostring int/float 갭" 근본 수정) — codegen이 rt.tostring에 isInt=true를
  // 추가 인자로 실어 기본(format_str 없음) 포맷을 pyFloatStr 대신 정수 포맷으로 낸다.
  tostringIntArgCalls: Set<CallExpr>;
  // UDT 타입명 -> 필드 목록(선언 순서, 이번 슬라이스는 float/int/bool/string/color 스칼라만).
  udtTypes: Map<string, UdtTypeInfo>;
  // top-level TypeDecl 이름 전체(C130) — analyze()가 단일 패스 시작 전 미리 훑어 채우는 사전 스캔
  // 집합. udtTypes와 달리 필드 검증 완료 여부와 무관하게 "이 프로그램에 이 이름의 type이 선언될
  // 것"만 안다 — isUdtFieldTypeAllowed가 forward-ref(아직 udtTypes에 없는 뒤쪽 선언)와 자기참조
  // (지금 막 처리 중이라 아직 udtTypes에 없는 자신)를 허용하는 근거. 충돌 검사(analyzeTypeDecl의
  // udtTypes.has 체크)는 이 집합을 쓰지 않아 기존 "먼저 선언된 쪽이 유효" 판정에 영향 없음.
  declaredTypeNames: Set<string>;
  // UDT 인스턴스를 담은 top-level var 이름 -> 그 UDT 타입명(arrayVars/mapVars/matrixVars와 완전히
  // 동일한 원칙 — 선언 시점 초기값이 `TypeName.new(...)` 콜인 좁은 구문 신호만 본다, 값 흐름
  // 추적 없음). '=' 로컬로 담긴 UDT 인스턴스는 이 추적 대상 밖(LIMITATIONS.md 참조,
  // array/map/matrix와 동일한 기존 제약 재적용).
  udtVarTypes: Map<string, string>;
  // array<UDT> 타입힌트가 명시된 top-level var 이름 -> 그 UDT 타입명(C341, udtVarTypes와 동일한
  // 순수 구조 판별 -- 초기값이 아니라 선언의 typeHint 문자열만 본다). array.get/pop/shift/first/
  // last/remove로 원소를 꺼낸 '=' 로컬이 그 UDT 필드에 접근할 수 있게 하는 최소 신호(값 흐름 추적
  // 없음 -- arrayVars와 동일하게 explicit `array<UDT>` 힌트가 없는 `var x = array.new<UDT>()`류는
  // 대상 밖, LIMITATIONS.md 참조).
  arrayElemUdtType: Map<string, string>;
  // array<label/line/box/table/linefill> typeHint 또는 array.new_box() 등 typed 생성자 콜이 명시된
  // top-level var 이름 -> 그 drawing kind(C352, arrayElemUdtType의 drawing 버전 -- 동일한 순수 구조
  // 판별 원칙). for-in 루프가 이 배열을 순회할 때 루프 변수에 drawingKindHints를 달아줘 method-call
  // sugar(`b.delete()`)를 받을 자격을 준다(analyzeForInStmt 참조). '=' 로컬은 여전히 대상 밖
  // (arrayElemUdtType과 동일한 기존 제약 재적용).
  arrayElemDrawingKind: Map<string, DrawingKind>;
  // matrix<UDT>/matrix<drawing> 원소 타입 추적(C618, arrayElemUdtType/arrayElemDrawingKind와 동일
  // 원칙 — top-level `var Ang = matrix.new<line>(...)` 제네릭 생성자 콜의 T(parser.ts가 보존한
  // DotAccess.genericElemType)만 신호로 본다, '=' 로컬 대상 밖). wild "지원하지 않는 호출: '?.delete'"
  // 서브폼(`Ang.get(row,col).delete()` — matrix.get(row,col)이 반환한 원소에 method-call sugar를
  // 곧바로 체이닝, C354 array/map 대칭축이 matrix만 비어 있었음)을 메운다.
  matrixElemUdtType: Map<string, string>;
  matrixElemDrawingKind: Map<string, DrawingKind>;
  // arrayElemUdtType/arrayElemDrawingKind의 map 버전(C684, next_hint(C683) getHighBox 축) —
  // top-level `var`가 map<K, UDT>/map<K, drawing> 컨테이너를 선언하면(명시 typeHint "map<K,V>" 또는
  // 초기값 map.new<K,V>() 생성자 콜이 보존한 V, parser.ts consumeMapNewGenericValueTypeArg) 그 값
  // 타입을 기록한다. 소비처는 resolveMapValueUdtType/resolveMapValueDrawingKind 각 하나뿐 — 지금까지
  // 이 두 리졸버는 UDT 필드 typeHint 경로(resolveUdtFieldTypeHint)만 지원해 var-name 키 추적이
  // 통째로 없던 비대칭(C500/C502 주석의 "wild 근거 부재" 유보가 배치34 대장 실측으로 해제됨).
  mapValueUdtType: Map<string, string>;
  mapValueDrawingKind: Map<string, DrawingKind>;
  // `TypeName.new(...)` 콜사이트 -> 타입명. codegen이 콜사이트별로 인자를 필드 타입에 맞춰
  // na 리터럴을 재코드젠해야 해서(genUdtValueForFieldType) builtinCalls와 별도 맵으로 둔다.
  udtConstructorCalls: Map<CallExpr, string>;
  // 중첩 UDT 필드 체이닝(C123): "UDT 필드 접근으로 확정된" DotAccess 노드 -> 그 필드의 타입명.
  // analyzeExpr(DotAccess)이 obj를 resolveUdtFieldObjectType으로 해석해 필드를 찾아낼 때마다
  // 등록하며, 그 필드 자체가 다시 UDT 타입이면(중첩) 값이 그 UDT 타입명이 되어 부모 DotAccess가
  // 한 단계 더 체이닝할 수 있는 근거가 된다(스칼라 필드면 등록하지 않아 체이닝이 자연히 멈춤).
  // codegen도 동일한 맵으로 obj가 "정적으로 UDT 타입임이 확정된 표현식"인지 판별한다. 키 타입은
  // DotAccess뿐 아니라 Expr 전체(C224) — resolveUdtObjectType(index-access.ts)이 '=' 로컬 UDT
  // Identifier의 스코프 체인 판정 결과도 이 맵에 노드 기준으로 캐싱해 codegen이 scope 체인 없이도
  // 동일한 답을 낼 수 있게 한다(이름이 아니라 노드 identity로 캐싱하므로 서로 다른 스코프의 동명
  // '=' 로컬이 있어도 충돌 없음).
  udtFieldAccessTypes: Map<Expr, string>;
  // enum 타입명 -> 멤버 목록(EnumTypeInfo 주석 참조). udtTypes와 나란한 별도 네임스페이스 —
  // `type`과 `enum`은 같은 top-level 이름 공간을 공유(analyzeEnumDecl의 충돌 검사가 udtTypes도
  // 함께 확인)하지만 값 표현이 완전히 달라(UDT=plain object, enum=문자열 상수) 별도 맵으로 둔다.
  enumTypes: Map<string, EnumTypeInfo>;
  // enum 인스턴스를 담은 top-level var 이름 -> 그 enum 타입명(C677, udtVarTypes와 나란한 enum
  // 버전). 신호는 두 종류(explicitUdtType/inferredUdtType과 동일한 우선순위 원칙): (1) 명시
  // typeHint가 등록된 enum 이름(`Timeframes tf = input.enum(...)`), (2) 초기값이
  // `input.enum(EnumType.member, ...)` 콜의 첫 위치 인자(또는 defval= 키워드)가 등록된 enum의
  // 멤버 접근일 때 그 enum 타입명(`i_timezone = input.enum(Timezones.ny, ...)`류 typeHint 생략).
  // 소비처는 resolveEnumExprType(udtVarTypes의 마지막 폴백과 동일 위치) 하나뿐 — method-call
  // sugar 수신자(`openTimeframeInput1.param()`) 판별 전용, UDT처럼 필드 접근 대상은 아니다(enum은
  // 필드가 없어 별도 맵으로 분리, udtVarTypes와 절대 공유하지 않음).
  enumVarTypes: Map<string, string>;
  // `obj.methodName(args)` 콜사이트 -> obj의 UDT 타입명(C124). codegen이 mangleMethodName(typeName,
  // callee.attr)로 실제 top-level 함수 이름을 재계산하는 데 쓴다(udtConstructorCalls와 동일 원칙 —
  // 콜사이트별로 다른 타입일 수 있어 builtinCalls와 별도 맵). slotBase 자체는 일반 UDF 콜과 동일하게
  // funcCallSlots를 그대로 공유한다(별도 맵 불필요 — analyzeUdtMethodCall 참조).
  udtMethodCallTypes: Map<CallExpr, string>;
  // arity-disjoint method 오버로드 표(C687): base mangled 이름 -> 등록된 전체 오버로드
  // (첫 선언 포함, [min,max]는 receiver 포함 arity 범위). 조회는 반드시 lookupMethodOverload
  // (udt-types.ts — analyzer/codegen 공유 순수 헬퍼)를 거칠 것. 상세는 그 함수 주석 참조.
  methodOverloads: Map<string, MethodOverloadEntry[]>;
  // MethodDecl 노드 -> 실제 prog.funcs 등록 키(base 또는 `${base}$ov$k`, C687). codegen
  // genMethodDecl이 mangleMethodName 재계산 대신 이 맵을 우선 조회해 오버로드 선언이 각자 별개
  // top-level 함수로 방출되게 한다(재계산만 쓰면 두 선언이 같은 JS 함수명으로 겹쳐 last-wins).
  methodDeclMangledNames: Map<MethodDecl, string>;
  // C688: same-arity(원소타입 판별) 오버로드 콜사이트 -> analyzer dispatch가 elemKind로 확정한
  // 실제 prog.funcs 등록 키. arity만으로는 유일 선택이 불가능한 콜사이트 전용 노드-캐시(C224) —
  // codegen은 scope 체인이 없어 receiver 원소 kind를 재유도할 수 없으므로 lookupMethodOverload가
  // node 인자로 이 맵을 최우선 조회한다(등록: call-expr.ts array extension dispatch 분기 1곳뿐).
  methodOverloadResolutions: Map<CallExpr, string>;
  // `obj.copy()` 콜사이트 -> obj의 UDT 타입명(C125, DIVERGENCES.md #57 — 컴파일러 자동 제공
  // 내장 pseudo-method, udtMethodCallTypes와 분리한 이유는 codegen이 mangleMethodName 조회 없이
  // rt.udtCopy 런타임 헬퍼로 바로 내려야 해서 디스패치 경로 자체가 다르기 때문).
  udtCopyCallTypes: Map<CallExpr, string>;
  // bare `plot(series, title)` 콜사이트 -> $.plots 배열 인덱스(C135, GOAL.md "plot은 Float64Array
  // 수집 채널" — pine2py엔 대응 없는 pine2js 자체 설계, context.plots가 선언만 되고 아무도 안 쓰는
  // 죽은 스텁임을 조사로 확인). 슬롯은 소스 등장 순서로 배정(historySlots와 동일 원칙).
  plotCallSlots: Map<CallExpr, number>;
  // 슬롯 인덱스 -> title(문자열 리터럴이 아니거나 생략되면 `Plot ${slot}` 기본값). RunResult.plots가
  // 이 순서 그대로 노출(engine.ts run() 참조) — title은 배열 키가 아니라 순수 메타데이터라 중복
  // title이어도 충돌 없음(input.*의 title 우선조회 키 매칭과는 다른 용도).
  plotTitles: string[];
  // request.security 첫 슬라이스(ROADMAP P2 [hard->분할]) — 콜사이트 -> $.securityCache 배열
  // 인덱스(slot) + 어느 OHLCV 필드를 조회할지(bare 식별자가 BAR_SERIES_NAMES 중 하나로 정적 확정
  // — 임의 표현식/hlc3 등은 이번 슬라이스 범위 밖, call-expr.ts 분기 참조). plotCallSlots(단일
  // number 값)와 달리 field까지 함께 실어야 해서 별도 맵으로 둔다. gaps/lookahead(둘째 슬라이스,
  // C177)는 kwargs로 받되 true/false 리터럴(또는 barmerge.* 상수)만 지원해 analyze-time에
  // boolean으로 확정되므로 slot 정보에 함께 실어 codegen이 리터럴로 그대로 방출한다(미지정 시
  // TV 기본값 false, C176 첫 슬라이스와 동일 동작으로 폴백).
  // multiSite(C529): tf 인자가 이 콜을 감싼 UDF의 매개변수이고 콜사이트(전원 top-level)마다 서로
  // 다른 리터럴로 접힌 경우에만 true로 세팅되는 옵션 필드 — slot은 콜사이트 수만큼 연속 배정된
  // 블록의 시작(base)이고 codegen이 `slot + __secIdx`(C453 서수 인프라 재사용)로 읽는다.
  // 미세팅(기존 등록 모양 그대로)이면 단일 고정 슬롯.
  securityCallSlots: Map<
    CallExpr,
    {
      slot: number;
      field: "open" | "high" | "low" | "close" | "volume";
      gaps: boolean;
      lookahead: boolean;
      multiSite?: true;
    }
  >;
  // C739(배치37(3) 9차 — series-arg PARAM sole 리프): UDF 본문 안 `request.security(sym, "리터럴tf",
  // bareSeries[오프셋식])` 콜사이트 — 오프셋식이 둘러싼 UDF의 매개변수 산술(매개변수/숫자 리터럴/
  // + - * /단항 -)이라 컴파일타임에도 프리패스(프리앰블 1회 실행 — per-bar 매개변수 값이 그 스코프에
  // 없음, C598 클래스)로도 확정 불가한 형태를, HTF 캐시(오프셋 무관 순수 필드 배열)에 대한 읽기-지점
  // 오프셋(runtime/security.ts getFieldHtfOffset — 리터럴 프리패스 경로와 정확 동치 증명은 그 주석)
  // 으로 지원한다. slot은 securityTfs 공유 배정(bare 콜과 동일), offsetExpr는 사용자 원본 index
  // 노드(codegen이 읽기 지점의 funcCtx로 genExpr — 매개변수가 JS 함수 인자로 그 자리에 실존).
  securityFieldOffsetCalls: Map<
    CallExpr,
    {
      slot: number;
      field: "open" | "high" | "low" | "close" | "volume";
      gaps: boolean;
      lookahead: boolean;
      offsetExpr: Expr;
    }
  >;
  // 슬롯 인덱스 -> 컴파일타임 tf 문자열 리터럴(plotTitles와 동일한 "슬롯 순서 배열" 원칙) —
  // engine.ts run()의 securityTfs 인자로 스레딩돼 Context 생성자가 콜사이트별 HTF 집계를 1회
  // 선계산하는 데 쓰인다(security.ts build() 참조). securityExprCallSlots(아래)의 슬롯도 이
  // 배열을 공유(둘 다 결국 $.securityCache[slot]의 원본 HTF OHLCV가 필요 — 3b가 그 배열을 도는
  // 프리패스로 표현식을 재계산할 예정, ROADMAP 3a/3b 설계 참조).
  securityTfs: string[];
  // 배치31 슬라이스 (a, C597) — tf가 컴파일타임 리터럴로 안 접혀도 bare series 콜사이트 +
  // simple/input 한정자(series 제외)면 하드 에러 대신 이 맵에 slot -> tf 표현식으로 등록한다.
  // securityTfs[slot]에는 자리표시 값(prog.chartTf, Context 생성자가 무해하게 즉시 빌드하도록)만
  // 넣어두고, codegen 프리앰블(바 루프 시작 전, ctx당 1회)이 이 식을 genExpr해 정확히 1회
  // evaluate한 뒤 `$.rebuildSecurityCache(slot, tf)`로 그 슬롯을 실제 값으로 다시 빌드한다
  // (runtime/context.ts 참조) — 읽기 측(securityCallSlots 소비 codegen)은 슬롯 인덱스로
  // $.securityCache[slot]을 그대로 읽으므로 리터럴 슬롯과 코드 경로가 완전히 동일해 무변경이다.
  securityRuntimeTfSlots: Map<number, Expr>;
  // request.security 셋째 슬라이스 서브슬라이스 3a(C180) — expression 인자가 BAR_SERIES_NAMES
  // bare 식별자가 아니라 "확장 좁은 표현식"(C367: ta.* 콜 0~N개 + bare/파생 시리즈 + 정수 리터럴
  // 히스토리 + 전역 유일 '=' 변수 치환, call-expr.ts buildSecurityExpr)으로 판정된 콜사이트.
  // slot은 securityTfs/securityCache 공유 배열의 인덱스(bare 슬롯과 동일한 배정 방식, 별도 카운터
  // 없음) — 이 슬롯 자신의 stateful ta.* 콜들은 이 맵이 아니라 평범한 stateCallSlots에 등록된다
  // (전역 taSlotCount 풀 공유 — C367부터 빌드된 클론 노드라 물리적으로 겹칠 수 없음, 3a 설계 메모
  // "슬롯 오프셋" 참조). codegen이 $.securityCache[slot] 원본 HTF OHLCV로 HTF 프리패스를 생성해
  // 이 표현식을 재계산한다. bodyExpr은 프리패스 함수 본문에서 genExpr할 "빌드된" 트리(치환/클론
  // 반영, buildSecurityExpr 주석 참조). key는 스칼라 콜사이트면 request.security CallExpr 자신,
  // 튜플 원소 콜사이트(아래 securityTupleCallSlots C349b)면 그 원소의 원본 Expr 노드 — 소스 위치가
  // 달라 항상 유일한 순수 핸들이다(C367: 같은 정의를 치환한 bodyExpr는 리프 공유로 노드가 겹칠 수
  // 있어 key로 못 쓴다 — codegen은 key를 조회하지 않고 값만 순회/조회한다).
  // histReads(C370, hist-on-expr): bodyExpr 안에서 "유효 서브식[정수 리터럴 n>=1]" 형태로 빌드된
  // IndexAccess 클론들(+ C601 값위치 삼항 eager 분기의 합성 n=0 래퍼, wrapSecurityEagerBranch)
  // — 배열 순서(안쪽 서브식 먼저)가 곧 프리패스 버퍼 인덱스이자 행별 fill 문 순서다. node는 bodyExpr 안에 실제로 박혀 있는 IndexAccess 클론(codegen genIndexAccess가
  // 노드 identity로 버퍼 읽기로 치환), obj는 그 클론의 자식(= 버퍼를 채울 서브식 루트 — 행마다
  // 정확히 1회 평가돼 ta 상태 전진/버퍼 기록이 동시에 일어난다). bare/파생 시리즈 obj의
  // 히스토리는 여기 등록되지 않고 기존 캐시 배열 직접 읽기 경로 그대로다(C367 출력 불변).
  securityExprCallSlots: Map<
    Expr,
    {
      slot: number;
      gaps: boolean;
      lookahead: boolean;
      bodyExpr: Expr;
      histReads: { node: IndexAccess; obj: Expr }[];
      // C738: top-level var 상태 변수 리플레이 슬라이스(SecurityVarSlice 주석 참조) — null이면
      // 기존 경로 그대로(방출 바이트 불변).
      varSlice: SecurityVarSlice | null;
    }
  >;
  // C605: 위 uniqueTopEqTuples 치환이 만든 합성 CallExpr 래퍼(codegen 전용 센티널, 원본 소스에
  // 대응 없음) → 실제 다중 반환 ta.* 클론 + 읽을 원소 index. genCallExpr이 이 맵을 stateCallSlots
  // 조회보다 먼저 확인해 `(rt.ta.XXX(...,$.taScratch), $.taScratch[index])` comma-식을 낸다 —
  // taCall 클론 자체는 이 맵에서만 참조되는 유일한 임베딩 지점이라 텍스트 중복(이중 전진) 위험이
  // 구조적으로 없다(C439/C446 계열 주석과 동일 원칙).
  securityExprTupleTaReads: Map<CallExpr, { taCall: CallExpr; index: number }>;
  // request.security 튜플 리터럴 expression 인자(C306, wild "튜플 디스트럭처링" 클러스터의
  // 최다빈도 부분집합) — `[a, b, ...] = request.security(sym, tf, [e1, e2, ...])`에서 원소마다
  // bare BAR_SERIES_NAMES 식별자 또는 스칼라 expression 경로와 동일한 확장 좁은 문법(C349b의
  // 단일 ta 콜에서 C367 buildSecurityExpr로 확장 — call-expr.ts request.security 분기 참조).
  // slot은 bare 필드 읽기가 공유하는 HTF 캐시
  // (같은 symbol/tf/gaps/lookahead라 하나면 충분 — securityCallSlots의 단일 필드 버전과 동일한
  // slot 배정 방식). ta.* 콜 원소는 각자 독립된 slot(securityExprCallSlots에 별도 등록, 스칼라
  // expression 경로와 동일한 프리패스/getFromArray 메커니즘 재사용)을 갖는다 — HTF 캐시 자체를
  // 중복 fetch하는 대가로(콜사이트당 원소 수만큼, GOAL.md 원칙상 바 루프 밖 1회성 비용이라 허용)
  // securityCache/securityExprCache의 기존 "슬롯 == securityTfs 인덱스" 불변식을 건드리지 않는다.
  // fields는 튜플 원소 순서 그대로라 codegen이 $.taScratch[0..N-1]에 그 순서로 기록(ta.macd 등
  // 다중 반환 TA와 동일한 "공유 스크래치 배열" 패턴, GOAL.md "bar loop 안 할당 제로").
  // multiSite(C532): tf가 UDF 매개변수이고 콜사이트별 리터럴이 distinct일 때(C529의 튜플판) —
  // slot(bare 공유 캐시)과 expr 필드 slot이 각각 "콜사이트별 연속 블록의 시작"이 되고 codegen이
  // __secIdx(C453 서수)를 더해 읽는다. expr 필드의 프리패스는 사이트별로 securityParamExprPrepasses에
  // 등록된다(이 맵엔 블록 시작만 남음). 이 맵의 multiSite 항목은 UDF 본문 안 노드에만 등록되므로
  // __secIdx는 항상 스코프에 존재한다.
  securityTupleCallSlots: Map<
    CallExpr,
    {
      slot: number;
      fields: ({ kind: "bare"; field: "open" | "high" | "low" | "close" | "volume" } | { kind: "expr"; slot: number })[];
      gaps: boolean;
      lookahead: boolean;
      multiSite?: boolean;
    }
  >;
  // C432(wild 클러스터① 최대 하위축, bareUdfCall 269건): `[a,b,...] = request.security(sym, tf,
  // myFunc(...))` — expression 인자가 브래킷 없이 그대로 튜플 반환 UDF 호출인 폼. pine2py 직접
  // 실행 확인(오라클): wavealgo/security.py의 _resolve_expression은 8종 bare OHLCV 식별자만 실제
  // HTF 집계를 하고, 그 외(UDF 호출 포함)는 "미지원 값은 그대로 통과"로 떨어진다 — UDF는
  // request_security() 진입 전 파이썬 인자 평가 시점에 **현재(차트) 타임프레임에서 이미 실행
  // 완료**된 값이 그대로 반환값이 된다(HTF 재계산 0, docs/transpiler/architecture.md에 의도된
  // 설계로 문서화됨 — 크래시/버그 아님). pine2js는 이 오라클 시맨틱을 literal port: HTF 프리패스/
  // 캐시를 전혀 만들지 않고 symbol/timeframe/gaps/lookahead 인자는 (기존 gaps/lookahead 파싱/검증
  // 흐름은 그대로 거치되) 계산에서 완전히 discard, UDF 콜을 마치 request.security 없이 그 자리에서
  // 직접 호출한 것과 동일하게 codegen한다. key는 request.security CallExpr(stmt.value) 자신, value는
  // 그 3번째 인자인 UDF CallExpr 노드(analyzeTupleDestructure가 채우고 genTupleDestructure가
  // valueCode를 이 내부 노드에서 genExpr — 외부 request.security 노드는 codegen이 아예 보지 않음).
  securityBareUdfCallSlots: Map<CallExpr, CallExpr>;
  // C436(wild 신규 최대 서브클러스터, next_hint(C435) 클러스터② 재분류 1위 214/483): 스칼라(비튜플)
  // 대입 `x = request.security(sym, tf, myFunc(...))` — 브래킷/튜플 디스트럭처 없이 단일 반환 UDF
  // 호출을 expression에 그대로 전달하는 폼. securityBareUdfCallSlots(C432, TupleDestructure 전용)의
  // 스칼라 자매 축 — 같은 pine2py _resolve_expression literal passthrough 오라클 근거(위 주석
  // 참조, 튜플/스칼라 구분 없이 UDF 콜은 항상 그대로 통과)를 이 analyzeCallExpr(request.security
  // 분기, TupleDestructure를 거치지 않는 모든 콜사이트의 유일한 진입점)에서 직접 등록한다. key는
  // request.security CallExpr 자신, value는 그 3번째 인자 — 직접 폼(`request.security(sym,tf,
  // myFunc())`)이면 그 UDF CallExpr 자체, C442 var-subst 폼(`x=myFunc(); request.security(sym,tf,x)`)
  // 이면 원본 Identifier 그대로(치환된 내부 CallExpr을 재사용하면 그 UDF가 자신의 top-level '='
  // 대입문에서 이미 analyzeExpr/genExpr된 slotBase를 이 콜사이트가 다시 공유해 var/ta.* 상태가 매 바
  // 이중 전진한다 — call-expr.ts C442 주석 참조). codegen(genCallExpr)이 외부 request.security
  // 노드를 완전히 무시하고 이 value를 그 자리에서 genExpr한다(Identifier면 이미 계산된 변수를 그냥
  // 읽기만 함).
  securityScalarBareUdfCallSlots: Map<CallExpr, Expr>;
  // C433(wild bareTaMultiReturn 서브클러스터, next_hint(C432)): `[a,b,...] = request.security(sym,
  // tf, ta.macd(...))` — expression 인자가 브래킷 없이 그대로 다중 반환 ta.* 콜(macd/bb/kc/
  // supertrend/dmi/vwap 3-인자)인 폼. securityBareUdfCallSlots과 동일한 자매 메커니즘(pine2py
  // 직접 실행 재검증: [m,s,h]=request.security(sym,tf,ta.macd(close,12,26,9))가 합성 60바 데이터로
  // [m,s,h]=ta.macd(close,12,26,9)와 bar-by-bar 완전 일치 — request_security._resolve_expression은
  // Series가 아닌 값(튜플 포함)을 그대로 통과시켜 HTF 재계산이 아예 없음, C432와 동일 오라클 근거)
  // 이나, 분석 등록 방식이 UDF와 달라(내부 콜을 analyzeTupleDestructure가 tupleStateCalls에 먼저
  // 표시해 표준 ta dispatch/analyzeStatefulCall을 그대로 태워야 함) 별도 맵으로 분리했다(MEMORY
  // C295 "서로 다른 메커니즘을 섞지 않는다"). key/value 구조는 securityBareUdfCallSlots와 동형 —
  // key는 request.security CallExpr(stmt.value) 자신, value는 그 3번째 인자인 ta.* CallExpr 노드.
  securityBareTaCallSlots: Map<CallExpr, CallExpr>;
  // C434(wild next_hint(C433) 클러스터① 서브축 (1) security-wrapped 잔여): `[a,b,...] =
  // request.security_lower_tf(sym, tf, nestedUdf(sym))` — expression 인자가 브래킷 없이 그대로
  // 튜플 반환 UDF 콜인 폼. securityBareUdfCallSlots(request.security)와 등록 모양은 같지만 오라클
  // 시맨틱이 다르다: pine2py request_security_lower_tf(...)는 expression 하나를 그대로
  // `[expression]`(원소 1개짜리 배열)으로 감싸는 순수 스텁이라(runtime/request.ts securityLowerTf
  // 주석 참조), expression 자리에 튜플(파이썬 list/tuple)이 오면 `[tuple]`이 되어 대상 개수만큼
  // 언패킹이 애초에 불가능하다 — python 직접 실행으로 확인(`a,b,c = wa.request_security_lower_tf(...)`
  // 가 `ValueError: not enough values to unpack`로 크래시, C267[part2]/C340과 동일 급 "오라클 자체가
  // 구조적으로 불가"). 기존 스칼라 케이스가 이미 "값 1개를 원소 1개짜리 배열로 감싼다"는
  // hand-verified 규칙으로 오라클 검증까지 마쳐 있으므로(C310), 튜플 케이스는 그 규칙을 원소별로
  // 그대로 확장한다(원소마다 독립적으로 1개짜리 배열로 감싸기) — TV 공식 문서상 request.security_lower_tf에
  // 튜플 expression을 주면 원소마다 독립된 array<type>을 반환하는 것과 근사적으로 정합(진짜
  // intrabar 데이터가 없어 배열 크기가 항상 1이라는 차이만 있음, 스칼라 케이스와 동일한 근사).
  // TV 미검증 가설 — DIVERGENCES 등재. key/value 구조는 securityBareUdfCallSlots와 동형이나 codegen이
  // "외부 콜 완전 무시 후 내부 값 그대로 통과"가 아니라 "내부 UDF를 1회 호출해 각 원소를 개별
  // 배열로 재포장"하는 별개 코드 경로를 타 별도 맵으로 분리했다(MEMORY C295).
  securityLowerTfBareUdfCallSlots: Map<CallExpr, CallExpr>;
  // C434 자매 폼: `[a,b] = request.security_lower_tf(sym, tf, [e1, e2])` — expression 인자가 브래킷
  // 있는 튜플 리터럴인 폼(wild 실측 최다, `[high, low]`/`[open, high, low, close, volume]`류).
  // request.security의 TupleExpr 리터럴 경로(securityTupleCallSlots)는 HTF 캐시 taScratch 배선과
  // 얽혀 있어 재사용 불가 — security_lower_tf는 HTF 캐시 자체가 없으므로 원소 Expr 리스트를 그대로
  // 들고 있다가 codegen이 원소마다 독립적으로 genExpr + 배열 포장(securityLowerTfBareUdfCallSlots와
  // 동일한 "원소당 1개짜리 배열" 규칙)한다. key는 request.security_lower_tf CallExpr(stmt.value)
  // 자신, value는 TupleExpr.elements 그대로.
  securityLowerTfTupleElemSlots: Map<CallExpr, Expr[]>;
  // C366: request.security tf 인자 상수 전파(wild 1위 클러스터 — `tf = input.timeframe("60")` 후
  // `request.security(sym, tf, ...)` 관용구). 프로그램 전역에서 바인딩 생성이 정확히 1개(top-level
  // depth 0의 '=' 또는 var/varip 선언 — UDF param/튜플/for 루프 변수/중첩 블록 로컬이 하나라도 더
  // 있으면 부적격)이고 ':=' 재대입이 어디에도 없는 이름 중, 그 유일 대입값이 컴파일타임 상수
  // 문자열로 확정되는 것만 등재한다(analyze() 상단 prescanConstVars — TypeDecl/EnumDecl
  // prepass와 같은 층의 사전 스캔이라 소스 순서와 무관하게 ':=' 재대입을 놓치지 않고, 전역 유일성
  // 요구가 섀도잉 오해석을 원천 차단한다). 적격 값 형태: 문자열 리터럴 / timeframe.period·
  // main_period(TIMEFRAME_STRING_PROPS 폴딩, DIVERGENCES #112) / defval이 그런 상수인
  // input.timeframe·input.string·bare input 콜 / 이미 적격인 상수 변수로의 단순 체인(b = a).
  // 입력 상수는 바 루프 동안 불변이라 기존 "컴파일타임 tf 확정 → Context 생성자 HTF 집계 1회"
  // 불변식(securityTfs 주석)이 그대로 유효하다. inputCall이 non-null이면 그 값은 런타임 입력
  // 오버라이드($.inputs, title 키)로 바뀔 수 있어 — 아래 securityTfConstGuards 참조.
  constStringVars: Map<string, { literal: string; inputCall: CallExpr | null }>;
  // C367: request.security expression 변수 치환(wild 1위 클러스터 — `ma = ta.sma(close, 20)` 후
  // `request.security(sym, tf, ma)` / `len = input.int(20)` 후 `ta.sma(close, len)` 관용구)용.
  // constStringVars와 같은 사전 스캔이 만들되 자격이 더 넓다: 값 형태 판정 없이 "전역 유일
  // top-level '=' 바인딩(var/varip·UDF param·튜플·루프 변수가 하나라도 더 있으면 부적격) + ':='
  // 재대입 0"인 이름 전부를 원시 값 Expr 그대로 등재한다 — 값이 확장 좁은 문법에 맞는지는 소비
  // 시점(call-expr.ts buildSecurityExpr)에 재귀 검사한다. var/varip 유일 바인딩은 제외(eq 플래그):
  // once-only 초기화 시맨틱이라 "요청 tf 문맥에서 매 행 재평가"(TV expression 시맨틱)와 다르다.
  // line은 "정의가 security 콜보다 소스에서 앞서는가"(선언-후-사용) 검사용 — expr 경로는
  // seriesArg 서브트리를 일반 analyzeExpr로 돌리지 않아(C180 이중 소비 방지) 미선언 검출이
  // 없으므로 치환 자격에서 보수적으로 잘라야 한다.
  uniqueTopEqVars: Map<string, { value: Expr; line: number }>;
  // C605: request.security expression에서 top-level 유일 튜플 디스트럭처 대상 치환(next_hint(C604)
  // "튜플 디스트럭처 좌변" — wild `[supertrend, stDir] = ta.supertrend(...)` 후
  // `request.security(sym, tf, stDir == -1, ...)`). uniqueTopEqVars와 동일한 안전 근거(전역 유일
  // 바인딩 + 재대입 0)지만 자격 판정이 분리된 이유: TupleDestructure 대상은 원시 값이 없고 다중
  // 반환 콜의 한 원소일 뿐이라("index") RHS를 그대로 재귀 검증할 수 없다 — source(다중 반환 ta.*
  // 콜)를 이 위치 전용 확장 문법(matchSecurityExprMultiReturnTaCall)으로 재검증한 뒤 클론을
  // taCalls에 등록하고, 그 클론 결과 중 index번째 원소만 읽는 합성 노드(securityExprTupleTaReads)로
  // 대체한다.
  uniqueTopEqTuples: Map<string, { source: CallExpr; index: number; line: number }>;
  // C738: request.security expression의 top-level `var` 상태 변수 슬라이스 후보(SecurityVarSlice
  // 주석 참조). 자격(prescanConstVars): top-level persistent VarDecl 정확히 1개 + top-level 중첩
  // 블록 동명 바인딩 0개(스코프 모호) + 그 이름의 모든 top-level ':=' 재대입이 "bare Assignment
  // 또는 IfStmt 트리 안"(for/while/switch/함수 본문 경유는 부적격 — 후보 자체를 등재하지 않음).
  // value/line은 VarDecl의 초기식/라인, writeStmts는 ':='를 포함하는 top-level 문장(중복 제거,
  // 소스 순서), writeLines는 개별 ':=' 라인 전부(치환 위치-안전성 검사용), shadowFuncs는 동명
  // 매개변수/함수-로컬 바인딩을 가진 함수 이름(C526/C666과 동일 완화 — 그 함수 본문 안 참조만
  // 슬라이스 해석을 건너뛴다). 값/조건이 좁은 문법에 맞는지는 소비 시점(call-expr.ts
  // buildSecurityVarSlice)에 검사한다 — uniqueTopEqVars와 동일 원칙.
  topVarSliceCandidates: Map<
    string,
    { value: Expr; line: number; writeStmts: Stmt[]; writeLines: number[]; shadowFuncs: Set<string> }
  >;
  // 위 constStringVars 중 실제로 request.security tf 위치에서 소비됐고 출처가 input 콜인 이름만
  // (이름 → 가드 정보, 콜사이트가 여러 개라도 이름당 1회 — call-expr.ts resolveSecurityTfLiteral이
  // 등록). HTF 집계 캐시는 트랜스파일 시점의 defval로 이미 고정되므로(securityTfs → Context 생성자)
  // 런타임 입력 오버라이드가 다른 tf를 주면 변수값과 집계 tf가 어긋나는 조용한 오답이 된다 —
  // codegen이 프리앰블(ctx당 1회)에 "오버라이드 값 === 폴딩된 리터럴" 가드를 방출해 즉시 throw로
  // 전환한다(generateCode 참조). 리터럴/timeframe.period 출처는 런타임에 변할 수 없어 가드 불필요.
  // C513: tf 삼항 조건 폴딩에 소비된 input.bool 상수도 같은 가드가 필요해 literal이 boolean일 수
  // 있다(resolveSecurityTfTernaryCondition Identifier 분기가 등록 — 조건 폴딩 결과가 tf 확정에
  // 관여하므로 그 bool 입력의 오버라이드도 동일하게 집계 tf를 어긋나게 한다).
  // C707: gaps=/lookahead= kwarg 값이 변수/삼항 경유로 폴딩될 때도 동일 메커니즘을 그대로 재사용
  // (resolveSecurityBooleanKwarg가 resolveSecurityTfTernaryCondition을 호출 — 이름은 tf 전용이지만
  // 실제로는 "컴파일타임 boolean 조건 폴딩" 범용 헬퍼). codegen 가드 메시지는 tf 전용 문구를
  // "HTF 관련 인자" 범용 문구로 일반화됨(codegen.ts generateCode 참조).
  // C735: 세션 문자열 조립 산술(resolveSecurityNumericConst)에 소비된 input.int/float 상수도 동일
  // 가드가 필요해 literal이 number일 수 있다(JSON.stringify(number)가 숫자 리터럴을 그대로 내
  // codegen 가드 방출은 변경 없음).
  securityTfConstGuards: Map<string, { literal: string | boolean | number; inputCall: CallExpr }>;
  // C526: constStringVars/uniqueTopEqVars 주석 참조 — 이름이 top-level 상수로 등재됐지만 어떤
  // FuncDecl/MethodDecl의 매개변수로도 동명 재사용되면 그 함수 이름 집합(prescanConstVars.shadowFuncs
  // 그대로 전달). call-expr.ts의 resolveSecurityTfLiteral류가 현재 참조가 그 함수들 중 하나의 본문
  // 안인지(scope.func?.name/funcName) 대조해 진짜 섀도잉일 때만 상수 치환을 건너뛴다.
  constVarShadowFuncs: Map<string, Set<string>>;
  // C623(next_hint(C622)): uniqueTopEqVars의 함수-로컬판(prescanConstVars.funcLocalUniqueEq 그대로
  // 전달) — outer key는 그 바인딩이 속한 UDF/method 이름, inner는 그 함수 본문 최상위에서 정확히
  // 1번 '=' 대입(':=' 재대입 0)된 변수 이름 → 정의식. call-expr.ts resolveSecurityTfLiteral/
  // resolveSecurityRuntimeTfString의 Identifier 분기가 funcName(scope.func?.name)으로 이 맵을
  // constStringVars/uniqueTopEqVars(둘 다 top-level 전용)보다 먼저 조회한다 — top-level과 달리
  // 이름이 프로그램 전역에서 유일할 필요가 없다(그 함수 스코프 안에서만 유일하면 충분, Pine UDF는
  // 서로의 로컬을 못 봄). 최소 재현: getWeeklyPivot() `weeklyTimeframe = timeframe.isintraday ?
  // "1W" : "1M"`(0262fcc4ff17.pine).
  funcLocalUniqueEqVars: Map<string, Map<string, { value: Expr; line: number }>>;
  errors: string[];
}

// C366: constStringVars 사전 스캔(AnalyzedProgram.constStringVars 주석 참조). AST 전체를 1회
// 제네릭 워크해 이름별 "바인딩 생성" 전부(top-level/중첩 '='·var, UDF/method param, 튜플, for/
// for-in 루프 변수)와 ':=' 재대입 존재 여부를 모은 뒤, "전역 유일 top-level 바인딩 + 재대입 0"인
// 이름의 값만 상수 문자열로 폴딩 시도한다. 단일 패스(analyzeStmt)가 아니라 사전 스캔이어야 하는
// 이유: ':='가 소스상 security 콜 **뒤**에 와도 상수성이 깨지므로 소비 시점보다 먼저 전 프로그램
// 뷰가 필요하다(C130 TypeDecl/C273 EnumDecl prepass와 같은 층). 제어문-식(값 위치의 IfStmt 등)
// 안의 바인딩도 제네릭 워크가 그대로 줍는다 — 그 바인딩은 블록-로컬이라 top 후보는 아니지만
// 바인딩 카운트에는 포함돼 동명 top-level 이름을 부적격으로 만든다(보수 원칙).
function resolveConstStringExpr(expr: Expr, chartTf: string): { literal: string; inputCall: CallExpr | null } | null {
  if (expr.kind === "StringLiteral") return { literal: expr.value, inputCall: null };
  if (expr.kind === "DotAccess" && expr.obj.kind === "Identifier" && expr.obj.name === "timeframe") {
    const lit = timeframeStringPropValue(expr.attr, chartTf);
    return lit !== undefined ? { literal: lit, inputCall: null } : null;
  }
  if (expr.kind === "CallExpr") {
    const callee = expr.callee;
    const isInput =
      (callee.kind === "DotAccess" &&
        callee.obj.kind === "Identifier" &&
        callee.obj.name === "input" &&
        (callee.attr === "timeframe" || callee.attr === "string")) ||
      (callee.kind === "Identifier" && callee.name === "input");
    if (!isInput) return null;
    // defval은 위치 인자 0번 또는 defval= 키워드(C435 — 이전 "kwarg 폼은 wild 근거 없음" 주석은
    // scripts_v56 재실측으로 반증됨: security tf 클러스터 416건 중 94건이 정확히
    // `input.timeframe(defval='..', title=..)` kwarg 폼의 전역 유일 상수였다). 위치 인자가 있으면
    // 그쪽 우선 — TV에서 둘 다 지정하면 중복 에러라 애초에 유효 소스가 아니고, input 콜 자체의
    // 위치/키워드 병합 검증은 별도 경로(analyzeCallExpr input 분기)가 이미 수행한다. defval 자신도
    // 컴파일타임 상수 문자열이어야 한다(리터럴 또는 timeframe.period류 재귀 1단).
    const defval = expr.args.length > 0 ? expr.args[0]! : expr.kwargs.find((k) => k.name === "defval")?.value;
    if (defval === undefined) return null;
    if (defval.kind === "StringLiteral") return { literal: defval.value, inputCall: expr };
    if (defval.kind === "DotAccess" && defval.obj.kind === "Identifier" && defval.obj.name === "timeframe") {
      const lit = timeframeStringPropValue(defval.attr, chartTf);
      return lit !== undefined ? { literal: lit, inputCall: expr } : null;
    }
    return null;
  }
  return null;
}

// C667: input.string/input.timeframe의 defval이 다른 top-level 문자열 상수를 가리키는 Identifier인
// 폼(`pivot_time_frame = input.string(defval=AUTO, options=[AUTO, DAILY, ...])` 후 `AUTO = "Auto"`류,
// wild get_pivot_resolution() accumulator tail 관용구의 선행 조건 — next_hint(C666)가 예고한 축).
// resolveConstStringExpr는 단일식만 보는 순수 함수라 AUTO가 아직 out에 없을 수 있어(선언 순서 무관)
// 이 정보만 뽑아 qualifying 루프의 pendingChains와 나란한 별도 지연 체인으로 처리한다.
function extractInputDefvalIdentifier(expr: Expr): { defvalName: string; inputCall: CallExpr } | null {
  if (expr.kind !== "CallExpr") return null;
  const callee = expr.callee;
  const isInput =
    (callee.kind === "DotAccess" &&
      callee.obj.kind === "Identifier" &&
      callee.obj.name === "input" &&
      (callee.attr === "timeframe" || callee.attr === "string")) ||
    (callee.kind === "Identifier" && callee.name === "input");
  if (!isInput) return null;
  const defval = expr.args.length > 0 ? expr.args[0]! : expr.kwargs.find((k) => k.name === "defval")?.value;
  if (defval === undefined || defval.kind !== "Identifier") return null;
  return { defvalName: defval.name, inputCall: expr };
}

function prescanConstVars(script: Script, chartTf: string): {
  constStrings: Map<string, { literal: string; inputCall: CallExpr | null }>;
  uniqueTopEq: Map<string, { value: Expr; line: number }>;
  uniqueTopEqTuples: Map<string, { source: CallExpr; index: number; line: number }>;
  shadowFuncs: Map<string, Set<string>>;
  funcLocalUniqueEq: Map<string, Map<string, { value: Expr; line: number }>>;
  topVarSlices: Map<string, { value: Expr; line: number; writeStmts: Stmt[]; writeLines: number[]; shadowFuncs: Set<string> }>;
} {
  // eq: 이 바인딩이 매 바 재평가되는 top-level '=' Assignment 또는 fresh(non-persistent) VarDecl인가
  // (uniqueTopEqVars 자격, C606 — param/튜플/루프 변수/persistent var·varip는 false).
  // line: 선언-후-사용 검사용 소스 라인(uniqueTopEqVars 주석 참조). paramOfFunc:
  // 이 바인딩이 FuncDecl/MethodDecl의 매개변수일 때만 그 함수 이름(C526 shadowFuncs 자격 판정용 —
  // 아래 qualifying 루프 참조. 다른 바인딩 종류(튜플/for 루프/중첩 블록 '=')는 계속 undefined로 둬
  // 기존처럼 전역 부적격 처리 대상이다).
  // C666: funcOwner — 이 바인딩이 어떤 FuncDecl/MethodDecl 본문 안(중첩 블록 포함, funcTop 무관)에서
  // 만들어졌는가(top-level이면 undefined). paramOfFunc(매개변수 전용, C526)와 같은 목적의 형제
  // 필드 — 아래 qualifying 루프가 "완전히 무관한 다른 함수의 로컬 바인딩"을 top-level 등재 부적격
  // 사유에서 빼주는 대신 그 함수를 shadowFuncs에 등록한다(파라미터와 동일 완화, resolveSecurityTfLiteral
  // 소비 시점에 scope.func?.name 대조로 진짜 섀도잉만 걸러짐 — get_pivot_resolution()류 "top-level
  // 변수 = UDF콜() 결과"가 그 UDF 자신의 동명 로컬 '='/':=' 때문에 통째로 부적격 처리되던 버그, C666).
  type Binding = { top: boolean; value: Expr | null; eq: boolean; line: number; paramOfFunc?: string; funcOwner?: string };
  const bindings = new Map<string, Binding[]>();
  const reassigned = new Set<string>();
  const addBinding = (name: string, b: Binding): void => {
    const list = bindings.get(name);
    if (list === undefined) bindings.set(name, [b]);
    else list.push(b);
  };
  // C623(next_hint(C622)): uniqueTopEq의 함수-로컬판 사이드 트랙 — top-level 바인딩이 아니라
  // "정확히 1개의 UDF/method 본문 안"에서만 유일한 '=' 변수(getWeeklyPivot() `weeklyTimeframe =
  // timeframe.isintraday ? "1W" : "1M"`류, 0262fcc4ff17.pine L179 — uniqueTopEq는 top-level 전용이라
  // 이런 함수-로컬 정의를 원천적으로 못 봄)를 함수 이름으로 키잉해 별도 등재한다. funcTop: 이
  // 바인딩이 그 함수 본문 최상위(중첩 if/for/while/switch 블록 밖)에 직접 있는가 — top-level의
  // '!inBlock'과 동일 원칙(C5 let-스코핑 전제: 블록 로컬은 함수 전체로 안 샌다). 다른 함수/
  // top-level의 동명 바인딩은 완전히 무관한 별개 스코프라 안 본다(Pine UDF는 서로의 로컬을 못 보고
  // 중첩 함수 선언 자체가 없음) — 자격은 "그 함수 안에서 이 이름의 바인딩이 정확히 1개(매개변수/
  // 튜플/루프변수 포함 전부) + funcTop eq 바인딩 + 그 함수 안 어디에도 ':=' 재대입 없음"뿐이다.
  const funcBindings = new Map<string, Map<string, { eq: boolean; value: Expr | null; line: number; funcTop: boolean }[]>>();
  const addFuncBinding = (
    funcName: string,
    name: string,
    b: { eq: boolean; value: Expr | null; line: number; funcTop: boolean },
  ): void => {
    let byName = funcBindings.get(funcName);
    if (byName === undefined) {
      byName = new Map();
      funcBindings.set(funcName, byName);
    }
    const list = byName.get(name);
    if (list === undefined) byName.set(name, [b]);
    else list.push(b);
  };
  const funcReassigned = new Map<string, Set<string>>();
  // C605: uniqueTopEqTuples 전용 사이드 트랙 — 위 bindings/addBinding(TupleDestructure 대상은
  // top:false 고정, 기존 동작 불변)과 별개로, top-level TupleDestructure 대상만 "그 이름이 정확히
  // 몇 번 어디서 튜플 대상으로 등장하는가"를 센다. 최종 자격은 아래 qualifying 루프에서 (1) bindings
  // 총 항목 1개(다른 종류 바인딩 0개) + (2) 이 트랙에서 top-level 등장 정확히 1개 + non-top 등장
  // 0개로 함께 판정한다.
  const tupleTopOccurrences = new Map<string, { source: Expr; index: number; line: number }[]>();
  const tupleNonTopNames = new Set<string>();
  // 제네릭 워크(프로퍼티 전수 순회) — AST 노드 kind를 화이트리스트하지 않아 새 문법이 추가돼도
  // 바인딩을 놓치는 쪽(조용한 오답)이 아니라 줍는 쪽(과잉 카운트 → 부적격)으로만 틀린다.
  // curFunc: 이 서브트리를 감싸는 가장 가까운 FuncDecl/MethodDecl의 이름(top-level이면 null) —
  // C623 funcBindings 키잉 전용. Pine은 함수 선언을 중첩하지 않으므로 실질적으로 top-level 함수
  // 진입 시 1회만 null→decl.name으로 바뀌지만, 방어적으로 매 FuncDecl/MethodDecl 진입마다 갱신한다.
  const walk = (node: unknown, inFunc: boolean, inBlock: boolean, curFunc: string | null): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inFunc, inBlock, curFunc);
      return;
    }
    const n = node as { kind?: string } & Record<string, unknown>;
    switch (n.kind) {
      case "FuncDecl":
      case "MethodDecl": {
        const decl = n as unknown as FuncDecl | MethodDecl;
        for (const p of decl.params) {
          addBinding(p.name, { top: false, value: null, eq: false, line: decl.line, paramOfFunc: decl.name });
          addFuncBinding(decl.name, p.name, { eq: false, value: null, line: decl.line, funcTop: false });
          if (p.default !== null) walk(p.default, true, false, decl.name);
        }
        walk(decl.body, true, false, decl.name);
        return;
      }
      case "VarDecl": {
        const decl = n as unknown as VarDecl;
        // C606: persistent(var/varip)만 once-only 초기화라 eq 자격에서 계속 제외 — 타입힌트가
        // 붙은 fresh VarDecl(`string x = expr`, var 없음)은 '=' Assignment와 매 바 재평가 시맨틱이
        // 동일해(typeHint는 순수 장식, MEMORY C386) uniqueTopEqVars 자격을 그대로 준다.
        addBinding(decl.name, {
          top: !inFunc && !inBlock,
          value: decl.value,
          eq: !decl.persistent,
          line: decl.line,
          funcOwner: curFunc ?? undefined,
        });
        if (curFunc !== null)
          addFuncBinding(curFunc, decl.name, { eq: !decl.persistent, value: decl.value, line: decl.line, funcTop: !inBlock });
        walk(decl.value, inFunc, inBlock, curFunc);
        return;
      }
      case "Assignment": {
        const stmt = n as unknown as Assignment;
        if (stmt.operator === "=") {
          addBinding(stmt.name, {
            top: !inFunc && !inBlock,
            value: stmt.value,
            eq: true,
            line: stmt.line,
            funcOwner: curFunc ?? undefined,
          });
          if (curFunc !== null)
            addFuncBinding(curFunc, stmt.name, { eq: true, value: stmt.value, line: stmt.line, funcTop: !inBlock });
        } else {
          // C666: ':=' 재대입 존재 여부는 이름 하나로 전역 집계하면 완전히 무관한 다른 함수 안의
          // 재대입까지 top-level 동명 변수를 부적격 처리해버린다(Pine 함수는 서로의 로컬을 볼 수
          // 없고 top-level 변수를 함수 안에서 ':='로 재대입할 수도 없다 — 그 이름이 함수 안에서
          // ':='된다는 것 자체가 그 함수 안에 동명 로컬 선언이 반드시 있다는 뜻이므로, 아래 qualifying
          // 루프의 funcOwner 완화가 이미 그 로컬을 shadowFuncs로 커버한다). top-level(함수 밖, 중첩
          // 블록 포함) 재대입만 전역 reassigned에 반영 — 함수 안 재대입은 funcReassigned(기존,
          // 함수별 스코프)로 계속 추적.
          if (curFunc === null) reassigned.add(stmt.name);
          if (curFunc !== null) {
            const set = funcReassigned.get(curFunc) ?? new Set<string>();
            set.add(stmt.name);
            funcReassigned.set(curFunc, set);
          }
        }
        walk(stmt.value, inFunc, inBlock, curFunc);
        return;
      }
      case "TupleDestructure": {
        const stmt = n as unknown as TupleDestructure;
        const isTop = !inFunc && !inBlock;
        stmt.names.forEach((name, i) => {
          addBinding(name, { top: false, value: null, eq: false, line: stmt.line, funcOwner: curFunc ?? undefined });
          if (curFunc !== null) addFuncBinding(curFunc, name, { eq: false, value: null, line: stmt.line, funcTop: false });
          if (isTop) {
            const list = tupleTopOccurrences.get(name);
            const entry = { source: stmt.value, index: i, line: stmt.line };
            if (list === undefined) tupleTopOccurrences.set(name, [entry]);
            else list.push(entry);
          } else {
            tupleNonTopNames.add(name);
          }
        });
        walk(stmt.value, inFunc, inBlock, curFunc);
        return;
      }
      case "ForStmt": {
        const stmt = n as unknown as ForStmt;
        addBinding(stmt.varName, { top: false, value: null, eq: false, line: stmt.line, funcOwner: curFunc ?? undefined });
        if (curFunc !== null) addFuncBinding(curFunc, stmt.varName, { eq: false, value: null, line: stmt.line, funcTop: false });
        walk(stmt.start, inFunc, inBlock, curFunc);
        walk(stmt.end, inFunc, inBlock, curFunc);
        if (stmt.step !== null) walk(stmt.step, inFunc, inBlock, curFunc);
        walk(stmt.body, inFunc, true, curFunc);
        return;
      }
      case "ForInStmt": {
        const stmt = n as unknown as ForInStmt;
        addBinding(stmt.varName, { top: false, value: null, eq: false, line: stmt.line, funcOwner: curFunc ?? undefined });
        if (curFunc !== null) addFuncBinding(curFunc, stmt.varName, { eq: false, value: null, line: stmt.line, funcTop: false });
        if (stmt.indexName !== null) {
          addBinding(stmt.indexName, { top: false, value: null, eq: false, line: stmt.line, funcOwner: curFunc ?? undefined });
          if (curFunc !== null)
            addFuncBinding(curFunc, stmt.indexName, { eq: false, value: null, line: stmt.line, funcTop: false });
        }
        walk(stmt.iterable, inFunc, inBlock, curFunc);
        walk(stmt.body, inFunc, true, curFunc);
        return;
      }
      case "IfStmt":
      case "WhileStmt":
      case "SwitchStmt": {
        // 이 노드들 아래의 모든 바인딩은 블록-로컬이다('='는 Stmt 위치에만 올 수 있고, 조건식
        // 안에는 바인딩이 문법상 없음) — 서브트리 전체를 inBlock으로 내려도 top/funcTop 판정만
        // 보수적으로 좁아질 뿐 카운트는 정확하다.
        for (const key of Object.keys(n)) {
          if (key === "kind" || key === "line" || key === "col") continue;
          walk(n[key], inFunc, true, curFunc);
        }
        return;
      }
      default: {
        for (const key of Object.keys(n)) {
          if (key === "kind" || key === "line" || key === "col") continue;
          walk(n[key], inFunc, inBlock, curFunc);
        }
        return;
      }
    }
  };
  walk(script.body, false, false, null);

  // C738: top-level var 슬라이스 후보용 ':=' 기록 — 메인 walk와 독립된 소형 스캔(메인 walk에
  // topStmt/ifOnly 파라미터를 끼워 넣는 것보다 기존 카운트 경로를 전혀 안 건드리는 쪽이 안전).
  // topStmt: 이 ':='를 포함하는 top-level 문장 루트. ifOnly: topStmt 루트에서 이 지점까지의 조상이
  // 전부 IfStmt(조건/본문)뿐인가 — for/while/switch/함수 본문을 하나라도 거치면 false(슬라이스가
  // 리플레이할 수 없는 형태라 그 이름 전체를 후보에서 제외).
  const topVarWrites = new Map<string, { stmts: Stmt[]; lines: number[]; bad: boolean }>();
  const funcScopeReassigned = new Set<string>();
  const recordVarWrite = (name: string, topStmt: Stmt, line: number, ifOnly: boolean): void => {
    let w = topVarWrites.get(name);
    if (w === undefined) {
      w = { stmts: [], lines: [], bad: false };
      topVarWrites.set(name, w);
    }
    if (w.stmts[w.stmts.length - 1] !== topStmt) w.stmts.push(topStmt);
    w.lines.push(line);
    if (!ifOnly) w.bad = true;
  };
  const scanVarWrites = (node: unknown, topStmt: Stmt, ifOnly: boolean, inFunc: boolean): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) scanVarWrites(item, topStmt, ifOnly, inFunc);
      return;
    }
    const n = node as { kind?: string } & Record<string, unknown>;
    switch (n.kind) {
      case "FuncDecl":
      case "MethodDecl":
        scanVarWrites((n as unknown as FuncDecl | MethodDecl).body, topStmt, false, true);
        return;
      case "Assignment": {
        const stmt = n as unknown as Assignment;
        if (stmt.operator === ":=") {
          if (inFunc) funcScopeReassigned.add(stmt.name);
          else recordVarWrite(stmt.name, topStmt, stmt.line, ifOnly);
        }
        scanVarWrites(stmt.value, topStmt, ifOnly, inFunc);
        return;
      }
      case "ForStmt":
      case "ForInStmt":
      case "WhileStmt":
      case "SwitchStmt": {
        for (const key of Object.keys(n)) {
          if (key === "kind" || key === "line" || key === "col") continue;
          scanVarWrites(n[key], topStmt, false, inFunc);
        }
        return;
      }
      default: {
        // IfStmt 포함 — 조건식 안에는 ':='가 문법상 없어 ifOnly를 그대로 내려도 안전.
        for (const key of Object.keys(n)) {
          if (key === "kind" || key === "line" || key === "col") continue;
          scanVarWrites(n[key], topStmt, ifOnly, inFunc);
        }
        return;
      }
    }
  };
  for (const stmt of script.body) scanVarWrites(stmt, stmt, true, false);

  const out = new Map<string, { literal: string; inputCall: CallExpr | null }>();
  const uniqueTopEq = new Map<string, { value: Expr; line: number }>();
  // C526: 전역 유일 top-level 바인딩 판정을 "바인딩 총 개수 1개"에서 "top-level 바인딩 정확히 1개
  // + 그 외 바인딩은 전부 FuncDecl/MethodDecl 매개변수"로 완화 — 매개변수는 그 함수 본문 안에서만
  // 유효한 완전히 별개 스코프라 무관한 다른 함수의 동명 매개변수가 top-level 상수 자체를 부적격
  // 처리할 근거가 아니다(wild 실측: `tf = timeframe.period` 최상위 변수가 어딘가의
  // `tfToMinutes(string tf) =>` 매개변수와 이름만 겹쳐 통째로 거부되던 실제 버그). 대신 그
  // 매개변수를 선언한 함수 이름들을 shadowFuncs에 기록해두고, 소비처(call-expr.ts
  // resolveSecurityTfLiteral류)가 "지금 이 참조가 바로 그 함수 본문 안인가"(scope.func/funcName)를
  // 대조해 진짜 섀도잉일 때만 상수 치환을 건너뛴다.
  // C666: 위 완화를 매개변수뿐 아니라 "어떤 함수 본문 안에서 만들어진 모든 non-top 바인딩"
  // (funcOwner — '='/':=' 로컬 변수, 튜플/for 루프 변수 포함, 중첩 블록 깊이 무관)으로 확장한다.
  // Pine 함수는 서로의 로컬을 볼 수 없고 top-level 이름을 함수 안에서 재선언/재대입해도 그 함수
  // 안에서만 유효한 완전히 별개 스코프이므로(C5), 그 함수를 통째로 shadowFuncs에 넣어 "그 함수
  // 본문 안" 참조만 치환을 건너뛰게 하면 매개변수와 동일한 안전 근거로 top-level 등재를 부적격
  // 처리하지 않아도 된다(wild get_pivot_resolution()류 "top-level var = UDF콜() 결과" 패턴이
  // 그 UDF 자신의 동명 로컬 '='/':=' 때문에 통째로 부적격 처리되던 버그를 해소). top-level 자신의
  // 중첩 블록 '=' (funcOwner 없음, 함수 밖의 if/for/while/switch 안)만 여전히 스코프 경계가
  // 불분명해 기존처럼 전역 부적격을 유지한다(그 경우는 애초에 Pine 함수 스코프 격리가 적용되지
  // 않는 진짜 모호한 경우 — wild 근거 없음, 보수 원칙 유지).
  const shadowFuncs = new Map<string, Set<string>>();
  const pendingChains: [string, string][] = [];
  // C667: [name, defval이 가리키는 identifier 이름, 그 name 자신의 input 콜(가드 등록용)].
  const pendingInputDefvalChains: [string, string, CallExpr][] = [];
  for (const [name, list] of bindings) {
    if (reassigned.has(name)) continue;
    const topBindings = list.filter((b) => b.top);
    if (topBindings.length !== 1) continue;
    const nonTopNonParam = list.filter((b) => !b.top && b.paramOfFunc === undefined && b.funcOwner === undefined);
    if (nonTopNonParam.length > 0) continue;
    const only = topBindings[0]!;
    if (only.value === null) continue;
    const paramShadows = list.filter((b) => !b.top && (b.paramOfFunc !== undefined || b.funcOwner !== undefined));
    if (paramShadows.length > 0) {
      const set = shadowFuncs.get(name) ?? new Set<string>();
      for (const b of paramShadows) set.add(b.paramOfFunc ?? b.funcOwner!);
      shadowFuncs.set(name, set);
    }
    // C367: '=' Assignment 유일 바인딩은 값 형태와 무관하게 전부 등재(자격 판정은 소비 시점 —
    // AnalyzedProgram.uniqueTopEqVars 주석 참조). constStrings 자격(아래)과 독립 — 상수 문자열
    // 변수도 '='이면 양쪽 맵에 다 실린다(소비처가 달라 충돌 없음).
    if (only.eq) uniqueTopEq.set(name, { value: only.value, line: only.line });
    const resolved = resolveConstStringExpr(only.value, chartTf);
    if (resolved !== null) {
      out.set(name, resolved);
    } else if (only.value.kind === "Identifier") {
      pendingChains.push([name, only.value.name]);
    } else {
      const inputChain = extractInputDefvalIdentifier(only.value);
      if (inputChain !== null) pendingInputDefvalChains.push([name, inputChain.defvalName, inputChain.inputCall]);
    }
  }
  // 단순 체인(b = a) 해소 — 참조 대상이 적격 상수면 값/가드 출처를 그대로 승계한다. 선언 순서
  // 검증은 여기서 하지 않는다: 역순 참조(a보다 b가 먼저)는 어차피 단일 패스 analyzeExpr의
  // 미선언 식별자 검사가 프로그램 전체를 실패시키므로 조용한 오답 경로가 없다.
  let changed = true;
  while (changed && pendingChains.length > 0) {
    changed = false;
    for (let i = pendingChains.length - 1; i >= 0; i--) {
      const [name, ref] = pendingChains[i]!;
      const target = out.get(ref);
      if (target !== undefined) {
        out.set(name, target);
        pendingChains.splice(i, 1);
        changed = true;
      }
    }
  }
  // C667: input defval identifier 체인 — 직접 별칭(pendingChains)이 완전히 안정화된 뒤에만 조회한다
  // (AUTO가 그 자신도 별칭 체인이었을 가능성까지 커버). inputCall은 target(AUTO 등)의 출처가 아니라
  // name 자신의 input 콜을 등록한다 — 런타임 오버라이드 위험은 pivot_time_frame 선언 자체에 있다.
  for (const [name, ref, inputCall] of pendingInputDefvalChains) {
    const target = out.get(ref);
    if (target !== undefined) out.set(name, { literal: target.literal, inputCall });
  }
  // C605: uniqueTopEqTuples 자격 판정 — (1) reassigned(':=') 0회, (2) 이 이름이 non-top
  // TupleDestructure 대상으로 어디서도 다시 등장하지 않음(tupleNonTopNames), (3) top-level
  // TupleDestructure 대상으로 정확히 1번만 등장(list.length===1), (4) bindings(위 일반 트랙, 이
  // TupleDestructure case의 addBinding 호출로 항상 최소 1개 실림) 총 항목도 정확히 1개 — VarDecl/
  // Assignment/ForStmt/FuncDecl param 등 다른 어떤 종류의 바인딩도 동명으로 없어야 한다(param
  // 섀도잉 완화는 uniqueTopEq의 shadowFuncs와 달리 여기선 적용하지 않음 — 자격을 더 보수적으로
  // 좁혀도 wild 대상 파일 3개 전부 걸리지 않아 스코프 확대 불필요). (5) source가 CallExpr(다중
  // 반환 ta.* 콜만 유효 — 소비처 matchSecurityExprMultiReturnTaCall이 재검증).
  const uniqueTopEqTuples = new Map<string, { source: CallExpr; index: number; line: number }>();
  for (const [name, occurrences] of tupleTopOccurrences) {
    if (reassigned.has(name)) continue;
    if (tupleNonTopNames.has(name)) continue;
    if (occurrences.length !== 1) continue;
    const generalList = bindings.get(name);
    if (generalList === undefined || generalList.length !== 1) continue;
    const only = occurrences[0]!;
    if (only.source.kind !== "CallExpr") continue;
    uniqueTopEqTuples.set(name, { source: only.source, index: only.index, line: only.line });
  }
  // C623: 함수-로컬 unique-eq 자격 판정 — 함수별로 독립 채점(다른 함수의 동명 바인딩은 안 봄).
  const funcLocalUniqueEq = new Map<string, Map<string, { value: Expr; line: number }>>();
  for (const [funcName, byName] of funcBindings) {
    const reassignedInFunc = funcReassigned.get(funcName);
    for (const [name, list] of byName) {
      if (reassignedInFunc?.has(name)) continue;
      if (list.length !== 1) continue;
      const only = list[0]!;
      if (!only.eq || !only.funcTop || only.value === null) continue;
      let inner = funcLocalUniqueEq.get(funcName);
      if (inner === undefined) {
        inner = new Map();
        funcLocalUniqueEq.set(funcName, inner);
      }
      inner.set(name, { value: only.value, line: only.line });
    }
  }
  // C738: top-level var 슬라이스 후보 자격 판정(AnalyzedProgram.topVarSliceCandidates 주석 참조).
  // top && !eq && value!==null 은 persistent VarDecl에서만 성립한다('=' Assignment/fresh VarDecl은
  // eq=true, 매개변수/튜플/루프 변수는 top=false·value=null).
  const topVarSlices = new Map<
    string,
    { value: Expr; line: number; writeStmts: Stmt[]; writeLines: number[]; shadowFuncs: Set<string> }
  >();
  for (const [name, list] of bindings) {
    const topBindings = list.filter((b) => b.top);
    if (topBindings.length !== 1) continue;
    const only = topBindings[0]!;
    if (only.eq || only.value === null) continue;
    // top-level 중첩 블록 동명 바인딩(함수 밖 if/for 안 '='/var 재선언)은 스코프 모호 — 부적격
    // (uniqueTopEq의 nonTopNonParam 검사와 동일 원칙).
    if (list.some((b) => !b.top && b.paramOfFunc === undefined && b.funcOwner === undefined)) continue;
    // 함수 본문 안 ':=' — 그 함수의 동명 로컬 재대입(정상 섀도잉)이라도 슬라이스 리플레이가 그
    // 이름의 실행 이력을 완전하게 재현한다는 보장이 깨지므로 보수적으로 후보 제외.
    if (funcScopeReassigned.has(name)) continue;
    const w = topVarWrites.get(name);
    if (w !== undefined && w.bad) continue;
    const sliceShadow = new Set<string>();
    for (const b of list) {
      if (!b.top && (b.paramOfFunc !== undefined || b.funcOwner !== undefined))
        sliceShadow.add(b.paramOfFunc ?? b.funcOwner!);
    }
    topVarSlices.set(name, {
      value: only.value,
      line: only.line,
      writeStmts: w?.stmts ?? [],
      writeLines: w?.lines ?? [],
      shadowFuncs: sliceShadow,
    });
  }

  return { constStrings: out, uniqueTopEq, uniqueTopEqTuples, shadowFuncs, funcLocalUniqueEq, topVarSlices };
}

// 배치30 (1), C591: analyze()의 유일한 컴파일 옵션 — timeframe.* 폴딩이 접는 "차트 자신의
// 타임프레임" 문자열(TV period 표기: "1"/"60"/"D"/"W"/"M" 등). 생략 시 DEFAULT_CHART_TF("D")로
// pine2py Context.timeframe 고정 가정과 100% 동일한 기존 동작을 유지한다.
export interface AnalyzeOptions {
  chartTf?: string;
}

export function analyze(script: Script, options?: AnalyzeOptions): AnalyzedProgram {
  const chartTf = options?.chartTf ?? DEFAULT_CHART_TF;
  // C686: arity-disjoint 함수 오버로드를 AST 사전 개명으로 해소 — 다른 모든 prepass(아래
  // prescanConstVars 포함, 전부 이름 기반)보다 반드시 먼저 실행해야 전 파이프라인이 처음부터
  // 서로 다른 이름의 독립 함수만 본다(func-overloads.ts 주석 참조).
  resolveArityDisjointOverloads(script);
  // C130: 단일 패스(analyzeStmt 루프)가 시작되기 전, top-level TypeDecl 이름만 먼저 전부 훑는
  // 사전 스캔(pine2py엔 대응 없음 — pine2py는 필드 타입 검증 자체가 없어 이식 대상이 아니라 이번
  // 슬라이스가 직접 설계한 pine2js 전용 안전장치, python 직접 실행으로 pine2py가 forward-ref/
  // 자기참조 UDT 필드 둘 다 NameError로 즉시 크래시함을 확인해 오라클도 성립 불가함을 확정).
  const declaredTypeNames = new Set<string>();
  for (const stmt of script.body) {
    if (stmt.kind === "TypeDecl") declaredTypeNames.add(stmt.name);
  }
  const constVarsPrescan = prescanConstVars(script, chartTf);

  const prog: AnalyzedProgram = {
    script,
    chartTf,
    declaredTypeNames,
    varSlots: [],
    varIndex: new Map(),
    varTypeHints: new Map(),
    locals: new Set(),
    stateCallSlots: new Map(),
    taSlotCount: 0,
    tupleStateCalls: new Set(),
    funcBodyTailTupleDestructures: new Set(),
    taScratchSize: 0,
    builtinCalls: new Map(),
    methodCallReceivers: new Map(),
    forInKinds: new Map(),
    builtinConstants: new Map(),
    builtinStringConstants: new Map(),
    builtinBooleanConstants: new Map(),
    builtinRuntimeExprs: new Map(),
    builtinArrayConstants: new Set(),
    arrayVars: new Set(),
    mapVars: new Set(),
    matrixVars: new Set(),
    drawingVarKinds: new Map(),
    directives: new Set(),
    noopStmtCalls: new Set(),
    isStrategy: false,
    strategyDefaultQty: null,
    strategyPyramiding: null,
    strategyInitialCapital: null,
    strategyQtyIsPercent: false,
    strategyQtyIsCash: false,
    strategyCurrency: SYMINFO_STRING_PROPS.get("currency")!,
    stmtCalls: new Set(),
    funcs: new Map(),
    funcSingleCallSiteArgs: new Map(),
    funcAllCallSites: new Map(),
    securityParamExprPending: [],
    securityParamExprPrepasses: [],
    securityParamExprCalls: new Map(),
    funcSecIdxArgs: new Map(),
    funcCallSlots: new Map(),
    fnVarSlotCount: 0,
    pendingFuncCallSlots: [],
    pendingTupleDestructures: new Map(),
    funcTaBases: new Map(),
    varQualifiers: new Map(),
    historySlots: new Map(),
    historySlotCount: 0,
    varRefHistorySlots: new Map(),
    historyOffsets: new Map(),
    dynamicHistoryOffsets: new Set(),
    arrayIndexReads: new Set(),
    strategyPropHistorySlots: new Map(),
    topLevelLocalNames: new Set(),
    localHistorySlots: new Map(),
    nestedTopLevelEqLocalNames: new Set(),
    nestedTopLevelHistShadowedNames: new Set(),
    refHistorySlots: new Map(),
    refHistorySlotCount: 0,
    ambiguousNestedHistDeclSlots: new Map(),
    ambiguousNestedHistReadSlots: new Map(),
    ambiguousNestedRefDeclSlots: new Map(),
    ambiguousNestedRefReadSlots: new Map(),
    ambiguousNestedTupleHistDeclSlots: new Map(),
    ambiguousNestedTupleRefDeclSlots: new Map(),
    nestedTupleElemKinds: new Map(),
    nestedVarDeclSlots: new Map(),
    nestedVarReadSlots: new Map(),
    nestedVarAssignSlots: new Map(),
    eqLocalShadowedVarReads: new Set(),
    eqLocalShadowedVarAssigns: new Set(),
    udtFieldHistorySlots: new Map(),
    udtFieldRefHistorySlots: new Map(),
    topLevelTupleElemKinds: new Map(),
    funcHistBases: new Map(),
    funcHistVarRecords: [],
    funcRefHistBases: new Map(),
    funcCondHistBases: new Map(),
    funcCondRefHistBases: new Map(),
    funcRefHistVarRecords: [],
    taCallHistorySlots: new Map(),
    lazyHistCallSites: new Set(),
    condCallHistorySlots: new Map(),
    condCallHistorySlotCount: 0,
    condCallRefHistorySlots: new Map(),
    condCallRefHistorySlotCount: 0,
    idivBinOps: new Set(),
    concatBinOps: new Set(),
    tostringIntArgCalls: new Set(),
    udtTypes: new Map(),
    udtVarTypes: new Map(),
    arrayElemUdtType: new Map(),
    arrayElemDrawingKind: new Map(),
    matrixElemUdtType: new Map(),
    matrixElemDrawingKind: new Map(),
    mapValueUdtType: new Map(),
    mapValueDrawingKind: new Map(),
    udtConstructorCalls: new Map(),
    udtFieldAccessTypes: new Map(),
    udtCopyCallTypes: new Map(),
    enumTypes: new Map(),
    enumVarTypes: new Map(),
    udtMethodCallTypes: new Map(),
    methodOverloads: new Map(),
    methodDeclMangledNames: new Map(),
    methodOverloadResolutions: new Map(),
    plotCallSlots: new Map(),
    plotTitles: [],
    securityCallSlots: new Map(),
    securityFieldOffsetCalls: new Map(),
    securityTfs: [],
    securityRuntimeTfSlots: new Map(),
    securityExprCallSlots: new Map(),
    securityExprTupleTaReads: new Map(),
    securityTupleCallSlots: new Map(),
    securityBareUdfCallSlots: new Map(),
    securityScalarBareUdfCallSlots: new Map(),
    securityBareTaCallSlots: new Map(),
    securityLowerTfBareUdfCallSlots: new Map(),
    securityLowerTfTupleElemSlots: new Map(),
    constStringVars: constVarsPrescan.constStrings,
    uniqueTopEqVars: constVarsPrescan.uniqueTopEq,
    uniqueTopEqTuples: constVarsPrescan.uniqueTopEqTuples,
    topVarSliceCandidates: constVarsPrescan.topVarSlices,
    constVarShadowFuncs: constVarsPrescan.shadowFuncs,
    funcLocalUniqueEqVars: constVarsPrescan.funcLocalUniqueEq,
    securityTfConstGuards: new Map(),
    errors: [],
  };

  const globalScope: LexScope = {
    parent: null,
    depth: 0,
    kind: null,
    names: new Set(),
    qualifiers: new Map(),
    numTypeHints: new Map(),
    containerKindHints: new Map(),
    udtKindHints: new Map(),
    arrayElemUdtKindHints: new Map(),
    arrayElemDrawingKindHints: new Map(),
    mapValueUdtKindHints: new Map(),
    mapValueDrawingKindHints: new Map(),
    drawingKindHints: new Map(),
    enumKindHints: new Map(),
    matrixKindHints: new Set(),
    matrixElemUdtKindHints: new Map(),
    stringLocalHints: new Set(),
    nestedEqLocalDeclStmts: new Map(),
    nestedVarDeclStmts: new Map(),
    nestedTupleLocalNames: new Set(),
    inLoop: false,
    func: null,
  };
  // C273: EnumDecl prepass가 이제 TypeDecl prepass보다 먼저 실행된다 — UDT 필드가 enum 타입일 때
  // (`Direction dir = Direction.Flat`) 필드 타입 검증(isUdtFieldTypeAllowed)과 필드 default 값
  // 표현식 분석(`Direction.Flat`의 DotAccess가 analyzeExpr에서 enum 멤버로 인식되려면
  // prog.enumTypes.has("Direction")가 true여야 함, analyzeExpr DotAccess 케이스 참조) 둘 다
  // TypeDecl prepass 시점에 prog.enumTypes가 완전히 채워져 있어야 한다 — EnumDecl은 본문에 표현식
  // 분석이 전혀 없어(멤버는 정적 이름+title 문자열뿐) TypeDecl과 달리 "시그니처"와 "본문"의 구분
  // 자체가 없으므로 prepassEnumDecl은 항상 완전 등록이다. registerEnumMembers의 자체 충돌 검사는
  // enum-vs-enum(이 루프 안에서 먼저 등록된 다른 enum)만 판정한다 — udtTypes/funcs는 이 시점에
  // 아직 비어있어(Type/Func prepass가 이 뒤에 옴) 신뢰 불가, 그 충돌은 메인 루프가 EnumDecl의 원래
  // 소스 위치에서 checkEnumDeclConflict로 재검사한다(TypeDecl의 registerTypeDeclFields가 이미
  // 확립한 "prepass=자기 충돌만, 메인 루프=나머지 재검사" 패턴과 대칭).
  for (const stmt of script.body) {
    if (stmt.kind === "EnumDecl") prepassEnumDecl(stmt, prog);
  }
  // C233: 단일 패스가 시작되기 전, top-level TypeDecl 전부를 소스 순서대로 먼저 필드까지 완전히
  // 등록(prepassTypeDecl)해 prog.udtTypes를 미리 채운다 — declaredTypeNames(위 C130 사전 스캔)는
  // 이름만 알아 필드 타입 검증(isUdtFieldTypeAllowed)엔 충분했지만, `TypeName.new(...)` 생성자
  // 판별은 prog.udtTypes.has(namespace)라 그 type 문에 단일 패스가 도달하기 전에는 forward-reference
  // (`Point.new(...)`가 `type Point` 선언보다 스크립트 앞쪽에 오는 패턴, corpus 실측 3건)가
  // "지원하지 않는 호출"로 거부됐다(TV/pine2py 둘 다 type 선언 순서 무관 — python 직접 실행 확인,
  // PROGRESS.md C232 참조). corpus 6,926개 전수 스캔으로 UDT 필드 default가 sibling 타입의
  // `.new()`를 forward-reference하는 사례가 0건임을 확인했으므로, 소스 순서 그대로 처리해도
  // prepass 자체의 선언 순서 의존성 문제는 발생하지 않는다.
  // prepassTypeDecl은 type-vs-type 이름 충돌만 판정한다(funcs/varIndex는 이 시점에 항상
  // 비어있어 신뢰 불가) — 그 외 이름 충돌(예: 먼저 선언된 UDF와 겹치는 type 이름)은 메인 루프가
  // TypeDecl의 원래 소스 위치에서 analyzeTypeDecl(=checkTypeDeclConflict)로 재검사한다(udt-decls.ts
  // 주석 참조) — 그래서 메인 루프는 TypeDecl을 건너뛰지 않고 그대로 analyzeStmt에 흘려보낸다.
  for (const stmt of script.body) {
    if (stmt.kind === "TypeDecl") prepassTypeDecl(stmt, prog, globalScope);
  }
  // C255: TypeDecl과 동일한 이유로 top-level FuncDecl 시그니처(paramNames/requiredParamCount/
  // paramQualifiers/paramUdtTypes)도 단일 패스 전에 미리 등록한다 — corpus 6,926개 전수 스캔에서
  // 최다빈도로 발견된 "helper(close) 호출이 helper(src)=>... 선언보다 앞선다" 패턴(pine2py도
  // codegen.py _HOISTABLE_TYPES로 FuncDecl을 그대로 hoist해 지원 확인, python 직접 실행으로
  // 재확인 — 실제 TV v5 문법이지 corpus 아티팩트가 아님). TypeDecl과 달리 본문(default 표현식/
  // body statements)은 여기서 분석하지 않는다 — 함수 본문이 아직 등록되지 않은 다른 top-level var를
  // 참조할 수 있어(analyzeExpr Identifier case의 prog.varIndex.has 체크, 현재도 지원되는 패턴)
  // 본문 분석을 여기로 옮기면 그 케이스가 조용히 깨진다(prepass 시점엔 varIndex가 항상 비어있음).
  // 시그니처만 있으면 forward-ref 콜사이트의 인자 개수 검증엔 충분하고, localVarSlots/
  // localTaSlotCount(콜사이트 slotBase 배정에 필요)는 아직 모르므로 그 배정은
  // pendingFuncCallSlots로 미룬다(analyzeUserFuncCall/resolvePendingFuncCallSlots 참조).
  for (const stmt of script.body) {
    if (stmt.kind === "FuncDecl") registerFuncSignature(stmt, prog);
  }
  // C394: 콜사이트 역추론 prepass — registerFuncSignature 직후, 본문 분석 전(위 함수 주석 참조).
  prepassInferParamUdtTypesFromCallSites(script, prog);
  // C452: 유일 콜사이트 인덱싱 prepass — 마찬가지로 본문 분석 전에 스크립트 전체를 훑어야
  // 나중에 선언되는 콜사이트도 놓치지 않는다(analyzeFuncDecl이 본문을 즉시 분석하므로 메인 루프
  // 안에서 세면 그 함수보다 뒤에 오는 콜사이트를 못 봄).
  prepassIndexSingleCallSites(script, prog);
  for (const stmt of script.body) {
    analyzeStmt(stmt, prog, globalScope);
  }
  // C255: 메인 루프 종료 시점엔 모든 top-level FuncDecl 본문이 분석 완료(bodyAnalyzed=true)라
  // forward-ref 콜사이트도 이제 localVarSlots/localTaSlotCount를 안전하게 읽을 수 있다.
  resolvePendingFuncCallSlots(prog);
  // C453: udf-param 다중 콜사이트 security expression 지연 처리 — 이 시점엔 모든 top-level
  // 이름/콜사이트가 등록 완료라 콜사이트 실인자 서브트리를 안전하게 빌드할 수 있다(선언-후-사용
  // line 검사 포함). ta 클론 등록에 top-level 스코프가 필요해 globalScope를 넘긴다(전역 taSlots
  // 슬롯 배정 — 프리패스는 top-level 함수로 방출되므로 함수-상대 __taBase 참조가 있으면 안 됨).
  processPendingSecurityParamExprs(prog, globalScope);
  // C412: 정상 경로는 analyzeFuncDecl이 bodyAnalyzed=true 직후 resolvePendingTupleDestructuresFor를
  // 호출해 이미 다 비워둔다 — 여기 남아있다면 analyzeFuncDecl이 bodyAnalyzed를 세팅하기 전에 조기
  // 반환한 극히 드문 경로(이름 충돌 등, 그 자체로 이미 다른 에러가 확정된 스크립트)뿐이다. 그런
  // 스크립트도 이 튜플 디스트럭처 자신의 실패 사유를 일관되게 남긴다(방어적 마감, C255
  // pendingFuncCallSlots와 달리 이쪽은 이 시점 이후 재개할 방법이 없어 명시적으로 닫아야 한다).
  for (const list of prog.pendingTupleDestructures.values()) {
    for (const { stmt } of list) {
      prog.errors.push(`튜플 디스트럭처링의 값은 튜플을 반환하는 UDF 호출이어야 함 (L${stmt.line}:${stmt.col})`);
    }
  }
  // C267[part2]: 이 시점엔 모든 top-level FuncDecl/method의 calls 그래프가 완전히 채워져 있어
  // 재귀 사이클(직접/상호) 탐지가 안전하다 — call-expr.ts 주석 참조.
  detectRecursiveFuncCalls(prog);
  // C450의 중첩 블록 '=' 로컬 히스토리 섀도잉 사후 검사(소스 순서상 두 번째 선언이 첫 읽기보다
  // 뒤에 오면 그 읽기가 조용히 통과하던 순서의존 버그 방지용)는 C714로 불필요해졌다 —
  // index-access.ts가 이제 이름이 아니라 대입문 노드로 슬롯을 키잉해(resolveAmbiguousNestedEqLocalDeclStmt)
  // 매 읽기를 그 자리에서 무모호하게 해석하므로 처리 순서 자체가 결과에 영향을 주지 않는다.
  return prog;
}

function analyzeStmt(stmt: Stmt, prog: AnalyzedProgram, scope: LexScope): void {
  switch (stmt.kind) {
    case "VarDecl":
      analyzeVarDecl(stmt, prog, scope);
      return;
    case "Assignment":
      analyzeAssignment(stmt, prog, scope);
      return;
    case "ExprStmt":
      // 문장 위치의 bare 콜 등록(C163) — strategy.entry/close의 "문장 위치에서만" 검증이 소비.
      // analyzeExpr보다 먼저 등록해야 그 재귀 안(analyzeCallExpr)에서 이 집합을 조회할 수 있다.
      if (stmt.expr.kind === "CallExpr") prog.stmtCalls.add(stmt.expr);
      // C610(배치32(2)): 문장 위치(값 폐기)의 bare 튜플 리터럴. wild 유기적 최다 폼은 UDF 본문
      // 중간의 early-exit 가드 `if guard \n runtime.error(...) \n [na, na, na]`(if 분기 마지막
      // 튜플이 문장 값으로 폐기 — TV 공식 라이브러리 MathGeometryCurvesChaikin 실사용). pine2py도
      // bare Python 리스트 식 문장으로 방출해 평가 후 폐기(python 직접 확인) — 원소를 각각 일반
      // 값 위치(topLevel=false)로 분석하고 TupleExpr 자신은 analyzeExpr의 값 위치 하드 에러를
      // 우회한다. codegen genStmt가 원소별 폐기 문장으로 방출(할당 제로 원칙 — 배열 리터럴 금지).
      // 값이 실제 소비되는 위치(Assignment/VarDecl 우변 등)는 기존 하드 에러 유지 — TV도 거부.
      if (stmt.expr.kind === "TupleExpr") {
        for (const el of stmt.expr.elements) analyzeExpr(el, prog, scope, false);
        return;
      }
      analyzeExpr(stmt.expr, prog, scope, /* topLevel */ scope.depth === 0);
      return;
    case "IfStmt":
      analyzeIfStmt(stmt, prog, scope);
      return;
    case "WhileStmt":
      analyzeWhileStmt(stmt, prog, scope);
      return;
    case "ForStmt":
      analyzeForStmt(stmt, prog, scope);
      return;
    case "ForInStmt":
      analyzeForInStmt(stmt, prog, scope);
      return;
    case "BreakStmt":
      if (!scope.inLoop) {
        prog.errors.push(`'break'는 반복문(while/for) 안에서만 사용 가능 (L${stmt.line}:${stmt.col})`);
      }
      return;
    case "ContinueStmt":
      if (!scope.inLoop) {
        prog.errors.push(`'continue'는 반복문(while/for) 안에서만 사용 가능 (L${stmt.line}:${stmt.col})`);
      }
      return;
    case "SwitchStmt":
      analyzeSwitchStmt(stmt, prog, scope);
      return;
    case "FuncDecl":
      analyzeFuncDecl(stmt, prog, scope);
      return;
    case "TupleDestructure":
      analyzeTupleDestructure(stmt, prog, scope);
      return;
    case "TypeDecl":
      analyzeTypeDecl(stmt, prog, scope);
      return;
    case "FieldAssignment":
      analyzeFieldAssignment(stmt, prog, scope);
      return;
    case "EnumDecl":
      analyzeEnumDecl(stmt, prog, scope);
      return;
    case "MethodDecl":
      analyzeMethodDecl(stmt, prog, scope);
      return;
  }
}

// analyzeEnumDecl/analyzeTypeDecl/analyzeFieldAssignment(UDT/enum 선언 분석 3종)는
// analyzer/udt-decls.ts로 이전(analyzer.ts 파일 분할 다섯 번째 슬라이스) — 유일한 소비처인
// analyzeStmt의 dispatch는 그대로 아래에 남아 이름 그대로 import해 호출한다. analyzeMethodDecl은
// pushScope/extractQualifierFromHint/FuncInfo 의존이 추가로 발견돼 이번 슬라이스에서 제외(이월).

// [a, b] = f() — f는 마지막 문장이 TupleExpr인 UDF(func.tupleArity가 대상 개수와 일치)여야 한다.
// 각 대상 이름은 '=' 로컬과 동일하게 "새 선언"이다(pine2py는 VarDecl(var_type="tuple")로 표현,
// 여기서도 동일하게 처음 등장하는 이름으로 취급 — var로 선언된 이름 재사용은 금지). 예외: '_'는
// TV가 문서화한 "이 튜플 원소는 버린다" 플레이스홀더라 같은 문장 안에서 몇 번이든 반복 가능
// (corpus 실측: `[_, signalLine, _] = ta.macd(...)`) — codegen(genTupleDestructure)이 두 번째부터는
// 유일한 임시 이름으로 치환해 방출하므로 실제 JS 식별자 중복은 발생하지 않는다.
function analyzeTupleDestructure(stmt: TupleDestructure, prog: AnalyzedProgram, scope: LexScope): void {
  const seen = new Set<string>();
  const registeredNames: string[] = [];
  for (const name of stmt.names) {
    if (seen.has(name)) {
      if (name !== "_") {
        prog.errors.push(`튜플 디스트럭처링 대상에 같은 이름이 중복됨: '${name}' (L${stmt.line}:${stmt.col})`);
      }
      continue;
    }
    seen.add(name);
    const func = scope.func;
    const isFuncLocalVar = func !== null && func.localVarIndex.has(name);
    // C745(배치37(1)(a) 승인 잔여): analyzeAssignment의 '=' 재대입 판정(C729)과 동일한 "own-scope
    // 재선언 vs 얕은 자손 스코프의 새 섀도" 구분을 튜플 대상에도 적용한다 — 원래는 depth 무관하게
    // prog.varIndex.has(name)만 보고 무조건 거부해, 조상 스코프의 var를 nested 블록 안 튜플
    // 디스트럭처가 새로 섀도하는 정당한 wild 패턴(`if init\n [activeAnchorEnabled,...] =
    // f_init()`류, var는 depth-0 flat 선언)까지 오탐 차단했다. 진짜 충돌(같은 스코프 자신이 그 var를
    // 직접 선언 — depth-0 flat 자기 스코프 또는 nested var의 선언 스코프 자신)만 하드 에러로 남긴다.
    const nestedKind = func === null ? resolveNestedVarOrEqLocalKind(scope, name) : null;
    const isOwnScopeVarReassign =
      func === null &&
      ((scope.depth === 0 && prog.varIndex.has(name)) ||
        (nestedKind?.kind === "var" && scope.nestedVarDeclStmts.get(name) === nestedKind.decl));
    if (isFuncLocalVar || isOwnScopeVarReassign) {
      prog.errors.push(
        `var로 선언된 변수는 튜플 디스트럭처링 대상으로 재사용할 수 없음: '${name}' (L${stmt.line}:${stmt.col})`,
      );
    } else {
      // 얕은 자손 스코프에서 조상의 var를 새로 섀도하는 튜플 대상이면(nestedKind?.kind==="var"인데
      // isOwnScopeVarReassign은 false — 즉 그 var의 선언 스코프 자신이 아님) resolveNestedVarOrEqLocalKind가
      // 이후 이 이름의 읽기/재대입을 var 슬롯이 아니라 이 plain 로컬로 잡도록 등록해둔다(eq-local과
      // 동일 변형 재사용, LexScope.nestedTupleLocalNames 주석 참조).
      if (func === null && scope.depth > 0 && (nestedKind?.kind === "var" || prog.varIndex.has(name))) {
        scope.nestedTupleLocalNames.add(name);
      }
      // C668(next_hint(C667)): 튜플 디스트럭처링 대상이 이미 선언된 UDF와 이름을 공유하는 패턴
      // (wild get_pivot_resolution() `adx(dilen,adxlen)=>...;[adx,diplus,diminus]=adx(dilen,adxlen)`류,
      // 12개 wild 템플릿 파일 실측) — analyzeAssignment의 '=' 로컬-UDF명 충돌(C413/C576)과 완전히
      // 동일한 이유로 하드 에러였던 것을 완화: TV는 call-vs-value 문법(뒤따르는 괄호 유무)으로 두
      // 네임스페이스를 분리해 실제 유효한 코드다. 여기서도 하드 에러 대신 그 함수의 FuncInfo에
      // shadowedByTopLevelLocal만 세운다 — codegen(funcCodegenName)이 함수 선언과 전체 콜사이트
      // (이 튜플의 값 표현식 자신의 CallExpr 콜사이트 포함)를 항상 함께 "$fn" 접미사로 mangle해
      // 이 로컬의 raw 식별자와 절대 충돌하지 않는다. C576 선례를 따라 top-level 여부와 무관하게
      // 모든 스코프에 적용 — 좁혔다면 `[adx, b] = adx(x)`류가 nested 위치에서 `let [adx,b]=adx(x)`로
      // 내려가 avg=avg(x)(C576)와 동형인 TDZ ReferenceError로 크래시했을 것.
      const collidingFunc = prog.funcs.get(name);
      if (collidingFunc !== undefined) collidingFunc.shadowedByTopLevelLocal = true;
      scope.names.add(name);
      prog.locals.add(name);
      registeredNames.push(name);
    }
  }

  let arity: number | null = null;
  // switch/if 각 분기가 정확히 대상 개수만큼의 튜플 리터럴로 끝나는 폼(wild corpus, C410/C411 —
  // if는 switch의 형제 폼) — UDF/ta 다중반환/security 튜플과 나란한 네·다섯 번째 합법 값. codegen이
  // taScratch 없이 분기별로 직접 N개 임시변수에 대입하므로(genSwitchTupleDestructure/
  // genIfTupleDestructure) 여기서는 원소별 kind만 함께 확정해둔다.
  let ctrlFlowTupleElemKinds: (string | null)[] | null = null;
  // C685: switch/if/삼항/튜플리터럴 RHS의 원소별 컨테이너 kind(분기 합의, conflict 원소는 이미
  // null) — 아래 C649 블록(bare UDF 콜 RHS 전용, tupleUdfCalleeName 게이트)과 대칭으로
  // scope.containerKindHints에 등록해 `vol4hrArr.getActivity(...)`류 method-sugar 디스패치를 연다.
  let ctrlFlowTupleElemContainerKinds: ("array" | "map" | null)[] | null = null;
  // C412: forward-reference UDF 튜플 콜(`[a,b]=f()`가 `f()=>...` 선언보다 앞섬, wild
  // 1f4336ca1266.pine) — pendingUdfFunc가 non-null이면 이 함수의 tupleArity/
  // tupleElemNonNumericKinds/tupleElemUdtTypes를 지금 못 읽는다(registerFuncSignature prepass는
  // 시그니처만 앎, C255). 이 이름은 top-level에서만 선언 가능해 메인 루프가 반드시 나중에 그
  // FuncDecl을 방문하므로, analyzeFuncDecl이 본문 분석을 마치는 시점(bodyAnalyzed=true 직후)에
  // resolvePendingTupleDestructuresFor가 아래 3개 arity-의존 블록과 동일한 처리를 그 자리에서
  // 재개한다 — "메인 루프 종료까지" 미루지 않는 이유는 udtKindHints/topLevelTupleElemKinds가 그
  // FuncDecl 직후에 오는 이후 문장의 analyzeExpr 재귀가 곧바로 읽을 수 있는 스코프/전역 상태라서다.
  let pendingUdfFunc: FuncInfo | null = null;
  if (stmt.value.kind === "SwitchStmt") {
    const result = analyzeSwitchTupleValue(stmt.value, stmt.names.length, prog, scope);
    if (result.ok) {
      arity = stmt.names.length;
      ctrlFlowTupleElemKinds = result.elemKinds;
      ctrlFlowTupleElemContainerKinds = result.elemContainerKinds;
    }
  } else if (stmt.value.kind === "IfStmt") {
    const result = analyzeIfTupleValue(stmt.value, stmt.names.length, prog, scope);
    if (result.ok) {
      arity = stmt.names.length;
      ctrlFlowTupleElemKinds = result.elemKinds;
      ctrlFlowTupleElemContainerKinds = result.elemContainerKinds;
    }
  } else if (stmt.value.kind === "TernaryOp") {
    // switch-튜플(C410)/if-튜플(C411)의 세 번째 형제 폼(C416) — 아래 SwitchStmt/IfStmt와 동일하게
    // ctrlFlowTupleElemKinds 경로에 합류시켜 기존 배선(topLevelTupleElemKinds 등록 등)을 그대로 재사용.
    const result = analyzeTernaryTupleValue(stmt.value, stmt.names.length, prog, scope);
    if (result.ok) {
      arity = stmt.names.length;
      ctrlFlowTupleElemKinds = result.elemKinds;
      ctrlFlowTupleElemContainerKinds = result.elemContainerKinds;
    }
  } else if (stmt.value.kind === "TupleExpr") {
    // C631(next_hint(C630) 후보2 조사 파생): `[a, b] = [e1, e2]` — TV "tuple declaration" 직접
    // 리터럴 값(함수 콜 없이 브래킷 값 그대로, wild ccb3f0d6d70d.pine 최소사례 등 4파일).
    // pine2py 대조 확인: parser.py _parse_tuple_destructure가 RHS를 범용 _parse_expression으로
    // 파싱해 브래킷 리터럴을 함수콜과 동일하게 받아들이고(codegen.py TupleExpr -> Python list
    // literal), `a, b = [close, True]`가 실제 실행까지 완주함(hand-verified, request_namespace_gap
    // 표본 재조사 중 발견 — 이전엔 request_namespace_gap으로 오분류됐던 버킷의 자매 폼이었으나
    // 실제로는 별개 direct_tuple_literal 버킷, 8/10은 라이브러리 오분류로 확정된 것과 무관).
    // resolveTupleValueBranch(switch/if/삼항 분기 판별과 동일 헬퍼)의 TupleExpr 케이스를 그대로
    // 재사용 — 원소별 analyzeExpr + kind 분류(elemKinds)까지 한 번에.
    const result = resolveTupleValueBranch(stmt.value, stmt.names.length, prog, scope, "튜플 리터럴 대입");
    if (result.ok) {
      arity = stmt.names.length;
      ctrlFlowTupleElemKinds = result.elemKinds;
      ctrlFlowTupleElemContainerKinds = result.elemContainerKinds;
    }
  } else if (stmt.value.kind === "CallExpr" && stmt.value.callee.kind === "Identifier") {
    const calleeFunc = prog.funcs.get(stmt.value.callee.name);
    if (calleeFunc !== undefined && !calleeFunc.bodyAnalyzed) {
      pendingUdfFunc = calleeFunc;
    } else if (calleeFunc !== undefined) {
      arity = calleeFunc.tupleArity;
    } else if (stmt.value.args.length > 0) {
      // C659: method(receiver, ...) 형태의 bare(점 호출 아닌) method 콜(C267/C525, call-expr.ts
      // analyzeCallExpr 표준 dispatch L3411~3450)이 튜플을 반환하는 경우 — 위 plain FuncDecl 조회는
      // method가 mangleMethodName(typeName, methodName)으로 저장돼(C124) 원본 이름으로 못 찾는다.
      // method는 forward-ref 대상이 아니라 항상 bodyAnalyzed=true이므로(analyzeMethodDecl,
      // call-expr.ts:6305 주석) pendingUdfFunc 없이 바로 arity를 peek할 수 있다. 실제 콜 디스패치
      // (udtMethodCallTypes 등록 등)는 C463/C526과 동일 원칙으로 아래 공용 analyzeExpr(stmt.value)
      // 재귀가 call-expr.ts 표준 경로를 그대로 타 전담한다(이중 등록 방지) — 여기서는 순수 peek만.
      const receiverType = resolveUdtObjectType(stmt.value.args[0]!, prog, scope);
      // C687: bare 콜은 receiver가 args[0]에 이미 포함 — 제공 값 개수 그대로 오버로드 선택.
      const bareArgTotal = stmt.value.args.length + stmt.value.kwargs.length;
      const udtMethodInfo =
        receiverType !== undefined ? lookupMethodOverload(prog, receiverType, stmt.value.callee.name, bareArgTotal, stmt.value) : undefined;
      if (udtMethodInfo !== undefined) {
        arity = udtMethodInfo.tupleArity;
      } else {
        const scalarMatches = resolveScalarMethodInfo(stmt.value.callee.name, prog, bareArgTotal);
        if (scalarMatches.length === 1) arity = scalarMatches[0]!.info.tupleArity;
      }
    }
  } else if (stmt.value.kind === "CallExpr" && stmt.value.callee.kind === "DotAccess") {
    // 다중 반환 TA(ta.macd 등, TA_REGISTRY.returnArity 설정 항목) — UDF 경로와 나란한 두 번째
    // 합법 값. 아래 analyzeExpr(stmt.value) 재귀가 analyzeCallExpr의 표현식 위치 거부에 걸리지
    // 않도록 먼저 tupleStateCalls에 등록해 "튜플 값 위치"임을 표시한다(인자 검증/슬롯 등록은
    // 그 재귀의 analyzeStatefulCall이 단일 반환 TA와 동일하게 처리). C362: 반환 arity가 인자
    // 개수에 의존하는 vwap(returnArityByArgCount) 때문에 entry.returnArity 직접 읽기 대신
    // taCallReturnArity(콜사이트 인자 개수)를 거친다 — 1/2-인자 vwap(스칼라 폼)은 여기서
    // undefined라 tupleStateCalls에 등록되지 않고 아래 generic "튜플을 반환하는 호출이어야 함"
    // 에러로 떨어진다(고정 arity 항목은 동작 불변).
    const callee = stmt.value.callee;
    const namespace = callee.obj.kind === "Identifier" ? callee.obj.name : null;
    const entry = namespace === "ta" ? TA_REGISTRY[callee.attr] : undefined;
    const callArity = entry && entry.dispatch === "ta" ? taCallReturnArity(entry, stmt.value.args.length) : undefined;
    if (entry && entry.dispatch === "ta" && callArity !== undefined) {
      arity = callArity;
      prog.tupleStateCalls.add(stmt.value);
    } else if (namespace === "request" && callee.attr === "security") {
      // request.security(sym, tf, [e1, e2, ...]) 튜플 리터럴 expression 인자(C306) — ta.* 다중
      // 반환과 나란한 세 번째 합법 값. 원소별 검증(bare series 전용, 이번 슬라이스 범위)과 슬롯
      // 등록은 위와 동일하게 call-expr.ts request.security 분기가 재귀 시 수행 — 여기서는 arity만
      // (튜플 원소 개수 그대로) 먼저 확정하고 "튜플 값 위치"로 표시.
      // C431: 완전 키워드형 폼(symbol=/timeframe=/expression=, C409)에서는 세 번째 위치 인자
      // 자체가 없어(expr.args가 비거나 짧음) 이 peek이 항상 놓쳐 "튜플 디스트럭처링의 값은 튜플을
      // 반환하는 UDF 호출이어야 함" 오탐으로 떨어지던 잠재 버그(wild 25건, corpus_scan 재실측) —
      // 위치 args[2]가 없으면 kwargs의 'expression=' 값도 함께 본다. 순수 조회라 에러 push 없음:
      // 실제 검증(중복 지정 등)은 아래 analyzeExpr(stmt.value) 재귀가 타는 call-expr.ts
      // request.security 분기의 resolveSecurityLeadArgs가 그대로 전담한다.
      const seriesArg =
        stmt.value.args[2] ?? stmt.value.kwargs.find((kw) => kw.name === "expression")?.value;
      if (seriesArg !== undefined && seriesArg.kind === "TupleExpr") {
        arity = seriesArg.elements.length;
        prog.tupleStateCalls.add(stmt.value);
      } else if (seriesArg !== undefined && seriesArg.kind === "CallExpr" && seriesArg.callee.kind === "Identifier") {
        // C432: bare UDF 콜(브래킷 없이 그대로 expression에 전달) — securityBareUdfCallSlots 주석
        // 참조. resolveTupleValueBranch(L3793)의 동형 Identifier-callee 판별과 동일하게 forward-ref
        // (calleeFunc가 아직 bodyAnalyzed=false)는 대상 밖(corpus 근거 0건, 과욕 금지 C232) —
        // 미매치면 그냥 폴백해 아래 generic buildSecurityExpr 에러로 정상 거부된다. 위 top-level
        // 직접 UDF 콜 분기(L2150 `arity = calleeFunc?.tupleArity ?? null`)와 동일하게 arity는
        // stmt.names.length와 무관하게 그대로 싣는다 — 불일치는 아래 공용 "개수 불일치" 체크가
        // 더 정확한 에러 문구로 잡아준다(여기서 조건절로 걸러버리면 그 대신 "튜플을 반환하는 UDF
        // 호출이어야 함"이라는 부정확한 에러로 떨어짐).
        const calleeFunc = prog.funcs.get(seriesArg.callee.name);
        if (calleeFunc !== undefined && calleeFunc.bodyAnalyzed && calleeFunc.tupleArity !== null) {
          arity = calleeFunc.tupleArity;
          prog.tupleStateCalls.add(stmt.value);
          prog.securityBareUdfCallSlots.set(stmt.value, seriesArg);
        }
      } else if (seriesArg !== undefined && seriesArg.kind === "CallExpr" && seriesArg.callee.kind === "DotAccess") {
        // C433: bare 다중 반환 ta.* 콜(브래킷 없이 그대로 expression에 전달) —
        // securityBareTaCallSlots 주석(AnalyzedProgram 필드) 참조. 내부 콜을 tupleStateCalls에
        // 먼저 표시해두면 아래 analyzeExpr(stmt.value) 재귀가 타는 call-expr.ts request.security
        // 분기가 이 콜을 일반 analyzeExpr 경로로 넘기고(bareTaInner), 그 표준 ta dispatch가
        // tupleStateCalls.has(expr)를 보고 analyzeStatefulCall을 그대로 호출한다 — 직접
        // `[m,s,h]=ta.macd(...)`(위 L2166 분기)와 완전히 같은 등록 결과(stateCallSlots/taScratch),
        // HTF 프리패스/슬롯은 전혀 생성하지 않는다. arity는 stmt.names.length와 무관하게 그대로
        // 싣는다(불일치는 아래 공용 "개수 불일치" 체크가 더 정확한 문구로 처리, bareUdfCall과
        // 동일 원칙 — L2202~2206 주석 참조).
        const taObj = seriesArg.callee.obj;
        const taEntry = taObj.kind === "Identifier" && taObj.name === "ta" ? TA_REGISTRY[seriesArg.callee.attr] : undefined;
        const callArity =
          taEntry && taEntry.dispatch === "ta" ? taCallReturnArity(taEntry, seriesArg.args.length) : undefined;
        if (taEntry && callArity !== undefined) {
          arity = callArity;
          prog.tupleStateCalls.add(seriesArg);
          prog.securityBareTaCallSlots.set(stmt.value, seriesArg);
        }
      }
    } else if (namespace === "request" && callee.attr === "security_lower_tf") {
      // C434: request.security_lower_tf 튜플 디스트럭처 — securityLowerTfBareUdfCallSlots/
      // securityLowerTfTupleElemSlots(AnalyzedProgram 필드 주석) 참조. wild 실측 전량이 3번째
      // 위치 인자(expression=kwarg 실사용 0건, C283 큐레이션 원칙)라 위치 인자만 본다 — request.security
      // 분기와 달리 kwarg 폴백은 두지 않는다(근거 없는 확장 금지).
      const seriesArg = stmt.value.args[2];
      if (seriesArg !== undefined && seriesArg.kind === "TupleExpr") {
        arity = seriesArg.elements.length;
        prog.securityLowerTfTupleElemSlots.set(stmt.value, seriesArg.elements);
      } else if (seriesArg !== undefined && seriesArg.kind === "CallExpr" && seriesArg.callee.kind === "Identifier") {
        // bareUdfCall과 동일 원칙(forward-ref 대상 밖, arity는 무조건 그대로 실어 아래 공용
        // "개수 불일치" 체크가 더 정확한 문구로 처리하게 함).
        const calleeFunc = prog.funcs.get(seriesArg.callee.name);
        if (calleeFunc !== undefined && calleeFunc.bodyAnalyzed && calleeFunc.tupleArity !== null) {
          arity = calleeFunc.tupleArity;
          prog.securityLowerTfBareUdfCallSlots.set(stmt.value, seriesArg);
        }
      }
    } else {
      // C463: UDT method 콜(`[a,b] = w.m()`, wild INV010 회귀 픽스처) — 위 ta/request 네임스페이스
      // 전부 안 맞았고 obj가 UDT 인스턴스(또는 array-elem-반환 콜, call-expr.ts
      // resolveUdtMethodReceiverType과 동일 조합)로 확정되면 유일하게 남은 해석은 사용자 선언
      // method 호출이다. method는 forward-reference 대상이 아니라 항상 bodyAnalyzed=true로
      // 등록되므로(analyzeMethodDecl 주석) pendingUdfFunc 처리 없이 바로 tupleArity를 읽을 수
      // 있다 — Identifier-callee UDF 분기(위 L2331)와 동일하게 여기서는 arity만 peek하고 실제
      // 콜 디스패치(dispatchUdtMethodCall 슬롯 등록)는 아래 공용 analyzeExpr(stmt.value) 재귀가
      // call-expr.ts의 표준 method 콜 경로를 그대로 타게 한다(이중 등록 방지, C180과 동일 원칙).
      const receiverType = resolveUdtMethodReceiverType(callee.obj, prog, scope);
      // C687: dot-sugar 콜은 receiver(callee.obj)가 args 밖 — 제공 값 개수에 +1 해 오버로드 선택.
      const dotArgTotal = 1 + stmt.value.args.length + stmt.value.kwargs.length;
      if (receiverType !== undefined) {
        const methodInfo = lookupMethodOverload(prog, receiverType, callee.attr, dotArgTotal, stmt.value);
        if (methodInfo !== undefined) arity = methodInfo.tupleArity;
      } else {
        // C526: 위 receiverType이 UDT 인스턴스/array-elem 조합만 커버해(resolveUdtMethodReceiverType
        // 자신의 주석 참조) receiver가 컨테이너 자기 자신(array<T>/map<K,V>/matrix<T>, C327) 또는
        // 스칼라(C328)인 extension method 튜플 반환(`[x1,y1] = zz.get_x1y1(1)`류, wild 실측)은
        // 여전히 놓쳤다 — call-expr.ts analyzeCallExpr 표준 dispatch(L4056~4128/4700)와 동일한
        // receiver 판별 우선순위(array -> map -> matrix -> scalar)를 그대로 peek만 복제한다(실제
        // 슬롯 등록은 여전히 아래 공용 analyzeExpr(stmt.value) 재귀가 전담, 이중 등록 없음).
        const arrayMethod =
          resolveContainerExprKind(callee.obj, prog, scope) === "array"
            ? lookupMethodOverload(prog, "array", callee.attr, dotArgTotal, stmt.value)
            : undefined;
        const mapMethod =
          arrayMethod === undefined && resolveContainerExprKind(callee.obj, prog, scope) === "map"
            ? lookupMethodOverload(prog, "map", callee.attr, dotArgTotal, stmt.value)
            : undefined;
        const matrixMethod =
          arrayMethod === undefined && mapMethod === undefined && resolveMatrixExprKind(callee.obj, prog, scope)
            ? lookupMethodOverload(prog, "matrix", callee.attr, dotArgTotal, stmt.value)
            : undefined;
        if (arrayMethod !== undefined) {
          arity = arrayMethod.tupleArity;
        } else if (mapMethod !== undefined) {
          arity = mapMethod.tupleArity;
        } else if (matrixMethod !== undefined) {
          arity = matrixMethod.tupleArity;
        } else {
          const scalarMatches = resolveScalarMethodInfo(callee.attr, prog, dotArgTotal);
          if (scalarMatches.length === 1) arity = scalarMatches[0]!.info.tupleArity;
        }
      }
    }
  }
  // pendingUdfFunc가 non-null이면 arity를 아직 모르므로 이 즉시-에러 판정은
  // resolvePendingTupleDestructuresFor로 미룬다(위 pendingUdfFunc 선언부 주석 참조).
  if (pendingUdfFunc === null) {
    if (arity === null) {
      prog.errors.push(`튜플 디스트럭처링의 값은 튜플을 반환하는 UDF 호출이어야 함 (L${stmt.line}:${stmt.col})`);
    } else if (arity !== stmt.names.length) {
      prog.errors.push(
        `튜플 디스트럭처링 개수 불일치: 대상 ${stmt.names.length}개, 함수는 ${arity}개 반환 (L${stmt.line}:${stmt.col})`,
      );
    }
  }

  // switch/if-튜플 값은 위 analyzeSwitchTupleValue/analyzeIfTupleValue가 subject·조건/case값·분기
  // 조건/본문을 이미 전부 분석했다 — 여기서 다시 analyzeExpr(SwitchStmt/IfStmt)를 타면 그 case
  // (analyzeControlFlowOrExpr 전용 진입점 우회 방지 안전장치, analyzeExpr 끝부분 참조)가 "제어문-식은
  // var/대입문 값 위치에서만 지원"이라는 엉뚱한 에러를 낸다. TernaryOp도 동일 원칙(C416) —
  // analyzeTernaryTupleValue/resolveTupleValueBranch가 이미 condition·양쪽 분기를 전부 analyzeExpr로
  // 분석했다 — 여기서 다시 타면 tupleStateCalls에 등록해둔 CallExpr(ta.*/request.security)가
  // analyzeCallExpr을 한 번 더 통과해 상태 슬롯이 이중 등록된다(MEMORY.md C180과 동일 클래스).
  // TupleExpr도 동일 원칙(C631) — 위 resolveTupleValueBranch가 원소별로 이미 analyzeExpr를 돌렸다.
  // 여기서 stmt.value(TupleExpr 자신) 전체를 analyzeExpr에 태우면 값 위치 TupleExpr 하드 에러
  // (C610, "튜플 리터럴은 함수의 마지막 문장에서만 지원")에 걸려버린다.
  if (
    stmt.value.kind !== "SwitchStmt" &&
    stmt.value.kind !== "IfStmt" &&
    stmt.value.kind !== "TernaryOp" &&
    stmt.value.kind !== "TupleExpr"
  ) {
    analyzeExpr(stmt.value, prog, scope, false);
  }

  // UDT 인스턴스 힌트(C387, wild `[top, btm] = swings(length)` — swings() 내부에 `var swing top =
  // swing.new(...)`처럼 UDT var를 튜플로 반환하는 UDF 관용구). analyzeAssignment의 '=' 로컬
  // udtKindHints 등록(C224/C386)과 동일 원칙이지만 값 표현식이 없는 대신 FuncInfo.tupleElemUdtTypes
  // (튜플 반환 분석 시점에 원소별로 이미 확정됨)를 원소 위치로 조회한다. top-level 히스토리 게이트
  // (scope.func===null && scope.depth===0, 아래 topLevelTupleElemKinds 블록)와 달리 이 등록은 어느
  // 스코프에서든 적용된다 — udtKindHints가 원래 스코프 체인 전역 메커니즘(C224)이라 '=' 로컬과 대칭.
  // C432: bare UDF 콜이 request.security로 감싸인 경우(securityBareUdfCallSlots) — 실제 UDF 이름은
  // stmt.value.callee(DotAccess)가 아니라 등록해둔 내부 CallExpr의 callee에 있다. 아래 두 블록
  // (udtKindHints/topLevelTupleElemKinds) 모두 이 조회를 공유한다.
  const bareUdfInnerCall = stmt.value.kind === "CallExpr" ? prog.securityBareUdfCallSlots.get(stmt.value) : undefined;
  const tupleUdfCalleeName =
    stmt.value.kind === "CallExpr" && stmt.value.callee.kind === "Identifier"
      ? stmt.value.callee.name
      : bareUdfInnerCall !== undefined && bareUdfInnerCall.callee.kind === "Identifier"
        ? bareUdfInnerCall.callee.name
        : null;
  if (pendingUdfFunc === null && arity !== null && arity === stmt.names.length && tupleUdfCalleeName !== null) {
    const udfElemUdtTypes = prog.funcs.get(tupleUdfCalleeName)?.tupleElemUdtTypes;
    if (udfElemUdtTypes) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const t = udfElemUdtTypes[i];
        if (t !== null && t !== undefined) scope.udtKindHints.set(name, t);
      });
    }
    // C649: array/map 원소 kind도 위 udtKindHints와 동일하게 func 경계/depth 게이트 없이 항상
    // 등록한다(wild `[fvgDn, fvgDnLines] = fvg(-3)`류 — fvg() 내부 `var fvgDrawings =
    // array.new<box>()`를 튜플로 반환하는 관용구, 그 뒤 `if fvgDn.size() > 0`처럼 array method-call
    // sugar 수신자로 쓰임). topLevelTupleElemKinds는 array/map을 "array/map"으로 뭉뚱그리고
    // scope.func===null && scope.depth===0 게이트까지 있어(위 topLevelTupleElemKinds 블록 참조)
    // if 블록 안 튜플 디스트럭처(depth>0, wild 실측 다수)엔 못 쓰인다 — resolveContainerExprKind가
    // 우선 조회하는 scope.containerKindHints(스코프 체인 전역, C216)에 정확한 종류로 직접 등록.
    const udfElemContainerKinds = prog.funcs.get(tupleUdfCalleeName)?.tupleElemContainerKinds;
    if (udfElemContainerKinds) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const k = udfElemContainerKinds[i];
        if (k !== null && k !== undefined) scope.containerKindHints.set(name, k);
      });
    }
    // C650: array<UDT/drawing> 원소 kind도 위와 동일 원칙으로 항상 등록 — 컨테이너 kind(위 블록)만으론
    // `fvgDn.get(i).get_top()`처럼 원소 자신에 method-call sugar를 쓰는 관용구를 못 푼다(별개 축,
    // next_hint(C649)). arrayElemUdtKindHints/arrayElemDrawingKindHints는 이미 '=' 로컬 대칭 메커니즘
    // (C393/C620)이 있어 여기서도 그대로 조회 맵에 등록만 하면 resolveArrayElemUdtType/
    // resolveArrayElemDrawingKind가 자동으로 소비한다.
    const udfElemArrayUdtTypes = prog.funcs.get(tupleUdfCalleeName)?.tupleElemArrayUdtTypes;
    if (udfElemArrayUdtTypes) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const t = udfElemArrayUdtTypes[i];
        if (t !== null && t !== undefined) scope.arrayElemUdtKindHints.set(name, t);
      });
    }
    const udfElemArrayDrawingKinds = prog.funcs.get(tupleUdfCalleeName)?.tupleElemArrayDrawingKinds;
    if (udfElemArrayDrawingKinds) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const dk = udfElemArrayDrawingKinds[i];
        if (dk !== null && dk !== undefined) scope.arrayElemDrawingKindHints.set(name, dk);
      });
    }
  }

  // C685: switch/if/삼항/튜플리터럴 RHS(ctrlFlow 경로)의 원소별 컨테이너 kind도 위 C649 블록과
  // 동일 원칙(func 경계/depth 게이트 없이 스코프 체인 등록)으로 등록 — wild `[vol4hr, vol4hrArr] =
  // switch \n cond => r4hrbars.tfDraw(...) \n => tfDrawLower(...)`(분기마다 method/UDF 콜이 튜플
  // 반환) 후 `vol4hrArr.getActivity(vol4hr)`(array<float> 첫 매개변수 extension method) 관용구,
  // getActivity 패턴군 wild2 10건. 분기 간 판정이 어긋난 원소는 병합이 이미 null로 고정해 여기
  // 도달하지 않는다(mergeTupleElemContainerKinds 주석 참조).
  if (arity !== null && arity === stmt.names.length && ctrlFlowTupleElemContainerKinds !== null) {
    const registeredSet = new Set(registeredNames);
    stmt.names.forEach((name, i) => {
      if (name === "_" || !registeredSet.has(name)) return;
      const k = ctrlFlowTupleElemContainerKinds![i];
      if (k !== null && k !== undefined) scope.containerKindHints.set(name, k);
    });
  }

  // C493: request.security_lower_tf 튜플 디스트럭처 대상은 항상 array 컨테이너(C434, "원소 1개짜리
  // 배열"로 감싸인 값 — securityLowerTfTupleElemSlots/securityLowerTfBareUdfCallSlots 주석 참조).
  // wild `[atr_ar, ...] = request.security_lower_tf(...)` 뒤 곧바로 `for a in atr_ar`(같은 UDF
  // 본문, top-level 여부 무관)이 이 이름을 for-in 이터러블로 쓰는 관용구가 있는데, 이걸 인식하려면
  // resolveContainerExprKind가 scope.containerKindHints를 조회한다(analyzeAssignment의 '=' 로컬
  // 등록과 동일한 맵 — 위 udtKindHints 등록과 같은 이유로 func 경계 게이트 없이 항상 등록한다).
  // topLevelTupleElemKinds(아래 블록)는 히스토리 인덱스 차단이 목적이라 top-level 전용 게이트가
  // 있지만, 이 등록은 순수 for-in 컨테이너 판별이라 그 게이트가 필요 없다.
  if (
    pendingUdfFunc === null &&
    arity !== null &&
    arity === stmt.names.length &&
    stmt.value.kind === "CallExpr" &&
    (prog.securityLowerTfTupleElemSlots.has(stmt.value) || prog.securityLowerTfBareUdfCallSlots.has(stmt.value))
  ) {
    const registeredSet = new Set(registeredNames);
    for (const name of stmt.names) {
      if (name !== "_" && registeredSet.has(name)) scope.containerKindHints.set(name, "array");
    }
  }

  // pine2py VarDecl(var_type="tuple")과 동일하게 전체 값(호출식) 하나의 한정자를 추론해 모든
  // 대상 이름에 그대로 적용한다(원소별로 쪼개 추론하지 않음 — _visit_var_decl의 tuple 분기 이식).
  const tupleQualifier = inferQualifier(stmt.value, prog, scope);
  for (const name of registeredNames) scope.qualifiers.set(name, tupleQualifier);

  // C369(히스토리 (ii)슬라이스): top-level(조건부 아님) 튜플 이름을 히스토리 배정 대상으로 등록 —
  // analyzeAssignment의 topLevelLocalNames와 정확히 같은 게이트(scope.func===null && depth===0 ==
  // codegen top-level 문장 루프 nested=false, JS `var name` 함수 스코프라 바-종료 record 루프가
  // 이름으로 최종값을 읽을 수 있음). 원소 kind는 값 종류별로: ta.* 다중 반환/request.security 튜플
  // 리터럴(bare series)은 전 원소 수치 확정(null), UDF는 본문 분석이 확정해 둔
  // FuncInfo.tupleElemNonNumericKinds(tupleArity와 함께 설정되는 불변식 — forward-ref 콜사이트는
  // 위의 arity===null 에러로 애초에 여기 못 옴). '_' 플레이스홀더는 값이 버려지는 자리라 제외
  // (읽으면 기존 폴스루 거부). arity 불일치 등 에러 문장은 등록하지 않는다(어차피 transpile 실패).
  if (pendingUdfFunc === null) {
    if (scope.func === null && scope.depth === 0 && arity === stmt.names.length) {
      let udfElemKinds: (string | null)[] | null | undefined;
      if (tupleUdfCalleeName !== null) {
        udfElemKinds = prog.funcs.get(tupleUdfCalleeName)?.tupleElemNonNumericKinds;
      } else if (ctrlFlowTupleElemKinds !== null) {
        udfElemKinds = ctrlFlowTupleElemKinds;
      } else if (
        stmt.value.kind === "CallExpr" &&
        (prog.securityLowerTfTupleElemSlots.has(stmt.value) || prog.securityLowerTfBareUdfCallSlots.has(stmt.value))
      ) {
        // C434: request.security_lower_tf 튜플 디스트럭처의 원소는 전부 원소 1개짜리 배열로
        // 감싸인 값(securityLowerTfBareUdfCallSlots/securityLowerTfTupleElemSlots 주석 참조) —
        // Float64Array 히스토리 슬롯에 담을 수 없는 참조형이라 무조건 "array"로 확정해 history
        // 인덱스('[]') 사용을 차단한다(index-access.ts topLevelTupleElemKinds 소비 참조).
        udfElemKinds = new Array(stmt.names.length).fill("array");
      }
      const registered = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registered.has(name)) return;
        // UDF인데 원소 kind가 없으면(불변식 위반 방어) 보수적으로 거부 문구를 남긴다.
        const kind = udfElemKinds === undefined ? null : udfElemKinds === null ? "판별 불가한 타입" : (udfElemKinds[i] ?? null);
        prog.topLevelTupleElemKinds.set(name, kind);
      });
    } else if (scope.func === null && scope.depth > 0 && stmt.value.kind === "CallExpr" && arity === stmt.names.length) {
      // C748: script top-level 중첩 블록(if/for 등, depth>0) 튜플 디스트럭처 대상 히스토리 — C450/
      // C714가 '=' 로컬에 적용한 node-keying(scope.nestedEqLocalDeclStmts, 형제 블록 동명 선언도
      // 절대 안 섞임)을 튜플까지 대칭 확장(wild `if cond\n [_vwap] = computeVWAP(...)\n
      // ... := _vwap[1]`류). 값이 CallExpr일 때만 등록 — 아래 func!==null 자매 분기(C535)와 동일
      // 이유로 switch/if/삼항 튜플 형제 폼은 genFuncTupleHistRecords 주입 지점이 없다(codegen.ts
      // genTupleDestructure 참조). 원소 kind는 depth-0 블록(C369, 바로 위)과 동일한 판별이지만
      // 이름별 값 표현식이 없어 topLevelTupleElemKinds 같은 이름-키가 아니라 노드+인덱스 배열로
      // 저장해야 형제 블록의 동명 원소끼리 안 섞인다(nestedTupleElemKinds, AnalyzedProgram 주석 참조).
      let udfElemKinds: (string | null)[] | null | undefined;
      if (tupleUdfCalleeName !== null) {
        udfElemKinds = prog.funcs.get(tupleUdfCalleeName)?.tupleElemNonNumericKinds;
      } else if (ctrlFlowTupleElemKinds !== null) {
        udfElemKinds = ctrlFlowTupleElemKinds;
      } else if (
        prog.securityLowerTfTupleElemSlots.has(stmt.value) || prog.securityLowerTfBareUdfCallSlots.has(stmt.value)
      ) {
        udfElemKinds = new Array(stmt.names.length).fill("array");
      }
      const registered = new Set(registeredNames);
      const elemKinds: (string | null)[] = stmt.names.map((name, i) => {
        if (name === "_" || !registered.has(name)) return null;
        return udfElemKinds === undefined ? null : udfElemKinds === null ? "판별 불가한 타입" : (udfElemKinds[i] ?? null);
      });
      prog.nestedTupleElemKinds.set(stmt, elemKinds);
      stmt.names.forEach((name) => {
        if (name === "_" || !registered.has(name)) return;
        // 이 스코프(블록) 자신이 직접 선언했음을 기록(C714 원칙 — 조상 스코프 탐색이 JS let 가시성과
        // 동일한 안전 조건을 보장, resolveAmbiguousNestedEqLocalDeclStmt 참조). '='와 튜플이 같은
        // nestedEqLocalDeclStmts를 공유하므로 이름이 겹쳐도(재선언/섀도잉) 마지막 등록이 그 스코프의
        // 대표 선언이 된다(TV "같은 스코프 재선언" 자체는 이미 별도 하드 에러로 걸러짐, 위 참조).
        scope.nestedEqLocalDeclStmts.set(name, stmt);
        if (prog.topLevelLocalNames.has(name) || prog.nestedTopLevelEqLocalNames.has(name)) {
          prog.nestedTopLevelHistShadowedNames.add(name);
        } else {
          prog.nestedTopLevelEqLocalNames.add(name);
        }
      });
    } else if (scope.func !== null && stmt.value.kind === "CallExpr" && arity === stmt.names.length) {
      // C535: 위 top-level 블록(C369)의 UDF 본문 자매 축 — eqLocalNames(C364)가 '=' 로컬에 하는 것과
      // 동일하게, TupleDestructure 대상도 히스토리 등록 대상으로 표시한다. 값이 CallExpr일 때만(위
      // tupleUdfCalleeName/securityLowerTf 판별과 동일 조건 재사용) — switch/if/삼항 튜플 형제 폼은
      // genTupleDestructure가 아니라 별도 codegen 함수(genSwitchTupleDestructure 등)가 담당해 record
      // 주입 지점이 없으므로 등록하지 않는다(미등록 이름은 기존처럼 index-access.ts의 "UDF 본문의 '='
      // Assignment 로컬에만 지원" 하드 에러로 자연히 떨어짐 — 조용한 NaN 방지, eqLocalNames 주석 참조).
      const func = scope.func;
      let udfElemKinds: (string | null)[] | null | undefined;
      if (tupleUdfCalleeName !== null) {
        udfElemKinds = prog.funcs.get(tupleUdfCalleeName)?.tupleElemNonNumericKinds;
      } else if (
        prog.securityLowerTfTupleElemSlots.has(stmt.value) || prog.securityLowerTfBareUdfCallSlots.has(stmt.value)
      ) {
        udfElemKinds = new Array(stmt.names.length).fill("array");
      }
      const registered = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registered.has(name)) return;
        const kind = udfElemKinds === undefined ? null : udfElemKinds === null ? "판별 불가한 타입" : (udfElemKinds[i] ?? null);
        func.localTupleElemKinds.set(name, kind);
        // eqLocalNames의 histShadowedNames 충돌 검사(analyzeAssignment)와 동일 원칙 — 매개변수/기존
        // '=' 로컬/기존 튜플 로컬과 이름이 겹치면 record 대상이 모호해지므로 섀도잉으로 격리한다.
        // nestedEqLocalNames/nestedHistShadowedNames(C714 UDF 확장)도 이 이름의 기존 물리 선언
        // 축이므로 함께 검사 — 튜플 디스트럭처는 node-keying 대상이 아니라(이번 슬라이스 범위 밖)
        // 이 축과 겹치면 여전히 블랭킷 거부해야 한다.
        if (
          func.paramNames.includes(name) ||
          func.eqLocalNames.has(name) ||
          func.tupleEqLocalNames.has(name) ||
          func.nestedEqLocalNames.has(name) ||
          func.nestedHistShadowedNames.has(name)
        ) {
          func.histShadowedNames.add(name);
        } else {
          func.tupleEqLocalNames.add(name);
        }
      });
    }
  } else {
    // 위 pendingUdfFunc 선언부 주석 참조 — 이 콜사이트를 함수 이름으로 등록해두고
    // resolvePendingTupleDestructuresFor(analyzeFuncDecl이 호출)가 이 시점의 scope/registeredNames로
    // 위 3개 블록과 동일한 처리를 재개한다.
    let pendingList = prog.pendingTupleDestructures.get(pendingUdfFunc.name);
    if (pendingList === undefined) {
      pendingList = [];
      prog.pendingTupleDestructures.set(pendingUdfFunc.name, pendingList);
    }
    pendingList.push({ stmt, scope, registeredNames });
  }
}

// UDF 선언: name(params) => body. 실제 PineScript처럼 top-level(depth===0)에서만 허용 — 중첩
// 함수 선언/재귀 호출은 지원하지 않는다(GOAL.md 범위 밖, 이번 ROADMAP 항목도 그렇게 명시).
// 함수 본문은 pushScope(scope, false, info)로 진입한다 — parent가 선언 시점의 스코프(top-level만
// 허용하므로 항상 global)라서 pine2py scope.py의 ScopeManager.enter_scope(FUNCTION)과 동일하게
// "선언 시점에 보이던 top-level 변수는 읽기 가능, 호출부의 지역 변수는 격리"가 그대로 재현된다.
// C255: analyze()의 prepass가 top-level FuncDecl마다 소스 순서대로 호출 — 시그니처(파라미터
// 개수/한정자/UDT 타입)만 등록해 이 함수를 forward-reference(자신의 선언보다 앞선 콜사이트)에서도
// 인자 개수 검증이 가능하게 한다. 이름 충돌은 여기서 다른 FuncDecl/method와의 충돌만 판정한다
// (prepassTypeDecl의 "type-vs-type만" 원칙과 동일 — var/'=' 로컬은 이 시점에 항상 비어있어
// 신뢰 불가, 그 충돌은 analyzeFuncDecl이 원래 소스 위치에서 재검사). 기본값 표현식/본문은 여기서
// 분석하지 않는다 — 함수가 아직 등록되지 않은 다른 top-level var를 참조할 수 있어(analyzeExpr
// Identifier case, 현재도 지원되는 패턴) prepass 시점(varIndex 항상 빈 상태)에 분석하면 조용히
// 깨진다.
function registerFuncSignature(stmt: FuncDecl, prog: AnalyzedProgram): void {
  if (prog.funcs.has(stmt.name)) {
    prog.errors.push(`이름이 이미 다른 선언과 충돌함: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  const info: FuncInfo = {
    name: stmt.name,
    paramNames: stmt.params.map((p) => p.name),
    requiredParamCount: 0,
    paramHasDefault: [],
    localVarSlots: [],
    localVarIndex: new Map(),
    localTaSlotCount: 0,
    tupleArity: null,
    tupleElemNonNumericKinds: null,
    tupleElemUdtTypes: null,
    tupleElemContainerKinds: null,
    tupleElemArrayUdtTypes: null,
    tupleElemArrayDrawingKinds: null,
    paramQualifiers: new Map(),
    localVarQualifiers: new Map(),
    paramUdtTypes: new Map(),
    paramArrayElemUdtTypes: new Map(),
    paramArrayElemDrawingKinds: new Map(),
    paramContainerKinds: new Map(),
    paramMatrixKinds: new Set(),
    paramDrawingKinds: new Map(),
    localVarDrawingKinds: new Map(),
    localVarUdtTypes: new Map(),
    localVarArrayElemUdtTypes: new Map(),
    localVarArrayElemDrawingKinds: new Map(),
    localVarMapValueUdtTypes: new Map(),
    localVarMapValueDrawingKinds: new Map(),
    returnUdtType: null,
    returnArrayElemUdtType: null,
    returnArrayElemDrawingKind: null,
    returnContainerKind: null,
    returnIsScalarSafe: false,
    bodyAnalyzed: false,
    calls: new Set(),
    localHistSlots: new Map(),
    localHistKinds: new Map(),
    localHistSlotCount: 0,
    localCallHistSlots: new Map(),
    localCondCallHistSlots: new Map(),
    localCondHistSlotCount: 0,
    localCondCallRefHistSlots: new Map(),
    localCondRefHistSlotCount: 0,
    localRefHistSlots: new Map(),
    localRefHistKinds: new Map(),
    localRefHistSlotCount: 0,
    localFieldHistSlots: new Map(),
    localFieldRefHistSlots: new Map(),
    paramTypeHints: new Map(),
    localVarTypeHints: new Map(),
    localVarValueKinds: new Map(),
    eqLocalNames: new Set(),
    tupleEqLocalNames: new Set(),
    localTupleElemKinds: new Map(),
    histShadowedNames: new Set(),
    nestedEqLocalNames: new Set(),
    nestedHistShadowedNames: new Set(),
    localAmbiguousNestedHistDeclSlots: new Map(),
    localAmbiguousNestedHistReadSlots: new Map(),
    localAmbiguousNestedRefDeclSlots: new Map(),
    localAmbiguousNestedRefReadSlots: new Map(),
    shadowedByTopLevelLocal: false,
    hasSecParamCalls: false,
  };
  stmt.params.forEach((p, i) => {
    const hasDefault = p.default !== null;
    info.paramHasDefault.push(hasDefault);
    if (!hasDefault) info.requiredParamCount = i + 1;
    // 명시적 힌트("series float" 등) 없으면 simple 기본(pine2py도 매개변수 qualifier를 UNKNOWN으로
    // 두고 merge 시 simple과 동일 순위로 취급 — 여기선 그 값을 그대로 simple로 저장해 단순화).
    info.paramQualifiers.set(p.name, extractQualifierFromHint(p.typeHint) ?? "simple");
    const paramUdtType = resolveParamUdtTypeHint(p.typeHint, prog);
    if (paramUdtType !== undefined) info.paramUdtTypes.set(p.name, paramUdtType);
    info.paramTypeHints.set(p.name, p.typeHint);
  });
  prog.funcs.set(stmt.name, info);
}

// C452: UDF 이름 -> 스크립트 전체 유일 콜사이트(AnalyzedProgram.funcSingleCallSiteArgs 주석
// 참조). 제네릭 프로퍼티 전수 순회(prescanConstVars와 동일 원칙 — kind 화이트리스트 없이 모든
// 서브트리를 훑어, 새 문법이 CallExpr을 어디에 박아 넣어도 놓치지 않는다)로 모든 CallExpr을
// 찾아 callee가 등록된 top-level 함수 이름인 것만 이름별로 모은다. inFuncName은 그 콜사이트 자신이
// 다른 FuncDecl/MethodDecl 본문 안이면 그 함수 이름(콜사이트가 함수 안이면 그 인자 표현식도 그
// 함수의 스코프에 매여 있어 "top-level 유일 변수처럼 안전하게 재사용 가능"이 성립하지 않는다 —
// 함수 안 콜사이트는 C452 단일 콜사이트 치환 후보에서 완전히 제외, 콜사이트가 여러 개인 경우와
// 동일하게 취급). 최종적으로 이름별 콜사이트가 정확히 1개이고 그 콜사이트가
// top-level(inFuncName===null)일 때만 등록한다.
function prepassIndexSingleCallSites(script: Script, prog: AnalyzedProgram): void {
  const sites = new Map<string, { call: CallExpr; inFuncName: string | null }[]>();
  const record = (call: CallExpr, inFuncName: string | null): void => {
    if (call.callee.kind !== "Identifier" || !prog.funcs.has(call.callee.name)) return;
    const list = sites.get(call.callee.name);
    if (list === undefined) sites.set(call.callee.name, [{ call, inFuncName }]);
    else list.push({ call, inFuncName });
  };
  // inFuncName: 현재 서브트리를 감싼 가장 안쪽 FuncDecl/MethodDecl의 이름(top-level이면 null) —
  // C539가 in-func 콜사이트 실인자의 C526 섀도잉 가드에 쓴다(funcAllCallSites 주석 참조).
  const walk = (node: unknown, inFuncName: string | null): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inFuncName);
      return;
    }
    const n = node as { kind?: string } & Record<string, unknown>;
    if (n.kind === "CallExpr") record(n as unknown as CallExpr, inFuncName);
    const nextInFuncName =
      n.kind === "FuncDecl" || n.kind === "MethodDecl" ? (n as unknown as FuncDecl | MethodDecl).name : inFuncName;
    for (const key of Object.keys(n)) {
      if (key === "kind" || key === "line" || key === "col") continue;
      walk(n[key], nextInFuncName);
    }
  };
  walk(script.body, null);
  for (const [name, list] of sites) {
    if (list.length === 1 && list[0]!.inFuncName === null) prog.funcSingleCallSiteArgs.set(name, list[0]!.call);
    // C453: 전수 목록도 함께 보존(다중 콜사이트 udf-param 치환의 서수/후보 판정 —
    // AnalyzedProgram.funcAllCallSites 주석 참조). 같은 워크라 순서가 결정적이다.
    prog.funcAllCallSites.set(name, list);
  }
}

// C394: 타입힌트 없는 UDF 매개변수의 UDT 타입을 콜사이트 역추론으로 채운다(next_hint(C393)
// 'UDF 매개변수 타입 역전파' 설계 — wild `openTrade(tr) => tr.direction`류, tr.direction 20파일
// 클러스터). registerFuncSignature(위)는 명시 typeHint만 등록하므로, `sendAlertOrder(tr)`처럼
// 콜사이트의 인자가 top-level `trade tr = evaluateTrade(...)`(explicit UDT typeHint)인데 매개변수
// 자신엔 힌트가 없는 경우를 못 잡는다 — 함수 본문이 소스 순서상 콜사이트보다 먼저 analyzeFuncDecl될
// 수 있어(호출부가 아래에 있는 게 흔한 배치) 메인 단일 패스로는 원천적으로 forward 정보가 없다.
// 이 prepass는 registerFuncSignature 다음, 메인 analyzeStmt 루프 전에 실행돼 (1) top-level(및
// top-level 제어문 안에 중첩된) explicit UDT typeHint 변수명을 수집하고 (2) 그 스코프에서만
// (FuncDecl/MethodDecl 본문은 절대 넘지 않음 — 함수 자신의 매개변수/로컬이 동명으로 섀도잉할 수
// 있어 안전하지 않음) 콜사이트를 스캔해 위치 인자가 그 이름과 일치하면 후보로 기록한다. 이름이
// 여러 선언(중첩 블록 섀도잉 포함)에서 서로 다른 타입으로 쓰이거나 for/for-in 루프 변수명과
// 충돌하면 확정 불가로 제외한다(추측으로 잘못된 타입을 심는 것보다 미해결로 남기는 쪽이 안전 —
// GOAL.md na/타입 안전 원칙). 매개변수에 이미 어떤 typeHint든 명시돼 있으면(UDT든 아니든)
// 건드리지 않는다. 오라클 대조 불가(순수 정적 판별) — hand-verified E2E로 검증.
function prepassInferParamUdtTypesFromCallSites(script: Script, prog: AnalyzedProgram): void {
  const topLevelUdtVars = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  // top-level array<UDT> 컨테이너 이름 -> 원소 UDT 타입(C456, gap/level/trade wild 클러스터 --
  // `trade = array.get(activeTrades, i)`처럼 explicit typeHint 없는 '=' 로컬이 array-elem 추출로만
  // UDT 타입을 얻는 경우. 이 prepass는 scope 없는 순수 정적 스캔이라 resolveArrayGetElemUdtType
  // (스코프 필요)을 재사용 못 해 최소 버전을 직접 둔다 -- top-level 컨테이너 선언만 인정).
  const arrayElemTypeByName = new Map<string, string>();
  // arrayElemTypeByName의 drawing 버전(C505, wild `flush(source) => ... source.get(i).delete()`류 --
  // `array.new<label>()`/`array.new<line>()` top-level var를 무힌트 매개변수에 넘기는 형태).
  const arrayElemDrawingTypeByName = new Map<string, DrawingKind>();
  // top-level 컨테이너(array/map, UDT 원소 여부 무관) 이름 -> kind(C492, FuncInfo.paramContainerKinds
  // 주석 참조) — topLevelUdtVars/arrayElemTypeByName과 독립된 축이라 별도 ambiguity 세트로 추적한다
  // (두 축은 서로 다른 값 종류를 담아 공유 시 존재하지 않는 충돌을 오탐할 수 있다).
  const topLevelContainerVars = new Map<string, "array" | "map">();
  const ambiguousContainerNames = new Set<string>();
  const registerCandidate = (name: string, udtType: string): void => {
    if (ambiguousNames.has(name)) return;
    const existing = topLevelUdtVars.get(name);
    if (existing === undefined) {
      topLevelUdtVars.set(name, udtType);
    } else if (existing !== udtType) {
      topLevelUdtVars.delete(name);
      ambiguousNames.add(name);
    }
  };
  const registerContainerCandidate = (name: string, kind: "array" | "map"): void => {
    if (ambiguousContainerNames.has(name)) return;
    const existing = topLevelContainerVars.get(name);
    if (existing === undefined) {
      topLevelContainerVars.set(name, kind);
    } else if (existing !== kind) {
      topLevelContainerVars.delete(name);
      ambiguousContainerNames.add(name);
    }
  };
  const shadow = (name: string): void => {
    ambiguousNames.add(name);
    topLevelUdtVars.delete(name);
    ambiguousContainerNames.add(name);
    topLevelContainerVars.delete(name);
  };
  // C561: TupleDestructure(`[a, b] = f()`) 대상도 컨테이너 후보로 등록하려면 콜리 UDF `f`의 반환
  // 튜플 리터럴을 봐야 하는데, 이 프리패스는 본문 분석 전(registerFuncSignature 직후)이라
  // FuncInfo.tupleElemNonNumericKinds가 아직 없다 — 원본 AST를 얕게(중첩 블록 진입 없이 함수 본문
  // 최상위 문장만) 직접 스캔해 반환 원소 이름이 최상위 var/'=' 대입으로 array/map 생성자 콜을
  // 받는지만 순수 구조로 판별한다(scanDecls의 VarDecl/Assignment 분기와 동일한 판별 재사용).
  const funcDeclsByName = new Map<string, FuncDecl>();
  for (const stmt of script.body) {
    if (stmt.kind === "FuncDecl") funcDeclsByName.set(stmt.name, stmt);
  }
  const findBodyLocalContainerKind = (body: Stmt[], name: string): "array" | "map" | null => {
    for (const s of body) {
      if ((s.kind === "VarDecl" || s.kind === "Assignment") && s.name === name) {
        const declaredKind = containerKindFromTypeHint(s.typeHint);
        if (declaredKind !== null) return declaredKind;
        if (isArrayConstructorCall(s.value, prog)) return "array";
        if (isMapConstructorCall(s.value, prog)) return "map";
        return null;
      }
    }
    return null;
  };
  const scanDecls = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "VarDecl":
        case "Assignment":
          // C492: UDT 전용 분기(아래)와 독립적으로 항상 먼저 컨테이너 종류(array/map)를 확인한다 —
          // registerCandidate 대상(스칼라 UDT)과 이 대상(array.new_line() 류 순수 컨테이너)은
          // 서로 겹치지 않으므로 아래 분기의 break로 건너뛸 걱정이 없다.
          {
            const declaredKind = containerKindFromTypeHint(stmt.typeHint);
            if (declaredKind !== null) registerContainerCandidate(stmt.name, declaredKind);
            else if (isArrayConstructorCall(stmt.value, prog)) registerContainerCandidate(stmt.name, "array");
            else if (isMapConstructorCall(stmt.value, prog)) registerContainerCandidate(stmt.name, "map");
          }
          if (stmt.typeHint !== null && prog.udtTypes.has(stmt.typeHint)) {
            registerCandidate(stmt.name, stmt.typeHint);
            break;
          }
          // C496: 명시 typeHint가 없어도 초기값이 `TypeName.new(...)` 생성자 콜이면 UDT 타입을
          // 추론한다(isUdtConstructorCall, scope 없는 순수 구조 판별 — 메인 패스 analyzeVarDecl의
          // explicitUdtType ?? inferredUdtType과 동일 원칙 재사용). wild `var c = channel.new(...)`류
          // (explicit typeHint 없는 UDT var)가 이 등록 없이는 topLevelUdtVars에 전혀 안 잡혀
          // resolveTopLevelFieldDrawingKind(아래, C496)가 그 필드를 못 찾던 gap.
          if (stmt.typeHint === null) {
            const inferredUdtType = isUdtConstructorCall(stmt.value, prog);
            if (inferredUdtType !== null) {
              registerCandidate(stmt.name, inferredUdtType);
              break;
            }
          }
          {
            const elemCtorType = (stmt.typeHint !== null ? arrayUdtElemType(stmt.typeHint, prog) : null) ?? arrayUdtConstructorElemType(stmt.value, prog);
            if (elemCtorType !== null) {
              arrayElemTypeByName.set(stmt.name, elemCtorType);
              break;
            }
          }
          {
            const elemDrawingKind = (stmt.typeHint !== null ? arrayDrawingElemType(stmt.typeHint) : null) ?? arrayDrawingConstructorElemKind(stmt.value, prog);
            if (elemDrawingKind !== null) {
              arrayElemDrawingTypeByName.set(stmt.name, elemDrawingKind);
              break;
            }
          }
          if (stmt.typeHint === null) {
            const gotElemType = arrayGetElemTypeFromKnownContainer(stmt.value, arrayElemTypeByName);
            if (gotElemType !== null) registerCandidate(stmt.name, gotElemType);
          }
          break;
        case "IfStmt":
          scanDecls(stmt.thenBody);
          for (const clause of stmt.elifClauses) scanDecls(clause.body);
          if (stmt.elseBody !== null) scanDecls(stmt.elseBody);
          break;
        case "ForStmt":
          shadow(stmt.varName);
          scanDecls(stmt.body);
          break;
        case "ForInStmt":
          shadow(stmt.varName);
          if (stmt.indexName !== null) shadow(stmt.indexName);
          scanDecls(stmt.body);
          break;
        case "WhileStmt":
          scanDecls(stmt.body);
          break;
        case "SwitchStmt":
          for (const c of stmt.cases) scanDecls(c.body);
          break;
        case "TupleDestructure": {
          if (stmt.value.kind === "CallExpr" && stmt.value.callee.kind === "Identifier") {
            const funcDecl = funcDeclsByName.get(stmt.value.callee.name);
            const lastIdx = funcDecl !== undefined ? funcDecl.body.length - 1 : -1;
            const last = lastIdx >= 0 ? funcDecl!.body[lastIdx] : undefined;
            if (
              last !== undefined &&
              last.kind === "ExprStmt" &&
              last.expr.kind === "TupleExpr" &&
              last.expr.elements.length === stmt.names.length
            ) {
              last.expr.elements.forEach((el, i) => {
                const name = stmt.names[i]!;
                if (name === "_" || el.kind !== "Identifier") return;
                const kind = findBodyLocalContainerKind(funcDecl!.body, el.name);
                if (kind !== null) registerContainerCandidate(name, kind);
              });
            }
          }
          break;
        }
        case "FuncDecl":
        case "MethodDecl":
          // C647: 선언 스캔도 콜사이트 스캔(C644, visitStmts)과 대칭으로 다른 UDF/method 본문 안까지
          // 재귀한다 — wild `fnOB_req() => var num_buy = array.new<int>(...) ... f_overlap(num_buy,
          // ...)`류(func-local var가 top-level이 아니라 *다른* 함수 본문 안에서 선언되는 관용구)가
          // 이 재귀 부재로 topLevelUdtVars/topLevelContainerVars에 전혀 등록되지 않아 considerCall이
          // 그 이름을 몰라 아래 호출부의 num_.size()류가 값 흐름 추적 없이 거부됐다(call-expr.ts
          // L5117 부근 주석 "UDF/method 매개변수로 직접 받은 array 수신자는 값 흐름 추적이 없어
          // 여전히 거부" 참조 — 원인은 값 흐름 추적 부재가 아니라 이 스캔 경계였음). 이름 기반 flat
          // 맵이라 다른 함수의 동명 선언과 충돌하면 기존 ambiguousNames/ambiguousContainerNames가
          // 그대로 안전하게 흡수한다(C644가 이미 인정한 정밀도 손실과 동급 -- 새 위험 없음).
          scanDecls(stmt.body);
          break;
        default:
          break; // TypeDecl/EnumDecl/ExprStmt/FieldAssignment/Break/Continue: 무관
      }
    }
  };
  scanDecls(script.body);
  if (
    topLevelUdtVars.size === 0 &&
    arrayElemTypeByName.size === 0 &&
    arrayElemDrawingTypeByName.size === 0 &&
    topLevelContainerVars.size === 0
  )
    return;

  // funcName -> 파라미터 위치별 후보(undefined=미발견, string=단일 후보, null=콜사이트간 불일치)
  const paramCandidates = new Map<string, (string | null | undefined)[]>();
  // C469: array<UDT> 컨테이너 인자 축(arrayElemTypeByName) 버전 — paramCandidates와 나란한 구조.
  // 매개변수 하나가 콜사이트에 따라 스칼라 UDT 인자와 array<UDT> 인자를 섞어 받는 모순 사용은
  // 실제 wild corpus에 없다고 가정하고 별도 상호 배제 검사는 두지 않는다(과욕 금지, C232).
  const arrayElemParamCandidates = new Map<string, (string | null | undefined)[]>();
  // arrayElemParamCandidates의 drawing 버전(C505, arrayElemDrawingTypeByName 축) — 같은 인자 이름은
  // arrayElemTypeByName/arrayElemDrawingTypeByName 중 최대 하나에만 등록되므로(scanDecls가 먼저
  // 매치한 쪽에서 break) 두 축이 같은 이름을 동시에 채우는 모순은 구조적으로 발생하지 않는다.
  const arrayElemDrawingParamCandidates = new Map<string, (DrawingKind | null | undefined)[]>();
  // C492: 컨테이너 종류(array/map, UDT 원소 여부 무관) 축 — arrayElemParamCandidates와 나란한 구조.
  // elemUdtType과 배타적이지 않다(array<UDT> 인자는 두 맵 모두에 등록돼야 함 — 원소 UDT 타입과
  // 컨테이너 종류는 서로 다른 소비처를 갖는 독립 정보이기 때문).
  const containerParamCandidates = new Map<string, (("array" | "map") | null | undefined)[]>();
  // C496: drawing kind 축(paramDrawingKinds) — containerParamCandidates와 나란한 구조. 콜사이트
  // 인자가 top-level UDT var의 필드(DotAccess, `f(c.line_mid1)`류)일 때만 채워진다 — Identifier
  // 인자(topLevelContainerVars 등)와는 겹치지 않는 별개 인자 형태라 상호 배제 검사 불필요.
  const drawingParamCandidates = new Map<string, (DrawingKind | null | undefined)[]>();
  // DotAccess 인자(`c.line_mid1`)가 top-level UDT var(topLevelUdtVars)의 필드이고 그 필드
  // typeHint가 label/line/box/table/polyline/linefill 중 하나면 그 drawing kind를 반환한다.
  // resolveUdtFieldTypeHint(scope 필요)와 달리 이 prepass는 scope 없는 순수 정적 스캔이라
  // topLevelUdtVars만으로 판별 가능한 단일 레벨(obj가 top-level Identifier)만 다룬다 — 중첩
  // DotAccess(obj가 다시 DotAccess)는 범위 밖(LIMITATIONS 이월).
  const resolveTopLevelFieldDrawingKind = (expr: Expr): DrawingKind | null => {
    if (expr.kind !== "DotAccess" || expr.obj.kind !== "Identifier") return null;
    const objType = topLevelUdtVars.get(expr.obj.name);
    if (objType === undefined) return null;
    const fieldType = prog.udtTypes.get(objType)?.fields.find((f) => f.name === expr.attr)?.typeHint;
    return fieldType !== undefined && DRAWING_ALL_NAMESPACES.has(fieldType) ? (fieldType as DrawingKind) : null;
  };
  const considerCall = (funcName: string, args: Expr[], localShadow: ReadonlySet<string>): void => {
    const info = prog.funcs.get(funcName);
    if (info === undefined) return;
    let slots = paramCandidates.get(funcName);
    if (slots === undefined) {
      slots = info.paramNames.map(() => undefined);
      paramCandidates.set(funcName, slots);
    }
    let elemSlots = arrayElemParamCandidates.get(funcName);
    if (elemSlots === undefined) {
      elemSlots = info.paramNames.map(() => undefined);
      arrayElemParamCandidates.set(funcName, elemSlots);
    }
    let elemDrawingSlots = arrayElemDrawingParamCandidates.get(funcName);
    if (elemDrawingSlots === undefined) {
      elemDrawingSlots = info.paramNames.map(() => undefined);
      arrayElemDrawingParamCandidates.set(funcName, elemDrawingSlots);
    }
    let containerSlots = containerParamCandidates.get(funcName);
    if (containerSlots === undefined) {
      containerSlots = info.paramNames.map(() => undefined);
      containerParamCandidates.set(funcName, containerSlots);
    }
    let drawingSlots = drawingParamCandidates.get(funcName);
    if (drawingSlots === undefined) {
      drawingSlots = info.paramNames.map(() => undefined);
      drawingParamCandidates.set(funcName, drawingSlots);
    }
    args.forEach((argExpr, i) => {
      if (i >= info.paramNames.length) return;
      const paramName = info.paramNames[i]!;
      if (info.paramTypeHints.get(paramName) !== null) return; // 이미 명시 힌트 있음(UDT든 아니든) — 건드리지 않음
      // C644: 콜사이트가 다른 UDF/method 본문 안(중첩 호출)이면 그 함수 자신의 파라미터 이름이
      // top-level 이름을 로컬 섀도잉할 수 있다 — 이름이 같아도 그 함수 안에서는 다른 값이므로 스킵.
      if (argExpr.kind === "Identifier" && localShadow.has(argExpr.name)) return;
      if (argExpr.kind === "DotAccess" && argExpr.obj.kind === "Identifier" && localShadow.has(argExpr.obj.name)) return;
      if (argExpr.kind === "Identifier") {
        const udtType = topLevelUdtVars.get(argExpr.name);
        if (udtType !== undefined) {
          const cur = slots![i];
          if (cur === undefined) slots![i] = udtType;
          else if (cur !== null && cur !== udtType) slots![i] = null;
        } else {
          const elemUdtType = arrayElemTypeByName.get(argExpr.name);
          if (elemUdtType !== undefined) {
            const curElem = elemSlots![i];
            if (curElem === undefined) elemSlots![i] = elemUdtType;
            else if (curElem !== null && curElem !== elemUdtType) elemSlots![i] = null;
          } else {
            const elemDrawingKind = arrayElemDrawingTypeByName.get(argExpr.name);
            if (elemDrawingKind !== undefined) {
              const curElemDrawing = elemDrawingSlots![i];
              if (curElemDrawing === undefined) elemDrawingSlots![i] = elemDrawingKind;
              else if (curElemDrawing !== null && curElemDrawing !== elemDrawingKind) elemDrawingSlots![i] = null;
            }
          }
        }
        const containerKind = topLevelContainerVars.get(argExpr.name);
        if (containerKind !== undefined) {
          const curContainer = containerSlots![i];
          if (curContainer === undefined) containerSlots![i] = containerKind;
          else if (curContainer !== null && curContainer !== containerKind) containerSlots![i] = null;
        }
        return;
      }
      // C496: DotAccess 인자(top-level UDT var의 drawing 필드) — Identifier 전용이던 위 분기와
      // 독립된 별개 인자 형태이므로 상호 배제 없이 자체 슬롯만 채운다.
      const drawingKind = resolveTopLevelFieldDrawingKind(argExpr);
      if (drawingKind !== null) {
        const curDrawing = drawingSlots![i];
        if (curDrawing === undefined) drawingSlots![i] = drawingKind;
        else if (curDrawing !== null && curDrawing !== drawingKind) drawingSlots![i] = null;
      }
    });
  };
  const visitExpr = (expr: Expr, localShadow: ReadonlySet<string>): void => {
    switch (expr.kind) {
      case "CallExpr":
        if (expr.callee.kind === "Identifier") considerCall(expr.callee.name, expr.args, localShadow);
        else visitExpr(expr.callee.obj, localShadow);
        for (const a of expr.args) visitExpr(a, localShadow);
        for (const kw of expr.kwargs) visitExpr(kw.value, localShadow);
        return;
      case "BinOp":
        visitExpr(expr.left, localShadow);
        visitExpr(expr.right, localShadow);
        return;
      case "UnaryOp":
        visitExpr(expr.operand, localShadow);
        return;
      case "TernaryOp":
        visitExpr(expr.condition, localShadow);
        visitExpr(expr.trueExpr, localShadow);
        visitExpr(expr.falseExpr, localShadow);
        return;
      case "DotAccess":
        visitExpr(expr.obj, localShadow);
        return;
      case "IndexAccess":
        visitExpr(expr.obj, localShadow);
        visitExpr(expr.index, localShadow);
        return;
      case "TupleExpr":
        for (const e of expr.elements) visitExpr(e, localShadow);
        return;
      case "IfStmt":
        visitExpr(expr.condition, localShadow);
        visitStmts(expr.thenBody, localShadow);
        for (const c of expr.elifClauses) {
          visitExpr(c.condition, localShadow);
          visitStmts(c.body, localShadow);
        }
        if (expr.elseBody !== null) visitStmts(expr.elseBody, localShadow);
        return;
      case "ForStmt":
        visitExpr(expr.start, localShadow);
        visitExpr(expr.end, localShadow);
        if (expr.step !== null) visitExpr(expr.step, localShadow);
        visitStmts(expr.body, localShadow);
        return;
      case "WhileStmt":
        visitExpr(expr.condition, localShadow);
        visitStmts(expr.body, localShadow);
        return;
      case "SwitchStmt":
        if (expr.subject !== null) visitExpr(expr.subject, localShadow);
        for (const c of expr.cases) {
          if (c.values !== null) for (const v of c.values) visitExpr(v, localShadow);
          visitStmts(c.body, localShadow);
        }
        return;
      default:
        return; // Identifier/리터럴류: 잎 노드
    }
  };
  const visitStmts = (stmts: Stmt[], localShadow: ReadonlySet<string>): void => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "VarDecl":
        case "Assignment":
          visitExpr(stmt.value, localShadow);
          break;
        case "ExprStmt":
          visitExpr(stmt.expr, localShadow);
          break;
        case "IfStmt":
          visitExpr(stmt.condition, localShadow);
          visitStmts(stmt.thenBody, localShadow);
          for (const c of stmt.elifClauses) {
            visitExpr(c.condition, localShadow);
            visitStmts(c.body, localShadow);
          }
          if (stmt.elseBody !== null) visitStmts(stmt.elseBody, localShadow);
          break;
        case "ForStmt":
          visitExpr(stmt.start, localShadow);
          visitExpr(stmt.end, localShadow);
          if (stmt.step !== null) visitExpr(stmt.step, localShadow);
          visitStmts(stmt.body, localShadow);
          break;
        case "ForInStmt":
          visitExpr(stmt.iterable, localShadow);
          visitStmts(stmt.body, localShadow);
          break;
        case "WhileStmt":
          visitExpr(stmt.condition, localShadow);
          visitStmts(stmt.body, localShadow);
          break;
        case "SwitchStmt":
          if (stmt.subject !== null) visitExpr(stmt.subject, localShadow);
          for (const c of stmt.cases) {
            if (c.values !== null) for (const v of c.values) visitExpr(v, localShadow);
            visitStmts(c.body, localShadow);
          }
          break;
        case "TupleDestructure":
          visitExpr(stmt.value, localShadow);
          break;
        case "FieldAssignment":
          visitExpr(stmt.object, localShadow);
          visitExpr(stmt.value, localShadow);
          break;
        case "FuncDecl":
        case "MethodDecl":
          // C644: 콜사이트가 다른 UDF/method 본문 안에 있어도(예: draw_channel() 안에서
          // color_lines(c.line_mid1, ...) 호출) param 타입 역추론이 미치도록 재귀 — 그 함수 자신의
          // 파라미터 이름은 로컬 섀도잉이라 top-level 이름과 동명이어도 조회 대상에서 제외한다
          // (전역 shadow()는 프리패스 전체를 영구 오염시켜 부적합, 이 호출 한정 지역 Set만 확장).
          visitStmts(stmt.body, new Set([...localShadow, ...stmt.params.map((p) => p.name)]));
          break;
        default:
          break; // TypeDecl/EnumDecl/Break/Continue: 무관
      }
    }
  };
  visitStmts(script.body, new Set());

  for (const [funcName, slots] of paramCandidates) {
    const info = prog.funcs.get(funcName)!;
    slots.forEach((udtType, i) => {
      if (udtType === null || udtType === undefined) return;
      info.paramUdtTypes.set(info.paramNames[i]!, udtType);
    });
  }
  for (const [funcName, elemSlots] of arrayElemParamCandidates) {
    const info = prog.funcs.get(funcName)!;
    elemSlots.forEach((elemUdtType, i) => {
      if (elemUdtType === null || elemUdtType === undefined) return;
      info.paramArrayElemUdtTypes.set(info.paramNames[i]!, elemUdtType);
    });
  }
  for (const [funcName, elemDrawingSlots] of arrayElemDrawingParamCandidates) {
    const info = prog.funcs.get(funcName)!;
    elemDrawingSlots.forEach((elemDrawingKind, i) => {
      if (elemDrawingKind === null || elemDrawingKind === undefined) return;
      info.paramArrayElemDrawingKinds.set(info.paramNames[i]!, elemDrawingKind);
    });
  }
  for (const [funcName, containerSlots] of containerParamCandidates) {
    const info = prog.funcs.get(funcName)!;
    containerSlots.forEach((kind, i) => {
      if (kind === null || kind === undefined) return;
      info.paramContainerKinds.set(info.paramNames[i]!, kind);
    });
  }
  for (const [funcName, drawingSlots] of drawingParamCandidates) {
    const info = prog.funcs.get(funcName)!;
    drawingSlots.forEach((kind, i) => {
      if (kind === null || kind === undefined) return;
      info.paramDrawingKinds.set(info.paramNames[i]!, kind);
    });
  }
}

// value가 canonical `array.get(container, idx)` 또는 method-sugar `container.get(idx)`(get 외
// pop/shift/first/last/remove도 동일 형태, resolveArrayGetElemUdtType의 ARRAY_ELEM_RETURNING_METHODS
// 화이트리스트 재사용 -- 아래쪽에 선언되지만 이 함수는 analyze() 호출 시점(모듈 로드 완료 후)에만
// 실행되므로 참조 순서 무관)이고 container가 arrayElemTypeByName에 이미 기록된 top-level 이름이면
// 그 원소 UDT 타입을 반환한다(C456). resolveArrayGetElemUdtType과 달리 scope 인자가 없다 --
// prepassInferParamUdtTypesFromCallSites 자신이 scope 없는 순수 정적 스캔이라(C394 주석 참조)
// 그 축의 최소 버전만 필요.
function arrayGetElemTypeFromKnownContainer(value: Expr, arrayElemTypeByName: ReadonlyMap<string, string>): string | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess") return null;
  const callee = value.callee;
  if (!ARRAY_ELEM_RETURNING_METHODS.has(callee.attr)) return null;
  if (callee.obj.kind === "Identifier" && callee.obj.name === "array") {
    const container = value.args[0];
    return container !== undefined && container.kind === "Identifier" ? (arrayElemTypeByName.get(container.name) ?? null) : null;
  }
  if (callee.obj.kind === "Identifier") return arrayElemTypeByName.get(callee.obj.name) ?? null;
  return null;
}

// array.*/map.* 콜에서 컨테이너 id가 아니라 생성자(사이즈 등)로 쓰이는 메서드는 자기참조 스캔
// 대상에서 제외해야 한다(new_float(size, initial)의 size를 컨테이너로 오인하면 안 됨) —
// ARRAY_REGISTRY/MAP_REGISTRY 키에서 생성자만 걸러낸 화이트리스트(scanOwnParamContainerKindUsage 전용).
const ARRAY_CONTAINER_ARG0_METHODS: ReadonlySet<string> = new Set(
  Object.keys(ARRAY_REGISTRY).filter((m) => m !== "from" && !m.startsWith("new")),
);
const MAP_CONTAINER_ARG0_METHODS: ReadonlySet<string> = new Set(Object.keys(MAP_REGISTRY).filter((m) => m !== "new"));
// MATRIX_REGISTRY 키에서 생성자("new")만 걸러낸 화이트리스트(C709, ARRAY_/MAP_CONTAINER_ARG0_METHODS와
// 나란함 — MATRIX_REGISTRY 전 항목이 arg0을 matrix로 받으므로 제외 대상은 "new" 하나뿐).
const MATRIX_CONTAINER_ARG0_METHODS: ReadonlySet<string> = new Set(Object.keys(MATRIX_REGISTRY).filter((m) => m !== "new"));

// C693: UDF/method 매개변수가 typeHint 없이 자기 본문 안에서 canonical array.*/map.*(param, ...)
// 형태로 먼저 쓰이면(wild `pearson(x) => if array.size(x) > 0 \n for i=1 to x.size()-1`류 —
// dot-sugar가 뒤이어 나오는 관용구) 그 매개변수의 container kind를 이 스캔으로 확정한다.
// paramContainerKinds(C492, considerCall — 다른 함수 호출 시 top-level 배열/맵을 인자로 넘기는
// "콜사이트" 신호)와 별개 신호원(본문 내부 "자기참조" 신호)이라 같은 필드에 병합하되 상호 배타는
// 아니다. 본문 전체를 대상별 shadow 없이 훑는 순수 구조 스캔(pearson 예시처럼 함수는 top-level만
// 가능해 중첩 FuncDecl/MethodDecl 자체가 없음, GOAL.md 아키텍처 원칙) — VarDecl/Assignment/
// TupleDestructure/FieldAssignment/제어문(식/문 양쪽) 전부를 covering해야 하므로 위
// prepassInferParamUdtTypesFromCallSites의 visitExpr/visitStmts와 동형 구조를 재사용한다(단
// considerCall의 cross-function 인자 추론과 달리 이 스캔은 "이 함수 자신의 매개변수"만 본다).
// C709: 같은 스캔에 matrix.*(param, ...) 자기참조도 나란히 얹는다(wild `_extend(_x, _len) =>
// matrix.rows(_x) ... matrix.set(_x, ...) ... for l in _x`류) — matrix는 종류가 하나뿐이라
// array/map처럼 모순 검사(note 함수의 null 강등)가 필요 없어 별도 Set으로 분리 반환한다.
function scanOwnParamContainerKindUsage(
  body: Stmt[],
  paramNames: ReadonlySet<string>,
): { containerKinds: Map<string, "array" | "map">; matrixParamNames: Set<string> } {
  const found = new Map<string, "array" | "map" | null>();
  const matrixParamNames = new Set<string>();
  const note = (name: string, kind: "array" | "map"): void => {
    const cur = found.get(name);
    if (cur === undefined) found.set(name, kind);
    else if (cur !== kind) found.set(name, null);
  };
  const visitExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case "CallExpr": {
        const callee = expr.callee;
        if (
          callee.kind === "DotAccess" &&
          callee.obj.kind === "Identifier" &&
          (callee.obj.name === "array" || callee.obj.name === "map") &&
          expr.args.length > 0 &&
          expr.args[0]!.kind === "Identifier" &&
          paramNames.has(expr.args[0]!.name) &&
          (callee.obj.name === "array"
            ? ARRAY_CONTAINER_ARG0_METHODS.has(callee.attr)
            : MAP_CONTAINER_ARG0_METHODS.has(callee.attr))
        ) {
          note(expr.args[0]!.name, callee.obj.name);
        }
        if (
          callee.kind === "DotAccess" &&
          callee.obj.kind === "Identifier" &&
          callee.obj.name === "matrix" &&
          expr.args.length > 0 &&
          expr.args[0]!.kind === "Identifier" &&
          paramNames.has(expr.args[0]!.name) &&
          MATRIX_CONTAINER_ARG0_METHODS.has(callee.attr)
        ) {
          matrixParamNames.add(expr.args[0]!.name);
        }
        if (callee.kind === "DotAccess") visitExpr(callee.obj);
        for (const a of expr.args) visitExpr(a);
        for (const kw of expr.kwargs) visitExpr(kw.value);
        return;
      }
      case "BinOp":
        visitExpr(expr.left);
        visitExpr(expr.right);
        return;
      case "UnaryOp":
        visitExpr(expr.operand);
        return;
      case "TernaryOp":
        visitExpr(expr.condition);
        visitExpr(expr.trueExpr);
        visitExpr(expr.falseExpr);
        return;
      case "DotAccess":
        visitExpr(expr.obj);
        return;
      case "IndexAccess":
        visitExpr(expr.obj);
        visitExpr(expr.index);
        return;
      case "TupleExpr":
        for (const e of expr.elements) visitExpr(e);
        return;
      case "IfStmt":
        visitExpr(expr.condition);
        visitStmts(expr.thenBody);
        for (const c of expr.elifClauses) {
          visitExpr(c.condition);
          visitStmts(c.body);
        }
        if (expr.elseBody !== null) visitStmts(expr.elseBody);
        return;
      case "ForStmt":
        visitExpr(expr.start);
        visitExpr(expr.end);
        if (expr.step !== null) visitExpr(expr.step);
        visitStmts(expr.body);
        return;
      case "WhileStmt":
        visitExpr(expr.condition);
        visitStmts(expr.body);
        return;
      case "SwitchStmt":
        if (expr.subject !== null) visitExpr(expr.subject);
        for (const c of expr.cases) {
          if (c.values !== null) for (const v of c.values) visitExpr(v);
          visitStmts(c.body);
        }
        return;
      default:
        return; // Identifier/리터럴류: 잎 노드
    }
  };
  const visitStmts = (stmts: Stmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case "VarDecl":
        case "Assignment":
          visitExpr(stmt.value);
          break;
        case "ExprStmt":
          visitExpr(stmt.expr);
          break;
        case "IfStmt":
          visitExpr(stmt.condition);
          visitStmts(stmt.thenBody);
          for (const c of stmt.elifClauses) {
            visitExpr(c.condition);
            visitStmts(c.body);
          }
          if (stmt.elseBody !== null) visitStmts(stmt.elseBody);
          break;
        case "ForStmt":
          visitExpr(stmt.start);
          visitExpr(stmt.end);
          if (stmt.step !== null) visitExpr(stmt.step);
          visitStmts(stmt.body);
          break;
        case "ForInStmt":
          visitExpr(stmt.iterable);
          visitStmts(stmt.body);
          break;
        case "WhileStmt":
          visitExpr(stmt.condition);
          visitStmts(stmt.body);
          break;
        case "SwitchStmt":
          if (stmt.subject !== null) visitExpr(stmt.subject);
          for (const c of stmt.cases) {
            if (c.values !== null) for (const v of c.values) visitExpr(v);
            visitStmts(c.body);
          }
          break;
        case "TupleDestructure":
          visitExpr(stmt.value);
          break;
        case "FieldAssignment":
          visitExpr(stmt.object);
          visitExpr(stmt.value);
          break;
        default:
          break; // TypeDecl/EnumDecl/FuncDecl/MethodDecl/Break/Continue: 무관(top-level 전용/제어흐름 무관)
      }
    }
  };
  visitStmts(body);
  const containerKinds = new Map<string, "array" | "map">();
  for (const [k, v] of found) if (v !== null) containerKinds.set(k, v);
  return { containerKinds, matrixParamNames };
}

function analyzeFuncDecl(stmt: FuncDecl, prog: AnalyzedProgram, scope: LexScope): void {
  if (scope.depth !== 0) {
    prog.errors.push(`함수 선언은 top-level에서만 가능 (중첩/재귀 UDF 미지원): '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  // C255: prog.funcs.has(stmt.name)는 prepass가 이미 이 이름을 등록해뒀으므로 항상 true라
  // 신호가 안 된다(prepassTypeDecl의 checkTypeDeclConflict와 동일 원칙) — 여기서는 var와의 충돌를
  // 재검사하지 않는다. top-level '=' 로컬과의 충돌은 더 이상 여기서 걸러지지 않는다(C413) — root
  // scope에 scopeHasLocal(scope, stmt.name)이 true가 되는 경로는 이 함수와 같은 이름의 top-level
  // '=' 로컬 또는 튜플 디스트럭처링 대상(C668)이 이미 accept돼 scope.names에 등록된 경우인데,
  // 그 경로는 이제 analyzeAssignment/analyzeTupleDestructure 양쪽 모두 FuncInfo.
  // shadowedByTopLevelLocal 플래그로 의도적으로 허용하는 바로 그 케이스이므로 여기서 다시 막으면
  // 안 된다. top-level var와의 충돌(C681, wild "이름충돌" 클러스터 실측 36건 중 7건)도 동일 원칙으로
  // 이제 허용한다 — TV는 call-vs-value 문법(뒤따르는 괄호 유무)으로 함수/값 네임스페이스를 완전히
  // 분리한다(C413의 '=' 로컬 근거와 동형, tv_verdict_v2.jsonl 재검증). '=' 로컬과 다른 점은 var가
  // codegen에서 애초에 bare JS 식별자로 방출되지 않는다는 것 — genIdentifier/resolveAssignTarget이
  // top-level var를 항상 `$.vars[slot]`으로 내려(codegen.ts, program.varIndex.get 분기) JS
  // 식별자 공간에 아예 등장하지 않으므로, funcCodegenName의 `$fn` 접미사 같은 mangling 없이도
  // `function <name>(...)`(함수)와 `$.vars[N]`(var)가 애초에 문자 그대로 충돌할 수 없다 — '='
  // 로컬(let 선언, JS 식별자 공간 공유)만 mangling이 필요했던 이유였다.
  const info = prog.funcs.get(stmt.name)!; // prepass(registerFuncSignature)가 이미 등록

  for (const p of stmt.params) {
    if (p.default !== null) {
      // 기본값 표현식은 함수 본문 스코프가 아니라 선언 시점(top-level) 스코프에서 평가된다
      // (pine2py CodeGen._gen_func_param과 동일 — 다른 매개변수를 참조할 수 없음).
      analyzeExpr(p.default, prog, scope, false);
    }
  }

  const bodyScope = pushScope(scope, "udf-body", /* inLoop */ false, info);
  for (const p of stmt.params) {
    // C414: 매개변수명이 top-level var와 같아도 더 이상 거부하지 않는다 — TV 스코프 규칙상
    // 매개변수는 함수 본문 안에서 그 이름의 바깥 var를 shadow하는 정상 패턴(wild 34건 실사용,
    // e.g. `update_zigzag(..., int dir) => ... dir ...`이 top-level `var int dir`와 공존).
    // pine2py도 python 함수 매개변수가 자연히 동일 이름을 shadow해 이 조합을 그대로 지원함을
    // python 직접 실행으로 확인(오라클 대조 가능 축). genIdentifier/resolveAssignTarget(codegen.ts)이
    // funcCtx.paramNames를 program.varIndex보다 먼저 확인하도록 우선순위를 바꿔 실제 파라미터
    // 값이 올바르게 읽히도록 함께 수정했다(C413의 "함수 자신의 mangle" 해법과 달리, 이번엔 식별자
    // 해석 순서 자체가 문제였다).
    bodyScope.names.add(p.name);
    prog.locals.add(p.name);
  }
  // C693: 본문 내부 canonical array.*/map.*(param,...) 자기참조 사용 스캔(위 함수 주석 참조) —
  // 콜사이트 인자 추론(C492)으로 이미 확정된 매개변수는 건드리지 않는다.
  {
    const untypedParamNames = new Set(
      stmt.params.filter((p) => p.typeHint === null && !info.paramContainerKinds.has(p.name)).map((p) => p.name),
    );
    if (untypedParamNames.size > 0) {
      const { containerKinds, matrixParamNames } = scanOwnParamContainerKindUsage(stmt.body, untypedParamNames);
      for (const [name, kind] of containerKinds) info.paramContainerKinds.set(name, kind);
      for (const name of matrixParamNames) info.paramMatrixKinds.add(name);
    }
  }
  if (stmt.body.length === 0) {
    prog.errors.push(`함수 본문이 비어 있음: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    info.bodyAnalyzed = true;
    resolvePendingTupleDestructuresFor(info, prog);
    return;
  }
  // 마지막 문장이 `[a, b]` TupleExpr이면 튜플 반환으로 취급한다(analyzeStmt의 일반 ExprStmt
  // 경로로 보내면 analyzeExpr의 TupleExpr case가 "반환 위치 전용" 에러를 낼 것이므로 여기서
  // 직접 분기 — codegen genFuncBody도 동일하게 마지막 문장만 특별 취급함). 마지막 문장이
  // if/switch면 아래 tryFuncBodyIfTupleReturn/tryFuncBodySwitchTupleReturn이 전담하며, 그
  // 안의 중첩 if/switch 분기까지 재귀로 흡수한다(C609, detectTupleReturnArityFromLastStmt).
  // C706: 이 블록(과 IfStmt/SwitchStmt/TernaryOp/TupleDestructure 4개 자매 분기, MethodDecl
  // 동형 블록 포함 총 12곳)은 전부 "튜플 반환은 2개 이상"을 강제했으나, wild `[average]` 단일
  // 원소 암시반환(`f() =>\n ... \n [average]` 후 콜사이트 `[x] = f()`) 관용구 17개 독립 파일 실측
  // 결과 파서(isTupleDestructure/parseTupleExpr)는 애초에 최소 원소 개수를 강제하지 않고,
  // pine2py parser.py도 arity 검증이 아예 없으며(_parse_tuple_destructure), codegen(JS 네이티브
  // 배열 destructure/return [x])도 arity=1에 대해 이미 완전히 일반적이라 "2개 이상" 자체가
  // 근거 없는 자체 발명 제약이었음(TV 실제로는 1-튜플도 허용하는 것으로 보임) — 하드 에러 제거.
  const lastIdx = stmt.body.length - 1;
  for (let i = 0; i < stmt.body.length; i++) {
    const s = stmt.body[i]!;
    if (i === lastIdx && s.kind === "ExprStmt" && s.expr.kind === "TupleExpr") {
      const elements = s.expr.elements;
      info.tupleArity = elements.length;
      // C369: 각 원소의 "히스토리 슬롯에 담을 수 없는 종류"를 분석 직후(스코프 힌트가 전부 누적된
      // 시점) 함께 확정한다 — top-level 튜플 디스트럭처 이름의 히스토리 타입 가드가 소비
      // (analyzeTupleDestructure의 topLevelTupleElemKinds 등록 주석 참조).
      info.tupleElemNonNumericKinds = elements.map((el) => {
        analyzeExpr(el, prog, bodyScope, false);
        return classifyTupleElemNonNumericKind(el, prog, bodyScope);
      });
      info.tupleElemUdtTypes = elements.map((el) => resolveTupleElemUdtType(el, prog, bodyScope));
      info.tupleElemContainerKinds = elements.map((el) => resolveContainerExprKind(el, prog, bodyScope));
      info.tupleElemArrayUdtTypes = elements.map((el) => resolveArrayElemUdtType(el, prog, bodyScope));
      info.tupleElemArrayDrawingKinds = elements.map((el) => resolveArrayElemDrawingKind(el, prog, bodyScope));
      continue;
    }
    // C530: 마지막 문장이 request.security(sym, tf, [e1, e2, ...]) 튜플 리터럴 expression 콜이면
    // security-튜플 반환 UDF로 취급한다(`[a, b] = f()` 콜사이트는 일반 UDF 튜플 디스트럭처 경로를
    // 그대로 탄다 — 신규 콜사이트 기구 0). tupleStateCalls에 선등록해 call-expr.ts request.security
    // 분기의 "튜플 디스트럭처링('[a, b] = ...')의 값으로만 지원" 게이트를 통과시키고, 원소 검증/슬롯
    // 등록(securityTupleCallSlots)은 그 분기가 전담한다(등록 후 즉시 return이라 TupleExpr가 일반
    // analyzeExpr 위치 거부에 안 닿음 — 이중 등록 없음, C180 원칙). tf는 고정 리터럴/C529 uniform
    // 폴딩/C532 distinct 콜사이트별 블록(multiSite) 전부 통과 — call-expr.ts tf 해석부 주석 참조,
    // ta.* 포함 원소는 exprHasTaInUdf가 기존대로 하드 에러(C367).
    // 원소는 전부 수치(bare/좁은 문법 — buildSecurityExpr가 보장)라 NonNumericKinds/UdtTypes는 null.
    if (i === lastIdx && s.kind === "ExprStmt" && s.expr.kind === "CallExpr") {
      const secTupleArity = securityTupleReturnArity(s.expr);
      if (secTupleArity !== null) {
        prog.tupleStateCalls.add(s.expr);
        analyzeExpr(s.expr, prog, bodyScope, false);
        info.tupleArity = secTupleArity;
        info.tupleElemNonNumericKinds = new Array(secTupleArity).fill(null);
        info.tupleElemUdtTypes = new Array(secTupleArity).fill(null);
        continue;
      }
      // C611: 마지막 문장이 request.security(sym, tf, tupleUdf(...)) bare UDF 콜이면 — C432
      // passthrough(외부 노드 완전 discard, HTF 슬롯/프리패스 0 — securityBareUdfCallSlots 주석의
      // pine2py 오라클 근거 그대로)의 UDF-본문 암시 반환 폼(위 C530 튜플 리터럴 폼의 bare-UDF
      // 자매 축, wild sec(bare-udf) 26건/11f 최다 실측). analyzeTupleDestructure C432 분기와 동일
      // 등록(tupleStateCalls + securityBareUdfCallSlots)을 여기서 미러 — analyzeExpr 재귀가
      // call-expr.ts bareUdfInner 분기를 타 내부 콜만 일반 UDF 콜 경로로 분석한다(이중 등록 없음,
      // C180). forward-ref(bodyAnalyzed=false) 내부 콜리는 C432 선례 그대로 대상 밖(과욕 금지
      // C232) — 미매치면 아래 일반 analyzeStmt로 폴백해 기존 좁은-문법 에러로 정상 거부된다.
      // arity/원소 kind는 내부 콜리의 확정값을 그대로 승계한다(래퍼는 그 튜플을 무가공 재반환).
      const secBareUdfInner = securityBareUdfTupleTail(s.expr, prog);
      if (secBareUdfInner !== null) {
        prog.tupleStateCalls.add(s.expr);
        prog.securityBareUdfCallSlots.set(s.expr, secBareUdfInner.inner);
        analyzeExpr(s.expr, prog, bodyScope, false);
        info.tupleArity = secBareUdfInner.func.tupleArity;
        info.tupleElemNonNumericKinds = secBareUdfInner.func.tupleElemNonNumericKinds?.slice() ?? null;
        info.tupleElemUdtTypes = secBareUdfInner.func.tupleElemUdtTypes?.slice() ?? null;
        continue;
      }
      // C611: 마지막 문장이 이미 확정된 튜플 반환 UDF의 직접 콜(`outer() =>\n ... \n inner(...)`)
      // 이면 그 arity/원소 kind를 그대로 승계한다(wild zigzag→zigzagcore 체인 관용구). 문장 자체는
      // 일반 analyzeStmt(stmtCalls 등록 포함, C347)로 기존과 동일하게 분석하고 — codegen도
      // genImplicitReturn 일반 ExprStmt 분기(`return <콜>`)가 "UDF 튜플 반환 = 배열 리터럴" 계약을
      // 공짜로 충족해 변경 0줄 — 여기서는 FuncInfo 튜플 메타만 채운다. forward-ref/스칼라 콜리는
      // 조건 미달로 자연 폴백(기존 동작 불변).
      if (s.expr.callee.kind === "Identifier") {
        const tailCallee = prog.funcs.get(s.expr.callee.name);
        if (tailCallee !== undefined && tailCallee.bodyAnalyzed && tailCallee.tupleArity !== null) {
          analyzeStmt(s, prog, bodyScope);
          info.tupleArity = tailCallee.tupleArity;
          info.tupleElemNonNumericKinds = tailCallee.tupleElemNonNumericKinds?.slice() ?? null;
          info.tupleElemUdtTypes = tailCallee.tupleElemUdtTypes?.slice() ?? null;
          continue;
        }
      }
      // C629: 마지막 문장이 다중 반환 TA 콜(`ta.macd(...)` 등) 자체면 그 UDF는 얇은 래퍼로 취급한다
      // (wild `macd(source,...) =>\n  ta.macd(source,...)` 관용구, 튜플 172-클러스터 non-library
      // 최다 서브패턴). tupleStateCalls에 선등록해 call-expr.ts의 "표현식 위치 거부" 게이트를
      // 통과시킨 뒤(위 C530 security-튜플 분기와 동일 원리) 표준 analyzeStmt로 인자 검증/슬롯 등록을
      // 그대로 맡긴다 — 원소는 전부 수치(ta.* 다중반환 원소는 항상 float)라 NonNumericKinds/UdtTypes는 null.
      const taArity = taMultiReturnTailArity(s.expr);
      if (taArity !== null) {
        prog.tupleStateCalls.add(s.expr);
        analyzeStmt(s, prog, bodyScope);
        info.tupleArity = taArity;
        info.tupleElemNonNumericKinds = new Array(taArity).fill(null);
        info.tupleElemUdtTypes = new Array(taArity).fill(null);
        continue;
      }
    }
    // C612: 마지막 문장이 삼항이고 양 분기가 튜플 값(리터럴/security 튜플/bare-UDF/튜플 UDF 콜)
    // 이면 삼항 자체가 튜플 암시 반환(wild ternary<tuple-literal|sec(tuple-lit)> 3건/3f,
    // c611_tail_shape_probe.mjs 실측 — `f() => cond ? [na, na] : request.security(..., [o, c])`
    // 관용구). detect 후 analyzeTernaryTupleValue(C416 디스트럭처 값 위치용 기존 스캐폴드)를 그대로
    // 재사용 — detect 리프 집합은 validate(resolveTupleValueBranch)의 부분집합이라(동명 함수 주석
    // 참조) detect 성공이면 validate도 같은 arity로 성공한다(폴백 재분석/이중 등록 없음, C180).
    if (i === lastIdx && s.kind === "ExprStmt" && s.expr.kind === "TernaryOp") {
      const ternaryArity = detectTupleReturnArityFromTailExpr(s.expr, prog);
      if (ternaryArity !== null) {
        const result = analyzeTernaryTupleValue(s.expr, ternaryArity, prog, bodyScope);
        if (result.ok) {
          info.tupleArity = ternaryArity;
          info.tupleElemNonNumericKinds = result.elemKinds;
          info.tupleElemUdtTypes = new Array(ternaryArity).fill(null);
          info.tupleElemContainerKinds = result.elemContainerKinds;
          continue;
        }
      }
    }
    // C531: 마지막 문장이 `[a, b, ...] = request.security(sym, tf, [e1, e2, ...])` 튜플
    // **디스트럭처**인 암시 재반환 폼(wild 36건, `getdata(sym, tf) =>\n    [o, c, ...] =
    // request.security(...)` — 위 C530 bare ExprStmt 콜 폼의 자매 축). 디스트럭처 자신(원소 검증/
    // 슬롯 등록/개수 불일치/tf 해석 — C529 uniform 폴딩 포함)은 기존 analyzeTupleDestructure가
    // analyzeStmt 경유로 전량 전담하고(tupleStateCalls 등록도 그 안에서 — 이중 등록 없음, C180),
    // 여기서는 함수 반환 arity만 대상 이름 개수로 확정해 콜사이트 `[x, y] = f()`가 일반 UDF 튜플
    // 디스트럭처 경로를 그대로 타게 한다(신규 콜사이트 기구 0). TV는 "마지막 문장이 튜플
    // 디스트럭처면 그 튜플이 함수의 반환값"을 공식 문서에 명시하지 않아 TV 미검증(가설) —
    // pine2py는 이 폼에서 None을 반환해 오라클 불가(DIVERGENCES 참조). 원소는 전부 수치
    // (buildSecurityExpr 좁은 문법이 보장)라 NonNumericKinds/UdtTypes는 null.
    if (
      i === lastIdx &&
      s.kind === "TupleDestructure" &&
      s.value.kind === "CallExpr" &&
      securityTupleReturnArity(s.value) !== null
    ) {
      analyzeStmt(s, prog, bodyScope);
      info.tupleArity = s.names.length;
      info.tupleElemNonNumericKinds = new Array(s.names.length).fill(null);
      info.tupleElemUdtTypes = new Array(s.names.length).fill(null);
      continue;
    }
    // C752: 마지막 문장이 TA 다중반환 콜(`ta.macd(...)` 등)을 튜플 디스트럭처하는 암시 재반환 폼
    // (C629 ExprStmt-tail 자매 축, wild `f() =>\n ... \n [a,b,c] = ta.vwap(...)` 관용구 — vVwap류).
    // 디스트럭처 자신(원소 검증/슬롯 등록)은 표준 analyzeStmt가 그대로 전담 — 여기서는 함수 반환
    // arity만 확정하고 funcBodyTailTupleDestructures에 등록해 codegen이 return을 방출하게 한다.
    if (
      i === lastIdx &&
      s.kind === "TupleDestructure" &&
      s.value.kind === "CallExpr" &&
      taMultiReturnTailArity(s.value) !== null
    ) {
      analyzeStmt(s, prog, bodyScope);
      info.tupleArity = s.names.length;
      info.tupleElemNonNumericKinds = new Array(s.names.length).fill(null);
      info.tupleElemUdtTypes = new Array(s.names.length).fill(null);
      prog.funcBodyTailTupleDestructures.add(s);
      continue;
    }
    // C752: 마지막 문장이 이미 확정된 튜플 반환 UDF를 튜플 디스트럭처하는 암시 재반환 폼(C611
    // ExprStmt-tail tailCallee 자매 축, `outer() =>\n ... \n [a,b] = inner(...)`류).
    if (
      i === lastIdx &&
      s.kind === "TupleDestructure" &&
      s.value.kind === "CallExpr" &&
      s.value.callee.kind === "Identifier"
    ) {
      const tailCallee = prog.funcs.get(s.value.callee.name);
      if (tailCallee !== undefined && tailCallee.bodyAnalyzed && tailCallee.tupleArity !== null) {
        analyzeStmt(s, prog, bodyScope);
        info.tupleArity = tailCallee.tupleArity;
        info.tupleElemNonNumericKinds = tailCallee.tupleElemNonNumericKinds?.slice() ?? null;
        info.tupleElemUdtTypes = tailCallee.tupleElemUdtTypes?.slice() ?? null;
        prog.funcBodyTailTupleDestructures.add(s);
        continue;
      }
    }
    if (i === lastIdx && s.kind === "IfStmt") {
      const tupleReturn = tryFuncBodyIfTupleReturn(s, prog, bodyScope);
      if (tupleReturn !== null) {
        info.tupleArity = tupleReturn.arity;
        info.tupleElemNonNumericKinds = tupleReturn.elemKinds;
        info.tupleElemUdtTypes = new Array(tupleReturn.arity).fill(null);
        info.tupleElemContainerKinds = tupleReturn.elemContainerKinds;
        continue;
      }
    }
    if (i === lastIdx && s.kind === "SwitchStmt") {
      const tupleReturn = tryFuncBodySwitchTupleReturn(s, prog, bodyScope);
      if (tupleReturn !== null) {
        info.tupleArity = tupleReturn.arity;
        info.tupleElemNonNumericKinds = tupleReturn.elemKinds;
        info.tupleElemUdtTypes = new Array(tupleReturn.arity).fill(null);
        info.tupleElemContainerKinds = tupleReturn.elemContainerKinds;
        continue;
      }
    }
    // C765: 단문 화살표 본문이 ExprStmt{IfStmt|SwitchStmt}로 감싸진 폼(위 두 분기의 ExprStmt 자매축).
    if (i === lastIdx && s.kind === "ExprStmt" && (s.expr.kind === "IfStmt" || s.expr.kind === "SwitchStmt")) {
      const tupleReturn = analyzeFuncBodyTailWrappedCtrlFlow(s.expr, prog, bodyScope);
      if (tupleReturn !== null) {
        info.tupleArity = tupleReturn.arity;
        info.tupleElemNonNumericKinds = tupleReturn.elemKinds;
        info.tupleElemUdtTypes = new Array(tupleReturn.arity).fill(null);
        info.tupleElemContainerKinds = tupleReturn.elemContainerKinds;
      }
      continue;
    }
    // C610: 마지막 문장(암시 반환 위치)이 위 튜플 반환 폼으로 확정되지 못했는데(분기 arity
    // 불일치/스칼라 혼합/루프 말미 튜플) 그 말미에 TupleExpr가 남아 있으면 계속 거부 —
    // analyzeStmt의 문장 위치(값 폐기) 허용이 반환 값 위치까지 뚫으면 genImplicitReturn/
    // genBodyWithResult가 genExpr(TupleExpr) internal throw로 크래시한다(스캐너 주석 참조).
    if (i === lastIdx) {
      const trailing = findTrailingTupleExprInStmt(s);
      if (trailing !== null) {
        prog.errors.push(
          `튜플 리터럴은 함수의 마지막 문장(튜플 반환)에서만 지원 (L${trailing.line}:${trailing.col})`,
        );
      }
    }
    analyzeStmt(s, prog, bodyScope);
  }
  info.returnUdtType = inferFuncBodyReturnUdtType(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnArrayElemUdtType = inferFuncBodyReturnArrayElemUdtType(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnArrayElemDrawingKind = inferFuncBodyReturnArrayElemDrawingKind(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnContainerKind = inferFuncBodyReturnContainerKind(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnIsScalarSafe = inferFuncBodyReturnIsScalarSafe(stmt.body[lastIdx]!, info, prog, bodyScope);
  checkHistShadowConflicts(stmt.name, stmt.line, stmt.col, info, prog);
  info.bodyAnalyzed = true;
  resolvePendingTupleDestructuresFor(info, prog);
}

// C530: FuncDecl 마지막 문장의 request.security(sym, tf, [e1, e2, ...]) 튜플 리터럴 expression 콜
// 판별 — analyzeTupleDestructure의 seriesArg peek(C431 kwargs 폴백 포함)과 동일한 조회를 그대로
// 미러한다. 매치하면 튜플 원소 개수, 아니면 null(호출부가 일반 analyzeStmt 경로로 폴백).
function securityTupleReturnArity(expr: CallExpr): number | null {
  if (expr.callee.kind !== "DotAccess" || expr.callee.obj.kind !== "Identifier") return null;
  if (expr.callee.obj.name !== "request" || expr.callee.attr !== "security") return null;
  const seriesArg = expr.args[2] ?? expr.kwargs.find((kw) => kw.name === "expression")?.value;
  return seriesArg !== undefined && seriesArg.kind === "TupleExpr" ? seriesArg.elements.length : null;
}

// C611: FuncDecl 마지막 문장의 request.security(sym, tf, tupleUdf(...)) bare UDF 콜 판별 —
// analyzeTupleDestructure C432 분기의 seriesArg peek(kwargs 'expression=' 폴백 포함)과 동일한
// 조회를 그대로 미러한다(내부 콜리는 bodyAnalyzed + tupleArity 확정 UDF만 — forward-ref 대상 밖,
// C432 선례). 매치하면 내부 CallExpr와 그 FuncInfo, 아니면 null(호출부가 다음 폼 판별로 폴백).
function securityBareUdfTupleTail(
  expr: CallExpr,
  prog: AnalyzedProgram,
): { inner: CallExpr; func: FuncInfo } | null {
  if (expr.callee.kind !== "DotAccess" || expr.callee.obj.kind !== "Identifier") return null;
  if (expr.callee.obj.name !== "request" || expr.callee.attr !== "security") return null;
  const seriesArg = expr.args[2] ?? expr.kwargs.find((kw) => kw.name === "expression")?.value;
  if (seriesArg === undefined || seriesArg.kind !== "CallExpr" || seriesArg.callee.kind !== "Identifier") return null;
  const calleeFunc = prog.funcs.get(seriesArg.callee.name);
  if (calleeFunc === undefined || !calleeFunc.bodyAnalyzed || calleeFunc.tupleArity === null) return null;
  return { inner: seriesArg, func: calleeFunc };
}

// C412: analyzeTupleDestructure가 forward-ref UDF 튜플 콜사이트를 pendingUdfFunc로 미뤄둔 것을,
// analyzeFuncDecl이 그 함수의 tupleArity/tupleElemNonNumericKinds/tupleElemUdtTypes를 막 확정한
// 시점(bodyAnalyzed=true 직후)에 즉시 재개한다 — analyzeTupleDestructure의 arity-확정 후 3블록
// (즉시-에러/udtKindHints/topLevelTupleElemKinds)과 동일한 판정을 저장해둔 stmt/scope/
// registeredNames로 그대로 재현한다.
function resolvePendingTupleDestructuresFor(func: FuncInfo, prog: AnalyzedProgram): void {
  const list = prog.pendingTupleDestructures.get(func.name);
  if (list === undefined) return;
  prog.pendingTupleDestructures.delete(func.name);
  for (const { stmt, scope, registeredNames } of list) {
    const arity = func.tupleArity ?? null;
    if (arity === null) {
      prog.errors.push(`튜플 디스트럭처링의 값은 튜플을 반환하는 UDF 호출이어야 함 (L${stmt.line}:${stmt.col})`);
      continue;
    }
    if (arity !== stmt.names.length) {
      prog.errors.push(
        `튜플 디스트럭처링 개수 불일치: 대상 ${stmt.names.length}개, 함수는 ${arity}개 반환 (L${stmt.line}:${stmt.col})`,
      );
      continue;
    }
    const udfElemUdtTypes = func.tupleElemUdtTypes;
    if (udfElemUdtTypes) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const t = udfElemUdtTypes[i];
        if (t !== null && t !== undefined) scope.udtKindHints.set(name, t);
      });
    }
    // C649: forward-ref 콜사이트 자매 축(analyzeTupleDestructure의 동일 블록 주석 참조) — array/map
    // 원소 kind도 udtKindHints와 동일하게 func 경계/depth 게이트 없이 등록.
    const udfElemContainerKinds = func.tupleElemContainerKinds;
    if (udfElemContainerKinds) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const k = udfElemContainerKinds[i];
        if (k !== null && k !== undefined) scope.containerKindHints.set(name, k);
      });
    }
    // C650: forward-ref 콜사이트 자매 축(analyzeTupleDestructure의 동일 블록 주석 참조) —
    // array<UDT/drawing> 원소 kind도 동일하게 등록.
    const udfElemArrayUdtTypes = func.tupleElemArrayUdtTypes;
    if (udfElemArrayUdtTypes) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const t = udfElemArrayUdtTypes[i];
        if (t !== null && t !== undefined) scope.arrayElemUdtKindHints.set(name, t);
      });
    }
    const udfElemArrayDrawingKinds = func.tupleElemArrayDrawingKinds;
    if (udfElemArrayDrawingKinds) {
      const registeredSet = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registeredSet.has(name)) return;
        const dk = udfElemArrayDrawingKinds[i];
        if (dk !== null && dk !== undefined) scope.arrayElemDrawingKindHints.set(name, dk);
      });
    }
    if (scope.func === null && scope.depth === 0) {
      const udfElemKinds = func.tupleElemNonNumericKinds;
      const registered = new Set(registeredNames);
      stmt.names.forEach((name, i) => {
        if (name === "_" || !registered.has(name)) return;
        const kind = udfElemKinds === null ? "판별 불가한 타입" : (udfElemKinds[i] ?? null);
        prog.topLevelTupleElemKinds.set(name, kind);
      });
    }
  }
}

// C364: 히스토리 대상 이름이 같은 함수 안에서 '='로 재선언/섀도잉되면 record 주입(이름 기반)이
// 어느 변수를 기록하는지 모호해지므로 본문 분석 완료 후 하드 에러로 거부한다(FuncInfo.
// histShadowedNames 주석 참조 — 선언/읽기 소스 순서와 무관하게 잡히도록 사후 교차 검사).
function checkHistShadowConflicts(funcName: string, line: number, col: number, info: FuncInfo, prog: AnalyzedProgram): void {
  // localRefHistSlots(C541, drawing 핸들 판)도 같은 이름-기반 record 주입이라 동일한 모호성 거부가
  // 필요하다 — 두 맵은 kind 분기로 상호 배타(같은 이름이 양쪽에 들어갈 수 없음)라 단순 연결로 안전.
  // nestedHistShadowedNames(C714 UDF 확장, next_hint(C715))도 함께 검사한다 — 이름-키 축
  // (localHistSlots/localRefHistSlots)에 이미 슬롯을 받은 이름이 나중에(소스 순서상 앞/뒤 무관)
  // 중첩 블록에서 또 '='로 선언되면(analyzeAssignment 나머지 분기 참조) codegen의 record 주입이
  // 여전히 이름 하나로 두 물리 선언을 공유해버린다 — 순수 중첩-대-중첩(형제 블록끼리만) 충돌은
  // 애초에 이 이름-키 축을 안 타므로(전량 node-keyed) 여기 안 걸린다.
  for (const name of [...info.localHistSlots.keys(), ...info.localRefHistSlots.keys()]) {
    if (info.histShadowedNames.has(name) || info.nestedHistShadowedNames.has(name)) {
      prog.errors.push(
        `히스토리 인덱스 대상 '${name}'이 함수 '${funcName}' 안에서 '='로 재선언/섀도잉됨 — 히스토리가 어느 변수를 가리키는지 모호해 미지원 (L${line}:${col})`,
      );
    }
  }
}

// method name(params) => body — analyzeFuncDecl과 거의 동일한 처리(파라미터/본문 분석)이나 등록
// 키가 다르다: 원래 이름(stmt.name)이 아니라 "TypeName$methodName"(mangleMethodName)으로
// prog.funcs에 등록해 서로 다른 UDT의 동명 method가 항상 분리되게 한다(pine2py의 flat 네임스페이스
// 충돌 버그를 따르지 않기로 한 결정, LIMITATIONS.md 참조). 첫 매개변수의 typeHint가 이 method의
// 소속 UDT를 결정하며(TV v5 실제 문법), analyzer가 top-level을 소스 순서 그대로 단일 패스 처리하는
// 구조상 UDT 필드 타입(C123)과 동일하게 "이미 앞서 선언된 타입만" 허용한다(forward-ref 불가).
function analyzeMethodDecl(stmt: MethodDecl, prog: AnalyzedProgram, scope: LexScope): void {
  if (scope.depth !== 0) {
    prog.errors.push(`'method' 선언은 top-level에서만 가능: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  const firstParam = stmt.params[0];
  // C327: 첫 매개변수는 이미 선언된 UDT 타입 힌트이거나(기존), array<T>/map<K,V>/matrix<T> 제네릭
  // 컨테이너 타입 힌트(base로 접어줌)여야 한다. C328: float/int/bool/string/color 스칼라 타입
  // 힌트(resolveMethodReceiverTypeName이 그대로 typeName으로 통과시킴)도 허용. C676: drawing 핸들
  // 6종(label/line/box/table/polyline/linefill) 타입 힌트도 동일 원칙으로 허용(wild 실측
  // "UDT첫매개변수" 클러스터 31건 중 24건이 이 축, 대표 예시 `method setLine(line ln, ...) =>
  // ln.set_xy1(...)`) — resolveDrawingExprKind(analyzer.ts)가 이미 scope.func.paramTypeHints를
  // 직접 조회하는 폴백(C476)을 갖고 있어 본문 안 receiver 사용은 별도 배선 없이 그대로 동작. C677:
  // 이미 선언된 enum 타입 힌트도 동일 원칙으로 허용(잔여 7건 중 5건, wild TUF_LOGIC 라이브러리
  // `export method NOT(series Trilean self)=> ...`류 + get_pivot_resolution() 계열 `method
  // param(simple Timeframes input) => switch input ...`류) — resolveEnumExprType(analyzer.ts)이
  // paramTypeHints 직접 조회 폴백을 동일하게 갖춰(C676과 나란한 구조) 본문 안 receiver 사용도
  // 별도 배선 없이 동작.
  const typeName =
    firstParam !== undefined && firstParam.typeHint !== null
      ? resolveMethodReceiverTypeName(firstParam.typeHint, prog)
      : undefined;
  if (typeName === undefined) {
    prog.errors.push(
      `'method ${stmt.name}'의 첫 매개변수는 이미 선언된 UDT 타입 힌트, array<T>/map<K,V>/matrix<T> 컨테이너 타입 힌트, float/int/bool/string/color 스칼라 타입 힌트, label/line/box/table/polyline/linefill drawing 핸들 타입 힌트, 또는 이미 선언된 enum 타입 힌트가 필요함 (L${stmt.line}:${stmt.col})`,
    );
    return;
  }
  let mangledName = mangleMethodName(typeName, stmt.name);
  const existingInfo = prog.funcs.get(mangledName);
  if (existingInfo !== undefined) {
    // C687: arity-disjoint method 오버로드 — C686(FuncDecl AST rename prepass)의 method판. 콜사이트가
    // DotAccess sugar(receiver 타입이 analyze 시점에야 확정)라 AST rename/콜사이트 재배선이 불가능해,
    // 등록명만 `${base}$ov$k`로 분기하고 모든 조회 지점이 lookupMethodOverload(udt-types.ts)로
    // 콜사이트 인자 개수(receiver 포함) 기준 선택한다. [required, max] 범위가 기존 오버로드 전부와
    // 서로소일 때만 허용. C688: 범위가 겹쳐도 receiver가 array<drawing>이고 겹치는 상대 전부와
    // 원소 kind가 서로 다르면(wild `clear_aLabLin(label[] l)`/`(line[] l)` 쌍) 허용 — dispatch는
    // call-expr.ts array extension 분기가 resolveArrayElemDrawingKind로 확정한다. 그 외(같은 arity
    // 스칼라/UDT 원소, 2번째-매개변수 타입 분기 등 값 흐름 추적이 필요한 케이스)는 기존 하드 에러
    // 유지(C394 "틀린 추측보다 기회 손실이 안전").
    let required = 0;
    stmt.params.forEach((p, i) => {
      if (p.default === null) required = i + 1;
    });
    const max = stmt.params.length;
    const newElemKind = typeName === "array" ? methodReceiverElemDrawingKind(firstParam?.typeHint) : null;
    const entries = prog.methodOverloads.get(mangledName) ?? [
      {
        name: mangledName,
        min: existingInfo.requiredParamCount,
        max: existingInfo.paramNames.length,
        // 첫 선언의 elemKind는 지연 등록(두 번째 선언 시점) — FuncInfo.paramTypeHints에 남은
        // receiver 원문 힌트로 역산한다(analyzeMethodDecl 자신이 아래에서 채우는 값이라 항상 존재).
        elemKind:
          typeName === "array"
            ? methodReceiverElemDrawingKind(
                existingInfo.paramNames.length > 0 ? existingInfo.paramTypeHints.get(existingInfo.paramNames[0]!) : null,
              )
            : null,
      },
    ];
    const overlapping = entries.filter((e) => !(max < e.min || e.max < required));
    const elemDisjoint = newElemKind !== null && overlapping.every((e) => e.elemKind !== null && e.elemKind !== newElemKind);
    if (overlapping.length > 0 && !elemDisjoint) {
      prog.errors.push(`이미 정의된 method: '${typeName}.${stmt.name}' (L${stmt.line}:${stmt.col})`);
      return;
    }
    prog.methodOverloads.set(mangledName, entries);
    const concrete = `${mangledName}$ov$${entries.length + 1}`;
    entries.push({ name: concrete, min: required, max, elemKind: newElemKind });
    mangledName = concrete;
  }
  prog.methodDeclMangledNames.set(stmt, mangledName);

  const info: FuncInfo = {
    name: mangledName,
    paramNames: stmt.params.map((p) => p.name),
    requiredParamCount: 0,
    paramHasDefault: [],
    localVarSlots: [],
    localVarIndex: new Map(),
    localTaSlotCount: 0,
    tupleArity: null,
    tupleElemNonNumericKinds: null,
    tupleElemUdtTypes: null,
    tupleElemContainerKinds: null,
    tupleElemArrayUdtTypes: null,
    tupleElemArrayDrawingKinds: null,
    paramQualifiers: new Map(),
    localVarQualifiers: new Map(),
    paramUdtTypes: new Map(),
    paramArrayElemUdtTypes: new Map(),
    paramArrayElemDrawingKinds: new Map(),
    paramContainerKinds: new Map(),
    paramMatrixKinds: new Set(),
    paramDrawingKinds: new Map(),
    localVarDrawingKinds: new Map(),
    localVarUdtTypes: new Map(),
    localVarArrayElemUdtTypes: new Map(),
    localVarArrayElemDrawingKinds: new Map(),
    localVarMapValueUdtTypes: new Map(),
    localVarMapValueDrawingKinds: new Map(),
    returnUdtType: null,
    returnArrayElemUdtType: null,
    returnArrayElemDrawingKind: null,
    returnContainerKind: null,
    returnIsScalarSafe: false,
    // method는 forward-reference 대상이 아니다(prepass 없이 이 함수 안에서 한 번에 등록/분석) —
    // 항상 완전히 분석된 상태로 만들어지므로 생성 시점에 바로 true.
    bodyAnalyzed: true,
    calls: new Set(),
    localHistSlots: new Map(),
    localHistKinds: new Map(),
    localHistSlotCount: 0,
    localCallHistSlots: new Map(),
    localCondCallHistSlots: new Map(),
    localCondHistSlotCount: 0,
    localCondCallRefHistSlots: new Map(),
    localCondRefHistSlotCount: 0,
    localRefHistSlots: new Map(),
    localRefHistKinds: new Map(),
    localRefHistSlotCount: 0,
    localFieldHistSlots: new Map(),
    localFieldRefHistSlots: new Map(),
    paramTypeHints: new Map(),
    localVarTypeHints: new Map(),
    localVarValueKinds: new Map(),
    eqLocalNames: new Set(),
    tupleEqLocalNames: new Set(),
    localTupleElemKinds: new Map(),
    histShadowedNames: new Set(),
    nestedEqLocalNames: new Set(),
    nestedHistShadowedNames: new Set(),
    localAmbiguousNestedHistDeclSlots: new Map(),
    localAmbiguousNestedHistReadSlots: new Map(),
    localAmbiguousNestedRefDeclSlots: new Map(),
    localAmbiguousNestedRefReadSlots: new Map(),
    shadowedByTopLevelLocal: false,
    hasSecParamCalls: false,
  };
  stmt.params.forEach((p, i) => {
    info.paramHasDefault.push(p.default !== null);
    if (p.default === null) {
      info.requiredParamCount = i + 1;
    } else {
      analyzeExpr(p.default, prog, scope, false);
    }
  });
  prog.funcs.set(mangledName, info);

  const bodyScope = pushScope(scope, "udf-body", /* inLoop */ false, info);
  for (const p of stmt.params) {
    // C414: analyzeFuncDecl과 동일 원칙 — 매개변수명이 top-level var와 같아도 더 이상 거부하지
    // 않는다(genIdentifier/resolveAssignTarget의 funcCtx.paramNames 우선순위로 codegen이 올바르게
    // 처리).
    bodyScope.names.add(p.name);
    prog.locals.add(p.name);
    info.paramQualifiers.set(p.name, extractQualifierFromHint(p.typeHint) ?? "simple");
    const paramUdtType = resolveParamUdtTypeHint(p.typeHint, prog);
    if (paramUdtType !== undefined) info.paramUdtTypes.set(p.name, paramUdtType);
    info.paramTypeHints.set(p.name, p.typeHint);
  }
  // C693: analyzeFuncDecl과 동일한 본문 내부 자기참조 스캔(위 scanOwnParamContainerKindUsage
  // 주석 참조) — method 첫 매개변수(receiver)는 항상 typeHint가 있어 이 스캔 대상에서 자연 제외.
  {
    const untypedParamNames = new Set(
      stmt.params.filter((p) => p.typeHint === null && !info.paramContainerKinds.has(p.name)).map((p) => p.name),
    );
    if (untypedParamNames.size > 0) {
      const { containerKinds, matrixParamNames } = scanOwnParamContainerKindUsage(stmt.body, untypedParamNames);
      for (const [name, kind] of containerKinds) info.paramContainerKinds.set(name, kind);
      for (const name of matrixParamNames) info.paramMatrixKinds.add(name);
    }
  }
  if (stmt.body.length === 0) {
    prog.errors.push(`method 본문이 비어 있음: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    return;
  }
  const lastIdx = stmt.body.length - 1;
  for (let i = 0; i < stmt.body.length; i++) {
    const s = stmt.body[i]!;
    if (i === lastIdx && s.kind === "ExprStmt" && s.expr.kind === "TupleExpr") {
      const elements = s.expr.elements;
      info.tupleArity = elements.length;
      // C369: analyzeFuncDecl의 튜플 반환 분기와 동일 — 원소별 비수치 종류를 함께 확정한다
      // (method 튜플은 현재 디스트럭처 값 위치에서 소비 불가하지만 "tupleArity 확정 == 원소 kind
      // 확정" 불변식을 두 선언 경로에서 대칭으로 유지).
      info.tupleElemNonNumericKinds = elements.map((el) => {
        analyzeExpr(el, prog, bodyScope, false);
        return classifyTupleElemNonNumericKind(el, prog, bodyScope);
      });
      info.tupleElemUdtTypes = elements.map((el) => resolveTupleElemUdtType(el, prog, bodyScope));
      info.tupleElemContainerKinds = elements.map((el) => resolveContainerExprKind(el, prog, bodyScope));
      info.tupleElemArrayUdtTypes = elements.map((el) => resolveArrayElemUdtType(el, prog, bodyScope));
      info.tupleElemArrayDrawingKinds = elements.map((el) => resolveArrayElemDrawingKind(el, prog, bodyScope));
      continue;
    }
    // C630: analyzeFuncDecl의 C530/C611/C612/C629 flat 꼬리 커밋 분기 이식 — method는 이 4개 폼
    // (request.security 튜플 리터럴/bare-UDF passthrough/직접 튜플 UDF 콜 체인/ta.* 다중반환)을
    // 전부 놓치고 있었다(wild `method request(string timeframe, ...) => ... \n request.security(sym,
    // tf, [time, open], ...)` 관용구, 튜플 172-클러스터 dotaccess_other 서브패턴 최다 원인,
    // next_hint(C629)). analyzeFuncDecl과 동일한 순서/등록(tupleStateCalls 등)을 그대로 미러 —
    // genFuncBody/genImplicitReturn은 FuncInfo/program 맵만 읽어 decl 종류에 무관하므로(genMethodDecl이
    // genFuncBody를 공유) codegen 변경 0줄로 자동 충족.
    if (i === lastIdx && s.kind === "ExprStmt" && s.expr.kind === "CallExpr") {
      const secTupleArity = securityTupleReturnArity(s.expr);
      if (secTupleArity !== null) {
        prog.tupleStateCalls.add(s.expr);
        analyzeExpr(s.expr, prog, bodyScope, false);
        info.tupleArity = secTupleArity;
        info.tupleElemNonNumericKinds = new Array(secTupleArity).fill(null);
        info.tupleElemUdtTypes = new Array(secTupleArity).fill(null);
        continue;
      }
      const secBareUdfInner = securityBareUdfTupleTail(s.expr, prog);
      if (secBareUdfInner !== null) {
        prog.tupleStateCalls.add(s.expr);
        prog.securityBareUdfCallSlots.set(s.expr, secBareUdfInner.inner);
        analyzeExpr(s.expr, prog, bodyScope, false);
        info.tupleArity = secBareUdfInner.func.tupleArity;
        info.tupleElemNonNumericKinds = secBareUdfInner.func.tupleElemNonNumericKinds?.slice() ?? null;
        info.tupleElemUdtTypes = secBareUdfInner.func.tupleElemUdtTypes?.slice() ?? null;
        continue;
      }
      if (s.expr.callee.kind === "Identifier") {
        const tailCallee = prog.funcs.get(s.expr.callee.name);
        if (tailCallee !== undefined && tailCallee.bodyAnalyzed && tailCallee.tupleArity !== null) {
          analyzeStmt(s, prog, bodyScope);
          info.tupleArity = tailCallee.tupleArity;
          info.tupleElemNonNumericKinds = tailCallee.tupleElemNonNumericKinds?.slice() ?? null;
          info.tupleElemUdtTypes = tailCallee.tupleElemUdtTypes?.slice() ?? null;
          continue;
        }
      }
      const taArity = taMultiReturnTailArity(s.expr);
      if (taArity !== null) {
        prog.tupleStateCalls.add(s.expr);
        analyzeStmt(s, prog, bodyScope);
        info.tupleArity = taArity;
        info.tupleElemNonNumericKinds = new Array(taArity).fill(null);
        info.tupleElemUdtTypes = new Array(taArity).fill(null);
        continue;
      }
    }
    if (i === lastIdx && s.kind === "ExprStmt" && s.expr.kind === "TernaryOp") {
      const ternaryArity = detectTupleReturnArityFromTailExpr(s.expr, prog);
      if (ternaryArity !== null) {
        const result = analyzeTernaryTupleValue(s.expr, ternaryArity, prog, bodyScope);
        if (result.ok) {
          info.tupleArity = ternaryArity;
          info.tupleElemNonNumericKinds = result.elemKinds;
          info.tupleElemUdtTypes = new Array(ternaryArity).fill(null);
          info.tupleElemContainerKinds = result.elemContainerKinds;
          continue;
        }
      }
    }
    if (
      i === lastIdx &&
      s.kind === "TupleDestructure" &&
      s.value.kind === "CallExpr" &&
      securityTupleReturnArity(s.value) !== null
    ) {
      analyzeStmt(s, prog, bodyScope);
      info.tupleArity = s.names.length;
      info.tupleElemNonNumericKinds = new Array(s.names.length).fill(null);
      info.tupleElemUdtTypes = new Array(s.names.length).fill(null);
      continue;
    }
    // C752: analyzeFuncDecl의 동명 분기 참조 — TA 다중반환 콜 튜플 디스트럭처 암시 재반환.
    if (
      i === lastIdx &&
      s.kind === "TupleDestructure" &&
      s.value.kind === "CallExpr" &&
      taMultiReturnTailArity(s.value) !== null
    ) {
      analyzeStmt(s, prog, bodyScope);
      info.tupleArity = s.names.length;
      info.tupleElemNonNumericKinds = new Array(s.names.length).fill(null);
      info.tupleElemUdtTypes = new Array(s.names.length).fill(null);
      prog.funcBodyTailTupleDestructures.add(s);
      continue;
    }
    // C752: analyzeFuncDecl의 동명 분기 참조 — 확정 튜플 반환 UDF 체인 튜플 디스트럭처 암시 재반환.
    if (
      i === lastIdx &&
      s.kind === "TupleDestructure" &&
      s.value.kind === "CallExpr" &&
      s.value.callee.kind === "Identifier"
    ) {
      const tailCallee = prog.funcs.get(s.value.callee.name);
      if (tailCallee !== undefined && tailCallee.bodyAnalyzed && tailCallee.tupleArity !== null) {
        analyzeStmt(s, prog, bodyScope);
        info.tupleArity = tailCallee.tupleArity;
        info.tupleElemNonNumericKinds = tailCallee.tupleElemNonNumericKinds?.slice() ?? null;
        info.tupleElemUdtTypes = tailCallee.tupleElemUdtTypes?.slice() ?? null;
        prog.funcBodyTailTupleDestructures.add(s);
        continue;
      }
    }
    if (i === lastIdx && s.kind === "IfStmt") {
      const tupleReturn = tryFuncBodyIfTupleReturn(s, prog, bodyScope);
      if (tupleReturn !== null) {
        info.tupleArity = tupleReturn.arity;
        info.tupleElemNonNumericKinds = tupleReturn.elemKinds;
        info.tupleElemUdtTypes = new Array(tupleReturn.arity).fill(null);
        info.tupleElemContainerKinds = tupleReturn.elemContainerKinds;
        continue;
      }
    }
    if (i === lastIdx && s.kind === "SwitchStmt") {
      const tupleReturn = tryFuncBodySwitchTupleReturn(s, prog, bodyScope);
      if (tupleReturn !== null) {
        info.tupleArity = tupleReturn.arity;
        info.tupleElemNonNumericKinds = tupleReturn.elemKinds;
        info.tupleElemUdtTypes = new Array(tupleReturn.arity).fill(null);
        info.tupleElemContainerKinds = tupleReturn.elemContainerKinds;
        continue;
      }
    }
    // C765: analyzeFuncDecl의 동일 가드 참조 — 단문 화살표 본문이 ExprStmt{IfStmt|SwitchStmt}로
    // 감싸진 폼.
    if (i === lastIdx && s.kind === "ExprStmt" && (s.expr.kind === "IfStmt" || s.expr.kind === "SwitchStmt")) {
      const tupleReturn = analyzeFuncBodyTailWrappedCtrlFlow(s.expr, prog, bodyScope);
      if (tupleReturn !== null) {
        info.tupleArity = tupleReturn.arity;
        info.tupleElemNonNumericKinds = tupleReturn.elemKinds;
        info.tupleElemUdtTypes = new Array(tupleReturn.arity).fill(null);
        info.tupleElemContainerKinds = tupleReturn.elemContainerKinds;
      }
      continue;
    }
    // C610: analyzeFuncDecl의 동일 가드 주석 참조 — 마지막 문장(암시 반환 위치) 말미의
    // 미확정 TupleExpr는 계속 거부(값 폐기 허용이 반환 값 위치까지 뚫지 않게).
    if (i === lastIdx) {
      const trailing = findTrailingTupleExprInStmt(s);
      if (trailing !== null) {
        prog.errors.push(
          `튜플 리터럴은 함수의 마지막 문장(튜플 반환)에서만 지원 (L${trailing.line}:${trailing.col})`,
        );
      }
    }
    analyzeStmt(s, prog, bodyScope);
  }
  info.returnUdtType = inferFuncBodyReturnUdtType(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnArrayElemUdtType = inferFuncBodyReturnArrayElemUdtType(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnArrayElemDrawingKind = inferFuncBodyReturnArrayElemDrawingKind(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnContainerKind = inferFuncBodyReturnContainerKind(stmt.body[lastIdx]!, info, prog, bodyScope);
  info.returnIsScalarSafe = inferFuncBodyReturnIsScalarSafe(stmt.body[lastIdx]!, info, prog, bodyScope);
  checkHistShadowConflicts(stmt.name, stmt.line, stmt.col, info, prog);
}

// 함수/method 본문의 마지막 문장에서 반환되는 값이 UDT 인스턴스인지 추론한다(C253, FuncInfo.returnUdtType
// 주석 참조) — analyzeFuncDecl/analyzeMethodDecl 양쪽이 본문 분석 루프를 마친 뒤(bodyScope에 그
// 문장까지의 '=' 로컬 UDT 힌트가 이미 누적된 상태) 호출한다. tupleArity가 이미 정해졌으면(튜플 반환)
// 단일값 UDT 반환과 양립 불가라 즉시 null. 그 외는 inferReturnStmtUdtType에 위임(ExprStmt/IfStmt
// 재귀 판별, C264).
function inferFuncBodyReturnUdtType(
  lastStmt: Stmt,
  info: FuncInfo,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): string | null {
  if (info.tupleArity !== null) return null;
  return inferReturnStmtUdtType(lastStmt, prog, bodyScope);
}

// 문장 하나가 암묵 반환하는 UDT 타입을 재귀적으로 추론한다(C264, 540460278459.pine
// `if src > sma \n Signal.new(...) \n else \n Signal.new(...)` 패턴 해소 — ROADMAP P4 next_hint).
// ExprStmt는 기존 판별(Identifier면 resolveUdtObjectType, 아니면 isUdtConstructorCall)을 그대로
// 쓴다. IfStmt는 then(+elif 전부)의 마지막 문장이 재귀적으로 전부 같은 non-null 타입일 때 그 타입을
// 반환한다 — else가 없거나 비어 있으면 TV 자체가 "그 분기 미충족 시 na"로 취급하는 것과 동형이라
// (공식 문서: else 없는 if-식은 조건 불충족 시 na) then 타입을 그대로 승격한다(C770, wild
// 15f45c768d6d.pine `pivots(...) => if bar_index>=length ... chart.point.from_time(...)`류 — 콜사이트가
// `if not na(H)`로 이미 na를 직접 가드하는 관용구, 이전엔 else 없다는 이유만으로 무조건 null 처리해
// 정상 UDT 필드 읽기를 "네임스페이스 접근은 호출식만 지원"으로 오분류했던 실제 버그, DIVERGENCES 참조).
// else가 "있지만" then과 다른 타입이면 여전히 null(모순 없는 정보만 승격). SwitchStmt는 corpus 근거
// 0건이라 범위 밖(LIMITATIONS.md 참조) — 그 외 kind는 전부 null. codegen은 변경 불필요:
// genReturnIfStmt/genReturnBlock이 이미 각 분기 마지막 문장을 이와 동일한 구조로 재귀 return
// 처리해 이 패턴을 그대로 방출한다(else 없으면 그 분기는 그대로 undefined/na로 떨어짐 — 런타임
// na 필드 접근이 실제로 일어나면 TV처럼 에러가 나는 게 정합, 타입 게이트만 완화하는 것).
// scope는 재귀 전체에서 bodyScope 그대로 고정 전달(분기별 실제 중첩 블록 스코프가 아님) — if/else
// 분기 안에서 새로 선언된 '=' 로컬을 그 분기의 마지막 문장으로 반환하는 경우(현재 corpus 근거 0건)는
// resolveUdtObjectType이 그 로컬을 못 찾아 조용히 null(안전한 false negative, 오탐 아님)로 빠진다 —
// corpus에 그런 사례가 나오면 그때 실제 분기 스코프 전달로 확장할 것.
function inferReturnStmtUdtType(stmt: Stmt, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (stmt.kind === "ExprStmt") {
    const expr = stmt.expr;
    if (expr.kind === "Identifier") return resolveUdtObjectType(expr, prog, scope) ?? null;
    return isUdtConstructorCall(expr, prog, scope);
  }
  // Assignment-tail(C705, C704와 나란한 확장 — next_hint(C704)): var 없는 '=' 신규 로컬 선언이
  // 마지막 문장이면 그 값 표현식이 암묵 반환된다. ExprStmt 분기와 동일 판별을 stmt.value에 적용.
  if (stmt.kind === "Assignment" && stmt.operator === "=") {
    const expr = stmt.value;
    if (expr.kind === "Identifier") return resolveUdtObjectType(expr, prog, scope) ?? null;
    return isUdtConstructorCall(expr, prog, scope);
  }
  if (stmt.kind === "IfStmt") {
    if (stmt.thenBody.length === 0) return null;
    const thenType = inferReturnStmtUdtType(stmt.thenBody[stmt.thenBody.length - 1]!, prog, scope);
    if (thenType === null) return null;
    for (const clause of stmt.elifClauses) {
      if (clause.body.length === 0 || inferReturnStmtUdtType(clause.body[clause.body.length - 1]!, prog, scope) !== thenType) {
        return null;
      }
    }
    if (stmt.elseBody === null || stmt.elseBody.length === 0) return thenType;
    const elseType = inferReturnStmtUdtType(stmt.elseBody[stmt.elseBody.length - 1]!, prog, scope);
    return elseType === thenType ? thenType : null;
  }
  return null;
}

// 함수/method 본문의 마지막 문장에서 반환되는 값이 "원소 타입이 등록된 UDT인 array"인지 추론한다
// (C458, FuncInfo.returnArrayElemUdtType 주석 참조) — inferFuncBodyReturnUdtType(단일 UDT 버전)과
// 완전히 동일한 구조/호출 시점(bodyScope에 그 문장까지의 '=' 로컬 array-elem-UDT 힌트가 이미
// 누적된 상태). tupleArity가 이미 정해졌으면 즉시 null.
function inferFuncBodyReturnArrayElemUdtType(
  lastStmt: Stmt,
  info: FuncInfo,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): string | null {
  if (info.tupleArity !== null) return null;
  return inferReturnStmtArrayElemUdtType(lastStmt, prog, bodyScope);
}

// inferReturnStmtUdtType과 완전히 동일한 재귀 구조의 array-elem 버전(C458) — ExprStmt는
// resolveArrayElemUdtType(Identifier만 해당, C393 arrayElemUdtKindHints 조회) 하나로 충분하다
// (isUdtConstructorCall 같은 "생성자 콜 직접 반환" 분기는 제외 — array.new<T>() 같은 생성자 콜을
// 마지막 문장으로 바로 반환하는 corpus 근거가 아직 없어 과욕 금지, Identifier 경유 관용구만 지원).
function inferReturnStmtArrayElemUdtType(stmt: Stmt, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (stmt.kind === "ExprStmt") {
    const expr = stmt.expr;
    return expr.kind === "Identifier" ? resolveArrayElemUdtType(expr, prog, scope) : null;
  }
  // Assignment-tail(C705, inferReturnStmtUdtType과 나란함) — ExprStmt와 동일 Identifier-only 판별.
  if (stmt.kind === "Assignment" && stmt.operator === "=") {
    const expr = stmt.value;
    return expr.kind === "Identifier" ? resolveArrayElemUdtType(expr, prog, scope) : null;
  }
  if (stmt.kind === "IfStmt") {
    if (stmt.thenBody.length === 0) return null;
    const thenType = inferReturnStmtArrayElemUdtType(stmt.thenBody[stmt.thenBody.length - 1]!, prog, scope);
    if (thenType === null) return null;
    for (const clause of stmt.elifClauses) {
      if (clause.body.length === 0 || inferReturnStmtArrayElemUdtType(clause.body[clause.body.length - 1]!, prog, scope) !== thenType) {
        return null;
      }
    }
    // else 없음/공백 = TV의 "그 분기 미충족 시 na" 취급과 동형(C770, inferReturnStmtUdtType 주석 참조).
    if (stmt.elseBody === null || stmt.elseBody.length === 0) return thenType;
    const elseType = inferReturnStmtArrayElemUdtType(stmt.elseBody[stmt.elseBody.length - 1]!, prog, scope);
    return elseType === thenType ? thenType : null;
  }
  return null;
}

// inferFuncBodyReturnArrayElemUdtType과 완전히 나란한 drawing 버전(C683, FuncInfo.returnArrayElemDrawingKind
// 주석 참조). tupleArity가 이미 정해졌으면 즉시 null.
function inferFuncBodyReturnArrayElemDrawingKind(
  lastStmt: Stmt,
  info: FuncInfo,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): DrawingKind | null {
  if (info.tupleArity !== null) return null;
  return inferReturnStmtArrayElemDrawingKind(lastStmt, prog, bodyScope);
}

// inferReturnStmtArrayElemUdtType과 완전히 동일한 재귀 구조의 drawing 버전(C683) — ExprStmt는
// resolveArrayElemDrawingKind(Identifier만 해당, C620 arrayElemDrawingKindHints 조회) 하나로 충분하다.
function inferReturnStmtArrayElemDrawingKind(stmt: Stmt, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (stmt.kind === "ExprStmt") {
    const expr = stmt.expr;
    return expr.kind === "Identifier" ? resolveArrayElemDrawingKind(expr, prog, scope) : null;
  }
  // Assignment-tail(C705, inferReturnStmtUdtType과 나란함) — ExprStmt와 동일 Identifier-only 판별.
  if (stmt.kind === "Assignment" && stmt.operator === "=") {
    const expr = stmt.value;
    return expr.kind === "Identifier" ? resolveArrayElemDrawingKind(expr, prog, scope) : null;
  }
  if (stmt.kind === "IfStmt") {
    if (stmt.thenBody.length === 0) return null;
    const thenKind = inferReturnStmtArrayElemDrawingKind(stmt.thenBody[stmt.thenBody.length - 1]!, prog, scope);
    if (thenKind === null) return null;
    for (const clause of stmt.elifClauses) {
      if (clause.body.length === 0 || inferReturnStmtArrayElemDrawingKind(clause.body[clause.body.length - 1]!, prog, scope) !== thenKind) {
        return null;
      }
    }
    // else 없음/공백 = TV의 "그 분기 미충족 시 na" 취급과 동형(C770, inferReturnStmtUdtType 주석 참조).
    if (stmt.elseBody === null || stmt.elseBody.length === 0) return thenKind;
    const elseKind = inferReturnStmtArrayElemDrawingKind(stmt.elseBody[stmt.elseBody.length - 1]!, prog, scope);
    return elseKind === thenKind ? thenKind : null;
  }
  return null;
}

// 함수/method 본문의 마지막 문장에서 반환되는 값이 array/map 컨테이너 자신인지 추론한다(C651,
// FuncInfo.returnContainerKind 주석 참조) — inferFuncBodyReturnArrayElemUdtType(원소 UDT 타입)과
// 나란한 구조/호출 시점이나, 이건 반환값 자체의 종류만 본다. tupleArity가 이미 정해졌으면 즉시 null.
function inferFuncBodyReturnContainerKind(
  lastStmt: Stmt,
  info: FuncInfo,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): "array" | "map" | null {
  if (info.tupleArity !== null) return null;
  return inferReturnStmtContainerKind(lastStmt, prog, bodyScope);
}

// inferReturnStmtArrayElemUdtType과 동일한 재귀 구조의 컨테이너-자신 버전(C651) — ExprStmt는 (1)
// 생성자 콜을 직접 반환(`array.new<float>(...)`/`map.new<K,V>()`, wild `mean(data,weights,len) =>
// ... \n array.new<float>(len, sum/weights.sum())`류 — inferReturnStmtArrayElemUdtType 주석이
// "corpus 근거 없어 과욕 금지"로 유보해둔 바로 그 폼, 이제 근거 확보) (2) Identifier면
// resolveContainerExprKind 재사용(func-local var가 명시 typeHint 또는 다른 컨테이너-반환 UDF 콜로
// 종류가 확정된 경우 포함, wild `getRootCodeMap() => var map<string,string> x = createRootCodeMap()
// \n x`류) 둘 다 커버한다.
function inferReturnStmtContainerKind(stmt: Stmt, prog: AnalyzedProgram, scope: LexScope): "array" | "map" | null {
  if (stmt.kind === "ExprStmt") {
    const expr = stmt.expr;
    if (expr.kind === "Identifier") return resolveContainerExprKind(expr, prog, scope);
    if (isArrayConstructorCall(expr, prog, scope)) return "array";
    if (isMapConstructorCall(expr, prog, scope)) return "map";
    return null;
  }
  // Assignment-tail(C705, inferReturnStmtUdtType과 나란함) — ExprStmt와 동일 판별을 stmt.value에 적용.
  if (stmt.kind === "Assignment" && stmt.operator === "=") {
    const expr = stmt.value;
    if (expr.kind === "Identifier") return resolveContainerExprKind(expr, prog, scope);
    if (isArrayConstructorCall(expr, prog, scope)) return "array";
    if (isMapConstructorCall(expr, prog, scope)) return "map";
    return null;
  }
  if (stmt.kind === "IfStmt") {
    if (stmt.thenBody.length === 0) return null;
    const thenKind = inferReturnStmtContainerKind(stmt.thenBody[stmt.thenBody.length - 1]!, prog, scope);
    if (thenKind === null) return null;
    for (const clause of stmt.elifClauses) {
      if (clause.body.length === 0 || inferReturnStmtContainerKind(clause.body[clause.body.length - 1]!, prog, scope) !== thenKind) {
        return null;
      }
    }
    // else 없음/공백 = TV의 "그 분기 미충족 시 na" 취급과 동형(C770, inferReturnStmtUdtType 주석 참조).
    if (stmt.elseBody === null || stmt.elseBody.length === 0) return thenKind;
    const elseKind = inferReturnStmtContainerKind(stmt.elseBody[stmt.elseBody.length - 1]!, prog, scope);
    return elseKind === thenKind ? thenKind : null;
  }
  return null;
}

// FuncInfo.returnIsScalarSafe(C520, index-access.ts "히스토리 인덱스는 stateful TA 콜에만 지원"
// 클러스터 — UDF 콜 결과 f()[N] 확장)를 채운다. tupleArity!==null이면 즉시 false(튜플 반환은
// f()[N] 문법 자체가 성립 안 함). 마지막 문장이 단일 ExprStmt일 때만 classifyTupleElemNonNumericKind
// (C369, 튜플 원소 참조형 판별기 — string/array/map/matrix/drawing/UDT 전부 커버)를 그 반환식에
// 재사용해 null(비-참조형 확정)이면 true. if/switch 암묵 반환 등 다른 구조는 corpus 근거 없어
// 보수적으로 false(inferReturnStmtArrayElemUdtType의 "생성자 콜 직접 반환은 범위 밖" 원칙과 동형).
// C704(wild 다수 — `f(x) =>\n    value = expr` 관용구, 예 `f_linearregressionslope`/`ATR`류 UDF가
// var 없이 마지막 문장을 '='로 새로 로컬 선언해 암묵 반환): 위 ExprStmt 전용 판정이 이 흔한 폼을
// 놓쳐 늘 false로 떨어지던 비대칭. Assignment(operator "=")도 그 값 표현식(lastStmt.value)을 동일
// 판별기에 재귀시켜 인정한다 — persistent(var/varip, VarDecl 별도 kind)는 여전히 범위 밖(그 값이
// 매 바 갱신 안 될 수 있어 별도 검토 필요, corpus 근거 없음)이고 ':='(재대입)도 제외(첫 선언이 아닌
// 값이 마지막 문장인 경우는 다른 시맨틱 축이라 과욕 금지).
function inferFuncBodyReturnIsScalarSafe(lastStmt: Stmt, info: FuncInfo, prog: AnalyzedProgram, bodyScope: LexScope): boolean {
  if (info.tupleArity !== null) return false;
  return inferStmtReturnIsScalarSafe(lastStmt, prog, bodyScope);
}

// inferFuncBodyReturnIsScalarSafe의 IfStmt/SwitchStmt 암묵 반환 재귀 확장(C712, wild
// `f(x) =>\n  if cond\n    a\n  else\n    b`/`f(t) => switch t\n  "A" => x\n  => y`류 다수
// 관용구 — codegen(genReturnIfStmt/genReturnSwitchStmt)은 이 구조를 이미 완전히 지원하는데
// (모든 분기 재귀 + else/default 없는 분기의 스칼라 NaN 폴백까지, C573) 히스토리 인덱싱 안전성
// 판별(이 함수)만 ExprStmt/Assignment 두 형태로 좁아 f()[N] 화이트리스트(index-access.ts
// isUserFuncScalarSafeHistoryCall)에서 늘 거부되던 비대칭. genReturnIfStmt/genReturnSwitchStmt와
// 동일하게 각 분기(thenBody/elifClauses/elseBody, cases)의 마지막 문장을 재귀 판정 — else/default가
// 없는 분기는 codegen이 스칼라 NaN을 폴백 return하므로(C573) 안전으로 간주. inferReturnStmtUdtType류
// (C458/C683/C705)와 달리 "모든 분기가 같은 타입"을 요구하지 않는다 — 여긴 "모든 분기가 비-참조형
// (숫자 계열)인가"만 확인하면 되므로 분기별 값이 달라도 무방. scope는 C705 선례(inferReturnStmtUdtType
// 계열)와 동일하게 bodyScope를 그대로 재사용 — 중첩 분기 전용 scope를 새로 push하지 않는다
// (classifyTupleElemNonNumericKind가 인식 못하는 구조는 기본 null=안전으로 접혀 보수성 방향의
// 오차만 생기고, 참조형을 숫자로 오판할 위험은 없다).
function inferStmtReturnIsScalarSafe(stmt: Stmt, prog: AnalyzedProgram, scope: LexScope): boolean {
  if (stmt.kind === "ExprStmt") return classifyTupleElemNonNumericKind(stmt.expr, prog, scope) === null;
  if (stmt.kind === "Assignment" && stmt.operator === "=") {
    return classifyTupleElemNonNumericKind(stmt.value, prog, scope) === null;
  }
  if (stmt.kind === "IfStmt") {
    if (stmt.thenBody.length === 0) return false;
    if (!inferStmtReturnIsScalarSafe(stmt.thenBody[stmt.thenBody.length - 1]!, prog, scope)) return false;
    for (const clause of stmt.elifClauses) {
      if (clause.body.length === 0 || !inferStmtReturnIsScalarSafe(clause.body[clause.body.length - 1]!, prog, scope)) {
        return false;
      }
    }
    if (stmt.elseBody !== null) {
      if (stmt.elseBody.length === 0) return false;
      return inferStmtReturnIsScalarSafe(stmt.elseBody[stmt.elseBody.length - 1]!, prog, scope);
    }
    return true;
  }
  if (stmt.kind === "SwitchStmt") {
    if (stmt.cases.length === 0) return false;
    for (const c of stmt.cases) {
      if (c.body.length === 0 || !inferStmtReturnIsScalarSafe(c.body[c.body.length - 1]!, prog, scope)) return false;
    }
    return true;
  }
  return false;
}

// 참조형(array/map/matrix/UDT) 생성자 콜 판별 술어(ARRAY_CONSTRUCTOR_METHODS/MAP_CONSTRUCTOR_METHODS/
// MATRIX_CONSTRUCTOR_METHODS + isArrayConstructorCall/isMapConstructorCall/isUdtConstructorCall/
// isMatrixConstructorCall/isMatrixMultCall/isMatrixMultVectorArg)는 analyzer/constructors.ts로
// 이전(analyzer.ts 파일 분할 세 번째 슬라이스) — 유일한 소비처인 analyzeVarDecl은 그대로 아래에 남음.

function analyzeVarDecl(stmt: VarDecl, prog: AnalyzedProgram, scope: LexScope): void {
  // UDF 본문 안(scope.func!==null)의 var/varip는 스크립트 전역 슬롯 배열(prog.varSlots)이 아니라
  // 그 함수 전용 함수-상대 슬롯에 들어간다 — call-site별 독립 상태(slotBase)는 이 함수-상대
  // 인덱스에 호출부마다 다른 베이스를 더해 만든다(analyzeCallExpr 참조). 함수 안에서도 var 이름은
  // (a) 그 함수 안에서 중복 금지 (b) 전역 var 슬롯 이름과 충돌 금지 — codegen의 식별자 우선순위가
  // "함수 로컬 슬롯 > 전역 var 슬롯 > 로컬"이라 충돌 시 혼란을 피하기 위해 보수적으로 막는다.
  const func = scope.func;
  let registered = false;
  if (func) {
    if (func.localVarIndex.has(stmt.name) || prog.varIndex.has(stmt.name)) {
      prog.errors.push(`중복 var 선언: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
    } else {
      const slot = func.localVarSlots.length;
      func.localVarSlots.push(stmt.name);
      func.localVarIndex.set(stmt.name, slot);
      registered = true;
      // func-local var의 drawing kind 추적(C358, C124 paramUdtTypes 원칙을 var 선언에도 적용):
      // 초기값이 label/line/box/table/polyline/linefill 생성자 콜이거나(드묾), wild 지배적 관용구인
      // `var box drawBox = na`(명시 typeHint, 조건부 대입 패턴)면 typeHint로 인식한다 — top-level
      // drawingKind(바로 아래 else 분기)는 생성자 콜만 보지만 여긴 typeHint 폴백까지 추가한다(explicit
      // typeHint가 UDT 축(explicitUdtType)에선 이미 top-level도 신뢰하는 신호라 func-local 확장에도
      // 안전).
      const drawingKind =
        isDrawingConstructorCall(stmt.value) ??
        (stmt.typeHint !== null && DRAWING_ALL_NAMESPACES.has(stmt.typeHint) ? (stmt.typeHint as DrawingKind) : null);
      if (drawingKind !== null) func.localVarDrawingKinds.set(stmt.name, drawingKind);
      // 히스토리 슬롯(Float64Array) 타입 가드용 추적(C364, ROADMAP 🔴🔴 (b)슬라이스 — 이전 주석
      // "UDF 내부 var는 히스토리 인덱싱 자체가 거부되는 위치라 추적 불필요"는 이번 슬라이스로
      // 무효). typeHint는 raw 보존(읽기 시점 lazy 분류 — FuncInfo.localVarTypeHints 주석 참조),
      // 초기값 생성자 콜 판별은 선언 시점에만 가능해 종류 문구로 접어 저장.
      func.localVarTypeHints.set(stmt.name, stmt.typeHint);
      // 별칭 대입(C427, 바로 아래 top-level var 분기의 aliasedContainerKind와 동일 원칙 — func-local
      // var도 RHS가 이미 컨테이너 종류가 확정된 다른 Identifier를 그대로 참조하면 물려받는다).
      // TernaryOp도 포함(C428, resolveContainerExprKind의 TernaryOp 분기 참조 — 삼항 양쪽이 같은
      // 종류로 확정되면 물려받는다). CallExpr도 포함(C682, wild `fvgDn = fvg(-3)` \ `fvgDn.size()`류 —
      // bare UDF 콜 RHS는 resolveContainerExprKind 자신은 이미 CallExpr 분기(FuncInfo.returnContainerKind)를
      // 지원하는데 이 게이트가 Identifier/TernaryOp로만 좁혀 그 분기 진입 자체를 막고 있었음). DotAccess도
      // 포함(C709, wild `g_boxs = box_row.g_box`류 UDT 필드 별칭 — resolveContainerExprKind 자신은
      // 이미 DotAccess를 resolveUdtFieldTypeHint 폴백으로 지원하는데 이 게이트가 그 진입 자체를 막고
      // 있었음, C682와 동일한 3-way 비대칭 패턴).
      const funcLocalAliasedContainerKind =
        stmt.value.kind === "Identifier" ||
        stmt.value.kind === "TernaryOp" ||
        stmt.value.kind === "CallExpr" ||
        stmt.value.kind === "DotAccess"
          ? resolveContainerExprKind(stmt.value, prog, scope)
          : null;
      // 명시 typeHint 폴백(C651, 바로 위 drawingKind의 typeHint 폴백과 나란함 — UDT/drawing 축엔
      // 이미 있었으나 array/map 축엔 없던 3-way 비대칭). wild `getRootCodeMap() => var map<string,
      // string> x = createRootCodeMap() \n x`류 — RHS가 map.new<K,V>() 리터럴도 aliased Identifier도
      // 아닌 임의 UDF 콜이라도, 명시 `map<string,string>` typeHint 하나로 종류가 이미 확정된다.
      const typeHintContainerKind = containerKindFromTypeHint(stmt.typeHint);
      if (isStringExpr(stmt.value)) func.localVarValueKinds.set(stmt.name, "string");
      else if (
        isArrayConstructorCall(stmt.value, prog, scope) ||
        isDrawingAllConstant(stmt.value) ||
        funcLocalAliasedContainerKind === "array" ||
        typeHintContainerKind === "array"
      ) {
        func.localVarValueKinds.set(stmt.name, "array");
        // array<UDT> 원소 타입 힌트(func-local var 버전, C638 — top-level var(L4597 부근)/'=' 로컬
        // (L4736 부근)과 완전히 동일한 계산을 func-local var에도 적용, FuncInfo.localVarArrayElemUdtTypes
        // 주석 참조).
        const funcLocalElemUdtType =
          (stmt.typeHint !== null ? arrayUdtElemType(stmt.typeHint, prog) : null) ?? arrayUdtConstructorElemType(stmt.value, prog, scope);
        if (funcLocalElemUdtType !== null) func.localVarArrayElemUdtTypes.set(stmt.name, funcLocalElemUdtType);
        // array<drawing> 원소 kind 힌트(func-local var 버전, C650 — 바로 위 funcLocalElemUdtType과
        // 완전히 나란한 구조): top-level var/'=' 로컬/매개변수 셋 다 있던 이 축이 func-local var에만
        // 없던 3-way 비대칭(FuncInfo.localVarArrayElemDrawingKinds 주석 참조).
        const funcLocalElemDrawingKind =
          (stmt.typeHint !== null ? arrayDrawingElemType(stmt.typeHint) : null) ?? arrayDrawingConstructorElemKind(stmt.value, prog);
        if (funcLocalElemDrawingKind !== null) func.localVarArrayElemDrawingKinds.set(stmt.name, funcLocalElemDrawingKind);
      } else if (
        isMapConstructorCall(stmt.value, prog, scope) ||
        funcLocalAliasedContainerKind === "map" ||
        typeHintContainerKind === "map"
      ) {
        func.localVarValueKinds.set(stmt.name, "map");
        // map<K, UDT/drawing> 값 타입 힌트(func-local var 버전, C684 — 바로 위 array 분기의
        // funcLocalElemUdtType/funcLocalElemDrawingKind와 완전히 나란한 구조): 명시 typeHint
        // "map<K,V>" 또는 map.new<K,V>() 생성자 콜이 보존한 V.
        const funcLocalMapValueUdtType =
          (stmt.typeHint !== null ? mapValueUdtElemType(stmt.typeHint, prog) : null) ?? mapUdtConstructorValueType(stmt.value, prog);
        if (funcLocalMapValueUdtType !== null) func.localVarMapValueUdtTypes.set(stmt.name, funcLocalMapValueUdtType);
        const funcLocalMapValueDrawingKind =
          (stmt.typeHint !== null ? mapValueDrawingElemType(stmt.typeHint) : null) ?? mapDrawingConstructorValueKind(stmt.value);
        if (funcLocalMapValueDrawingKind !== null) func.localVarMapValueDrawingKinds.set(stmt.name, funcLocalMapValueDrawingKind);
      } else if (isMatrixConstructorCall(stmt.value) || isMatrixMultCall(stmt.value)) func.localVarValueKinds.set(stmt.name, "matrix");
      else {
        // func-local var의 실제 UDT 타입명 추적(C392, drawingKind 바로 위와 동일 원칙의 UDT 축 —
        // top-level analyzeVarDecl의 explicitUdtType/inferredUdtType(L2503 부근)과 완전히 대칭):
        // `var Swing s = na`처럼 초기값이 na라 생성자 콜 판별(isUdtConstructorCall)만으로는 못 잡는
        // 관용구가 wild 지배적이라 명시 typeHint 폴백이 필수 — 이게 없으면 이 함수가 s를 그대로
        // 반환할 때 FuncInfo.returnUdtType 추론(inferReturnStmtUdtType -> resolveUdtObjectType)이
        // 실패해 호출부(`x = f()` 후 `x.field`)까지 연쇄적으로 막힌다. chart.point는 prog.udtTypes에
        // 없는 특수 값 타입(C486/C487, CHART_POINT_FIELD_TYPE)이라 udtTypes.has만으로는 인식되지
        // 않는다 — analyzeAssignment('=' 로컬, C487)와 동일하게 명시적으로 함께 인정한다(C518,
        // parseVarDecl이 이제 `var chart.point p = ...`를 파싱할 수 있게 되며 드러난 대칭 갭).
        const explicitUdtType =
          stmt.typeHint !== null && (prog.udtTypes.has(stmt.typeHint) || stmt.typeHint === CHART_POINT_FIELD_TYPE)
            ? stmt.typeHint
            : null;
        const inferredUdtType = isUdtConstructorCall(stmt.value, prog, scope);
        if (explicitUdtType !== null && inferredUdtType !== null && explicitUdtType !== inferredUdtType) {
          prog.errors.push(
            `선언 타입 '${explicitUdtType}'과 생성자 타입 '${inferredUdtType}'가 다름: '${stmt.name}' (L${stmt.line}:${stmt.col})`,
          );
        }
        const udtTypeName = explicitUdtType ?? inferredUdtType;
        if (udtTypeName !== null) {
          func.localVarUdtTypes.set(stmt.name, udtTypeName);
          func.localVarValueKinds.set(stmt.name, "UDT");
        }
      }
    }
  } else if (
    // C728(배치37 (2) 블록-스코프 변수 슬롯 추적 첫 슬라이스): depth>0(if/for/while 등 중첩 블록)
    // 안의 var 선언은 이름이 아니라 "이 스코프(또는 조상)가 이미 같은 이름을 직접 선언했는가"로
    // 충돌을 판정한다 — 서로소 형제 블록(if A/if not A 등)은 조상 관계가 아니므로 절대 충돌하지
    // 않는다(wild `if showzigzag\n var line zzline=na` vs `if not showzigzag\n var line zzline=na`류,
    // LIMITATIONS C682). depth===0(스크립트 최상위)은 기존 그대로 이름 하나당 슬롯 하나뿐인 평면
    // 충돌 판정 유지.
    scope.depth > 0
      ? scope.nestedVarDeclStmts.has(stmt.name) ||
        (scope.parent !== null && resolveAmbiguousNestedVarDeclStmt(scope.parent, stmt.name) !== null) ||
        prog.varIndex.has(stmt.name)
      : prog.varIndex.has(stmt.name)
  ) {
    prog.errors.push(`중복 var 선언: '${stmt.name}' (L${stmt.line}:${stmt.col})`);
  } else {
    const slot = prog.varSlots.length;
    prog.varSlots.push(stmt.name);
    if (scope.depth > 0) {
      // 물리 슬롯은 이 VarDecl 노드로만 키잉(이름 공유 무관 — 형제 블록의 동명 선언과 절대 안
      // 섞임). scope.names에도 등록해 analyzeExpr Identifier 케이스의 scopeHasLocal 가시성 판정이
      // "이 선언의 자손 스코프에서만 알려진 이름"을 그대로 재사용하게 한다(LexScope 주석 참조).
      prog.nestedVarDeclSlots.set(stmt, slot);
      scope.nestedVarDeclStmts.set(stmt.name, stmt);
      scope.names.add(stmt.name);
    } else {
      prog.varIndex.set(stmt.name, slot);
    }
    prog.varTypeHints.set(stmt.name, stmt.typeHint);
    // 초기값이 array 생성 콜이면 array를 담는 var로 표시(C79) — 히스토리 인덱싱 차단에만 쓰인다
    // (AnalyzedProgram.arrayVars 주석 참조). UDF 내부 var(위 func 분기)는 히스토리 인덱싱 자체가
    // 이미 거부되는 위치라 추적 불필요.
    // prog+scope를 함께 넘겨 method-call 스타일로 체이닝된 생성자 반환 콜도 인정한다(C223,
    // C222 next_hint 1순위 -- constructors.ts의 확장 주석 참조).
    // 별칭 대입(C427, `before = amount_array`처럼 RHS가 이미 컨테이너 종류가 확정된 다른
    // Identifier를 그대로 참조하는 형태) — resolveContainerExprKind가 이미 그 이름의 종류를 알고
    // 있으면 그대로 물려받는다(값 흐름 추적이 아니라 "참조 재대입" 1단계 구조 판별,
    // isArrayConstructorCall/isMapConstructorCall과 동일한 순수 구조 검사 원칙). TernaryOp도
    // 포함(C428, resolveContainerExprKind의 TernaryOp 분기 참조). CallExpr도 포함(C682, func-local
    // var 분기의 funcLocalAliasedContainerKind와 동일한 3-way 대칭 수정 — bare UDF 콜 RHS
    // `var y = helper()`류). DotAccess도 포함(C709, funcLocalAliasedContainerKind와 동일한 3-way
    // 확장 — `var g_boxs = box_row.g_box`류 UDT 필드 별칭).
    const aliasedContainerKind =
      stmt.value.kind === "Identifier" ||
      stmt.value.kind === "TernaryOp" ||
      stmt.value.kind === "CallExpr" ||
      stmt.value.kind === "DotAccess"
        ? resolveContainerExprKind(stmt.value, prog, scope)
        : null;
    if (isArrayConstructorCall(stmt.value, prog, scope) || aliasedContainerKind === "array") prog.arrayVars.add(stmt.name);
    // 초기값이 label.all 등 drawing '.all' 상수면 array를 담는 var로 표시(C244, isArrayConstructorCall과
    // 동일 원칙 — `var lbls = label.all`처럼 값 위치 DotAccess를 그대로 var 초기값으로 쓰는 패턴).
    if (isDrawingAllConstant(stmt.value)) prog.arrayVars.add(stmt.name);
    // 초기값이 map.new/map.copy 콜이면 map을 담는 var로 표시(C89, arrayVars와 동일 원칙).
    if (isMapConstructorCall(stmt.value, prog, scope) || aliasedContainerKind === "map") prog.mapVars.add(stmt.name);
    // 명시 typeHint 기반 폴백(C415, containerKindFromTypeHint 주석 참조): 값이 위 생성자 콜/판별
    // 어디에도 안 걸려도(`var array<T> x = na` 후 조건부 ':=' 재할당, 또는 array를 반환하는 UDF
    // 콜 초기값 등) 선언에 붙은 "array<T>"/"map<K,V>" 타입힌트 자체가 이미 컨테이너 종류를
    // 확정한다 — 아래 UDT explicitUdtType과 동일 원칙을 컨테이너 종류에도 적용. arrayElemUdtType/
    // arrayElemDrawingKind는 이미 typeHint만으로 무조건 계산되므로(아래 L2941/2946 참조) 이 등록
    // 하나로 원소 타입 힌트까지 자동으로 딸려온다.
    const declaredContainerKind = containerKindFromTypeHint(stmt.typeHint);
    if (declaredContainerKind === "array") prog.arrayVars.add(stmt.name);
    else if (declaredContainerKind === "map") prog.mapVars.add(stmt.name);
    // 초기값이 matrix.new 콜이면 matrix를 담는 var로 표시(C90, arrayVars/mapVars와 동일 원칙).
    if (isMatrixConstructorCall(stmt.value)) prog.matrixVars.add(stmt.name);
    // matrix<drawing/UDT> 원소 타입 추적(C618, 바로 위 arrayElemUdtType/arrayElemDrawingKind 등록
    // (L4356 부근)과 동일 원칙 -- matrix.new<T>() 제네릭 생성자 콜의 T만 신호로 본다).
    const matrixElemDrawing = matrixDrawingConstructorElemKind(stmt.value);
    if (matrixElemDrawing !== null) prog.matrixElemDrawingKind.set(stmt.name, matrixElemDrawing);
    const matrixElemUdt = matrixUdtConstructorElemType(stmt.value, prog);
    if (matrixElemUdt !== null) prog.matrixElemUdtType.set(stmt.name, matrixElemUdt);
    // 초기값이 matrix.mult 콜이면 두 번째 인자 타입에 따라 array/matrix 중 하나로 분류(C97,
    // isMatrixMultVectorArg 주석 참조) — 메서드 이름만으로 정할 수 없는 유일한 matrix.* 사례.
    // scope도 함께 넘겨 두 번째 인자가 '=' 로컬 array여도 판별(C503).
    if (isMatrixMultCall(stmt.value)) {
      const otherArg = (stmt.value as CallExpr).args[1];
      if (otherArg !== undefined && isMatrixMultVectorArg(otherArg, prog, scope)) prog.arrayVars.add(stmt.name);
      else prog.matrixVars.add(stmt.name);
    }
    // UDT 인스턴스를 담는 var 판별은 두 신호 중 하나만 있어도 충분 — (a) 명시적 타입 힌트가
    // 등록된 UDT 이름(`var Foo p = na`처럼 초기값이 생성자 콜이 아니어도 힌트만으로 확정 가능,
    // varTypeHints의 "string" 판별과 동일한 파서 경로를 그냥 재사용), (b) 초기값이
    // `TypeName.new(...)` 콜(`var p = Foo.new(...)`처럼 힌트 없는 타입 추론). 둘 다 있는데
    // 서로 다르면 선언 타입과 생성자 타입이 불일치하는 실제 에러. chart.point는 prog.udtTypes에
    // 없는 특수 값 타입(C486/C487, CHART_POINT_FIELD_TYPE)이라 udtTypes.has만으로는 인식되지 않는다
    // — func-local 분기(바로 위) 및 analyzeAssignment('=' 로컬, C487)와 동일하게 명시적으로 함께
    // 인정한다(C518, parseVarDecl이 이제 `var chart.point p = ...`를 파싱할 수 있게 되며 드러난
    // 대칭 갭 — 이게 없으면 p가 prog.udtVarTypes에 등록 안 돼 이후 `p.price` 필드 접근이 "네임스페이스
    // 접근은 호출식만 지원"으로 오판된다).
    const explicitUdtType =
      stmt.typeHint !== null && (prog.udtTypes.has(stmt.typeHint) || stmt.typeHint === CHART_POINT_FIELD_TYPE)
        ? stmt.typeHint
        : null;
    const inferredUdtType = isUdtConstructorCall(stmt.value, prog, scope);
    if (explicitUdtType !== null && inferredUdtType !== null && explicitUdtType !== inferredUdtType) {
      prog.errors.push(
        `선언 타입 '${explicitUdtType}'과 생성자 타입 '${inferredUdtType}'가 다름: '${stmt.name}' (L${stmt.line}:${stmt.col})`,
      );
    }
    const udtTypeName = explicitUdtType ?? inferredUdtType;
    if (udtTypeName !== null) prog.udtVarTypes.set(stmt.name, udtTypeName);
    // enum 인스턴스를 담는 var 판별(C677, 바로 위 udtTypeName과 나란한 구조 -- prog.enumVarTypes
    // 주석 참조): (a) 명시 typeHint가 등록된 enum 이름(wild `var StatStyle slope_style =
    // input.enum(...)`류), (b) 초기값이 `input.enum(EnumType.member, ...)` 콜(typeHint 생략).
    const explicitEnumType = stmt.typeHint !== null ? (enumTypeFromTypeHint(stmt.typeHint, prog) ?? null) : null;
    const inferredEnumType = inferEnumConstructorType(stmt.value, prog);
    const enumTypeName = explicitEnumType ?? inferredEnumType;
    if (enumTypeName !== null) prog.enumVarTypes.set(stmt.name, enumTypeName);
    // array<UDT> 원소 타입 추적(C341, arrayVars 바로 위 주석 참조): 명시 typeHint가
    // "array<등록된 UDT명>"일 때 기록(arrayUdtElemType) -- 또는(C355) typeHint 생략이어도 초기값이
    // `array.new<UDT>()` 생성자 콜 자체면 파서가 보존해둔 genericElemType으로 구조 판별
    // (arrayUdtConstructorElemType, elemDrawingKind 바로 아래의 arrayDrawingConstructorElemKind와
    // 나란한 패턴). 드물게 명시 typeHint가 있는데 그것도 UDT가 아닐 수 있어(`array<label>` 등)
    // typeHint 경로 실패 시에만 생성자 경로로 폴백. scope를 함께 넘겨(C457) `array.copy(container)`/
    // method-sugar `container.copy()`도 container의 이미 확정된 원소 UDT 타입을 그대로 물려받는다.
    const elemUdtType =
      (stmt.typeHint !== null ? arrayUdtElemType(stmt.typeHint, prog) : null) ?? arrayUdtConstructorElemType(stmt.value, prog, scope);
    if (elemUdtType !== null) prog.arrayElemUdtType.set(stmt.name, elemUdtType);
    // array<drawing> 원소 kind 추적(C352, 바로 위 arrayElemUdtType과 동일 원칙): typeHint가
    // "array<box>"류로 명시됐거나(드묾), 초기값이 array.new_box() 등 typed 생성자 콜이면(wild
    // 실측의 지배적 형태) 기록한다.
    const elemDrawingKind = arrayDrawingConstructorElemKind(stmt.value, prog) ?? (stmt.typeHint !== null ? arrayDrawingElemType(stmt.typeHint) : null);
    if (elemDrawingKind !== null) prog.arrayElemDrawingKind.set(stmt.name, elemDrawingKind);
    // map<K, UDT/drawing> 값 타입 추적(C684, 바로 위 arrayElemUdtType/arrayElemDrawingKind와 동일
    // 원칙의 map 버전): 명시 typeHint "map<K,V>" 또는 초기값 map.new<K,V>() 생성자 콜이 보존한 V.
    const mapValUdtType =
      (stmt.typeHint !== null ? mapValueUdtElemType(stmt.typeHint, prog) : null) ?? mapUdtConstructorValueType(stmt.value, prog);
    if (mapValUdtType !== null) prog.mapValueUdtType.set(stmt.name, mapValUdtType);
    const mapValDrawingKind =
      (stmt.typeHint !== null ? mapValueDrawingElemType(stmt.typeHint) : null) ?? mapDrawingConstructorValueKind(stmt.value);
    if (mapValDrawingKind !== null) prog.mapValueDrawingKind.set(stmt.name, mapValDrawingKind);
    // 초기값이 label/line/box/table/polyline 생성자(new, label/line/box는 copy도) 콜이면 그 kind로
    // 표시(C232, arrayVars/mapVars/matrixVars와 동일 원칙 — corpus 재스캔이 발견한 `var t =
    // table.new(...)` 1건 대응, drawingKindHints 주석 참조). 생성자 콜이 아니어도 명시 typeHint가
    // DRAWING_ALL_NAMESPACES 멤버면 typeHint로 폴백(C359, func-local 분기(C358, L2020-2022)와 대칭 —
    // wild 지배적 관용구 `var line bull_line = na` 처럼 na 초기값 + 명시 typeHint만 있는 패턴).
    const drawingKind =
      isDrawingConstructorCall(stmt.value) ??
      (stmt.typeHint !== null && DRAWING_ALL_NAMESPACES.has(stmt.typeHint) ? (stmt.typeHint as DrawingKind) : null);
    if (drawingKind !== null) prog.drawingVarKinds.set(stmt.name, drawingKind);
    registered = true;
  }
  analyzeControlFlowOrExpr(stmt.value, prog, scope);
  if (registered) {
    const qualifier = inferQualifier(stmt.value, prog, scope);
    if (func) func.localVarQualifiers.set(stmt.name, qualifier);
    else prog.varQualifiers.set(stmt.name, qualifier);
  }
}

function analyzeAssignment(stmt: Assignment, prog: AnalyzedProgram, scope: LexScope): void {
  const func = scope.func;
  const isFuncLocalVar = func !== null && func.localVarIndex.has(stmt.name);
  // C728: 이 대입이 중첩 top-level var(depth>0)를 가리키는지 미리 확인 — ':=' 재대입 대상 슬롯
  // 기록과 '=' 하드 에러 판정 둘 다 이 결과를 공유한다(scope 체인 접근이 여기서만 가능,
  // codegen은 이 함수가 record해둔 결과만 노드 키로 조회).
  // C729(배치37(2) 2차 슬라이스): resolveAmbiguousNestedVarDeclStmt 단독 대신 var/eq-local 겸용
  // resolveNestedVarOrEqLocalKind를 쓴다 — '=' 분기가 "가장 가까운 선언이 var 자신의 스코프인지,
  // 아니면 그보다 얕은 자손 스코프의 기존 섀도인지"를 구분해야 하기 때문(아래 주석 참조).
  const nestedKind = func === null ? resolveNestedVarOrEqLocalKind(scope, stmt.name) : null;
  const nestedVarDecl = nestedKind?.kind === "var" ? nestedKind.decl : null;
  let isNewLocal = false;
  if (stmt.operator === ":=") {
    if (nestedVarDecl !== null) {
      prog.nestedVarAssignSlots.set(stmt, prog.nestedVarDeclSlots.get(nestedVarDecl)!);
    } else if (nestedKind?.kind === "eq-local") {
      // C729: 이 이름을 재대입하는 ':='가 var보다 가까운 기존 '=' 섀도를 가리킨다 — 그 섀도가
      // flat top-level var도 함께 가리는 이름이면 codegen이 program.varIndex를 건너뛰도록 표시.
      if (prog.varIndex.has(stmt.name)) prog.eqLocalShadowedVarAssigns.add(stmt);
    } else if (!isFuncLocalVar && !prog.varIndex.has(stmt.name) && !scopeHasLocal(scope, stmt.name)) {
      prog.errors.push(
        `':='는 이미 선언된 변수에만 사용 가능 (var 또는 '='로 먼저 선언): '${stmt.name}' (L${stmt.line}:${stmt.col})`,
      );
    }
  } else {
    // C679(a): func 본문 안 '='가 이 함수 자신의 'var' 선언(isFuncLocalVar)이 아니라 이름만 같은
    // outer top-level var를 가리키면 재대입 금지 규칙 대상이 아니다 — TV는 이를 그 이름의 새
    // func-local shadow로 컴파일한다(재대입이 아님, tv_verdict_v2.jsonl 실측 accept). codegen의
    // genIdentifier/resolveAssignTarget은 이미 funcCtx.bodyLocalNames를 program.varIndex보다
    // 먼저 확인해(C568/C414) 이 shadow를 올바르게 컴파일하므로 여기서 else 분기로 흘려보내기만
    // 하면 된다.
    // C729: top-level(func===null)도 이제 대칭이다 — 단 "var 선언 스코프 자신"에서의 '=' 재대입만
    // 하드 에러다(TV 실측 reject, `var x=1\nx=2` 같은 줄 블록). 그보다 **얕은 자손 스코프**의 '='는
    // 새 섀도 선언이라(TV 실측 accept, wild `var float entry_price=na` 후 중첩 if 안
    // `entry_price=(close+high)/2`) 아래 else 분기로 흘려보낸다 — flat var(scope.depth===0에서
    // 곧 그 선언 스코프 자신)와 중첩 var(nestedKind가 "이 scope 자신"이 선언 스코프인지는
    // scope.nestedVarDeclStmts로 직접 재확인) 둘 다 같은 원칙.
    const isOwnScopeVarReassign =
      func === null &&
      ((scope.depth === 0 && prog.varIndex.has(stmt.name)) ||
        (nestedKind?.kind === "var" && scope.nestedVarDeclStmts.get(stmt.name) === nestedKind.decl));
    if (isFuncLocalVar || isOwnScopeVarReassign) {
      prog.errors.push(
        `var로 선언된 변수는 '='로 재대입할 수 없음, ':=' 사용: '${stmt.name}' (L${stmt.line}:${stmt.col})`,
      );
    } else {
      // C413(wild "이미 함수로 선언된 이름은 top-level '=' 변수로 재사용할 수 없음" 42건):
      // '=' 로컬이 이미 선언된 UDF와 이름을 공유하는 패턴 — TV는 call-vs-value 문법
      // (뒤따르는 괄호 유무)으로 두 네임스페이스를 분리해 실제 유효한 코드다(FuncInfo.
      // shadowedByTopLevelLocal 주석 참조 — pine2py는 이 조합에서 런타임 크래시라 오라클 불가,
      // hand-verified로 지원). codegen이 이 함수의 JS 바인딩만 mangle해 이 raw 식별자와 분리하므로
      // (funcCodegenName) 여기서는 그 함수의 FuncInfo에 플래그만 세우고 이 로컬은 평범하게
      // 등록한다. C576: 원래 top-level(scope.func===null && depth===0)만 대상이었으나 "이미
      // let 블록 스코프 섀도잉이라 안전"이라는 전제가 틀렸음이 wild corpus로 확인됨 —
      // `avg_plot() => avg = avg(x)` 류(func-local '=' 로컬이 같은 이름의 top-level UDF를 자신의
      // 초기값 식에서 호출)는 JS `let avg = avg(x)`로 내려가는데 let의 TDZ가 이 자기참조 RHS
      // 호출까지 새 바인딩으로 가로채 "Cannot access 'avg' before initialization"로 크래시한다
      // (exec 클러스터 실증, LIMITATIONS C576). 모든 스코프에서 무조건 플래그를 세워도 안전 —
      // funcCodegenName은 이 함수의 선언/전체 콜사이트를 항상 함께 mangle하므로 로컬 쪽 raw
      // 식별자와 절대 충돌하지 않는다.
      const collidingFunc = prog.funcs.get(stmt.name);
      if (collidingFunc !== undefined) collidingFunc.shadowedByTopLevelLocal = true;
      scope.names.add(stmt.name);
      prog.locals.add(stmt.name);
      isNewLocal = true;
      // top-level(조건부 아님) '=' 로컬 히스토리 배정 대상 표시(C363 — topLevelLocalNames 주석
      // 참조). scope.func===null && scope.depth===0은 codegen의 top-level 문장 루프(genStmt
      // nested=false)와 정확히 같은 조건이라, 여기서 등록된 이름만 JS `var name`(함수 스코프,
      // 바 종료 후 record 시점까지 값이 살아있음)으로 컴파일된다. depth>0(중첩 블록)은 C450부터
      // 별도 축(nestedTopLevelEqLocalNames)으로 등록 — 두 축이 같은 이름을 공유하면(재선언/섀도잉)
      // record가 어느 선언을 가리키는지 모호해지므로 UDF의 eqLocalNames/histShadowedNames(C364/C388)
      // 와 동일한 상호 배제 검사를 적용한다.
      if (scope.func === null) {
        if (scope.depth === 0) {
          prog.topLevelLocalNames.add(stmt.name);
          if (prog.nestedTopLevelEqLocalNames.has(stmt.name)) prog.nestedTopLevelHistShadowedNames.add(stmt.name);
        } else {
          // C714: 이 스코프(블록) 자신이 직접 선언한 이 대입문을 항상 기록해둔다 — 섀도잉으로
          // nestedTopLevelHistShadowedNames에 빠지더라도(아래 분기) 형제 블록과 물리적으로 다른
          // scope 객체라 이름이 겹쳐도 이 맵은 절대 섞이지 않는다(index-access.ts
          // resolveAmbiguousNestedEqLocalDeclStmt가 조상 스코프 탐색으로 정확히 하나만 찾아낸다).
          scope.nestedEqLocalDeclStmts.set(stmt.name, stmt);
          if (prog.topLevelLocalNames.has(stmt.name) || prog.nestedTopLevelEqLocalNames.has(stmt.name)) {
            prog.nestedTopLevelHistShadowedNames.add(stmt.name);
          } else {
            prog.nestedTopLevelEqLocalNames.add(stmt.name);
          }
        }
      }
      // UDF 내부 히스토리 대상 판별용 추적(C364, 중첩 블록 허용은 C388 — FuncInfo.eqLocalNames/
      // histShadowedNames 주석 참조): '=' 선언은 어느 깊이(udf-body 루트든 if/for 중첩이든)든
      // 히스토리 지원 대상이다 — resolveFuncInternalRole의 조상-스코프 탐색이 "읽기 지점이 선언
      // 스코프의 자손"임을 이미 구조적으로 보장해(JS let 블록 스코프 가시성과 정확히 같은 조건)
      // record 주입 지점(genStmt Assignment 분기, 중첩 여부 무관하게 항상 존재)도 항상 안전하다.
      // C714 UDF 확장(next_hint(C715)): udf-body 루트(scope.kind==="udf-body", top-level depth-0과
      // 동일한 "무조건 매 호출 실행" 자리)는 예전처럼 이름-키(func.eqLocalNames)로 남기지만, 중첩
      // 블록(if/for/while 등)은 top-level 중첩 블록(C450/C714)과 동형으로 대입문 AST 노드로 키잉한다
      // (scope.nestedEqLocalDeclStmts) — 형제 블록마다 독립적으로 같은 이름을 선언하는 wild 관용구
      // (alpha/a_trendline류, LIMITATIONS C369 "TV는 섀도우 로컬의 독립 시리즈")를 지원. 매개변수/
      // 튜플 디스트럭처와의 충돌은 node-keying으로 안 풀리는 진짜 충돌이라 여전히 histShadowedNames로
      // 블랭킷 거부(checkHistShadowConflicts가 선언 순서와 무관하게 사후 교차 검사).
      if (func !== null) {
        if (scope.kind === "udf-body") {
          // C535: tupleEqLocalNames와도 교차 검사 — TupleDestructure가 먼저 이 이름을 등록해뒀으면
          // ('=' Assignment가 나중에 같은 이름을 재선언) 서로 다른 물리 로컬인데 histSlot 이름이
          // 겹치는 동일한 모호성이라 대칭으로 처리해야 한다.
          if (func.paramNames.includes(stmt.name) || func.eqLocalNames.has(stmt.name) || func.tupleEqLocalNames.has(stmt.name)) {
            func.histShadowedNames.add(stmt.name);
          } else {
            func.eqLocalNames.add(stmt.name);
          }
          if (func.nestedEqLocalNames.has(stmt.name)) func.nestedHistShadowedNames.add(stmt.name);
        } else {
          if (func.paramNames.includes(stmt.name) || func.tupleEqLocalNames.has(stmt.name)) {
            func.histShadowedNames.add(stmt.name);
          } else {
            scope.nestedEqLocalDeclStmts.set(stmt.name, stmt);
            if (func.eqLocalNames.has(stmt.name) || func.nestedEqLocalNames.has(stmt.name)) {
              func.nestedHistShadowedNames.add(stmt.name);
            } else {
              func.nestedEqLocalNames.add(stmt.name);
            }
          }
        }
      }
    }
  }
  // plot()/hline() 대입-RHS(`p1 = plot(...)`, `h1 = hline(...)`, C209) — v5는 이 두 함수를 "스크립트
  // 최상위(local scope 아님)"이기만 하면 bare ExprStmt든 '=' 대입 RHS든 모두 허용한다(fill()에 넘길
  // plot 핸들을 얻는 표준 관용구, corpus 12건 실측). 기존 topLevel 판정("scope.depth===0 AND
  // ExprStmt"이 한 플래그로 뭉쳐 있던 것, C135)에서 "대입 RHS냐 아니냐" 축만 분리 — depth===0이면
  // ExprStmt와 동등하게 취급한다(그 외 NOOP_BUILTIN_TOPLEVEL 형제/directive는 이 예외 대상이 아님,
  // 아래 analyzeControlFlowOrExpr의 좁은 게이트 참조). var 선언(analyzeVarDecl)의 RHS는 이 예외
  // 대상이 아니다(plot()은 매 바 호출돼야 하는데 var 초기값은 once-only 게이트라 시맨틱이 다름 —
  // corpus에도 이 조합은 없음).
  analyzeControlFlowOrExpr(stmt.value, prog, scope, scope.depth === 0);
  if (isNewLocal) {
    scope.qualifiers.set(stmt.name, inferQualifier(stmt.value, prog, scope));
    // str.tostring int/float 갭 잔여 스코프 (4, C201/LIMITATIONS.md): '=' 로컬이 정수 리터럴 또는
    // (for 루프 카운터를 경유해) 이미 int로 확정된 다른 '=' 로컬을 직접 대입받으면 이 로컬도 int로
    // 표시 -- isStaticIntExpr의 Identifier 분기(resolveLocalNumType)가 그대로 체이닝을 처리하므로
    // 다단계 대입(`m = n; n = k`)도 별도 로직 없이 자동으로 전파된다. Pine 타입 시스템상 '='가 확정한
    // 타입은 이후 ':='로 바뀌지 않으므로(정상 스크립트 한정) for 루프 카운터와 동일한 안전성 근거.
    if (isStaticIntExpr(stmt.value, prog, scope)) scope.numTypeHints.set(stmt.name, "int");
    // 문자열 힌트(C363, LexScope.stringLocalHints 주석 참조): '=' 로컬이 순수 구문상 문자열식
    // (isStringExpr)을 직접 대입받으면 기록 — 히스토리 슬롯(Float64Array 기반)이 문자열을 담을 수
    // 없다는 var string 가드(varTypeHints)를 '=' 로컬에 미러링.
    if (isStringExpr(stmt.value)) scope.stringLocalHints.add(stmt.name);
    // for-in 이터러블 종류 힌트(C216, containerKindHints 주석 참조): '=' 로컬이 array/map 생성자
    // 콜을 직접 대입받으면 기록. isArrayConstructorCall/isMapConstructorCall은 analyzeVarDecl이
    // top-level var에 쓰는 것과 동일한 순수 구조 판별 — prog+scope를 넘기면 method-call 스타일로
    // 체이닝된 생성자 반환 콜(`b = a.slice(0,3)`)의 한 단계 체이닝까지만 resolveContainerExprKind로
    // 인정한다(C223). 값 흐름 추적(UDF 매개변수/복합식 등)은 여전히 하지 않는다(과욕 금지).
    // 별칭 대입(C427, `before = amount_array`처럼 RHS가 이미 컨테이너 종류가 확정된 다른
    // Identifier를 그대로 참조하는 형태) — resolveContainerExprKind가 이미 그 이름의 종류를 알고
    // 있으면 그대로 물려받는다(top-level var 분기의 aliasedContainerKind와 동일 원칙, C79/C89와
    // 나란한 "참조 재대입" 1단계 구조 판별). 삼항 별칭도 포함(C428, wild `_tFactors = _tIdx==0 ?
    // _cf0 : _tIdx==1 ? _cf1 : _cf2` — resolveContainerExprKind의 TernaryOp 분기가 양쪽이 같은
    // 종류로 확정될 때만 인정).
    // CallExpr도 포함(C682, top-level var/func-local var 분기와 동일한 3-way 대칭 수정 — wild
    // `fvgDn = fvg(-3)` \ `fvgDn.size()`류 bare UDF 콜 RHS가 resolveContainerExprKind 자신은 이미
    // 지원하는 CallExpr 분기(FuncInfo.returnContainerKind)에 이 게이트가 진입 자체를 막고 있었음).
    // DotAccess도 포함(C709, 동일한 3-way 대칭 확장 — wild `g_boxs = box_row.g_box`류 UDT 필드
    // 별칭이 중첩 for-in 이터러블로 쓰이는 관용구, resolveContainerExprKind 자신은 이미 DotAccess를
    // resolveUdtFieldTypeHint 폴백으로 지원하는데 이 게이트가 그 진입 자체를 막고 있었음).
    const aliasedContainerKind =
      stmt.value.kind === "Identifier" ||
      stmt.value.kind === "TernaryOp" ||
      stmt.value.kind === "CallExpr" ||
      stmt.value.kind === "DotAccess"
        ? resolveContainerExprKind(stmt.value, prog, scope)
        : null;
    if (isArrayConstructorCall(stmt.value, prog, scope) || aliasedContainerKind === "array") {
      scope.containerKindHints.set(stmt.name, "array");
      // array<UDT> 원소 타입 힌트('=' 로컬 버전, C393 — arrayElemUdtKindHints 주석/resolveArrayElemUdtType
      // 참조): analyzeVarDecl의 var 분기(L2543 부근)와 완전히 동일한 계산을 '=' 로컬에도 적용.
      // scope 전달(C457): array.copy(container)/container.copy()가 이미 확정된 container 원소
      // UDT 타입을 물려받는 축까지 대칭 적용 — wild `sorted_levels = array.copy(sr_levels)`류.
      const arrayElemUdtType =
        (stmt.typeHint !== null ? arrayUdtElemType(stmt.typeHint, prog) : null) ?? arrayUdtConstructorElemType(stmt.value, prog, scope);
      if (arrayElemUdtType !== null) scope.arrayElemUdtKindHints.set(stmt.name, arrayElemUdtType);
      // array<drawing> 원소 kind 힌트('=' 로컬 버전, C620 — 바로 위 arrayElemUdtType과 완전히
      // 나란한 구조): analyzeVarDecl의 var 분기(elemDrawingKind, L4379 부근)와 동일한 계산을 '='
      // 로컬에도 적용. wild `array<box> b_oxes = internal ? internalOrderBlocksBoxes :
      // swingOrderBlocksBoxes` 관용구는 typeHint 경로로, `boxes = array.new_box()`류는 생성자 경로로
      // 잡힌다(C619 실사용).
      const arrayElemDrawingKind =
        (stmt.typeHint !== null ? arrayDrawingElemType(stmt.typeHint) : null) ?? arrayDrawingConstructorElemKind(stmt.value, prog);
      if (arrayElemDrawingKind !== null) scope.arrayElemDrawingKindHints.set(stmt.name, arrayElemDrawingKind);
    } else if (isMapConstructorCall(stmt.value, prog, scope) || aliasedContainerKind === "map") {
      scope.containerKindHints.set(stmt.name, "map");
      // map<K, UDT/drawing> 값 타입 힌트('=' 로컬 버전, C684 — 바로 위 array 분기의
      // arrayElemUdtType/arrayElemDrawingKind 힌트와 완전히 나란한 구조).
      const mapValueUdtType =
        (stmt.typeHint !== null ? mapValueUdtElemType(stmt.typeHint, prog) : null) ?? mapUdtConstructorValueType(stmt.value, prog);
      if (mapValueUdtType !== null) scope.mapValueUdtKindHints.set(stmt.name, mapValueUdtType);
      const mapValueDrawingKind =
        (stmt.typeHint !== null ? mapValueDrawingElemType(stmt.typeHint) : null) ?? mapDrawingConstructorValueKind(stmt.value);
      if (mapValueDrawingKind !== null) scope.mapValueDrawingKindHints.set(stmt.name, mapValueDrawingKind);
    }
    // drawing '.all' 상수 힌트(C244, containerKindHints 바로 위 주석과 동일 원칙): '=' 로컬이
    // label.all 등을 직접 대입받으면 array로 기록(top-level var의 isDrawingAllConstant와 동일 판별).
    else if (isDrawingAllConstant(stmt.value)) scope.containerKindHints.set(stmt.name, "array");
    // 명시 typeHint 기반 폴백(C415, resolveContainerExprKind의 containerKindFromTypeHint 주석 참조):
    // 값이 위 어느 생성자 콜/판별에도 안 걸려도(`barData[] x = na` 후 조건부 ':=' 재할당, 또는
    // array를 반환하는 UDF 콜 초기값 등) 선언에 붙은 "array<T>"/"map<K,V>" 타입힌트 자체가 이미
    // 컨테이너 종류를 확정한다 — 아래 UDT explicitUdtType(C224/C386)과 동일 원칙.
    else {
      const declaredContainerKind = containerKindFromTypeHint(stmt.typeHint);
      if (declaredContainerKind === "array") {
        scope.containerKindHints.set(stmt.name, "array");
        const arrayElemUdtType = stmt.typeHint !== null ? arrayUdtElemType(stmt.typeHint, prog) : null;
        if (arrayElemUdtType !== null) scope.arrayElemUdtKindHints.set(stmt.name, arrayElemUdtType);
        const arrayElemDrawingKind = stmt.typeHint !== null ? arrayDrawingElemType(stmt.typeHint) : null;
        if (arrayElemDrawingKind !== null) scope.arrayElemDrawingKindHints.set(stmt.name, arrayElemDrawingKind);
      } else if (declaredContainerKind === "map") {
        scope.containerKindHints.set(stmt.name, "map");
        // map<K, UDT/drawing> 값 타입 힌트(명시 typeHint 폴백 버전, C684 — 바로 위 array 분기와
        // 나란함): `map<string, box> x = na` 후 조건부 ':=' 재할당류.
        const mapValueUdtType = stmt.typeHint !== null ? mapValueUdtElemType(stmt.typeHint, prog) : null;
        if (mapValueUdtType !== null) scope.mapValueUdtKindHints.set(stmt.name, mapValueUdtType);
        const mapValueDrawingKind = stmt.typeHint !== null ? mapValueDrawingElemType(stmt.typeHint) : null;
        if (mapValueDrawingKind !== null) scope.mapValueDrawingKindHints.set(stmt.name, mapValueDrawingKind);
      }
    }
    // UDT 인스턴스 힌트(C224/C386, containerKindHints 바로 위 주석 참조): 우선순위 (1) 명시
    // 타입힌트가 등록된 UDT 이름('=' 로컬에 `Type name = expr` 접두가 붙은 경우, RHS 형태와 무관하게
    // 확정 -- analyzeVarDecl의 explicitUdtType과 동일 원칙, wild corpus에 `OrderBlockInfo info =
    // ob.info`처럼 생성자 콜이 아닌 RHS에 타입힌트만 붙는 관용구가 흔함) (2) 초기값이
    // `TypeName.new(...)`/`obj.copy()` 생성자 콜(isUdtConstructorCall, analyzeVarDecl과 동일한 순수
    // 구조 판별 -- scope를 함께 넘겨 `obj.copy()`도 obj가 이미 UDT로 확정돼 있으면 인정). 서로 달라
    // 확정되면 analyzeVarDecl과 동일한 에러. C487: chart.point는 prog.udtTypes에 없는 특수 값
    // 타입(analyzeExpr DotAccess 케이스의 CHART_POINT_FIELD_TYPE 분기, L4855 부근)이라 udtTypes.has만
    // 으로는 인식되지 않는다 -- field.typeHint 소비처(L4872)와 동일하게 명시적으로 함께 인정한다.
    const explicitUdtType =
      stmt.typeHint !== null && (prog.udtTypes.has(stmt.typeHint) || stmt.typeHint === CHART_POINT_FIELD_TYPE)
        ? stmt.typeHint
        : null;
    const constructorUdtType = isUdtConstructorCall(stmt.value, prog, scope);
    if (explicitUdtType !== null && constructorUdtType !== null && explicitUdtType !== constructorUdtType) {
      prog.errors.push(
        `선언 타입 '${explicitUdtType}'과 생성자 타입 '${constructorUdtType}'가 다름: '${stmt.name}' (L${stmt.line}:${stmt.col})`,
      );
    }
    const udtTypeName = explicitUdtType ?? constructorUdtType;
    if (udtTypeName !== null) scope.udtKindHints.set(stmt.name, udtTypeName);
    // array<UDT> 원소 힌트(C341, 바로 위 udtTypeName과 동일 원칙): '=' 로컬이
    // array.get/pop/shift/first/last/remove로 원소를 하나 꺼내 받으면, 그 컨테이너의 원소가 등록된
    // UDT로 확정될 때만(resolveArrayGetElemUdtType) 동일한 udtKindHints에 기록 -- 생성자 콜이 아니라
    // "원소 획득" 콜이라는 점만 다를 뿐 이후 필드 접근 소비 경로는 완전히 동일.
    else {
      const elemUdtType = resolveArrayGetElemUdtType(stmt.value, prog, scope);
      if (elemUdtType !== null) scope.udtKindHints.set(stmt.name, elemUdtType);
      // UDT 필드 그대로 대입 힌트(C419, 바로 위 elemUdtType과 나란한 구조): '=' 로컬이 다른 UDT
      // 인스턴스의 필드를 그대로 대입받으면(`sessionDisp = this.active`처럼 생성자 콜도 원소 추출도
      // 아닌 DotAccess) 그 필드의 typeHint가 등록된 UDT 이름일 때만 동일하게 기록 --
      // resolveUdtFieldTypeHint(C495부터 target.obj가 DotAccess인 임의 깊이 중첩도 재귀로 지원)를
      // 재사용한다.
      else {
        const fieldUdtType = resolveUdtFieldTypeHint(stmt.value, prog, scope);
        if (fieldUdtType !== undefined && prog.udtTypes.has(fieldUdtType)) scope.udtKindHints.set(stmt.name, fieldUdtType);
      }
    }
    // enum 인스턴스 힌트('=' 로컬 버전, C677 — analyzeVarDecl의 explicitEnumType/inferredEnumType과
    // 완전히 동일한 두 신호: (1) 명시 typeHint가 등록된 enum 이름(wild `Timeframes
    // openTimeframeInput1 = input.enum(...)`류), (2) 초기값이 `input.enum(EnumType.member, ...)`
    // 콜(typeHint 생략, wild `i_timezone = input.enum(Timezones.ny, ...)`류). udtKindHints와 별도
    // 맵(scope.enumKindHints)에 기록 — enum은 필드가 없어 UDT 필드 접근 경로와 절대 공유하지 않는다.
    const explicitEnumType = stmt.typeHint !== null ? (enumTypeFromTypeHint(stmt.typeHint, prog) ?? null) : null;
    const inferredEnumType = inferEnumConstructorType(stmt.value, prog);
    const enumTypeName = explicitEnumType ?? inferredEnumType;
    if (enumTypeName !== null) scope.enumKindHints.set(stmt.name, enumTypeName);
    // drawing 핸들 힌트(C232, containerKindHints/udtKindHints 바로 위 주석과 동일 원칙): '=' 로컬이
    // label/line/box/table/polyline 생성자(new, label/line/box는 copy도) 콜을 직접 대입받으면 기록.
    // 생성자 콜이 아니어도 명시 typeHint가 DRAWING_ALL_NAMESPACES 멤버면 typeHint로 폴백(C698,
    // analyzeVarDecl의 drawingKind 폴백(L5461-5463)과 대칭 — 이 '=' 로컬 분기에만 누락돼 있던
    // 비대칭. wild `box up = na` 후 `up.get_left()`류 comma-다중선언 관용구, next_hint(C697) 미지원호출
    // '?.size' 재조사 중 인접 발견).
    const drawingKind =
      isDrawingConstructorCall(stmt.value) ??
      (stmt.typeHint !== null && DRAWING_ALL_NAMESPACES.has(stmt.typeHint) ? (stmt.typeHint as DrawingKind) : null);
    if (drawingKind !== null) scope.drawingKindHints.set(stmt.name, drawingKind);
    // array<drawing> 원소 힌트(C353, 바로 위 drawingKind와 동일 원칙 -- elemUdtType/else 분기와
    // 나란한 구조): '=' 로컬이 array.get/pop/shift/first/last/remove로 원소를 하나 꺼내 받으면, 그
    // 컨테이너의 원소가 label/line/box/table/linefill로 확정될 때만(resolveArrayGetElemDrawingKind)
    // 동일한 drawingKindHints에 기록 -- wild `activeBox = this.boxes.last()`(array<box> 필드에서
    // .last()로 뽑은 원소에 method-call sugar) 실사용.
    else {
      const elemDrawingKind = resolveArrayGetElemDrawingKind(stmt.value, prog, scope);
      if (elemDrawingKind !== null) scope.drawingKindHints.set(stmt.name, elemDrawingKind);
      // UDT 필드 그대로 대입 힌트(C419, 바로 위 elemDrawingKind와 나란한 구조, udtKindHints의
      // fieldUdtType 폴백과 동형): '=' 로컬이 다른 UDT 인스턴스의 drawing 타입 필드를 그대로
      // 대입받으면(`sessionBox = this.sessionBox`/`sessionBox = sessionDisp.sessionBox`처럼 생성자
      // 콜도 원소 추출도 아닌 DotAccess) resolveDrawingExprKind(Identifier 체인 + UDT 필드 DotAccess
      // 임의 깊이 중첩, C495 둘 다 커버)로 동일하게 기록 -- wild sessionBox.get_top() 클러스터
      // (next_hint(C418)) 실사용.
      else {
        const fieldDrawingKind = resolveDrawingExprKind(stmt.value, prog, scope);
        if (fieldDrawingKind !== null) scope.drawingKindHints.set(stmt.name, fieldDrawingKind);
      }
    }
    // matrix 힌트(C237, containerKindHints/udtKindHints/drawingKindHints 바로 위 주석과 동일
    // 원칙): '=' 로컬이 matrix로 정적 확정되는 값을 대입받으면 기록. 이전엔 isMatrixConstructorCall
    // (리터럴 `matrix.new<T>(...)`)만 체크해 resolveMatrixExprKind가 C494부터 이미 인식하는
    // method-call sugar 체이닝 대입(C502, wild `XTW = X.transpose().mult(W)` 후 `XTW.mult(...)`
    // 재체이닝)은 등록 누락으로 여전히 거부되는 비대칭이었음 — 등록 지점을 resolveMatrixExprKind
    // 자체로 통일(리터럴 생성자/matrix.mult/sugar 체이닝 셋 다 포괄).
    if (resolveMatrixExprKind(stmt.value, prog, scope)) {
      scope.matrixKindHints.add(stmt.name);
      // matrix<UDT> 원소 타입 힌트('=' 로컬 버전, C638 — top-level var(matrixUdtConstructorElemType,
      // L4558 부근)와 동일한 계산을 '=' 로컬에도 적용, LexScope.matrixElemUdtKindHints 주석 참조).
      const matrixElemUdt = matrixUdtConstructorElemType(stmt.value, prog);
      if (matrixElemUdt !== null) scope.matrixElemUdtKindHints.set(stmt.name, matrixElemUdt);
    }
  }
}

// VarDecl/Assignment의 값이 제어문-식(if/for/while/switch as expression)이면 statement 위치와
// 동일한 analyze*Stmt를 그대로 재사용한다 — 조건/블록 스코프/ta.* 제약 등 모든 시맨틱이 statement
// 위치일 때와 완전히 동일하기 때문(값을 만드느냐 아니냐는 codegen의 관심사, analyzer는 스코프와
// 안전성만 검증). 그 외 값은 기존과 동일하게 analyzeExpr로 간다. allowPlotFamilyRhs(C209, 기본값
// false — VarDecl 호출부는 인자를 안 줘 기존과 동일)는 '=' 대입이 depth 0일 때만 analyzeAssignment가
// true로 넘기며, 그 값이 정확히 bare plot()/hline() 콜일 때만 topLevel 취급으로 좁힌다(예: `x =
// plot(a) + 1`처럼 더 큰 식에 파묻힌 경우는 여전히 거부 — plot 핸들은 다른 연산의 피연산자가 아니다).
// C610: 문장(또는 제어문-식 값)의 "값이 되는 말미 위치"에 남는 TupleExpr를 재귀로 찾는다 —
// 분기/본문 마지막 문장이 다시 if/switch/for/while이면 그 안으로 내려간다(detectTupleReturn
// 재귀와 동형의 순수 구문 스캔, 분석 부작용 0). analyzeStmt의 문장 위치(값 폐기) TupleExpr
// 허용(C610)이 "값이 소비되는 위치"(제어문-식 값/UDF 암시 반환)까지 뚫지 않도록, 각 값
// 소비처가 이 스캐너로 선-거부한다 — 여기서 못 막으면 genBodyWithResult/genImplicitReturn이
// 말미 ExprStmt를 genExpr(TupleExpr)로 방출해 internal throw로 크래시한다(기존에는 analyzeExpr의
// 값 위치 하드 에러가 이 거부를 공짜로 대신하고 있었다).
function findTrailingTupleExprInStmt(last: Stmt): TupleExpr | null {
  const scanBody = (body: Stmt[]): TupleExpr | null => {
    const tail = body.length > 0 ? body[body.length - 1] : undefined;
    return tail === undefined ? null : findTrailingTupleExprInStmt(tail);
  };
  switch (last.kind) {
    case "ExprStmt":
      return last.expr.kind === "TupleExpr" ? last.expr : null;
    case "IfStmt": {
      const bodies = [last.thenBody, ...last.elifClauses.map((c) => c.body)];
      if (last.elseBody !== null) bodies.push(last.elseBody);
      for (const b of bodies) {
        const t = scanBody(b);
        if (t !== null) return t;
      }
      return null;
    }
    case "SwitchStmt": {
      for (const c of last.cases) {
        const t = scanBody(c.body);
        if (t !== null) return t;
      }
      return null;
    }
    case "ForStmt":
    case "WhileStmt":
    case "ForInStmt":
      return scanBody(last.body);
    default:
      return null;
  }
}

function isControlFlowValueKind(value: Expr): boolean {
  return (
    value.kind === "IfStmt" || value.kind === "ForStmt" || value.kind === "WhileStmt" || value.kind === "SwitchStmt"
  );
}

// 복합 대입 연산자(parser.ts COMPOUND_ASSIGN_OPS)와 동일한 산술 5종 — analyzeControlFlowOrExpr의
// BinOp 피연산자 제어문-식 허용 게이트 전용(아래 주석 참조).
const ARITH_BINOP_OPS: ReadonlySet<string> = new Set(["+", "-", "*", "/", "%"]);

export function analyzeControlFlowOrExpr(
  value: Expr,
  prog: AnalyzedProgram,
  scope: LexScope,
  allowPlotFamilyRhs: boolean = false,
): void {
  switch (value.kind) {
    case "IfStmt":
    case "ForStmt":
    case "WhileStmt":
    case "SwitchStmt": {
      // C610: 제어문-식 "값" 위치의 분기/본문 말미 튜플 리터럴은 계속 거부 — 스칼라 대입
      // 대상에 튜플은 TV도 거부하는 폼이고, 통과시키면 genBodyWithResult가 말미 ExprStmt를
      // `target = genExpr(expr)`로 방출해 genExpr(TupleExpr) internal throw로 크래시한다.
      const trailing = findTrailingTupleExprInStmt(value);
      if (trailing !== null) {
        prog.errors.push(
          `튜플 리터럴은 함수의 마지막 문장(튜플 반환)에서만 지원 (L${trailing.line}:${trailing.col})`,
        );
      }
      break;
    }
    default:
      break;
  }
  switch (value.kind) {
    case "IfStmt":
      analyzeIfStmt(value, prog, scope);
      return;
    case "ForStmt":
      analyzeForStmt(value, prog, scope);
      return;
    case "WhileStmt":
      analyzeWhileStmt(value, prog, scope);
      return;
    case "SwitchStmt":
      analyzeSwitchStmt(value, prog, scope);
      return;
    default: {
      // 단일 BinOp의 즉시 피연산자로 제어문-식이 오면 VarDecl/Assignment 값 위치와 동형으로
      // 허용한다(재귀 호출이 IfStmt/ForStmt/WhileStmt/SwitchStmt 분기 또는 이 default의 analyzeExpr로
      // 다시 갈라짐 -- 위 C610 트레일링 튜플 검사도 재귀를 통해 그대로 적용됨). 그 아래 더 깊이
      // 중첩되면(예: 함수 인자, 2단 BinOp) 여전히 거부 — 이 정확히 한 형태(단일 BinOp)만 대상이다.
      // wild 실측 두 원천: (1) 복합 대입 데슈가링(`disp /= switch i ...` -> `disp := disp /
      // (switch i ...)`, parser.ts COMPOUND_ASSIGN_OPS), (2) 여러 줄 문자열 연결(`+` 줄바꿈 계속)의
      // 뒤쪽 줄들이 전부 주석 처리돼 마지막 살아있는 `+`가 다음 실제 문장(bare 'if')까지 피연산자로
      // 삼켜버리는 경우(`dbText = "..." + <주석들> \n if showDashboard ...`, C769 실측 2건 — 파서의
      // 줄이음 규칙 자체는 이 사이클 변경 대상이 아니고, 이미 그렇게 파싱된 BinOp{right: IfStmt}를
      // 이 게이트가 받아들이는 것뿐). op는 COMPOUND_ASSIGN_OPS와 동일한 산술 5종만 허용(codegen.ts
      // hoistBinOpControlFlowOperands가 이 5종만 지원 — ==/!=/비교/and·or까지 허용하면
      // genEquality/pineAnd·Or 우회 로직을 이 좁은 형태에도 재구현해야 해 범위 밖으로 유지, 두 원천
      // 모두 산술 연산자만 실사용).
      if (
        value.kind === "BinOp" &&
        ARITH_BINOP_OPS.has(value.op) &&
        (isControlFlowValueKind(value.left) || isControlFlowValueKind(value.right))
      ) {
        analyzeControlFlowOrExpr(value.left, prog, scope);
        analyzeControlFlowOrExpr(value.right, prog, scope);
        return;
      }
      const isPlotFamilyRhs =
        allowPlotFamilyRhs &&
        value.kind === "CallExpr" &&
        value.callee.kind === "Identifier" &&
        (value.callee.name === "plot" || value.callee.name === "hline");
      analyzeExpr(value, prog, scope, isPlotFamilyRhs);
      return;
    }
  }
}

function analyzeIfStmt(stmt: IfStmt, prog: AnalyzedProgram, scope: LexScope): void {
  // C246: 최초 if 조건(stmt.condition)은 elif/case 값과 달리 앞선 형제 분기의 매치 여부에 좌우되지
  // 않는다 — 이 if 문에 실행이 도달할 때마다 무조건 정확히 1회 평가된다(cond-body 본문과 동형의
  // per-call 위치). 그래서 kind:"condition"을 push하지 않고 현재 scope 그대로 분석한다 — 바깥
  // scope가 이미 허용 kind(top-level/cond-body/loop-body/udf-body)면 이 콜도 허용되고, 바깥이
  // 이미 거부 kind(예: 상위 elif 조건 안에 중첩된 if)면 그대로 상속된다. codegen(genIfStmt/
  // genIfWithResult)이 이 조건 앞에 lazy 호이스팅 프리루드(hoistLazyStatefulCalls)를 안전하게
  // 붙일 수 있는 이유도 동일 — "무조건 1회, 이 문장 직전"이 VarDecl/Assignment 값 위치와 동형이라서다
  // (DIVERGENCES.md #97, corpus 클러스터 92건 중 86건이 정확히 이 패턴 — 코퍼스 재스캔으로 발견).
  // elif 조건은 여전히 진짜 short-circuit 체인(앞선 분기가 매치하면 평가 안 됨, 재평가 횟수가
  // 분기 순서에 달림)이라 kind:"condition"으로 거부 유지 — 문장 직전 프리루드로 hoisting하면
  // "매치하면 평가 안 함"을 깨뜨린다(analyzer.ts ScopePushKind 주석 "별개 조사 필요" 중 이 부분은
  // 범위 밖으로 확정 — switch case 값/while 조건도 동일 이유로 그대로 거부 유지).
  // 분기 본문은 kind:"cond-body" — 문장 레벨 조건부 실행이라 stateful 콜의 per-call 상태 전진이
  // TV/pine2py와 동형(C64, oracle/cases/cond_if_ta.pine)이라 허용된다.
  analyzeExpr(stmt.condition, prog, scope, false);
  analyzeBlock(stmt.thenBody, prog, scope, "cond-body");
  const condScope = pushScope(scope, "condition");
  for (const clause of stmt.elifClauses) {
    analyzeExpr(clause.condition, prog, condScope, false);
    analyzeBlock(clause.body, prog, scope, "cond-body");
  }
  if (stmt.elseBody) analyzeBlock(stmt.elseBody, prog, scope, "cond-body");
}

function analyzeWhileStmt(stmt: WhileStmt, prog: AnalyzedProgram, scope: LexScope): void {
  // 조건식은 매 반복마다 재평가되는 조건부 영역 — if의 조건과 동일하게 kind:"condition"으로 다뤄
  // stateful 콜 검사를 적용한다 (analyzeIfStmt 주석 참조). 본문은 바당 0~N회 실행이라 "loop-body"
  // (C161부터 stateful 콜 허용 — 반복마다 per-call 전진, ScopePushKind 주석 참조).
  const condScope = pushScope(scope, "condition");
  analyzeExpr(stmt.condition, prog, condScope, false);
  analyzeBlock(stmt.body, prog, scope, "loop-body", /* inLoop */ true);
}

function analyzeForStmt(stmt: ForStmt, prog: AnalyzedProgram, scope: LexScope): void {
  // start/end/step은 for 진입 시 단 한 번만 평가된다(while의 조건식과 달리 매 반복 재평가되지
  // 않음) — 별도의 조건부(depth+1) 영역으로 다루지 않고 현재 scope 그대로 분석한다.
  analyzeExpr(stmt.start, prog, scope, false);
  analyzeExpr(stmt.end, prog, scope, false);
  if (stmt.step) analyzeExpr(stmt.step, prog, scope, false);

  if (prog.varIndex.has(stmt.varName)) {
    prog.errors.push(`for 루프 변수명이 이미 var로 선언됨: '${stmt.varName}' (L${stmt.line}:${stmt.col})`);
  }
  prog.locals.add(stmt.varName);

  // 루프 변수 + 본문을 하나의 블록 스코프로 묶는다(pine2py ScopeManager의 BLOCK 스코프와 동일
  // 구조 — analyzeBlock을 그대로 쓰지 않는 이유는 루프 변수 이름을 그 스코프에 미리 심어야
  // 해서다). while과 동일하게 inLoop=true로 강제해 본문의 break/continue를 허용한다.
  const bodyScope = pushScope(scope, "loop-body", /* inLoop */ true);
  bodyScope.names.add(stmt.varName);
  // 루프 변수는 반복마다 값이 바뀌므로 'series'로 태그한다(C161 — loop-body stateful 콜 허용과
  // 동반 도입). 유일한 qualifier 소비처인 ta.* length series 하드 에러가 `ta.sma(close, i)`뿐
  // 아니라 파생식(`i + 1` 등, inferQualifier merge로 series 전파)까지 자동으로 거부하게 된다 —
  // 고정폭/초기화 구간 상태가 반복마다 다른 length로 조용히 깨지는 것을 차단(pine2py는 매 바
  // 윈도우 재스캔 구조라 가변 length가 "동작"하지만 pine2js incremental 구조는 깨짐 — C16이
  // pine2py 경고를 하드 에러로 승격한 것과 같은 축의 의도적 divergence). pine2py 자신은 루프
  // 변수를 명시적 qualifier 없이 선언(UNKNOWN — merge 시 simple 순위)하나 pine2py의 qualifier
  // 소비처는 경고뿐이라 실질 차이는 이 하드 에러 하나다.
  bodyScope.qualifiers.set(stmt.varName, "series");
  // for 루프 카운터는 Pine 언어 자체가 항상 int 타입으로 고정한다(isStaticIntExpr 주석 참조,
  // C201) — start/end/step의 실제 값과 무관하게 변수 자체의 타입은 항상 int.
  bodyScope.numTypeHints.set(stmt.varName, "int");
  for (const s of stmt.body) analyzeStmt(s, prog, bodyScope);
}

// for-in 루프(C216, C215가 남긴 파서 슬라이스의 후속) — pine2py parser.py _parse_for가 iterable
// 타입을 정적으로 제약하지 않고 codegen이 런타임 isinstance(dict) 분기로 array/map을 가른다
// (codegen.py _gen_for_in 참조). pine2js는 codegen이 JS 네이티브 for/for-of로 정적으로 갈라야
// 해서(제네릭 런타임 분기 없음) 이터러블의 컨테이너 종류를 analyze-time에 확정해야 한다 —
// resolveContainerExprKind가 array/map 중 하나로 확정 못 하면(matrix/UDF 로컬·매개변수/복합식
// 등) 침묵 오작동 대신 명시 거부한다(C215가 파서 슬라이스에서 세운 "중간 상태를 침묵 no-op으로
// 두지 않는다" 원칙 그대로 연장).
function analyzeForInStmt(stmt: ForInStmt, prog: AnalyzedProgram, scope: LexScope): void {
  // iterable은 for의 start/end/step과 동일하게 진입 시 단 한 번만 평가된다 — 조건부 영역이 아님.
  analyzeExpr(stmt.iterable, prog, scope, false);

  // C709: matrix 이터러블(TV가 행 단위 array로 순회 -- wild "Loop through every row of the
  // matrix" 주석 실측, matrix.ts PineMatrix가 이미 unknown[][]라 JS 네이티브 for-of가 그대로
  // 동형) -- resolveContainerExprKind(array/map 전용)가 null을 반환한 뒤에만 확인하는 폴백이라
  // 기존 array/map 판별 우선순위와 충돌하지 않는다.
  const containerKind = resolveContainerExprKind(stmt.iterable, prog, scope);
  const kind: "array" | "map" | "matrix" | null =
    containerKind ?? (resolveMatrixExprKind(stmt.iterable, prog, scope) ? "matrix" : null);
  if (kind === null) {
    prog.errors.push(
      `for-in 루프의 순회 대상 타입을 정적으로 판별할 수 없음(top-level 또는 로컬 array/map/matrix ` +
        `변수만 지원 — UDF 매개변수·로컬/복합식 이터러블은 아직 지원하지 않음): (L${stmt.line}:${stmt.col})`,
    );
    return;
  }
  prog.forInKinds.set(stmt, kind);

  if (prog.varIndex.has(stmt.varName)) {
    prog.errors.push(`for-in 루프 변수명이 이미 var로 선언됨: '${stmt.varName}' (L${stmt.line}:${stmt.col})`);
  }
  prog.locals.add(stmt.varName);
  if (stmt.indexName !== null) {
    if (prog.varIndex.has(stmt.indexName)) {
      prog.errors.push(`for-in 루프 변수명이 이미 var로 선언됨: '${stmt.indexName}' (L${stmt.line}:${stmt.col})`);
    }
    prog.locals.add(stmt.indexName);
  }

  // analyzeForStmt와 동일한 구조(루프 변수 + 본문을 하나의 블록 스코프로 묶음, inLoop=true로
  // break/continue 허용).
  const bodyScope = pushScope(scope, "loop-body", /* inLoop */ true);
  bodyScope.names.add(stmt.varName);
  // 원소 값은 반복마다 바뀌므로 range-for 카운터와 동일하게 'series'로 태그(analyzeForStmt 주석
  // 참조) — numType은 지정하지 않는다(array 원소가 항상 int라는 보장이 없음, range-for 카운터와
  // 다른 지점).
  bodyScope.qualifiers.set(stmt.varName, "series");
  if (stmt.indexName !== null) {
    bodyScope.names.add(stmt.indexName);
    bodyScope.qualifiers.set(stmt.indexName, "series");
    // array/matrix의 인덱스(enumerate 위치, matrix는 행 번호)는 Pine이 항상 int로 고정하지만,
    // map의 "index_name"은 실제로는 키(임의 타입일 수 있음, pine2py `.items()`의 키)라
    // kind==="array"/"matrix"일 때만 int 힌트를 단다.
    if (kind === "array" || kind === "matrix") bodyScope.numTypeHints.set(stmt.indexName, "int");
  }
  // array<drawing> 원소 kind 힌트(C352, drawingKindHints 주석 참조): 이터러블이 label/line/box/
  // table/linefill 원소 배열로 확정되면 루프 변수에 그 kind를 달아 method-call sugar(`b.delete()`
  // == `box.delete(b)`)가 isDrawingMethodSugarCall(call-expr.ts)에서 인식되게 한다.
  // array<UDT> 원소 타입 힌트(C356, 위 drawing 배선과 완전히 대칭): 이터러블이 UDT 원소 배열로
  // 확정되면 루프 변수에 그 UDT 타입명을 달아 method-call sugar(`gap.checkForClose()` ==
  // `Gap.checkForClose(gap)`)가 resolveUdtMethodReceiverType(call-expr.ts, resolveUdtObjectType ->
  // udtKindHints 체인 조회)에서 인식되게 한다.
  if (kind === "array") {
    const elemDrawingKind = resolveArrayElemDrawingKind(stmt.iterable, prog, scope);
    if (elemDrawingKind !== null) bodyScope.drawingKindHints.set(stmt.varName, elemDrawingKind);
    const elemUdtType = resolveArrayElemUdtType(stmt.iterable, prog, scope);
    if (elemUdtType !== null) bodyScope.udtKindHints.set(stmt.varName, elemUdtType);
  }
  // matrix 이터러블(C709): 루프 변수는 그 행(array) 자체 -- 본문 안에서 `row.get(i)`/`for v in row`
  // 등 array method-call sugar/중첩 for-in이 그대로 동작하도록 container kind 힌트를 단다
  // (PineMatrix 원소 타입은 추적하지 않아 array<UDT>/array<drawing> 힌트는 달지 않음, 과욕 금지).
  if (kind === "matrix") bodyScope.containerKindHints.set(stmt.varName, "array");
  for (const s of stmt.body) analyzeStmt(s, prog, bodyScope);
}

// obj.field 형태(DotAccess, 임의 깊이 중첩 허용 — C495)의 필드가 정적으로 UDT 필드로 확정되면
// 그 필드의 typeHint 문자열("array<float>"/"map<string, float>"/"line" 등, parser.ts
// parseFieldTypeHint가 조립한 그대로)을 반환한다(C323, wild "?." 클러스터 —
// `id.d.unshift(x)`/`graphic.pivotLine.delete()`류 UDT 필드가 컨테이너/drawing 핸들 타입인
// method-call sugar 수신자). obj가 Identifier면 resolveUdtObjectType과 동일한 원칙(top-level
// var/'=' 로컬/UDF 매개변수)으로 UDT 인스턴스여야 한다. obj가 CallExpr이면(C422, wild
// `assets.get(index).prices.push(...)` — array<UDT> 원소를 꺼내자마자 그 필드에 곧바로 체이닝)
// resolveArrayGetElemUdtType(C341, call-expr.ts resolveUdtMethodReceiverType의 C354 선례와 동일
// 조합)으로 그 CallExpr이 반환하는 원소의 UDT 타입을 판별한다. obj가 그 자체로 DotAccess인 중첩
// 체이닝(C495, wild `this.lines.startline.set_xy1(...)`류 — outer UDT 필드가 다시 UDT이고 그
// 필드가 컨테이너/drawing 핸들인 경우)은 resolveUdtObjectType의 udtFieldAccessTypes 사전 캐시에
// 기대지 않고 이 함수 자신을 obj에 재귀 호출해 얻은 typeHint를 그대로 UDT 타입명 후보로 재사용한다
// (얕은 필드가 실제 UDT 타입이 아니면 prog.udtTypes.get()이 undefined를 반환해 자연히 걸러짐 —
// 재귀는 매 호출 DotAccess 체인이 한 단계씩 짧아지므로 항상 종료, 임의 깊이로 일반화된다).
export function resolveUdtFieldTypeHint(target: Expr, prog: AnalyzedProgram, scope: LexScope): string | undefined {
  if (target.kind !== "DotAccess") return undefined;
  const objTypeName =
    target.obj.kind === "Identifier"
      ? resolveUdtObjectType(target.obj, prog, scope)
      : target.obj.kind === "CallExpr"
        ? (resolveArrayGetElemUdtType(target.obj, prog, scope) ?? undefined)
        : target.obj.kind === "DotAccess"
          ? resolveUdtFieldTypeHint(target.obj, prog, scope)
          : undefined;
  if (objTypeName === undefined) return undefined;
  return prog.udtTypes.get(objTypeName)?.fields.find((f) => f.name === target.attr)?.typeHint;
}

// 명시 typeHint 문자열("array<T>"/"map<K,V>"/qualifier 접두 "series array<float>" 등)에서 컨테이너
// 종류를 뽑아낸다(C415). FuncParam.typeHint는 qualifier를 압축 없이 그대로 보존하지만(parseFuncParam)
// VarDecl/Assignment.typeHint는 파서가 이미 qualifier를 제거한 base만 담아(parseVarDecl/
// parseAssignmentOrExpr) 두 형태 모두 안전하게 처리 — index-access.ts classifyNonNumericTypeHint와
// 동일한 qualifier-strip 규칙(그 함수는 array/map 외에 matrix/string/UDT/enum까지 분류하는 상위
// 집합이라 여기서는 별도 재사용하지 않고 array/map 서브셋만 좁게 재구현).
function containerKindFromTypeHint(hint: string | null): "array" | "map" | null {
  if (hint === null) return null;
  const parts = hint.trim().split(/\s+/);
  const first = parts[0]!;
  const base = parts.length > 1 && (first === "series" || first === "simple" || first === "const") ? parts[1]! : first;
  if (base.startsWith("array<")) return "array";
  if (base.startsWith("map<")) return "map";
  return null;
}

// 임의 Expr의 컨테이너 종류를 정적으로 판별한다. Identifier(top-level var/'=' 로컬/UDF·method
// 매개변수)이거나, UDT 인스턴스의 필드가 array<T>/map<K,V>로 선언된 DotAccess(C323, resolveUdtFieldTypeHint
// — C495부터 obj가 다시 DotAccess인 임의 깊이 중첩도 재귀로 지원)이거나, 그 자체가 array/map을 새로 반환하는 생성자 콜(C417,
// `array.from(...)`/`str.split(...)`/`map.keys(...)`류 — isArrayConstructorCall/isMapConstructorCall이
// 이미 순수 구조로 판별)일 때 판별되고, 그 외 복합식(`f().push(x)`처럼 콜 결과를 다시 체이닝하는
// IndexAccess 등)은 여전히 null — for-in 이터러블(C216)과 method-call 스타일 콜 수신자(C222) 둘 다
// 실전 corpus에서 이 형태들이 압도적이라 그 이상은 별도 근거 없이 지원 범위를 넓히지 않는다.
// 조회 순서: (1) scope 체인의 containerKindHints('=' 로컬, top-level 포함) -> (2) scope.func의
// func-local var(C425, localVarValueKinds — resolveDrawingExprKind의 localVarDrawingKinds 폴백과
// 나란한 축. analyzeVarDecl은 func!==null이면 컨테이너 종류를 scope.containerKindHints가 아니라
// FuncInfo.localVarValueKinds에 등록하는데(함수 전체 가시성, '=' 로컬과 저장처가 다름)
// resolveContainerExprKind가 이 맵을 조회한 적이 없어 `method f()=> var m = map.new<K,V>()
// \n m.put(...)`류가 top-level var/'=' 로컬과 값·구조가 완전히 같은데도 "지원하지 않는 호출"로
// 거부돼 왔다 -- 값 UDT가 로컬이든 외부 library alias든 무관하게 재현되는 순수 조회 갭이었음을
// 최소 재현으로 확인) -> (3) scope.func의 매개변수 typeHint(C415, paramTypeHints — 명시
// `array<T>`/`map<K,V>` 힌트가 있는 UDF/method 매개변수, method 수신자 "this" 포함) -> (3.5)
// scope.func의 매개변수가 명시 typeHint 없이 콜사이트 인자로만 컨테이너 종류가 역추론된 경우
// (C492, paramContainerKinds — wild `helper(arr) => for x in arr`류 무힌트 매개변수, paramArrayElemUdtTypes
// (C469)의 UDT-무관 버전) -> (4) top-level var 전용 arrayVars/mapVars(analyzeVarDecl) -> (5) UDT
// 필드 typeHint 접두사 -> (6) CallExpr 자신이 생성자 콜. matrixVars(matrix 이터러블은 별도 축,
// 행 단위 순회 codegen이 필요해 범위 밖)/값 흐름 추적이 필요한 그 외 매개변수는 여전히 null.
export function resolveContainerExprKind(target: Expr, prog: AnalyzedProgram, scope: LexScope): "array" | "map" | null {
  if (target.kind === "Identifier") {
    const name = target.name;
    const localKind = resolveLocalContainerKind(scope, name);
    if (localKind !== undefined) return localKind;
    const funcLocalKind = scope.func?.localVarValueKinds.get(name);
    if (funcLocalKind === "array" || funcLocalKind === "map") return funcLocalKind;
    const paramKind = containerKindFromTypeHint(scope.func?.paramTypeHints.get(name) ?? null);
    if (paramKind !== null) return paramKind;
    const inferredParamKind = scope.func?.paramContainerKinds.get(name) ?? null;
    if (inferredParamKind !== null) return inferredParamKind;
    if (prog.arrayVars.has(name)) return "array";
    if (prog.mapVars.has(name)) return "map";
    // C678(배치34 (3) 판정 뒤집힌 축 재점검 — for-in): 위 어느 경로로도 종류를 못 찾은 식별자이
    // 물리적으로 위치한 UDF(scope.func) 자신이 스크립트 전체에서 콜사이트 0개("완전 죽은 코드")면
    // 안전한 플레이스홀더(array)로 접는다 — C663(buildSecurityExprNode)이 이미 확립한 동일 원칙
    // (funcAllCallSites 전수 목록으로 실제 0개만 가려냄)의 확장. wild `remove_mitigated(ob_top,
    // ob_btm, ...) => target_array = bull ? ob_btm : ob_top \n for element in target_array`류
    // (선언만 되고 어디서도 호출되지 않는 UDF, TV는 이 상태로도 컴파일을 수용) 8파일 공통 축.
    // 안전 가드 3종(전부 회귀 실측으로 발견):
    // (1) name이 이 함수 자신의 선언된 매개변수/func-local var일 때만(paramNames/localVarSlots
    //     멤버십 필수) — 그냥 "scope.func 안의 아무 미해결 식별자"로 넓히면 `line.copy(x)`(namespace
    //     리터럴 콜) 같은 무관한 DotAccess의 obj 식별자("line")까지 오탐해 array method-sugar로
    //     잘못 디스패치되는 회귀가 실측됨(scratch/c678, before/after okset diff로 6파일 newly-broken).
    // (2) 매개변수가 array<T>/map<K,V>가 아닌 다른 명시 typeHint(예 matrix<float>)를 가졌으면 제외 —
    //     그 축은 별도 미구현 상태(matrix for-in)로 남겨야지 이 플레이스홀더로 조용히 array 취급하면
    //     "명시 타입 무시"가 된다.
    // (3) name이 func.histShadowedNames(C364)에 있으면 제외 — 매개변수와 동명인 '='/튜플 로컬이 함수
    //     본문 안에서 이름을 재선언(섀도잉)했다면 이 식별자는 더 이상 그 매개변수를 가리키지 않을 수
    //     있어(어느 선언을 가리키는지 자체가 모호) 매개변수 kind를 그대로 신뢰할 수 없다.
    // method(이름에 "$")는 제외: prepassIndexSingleCallSites의 record()가 callee.kind==="Identifier"
    // 콜사이트만 세어 dot-sugar/static 스타일(항상 DotAccess callee)로만 호출되는 method는 실제 호출
    // 여부와 무관하게 funcAllCallSites가 구조적으로 항상 비어 있다 — "$"는 렉서가 식별자 문자
    // ([A-Za-z0-9_])로 인정하지 않아 실제 이름과 절대 안 겹치는 안전한 판별자.
    if (
      scope.func !== null &&
      !scope.func.name.includes("$") &&
      !scope.func.histShadowedNames.has(name) &&
      (scope.func.paramNames.includes(name)
        ? scope.func.paramTypeHints.get(name) == null
        : scope.func.localVarSlots.includes(name))
    ) {
      const sites = prog.funcAllCallSites.get(scope.func.name);
      if (sites === undefined || sites.length === 0) return "array";
    }
    return null;
  }
  // label.all/line.all/box.all/table.all/polyline.all/linefill.all(C244)을 값 위치에 직접 쓰는
  // 경우(`for bx in box.all`류, var 경유 없이 바로 이터러블/수신자로 오는 형태) — analyzeVarDecl
  // 경유 arrayVars 등록과 별개로, 이 값 자체가 이미 정적으로 "빈 배열"임을 구조만으로 판별 가능.
  if (isDrawingAllConstant(target)) return "array";
  // 이터러블/수신자 자리에 var 경유 없이 생성자 콜이 직접 오는 형태(C417, `for x in array.from(...)`
  // /`for x in str.split(s, sep)`/`for x in map.keys(m)`) — isArrayConstructorCall/isMapConstructorCall이
  // 이미 이 콜들을 리터럴 네임스페이스로 순수 구조 판별하므로 그대로 재사용.
  if (target.kind === "CallExpr") {
    if (isArrayConstructorCall(target, prog, scope)) return "array";
    if (isMapConstructorCall(target, prog, scope)) return "map";
    // bare UDF 콜을 컨테이너 수신자 자리에 var 경유 없이 바로 체이닝하는 형태(C651, wild
    // `mean(data,weights,len).get(0)`/`getRootCodeMap().get(root)`) — 그 함수의
    // FuncInfo.returnContainerKind(마지막 문장이 생성자 콜/컨테이너 종류가 확정된 로컬을 반환)를 인정.
    if (target.callee.kind === "Identifier") {
      const calleeInfo = prog.funcs.get(target.callee.name);
      if (calleeInfo?.returnContainerKind != null) return calleeInfo.returnContainerKind;
    }
    return null;
  }
  // 삼항 별칭 대입(C428, wild `_tFactors = _tIdx == 0 ? _cf0 : _tIdx == 1 ? _cf1 : _cf2` — 이미
  // 컨테이너 종류가 확정된 여러 Identifier/식 중 조건에 따라 하나를 그대로 참조하는 형태). 양쪽
  // 분기를 재귀적으로 판별해 둘 다 non-null이고 같은 종류일 때만 인정한다(한쪽만 확정되거나 서로
  // 다르면 정적으로 안전하게 판별 불가 -- 과욕 금지, C232). trueExpr/falseExpr가 각각 Identifier/
  // CallExpr/UDT 필드/중첩 TernaryOp(`a?b:c?d:e`)여도 이 재귀가 그대로 커버한다.
  if (target.kind === "TernaryOp") {
    const trueKind = resolveContainerExprKind(target.trueExpr, prog, scope);
    if (trueKind === null) return null;
    const falseKind = resolveContainerExprKind(target.falseExpr, prog, scope);
    return trueKind === falseKind ? trueKind : null;
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  if (fieldType === undefined) return null;
  return containerKindFromTypeHint(fieldType);
}

// target(컨테이너 표현식)이 정적으로 "원소 타입이 등록된 UDT인 array"로 확정되면 그 UDT 타입명을
// 반환한다(C341, resolveContainerExprKind와 동일한 조회 원칙 -- 값 흐름 추적 없는 순수 구조 판별을
// "원소 타입까지"로 한 단계 넓힘). (1) scope 체인의 arrayElemUdtKindHints('=' 로컬, top-level/UDF
// 로컬 포함, C393) -> (2) top-level var의 명시 typeHint(arrayElemUdtType, analyzeVarDecl) -> (3)
// scope.func의 매개변수 typeHint(C415, resolveContainerExprKind의 paramKind와 동일한 소비처 —
// `array<Candle> candles` 매개변수의 원소 UDT까지 확정) -> (3.5) scope.func의 매개변수가 명시
// typeHint 없이 콜사이트 인자로만 array<UDT> 원소 타입이 역추론된 경우(C469, paramArrayElemUdtTypes
// — `helper(levels) => ... = array.get(levels, i)`류 무힌트 매개변수) -> (3.7) target 자신이 bare
// UDF 콜인 경우(C491, `for [i, v] in f_getAllPairCombinations(...)`류 — '=' 로컬 대입 없이 이터러블
// 자리에 바로 오는 형태) FuncInfo.returnArrayElemUdtType(C458, isArrayConstructorCall의 bare UDF
// 분기와 동일한 조회)을 그대로 인정 -> (4) UDT 필드 typeHint("array<UDT>", resolveUdtFieldTypeHint
// 재사용). export(C457): constructors.ts의 arrayUdtConstructorElemType이
// array.copy(container)/container.copy()의 원소타입 전파에 재사용.
export function resolveArrayElemUdtType(target: Expr, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (target.kind === "Identifier") {
    const known =
      resolveLocalArrayElemUdtKind(scope, target.name) ??
      prog.arrayElemUdtType.get(target.name) ??
      scope.func?.localVarArrayElemUdtTypes.get(target.name) ??
      null;
    if (known !== null) return known;
    const paramHint = scope.func?.paramTypeHints.get(target.name) ?? null;
    if (paramHint !== null) return arrayUdtElemType(paramHint, prog);
    return scope.func?.paramArrayElemUdtTypes.get(target.name) ?? null;
  }
  if (target.kind === "CallExpr" && target.callee.kind === "Identifier") {
    const funcInfo = prog.funcs.get(target.callee.name);
    if (funcInfo !== undefined && funcInfo.returnArrayElemUdtType !== null) return funcInfo.returnArrayElemUdtType;
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  if (fieldType === undefined) return null;
  return arrayUdtElemType(fieldType, prog);
}

// resolveArrayElemUdtType과 완전히 동일한 조회 순서의 drawing 버전(C352, for-in 루프 변수가
// array<label/line/box/table/linefill>의 원소를 받을 때 drawing method-call sugar 자격을 주는
// 유일한 소비처, analyzeForInStmt 참조 + C354부터 resolveArrayGetElemDrawingKind의 CallExpr 수신자
// 판별도 재사용). scope.func 매개변수 typeHint 폴백(C421 — resolveArrayElemUdtType은 C415가 이미
// 갖췄으나 이 drawing 형제 함수는 빠져 있던 비대칭이었음: `method clear_arr(line[] l) =>
// l.pop().delete()`류 array<drawing> 매개변수가 이 폴백 부재로 실패). '=' 로컬 컨테이너는
// resolveLocalArrayElemDrawingKind(scope 체인, C620)로 resolveArrayElemUdtType과 대칭 지원.
// typeHint 없이 콜사이트 인자로만 원소 drawing kind가 역추론된 경우
// (C505, paramArrayElemDrawingKinds — resolveArrayElemUdtType의 paramArrayElemUdtTypes 폴백(C469)과
// 나란한 마지막 폴백. wild `flush(source) => ... source.get(i).delete()`류 무힌트 매개변수).
// C688부터 call-expr.ts array extension dispatch(same-arity elemKind 오버로드 선택)도 소비해 export.
export function resolveArrayElemDrawingKind(target: Expr, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (target.kind === "Identifier") {
    const known =
      resolveLocalArrayElemDrawingKind(scope, target.name) ??
      prog.arrayElemDrawingKind.get(target.name) ??
      scope.func?.localVarArrayElemDrawingKinds.get(target.name) ??
      null;
    if (known !== null) return known;
    const paramHint = scope.func?.paramTypeHints.get(target.name) ?? null;
    if (paramHint !== null) return arrayDrawingElemType(paramHint);
    return scope.func?.paramArrayElemDrawingKinds.get(target.name) ?? null;
  }
  // label.all/line.all/box.all/table.all/polyline.all/linefill.all의 원소 kind는 namespace 이름
  // 자신과 정확히 같다(DRAWING_ALL_NAMESPACES가 DrawingKind와 동일 문자열 집합, resolveContainerExprKind
  // 위 주석 참조) — `for bx in box.all` 이터러블 원소는 항상 box 핸들.
  if (target.kind === "DotAccess" && target.obj.kind === "Identifier" && isDrawingAllConstant(target)) {
    return target.obj.name as DrawingKind;
  }
  // bare UDF 콜 RHS(C683, resolveArrayElemUdtType의 CallExpr 분기(C458)와 완전히 나란함) — target
  // 자신이 array<drawing>을 반환하는 함수 콜이면 FuncInfo.returnArrayElemDrawingKind를 그대로 인정.
  if (target.kind === "CallExpr" && target.callee.kind === "Identifier") {
    const funcInfo = prog.funcs.get(target.callee.name);
    if (funcInfo !== undefined && funcInfo.returnArrayElemDrawingKind !== null) return funcInfo.returnArrayElemDrawingKind;
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  if (fieldType === undefined) return null;
  return arrayDrawingElemType(fieldType);
}

// value가 array<UDT>에서 원소 하나를 꺼내는 콜(canonical `array.get(container, idx)` 또는
// method-call sugar `container.get(idx)`, C222 resolveContainerExprKind 재사용)이면 그 원소의 UDT
// 타입명을 반환한다(C341). get 외에 pop/shift/first/last/remove도 동일하게 원소 하나를 반환하는
// ARRAY_REGISTRY 멤버라 같은 화이트리스트로 묶는다(insert/set/push 등 원소를 반환하지 않는 나머지는
// 대상 밖). isUdtConstructorCall과 나란한 순수 구조 판별 -- 인자 값이 아니라 콜 형태만 본다.
const ARRAY_ELEM_RETURNING_METHODS: ReadonlySet<string> = new Set(["get", "pop", "shift", "first", "last", "remove"]);
// C354부터 call-expr.ts의 method-call 콜 수신자 판별(namespace===null인 CallExpr 수신자,
// `allGaps.shift().delete()`류)도 재사용하는 두 번째 소비처가 생겨 export한다.
// C502부터 map<K, UDT> 수신자도 함께 인정한다(wild `data.get(key).v.avg()` -- `map<string, UDT>`
// UDT 필드에서 값 하나를 꺼내자마자 필드 읽기를 체이닝) -- resolveArrayGetElemDrawingKind(C500)가
// 이미 갖춘 map 분기를 그대로 대칭 이식(mapValueUdtElemType, resolveMapValueUdtType 신설 --
// C684부터 var-name 키 추적도 지원, 해당 함수 주석 참조).
export function resolveArrayGetElemUdtType(value: Expr, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess") return null;
  const callee = value.callee;
  if (!ARRAY_ELEM_RETURNING_METHODS.has(callee.attr)) return null;
  if (callee.obj.kind === "Identifier" && callee.obj.name === "array") {
    const container = value.args[0];
    return container === undefined ? null : resolveArrayElemUdtType(container, prog, scope);
  }
  if (callee.obj.kind === "Identifier" && callee.obj.name === "map") {
    const container = value.args[0];
    return container === undefined ? null : resolveMapValueUdtType(container, prog, scope);
  }
  // matrix<UDT> 수신자(C618, map 분기 바로 위와 나란함) -- matrix.get은 2-인덱스(row,col) 시그니처라
  // ARRAY_ELEM_RETURNING_METHODS의 get/pop/shift/first/last/remove 중 matrix에 실제로 존재하는 건
  // "get" 하나뿐(row/col은 원소가 아니라 array를 반환해 별도 축, MATRIX_ARRAY_RETURNING_METHODS
  // 참조) -- attr==="get" 명시 가드로 나머지 원소 없는 이름이 실수로 이 분기를 타지 않게 한다.
  if (callee.attr === "get" && callee.obj.kind === "Identifier" && callee.obj.name === "matrix") {
    const container = value.args[0];
    return container === undefined ? null : resolveMatrixValueUdtType(container, prog, scope);
  }
  const containerKind = resolveContainerExprKind(callee.obj, prog, scope);
  if (containerKind === "array") return resolveArrayElemUdtType(callee.obj, prog, scope);
  if (containerKind === "map") return resolveMapValueUdtType(callee.obj, prog, scope);
  if (callee.attr === "get" && resolveMatrixExprKind(callee.obj, prog, scope)) return resolveMatrixValueUdtType(callee.obj, prog, scope);
  return null;
}

// resolveArrayElemUdtType/resolveMapValueUdtType과 나란한 matrix 버전(C618). '=' 로컬 값 타입
// 추적(matrixElemUdtKindHints, C638)이 이제 scope 체인으로 top-level var(prog.matrixElemUdtType)와
// 나란히 지원된다 -- wild `symbolMat = matrix.new<values>(2, 40)` 후 `symbolMat.get(0, i).symbolData`
// 관용구(과욕 금지 원칙은 여전히 유효: matrixUdtConstructorElemType 자신이 리터럴 `matrix.new<T>()`
// 콜 하나만 인식, method-call sugar 체이닝/copy 상속은 array 쪽처럼 여전히 대상 밖).
function resolveMatrixValueUdtType(target: Expr, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (target.kind !== "Identifier") return null;
  return resolveLocalMatrixElemUdtKind(scope, target.name) ?? prog.matrixElemUdtType.get(target.name) ?? null;
}

// resolveMapValueDrawingKind(C500)와 완전히 동일한 구조의 UDT 버전(C502). C684부터 var-name 키
// 추적(resolveArrayElemUdtType의 Identifier 분기와 대칭)도 지원한다 — 조회 순서: (1) scope 체인
// mapValueUdtKindHints('=' 로컬) -> (2) top-level var(prog.mapValueUdtType) -> (3) func-local
// var(FuncInfo.localVarMapValueUdtTypes) -> (4) 매개변수 typeHint("map<K, V>") -> (5) UDT 필드
// typeHint(resolveUdtFieldTypeHint, C502 기존 경로).
function resolveMapValueUdtType(target: Expr, prog: AnalyzedProgram, scope: LexScope): string | null {
  if (target.kind === "Identifier") {
    const known =
      resolveLocalMapValueUdtKind(scope, target.name) ??
      prog.mapValueUdtType.get(target.name) ??
      scope.func?.localVarMapValueUdtTypes.get(target.name) ??
      null;
    if (known !== null) return known;
    const paramHint = scope.func?.paramTypeHints.get(target.name) ?? null;
    if (paramHint !== null) return mapValueUdtElemType(paramHint, prog);
    return null;
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  if (fieldType === undefined) return null;
  return mapValueUdtElemType(fieldType, prog);
}

// resolveArrayGetElemUdtType과 완전히 동일한 구조의 drawing 버전(C353, ROADMAP P4 next_hint(C352)
// 1순위 -- wild `activeBox = this.boxes.last()`: array<box> UDT 필드에서 원소 하나를 꺼내는 콜을
// '=' 로컬 drawingKindHints로 잇는다). ARRAY_ELEM_RETURNING_METHODS(get/pop/shift/first/last/remove)
// 화이트리스트를 그대로 재사용 -- 반환 원소 타입이 UDT냐 drawing kind냐만 다를 뿐 콜 형태 판별은 동일.
// C354부터 resolveArrayGetElemUdtType과 나란히 call-expr.ts의 method-call 콜 수신자 판별(CallExpr
// 수신자, `boxes.shift().delete()`류)도 재사용하는 두 번째 소비처가 생겨 export한다.
// C500부터 map<K, drawing> 수신자도 함께 인정한다(wild `lineDraw.rTFdraw.get("High").set_xy1(...)`
// -- `map<string, line>` UDT 필드에서 값 하나를 꺼내자마자 method-call sugar를 체이닝). array
// 분기와 마찬가지로 canonical `map.get(container, key)`와 method-call sugar `container.get(key)`
// 양쪽을 다룬다 -- C684부터 resolveMapValueDrawingKind가 UDT 필드 typeHint 경로에 더해 var-name
// 키 추적('=' 로컬/top-level var/func-local var/매개변수 typeHint)도 지원한다(해당 함수 주석 참조).
export function resolveArrayGetElemDrawingKind(value: Expr, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (value.kind !== "CallExpr" || value.callee.kind !== "DotAccess") return null;
  const callee = value.callee;
  if (!ARRAY_ELEM_RETURNING_METHODS.has(callee.attr)) return null;
  if (callee.obj.kind === "Identifier" && callee.obj.name === "array") {
    const container = value.args[0];
    return container === undefined ? null : resolveArrayElemDrawingKind(container, prog, scope);
  }
  if (callee.obj.kind === "Identifier" && callee.obj.name === "map") {
    const container = value.args[0];
    return container === undefined ? null : resolveMapValueDrawingKind(container, prog, scope);
  }
  // matrix<drawing> 수신자(C618) -- resolveArrayGetElemUdtType의 matrix 분기와 완전히 나란함(주석
  // 참조), attr==="get" 가드 이유도 동일.
  if (callee.attr === "get" && callee.obj.kind === "Identifier" && callee.obj.name === "matrix") {
    const container = value.args[0];
    return container === undefined ? null : resolveMatrixValueDrawingKind(container, prog);
  }
  const containerKind = resolveContainerExprKind(callee.obj, prog, scope);
  if (containerKind === "array") return resolveArrayElemDrawingKind(callee.obj, prog, scope);
  if (containerKind === "map") return resolveMapValueDrawingKind(callee.obj, prog, scope);
  if (callee.attr === "get" && resolveMatrixExprKind(callee.obj, prog, scope)) return resolveMatrixValueDrawingKind(callee.obj, prog);
  return null;
}

// resolveMatrixValueUdtType과 나란한 drawing 버전(C618) -- 동일하게 top-level var 전용.
function resolveMatrixValueDrawingKind(target: Expr, prog: AnalyzedProgram): DrawingKind | null {
  if (target.kind !== "Identifier") return null;
  return prog.matrixElemDrawingKind.get(target.name) ?? null;
}

// resolveArrayElemDrawingKind의 map 버전(C500). C684부터 var-name 키 추적(resolveMapValueUdtType과
// 완전히 나란한 구조 — 조회 순서는 그쪽 주석 참조)도 지원한다: wild `var aoeLevels =
// map.new<string, box>()`(UDF 본문 중첩 블록) 뒤 `getHighBox = aoeLevels.get("High")` \
// `getHighBox.get_top()` 관용구(next_hint(C683) getHighBox 축) — 기존엔 UDT 필드 typeHint 경로
// (`lineDraw.rTFdraw`처럼 필드가 정적으로 "map<K, drawing>")만 지원했다.
function resolveMapValueDrawingKind(target: Expr, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (target.kind === "Identifier") {
    const known =
      resolveLocalMapValueDrawingKind(scope, target.name) ??
      prog.mapValueDrawingKind.get(target.name) ??
      scope.func?.localVarMapValueDrawingKinds.get(target.name) ??
      null;
    if (known !== null) return known;
    const paramHint = scope.func?.paramTypeHints.get(target.name) ?? null;
    if (paramHint !== null) return mapValueDrawingElemType(paramHint);
    return null;
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  if (fieldType === undefined) return null;
  return mapValueDrawingElemType(fieldType);
}

// resolveLocalContainerKind와 동일한 체인 탐색을 drawingKindHints에 적용(method-call 스타일
// drawing 콜 수신자 판별 전용, C232).
function resolveLocalDrawingKind(scope: LexScope, name: string): DrawingKind | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const k = s.drawingKindHints.get(name);
    if (k !== undefined) return k;
    s = s.parent;
  }
  return undefined;
}

// containerKindFromTypeHint(C415)의 drawing 버전 — 명시 typeHint 문자열("table"/qualifier 접두
// "series table" 등)이 스칼라 drawing kind 하나와 정확히 일치하면 그 kind를 반환한다(C476).
// arrayDrawingElemType(array<T> 제네릭 래퍼)과 달리 이건 매개변수 자신이 곧 핸들 스칼라인
// 경우라 startsWith가 아니라 정확한 일치로 검사.
function drawingKindFromTypeHint(hint: string | null): DrawingKind | null {
  if (hint === null) return null;
  const parts = hint.trim().split(/\s+/);
  const first = parts[0]!;
  const base = parts.length > 1 && (first === "series" || first === "simple" || first === "const") ? parts[1]! : first;
  return DRAWING_ALL_NAMESPACES.has(base) ? (base as DrawingKind) : null;
}

// resolveContainerExprKind와 완전히 동일한 조회 순서((1) scope 체인의 drawingKindHints('=' 로컬,
// top-level 포함) -> (2) scope.func.localVarDrawingKinds(C358, func-local var — paramUdtTypes와
// 나란한 함수-전체 가시성) -> (3) scope.func의 매개변수 typeHint(C476, paramTypeHints —
// resolveContainerExprKind의 paramKind/resolveArrayElemDrawingKind의 paramHint와 나란한 축.
// 지금까지 UDF 매개변수가 명시 `table t_able` 등으로 선언돼도 이 조회가 빠져 있어
// `t_able.cell(...)` 같은 method-call sugar가 "지원하지 않는 호출"로 거부됐었다 — wild
// `cell(table t_able, ...) => t_able.cell(column,row,data,text_color=color,...)`류) -> (3.5)
// scope.func의 매개변수가 명시 typeHint 없이 콜사이트 인자로만 drawing kind가 역추론된 경우
// (C496, paramDrawingKinds — resolveContainerExprKind의 inferredParamKind와 나란한 축. wild
// `color_lines(line_m, ...) => line_m.get_y1()`류, 콜사이트가 `color_lines(c.line_mid1, ...)`처럼
// top-level UDT var의 drawing 필드를 무힌트 매개변수에 그대로 넘기는 형태) -> (4) top-level var
// 전용 prog.drawingVarKinds -> (5) UDT 필드 typeHint가 label/line/box/table/polyline/linefill 중
// 하나인 DotAccess, C323 resolveUdtFieldTypeHint 재사용(C495부터 obj가 다시 DotAccess인 임의 깊이
// 중첩도 재귀로 지원, wild `this.lines.startline.set_xy1(...)`류) — wild 실측
// `graphic.pivotLine.delete()`/`id.max.get_y2()`류) — label/line/box/table/polyline 핸들로
// 정적 확정되는 표현식인지 판별한다(C232, call-expr.ts의 method-call 스타일 drawing 콜 수신자
// 판별 소비처 하나뿐). 그 외 복합식(콜 결과 재체이닝 등)은 여전히 null(명시 거부,
// resolveContainerExprKind와 동일한 과욕 금지 원칙).
export function resolveDrawingExprKind(target: Expr, prog: AnalyzedProgram, scope: LexScope): DrawingKind | null {
  if (target.kind === "Identifier") {
    const localKind = resolveLocalDrawingKind(scope, target.name);
    if (localKind !== undefined) return localKind;
    const funcLocalKind = scope.func?.localVarDrawingKinds.get(target.name);
    if (funcLocalKind !== undefined) return funcLocalKind;
    const paramKind = drawingKindFromTypeHint(scope.func?.paramTypeHints.get(target.name) ?? null);
    if (paramKind !== null) return paramKind;
    const inferredParamKind = scope.func?.paramDrawingKinds.get(target.name) ?? null;
    if (inferredParamKind !== null) return inferredParamKind;
    return prog.drawingVarKinds.get(target.name) ?? null;
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  return fieldType !== undefined && DRAWING_ALL_NAMESPACES.has(fieldType) ? (fieldType as DrawingKind) : null;
}

// resolveLocalDrawingKind와 동일한 체인 탐색을 enumKindHints에 적용(method-call 스타일 enum
// 콜 수신자 판별 전용, C677).
function resolveLocalEnumKind(scope: LexScope, name: string): string | undefined {
  let s: LexScope | null = scope;
  while (s) {
    const t = s.enumKindHints.get(name);
    if (t !== undefined) return t;
    s = s.parent;
  }
  return undefined;
}

// drawingKindFromTypeHint(C476)와 완전히 동일한 qualifier-strip 규칙의 enum 버전 — 명시 typeHint
// 문자열이 등록된 enum 이름과 정확히 일치하면 그 이름을 반환한다.
function enumTypeFromTypeHint(hint: string | null, prog: AnalyzedProgram): string | undefined {
  if (hint === null) return undefined;
  const parts = hint.trim().split(/\s+/);
  const first = parts[0]!;
  const base = parts.length > 1 && (first === "series" || first === "simple" || first === "const") ? parts[1]! : first;
  return prog.enumTypes.has(base) ? base : undefined;
}

// var/'=' 로컬 초기값이 `input.enum(EnumType.member, ...)` 콜이면 그 첫 인자(위치 또는 defval=
// 키워드)의 DotAccess.obj가 가리키는 등록된 enum 타입명을 반환한다(C677, isUdtConstructorCall의
// enum 버전 -- explicit typeHint가 없는 `i_timezone = input.enum(Timezones.ny, ...)`류에서 초기값
// 자체로 타입을 추론). 멤버 이름이 실제로 그 enum에 존재하는지는 검증하지 않는다(값 흐름 추적
// 없음, 다른 isXxxConstructorCall류와 동일한 순수 구조 판별 원칙 -- 오타는 analyzeExpr(DotAccess)의
// 별도 enum 멤버 존재 검증이 이미 잡는다).
function inferEnumConstructorType(value: Expr, prog: AnalyzedProgram): string | null {
  if (value.kind !== "CallExpr") return null;
  const callee = value.callee;
  if (callee.kind !== "DotAccess" || callee.obj.kind !== "Identifier" || callee.obj.name !== "input" || callee.attr !== "enum") {
    return null;
  }
  const firstArg = value.args[0];
  if (firstArg !== undefined && firstArg.kind === "DotAccess" && firstArg.obj.kind === "Identifier" && prog.enumTypes.has(firstArg.obj.name)) {
    return firstArg.obj.name;
  }
  const defvalKwarg = value.kwargs.find((kw) => kw.name === "defval");
  if (
    defvalKwarg !== undefined &&
    defvalKwarg.value.kind === "DotAccess" &&
    defvalKwarg.value.obj.kind === "Identifier" &&
    prog.enumTypes.has(defvalKwarg.value.obj.name)
  ) {
    return defvalKwarg.value.obj.name;
  }
  return null;
}

// resolveDrawingExprKind와 완전히 동일한 조회 순서((1) scope 체인의 enumKindHints('=' 로컬,
// top-level 포함) -> (2) scope.func의 매개변수 typeHint(paramTypeHints, C328/C676과 동일한
// "이미 모든 매개변수에 채워지는 범용 맵" 재사용 -- wild TUF_LOGIC 라이브러리
// `export method NOT(series Trilean self)=> ... self.OR(comparator)...`류, 같은 method 본문
// 안에서 Trilean 타입 매개변수를 다시 receiver로 쓰는 콜 체이닝) -> (3) top-level var 전용
// prog.enumVarTypes) — enum 인스턴스로 정적 확정되는 표현식인지 판별한다(C677, 배치34
// 'UDT첫매개변수' 잔여 클러스터 -- method 첫 매개변수가 사용자 선언 enum 타입인 extension method,
// `method param(simple Timeframes input) => switch input ...`류). resolveUdtMethodReceiverType의
// 추가 폴백 하나로만 소비되며(call-expr.ts), UDT와 달리 필드 체이닝(DotAccess) 대상은 없다(enum은
// 필드가 없음 -- Trilean.True 같은 멤버 접근은 이 함수의 관심사가 아니라 analyzeExpr DotAccess의
// 별도 enumTypes 분기가 처리).
export function resolveEnumExprType(target: Expr, prog: AnalyzedProgram, scope: LexScope): string | undefined {
  if (target.kind !== "Identifier") return undefined;
  const localType = resolveLocalEnumKind(scope, target.name);
  if (localType !== undefined) return localType;
  const paramType = enumTypeFromTypeHint(scope.func?.paramTypeHints.get(target.name) ?? null, prog);
  if (paramType !== undefined) return paramType;
  return prog.enumVarTypes.get(target.name);
}

// resolveLocalDrawingKind와 동일한 체인 탐색을 matrixKindHints에 적용(method-call 스타일 matrix
// 콜 수신자 판별 전용, C237).
function resolveLocalMatrixKind(scope: LexScope, name: string): boolean {
  let s: LexScope | null = scope;
  while (s) {
    if (s.matrixKindHints.has(name)) return true;
    s = s.parent;
  }
  return false;
}

// containerKindFromTypeHint/drawingKindFromTypeHint(C415/C476)와 완전히 동일한 qualifier-strip
// 규칙의 matrix 버전 — UDT 필드 typeHint("matrix<float>" 등)가 matrix인지만 boolean으로 판별.
function isMatrixTypeHint(hint: string): boolean {
  const parts = hint.trim().split(/\s+/);
  const first = parts[0]!;
  const base = parts.length > 1 && (first === "series" || first === "simple" || first === "const") ? parts[1]! : first;
  return base === "matrix" || base.startsWith("matrix<");
}

// resolveContainerExprKind/resolveDrawingExprKind와 완전히 동일한 조회 순서((1) scope 체인의
// matrixKindHints('=' 로컬, top-level 포함) -> (1.5) func-local var(C425, scope.func?.localVarValueKinds
// -- resolveContainerExprKind는 이미 이 폴백을 갖췄으나(L5188) matrix는 여태 빠져 있던 비대칭이었음,
// C646, wild `fvgMat.add_col(...)`류 func-local `var m = matrix.new<T>()`) -> (1.7) UDF/method
// 매개변수의 명시 typeHint(C646, scope.func?.paramTypeHints — resolveContainerExprKind의 paramKind
// 폴백(L5190)과 동일 원칙. wild `method pivotCalcH(matrix<float> id, ...) => id.add_col(...)`류,
// 값 흐름 추적 없는 순수 선언 typeHint 판별이라 과욕 금지 원칙과 무관 -- UDT 축(paramTypeHints
// 소비처)이 이미 이 신뢰 수준으로 쓰고 있음) -> (2) top-level var 전용 prog.matrixVars -> (3) UDT
// 필드 typeHint, C502) — matrix 핸들로 정적 확정되는 표현식인지 판별한다(C237, call-expr.ts의
// method-call 스타일 matrix 콜 `m.det()` == `matrix.det(m)` 수신자 판별 소비처 하나뿐). 명시 typeHint
// 없는 매개변수/복합식은 여전히 false(값 흐름 추적 없음, 같은 과욕 금지 원칙). drawing과 달리 kind가
// 하나뿐이라 boolean을 반환한다. CallExpr 분기(C494, wild `kso_F.mult(kso_P.mult(kso_F.transpose())).sum(kso_Q)`류)
// -- 리터럴 `matrix.foo(...)`/`matrix.mult(...)`(isMatrixConstructorCall/isMatrixMultCall) 및
// method-call sugar 체이닝(isMatrixReturningMethodSugarCall, 재귀적으로 이 함수 자신을 호출)이
// matrix를 새로 반환하면 인정 -- array/map의 C420(resolveContainerExprKind CallExpr 분기)과 동일
// 원칙을 그동안 CallExpr 분기 자체가 없었던 matrix에 처음 적용. UDT 필드 분기(C502, wild
// `data.HLmat.get(0, i)`류 -- resolveContainerExprKind/resolveDrawingExprKind는 이미 C323부터
// resolveUdtFieldTypeHint 폴백을 갖췄으나 matrix는 Identifier/CallExpr 둘뿐이라 DotAccess가 항상
// false로 떨어지는 비대칭이었음)은 array/map의 fieldType 폴백(resolveContainerExprKind 마지막 두
// 줄)과 동일한 자리에 동일한 원칙으로 추가. isMatrixSumCall(C658, 리터럴 `matrix.sum(id1, id2)`
// 2-인자 폼 -- mult와 마찬가지로 값이 아니라 인자 개수 자체가 matrix/스칼라 반환을 가르는 신호라
// isMatrixMultCall과 나란한 별도 술어로 분리, wild `p = matrix.sum(m1, m2)` 후 `p.det()`류가
// 이 분기 누락으로 여전히 거부되던 비대칭 해소).
export function resolveMatrixExprKind(target: Expr, prog: AnalyzedProgram, scope: LexScope): boolean {
  if (target.kind === "CallExpr") {
    return (
      isMatrixConstructorCall(target) ||
      isMatrixMultCall(target) ||
      isMatrixSumCall(target) ||
      isMatrixReturningMethodSugarCall(target, prog, scope)
    );
  }
  if (target.kind === "Identifier") {
    if (resolveLocalMatrixKind(scope, target.name)) return true;
    if (scope.func?.localVarValueKinds.get(target.name) === "matrix") return true;
    const paramHint = scope.func?.paramTypeHints.get(target.name) ?? null;
    if (paramHint !== null && isMatrixTypeHint(paramHint)) return true;
    // C709: 명시 typeHint 없는 매개변수의 본문 내부 자기참조 추론(scanOwnParamContainerKindUsage의
    // matrix 판, paramMatrixKinds) — resolveContainerExprKind의 inferredParamKind 폴백과 동일 원칙.
    if (scope.func?.paramMatrixKinds.has(target.name)) return true;
    return prog.matrixVars.has(target.name);
  }
  const fieldType = resolveUdtFieldTypeHint(target, prog, scope);
  return fieldType !== undefined && isMatrixTypeHint(fieldType);
}

function analyzeSwitchStmt(stmt: SwitchStmt, prog: AnalyzedProgram, scope: LexScope): void {
  // subject는 for의 start/end/step과 같은 원리로 switch 진입 시 단 한 번만 평가된다 —
  // 조건부(depth+1) 영역으로 다루지 않고 현재 scope 그대로 분석한다.
  if (stmt.subject !== null) analyzeExpr(stmt.subject, prog, scope, false);

  // case 값은 앞선 case가 매치하지 않을 때만 평가되는 short-circuit 체인이라(elif 조건과 동일 원칙,
  // analyzeIfStmt 주석 참조) kind:"condition"으로 다뤄 stateful 콜 검사를 적용한다. C260부터 이
  // condition 안의 직접 호출(and/or lazy 우변 밖)은 허용되지만, 한 case 안에 콤마로 나열된 값
  // 목록(`case v1, v2 => ...`)은 genSwitchCaseTest가 `v1 || v2 || ...`로 내려 v1만 항상 평가되고
  // v2 이후는 앞선 값이 매치하면 평가되지 않는 진짜 lazy 위치다 — and/or 우변과 동일하게
  // kind:"lazy-expr"로 다뤄 두 번째 값부터는 여전히 거부되게 한다(C260 직접 호출 허용은 각 case의
  // 첫 값에만 적용).
  const condScope = pushScope(scope, "condition");
  let sawDefault = false;
  for (const c of stmt.cases) {
    if (c.values === null) {
      if (sawDefault) {
        prog.errors.push(`switch에는 default(bare '=>') 분기가 최대 1개만 가능 (L${stmt.line}:${stmt.col})`);
      }
      sawDefault = true;
    } else {
      c.values.forEach((v, i) => {
        const valueScope = i === 0 ? condScope : pushScope(condScope, "lazy-expr");
        analyzeExpr(v, prog, valueScope, false);
      });
    }
    // case 본문은 if 분기 본문과 동일한 문장 레벨 조건부(pine2py도 switch를 if/elif 체인으로
    // 트랜스파일)라 kind:"cond-body"로 다뤄 per-call 상태 전진을 허용한다(C65,
    // oracle/cases/cond_switch_ta.pine으로 수치 확정 — ScopePushKind 주석 참조).
    analyzeBlock(c.body, prog, scope, "cond-body");
  }
}

// [a, b] = switch subject \n case1 => [v1, v2] \n ... \n => [d1, d2] — analyzeTupleDestructure
// 전용(analyzeSwitchStmt와 거의 같은 subject 1회 평가/case값 condition·lazy-expr/case본문
// cond-body 스코프 규칙이나, 각 case 본문의 **마지막 문장만** analyzeBlock의 일반 analyzeStmt
// 경로(ExprStmt의 TupleExpr는 analyzeExpr가 "함수의 마지막 문장에서만 지원"으로 거부함, C243 유사
// 원칙) 대신 UDF/method 튜플 반환(analyzeFuncDecl/analyzeMethodDecl)과 동일하게 원소별 analyzeExpr로
// 직접 처리한다). 반환값 ok는 모든 분기가 정확히 arity개짜리 TupleExpr로 끝났는지 — 하나라도
// 아니면 false(호출부가 기존 generic "튜플을 반환하는 호출이어야 함" 에러로 폴백). elemKinds는
// 원소 위치별 첫 non-null 히스토리 비수치 kind(classifyTupleElemNonNumericKind, C369 UDF 튜플
// 반환과 동일한 헬퍼) — topLevelTupleElemKinds 등록(analyzeTupleDestructure)이 소비한다.
// C685: switch/if/삼항/튜플리터럴 분기 튜플 값의 원소별 판정 묶음 — elemKinds는 히스토리 게이트용
// 비수치 kind(C369, 분기 간 첫 non-null 유지), elemContainerKinds는 method-sugar 디스패치용 컨테이너
// 종류(FuncInfo.tupleElemContainerKinds(C649)의 분기 합의판). 분기 간 컨테이너 판정이 서로 어긋난
// 원소는 elemContainerConflicts로 영구 표시해 상위(중첩 if/switch/삼항) 병합에서 다른 분기의
// non-null 판정이 그 원소를 되살리지 못하게 한다 — 오판 등록(잘못된 method 디스패치)이
// 미등록(기존과 동일한 거부)보다 위험하므로 false negative 쪽이 항상 안전(C394 원칙).
type TupleBranchValueResult = {
  ok: boolean;
  elemKinds: (string | null)[];
  elemContainerKinds: ("array" | "map" | null)[];
  elemContainerConflicts: boolean[];
};

// C685: 분기 하나의 컨테이너 kind 판정을 누적치에 합의 병합 — null(미확정/na 리터럴 분기)은
// 무시하고, non-null끼리 어긋나면 conflict로 포이즌(누적값 null 고정).
function mergeTupleElemContainerKinds(
  accKinds: ("array" | "map" | null)[],
  accConflicts: boolean[],
  branch: TupleBranchValueResult,
  arity: number,
): void {
  for (let i = 0; i < arity; i++) {
    if (branch.elemContainerConflicts[i]) {
      accConflicts[i] = true;
    }
    if (accConflicts[i]) {
      accKinds[i] = null;
      continue;
    }
    const k = branch.elemContainerKinds[i] ?? null;
    if (k === null) continue;
    if (accKinds[i] === null) {
      accKinds[i] = k;
    } else if (accKinds[i] !== k) {
      accConflicts[i] = true;
      accKinds[i] = null;
    }
  }
}

function analyzeSwitchTupleValue(
  stmt: SwitchStmt,
  arity: number,
  prog: AnalyzedProgram,
  scope: LexScope,
): TupleBranchValueResult {
  if (stmt.subject !== null) analyzeExpr(stmt.subject, prog, scope, false);

  const condScope = pushScope(scope, "condition");
  let sawDefault = false;
  let ok = true;
  const elemKinds: (string | null)[] = new Array(arity).fill(null);
  const elemContainerKinds: ("array" | "map" | null)[] = new Array(arity).fill(null);
  const elemContainerConflicts: boolean[] = new Array(arity).fill(false);
  for (const c of stmt.cases) {
    if (c.values === null) {
      if (sawDefault) {
        prog.errors.push(`switch에는 default(bare '=>') 분기가 최대 1개만 가능 (L${stmt.line}:${stmt.col})`);
      }
      sawDefault = true;
    } else {
      c.values.forEach((v, i) => {
        const valueScope = i === 0 ? condScope : pushScope(condScope, "lazy-expr");
        analyzeExpr(v, prog, valueScope, false);
      });
    }

    const bodyScope = pushScope(scope, "cond-body");
    const lastIdx = c.body.length - 1;
    const last = lastIdx >= 0 ? c.body[lastIdx] : undefined;
    for (let i = 0; i < lastIdx; i++) analyzeStmt(c.body[i]!, prog, bodyScope);
    if (last === undefined) {
      ok = false;
      continue;
    }
    // C508: 마지막 문장이 튜플 리터럴이 아니어도 튜플 반환 UDF/ta.* 다중반환/request.security
    // 튜플일 수 있다(resolveTupleValueBranch — 삼항의 형제 폼, wild `[reg,slp]=switch methodSel
    // \n "Linear"=>f_linreg(...) ... \n =>[float(na),float(na)]`류). 원소별 kind는 분기 간
    // 첫 non-null만 유지(기존 TupleExpr 전용 루프와 동일 원칙). C609: 마지막 문장이 다시
    // IfStmt/SwitchStmt(중첩)면 resolveTupleValueBranchStmt가 재귀로 흡수(위 주석 참조).
    const branchResult = resolveTupleValueBranchStmt(last, arity, prog, bodyScope, "switch");
    if (!branchResult.ok) ok = false;
    for (let i = 0; i < arity; i++) {
      if (elemKinds[i] === null) elemKinds[i] = branchResult.elemKinds[i] ?? null;
    }
    mergeTupleElemContainerKinds(elemContainerKinds, elemContainerConflicts, branchResult, arity);
  }
  return { ok, elemKinds, elemContainerKinds, elemContainerConflicts };
}

// [a, b] = if cond \n [v1, v2] \n else \n [v3, v4] — analyzeTupleDestructure 전용(analyzeIfStmt와
// 동일한 조건/분기 스코프 규칙이나, 각 분기 본문의 **마지막 문장만** analyzeBlock의 일반 analyzeStmt
// 경로 대신 UDF/method 튜플 반환·analyzeSwitchTupleValue(C410)와 동일하게 원소별 analyzeExpr로 직접
// 처리한다 — switch-튜플의 형제 폼(C411)). 반환값 ok는 존재하는 모든 분기(then/elif/else)가 정확히
// arity개짜리 TupleExpr로 끝났는지 — else가 없으면(switch의 default 없음과 동일하게) 미매치 시 전
// target NaN 폴백을 그대로 허용한다. elemKinds는 원소 위치별 첫 non-null 히스토리 비수치 kind
// (classifyTupleElemNonNumericKind, C369/C410과 동일한 헬퍼) — topLevelTupleElemKinds 등록
// (analyzeTupleDestructure)이 소비한다.
function analyzeIfTupleValue(
  stmt: IfStmt,
  arity: number,
  prog: AnalyzedProgram,
  scope: LexScope,
): TupleBranchValueResult {
  let ok = true;
  const elemKinds: (string | null)[] = new Array(arity).fill(null);
  const elemContainerKinds: ("array" | "map" | null)[] = new Array(arity).fill(null);
  const elemContainerConflicts: boolean[] = new Array(arity).fill(false);

  const analyzeBranchBody = (body: Stmt[]): void => {
    const bodyScope = pushScope(scope, "cond-body");
    const lastIdx = body.length - 1;
    const last = lastIdx >= 0 ? body[lastIdx] : undefined;
    for (let i = 0; i < lastIdx; i++) analyzeStmt(body[i]!, prog, bodyScope);
    if (last === undefined) {
      ok = false;
      return;
    }
    // C508: switch-튜플과 동일하게 튜플 반환 UDF/ta.* 다중반환/request.security 튜플도 허용
    // (resolveTupleValueBranch 재사용 — analyzeSwitchTupleValue 주석 참조). C609: 마지막 문장이
    // 다시 IfStmt/SwitchStmt(중첩)면 resolveTupleValueBranchStmt가 재귀로 흡수(위 주석 참조).
    const branchResult = resolveTupleValueBranchStmt(last, arity, prog, bodyScope, "if");
    if (!branchResult.ok) ok = false;
    for (let i = 0; i < arity; i++) {
      if (elemKinds[i] === null) elemKinds[i] = branchResult.elemKinds[i] ?? null;
    }
    mergeTupleElemContainerKinds(elemContainerKinds, elemContainerConflicts, branchResult, arity);
  };

  // analyzeIfStmt 주석 참조 — 최초 조건은 무조건 1회 평가되는 per-call 위치라 kind push 없이 현재
  // scope 그대로, elif 조건은 진짜 short-circuit 체인이라 kind:"condition"으로 거부.
  analyzeExpr(stmt.condition, prog, scope, false);
  analyzeBranchBody(stmt.thenBody);

  const condScope = pushScope(scope, "condition");
  for (const clause of stmt.elifClauses) {
    analyzeExpr(clause.condition, prog, condScope, false);
    analyzeBranchBody(clause.body);
  }
  if (stmt.elseBody !== null) analyzeBranchBody(stmt.elseBody);

  return { ok, elemKinds, elemContainerKinds, elemContainerConflicts };
}

// UDF/method 본문의 **마지막 문장**이 `if cond \n [a,b] \n else \n [c,d]`(if-표현식 자체가 튜플을
// 암시 반환)인 폼 — wild "튜플 리터럴은 함수의 마지막 문장에서만 지원" 클러스터의 82%(next_hint,
// C4XX). analyzeIfTupleValue(바로 위, 튜플 디스트럭처 **값** 위치용 — 대상 arity가 destructure
// 타깃 개수로 이미 알려짐)와 달리 여기선 함수 반환 위치라 arity를 아는 대상이 없어 분기 자신에서
// 먼저 추론해야 한다. else 분기가 없어도(then/elif만으로) arity가 일치하면 채택한다(C519) —
// analyzeIfTupleValue가 이미 "else 없으면 미매치 target은 NaN 폴백"을 지원하고, codegen
// genReturnIfStmt도 이 경우 합성 `else return [NaN,...]`을 붙여 조건 불일치 시 undefined 암시
// 반환(호출부 `[a,b]=f()` 구조분해가 크래시)을 막는다 — 스칼라 UDT 반환 추론의 "else 없으면 null"
// 원칙(inferReturnStmtUdtType, C264)과 동일한 na 폴백 철학. C609(배치32): 분기 마지막 문장이
// 다시 중첩 if/switch면 detectTupleReturnArityFromLastStmt가 그 안으로 재귀해 arity를 추론한다
// (이전엔 "중첩 if/switch 범위 밖"으로 null 폴백했으나 wild corpus 최다 원인 중 하나로 확인돼
// 뒤집음 — resolveTupleValueBranchStmt와 동일한 상호 재귀 원리, 되돌리지 말 것).
function detectIfTupleReturnArity(stmt: IfStmt, prog: AnalyzedProgram): number | null {
  const bodies = [stmt.thenBody, ...stmt.elifClauses.map((c) => c.body)];
  if (stmt.elseBody !== null) bodies.push(stmt.elseBody);
  const arities: number[] = [];
  for (const body of bodies) {
    const last = body.length > 0 ? body[body.length - 1] : undefined;
    const arity = detectTupleReturnArityFromLastStmt(last, prog);
    if (arity === null) return null;
    arities.push(arity);
  }
  const first = arities[0]!;
  return arities.every((a) => a === first) ? first : null;
}

// detectIfTupleReturnArity/detectSwitchTupleReturnArity 공용 — 분기(또는 case)의 마지막 문장
// 하나가 "튜플 arity를 암시 반환"하는지 판별한다. 기본형(ExprStmt+TupleExpr 리터럴) 외에 그
// 문장 자신이 IfStmt/SwitchStmt(중첩)면 두 detect 함수로 재귀 위임 — 상호 재귀(mutual
// recursion)이므로 함수 선언 호이스팅에 의존한다(선언 순서 무관, C609). C612부터 ExprStmt
// 리프는 detectTupleReturnArityFromTailExpr로 일반화(security 튜플/bare-UDF/튜플 UDF 콜/삼항).
export function detectTupleReturnArityFromLastStmt(last: Stmt | undefined, prog: AnalyzedProgram): number | null {
  if (last === undefined) return null;
  if (last.kind === "ExprStmt") return detectTupleReturnArityFromTailExpr(last.expr, prog);
  if (last.kind === "IfStmt") return detectIfTupleReturnArity(last, prog);
  if (last.kind === "SwitchStmt") return detectSwitchTupleReturnArity(last, prog);
  return null;
}

// C612(배치32(1) 잔여): 분기 꼬리의 값 표현식 하나가 "튜플 arity를 암시 반환"하는지 판별하는
// 리프 집합 — TupleExpr 리터럴 외에 C611 두 꼬리 폼(request.security 튜플 리터럴 expression/
// security bare-UDF passthrough)과 직접 튜플 UDF 콜(bodyAnalyzed+tupleArity 확정), 삼항(양 분기
// arity 일치)을 인정한다(wild if<sec(tuple-lit)>/if<tuple-literal|udf-call>/switch<udf-call>/
// ternary<tuple-literal|sec(tuple-lit)> 실측, c611_tail_shape_probe.mjs). ⚠ 이 리프 집합은
// resolveTupleValueBranch의 수용 종과 반드시 부분집합 관계여야 한다(detect가 인정하면 validate도
// 같은 arity로 인정 — 아니면 detect 성공 후 validate 실패로 폴백 재분석(이중 슬롯 등록, C180)
// 위험). C629: ta.* 다중반환도 이제 detect에 추가(validate엔 이미 있었음, resolveTupleValueBranch
// L5646 참조 — wild `macd(source,...) =>\n  ta.macd(source,...)` 래퍼 UDF 관용구 실측,
// 튜플 디스트럭처링 172-클러스터 최다 non-library 서브패턴). codegen(genImplicitReturn 삼항 꼬리)도
// 같은 판별을 재실행한다.
export function detectTupleReturnArityFromTailExpr(expr: Expr, prog: AnalyzedProgram): number | null {
  if (expr.kind === "TupleExpr") return expr.elements.length;
  if (expr.kind === "CallExpr") {
    if (expr.callee.kind === "Identifier") {
      const f = prog.funcs.get(expr.callee.name);
      return f !== undefined && f.bodyAnalyzed && f.tupleArity !== null ? f.tupleArity : null;
    }
    const secArity = securityTupleReturnArity(expr);
    if (secArity !== null) return secArity;
    const bareUdf = securityBareUdfTupleTail(expr, prog);
    if (bareUdf !== null) return bareUdf.func.tupleArity;
    const taArity = taMultiReturnTailArity(expr);
    if (taArity !== null) return taArity;
    return null;
  }
  if (expr.kind === "TernaryOp") {
    const t = detectTupleReturnArityFromTailExpr(expr.trueExpr, prog);
    if (t === null) return null;
    const f = detectTupleReturnArityFromTailExpr(expr.falseExpr, prog);
    return f === t ? t : null;
  }
  return null;
}

// C629: `ta.macd(...)` 등 DotAccess 다중 반환 TA 콜의 arity — resolveTupleValueBranch(L5646)의
// 동일 조회를 detect 쪽에서도 미러한다(위 주석 "validate엔 있으나 detect엔 없음" 격차 해소).
function taMultiReturnTailArity(expr: CallExpr): number | null {
  if (expr.callee.kind !== "DotAccess" || expr.callee.obj.kind !== "Identifier") return null;
  if (expr.callee.obj.name !== "ta") return null;
  const entry = TA_REGISTRY[expr.callee.attr];
  if (entry === undefined || entry.dispatch !== "ta") return null;
  const callArity = taCallReturnArity(entry, expr.args.length);
  return callArity ?? null;
}

// analyzeFuncDecl/analyzeMethodDecl 공용 진입점 — detectIfTupleReturnArity로 대상 arity를 추론한
// 뒤 analyzeIfTupleValue(원소별 analyzeExpr/kind 판별)를 그대로 재사용한다. null 반환 시 호출부가
// 기존 analyzeStmt(일반 IfStmt 경로) 폴백으로 떨어져 이전과 동일한 에러를 낸다.
function tryFuncBodyIfTupleReturn(
  s: IfStmt,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): { arity: number; elemKinds: (string | null)[]; elemContainerKinds: ("array" | "map" | null)[] } | null {
  const arity = detectIfTupleReturnArity(s, prog);
  if (arity === null) return null;
  const result = analyzeIfTupleValue(s, arity, prog, bodyScope);
  // C685: conflict 원소는 병합이 이미 null로 고정 — elemContainerKinds를 그대로 FuncInfo에 실어도 안전.
  return result.ok ? { arity, elemKinds: result.elemKinds, elemContainerKinds: result.elemContainerKinds } : null;
}

// UDF/method 본문의 **마지막 문장**이 `switch subj \n v1 => [a,b] \n => [c,d]`(switch-표현식
// 자체가 튜플을 암시 반환)인 폼 — detectIfTupleReturnArity/tryFuncBodyIfTupleReturn(C461)의 switch
// 형제 폼(C462, wild "튜플 디스트럭처링의 값은 튜플을 반환하는 UDF 호출이어야 함" 클러스터 잔여
// 재조사로 발견 — 실측 5건, 3건이 이 갭 단독 원인). default(bare '=>') 분기가 없어도 채택한다
// (C519, if 형제 폼과 동일 완화) — analyzeSwitchTupleValue는 애초에 default 유무와 무관하게
// 나열된 case들의 arity만 검증하고, codegen genReturnSwitchStmt가 미매치 시를 대비한 합성
// `else return [NaN,...]`을 붙여 undefined 암시 반환(호출부 구조분해 크래시)을 막는다.
function detectSwitchTupleReturnArity(stmt: SwitchStmt, prog: AnalyzedProgram): number | null {
  if (stmt.cases.length === 0) return null;
  const arities: number[] = [];
  for (const c of stmt.cases) {
    const last = c.body.length > 0 ? c.body[c.body.length - 1] : undefined;
    const arity = detectTupleReturnArityFromLastStmt(last, prog);
    if (arity === null) return null;
    arities.push(arity);
  }
  const first = arities[0]!;
  return arities.every((a) => a === first) ? first : null;
}

// analyzeFuncDecl/analyzeMethodDecl 공용 진입점 — tryFuncBodyIfTupleReturn과 동일한 패턴
// (detectSwitchTupleReturnArity로 대상 arity를 추론한 뒤 analyzeSwitchTupleValue(C410, 튜플
// 디스트럭처 값 위치와 공유하는 기존 스캐폴드)를 그대로 재사용).
function tryFuncBodySwitchTupleReturn(
  s: SwitchStmt,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): { arity: number; elemKinds: (string | null)[]; elemContainerKinds: ("array" | "map" | null)[] } | null {
  const arity = detectSwitchTupleReturnArity(s, prog);
  if (arity === null) return null;
  const result = analyzeSwitchTupleValue(s, arity, prog, bodyScope);
  // C685: conflict 원소는 병합이 이미 null로 고정 — elemContainerKinds를 그대로 FuncInfo에 실어도 안전.
  return result.ok ? { arity, elemKinds: result.elemKinds, elemContainerKinds: result.elemContainerKinds } : null;
}

// C765: analyzeFuncDecl/analyzeMethodDecl 마지막 문장이 단문 화살표 본문(`f(x) => switch x`류,
// '=>' 직후 INDENT 없이 제어문이 같은 줄에서 시작)이라 파서가 ExprStmt{IfStmt|SwitchStmt}로 감싸둔
// 폼 전용 — 감싸지 않은 직접-IfStmt/SwitchStmt 두 분기(바로 아래)와 동일하게 튜플 반환을 먼저
// 시도하고, 아니면 analyzeIfStmt/analyzeSwitchStmt로 스칼라 암시반환을 허용한다(analyzeControlFlowOrExpr가
// VarDecl/Assignment 값 위치에서 하는 처리와 동형 — 여기는 UDF 본문 마지막 문장 위치라는 점만 다름).
function analyzeFuncBodyTailWrappedCtrlFlow(
  inner: IfStmt | SwitchStmt,
  prog: AnalyzedProgram,
  bodyScope: LexScope,
): { arity: number; elemKinds: (string | null)[]; elemContainerKinds: ("array" | "map" | null)[] } | null {
  const tupleReturn =
    inner.kind === "IfStmt"
      ? tryFuncBodyIfTupleReturn(inner, prog, bodyScope)
      : tryFuncBodySwitchTupleReturn(inner, prog, bodyScope);
  if (tupleReturn !== null) return tupleReturn;
  const trailing = findTrailingTupleExprInStmt(inner);
  if (trailing !== null) {
    prog.errors.push(`튜플 리터럴은 함수의 마지막 문장(튜플 반환)에서만 지원 (L${trailing.line}:${trailing.col})`);
  }
  if (inner.kind === "IfStmt") analyzeIfStmt(inner, prog, bodyScope);
  else analyzeSwitchStmt(inner, prog, bodyScope);
  return null;
}

// [a, b] = cond ? trueVal : falseVal — switch-튜플(C410)/if-튜플(C411)의 세 번째 형제 폼(C416,
// wild AST 전수 스캔 6건 — `calcvwmacd ? ta.macd(...) : [na, na, na]`류). switch/if와 달리 각
// 분기는 문장 블록이 아니라 단일 표현식이라 "튜플을 반환하는 값"의 정의 자체가 다르다 — 최상위
// analyzeTupleDestructure의 값 판별 3+1종(TupleExpr 리터럴/ta.* 다중반환/UDF tupleArity 일치/
// request.security 튜플 리터럴)과 동일한 판별을 각 분기(trueExpr/falseExpr)에 독립적으로
// 재적용한다(resolveTupleValueBranch — 최상위 dispatch는 stmt 전용 필드(pendingUdfFunc 등)에
// 얽혀 있어 공유하지 않음). 두 분기가 서로 다른 값 종류를 섞어 써도 무방(wild 실측: 한쪽은
// ta.macd/request.security/UDF콜, 다른쪽은 [na,na,...] 리터럴). forward-ref UDF(C412)는 corpus
// 근거 0건이라 대상 밖(bodyAnalyzed 이전이면 그냥 미매치로 폴백).
function analyzeTernaryTupleValue(
  stmt: TernaryOp,
  arity: number,
  prog: AnalyzedProgram,
  scope: LexScope,
): TupleBranchValueResult {
  // analyzeExpr TernaryOp case와 동일하게 조건은 무조건 1회 평가(kind push 없음), 두 분기는 조건에
  // 따라 하나만 실행되는 lazy 위치(C66 eager 호이스팅 대상, codegen genTernaryTupleDestructure가
  // if/else로 직접 내려 실제로 한쪽만 실행됨 — lazy-expr 태그는 stateful 콜 검증용).
  analyzeExpr(stmt.condition, prog, scope, false);
  const trueScope = pushScope(scope, "lazy-expr");
  const trueResult = resolveTupleValueBranch(stmt.trueExpr, arity, prog, trueScope, "삼항(ternary)");
  const falseScope = pushScope(scope, "lazy-expr");
  const falseResult = resolveTupleValueBranch(stmt.falseExpr, arity, prog, falseScope, "삼항(ternary)");
  const elemKinds: (string | null)[] = new Array(arity).fill(null);
  for (let i = 0; i < arity; i++) elemKinds[i] = trueResult.elemKinds[i] ?? falseResult.elemKinds[i] ?? null;
  const elemContainerKinds: ("array" | "map" | null)[] = new Array(arity).fill(null);
  const elemContainerConflicts: boolean[] = new Array(arity).fill(false);
  mergeTupleElemContainerKinds(elemContainerKinds, elemContainerConflicts, trueResult, arity);
  mergeTupleElemContainerKinds(elemContainerKinds, elemContainerConflicts, falseResult, arity);
  return { ok: trueResult.ok && falseResult.ok, elemKinds, elemContainerKinds, elemContainerConflicts };
}

// analyzeTernaryTupleValue 전용으로 시작했으나 C508에서 analyzeSwitchTupleValue/analyzeIfTupleValue의
// 마지막 문장 판별에도 공용화됨 — 분기 하나(삼항은 표현식 자체, switch/if는 body 마지막 ExprStmt.expr)가
// "튜플을 반환하는 값"인지 판별하고 그에 맞는 부작용(콜그래프 등록/타 스테이트 콜 슬롯/security 튜플
// 슬롯)을 등록한다. 최상위 analyzeTupleDestructure(L2124 부근)의 값 판별과 동일한 종류를 다루지만,
// 그쪽은 TupleDestructure stmt 전용 필드(pendingUdfFunc/registeredNames 등)에 묶여 있어 재사용하지
// 않고 독립 구현한다 — 실패(ok:false)해도 항상 analyzeExpr(expr)을 호출해 미선언 식별자 등 일반 검증은
// 그대로 받는다(switch/if 분기가 "튜플 아님" 판정 시에도 본문 전체를 analyzeStmt하는 것과 동일한 원칙).
// branchLabel은 원소 개수 불일치 에러 문구에만 쓰인다(호출부별 기존 문구 보존 — "switch"/"if"/
// "삼항(ternary)").
function resolveTupleValueBranch(
  expr: Expr,
  arity: number,
  prog: AnalyzedProgram,
  scope: LexScope,
  branchLabel: string,
): TupleBranchValueResult {
  const elemKinds: (string | null)[] = new Array(arity).fill(null);
  // C685: 원소별 컨테이너 kind — 리프 분기라 conflict는 항상 false(합의 병합은 상위
  // analyzeSwitch/If/TernaryTupleValue의 몫). 콜 계열 분기는 콜리 FuncInfo.tupleElemContainerKinds
  // (C649, tupleArity와 같은 지점에서 확정되는 불변식)를 그대로 승계한다.
  const elemContainerKinds: ("array" | "map" | null)[] = new Array(arity).fill(null);
  const elemContainerConflicts: boolean[] = new Array(arity).fill(false);
  const copyFuncElemContainerKinds = (info: FuncInfo): void => {
    const kinds = info.tupleElemContainerKinds;
    if (kinds) for (let i = 0; i < arity; i++) elemContainerKinds[i] = kinds[i] ?? null;
  };
  if (expr.kind === "TupleExpr") {
    let ok = true;
    if (expr.elements.length !== arity) {
      ok = false;
      prog.errors.push(
        `${branchLabel} 분기의 튜플 리터럴 원소 개수가 대상과 다름: 분기 ${expr.elements.length}개, 대상 ${arity}개 (L${expr.line}:${expr.col})`,
      );
    }
    expr.elements.forEach((el, i) => {
      analyzeExpr(el, prog, scope, false);
      if (i < arity) {
        elemKinds[i] = classifyTupleElemNonNumericKind(el, prog, scope);
        elemContainerKinds[i] = resolveContainerExprKind(el, prog, scope);
      }
    });
    return { ok, elemKinds, elemContainerKinds, elemContainerConflicts };
  }
  if (expr.kind === "CallExpr" && expr.callee.kind === "Identifier") {
    const calleeFunc = prog.funcs.get(expr.callee.name);
    if (calleeFunc !== undefined && calleeFunc.bodyAnalyzed && calleeFunc.tupleArity === arity) {
      analyzeExpr(expr, prog, scope, false);
      const kinds = calleeFunc.tupleElemNonNumericKinds;
      if (kinds) for (let i = 0; i < arity; i++) elemKinds[i] = kinds[i] ?? null;
      copyFuncElemContainerKinds(calleeFunc);
      return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
    }
    analyzeExpr(expr, prog, scope, false);
    return { ok: false, elemKinds, elemContainerKinds, elemContainerConflicts };
  }
  if (expr.kind === "CallExpr" && expr.callee.kind === "DotAccess") {
    const callee = expr.callee;
    const namespace = callee.obj.kind === "Identifier" ? callee.obj.name : null;
    const entry = namespace === "ta" ? TA_REGISTRY[callee.attr] : undefined;
    const callArity = entry && entry.dispatch === "ta" ? taCallReturnArity(entry, expr.args.length) : undefined;
    if (entry && entry.dispatch === "ta" && callArity === arity) {
      prog.tupleStateCalls.add(expr);
      analyzeExpr(expr, prog, scope, false);
      return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
    }
    if (namespace === "request" && callee.attr === "security") {
      // C612: kwargs 'expression=' 폴백을 위치 인자와 나란히 본다(C431 — arity-peek/검증 경로가
      // 한쪽만 kwargs를 보면 detect(securityTupleReturnArity)와 비대칭이 생겨 detect 성공 후
      // validate 실패(폴백 재분석 이중 등록, C180) 위험).
      const seriesArg = expr.args[2] ?? expr.kwargs.find((kw) => kw.name === "expression")?.value;
      if (seriesArg !== undefined && seriesArg.kind === "TupleExpr" && seriesArg.elements.length === arity) {
        prog.tupleStateCalls.add(expr);
        analyzeExpr(expr, prog, scope, false);
        return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
      }
      // C612: security bare-UDF passthrough 꼬리(C611 flat 폼의 분기-꼬리판, wild
      // if<sec(bare-udf)|udf-call> 등) — analyzeFuncDecl C611 분기와 동일 등록(tupleStateCalls +
      // securityBareUdfCallSlots)을 미러하고 analyzeExpr 재귀가 call-expr.ts bareUdfInner 분기를
      // 타 내부 콜만 일반 UDF 콜 경로로 분석한다(이중 등록 없음, C180). 원소 kind는 내부 콜리의
      // 확정값을 그대로 승계(래퍼는 그 튜플을 무가공 재반환).
      const bareUdf = securityBareUdfTupleTail(expr, prog);
      if (bareUdf !== null && bareUdf.func.tupleArity === arity) {
        prog.tupleStateCalls.add(expr);
        prog.securityBareUdfCallSlots.set(expr, bareUdf.inner);
        analyzeExpr(expr, prog, scope, false);
        const kinds = bareUdf.func.tupleElemNonNumericKinds;
        if (kinds) for (let i = 0; i < arity; i++) elemKinds[i] = kinds[i] ?? null;
        copyFuncElemContainerKinds(bareUdf.func);
        return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
      }
    }
    // C613: UDT method/컨테이너(array·map·matrix) method/스칼라 확장 method 튜플 반환 —
    // analyzeTupleDestructure 본문의 receiver 캐스케이드(C463/C526, L2857 이하)와 동형이지만 그
    // 캐스케이드는 top-level 직접 값 위치에만 있었고 branch-tail(if/switch-as-value, wild
    // if<UDT method>/switch<UDT method> 실측, c613_bucket_samples.mjs)에는 없었다 — codegen은
    // 변경 불필요(UDT method 콜은 이미 일반 배열 반환 함수라 genTupleValueLines의 범용
    // `[targets]=value` 폴백이 그대로 맞아떨어짐). 실제 슬롯 등록은 아래 analyzeExpr(expr) 재귀가
    // call-expr.ts 표준 method 콜 경로로 전담(이중 등록 없음, C180).
    const receiverType = resolveUdtMethodReceiverType(callee.obj, prog, scope);
    // C687: dot-sugar 오버로드 선택(receiver 몫 +1) — 위 C463/C526 peek 캐스케이드와 동일 원칙.
    const branchDotArgTotal = 1 + expr.args.length + expr.kwargs.length;
    if (receiverType !== undefined) {
      const methodInfo = lookupMethodOverload(prog, receiverType, callee.attr, branchDotArgTotal, expr);
      if (methodInfo !== undefined && methodInfo.tupleArity === arity) {
        analyzeExpr(expr, prog, scope, false);
        const kinds = methodInfo.tupleElemNonNumericKinds;
        if (kinds) for (let i = 0; i < arity; i++) elemKinds[i] = kinds[i] ?? null;
        copyFuncElemContainerKinds(methodInfo);
        return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
      }
    } else {
      const containerKind = resolveContainerExprKind(callee.obj, prog, scope);
      const arrayMethod = containerKind === "array" ? lookupMethodOverload(prog, "array", callee.attr, branchDotArgTotal, expr) : undefined;
      const mapMethod = containerKind === "map" ? lookupMethodOverload(prog, "map", callee.attr, branchDotArgTotal, expr) : undefined;
      const matrixMethod =
        arrayMethod === undefined && mapMethod === undefined && resolveMatrixExprKind(callee.obj, prog, scope)
          ? lookupMethodOverload(prog, "matrix", callee.attr, branchDotArgTotal, expr)
          : undefined;
      const containerMethod = arrayMethod ?? mapMethod ?? matrixMethod;
      if (containerMethod !== undefined && containerMethod.tupleArity === arity) {
        analyzeExpr(expr, prog, scope, false);
        const kinds = containerMethod.tupleElemNonNumericKinds;
        if (kinds) for (let i = 0; i < arity; i++) elemKinds[i] = kinds[i] ?? null;
        copyFuncElemContainerKinds(containerMethod);
        return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
      }
      if (containerMethod === undefined) {
        const scalarMatches = resolveScalarMethodInfo(callee.attr, prog, branchDotArgTotal);
        if (scalarMatches.length === 1 && scalarMatches[0]!.info.tupleArity === arity) {
          analyzeExpr(expr, prog, scope, false);
          const kinds = scalarMatches[0]!.info.tupleElemNonNumericKinds;
          if (kinds) for (let i = 0; i < arity; i++) elemKinds[i] = kinds[i] ?? null;
          copyFuncElemContainerKinds(scalarMatches[0]!.info);
          return { ok: true, elemKinds, elemContainerKinds, elemContainerConflicts };
        }
      }
    }
    analyzeExpr(expr, prog, scope, false);
    return { ok: false, elemKinds, elemContainerKinds, elemContainerConflicts };
  }
  // C612: 분기 값이 다시 삼항이면 analyzeTernaryTupleValue로 재귀 —
  // detectTupleReturnArityFromTailExpr의 TernaryOp 재귀와 대칭(중첩 삼항까지 자연 흡수).
  if (expr.kind === "TernaryOp") {
    return analyzeTernaryTupleValue(expr, arity, prog, scope);
  }
  analyzeExpr(expr, prog, scope, false);
  return { ok: false, elemKinds, elemContainerKinds, elemContainerConflicts };
}

// C609(배치32): switch/if-튜플 분기의 **마지막 문장**이 resolveTupleValueBranch가 다루는 단일
// ExprStmt가 아니라 그 자신이 다시 IfStmt/SwitchStmt인 경우(중첩, wild 190740110fdf.pine/
// 21f059c7006f.pine 등 `[a,b] = switch ... => if cond \n [v1,v2] \n else \n [v3,v4]`류) —
// analyzeIfTupleValue/analyzeSwitchTupleValue를 그대로 재귀 호출해 그 분기 자체를 "arity가
// 이미 알려진 튜플 값 위치"로 재처리한다(security-expression 축의 동형 일반화, C606/C607
// resolveSecurityBodyConstValue와 동일 원리 — 신규 기구 없이 기존 두 함수의 상호 재귀만 추가).
// 이전엔 이 조합을 "중첩 if/switch는 범위 밖"으로 의도적으로 거부했으나(analyzeSwitchTupleValue/
// analyzeIfTupleValue 원 주석), 배치32 공출현 실측(C609)에서 wild corpus 최다 원인 중 하나로
// 확인돼 뒤집었다 — 되돌리지 말 것.
function resolveTupleValueBranchStmt(
  last: Stmt,
  arity: number,
  prog: AnalyzedProgram,
  scope: LexScope,
  branchLabel: string,
): TupleBranchValueResult {
  if (last.kind === "ExprStmt") return resolveTupleValueBranch(last.expr, arity, prog, scope, branchLabel);
  if (last.kind === "IfStmt") return analyzeIfTupleValue(last, arity, prog, scope);
  if (last.kind === "SwitchStmt") return analyzeSwitchTupleValue(last, arity, prog, scope);
  analyzeStmt(last, prog, scope);
  return {
    ok: false,
    elemKinds: new Array(arity).fill(null),
    elemContainerKinds: new Array(arity).fill(null),
    elemContainerConflicts: new Array(arity).fill(false),
  };
}

function analyzeBlock(
  body: Stmt[],
  prog: AnalyzedProgram,
  parentScope: LexScope,
  kind: ScopePushKind,
  inLoop?: boolean,
): void {
  const blockScope = pushScope(parentScope, kind, inLoop ?? parentScope.inLoop);
  for (const stmt of body) analyzeStmt(stmt, prog, blockScope);
}

export function analyzeExpr(expr: Expr, prog: AnalyzedProgram, scope: LexScope, topLevel: boolean): void {
  switch (expr.kind) {
    case "NumberLiteral":
    case "StringLiteral":
    case "BoolLiteral":
    case "NaLiteral":
    case "ColorLiteral":
      return;
    case "Identifier": {
      const name = expr.name;
      // C728: 이 읽기가 중첩 top-level var(depth>0)를 가리키면 codegen이 scope 정보 없이도
      // 정확한 물리 슬롯을 찾도록 이 Identifier 노드 자신에 슬롯을 기록해둔다(LexScope.
      // nestedVarDeclStmts 주석 참조) — scope.names에 이미 등록돼(analyzeVarDecl) 아래
      // scopeHasLocal도 true를 내지만, 그것만으로는 codegen이 "어느 슬롯"인지 알 수 없다.
      const nestedKind = resolveNestedVarOrEqLocalKind(scope, name);
      if (nestedKind?.kind === "var") {
        prog.nestedVarReadSlots.set(expr, prog.nestedVarDeclSlots.get(nestedKind.decl)!);
        return;
      }
      // C729: 이 이름이 var이면서 그보다 가까운 '=' 섀도(nestedKind.kind==="eq-local")가 있으면
      // codegen이 program.varIndex를 건너뛰도록 표시(eqLocalShadowedVarReads 주석 참조) — flat var가
      // 아니면(순수 eq-local끼리의 섀도) 표시 없이도 이미 정확하다.
      if (nestedKind?.kind === "eq-local") {
        if (prog.varIndex.has(name)) prog.eqLocalShadowedVarReads.add(expr);
        return;
      }
      if (
        BAR_SERIES_NAMES.has(name) ||
        DERIVED_PRICE_NAMES.has(name) ||
        name === BAR_INDEX_NAME ||
        TIME_VAR_NAMES.has(name) ||
        BID_ASK_NAMES.has(name) ||
        prog.varIndex.has(name) ||
        (scope.func !== null && scope.func.localVarIndex.has(name)) ||
        scopeHasLocal(scope, name)
      ) {
        return;
      }
      prog.errors.push(`알 수 없는 식별자: '${name}' (L${expr.line}:${expr.col})`);
      return;
    }
    case "UnaryOp":
      analyzeExpr(expr.operand, prog, scope, false);
      return;
    case "BinOp":
      analyzeExpr(expr.left, prog, scope, false);
      if (expr.op === "and" || expr.op === "or") {
        // 우변은 좌변이 이미 결과를 결정하면 평가되지 않는 단락(lazy) 위치. TV v5는 and/or
        // 양변을 항상 평가하므로(C24) C66부터 codegen이 이 위치 아래의 stateful 콜을 문장 직전
        // 임시변수로 eager 호이스팅해 허용한다(hoistLazyStatefulCalls — kind:"lazy-expr"는
        // firstForbiddenKind에서 cond-body와 동일 취급, 체인의 condition/loop-body/udf-body는
        // 여전히 거부). 값 결합은 JS '&&'/'||' 그대로 — 호이스팅된 임시변수는 이미 평가가 끝난
        // 뒤라 단락 평가가 값에만 적용되고 상태 전진에는 영향을 주지 않는다.
        const rightScope = pushScope(scope, "lazy-expr");
        analyzeExpr(expr.right, prog, rightScope, false);
      } else {
        analyzeExpr(expr.right, prog, scope, false);
      }
      if (expr.op === "/" && inferNumType(expr.left, prog) === "int" && inferNumType(expr.right, prog) === "int") {
        prog.idivBinOps.add(expr);
      }
      if (expr.op === "+" && (isStringExpr(expr.left) || isStringExpr(expr.right))) {
        prog.concatBinOps.add(expr);
      }
      return;
    case "TernaryOp": {
      // 삼항의 두 분기는 조건에 따라 하나만 실행되는 lazy 위치 — and/or 우변과 동일하게
      // kind:"lazy-expr"로 태그하고 C66부터 codegen eager 호이스팅으로 허용한다(위 and/or 주석
      // 참조). 조건은 삼항이 평가될 때 항상 평가되므로 태그 없이 현재 scope 그대로.
      analyzeExpr(expr.condition, prog, scope, false);
      const trueScope = pushScope(scope, "lazy-expr");
      analyzeExpr(expr.trueExpr, prog, trueScope, false);
      const falseScope = pushScope(scope, "lazy-expr");
      analyzeExpr(expr.falseExpr, prog, falseScope, false);
      return;
    }
    case "DotAccess": {
      // math.pi/e/phi/rphi(C72) — 인자 없는 네임스페이스 상수라 CallExpr 경로가 아예 안 맞는다.
      // analyzer가 여기서 리터럴 값으로 접어 builtinConstants에 등록하면 codegen은 rt 조회 없이
      // 숫자 리터럴을 직접 방출한다(GOAL.md "bar loop 안 할당 제로"에 런타임 콜보다 더 부합).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "math" && MATH_CONSTANTS.has(expr.attr)) {
        prog.builtinConstants.set(expr, MATH_CONSTANTS.get(expr.attr)!);
        return;
      }
      // dayofweek.sunday~saturday(C497) — math 상수와 동일한 컴파일타임 폴딩(builtinConstants
      // 재사용, 값 타입도 number로 동일).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "dayofweek" && DAYOFWEEK_CONSTANTS.has(expr.attr)) {
        prog.builtinConstants.set(expr, DAYOFWEEK_CONSTANTS.get(expr.attr)!);
        return;
      }
      // color.* 상수 17종(C78) — math 상수와 동일한 컴파일타임 폴딩이지만 값이 string이라
      // builtinStringConstants(병렬 맵)에 등록.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "color" && COLOR_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, COLOR_CONSTANTS.get(expr.attr)!);
        return;
      }
      // order.ascending/descending(C85) — math/color 상수와 동일한 컴파일타임 폴딩이지만 값이
      // boolean이라 builtinBooleanConstants(세 번째 병렬 맵)에 등록.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "order" && ORDER_CONSTANTS.has(expr.attr)) {
        prog.builtinBooleanConstants.set(expr, ORDER_CONSTANTS.get(expr.attr)!);
        return;
      }
      // barmerge.gaps_on/gaps_off/lookahead_on/lookahead_off(C177, request.security 둘째 슬라이스
      // gaps=/lookahead= kwargs 값) — order.ascending/descending과 동일한 컴파일타임 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "barmerge" && BARMERGE_CONSTANTS.has(expr.attr)) {
        prog.builtinBooleanConstants.set(expr, BARMERGE_CONSTANTS.get(expr.attr)!);
        return;
      }
      // alert.freq_*/shape.*/location.*/hline.style_*(C208) — order.ascending/descending과 동일한
      // 컴파일타임 문자열 폴딩(builtinStringConstants 재사용). 값은 noopStmtCalls 소비처가 전부
      // discard하므로 실제로 codegen에 실리지는 않는다 — 이 분기의 유일한 역할은 아래 최종
      // "네임스페이스 접근은 호출식만 지원" 에러로 떨어지지 않게 막는 것.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "alert" && ALERT_FREQ_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, ALERT_FREQ_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "shape" && SHAPE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, SHAPE_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "location" && LOCATION_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, LOCATION_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "hline" && HLINE_STYLE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, HLINE_STYLE_CONSTANTS.get(expr.attr)!);
        return;
      }
      // adjustment.*/backadjustment.*(C615) — ticker.modify() session=/adjustment=/backadjustment=
      // 값, hline.style_*와 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "adjustment" && ADJUSTMENT_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, ADJUSTMENT_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "backadjustment" && BACKADJUSTMENT_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, BACKADJUSTMENT_CONSTANTS.get(expr.attr)!);
        return;
      }
      // plot.style_*/display.*(C254) — hline.style_*와 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "plot" && PLOT_STYLE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, PLOT_STYLE_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "plot" && PLOT_LINESTYLE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, PLOT_LINESTYLE_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "display" && DISPLAY_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, DISPLAY_CONSTANTS.get(expr.attr)!);
        return;
      }
      // label.style_*/line.style_*/size.*/position.*/extend.*/xloc.*/yloc.*/text.align_*·wrap_*
      // (신규, 드로잉 객체 kwarg 상수) — alert/shape/location/hline과 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "label" && LABEL_STYLE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, LABEL_STYLE_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "line" && LINE_STYLE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, LINE_STYLE_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "size" && SIZE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, SIZE_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "position" && POSITION_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, POSITION_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "extend" && EXTEND_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, EXTEND_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "xloc" && XLOC_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, XLOC_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "yloc" && YLOC_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, YLOC_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "text" && TEXT_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, TEXT_CONSTANTS.get(expr.attr)!);
        return;
      }
      // font.*(C335) — text와 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "font" && FONT_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, FONT_CONSTANTS.get(expr.attr)!);
        return;
      }
      // label.all/line.all/box.all/table.all/polyline.all/linefill.all(C244, ROADMAP P3 next_hint
      // 1순위) — pine2py IDENTIFIER_MAP이 6종 전부 "[]"로 접는 값 위치 상수(constructors.ts
      // isDrawingAllConstant 주석 참조). 값이 리터럴 배열이라 builtinStringConstants가 아니라
      // 전용 병렬 맵(builtinArrayConstants)에 등록 — codegen이 JSON.stringify 없이 "[]"를 그대로 방출.
      if (expr.obj.kind === "Identifier" && expr.attr === "all" && DRAWING_ALL_NAMESPACES.has(expr.obj.name)) {
        prog.builtinArrayConstants.add(expr);
        return;
      }
      // dividends.gross/net · splits.numerator/denominator(신규) — alert/shape 등과 동일한
      // 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "dividends" && DIVIDENDS_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, DIVIDENDS_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "splits" && SPLITS_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, SPLITS_CONSTANTS.get(expr.attr)!);
        return;
      }
      // earnings.actual/estimate/standardized(C397) — dividends/splits와 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "earnings" && EARNINGS_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, EARNINGS_CONSTANTS.get(expr.attr)!);
        return;
      }
      // earnings.future_eps/future_period_end_time/future_revenue/future_time(C482) — bare 변수형
      // series 숫자값이라 syminfo.shares_outstanding_float(C391)과 동일하게 builtinConstants(number)에
      // 등록(EARNINGS_CONSTANTS의 string 폴딩과는 별개 맵).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "earnings" && EARNINGS_NUMBER_PROPS.has(expr.attr)) {
        prog.builtinConstants.set(expr, EARNINGS_NUMBER_PROPS.get(expr.attr)!);
        return;
      }
      // currency.*/format.*(C284) — dividends/splits와 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "currency" && CURRENCY_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, CURRENCY_CONSTANTS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "format" && FORMAT_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, FORMAT_CONSTANTS.get(expr.attr)!);
        return;
      }
      // scale.*(C286) — currency/format과 동일한 컴파일타임 문자열 폴딩.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "scale" && SCALE_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, SCALE_CONSTANTS.get(expr.attr)!);
        return;
      }
      // syminfo.*(14종, ROADMAP P2 두 번째 슬라이스) — math/color 상수와 동일한 컴파일타임 폴딩.
      // 문자열/숫자 두 갈래라 기존 builtinConstants(number)/builtinStringConstants(string) 두
      // 맵에 값 타입별로 나눠 등록(barstate/session의 builtinRuntimeExprs와 달리 새 병렬 맵
      // 불필요 — 위 SYMINFO_STRING_PROPS/SYMINFO_NUMBER_PROPS 주석 참조).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "syminfo" && SYMINFO_STRING_PROPS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, SYMINFO_STRING_PROPS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "syminfo" && SYMINFO_NUMBER_PROPS.has(expr.attr)) {
        prog.builtinConstants.set(expr, SYMINFO_NUMBER_PROPS.get(expr.attr)!);
        return;
      }
      // barstate.*/session.*(ROADMAP P2 첫 슬라이스) — math/color/order와 같은 bare 네임스페이스
      // DotAccess 구문이지만 값이 컴파일타임 상수가 아니라 $.idx/$.barCount에 의존하는 런타임 식이라
      // 리터럴이 아닌 JS 식 문자열을 builtinRuntimeExprs에 등록(위 BARSTATE_PROPS/SESSION_PROPS 주석 참조).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "barstate" && BARSTATE_PROPS.has(expr.attr)) {
        prog.builtinRuntimeExprs.set(expr, BARSTATE_PROPS.get(expr.attr)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "session" && SESSION_PROPS.has(expr.attr)) {
        prog.builtinRuntimeExprs.set(expr, SESSION_PROPS.get(expr.attr)!);
        return;
      }
      // session.regular/extended(C286) — 위 SESSION_PROPS(런타임 bool)와 달리 고정 문자열이라
      // 별도 맵(SESSION_STRING_CONSTANTS)에서 컴파일타임 폴딩(currency/format과 동일 패턴).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "session" && SESSION_STRING_CONSTANTS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, SESSION_STRING_CONSTANTS.get(expr.attr)!);
        return;
      }
      // chart.*(C287) — 헤드리스 배치 리플레이 설계 결정(상단 CHART_* 4개 맵 주석 참조, 오라클
      // 불가·hand-verified). 색상 2종은 문자열 폴딩, left_visible_bar_index는 숫자 폴딩,
      // left/right_visible_bar_time은 데이터 의존 런타임 식(barstate 패턴), is_* 7종은 C239 호출형
      // 하드코딩 값의 bare 변수형 boolean 폴딩. 그 외 chart.*(chart.point 포함 — 콜식 전용
      // 네임스페이스라 값 위치에 못 옴)는 아래 최종 에러로 자연 낙하해 기존과 동일하게 거부.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "chart") {
        if (CHART_COLOR_CONSTANTS.has(expr.attr)) {
          prog.builtinStringConstants.set(expr, CHART_COLOR_CONSTANTS.get(expr.attr)!);
          return;
        }
        if (CHART_NUMBER_CONSTANTS.has(expr.attr)) {
          prog.builtinConstants.set(expr, CHART_NUMBER_CONSTANTS.get(expr.attr)!);
          return;
        }
        if (CHART_RUNTIME_PROPS.has(expr.attr)) {
          prog.builtinRuntimeExprs.set(expr, CHART_RUNTIME_PROPS.get(expr.attr)!);
          return;
        }
        if (CHART_IS_BOOLEAN_PROPS.has(expr.attr)) {
          prog.builtinBooleanConstants.set(expr, CHART_IS_BOOLEAN_PROPS.get(expr.attr)!);
          return;
        }
      }
      // timeframe.*(9종+main_period, ROADMAP P2 세 번째(마지막) 슬라이스) — syminfo와 동일한
      // 컴파일타임 폴딩. 문자열/숫자/불리언 세 갈래라 builtinStringConstants/builtinConstants/
      // builtinBooleanConstants 세 맵에 값 타입별로 나눠 등록(barstate/session의 builtinRuntimeExprs와
      // 달리 새 병렬 맵 불필요 — 위 TIMEFRAME_*_PROPS 주석 참조). 값 자체는 배치30 (1)부터
      // prog.chartTf 기반 timeframe*PropValue()로 계산(.has()는 여전히 정적 맵의 키 집합만 확인).
      if (expr.obj.kind === "Identifier" && expr.obj.name === "timeframe" && TIMEFRAME_STRING_PROPS.has(expr.attr)) {
        prog.builtinStringConstants.set(expr, timeframeStringPropValue(expr.attr, prog.chartTf)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "timeframe" && TIMEFRAME_NUMBER_PROPS.has(expr.attr)) {
        prog.builtinConstants.set(expr, timeframeNumberPropValue(expr.attr, prog.chartTf)!);
        return;
      }
      if (expr.obj.kind === "Identifier" && expr.obj.name === "timeframe" && TIMEFRAME_BOOLEAN_PROPS.has(expr.attr)) {
        prog.builtinBooleanConstants.set(expr, timeframeBooleanPropValue(expr.attr, prog.chartTf)!);
        return;
      }
      // strategy.* 속성(C163 첫 슬라이스, C164에서 short 해제, C165에서 계좌 속성 10종 추가,
      // C172에서 max_drawdown 추가) — long/short는 방향 상수(string "long"/"short", 컴파일타임
      // 폴딩), 나머지는 바마다 바뀌는 브로커 상태라 barstate.*와 동일한 builtinRuntimeExprs 패턴
      // (STRATEGY_RUNTIME_PROPS 주석 참조). 전부 strategy() 지시어 선행 필수(TV: declaration
      // statement 필수). 그 외 속성(report류)은 여전히 명시적으로 거부 — comment 실소비(C173)는
      // 이 프로퍼티 폴딩이 아니라 `strategy.closedtrades.entry_comment/exit_comment(index)`
      // 3-level 콜 체인(call-expr.ts 별도 분기)과 entry/order/exit/close/close_all의 comment=
      // kwargs로 이뤄진다.
      if (expr.obj.kind === "Identifier" && expr.obj.name === "strategy") {
        // C771(wild 실측, tv_verdict accept 7건 이상/reject 반례 0 — 전량 무관한 별개 원인):
        // `indicator()` 스크립트가 strategy() 선언 없이 strategy.* 프로퍼티/상수를 읽거나
        // (심지어 strategy.entry/exit 호출까지) TV가 그대로 컴파일 수용한다(wild
        // 34144f307dda.pine 등). 이전 "strategy() 선언 선행 필수" 게이트는 pine2py에도 대응
        // 근거가 없는(codegen.py 순수 리터럴 매핑, 게이트 없음) pine2js 자체 추가 제약이었다 —
        // 제거. Context.strategy는 isStrategy 무관하게 항상 생성되므로(context.ts) 런타임은
        // 변경 불필요.
        if (expr.attr === "long") {
          prog.builtinStringConstants.set(expr, "long");
          return;
        }
        if (expr.attr === "short") {
          prog.builtinStringConstants.set(expr, "short");
          return;
        }
        // default_qty_type용 수량 방식 상수 3종(C171) — long/short와 동일한 컴파일타임 문자열
        // 폴딩(TV에서도 const string — pine2py constants.py FIXED/CASH/PERCENT_OF_EQUITY 동형
        // 문자열 값). 지시어 인자 밖 일반 식 위치에서도 문자열 상수로 동작한다(TV 정합 추정).
        // cash 거부는 상수 자체가 아니라 default_qty_type **값으로 쓰였을 때**(call-expr.ts 지시어
        // 분기)에만 건다 — 상수와 소비처의 지원 여부는 별개 축.
        if (expr.attr === "fixed" || expr.attr === "cash" || expr.attr === "percent_of_equity") {
          prog.builtinStringConstants.set(expr, expr.attr);
          return;
        }
        // account_currency(C332) — strategy()의 currency= kwarg에서 캡처한 컴파일타임 문자열
        // (위 AnalyzedProgram.strategyCurrency 주석 참조). long/short/fixed와 동일한 폴딩 경로.
        if (expr.attr === "account_currency") {
          prog.builtinStringConstants.set(expr, prog.strategyCurrency);
          return;
        }
        const strategyRuntimeExpr = STRATEGY_RUNTIME_PROPS.get(expr.attr);
        if (strategyRuntimeExpr !== undefined) {
          prog.builtinRuntimeExprs.set(expr, strategyRuntimeExpr);
          return;
        }
        prog.errors.push(
          `지원하지 않는 strategy 속성: 'strategy.${expr.attr}' — long/short/fixed/cash/percent_of_equity/account_currency 상수와 position_size/position_avg_price/position_entry_name/netprofit/openprofit/equity/initial_capital/closedtrades/opentrades/wintrades/losstrades/grossprofit/grossloss/max_drawdown/max_drawdown_percent/max_runup/max_runup_percent/default_qty_value/netprofit_percent/openprofit_percent/eventrades/avg_winning_trade/avg_losing_trade/avg_winning_trade_percent/avg_losing_trade_percent/max_contracts_held_all/max_contracts_held_long/max_contracts_held_short만 지원 (L${expr.line}:${expr.col})`,
        );
        return;
      }
      // strategy.commission.*(C288, 2단 중첩 네임스페이스) — 위 strategy.* 단일 레벨 분기와 달리
      // expr.obj 자체가 DotAccess(strategy.commission)라 별도 분기 필요(STRATEGY_COMMISSION_CONSTANTS
      // 주석 참조). 매치 안 되면(strategy.oca.* 등 다른 조합) 아래 UDT 체이닝 재귀가
      // expr.obj(strategy.X)를 analyzeExpr해 위 단일 레벨 분기의 "지원하지 않는 strategy 속성"
      // 에러로 자연 낙하 — 기존 거부 그대로 유지(strategy.oca는 의도적 스킵, 위 주석 참조).
      if (
        expr.obj.kind === "DotAccess" &&
        expr.obj.obj.kind === "Identifier" &&
        expr.obj.obj.name === "strategy" &&
        expr.obj.attr === "commission"
      ) {
        // C771 — strategy.* 전반과 동일하게 선행 선언 불필요(위 단일 레벨 분기 주석 참조).
        if (STRATEGY_COMMISSION_CONSTANTS.has(expr.attr)) {
          prog.builtinStringConstants.set(expr, STRATEGY_COMMISSION_CONSTANTS.get(expr.attr)!);
          return;
        }
      }
      // strategy.direction.*(C309) — commission과 동일한 2단 중첩 분기, strategy.risk.allow_entry_in
      // 호출의 인자 위치뿐 아니라 일반 식 위치(변수 대입/삼항)에서도 컴파일타임 문자열로 접힌다
      // (wild 실측: `direction == 0 ? strategy.direction.all : ...`처럼 런타임 삼항 안에 섞여 쓰임 —
      // 이 폴딩이 있어야 그 삼항 자체가 유효한 문자열 식이 된다).
      if (
        expr.obj.kind === "DotAccess" &&
        expr.obj.obj.kind === "Identifier" &&
        expr.obj.obj.name === "strategy" &&
        expr.obj.attr === "direction"
      ) {
        // C771 — strategy.* 전반과 동일하게 선행 선언 불필요.
        if (STRATEGY_DIRECTION_CONSTANTS.has(expr.attr)) {
          prog.builtinStringConstants.set(expr, STRATEGY_DIRECTION_CONSTANTS.get(expr.attr)!);
          return;
        }
      }
      // enum 멤버 접근(Direction.long) — math/color/order 상수와 동일한 컴파일타임 폴딩
      // (builtinStringConstants 재사용): "EnumName.MemberName" qualified 문자열로 접어, 서로 다른
      // enum의 동명 멤버가 pine2py의 method flat-namespace 버그(LIMITATIONS.md 참조)와 달리 항상
      // 구분되게 한다 — 새 런타임 표현이나 codegen 분기가 전혀 필요 없다(color.* 패턴 그대로).
      if (expr.obj.kind === "Identifier" && prog.enumTypes.has(expr.obj.name)) {
        const enumInfo = prog.enumTypes.get(expr.obj.name)!;
        if (!enumInfo.members.includes(expr.attr)) {
          prog.errors.push(`'${expr.obj.name}'에 없는 enum 멤버: '${expr.attr}' (L${expr.line}:${expr.col})`);
          return;
        }
        prog.builtinStringConstants.set(expr, `${expr.obj.name}.${expr.attr}`);
        return;
      }
      // UDT 필드 읽기: obj가 var/​'=' 로컬로 추적된 UDT 인스턴스(단일 레벨, udtVarTypes/udtKindHints
      // 스코프 체인, C224)이거나 그 자체가 이미 UDT 필드 접근으로 확정된 DotAccess(중첩 체이닝,
      // C123 — outer.inner.x)이거나 array<UDT>에서 원소 하나를 꺼내는 CallExpr(C390, `sequence.
      // first().dir`류 — call-expr.ts의 resolveUdtMethodReceiverType(C354, method 호출 수신자
      // 판별용)과 동일한 resolveUdtObjectType ?? resolveArrayGetElemUdtType 조합을 필드 읽기
      // 소비처에도 적용, 세 번째 소비처)일 때만. obj가 DotAccess/CallExpr/IndexAccess면 먼저 재귀
      // analyzeExpr로 그 자신을 분석해야(CallExpr은 codegen 디스패치 등록, DotAccess는
      // resolveUdtObjectType이 udtFieldAccessTypes에서 찾아낼 수 있게, IndexAccess는 C637
      // `(recv[N]).field`류 — 히스토리 슬롯 배정 자체가 analyzeIndexAccess에서 일어나므로 여길
      // 거치지 않으면 codegen이 슬롯을 못 찾는다).
      if (expr.obj.kind === "DotAccess" || expr.obj.kind === "CallExpr" || expr.obj.kind === "IndexAccess") {
        analyzeExpr(expr.obj, prog, scope, false);
      } else if (expr.obj.kind === "Identifier") {
        // C728: UDT 필드 읽기의 Identifier receiver도 analyzeExpr을 안 타는 동일한 사각지대라
        // (analyzeCallExpr 꼬리 재귀 주석 참조) 중첩 top-level var(depth>0)에 담긴 UDT 인스턴스
        // 필드 접근(`previousHighPoint.openTime`류)이 codegen에서 슬롯을 못 찾았다.
        const nestedKind = resolveNestedVarOrEqLocalKind(scope, expr.obj.name);
        if (nestedKind?.kind === "var") {
          prog.nestedVarReadSlots.set(expr.obj, prog.nestedVarDeclSlots.get(nestedKind.decl)!);
        } else if (nestedKind?.kind === "eq-local" && prog.varIndex.has(expr.obj.name)) {
          // C729: Identifier read 분기와 동일한 var-섀도 표시(위 Identifier case 주석 참조).
          prog.eqLocalShadowedVarReads.add(expr.obj);
        }
      }
      let objTypeName = resolveUdtObjectType(expr.obj, prog, scope);
      if (objTypeName === undefined && expr.obj.kind === "CallExpr") {
        // array<UDT>/matrix<UDT> 원소 추출(resolveArrayGetElemUdtType) 외에, bare UDF 호출 자체가
        // UDT를 반환하는 형태(C638, wild "네임스페이스 접근은 호출식만 지원" objKind=CallExpr 축 —
        // `get_recent_gap().pivot_upper`류, 중간 변수 없이 UDF 콜에 바로 필드 체이닝)도 인정한다.
        // isUdtConstructorCall은 call-expr.ts의 resolveUdtMethodReceiverType(C632, method-chain
        // 수신자 판별)이 이미 CallExpr 수신자에 합성해 쓰는 동일한 두 헬퍼 조합 — 여기서도 그대로
        // 재사용(신규 판별 로직 없음).
        objTypeName = resolveArrayGetElemUdtType(expr.obj, prog, scope) ?? isUdtConstructorCall(expr.obj, prog, scope) ?? undefined;
        // codegen은 scope 체인 없이 이 노드만 보고 재판별해야 하므로(C224), CallExpr obj 자신을
        // udtFieldAccessTypes에 캐싱해둔다 — codegen.ts의 독립 사본 resolveUdtObjectType이
        // DotAccess와 동일하게 이 맵만 조회하도록 obj.kind==="CallExpr" 분기를 나란히 추가했다.
        if (objTypeName !== undefined) prog.udtFieldAccessTypes.set(expr.obj, objTypeName);
      }
      if (objTypeName !== undefined) {
        // chart.point는 prog.udtTypes에 등록된 UDT가 아니라(UDT 필드/매개변수 typeHint로만 쓰이는
        // 특수 값 타입, C486) typeInfo.fields 조회가 성립하지 않는다 -- 스칼라 필드 3종(time/index/
        // price, CHART_POINT_FIELDS)으로 직접 검증하고 항상 여기서 체이닝을 끝낸다(chart.point 필드는
        // 전부 number|null이라 더 이상 체이닝될 수 없음, LIMITATIONS.md C486 잔여 항목 해소).
        if (objTypeName === CHART_POINT_FIELD_TYPE) {
          if (!CHART_POINT_FIELDS.has(expr.attr)) {
            prog.errors.push(`'chart.point'에 없는 필드: '${expr.attr}' (L${expr.line}:${expr.col})`);
          }
          return;
        }
        const typeInfo = prog.udtTypes.get(objTypeName)!;
        const field = typeInfo.fields.find((f) => f.name === expr.attr);
        if (field === undefined) {
          prog.errors.push(`'${objTypeName}'에 없는 필드: '${expr.attr}' (L${expr.line}:${expr.col})`);
          return;
        }
        // 필드 자체가 다시 UDT 타입이거나 chart.point(C486, 중첩 chart.point 필드 -- `pivot.end.price`류
        // 체이닝 지원)면 이 DotAccess를 "그 타입으로 확정됨"으로 등록해 부모 DotAccess(예:
        // outer.inner.x의 outer.inner)가 한 단계 더 체이닝할 수 있게 한다 — 그 외 스칼라 필드면
        // 등록하지 않아 체이닝이 자연히 여기서 멈춘다(`outer.price.foo` 같은 잘못된 체이닝은
        // objTypeName이 undefined가 되어 아래 최종 에러로 거부됨).
        if (prog.udtTypes.has(field.typeHint) || field.typeHint === CHART_POINT_FIELD_TYPE) {
          prog.udtFieldAccessTypes.set(expr, field.typeHint);
        }
        return;
      }
      prog.errors.push(
        `네임스페이스 접근은 호출식만 지원 (예: ta.sma(...)): '${describeDotAccess(expr)}' (L${expr.line}:${expr.col})`,
      );
      return;
    }
    case "IndexAccess":
      analyzeIndexAccess(expr, prog, scope);
      return;
    case "CallExpr":
      analyzeCallExpr(expr, prog, scope, topLevel);
      return;
    case "TupleExpr":
      // 값 위치의 튜플 리터럴은 지원하지 않는다 — 허용 위치는 (1) UDF 본문의 마지막 문장(튜플
      // 반환, analyzeFuncDecl이 이 함수를 거치지 않고 각 원소를 직접 analyzeExpr) (2) 문장
      // 위치(값 폐기, C610 — analyzeStmt ExprStmt 분기가 원소별로 직접 분석) (3) TupleDestructure
      // 자신의 값(`[a,b] = [e1,e2]`, C631 — analyzeTupleDestructure가 resolveTupleValueBranch로
      // 이 함수를 거치지 않고 원소별 직접 analyzeExpr)뿐이다. 여기 도달 = Assignment/VarDecl
      // 우변(스칼라 변수에 튜플 대입)·콜 인자 등 값이 소비되는 위치 — TV도 거부하는 폼(배치32(2)).
      prog.errors.push(`튜플 리터럴은 함수의 마지막 문장(튜플 반환)에서만 지원 (L${expr.line}:${expr.col})`);
      return;
    case "IfStmt":
    case "ForStmt":
    case "WhileStmt":
    case "SwitchStmt":
      // 제어문-식의 유일하게 허용되는 위치(VarDecl/Assignment의 값)는 analyzeControlFlowOrExpr가
      // 이 함수를 거치지 않고 analyzeIfStmt/analyzeForStmt/analyzeWhileStmt/analyzeSwitchStmt로
      // 직접 보낸다 — TupleExpr와 동일한 "파서는 넓게, analyzer가 좁힌다" 패턴.
      prog.errors.push(
        `제어문-식(if/for/while/switch)은 'var' 선언 또는 대입문의 값 위치에서만 지원 (L${expr.line}:${expr.col})`,
      );
      return;
  }
}

// describeDotAccess/resolveUdtObjectType/literalOffsetValue/analyzeIndexAccess(DotAccess/IndexAccess
// 분석 유틸 전체) + INPUT_PARAM_NAMES/analyzeInputCall/analyzeCallExpr/analyzeUserFuncCall(호출식
// 분석 전체, C146)은 각각 analyzer/index-access.ts(C147)/analyzer/call-expr.ts로 이전.

