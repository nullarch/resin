// StrategyState: strategy.* 브로커 에뮬레이터 — 마켓 주문 entry/close, 롱/숏 양방향(C164 둘째
// 슬라이스), 계좌 속성 netprofit/openprofit/equity/트레이드 카운터(C165 셋째 슬라이스),
// limit/stop entry 주문 + 바 넘어 이월 + cancel/cancel_all(C166 넷째 슬라이스),
// strategy.exit 브래킷 청산(limit=익절/stop=손절, C167 다섯째 슬라이스),
// strategy.close_all(id 무관 전량 청산) + close/exit qty= 부분 청산(C168 여섯째 슬라이스),
// strategy.order 넷팅 주문(리버스/pyramiding 가드 없는 순수 방향 주문 — 반대 방향 체결은
// |posSize| 상쇄: 축소/정확 flat/부호 반전, C169 일곱째 슬라이스), entry/order/exit/close/
// close_all(comment=) 실소비 + strategy.closedtrades.entry_comment/exit_comment(index) 최신
// 트레이드 1건 조회(C173 열한째 슬라이스).
// strategy.closedtrades.<method>(trade_num) 전 인덱스(0=가장 오래된 트레이드 ~ closedTrades-1=
// 가장 최근) 조회용 레코드(C579, 배치28 (1) — per-trade 이력 설계 승인). TV 공식 레퍼런스:
// "trades are numbered starting at zero...the number increasing with each closed trade" — 즉
// trade_num 0이 최초 청산, 최댓값이 최신 청산이라 closeAt()의 push 순서(청산 발생 순)가 그대로
// 정답 순서다.
interface ClosedTradeRecord {
  entryComment: string;
  exitComment: string;
  entryPrice: number;
  exitPrice: number;
  entryBarIndex: number;
  exitBarIndex: number;
  entryTime: number;
  exitTime: number;
  entryId: string;
  exitId: string;
  profit: number;
  size: number;
  maxRunup: number;
  maxDrawdown: number;
}

// pine2py wavealgo/strategy/engine.py의 주문 상태머신 구조(pending 주문 → 체결 → Position
// 갱신, entry()의 반대 포지션 청산/pyramiding 가드, _fill_entry의 가중평균 추가 진입)를 시맨틱
// 참조로 이식하되, **체결 시점은 pine2py를 따르지 않는다**: pine2py StrategyEngine은 market 주문을
// 당일 close에 즉시 체결하는데(engine.py entry()의 `self._fill_entry(order, self._close)`) 이는
// 알려진 버그다(GOAL.md "strategy 체결: market 주문은 **다음 바 open** 체결" — TV 브로커 에뮬레이터
// 규칙). 따라서 strategy 계열은 오라클(gen_oracle.py) 골든 생성 자체가 무효 구간이며 전 기능을
// hand-verified로 검증한다(tests/unit/strategy.test.ts, DIVERGENCES.md #1/#66/#67 참조).
//
// 체결 적격성(리버스/pyramiding)도 콜타임이 아니라 **체결 시점**에 판정한다 — pine2py의 콜타임 판정
// (entry()의 `self.position.is_short` 체크 등)은 당일 체결 전제라 next-bar-open 모델에 그대로 이식할
// 수 없다(주문을 낸 바와 체결되는 바 사이에 포지션이 바뀔 수 있음). DIVERGENCES.md #66/#67의 TV
// 미검증 가설 축.
//
// 상태 표현: 큐(가변 배열) 대신 고정 pending 슬롯 2개(entry/close)를 in-place 뮤테이션으로만 쓴다
// (GOAL.md "bar loop 안 할당 제로" — 신호 바에서도 객체/배열 할당이 전혀 없음). 마켓 주문은 다음 바
// open에서 반드시 소진(체결 또는 취소)되고, limit/stop 주문(C166)은 체결/취소까지 슬롯을 점유한 채
// 이월된다 — "동시 pending entry 1건" 모델: entry는 "첫 주문 유지 + 같은 id 재호출만 수정", close는
// 멱등. pyramiding>=2에서 서로 다른 id의 entry 주문을 동시에 걸면 첫 주문만 유지된다(LIMITATIONS.md).
export class StrategyState {
  // 포지션 — posSize는 부호 있는 값(C164): >0=롱, <0=숏, 0=flat (pine2py position_size 프로퍼티/
  // TV strategy.position_size와 동일한 부호 규약).
  posSize: number;
  posAvgPrice: number; // strategy.position_avg_price — flat이면 NaN(TV: na)
  entryId: string | null; // 현재 포지션을 연 entry 주문 id (flat이면 null, pyramiding 추가 진입은 최초 id 유지)
  // 현재 포지션을 연 entry/order 주문의 comment(C173 열한째 슬라이스) — entryId와 동일하게
  // pyramiding 추가 진입에도 최초 값을 유지한다(pine2py Position.entry_comment가 _fill_entry의
  // "새 Position" 분기에서만 order.comment로 설정되고 가중평균 분기에서는 안 건드리는 것의 미러).
  entryComment: string;
  // 현재 포지션을 구성하는 체결 횟수(pyramiding 게이트) — flat/청산 시 0, 새 포지션 1, 추가 진입 +1.
  // pine2py의 _long_entries/_short_entries(청산 시 0 리셋)와 동형이되 체결 시점에 갱신.
  entryCount: number;
  // 현재 포지션이 열린 bar_index(C308, strategy.opentrades.entry_bar_index/closedtrades의 청산
  // 스냅샷 lastClosedEntryBarIndex 공용 소스) — entryId/entryComment와 동일 lifecycle(flat=NaN,
  // 새 포지션에서 세팅, pyramiding 추가 진입엔 안 바뀜, pine2py Position.entry_bar 대응).
  entryBarIndexOpen: number;
  // 현재 포지션이 열린 바의 시각(ms, C418) — entryBarIndexOpen과 완전히 동일한 lifecycle/용도의
  // 시간판(strategy.opentrades.entry_time/closedtrades.entry_time 공용 소스). processFills가
  // 받는 barTimeMs를 그대로 스냅샷 — entry_bar_index가 barIndex를 스냅샷하는 것과 대칭.
  entryTimeOpen: number;

  // strategy() 지시어 메타데이터(C164, C165에서 initialCapital 추가) — codegen이 프리앰블에서
  // configure()로 1회 주입. 미지정 스크립트는 configure 호출 자체가 없거나(1/1) 세 번째 인자를
  // 생략해(100000) 기본값이 그대로 쓰인다.
  defaultQty: number; // strategy(default_qty_value=N) — entry qty 생략 시 사용
  pyramiding: number; // strategy(pyramiding=N) — 같은 방향 추가 진입 최대 횟수(0은 1과 실질 동치 — 아래 processFills 참조)
  initialCapital: number; // strategy(initial_capital=N) — equity의 기저(TV/pine2py StrategyConfig 기본 100000)
  // strategy(default_qty_type=strategy.percent_of_equity) 소비(C171 아홉째 슬라이스) — true면
  // entry/order의 qty 생략 시 defaultQty를 계약 수가 아니라 **지분율 %**로 해석해 체결 시점에
  // 수량을 산출한다(autoQtyAt — 가격이 확정되는 지점이라 콜타임 해석 불가). fixed(기본)는 기존
  // 동작 그대로. pine2py는 상수(constants.py PERCENT_OF_EQUITY)만 있고 StrategyConfig에 필드
  // 자체가 없어 소비 로직 전무 — 전부 TV 실측 미검증 가설(DIVERGENCES #74).
  qtyIsPercent: boolean;
  // strategy(default_qty_type=strategy.cash) 소비(C330) — true면 entry/order의 qty 생략 시
  // defaultQty를 계약 수가 아니라 **통화 금액**으로 해석해 체결 시점에 금액/체결가로 계약 수를
  // 산출한다(autoQtyCashAt — percent_of_equity와 달리 equity(잔고) 자체와는 무관한 절대 금액 축).
  // qtyIsPercent와 상호 배타(codegen이 if/else-if로 하나만 true를 방출). 동일하게 pine2py 소비
  // 로직 전무 — TV 실측 미검증 가설(DIVERGENCES #74).
  qtyIsCash: boolean;

  // 계좌 속성 누적기(C165 셋째 슬라이스) — pine2py는 청산마다 Trade 객체를 리스트에 쌓고 속성을
  // 매번 리스트 스캔(sum/len)으로 계산하지만, 여기서는 GOAL.md "bar loop 안 할당 제로"에 따라
  // Trade 객체 없이 스칼라 누적기 6개로 동일한 관측값을 유지한다(commission 0 고정이라
  // Trade.profit = (체결가-진입가)*qty*방향부호 하나면 충분 — engine.py _close_position/
  // types.py Trade.profit 대조). 트레이드 개별 기록(entry/exit bar, comment)은 이후 슬라이스.
  realizedPnl: number; // strategy.netprofit — 실현 손익 합(engine.py _realized_pnl)
  closedTrades: number; // strategy.closedtrades — 청산된 트레이드 수(리버스 1회도 1건)
  winTrades: number; // strategy.wintrades — profit > 0 트레이드 수(0은 win도 loss도 아님 — pine2py 부등호 동일)
  lossTrades: number; // strategy.losstrades — profit < 0 트레이드 수
  evenTrades: number; // strategy.eventrades(C331, wild 신규) — profit === 0 트레이드 수(win/lossTrades가
  // 원래 안 세던 나머지 축을 명시적으로 채움 — DIVERGENCES #68 (c)가 미리 지적해둔 gap)
  grossProfit: number; // strategy.grossprofit — 양수 profit 합
  grossLoss: number; // strategy.grossloss — 음수 profit 합(pine2py와 동일하게 0 이하 값 — DIVERGENCES #68)
  // strategy.avg_winning_trade_percent/avg_losing_trade_percent(C674, wild 신규 — pine2py에 대응
  // 구현 전무, grep 0건) — closedTradeProfitPercent와 동일 공식(entryPrice===0 가드, 방향은 profit
  // 부호와 항상 일치하므로 별도 sign 재계산 없이 closeAt()에서 profit 분기와 나란히 누적)을 트레이드당
  // 계산해 win/loss 트레이드 각각의 profit_percent 합만 스칼라로 유지(GOAL.md "bar loop 안 할당
  // 제로"와 동일하게 트레이드 리스트 재스캔 없이 grossProfit/grossLoss와 동형 누적기). avg_*=합/카운트.
  sumWinProfitPercent: number;
  sumLossProfitPercent: number;

  // 트레이드 접근자 실소비(C173 열한째 슬라이스 entry_comment/exit_comment → C308이 나머지
  // 필드로 확장) — pine2py는 Trade 리스트 전체를 보관해 임의 인덱스로 재조회 가능하지만
  // (types.py Trade 필드셋: entry_id/exit_id/entry_price/exit_price/entry_bar/exit_bar/
  // entry_comment/exit_comment/profit), 여기서는 GOAL.md "bar loop 안 할당 제로"와의 충돌
  // 우려(청산마다 성장하는 Trade 배열)를 피해 **가장 최근 청산 트레이드 1건만** 스칼라로
  // 캐시한다(next_hint 압축안 채택) — closeAt이 매 청산(부분 포함)마다 갱신.
  // strategy.closedtrades.<method>(index)는 index가 closedTrades-1(최신)이 아니면 하드
  // 에러(closedTradeXxx 접근자 참조 — 없는 데이터를 조용히 틀리게 반환하는 대신 명시적 실패,
  // LIMITATIONS.md). size는 TV 규약대로 부호 있음(롱 +, 숏 -, closeAt의 sign*closeQty).
  lastClosedEntryComment: string;
  lastClosedExitComment: string;
  lastClosedEntryPrice: number;
  lastClosedExitPrice: number;
  lastClosedEntryBarIndex: number;
  lastClosedExitBarIndex: number;
  lastClosedEntryId: string;
  lastClosedExitId: string;
  lastClosedProfit: number;
  lastClosedSize: number;
  // strategy.closedtrades.entry_time/exit_time(C418) — entry_bar_index/exit_bar_index와 동일
  // lifecycle의 시간판(ms). entryTimeOpen의 청산 시점 스냅샷 + closeAt이 받는 barTimeMs 그대로.
  lastClosedEntryTime: number;
  lastClosedExitTime: number;
  // strategy.closedtrades/opentrades.max_drawdown/max_runup(hand-verified, C312) — TV MFE/MAE류
  // "트레이드 생존 기간 중 최대 유리/불리 가격 이탈"(둘 다 통화 단위, 항상 >= 0). pine2py
  // Trade/Position dataclass 어디에도 대응 필드가 없어(types.py 전체 grep 0건) 전부 신규 설계다.
  // tradeMaxRunup/tradeMaxDrawdown은 "현재 열린 트레이드"의 러닝 누적값(updateTradeExcursion이
  // 매 바 갱신, 새 포지션 시작 시 closeAt의 flat 분기가 0으로 리셋) — opentrades 접근자가 그대로
  // 노출한다. closedtrades 접근자는 closeAt()이 flat 전환 시점에 그 값을 lastClosedMaxRunup/
  // lastClosedMaxDrawdown으로 스냅샷한 것을 읽는다(다른 lastClosed* 필드와 동일 lifecycle).
  tradeMaxRunup: number;
  tradeMaxDrawdown: number;
  lastClosedMaxRunup: number;
  lastClosedMaxDrawdown: number;
  // strategy.closedtrades.<method>(trade_num) 전 인덱스 조회용 레코드 배열(C579) — closeAt()이
  // 청산마다(부분 청산 포함, closedTrades 증가와 동일 관례) 1건 push. 청산은 바 루프의 매 바가
  // 아니라 실제 체결 이벤트에서만 일어나는 드문 이벤트라 GOAL.md "bar loop 안 할당 제로"(매 바
  // 무조건 발생하는 할당 금지)의 대상과는 성격이 다르다 — 위 lastClosed* 스칼라 필드는 기존
  // 화이트박스 테스트 호환을 위해 그대로 유지하며 항상 이 배열의 마지막 원소와 동치.
  closedTradeRecords: ClosedTradeRecord[];

  // equity 히스토리 누적기(C172 열째 슬라이스) — pine2py에 drawdown 구현이 전무하다(grep 0건,
  // C171/C172 확인)라 아래 설계 전부가 TV 실측 미검증 가설이다(DIVERGENCES #75). peakEquity는
  // "지금까지 관측된 equity의 최고값"(NaN=아직 첫 바 미관측 — updateDrawdown이 initialCapital로
  // 1회 시드), maxDrawdown은 "peakEquity에서 그 이후 최대로 떨어진 폭"(통화 단위, 항상 >= 0)의
  // 누적 최대치 — 둘 다 표준 온라인 max-drawdown 알고리즘(GOAL.md "TA는 전부 incremental O(1)/bar"
  // 축과 동일 모양, sma류 누적기와 같은 급).
  peakEquity: number; // strategy.max_drawdown의 내부 상태 — 사용자 노출 프로퍼티 아님
  maxDrawdown: number; // strategy.max_drawdown
  // strategy.max_drawdown_percent(C333, next_hint(C331/C332) 1순위) — maxDrawdown(통화 절대값)을
  // 퍼센트로 정규화하려면 "그 최댓값이 갱신된 시점의 peakEquity" 스냅샷이 필요하다(현재 peakEquity를
  // 그대로 나누면 이후 신고점 갱신 시 분모가 달라져 과거 최대낙폭의 퍼센트가 조용히 줄어든다).
  // updateDrawdown()의 최초 시드 시점과 maxDrawdown 갱신 시점 두 곳에서만 함께 갱신 — peakEquity와
  // 동일한 "NaN이 절대 관측되지 않는" lifecycle(항상 시드 직후에만 읽힘)이라 사용 전 NaN 가드 불필요.
  peakEquityAtMaxDrawdown: number;

  // strategy.max_runup/max_runup_percent(C674, wild 신규 — pine2py에 대응 구현 전무, grep 0건)는
  // max_drawdown을 뒤집은 대칭 축: peakEquity(러닝 최댓값) 대신 troughEquity(러닝 최솟값)를 추적해
  // "트로프 이후 최대로 오른 폭"의 러닝 최댓값을 유지한다. troughEquityAtMaxRunup은
  // peakEquityAtMaxDrawdown과 동일한 이유(퍼센트 정규화 분모가 그 최댓값이 갱신된 시점 값으로
  // 고정돼야 이후 신저점 갱신에 조용히 안 흔들림)로 별도 스냅샷. updateDrawdown()과 같은 호출
  // 위치에서 함께 갱신 — 둘 다 "이 바에 스크립트가 보게 될 equity"의 히스토리 하나를 공유하는
  // 독립 축이라 별도 사후 훅 불필요(updateDrawdown 주석 참조). TV 미검증(가설), DIVERGENCES #75.
  troughEquity: number;
  maxRunup: number;
  troughEquityAtMaxRunup: number;

  // strategy.max_contracts_held_all/long/short(C334, next_hint(C333) 1순위) — pine2py에 대응 구현이
  // 전무해(grep 0건) hand-verified 설계, "TV 미검증(가설)": 지금까지 보유했던 |posSize|의 러닝
  // 최댓값. updateMaxContractsHeld()가 updateDrawdown()과 같은 위치(Context.advance()가 매 바
  // processFills() 직후, barFn 실행 전)에서 갱신 — 이 시점의 posSize는 이번 바의 모든 체결이 반영된
  // 최종값이라(processFills가 한 바의 entry/order/exit/close/pyramiding 전부를 단일 호출로 정산)
  // 개별 posSize 대입 지점(entry/order 체결, closeAt 부분청산 등 5곳)마다 훅을 심을 필요가 없다.
  // all=방향 무관 |posSize|, long=posSize>0일 때만, short=posSize<0일 때 |posSize| — 셋 다 한 번도
  // 그 방향으로 보유한 적이 없으면 TV 관례대로 0(마이너스 무한대 시드 아님).
  maxContractsHeldAll: number;
  maxContractsHeldLong: number;
  maxContractsHeldShort: number;

  // pending 주문 슬롯 — processFills()가 매 바 체결 시도. 테스트 관측 편의상 public
  // (Context의 다른 필드와 동일 관례)이지만 트랜스파일 출력이 직접 만지는 것은 entry/exit/close/
  // close_all/cancel/cancel_all/configure 일곱 메서드 + openProfit/equity/closedTradeEntryComment/
  // closedTradeExitComment 네 관측 메서드 + posSize/posAvgPrice/realizedPnl/closedTrades/
  // winTrades/lossTrades/evenTrades/grossProfit/grossLoss/initialCapital/defaultQty 관측 필드뿐이다
  // (analyzer.ts STRATEGY_RUNTIME_PROPS + call-expr.ts closedtrades.entry_comment/exit_comment 분기가 유일한
  // 방출 지점).
  // 마켓 주문은 다음 바 open에서 반드시 소진(체결 또는 취소)되지만, limit/stop 주문(C166 넷째
  // 슬라이스)은 가격 조건 미충족 시 **바를 넘어 이월**된다(pine2py _pending_orders 존속과 동형 —
  // 취소 수단은 cancel/cancel_all, 같은 id 재호출은 주문 수정).
  entryPending: boolean;
  entryOrderId: string;
  entryDirection: string; // "long" | "short" (entry()가 검증)
  entryQty: number; // 계약 수 — entryQtyAuto가 true면 지분율 %(C171) 또는 통화 금액(C330), qtyIsCash로 분기(체결 시점에 계약 수로 환산)
  entryQtyAuto: boolean; // percent_of_equity/cash 자동 수량 — qty 생략 + (qtyIsPercent || qtyIsCash)일 때만 true
  entryLimit: number; // 지정가(NaN=없음) — limit/stop 둘 다 NaN이면 마켓 주문
  entryStop: number; // 역지정가(NaN=없음) — 둘 다 지정되면 stop-limit
  entryOrderComment: string; // strategy.entry(comment=, C173) — 이 pending 주문 자체의 comment(체결 시 새 포지션이면 entryComment로 승격)
  closePending: boolean;
  closeOrderId: string;
  closeQty: number; // strategy.close(qty=) 부분 청산 수량(C168) — Infinity=전량(기본)
  closeOrderComment: string; // strategy.close(comment=)/close_all(comment=, C173) 공유 슬롯(closeQty와 동일 공유 관례)
  // strategy.close_all() 플래그(C168) — closePending 슬롯을 재사용하되 체결 시 id 매칭을 생략.
  // close_all은 항상 전량이므로 이 플래그가 서면 closeQty도 Infinity로 고정되고, 같은 바의 후속
  // close(qty=) 부분 주문은 전량 청산의 부분집합이라 무시된다(TV라면 두 주문이 각각 나가지만 둘 다
  // 다음 바 open 체결이라 순효과는 전량 청산으로 동일 — TV 실측 미검증 가설, DIVERGENCES #71).
  closeAllPending: boolean;
  // pending exit(브래킷 청산) 슬롯(C167 다섯째 슬라이스) — entry 슬롯과 별개. exit는 항상 가격
  // 기반(limit/stop 최소 하나 — analyzer가 강제)이라 마켓 소진 규칙이 없고, 체결/취소/포지션
  // 청산까지 이월된다.
  exitPending: boolean;
  exitOrderId: string;
  exitFromEntry: string; // strategy.exit(from_entry=) — ""는 전체 포지션 대상(entry id 무관)
  exitLimit: number; // 익절 지정가(NaN=없음)
  exitStop: number; // 손절 역지정가(NaN=없음)
  exitQty: number; // strategy.exit(qty=) 부분 청산 수량(C168) — Infinity=전량(기본)
  exitOrderComment: string; // strategy.exit(comment=, C173)
  // strategy.exit(comment_loss=/comment_profit=, C375, hand-verified) — TV 시그니처는 comment=의
  // 트리거별 오버라이드 축이다: 이 청산 체결이 stop=/loss=(또는 트레일링 스톱)로 발생했으면
  // comment_loss=가, limit=/profit=로 발생했으면 comment_profit=가 comment=보다 우선(둘 다
  // null=미지정이면 comment=로 폴백). pine2py exit()는 이 이름들을 아예 모르고 **kwargs로 조용히
  // 버린다(engine.py L141-153, python 소스 확인) — 그러나 alert_message(C374)와 달리 comment=는
  // 이미 exitOrderComment/closedtrades.exit_comment(C173)로 실제로 소비되는 값이라 순수 discard가
  // 아니라 실제 조건부 선택 시맨틱을 구현한다(MEMORY C147 원칙: 표시값이라도 소비 채널이 있으면
  // discard 금지). null(미지정, na)과 ""(명시적 빈 문자열)을 구분해야 "미지정 시 comment=로 폴백"이
  // 성립하므로 참조형 na 규약대로 string|null로 저장(comment=처럼 ""로 뭉개면 안 됨). comment_trailing=
  // (TV의 세 번째 축, 트레일링 전용 오버라이드)은 C673에서 구현 — 아래 exitCommentTrailing 참조.
  exitCommentLoss: string | null;
  exitCommentProfit: string | null;
  // strategy.exit(comment_trailing=, C673, hand-verified) — comment_loss/profit이 커버 못 하는
  // 세 번째 축(exitFillKind===null, 순수 트레일링 라인 체결) 전용 오버라이드. 규약은 comment_loss/
  // profit과 동일(null=미지정이면 comment=로 폴백, string|null 저장). pine2py exit()에 대응 파라미터
  // 자체가 없어(comment_loss/profit과 동일 이유) TV 미검증 가설(DIVERGENCES 신규 항목).
  exitCommentTrailing: string | null;
  // exitFillPrice()가 이번 체결을 촉발한 축을 스칼라 필드로 보고(GOAL "bar loop 안 할당 제로" —
  // 튜플/객체 반환 대신 기존 exitTrailPrice 래칫과 동일한 "부작용으로 상태 필드 갱신" 관례 재사용).
  // "loss"=stop/trail_points·trail_price가 체결가를 결정, "profit"=limit/profit=가 결정,
  // null=순수 트레일링 라인이 결정(comment_trailing=이 있으면 그쪽, 없으면 comment=로 폴백).
  // processFills가 closeAt() 호출 직전에 1회만 읽고 소비 — exit 체결이 없는 바에는 갱신되지
  // 않는 값이라도 무해(그 바엔 애초에 안 읽음).
  exitFillKind: "profit" | "loss" | null;
  // 트레일링 스톱(C170 여덟째 슬라이스) — strategy.exit(trail_points=, trail_offset=). pine2py
  // engine.py _check_trailing_fill 이식: 활성화 레벨 = posAvgPrice ± trail_points(롱 +/숏 -, 체결
  // 판정 시점의 avg — 콜타임 스냅샷 아님), 활성화 후 바마다 유리 극값(롱 high/숏 low)에서
  // trail_offset만큼 떨어진 라인을 단조 래칫(롱은 max/숏은 min — 되돌림에도 라인은 후퇴 안 함),
  // 반대 극값이 라인에 닿으면 라인 가격 체결. 단위는 pine2py와 동일하게 **가격 포인트**(TV 문서의
  // trail_points는 틱 단위로 알려져 있으나 syminfo.mintick 미구현이라 mintick=1 가정과 동치 —
  // TV 실측 미검증, DIVERGENCES #73).
  exitTrailPoints: number; // 활성화 거리(포인트, NaN=trail_price로 대체 활성화 또는 트레일링 축 없음)
  exitTrailOffset: number; // 라인 오프셋(포인트, NaN=trail_points를 오프셋으로 재사용 — pine2py 기본 규칙. trail_price 사용 시 필수)
  exitTrailPrice: number; // 추적 중인 트레일링 스톱 라인(NaN=미활성) — exitFillPrice가 바마다 갱신
  // strategy.exit(trail_price=, C178) — 활성화 레벨을 posAvgPrice±trail_points 산식이 아니라
  // **절대 가격**으로 직접 지정(pine2py에 사용자 파라미터로 존재하지 않아 전부 TV 미검증 가설,
  // DIVERGENCES #79). trail_points와 동시 지정은 activation 산식이 상충해 analyzer가 하드
  // 에러로 막는다 — 이 필드가 NaN이 아니면 exitFillPrice는 posAvgPrice±trail_points 산식 대신
  // 이 값을 그대로 activation 임계값으로 쓴다(방향 부호 보정 없음 — 롱/숏 모두 절대 가격 그대로 비교).
  exitTrailPriceArg: number; // 활성화 절대가(NaN=trail_points 산식 사용)
  // strategy.exit(profit=/loss=, hand-verified) — pine2py exit()는 **kwargs로 받아 조용히 버리는
  // 파라미터라(engine.py L141-153) 대응 구현 자체가 없음, 전부 TV 미검증 가설(DIVERGENCES #98).
  // limit=/stop=(절대가)의 "포인트 단위" 대안 — profit은 posAvgPrice에서 유리한 방향으로 이만큼,
  // loss는 불리한 방향으로 이만큼 떨어진 가격을 익절/손절 레벨로 쓴다. trail_points와 동일하게
  // exitFillPrice가 매 바 posAvgPrice로 다시 계산(콜타임 스냅샷 아님 — pyramiding으로 avg가 바뀌어도
  // 정합). limit=/stop=과 각각 같은 축(둘 다 "이 포지션의 익절/손절 절대가"를 결정)이라 동시 지정은
  // analyzer가 하드 에러로 막는다(어느 쪽이 우선인지 확신 없음, trail_price/trail_points와 동일 원칙).
  // 단위는 trail_points와 동일하게 가격 포인트(TV는 틱 단위로 알려져 있으나 syminfo.mintick
  // 미구현이라 mintick=1 가정과 동치, #73 축 계승).
  exitProfitPoints: number; // 익절 목표(포인트, NaN=미지정 — limit=이 대신 쓰임)
  exitLossPoints: number; // 손절 목표(포인트, NaN=미지정 — stop=이 대신 쓰임)
  // pending order(넷팅 주문) 슬롯(C169 일곱째 슬라이스) — entry 슬롯과 별개: entry의 체결 판정
  // (리버스 전량 청산 + pyramiding 게이트)과 달리 order는 반대 방향을 |posSize|와 상쇄하고
  // 같은 방향 추가엔 pyramiding 게이트가 없어 체결 경로가 다르다. 마켓/limit/stop·이월·같은 id
  // 수정·다른 id 첫 주문 유지 규칙은 entry 슬롯 모델과 동형.
  orderPending: boolean;
  orderOrderId: string;
  orderDirection: string; // "long" | "short" (order()가 검증)
  orderQty: number; // 계약 수 — orderQtyAuto가 true면 지분율 %(C171) 또는 통화 금액(C330), entry 슬롯과 동일 규약
  orderQtyAuto: boolean; // percent_of_equity/cash 자동 수량(entry와 동일 규약)
  orderLimit: number; // 지정가(NaN=없음) — limit/stop 둘 다 NaN이면 마켓 주문
  orderStop: number; // 역지정가(NaN=없음)
  orderOrderComment: string; // strategy.order(comment=, C173)

  // strategy.risk.allow_entry_in(value)(C309) — "all"|"long"|"short" 방향 제한. entry()의
  // 체결 시점(processFills)에서만 소비 — 콜타임이 아니라 체결 시점에 검사해야 그 사이 방향이
  // 바뀌어도(같은 바에 재호출) 최종 체결에 항상 최신 설정이 반영된다(entryDirection/qty 등
  // "체결 시점 해석" 기존 관례와 동일 축).
  allowedDirection: string;

  // strategy.risk.max_intraday_filled_orders(count)(C320) — 거래일 안에 신규 체결(오픈/피라미딩
  // 추가)된 entry 수 상한. NaN=제한 없음(기본값). "거래일" 경계는 C299가 이미 채택한 축(exchange
  // 타임존 미구현 — UTC 고정, LIMITATIONS.md 동일 갭)을 그대로 연장해 UTC 달력일로 판정한다.
  // intradayDayKey는 그 경계 판정용 키(NaN=아직 관측 안 됨, processFills가 바 시각을 받을 때만
  // 갱신 — 시각 채널이 없는 기존 단위 테스트 호출부는 이 게이트 자체가 무해하게 no-op).
  maxIntradayFilledOrders: number;
  intradayFilledCount: number;
  intradayDayKey: number;

  // strategy.risk.max_drawdown(value, type)/max_intraday_loss(value, type)(C322, next_hint 2순위 —
  // LIMITATIONS.md C309 착수 체크리스트 (a)~(d) 완료) — 둘 다 pine2py에 대응 구현이 전혀 없어
  // (allow_entry_in/max_intraday_filled_orders와 동일 근거) hand-verified 신규 설계, "TV
  // 미검증(가설)": max_drawdown은 전체 실행 기간의 peakEquity(이미 존재하는 updateDrawdown 인프라)
  // 대비 하락폭이 문턱을 넘으면 **영구** 정지(이름에 "intraday"가 없어 max_intraday_filled_orders류
  // 거래일 한정과 다른 축으로 판단 — 이름 자체가 유일한 근거라 DIVERGENCES에 가설로 명시), 반대로
  // max_intraday_loss는 "거래일 안의 peak equity" 대비 하락폭이라 peakEquity와 별도로 거래일마다
  // 리셋되는 intradayPeakEquity가 필요하다(intradayDayKey 재사용 — max_intraday_filled_orders와
  // 동일한 "거래일" 경계 판정 채널 공유). type("cash"|"percent_of_equity", strategy.cash/
  // percent_of_equity 상수가 analyzer의 builtinStringConstants로 이미 문자열 폴딩됨)에 따라
  // 문턱값을 통화 절대값 또는 peak 대비 퍼센트(0~100 스케일 — autoQtyAt의 percent/100 관례와 동일)로
  // 해석한다. 둘 다 "한 번 넘으면 래치"(같은 바 안에서 등락으로 되돌아오지 못하게) — 넘은 순간의
  // equity가 peak보다 낮아 손실폭이 줄어드는 조합이어도 재계산하면 거짓으로 풀려버리므로 불리언
  // 래치가 필수(단순 부등호 재비교로는 불가, MEMORY.md C91급 함정과 유사). max_drawdown은 영구라
  // 리셋 자체가 없고, max_intraday_loss는 processFills의 거래일 경계 블록에서 intradayFilledCount와
  // 나란히 리셋된다. 게이트는 allow_entry_in/max_intraday_filled_orders와 동일하게 entry()의
  // 오픈/피라미딩 분기만 막고(REMARKS 패턴 계승 — 청산/반대방향 리버스-청산은 계속 허용) order()는
  // 기존 두 게이트와 동일하게 미적용 범위 밖(대칭성 유지). "포지션 강제 청산"(TV가 실제로 그렇게
  // 동작한다는 설/외부 통설이 있으나 이 세션 1차 검증 불가)은 신규 진입 차단보다 훨씬 큰 행동
  // 변화라 이번 슬라이스 범위 밖으로 명시적으로 제외(LIMITATIONS.md 신규 등재).
  maxDrawdownValue: number; // strategy.risk.max_drawdown(value)의 value — NaN=제한 없음(기본값)
  maxDrawdownType: string; // "cash" | "percent_of_equity"
  drawdownLimitReached: boolean; // 영구 래치 — 한 번 true면 이후 절대 false로 안 돌아감
  maxIntradayLossValue: number; // strategy.risk.max_intraday_loss(value)의 value — NaN=제한 없음
  maxIntradayLossType: string; // "cash" | "percent_of_equity"
  intradayPeakEquity: number; // 거래일 안 peak equity(NaN=이번 거래일 아직 미관측 — updateDrawdown이 시드)
  intradayLossLimitReached: boolean; // 거래일 한정 래치 — 거래일 경계에서만 false로 리셋
  // strategy.risk.max_position_size(value)(C324) — 위 3형제와 달리 "전면 차단"이 아니라 "신규
  // 진입/피라미딩 수량 축소"(reduce) 게이트다(TV 문서 발췌: "quantity of new strategy.entry
  // orders will be reduced if necessary to prevent exceeding this limit"). 영구 상한(거래일 리셋
  // 없음, maxDrawdownValue와 동일 스코프) — 판정은 processFills의 qty 계산 자리에서 직접 캡한다.
  maxPositionSizeValue: number; // NaN=제한 없음(기본값)

  // strategy.risk.max_cons_loss_days(count)(C325, next_hint(C324) 신규 발견 — strategy.risk.* 6종
  // 중 마지막 미구현 형제) — pine2py에 대응 구현이 전혀 없어(형제들과 동일 근거) hand-verified 신규
  // 설계, "TV 미검증(가설)": wild 코퍼스 자신에 포함된 TV 문서 발췌(86e04be3ab6c.pine DESCRIPTION::
  // "A strategy-wide rule that stops all trading (cancels pending orders, closes open positions)
  // if the specified count of consecutive days end with a loss.")가 근거. 이름에 "intraday"가
  // 없어 max_drawdown과 동일 축(영구 래치, 거래일 경계 리셋 없음)으로 판단 — allow_entry_in류
  // "거래일마다 리셋"과 달리 한 번 N일 연속 손실이 발생하면 전략 전체가 영구 정지된다(maxDrawdown과
  // 동일하게 processFills의 거래일 경계 리셋 블록에서 이 래치는 건드리지 않음). "거래일이 손실로
  // 끝났는가"는 그 거래일이 끝나는 시점(다음 거래일 전환이 감지되는 processFills 호출)에 그날 실현
  // 손익(realizedPnl 변화량)이 음수인지로 판정한다 — consLossDayStartRealizedPnl이 거래일 시작
  // 시점의 realizedPnl 스냅샷(intradayPeakEquity와 동일한 "day-key 전환 블록에서 다음 날 기준으로
  // 재시드" 패턴), 전환 시 (이전) realizedPnl - consLossDayStartRealizedPnl < 0 이면 연속 카운터 +1,
  // 0 이상(무손실/무거래일 포함)이면 0으로 리셋. count<=0/NaN도 그대로 저장(C91 긍정형 가드 원칙).
  maxConsLossDaysValue: number; // NaN=제한 없음(기본값)
  consLossDayCount: number; // 현재까지의 연속 손실-거래일 스트릭
  consLossDayStartRealizedPnl: number; // 현재 거래일 시작 시점의 realizedPnl 스냅샷(NaN=아직 미관측)
  consLossLimitReached: boolean; // 영구 래치 — 한 번 true면 이후 절대 false로 안 돌아감

  constructor() {
    this.posSize = 0;
    this.posAvgPrice = NaN;
    this.entryId = null;
    this.entryComment = "";
    this.entryCount = 0;
    this.entryBarIndexOpen = NaN;
    this.entryTimeOpen = NaN;
    this.defaultQty = 1;
    this.pyramiding = 1;
    this.initialCapital = 100000;
    this.qtyIsPercent = false;
    this.qtyIsCash = false;
    this.realizedPnl = 0;
    this.closedTrades = 0;
    this.winTrades = 0;
    this.lossTrades = 0;
    this.evenTrades = 0;
    this.grossProfit = 0;
    this.grossLoss = 0;
    this.sumWinProfitPercent = 0;
    this.sumLossProfitPercent = 0;
    this.peakEquity = NaN;
    this.maxDrawdown = 0;
    this.peakEquityAtMaxDrawdown = NaN;
    this.troughEquity = NaN;
    this.maxRunup = 0;
    this.troughEquityAtMaxRunup = NaN;
    this.maxContractsHeldAll = 0;
    this.maxContractsHeldLong = 0;
    this.maxContractsHeldShort = 0;
    this.lastClosedEntryComment = "";
    this.lastClosedExitComment = "";
    this.lastClosedEntryPrice = NaN;
    this.lastClosedExitPrice = NaN;
    this.lastClosedEntryBarIndex = NaN;
    this.lastClosedExitBarIndex = NaN;
    this.lastClosedEntryTime = NaN;
    this.lastClosedExitTime = NaN;
    this.lastClosedEntryId = "";
    this.lastClosedExitId = "";
    this.lastClosedProfit = NaN;
    this.lastClosedSize = NaN;
    this.tradeMaxRunup = 0;
    this.tradeMaxDrawdown = 0;
    this.lastClosedMaxRunup = NaN;
    this.lastClosedMaxDrawdown = NaN;
    this.closedTradeRecords = [];
    this.entryPending = false;
    this.entryOrderId = "";
    this.entryDirection = "long";
    this.entryQty = 0;
    this.entryQtyAuto = false;
    this.entryLimit = NaN;
    this.entryStop = NaN;
    this.entryOrderComment = "";
    this.closePending = false;
    this.closeOrderId = "";
    this.closeQty = Infinity;
    this.closeOrderComment = "";
    this.closeAllPending = false;
    this.exitPending = false;
    this.exitOrderId = "";
    this.exitFromEntry = "";
    this.exitLimit = NaN;
    this.exitStop = NaN;
    this.exitQty = Infinity;
    this.exitOrderComment = "";
    this.exitCommentLoss = null;
    this.exitCommentProfit = null;
    this.exitCommentTrailing = null;
    this.exitFillKind = null;
    this.exitTrailPoints = NaN;
    this.exitTrailOffset = NaN;
    this.exitTrailPrice = NaN;
    this.exitTrailPriceArg = NaN;
    this.exitProfitPoints = NaN;
    this.exitLossPoints = NaN;
    this.orderPending = false;
    this.orderOrderId = "";
    this.orderDirection = "long";
    this.orderQty = 0;
    this.orderQtyAuto = false;
    this.orderLimit = NaN;
    this.orderStop = NaN;
    this.orderOrderComment = "";
    this.allowedDirection = "all";
    this.maxIntradayFilledOrders = NaN;
    this.intradayFilledCount = 0;
    this.intradayDayKey = NaN;
    this.maxDrawdownValue = NaN;
    this.maxDrawdownType = "cash";
    this.drawdownLimitReached = false;
    this.maxIntradayLossValue = NaN;
    this.maxIntradayLossType = "cash";
    this.intradayPeakEquity = NaN;
    this.intradayLossLimitReached = false;
    this.maxPositionSizeValue = NaN;
    this.maxConsLossDaysValue = NaN;
    this.consLossDayCount = 0;
    this.consLossDayStartRealizedPnl = NaN;
    this.consLossLimitReached = false;
  }

  // strategy() 지시어의 default_qty_value/pyramiding/initial_capital 주입(C164, C165에서 세 번째
  // 인자 추가, C171에서 default_qty_type 네 번째 인자 추가, C330에서 cash 다섯 번째 인자 추가) —
  // codegen이 프리앰블(ctx당 1회 실행 영역)에 방출하므로 바 루프 시작 전에 정확히 한 번 호출된다.
  // initialCapital/qtyIsPercent/qtyIsCash는 기본 파라미터로 두어 이전 슬라이스가 방출한 2~4-인자
  // 호출 형태(및 그 exact-string 테스트)가 그대로 유효하다 — codegen도 미지정 슬롯 뒤쪽은 방출을
  // 생략한다(C129 원칙).
  configure(
    defaultQty: number, pyramiding: number, initialCapital: number = 100000,
    qtyIsPercent: boolean = false, qtyIsCash: boolean = false,
  ): void {
    this.defaultQty = defaultQty;
    this.pyramiding = pyramiding;
    this.initialCapital = initialCapital;
    this.qtyIsPercent = qtyIsPercent;
    this.qtyIsCash = qtyIsCash;
  }

  // strategy.openprofit — 미실현 손익(pine2py engine.py openprofit 프로퍼티의 signed-posSize 형:
  // flat=0, 롱=(close-avg)*size, 숏=(avg-close)*size — 부호 있는 posSize 곱 하나로 두 분기 동치).
  // 현재 바 close는 브로커 상태가 아니라 시장 데이터라 호출자(codegen이 방출하는 식)가 인자로
  // 넘긴다 — position_size류 순수 프로퍼티 식과 달리 메서드 호출 식으로 등록되는 이유.
  openProfit(closePrice: number): number {
    if (this.posSize === 0) return 0;
    return (closePrice - this.posAvgPrice) * this.posSize;
  }

  // strategy.equity = initial_capital + 실현 손익 + 미실현 손익 (engine.py equity 프로퍼티 literal port).
  equity(closePrice: number): number {
    return this.initialCapital + this.realizedPnl + this.openProfit(closePrice);
  }

  // strategy.max_drawdown — Context.advance()가 매 바 processFills() 직후, barFn 실행 **전에**
  // 호출한다(C172). next_hint는 이 갱신에 "barFn 실행 후" 훅이 필요하다고 예상했으나 재검토 결과
  // 불필요하다고 판단했다: 이 엔진은 스트리밍이 아니라 배치 리플레이라 Context가 OHLCV 전 배열을
  // 생성 시점에 이미 쥐고 있고(context.ts Series 생성자), close.advance()도 processFills보다
  // 먼저 실행되므로 이 시점의 `this.close.get(0)`은 이미 "이 바의 실제 close"다 — barFn이 나중에
  // strategy.equity를 읽어도 정확히 같은 값을 본다(같은 Series 커서). 즉 "이 바에 스크립트가 보게 될
  // equity"의 히스토리를 여기서 그대로 누적하면 충분하고 별도 사후 훅이 필요 없다(MEMORY.md
  // "next_hint도 틀릴 수 있다" 원칙 재확인 — 소스를 실행 흐름까지 추적해 재검증함).
  // peakEquity가 NaN(첫 호출)이면 initialCapital로 시드한다 — configure()는 프리앰블(바 루프 시작
  // 전 정확히 1회)에서 이미 끝나 있으므로 이 시점의 initialCapital은 최종값이다. TV 실측 미검증
  // 가설(DIVERGENCES #75): (a) close 기준(intrabar high/low 미반영), (b) 통화 절대값(퍼센트 아님).
  updateDrawdown(closePrice: number): void {
    if (Number.isNaN(this.peakEquity)) {
      this.peakEquity = this.initialCapital;
      this.peakEquityAtMaxDrawdown = this.initialCapital; // maxDrawdown=0 시점의 분모 시드(C333)
    }
    const currentEquity = this.equity(closePrice);
    if (currentEquity > this.peakEquity) this.peakEquity = currentEquity;
    const drawdown = this.peakEquity - currentEquity;
    if (drawdown > this.maxDrawdown) {
      this.maxDrawdown = drawdown;
      this.peakEquityAtMaxDrawdown = this.peakEquity; // C333: 이 최댓값이 갱신된 시점의 peak 스냅샷
    }

    // strategy.max_runup(C674) — max_drawdown을 뒤집은 대칭 축(위 클래스 필드 주석 참조).
    if (Number.isNaN(this.troughEquity)) {
      this.troughEquity = this.initialCapital;
      this.troughEquityAtMaxRunup = this.initialCapital;
    }
    if (currentEquity < this.troughEquity) this.troughEquity = currentEquity;
    const runup = currentEquity - this.troughEquity;
    if (runup > this.maxRunup) {
      this.maxRunup = runup;
      this.troughEquityAtMaxRunup = this.troughEquity;
    }

    // strategy.risk.max_drawdown(C322) — 영구 래치. peakEquity가 시드된 이 시점 이후에만 의미가
    // 있어 위 두 줄 다음에 판정(같은 바에서 peakEquity가 이미 이번 equity를 반영한 뒤).
    if (!this.drawdownLimitReached && !Number.isNaN(this.maxDrawdownValue)) {
      const measure = this.maxDrawdownType === "percent_of_equity" ? (this.maxDrawdown / this.peakEquity) * 100 : this.maxDrawdown;
      if (measure >= this.maxDrawdownValue) this.drawdownLimitReached = true;
    }

    // strategy.risk.max_intraday_loss(C322) — 거래일 한정 peak(intradayPeakEquity, processFills의
    // 거래일 경계 블록이 day 전환 시 NaN으로 리셋)를 전체 peakEquity와 동일한 "NaN-시드 후 ratchet"
    // 패턴으로 갱신한다.
    if (Number.isNaN(this.intradayPeakEquity)) this.intradayPeakEquity = currentEquity;
    if (currentEquity > this.intradayPeakEquity) this.intradayPeakEquity = currentEquity;
    if (!this.intradayLossLimitReached && !Number.isNaN(this.maxIntradayLossValue)) {
      const intradayLoss = this.intradayPeakEquity - currentEquity;
      const measure =
        this.maxIntradayLossType === "percent_of_equity" ? (intradayLoss / this.intradayPeakEquity) * 100 : intradayLoss;
      if (measure >= this.maxIntradayLossValue) this.intradayLossLimitReached = true;
    }
  }

  // strategy.max_contracts_held_all/long/short(C334) — updateDrawdown()과 동일 호출 위치(Context.advance()
  // 참조)에서 이번 바 최종 posSize로 러닝 최댓값을 갱신. posSize===0(flat)이면 어느 방향도 갱신하지 않는다.
  updateMaxContractsHeld(): void {
    const size = Math.abs(this.posSize);
    if (size > this.maxContractsHeldAll) this.maxContractsHeldAll = size;
    if (this.posSize > 0 && size > this.maxContractsHeldLong) this.maxContractsHeldLong = size;
    else if (this.posSize < 0 && size > this.maxContractsHeldShort) this.maxContractsHeldShort = size;
  }

  // strategy.closedtrades/opentrades.max_drawdown/max_runup(hand-verified, C312) — processFills가
  // 이번 바의 fills를 반영하기 **전에**(processFills 첫 줄) 호출된다: 이번 바에 청산되는 트레이드는
  // 청산을 유발한 손절/익절 등 극값이 바로 이 바의 high/low에 있으므로, 그 갱신이 먼저 반영된
  // 뒤에야 closeAt()이 정확한 값을 스냅샷할 수 있다(반대로 이번 바에 새로 열리는 트레이드는 자신의
  // 진입 바 자체의 인트라바 구간은 반영되지 않고 다음 바부터 누적되는 알려진 단순화 — LIMITATIONS.md).
  // openProfit과 동일한 부호 공식((price-avg)*posSize, 롱/숏 무관)으로 이번 바 high/low 각각의
  // 미실현 손익을 구해 러닝 최대/최소에 반영 — 둘 다 0 미만으로는 안 내려간다(TV: 한 번도 유리(불리)
  // 했던 적이 없으면 runup(drawdown)은 0). high/low가 NaN(마켓 전용 단위 테스트 기본값)이면 모든
  // 비교가 false라 안전하게 no-op(MEMORY.md C91 축).
  updateTradeExcursion(high: number, low: number): void {
    if (this.posSize === 0) return;
    const pnlAtHigh = (high - this.posAvgPrice) * this.posSize;
    const pnlAtLow = (low - this.posAvgPrice) * this.posSize;
    const bestPnl = pnlAtHigh > pnlAtLow ? pnlAtHigh : pnlAtLow;
    const worstPnl = pnlAtHigh < pnlAtLow ? pnlAtHigh : pnlAtLow;
    if (bestPnl > this.tradeMaxRunup) this.tradeMaxRunup = bestPnl;
    if (-worstPnl > this.tradeMaxDrawdown) this.tradeMaxDrawdown = -worstPnl;
  }

  // strategy.closedtrades.<method>(trade_num)(C579, 배치28 (1)) — closedTradeRecords 전 인덱스
  // 지원(0=가장 오래된 트레이드 ~ closedTrades-1=가장 최근). 범위 밖 index는 pine2js가 갖고 있지
  // 않은 데이터라 조용히 얼버무리지 않고 명시적으로 던진다(MEMORY.md "조용한 오답 방지" 축과 동일
  // 원칙). 가드는 긍정형(index>=0 && index<closedTrades, MEMORY.md C91)으로 NaN/비정상 index가
  // 실수로 통과하지 않게 한다 — 단 index===-1 && closedTrades===0(청산 전 `closedtrades-1` 관용구가
  // 자연히 만드는 값)은 예외로 계속 허용해 na 기본값을 반환한다(C173 이래 기존 관례, 아래
  // closedTradeRecordAt 참조). 모든 closedTradeXxx 접근자가 공유하는 단일 검증 지점.
  private assertValidClosedTradeIndex(method: string, index: number): void {
    const validBeforeAnyClose = index === -1 && this.closedTrades === 0;
    if (!validBeforeAnyClose && !(index >= 0 && index < this.closedTrades)) {
      throw new Error(
        `strategy.closedtrades.${method}: index ${index}는 미지원 — 유효 범위 0~${this.closedTrades - 1}(closedTrades=${this.closedTrades})`,
      );
    }
  }

  // 청산 전(closedTrades===0)의 index===-1 요청은 실제 레코드가 없어 배열 인덱싱이 불가능하다 —
  // 기존 lastClosed* 필드의 생성자 초기값(NaN/"")과 동일한 "빈 트레이드" 스냅샷을 반환해 C173 이래
  // 기존 관례(청산 전 조회는 예외가 아니라 na)를 유지한다.
  private static readonly EMPTY_CLOSED_TRADE_RECORD: ClosedTradeRecord = {
    entryComment: "", exitComment: "", entryPrice: NaN, exitPrice: NaN,
    entryBarIndex: NaN, exitBarIndex: NaN, entryTime: NaN, exitTime: NaN,
    entryId: "", exitId: "", profit: NaN, size: NaN, maxRunup: NaN, maxDrawdown: NaN,
  };

  private closedTradeRecordAt(index: number): ClosedTradeRecord {
    if (index === -1 && this.closedTrades === 0) return StrategyState.EMPTY_CLOSED_TRADE_RECORD;
    return this.closedTradeRecords[index]!;
  }

  closedTradeEntryComment(index: number): string {
    this.assertValidClosedTradeIndex("entry_comment", index);
    return this.closedTradeRecordAt(index).entryComment;
  }

  closedTradeExitComment(index: number): string {
    this.assertValidClosedTradeIndex("exit_comment", index);
    return this.closedTradeRecordAt(index).exitComment;
  }

  closedTradeEntryPrice(index: number): number {
    this.assertValidClosedTradeIndex("entry_price", index);
    return this.closedTradeRecordAt(index).entryPrice;
  }

  closedTradeExitPrice(index: number): number {
    this.assertValidClosedTradeIndex("exit_price", index);
    return this.closedTradeRecordAt(index).exitPrice;
  }

  closedTradeEntryBarIndex(index: number): number {
    this.assertValidClosedTradeIndex("entry_bar_index", index);
    return this.closedTradeRecordAt(index).entryBarIndex;
  }

  closedTradeExitBarIndex(index: number): number {
    this.assertValidClosedTradeIndex("exit_bar_index", index);
    return this.closedTradeRecordAt(index).exitBarIndex;
  }

  closedTradeEntryId(index: number): string {
    this.assertValidClosedTradeIndex("entry_id", index);
    return this.closedTradeRecordAt(index).entryId;
  }

  closedTradeExitId(index: number): string {
    this.assertValidClosedTradeIndex("exit_id", index);
    return this.closedTradeRecordAt(index).exitId;
  }

  closedTradeProfit(index: number): number {
    this.assertValidClosedTradeIndex("profit", index);
    return this.closedTradeRecordAt(index).profit;
  }

  closedTradeSize(index: number): number {
    this.assertValidClosedTradeIndex("size", index);
    return this.closedTradeRecordAt(index).size;
  }

  // strategy.closedtrades.entry_time/exit_time(index)(C418) — entry_bar_index/exit_bar_index와
  // 동일 원칙의 시간판(ms, entryTimeOpen/closeAt의 barTimeMs 스냅샷).
  closedTradeEntryTime(index: number): number {
    this.assertValidClosedTradeIndex("entry_time", index);
    return this.closedTradeRecordAt(index).entryTime;
  }

  closedTradeExitTime(index: number): number {
    this.assertValidClosedTradeIndex("exit_time", index);
    return this.closedTradeRecordAt(index).exitTime;
  }

  // strategy.closedtrades.commission(index)(C418) — commission 0 고정 기존 결정 그대로(주석
  // "Trade 객체 없이 스칼라 누적기 6개로 동일한 관측값을 유지한다(commission 0 고정...)" 참조,
  // engine.py Trade.commission도 항상 0.0). index 유효성만 다른 접근자와 동일하게 검증.
  closedTradeCommission(index: number): number {
    this.assertValidClosedTradeIndex("commission", index);
    return 0;
  }

  // strategy.closedtrades.profit_percent(index)(C312) — pine2py types.py Trade.profit_percent
  // literal port(entry_price==0이면 0 — division-by-zero 방지, pine2py도 동일 가드 없이 ZeroDivisionError
  // 크래시하므로 이 가드 자체는 TV 미검증 가설이지만 "조용한 오답 방지"보다 "크래시 방지"가 안전한
  // 방향이라 채택). direction은 size의 부호로 판별(양수=롱, 음수=숏 — closedTradeSize와 동일 규약).
  closedTradeProfitPercent(index: number): number {
    this.assertValidClosedTradeIndex("profit_percent", index);
    const rec = this.closedTradeRecordAt(index);
    if (rec.entryPrice === 0) return 0;
    return rec.size >= 0
      ? ((rec.exitPrice - rec.entryPrice) / rec.entryPrice) * 100
      : ((rec.entryPrice - rec.exitPrice) / rec.entryPrice) * 100;
  }

  closedTradeMaxRunup(index: number): number {
    this.assertValidClosedTradeIndex("max_runup", index);
    return this.closedTradeRecordAt(index).maxRunup;
  }

  closedTradeMaxDrawdown(index: number): number {
    this.assertValidClosedTradeIndex("max_drawdown", index);
    return this.closedTradeRecordAt(index).maxDrawdown;
  }

  // strategy.opentrades.<method>(index)(C308) — Position dataclass(entry_id/entry_price/
  // entry_bar/size) 대응, STRATEGY_RUNTIME_PROPS의 opentrades 스칼라 카운트(posSize===0?0:1)와
  // 동일 전제라 열린 포지션이 있을 때 index=0(단일 가상 트레이드, 피라미딩도 이 모델로 압축)만
  // 유효 — 살아있는 상태를 그대로 읽어 별도 캐시가 불필요하다(closedtrades와 달리 청산 스냅샷이
  // 아니라 현재 posSize/posAvgPrice/entryId/entryBarIndexOpen 자체가 곧 "열린 트레이드").
  // C578(exec 클러스터 wild 실측 75건 전수, 전부 posSize===0에서 크래시): "열린 트레이드가 아예
  // 없음"과 "트레이드는 있는데 index가 그 트레이드가 아님(피라미딩 세부 미보유)"은 서로 다른
  // 케이스다 — 후자만 "틀린 값을 조용히 반환"할 위험이 있는 진짜 갭이라 하드 에러 유지, 전자는
  // `strategy.opentrades > 0 and strategy.opentrades.entry_bar_index(0) >= n`류 TV eager and/or
  // 관용구(VERIFIED_SEMANTICS "TV v5는 and/or 양변을 모두 평가")가 매 바 무조건 이 접근자를
  // 호출해 flat 상태에서도 흔히 도달하므로, 데이터가 아예 없는 na로 처리(TV 미검증 가설,
  // DIVERGENCES 추가 예정 — pine2py에 이 API 자체가 없어 오라클 대조 불가는 기존과 동일).
  private assertOpenTrade(method: string, index: number): void {
    if (this.posSize !== 0 && index !== 0) {
      throw new Error(
        `strategy.opentrades.${method}: index ${index}는 미지원 — 열린 포지션은 index=0(단일 가상 트레이드)만 지원(피라미딩 세부 트레이드 미보유, LIMITATIONS.md)`,
      );
    }
  }

  openTradeEntryPrice(index: number): number {
    this.assertOpenTrade("entry_price", index);
    return this.posSize === 0 ? NaN : this.posAvgPrice;
  }

  openTradeEntryBarIndex(index: number): number {
    this.assertOpenTrade("entry_bar_index", index);
    return this.posSize === 0 ? NaN : this.entryBarIndexOpen;
  }

  // strategy.opentrades.entry_time(index)(C418) — entry_bar_index와 동일 원칙의 시간판(ms).
  openTradeEntryTime(index: number): number {
    this.assertOpenTrade("entry_time", index);
    return this.posSize === 0 ? NaN : this.entryTimeOpen;
  }

  openTradeEntryId(index: number): string {
    this.assertOpenTrade("entry_id", index);
    return this.entryId ?? "";
  }

  openTradeSize(index: number): number {
    this.assertOpenTrade("size", index);
    return this.posSize === 0 ? NaN : this.posSize;
  }

  // strategy.opentrades.commission(index)(C418) — closedTradeCommission과 동일 원칙(commission 0
  // 고정), 아직 청산 전이라도 진입 커미션은 항상 0이라 시점 무관.
  openTradeCommission(index: number): number {
    this.assertOpenTrade("commission", index);
    return this.posSize === 0 ? NaN : 0;
  }

  // strategy.opentrades.profit(index)(C312) — closedTradeProfit과 달리 미실현 손익이라 현재 종가가
  // 필요하다(strategy.openprofit(closePrice)와 동일 구조 — codegen이 `$.close.get(0)`을 인자로
  // 주입한다, codegen.ts OPEN_TRADE_CLOSE_PRICE_METHODS 참조). openProfit을 그대로 재사용(단일
  // 가상 트레이드 = 현재 포지션 전체라 값이 완전히 동치) — 단 openProfit 자체는 strategy.openprofit
  // 스칼라용이라 flat=0을 반환하므로(C578) "트레이드 0의 손익" 의미로는 na가 맞아 여기서 override.
  openTradeProfit(closePrice: number, index: number): number {
    this.assertOpenTrade("profit", index);
    return this.posSize === 0 ? NaN : this.openProfit(closePrice);
  }

  // strategy.opentrades.profit_percent(index)(C312) — closedTradeProfitPercent의 미실현 버전.
  // pine2py Position dataclass엔 이 계산 자체가 없어(profit도 없음) 전부 hand-verified.
  openTradeProfitPercent(closePrice: number, index: number): number {
    this.assertOpenTrade("profit_percent", index);
    if (this.posSize === 0) return NaN;
    if (this.posAvgPrice === 0) return 0;
    return this.posSize > 0
      ? ((closePrice - this.posAvgPrice) / this.posAvgPrice) * 100
      : ((this.posAvgPrice - closePrice) / this.posAvgPrice) * 100;
  }

  openTradeMaxRunup(index: number): number {
    this.assertOpenTrade("max_runup", index);
    return this.posSize === 0 ? NaN : this.tradeMaxRunup;
  }

  openTradeMaxDrawdown(index: number): number {
    this.assertOpenTrade("max_drawdown", index);
    return this.posSize === 0 ? NaN : this.tradeMaxDrawdown;
  }

  // percent_of_equity 자동 수량(C171): 체결가 기준 equity의 percent%를 체결가로 나눈 계약 수 —
  // qty = equity(체결가) * percent/100 / 체결가. TV는 산출 수량을 심볼 최소 수량 단위(qty step)로
  // 내림하는 것으로 알려져 있으나 syminfo 미구현이라 소수 수량을 그대로 쓴다(trail_points의
  // mintick=1 가정과 같은 축 — TV 실측 미검증 가설, DIVERGENCES #74). equity가 0 이하(파산)면
  // 음수/0 수량이 나오며 호출부의 긍정형 가드가 주문을 미체결 소진시킨다.
  private autoQtyAt(fillPrice: number, percent: number): number {
    return (this.equity(fillPrice) * percent) / 100 / fillPrice;
  }

  // strategy.cash 자동 수량(C330): 현금 금액을 체결가로 나눈 계약 수 — qty = 금액 / 체결가.
  // percent_of_equity(위 autoQtyAt)와 달리 equity(잔고)와는 무관한 절대 금액 축(pine2py는
  // 소비 로직이 없어 산식 자체가 TV 실측 미검증 가설, DIVERGENCES #74). 소수 수량 그대로(qty step
  // 내림 없음 — syminfo 미구현, autoQtyAt (d)와 동일 축). 금액<=0이면 qty<=0이 나와 호출부의
  // 긍정형 가드(`qty > 0`)가 주문을 미체결 소진시킨다(equity<=0 파산 분기와 동일 관례).
  private autoQtyCashAt(fillPrice: number, cashAmount: number): number {
    return cashAmount / fillPrice;
  }

  // strategy.default_entry_qty(price)(C429) — entry()/order()의 qty 생략 시 실제로 쓰일 기본
  // 수량을 그대로 반환(pine2py에 대응 구현 없음, hand-verified "TV 미검증(가설)"). qty_type에
  // 따라 percent_of_equity/cash는 위 두 헬퍼로 price 기준 환산(entry/order 체결 시점의 qtyAuto
  // 해석과 완전히 동일한 3-way 분류), fixed는 price 인자와 무관하게 defaultQty 그대로.
  defaultEntryQty(price: number): number {
    if (this.qtyIsPercent) return this.autoQtyAt(price, this.defaultQty);
    if (this.qtyIsCash) return this.autoQtyCashAt(price, this.defaultQty);
    return this.defaultQty;
  }

  // 포지션 청산 체결(qty 생략=전량) — 실현 손익/트레이드 카운터 누적 + 포지션 감소/리셋(engine.py
  // _close_position의 Trade 생성+_realized_pnl 누적+포지션 리셋을 스칼라 누적기로 압축, commission
  // 0 고정). profit = (체결가-평균진입가)*방향부호*청산수량 — 전량이면 (체결가-avg)*posSize와 동치.
  // qty 부분 청산(C168)은 pine2py에 대응 구현이 없다(exit()가 qty를 받아놓고 _close_position이
  // 무시하는 전량 전용 — C167 소스 확인): 부분 산식(avg 유지·|posSize| 감소·초과 qty는 전량 클램프)
  // 과 "부분 청산 1회 = closedtrades 1건"(pine2py의 _close_position 1회=Trade 1건 관례 준용 — TV는
  // entry별 카운트 가능성) 전부 TV 실측 미검증 가설이다(DIVERGENCES #71).
  // 전량 도달 판정은 정확-0이 보장된다(closeQty===|posSize|일 때 posSize-sign*|posSize|는 IEEE754
  // 정확 0 — C114의 "러닝 합계 잔차" 클래스가 아님. 부분 qty 자체의 fp 잔차는 호출자 데이터 축).
  // processFills의 close/exit 청산 지점과 리버스 지점이 호출. barIndex/exitId(C308)는 C129 원칙대로
  // 뒤쪽 슬롯에 추가(기존 3-인자 호출부 exact-string 무변화) — closedtrades.entry_bar_index/
  // exit_bar_index/entry_id/exit_id/entry_price/exit_price/profit/size 스냅샷에 쓰인다. barTimeMs
  // (C418)는 그보다도 뒤(C129 "실제 지정된 가장 뒤쪽 슬롯까지만" 원칙 — 기존 5-인자 호출부
  // exact-string 무변화) — closedtrades.entry_time/exit_time 스냅샷 전용.
  private closeAt(
    fillPrice: number, qty: number = Infinity, exitComment: string = "",
    barIndex: number = NaN, exitId: string = "", barTimeMs: number = NaN,
  ): void {
    const size = Math.abs(this.posSize);
    const closeQty = qty < size ? qty : size;
    const sign = this.posSize > 0 ? 1 : -1;
    const profit = (fillPrice - this.posAvgPrice) * sign * closeQty;
    this.realizedPnl += profit;
    this.closedTrades += 1;
    // C173/C308: 부분 청산도 "청산 1회"라 매번 갱신(closedTrades 증가와 동일 관례, C168 (3)).
    this.lastClosedEntryComment = this.entryComment;
    this.lastClosedExitComment = exitComment;
    this.lastClosedEntryPrice = this.posAvgPrice;
    this.lastClosedExitPrice = fillPrice;
    this.lastClosedEntryBarIndex = this.entryBarIndexOpen;
    this.lastClosedExitBarIndex = barIndex;
    this.lastClosedEntryTime = this.entryTimeOpen;
    this.lastClosedExitTime = barTimeMs;
    this.lastClosedEntryId = this.entryId ?? "";
    this.lastClosedExitId = exitId;
    this.lastClosedProfit = profit;
    this.lastClosedSize = sign * closeQty;
    // max_drawdown/max_runup(C312) 스냅샷 — 다른 lastClosed* 필드와 동일하게 부분 청산도 "청산
    // 1회"라 매번 갱신한다(closedTrades 증가와 동일 관례, 바로 위 주석). 러닝값 자체의 리셋은
    // 부분 청산에서는 하지 않는다(잔여 포지션의 트레이드가 아직 안 끝났으므로) — 전량 청산(flat
    // 전환) 시에만 아래에서 0으로 되돌린다.
    this.lastClosedMaxRunup = this.tradeMaxRunup;
    this.lastClosedMaxDrawdown = this.tradeMaxDrawdown;
    // C579: trade_num 전 인덱스 조회용 레코드 push — 위 lastClosed* 스냅샷과 완전히 동일한 값(그
    // 필드들의 push 시점 그대로 복사)이라 이후 별도 동기화가 필요 없다.
    this.closedTradeRecords.push({
      entryComment: this.lastClosedEntryComment,
      exitComment: this.lastClosedExitComment,
      entryPrice: this.lastClosedEntryPrice,
      exitPrice: this.lastClosedExitPrice,
      entryBarIndex: this.lastClosedEntryBarIndex,
      exitBarIndex: this.lastClosedExitBarIndex,
      entryTime: this.lastClosedEntryTime,
      exitTime: this.lastClosedExitTime,
      entryId: this.lastClosedEntryId,
      exitId: this.lastClosedExitId,
      profit,
      size: this.lastClosedSize,
      maxRunup: this.lastClosedMaxRunup,
      maxDrawdown: this.lastClosedMaxDrawdown,
    });
    // avg_winning_trade_percent/avg_losing_trade_percent(C674) — closedTradeProfitPercent와
    // 동일 공식(entryPrice===0 가드, direction은 profit과 같은 sign 변수로 판별 — closedTradeSize와
    // 동일 규약이라 별도 재계산 불필요).
    const entryPriceForPct = this.lastClosedEntryPrice;
    const profitPercent =
      entryPriceForPct === 0 ? 0 : sign > 0
        ? ((fillPrice - entryPriceForPct) / entryPriceForPct) * 100
        : ((entryPriceForPct - fillPrice) / entryPriceForPct) * 100;
    if (profit > 0) {
      this.winTrades += 1;
      this.grossProfit += profit;
      this.sumWinProfitPercent += profitPercent;
    } else if (profit < 0) {
      this.lossTrades += 1;
      this.grossLoss += profit;
      this.sumLossProfitPercent += profitPercent;
    } else {
      this.evenTrades += 1;
    }
    this.posSize -= sign * closeQty;
    if (this.posSize === 0) {
      this.tradeMaxRunup = 0;
      this.tradeMaxDrawdown = 0;
      this.posAvgPrice = NaN;
      this.entryId = null;
      this.entryComment = "";
      this.entryCount = 0;
      this.entryBarIndexOpen = NaN;
      this.entryTimeOpen = NaN;
      // 포지션 전량 청산 시 pending exit 자동 소멸(pine2py _close_position의 from_entry 주문 제거
      // 동형, C167) — exit 자신의 체결 소비/close 마켓 청산/리버스 entry 세 경로 모두 여기 한 곳으로
      // 수렴. 부분 청산(잔여 포지션 존재)은 브래킷 유지 — 잔여분의 익절/손절이 계속 유효한 쪽이 TV
      // 브래킷 의도에 맞는다는 가설(exit 자신의 부분 체결은 processFills가 주문 소비를 별도 수행,
      // DIVERGENCES #71). entryCount(pyramiding 게이트)도 유지 — 부분 청산이 추가 진입 여력을
      // 되돌리는지는 TV 미검증이라 보수적으로 불변(LIMITATIONS.md).
      this.exitPending = false;
    }
  }

  // strategy.risk.allow_entry_in(value)(C309) — value는 컴파일타임 상수가 아닐 수 있어(wild:
  // 삼항식으로 조립) 런타임에서도 이중 방어(entry()의 direction 검증과 동일 관례). "all"은 제한
  // 해제(기본값) — pine2py에 대응 구현이 전혀 없어 hand-verified 신규 설계(TV 미검증 가설,
  // DIVERGENCES 참조). 실제 제한 적용은 processFills의 entry 체결 분기에서 일어난다(콜타임이
  // 아니라 체결 시점 — entryDirection 등 다른 필드와 동일한 "체결 시점 해석" 원칙).
  setAllowEntryIn(direction: string): void {
    if (direction !== "all" && direction !== "long" && direction !== "short") {
      throw new Error(
        `strategy.risk.allow_entry_in: 지원하지 않는 value '${String(direction)}' ("all"/"long"/"short"만 지원)`,
      );
    }
    this.allowedDirection = direction;
  }

  // strategy.risk.max_intraday_filled_orders(count)(C320, wild "지원하지 않는 호출" 클러스터
  // next_hint 2순위 서브그룹) — pine2py에 대응 구현이 전혀 없어(allow_entry_in과 동일 근거)
  // hand-verified 신규 설계, "TV 미검증(가설)": 근거는 allow_entry_in과 같은 wild 코퍼스 자신에
  // 포함된 TV 문서 발췌(86e04be3ab6c.pine, DESCRIPTION:: "stops new orders for the current day
  // once the maximum allowed number of filled orders (count) is reached", REMARKS:: "A market
  // order to exit a current open position is still allowed, even after the limit is reached.").
  // count<=0/NaN도 그대로 저장 — processFills 게이트가 `intradayFilledCount >= NaN`은 항상
  // false로 안전하게 무시(C91 긍정형 가드와 동일 원칙), count<=0은 그날 즉시 전면 차단으로
  // 자연히 동작해 별도 검증 분기가 불필요하다.
  setMaxIntradayFilledOrders(count: number): void {
    this.maxIntradayFilledOrders = count;
  }

  // strategy.risk.max_drawdown(value, type)(C322) — value<=0/NaN도 그대로 저장하고 실제 판정은
  // updateDrawdown에서 일어난다(allow_entry_in/max_intraday_filled_orders와 동일 "저장은 setter,
  // 판정은 다른 곳" 분리 원칙). type은 setAllowEntryIn과 동일하게 이중 방어(analyzer가 이미
  // strategy.cash/percent_of_equity 상수만 문자열로 접지만, 런타임에서도 검증).
  setMaxDrawdown(value: number, type: string): void {
    if (type !== "cash" && type !== "percent_of_equity") {
      throw new Error(
        `strategy.risk.max_drawdown: 지원하지 않는 type '${String(type)}' ("strategy.cash"/"strategy.percent_of_equity"만 지원)`,
      );
    }
    this.maxDrawdownValue = value;
    this.maxDrawdownType = type;
  }

  // strategy.risk.max_intraday_loss(value, type)(C322) — setMaxDrawdown과 동일 관례, 거래일 한정
  // peak(intradayPeakEquity)을 기준으로 삼는다는 점만 다르다(updateDrawdown 참조).
  setMaxIntradayLoss(value: number, type: string): void {
    if (type !== "cash" && type !== "percent_of_equity") {
      throw new Error(
        `strategy.risk.max_intraday_loss: 지원하지 않는 type '${String(type)}' ("strategy.cash"/"strategy.percent_of_equity"만 지원)`,
      );
    }
    this.maxIntradayLossValue = value;
    this.maxIntradayLossType = type;
  }

  // strategy.risk.max_position_size(value)(C324) — value<=0/NaN도 그대로 저장(allow_entry_in류와
  // 동일 "저장은 setter, 판정은 다른 곳" 분리 원칙). 실제 캡 적용은 processFills의 entry 체결
  // 분기에서 일어난다(qty_type 인자는 wild 실사용 0건이라 미지원 — C283 큐레이션, LIMITATIONS.md).
  setMaxPositionSize(value: number): void {
    this.maxPositionSizeValue = value;
  }

  // strategy.risk.max_cons_loss_days(count)(C325) — value<=0/NaN도 그대로 저장(형제들과 동일
  // "저장은 setter, 판정은 다른 곳" 분리 원칙). 실제 스트릭 판정/래치는 processFills의 거래일
  // 경계 블록에서 일어난다.
  setMaxConsLossDays(count: number): void {
    this.maxConsLossDaysValue = count;
  }

  // strategy.entry(id, direction, qty=default_qty_value, limit=, stop=) — 주문 큐잉. 마켓은 다음 바
  // open의 processFills에서 체결, limit/stop은 가격 조건 충족 바까지 이월(C166). direction은
  // analyzer가 strategy.long/strategy.short 상수만 폴딩하지만 문자열 리터럴/변수로 우회 전달될 수
  // 있어 런타임에서도 조용한 오동작 대신 하드 에러로 막는다(이중 방어).
  // limit/stop의 na(NaN)는 "조건 없음"으로 정규화한다(limit=na는 마켓 주문) — pine2py는 na를
  // nan 가격의 limit 주문으로 만들어 영원히 미체결로 남는데, 이는 None(인자 생략 센티널)과 na가
  // 겹치는 C107/C110 클래스의 부작용이라 이식하지 않는다(DIVERGENCES #69, TV 미검증 가설).
  // when=(C372)은 pine2py entry(..., when=True, **kwargs)의 게이트 파라미터 literal port —
  // close()의 when=(C293)과 동일하게 함수 최상단에서 direction 검증보다 먼저 판정한다(when=false면
  // direction이 잘못돼도 에러 없이 완전 no-op이어야 "이 콜 자체가 없었던 것"이라는 게이트 의미와
  // 일치). 생략(JS 기본 파라미터)은 항상 true로 떨어져 기존 호출 무변화.
  entry(
    id: string | null | undefined, direction: string, qty?: number, limit?: number, stop?: number,
    comment?: string, when: boolean = true,
  ): void {
    if (!when) return;
    if (direction !== "long" && direction !== "short") {
      throw new Error(
        `strategy.entry: 지원하지 않는 direction '${String(direction)}' ("long"/"short"만 지원)`,
      );
    }
    // na 안전성: id가 na(null)이거나 qty가 na(NaN) 또는 0 이하면 주문을 내지 않는다(LIMITATIONS.md).
    // `!(qty > 0)`은 NaN에서도 안전한 긍정형 가드(MEMORY.md C91 — NaN 비교는 항상 false).
    if (id === null || id === undefined) return;
    // percent_of_equity(C171)/cash(C330): qty 생략 시 defaultQty는 지분율 % 또는 통화 금액으로
    // 해석 — 계약 수는 체결가가 확정되는 processFills에서 산출해야 하므로(둘 다 체결가의 함수)
    // 여기서는 원시값을 그대로 싣고 auto 플래그만 세운다(정확한 산식은 qtyIsCash로 그 지점에서
    // 분기). qty= 명시는 유형 무관 계약 수 그대로(TV: qty 인자는 default_qty_*를 덮어쓰는 계약 수
    // — TV 실측 미검증 가설, DIVERGENCES #74). 가드는 세 해석 공통(>0 필수).
    const qtyAuto = qty === undefined && (this.qtyIsPercent || this.qtyIsCash);
    if (qty === undefined) qty = this.defaultQty; // 콜타임 해석 — configure는 프리앰블에서 이미 완료
    if (!(qty > 0)) return;
    const cmt = comment ?? "";
    if (this.entryPending) {
      // 같은 id 재호출 = 기존 주문 수정(TV: 동일 id 주문은 대체 — qty/direction/limit/stop 전부.
      // 이월 중인 limit 주문을 마켓으로 바꾸는 것도 이 경로). 다른 id면 첫 주문 유지
      // (LIMITATIONS.md — pyramiding>=2에서 동시 pending entry 2건 이상은 미지원).
      if (this.entryOrderId === id) {
        this.entryQty = qty;
        this.entryQtyAuto = qtyAuto;
        this.entryDirection = direction;
        this.entryLimit = limit ?? NaN;
        this.entryStop = stop ?? NaN;
        this.entryOrderComment = cmt;
      }
      return;
    }
    this.entryPending = true;
    this.entryOrderId = id;
    this.entryDirection = direction;
    this.entryQty = qty;
    this.entryQtyAuto = qtyAuto;
    this.entryLimit = limit ?? NaN;
    this.entryStop = stop ?? NaN;
    this.entryOrderComment = cmt;
  }

  // strategy.order(id, direction, qty=, limit=, stop=) — 넷팅 주문 큐잉(C169). entry와 시그니처는
  // 같지만 체결 시맨틱이 다르다: 콜타임/체결 시점 어디에도 리버스 전량 청산·pyramiding 게이트가
  // 없고, 체결 시 포지션과 같은 방향이면 무조건 가중평균 증분, 반대 방향이면 |posSize|와 상쇄
  // (축소/정확 flat/부호 반전 — processFills의 order 분기 참조). **pine2py order()는 _fill_entry로
  // 직행해 반대 방향이면 기존 포지션을 실현손익 기록 없이 통째로 새 Position으로 교체하는
  // 실버그**(engine.py L353 `direction != order.direction` → 새 Position — next_hint의 "가중평균에
  // 반대 qty 혼입" 서술과 달리 실제로는 전체 교체지만, 어느 쪽이든 TV 넷팅과 다른 비경제 동작이라
  // 미추종. TV order는 순수 방향 주문이라 상쇄가 정합이라는 가설 — TV 실측 미검증, DIVERGENCES #72).
  // id na/qty na·0 이하 가드, defaultQty 해석, limit/stop na 정규화, 같은 id 수정/다른 id 첫 주문
  // 유지, direction 런타임 이중 방어, when=(C372, entry와 동일 관례 — 게이트가 direction 검증보다
  // 먼저) 전부 entry와 동일 관례.
  order(
    id: string | null | undefined, direction: string, qty?: number, limit?: number, stop?: number,
    comment?: string, when: boolean = true,
  ): void {
    if (!when) return;
    if (direction !== "long" && direction !== "short") {
      throw new Error(
        `strategy.order: 지원하지 않는 direction '${String(direction)}' ("long"/"short"만 지원)`,
      );
    }
    if (id === null || id === undefined) return;
    const qtyAuto = qty === undefined && (this.qtyIsPercent || this.qtyIsCash); // percent_of_equity(C171)/cash(C330) — entry와 동일 규약
    if (qty === undefined) qty = this.defaultQty;
    if (!(qty > 0)) return; // NaN에서도 안전한 긍정형 가드(MEMORY.md C91)
    const cmt = comment ?? "";
    if (this.orderPending) {
      if (this.orderOrderId === id) {
        this.orderQty = qty;
        this.orderQtyAuto = qtyAuto;
        this.orderDirection = direction;
        this.orderLimit = limit ?? NaN;
        this.orderStop = stop ?? NaN;
        this.orderOrderComment = cmt;
      }
      return;
    }
    this.orderPending = true;
    this.orderOrderId = id;
    this.orderDirection = direction;
    this.orderQty = qty;
    this.orderQtyAuto = qtyAuto;
    this.orderLimit = limit ?? NaN;
    this.orderStop = stop ?? NaN;
    this.orderOrderComment = cmt;
  }

  // strategy.exit(id, from_entry, limit=익절, stop=손절) — 브래킷 청산 주문 큐잉(C167). limit/stop
  // 중 최소 하나는 analyzer가 강제하지만 na(NaN) 값으로 무력화될 수 있어 런타임에서 재검사한다
  // (둘 다 na면 조건 없는 주문 — TV는 na 파라미터를 "그 축 없음"으로 무시하므로 주문 자체를 내지
  // 않는다. pine2py는 이 경우 마켓 청산(_close_position 즉시 호출)인데, TV 문서가 strategy.exit에
  // 최소 1개 청산 조건을 요구하는 것으로 알려져 있어 미추종 — TV 실측 미검증 가설, DIVERGENCES #70).
  // 콜타임 가드 2종은 pine2py exit() literal port: (1) flat이면 무시(is_flat 가드 — entry와 같은
  // 바에 낸 exit는 등록되지 않는다: 다음 바 open 체결 모델에서는 매 바 재호출이 표준 패턴이라
  // 포지션 성립 다음 바부터 자연 등록, LIMITATIONS.md), (2) from_entry가 지정됐고 현재 포지션의
  // entry id와 다르면 무시(pine2py는 from_entry를 매칭 없이 전량 청산하지만 TV의 "해당 entry 대상"
  // 의도에 맞춰 매칭 — TV 미검증 가설. from_entry=na/생략은 ""로 정규화해 전체 포지션 대상).
  // qty=(C168)는 부분 청산 수량 — 생략은 전량(Infinity 센티널). na(NaN)/0 이하 qty는 entry의
  // qty 가드와 동일한 관례로 호출 전체를 무시한다(주문 미발행/기존 주문 무수정 — entry가 이미
  // 확립한 "qty na는 주문 무시" 규칙의 같은 파라미터 이름 미러, TV 미검증 가설 DIVERGENCES #71).
  // trail_points=/trail_offset=(C170)는 뒤쪽 슬롯으로 추가(C129 원칙 — 기존 콜사이트 출력 무변화).
  // trail_offset 단독(활성화 조건 없는 트레일링)은 analyzer가 하드 에러로 막지만 런타임 우회 대비
  // "청산 조건 없음"으로 접어 주문 미발행(limit/stop/trail_points 셋 다 na와 동일 경로 — pine2py는
  // trail_offset 단독이면 trail_points=0으로 즉시 활성화하는데 TV가 활성화 레벨 없는 trail_offset을
  // 무시하는 것으로 알려져 있어 어느 쪽도 확신 불가, 조용한 오답 방지 축. DIVERGENCES #73).
  // trail_price=(C178)는 그 뒤 슬롯으로 추가(C129 유지) — trail_points와 동시 지정은 analyzer가
  // 하드 에러로 막아 이 함수에서는 항상 둘 중 하나만 유한값이다(DIVERGENCES #79).
  // profit=/loss=(hand-verified)는 그보다 더 뒤 슬롯(C129 유지) — limit=/stop=과 각각 동시 지정은
  // analyzer가 하드 에러로 막아 이 함수에서는 limit/profit, stop/loss 각 쌍이 항상 상호 배타(#98).
  // qty_percent=(C373, hand-verified, TV 미검증 가설 DIVERGENCES) — profit=/loss=보다도 뒤 슬롯.
  // pine2py exit()는 **kwargs로 받아 조용히 버리지만(qty=와 동일 급, C168/C259 선례) TV 문서 규칙
  // "qty_percent 우선순위는 qty보다 낮음"을 그대로 이식: qty가 명시되면 qty_percent는 완전히 무시,
  // qty 생략 시에만 |posSize|*percent/100을 이 호출 시점(콜타임 스냅샷)에 계산해 기존 qty= 부분청산
  // 슬롯에 그대로 태운다 — closeAt 등 하위 체결 로직은 절대값 qty만 보므로 변경 불필요.
  // comment_loss=/comment_profit=(C375, hand-verified)는 qty_percent=보다도 뒤 슬롯 — 값은 null(na)
  // 그대로 저장하고 실제 선택은 exitFillPrice()가 결정한 exitFillKind를 processFills가 읽어 수행한다
  // (이 함수는 값을 받아 저장만, 트리거별 선택 로직 없음). when=(C380)은 pine2py
  // exit(..., when: bool=True, **kwargs)의 게이트 파라미터 literal port — entry/order(C372)/
  // close(C293)/close_all(C378)과 동일하게 함수 최상단에서 id 검증보다 먼저 판정한다(when=false면
  // id/청산조건 상태와 무관하게 무조건 no-op). 생략(JS 기본 파라미터)은 항상 true로 떨어져 기존
  // 호출 무변화. comment_trailing=(C673)은 when= 뒤 마지막 슬롯 — comment_loss/profit과 동일하게
  // 값을 받아 저장만 하고 트리거별 선택(exitFillKind===null)은 processFills가 수행.
  exit(
    id: string | null | undefined, fromEntry?: string | null, limit?: number, stop?: number,
    qty?: number, trailPoints?: number, trailOffset?: number, comment?: string, trailPrice?: number,
    profit?: number, loss?: number, qtyPercent?: number,
    commentLoss?: string | null, commentProfit?: string | null, when: boolean = true,
    commentTrailing?: string | null,
  ): void {
    if (!when) return;
    if (id === null || id === undefined) return;
    const q = qty !== undefined
      ? qty
      : qtyPercent !== undefined
        ? (Math.abs(this.posSize) * qtyPercent) / 100
        : Infinity;
    if (!(q > 0)) return; // NaN에서도 안전한 긍정형 가드(MEMORY.md C91)
    const from = fromEntry ?? "";
    const lim = limit ?? NaN;
    const stp = stop ?? NaN;
    const tp = trailPoints ?? NaN;
    const toff = trailOffset ?? NaN;
    const tprice = trailPrice ?? NaN;
    const prof = profit ?? NaN;
    const loss_ = loss ?? NaN;
    const cmt = comment ?? "";
    const cmtLoss = commentLoss ?? null;
    const cmtProfit = commentProfit ?? null;
    const cmtTrailing = commentTrailing ?? null;
    if (
      Number.isNaN(lim) && Number.isNaN(stp) && Number.isNaN(tp) && Number.isNaN(tprice) &&
      Number.isNaN(prof) && Number.isNaN(loss_)
    ) {
      return;
    }
    if (this.posSize === 0) return;
    if (from !== "" && from !== this.entryId) return;
    if (this.exitPending) {
      // 같은 id 재호출 = 주문 수정(pine2py exit()의 "같은 ID 이전 exit 제거 후 재등록" 동형 —
      // 매 바 재호출로 브래킷 가격을 갱신하는 표준 패턴). 다른 id면 첫 주문 유지(entry 슬롯과
      // 동일한 "동시 pending 1건" 모델, LIMITATIONS.md).
      if (this.exitOrderId === id) {
        this.exitFromEntry = from;
        this.exitLimit = lim;
        this.exitStop = stp;
        this.exitQty = q;
        this.exitTrailPoints = tp;
        this.exitTrailOffset = toff;
        this.exitTrailPriceArg = tprice;
        this.exitProfitPoints = prof;
        this.exitLossPoints = loss_;
        this.exitOrderComment = cmt;
        this.exitCommentLoss = cmtLoss;
        this.exitCommentProfit = cmtProfit;
        this.exitCommentTrailing = cmtTrailing;
        // 달성된 트레일링 라인은 같은 id 수정에서 보존한다 — "매 바 재호출" 표준 패턴에서 래칫이
        // 유지되는 것이 TV 트레일링의 관측 동작(pine2py는 재호출마다 Order를 새로 만들어 trail_price
        // 가 매 바 리셋되는데, 그러면 매 바 재호출 패턴에서 래칫이 절대 형성되지 않아 트레일링이
        // 사실상 무상태가 됨 — 실버그로 판단, 미추종. TV 실측 미검증 가설, DIVERGENCES #73).
        // 트레일링 축이 제거된 수정은 라인도 파기(이후 재도입 시 활성화부터 다시).
        if (Number.isNaN(tp) && Number.isNaN(tprice)) this.exitTrailPrice = NaN;
      }
      return;
    }
    this.exitPending = true;
    this.exitOrderId = id;
    this.exitFromEntry = from;
    this.exitLimit = lim;
    this.exitStop = stp;
    this.exitQty = q;
    this.exitTrailPoints = tp;
    this.exitTrailOffset = toff;
    this.exitTrailPriceArg = tprice;
    this.exitProfitPoints = prof;
    this.exitLossPoints = loss_;
    this.exitOrderComment = cmt;
    this.exitCommentLoss = cmtLoss;
    this.exitCommentProfit = cmtProfit;
    this.exitCommentTrailing = cmtTrailing;
    this.exitTrailPrice = NaN; // 신규 등록은 항상 미활성에서 시작(이전 주문의 잔류 라인 차단)
  }

  // strategy.cancel(id) — 미체결 가격 기반 주문(limit/stop) 취소. **마켓 주문은 취소 대상이 아니다**:
  // pine2py cancel()은 _pending_orders에서 id 매칭 제거인데 마켓 주문은 콜타임 즉시 체결이라 애초에
  // pending에 없고(구조적 참조), TV도 마켓 주문은 다음 틱 무조건 실행이라 취소 불가로 문서화돼 있다
  // (TV 실측 미검증 — DIVERGENCES #69). close의 마켓 청산 주문도 같은 이유로 cancel 대상이 아님.
  // when=(C708) — entry/order/close/close_all/exit(C372/C293/C378/C380)과 동일한 게이트를 마저
  // 이식(hand-verified, DIVERGENCES 신규 — pine2py engine.py cancel(id, when=True)는 when을
  // named parameter로 받으나 본문에서 전혀 참조하지 않는 latent 미적용, literal port 대상 아님).
  cancel(id: string | null | undefined, when: boolean = true): void {
    if (!when) return;
    if (id === null || id === undefined) return;
    if (this.entryPending && this.entryOrderId === id && this.entryIsPriceBased()) {
      this.entryPending = false;
    }
    // exit 주문도 id로 취소 가능(pine2py cancel의 _pending_orders id 매칭이 exit 주문을 포함하는
    // 것과 동형, C167) — exit는 항상 가격 기반이라 마켓 제외 검사가 불필요.
    if (this.exitPending && this.exitOrderId === id) {
      this.exitPending = false;
    }
    // order 주문(C169)도 entry와 동일 규칙: 가격 기반만 취소 가능(마켓은 다음 바 open 무조건 체결).
    if (this.orderPending && this.orderOrderId === id && this.orderIsPriceBased()) {
      this.orderPending = false;
    }
  }

  // strategy.cancel_all() — 모든 미체결 가격 기반 주문 취소(pine2py cancel_all의 pending 전체 clear
  // 에서 마켓 제외 축만 다름 — cancel과 동일한 근거).
  cancel_all(): void {
    if (this.entryPending && this.entryIsPriceBased()) {
      this.entryPending = false;
    }
    this.exitPending = false;
    if (this.orderPending && this.orderIsPriceBased()) {
      this.orderPending = false;
    }
  }

  // limit/stop 중 하나라도 지정된 주문인가(둘 다 NaN이면 마켓). NaN 판별은 자기 비교(x !== x)가
  // 아니라 Number.isNaN으로 명시(가독성 — hot path 아님: 호출 지점이 전부 주문 이벤트 시점).
  private entryIsPriceBased(): boolean {
    return !Number.isNaN(this.entryLimit) || !Number.isNaN(this.entryStop);
  }

  private orderIsPriceBased(): boolean {
    return !Number.isNaN(this.orderLimit) || !Number.isNaN(this.orderStop);
  }

  // strategy.close(id, qty=) — 마켓 청산 주문 큐잉. 호출 시점에 포지션이 없거나 entry id가 다르면
  // 무시(pine2py close()의 콜타임 가드와 동일 — 이 판정은 체결 시점 축과 무관한 순수 시맨틱이라
  // 이식). qty=(C168)는 부분 청산 수량 — 생략은 전량, na/0 이하는 호출 무시(exit의 qty 가드와
  // 동일한 entry 관례 미러). 같은 바에 close_all이 이미 걸려 있으면 부분 close는 전량 청산의
  // 부분집합이라 무시된다(closeAllPending 필드 주석 참조). when=(C293)은 pine2py
  // close(id="", comment="", when=True, **kwargs)의 게이트 파라미터 literal port — 생략(JS 기본
  // 파라미터가 "생략"과 "명시적 undefined"를 동일 취급)은 항상 true로 떨어져 기존 호출 무변화.
  // qty_percent=(C373, hand-verified) — exit()의 qty_percent와 동일 메커니즘(qty 우선, 생략 시에만
  // |posSize|*percent/100 콜타임 계산). posSize===0 조기 반환이 이 계산보다 먼저라 division 걱정 없음.
  // immediately=(C379, hand-verified — pine2py는 close()가 **kwargs로 흡수해 오라클 불가, TV 공식
  // 시맨틱은 "다음 바 open" 큐잉을 건너뛰고 이 바에서 즉시 체결) — currentClose/currentBarIndex는
  // codegen이 $.close.get(0)/$.idx를 암묵 주입한다(트레이드 접근자 OPEN_TRADE_CLOSE_PRICE_METHODS의
  // unshift와 동일 원리). id 매칭/when 게이트는 즉시·큐잉 두 경로가 공유(분기는 그 이후에만 갈림) —
  // closeAllPending 가드는 "다음 바에 이미 전량 청산이 걸려 있으면 부분 큐잉을 skip"하는 pending-vs-
  // pending 축이라 즉시 체결(지금 당장 발생)에는 적용하지 않는다(즉시 체결로 posSize가 0이 되면
  // 나중에 pending 소비 시점의 기존 posSize!==0 가드가 자연히 no-op 처리).
  close(
    id: string | null | undefined, qty?: number, comment?: string, when: boolean = true,
    qtyPercent?: number, immediately?: boolean, currentClose?: number, currentBarIndex?: number,
    currentBarTimeMs?: number,
  ): void {
    if (!when) return;
    if (this.posSize === 0) return;
    if (id === null || id === undefined || id !== this.entryId) return;
    const q = qty !== undefined
      ? qty
      : qtyPercent !== undefined
        ? (Math.abs(this.posSize) * qtyPercent) / 100
        : Infinity;
    if (!(q > 0)) return; // NaN에서도 안전한 긍정형 가드(MEMORY.md C91)
    const cmt = comment ?? "";
    if (immediately) {
      this.closeAt(currentClose ?? NaN, q, cmt, currentBarIndex ?? NaN, id, currentBarTimeMs ?? NaN);
      return;
    }
    if (this.closeAllPending) return;
    this.closePending = true;
    this.closeOrderId = id;
    this.closeQty = q;
    this.closeOrderComment = cmt;
  }

  // strategy.close_all() — id 무관 전량 마켓 청산 주문 큐잉(C168). pine2py close_all()의 콜타임
  // flat 가드는 literal port하되, 체결은 콜타임 즉시 _close_position(당일 close — #66 버그 축)이
  // 아니라 close와 동일하게 다음 바 open이다(TV 규칙). closePending 슬롯을 재사용하고 체결 시
  // id 매칭만 생략한다(closeAllPending 플래그) — 먼저 걸린 close(id, qty=) 부분 주문이 있어도
  // 전량으로 덮어쓴다(전량이 부분의 상위집합). when=(C378)은 pine2py
  // close_all(comment: str="", when: bool=True)의 게이트 파라미터 literal port — entry/order
  // (C372)/close(C293)와 동일하게 함수 최상단에서 flat 검증보다 먼저 판정한다(when=false면 posSize
  // 상태와 무관하게 무조건 no-op). immediately=(C379) — close()와 동일 원리(pine2py close_all()은
  // **kwargs 자체가 없어 구조적 크래시, hand-verified). id 개념이 없어 exitId는 close()의 "id 매칭"
  // 대응물이 없는 빈 문자열로 기록한다(기존 pending 경로도 close_all 전용 id를 추적하지 않음 —
  // closeOrderId는 close()만 채우는 필드, 동일 관례 유지).
  close_all(
    comment?: string, when: boolean = true, immediately?: boolean,
    currentClose?: number, currentBarIndex?: number, currentBarTimeMs?: number,
  ): void {
    if (!when) return;
    if (this.posSize === 0) return;
    const cmt = comment ?? "";
    if (immediately) {
      this.closeAt(currentClose ?? NaN, Infinity, cmt, currentBarIndex ?? NaN, "", currentBarTimeMs ?? NaN);
      return;
    }
    this.closePending = true;
    this.closeAllPending = true;
    this.closeQty = Infinity;
    this.closeOrderComment = cmt;
  }

  // Context.advance()가 매 바 barFn 실행 **전에** 호출한다 — 마켓 주문은 이번 바 open으로 체결
  // (TV 규칙: 주문은 다음 바 open에서 체결되고, 스크립트는 그 바에서 체결 후의 position_size를
  // 본다), limit/stop 주문(C166)은 이번 바에서 가격 조건을 검사해 충족하면 체결·미충족이면 이월.
  // 처리 순서는 close 먼저 → entry: 같은 바에 청산+재진입이 큐잉됐을 때 둘 다 같은 바에서 순차
  // 체결되는 TV 패턴 재현(TV 실측 미검증 가설 — DIVERGENCES.md 참조). 체결이 트리거됐지만
  // 적격성(같은 방향 + pyramiding 소진)에 막힌 entry는 이월 없이 취소된다(마켓과 동일 소진 규칙).
  // high/low는 limit/stop의 intrabar 판정에만 쓰인다 — 마켓 전용 단위 테스트 호환을 위해 기본값
  // NaN(NaN 비교는 전부 false라 intrabar 트리거가 안전하게 죽는다, MEMORY.md C91 축). 실제 실행
  // 경로(Context.advance)는 항상 세 값을 모두 넘긴다. barIndex(C308, C129 원칙대로 뒤쪽 슬롯 추가
  // — 기존 3-인자 호출부 exact-string 무변화)는 closedtrades.entry_bar_index/exit_bar_index 및
  // opentrades.entry_bar_index 스냅샷의 유일한 소스라, 없으면(단위 테스트 기본값) 그 채널만 NaN.
  // barTimeMs(C320, C129/C308과 동일 원칙 — 뒤쪽 슬롯 추가로 기존 4-인자 호출부 exact-string
  // 무변화)는 strategy.risk.max_intraday_filled_orders의 "거래일" 경계 판정 유일한 소스라, 없으면
  // (단위 테스트 기본값) 그 게이트 자체가 무해하게 no-op(아래 NaN 가드).
  processFills(openPrice: number, high: number = NaN, low: number = NaN, barIndex: number = NaN, barTimeMs: number = NaN): void {
    if (!Number.isNaN(barTimeMs)) {
      const d = new Date(barTimeMs);
      const dayKey = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      if (dayKey !== this.intradayDayKey) {
        this.intradayDayKey = dayKey;
        this.intradayFilledCount = 0;
        // strategy.risk.max_intraday_loss(C322) — 거래일 전환 시 이번 거래일의 peak/래치를
        // 리셋(updateDrawdown이 이번 바 close로 intradayPeakEquity를 새로 시드).
        this.intradayPeakEquity = NaN;
        this.intradayLossLimitReached = false;

        // strategy.risk.max_cons_loss_days(C325) — 이 전환 시점에 "끝난"(직전) 거래일의 실현손익을
        // 판정한다: consLossDayStartRealizedPnl이 아직 NaN이면 이번이 관측된 첫 거래일 전환이라
        // 비교 대상(직전 거래일)이 없어 시드만 하고 스트릭 판정은 건너뛴다(intradayPeakEquity류
        // "첫 관측 시드" 패턴과 동일). 그 외엔 realizedPnl 변화량이 음수면 손실일 -> 스트릭 +1,
        // 0 이상(무손실 또는 무거래일 포함)이면 스트릭 리셋. consLossLimitReached는 max_drawdown과
        // 동일한 영구 래치라 여기서 리셋하지 않는다.
        if (!Number.isNaN(this.consLossDayStartRealizedPnl)) {
          const dayPnl = this.realizedPnl - this.consLossDayStartRealizedPnl;
          if (dayPnl < 0) {
            this.consLossDayCount += 1;
            if (
              !this.consLossLimitReached &&
              !Number.isNaN(this.maxConsLossDaysValue) &&
              this.consLossDayCount >= this.maxConsLossDaysValue
            ) {
              this.consLossLimitReached = true;
            }
          } else {
            this.consLossDayCount = 0;
          }
        }
        this.consLossDayStartRealizedPnl = this.realizedPnl;
      }
    }
    this.updateTradeExcursion(high, low);
    if (this.closePending) {
      this.closePending = false;
      const ignoreId = this.closeAllPending; // close_all(C168) — id 매칭 생략(전량 청산)
      this.closeAllPending = false;
      if (this.posSize !== 0 && (ignoreId || this.entryId === this.closeOrderId)) {
        this.closeAt(openPrice, this.closeQty, this.closeOrderComment, barIndex, this.closeOrderId, barTimeMs);
      }
    }
    // exit 브래킷(C167)은 close(마켓 청산) 다음, entry 앞에서 판정한다 — 마켓 close는 open 체결이라
    // 항상 이 바의 첫 가격이고(체결되면 closeAt이 exitPending을 함께 소멸시킴), exit도 청산 계열이라
    // 기존 "청산 먼저 → entry" 순서 원칙에 합류한다(같은 바에 exit 체결+재진입 entry 체결이 순차
    // 발생 가능 — TV 실측 미검증 가설, DIVERGENCES #70). from_entry 매칭은 체결 시점에 재검사
    // (콜타임과 체결 바 사이에 포지션이 바뀔 수 있음 — 불일치면 이월, 포지션 청산 시 자동 소멸).
    if (this.exitPending && this.posSize !== 0 && (this.exitFromEntry === "" || this.exitFromEntry === this.entryId)) {
      const exitFill = this.exitFillPrice(openPrice, high, low);
      if (!Number.isNaN(exitFill)) {
        // 주문 소비는 여기서 명시(C168) — 전량 청산은 closeAt의 flat 리셋이 exitPending을 함께
        // 소멸시키지만, qty= 부분 체결은 포지션이 남아도 브래킷 주문 자체는 체결로 소진돼야 한다
        // (TV: 주문은 1회 체결로 소멸, 잔여분 브래킷은 스크립트가 매 바 재호출로 재발행 — 가설 #71).
        this.exitPending = false;
        // comment_loss=/comment_profit=/comment_trailing=(C375+C673) — exitFillPrice가 남긴
        // exitFillKind로 트리거별 오버라이드를 선택: "profit"→comment_profit=, "loss"→comment_loss=,
        // null(순수 트레일링)→comment_trailing=. 셋 다 미지정(null)이면 comment=로 폴백.
        const exitCmt =
          this.exitFillKind === "profit" && this.exitCommentProfit !== null
            ? this.exitCommentProfit
            : this.exitFillKind === "loss" && this.exitCommentLoss !== null
              ? this.exitCommentLoss
              : this.exitFillKind === null && this.exitCommentTrailing !== null
                ? this.exitCommentTrailing
                : this.exitOrderComment;
        this.closeAt(exitFill, this.exitQty, exitCmt, barIndex, this.exitOrderId, barTimeMs);
      }
    }
    if (this.entryPending) {
      const fillPrice = this.entryFillPrice(openPrice, high, low);
      // NaN이면 limit/stop 가격 조건 미충족 — 주문 이월(마켓은 NaN 불가). early return이 아니라
      // 분기 스킵인 이유(C169): 아래 order 슬롯 판정이 entry 이월 여부와 무관하게 이 바에서
      // 실행돼야 한다(entry가 마지막 블록이던 시절의 return을 order 추가와 함께 구조 변경 — 동작 동치).
      if (!Number.isNaN(fillPrice)) {
        this.entryPending = false;
        const sign = this.entryDirection === "long" ? 1 : -1;
        // percent_of_equity 자동 수량(C171)은 체결 시점에 해석: entryQty(지분율 %)를 equity(체결가
        // 기준)로 계약 수 환산. 리버스 청산 **전에** 계산해도 동일하다 — equity(p)는 같은 가격 p의
        // 청산 전/후 불변((p-avg)*posSize가 미실현→실현으로 자리만 옮기고 openProfit이 0이 됨).
        // equity<=0(파산)이면 qty<=0 → 주문은 소진하되(마켓 소진 규칙과 동일 — 이월 없음) 리버스
        // 청산 포함 아무 체결도 없다(긍정형 가드 C91, TV 실측 미검증 가설 DIVERGENCES #74).
        let qty = this.entryQtyAuto
          ? this.qtyIsCash
            ? this.autoQtyCashAt(fillPrice, this.entryQty)
            : this.autoQtyAt(fillPrice, this.entryQty)
          : this.entryQty;
        if (qty > 0) {
          // strategy.risk.allow_entry_in(C309) — 금지된 방향의 entry는 아래 리버스-청산(있었다면)
          // 까지만 수행하고 신규 포지션/피라미딩 추가는 열지 않는다("position-closing order
          // instead of a reversal" — call-expr.ts strategy.risk.allow_entry_in 분기 주석의 TV 문서
          // 발췌 근거 참조). "all"(기본값)이면 이 게이트는 항상 false — 기존 무제한 동작 무변화.
          const directionForbidden =
            this.allowedDirection !== "all" && this.entryDirection !== this.allowedDirection;
          // strategy.risk.max_intraday_filled_orders(C320) — 오늘 이미 상한만큼 신규 체결됐으면
          // directionForbidden과 동일하게 "위 리버스 청산까지만" 허용하고 아래 오픈/피라미딩 분기는
          // 막는다(REMARKS "market order to exit ... still allowed"). 카운터는 오픈/피라미딩 분기가
          // 실제로 실행될 때만 +1 — 청산 전용 체결(반대 방향 entry의 리버스-청산 부분, close/exit)은
          // 세지 않는다(TV 미검증 가설 — call-expr.ts 분기 주석 근거 참조).
          const intradayLimitReached =
            !Number.isNaN(this.maxIntradayFilledOrders) &&
            this.intradayFilledCount >= this.maxIntradayFilledOrders;
          // strategy.risk.max_drawdown/max_intraday_loss(C322)/max_cons_loss_days(C325) — allow_entry_in/
          // max_intraday_filled_orders와 동일한 "위 리버스 청산까지만 허용" 게이트에 합류.
          const drawdownForbidden =
            this.drawdownLimitReached || this.intradayLossLimitReached || this.consLossLimitReached;
          if (this.posSize !== 0 && this.posSize > 0 !== sign > 0) {
            // 반대 방향이면 리버스(TV: 반대 direction entry는 기존 포지션 청산 후 진입 — pine2py
            // entry()의 콜타임 `_close_position` + `_fill_entry` "새 Position" 분기를 체결 시점으로
            // 옮긴 것, DIVERGENCES #67). 청산을 실현 손익으로 기록(closedtrades 1건)한 뒤 flat이 되어
            // 아래 새 포지션 분기로 이어진다 — C164의 "포지션 교체" 단축과 포지션 관측은 동일하고
            // 계좌 속성 관측만 추가된 것. limit/stop 체결도 동일 경로(청산가 = 그 주문의 체결가).
            // exit_comment(C173)는 pine2py `self._close_position(id, comment)`처럼 **청산을 유발한
            // 새 entry 주문 자신의 comment**를 쓴다(_close_position이 exit_id/comment 인자를
            // exit()의 그것이 아니라 리버스를 일으킨 entry()의 id/comment로 호출하는 것의 미러).
            this.closeAt(fillPrice, Infinity, this.entryOrderComment, barIndex, this.entryOrderId, barTimeMs);
          }
          // strategy.risk.max_position_size(value)(C324) — 위 3형제(directionForbidden 등)와 달리
          // "전면 차단"이 아니라 "부족분만 체결"이다(TV 문서: "quantity of new strategy.entry orders
          // will be reduced if necessary to prevent exceeding this limit"). 위 리버스 청산 이후
          // 시점의 |posSize|(리버스가 있었다면 이미 0)를 "기존 같은 방향 보유량"으로 삼아 남은 여유만
          // qty에서 깎는다 — 이미 한도 이상이면 0으로 축소돼 아래 오픈/피라미딩 분기 자체가
          // 무해하게 스킵된다(긍정형 가드, C91과 동일 원칙).
          if (!Number.isNaN(this.maxPositionSizeValue)) {
            qty = Math.max(0, Math.min(qty, this.maxPositionSizeValue - Math.abs(this.posSize)));
          }
          if (directionForbidden || intradayLimitReached || drawdownForbidden || qty <= 0) {
            // 위 청산까지만 — 아래 신규/피라미딩 분기 스킵(주문 자체는 소진, 이월 없음).
          } else if (this.posSize === 0) {
            this.posSize = sign * qty;
            this.posAvgPrice = fillPrice;
            this.entryId = this.entryOrderId;
            this.entryComment = this.entryOrderComment;
            this.entryCount = 1;
            this.entryBarIndexOpen = barIndex;
            this.entryTimeOpen = barTimeMs;
            this.intradayFilledCount += 1;
          } else if (this.entryCount < this.pyramiding) {
            // 같은 방향 추가 진입(pyramiding) — pine2py _fill_entry의 가중평균 분기 literal port.
            // entryId는 최초 진입 id 유지(pine2py도 pyramiding 분기에서 position.entry_id를 안 바꿈).
            // pyramiding=0은 이 분기(0 < 0 false)에 절대 못 들어와 1과 실질 동치 — pine2py 가드
            // (`entries >= pyramiding`이되 `is_long`일 때만 차단)와 같은 관측 결과.
            // 자동 수량의 추가 진입 equity에는 기존 포지션의 미실현 손익(체결가 기준)이 포함된다.
            const size = Math.abs(this.posSize);
            this.posAvgPrice = (this.posAvgPrice * size + fillPrice * qty) / (size + qty);
            this.posSize += sign * qty;
            this.entryCount += 1;
            this.intradayFilledCount += 1;
          }
          // else: 같은 방향 + pyramiding 소진 → 주문 취소(이월 없음)
        }
      }
    }
    // order 넷팅 주문(C169)은 마지막에 판정한다 — 처리 순서 close→exit→entry→order: 청산 계열
    // 먼저 원칙(기존 순서 불변) + 같은 바에 entry와 order가 둘 다 체결되면 entry가 만든 포지션에
    // 대해 order가 넷팅한다(고정 슬롯 모델의 결정론적 순서 — pine2py는 _pending_orders 삽입 순서,
    // TV 실측 미검증 가설 DIVERGENCES #72). 가격 판정은 entry와 동일한 directionalFillPrice
    // (마켓=open, limit/stop=조건 충족 시 체결·미충족 시 이월, 갭 오픈 or-better #69 (a) 축).
    if (this.orderPending) {
      const orderFill = this.directionalFillPrice(this.orderDirection, this.orderLimit, this.orderStop, openPrice, high, low);
      if (!Number.isNaN(orderFill)) {
        this.orderPending = false;
        const sign = this.orderDirection === "long" ? 1 : -1;
        // percent_of_equity 자동 수량(C171) — entry 분기와 동일하게 체결 시점 해석. 상쇄(부분
        // closeAt)도 같은 가격이라 equity 불변 — 해석을 상쇄 앞 한 곳에 두면 충분하다. equity<=0이면
        // 주문 소진·미체결(상쇄 포함 전부 스킵 — entry 분기와 동일 가드, DIVERGENCES #74).
        let qty = this.orderQtyAuto
          ? this.qtyIsCash
            ? this.autoQtyCashAt(orderFill, this.orderQty)
            : this.autoQtyAt(orderFill, this.orderQty)
          : this.orderQty;
        if (qty > 0) {
          if (this.posSize !== 0 && this.posSize > 0 !== sign > 0) {
            // 반대 방향은 |posSize|와 상쇄 — 축소분을 실현 손익으로 기록(closeAt 부분 산식 재사용,
            // C168 인프라의 자연 확장: avg/entryId/entryCount 유지, 전량 도달 시 flat 리셋 + 브래킷
            // 소멸까지 기존 경로와 동치). qty가 |posSize|를 초과하면 잔여분이 아래 분기에서 반대
            // 방향 새 포지션이 된다(부호 반전 — entry의 리버스 전량+전량과 달리 넷 수량만 진입).
            const size = Math.abs(this.posSize);
            const reduceQty = qty < size ? qty : size;
            // exit_comment(C173)는 entry 리버스 분기와 같은 가설(주문 자신의 comment) — order()엔
            // pine2py 대응 구현이 없어(DIVERGENCES #72) 대칭성만 근거로 삼는다.
            this.closeAt(orderFill, reduceQty, this.orderOrderComment, barIndex, this.orderOrderId, barTimeMs);
            qty -= reduceQty;
          }
          if (qty > 0) {
            if (this.posSize === 0) {
              this.posSize = sign * qty;
              this.posAvgPrice = orderFill;
              this.entryId = this.orderOrderId;
              this.entryComment = this.orderOrderComment;
              this.entryCount = 1;
              this.entryBarIndexOpen = barIndex;
              this.entryTimeOpen = barTimeMs;
            } else {
              // 같은 방향 추가 — entry의 pyramiding 분기와 같은 가중평균이되 **게이트 없음**(TV:
              // strategy.order는 pyramiding 설정의 영향을 받지 않는다 — 미검증 가설 #72). entryCount는
              // 증가시켜 이후 entry의 pyramiding 게이트에 반영한다(pine2py _fill_entry가 주문 출처
              // 무관하게 _long/_short_entries를 증가시키는 것과 동형 — 역시 TV 미검증 가설).
              const size = Math.abs(this.posSize);
              this.posAvgPrice = (this.posAvgPrice * size + orderFill * qty) / (size + qty);
              this.posSize += sign * qty;
              this.entryCount += 1;
            }
          }
        }
      }
    }
  }

  // pending entry 주문의 이번 바 체결가 — NaN이면 미체결(이월). pine2py _check_fill의 entry 분기
  // (long limit: low<=limit → limit 체결, long stop: high>=stop → stop 체결, stop-limit: 두 조건
  // 동시 충족 시 limit 체결, 숏은 부등호 반전)를 기본으로 하되, **트리거 조건이 이 바 open에서
  // 이미 충족돼 있으면 open으로 체결**한다(갭 오픈: pine2py는 갭에서도 정확히 limit/stop 가격을
  // 반환해 "시장에 존재하지 않았던 가격" 체결이 되는데, TV 브로커 에뮬레이터는 limit을 "지정가
  // 이하/이상(or better)", stop을 "트리거 시점 시장가"로 채우므로 open 체결이 정합 — TV 실측
  // 미검증 가설, DIVERGENCES #69). intrabar O→H→L→C 세부 경로는 도입하지 않고 "open 스냅샷 →
  // 바 전체 H/L" 2단 모델만 쓴다(next_hint의 단순 모델 — stop-limit의 트리거-후-limit 시차도
  // pine2py와 동일하게 같은 바 결합 조건으로 접는다: stop 트리거 상태의 바 넘어 존속 없음).
  private entryFillPrice(openPrice: number, high: number, low: number): number {
    return this.directionalFillPrice(this.entryDirection, this.entryLimit, this.entryStop, openPrice, high, low);
  }

  // entry/order 공용 방향 주문 체결 판정(C169에서 entryFillPrice 본문을 파라미터화 추출 — 동작
  // 동치, exit의 부등호 반전판(exitFillPrice)과는 별개). direction 기준 부등호는 entry 분기 그대로.
  private directionalFillPrice(
    direction: string, limitV: number, stopV: number, openPrice: number, high: number, low: number,
  ): number {
    const hasLimit = !Number.isNaN(limitV);
    const hasStop = !Number.isNaN(stopV);
    if (!hasLimit && !hasStop) return openPrice; // 마켓 — 다음 바 open 무조건 체결
    const limit = limitV;
    const stop = stopV;
    if (direction === "long") {
      if (hasLimit && hasStop) {
        if (openPrice >= stop && openPrice <= limit) return openPrice;
        if (high >= stop && low <= limit) return limit;
      } else if (hasLimit) {
        if (openPrice <= limit) return openPrice;
        if (low <= limit) return limit;
      } else {
        if (openPrice >= stop) return openPrice;
        if (high >= stop) return stop;
      }
    } else {
      if (hasLimit && hasStop) {
        if (openPrice <= stop && openPrice >= limit) return openPrice;
        if (low <= stop && high >= limit) return limit;
      } else if (hasLimit) {
        if (openPrice >= limit) return openPrice;
        if (high >= limit) return limit;
      } else {
        if (openPrice <= stop) return openPrice;
        if (low <= stop) return stop;
      }
    }
    return NaN;
  }

  // pending exit 브래킷의 이번 바 체결가(C167, C186에서 intrabar 우선순위 정정) — NaN이면
  // 미체결(이월). pine2py _check_fill의 from_entry 분기(entry의 부등호 반전판: 롱 포지션 exit
  // limit(익절)은 high>=limit → limit 체결, exit stop(손절)은 low<=stop → stop 체결, 숏은 반전)를
  // 기본으로 하되 두 가지를 의도적으로 바꾼다(DIVERGENCES #70): (1) limit+stop 동시 지정을
  // pine2py는 entry와 같은 stop-limit 결합 조건(둘 다 충족해야 limit 체결)으로 접는데, exit
  // 브래킷의 TV 의미는 OCA(익절/손절 각각 독립 트리거, 한쪽 체결 시 반대쪽 소멸)라 결합 조건은
  // #66급 비경제 동작으로 판단해 미추종 — 각 축을 독립 판정한다. (2) 갭 오픈은 open 체결
  // (or-better/트리거 시점 시장가 — entryFillPrice의 #69 (a)와 동일 축).
  //
  // **같은 바에 두 축이 모두 트리거될 때의 우선순위(C186, VERIFIED_SEMANTICS.md CONFIRMED
  // "intrabar 체결 경로 = 무조건 O→L→H→C" 적용)**: low는 항상 high보다 먼저 지나므로, 두 축 중
  // **low 쪽 조건으로 트리거되는 축이 항상 먼저 체결**된다 — "stop이 우선"이 아니라 "low-anchored
  // 축이 우선"이 진짜 규칙이다. 롱은 stop/trail(손절 계열)이 low 쪽(low<=stop), limit(익절)이
  // high 쪽(high>=limit)이라 stop/trail 우선이 O-L-H-C와 그대로 일치(기존 "보수적 stop 우선"
  // 가정이 우연히 정답이었음, DIVERGENCES #70 (c)/#73 (c) promote). **숏은 정반대**: limit(익절)이
  // low 쪽(low<=limit), stop/trail(손절)이 high 쪽(high>=stop)이라 **limit이 stop/trail보다 먼저
  // 체결**된다 — 기존 "숏도 stop 우선"이던 근사는 틀렸으므로 이 사이클에서 정정(단순 손 계산으로
  // open→low→high→close 4점 경로를 그려보면: 두 축 모두 open에서 미트리거 상태라면 stop/limit이
  // 각각 open의 반대편에 있고, low로 내려가는 첫 구간(leg1)에서 open보다 낮은 쪽 임계값이 먼저
  // 닿고, 그 다음 low에서 high로 오르는 구간(leg2)에서 open보다 높은 쪽 임계값이 닿는다 — 롱은
  // stop<open<limit이라 stop이 leg1, limit이 leg2, 숏은 limit<open<stop이라 limit이 leg1, stop이
  // leg2). 판정 순서: stop@open > trail@open > limit@open(둘 다 open 트리거는 결합이 비정상
  // 브래킷에서만 가능 — 순서 유지) > **롱: stop·trail intrabar 먼저, limit 나중 / 숏: limit
  // intrabar 먼저, stop·trail 나중**. NaN open/high/low 비교는 전부 false로 안전(C91).
  //
  // 트레일링 축(C170, pine2py _check_trailing_fill 이식 + 갭 open 체결 적응)은 **상태를 뮤테이션**
  // 한다(exitTrailPrice 래칫) — pending exit가 살아있는 바마다 정확히 1회 호출되는 위치(processFills
  // exit 분기)라 순수 판정 함수에 갱신을 함께 두는 것이 pine2py(_check_fill 안에서 order.trail_price
  // 갱신)와 동형. 바 내 순서는 pine2py literal port: 유리 극값(롱 high)으로 라인을 먼저 래칫한 뒤
  // 반대 극값(롱 low)과 대조 — "유리 극값이 시간상 먼저"라는 intrabar 가설(활성화 바에서 즉시 체결도
  // 가능). 같은 바에 stop과 trail이 둘 다 트리거되면 롱은 max(stop, 라인)/숏은 min — 두 레벨 모두
  // 같은(손절) 방향이라 하락(상승) 경로에서 항상 높은(낮은) 쪽이 먼저 닿는 기하학적 순서(축 간
  // 우선순위와 별개 — 같은 축 안에서는 순서가 결정적). trail은 stop과 같은 축(손절 계열, 위 우선순위
  // 규칙 그대로 적용 — 롱은 limit보다 먼저, 숏은 limit보다 나중). 전부 TV 실측 미검증 가설(DIVERGENCES #73).
  // 갭 open 적응: open이 **이전 바까지의** 라인을 이미 관통했으면 open 체결(라인 래칫 전 판정 —
  // pine2py는 갭에서도 정확히 라인 가격을 반환해 "시장에 없던 가격" 체결, #69 (a) 축이라 미추종).
  private exitFillPrice(openPrice: number, high: number, low: number): number {
    // profit=/loss=(hand-verified, #98)는 limit=/stop=의 포인트 단위 대안 — analyzer가 limit=/profit=,
    // stop=/loss= 각각 동시 지정을 막아두므로 둘 중 하나만 유한값이다. limit=/stop=이 없을 때만
    // posAvgPrice(체결 시점 최신값 — trail_points 활성화 산식과 동일하게 매 바 재계산)로 절대가를
    // 유도한다. 롱은 유리한 방향이 +profit/-loss, 숏은 반대(entryFillPrice 부호 규약과 동일 축).
    const isLong = this.posSize > 0;
    const limit = !Number.isNaN(this.exitLimit)
      ? this.exitLimit
      : !Number.isNaN(this.exitProfitPoints)
        ? (isLong ? this.posAvgPrice + this.exitProfitPoints : this.posAvgPrice - this.exitProfitPoints)
        : NaN;
    const stop = !Number.isNaN(this.exitStop)
      ? this.exitStop
      : !Number.isNaN(this.exitLossPoints)
        ? (isLong ? this.posAvgPrice - this.exitLossPoints : this.posAvgPrice + this.exitLossPoints)
        : NaN;
    const hasLimit = !Number.isNaN(limit);
    const hasStop = !Number.isNaN(stop);
    const hasTrail = !Number.isNaN(this.exitTrailPoints) || !Number.isNaN(this.exitTrailPriceArg);
    // comment_loss=/comment_profit=/comment_trailing=(C375+C673) 선택은 이 함수가 어느 축(stop=
    // loss, limit=profit, 라인=null)이 체결가를 결정했는지 exitFillKind에 부작용으로 남긴다 —
    // 순수 트레일링(라인이 결정)은 null로 남겨 processFills가 comment_trailing=을 선택(위
    // exitCommentTrailing 선언 참조).
    if (this.posSize > 0) {
      if (hasStop && openPrice <= stop) { this.exitFillKind = "loss"; return openPrice; }
      if (hasTrail && openPrice <= this.exitTrailPrice) { this.exitFillKind = null; return openPrice; } // 라인 미활성(NaN)이면 비교 false — 안전(C91)
      if (hasLimit && openPrice >= limit) { this.exitFillKind = "profit"; return openPrice; }
      if (hasTrail) {
        // 활성화(high가 avg+trail_points, 또는 trail_price가 지정됐으면 그 절대가 그대로 도달)
        // 또는 기활성이면 이번 바 high로 라인 래칫(단조 max). high가 NaN(마켓 전용 단위 테스트
        // 경로)이면 활성화 비교/래칫 비교 전부 false — 안전 소멸.
        const offset = Number.isNaN(this.exitTrailOffset) ? this.exitTrailPoints : this.exitTrailOffset;
        const activation = Number.isNaN(this.exitTrailPriceArg)
          ? this.posAvgPrice + this.exitTrailPoints
          : this.exitTrailPriceArg;
        if (!Number.isNaN(this.exitTrailPrice) || high >= activation) {
          const newTrail = high - offset;
          if (Number.isNaN(this.exitTrailPrice) || newTrail > this.exitTrailPrice) this.exitTrailPrice = newTrail;
        }
      }
      const stopHit = hasStop && low <= stop;
      const trailHit = hasTrail && low <= this.exitTrailPrice;
      if (stopHit && trailHit) {
        const stopWins = stop > this.exitTrailPrice;
        this.exitFillKind = stopWins ? "loss" : null;
        return stopWins ? stop : this.exitTrailPrice;
      }
      if (stopHit) { this.exitFillKind = "loss"; return stop; }
      if (trailHit) { this.exitFillKind = null; return this.exitTrailPrice; }
      if (hasLimit && high >= limit) { this.exitFillKind = "profit"; return limit; }
    } else {
      if (hasStop && openPrice >= stop) { this.exitFillKind = "loss"; return openPrice; }
      if (hasTrail && openPrice >= this.exitTrailPrice) { this.exitFillKind = null; return openPrice; }
      if (hasLimit && openPrice <= limit) { this.exitFillKind = "profit"; return openPrice; }
      if (hasTrail) {
        const offset = Number.isNaN(this.exitTrailOffset) ? this.exitTrailPoints : this.exitTrailOffset;
        const activation = Number.isNaN(this.exitTrailPriceArg)
          ? this.posAvgPrice - this.exitTrailPoints
          : this.exitTrailPriceArg;
        if (!Number.isNaN(this.exitTrailPrice) || low <= activation) {
          const newTrail = low + offset;
          if (Number.isNaN(this.exitTrailPrice) || newTrail < this.exitTrailPrice) this.exitTrailPrice = newTrail;
        }
      }
      // 숏은 limit(익절)이 low 쪽이라 O-L-H-C 경로상 stop/trail(high 쪽)보다 먼저 도달한다(C186,
      // 위 클래스 주석 참조 — 롱의 "stop/trail 먼저"와 정확히 대칭 반전).
      if (hasLimit && low <= limit) { this.exitFillKind = "profit"; return limit; }
      const stopHit = hasStop && high >= stop;
      const trailHit = hasTrail && high >= this.exitTrailPrice;
      if (stopHit && trailHit) {
        const stopWins = stop < this.exitTrailPrice;
        this.exitFillKind = stopWins ? "loss" : null;
        return stopWins ? stop : this.exitTrailPrice;
      }
      if (stopHit) { this.exitFillKind = "loss"; return stop; }
      if (trailHit) { this.exitFillKind = null; return this.exitTrailPrice; }
    }
    return NaN;
  }
}
