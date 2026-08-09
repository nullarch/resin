// ta.*/math.sum/math.random/fixnan(bare) 등 상태 있는(stateful) 빌트인 콜의 TA_REGISTRY 테이블 +
// dispatch 함수(analyzeStatefulCall) — analyzer.ts에서 분리(ROADMAP "컬렉션 네임스페이스
// 레지스트리화 + analyzer.ts 분할", collections.ts(C137~C141)에 이은 analyzer.ts 파일 분할 두 번째
// 슬라이스). 순수 이동만 수행 — 신규 검증 로직 없음. firstForbiddenKind/FORBIDDEN_KIND_DESC는
// analyzeStatefulCall의 유일한 소비처라 함께 이전했다(analyzer.ts에는 다른 호출부가 없음, grep으로
// 확인). LexScope/ScopePushKind는 analyzer.ts 전역에서 널리 쓰여 그대로 두고 타입만 export해 여기서
// import한다.

import type { CallExpr, Expr } from "../ast";
import type { AnalyzedProgram, LexScope, ScopePushKind } from "../analyzer";
import { inferQualifier } from "../analyzer";
import { isHarmlessArgDup } from "./arg-dup";

// stateful 콜(ta.*/fixnan) 거부 판정: 스코프 체인을 루트까지 걸어 cond-body(if 분기 본문/switch
// case 본문 — C64/C65부터 per-call 전진 허용), lazy-expr(삼항/and·or lazy 위치 — C66부터 codegen
// eager 호이스팅으로 허용), loop-body(for/while 본문 — C161부터 per-call 전진 허용: 반복마다 같은
// 콜사이트 상태가 1회씩 전진, pine2py가 루프를 Python 루프로 직결 트랜스파일 + state_key가 정적
// 콜사이트 카운터라 동형임을 oracle/cases/cond_loop_ta.pine 골든으로 수치 확정), udf-body
// (UDF/method 본문 — C162부터 허용: 콜은 함수-상대 슬롯을 받고 콜사이트별 __taBase 전파로 상태가
// 분리되므로 "몇 번 호출될지 바마다 다르다"는 위험이 per-call 모델 + 콜사이트 독립으로 해소됨,
// analyzer.ts ScopePushKind 주석 참조) 이외의 kind가 하나라도 있으면 그 kind를 반환(거부), 전부
// 허용 kind(또는 루트)면 null(허용). C246부터 최초 if 조건은 kind:"condition"이 아예 push되지
// 않으므로(analyzer.ts analyzeIfStmt) 이 함수에 도달하지 않는다 — condition으로 남는 위치는 elif
// 조건/switch case 값/while 조건뿐(무조건 1회가 아니라 진짜 short-circuit/반복 체인).
// C260: 그 condition 위치 안에서도 **직접 호출**(콜과 그 condition scope 사이에 lazy-expr이 없는
// 경우 — and/or 좌변, 산술/비교 등 non-lazy 합성은 전부 해당)은 이제 허용한다. codegen(genIfStmt의
// elif/genWhileStmt/genSwitchStmt)이 elif 조건·while 조건·case 값을 항상 JS 네이티브 `else if`/
// `while`/`else if`로 그 자리에 그대로 인라인하므로(호이스팅 없이 genExpr 그대로), 그 안의 직접
// 호출은 JS 자체의 단락 평가가 pine2py의 네이티브 elif/switch-if/while 체인과 정확히 동형이다
// (그 조건에 도달했을 때만, 도달한 그 순간 정확히 1회 평가 — cond-body/loop-body와 같은 급의
// per-call). 반대로 and/or **우변**(lazy-expr)에 놓인 호출은 여전히 거부한다 — codegen이 elif/
// switch case/while 조건 앞에는 lazy 호이스팅 프리루드를 붙이지 않아(hoistLazyStatefulCalls 호출부
// 자체가 없음, codegen.ts 주석 참조) 우변에 두면 "매치 안 하면 평가 안 함"을 지키면서 상태가
// 조용히 전진을 건너뛰는데, 문장 직전으로 eager 호이스팅하면 반대로 "항상 평가"가 돼 short-circuit
// 자체가 깨진다 — 두 시맨틱을 동시에 만족할 방법이 없어 범위 밖으로 유지(LIMITATIONS.md 참조).
// 그래서 여기선 "condition에 도달하기 전에 lazy-expr을 먼저 지나왔는가"만 추적하면 충분하다 —
// lazy-expr을 하나라도 거치고 condition에 도달하면 거부, 거치지 않고 도달하면 허용. condition을
// 아예 못 만나면(체인이 조건부 위치 밖) 기존과 동일하게 항상 허용(null).
function firstForbiddenKind(scope: LexScope): ScopePushKind | null {
  let passedLazyExpr = false;
  for (let s: LexScope | null = scope; s !== null; s = s.parent) {
    if (s.kind === "lazy-expr") {
      passedLazyExpr = true;
    } else if (s.kind === "condition") {
      return passedLazyExpr ? s.kind : null;
    }
  }
  return null;
}

// 거부 에러 메시지용 위치 설명(analyzeStatefulCall). cond-body/loop-body/udf-body는
// firstForbiddenKind가 반환하지 않지만(허용 kind) Record 완전성을 위해 포함.
const FORBIDDEN_KIND_DESC: Record<ScopePushKind, string> = {
  "cond-body": "if 분기 본문/switch case 본문",
  condition:
    "조건식의 and/or lazy 분기(short-circuit 평가 위치 — elif 조건/switch case 값/while 조건 안의 and/or 우변. 직접 호출은 C260부터 허용, 최초 if 조건은 C246부터 허용)",
  "loop-body": "반복문 본문(C161부터 허용 — 도달 불가)",
  "lazy-expr": "삼항/and/or의 lazy 분기(C66부터 허용 — 도달 불가)",
  "udf-body": "UDF 본문(C162부터 허용 — 도달 불가)",
};

// 상태 있는(stateful) TA/빌트인 콜 하나의 전체 시맨틱을 표 하나로 기술한다(ROADMAP P2-0 "TA 디스패치
// 레지스트리화" — pine2py의 FUNC_MAP/TA_STATEFUL과 동일한 발상). 이전에는 함수 하나를 추가할 때마다
// analyzer에 else-if 분기 + 전용 Map 필드, codegen에 조회 분기를 각각 손으로 늘렸다(sma/ema/rsi/rma/
// crossover/crossunder/fixnan 7벌 반복 — MEMORY.md Architecture Decisions 참조). 이제는 이 표에
// 항목 하나만 추가하면 analyzeStatefulCall/genCallExpr가 자동으로 그 함수를 인식한다. dispatch:"ta"는
// `ta.<name>(...)` 네임스페이스 호출, dispatch:"bare"는 `<name>(...)`처럼 namespace 없는 최상위 호출
// (fixnan)을 가리킨다 — nz처럼 상태가 없는 bare 빌트인은 이 표에 넣지 않고 기존 builtinCalls 패턴을
// 그대로 쓴다(상태 유무가 두 메커니즘을 가르는 유일한 기준, MEMORY.md 참조). dispatch:"math"는
// `math.<name>(...)`이지만 math.round류(stateless)와 달리 고정폭 윈도우 상태가 필요한 함수(math.sum)
// — "ta"와 처리 로직은 완전히 동일하고 namespace 문자열만 다르다(analyzeCallExpr DotAccess 분기 참조).
export interface TaRegistryEntry {
  dispatch: "ta" | "bare" | "math";
  displayName: string; // 에러 메시지용 (예: "ta.sma", "fixnan")
  argCount: number; // 최대(=기본, minArgCount 생략 시 정확히 이 개수) 인자 개수
  // 선택 인자를 갖는 첫 사례(math.random, C120) — 생략하면 기존 전부와 동일하게 argCount와
  // 일치해야만 통과(정확히 N개). 지정하면 [minArgCount, argCount] 범위 허용 — 런타임 함수가 누락된
  // 나머지를 기본값 파라미터로 채운다(JS 기본 파라미터는 "누락"과 "명시적 undefined 전달" 둘 다에
  // 적용되므로 codegen이 중간 인자를 건너뛴 패딩에도 안전).
  minArgCount?: number;
  // minArgCount처럼 선택 인자를 갖지만 그 선택 인자가 **맨 앞**(source)인 경우(C250, ta.highest/
  // lowest) — pine2py highest.py/lowest.py가 런타임에 `isinstance(source,(int,float))`로 1-인자
  // 호출을 스니핑해 source=암묵 bar series로 재해석하는 것과 동형. pine2js는 컴파일타임에
  // expr.args.length로 이미 이 판정을 대신하므로(TA_REGISTRY는 정적 표), 이 플래그가 true면
  // analyzeStatefulCall이 source 생략 시(args.length === argCount - minArgCount) lengthArgIndex(es)를
  // 1칸씩 당겨서 검사한다(뒤 인자들이 전부 앞으로 밀리므로) — codegen도 별도로 같은 조건에서 암묵
  // source를 args 맨 앞에 unshift해야 함(genCallExpr 참조). 현재 1칸 시프트(정확히 source 하나만
  // 생략)만 지원 — 2칸 이상 생략하는 함수가 생기면 재검토.
  sourceOmittable?: boolean;
  // 이 함수가 키워드 인자(`ta.sma(source=x, length=y)`)를 지원하면, TV 공식 위치 인자 순서 그대로
  // 이름을 나열한다(C400, next_hint(C399) — wild kwarg blanket 잔여 재세분류 결과 ta.*(source=/
  // length=/source1=/source2=) kwarg가 24건으로 최대 서브클러스터, pine2py docs/pinescript/
  // 07-namespaces.md + wild corpus 실사용(scratch/c397_kwarg_blanket_v3.mjs) 대조로 확정한 이름 —
  // crossover/crossunder는 그 문서의 약식 "a, b"가 아니라 wild 3파일이 독립적으로 실사용한
  // "source1"/"source2"를 채택). 없으면(undefined) 이 함수는 kwargs 자체를 지원하지 않음(기존
  // 전부와 동일) — resolveTaKwargPositions/analyzeStatefulCall 참조. C283 큐레이션 원칙대로 wild
  // 실사용이 확인된 13종(sma/ema/rsi/highest/lowest/crossover/crossunder/change/cum/alma/pivotlow/
  // atr/pivothigh, C402가 마지막 둘 추가)에만 등재 — ta.vwap는 인자 개수별 반환 arity 오버로드
  // ([hard], C294)와 얽혀 이번 슬라이스 제외했었으나, C471이 vwap.kwargParamNames를 ["source"]
  // 단일 이름(wild 실사용 전량이 `ta.vwap(source=close)` 1-인자 폼)으로만 좁혀 그 축을 우회—
  // anchor/stdev_mult는 위치 인자로만 남아(kwarg 이름 미등재) resolvedArgs.length가 여전히
  // expr.args.length와 항상 일치, taCallReturnArity의 인자-개수 판별([hard] 우려 지점)이 그대로
  // 정확하다(TA_REGISTRY.vwap 주석 참조).
  kwargParamNames?: readonly string[];
  // series면 하드 에러를 낼 인자의 0-based 인덱스. 없으면 null, 두 개 이상(예: ta.tsi의
  // short_length/long_length처럼 고정폭 버퍼/초기화 구간을 함께 결정하는 인자가 여럿)이면 배열
  // (C49 — 지금까지는 전부 단일 length라 number만으로 충분했지만 tsi가 첫 다중 length 사례).
  lengthArgIndex: number | number[] | null;
  // true면 lengthArgIndex 위치가 series여도 하드 에러를 내지 않고 대신 codegen이 다른 rtPath(state에
  // 고정폭 버퍼를 굳히지 않는 변형, 예: highestVarLen)로 분기한다(배치25 (4), wild "length
  // 인자는 series일 수 없음" 클러스터 대상 — runtime/ta.ts highestVarLen 주석 참조). 현재
  // highest/lowest(C547)/sma(C548)/highestbars/lowestbars(C549)/median/linreg/wma(C550)/
  // stdev/sum(C551)/pivothigh/pivotlow(C552)/range/percentile_nearest_rank/
  // percentile_linear_interpolation(C553)만 해당 변형이 존재 — 다른 함수에 true를 놓으면
  // codegen의 VARLEN_RT_PATHS(codegen.ts genCallExpr)에
  // 대응 항목이 없어 컴파일 산출물이 존재하지 않는 런타임 함수를 참조하게 되니 반드시 그 표와
  // 런타임 변형 함수를 함께 추가할 것(linreg처럼 length 뒤에 선택 인자가 있으면 genCallExpr의
  // varlen 패딩 분기도 함께 — 뒤에 붙는 barCount/barIdx가 그 자리를 침범하지 않도록).
  seriesLengthOk?: boolean;
  // true면 조건부 위치에서의 호출을 제한한다(전 항목 true). C64/C65/C66/C161/C162를 거치며
  // cond-body/lazy-expr/loop-body/udf-body가 차례로 허용돼 남은 거부 위치는 조건식(condition)
  // 하나다 — firstForbiddenKind/ScopePushKind 주석 참조.
  conditionalForbidden: boolean;
  rtPath: string; // codegen이 내릴 런타임 호출 경로 — 첫 인자 `$.taSlots[slot]`은 codegen이 자동 삽입
  // 다중 반환 TA(ta.macd의 [macdLine, signalLine, histLine] 등)의 반환 개수. 생략(undefined)이면
  // 단일 스칼라 반환(기존 전부). 설정된 함수는 (1) 튜플 디스트럭처링의 값으로만 호출 가능(표현식
  // 위치는 analyzer가 거부 — codegen genCallExpr가 스칼라 식을 기대하므로), (2) 대상 이름 개수가
  // 정확히 이 값과 일치해야 하며(pine2py는 검증 없이 Python 튜플 언패킹에 위임해 불일치 시 런타임
  // ValueError — 즉 "정확히 일치"가 pine2py 시맨틱, UDF tupleArity 검사와 동일 패턴), (3) codegen이
  // 런타임 호출 마지막 인자로 $.taScratch를 넘기고 rt 함수는 반환값 대신 scratch[0..N-1]에 쓴다
  // (GOAL.md "다중 반환 TA는 재사용 스크래치 배열" — bar loop 안 튜플/배열 생성 금지, C50).
  returnArity?: number;
  // ta.vwap(C362) 전용 — 같은 함수 이름이 **사용자 인자 개수**에 따라 단일 스칼라 ↔ 다중 반환을
  // 오가는 첫 사례(TV 공식 시그니처: ta.vwap(source)→float / ta.vwap(source, anchor)→float /
  // ta.vwap(source, anchor, stdev_mult)→[vwap, upper, lower]). key=콜사이트의 사용자 인자 개수
  // (expr.args.length), value=그 폼의 returnArity. 등재된 개수의 콜만 다중 반환(튜플 디스트럭처링
  // 전용) 취급하고, 그 외 개수는 returnArity(없으면 단일 스칼라) 규칙을 그대로 따른다.
  // entry.returnArity를 직접 읽던 소비처는 전부 taCallReturnArity() 헬퍼로 교체됐다 —
  // analyzeTupleDestructure(analyzer.ts)/표현식 위치 거부·matchSecurityExprTaCall(call-expr.ts)/
  // analyzeStatefulCall 스크래치 크기(아래)/genCallExpr·genTupleDestructure(codegen.ts) 6곳.
  // 고정 returnArity 항목(macd/bb/kc/supertrend/dmi)은 이 필드가 없어 동작 불변.
  returnArityByArgCount?: Readonly<Record<number, number>>;
  // true면 반환값이 스칼라/튜플이 아니라 array<float> "핸들"(JS 배열 참조)이다 — 첫 사례
  // ta.pivot_point_levels(C653). 소비처 2곳: (1) constructors.ts isArrayConstructorCall이 이
  // 플래그로 `x = ta.pivot_point_levels(...)`를 array 컨테이너로 판별(containerKindHints/arrayVars
  // 전파 — C393 "공유 헬퍼 원천 확장" 패턴), (2) call-expr.ts matchSecurityExprTaCall이 이 플래그를
  // 거부 조건으로 사용(security expr의 out[h]/버퍼는 Float64Array라 배열 핸들이 흘러들면
  // Number(array)=NaN 조용한 부식 — C602 클래스 예방).
  returnsArrayHandle?: boolean;
}

// 콜사이트 하나의 실제 반환 arity — returnArityByArgCount(인자 개수 의존, vwap)가 등재된 개수면
// 그 값을, 아니면 entry.returnArity(고정 다중 반환)를, 둘 다 없으면 undefined(단일 스칼라).
// userArgCount는 반드시 **사용자가 쓴 인자 개수**(expr.args.length — codegen의 암묵 주입/패딩
// 전)여야 한다.
export function taCallReturnArity(entry: TaRegistryEntry, userArgCount: number): number | undefined {
  return entry.returnArityByArgCount?.[userArgCount] ?? entry.returnArity;
}

export const TA_REGISTRY: Readonly<Record<string, TaRegistryEntry>> = {
  sma: { dispatch: "ta", displayName: "ta.sma", argCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.sma", kwargParamNames: ["source", "length"] },
  ema: { dispatch: "ta", displayName: "ta.ema", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.ema", kwargParamNames: ["source", "length"] },
  rsi: { dispatch: "ta", displayName: "ta.rsi", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.rsi", kwargParamNames: ["source", "length"] },
  // C473: rma/wma(source=/length= kwarg, next_hint(C472) 지시대로 재노출된 "SMMA" 클러스터
  // 9528a6345fa3.pine 세분화 결과 — wild 파일 하나가 ta.rma/wma/vwma/stdev 4종 전부를
  // `source=.../length=...` 완전 키워드 폼으로 호출. pine2py wavealgo/ta/rma.py·wma.py 소스 대조
  // 결과 첫 두 파라미터명이 정확히 "source"/"length"(TV 공식 이름과 일치) — sma/ema/rsi(C400)와
  // 동일하게 진짜 오라클 대조 가능.
  rma: { dispatch: "ta", displayName: "ta.rma", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.rma", kwargParamNames: ["source", "length"] },
  wma: { dispatch: "ta", displayName: "ta.wma", argCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.wma", kwargParamNames: ["source", "length"] },
  // ta.alma(source, length, offset, sigma) — Gaussian 가중 이동평균. pine2py wavealgo/ta/alma.py
  // 소스 대조 결과 weight(i)=exp(-((i-m)^2)/(2*s*s))(m=offset*(length-1), s=length/sigma)가 임의
  // (비-등차/비-등비) 가중치라 wma(C28)의 O(1) telescoping 재귀식이 존재하지 않음을 확정(2,000건
  // python fuzz + 대수적 검토, PROGRESS C113/MEMORY.md Architecture Decisions 참조) — GOAL.md
  // "TA는 전부 incremental O(1)/bar" 원칙의 첫 명시적 예외(가중치 배열은 캐시, 가중합만 매 바
  // O(length) 재계산, runtime/ta.ts alma() 주석 참조). length/offset/sigma 셋 다 최초 호출 값으로
  // weight 배열 크기/모양을 고정하므로(tsi/macd의 다중 length와 동일 이유) lengthArgIndex를 배열
  // [1, 2, 3]으로 등록(series면 하드 에러) — TV 실제 시그니처도 이 셋 다 simple(non-series) 한정.
  alma: { dispatch: "ta", displayName: "ta.alma", argCount: 4, lengthArgIndex: [1, 2, 3], conditionalForbidden: true, rtPath: "rt.ta.alma", kwargParamNames: ["source", "length", "offset", "sigma"] },
  // ta.hma(source, length) — pine2py wavealgo/ta/hma.py 소스 대조 결과 HMA = WMA(2*WMA(src,half_len)
  // - WMA(src,length), sqrt_len)(half_len/sqrt_len는 length의 순수 파생값). runtime/ta.ts hma()가
  // rt.ta.wma를 half/full/outer 세 벌 독립 상태로 내부 재호출하므로 codegen 특수 분기 불필요 —
  // sma와 동일한 표준 시그니처(source, length)로 lengthArgIndex:1 그대로 재사용.
  hma: { dispatch: "ta", displayName: "ta.hma", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.hma" },
  // ta.dema(source, length) — Double Exponential Moving Average: DEMA = 2*EMA(source,length) -
  // EMA(EMA(source,length),length)(배치25 (3), 표준 TV 공식 정의). pine2py wavealgo/ta/에 대응
  // 구현이 전혀 없어(전수 grep 0건) 오라클 대조 자체가 불가능한 hand-verified 신규 함수 —
  // DIVERGENCES.md #175 "TV 미검증(가설)" 참조. runtime/ta.ts dema()가 오라클로 이미 검증된
  // rt.ta.ema를 두 겹 내부 재호출로 구성하므로(hma()가 rt.ta.wma를 세 겹 재사용하는 것과 동일
  // 원칙) sma/hma와 동일한 표준 시그니처(source, length)로 lengthArgIndex:1 그대로 재사용.
  dema: { dispatch: "ta", displayName: "ta.dema", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.dema" },
  // ta.linreg(source, length, offset) — pine2py wavealgo/ta/linreg.py 소스 대조 결과 sum_x/sum_x2는
  // length만으로 결정되는 상수, sum_xy는 rt.ta.wma의 내부 weightedSum(1-based)-sum과 대수적으로
  // 동일해(runtime/ta.ts linreg 주석 참조) codegen 특수 분기 없이 WmaState 재사용으로 구현. length는
  // sma와 동일하게 버퍼 크기를 고정하므로 lengthArgIndex:1(series 하드 에러). offset은 최종 산술에만
  // 쓰이고 버퍼 크기를 결정하지 않아 series여도 안전 — lengthArgIndex 대상이 아님(valuewhen의
  // occurrence와 다른 지점, occurrence는 버퍼 크기를 결정해서 lengthArgIndex였음).
  // C252: pine2py linreg.py 시그니처가 이미 `offset: int = 0`이라 2-인자 호출(offset 생략)이
  // pine2py에서 그대로 유효(corpus 실측 472ec897958a.pine/7ba48aafb742.pine 2건) — minArgCount:2
  // 신설. offset은 trailing이라 sourceOmittable(leading 전용, highest/lowest C250) 불필요하고
  // lengthArgIndex:1은 offset 생략 여부와 무관하게 그대로 유지. codegen 특수 분기도 불필요 —
  // runtime/ta.ts linreg()에 offset 기본값을 추가해 change()(minArgCount:1, length=1 기본값)와
  // 동일하게 JS 자체 파라미터 기본값으로 흡수(kc류의 명시적 "0"/"undefined" 리터럴 패딩과 달리,
  // offset이 args 마지막 자리라 트레일링 생략은 그냥 인자 개수가 적은 호출일 뿐).
  linreg: { dispatch: "ta", displayName: "ta.linreg", argCount: 3, minArgCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.linreg" },
  // ta.vwma(source, length) — Pine 문법상 volume은 인자로 받지 않고 내장 bar series `volume`을
  // 암묵 사용한다(pine2py wavealgo/ta/vwma.py 소스 대조). argCount는 사용자가 실제로 쓰는 2개
  // 그대로이고, codegen.genCallExpr이 런타임 호출 시 $.volume.get(0)을 source와 length 사이에
  // 끼워 넣는다(레지스트리 스키마 확장 없이 vwma 하나만의 특수 처리 — MEMORY.md 참조).
  // C473: vwma도 rma/wma와 동일하게 source=/length= 완전 키워드 폼 지원(pine2py wavealgo/ta/vwma.py
  // 첫 파라미터명도 정확히 "source"). codegen의 volume splice(genCallExpr L2641)는
  // resolveTaKwargPositions로 위치 정규화된 뒤에 실행되므로 kwarg 폼도 기존 splice 로직을 그대로 탄다.
  // C555(배치25 (4) 마지막): seriesLengthOk true — pine2py vwma.py가 sma/wma(#179/#181)와 동일한
  // 첫-호출-length-고정 latent 버그라 hand-verified(runtime/ta.ts vwmaVarLen 주석 참조).
  vwma: {
    dispatch: "ta",
    displayName: "ta.vwma",
    argCount: 2,
    lengthArgIndex: 1,
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.vwma",
    kwargParamNames: ["source", "length"],
  },
  // ta.swma(source) — Pine 문법상 length 인자가 없는 고정 4-tap 가중평균(weights=[1,2,2,1]/6).
  // lengthArgIndex: null이라 series length 하드 에러 검사 대상이 아니다(길이 자체가 없으므로).
  swma: { dispatch: "ta", displayName: "ta.swma", argCount: 1, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.swma" },
  crossover: {
    dispatch: "ta",
    displayName: "ta.crossover",
    argCount: 2,
    lengthArgIndex: null,
    conditionalForbidden: true,
    rtPath: "rt.ta.crossover",
    kwargParamNames: ["source1", "source2"],
  },
  crossunder: {
    dispatch: "ta",
    displayName: "ta.crossunder",
    argCount: 2,
    lengthArgIndex: null,
    conditionalForbidden: true,
    rtPath: "rt.ta.crossunder",
    kwargParamNames: ["source1", "source2"],
  },
  // ta.cross(a, b) — crossover OR crossunder(방향 무관). pine2py wavealgo/ta/cross.py 소스 대조로
  // crossover/crossunder와 완전히 동일한 CrossState를 재사용하지만 반환식이 두 부울식의 OR라 별도
  // rt.ta.cross가 필요(roc/change와 동일 원칙 — 상태 모양이 같아도 반환 로직이 다르면 alias 불가).
  cross: {
    dispatch: "ta",
    displayName: "ta.cross",
    argCount: 2,
    lengthArgIndex: null,
    conditionalForbidden: true,
    rtPath: "rt.ta.cross",
  },
  // C557: kwargParamNames ["source"](next_hint(C556) 지시로 재조사한 argcount 클러스터의
  // color.new/matrix.sum/ta.obv 3종은 전부 C501이 이미 corpus 아티팩트/TV 자체 무효 호출로 확정한
  // 것과 동일 판정(재확인만, wild net-gain 0) — 대신 같은 클러스터 재스캔에서 발견한 신규 저비용
  // 후보. wild f2f9d8404a18.pine(`fixnan(source=close)`)이 TV 공식 파라미터명 "source"로 완전
  // 키워드 폼을 씀 — sma/cci(C400/C477)와 동일한 kwargParamNames 슬라이스, pine2py fixnan(value)의
  // 내부 파라미터명(core.py)은 TV 공식명과 달라도(source vs value) kwargParamNames는 TV 문서 이름
  // 기준이라 무관(resolveTaKwargPositions는 위치 슬롯 매핑일 뿐 pine2py 심볼과 무관).
  fixnan: {
    dispatch: "bare",
    displayName: "fixnan",
    argCount: 1,
    lengthArgIndex: null,
    conditionalForbidden: true,
    rtPath: "rt.fixnan",
    kwargParamNames: ["source"],
  },
  // ta.cmo(source, length) — 다른 인자 개수/암묵 주입 없이 sma와 동일한 표준 시그니처.
  cmo: { dispatch: "ta", displayName: "ta.cmo", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.cmo" },
  // ta.cci(source, length) — 다른 인자 개수/암묵 주입 없이 sma와 동일한 표준 시그니처. pine2py
  // wavealgo/ta/cci.py 소스 대조 결과 alma(C113)에 이은 두 번째 GOAL.md O(1)/bar 명시적 예외
  // (runtime/ta.ts cci() 주석 참조 — sum조차 캐시하지 않는 완전한 매 바 재계산, 러닝 합계 최적화가
  // 부동소수점 캔슬레이션으로 정확한 tie를 깨는 실측 버그를 만들어 배제).
  // C477: source=/length= 완전 키워드 폼(wild 10c6fbc3696f.pine/257fa4fb6137.pine, next_hint(C476)
  // 지시대로 착수). pine2py wavealgo/ta/cci.py의 첫 두 파라미터명이 정확히 "source"/"length"라
  // sma/ema/rsi(C400)·rma/wma/vwma/stdev(C473)와 동일한 진짜 오라클 대조 축.
  cci: { dispatch: "ta", displayName: "ta.cci", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.cci", kwargParamNames: ["source", "length"] },
  // ta.change(source, length) — pine2py wavealgo/ta/change.py 소스 대조 결과 ta.mom이 change()에
  // 인자를 그대로 전달해 호출하는 완전한 별칭(로직 0줄 차이)임을 확인 — mom은 별도 런타임 구현 없이
  // 이 rtPath(rt.ta.change)를 그대로 재사용한다(runtime/ta.ts change() 주석 참조). pine2py 시그니처는
  // length가 선택 인자(기본값 1, TV corpus 실측 10건이 `ta.change(close)` 1-인자 관용구 — C227)라
  // minArgCount:1 신설(math.random C120과 동일 패턴). mom은 TV 실제 시그니처에 length 기본값이
  // 없어(corpus에도 1-인자 ta.mom 관용구 없음) 그대로 2-인자 고정 유지.
  change: { dispatch: "ta", displayName: "ta.change", argCount: 2, minArgCount: 1, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.change", kwargParamNames: ["source", "length"] },
  mom: { dispatch: "ta", displayName: "ta.mom", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.change" },
  // ta.roc(source, length) — pine2py wavealgo/ta/roc.py 소스 대조 결과 change와 완전히 동일한
  // NaN-프라임 순환 버퍼 상태(source.get(0)/source.get(length))를 쓰지만 반환 산식이 다르다
  // (100*(curr-prev)/prev, prev===0이면 NaN) — alias 재사용(mom처럼) 불가, 별도 rt.ta.roc 신규 필요.
  roc: { dispatch: "ta", displayName: "ta.roc", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.roc" },
  // ta.rising(source, length)/ta.falling(source, length) — pine2py wavealgo/ta/cross.py 소스 대조
  // 결과 매 호출 O(length) 재스캔이 O(1) streak 카운터와 동치임을 확인(runtime/ta.ts rising/falling
  // 주석 참조). sma류와 달리 고정폭 버퍼를 전혀 쓰지 않아 length가 바마다 바뀌어도(series) 결과가
  // 여전히 정확 — lengthArgIndex: null(series length 하드 에러 대상 아님).
  rising: { dispatch: "ta", displayName: "ta.rising", argCount: 2, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.rising" },
  falling: { dispatch: "ta", displayName: "ta.falling", argCount: 2, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.falling" },
  // ta.variance(source, length)/ta.stdev(source, length) — pine2py wavealgo/ta/stdev.py 소스 대조
  // 결과 둘 다 population variance/stdev로 완전히 동일한 로직(가중치 없는 단순 윈도우, stdev만
  // sqrt 추가)이라 sma와 동일한 표준 시그니처(source, length). stdev는 variance와 반환 산식이
  // 달라 별도 rt.ta.stdev가 필요(roc/change와 동일 원칙 — runtime/ta.ts stdev 주석 참조).
  variance: { dispatch: "ta", displayName: "ta.variance", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.variance" },
  // C296: stdev만 argCount 3(minArgCount 2)로 확장 — TV 공식 3번째 위치 인자 biased(bool, 기본
  // true, wild corpus 실사용 2건 확인)를 hand-verified로 지원(DIVERGENCES #110, pine2py
  // stdev(source, length, **kwargs)가 2-positional 고정이라 오라클 구조적 불가, C291/C292급 패턴).
  // args가 genCallExpr에서 expr.args.map으로 그대로 순서 보존돼 넘어가(codegen.ts L1736) 별도
  // unshift/push 분기 없이 runtime stdev(state, value, length, biased)에 그대로 맞는다.
  // ta.variance는 wild에 3-인자 실사용 근거가 0건이라 argCount 2 그대로 유지(C283 "wild 실측에
  // 나온 이름만 큐레이션" 원칙 — variance()에 biased 파라미터 자체는 stdev가 내부 호출하므로
  // runtime/ta.ts에 이미 추가돼 있지만 TA_REGISTRY 노출은 근거 없이 앞당기지 않는다).
  // C473: stdev도 source=/length= 완전 키워드 폼 지원(pine2py wavealgo/ta/stdev.py 시그니처
  // `stdev(source, length: int, **kwargs)` — 앞 두 파라미터명이 정확히 일치, python 직접 호출로
  // `stdev(source=s, length=3)`이 위치 폼과 동일한 값을 냄을 확인, C296 주석의 "2-positional 고정"은
  // 3번째 biased의 **kwargs 무시 축을 가리킨 것일 뿐 source/length 키워드 바인딩 자체와는 무관 —
  // biased는 wild kwarg 실사용 0건이라 표에 미등재(argCount:3 그대로, 3번째는 위치 인자 전용 유지).
  // C551: seriesLengthOk true — pine2py stdev.py가 median/linreg(#181)와 동일한 무상태 재스캔
  // (get_ta_state 미사용, python 직접 실행 확인)이라 가변 length 오라클 성립(runtime/ta.ts
  // stdevVarLen 참조). ta.variance는 wild series-length 실사용 근거 0건이라 미확장.
  stdev: { dispatch: "ta", displayName: "ta.stdev", argCount: 3, minArgCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.stdev", kwargParamNames: ["source", "length"] },
  // ta.cum(source) — Pine 문법상 length 인자가 없는(고정 없음) 누적 합계. swma와 동일하게
  // lengthArgIndex: null(길이 자체가 없어 series length 하드 에러 검사 대상이 아님). NaN 처리는
  // runtime/ta.ts cum() 주석 참조 — NaN을 0으로 치환해 누적해 절대 NaN을 반환하지 않는다.
  cum: { dispatch: "ta", displayName: "ta.cum", argCount: 1, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.cum", kwargParamNames: ["source"] },
  // ta.max(source)/ta.min(source) — cum(위)의 형제 함수: 인자 1개, length 없음(lengthArgIndex:
  // null). pine2py에 대응 구현이 전혀 없는 hand-verified 신규 함수(배치25 (3), DIVERGENCES.md #176)
  // — wild 재확인 결과 `import TradingView/ta/N [as ta]` 라이브러리가 "ta" 이름을 shadow하는 파일도
  // 섞여있어(ta.cagr 전량이 이 축, 스킵 확정) 그 경우를 제외한 unshadowed 실사용만 근거로 채택.
  // NaN 처리는 runtime/ta.ts cumMax/cumMin() 주석 참조 — cum과 달리 항등원이 없어 첫 유효값 이전엔
  // NaN 유지.
  max: { dispatch: "ta", displayName: "ta.max", argCount: 1, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.cumMax" },
  min: { dispatch: "ta", displayName: "ta.min", argCount: 1, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.cumMin" },
  // ta.barssince(condition) — pine2py wavealgo/ta/barssince.py 소스 대조 결과 condition 인자
  // 1개짜리 단일 카운터 상태(count). length 인자 자체가 없어 lengthArgIndex: null(cum/swma와 동일
  // 모양). runtime/ta.ts barssince() 주석 참조 — NaN 초기값(cum의 0.0 초기값과 다름).
  barssince: { dispatch: "ta", displayName: "ta.barssince", argCount: 1, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.barssince" },
  // ta.valuewhen(condition, source, occurrence) — pine2py wavealgo/ta/barssince.py의 valuewhen()
  // 소스 대조 결과 occurrence+1 크기로 bounded된 순환 버퍼 상태(runtime/ta.ts valuewhen 주석 참조).
  // occurrence는 sma의 length와 동일한 이유로 lengthArgIndex: 2(0-based 세 번째 인자)에 등록해
  // series 하드 에러 대상으로 삼는다 — 첫 호출 값으로 버퍼 크기를 한 번만 굳히므로 바마다 값이
  // 바뀌면(series) 위험(next_hint가 우려했던 지점, 새 필드 없이 기존 메커니즘 재사용으로 해소).
  // C557: kwargParamNames ["condition","source","occurrence"] — wild 3파일(6bbaeabd79ae.pine/
  // bed3f38ecd0f.pine/fab0b2ffba07.pine)이 전부 `ta.valuewhen(condition=..., source=...,
  // occurrence=0)` 완전 키워드 폼. pine2py wavealgo/ta/barssince.py valuewhen()의 파라미터명이
  // 정확히 condition/source/occurrence(TV 공식 이름과 일치, fixnan과 달리 내부 이름부터 이미
  // 일치) — sma/cci와 동일한 진짜 오라클 대조 축.
  valuewhen: {
    dispatch: "ta",
    displayName: "ta.valuewhen",
    argCount: 3,
    lengthArgIndex: 2,
    conditionalForbidden: true,
    rtPath: "rt.ta.valuewhen",
    kwargParamNames: ["condition", "source", "occurrence"],
  },
  // ta.highest(source, length)/ta.lowest(source, length) — pine2py wavealgo/ta/highest.py 소스 대조
  // 결과 매 호출 source.get(0..length-1) 전체를 O(length) 재스캔해 그 중 하나라도 NaN이면 즉시 NaN을
  // 반환한다(runtime/ta.ts highest/lowest 주석의 monotonic deque 유도 참조). length가 창 폭(버퍼 크기)을
  // 결정하므로 sma와 동일하게 lengthArgIndex: 1(series 하드 에러). codegen 특수 분기 불필요(2개 인자가
  // 그대로 순서대로 전달) — **C250**: pine2py의 `ta.highest(length)`(source 생략, 암묵 high/low)
  // 1-인자 축약형은 highest.py/lowest.py가 `isinstance(source,(int,float))` 런타임 스니핑으로 실제
  // 지원함을 확인(소스 20-35행) — minArgCount:1 + sourceOmittable:true로 신규 지원(genCallExpr의
  // "highest"/"lowest" 분기가 1-인자 호출에서만 암묵 high/low를 unshift). change의 선택적 length와
  // 다른 점: change는 뒤(length)가 생략, 이건 앞(source)이 생략 — TA_REGISTRY 주석의 sourceOmittable
  // 참조. **동일 형제로 보였던 ta.pivothigh/pivotlow(leftbars, rightbars) 2-인자 축약형은 범위 밖**:
  // pine2py pivot.py의 pivothigh/pivotlow는 이런 스니핑이 없어(`def pivothigh(source, left=5,
  // right=5, ...)`) 2-인자 호출 시 Python이 source=leftbars_값/left=rightbars_값으로 잘못
  // 바인딩한다(크래시 없이 조용히 틀린 값) — 오라클 자체가 이 폼을 지원하지 않아 구현 보류
  // (LIMITATIONS.md 참조).
  highest: {
    dispatch: "ta",
    displayName: "ta.highest",
    argCount: 2,
    minArgCount: 1,
    sourceOmittable: true,
    lengthArgIndex: 1,
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.highest",
    // wild kwarg 실사용(2f58cc5db939.pine/b7233fee9207.pine)이 전부 source+length 둘 다 이름으로
    // 지정한 완전 폼뿐이라(sourceOmittable 1-인자 축약형을 키워드로 흉내내는 실사용 0건) 이 표는
    // "source 홀 없이 둘 다 채워짐"만 지원 — analyzeStatefulCall의 홀 검사가 자연히 이를 강제한다.
    kwargParamNames: ["source", "length"],
  },
  lowest: {
    dispatch: "ta",
    displayName: "ta.lowest",
    argCount: 2,
    minArgCount: 1,
    sourceOmittable: true,
    lengthArgIndex: 1,
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.lowest",
    kwargParamNames: ["source", "length"],
  },
  // ta.stoch(source, high, low, length) — pine2py wavealgo/ta/stoch.py 소스 대조 결과 %K = 100*
  // (source-ll)/(hh-ll), hh=ta.highest(high,length)/ll=ta.lowest(low,length)를 내부에서 그대로
  // 호출하는 합성(runtime/ta.ts stoch() 주석 참조 — hma/linreg와 동일한 "이미 구현된 TA를 함수
  // 본문 안에서 재호출"이지만 반환값 자체를 바로 쓴다는 점은 hma와 더 가까움). length는 hh/ll의
  // 창 폭을 결정하므로 sma와 동일하게 lengthArgIndex: 3(0-based 네 번째 인자, series 하드 에러).
  // codegen 특수 분기 불필요 — Pine 문법상 4개 인자(source/high/low/length)가 wavealgo stoch()
  // 시그니처와 순서까지 그대로 일치해 vwma의 암묵 volume 주입 같은 처리가 필요 없다.
  // kwargParamNames: ["source","high","low","length"](C407, next_hint(C406) 1순위 — 최저비용 후보).
  // pine2py 실제 시그니처 `stoch(close, high, low, length=14, **kwargs)`를 python inspect.signature로
  // 재확인(C406에서 이미 확인, C407 재검증) — high/low/length는 TV 공식 이름과 정확히 일치해 부분
  // 오라클 가능(atr/C402와 동일), 'source='만 pine2py 'close'와 이름 불일치(crossover/pivothigh류와
  // 동일 축)라 hand-verified 필요.
  stoch: {
    dispatch: "ta",
    displayName: "ta.stoch",
    argCount: 4,
    lengthArgIndex: 3,
    conditionalForbidden: true,
    rtPath: "rt.ta.stoch",
    kwargParamNames: ["source", "high", "low", "length"],
  },
  // ta.wpr(length) — Pine 문법상 length 1개뿐(high/low/close는 bar series 암묵 사용, vwma의 volume
  // 암묵 주입과 동일한 특수 케이스 — codegen.genCallExpr이 $.close/$.high/$.low.get(0)을 length 앞에
  // 끼워 넣는다). **의도적 divergence**(runtime/ta.ts wpr() 주석 + DIVERGENCES.md 참조): pine2py
  // wavealgo/ta/wpr.py는 rt.ta.highest/rt.ta.lowest를 재사용하지 않는 자체 skip-NaN window(현재 바만
  // NaN 체크, NaN이면 append 자체를 생략해 window가 과거 NaN 갭을 조용히 건너뜀)를 쓰는데, 이는
  // TV 실제 Williams %R 내장 스크립트(ta.highest(length)/ta.lowest(length) 합성 — highest.py와
  // 동일한 NaN-poison window)와 다른 pine2py 자체의 latent 비일관성으로 판단해 포팅하지 않고 C42의
  // rt.ta.highest/rt.ta.lowest를 stoch(C43)과 동일하게 재사용한다. argCount는 사용자가 실제로 쓰는
  // 1개(length)뿐이고, length가 hh/ll의 창 폭을 결정하므로 sma와 동일하게 lengthArgIndex: 0(series
  // 하드 에러).
  wpr: { dispatch: "ta", displayName: "ta.wpr", argCount: 1, lengthArgIndex: 0, conditionalForbidden: true, rtPath: "rt.ta.wpr" },
  // ta.tr(handle_na) — True Range. Pine 문법상 인자가 없거나(bare `ta.tr` 프로퍼티 접근/`ta.tr()`,
  // C248) handle_na(선택, bool, 기본 true) 하나뿐(TV 실제 시그니처, C291) — high/low/close는 둘 다
  // bar series 암묵 사용(codegen이 $.high.get(0)/$.low.get(0)/$.close.get(1)(prevClose)을
  // handle_na **앞**에 끼워 넣는다 — wpr과 동일한 unshift 패턴, handle_na는 유일한 사용자 인자라
  // 그대로 맨 뒤에 남는다). minArgCount:0으로 0~1개 허용(math.random류 트레일링 선택 인자 패턴,
  // C120) — sourceOmittable(선두 생략, C250)과는 다른 축. runtime/ta.ts tr() 주석 참조 — 완전히
  // stateless인 순수 함수라 lengthArgIndex: null(길이 인자 자체가 없음, swma/cum과 동일 모양).
  // **C291: pine2py wavealgo/pine2wave/codegen.py OHLCV_INJECT["ta.tr"]=(0,...)는 user_arg_count<=0
  // 일 때만 high/low/close를 주입해 `ta.tr(true)` 자체가 오라클에서 크래시(source=최초 인자가
  // 잘못 바인딩됨, tr() 시그니처 자체가 (high,low,close,**kwargs)라 인자 부족 TypeError)한다 —
  // 오라클 불가, hand-verified 대체(DIVERGENCES 참조, "TV 미검증(가설)" — 이 세션 웹 접근 없음).
  tr: { dispatch: "ta", displayName: "ta.tr", argCount: 1, minArgCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.tr" },
  // ta.atr(length) — Average True Range = RMA(TR, length)(GOAL.md가 이미 명시). Pine 문법상
  // length 1개뿐, high/low/close는 tr과 동일하게 암묵 주입(codegen이 셋을 length 앞에 unshift).
  // **의도적 divergence**(runtime/ta.ts atr() 주석 + DIVERGENCES.md 참조): pine2py
  // wavealgo/ta/atr.py는 이 O(1) RMA 합성이 아니라 매 호출 length+10폭까지 tr_values를 재스캔하는
  // 독자 구현인데, scratch/probe_atr.mjs + 실제 오라클 골든 대조로 이 재스캔이 (1) 워밍업을
  // 실제 필요한 것보다 한 바 항상 늦추고 (2) length+10바보다 긴 시리즈에서 무한 히스토리
  // 스트리밍 RMA와 수치가 갈리는 pine2py 자체의 latent 버그임을 확인, GOAL.md
  // "pine2py의 알려진 버그는 따르지 않는다" 적용. length가 내부 RmaState 초기화 구간을
  // 결정하므로 sma/ema/rma와 동일하게 lengthArgIndex: 0(series 하드 에러).
  // kwargParamNames: ["length"](C402, next_hint(C401) 저비용 후보 — wild f2f9d8404a18.pine 신규
  // 노출). pine2py wavealgo/ta/atr.py의 실제 파라미터명이 `length`로 TV 공식 이름과 정확히 일치함을
  // python inspect.signature로 확인(atr(high, low, close, length=14, **kwargs)) — crossover/alma/
  // pivotlow(이름 불일치)와 달리 크래시/거짓흡수 문제는 없다. 그러나 신규 골든 오라클은 만들지
  // 않았다: 착수 전 실제로 골든을 생성해보니 이 함수 자체가 이미 바로 위 주석의 **의도적
  // divergence**(pine2py 재스캔이 워밍업을 한 바 항상 늦춤, ta_atr_tr.test.ts가 이미 문서화)를
  // 그대로 안고 있어, kwarg 폼 전용 새 골든도 그 기존 divergence만 재확인할 뿐 kwargs 바인딩
  // 자체의 검증력을 더하지 못한다 — 대신 crossover/alma/pivotlow와 동일하게 codegen 동치성(이미
  // 검증된 위치 인자 폼과 바이트 단위로 동일한 런타임 호출을 emit하는지)으로 hand-verified 대체.
  // 유일한 사용자 인자가 length 하나뿐이라 resolveTaKwargPositions는 항상 인덱스 0만 다루고, codegen의
  // 암묵 high/low/prevClose unshift(genCallExpr "atr" 분기)는 resolveTaKwargPositions가 만든 배열을
  // genExpr로 낮춘 **이후**에 실행돼(코드 확인 완료) 서로 간섭하지 않는다.
  atr: {
    dispatch: "ta",
    displayName: "ta.atr",
    argCount: 1,
    lengthArgIndex: 0,
    conditionalForbidden: true,
    rtPath: "rt.ta.atr",
    kwargParamNames: ["length"],
  },
  // ta.highestbars(source, length)/ta.lowestbars(source, length) — 최근 length바 중 최댓값/최솟값이
  // 발생한 바의 오프셋(0=현재바, -1=1바 전 ...). pine2py wavealgo/ta/highest.py의 highestbars()/
  // lowestbars()는 highest()/lowest()와 완전히 동일한 NaN-poison window(창 안 하나라도 NaN이면 즉시
  // NaN)라 divergence 없이 그대로 이식(wpr(C44)과 달리 highest.py 한 파일 안에서 poison window로
  // 이미 일관됨). runtime/ta.ts highestbars()/lowestbars() 주석 + scratch/probe_highestbars.mjs
  // 검증대로 rt.ta.highest/rt.ta.lowest(C42)의 ExtremeState 부수 정보(seq/dequeSeq[dequeHead])만
  // 읽어 offset을 유도하는 합성(hma/linreg/stoch과 동일 "이미 구현된 TA 재사용" 원칙) — 새 상태
  // 모양 불필요. length가 창 폭(deque backing array 크기)을 결정하므로 고정 length 폼은
  // lengthArgIndex: 1 그대로 — 단 pine2py 원본이 highest/lowest와 동일한 무상태 O(length) 재스캔
  // (get_ta_state 미사용)이라 series length도 깨지지 않아 seriesLengthOk: true(C549, 배치25 (4) —
  // codegen이 runtime/ta.ts highestbarsVarLen/lowestbarsVarLen 변형으로 분기).
  // C655: minArgCount:1 + sourceOmittable:true 추가 — TV 실측(scratch/tv_validation/results.jsonl,
  // 배치33 (6) argcount 재조사)이 `ta.highestbars(length)`/`ta.lowestbars(length)`(source 생략,
  // 암묵 high/low) 1-인자 폼을 실제 TV 컴파일러로 4/7 표본에서 accept로 확정(wild
  // 7544f96dc551/814617d16e02/98fd33c9f088/7b93045ac75f.pine 전부 이 형태). 위 주석의 "pine2py도
  // 1-인자 축약형이 아예 없어 표준 시그니처만 존재"는 pine2py 소스만 읽고 내린 결론이었을 뿐 TV
  // 문법 자체의 부재를 뜻하지 않았다 — pivothigh/pivotlow(C509)와 완전히 동일한 클래스의 pine2py
  // 자체 갭(오라클 새 골든 불가, highest.py 20-98행 재확인: highestbars/lowestbars엔 highest/lowest의
  // `isinstance(source,(int,float))` 스니핑이 없음) → highest/lowest(C250)와 동일한 codegen 동치성
  // hand-verified 원칙으로 이식. codegen이 1-인자 폼만 length(index 0) 앞에 암묵 $.high/$.low를
  // unshift(codegen.ts genCallExpr 참조), 2-인자 폼은 그대로 유지.
  highestbars: {
    dispatch: "ta",
    displayName: "ta.highestbars",
    argCount: 2,
    minArgCount: 1,
    sourceOmittable: true,
    lengthArgIndex: 1,
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.highestbars",
  },
  lowestbars: {
    dispatch: "ta",
    displayName: "ta.lowestbars",
    argCount: 2,
    minArgCount: 1,
    sourceOmittable: true,
    lengthArgIndex: 1,
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.lowestbars",
  },
  // ta.mfi(source, length) — Money Flow Index. Pine 문법상 volume은 인자가 아니라 내장 bar series를
  // 암묵 사용한다(vwma와 동일한 특수 케이스 — codegen.genCallExpr이 $.volume.get(0)을 source와
  // length 사이에 끼워 넣는다). length는 posBuffer/negBuffer의 고정폭 순환 버퍼 크기를 결정하므로
  // sma와 동일하게 lengthArgIndex: 1(series 하드 에러). runtime/ta.ts mfi() 주석 참조 — prevTp는
  // cmo의 무조건 raw-passthrough와 달리 source/volume이 둘 다 유효한 바에서만 갱신된다.
  mfi: { dispatch: "ta", displayName: "ta.mfi", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.mfi" },
  // ta.cog(source, length) — Center of Gravity. pine2py wavealgo/ta/cog.py 소스 대조 결과
  // num=Σsource.get(i)*(i+1)/denom=Σsource.get(i)에 대해 result=-num/denom(음수 부호), 창 안
  // 하나라도 NaN이거나 데이터 부족이면 NaN(highest.py와 동일한 poison window 계열). runtime/ta.ts
  // cog() 주석 참조 — rt.ta.wma의 내부 state.sum/weightedSum을 항등식으로 읽는 linreg(C41)와
  // 동일한 합성 원칙. length가 내부 WmaState 버퍼 크기를 결정하므로 sma와 동일하게 lengthArgIndex: 1
  // (series 하드 에러). codegen 특수 분기 불필요(source/length 2개 인자 그대로 순서대로 전달, volume
  // 등 암묵 주입 없음 — mfi/vwma/wpr과 다른 지점).
  cog: { dispatch: "ta", displayName: "ta.cog", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.cog" },
  // ta.correlation(source1, source2, length) — 피어슨 상관계수. pine2py wavealgo/ta/correlation.py
  // 소스 대조 결과 sum_x/sum_y/sum_xy/sum_x2/sum_y2 다섯 러닝 합계로만 구성됨(runtime/ta.ts
  // correlation() 주석 참조) — vwma(C29, 두 신호 병렬 버퍼)와 stdev(C36, sumSq 항등식)를 합친 형태로
  // codegen 특수 분기 없이 구현. length가 x/yBuffer 고정폭 순환 버퍼 크기를 결정하므로 sma와 동일하게
  // lengthArgIndex: 2(0-based 세 번째 인자, series 하드 에러). source1/source2는 버퍼 크기와 무관해
  // series 허용(linreg의 offset과 동일한 이유로 lengthArgIndex 대상 아님).
  correlation: { dispatch: "ta", displayName: "ta.correlation", argCount: 3, lengthArgIndex: 2, conditionalForbidden: true, rtPath: "rt.ta.correlation" },
  // ta.tsi(source, short_length, long_length) — True Strength Index. pine2py wavealgo/ta/tsi.py
  // 소스 대조 결과 자체 _ema_step 인라인 재구현(count/running_sum/prev_ema)이 rt.ta.ema와 완전히
  // 동일한 2단계 상태 전이라 이미 구현된 rt.ta.ema를 함수 본문 안에서 4벌(e1_pc/e1_abs/e2_pc/
  // e2_abs) 독립 상태로 재호출(hma/linreg/stoch/cog와 동일 합성 원칙, runtime/ta.ts tsi() 주석
  // 참조). e1이 아직 NaN이어도 e2 ema() 호출은 조건문 없이 무조건 실행 — ema()의 최상단 NaN
  // 게이트가 상태 불변으로 NaN을 반환해 pine2py의 "e1 NaN이면 e2 호출 자체 생략"과 결과가
  // 동치임을 scratch/probe_tsi.mjs로 검증. short_length/long_length 둘 다 e1/e2의 고정 초기화
  // 구간 길이를 결정하므로(ema가 series length에서 조용히 틀어지는 것과 동일 이유) sma/ema와
  // 동일한 이유로 series 하드 에러 대상 — 다중 length 인자를 하드 에러하는 첫 사례라
  // lengthArgIndex를 number[]로 확장해 [1, 2] 등록(위 TaRegistryEntry 주석 참조).
  tsi: { dispatch: "ta", displayName: "ta.tsi", argCount: 3, lengthArgIndex: [1, 2], conditionalForbidden: true, rtPath: "rt.ta.tsi" },
  // ta.median(source, length) — 다른 인자 개수/암묵 주입 없이 sma와 동일한 표준 시그니처. pine2py
  // wavealgo/ta/median.py 소스 대조 결과 highest/cci에 이은 세 번째 GOAL.md O(1)/bar 명시적 예외
  // (runtime/ta.ts median() 주석 참조 — 정렬 자체가 incremental 구조를 허용하지 않아 매 바
  // O(length log length) 재정렬, 두-힙 O(log n) 대안은 정확성 버그 표면 대비 이득이 작다고 판단).
  median: { dispatch: "ta", displayName: "ta.median", argCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.median" },
  // ta.mode(source, length) — median과 동일한 표준 시그니처지만 워밍업 게이트(순수 호출 횟수
  // 카운터, median의 "버퍼 NaN-프라임 잔존" 판정과 다름)와 NaN 처리(개별 NaN 스킵, median의
  // "하나라도 있으면 전체 NaN"과 다름)가 갈린다 — runtime/ta.ts mode() 주석 참조. median(C115)에
  // 이은 GOAL.md O(1)/bar 네 번째 명시적 예외.
  mode: { dispatch: "ta", displayName: "ta.mode", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.mode" },
  // ta.percentrank(source, length) — median/mode와 동일한 표준 시그니처지만 창이 현재 바 포함
  // length개가 아니라 **1~length바 전(현재 제외) length개**라 읽기가 쓰기보다 먼저 오는 순환 버퍼
  // 변형(runtime/ta.ts percentrank() 주석 참조). ta.* 44종 완주(alma C113/cci C114/median C115/
  // mode C116에 이은 다섯 번째이자 마지막 GOAL.md O(1)/bar 명시적 예외 — 버퍼 스캔 자체는
  // median/mode와 동일하게 O(length)/bar).
  percentrank: { dispatch: "ta", displayName: "ta.percentrank", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.percentrank" },
  // ta.dev(source, length) — Mean Absolute Deviation. 다른 인자 개수/암묵 주입 없이 sma와 동일한
  // 표준 시그니처. ROADMAP.md의 "ta.* 44종 완주"(C118) 정정 시점에도 인라인으로만 남아있던 실제
  // 누락 항목이었음(TA_REGISTRY/rt.ts/ta.ts 어디에도 없었음을 grep으로 확인 후 이번에 추가) — pine2py
  // wavealgo/ta/dev.py 소스 대조 결과 context/state_key kwargs를 받지만 실제로 context.get_ta_state를
  // 전혀 쓰지 않는 완전 무상태 함수(cci류의 phase1/phase2 구분조차 없음)라, alma/cci/median/mode/
  // percentrank에 이은 **여섯 번째** GOAL.md O(1)/bar 명시적 예외(runtime/ta.ts dev() 주석 참조 —
  // mean이 매 바 바뀌어 mad_sum을 러닝 합계로 캐시할 수 없음, cci와 동일 이유로 sum도 함께
  // O(length) 재계산).
  dev: { dispatch: "ta", displayName: "ta.dev", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.dev" },
  // ta.rci(source, length) — Rank Correlation Index. 다른 인자 개수/암묵 주입 없이 sma와 동일한
  // 표준 시그니처. pine2py에 대응 구현이 전혀 없는 hand-verified 신규 함수(배치25 (3),
  // DIVERGENCES.md #177) — runtime/ta.ts rci() 주석 참조. alma/cci/median/mode/percentrank/dev에
  // 이은 GOAL.md O(1)/bar 일곱 번째 명시적 예외. length가 내부 순환 버퍼 크기를 결정하므로 sma와
  // 동일하게 lengthArgIndex: 1(series 하드 에러).
  rci: { dispatch: "ta", displayName: "ta.rci", argCount: 2, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.rci" },
  // ta.pivot_point_levels(type, anchor, developing=false) — 피벗 레벨 11종을 array<float> 핸들로
  // 반환하는 첫 stateful TA(C653, returnsArrayHandle 주석 참조). pine2py 미구현이라 hand-verified
  // (배치25 (3) 트랙, LIMITATIONS C546이 '다음 배치'로 지목 — 반환 계약/공식 근거는 runtime/ta.ts
  // pivotPointLevels() 주석 + DIVERGENCES.md 참조). type/anchor/developing 전부 series 허용이라
  // lengthArgIndex: null(고정폭 버퍼 없음 — 상태는 anchor 구간 누적 극값뿐). open/high/low/close는
  // Pine 문법에 인자가 없는 암묵 bar series 주입(codegen genCallExpr "pivot_point_levels" 분기,
  // tr/atr/supertrend와 동일 패턴 + developing 누락 시 "false" 명시 패딩).
  pivot_point_levels: { dispatch: "ta", displayName: "ta.pivot_point_levels", argCount: 3, minArgCount: 2, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.pivotPointLevels", returnsArrayHandle: true },
  // ta.range(source, length) — 최근 length바(현재 포함) 중 최댓값-최솟값. 다른 인자 개수/암묵
  // 주입 없이 sma와 동일한 표준 시그니처(C256, "지원하지 않는 호출" 클러스터 조사 중 발견 —
  // pine2py wavealgo/ta/range_func.py + wavealgo/ta/__init__.py L76 TA 함수 세트 대조로 실제
  // 등록된 TA 함수임을 확인. array.range(id)와는 별개 함수). runtime/ta.ts range() 주석 참조 —
  // highest/lowest 재호출 합성(stoch과 동일 원칙)이라 poison window(창 안 NaN 하나라도 있으면
  // 전체 NaN)는 highest/lowest의 기존 nanCount 게이트로 자동 전파. length가 내부 ExtremeState
  // 순환 버퍼 크기를 결정하므로 sma와 동일하게 lengthArgIndex: 1(series 하드 에러).
  // C552(next_hint) 잔여 싱글턴 재실측 결과 range_func.py도 상태 없이 매 호출 재스캔이라
  // seriesLengthOk: true(runtime/ta.ts rangeVarLen 참조, oracle/cases/ta_range_percentile_varlen.pine).
  range: { dispatch: "ta", displayName: "ta.range", argCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.range" },
  // ta.percentile_nearest_rank(source, length, percentage=50) / ta.percentile_linear_interpolation
  // (source, length, percentage=50) — median과 정확히 동일한 창 수집(현재 바 포함 length개, 정렬)을
  // 공유하고 마지막 선택/보간 계산만 다르다(runtime/ta.ts percentileNearestRank/
  // percentileLinearInterpolation 주석 참조). percentage는 pine2py 시그니처가 이미 기본값 50.0을
  // 가진 선택 인자라 change/kc와 동일한 minArgCount 패턴(C227) 적용 — kc처럼 뒤에 스크래치를
  // 추가로 push하는 returnArity가 없어 codegen 특수 패딩 분기 불필요, entry.rtPath 표준 경로 그대로.
  // C552(next_hint) 잔여 싱글턴 재실측 결과 percentrank.py의 두 percentile_* 함수도 median.py와
  // 동일한 무상태 재스캔이라 seriesLengthOk: true(runtime/ta.ts percentileNearestRankVarLen/
  // percentileLinearInterpolationVarLen 참조, range와 같은 오라클 케이스 파일 공유).
  percentile_nearest_rank: { dispatch: "ta", displayName: "ta.percentile_nearest_rank", argCount: 3, minArgCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.percentileNearestRank" },
  percentile_linear_interpolation: { dispatch: "ta", displayName: "ta.percentile_linear_interpolation", argCount: 3, minArgCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.percentileLinearInterpolation" },
  // ta.macd(source, fast_length, slow_length, signal_length) — 첫 다중 반환 TA(returnArity: 3,
  // [macdLine, signalLine, histLine]). pine2py wavealgo/ta/macd.py 소스 대조 결과 macd_line =
  // ema(fast) - ema(slow)(진짜 wavealgo ema 재사용), signal은 자체 인라인이지만 전이 로직이
  // rt.ta.ema와 완전히 동일해 rt.ta.ema 3벌 합성으로 이식(runtime/ta.ts macd() 주석 참조 —
  // tsi(C49)의 4벌 합성과 동일 원칙, scratch/probe_macd.mjs로 NaN 게이트 동치성 검증).
  // fast/slow/signal_length 셋 다 EMA 초기화 구간 크기를 고정하므로 tsi와 동일하게 전부
  // lengthArgIndex 배열에 등록(series 하드 에러). codegen은 stateCallSlots 표준 경로에
  // $.taScratch 마지막 인자 추가만 다르다(genTupleDestructure/genCallExpr 참조).
  macd: {
    dispatch: "ta",
    displayName: "ta.macd",
    argCount: 4,
    lengthArgIndex: [1, 2, 3],
    conditionalForbidden: true,
    rtPath: "rt.ta.macd",
    returnArity: 3,
  },
  // ta.bb(source, length, mult) — Bollinger Bands, the second multi-return TA (returnArity: 3,
  // [middle, upper, lower]). pine2py wavealgo/ta/bb.py 소스 대조 결과 middle=SMA(source,length),
  // stdev=population stdev(같은 창, C36과 동일 공식), upper/lower=middle±mult*stdev, poison
  // window(highest류)임을 확인 — runtime/ta.ts bb() 주석 참조. length만 내부 StdevState 순환
  // 버퍼 크기를 결정하므로 sma와 동일하게 lengthArgIndex: 1(series 하드 에러); mult은 최종 산술
  // 에만 쓰여 series 허용(linreg의 offset과 동일 이유로 lengthArgIndex 대상 아님). codegen 특수
  // 분기 불필요 — 이 항목이 macd와 다른 필드는 rtPath/displayName뿐이라는 사실 자체가 다중 반환
  // 인프라(C50)가 macd 전용이 아니라 일반화됐다는 증거(analyzer/codegen 코드 변경 0줄).
  bb: {
    dispatch: "ta",
    displayName: "ta.bb",
    argCount: 3,
    lengthArgIndex: 1,
    conditionalForbidden: true,
    rtPath: "rt.ta.bb",
    returnArity: 3,
  },
  // ta.bbw(source, length, mult) - Bollinger Bands Width. pine2py wavealgo/ta/bbw.py 소스 대조
  // 결과 bb(source,length,mult)를 호출해 basis/upper/lower를 얻은 뒤 (upper-lower)/basis*100
  // (basis가 NaN이거나 정확히 0이면 NaN)임을 확인 — runtime/ta.ts bbw() 주석 참조. bb와 달리
  // 단일 스칼라 반환이라 returnArity 없이 macd/bb 이전 33종과 동일한 표준 패턴. length는 bb와
  // 동일하게 내부 StdevState 순환 버퍼 크기를 결정하므로 lengthArgIndex: 1(series 하드 에러);
  // mult은 최종 산술에만 쓰여 series 허용(bb와 동일 이유).
  bbw: { dispatch: "ta", displayName: "ta.bbw", argCount: 3, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.bbw" },
  // ta.kc(source, length, mult, useTrueRange) — Keltner Channels, the third multi-return TA
  // (returnArity: 3, [basis, upper, lower]). pine2py wavealgo/ta/kc.py composes basis=ema(source,
  // length) with range=atr(high,low,close,length) when useTrueRange(default true) — both already
  // implemented (rt.ta.ema/rt.ta.atr, C19/C53) — reused unconditionally every bar (runtime/ta.ts
  // kc() comment: gating atr's call on basis being NaN, as pine2py's early return literally does,
  // desyncs the two independent length-bar warmups — scratch/probe_kc.mjs confirmed). useTrueRange
  // false uses TV's documented "high - low" formula, **not** pine2py's kc.py bug (source.get(0)
  // read twice → range always 0) — DIVERGENCES.md 신규. Pine 문법에 high/low/close 인자가 없어
  // codegen이 atr과 동일한 패턴으로 $.high.get(0)/$.low.get(0)/$.close.get(1)을 앞에 unshift한다.
  // length가 ema/atr 둘 다의 초기화 구간을 결정하므로 sma와 동일하게 lengthArgIndex: 1(series 하드
  // 에러); mult/useTrueRange는 최종 산술/분기에만 쓰여 series 허용. useTrueRange는 TV 기본값 true
  // (pine2py kc.py도 use_true_range=True 기본값 — corpus 실측 20+건이 `ta.kc(source, length, mult)`
  // 3-인자 관용구, C227)라 minArgCount:3 신설 — codegen이 args를 4개로 패딩한 뒤 implicit unshift하므로
  // (genCallExpr kc/kcw 분기 참조) 이 함수의 returnArity 스크래치 push와 트레일링 생략이 충돌하지 않음.
  kc: {
    dispatch: "ta",
    displayName: "ta.kc",
    argCount: 4,
    minArgCount: 3,
    lengthArgIndex: 1,
    conditionalForbidden: true,
    rtPath: "rt.ta.kc",
    returnArity: 3,
  },
  // ta.kcw(source, length, mult, useTrueRange) — Keltner Channels Width. pine2py wavealgo/ta/kcw.py
  // calls kc(...) then (upper-lower)/basis*100 (NaN if basis is NaN or exactly 0) — same "call kc
  // for its side effect, inline arithmetic" composition as bbw over bb (C52). Single scalar return,
  // no returnArity, standard pattern. Same implicit high/low/close injection + lengthArgIndex: 1 as kc.
  // useTrueRange 기본값 true — kc와 동일 이유로 minArgCount:3(kcw는 returnArity 없어 트레일링 스크래치
  // push 자체가 없으므로 useTrueRange 생략도 자연스러운 트레일링 인자 누락으로 그대로 안전 —
  // codegen genCallExpr kc/kcw 분기의 "undefined" 패딩은 kc 전용, kcw는 패딩 불필요).
  kcw: { dispatch: "ta", displayName: "ta.kcw", argCount: 4, minArgCount: 3, lengthArgIndex: 1, conditionalForbidden: true, rtPath: "rt.ta.kcw" },
  // ta.obv() — On Balance Volume. Pine 문법상 인자가 없고(close/volume은 bar series 암묵 사용,
  // tr/atr과 동일한 implicit unshift 패턴 — codegen이 $.close.get(0)/$.volume.get(0)을 끼워 넣는다)
  // TA_IMPLICIT_CALL bare 프로퍼티 그룹(PROGRESS.md C54 next_hint)의 첫 사례. length 자체가 없어
  // lengthArgIndex: null(cum/barssince와 동일 모양). runtime/ta.ts obv() 주석 참조 — 지금까지의
  // 다섯 가지 NaN 패턴과 다른 여섯 번째: NaN이면 state를 전혀 안 건드리고 즉시 NaN 반환.
  obv: { dispatch: "ta", displayName: "ta.obv", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.obv" },
  // ta.accdist() — Accumulation/Distribution. Pine 문법상 인자가 없고(close/high/low/volume은 bar
  // series 암묵 사용, obv와 동일한 implicit unshift 패턴) codegen이 넷을 끼워 넣는다. length 자체가
  // 없어 lengthArgIndex: null(obv/cum과 동일 모양). runtime/ta.ts accdist() 주석 참조 — ta.cum(C37)과
  // 같은 누적 모양이지만 NaN을 0으로 치환하지 않고 state를 그대로 유지(ema/rma류 패턴).
  accdist: { dispatch: "ta", displayName: "ta.accdist", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.accdist" },
  // ta.pvt() — Price Volume Trend. Pine 문법상 인자가 없고(close/volume은 bar series 암묵 사용,
  // obv와 동일한 implicit unshift 패턴) codegen이 둘을 끼워 넣는다. length 자체가 없어
  // lengthArgIndex: null(obv/accdist와 동일 모양). runtime/ta.ts pvt() 주석 참조 — obv와 같은
  // 여섯 번째 NaN 패턴(NaN이면 state 전혀 안 건드림)이지만 prevClose===0 나눗셈 가드가 추가로 있다.
  pvt: { dispatch: "ta", displayName: "ta.pvt", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.pvt" },
  // ta.wad() — Williams Accumulation/Distribution. Pine 문법상 인자가 없고(high/low/close는 bar
  // series 암묵 사용, obv/pvt와 동일한 implicit unshift 패턴) codegen이 셋을 끼워 넣는다. length
  // 자체가 없어 lengthArgIndex: null(obv/pvt와 동일 모양). runtime/ta.ts wad() 주석 참조 — obv/pvt와
  // 같은 "최초 유효 바 0.0 시드, NaN이면 state 전혀 안 건드림" 부류이나 누적값이 그 바의 range로
  // 계산한 gain(오르내림에 따라 다른 파생값).
  wad: { dispatch: "ta", displayName: "ta.wad", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.wad" },
  // ta.nvi() — Negative Volume Index. Pine 문법상 인자가 없고(close/volume은 bar series 암묵 사용,
  // obv/pvt/wad와 동일한 implicit unshift 패턴) codegen이 둘을 끼워 넣는다. length 자체가 없어
  // lengthArgIndex: null(obv/pvt/wad와 동일 모양). runtime/ta.ts nvi() 주석 참조 — obv류와 같은
  // "NaN이면 state 전혀 안 건드림" 부류이나 초기 시드가 1.0이고 prevClose===0 가드가 volume 비교
  // 조건보다 우선하는 elif 체인 최상단(pvt의 "가드 시에도 계속 갱신"과 다름).
  nvi: { dispatch: "ta", displayName: "ta.nvi", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.nvi" },
  // ta.pvi() — Positive Volume Index. nvi와 완전 대칭(volume이 직전 바보다 클 때만 복리 갱신) —
  // 상세는 nvi 주석 참조.
  pvi: { dispatch: "ta", displayName: "ta.pvi", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.pvi" },
  // ta.wvad() — Williams Variable Accumulation/Distribution. Pine 문법상 인자가 없고(open/high/low/
  // close/volume은 bar series 암묵 사용) codegen이 다섯을 끼워 넣는다(지금까지의 implicit-push
  // 그룹 중 인자 개수가 가장 많음). length 자체가 없어 lengthArgIndex: null(obv/pvt/wad/nvi/pvi와
  // 동일 모양). runtime/ta.ts wvad() 주석 참조 — obv류와 달리 **완전히 stateless**(tr(C53)과 동일
  // 부류, state 인자는 디스패치 일관성만을 위해 받고 내부에서 전혀 안 씀).
  wvad: { dispatch: "ta", displayName: "ta.wvad", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.wvad" },
  // ta.iii() — Intraday Intensity Index. Pine 문법상 인자가 없고(high/low/close/volume은 bar series
  // 암묵 사용) codegen이 넷을 끼워 넣는다. length 자체가 없어 lengthArgIndex: null. runtime/ta.ts
  // iii() 주석 참조 — wvad와 동일하게 완전히 stateless(tr류).
  iii: { dispatch: "ta", displayName: "ta.iii", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.iii" },
  // ta.ao() — Awesome Oscillator: AO = SMA(hl2,5) - SMA(hl2,34)(배치25 (3), 표준 TV 공식 정의).
  // Pine 문법상 인자가 없고(hl2는 파생 bar series 암묵 사용, obv/accdist와 동일한 implicit-
  // injection 그룹이나 파생값 하나뿐) codegen이 hl2 하나를 끼워 넣는다. length 자체가 없어
  // lengthArgIndex: null(obv류와 동일 모양). pine2py wavealgo/ta/에 대응 구현이 전혀 없어
  // 오라클 대조 불가 — DIVERGENCES.md #175 "TV 미검증(가설)" 참조. wild 재확인 결과(corpus_scan
  // C543/C544) `ta.ao()` 0-인자 폼 실사용 2건 확정, `ta.ao(close,5,34)`류 3-인자 폼 2건은
  // 실제 TV 시그니처와 불일치하는 corpus 아티팩트(C361 원칙, AI 생성 합성 코드 추정)로 스킵.
  // runtime/ta.ts ao()가 오라클로 이미 검증된 rt.ta.sma를 두 겹(5바/34바) 독립 상태로 재사용.
  ao: { dispatch: "ta", displayName: "ta.ao", argCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.ao" },
  // ta.vwap(source[, anchor[, stdev_mult]]) — Volume Weighted Average Price. Pine 문법상 volume
  // 인자가 없고 내장 bar series volume을 암묵 사용한다(vwma/mfi와 동일한 특수 케이스 —
  // codegen.genCallExpr이 $.volume.get(0)을 source(index 0) 바로 뒤에 splice해 런타임 시그니처
  // (state, source, volume[, anchor[, stdevMult[, scratch]]])를 맞춘다). length 자체가 없어
  // lengthArgIndex: null(고정폭 버퍼 없이 러닝 합계만 무한 누적). C362: TV 공식 다중 인자
  // 오버로드 — 1-인자 폼은 리셋 없는 전체 누적(pine2py vwap.py 동일 시맨틱, 오라클 골든 유지,
  // LIMITATIONS.md "ta.vwap 세션 리셋" 참조), 2-인자 폼은 anchor(series bool)가 true인 바마다
  // 누적 리셋(스칼라 반환), 3-인자 폼은 [vwap, upper, lower] 3-튜플 반환(stdev_mult 밴드 —
  // returnArityByArgCount {3:3}, 첫 인자-개수 의존 반환 arity). 2/3-인자 폼은 pine2py에 anchor
  // 개념 자체가 없어 오라클 구조적 불가 — hand-verified, DIVERGENCES 'TV 미검증(가설)' 등재.
  // anchor/stdev_mult는 length가 아니라 series 허용(lengthArgIndex 확장 불필요).
  // kwargParamNames: ["source"](C471, next_hint(C470) 지시대로 wild 재스캔 후 신규 "키워드 인자"
  // 잔여 클러스터 세분화 — `ta.vwap(source = close)` 6건이 전량 1-인자 폼. C294가 전체 kwarg
  // 지원을 [hard]로 미룬 이유(returnArityByArgCount가 taCallReturnArity(entry, expr.args.length)로
  // **원본** 위치 인자 개수만 보고 tuple-arity를 판정하므로, anchor/stdev_mult까지 kwarg로 등재하면
  // 완전-키워드 3-인자 호출에서 expr.args.length=0이 되어 3-튜플 반환을 스칼라로 오판할 여지가
  // 있었음)는 anchor/stdev_mult를 이 목록에 넣지 않는 한 발현 불가 — source 하나만 등재하면
  // resolveTaKwargPositions가 index 0만 채우고, analyzeStatefulCall의 기존 "위치+키워드 중복"
  // 가드가 나머지 위치를 그대로 지켜 resolvedArgs.length가 항상 expr.args.length와 일치한다
  // (오라클: pine2py wavealgo/ta/vwap.py 첫 파라미터명이 정확히 "source"라 kwarg 폼도 위치 폼과
  // 동일한 값을 내는 진짜 오라클 대조 가능 — oracle/cases/ta_vwap_kwargs.pine).
  vwap: {
    dispatch: "ta",
    displayName: "ta.vwap",
    argCount: 3,
    minArgCount: 1,
    lengthArgIndex: null,
    conditionalForbidden: true,
    rtPath: "rt.ta.vwap",
    returnArityByArgCount: { 3: 3 },
    kwargParamNames: ["source"],
  },
  // ta.pivothigh(source, left, right) / ta.pivotlow(source, left, right) — source.get(right)(right바
  // 지연 후보)가 창 [0..left+right] 전체에서 최댓값/최솟값이면 그 값을, 아니면 NaN을 반환(동률은
  // 성립 허용, 엄격 부등호만 거부). 새 상태 없이 length=left+right+1짜리 rt.ta.highest/rt.ta.lowest
  // (C42 ExtremeState)를 그대로 호출하는 합성(hma/stoch류 "이미 구현된 TA 재사용" 원칙) —
  // runtime/ta.ts pivothigh()/pivotlow() 주석 참조. left/right 둘 다 ExtremeState 버퍼 크기(창 전체
  // 폭)와 candidate 오프셋을 결정하므로 tsi(C49)와 동일하게 lengthArgIndex를 배열 [1, 2]로 등록해
  // 둘 다 series면 하드 에러.
  // kwargParamNames: ["source","leftbars","rightbars"](C402, next_hint(C401) 1순위 — wild
  // ed93509e928c.pine의 ta.sma kwarg를 해소하며 같은 파일에서 캐스케이드로 재노출, C249). pivotlow
  // (C400)와 완전히 동일한 구조로 대칭 추가 — pine2py pivot.py의 pivothigh(source, left=5, right=5,
  // **kwargs)도 내부 파라미터명이 left/right(TV 공식 leftbars/rightbars와 다름)라 leftbars=/rightbars=
  // kwarg가 크래시 없이 **kwargs로 조용히 흡수·기본값 유지 — 오라클 구조적 불가는 pivotlow와 동일
  // (DIVERGENCES #151/LIMITATIONS.md 참조), pine2js 자신의 정확성은 codegen 동치성으로 hand-verified.
  // minArgCount:2 + sourceOmittable:true(C509, wild 최다 서브클러스터 147건 — next_hint(C508)가
  // 지목한 '예상치 못한 들여쓰기 블록'은 C360이 이미 109/109 pine2py 오라클 거부로 확정 스킵했음을
  // 재확인해 대신 착수). TV 공식 오버로드 `ta.pivothigh(leftbars, rightbars)`(source 생략, 암묵 high)
  // — highest/lowest(C250)와 동일 패턴이나 pine2py pivot.py는 이 형태에 대한 런타임 스니핑이 없어
  // (C250 주석이 이미 "범위 밖" 근거로 남겨둔 그 사실) 오라클로 새 골든을 낼 수 없다. 그러나 그건
  // "pine2py 오라클이 이 오버로드를 지원 못 함"이지 "TV가 지원 안 함"이 아니다 — wild corpus에서
  // 147건(pivothigh)+8건(pivotlow)이 이 정확한 2-인자 형태로 실사용돼 TV 문법임이 사실상 확정되므로,
  // atr/alma/crossover/pivotlow-이름불일치(C402)와 동일한 "codegen 동치성 hand-verified" 원칙으로
  // 이식한다(오라클 불가일 뿐 구현 자체는 highest/lowest와 대칭). source 생략 시 codegen이 pivothigh는
  // $.high.get(0), pivotlow는 $.low.get(0)을 leftbars 앞에 unshift(codegen.ts genCallExpr 참조).
  // seriesLengthOk: true(배치25 (4) 계속, next_hint(C551) — pine2py pivot.py도 highest.py와 동일한
  // 무상태 재스캔이라 left/right 둘 다 series여도 #178과 같은 축으로 가변 length 골든 오라클이
  // 성립함을 python 직접 실행으로 확인, runtime/ta.ts pivothighVarLen/pivotlowVarLen 참조). left/right
  // 둘 다 lengthArgIndex [1, 2] 그대로 유지 — 둘 중 하나만 series여도 varlen 경로로 분기.
  pivothigh: {
    dispatch: "ta",
    displayName: "ta.pivothigh",
    argCount: 3,
    minArgCount: 2,
    sourceOmittable: true,
    lengthArgIndex: [1, 2],
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.pivothigh",
    kwargParamNames: ["source", "leftbars", "rightbars"],
  },
  pivotlow: {
    dispatch: "ta",
    displayName: "ta.pivotlow",
    argCount: 3,
    minArgCount: 2,
    sourceOmittable: true,
    lengthArgIndex: [1, 2],
    seriesLengthOk: true,
    conditionalForbidden: true,
    rtPath: "rt.ta.pivotlow",
    kwargParamNames: ["source", "leftbars", "rightbars"],
  },
  // ta.supertrend(factor, atrPeriod) — the fourth multi-return TA (returnArity: 2, [value, direction]),
  // and the first non-3-arity use of the C50 infra (macd/bb/kc were all 3) — confirms the infra
  // generalizes to arbitrary arity with 0 analyzer/codegen changes (runtime/ta.ts supertrend() 주석
  // 참조). pine2py wavealgo/ta/supertrend.py 소스 대조 결과 basicUpper/Lower=hl2±factor*atr(atrPeriod)
  // (이미 구현된 rt.ta.atr 재호출)에 band-hold/direction-flip 상태 머신을 얹은 순수 O(1) 함수 —
  // atrPeriod가 내부 AtrState(RMA)의 초기화 구간을 결정하므로 sma와 동일하게 lengthArgIndex: 1
  // (series 하드 에러); factor는 최종 산술에만 쓰여 series 허용(kc의 mult과 동일 이유). Pine
  // 문법에 high/low/close 인자가 없어 codegen이 $.high.get(0)/$.low.get(0)/$.close.get(0)(현재
  // close)/$.close.get(1)(prevClose, atr용)을 앞에 unshift한다(atr/kc와 동일 패턴 + 현재 close
  // 슬롯 하나 추가).
  supertrend: {
    dispatch: "ta",
    displayName: "ta.supertrend",
    argCount: 2,
    lengthArgIndex: 1,
    conditionalForbidden: true,
    rtPath: "rt.ta.supertrend",
    returnArity: 2,
  },
  // ta.sar(start, inc, maxAf) — Parabolic SAR. pine2py wavealgo/ta/sar.py 소스 대조 결과 다른
  // ta.*와 달리 이미 구현된 TA를 재사용하지 않는 자체 9-필드 상태 머신(runtime/ta.ts sar() 주석
  // 참조) — 단일 반환(returnArity 없음). start/inc/maxAf 셋 다 매 호출 그 값 자체로만 쓰이고
  // 고정폭 버퍼/초기화 구간을 결정하지 않아(rising/falling과 동일 이유) lengthArgIndex: null —
  // series여도 결과가 정확. Pine 문법에 high/low/close 인자가 없어 codegen이 $.high.get(0)/
  // $.low.get(0)/$.close.get(0)을 앞에 unshift한다(atr/supertrend와 동일 패턴이나 prevClose는
  // sar 자신이 state로 추적하므로 $.close.get(1) 주입 불필요).
  sar: { dispatch: "ta", displayName: "ta.sar", argCount: 3, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.sar" },
  // ta.dmi(diLength, adxSmoothing) — Directional Movement Index (returnArity: 3, [plusDi, minusDi,
  // adx]). pine2py wavealgo/ta/dmi.py 소스 대조 결과(runtime/ta.ts dmi() 주석 참조) diLength는 자체
  // Wilder 단일값-시드 스무딩(smoothTr/smoothPlus/smoothMinus)의 alpha=1/diLength를 고정하고,
  // adxSmoothing은 dx를 rt.ta.rma에 합성 호출할 때 워밍업/블렌드 구간을 고정한다 — 둘 다 sma/tsi와
  // 동일 이유로 series면 하드 에러(lengthArgIndex: [0, 1]). Pine 문법에 high/low/close 인자가 없어
  // codegen이 $.high.get(0)/$.low.get(0)/$.close.get(0)/$.high.get(1)/$.low.get(1)/$.close.get(1)
  // 여섯 개(지금까지 최다, dmi.py L74-79 순서 그대로)를 diLength/adxSmoothing 앞에 unshift한다.
  dmi: { dispatch: "ta", displayName: "ta.dmi", argCount: 2, lengthArgIndex: [0, 1], conditionalForbidden: true, rtPath: "rt.ta.dmi", returnArity: 3 },
  // math.sum(source, length) — 고정폭 슬라이딩 윈도우 합계. pine2py wavealgo/math.sum(*args) 소스
  // 대조 결과 `hasattr(source,'get') and hasattr(source,'__len__')`인 경우에만(즉 source가 실제
  // Series 객체일 때만) 창 [0, min(length,len(source)))의 non-na 값만 걸러 합산하고, 그 외(스칼라)는
  // `builtins.sum(args)`로 폴백해 사실상 `source+length`를 반환하는 완전히 다른(잘못된) 값을 낸다.
  // pine2py 생성 코드는 CONTEXT_DATA_VARS(open/high/low/close/volume 등) bare 식별자를 직접 넘길
  // 때만 진짜 Series 객체가 전달되고, `x = ta.sma(close,3)` 같은 계산된 변수는 스칼라 float이라
  // 이 폴백 버그를 탄다(scratch로 `wa_sum(5.0,3)==8.0` 직접 확인) — 실제 TV math.sum(source,length)은
  // source가 어떤 series float 식이든 동작하는 범용 윈도우 함수이므로 이 스칼라 폴백은 pine2py
  // latent 버그로 판단(GOAL.md "pine2py의 알려진 버그는 따르지 않는다", DIVERGENCES.md #15).
  // pine2js는 애초에 모든 인자가 codegen에서 스칼라로 낮춰지므로(GOAL.md "명시적 .get(0)") sma류와
  // 동일하게 taSlots 순환 버퍼로 이식 — length가 버퍼 크기를 고정하므로 sma와 동일하게
  // lengthArgIndex: 1(series 하드 에러). NaN 처리는 sma(포이즌)와 달리 pine2py 소스의
  // `if not isnan(val): total += val`를 그대로 따라 NaN은 항상 기여 0(runtime/ta.ts sum() 주석
  // 참조) — 전부 na여도 na가 아니라 0.0을 반환한다.
  // C551: seriesLengthOk true — pine2py math.sum도 상태 없이 매 호출 min(length, dataLen)만큼
  // 재스캔하는 무상태 함수(get_ta_state 미사용, python 직접 실행 확인)라 가변 length 오라클
  // 성립(runtime/ta.ts sumVarLen 참조, stdevVarLen과 다르게 워밍업 NaN 게이트 자체가 없음).
  sum: { dispatch: "math", displayName: "math.sum", argCount: 2, lengthArgIndex: 1, seriesLengthOk: true, conditionalForbidden: true, rtPath: "rt.ta.sum" },
  // math.random(min=0.0, max=1.0, seed) — C120, math.* 잔여 마지막 항목. pine2py wavealgo/math/
  // __init__.py L102-106: `random(min_val=0.0, max_val=1.0, seed=None)`가 Python 표준 random
  // 모듈(전역 Mersenne Twister)의 seed()+uniform()에 위임한다 — seed를 줘도 CPython MT19937
  // 알고리즘 자체를 JS로 재이식해야 bit-parity가 가능해(방대·저가치, C119 next_hint 조사)
  // **오라클 크로스체크가 이 함수 전체(정상 경로 포함)에 구조적으로 불가능한 첫 사례**(alma의
  // sigma=0처럼 일부 경계만 갈리는 게 아니라 전체 값 도메인이 대상). pine2js는 콜사이트별 독립
  // 상태(rt.taSlots)에 자체 xorshift32 PRNG(SplitMix32 믹싱으로 시드)를 신설(runtime/ta.ts
  // random() 주석 참조) — TV 실제 PRNG 알고리즘도 비공개·비결정 문서화라 "정답"이 없으므로 값
  // 자체는 오라클/hand-verified 비교 대상에서 제외하고 범위/seed 재현성만 검증한다(LIMITATIONS.md/
  // DIVERGENCES.md 등재). TV 문법상 min/max/seed 셋 다 선택 인자(기본 0.0/1.0/na) — 첫 선택 인자
  // stateful 콜이라 minArgCount:0 신설(TaRegistryEntry 주석 참조). length 인자가 없어
  // lengthArgIndex: null. codegen이 누락 인자를 "undefined" 리터럴로 패딩하고 콜사이트 slot을
  // 숨은 4번째 인자(site)로 항상 추가 주입한다(genCallExpr `stateCall.fn === "random"` 분기) —
  // site는 seed가 한 번도 안 주어졌을 때의 기본 시퀀스를 콜사이트마다 다르게 만드는 용도일 뿐 TV
  // 시맨틱과 무관한 pine2js 내부 구현 디테일.
  random: { dispatch: "math", displayName: "math.random", argCount: 3, minArgCount: 0, lengthArgIndex: null, conditionalForbidden: true, rtPath: "rt.ta.random" },
};

// ta.* kwargs 지원 콜(entry.kwargParamNames)의 위치+키워드 인자를 위치 인자 배열 하나로 정규화한다
// (C400 — UDT `.new()`의 C129 "위치/키워드 슬롯 병합" 패턴과 동일 발상). 순수 함수 — 검증/에러
// 보고는 하지 않고(analyzeStatefulCall이 이 반환값으로 직접 수행) analyzer/codegen 양쪽이 공유해
// 항상 같은 결과를 낸다(analyzer가 이미 통과시킨 콜사이트만 codegen이 다시 보므로 재계산이 안전).
// kwargs가 없거나(가장 흔한 경로) 이 함수가 kwargs 자체를 지원하지 않으면(kwargParamNames 없음)
// expr.args를 그대로 반환 — 기존 전부와 바이트 동일 동작(회귀 없음). 이름이 안 맞는 kwarg는 조용히
// 버리지 않고 그 자리를 구멍(undefined)으로 남긴다 — analyzeStatefulCall의 이름/구멍 검사가 잡는다.
export function resolveTaKwargPositions(expr: CallExpr, entry: TaRegistryEntry): (Expr | undefined)[] {
  if (expr.kwargs.length === 0 || entry.kwargParamNames === undefined) return expr.args;
  const paramNames = entry.kwargParamNames;
  const resolved: (Expr | undefined)[] = [...expr.args];
  for (const kw of expr.kwargs) {
    const idx = paramNames.indexOf(kw.name);
    if (idx >= 0) resolved[idx] = kw.value;
  }
  return resolved;
}

// TA_REGISTRY에 등록된 콜사이트 하나를 검증/등록하는 단일 진입점(위 TA_REGISTRY 주석 참조) —
// 인자 개수 검증, 조건부 위치 거부(if 분기 본문은 C64부터 허용 — firstForbiddenKind),
// 상태 슬롯 등록(거부되지 않은 콜사이트만), length 인자 series 하드 에러까지 함수 종류와 무관하게
// 한 곳에서 처리한다. 새 stateful 함수를 추가할 때는 이 함수를 건드릴 필요 없이 TA_REGISTRY에
// 항목만 추가하면 된다.
export function analyzeStatefulCall(
  expr: CallExpr,
  name: string,
  entry: TaRegistryEntry,
  prog: AnalyzedProgram,
  scope: LexScope,
): void {
  // C400: kwargs(source=/length=/source1=/source2=/leftbars= 등, entry.kwargParamNames 참조) —
  // 이름/중복/위치-키워드 충돌/구멍(예: source를 안 주고 length만 이름으로 준 경우)을 여기서 전부
  // 검증한다. resolvedArgs는 검증 통과 여부와 무관하게 항상 계산되고(에러가 있으면 어차피 pipeline이
  // codegen 전에 멈춘다), 아래 인자 개수/length series 검사가 expr.args 대신 이 배열을 쓴다 — kwargs가
  // 없으면 resolvedArgs===expr.args(같은 배열 참조)라 기존 검사와 완전히 동일하게 동작한다.
  const resolvedArgs = resolveTaKwargPositions(expr, entry);
  if (expr.kwargs.length > 0) {
    if (entry.kwargParamNames === undefined) {
      // 이 슬라이스 대상이 아닌 TA_REGISTRY 함수에 kwargs가 온 경우 — 호출부(call-expr.ts)의
      // blanket kwargs 거부가 이미 에러를 냈으므로(이 함수까지 kwargs를 들고 도달하는 기존 경로,
      // isTaKwargCall 예외에 없는 함수는 그대로 거부 유지) 여기서 또 등재할 필요는 없다.
    } else {
      const paramNames = entry.kwargParamNames;
      const filledPositions = new Set<number>();
      for (let i = 0; i < expr.args.length; i++) filledPositions.add(i);
      for (const kw of expr.kwargs) {
        const idx = paramNames.indexOf(kw.name);
        if (idx === -1) {
          prog.errors.push(`'${entry.displayName}'에 없는 인자 이름: '${kw.name}=' (L${kw.line}:${kw.col})`);
        } else if (idx < expr.args.length) {
          if (!isHarmlessArgDup(expr.args[idx], kw.value)) {
            prog.errors.push(
              `인자 '${kw.name}'이(가) 위치 인자와 키워드 인자로 중복 지정됨 (L${kw.line}:${kw.col})`,
            );
          }
        } else if (filledPositions.has(idx)) {
          prog.errors.push(`키워드 인자 '${kw.name}' 중복 지정 (L${kw.line}:${kw.col})`);
        } else {
          filledPositions.add(idx);
        }
      }
      const maxFilled = filledPositions.size === 0 ? -1 : Math.max(...filledPositions);
      for (let i = 0; i < maxFilled; i++) {
        if (!filledPositions.has(i)) {
          prog.errors.push(
            `'${entry.displayName}' 호출에 '${paramNames[i]}' 인자가 누락됨(뒤 인자가 이름으로 지정됨): (L${expr.line}:${expr.col})`,
          );
        }
      }
    }
  }
  const minArgCount = entry.minArgCount ?? entry.argCount;
  if (resolvedArgs.length < minArgCount || resolvedArgs.length > entry.argCount) {
    const need =
      minArgCount === entry.argCount ? `${entry.argCount}개` : `${minArgCount}~${entry.argCount}개`;
    prog.errors.push(
      `'${entry.displayName}' 호출 인자 개수 불일치: ${need} 필요, ${resolvedArgs.length}개 전달 (L${expr.line}:${expr.col})`,
    );
  }
  // C64/C65: if 분기 본문/switch case 본문(cond-body 체인)은 per-call 상태 전진이 TV/pine2py와
  // 동형이라 허용(oracle/cases/cond_if_ta.pine·cond_switch_ta.pine — "호출된 바에서만 상태 전진"을
  // 골든으로 수치 확정). C66: 삼항/and·or lazy 위치(lazy-expr)는 codegen eager 호이스팅으로 허용.
  // C161: for/while 본문(loop-body)은 "호출될 때마다 상태 전진"(반복마다 1회)으로 허용 —
  // pine2py와 동형(oracle/cases/cond_loop_ta.pine 골든으로 수치 확정), TV 실측은 미검증 가설
  // (DIVERGENCES.md 참조 — VERIFIED_SEMANTICS의 조건부 per-call CONFIRMED를 루프에 외삽).
  // C162: UDF/method 본문(udf-body)은 함수-상대 슬롯 + 콜사이트별 __taBase 전파로 허용
  // (oracle/cases/cond_udf_ta.pine — 단일 콜사이트 골든, 다중 콜사이트는 hand-verified).
  // C260: elif 조건/switch case 값/while 조건의 직접 호출(and/or lazy 우변 밖)도 허용 —
  // firstForbiddenKind 주석 참조. 남은 거부 위치는 그 조건 안의 lazy-expr(and/or 우변)뿐이다.
  const forbiddenKind = entry.conditionalForbidden ? firstForbiddenKind(scope) : null;
  if (forbiddenKind !== null) {
    prog.errors.push(
      `'${entry.displayName}' 호출은 이 조건부 블록 위치에서 아직 지원하지 않음 — ${FORBIDDEN_KIND_DESC[forbiddenKind]} (if 분기/switch case 본문·삼항/and/or lazy 위치·elif 조건/switch case 값/while 조건의 직접 호출은 허용, ROADMAP P2 조건부 stateful call 항목): (L${expr.line}:${expr.col})`,
    );
    return;
  }
  if (scope.func !== null) {
    // UDF/method 본문 안(C162): 함수-상대 슬롯을 등록한다 — 전역 taSlotCount는 여기서 늘리지
    // 않고, 이 함수를 부르는 각 콜사이트가 localTaSlotCount칸씩 새로 배정받는다
    // (analyzeUserFuncCall/analyzeUdtMethodCall의 funcTaBases — fnVars slotBase와 동형).
    prog.stateCallSlots.set(expr, { fn: name, slot: scope.func.localTaSlotCount, inUdf: true });
    scope.func.localTaSlotCount += 1;
  } else {
    prog.stateCallSlots.set(expr, { fn: name, slot: prog.taSlotCount });
    prog.taSlotCount += 1;
  }
  const callReturnArity = taCallReturnArity(entry, expr.args.length);
  if (callReturnArity !== undefined) {
    // 다중 반환 콜이 실제로 등장했으니 Context.taScratch가 그 반환 개수만큼은 필요하다
    // (엔진이 이 값으로 공유 스크래치 배열을 1회 사전할당 — AnalyzedProgram.taScratchSize 주석 참조).
    // C362: vwap처럼 인자 개수에 따라 arity가 달라지는 항목은 이 콜사이트의 실제 arity로만 반영
    // (1/2-인자 vwap만 있는 스크립트는 스크래치가 커지지 않음) — taCallReturnArity 주석 참조.
    prog.taScratchSize = Math.max(prog.taScratchSize, callReturnArity);
  }
  // length 인자가 series면 하드 에러: rt.ta.<이름>은 첫 호출의 length로 고정폭 버퍼/초기화 구간
  // 상태를 한 번만 굳히므로, 바마다 값이 바뀌면 그 상태가 조용히 틀어진다(pine2py PARAM_CONSTRAINTS는
  // 경고만 하지만 pine2js incremental 구조는 이 조건에서 실제로 깨짐 — analyzer.ts 상단 주석 참조).
  // 인덱스가 여럿(예: ta.tsi의 short_length/long_length, C49)이면 전부 동일하게 검사한다.
  // sourceOmittable(C250)이 true이고 실제로 source가 정확히 1개 생략된 유효 호출(args.length ===
  // argCount - 1)이면 뒤 인자들이 전부 한 칸씩 앞으로 밀리므로 lengthArgIndex도 동일하게 1칸 당겨서
  // 검사해야 한다 — 그러지 않으면 `ta.highest(length)`(1-인자)에서 length가 args[0]인데 원래
  // 인덱스(1)로 계속 찾아 검사 자체가 조용히 스킵된다. **정확히 argCount-1일 때만** 적용(위 인자
  // 개수 검증이 이미 실패한 그 외 개수(예: 0개)에서 shift를 계속 키우면 idx가 음수로 내려가 배열
  // 밖 접근이 된다 — args.length>idx 가드는 idx가 음수면 무력화됨).
  const omittedLeadingArgs = entry.sourceOmittable && resolvedArgs.length === entry.argCount - 1 ? 1 : 0;
  const lengthArgIndices =
    entry.lengthArgIndex === null
      ? []
      : Array.isArray(entry.lengthArgIndex)
        ? entry.lengthArgIndex.map((idx) => idx - omittedLeadingArgs)
        : [entry.lengthArgIndex - omittedLeadingArgs];
  for (const idx of lengthArgIndices) {
    // resolvedArgs[idx]가 undefined(구멍)면 위 이름/구멍 검증이 이미 에러를 냈으므로 여기서는
    // 조용히 건너뛴다(series 하드 에러까지 중복 보고할 필요 없음).
    if (resolvedArgs.length > idx && resolvedArgs[idx] !== undefined && inferQualifier(resolvedArgs[idx]!, prog, scope) === "series") {
      if (entry.seriesLengthOk) {
        // seriesLengthOk 함수(highest/lowest/sma/highestbars/lowestbars/median/linreg/wma/stdev/sum/
        // pivothigh/pivotlow) 전용 —
        // 하드 에러 대신 codegen이 state-fixed rtPath를 우회하도록 표시만 한다(genCallExpr의
        // stateCall.seriesLength 분기, runtime/ta.ts highestVarLen/smaVarLen 참조).
        prog.stateCallSlots.get(expr)!.seriesLength = true;
        continue;
      }
      prog.errors.push(
        `'${entry.displayName}'의 length 인자는 'series'일 수 없음(바마다 값이 바뀌면 고정폭/초기화 구간 상태가 깨짐): (L${expr.line}:${expr.col})`,
      );
    }
  }
}
