// Context: 바-루프 실행 컨텍스트. 상태는 정수 슬롯 배열 + plain object (클로저 금지 - GOAL.md).
// var/varip 상태 -> $.vars[slot] (number, 최초 undefined로 "미초기화" 표시).
// TA 상태 -> $.taSlots[slot] (plain object, Context 생성 시 미리 할당해 콜사이트별 독립 보장).
// UDF 내부 var/varip 상태 -> $.fnVars[slotBase+localSlot] (number) — $.vars와 별도 배열인 이유:
// 콜사이트별 슬롯 베이스가 $.vars의 이름 있는 top-level 슬롯과 같은 배열을 공유하면 오라클
// 스냅샷(var:<name> 채널, engine.ts run())의 이름 유일성 가정이 깨진다(같은 함수의 서로 다른
// 콜사이트가 같은 지역변수 이름을 재사용하므로). 완전히 분리해 이 문제를 원천 차단한다.
// 슬롯 타입에 string|null이 섞인 이유("na/수치 2c-ii" concat): var string 선언은 이 배열에 문자열을
// 그대로 저장한다(GOAL.md na 시맨틱 — 참조형 na는 null). number[]는 array.*(C79) — Pine array는
// 참조 타입이라 var 슬롯이 JS 배열 참조를 그대로 담는다(string과 동일한 참조형 저장 선례).
// 생성된 코드는 `new Function`으로 실행되는
// 순수 동적 타입 JS라 이 타입 확장 자체는 런타임 동작을 바꾸지 않는다 — 이 배열을 직접 다루는 TS
// 소스(engine.ts)가 이미 `as number`로 명시 캐스팅하고 있어 여기서도 컴파일 영향이 없다.

import { Series, RefSeries } from "./series";
import { StrategyState } from "./strategy";
import { build as buildSecurityCache, type SecurityCache } from "./security";

export interface OHLCVData {
  open: ArrayLike<number>;
  high: ArrayLike<number>;
  low: ArrayLike<number>;
  close: ArrayLike<number>;
  volume: ArrayLike<number>;
  // request.security(ROADMAP P2 [hard->분할]) 0번째 슬라이스 — 바 open 시각(unix ms, TV time
  // 빌트인과 동일 단위). 옵셔널: 미지정 시 기존 동작 완전 무변화(C129 원칙과 동형). 달력 기반 HTF
  // 집계(pine2py SecurityManager._aggregate_by_time 이식분, 다음 슬라이스)가 이 채널의 유무로
  // 나이브 count 폴백과 분기할 예정 — 이 슬라이스는 request.security 자체를 구현하지 않는다.
  time?: ArrayLike<number>;
}

export class Context {
  vars: (number | string | number[] | null | undefined)[];
  taSlots: Record<string, unknown>[];
  // 다중 반환 TA(rt.ta.macd 등)가 튜플 대신 쓰는 공유 스크래치 배열(GOAL.md "다중 반환 TA는
  // 재사용 스크래치 배열" — bar loop 안 배열 생성 금지). 크기는 analyzer가 스크립트에 실제로
  // 등장하는 다중 반환 콜의 최대 반환 개수로 계산(taScratchSize, 없으면 0). 콜사이트별 분리가
  // 필요 없는 이유: codegen이 "TA 콜 문장 실행 → 즉시 대상 변수로 복사"를 한 문장 블록으로
  // 내리므로 다음 stateful 콜 전에 항상 소비가 끝난다.
  taScratch: Float64Array;
  fnVars: (number | string | number[] | null | undefined)[];
  histSlots: Series[];
  // drawing 핸들(line/label/box/table) '=' 로컬 히스토리 전용 object 원형 버퍼(배치25 (1), series.ts
  // RefSeries 주석 참조) — histSlots와 나란한 별도 배열. 슬롯 개수는 histSlots와 무관하게 독립
  // 카운트(analyzer의 refHistorySlotCount)라 이 배열 자체가 대부분의 스크립트에서 길이 0.
  refHistSlots: RefSeries[];
  // 조건부(if/for/while) 위치 stateful 콜 히스토리 전용(C671, analyzer.ts condCallHistorySlots
  // 주석 참조) — histSlots와 나란한 별도 배열이지만 결정적으로 advance()가 이 배열은 건드리지
  // 않는다. 각 슬롯의 커서 전진은 오직 그 슬롯 자신의 Series.push() 호출(codegen이 그 콜이 실제로
  // 실행되는 정확한 코드 위치에서만 내보냄)로만 일어나 "호출된 횟수"로 전진하는 압축 인덱스가 된다.
  condCallHistSlots: Series[];
  // drawing 생성자 콜(line.new/label.new/box.new/table.new 등) 결과의 인라인 히스토리 인덱싱
  // 전용(C700, wild `line.delete(line.new(...)[1])`류 "직전 도형 지우기" 관용구) — condCallHistSlots와
  // 동일한 push() 압축(call-count) 인덱스지만 물리 배열이 RefSeries(object 원형 버퍼, drawing 핸들은
  // Float64Array에 못 담김)다. condCallHistSlots와 마찬가지로 advance()가 건드리지 않는다.
  condCallRefHistSlots: RefSeries[];
  open: Series;
  high: Series;
  low: Series;
  close: Series;
  volume: Series;
  // input.*(C131) 외부 오버라이드 dict — title 문자열 키로 우선 조회(rt.input.* 참조). 호출측이
  // 안 넘기면 빈 객체(전부 defval로 폴백, pine2py의 "오버라이드 없음" 경로와 동치).
  inputs: Record<string, unknown>;
  // plot 수집 채널(C135, GOAL.md "plot은 Float64Array 수집 채널") — 콜사이트별로 독립된
  // Series.preallocate(histSlots와 동일 원칙, 바 개수를 미리 아는 배치 특성 재사용). record()가
  // codegen이 방출한 `$.plots[N].record(value)`로 매 바 채워지고, 바 루프가 끝난 뒤
  // engine.ts run()이 Series.toArray()로 순수 배열로 뽑아 RunResult.plots에 노출한다.
  plots: Series[];
  // barstate.*/session.*(ROADMAP P2) 전용 0-based 현재 바 인덱스 — pine2py wavealgo Context.idx와
  // 동형(push_bar가 0,1,2,...로 순증가시키는 index를 그대로 대입, context.py L155). advance()가
  // 매 바 1씩 전진시키고, barCount(기존 getter)가 pine2py의 Context.length(고정 총 바 수)에 대응.
  idx: number;
  // strategy.* 브로커 상태(C163 첫 슬라이스 — 롱-온리 마켓 주문/포지션). 지시어 유무와 무관하게
  // 항상 생성한다(주문 콜이 없으면 processFills가 매 바 boolean 체크 2회로 끝나는 완전 무해 상태
  // — plots처럼 슬롯 개수 파라미터가 필요 없어 엔진 run() 시그니처 변경 0). 트랜스파일 출력이
  // `$.strategy.entry(...)`/`$.strategy.posSize`로 직접 접근한다($.plots[n].record와 동일한
  // "Context 채널 직결" 관례, rt 경유 없음).
  strategy: StrategyState;
  // request.security 0번째 슬라이스(선행 작업) — pine2py ctx._time_data(context.py:63, 바별 raw
  // 배열)와 동형. Series로 감싸지 않는 이유: HTF 집계는 idx로 직접 lookup하는 바 루프 밖 사전계산
  // 패스라(다음 슬라이스) get(0)/history 접근이 필요 없다 — pine2py 원본도 동일하게 raw list.
  // 미지정(대부분의 기존 오라클 케이스)이면 undefined로 남아 이 채널을 참조하는 코드가 아직 없다.
  time: ArrayLike<number> | undefined;
  // request.security 첫 슬라이스 — 콜사이트(analyzer가 소스 등장 순서로 배정한 slot)별 HTF 집계
  // 캐시(security.ts SecurityCache 참조). tf가 컴파일타임 리터럴이라 첫 호출까지 미룰 이유가 없어
  // Context 생성 시 전부 즉시 계산해둔다("바 루프 밖에서 timeframe당 1회" 원칙을 문자 그대로 구현 —
  // 여기서는 "1회"가 매 콜사이트 1회, 바 루프 자체는 이 배열 생성 이후에 시작).
  securityCache: SecurityCache[];
  // request.security 셋째 슬라이스 서브슬라이스 3b(ROADMAP [hard->분할]) — securityCache와 같은
  // slot 번호 공간을 공유하는 표현식 콜사이트 전용 캐시(3a securityExprCallSlots.slot). 여기서는
  // 빈 슬롯만 준비한다 — bare series 콜사이트(securityCallSlots)의 slot은 영원히 undefined로
  // 남고(3c 이후로도 참조 안 됨), 실제 계산은 codegen이 생성한 프리앰블의 `__secExprN()` 호출이
  // Context 생성 직후(팩토리 호출 시점) 채운다(codegen.ts generateSecurityExprPreamble 참조) —
  // securityCache처럼 생성자 자신이 즉시 계산하지 못하는 이유는 그 계산이 genExpr 재사용(사용자
  // Pine 표현식 코드젠)을 필요로 해 런타임 모듈에서 만들 수 없기 때문이다.
  securityExprCache: (Float64Array | undefined)[];
  // 배치31 (a, C597) — request.security 런타임 tf 슬롯(analyzer.ts securityRuntimeTfSlots) 재빌드용
  // 원본 OHLCV 참조. open/high/low/close/volume은 위에서 이미 Series로 감싸 저장하지만(reverse
  // access 전용, raw 배열 노출 없음) buildSecurityCache는 forward ArrayLike가 필요해 원본을 그대로
  // 보관한다 — Context 생성자 인자 그대로라 새 메모리 할당/복사 없음.
  private rawData: OHLCVData;

  constructor(
    data: OHLCVData,
    varSlotCount: number,
    taSlotCount: number,
    fnVarSlotCount: number = 0,
    historySlotCount: number = 0,
    taScratchSize: number = 0,
    inputs: Record<string, unknown> = {},
    plotSlotCount: number = 0,
    securityTfs: readonly string[] = [],
    refHistorySlotCount: number = 0,
    condCallHistorySlotCount: number = 0,
    condCallRefHistorySlotCount: number = 0,
  ) {
    this.vars = new Array(varSlotCount).fill(undefined);
    this.taSlots = Array.from({ length: taSlotCount }, () => ({}));
    this.taScratch = new Float64Array(taScratchSize);
    this.fnVars = new Array(fnVarSlotCount).fill(undefined);
    this.histSlots = Array.from({ length: historySlotCount }, () => Series.preallocate(data.close.length));
    this.refHistSlots = Array.from({ length: refHistorySlotCount }, () => RefSeries.preallocate(data.close.length));
    this.condCallHistSlots = Array.from({ length: condCallHistorySlotCount }, () => Series.preallocate(data.close.length));
    this.condCallRefHistSlots = Array.from({ length: condCallRefHistorySlotCount }, () => RefSeries.preallocate(data.close.length));
    this.open = new Series(data.open);
    this.high = new Series(data.high);
    this.low = new Series(data.low);
    this.close = new Series(data.close);
    this.volume = new Series(data.volume);
    this.inputs = inputs;
    this.plots = Array.from({ length: plotSlotCount }, () => Series.preallocate(data.close.length));
    this.idx = -1;
    this.strategy = new StrategyState();
    this.time = data.time;
    this.rawData = data;
    this.securityCache = securityTfs.map((tf) =>
      buildSecurityCache(data.open, data.high, data.low, data.close, data.volume, data.time, tf),
    );
    this.securityExprCache = new Array(securityTfs.length).fill(undefined);
  }

  // 배치31 (a, C597) — request.security tf가 simple/input 한정자 표현식일 때, codegen 프리앰블
  // (바 루프 시작 전, ctx당 1회)이 그 식을 evaluate한 값으로 이 슬롯을 다시 빌드한다. 생성자가
  // securityTfs[slot] 자리표시(prog.chartTf)로 이미 무해하게 채워둔 것을 덮어쓸 뿐이라, 이 메서드가
  // 호출되지 않는 슬롯(기존 컴파일타임 리터럴 전량)은 동작이 한 글자도 안 바뀐다.
  rebuildSecurityCache(slot: number, tf: string): void {
    this.securityCache[slot] = buildSecurityCache(
      this.rawData.open,
      this.rawData.high,
      this.rawData.low,
      this.rawData.close,
      this.rawData.volume,
      this.rawData.time,
      tf,
    );
  }

  get barCount(): number {
    return this.close.length;
  }

  // TV 시각 변수(hour/year/dayofweek/time_tradingday, C242) 전용 — pine2py wavealgo/context.py
  // Context.time 프로퍼티와 동형(this.time이 없거나 범위를 벗어나면 0, GOAL.md "알려진 버그는
  // 따르지 않는다" 대상이 아니라 양쪽 다 시간 데이터가 없을 때의 "인프라 부재" 기본값 — ta.vwap
  // C59와 동일 원칙). genIdentifier가 "time" bare 식별자와 년/월/일/시/분/초/거래일 파생 계산의
  // 공통 입력으로 그대로 방출한다.
  get barTimeMs(): number {
    return this.time !== undefined && this.idx < this.time.length ? this.time[this.idx]! : 0;
  }

  // last_bar_time — pine2py Context.last_bar_time과 동형(전체 time 배열의 마지막 원소, 바 루프
  // 진행과 무관하게 항상 같은 값).
  get lastBarTimeMs(): number {
    return this.time !== undefined && this.time.length > 0 ? this.time[this.time.length - 1]! : 0;
  }

  // time[n] 히스토리(C368, wild 1위 클러스터 time 계열 빌트인 슬라이스) — time은 전체 배열을
  // Context가 이미 쥐고 있어 histSlot record 없이 (idx - offset) 직접 인덱싱으로 합성한다
  // (rt.barIndexHistory의 시각 배열판 — 상태가 없어 조건부/UDF 위치 제약도 없음). 가드는
  // Series.get()과 동일 원칙: trunc + 긍정형(NaN 오프셋 차단) + 워밍업(idx < offset)은 NaN.
  // time 채널 부재 시 barTimeMs와 동일하게 0 폴백(워밍업 NaN 가드는 채널 유무와 무관하게 선행 —
  // "그 바 자체가 없다"는 축은 데이터 유무와 별개다).
  barTimeAt(offset: number): number {
    const t = Math.trunc(offset);
    if (!(t >= 0) || this.idx - t < 0) return NaN;
    if (this.time === undefined) return 0;
    const i = this.idx - t;
    return i < this.time.length ? this.time[i]! : 0;
  }

  // time_close[n] 히스토리(C368) — timeCloseMs 게터와 동일한 "다음 바 open 시각 근사 + 마지막
  // 바는 직전 간격 외삽" 로직을 (idx - offset) 바 기준으로 일반화. offset>=1이면 그 다음 바가
  // 항상 존재해 외삽 분기는 동적 오프셋의 런타임 0에서만 도달한다.
  timeCloseAt(offset: number): number {
    const t = Math.trunc(offset);
    if (!(t >= 0) || this.idx - t < 0) return NaN;
    if (this.time === undefined || this.time.length === 0) return 0;
    const i = this.idx - t;
    const n = this.time.length;
    if (i + 1 < n) return this.time[i + 1]!;
    if (n >= 2) return this.time[n - 1]! + (this.time[n - 1]! - this.time[n - 2]!);
    return this.time[0]!;
  }

  // time(...)/time_close(...) 호출형의 bars_back 인자(C727, wild 9건) — barTimeAt(C368)의 부호있는
  // 버전. 양수/0은 barTimeAt과 동일(과거/현재 바의 실제 시각, 워밍업이면 NaN). 음수(미래)는 GOAL.md
  // 배치 리플레이 원칙대로 배열이 이미 쥔 미래 바가 있으면 그 실값을 그대로 쓰고, 배열 끝을 넘어서면
  // timeCloseMs와 동일한 "마지막 두 바 간격으로 외삽" 근사를 쓴다(TV 미검증(가설), DIVERGENCES #219).
  timeAtBarsBack(barsBack: number): number {
    const n = Math.trunc(barsBack);
    if (this.time === undefined) return 0;
    const len = this.time.length;
    const i = this.idx - n;
    if (n >= 0) {
      if (i < 0) return NaN;
      return i < len ? this.time[i]! : 0;
    }
    if (i < len) return this.time[i]!;
    if (len >= 2) return this.time[len - 1]! + (i - (len - 1)) * (this.time[len - 1]! - this.time[len - 2]!);
    return len > 0 ? this.time[len - 1]! : 0;
  }

  // chart.left_visible_bar_time(C287) — 헤드리스 배치 엔진은 뷰포트가 없어 전체 바 배열이 항상
  // "보임"이므로 가장 왼쪽 보이는 바 = 첫 바(전체 time 배열의 첫 원소, lastBarTimeMs와 대칭).
  // time 채널이 없으면 0 폴백(barTimeMs/lastBarTimeMs와 동일 — GOAL.md "알려진 버그는 따르지
  // 않는다"가 아니라 C59 이래의 기존 무데이터 폴백 관례).
  get firstBarTimeMs(): number {
    return this.time !== undefined && this.time.length > 0 ? this.time[0]! : 0;
  }

  // time_close(C342) — pine2py 자신도 이 값을 채우는 코드가 전혀 없어(_time_close_data가 항상
  // 빈 배열) 항상 0을 반환하는 dead 프로퍼티였다(literal port 대상 아님, TV 미검증 가설 설계).
  // pine2js는 전체 time 배열을 이미 쥔 배치 리플레이라 다음 바의 open 시각을 현재 바의 close
  // 시각으로 근사한다(연속 구간 데이터 가정 — 거래소 세션 갭이 있으면 부정확할 수 있음).
  // 마지막 바는 다음 바가 없어 직전 바 간격으로 외삽, 바가 1개뿐이면 duration=0으로 자기 자신.
  get timeCloseMs(): number {
    if (this.time === undefined || this.time.length === 0) return 0;
    const n = this.time.length;
    if (this.idx + 1 < n) return this.time[this.idx + 1]!;
    if (n >= 2) return this.time[n - 1]! + (this.time[n - 1]! - this.time[n - 2]!);
    return this.time[0]!;
  }

  // timenow(C342) — pine2py는 실제 벽시계(`time.time()`)를 반환해 결정적 재현이 구조적으로
  // 불가능하다(LIMITATIONS.md 기존 결정). chart.*(C239/C287)와 동일한 "환경값" 축으로 취급해
  // 배치 리플레이가 가진 유일한 "현재"에 가장 가까운 결정적 값인 마지막 바 시각으로 고정한다.
  get timenowMs(): number {
    return this.lastBarTimeMs;
  }

  advance(): void {
    this.idx += 1;
    this.open.advance();
    this.high.advance();
    this.low.advance();
    this.close.advance();
    this.volume.advance();
    for (const h of this.histSlots) h.advance();
    for (const h of this.refHistSlots) h.advance();
    for (const p of this.plots) p.advance();
    // 직전 바에 큐잉된 마켓 주문을 이번 바 open으로 체결(GOAL.md "다음 바 open 체결" TV 규칙).
    // limit/stop 주문(C166)은 이번 바 open(갭 체결)과 high/low(intrabar 트리거)로 조건 판정 —
    // 미충족이면 슬롯에 남아 다음 바로 이월된다. advance()는 barFn() 실행 전에 호출되므로 이 바의
    // 스크립트 코드는 체결 후의 포지션을 본다.
    // barTimeMs(C320)는 strategy.risk.max_intraday_filled_orders의 "거래일" 경계 판정 유일한
    // 소스 — barTimeMs 게터는 time 채널이 없으면 0 폴백(항상 같은 날, GOAL.md "알려진 버그는
    // 따르지 않되 안전한 쪽" 축과 동일 관례)이라 여기서 별도 널 체크가 불필요하다.
    this.strategy.processFills(this.open.get(0), this.high.get(0), this.low.get(0), this.idx, this.barTimeMs);
    // strategy.max_drawdown(C172) — 이 바의 close는 배치 리플레이라 이미 확정돼 있어(Series가 전
    // 배열을 쥐고 있음) barFn 실행 전인 이 시점에 갱신해도 barFn이 나중에 읽는 strategy.equity와
    // 정확히 같은 값을 쓴다(strategy.ts updateDrawdown 주석 참조).
    this.strategy.updateDrawdown(this.close.get(0));
    // strategy.max_contracts_held_all/long/short(C334) — updateDrawdown과 동일 이유로 이 시점의
    // posSize가 이미 이번 바의 최종 체결 반영값이라 별도 사후 훅이 불필요하다.
    this.strategy.updateMaxContractsHeld();
  }
}
