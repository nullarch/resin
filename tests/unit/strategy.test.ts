// strategy.* 첫 슬라이스(C163: 롱-온리 마켓 주문 entry/close + 다음 바 open 체결 + 최소 포지션
// 상태) + 둘째 슬라이스(C164: strategy.short/숏 포지션(음수 position_size)/반대 방향 entry 자동
// 리버스/strategy() default_qty_value·pyramiding 소비/entry qty=·comment= kwargs) + 셋째 슬라이스
// (C165: 계좌 속성 netprofit/openprofit/equity/initial_capital/트레이드 카운터 6종 +
// strategy(initial_capital=) 소비) + 넷째 슬라이스(C166: entry limit=/stop= 주문 + 가격 조건
// 미충족 시 바 넘어 이월 + strategy.cancel/cancel_all) + 여섯째 슬라이스(C168:
// strategy.close_all + close/exit qty= 부분 청산) + 일곱째 슬라이스(C169: strategy.order
// 넷팅 주문 — 리버스/pyramiding 가드 없음, 반대 방향은 |posSize| 상쇄).
// **전부 hand-verified**: pine2py StrategyEngine은 market 주문을 당일 close에 체결하는 알려진
// 버그(GOAL.md/MEMORY.md)가 있어 이 계열은 오라클 골든 생성 자체가 무효 구간이다(DIVERGENCES.md
// #1/#66/#67/#68/#69/#71). pine2py는 주문 상태머신 구조(콜타임 가드/리버스/가중평균 pyramiding/
// Trade.profit 공식/_check_fill 가격 조건)의 시맨틱 참조로만 썼다.

import { describe, it, expect } from "vitest";
import { StrategyState } from "../../src/runtime/strategy";
import { transpile } from "../../src/transpiler/pipeline";
import { runPipeline } from "../helpers/pipeline";
import type { OHLCVData } from "../../src/runtime/context";

function transpileErrors(source: string): string[] {
  const r = transpile(source);
  return r.ok ? [] : r.errors;
}

function transpileCode(source: string): string {
  const r = transpile(source);
  if (!r.ok) throw new Error(`transpile failed: ${r.errors.join("; ")}`);
  return r.code;
}

describe("StrategyState (runtime, hand-verified)", () => {
  it("entry queues a market order — no fill until next-bar processFills", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    expect(st.posSize).toBe(0); // 호출한 바에서는 아직 flat(다음 바 open 체결)
    expect(Number.isNaN(st.posAvgPrice)).toBe(true);
    st.processFills(100);
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(100);
    expect(st.entryId).toBe("L");
  });

  it("entry defaults qty to 1 when omitted", () => {
    const st = new StrategyState();
    st.entry("L", "long");
    st.processFills(50);
    expect(st.posSize).toBe(1);
  });

  it("entry is a no-op when when=false (C372) — even with an invalid direction, no throw", () => {
    const st = new StrategyState();
    st.entry("L", "bogus", 2, undefined, undefined, undefined, false);
    expect(st.entryPending).toBe(false);
    st.processFills(100);
    expect(st.posSize).toBe(0);
  });

  it("entry queues normally when when=true (default, explicit and omitted are equivalent, C372)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2, undefined, undefined, undefined, true);
    st.processFills(100);
    expect(st.posSize).toBe(2);
  });

  it("entry ignores na(NaN)/zero/negative qty (no order)", () => {
    const st = new StrategyState();
    st.entry("A", "long", NaN);
    st.entry("B", "long", 0);
    st.entry("C", "long", -3);
    st.processFills(10);
    expect(st.posSize).toBe(0);
    expect(st.entryId).toBeNull();
  });

  it("entry ignores na(null) id (no order)", () => {
    const st = new StrategyState();
    st.entry(null, "long", 1);
    st.processFills(10);
    expect(st.posSize).toBe(0);
  });

  // C164 긍정 마이그레이션: 구 "entry throws on non-long direction (첫 슬라이스 롱-온리)" —
  // short가 정식 지원되면서 거부 프로브를 진짜 무효 문자열로 회전(거부 의도 보존, C120/C163 관례).
  it("entry throws on an unknown direction string (long/short 외 — 런타임 이중 방어)", () => {
    const st = new StrategyState();
    expect(() => st.entry("X", "sideways", 1)).toThrow(/unsupported direction/);
    expect(() => st.entry("X", "LONG", 1)).toThrow(/unsupported direction/); // 대소문자 구분
  });

  it("same-bar re-entry with same id modifies the pending order qty", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.entry("L", "long", 5);
    st.processFills(10);
    expect(st.posSize).toBe(5);
  });

  it("same-bar entry with a different id keeps the first order (pyramiding=1 동치)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.entry("B", "long", 7);
    st.processFills(10);
    expect(st.posSize).toBe(1);
    expect(st.entryId).toBe("A");
  });

  it("entry while already long is canceled at fill time (pyramiding=1) and does not persist", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10); // 롱 1 @ 10
    st.entry("A", "long", 3);
    st.processFills(20); // pyramiding 차단 — 포지션 불변, 주문 취소
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(10);
    st.close("A");
    st.processFills(30); // flat — 차단됐던 주문이 이월돼 있었다면 여기서 체결됐을 것
    expect(st.posSize).toBe(0);
    st.processFills(40);
    expect(st.posSize).toBe(0);
  });

  it("close is a no-op when flat at call time", () => {
    const st = new StrategyState();
    st.close("L");
    expect(st.closePending).toBe(false);
    st.processFills(10);
    expect(st.posSize).toBe(0);
  });

  it("close is a no-op when when=false (C293)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", undefined, undefined, false);
    expect(st.closePending).toBe(false);
    st.processFills(20);
    expect(st.posSize).toBe(2); // 여전히 롱 — when=false라 청산 큐잉 자체가 없었음
  });

  it("close fills normally when when=true (default, explicit and omitted are equivalent, C293)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", undefined, undefined, true);
    st.processFills(20);
    expect(st.posSize).toBe(0);
  });

  it("close is a no-op when entry id does not match", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("B");
    st.processFills(20);
    expect(st.posSize).toBe(2); // 여전히 롱
  });

  it("close fills at next-bar open and resets position to flat", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A");
    expect(st.posSize).toBe(2); // 호출한 바에서는 아직 롱
    st.processFills(20);
    expect(st.posSize).toBe(0);
    expect(Number.isNaN(st.posAvgPrice)).toBe(true);
    expect(st.entryId).toBeNull();
  });

  it("same-bar close + entry: both fill at the same next-bar open (close first)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10); // 롱 A 2 @ 10
    st.close("A");
    st.entry("B", "long", 3);
    st.processFills(15); // 청산 후 같은 open에서 재진입
    expect(st.posSize).toBe(3);
    expect(st.posAvgPrice).toBe(15);
    expect(st.entryId).toBe("B");
  });

  it("same-bar entry + close while flat: close no-ops (position not yet open at call time)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.close("L"); // 아직 flat — TV에서도 position_size가 0인 바라 no-op
    st.processFills(10);
    expect(st.posSize).toBe(1); // entry만 체결
  });
});

describe("StrategyState 둘째 슬라이스 (C164: short/리버스/pyramiding/defaultQty, hand-verified)", () => {
  it("short entry fills with negative posSize", () => {
    const st = new StrategyState();
    st.entry("S", "short", 2);
    expect(st.posSize).toBe(0); // 호출한 바에서는 아직 flat
    st.processFills(100);
    expect(st.posSize).toBe(-2);
    expect(st.posAvgPrice).toBe(100);
    expect(st.entryId).toBe("S");
  });

  it("close works on a short position (posSize !== 0 가드)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 2);
    st.processFills(10);
    st.close("S");
    st.processFills(20);
    expect(st.posSize).toBe(0);
    expect(Number.isNaN(st.posAvgPrice)).toBe(true);
    expect(st.entryId).toBeNull();
  });

  it("opposite-direction entry reverses long -> short at fill time", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10); // 롱 2 @ 10
    st.entry("S", "short", 3);
    expect(st.posSize).toBe(2); // 호출한 바에서는 아직 롱
    st.processFills(15); // 리버스: 청산 후 숏 진입 (관측상 교체와 동치)
    expect(st.posSize).toBe(-3);
    expect(st.posAvgPrice).toBe(15);
    expect(st.entryId).toBe("S");
  });

  it("opposite-direction entry reverses short -> long at fill time", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(10);
    st.entry("L", "long", 4);
    st.processFills(8);
    expect(st.posSize).toBe(4);
    expect(st.posAvgPrice).toBe(8);
    expect(st.entryId).toBe("L");
  });

  it("same-direction short entry while short is canceled (pyramiding=1) and not carried over", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(10);
    st.entry("S2", "short", 3);
    st.processFills(20); // pyramiding 차단 — 취소
    expect(st.posSize).toBe(-1);
    expect(st.posAvgPrice).toBe(10);
    st.close("S");
    st.processFills(30);
    expect(st.posSize).toBe(0);
    st.processFills(40); // 차단됐던 주문이 이월돼 있었다면 여기서 체결됐을 것
    expect(st.posSize).toBe(0);
  });

  it("configure(defaultQty) is consumed when entry omits qty", () => {
    const st = new StrategyState();
    st.configure(5, 1);
    st.entry("L", "long");
    st.processFills(10);
    expect(st.posSize).toBe(5);
  });

  it("explicit qty overrides defaultQty", () => {
    const st = new StrategyState();
    st.configure(5, 1);
    st.entry("L", "long", 2);
    st.processFills(10);
    expect(st.posSize).toBe(2);
  });

  // C465: configure(defaultQty=0)은 entry마다 qty=를 항상 명시하는 실전 스크립트의 fallback
  // "미사용" 관용구 — omit-qty 주문은 qty<=0 가드(processFills L1324)로 조용히 무발동해야 하고,
  // 명시적 qty는 여전히 정상 체결돼야 한다.
  it("configure(defaultQty=0): entry omitting qty is a no-op, explicit qty still fills", () => {
    const st = new StrategyState();
    st.configure(0, 1);
    st.entry("L", "long");
    st.processFills(10);
    expect(st.posSize).toBe(0);
    st.entry("L2", "long", 3);
    st.processFills(11);
    expect(st.posSize).toBe(3);
  });

  it("pyramiding=2: second same-direction fill adds with weighted average price and keeps the first entry id", () => {
    const st = new StrategyState();
    st.configure(1, 2);
    st.entry("A", "long", 2);
    st.processFills(12); // 롱 2 @ 12, entryCount=1
    st.entry("B", "long", 2);
    st.processFills(14); // 추가 진입: (12*2 + 14*2) / 4 = 13
    expect(st.posSize).toBe(4);
    expect(st.posAvgPrice).toBe(13);
    expect(st.entryId).toBe("A"); // pine2py _fill_entry pyramiding 분기와 동일 — 최초 id 유지
    st.entry("C", "long", 2);
    st.processFills(16); // entryCount=2 >= pyramiding=2 — 차단
    expect(st.posSize).toBe(4);
    expect(st.posAvgPrice).toBe(13);
  });

  it("pyramiding gate resets after close (entryCount 리셋 — 재진입 다시 허용)", () => {
    const st = new StrategyState();
    st.configure(1, 1);
    st.entry("A", "long", 1);
    st.processFills(10);
    st.close("A");
    st.entry("B", "long", 2);
    st.processFills(20); // 같은 open에서 청산 후 재진입(entryCount 0 -> 1)
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(20);
    expect(st.entryId).toBe("B");
  });

  it("pyramiding=0 behaves like 1 (첫 진입 허용, 추가 진입 차단 — pine2py 가드 구조 동치)", () => {
    const st = new StrategyState();
    st.configure(1, 0);
    st.entry("A", "long", 1);
    st.processFills(10); // flat -> 새 포지션 (pyramiding 게이트는 추가 진입에만 적용)
    expect(st.posSize).toBe(1);
    st.entry("B", "long", 1);
    st.processFills(20); // 0 < 0 false — 차단
    expect(st.posSize).toBe(1);
  });

  it("same-bar same-id re-entry updates direction as well as qty (동일 id 주문 대체)", () => {
    const st = new StrategyState();
    st.entry("X", "long", 2);
    st.entry("X", "short", 3);
    st.processFills(10);
    expect(st.posSize).toBe(-3);
  });

  it("pyramiding=2: reverse still replaces the whole position (추가 진입이 아니라 리버스)", () => {
    const st = new StrategyState();
    st.configure(1, 2);
    st.entry("A", "long", 2);
    st.processFills(10);
    st.entry("B", "short", 1);
    st.processFills(20);
    expect(st.posSize).toBe(-1);
    expect(st.posAvgPrice).toBe(20);
    expect(st.entryId).toBe("B");
  });
});

describe("StrategyState limit/stop 주문 + 이월 + cancel (C166 넷째 슬라이스, hand-verified)", () => {
  it("long limit fills at limit price when the bar's low touches it (non-gap)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.processFills(105, 106, 99); // open 105 > 100, low 99 <= 100 → limit 가격 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(100);
    expect(st.entryPending).toBe(false);
  });

  it("long limit carries over unfilled bars and fills later (바 넘어 이월)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.processFills(105, 106, 101); // low 101 > 100 → 미체결, 이월
    expect(st.posSize).toBe(0);
    expect(st.entryPending).toBe(true);
    st.processFills(104, 105, 102); // 여전히 미체결
    expect(st.posSize).toBe(0);
    st.processFills(103, 104, 100); // low 100 <= 100 → 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(100);
  });

  it("long limit gap open fills at the (better) open price — TV 가설, pine2py 미추종", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.processFills(98, 106, 95); // open 98 <= limit 100 → open 체결(지정가 이하 or better)
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(98);
  });

  it("short limit fills at limit when high touches it; gap open fills at open", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1, 100);
    st.processFills(95, 101, 94); // open 95 < 100, high 101 >= 100 → limit 체결
    expect(st.posSize).toBe(-1);
    expect(st.posAvgPrice).toBe(100);

    const st2 = new StrategyState();
    st2.entry("S", "short", 1, 100);
    st2.processFills(102, 103, 101); // open 102 >= 100 → open 체결(더 유리)
    expect(st2.posSize).toBe(-1);
    expect(st2.posAvgPrice).toBe(102);
  });

  it("long stop fills at stop when high reaches it; gap open fills at open", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, 100);
    st.processFills(95, 101, 94); // open 95 < 100, high 101 >= 100 → stop 가격 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(100);

    const st2 = new StrategyState();
    st2.entry("L", "long", 1, undefined, 100);
    st2.processFills(103, 104, 102); // open 103 >= stop 100 → 트리거 즉시 마켓(open) 체결
    expect(st2.posSize).toBe(1);
    expect(st2.posAvgPrice).toBe(103);
  });

  it("short stop fills at stop when low reaches it; carries over otherwise", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1, undefined, 100);
    st.processFills(105, 110, 101); // low 101 > 100 → 미체결 이월
    expect(st.posSize).toBe(0);
    st.processFills(104, 106, 99); // low 99 <= 100 → stop 체결
    expect(st.posSize).toBe(-1);
    expect(st.posAvgPrice).toBe(100);
  });

  it("long stop-limit fills at limit on the joint same-bar condition (pine2py _check_fill port)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 102, 100); // limit=102, stop=100
    st.processFills(95, 99, 94); // high 99 < stop 100 → 미체결
    expect(st.posSize).toBe(0);
    st.processFills(96, 101, 94); // high 101 >= 100 && low 94 <= 102 → limit 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(102);
  });

  it("long stop-limit open inside [stop, limit] fills at open (갭 open 마켓터블 — TV 가설)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 102, 100);
    st.processFills(101, 103, 100); // open 101 >= stop 100 && 101 <= limit 102 → open 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(101);
  });

  it("limit=NaN (na) is a market order — 조건 없음 정규화 (DIVERGENCES #69)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, NaN);
    st.processFills(105); // 마켓 — 다음 바 open 무조건 체결(H/L 불필요)
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(105);
  });

  it("cancel(id) removes a pending limit order; wrong id is a no-op", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.cancel("M"); // 다른 id — 무시
    expect(st.entryPending).toBe(true);
    st.cancel("L");
    expect(st.entryPending).toBe(false);
    st.processFills(99, 100, 95); // 조건 충족 가격이지만 주문이 없다
    expect(st.posSize).toBe(0);
  });

  it("cancel(id, when=false) is a no-op — pending limit order survives (C708, hand-verified — pine2py cancel() has no such gate)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.cancel("L", false);
    expect(st.entryPending).toBe(true);
    st.processFills(99, 100, 95); // 조건 충족 가격 — 취소 안 됐으니 체결돼야 함
    expect(st.posSize).toBe(1);
  });

  it("cancel(id, when=true) behaves identically to the omitted-when default (C708)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.cancel("L", true);
    expect(st.entryPending).toBe(false);
  });

  it("cancel does NOT cancel a pending market entry (마켓 주문 취소 불가 — TV 가설)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.cancel("L");
    st.processFills(10);
    expect(st.posSize).toBe(1);
  });

  it("cancel_all removes the pending price-based entry but keeps a market entry", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.cancel_all();
    expect(st.entryPending).toBe(false);

    const st2 = new StrategyState();
    st2.entry("L", "long", 1);
    st2.cancel_all();
    st2.processFills(10);
    expect(st2.posSize).toBe(1);
  });

  it("cancel does not touch a queued strategy.close market order", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    st.close("L");
    st.cancel("L");
    st.processFills(15);
    expect(st.posSize).toBe(0); // 청산은 그대로 체결
    expect(st.realizedPnl).toBe(5);
  });

  it("same-id re-entry converts a carried limit order into a market order (주문 수정)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.processFills(105, 106, 101); // 미체결 이월
    expect(st.entryPending).toBe(true);
    st.entry("L", "long", 2); // 같은 id — limit 제거(마켓으로 수정) + qty 대체
    st.processFills(104, 105, 103); // 마켓 — open 체결
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(104);
  });

  it("limit fill applies reverse at fill time (체결 시점 판정 — DIVERGENCES #67 확장)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(10); // 숏 1 @ 10
    st.entry("L", "long", 2, 9);
    st.processFills(9.5, 10, 8.9); // open 9.5 > 9, low 8.9 <= 9 → 9에 체결: 숏 청산 + 롱 2
    expect(st.realizedPnl).toBe(1); // (9 - 10) * (-1)
    expect(st.closedTrades).toBe(1);
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(9);
  });

  it("triggered-but-blocked limit entry is consumed, not carried (pyramiding 차단 시 소진)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10); // 롱 1 @ 10 (pyramiding=1 소진)
    st.entry("M", "long", 1, 9);
    st.processFills(9.5, 10, 8); // low 8 <= 9 → 트리거됐지만 같은 방향 + pyramiding 차단 → 소진
    expect(st.posSize).toBe(1);
    expect(st.entryPending).toBe(false);
    st.processFills(9.5, 10, 8); // 이월돼 있었다면 여기서 체결됐을 것
    expect(st.posSize).toBe(1);
  });

  it("same-bar close then limit entry fill (close 먼저 → entry — 기존 순서 유지)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10); // 롱 1 @ 10
    st.close("A");
    st.entry("B", "long", 1, 95);
    st.processFills(100, 101, 94); // close: open 100 청산(profit 90) → entry: low 94 <= 95 → 95 체결
    expect(st.realizedPnl).toBe(90);
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(95);
    expect(st.entryId).toBe("B");
  });

  it("NaN high/low (마켓 전용 단위 테스트 폴백) never triggers an intrabar fill", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 100);
    st.processFills(105); // H/L 미지정 — open 105 > 100이고 intrabar 판정 불가 → 이월
    expect(st.posSize).toBe(0);
    expect(st.entryPending).toBe(true);
  });
});

describe("strategy.* analyzer validation", () => {
  // C771(wild tv_verdict 실측, 34144f307dda.pine 등): TV는 strategy() 선언 없이(심지어
  // indicator()뿐인 스크립트에서도) strategy.entry/exit/close 등 호출을 그대로 컴파일 수용한다 —
  // 이전 "선언 선행 필수" 게이트는 pine2py에도 없는(codegen.py 순수 리터럴 매핑) pine2js 자체
  // 추가 제약이었다. 아래 3건은 전부 "거부"에서 "수용"으로 정정.
  it("accepts strategy.entry without a strategy() declaration", () => {
    expect(transpile('strategy.entry("L", strategy.long)').ok).toBe(true);
  });

  it("accepts strategy.entry in an indicator() script", () => {
    expect(transpile('indicator("i")\nstrategy.entry("L", strategy.long)').ok).toBe(true);
  });

  it("accepts strategy.entry that appears before a later strategy() declaration", () => {
    expect(transpile('strategy.entry("L", strategy.long)\nstrategy("s")').ok).toBe(true);
  });

  it("runs a real wild pattern end-to-end: indicator()-only script placing strategy.entry/close orders (34144f307dda.pine, C771)", () => {
    const data: OHLCVData = {
      open: [10, 12, 13, 15, 17],
      high: [12, 13, 15, 17, 18],
      low: [9, 10, 12, 14, 15],
      close: [11, 11, 14, 16, 16],
      volume: [100, 100, 100, 100, 100],
    };
    const src = [
      'indicator("Entry and Exit based on Historical Low", overlay=true)',
      "enterLong = close <= open",
      "exitLong = close >= open",
      "var float __obs_ps = na",
      'strategy.entry("Long Entry", strategy.long, when=enterLong)',
      'strategy.close("Long Entry", when=exitLong)',
      "__obs_ps := strategy.position_size",
    ].join("\n");
    const result = runPipeline(src, data);
    // enterLong=true bar1/bar4, exitLong=true bar0/bar2/bar3 — 다음 바 open 체결(GOAL.md)이라
    // bar1 신호는 bar2에 체결(pos=1), bar2 신호(exitLong)는 bar3에 체결(pos=0), bar4 신호는
    // 데이터 끝이라 미체결.
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 0, 1, 0, 0]);
  });

  it("accepts strategy.entry/close at top level and inside an if body", () => {
    const src = [
      'strategy("s")',
      "if close > open",
      '    strategy.entry("L", strategy.long, 2)',
      "if close < open",
      '    strategy.close("L")',
    ].join("\n");
    expect(transpile(src).ok).toBe(true);
  });

  it("rejects strategy.entry in a value position (반환값 없음)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.entry("L", strategy.long)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("validates strategy.entry arg count (2~3개)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.entry("L")').some((e) =>
        e.includes("'strategy.entry' call argument count mismatch"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, 1, 2)').some((e) =>
        e.includes("'strategy.entry' call argument count mismatch"),
      ),
    ).toBe(true);
  });

  it("validates strategy.close arg count (1~2개)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.close()').some((e) =>
        e.includes("'strategy.close' call argument count mismatch"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.close("L", "x", "y")').some((e) =>
        e.includes("'strategy.close' call argument count mismatch"),
      ),
    ).toBe(true);
  });

  // C345(wild argcount 클러스터, next_hint(C344) 1순위): 위치 인자 2번째 슬롯(comment) 신규
  // 지원 — wild 실측(`strategy.close("buy", "closebuy-all", qty_percent=100)`,
  // `strategy.close(42, f(close) ? "a" : "b")`)이 pine2py close(id="", comment="", when=True,
  // **kwargs)의 위치 시그니처(id, comment, when)와 정합.
  it("accepts strategy.close with a 2nd positional arg (comment, C345, wild-evidenced)", () => {
    expect(transpile('strategy("s")\nstrategy.close("L", "bye")').ok).toBe(true);
  });

  // C164 긍정 마이그레이션: 구 "rejects strategy.short (롱-온리 첫 슬라이스)" — short가 정식
  // 지원되면서 거부 테스트를 수용 테스트로 전환(미지원 속성 거부 의도는 아래
  // "rejects unsupported strategy.* properties" 테스트가 netprofit 프로브로 계속 담당).
  it("accepts strategy.short and folds it to the \"short\" direction constant (C164)", () => {
    expect(transpile('strategy("s")\nstrategy.entry("S", strategy.short)').ok).toBe(true);
  });

  // C165 긍정 마이그레이션: 거부 프로브 netprofit이 정식 지원되면서 max_drawdown(equity 히스토리
  // 추적이 필요한 진짜 미구현 속성)으로 회전 — C120/C163/C164 프로브 회전 관례.
  // C167 재회전: 호출 프로브 strategy.exit가 정식 지원되면서 strategy.order(포지션 관리 없는
  // 단순 주문 — 진짜 미구현 호출)로 회전.
  // C169 재회전: strategy.order가 정식 지원되면서 strategy.convert_to_account(통화 환산 —
  // 진짜 미구현 호출, TV v5 strategy 네임스페이스의 마지막 잔여 함수 계열)로 회전.
  // C172 재회전: max_drawdown이 정식 지원되면서 max_runup(같은 온라인 알고리즘의 반대 극성 —
  // peak/trough를 뒤집으면 되는 진짜 미구현 속성, ROADMAP strategy.* "이후" 잔여)으로 회전.
  // C674 재회전: max_runup이 정식 지원되면서 strategy.oca(OCA 그룹 취소 시맨틱이 런타임에 아예
  // 없어 값을 discard하면 조용한 오답 — analyzer.ts STRATEGY_RUNTIME_PROPS 주석 참조, 의도적
  // 스킵이라 여전히 미지원)로 회전.
  // C763 재회전: convert_to_account/convert_to_symbol이 정식 지원되면서 TV strategy.* 콜 계열
  // (entry/order/exit/close/close_all/cancel/cancel_all/default_entry_qty/convert_to_account/
  // convert_to_symbol/risk.*/closedtrades.*/opentrades.*)이 사실상 전부 소진돼 실재하는 미구현
  // strategy.*() 콜을 못 찾음 — 순수 합성 프로브(strategy.__unsupported_probe__)로 대체.
  it("rejects unsupported strategy.* properties and calls", () => {
    expect(
      transpileErrors('strategy("s")\nx = strategy.oca').some((e) =>
        e.includes("unsupported strategy property"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.__unsupported_probe__(10)').some((e) =>
        e.includes("unsupported call: 'strategy.__unsupported_probe__'"),
      ),
    ).toBe(true);
  });

  // C164 긍정 마이그레이션 → C166 재회전: limit=/stop=이 정식 지원되면서(넷째 슬라이스) 거부
  // 프로브를 oca_name=/oca_type=/disable_alert=(OCA 그룹/알림 — 진짜 미구현 파라미터)로 회전
  // (C120/C163/C164/C165 프로브 회전 관례. 파싱-후-버림은 조용한 오답이라 하드 에러 유지 동일).
  // C374 재마이그레이션: alert_message=(순수 표시값 discard 신규 지원)가 목록에서 제거 — 별도
  // 긍정 테스트로 이동, disable_alert=로 회전(진짜 미구현 파라미터).
  // C746(next_hint(C745) 재조사): disable_alert=(exit()의 C708/close_all()의 C724와 동일 축, 순수
  // 표시값 discard)가 목록에서 제거 — 별도 긍정 테스트로 이동, oca_type=(진짜 미구현 파라미터,
  // OCA 축은 ROADMAP 배치37 (4) 감독 승인 대기)만 남김.
  it("rejects unsupported strategy.entry kwargs (oca_name= 등)", () => {
    for (const kw of ['oca_name="g"', 'oca_type="cancel"']) {
      const errors = transpileErrors(`strategy("s")\nstrategy.entry("L", strategy.long, ${kw})`);
      expect(
        errors.some((e) =>
          e.includes(
            "'strategy.entry' only supports keyword arguments 'id='/'direction='/'qty='/'comment='/'limit='/'stop='/'when='/'alert_message='/'disable_alert='",
          ),
        ),
      ).toBe(true);
    }
  });

  it("accepts strategy.entry/order disable_alert= kwarg (C746, exit()/close_all()와 동일 축, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, disable_alert=true)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.order("O", strategy.long, disable_alert=false)').ok).toBe(true);
  });

  it("rejects duplicate disable_alert= kwarg on strategy.entry", () => {
    const errors = transpileErrors(
      'strategy("s")\nstrategy.entry("L", strategy.long, disable_alert=true, disable_alert=false)',
    );
    expect(errors.some((e) => e.includes("duplicate keyword argument 'disable_alert'"))).toBe(true);
  });

  it("discards disable_alert= on strategy.entry codegen (C746, no KWARG_SLOTS entry)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, disable_alert=true)');
    expect(code).not.toContain("disable_alert");
  });

  // C423(wild argcount 클러스터 51건, next_hint(C422) 재클러스터링 파생 — "지원하지 않는 호출"
  // 재조사 중 발견): id/direction도 strategy.close의 id=(C293)와 동일하게 위치 또는 키워드 인자
  // 중 하나로만 지정 가능 — wild 실측 전량이 `strategy.entry(id="Long", direction=strategy.long)`
  // (0 positional) 또는 `strategy.entry("long", direction=strategy.long, when=...)`(id만
  // positional) 폼(0349e3674f86.pine/108954cbf4a4.pine).
  it("accepts strategy.entry id=/direction= kwargs (C423, wild-evidenced)", () => {
    expect(transpile('strategy("s")\nstrategy.entry(id="Long", direction=strategy.long)').ok).toBe(true);
    expect(
      transpile('strategy("s")\nstrategy.entry("long", direction=strategy.long, when=close > open)').ok,
    ).toBe(true);
    expect(
      transpile('strategy("s")\nstrategy.entry(id="Long", direction=strategy.long, qty=2, comment="c")').ok,
    ).toBe(true);
  });

  it("rejects strategy.entry id=/direction= duplicated with positional args (C423)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, id="L2")').some((e) =>
        e.includes("argument 'id' specified both positionally and as a keyword"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, direction=strategy.short)').some((e) =>
        e.includes("argument 'direction' specified both positionally and as a keyword"),
      ),
    ).toBe(true);
  });

  it("rejects strategy.entry with direction missing entirely (C423, id kwarg only)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.entry(id="L")').some((e) =>
        e.includes("'strategy.entry' call argument count mismatch"),
      ),
    ).toBe(true);
  });

  it("accepts strategy.entry limit=/stop= kwargs (C166 넷째 슬라이스)", () => {
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, limit=99.5)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, stop=101)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, 2, limit=99, stop=98)').ok).toBe(true);
  });

  it("accepts strategy.entry when= kwarg (C372, wild 최다 단일 kwarg)", () => {
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, when=close > open)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, 2, when=true)').ok).toBe(true);
  });

  it("rejects duplicate when= kwarg on strategy.entry", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, when=true, when=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'when'"))).toBe(true);
  });

  it("accepts strategy.entry alert_message= kwarg (C374, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, alert_message="hi")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, 2, when=true, alert_message="hi")').ok).toBe(
      true,
    );
  });

  it("rejects duplicate alert_message= kwarg on strategy.entry", () => {
    const errors = transpileErrors(
      'strategy("s")\nstrategy.entry("L", strategy.long, alert_message="a", alert_message="b")',
    );
    expect(errors.some((e) => e.includes("duplicate keyword argument 'alert_message'"))).toBe(true);
  });

  it("rejects duplicate limit= kwarg", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, limit=1, limit=2)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'limit'"))).toBe(true);
  });

  it("accepts strategy.cancel/cancel_all at top level and inside an if body (C166)", () => {
    const src = [
      'strategy("s")',
      'strategy.entry("L", strategy.long, limit=10)',
      "if close > open",
      '    strategy.cancel("L")',
      "if close < open",
      "    strategy.cancel_all()",
    ].join("\n");
    expect(transpile(src).ok).toBe(true);
  });

  it("accepts strategy.cancel/cancel_all without a strategy() declaration (C771)", () => {
    expect(transpile('strategy.cancel("L")').ok).toBe(true);
    expect(transpile("strategy.cancel_all()").ok).toBe(true);
  });

  it("rejects strategy.cancel in a value position (반환값 없음)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.cancel("L")');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("validates strategy.cancel arg count (정확히 1개)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.cancel()').some((e) =>
        e.includes("'strategy.cancel' call argument count mismatch"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.cancel("L", "M")').some((e) =>
        e.includes("'strategy.cancel' call argument count mismatch"),
      ),
    ).toBe(true);
  });

  it("validates strategy.cancel_all arg count (0개)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.cancel_all("L")');
    expect(errors.some((e) => e.includes("'strategy.cancel_all' call argument count mismatch"))).toBe(true);
  });

  // C382: id는 위치 인자 또는 'id=' 키워드 인자 중 정확히 하나로만 지정 가능(wild 실측
  // f8629b966f24.pine `strategy.cancel(id='exit'+strategy.opentrades.entry_id(i))` 전량 이 폼) —
  // strategy.close의 id=(C293)와 동일 패턴. cancel_all은 TV에 id 파라미터가 없어 예외 대상 아님.
  it("accepts strategy.cancel with id= as a keyword arg (C382, 0 positional args)", () => {
    expect(transpile('strategy("s")\nstrategy.cancel(id="L")').ok).toBe(true);
  });

  it("rejects strategy.cancel with id given both positionally and as a keyword", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.cancel("L", id="M")');
    expect(errors.some((e) => e.includes("'id' specified both positionally and as a keyword"))).toBe(true);
  });

  it("rejects duplicate id= kwarg on strategy.cancel", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.cancel(id="L", id="M")');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'id'"))).toBe(true);
  });

  // C708 재마이그레이션: when=(hand-verified 신규 지원)이 화이트리스트에 추가돼 이 substring도 갱신
  // (comment=는 여전히 진짜 미구현 파라미터).
  it("still rejects unsupported kwarg names on strategy.cancel (blanket 화이트리스트는 'id='/'when='만 허용)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.cancel("L", comment="x")');
    expect(errors.some((e) => e.includes("'strategy.cancel' only supports keyword arguments 'id='/'when='"))).toBe(true);
  });

  it("accepts strategy.cancel when= kwarg (C708, wild 4건 — pine2py cancel(id, when=True)와 동일 게이트 신규 이식)", () => {
    expect(transpile('strategy("s")\nstrategy.cancel("L", when=close > open)').ok).toBe(true);
  });

  it("rejects duplicate when= kwarg on strategy.cancel", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.cancel("L", when=true, when=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'when'"))).toBe(true);
  });

  it("emits strategy.cancel when= folded into slot 1 after id (C708)", () => {
    const code = transpileCode('strategy("s")\nstrategy.cancel("L", when=close > open)');
    expect(code).toMatch(/\$\.strategy\.cancel\("L", rt\.pineGt\(\$\.close\.get\(0\), \$\.open\.get\(0\)\)\);/);
  });

  it("keeps strategy.cancel output byte-identical when when= is absent (C708, C129 원칙)", () => {
    const code = transpileCode('strategy("s")\nstrategy.cancel("L")');
    expect(code).toContain('$.strategy.cancel("L");');
  });

  it("still rejects kwargs on strategy.cancel_all (blanket 거부 — id 파라미터가 TV에 없음, C382)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.cancel_all(id="L")');
    expect(errors.some((e) => e.includes("keyword argument"))).toBe(true);
  });

  it("accepts strategy.entry qty=/comment= kwargs (C164)", () => {
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, qty=2)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, comment="buy")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.entry("L", strategy.long, qty=2, comment="buy")').ok).toBe(true);
  });

  it("rejects qty specified both positionally and as a kwarg", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, 2, qty=3)');
    expect(errors.some((e) => e.includes("'qty' specified both positionally and as a keyword"))).toBe(true);
  });

  it("rejects duplicate qty= kwarg", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.entry("L", strategy.long, qty=2, qty=3)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'qty'"))).toBe(true);
  });

  // C168 긍정 마이그레이션: 구 "still rejects kwargs on strategy.close(blanket 거부)" — close가
  // qty=/comment=를 정식 지원하면서(여섯째 슬라이스) accepts로 전환 + 미지원 kwargs 거부는 아래
  // C168 analyzer 블록의 전용 테스트가 담당(C120/C163~C167 프로브 회전 관례).
  it("accepts strategy.close qty=/comment= kwargs (C168 여섯째 슬라이스)", () => {
    expect(transpile('strategy("s")\nstrategy.close("L", comment="bye")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close("L", qty=1)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close("L", qty=1, comment="bye")').ok).toBe(true);
  });

  it("accepts literal default_qty_value/pyramiding in strategy() (C164 메타데이터 추출)", () => {
    expect(transpile('strategy("s", default_qty_value=2.5, pyramiding=3)\nstrategy.entry("L", strategy.long)').ok).toBe(
      true,
    );
  });

  // C465: wild corpus 65건 재조사 결과 94%(61/65)가 `default_qty_value=0`(모든 entry/order 호출이
  // qty=를 명시적으로 지정하고 default_qty_value fallback을 의도적으로 미사용 고정하는 실전 관용구)
  // — runtime(strategy.ts)이 qty<=0을 이미 no-op으로 가드하므로 0은 well-defined이라 허용 전환.
  it("accepts default_qty_value=0 literal (C465, entry마다 qty= 명시 관용구)", () => {
    expect(transpile('strategy("s", default_qty_value=0)').ok).toBe(true);
    expect(transpile('strategy("s", default_qty_value=0)\nstrategy.entry("L", strategy.long, qty=2)').ok).toBe(true);
  });

  it("rejects non-literal or negative default_qty_value", () => {
    expect(
      transpileErrors('x = input.float(2)\nstrategy("s", default_qty_value=x)').some((e) =>
        e.includes("'default_qty_value' argument only supports a number literal >= 0"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s", default_qty_value=-1)').some((e) =>
        e.includes("'default_qty_value' argument only supports a number literal >= 0"),
      ),
    ).toBe(true);
  });

  // C764: default_qty_value/pyramiding/initial_capital이 top-level 유일 '=' 상수 식별자를 가리키는
  // wild 실전 관용구(`qty1 = 180` 후 `default_qty_value=qty1`, resolveSecurityTfLiteral류와 동일
  // uniqueTopEqVars 안전 근거) — 재귀 해석해 리터럴로 치환.
  it("resolves top-level const identifiers for default_qty_value/pyramiding/initial_capital (C764)", () => {
    expect(
      transpile('qty1 = 2.5\nstrategy("s", default_qty_value=qty1)\nstrategy.entry("L", strategy.long)').ok,
    ).toBe(true);
    expect(
      transpile('maxPyr = 3\nstrategy("s", pyramiding=maxPyr)\nstrategy.entry("L", strategy.long)').ok,
    ).toBe(true);
    expect(
      transpile('cap = 50000\nstrategy("s", initial_capital=cap)\nstrategy.entry("L", strategy.long)').ok,
    ).toBe(true);
    // 식별자가 다시 다른 top-level 유일 상수를 가리키는 체인도 재귀 해석.
    const code = transpileCode('base = 100000\ncap = base\nstrategy("s", initial_capital=cap)\nstrategy.entry("L", strategy.long)');
    expect(code).toContain("$.strategy.configure(1, 1, 100000);");
  });

  it("rejects non-integer or negative pyramiding", () => {
    expect(
      transpileErrors('strategy("s", pyramiding=1.5)').some((e) =>
        e.includes("'pyramiding' argument only supports an int literal >= 0"),
      ),
    ).toBe(true);
    // -1은 파서가 UnaryOp('-', 1)로 만들어 NumberLiteral이 아니므로 같은 에러로 떨어진다.
    expect(
      transpileErrors('strategy("s", pyramiding=-1)').some((e) =>
        e.includes("'pyramiding' argument only supports an int literal >= 0"),
      ),
    ).toBe(true);
  });

  it("accepts strategy.position_size without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.position_size").ok).toBe(true);
  });
});

describe("strategy.* codegen emission", () => {
  it("emits $.strategy.entry with folded direction constant and qty", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, 2)');
    expect(code).toContain('$.strategy.entry("L", "long", 2);');
  });

  it("emits $.strategy.entry without qty when omitted (JS 기본 파라미터가 1을 채움)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long)');
    expect(code).toContain('$.strategy.entry("L", "long");');
  });

  it("emits $.strategy.close", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L")');
    expect(code).toContain('$.strategy.close("L");');
  });

  // C423: id=/direction= kwargs route to runtime slots 0/1 (KWARG_SLOTS — strategy.close의
  // id=(C293)와 동일 원리), 0 positional args라 args 배열이 빈 채로 시작해 kwarg가 두 슬롯을 채운다.
  it("emits $.strategy.entry with id=/direction= kwargs routed to positional slots (C423)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry(id="Long", direction=strategy.long, qty=2)');
    expect(code).toContain('$.strategy.entry("Long", "long", 2);');
  });

  it("emits $.strategy.entry with id positional + direction= kwarg mixed (C423)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("long", direction=strategy.short, comment="c")');
    expect(code).toContain('$.strategy.entry("long", "short", undefined, undefined, undefined, "c");');
  });

  it("emits parenthesized runtime exprs for position_size/position_avg_price", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.position_size\nvar float b = na\nb := strategy.position_avg_price',
    );
    expect(code).toContain("($.strategy.posSize)");
    expect(code).toContain("($.strategy.posAvgPrice)");
  });

  it("keeps the strategy() directive itself a no-op (rt.strategy 경유 없음)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long)');
    expect(code).not.toContain("rt.strategy");
    expect(code).not.toContain('strategy("s")');
  });

  it("emits $.strategy.entry with the folded \"short\" constant (C164)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("S", strategy.short, 1)');
    expect(code).toContain('$.strategy.entry("S", "short", 1);');
  });

  it("lowers qty= kwarg to the third positional slot (C164)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, qty=2)');
    expect(code).toContain('$.strategy.entry("L", "long", 2);');
  });

  it("lowers comment= kwarg to the 6th slot (C173 실소비)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, qty=2, comment="buy!")');
    expect(code).toContain('$.strategy.entry("L", "long", 2, undefined, undefined, "buy!");');
  });

  it("lowers when= kwarg to the 7th slot on strategy.entry (C372)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, when=close > open)');
    expect(code).toContain(
      '$.strategy.entry("L", "long", undefined, undefined, undefined, undefined, rt.pineGt($.close.get(0), $.open.get(0)));',
    );
  });

  it("lowers when= kwarg to the 7th slot on strategy.order (C372, entry와 동일 슬롯 표 공유)", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.long, when=close > open)');
    expect(code).toContain(
      '$.strategy.order("O", "long", undefined, undefined, undefined, undefined, rt.pineGt($.close.get(0), $.open.get(0)));',
    );
  });

  it("keeps the existing qty=+when= combination correctly slotted (C372)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, qty=2, when=true)');
    expect(code).toContain('$.strategy.entry("L", "long", 2, undefined, undefined, undefined, true);');
  });

  it("discards alert_message= on strategy.entry (C374, no KWARG_SLOTS entry — comment= 뒤 출력 무변화)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, comment="c", alert_message="hi")');
    expect(code).toContain('$.strategy.entry("L", "long", undefined, undefined, undefined, "c");');
    expect(code).not.toContain("hi");
  });

  it("emits a preamble $.strategy.configure line for default_qty_value/pyramiding (C164)", () => {
    const code = transpileCode('strategy("s", default_qty_value=2.5, pyramiding=3)\nstrategy.entry("L", strategy.long)');
    expect(code).toContain("$.strategy.configure(2.5, 3);");
    // 프리앰블(1회 실행 영역)에 있어야 한다 — per-bar 함수 본문 시작 전.
    expect(code.indexOf("$.strategy.configure")).toBeLessThan(code.indexOf("return function () {"));
  });

  it("fills configure defaults (1) when only one of the two values is given", () => {
    const code = transpileCode('strategy("s", default_qty_value=2)\nstrategy.entry("L", strategy.long)');
    expect(code).toContain("$.strategy.configure(2, 1);");
    const code2 = transpileCode('strategy("s", pyramiding=4)\nstrategy.entry("L", strategy.long)');
    expect(code2).toContain("$.strategy.configure(1, 4);");
  });

  // C465: `?? 1` 기본값 채움은 nullish 전용(0은 falsy지만 null이 아님) — default_qty_value=0이
  // 조용히 1로 둔갑하지 않는지 codegen 레벨에서 직접 확인.
  it("emits configure(0, ...) verbatim for default_qty_value=0 (C465, ?? 는 null만 대체)", () => {
    const code = transpileCode('strategy("s", default_qty_value=0)\nstrategy.entry("L", strategy.long, qty=2)');
    expect(code).toContain("$.strategy.configure(0, 1);");
  });

  it("emits no configure line when neither value is specified (기존 출력 무변화 — C129 원칙)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long)');
    expect(code).not.toContain("configure");
  });

  it("lowers limit= to the 4th slot, padding qty with undefined (C166, C129 원칙)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, limit=99.5)');
    expect(code).toContain('$.strategy.entry("L", "long", undefined, 99.5);');
  });

  it("lowers stop= to the 5th slot after a positional qty (C166)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, 2, stop=105)');
    expect(code).toContain('$.strategy.entry("L", "long", 2, undefined, 105);');
  });

  it("fills both limit= and stop= slots regardless of kwarg order (C166)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, stop=98, limit=99)');
    expect(code).toContain('$.strategy.entry("L", "long", undefined, 99, 98);');
  });

  it("lowers comment= alongside limit= to the 6th slot (C173)", () => {
    const code = transpileCode('strategy("s")\nstrategy.entry("L", strategy.long, limit=99, comment="buy!")');
    expect(code).toContain('$.strategy.entry("L", "long", undefined, 99, undefined, "buy!");');
  });

  it("emits $.strategy.cancel / $.strategy.cancel_all (C166)", () => {
    const code = transpileCode('strategy("s")\nstrategy.cancel("L")\nstrategy.cancel_all()');
    expect(code).toContain('$.strategy.cancel("L");');
    expect(code).toContain("$.strategy.cancel_all();");
  });

  it("lowers id= kwarg on strategy.cancel identically to a positional id (C382)", () => {
    const code = transpileCode('strategy("s")\nstrategy.cancel(id="L")');
    expect(code).toContain('$.strategy.cancel("L");');
  });

  it("registers a nested builtin call inside strategy.cancel's id= kwarg value (C382, wild f8629b966f24.pine shape)", () => {
    const code = transpileCode(
      'strategy("s")\nfor i = 0 to strategy.opentrades - 1\n    strategy.cancel(id="exit" + strategy.opentrades.entry_id(i))',
    );
    expect(code).toContain("$.strategy.openTradeEntryId(i)");
  });
});

describe("strategy.* E2E (hand-verified: 다음 바 open 체결)", () => {
  // 손 계산 시나리오 (바 5개, entry 신호 = 양봉(close>open), close 신호 = 음봉):
  //   bar0: O=10 C=11 양봉 -> entry("L",2) 큐잉. 이 바에서는 아직 flat (ps=0, ap=na)
  //   bar1: O=12 C=11 -> open 12에 체결(롱 2@12). 음봉 -> close 큐잉. (ps=2, ap=12)
  //   bar2: O=13 C=14 -> open 13에 청산(flat). 양봉 -> entry 재큐잉. (ps=0, ap=na)
  //   bar3: O=15 C=16 -> open 15에 체결(롱 2@15). 양봉 -> entry 또 큐잉. (ps=2, ap=15)
  //   bar4: O=17 C=16 -> 이미 롱이라 pyramiding=1 차단(주문 취소). 포지션 불변. (ps=2, ap=15)
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open",
    '    strategy.entry("L", strategy.long, 2)',
    "if close < open",
    '    strategy.close("L")',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_ap = na",
    "__obs_ap := strategy.position_avg_price",
  ].join("\n");

  it("tracks position_size per bar with next-bar-open fills", () => {
    const result = runPipeline(src, data);
    const ps = result.bars.map((b) => b["var:__obs_ps"]);
    expect(ps).toEqual([0, 2, 0, 2, 2]);
  });

  it("tracks position_avg_price per bar (flat이면 na)", () => {
    const result = runPipeline(src, data);
    const ap = result.bars.map((b) => b["var:__obs_ap"]);
    expect(Number.isNaN(ap[0]!)).toBe(true);
    expect(ap[1]).toBe(12);
    expect(Number.isNaN(ap[2]!)).toBe(true);
    expect(ap[3]).toBe(15);
    expect(ap[4]).toBe(15);
  });
});

describe("strategy.* E2E 둘째 슬라이스 (hand-verified: 숏/리버스)", () => {
  // 손 계산 시나리오 (바 5개, 양봉 -> 롱 entry, 음봉 -> 숏 entry — 매 신호가 리버스):
  //   bar0: O=10 C=11 양봉 -> entry("L",long,1) 큐잉. 아직 flat (ps=0, ap=na)
  //   bar1: O=12 C=11 -> open 12에 롱 1 체결. 음봉 -> entry("S",short,1) 큐잉. (ps=+1, ap=12)
  //   bar2: O=13 C=14 -> open 13에 리버스(숏 1). 양봉 -> entry("L") 큐잉. (ps=-1, ap=13)
  //   bar3: O=15 C=14 -> open 15에 리버스(롱 1). 음봉 -> entry("S") 큐잉. (ps=+1, ap=15)
  //   bar4: O=16 C=17 -> open 16에 리버스(숏 1). 양봉 -> entry("L") 큐잉(미체결). (ps=-1, ap=16)
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 16],
    high: [12, 13, 15, 16, 18],
    low: [9, 10, 12, 13, 15],
    close: [11, 11, 14, 14, 17],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open",
    '    strategy.entry("L", strategy.long, 1)',
    "if close < open",
    '    strategy.entry("S", strategy.short, 1)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_ap = na",
    "__obs_ap := strategy.position_avg_price",
  ].join("\n");

  it("tracks signed position_size through long/short reversals", () => {
    const result = runPipeline(src, data);
    const ps = result.bars.map((b) => b["var:__obs_ps"]);
    expect(ps).toEqual([0, 1, -1, 1, -1]);
  });

  it("tracks position_avg_price through reversals (각 리버스 바의 open)", () => {
    const result = runPipeline(src, data);
    const ap = result.bars.map((b) => b["var:__obs_ap"]);
    expect(Number.isNaN(ap[0]!)).toBe(true);
    expect(ap[1]).toBe(12);
    expect(ap[2]).toBe(13);
    expect(ap[3]).toBe(15);
    expect(ap[4]).toBe(16);
  });
});

describe("strategy.* E2E 둘째 슬라이스 (hand-verified: default_qty_value + pyramiding)", () => {
  // 손 계산 시나리오 (바 5개, default_qty_value=2 pyramiding=2, 양봉마다 entry — qty 인자 생략):
  //   bar0: O=10 C=11 양봉 -> entry 큐잉(qty=default 2). (ps=0, ap=na)
  //   bar1: O=12 C=13 -> 롱 2@12 체결(count=1). 양봉 -> entry 큐잉. (ps=2, ap=12)
  //   bar2: O=14 C=15 -> 추가 진입 2@14: avg=(12*2+14*2)/4=13, count=2. 양봉 -> 큐잉. (ps=4, ap=13)
  //   bar3: O=16 C=17 -> count=2>=2 차단(취소). 양봉 -> 큐잉. (ps=4, ap=13)
  //   bar4: O=18 C=17 -> 차단(취소). 음봉 -> 신호 없음. (ps=4, ap=13)
  const data: OHLCVData = {
    open: [10, 12, 14, 16, 18],
    high: [12, 14, 16, 18, 19],
    low: [9, 11, 13, 15, 16],
    close: [11, 13, 15, 17, 17],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", default_qty_value=2, pyramiding=2)',
    "if close > open",
    '    strategy.entry("L", strategy.long)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_ap = na",
    "__obs_ap := strategy.position_avg_price",
  ].join("\n");

  it("consumes default_qty_value and accumulates up to pyramiding fills", () => {
    const result = runPipeline(src, data);
    const ps = result.bars.map((b) => b["var:__obs_ps"]);
    expect(ps).toEqual([0, 2, 4, 4, 4]);
  });

  it("tracks the weighted-average position_avg_price across pyramiding fills", () => {
    const result = runPipeline(src, data);
    const ap = result.bars.map((b) => b["var:__obs_ap"]);
    expect(Number.isNaN(ap[0]!)).toBe(true);
    expect(ap[1]).toBe(12);
    expect(ap[2]).toBe(13);
    expect(ap[3]).toBe(13);
    expect(ap[4]).toBe(13);
  });
});

describe("StrategyState 셋째 슬라이스 (C165: 계좌 속성, hand-verified)", () => {
  it("starts with zeroed accumulators and the TV default initial capital (100000)", () => {
    const st = new StrategyState();
    expect(st.realizedPnl).toBe(0);
    expect(st.closedTrades).toBe(0);
    expect(st.winTrades).toBe(0);
    expect(st.lossTrades).toBe(0);
    expect(st.grossProfit).toBe(0);
    expect(st.grossLoss).toBe(0);
    expect(st.initialCapital).toBe(100000);
    expect(st.openProfit(123)).toBe(0); // flat — 미실현 손익 0
    expect(st.equity(123)).toBe(100000);
  });

  it("records a winning long close: (exit-entry)*qty", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10); // 롱 2 @ 10
    st.close("L");
    st.processFills(15); // 청산 @ 15 -> profit (15-10)*2 = 10
    expect(st.realizedPnl).toBe(10);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(1);
    expect(st.lossTrades).toBe(0);
    expect(st.grossProfit).toBe(10);
    expect(st.grossLoss).toBe(0);
  });

  it("records a losing long close (grossLoss는 pine2py와 동일하게 음수 합 — DIVERGENCES #68)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10);
    st.close("L");
    st.processFills(7); // profit (7-10)*2 = -6
    expect(st.realizedPnl).toBe(-6);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(0);
    expect(st.lossTrades).toBe(1);
    expect(st.grossProfit).toBe(0);
    expect(st.grossLoss).toBe(-6);
  });

  it("records a winning short close: (entry-exit)*qty via signed posSize", () => {
    const st = new StrategyState();
    st.entry("S", "short", 3);
    st.processFills(20); // 숏 3 @ 20
    st.close("S");
    st.processFills(15); // profit (15-20)*(-3) = +15
    expect(st.realizedPnl).toBe(15);
    expect(st.winTrades).toBe(1);
    expect(st.grossProfit).toBe(15);
  });

  it("records a losing short close", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(10);
    st.close("S");
    st.processFills(14); // profit (14-10)*(-1) = -4
    expect(st.realizedPnl).toBe(-4);
    expect(st.lossTrades).toBe(1);
    expect(st.grossLoss).toBe(-4);
  });

  it("a breakeven close counts as closed but neither win nor loss (pine2py 부등호 동일)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    st.close("L");
    st.processFills(10); // profit 0
    expect(st.realizedPnl).toBe(0);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(0);
    expect(st.lossTrades).toBe(0);
    expect(st.grossProfit).toBe(0);
    expect(st.grossLoss).toBe(0);
  });

  it("a reversal records the old position's realized PnL as one closed trade", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10); // 롱 2 @ 10
    st.entry("S", "short", 3);
    st.processFills(13); // 리버스: 청산 (13-10)*2=+6 -> 숏 3 @ 13
    expect(st.realizedPnl).toBe(6);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(1);
    expect(st.posSize).toBe(-3);
    st.close("S");
    st.processFills(11); // 청산 (11-13)*(-3)=+6
    expect(st.realizedPnl).toBe(12);
    expect(st.closedTrades).toBe(2);
    expect(st.winTrades).toBe(2);
    expect(st.grossProfit).toBe(12);
  });

  it("closing a pyramided position is one trade with the weighted-average entry (pine2py Trade 1건 — DIVERGENCES #68)", () => {
    const st = new StrategyState();
    st.configure(1, 2);
    st.entry("A", "long", 2);
    st.processFills(12); // 롱 2 @ 12
    st.entry("B", "long", 2);
    st.processFills(14); // 추가 진입 -> 롱 4 @ avg 13
    st.close("A");
    st.processFills(16); // profit (16-13)*4 = 12
    expect(st.realizedPnl).toBe(12);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(1);
  });

  it("accumulates counters across multiple trades (win 1건 + loss 1건)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10);
    st.close("A");
    st.processFills(15); // +5
    st.entry("B", "long", 2);
    st.processFills(20);
    st.close("B");
    st.processFills(17); // (17-20)*2 = -6
    expect(st.realizedPnl).toBe(-1);
    expect(st.closedTrades).toBe(2);
    expect(st.winTrades).toBe(1);
    expect(st.lossTrades).toBe(1);
    expect(st.grossProfit).toBe(5);
    expect(st.grossLoss).toBe(-6);
  });

  it("openProfit uses the caller-supplied close price and the signed posSize", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10);
    expect(st.openProfit(13)).toBe(6); // (13-10)*2
    expect(st.openProfit(8)).toBe(-4);
    const st2 = new StrategyState();
    st2.entry("S", "short", 2);
    st2.processFills(10);
    expect(st2.openProfit(7)).toBe(6); // (7-10)*(-2)
    expect(st2.openProfit(12)).toBe(-4);
  });

  it("equity = initialCapital + realized + open (configure 세 번째 인자 소비)", () => {
    const st = new StrategyState();
    st.configure(1, 1, 50000);
    expect(st.equity(99)).toBe(50000); // flat
    st.entry("L", "long", 1);
    st.processFills(10);
    expect(st.equity(14)).toBe(50004); // 미실현 +4
    st.close("L");
    st.processFills(12); // 실현 +2
    expect(st.equity(999)).toBe(50002);
  });

  it("configure without the third arg keeps the default initial capital (C164 2-인자 호출 호환)", () => {
    const st = new StrategyState();
    st.configure(5, 1);
    expect(st.initialCapital).toBe(100000);
    st.configure(5, 1, 777);
    expect(st.initialCapital).toBe(777);
  });
});

describe("strategy.* 계좌 속성 analyzer/codegen (C165)", () => {
  it("accepts all 10 account properties after a strategy() declaration", () => {
    for (const p of [
      "netprofit",
      "openprofit",
      "equity",
      "initial_capital",
      "closedtrades",
      "opentrades",
      "wintrades",
      "losstrades",
      "grossprofit",
      "grossloss",
    ]) {
      expect(transpile(`strategy("s")\nx = strategy.${p}`).ok).toBe(true);
    }
  });

  it("accepts strategy.netprofit without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.netprofit").ok).toBe(true);
  });

  it("rejects non-literal initial_capital in strategy()", () => {
    const errors = transpileErrors('x = input.float(1000)\nstrategy("s", initial_capital=x)');
    expect(errors.some((e) => e.includes("'initial_capital' argument only supports a number literal >= 0"))).toBe(true);
  });

  it("rejects negative initial_capital in strategy()", () => {
    const errors = transpileErrors('strategy("s", initial_capital=-1)');
    expect(errors.some((e) => e.includes("'initial_capital' argument only supports a number literal >= 0"))).toBe(true);
  });

  // C764: wild 3건이 initial_capital=0(equity 기저를 명시적으로 0 고정)을 실사용 — runtime(equity =
  // initialCapital + realizedPnl + openProfit, strategy.ts L490)이 나눗셈 분모가 아니라 0도
  // well-defined, default_qty_value=0(C465)과 동일 근거로 허용 전환.
  it("accepts zero initial_capital in strategy() (C764)", () => {
    expect(transpile('strategy("s", initial_capital=0)').ok).toBe(true);
  });

  it("emits plain accumulator reads for netprofit/closedtrades/initial_capital", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.netprofit\nvar float b = na\nb := strategy.closedtrades\nvar float c = na\nc := strategy.initial_capital',
    );
    expect(code).toContain("($.strategy.realizedPnl)");
    expect(code).toContain("($.strategy.closedTrades)");
    expect(code).toContain("($.strategy.initialCapital)");
  });

  it("emits method-call exprs with the current bar close for openprofit/equity", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.openprofit\nvar float b = na\nb := strategy.equity',
    );
    expect(code).toContain("($.strategy.openProfit($.close.get(0)))");
    expect(code).toContain("($.strategy.equity($.close.get(0)))");
  });

  it("emits a parenthesized ternary for opentrades (flat=0, 아니면 1)", () => {
    const code = transpileCode('strategy("s")\nvar float a = na\na := strategy.opentrades');
    expect(code).toContain("($.strategy.posSize === 0 ? 0 : 1)");
  });

  it("emits a 3-arg configure only when initial_capital is specified (C129 원칙)", () => {
    const code = transpileCode('strategy("s", initial_capital=50000)\nstrategy.entry("L", strategy.long)');
    expect(code).toContain("$.strategy.configure(1, 1, 50000);");
    const code2 = transpileCode(
      'strategy("s", default_qty_value=2, pyramiding=3, initial_capital=50000)\nstrategy.entry("L", strategy.long)',
    );
    expect(code2).toContain("$.strategy.configure(2, 3, 50000);");
  });
});

describe("strategy.* E2E 셋째 슬라이스 (hand-verified: 계좌 속성 — 롱 entry/close 손익)", () => {
  // 손 계산 시나리오 (첫 슬라이스 E2E와 동일 데이터, initial_capital=1000, 양봉 entry qty 2/음봉 close):
  //   bar0: O=10 C=11 양봉 -> entry 큐잉. flat: np=0 ct=0 op=0 eq=1000
  //   bar1: O=12 C=11 -> 롱 2@12 체결. 음봉 -> close 큐잉. op=(11-12)*2=-2, eq=998
  //   bar2: O=13 C=14 -> open 13 청산: profit (13-12)*2=+2. 양봉 -> entry 큐잉. np=2 ct=1 op=0 eq=1002
  //   bar3: O=15 C=16 -> 롱 2@15 체결. 양봉 -> entry 큐잉. np=2 op=(16-15)*2=2 eq=1004
  //   bar4: O=17 C=16 -> pyramiding=1 차단(취소). 음봉 -> close 큐잉(미체결). np=2 ct=1 op=2 eq=1004
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", initial_capital=1000)',
    "if close > open",
    '    strategy.entry("L", strategy.long, 2)',
    "if close < open",
    '    strategy.close("L")',
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
    "var float __obs_ct = na",
    "__obs_ct := strategy.closedtrades",
    "var float __obs_op = na",
    "__obs_op := strategy.openprofit",
    "var float __obs_eq = na",
    "__obs_eq := strategy.equity",
  ].join("\n");

  it("tracks netprofit per bar (실현 손익은 청산 체결 바부터)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 2, 2, 2]);
  });

  it("tracks closedtrades per bar", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ct"])).toEqual([0, 0, 1, 1, 1]);
  });

  it("tracks openprofit per bar (현재 바 close 기준, flat이면 0)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_op"])).toEqual([0, -2, 0, 2, 2]);
  });

  it("tracks equity per bar (initial_capital + realized + open)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_eq"])).toEqual([1000, 998, 1002, 1004, 1004]);
  });
});

describe("strategy.* E2E 셋째 슬라이스 (hand-verified: 리버스 연쇄의 트레이드 카운터)", () => {
  // 손 계산 시나리오 (둘째 슬라이스 리버스 E2E와 동일 데이터, 양봉 -> 롱 1/음봉 -> 숏 1):
  //   bar0: O=10 C=11 양봉 -> entry L 큐잉. flat
  //   bar1: O=12 C=11 -> 롱 1@12. 음봉 -> entry S 큐잉.
  //   bar2: O=13 C=14 -> 리버스: 청산 (13-12)*1=+1(win) 후 숏 1@13. 양봉 -> entry L 큐잉.
  //   bar3: O=15 C=14 -> 리버스: 청산 (15-13)*(-1)=-2(loss) 후 롱 1@15. 음봉 -> entry S 큐잉.
  //   bar4: O=16 C=17 -> 리버스: 청산 (16-15)*1=+1(win) 후 숏 1@16. 양봉 -> entry L 큐잉(미체결).
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 16],
    high: [12, 13, 15, 16, 18],
    low: [9, 10, 12, 13, 15],
    close: [11, 11, 14, 14, 17],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open",
    '    strategy.entry("L", strategy.long, 1)',
    "if close < open",
    '    strategy.entry("S", strategy.short, 1)',
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
    "var float __obs_ct = na",
    "__obs_ct := strategy.closedtrades",
    "var float __obs_wt = na",
    "__obs_wt := strategy.wintrades",
    "var float __obs_lt = na",
    "__obs_lt := strategy.losstrades",
    "var float __obs_gp = na",
    "__obs_gp := strategy.grossprofit",
    "var float __obs_gl = na",
    "__obs_gl := strategy.grossloss",
  ].join("\n");

  it("tracks netprofit through reversal-closed trades", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 1, -1, 0]);
  });

  it("counts each reversal close as one closed trade", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ct"])).toEqual([0, 0, 1, 2, 3]);
  });

  it("splits win/loss trade counters (0 손익은 어느 쪽도 아님)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_wt"])).toEqual([0, 0, 1, 1, 2]);
    expect(result.bars.map((b) => b["var:__obs_lt"])).toEqual([0, 0, 0, 1, 1]);
  });

  it("accumulates grossprofit(양수 합)/grossloss(음수 합 — DIVERGENCES #68)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_gp"])).toEqual([0, 0, 1, 1, 2]);
    expect(result.bars.map((b) => b["var:__obs_gl"])).toEqual([0, 0, 0, -2, -2]);
  });
});

describe("strategy.* E2E 넷째 슬라이스 (hand-verified: limit 이월 체결 + cancel)", () => {
  // 손 계산 시나리오 (limit 주문의 바 넘어 이월 — bar0에서 딱 한 번 limit=10.5 매수 주문):
  //   bar0: O=10 H=12 L=9.5 — barstate.isfirst → entry("L", limit=10.5) 큐잉. 이 바에서는 flat.
  //   bar1: O=12 H=13 L=11  — open 12 > 10.5(갭 아님), low 11 > 10.5 → 미체결 이월. flat.
  //   bar2: O=11 H=12 L=10  — open 11 > 10.5, low 10 <= 10.5 → limit 10.5에 체결. (ps=1, ap=10.5)
  //   bar3: O=9  H=10 L=8.5 — 추가 주문 없음. (ps=1, ap=10.5)
  //   bar4: O=8  H=9  L=7   — 그대로. (ps=1, ap=10.5)
  const data: OHLCVData = {
    open: [10, 12, 11, 9, 8],
    high: [12, 13, 12, 10, 9],
    low: [9.5, 11, 10, 8.5, 7],
    close: [11, 12, 11, 9.5, 8.5],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if barstate.isfirst",
    '    strategy.entry("L", strategy.long, 1, limit=10.5)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_ap = na",
    "__obs_ap := strategy.position_avg_price",
  ].join("\n");

  it("carries the limit order across bars and fills at the limit price", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 0, 1, 1, 1]);
    const ap = result.bars.map((b) => b["var:__obs_ap"]);
    expect(Number.isNaN(ap[0]!)).toBe(true);
    expect(Number.isNaN(ap[1]!)).toBe(true);
    expect(ap.slice(2)).toEqual([10.5, 10.5, 10.5]);
  });

  it("same-bar cancel prevents any fill (스크립트 문장 순서: entry 큐잉 → cancel)", () => {
    const cancelSrc = [
      'strategy("s")',
      "if barstate.isfirst",
      '    strategy.entry("L", strategy.long, 1, limit=10.5)',
      'strategy.cancel("L")',
      "var float __obs_ps = na",
      "__obs_ps := strategy.position_size",
    ].join("\n");
    const result = runPipeline(cancelSrc, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("StrategyState exit 브래킷 청산 (C167 다섯째 슬라이스, hand-verified)", () => {
  // 롱 1 @ 12 포지션을 만든 상태에서 시작하는 공용 셋업.
  function longAt12(): StrategyState {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    return st;
  }

  it("exit TP(limit) fills when high reaches the limit — 체결가는 limit", () => {
    const st = longAt12();
    st.exit("X", "", 15);
    expect(st.exitPending).toBe(true);
    expect(st.posSize).toBe(1); // 등록한 바에서는 체결 없음
    st.processFills(13, 16, 12); // open 13 < 15(갭 아님), high 16 >= 15 → limit 15 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3); // (15-12)*1
    expect(st.exitPending).toBe(false); // 주문 소비
  });

  it("exit is a no-op when flat at call time (pine2py is_flat 가드)", () => {
    const st = new StrategyState();
    st.exit("X", "", 15);
    expect(st.exitPending).toBe(false);
    st.processFills(20, 21, 19);
    expect(st.posSize).toBe(0);
  });

  it("exit is a no-op when from_entry does not match the position's entry id — \"\"는 전체 대상", () => {
    const st = longAt12();
    st.exit("X", "M", 15); // 포지션 entry id는 "L"
    expect(st.exitPending).toBe(false);
    st.exit("X", "", 15); // ""(생략)는 어떤 entry든 매칭
    expect(st.exitPending).toBe(true);
  });

  it("same-id exit re-call modifies the pending bracket (매 바 재호출 표준 패턴)", () => {
    const st = longAt12();
    st.exit("X", "", 15);
    st.exit("X", "", 20); // limit 15 → 20 수정
    st.processFills(13, 16, 12); // high 16 < 20 — 구 limit 15였다면 체결됐을 바
    expect(st.posSize).toBe(1);
    st.processFills(19, 21, 18); // high 21 >= 20 → 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(8); // (20-12)*1
  });

  it("different-id exit keeps the first pending order (동시 pending exit 1건 모델)", () => {
    const st = longAt12();
    st.exit("X", "", 15);
    st.exit("Y", "", 13); // 첫 주문 유지 — Y의 낮은 limit은 무시
    st.processFills(12.5, 14, 12); // high 14 >= 13(Y 기준)이지만 X의 15 미달 → 미체결
    expect(st.posSize).toBe(1);
    st.processFills(13, 16, 12); // X의 limit 15 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3);
  });

  it("exit with both limit/stop na places no order (조건 없는 exit — 마켓 청산으로 접지 않음)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN);
    expect(st.exitPending).toBe(false);
    st.exit("X"); // 둘 다 생략도 동일
    expect(st.exitPending).toBe(false);
    st.processFills(20, 21, 19);
    expect(st.posSize).toBe(1); // 청산되지 않음
  });

  it("exit TP fills at open on a gap-up (or-better — #69 (a) 축)", () => {
    const st = longAt12();
    st.exit("X", "", 15);
    st.processFills(16, 17, 15); // open 16 >= limit 15 → open 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(4); // (16-12)*1 — limit이었다면 3
  });

  it("exit SL(stop) fills when low reaches the stop — 체결가는 stop", () => {
    const st = longAt12();
    st.exit("X", "", NaN, 10);
    st.processFills(11, 12, 9.5); // open 11 > 10, low 9.5 <= 10 → stop 10 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(-2); // (10-12)*1
  });

  it("exit SL fills at open on a gap-down (트리거 시점 시장가)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, 10);
    st.processFills(9, 10, 8); // open 9 <= stop 10 → open 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(-3); // (9-12)*1 — stop이었다면 -2
  });

  it("bracket: 같은 바에 limit/stop 둘 다 트리거되면 stop(손절) 우선 (C186: O-L-H-C 확정 — 롱은 stop이 low 쪽이라 그대로 일치)", () => {
    const st = longAt12();
    st.exit("X", "", 15, 10);
    st.processFills(12, 16, 9); // high 16 >= 15(TP)이고 low 9 <= 10(SL) — low가 high보다 먼저라 stop 우선
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(-2); // stop 10 체결: (10-12)*1
    expect(st.lossTrades).toBe(1);
  });

  it("short bracket: 같은 바에 limit/stop 둘 다 트리거되면 limit(익절) 우선 (C186: O-L-H-C 확정 — 숏은 limit이 low 쪽이라 stop보다 먼저)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12); // 숏 1 @ 12
    st.exit("X", "", 9, 15); // limit 9(익절)/stop 15(손절)
    st.processFills(12, 16, 8); // low 8 <= 9(TP)이고 high 16 >= 15(SL) — low가 high보다 먼저라 limit 우선
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3); // limit 9 체결: (9-12)*(-1) — stop 우선이었다면 -3
    expect(st.winTrades).toBe(1);
  });

  it("short exit TP: low <= limit → limit 체결, 갭 다운은 open 체결", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12); // 숏 1 @ 12
    st.exit("X", "", 9);
    st.processFills(11, 12, 8); // open 11 > 9, low 8 <= 9 → limit 9 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3); // (9-12)*(-1)
    // 갭 다운 케이스
    const st2 = new StrategyState();
    st2.entry("S", "short", 1);
    st2.processFills(12);
    st2.exit("X", "", 9);
    st2.processFills(8, 9, 7); // open 8 <= 9 → open 체결
    expect(st2.realizedPnl).toBe(4); // (8-12)*(-1)
  });

  it("short exit SL: high >= stop → stop 체결, 갭 업은 open 체결", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12);
    st.exit("X", "", NaN, 14);
    st.processFills(13, 15, 12); // open 13 < 14, high 15 >= 14 → stop 14 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(-2); // (14-12)*(-1)
    const st2 = new StrategyState();
    st2.entry("S", "short", 1);
    st2.processFills(12);
    st2.exit("X", "", NaN, 14);
    st2.processFills(15, 16, 14.5); // open 15 >= 14 → open 체결
    expect(st2.realizedPnl).toBe(-3); // (15-12)*(-1)
  });

  it("carries the bracket across bars until a side triggers (이월)", () => {
    const st = longAt12();
    st.exit("X", "", 15, 10);
    st.processFills(12, 13, 11); // 어느 축도 미충족 → 이월
    expect(st.exitPending).toBe(true);
    expect(st.posSize).toBe(1);
    st.processFills(12, 16, 11); // high 16 >= 15 → TP 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3);
  });

  it("market close fill auto-cancels the pending exit (closeAt 수렴 — 부활 없음)", () => {
    const st = longAt12();
    st.exit("X", "", 15, 10);
    st.close("L");
    st.processFills(13, 13.5, 12.5); // close 마켓이 open 13에 먼저 체결 → flat + exit 소멸
    expect(st.posSize).toBe(0);
    expect(st.exitPending).toBe(false);
    expect(st.realizedPnl).toBe(1); // (13-12)*1 — exit 가격(15/10)이 아님
    // 새 포지션을 열어도 소멸한 브래킷이 부활하지 않는다
    st.entry("L2", "long", 1);
    st.processFills(14);
    st.processFills(14, 16, 9); // 구 브래킷(15/10)이 살아 있었다면 어느 쪽이든 체결됐을 바
    expect(st.posSize).toBe(1);
  });

  it("reverse entry fill auto-cancels the pending exit", () => {
    const st = longAt12();
    st.exit("X", "", 15, 10);
    st.entry("S", "short", 1);
    st.processFills(12, 13, 11); // exit 미트리거 → entry 리버스가 open 12에 체결(closeAt 경유)
    expect(st.posSize).toBe(-1);
    expect(st.exitPending).toBe(false);
    st.processFills(16, 17, 15); // 구 브래킷 TP 15가 살아 있었다면 (숏 기준 SL로도) 반응했을 바
    expect(st.posSize).toBe(-1);
  });

  it("cancel(id)/cancel_all also cancel a pending exit", () => {
    const st = longAt12();
    st.exit("X", "", 15, 10);
    st.cancel("Y"); // id 불일치 — 유지
    expect(st.exitPending).toBe(true);
    st.cancel("X");
    expect(st.exitPending).toBe(false);
    st.exit("X", "", 15, 10);
    st.cancel_all();
    expect(st.exitPending).toBe(false);
    st.processFills(16, 17, 9);
    expect(st.posSize).toBe(1); // 취소됐으니 청산 없음
  });

  it("exit fill updates the trade counters (closeAt 재사용 — 승/패 집계)", () => {
    const st = longAt12();
    st.exit("X", "", 15);
    st.processFills(13, 16, 12); // TP 15 체결, profit +3
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(1);
    expect(st.lossTrades).toBe(0);
    expect(st.grossProfit).toBe(3);
    expect(st.grossLoss).toBe(0);
  });

  it("same-bar exit fill → pending entry re-entry (청산 먼저 → entry 순서)", () => {
    const st = longAt12();
    st.exit("X", "", 15);
    st.entry("L2", "long", 1); // 같은 방향 재진입 주문(마켓) — pyramiding=1이지만 exit가 먼저 flat을 만든다
    st.processFills(16, 17, 15); // exit: open 16 >= 15 → open 체결 → flat → entry가 open 16에 새 포지션
    expect(st.realizedPnl).toBe(4); // (16-12)*1
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(16);
    expect(st.entryId).toBe("L2");
  });
});

describe("strategy.exit analyzer validation (C167)", () => {
  it("accepts strategy.exit with limit=/stop= kwargs (from_entry 위치/키워드 모두)", () => {
    expect(transpile('strategy("s")\nstrategy.exit("X", limit=15)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.exit("X", "L", stop=9)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.exit("X", from_entry="L", limit=15, stop=9)').ok).toBe(true);
    const src = ['strategy("s")', "if close > open", '    strategy.exit("X", limit=15)'].join("\n");
    expect(transpile(src).ok).toBe(true); // if 본문 안 호출 허용(이벤트 구동)
  });

  it("accepts strategy.exit without a strategy() declaration (C771)", () => {
    expect(transpile('strategy.exit("X", limit=15)').ok).toBe(true);
  });

  it("rejects strategy.exit in a value position (반환값 없음)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.exit("X", limit=15)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("validates strategy.exit positional arg count (0~3개, id는 kwarg로도 가능 — C424)", () => {
    // C424 이전: id= kwarg가 아예 미지원이라 args.length===0은 항상 에러였다. 이제 id kwarg가
    // 있으면 0개도 허용(아래 별도 테스트) — 여기는 id도 없이 0개(진짜 누락)와 4개 초과만 검증.
    expect(
      transpileErrors('strategy("s")\nstrategy.exit(limit=15)').some((e) =>
        e.includes("'strategy.exit' call argument count mismatch"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", "L", 1, 2, limit=15)').some((e) =>
        e.includes("'strategy.exit' call argument count mismatch"),
      ),
    ).toBe(true);
  });

  // C424(next_hint(C423) 1순위 재검증 — wild 49건 재클러스터링 결과 다수(47건)는 id(종종
  // from_entry도)를 전부 키워드 인자로 주는 폼, 소수(2건)만 next_hint가 예상한 qty 3번째 위치 인자
  // 폼(`strategy.exit("Bracket","LE1", q, profit=tp, loss=sl)`류)이었다 — 둘 다 이식.
  it("accepts strategy.exit id= kwarg only (0 positional args, C424, wild-evidenced)", () => {
    expect(transpile('strategy("s")\nstrategy.exit(id="X", limit=15)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.exit(id="X", from_entry="L", stop=9)').ok).toBe(true);
  });

  it("accepts strategy.exit with qty as a 3rd positional arg (C424, wild-evidenced)", () => {
    expect(transpile('strategy("s")\nstrategy.exit("X", "L", 1, profit=10, loss=5)').ok).toBe(true);
  });

  it("rejects strategy.exit id= duplicated with a positional id (C424)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", id="Y", limit=15)');
    expect(errors.some((e) => e.includes("'id' specified both positionally and as a keyword"))).toBe(true);
  });

  it("rejects strategy.exit qty= duplicated with a positional qty (C424)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", "L", 1, qty=2, profit=10)');
    expect(errors.some((e) => e.includes("'qty' specified both positionally and as a keyword"))).toBe(true);
  });

  // C168 긍정 마이그레이션: qty=가 정식 지원되면서(부분 청산) 거부 프로브 목록에서 제거 —
  // C170 재마이그레이션: trail_points=/trail_offset= 지원으로 에러 메시지 문자열 갱신.
  // C178 재마이그레이션: trail_price= 지원으로 목록에서 제거, qty_percent=(진짜 미구현 파라미터)로
  // 회전. profit=/loss= 신규 지원(hand-verified) 재마이그레이션: profit=/loss=가 목록에서 제거되고
  // oca_type=/alert_message=(둘 다 진짜 미구현 파라미터)로 회전(C120/C163~C178 프로브 회전 관례).
  // C373 재마이그레이션: qty_percent=(hand-verified 신규 지원)가 목록에서 제거 — 별도 긍정 테스트로
  // 이동, oca_name=/oca_type=/alert_message=(전부 진짜 미구현 파라미터)만 남김.
  // C374 재마이그레이션: alert_message=(순수 표시값 discard 신규 지원)가 목록에서 제거 — 별도
  // 긍정 테스트로 이동, disable_alert=로 회전(진짜 미구현 파라미터).
  // C375 재마이그레이션: comment_loss=/comment_profit=(hand-verified 신규 지원)가 에러 메시지
  // 문자열에 추가돼 이 substring도 갱신(oca_name=/oca_type=/disable_alert=는 여전히 진짜 미구현).
  // C380 재마이그레이션: when=(hand-verified 신규 지원)가 목록에 추가돼 이 substring도 갱신.
  // C424 재마이그레이션: id=(신규 지원)가 목록 맨 앞에 추가돼 이 substring도 갱신.
  // C673 재마이그레이션: comment_trailing=(hand-verified 신규 지원)가 when= 앞에 추가돼 이 substring도 갱신.
  // C708 재마이그레이션: alert_profit=/alert_loss=/disable_alert=(discard 신규 지원, wild 9건)가
  // 목록에서 제거되고 별도 긍정 테스트로 이동 — disable_alert=는 alert_trailing=(TV 시그니처의
  // 형제 파라미터, wild 근거 0건이라 MEMORY C283 큐레이션 원칙대로 미이식)로 회전.
  it("rejects unsupported strategy.exit kwargs (oca_name=/oca_type=/alert_trailing=)", () => {
    for (const kw of ['oca_name="g"', 'oca_type="cancel"', "alert_trailing=true"]) {
      const errors = transpileErrors(`strategy("s")\nstrategy.exit("X", limit=15, ${kw})`);
      expect(
        errors.some((e) =>
          e.includes(
            "'strategy.exit' only supports keyword arguments 'id='/'from_entry='/'limit='/'stop='/'trail_points='/'trail_offset='/'trail_price='/'qty='/'comment='/'profit='/'loss='/'qty_percent='/'alert_message='/'comment_loss='/'comment_profit='/'comment_trailing='/'when='/'alert_profit='/'alert_loss='/'disable_alert='",
          ),
        ),
      ).toBe(true);
    }
  });

  it("accepts strategy.exit alert_message= kwarg combined with a real exit condition (C374, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.exit("X", limit=15, alert_message="hi")').ok).toBe(true);
  });

  it("rejects duplicate alert_message= kwarg on strategy.exit", () => {
    const errors = transpileErrors(
      'strategy("s")\nstrategy.exit("X", limit=15, alert_message="a", alert_message="b")',
    );
    expect(errors.some((e) => e.includes("duplicate keyword argument 'alert_message'"))).toBe(true);
  });

  it("discards alert_message= on strategy.exit codegen (C374, no KWARG_SLOTS entry)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15, alert_message="hi")');
    expect(code).not.toContain("hi");
  });

  it("accepts strategy.exit alert_profit=/alert_loss=/disable_alert= kwargs combined with a real exit condition (C708, wild 9건, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.exit("X", limit=15, alert_profit="p")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.exit("X", limit=15, alert_loss="l")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.exit("X", limit=15, disable_alert=true)').ok).toBe(true);
  });

  it("rejects duplicate alert_profit=/alert_loss=/disable_alert= kwargs on strategy.exit", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, alert_profit="a", alert_profit="b")').some((e) =>
        e.includes("duplicate keyword argument 'alert_profit'"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, alert_loss="a", alert_loss="b")').some((e) =>
        e.includes("duplicate keyword argument 'alert_loss'"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, disable_alert=true, disable_alert=false)').some((e) =>
        e.includes("duplicate keyword argument 'disable_alert'"),
      ),
    ).toBe(true);
  });

  it("discards alert_profit=/alert_loss=/disable_alert= on strategy.exit codegen (C708, no KWARG_SLOTS entry)", () => {
    const code = transpileCode(
      'strategy("s")\nstrategy.exit("X", limit=15, alert_profit="pp", alert_loss="ll", disable_alert=true)',
    );
    expect(code).not.toContain("pp");
    expect(code).not.toContain("ll");
    expect(code).not.toContain("disable_alert");
  });

  // C723(배치37 지시 (1) — kwarg 상호배타 과잉검증 완화): 청산 조건 0개는 runtime/strategy.ts
  // exit()의 전-NaN no-op 가드(L1145-1150)로 안전하게 흡수돼 하드 에러를 제거.
  it("accepts strategy.exit without limit=/stop=/trail_points=/trail_price= (runtime no-op 가드로 안전, C723)", () => {
    for (const src of ['strategy.exit("X")', 'strategy.exit("X", "L")', 'strategy.exit("X", comment="c")']) {
      expect(transpileErrors(`strategy("s")\n${src}`)).toEqual([]);
    }
  });

  // C178 하드 에러 3종을 C723(배치37 지시 (1))에서 제거 — exitFillPrice()가 이미 trail_price 우선
  // activation + trail_points를 offset 폴백으로 자연 분리해 처리하고 있었음(상충 아님, hand-verified).
  it("accepts strategy.exit trail_price= combined with trail_points= (activation=trail_price, offset=trail_points, C723)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", trail_points=2, trail_offset=1, trail_price=14)'),
    ).toEqual([]);
  });

  it("accepts strategy.exit trail_price= without trail_offset= (offset NaN로 트레일링만 비활성, 다른 조건은 정상, C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", trail_price=14)')).toEqual([]);
  });

  it("accepts strategy.exit trail_price= with trail_offset=", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", trail_price=14, trail_offset=1)')).toEqual([]);
  });

  it("rejects duplicate stop= kwarg on strategy.exit", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", stop=9, stop=8)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'stop'"))).toBe(true);
  });

  it("rejects from_entry specified both positionally and as a kwarg", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", "L", from_entry="M", stop=9)');
    expect(errors.some((e) => e.includes("'from_entry' specified both positionally and as a keyword"))).toBe(true);
  });
});

describe("strategy.exit codegen emission (C167)", () => {
  it("lowers limit= to the 3rd slot, padding from_entry with undefined", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15);');
  });

  it("lowers stop= to the 4th slot after a positional from_entry", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", "L", stop=9)');
    expect(code).toContain('$.strategy.exit("X", "L", undefined, 9);');
  });

  it("fills both limit= and stop= slots (브래킷)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15, stop=9)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15, 9);');
  });

  it("emits the same slots regardless of kwarg order", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", stop=9, limit=15)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15, 9);');
  });

  it("lowers from_entry= kwarg to the 2nd slot", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", from_entry="L", stop=9)');
    expect(code).toContain('$.strategy.exit("X", "L", undefined, 9);');
  });

  it("lowers comment= on strategy.exit to the 8th slot (C173 실소비)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15, comment="tp!")');
    expect(code).toContain('$.strategy.exit("X", undefined, 15, undefined, undefined, undefined, undefined, "tp!");');
  });

  // C424: id=(신규 KWARG_SLOTS 슬롯 0) + qty가 3번째 위치 인자일 때의 재배치(슬롯 2/3 건너뛰고
  // 슬롯 4로 이동 — 런타임 exit(id, fromEntry, limit, stop, qty, ...) 시그니처가 TV 위치 순서
  // (id, from_entry, qty)와 다르기 때문, strategy.close의 comment 재배치(C345)와 동일 원칙).
  it("lowers id= kwarg to the 1st slot (0 positional args, C424)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit(id="X", limit=15)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15);');
  });

  it("lowers id=/from_entry= kwargs together (0 positional args, C424)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit(id="X", from_entry="L", stop=9)');
    expect(code).toContain('$.strategy.exit("X", "L", undefined, 9);');
  });

  it("moves a 3rd positional qty arg into the 5th slot, past limit/stop (C424)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", "L", 1, profit=10, loss=5)');
    expect(code).toContain(
      '$.strategy.exit("X", "L", undefined, undefined, 1, undefined, undefined, undefined, undefined, 10, 5);',
    );
  });

  it("combines a 3rd positional qty arg with a real limit=/stop= kwarg pair (C424)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", "L", 1, limit=15, stop=9)');
    expect(code).toContain('$.strategy.exit("X", "L", 15, 9, 1);');
  });
});

describe("strategy.* E2E 다섯째 슬라이스 (hand-verified: exit 브래킷 TP→SL)", () => {
  // 손 계산 시나리오 (롱 재진입 2회, 브래킷 limit=ap+3/stop=ap-2 — 매 바 재호출):
  //   bar0: O=10 C=11 양봉&flat → entry("L",1) 큐잉. (ps=0, np=0)
  //   bar1: O=12 → 롱 1@12 체결. ps>0 → exit("X","L",limit=15,stop=10) 등록. (ps=1, np=0)
  //   bar2: O=13 H=16 L=12 → open은 10/15 사이, high 16>=15 → TP 15 체결(np=+3). 양봉&flat →
  //         entry 재큐잉. (ps=0, np=3)
  //   bar3: O=15 → 롱 1@15 체결. exit(limit=18, stop=13) 등록. (ps=1, np=3)
  //   bar4: O=14 H=15 L=9 → open은 13/18 사이, low 9<=13 → SL 13 체결(np=3-2=1). (ps=0, np=1)
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 14],
    high: [12, 13, 16, 16, 15],
    low: [9, 11, 12, 13, 9],
    close: [11, 12, 14, 14, 10],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", "L", limit=strategy.position_avg_price + 3, stop=strategy.position_avg_price - 2)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("fills TP at the limit and SL at the stop across re-entries", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 1, 0, 1, 0]);
  });

  it("accumulates netprofit from bracket exits (+3 TP, -2 SL)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 3, 3, 1]);
  });
});

describe("strategy.* E2E 다섯째 슬라이스 (hand-verified: 갭 다운 SL open 체결 + 브래킷 이월)", () => {
  // 손 계산 시나리오 (bar2가 stop 아래로 갭 다운 — SL이 stop이 아닌 open에 체결):
  //   bar0: O=10 C=11 양봉&flat → entry 큐잉. (ps=0, np=0)
  //   bar1: O=12 → 롱 1@12 체결. exit(limit=15, stop=10) 등록. (ps=1, np=0)
  //   bar2: O=9 → open 9 <= stop 10 → SL이 open 9에 체결(np=9-12=-3 — stop 10 체결이면 -2).
  //         양봉(C=9.5)&flat → entry 재큐잉. (ps=0, np=-3)
  //   bar3: O=10 → 롱 1@10 체결. exit(limit=13, stop=8) 등록. (ps=1, np=-3)
  //   bar4: O=11 H=12 L=10 → 13/8 어느 축도 미충족 → 브래킷 이월, 포지션 유지. (ps=1, np=-3)
  const data: OHLCVData = {
    open: [10, 12, 9, 10, 11],
    high: [12, 13, 10, 11, 12],
    low: [9, 11, 8, 9, 10],
    close: [11, 13, 9.5, 10, 11],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", "L", limit=strategy.position_avg_price + 3, stop=strategy.position_avg_price - 2)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("fills the gap-down SL at open and carries an untriggered bracket", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 1, 0, 1, 1]);
  });

  it("records the gap fill price (open 9, not stop 10) in netprofit", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, -3, -3, -3]);
  });
});

describe("strategy.* E2E intrabar O-L-H-C 우선순위 (C186, hand-verified: 숏 브래킷 동시 트리거)", () => {
  // 손 계산 시나리오(VERIFIED_SEMANTICS.md CONFIRMED "intrabar 체결 경로 = 무조건 O-L-H-C" 적용
  // — 숏 브래킷은 limit(익절)이 low 쪽, stop(손절)이 high 쪽이라 low가 high보다 먼저 지나는
  // O-L-H-C 경로상 limit이 stop보다 먼저 체결돼야 한다):
  //   bar0: O=12 C=11(음봉)&flat → entry("S",1) 큐잉. (ps=0, np=0)
  //   bar1: O=11 → 숏 1@11 체결. ps<0 → exit("X","S",limit=avg-2=9,stop=avg+3=14) 등록. (ps=-1, np=0)
  //   bar2: O=10 H=15 L=8 → open은 9/14 사이(갭 아님), low 8<=9(TP)이고 high 15>=14(SL) 동시 도달 —
  //         O-L-H-C상 low가 high보다 먼저라 limit 9 체결(np=+2, stop 14였다면 -3). 음봉(C=9.5)&flat
  //         → entry 재큐잉. (ps=0, np=2)
  //   bar3: O=9 → 숏 1@9 체결. (ps=-1, np=2)
  const data: OHLCVData = {
    open: [12, 11, 10, 9],
    high: [12, 12, 15, 10],
    low: [11, 10, 8, 8],
    close: [11, 12, 9.5, 9],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close < open and strategy.position_size == 0",
    '    strategy.entry("S", strategy.short, 1)',
    "if strategy.position_size < 0",
    '    strategy.exit("X", "S", limit=strategy.position_avg_price - 2, stop=strategy.position_avg_price + 3)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("fills the short bracket at limit (not stop) when both trigger intrabar in the same bar", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, -1, 0, -1]);
  });

  it("accumulates netprofit from the limit fill (+2), not the stop fill (-3)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 2, 2]);
  });
});

describe("StrategyState close_all + qty 부분 청산 (C168 여섯째 슬라이스, hand-verified)", () => {
  it("close_all fills at next-bar open and resets to flat (id 무관 전량)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10); // 롱 2 @ 10
    st.close_all(); // entry id를 전혀 참조하지 않는다
    expect(st.posSize).toBe(2); // 호출한 바에서는 아직 미체결
    st.processFills(15);
    expect(st.posSize).toBe(0);
    expect(Number.isNaN(st.posAvgPrice)).toBe(true);
    expect(st.entryId).toBeNull();
    expect(st.realizedPnl).toBe(10); // (15-10)*2
    expect(st.closedTrades).toBe(1);
  });

  it("close_all is a no-op when flat at call time (pine2py is_flat 가드 port)", () => {
    const st = new StrategyState();
    st.close_all();
    expect(st.closePending).toBe(false);
    st.processFills(10);
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(0);
  });

  it("close_all is a no-op when when=false (C378)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close_all(undefined, false);
    expect(st.closePending).toBe(false);
    st.processFills(20);
    expect(st.posSize).toBe(2); // 여전히 롱 — when=false라 청산 큐잉 자체가 없었음
  });

  it("close_all fills normally when when=true (default, explicit and omitted are equivalent, C378)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close_all(undefined, true);
    st.processFills(20);
    expect(st.posSize).toBe(0);
  });

  it("close_all closes a short position (부호 확인)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 3);
    st.processFills(20); // 숏 3 @ 20
    st.close_all();
    st.processFills(14);
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(18); // (14-20)*(-1)*3
    expect(st.winTrades).toBe(1);
  });

  it("close_all kills the pending exit bracket via the full-close reset", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    st.exit("X", null, 15, 8);
    expect(st.exitPending).toBe(true);
    st.close_all();
    st.processFills(12); // 브래킷 어느 축도 안 건드리는 open — close_all이 먼저 전량 청산
    expect(st.posSize).toBe(0);
    expect(st.exitPending).toBe(false);
    expect(st.realizedPnl).toBe(2);
  });

  it("same-bar close_all + entry: both fill at the same next-bar open (close 먼저)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10);
    st.close_all();
    st.entry("B", "long", 2);
    st.processFills(20); // 청산(+10) 후 같은 open에서 재진입
    expect(st.realizedPnl).toBe(10);
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(20);
    expect(st.entryId).toBe("B");
  });

  it("close_all dominates an earlier same-bar partial close (전량으로 승격)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 4);
    st.processFills(10);
    st.close("A", 1);
    st.close_all(); // 부분 주문을 전량으로 덮어씀
    st.processFills(20);
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(40); // (20-10)*4
    expect(st.closedTrades).toBe(1);
  });

  it("partial close after a same-bar close_all is ignored (부분은 전량의 부분집합)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 4);
    st.processFills(10);
    st.close_all();
    st.close("A", 1); // closeAllPending 가드 — 무시
    st.processFills(20);
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(40);
  });

  it("close(qty=) partially closes, keeping avg price / entry id / remaining size", () => {
    const st = new StrategyState();
    st.entry("A", "long", 3);
    st.processFills(10);
    st.close("A", 1);
    st.processFills(16);
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(10); // avg 유지
    expect(st.entryId).toBe("A");
    expect(st.realizedPnl).toBe(6); // (16-10)*1
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(1);
    expect(st.grossProfit).toBe(6);
  });

  it("close(qty=) reaching the full size behaves exactly like a full close", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", 2);
    st.processFills(14);
    expect(st.posSize).toBe(0); // 정확-0 (posSize - sign*|posSize|)
    expect(Number.isNaN(st.posAvgPrice)).toBe(true);
    expect(st.entryId).toBeNull();
    expect(st.realizedPnl).toBe(8);
  });

  it("close(qty=) larger than the position clamps to a full close (초과 클램프 — TV 가설)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", 99);
    st.processFills(13);
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(6); // (13-10)*2 — 초과분은 청산할 것이 없음
    expect(st.closedTrades).toBe(1);
  });

  it("close ignores na(NaN)/zero/negative qty (주문 미발행 — entry qty 가드 미러)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", NaN);
    expect(st.closePending).toBe(false);
    st.close("A", 0);
    expect(st.closePending).toBe(false);
    st.close("A", -1);
    expect(st.closePending).toBe(false);
    st.processFills(15);
    expect(st.posSize).toBe(2);
  });

  it("close(qty=) works on a short position (부호 확인 + avg 유지)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 4);
    st.processFills(20); // 숏 4 @ 20
    st.close("S", 1);
    st.processFills(18);
    expect(st.posSize).toBe(-3);
    expect(st.posAvgPrice).toBe(20);
    expect(st.realizedPnl).toBe(2); // (18-20)*(-1)*1
  });

  it("partial close keeps the pending exit bracket alive for the remainder (가설 #71)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.exit("X", null, 20, 5);
    st.close("A", 1);
    st.processFills(12, 13, 11); // 부분 청산 +2, 브래킷은 어느 축도 미트리거 — 이월
    expect(st.posSize).toBe(1);
    expect(st.exitPending).toBe(true);
    st.processFills(21, 22, 20); // open 21 >= limit 20 — 잔여 1 계약 open 체결(전량)
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(13); // (12-10)*1 + (21-10)*1
    expect(st.closedTrades).toBe(2);
  });

  it("exit(qty=) partial fill consumes the bracket order but keeps the remainder", () => {
    const st = new StrategyState();
    st.entry("A", "long", 3);
    st.processFills(10);
    st.exit("X", null, 15, undefined, 1);
    st.processFills(12, 16, 11); // high 16 >= limit 15 — TP 15에 1 계약만 청산
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(10);
    expect(st.exitPending).toBe(false); // 주문 자체는 체결로 소진(재발행은 스크립트 몫)
    expect(st.realizedPnl).toBe(5); // (15-10)*1
    expect(st.closedTrades).toBe(1);
  });

  it("exit ignores na(NaN)/zero/negative qty (주문 미발행/기존 주문 무수정)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.exit("X", null, 15, undefined, NaN);
    expect(st.exitPending).toBe(false);
    st.exit("X", null, 15, undefined, 0);
    expect(st.exitPending).toBe(false);
    st.exit("X", null, 15, undefined, 1); // 정상 등록
    expect(st.exitPending).toBe(true);
    st.exit("X", null, 16, undefined, NaN); // qty na — 호출 전체 무시(가격도 무수정)
    expect(st.exitLimit).toBe(15);
    expect(st.exitQty).toBe(1);
  });

  it("same-id exit re-call updates qty (주문 수정)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 3);
    st.processFills(10);
    st.exit("X", null, 15, undefined, 1);
    st.exit("X", null, 15, undefined, 2);
    expect(st.exitQty).toBe(2);
    st.processFills(12, 16, 11);
    expect(st.posSize).toBe(1); // 3 - 2
    expect(st.realizedPnl).toBe(10); // (15-10)*2
  });

  it("exit(qty=) partial SL fill on a short position", () => {
    const st = new StrategyState();
    st.entry("S", "short", 2);
    st.processFills(20); // 숏 2 @ 20
    st.exit("X", null, undefined, 23, 1); // 손절 stop=23
    st.processFills(21, 24, 20); // high 24 >= 23 — stop 23에 1 계약 청산
    expect(st.posSize).toBe(-1);
    expect(st.realizedPnl).toBe(-3); // (23-20)*(-1)*1
    expect(st.lossTrades).toBe(1);
    expect(st.grossLoss).toBe(-3);
  });

  it("two partial closes count closedtrades per fill (부분 1회=1건 — pine2py Trade 관례 가설)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 3);
    st.processFills(10);
    st.close("A", 1);
    st.processFills(12); // +2 (win)
    st.close("A", 1);
    st.processFills(8); // -2 (loss)
    expect(st.posSize).toBe(1);
    expect(st.closedTrades).toBe(2);
    expect(st.winTrades).toBe(1);
    expect(st.lossTrades).toBe(1);
    expect(st.grossProfit).toBe(2);
    expect(st.grossLoss).toBe(-2);
    expect(st.realizedPnl).toBe(0);
  });

  it("partial close does not restore pyramiding capacity (entryCount 유지 — 보수 가설)", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2
    st.entry("A", "long", 2);
    st.processFills(10); // entryCount=1
    st.entry("A", "long", 2);
    st.processFills(12); // 추가 진입 — entryCount=2, avg=(10*2+12*2)/4=11
    expect(st.posSize).toBe(4);
    expect(st.posAvgPrice).toBe(11);
    st.close("A", 1);
    st.processFills(13); // 부분 청산 — entryCount는 2 유지
    expect(st.posSize).toBe(3);
    st.entry("A", "long", 1);
    st.processFills(14); // pyramiding 소진(2>=2) — 체결 차단
    expect(st.posSize).toBe(3);
    expect(st.posAvgPrice).toBe(11);
  });
});

describe("StrategyState close/close_all immediately= (C379, hand-verified — pine2py 오라클 불가)", () => {
  it("close(immediately=true) fills at the current bar's close, not the next bar's open", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10); // 롱 2 @ 10
    st.close("A", undefined, undefined, true, undefined, true, 13, 5); // 이번 바 close=13, idx=5
    expect(st.posSize).toBe(0); // 큐잉 없이 콜타임에 즉시 체결
    expect(st.closePending).toBe(false); // pending 큐를 아예 안 거침
    expect(st.realizedPnl).toBe(6); // (13-10)*2
    expect(st.closedTrades).toBe(1);
    expect(st.lastClosedExitBarIndex).toBe(5);
  });

  it("close(immediately=false or omitted) keeps the existing next-bar-open queueing behavior", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", undefined, undefined, true, undefined, false, 13, 5);
    expect(st.posSize).toBe(2); // 아직 미체결 — 큐잉만 됨
    expect(st.closePending).toBe(true);
    st.processFills(20);
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(20); // (20-10)*2 — open가 체결, close가 아님
  });

  it("close(immediately=true) still respects the id-match gate (no-op on mismatch)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("B", undefined, undefined, true, undefined, true, 13, 5); // id 불일치
    expect(st.posSize).toBe(2);
    expect(st.realizedPnl).toBe(0);
  });

  it("close(immediately=true) still respects when=false (no-op regardless of immediacy)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close("A", undefined, undefined, false, undefined, true, 13, 5);
    expect(st.posSize).toBe(2);
    expect(st.closePending).toBe(false);
  });

  it("close(qty=, immediately=true) partially closes now, leaving the remainder open", () => {
    const st = new StrategyState();
    st.entry("A", "long", 4);
    st.processFills(10);
    st.close("A", 1, undefined, true, undefined, true, 13, 5);
    expect(st.posSize).toBe(3); // 잔여 포지션은 그대로
    expect(st.posAvgPrice).toBe(10); // avg 유지
    expect(st.entryId).toBe("A");
    expect(st.realizedPnl).toBe(3); // (13-10)*1
  });

  it("close_all(immediately=true) closes the entire position now, ignoring id", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close_all("bye", true, true, 17, 9);
    expect(st.posSize).toBe(0);
    expect(st.closePending).toBe(false);
    expect(st.realizedPnl).toBe(14); // (17-10)*2
    expect(st.lastClosedExitComment).toBe("bye");
    expect(st.lastClosedExitBarIndex).toBe(9);
  });

  it("close_all(immediately=true) kills a pending exit bracket via the same flat reset closeAt already does", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    st.exit("X", null, 15, 8);
    expect(st.exitPending).toBe(true);
    st.close_all(undefined, true, true, 12, 3);
    expect(st.posSize).toBe(0);
    expect(st.exitPending).toBe(false);
  });

  it("close_all(immediately=true) still respects when=false", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close_all(undefined, false, true, 17, 9);
    expect(st.posSize).toBe(2);
  });

  it("an immediate close is not blocked by an already-pending same-bar close_all (pending-vs-pending 축과 무관)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 2);
    st.processFills(10);
    st.close_all(); // 다음 바 open 큐잉
    expect(st.closeAllPending).toBe(true);
    st.close("A", undefined, undefined, true, undefined, true, 13, 5); // 즉시 체결이 먼저 발동
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(6); // (13-10)*2 — close 가격 기준
    st.processFills(20); // 이미 flat이라 남아있던 close_all pending은 no-op
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(6);
  });
});

describe("strategy.close_all / qty= analyzer validation (C168)", () => {
  it("accepts strategy.close_all at top level and inside an if body", () => {
    const src = [
      'strategy("s")',
      'strategy.entry("L", strategy.long)',
      "strategy.close_all()",
      "if close < open",
      "    strategy.close_all()",
    ].join("\n");
    expect(transpile(src).ok).toBe(true);
  });

  it("accepts strategy.close_all comment= kwarg (C173부터 실소비)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all(comment="bye")').ok).toBe(true);
  });

  it("accepts strategy.close_all without a strategy() declaration (C771)", () => {
    expect(transpile("strategy.close_all()").ok).toBe(true);
  });

  it("accepts strategy.close_all(comment) as a positional argument (C250, corpus 실측 4afee54bdc81.pine)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all("bye")').ok).toBe(true);
    expect(
      transpile('strategy("s")\nstrategy.close_all(close > open ? "Exit" : na)').ok,
    ).toBe(true);
  });

  it("rejects duplicate comment specified both positionally and via comment= (C250, request.security C249와 동일 원칙)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close_all("bye", comment="bye2")');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'comment'"))).toBe(true);
  });

  // C467 재마이그레이션: pine2py engine.py `close_all(comment: str="", when: bool=True)`이 when도
  // 2번째 named parameter로 받음을 재확인해 위치 인자 상한을 1개->2개로 확장(wild 실측 7건,
  // `strategy.close_all('EOS', 'EOS', immediately=true)`류) — 경계는 3개부터 거부로 이동.
  it("accepts strategy.close_all(comment, when) as two positional arguments (C467, wild 실측)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all("bye", close > open)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close_all("bye", true)').ok).toBe(true);
  });

  it("rejects duplicate when specified both positionally and via when= (C467, comment C250과 동일 원칙)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close_all("bye", true, when=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'when'"))).toBe(true);
  });

  it("validates strategy.close_all arg count (위치 인자 0~2개 — 3개부터 거부, C467로 경계 확장)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close_all("bye", true, "extra")');
    expect(errors.some((e) => e.includes("'strategy.close_all' call argument count mismatch"))).toBe(true);
  });

  // C724(배치37 (1) 잔여, next_hint(C723)): disable_alert=(exit()의 alert_profit=/alert_loss=/
  // disable_alert=(C708)와 동일 축, 순수 alert 팝업 억제 discard)가 목록에서 제거 — 별도 긍정
  // 테스트로 이동. strategy.close_all은 이제 미지원 kwarg가 없어 이 테스트 자체를 "존재하지 않는
  // kwarg" 프로브로 회전(허용 목록 메시지는 확장돼 기대 문자열도 함께 갱신).
  it("rejects unsupported strategy.close_all kwargs (존재하지 않는 kwarg)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close_all(oca_name="g")');
    expect(
      errors.some((e) =>
        e.includes(
          "'strategy.close_all' only supports keyword arguments 'comment='/'alert_message='/'when='/'immediately='/'disable_alert='",
        ),
      ),
    ).toBe(true);
  });

  it("accepts strategy.close_all disable_alert= kwarg (C724, exit()와 동일 축, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all(disable_alert=true)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close_all("bye", disable_alert=false)').ok).toBe(true);
  });

  it("rejects duplicate disable_alert= kwarg on strategy.close_all", () => {
    const errors = transpileErrors(
      'strategy("s")\nstrategy.close_all(disable_alert=true, disable_alert=false)',
    );
    expect(errors.some((e) => e.includes("duplicate keyword argument 'disable_alert'"))).toBe(true);
  });

  it("discards disable_alert= on strategy.close_all codegen (C724, no KWARG_SLOTS entry)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all("bye", disable_alert=true)');
    expect(code).not.toContain("disable_alert");
  });

  it("accepts strategy.close_all alert_message= kwarg (C374, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all(alert_message="hi")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close_all("bye", alert_message="hi")').ok).toBe(true);
  });

  it("rejects duplicate alert_message= kwarg on strategy.close_all", () => {
    const errors = transpileErrors(
      'strategy("s")\nstrategy.close_all(alert_message="a", alert_message="b")',
    );
    expect(errors.some((e) => e.includes("duplicate keyword argument 'alert_message'"))).toBe(true);
  });

  it("accepts strategy.close_all when= kwarg (C378, entry/order/close와 동일 게이트)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all(when=close > open)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close_all("bye", when=true)').ok).toBe(true);
  });

  it("rejects duplicate when= kwarg on strategy.close_all", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close_all(when=true, when=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'when'"))).toBe(true);
  });

  it("accepts strategy.close_all immediately= kwarg (C379, hand-verified 즉시체결)", () => {
    expect(transpile('strategy("s")\nstrategy.close_all(immediately=true)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close_all("bye", immediately=false)').ok).toBe(true);
  });

  it("rejects duplicate immediately= kwarg on strategy.close_all", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close_all(immediately=true, immediately=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'immediately'"))).toBe(true);
  });

  it("discards alert_message= on strategy.close_all codegen (C374, comment= 슬롯만 유지)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all("bye", alert_message="hi")');
    expect(code).toContain('$.strategy.close_all("bye");');
    expect(code).not.toContain('"hi"');
  });

  it("rejects strategy.close_all in a value position (반환값 없음)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.close_all()');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  // C373 재마이그레이션: qty_percent=(hand-verified 신규 지원)가 목록에서 제거 — 별도 긍정
  // 테스트로 이동, alert_message=/immediately=(전부 진짜 미구현 파라미터)만 남김.
  // C374 재마이그레이션: alert_message=(순수 표시값 discard 신규 지원)가 목록에서 제거 —
  // 별도 긍정 테스트로 이동, immediately=(진짜 미구현 파라미터)만 남김.
  // C379 재마이그레이션: immediately=(hand-verified 신규 지원, 즉시체결 시맨틱)가 목록에서 제거 —
  // 별도 긍정 테스트로 이동, disable_alert=(진짜 미구현 파라미터)만 남김.
  it("rejects unsupported strategy.close kwargs (disable_alert= 등)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", disable_alert=true)');
    expect(
      errors.some((e) =>
        e.includes(
          "'strategy.close' only supports keyword arguments 'id='/'qty='/'comment='/'when='/'qty_percent='/'alert_message='/'immediately='",
        ),
      ),
    ).toBe(true);
  });

  it("accepts strategy.close immediately= kwarg (C379, hand-verified 즉시체결)", () => {
    expect(transpile('strategy("s")\nstrategy.close("L", immediately=true)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close(id="L", immediately=false)').ok).toBe(true);
  });

  it("rejects duplicate immediately= kwarg on strategy.close", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", immediately=true, immediately=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'immediately'"))).toBe(true);
  });

  it("accepts strategy.close alert_message= kwarg (C374, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.close("L", alert_message="hi")').ok).toBe(true);
  });

  it("rejects duplicate alert_message= kwarg on strategy.close", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", alert_message="a", alert_message="b")');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'alert_message'"))).toBe(true);
  });

  // C293(wild argcount 클러스터): id는 위치 인자 또는 'id=' 키워드 인자 중 하나로만 지정 가능
  // (wild 실측 `strategy.close(id="Short", when=...)` 전량이 이 폼).
  it("accepts strategy.close with id= as a keyword arg (0 positional args)", () => {
    expect(transpile('strategy("s")\nstrategy.close(id="L")').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.close(id="L", when=close > open)').ok).toBe(true);
  });

  it("rejects strategy.close with id given both positionally and as a keyword", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", id="M")');
    expect(errors.some((e) => e.includes("'id' specified both positionally and as a keyword"))).toBe(true);
  });

  it("rejects duplicate id= kwarg on strategy.close", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close(id="L", id="M")');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'id'"))).toBe(true);
  });

  it("rejects duplicate qty= kwarg on strategy.close", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", qty=1, qty=2)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'qty'"))).toBe(true);
  });

  // C345: comment도 id(C293)와 동일하게 위치 2번째 슬롯 또는 'comment=' 키워드 중 하나로만 지정 가능.
  it("rejects strategy.close with comment given both positionally and as a keyword", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", "bye", comment="also bye")');
    expect(errors.some((e) => e.includes("'comment' specified both positionally and as a keyword"))).toBe(true);
  });

  it("accepts strategy.exit qty= kwarg (부분 청산)", () => {
    expect(transpile('strategy("s")\nstrategy.exit("X", limit=15, qty=1)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.exit("X", "L", limit=15, stop=9, qty=2)').ok).toBe(true);
  });

  it("rejects duplicate qty= kwarg on strategy.exit", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, qty=1, qty=2)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'qty'"))).toBe(true);
  });
});

describe("strategy.close_all / qty= codegen emission (C168)", () => {
  it("emits $.strategy.close_all()", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all()');
    expect(code).toContain("$.strategy.close_all();");
  });

  it("lowers comment= on strategy.close_all to its sole slot (C173 실소비)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all(comment="bye!")');
    expect(code).toContain('$.strategy.close_all("bye!");');
  });

  it("emits a positional comment on strategy.close_all identically to comment= (C250)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all("bye!")');
    expect(code).toContain('$.strategy.close_all("bye!");');
  });

  it("lowers when= on strategy.close_all to the 2nd slot (C378)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all(when=close > open)');
    expect(code).toContain("$.strategy.close_all(undefined, rt.pineGt($.close.get(0), $.open.get(0)));");
  });

  it("keeps the existing comment=+when= combination correctly slotted (C378)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all("bye!", when=true)');
    expect(code).toContain('$.strategy.close_all("bye!", true);');
  });

  it("emits positional (comment, when) identically to comment=+when= (C467, no reslotting needed)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all("bye!", true)');
    expect(code).toContain('$.strategy.close_all("bye!", true);');
  });

  it("lowers immediately= on strategy.close_all to the 3rd slot + implicit close/idx/barTimeMs (C379/C418)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all(immediately=true)');
    expect(code).toContain(
      "$.strategy.close_all(undefined, undefined, true, $.close.get(0), $.idx, $.barTimeMs);",
    );
  });

  it("omits the implicit close/idx slots on strategy.close_all when immediately= is unused (C379, C129 무변화)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close_all("bye!", when=true)');
    expect(code).not.toContain("$.idx");
  });

  it("lowers close qty= to the 2nd slot", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L", qty=2)');
    expect(code).toContain('$.strategy.close("L", 2);');
  });

  it("lowers comment= on strategy.close to the 3rd slot (C173 실소비)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L", comment="bye!")');
    expect(code).toContain('$.strategy.close("L", undefined, "bye!");');
  });

  it("lowers id= kwarg on strategy.close identically to a positional id (C293)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close(id="L")');
    expect(code).toContain('$.strategy.close("L");');
  });

  // C345: 2번째 위치 인자(comment)는 런타임 close(id, qty, comment, when) 시그니처의 qty 슬롯을
  // 건너뛰어 comment 슬롯(3번째)으로 재배치돼야 한다 — comment=(kwarg) 출력과 동일해야 함.
  it("lowers a 2nd positional arg on strategy.close to the comment slot, skipping qty (C345)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L", "bye")');
    expect(code).toContain('$.strategy.close("L", undefined, "bye");');
  });

  it("lowers when= on strategy.close to the 4th slot (C293)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close(id="L", when=close > open)');
    expect(code).toContain('$.strategy.close("L", undefined, undefined, rt.pineGt($.close.get(0), $.open.get(0)));');
  });

  it("lowers immediately= on strategy.close to the 6th slot + implicit close/idx/barTimeMs (C379/C418)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L", immediately=true)');
    expect(code).toContain(
      '$.strategy.close("L", undefined, undefined, undefined, undefined, true, $.close.get(0), $.idx, $.barTimeMs);',
    );
  });

  it("omits the implicit close/idx slots on strategy.close when immediately= is unused (C379, C129 무변화)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L", when=close > open)');
    expect(code).not.toContain("$.idx");
  });

  it("lowers exit qty= to the 5th slot, padding stop with undefined", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15, qty=2)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15, undefined, 2);');
  });

  it("lowers exit stop=+qty= without a limit (3번 슬롯 undefined 패딩)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", stop=9, qty=2)');
    expect(code).toContain('$.strategy.exit("X", undefined, undefined, 9, 2);');
  });

  it("keeps the exit output unchanged when qty= is omitted (기존 슬라이스 출력 불변)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15, stop=9)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15, 9);');
  });
});

describe("strategy.* E2E 여섯째 슬라이스 (hand-verified: 부분 청산 + close_all)", () => {
  // 손 계산 시나리오 (롱 4 진입 → qty=1 부분 청산 → 음봉에서 close_all 전량 청산):
  //   bar0: O=10 C=11 양봉&flat → entry("L",4) 큐잉. (ps=0, np=0, ct=0)
  //   bar1: O=12 → 롱 4@12 체결. ps>=4 → close("L",qty=1) 큐잉. C=13>O=12라 close_all 미발동.
  //         (ps=4, np=0, ct=0)
  //   bar2: O=13 → 부분 청산 1@13 (np=+1, 잔여 3, avg 12 유지). C=12.5<O=13 음봉&ps>0 →
  //         close_all() 큐잉. (ps=3, np=1, ct=1)
  //   bar3: O=11 → close_all 전량 3@11 체결 (np=1+(11-12)*3=-2). 음봉이라 재진입 없음.
  //         (ps=0, np=-2, ct=2)
  //   bar4: O=9 C=9.5 양봉&flat → entry 재큐잉(미체결 종료). (ps=0, np=-2, ct=2)
  const data: OHLCVData = {
    open: [10, 12, 13, 11, 9],
    high: [11.5, 13.5, 13.5, 11.5, 10],
    low: [9.5, 11.5, 12, 9.5, 8.5],
    close: [11, 13, 12.5, 10, 9.5],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 4)',
    "if strategy.position_size >= 4",
    '    strategy.close("L", qty=1)',
    "if strategy.position_size > 0 and close < open",
    "    strategy.close_all()",
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
    "var float __obs_ct = na",
    "__obs_ct := strategy.closedtrades",
  ].join("\n");

  it("tracks position size through partial close and close_all", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 4, 3, 0, 0]);
  });

  it("accumulates netprofit from the partial (+1) and close_all (-3) fills", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 1, -2, -2]);
  });

  it("counts each partial fill as one closed trade (가설 #71)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ct"])).toEqual([0, 0, 1, 2, 2]);
  });
});

describe("strategy.* E2E 여섯째 슬라이스 (hand-verified: exit qty= 부분 익절 2단)", () => {
  // 손 계산 시나리오 (롱 2 진입, 매 바 qty=1 브래킷 재발행 — TP 2회로 분할 청산):
  //   bar0: O=10 C=11 양봉&flat → entry("L",2) 큐잉. (ps=0, np=0)
  //   bar1: O=12 → 롱 2@12 체결. exit("X","L",limit=15,qty=1) 등록. (ps=2, np=0)
  //   bar2: O=13 H=16 → high 16>=15 → TP 15에 1 계약 청산(np=+3, 잔여 1, avg 12 유지).
  //         ps>0 → exit 재발행(avg 불변이라 limit=15, qty=1). (ps=1, np=3)
  //   bar3: O=16 → open 16>=limit 15 — 갭 or-better, open 16에 잔여 1 계약 청산(np=3+4=7).
  //         C=15.5<O=16 음봉이라 재진입 없음. (ps=0, np=7)
  const data: OHLCVData = {
    open: [10, 12, 13, 16],
    high: [11, 13, 16, 17],
    low: [9, 11, 12, 15],
    close: [11, 13, 14, 15.5],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 2)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", "L", limit=strategy.position_avg_price + 3, qty=1)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("splits the exit into two partial TP fills (재발행 브래킷)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 2, 1, 0]);
  });

  it("accumulates netprofit from both partial fills (+3 at limit, +4 at gap open)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 3, 7]);
  });
});

// ── C169 일곱째 슬라이스: strategy.order 넷팅 주문 ─────────────────────────────
// entry와 달리 리버스 전량 청산/pyramiding 게이트가 없다: 체결 시 같은 방향이면 무조건 가중평균
// 증분, 반대 방향이면 |posSize|와 상쇄(축소/정확 flat/부호 반전 — 축소분은 closeAt 부분 산식으로
// 실현 손익 기록). pine2py order()는 _fill_entry 직행이라 반대 방향이면 기존 포지션을 손익 기록
// 없이 통째로 교체하는 실버그(engine.py L353) — 미추종, 전부 TV 미검증 가설(DIVERGENCES #72).
describe("StrategyState.order (C169, hand-verified)", () => {
  it("order queues a market order — fills next-bar open, opens a long position", () => {
    const st = new StrategyState();
    st.order("O", "long", 2);
    expect(st.posSize).toBe(0); // 호출한 바에서는 아직 flat
    st.processFills(100);
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(100);
    expect(st.entryId).toBe("O");
    expect(st.entryCount).toBe(1);
  });

  it("order opens a short position with direction \"short\"", () => {
    const st = new StrategyState();
    st.order("O", "short", 3);
    st.processFills(50);
    expect(st.posSize).toBe(-3);
    expect(st.posAvgPrice).toBe(50);
  });

  it("order defaults qty to strategy(default_qty_value=)", () => {
    const st = new StrategyState();
    st.configure(4, 1);
    st.order("O", "long");
    st.processFills(10);
    expect(st.posSize).toBe(4);
  });

  it("order ignores na(NaN)/zero/negative qty and na(null) id", () => {
    const st = new StrategyState();
    st.order("A", "long", NaN);
    st.order("B", "long", 0);
    st.order("C", "long", -3);
    st.order(null, "long", 1);
    st.processFills(10);
    expect(st.posSize).toBe(0);
    expect(st.entryId).toBeNull();
  });

  it("order throws on an unknown direction string (런타임 이중 방어)", () => {
    const st = new StrategyState();
    expect(() => st.order("X", "sideways", 1)).toThrow(/unsupported direction/);
    expect(() => st.order("X", "LONG", 1)).toThrow(/unsupported direction/);
  });

  it("order is a no-op when when=false (C372) — even with an invalid direction, no throw", () => {
    const st = new StrategyState();
    st.order("O", "bogus", 2, undefined, undefined, undefined, false);
    expect(st.orderPending).toBe(false);
    st.processFills(100);
    expect(st.posSize).toBe(0);
  });

  it("order queues normally when when=true (default, explicit and omitted are equivalent, C372)", () => {
    const st = new StrategyState();
    st.order("O", "long", 2, undefined, undefined, undefined, true);
    st.processFills(100);
    expect(st.posSize).toBe(2);
  });

  it("same-bar re-order with same id modifies, different id keeps the first order", () => {
    const st = new StrategyState();
    st.order("A", "long", 2);
    st.order("A", "long", 5); // 수정
    st.order("B", "long", 9); // 무시(첫 주문 유지)
    st.processFills(10);
    expect(st.posSize).toBe(5);
    expect(st.entryId).toBe("A");
  });

  it("same-direction order adds without a pyramiding gate and counts toward the entry gate", () => {
    const st = new StrategyState(); // pyramiding=1
    st.entry("L", "long", 2);
    st.processFills(10); // 롱 2 @ 10, entryCount=1
    st.order("O", "long", 2);
    st.processFills(20); // entry였다면 pyramiding=1에 차단 — order는 게이트 없음
    expect(st.posSize).toBe(4);
    expect(st.posAvgPrice).toBe(15); // (10*2+20*2)/4
    expect(st.entryId).toBe("L"); // 최초 진입 id 유지
    expect(st.entryCount).toBe(2);
    st.entry("L2", "long", 1);
    st.processFills(30); // order 체결이 entryCount를 올려 이후 entry는 게이트에 차단(가설 #72)
    expect(st.posSize).toBe(4);
  });

  it("opposite-direction order partially reduces the position (avg/entryId 유지, 손익 기록)", () => {
    const st = new StrategyState();
    st.order("L", "long", 10);
    st.processFills(10); // 롱 10 @ 10
    st.order("S", "short", 4);
    st.processFills(20);
    expect(st.posSize).toBe(6);
    expect(st.posAvgPrice).toBe(10); // 부분 상쇄는 평균가 불변
    expect(st.entryId).toBe("L");
    expect(st.realizedPnl).toBe(40); // (20-10)*4
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(1);
  });

  it("opposite-direction order with qty == |posSize| flattens exactly", () => {
    const st = new StrategyState();
    st.order("L", "long", 2);
    st.processFills(10);
    st.order("S", "short", 2);
    st.processFills(8);
    expect(st.posSize).toBe(0);
    expect(Number.isNaN(st.posAvgPrice)).toBe(true);
    expect(st.entryId).toBeNull();
    expect(st.entryCount).toBe(0);
    expect(st.realizedPnl).toBe(-4); // (8-10)*2
    expect(st.lossTrades).toBe(1);
  });

  it("opposite-direction order with qty > |posSize| reverses with the net quantity", () => {
    const st = new StrategyState();
    st.order("L", "long", 2);
    st.processFills(10);
    st.order("R", "short", 5);
    st.processFills(12);
    expect(st.posSize).toBe(-3); // 5 - 2 넷 수량만 진입(entry 리버스의 전량+전량과 다름)
    expect(st.posAvgPrice).toBe(12);
    expect(st.entryId).toBe("R");
    expect(st.entryCount).toBe(1);
    expect(st.realizedPnl).toBe(4); // (12-10)*2
    expect(st.closedTrades).toBe(1);
  });

  it("short position nets against an opposite long order (부등호 반전 미러)", () => {
    const st = new StrategyState();
    st.order("S", "short", 4);
    st.processFills(20); // 숏 4 @ 20
    st.order("L", "long", 1);
    st.processFills(15);
    expect(st.posSize).toBe(-3);
    expect(st.posAvgPrice).toBe(20);
    expect(st.realizedPnl).toBe(5); // (15-20)*(-1)*1
  });

  it("order limit= carries over until triggered and fills at limit (갭 오픈은 open or-better)", () => {
    const st = new StrategyState();
    st.order("O", "long", 1, 9);
    st.processFills(10, 11, 9.5); // low 9.5 > 9 — 미체결 이월
    expect(st.posSize).toBe(0);
    expect(st.orderPending).toBe(true);
    st.processFills(10, 11, 8.5); // low 8.5 <= 9 — limit 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(9);
    const st2 = new StrategyState();
    st2.order("O", "long", 1, 9);
    st2.processFills(8, 10, 7); // 갭 다운 open 8 <= 9 — open 체결(or-better)
    expect(st2.posAvgPrice).toBe(8);
  });

  it("order stop= carries over until triggered and fills at stop", () => {
    const st = new StrategyState();
    st.order("O", "long", 1, undefined, 12);
    st.processFills(10, 11.5, 9); // high 11.5 < 12 — 미체결 이월
    expect(st.posSize).toBe(0);
    st.processFills(10, 12.5, 9); // high 12.5 >= 12 — stop 체결
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(12);
  });

  it("cancel cancels a price-based order but not a market order", () => {
    const st = new StrategyState();
    st.order("O", "long", 1, 5);
    st.cancel("O");
    expect(st.orderPending).toBe(false);
    st.order("M", "long", 1);
    st.cancel("M"); // 마켓은 취소 불가
    st.processFills(10);
    expect(st.posSize).toBe(1);
  });

  it("cancel_all cancels a pending price-based order", () => {
    const st = new StrategyState();
    st.order("O", "short", 1, 99);
    st.cancel_all();
    expect(st.orderPending).toBe(false);
    st.processFills(10, 100, 9);
    expect(st.posSize).toBe(0);
  });

  it("same-bar entry then order fill sequence — order nets against the freshly filled entry", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.order("O", "short", 1);
    st.processFills(10); // entry 체결(롱 2 @ 10) → order 넷팅(1 축소, profit 0)
    expect(st.posSize).toBe(1);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(0); // profit 0은 win도 loss도 아님
    expect(st.lossTrades).toBe(0);
  });

  it("order full flatten kills the pending exit bracket, partial reduce keeps it", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10);
    st.exit("X", undefined, 100); // 익절 100 — 이 시나리오 가격대에선 트리거 안 됨
    st.order("O", "short", 1);
    st.processFills(11, 11, 11); // 부분 축소 — 브래킷 유지
    expect(st.posSize).toBe(1);
    expect(st.exitPending).toBe(true);
    st.order("O2", "short", 1);
    st.processFills(12, 12, 12); // 전량 도달 — flat 리셋이 브래킷 소멸
    expect(st.posSize).toBe(0);
    expect(st.exitPending).toBe(false);
    expect(st.realizedPnl).toBe(3); // (11-10)*1 + (12-10)*1
  });

  it("an unfilled carried entry limit order does not block same-bar order processing", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, 1); // limit 1 — 이 가격대에선 영원히 미체결
    st.order("O", "long", 2);
    st.processFills(10, 11, 9); // entry 이월(구 early-return이었다면 order가 굶었을 경로)
    expect(st.entryPending).toBe(true);
    expect(st.posSize).toBe(2);
    expect(st.entryId).toBe("O");
  });
});

describe("strategy.order analyzer (C169)", () => {
  it("accepts strategy.order at top level and inside an if body", () => {
    const src = [
      'strategy("s")',
      'strategy.order("O", strategy.long, 2)',
      "if close > open",
      '    strategy.order("S", strategy.short)',
    ].join("\n");
    expect(transpile(src).ok).toBe(true);
  });

  it("accepts strategy.order without a strategy() declaration (C771)", () => {
    expect(transpile('strategy.order("O", strategy.long)').ok).toBe(true);
  });

  it("rejects strategy.order in a value position (반환값 없음)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.order("O", strategy.long)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("validates strategy.order arg count (2~3개)", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.order("O")').some((e) =>
        e.includes("'strategy.order' call argument count mismatch"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.order("O", strategy.long, 1, 2)').some((e) =>
        e.includes("'strategy.order' call argument count mismatch"),
      ),
    ).toBe(true);
  });

  it("accepts strategy.order qty=/limit=/stop=/comment= kwargs", () => {
    expect(transpile('strategy("s")\nstrategy.order("O", strategy.long, qty=2)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.order("O", strategy.long, limit=99.5)').ok).toBe(true);
    expect(transpile('strategy("s")\nstrategy.order("O", strategy.long, 2, stop=101, comment="c")').ok).toBe(true);
  });

  it("accepts strategy.order when= kwarg (C372, entry와 동일 게이트)", () => {
    expect(transpile('strategy("s")\nstrategy.order("O", strategy.long, when=close > open)').ok).toBe(true);
  });

  it("accepts strategy.order alert_message= kwarg (C374, entry와 동일 게이트, 순수 표시값 discard)", () => {
    expect(transpile('strategy("s")\nstrategy.order("O", strategy.long, alert_message="hi")').ok).toBe(true);
  });

  it("rejects unsupported strategy.order kwargs (oca_name= 등)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.order("O", strategy.long, oca_name="g")');
    expect(
      errors.some((e) =>
        e.includes(
          "'strategy.order' only supports keyword arguments 'id='/'direction='/'qty='/'comment='/'limit='/'stop='/'when='/'alert_message='/'disable_alert='",
        ),
      ),
    ).toBe(true);
  });

  // C423(strategy.entry와 동일 슬라이스 — order는 entry와 검증을 공유).
  it("accepts strategy.order id=/direction= kwargs (C423, wild-evidenced)", () => {
    expect(transpile('strategy("s")\nstrategy.order(id="buyId", direction=strategy.long, qty=1, limit=99)').ok).toBe(
      true,
    );
  });

  it("rejects duplicate and positional-keyword conflicting qty", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.order("O", strategy.long, limit=1, limit=2)').some((e) =>
        e.includes("duplicate keyword argument 'limit'"),
      ),
    ).toBe(true);
    expect(
      transpileErrors('strategy("s")\nstrategy.order("O", strategy.long, 2, qty=3)').some((e) =>
        e.includes("argument 'qty' specified both positionally and as a keyword"),
      ),
    ).toBe(true);
  });
});

describe("strategy.order codegen (C169)", () => {
  it("emits $.strategy.order with folded direction constant and qty", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.long, 2)');
    expect(code).toContain('$.strategy.order("O", "long", 2);');
  });

  it("emits $.strategy.order without qty when omitted", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.short)');
    expect(code).toContain('$.strategy.order("O", "short");');
  });

  it("lowers qty= kwarg into the third positional slot", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.long, qty=2)');
    expect(code).toContain('$.strategy.order("O", "long", 2);');
  });

  it("lowers limit= kwarg with an undefined qty slot", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.long, limit=99.5)');
    expect(code).toContain('$.strategy.order("O", "long", undefined, 99.5);');
  });

  it("lowers stop= kwarg after a positional qty", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.long, 2, stop=105)');
    expect(code).toContain('$.strategy.order("O", "long", 2, undefined, 105);');
  });

  it("lowers comment= to the 6th slot (C173 실소비)", () => {
    const code = transpileCode('strategy("s")\nstrategy.order("O", strategy.long, comment="c")');
    expect(code).toContain('$.strategy.order("O", "long", undefined, undefined, undefined, "c");');
  });
});

// E2E A: order 누적(가중평균) → 반대 방향 부분 상쇄 — 5바 손 계산.
// var 카운터 n: bar0=1, bar1=2, ... 진행. 주문은 다음 바 open 체결.
// bar0: O1 롱 2 큐잉 → bar1 open 12 체결(롱 2 @ 12)
// bar1: O2 롱 3 큐잉 → bar2 open 14 체결: avg=(12*2+14*3)/5=13.2, pos=5
// bar2: O3 숏 3 큐잉 → bar3 open 13 체결: 3 축소, profit=(13-13.2)*3, pos=2, avg 유지
describe("strategy.order E2E — 누적 후 부분 상쇄 (C169, hand-verified 5바)", () => {
  const data: OHLCVData = {
    open: [10, 12, 14, 13, 15],
    high: [11, 13, 15, 14, 16],
    low: [9, 11, 13, 12, 14],
    close: [11, 13, 14, 14, 15],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.order("O1", strategy.long, 2)',
    "if n == 2",
    '    strategy.order("O2", strategy.long, 3)',
    "if n == 3",
    '    strategy.order("O3", strategy.short, 3)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("accumulates with weighted-average then partially nets down", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 2, 5, 2, 2]);
  });

  it("records realized pnl only for the netted quantity", () => {
    const result = runPipeline(src, data);
    const partial = (13 - 13.2) * 3; // IEEE754 그대로(손 계산 -0.6의 fp 표현)
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, partial, partial]);
  });
});

// E2E B: order 부호 반전(넷 수량 진입) — 5바 손 계산.
// bar0: S 롱 2 큐잉 → bar1 open 12 체결(롱 2 @ 12)
// bar2: R 숏 5 큐잉 → bar3 open 11 체결: 2 상쇄 profit=(11-12)*2=-2 + 잔여 3 숏 @ 11
describe("strategy.order E2E — 부호 반전 (C169, hand-verified 5바)", () => {
  const data: OHLCVData = {
    open: [10, 12, 14, 11, 13],
    high: [11, 13, 15, 12, 14],
    low: [9, 11, 13, 10, 12],
    close: [11, 13, 14, 12, 13],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.order("S", strategy.long, 2)',
    "if n == 3",
    '    strategy.order("R", strategy.short, 5)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("reverses to the net short quantity at the fill price", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 2, 2, -3, -3]);
  });

  it("realizes pnl only on the offset quantity at the reversal fill", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, -2, -2]);
  });
});

// ── C170 여덟째 슬라이스: strategy.exit trail_points=/trail_offset= 트레일링 스톱 ──
// pine2py engine.py _check_trailing_fill 이식(활성화 = avg±trail_points 도달, 이후 유리 극값에서
// trail_offset 떨어진 라인을 단조 래칫, 반대 극값이 라인에 닿으면 라인 체결) + 갭 오픈 open 체결
// 적응(#69 (a) 축). pine2py의 "재호출마다 trail_price 리셋"(Order 재생성)은 매 바 재호출 표준
// 패턴에서 래칫이 절대 형성되지 않는 실버그로 판단해 미추종 — 같은 id 수정은 라인 보존.
// 전부 TV 실측 미검증 가설(DIVERGENCES #73), hand-verified.
describe("StrategyState exit 트레일링 스톱 (C170 여덟째 슬라이스, hand-verified)", () => {
  function longAt12(): StrategyState {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    return st;
  }

  it("long: 활성화 후 유리 극값 래칫 → 라인 터치 시 라인 가격 체결", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2, 1); // 활성화 12+2=14, 오프셋 1
    expect(st.exitPending).toBe(true);
    st.processFills(13, 13.5, 12.5); // high 13.5 < 14 — 미활성
    expect(st.exitTrailPrice).toBeNaN();
    expect(st.posSize).toBe(1);
    st.processFills(14.5, 15, 14.2); // high 15 >= 14 활성화 → 라인 = 15-1 = 14, low 14.2 > 14 미체결
    expect(st.exitTrailPrice).toBe(14);
    expect(st.posSize).toBe(1);
    st.processFills(14.8, 16.5, 14.6); // 라인 = max(14, 16.5-1) = 15.5, low 14.6 <= 15.5 → 15.5 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3.5); // (15.5-12)*1
    expect(st.exitPending).toBe(false); // 주문 소비
  });

  it("long: 활성화 미달 바는 상태 없이 이월, 경계(>=)에서 활성화", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 5, 1); // 활성화 17
    st.processFills(13, 14, 12.5);
    st.processFills(14, 15, 13.5);
    expect(st.exitPending).toBe(true);
    expect(st.exitTrailPrice).toBeNaN(); // 두 바 모두 미활성 이월
    st.processFills(16, 17, 15.5); // high 17 >= 17(경계) → 라인 = 17-1 = 16, low 15.5 <= 16 → 16 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(4);
  });

  it("long: 넓은 바에서 같은 바 활성화+체결 (유리 극값 선행 가설)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2, 1);
    st.processFills(15.5, 16, 13.5); // 활성화(16>=14) → 라인 15, low 13.5 <= 15 → 같은 바 15 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3);
  });

  it("long: 라인 아래 갭 다운 open은 open 체결 (pine2py의 라인 가격 체결 미추종 — #69 (a) 축)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2, 1);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(13, 13.2, 12.8); // open 13 <= 14 → open 체결(라인 14 체결이었다면 profit 2)
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(1); // (13-12)*1
  });

  it("trail_offset 생략 시 trail_points를 오프셋으로 재사용 (pine2py 기본 규칙)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2); // 오프셋 = 2
    st.processFills(14.5, 15, 13.2); // 활성화 → 라인 = 15-2 = 13, low 13.2 > 13 미체결
    expect(st.exitTrailPrice).toBe(13);
    st.processFills(13.5, 13.6, 12.9); // 래칫 없음(13.6-2 < 13), low 12.9 <= 13 → 13 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(1);
  });

  // C723(배치37 지시 (1)): trail_price 단독(trail_offset/trail_points 둘 다 없음)은 analyzer
  // 하드 에러를 제거했으므로 runtime이 크래시/NaN 전파 없이 안전하게 저하되는지 확인 — offset이
  // NaN으로 남아 트레일링 라인이 영구 미형성(다른 청산 조건이 없으면 포지션이 계속 열려 있음).
  it("trail_price 단독은 offset 근거가 없어 트레일링 영구 비활성 (크래시 없음, C723)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, undefined, undefined, undefined, 20); // trail_price=20, offset 없음
    st.processFills(21, 22, 20.5); // activation(22>=20) 시도해도 offset NaN → 라인 NaN
    expect(st.exitTrailPrice).toBeNaN();
    expect(st.posSize).toBe(1); // 트레일링으로는 청산되지 않음(다른 조건 없어 계속 보유)
    st.processFills(25, 30, 24); // 더 크게 움직여도 여전히 NaN 라인 — 체결 없음
    expect(st.exitTrailPrice).toBeNaN();
    expect(st.posSize).toBe(1);
  });

  // trail_price+trail_points 동시 지정(구 하드 에러) — activation=trail_price(절대가 우선),
  // offset=trail_points(포인트 단위)로 자연 분리돼 정상 작동함을 확인.
  it("trail_price+trail_points 동시 지정은 activation=trail_price, offset=trail_points로 정상 작동 (C723)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 999, undefined, undefined, 14); // trail_price=14(활성화), trail_points=999(offset으로만 재사용)
    st.processFills(14.5, 15, 14.2); // activation(15>=14, trail_points의 12+999 아님) → 라인 = 15-999 = -984
    expect(st.exitTrailPrice).toBe(15 - 999);
    st.processFills(-900, -900, -1000); // 라인 밑으로 내려가는 극단값으로 체결 확인
    expect(st.posSize).toBe(0);
  });

  it("청산 조건 0개(min-1-condition 하드 에러 제거)는 런타임에서 등록 자체를 건너뛰는 no-op (C723)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN); // limit/stop/trail/profit/loss 전부 NaN
    expect(st.exitPending).toBe(false); // 등록되지 않음(L1145-1150 가드)
    st.processFills(100, 100, 100); // 아무 일도 안 일어남
    expect(st.posSize).toBe(1);
  });

  it("trail_points=0은 진입가에서 즉시 활성화 (profit 0 청산은 win도 loss도 아님)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 0, 1); // 활성화 12
    st.processFills(12.5, 13, 12.4); // 활성화(13>=12) → 라인 12, low 12.4 > 12 미체결
    expect(st.exitTrailPrice).toBe(12);
    st.processFills(12.3, 12.4, 11.9); // low 11.9 <= 12 → 12 체결, profit 0
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(0);
    expect(st.closedTrades).toBe(1);
    expect(st.winTrades).toBe(0);
    expect(st.lossTrades).toBe(0);
  });

  it("short: 활성화(low) → 최저가 래칫(min) → high 터치 시 라인 체결", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12); // 숏 1 @ 12
    st.exit("X", "", NaN, NaN, undefined, 2, 1); // 활성화 12-2=10, 오프셋 1
    st.processFills(10.5, 10.7, 9.8); // low 9.8 <= 10 활성화 → 라인 = 9.8+1 = 10.8, high 10.7 < 10.8 미체결
    expect(st.exitTrailPrice).toBe(10.8);
    st.processFills(10, 10.5, 9); // 라인 = min(10.8, 9+1) = 10, high 10.5 >= 10 → 10 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2); // (10-12)*(-1)
  });

  it("short: 라인 위 갭 업 open은 open 체결", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12);
    st.exit("X", "", NaN, NaN, undefined, 2, 1);
    st.processFills(10.5, 10.7, 9.8); // 라인 10.8
    st.processFills(11, 11.2, 10.9); // open 11 >= 10.8 → open 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(1); // (11-12)*(-1)
  });

  it("같은 바에 stop과 trail 둘 다 트리거되면 높은(롱) 레벨 체결 — 하락 경로에서 먼저 닿는 쪽", () => {
    const st = longAt12();
    st.exit("X", "", NaN, 10, undefined, 2, 1); // stop 10 + 트레일링
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(14.1, 14.1, 9); // low 9는 stop 10과 라인 14 둘 다 관통 → max(10, 14) = 14 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2); // (14-12)*1 — stop 우선이었다면 -2
  });

  it("같은 바에 trail과 limit 둘 다 트리거되면 trail(손절 계열) 우선 (C186: O-L-H-C 확정 — 롱은 trail이 low 쪽이라 그대로 일치)", () => {
    const st = longAt12();
    st.exit("X", "", 16, NaN, undefined, 2, 1); // limit 16 + 트레일링
    st.processFills(14.5, 15, 14.2); // 라인 14, high 15 < 16
    st.processFills(15, 16.5, 14.5); // 라인 → 15.5, high 16.5 >= 16(TP)이고 low 14.5 <= 15.5(trail) → 15.5
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3.5); // limit 우선이었다면 4
  });

  it("short: 같은 바에 trail과 limit 둘 다 트리거되면 limit(익절) 우선 (C186: O-L-H-C 확정 — 숏은 limit이 low 쪽이라 trail보다 먼저)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12); // 숏 1 @ 12
    st.exit("X", "", 8, NaN, undefined, 2, 2); // limit 8 + 트레일링(활성화 12-2=10, 오프셋 2)
    st.processFills(9.5, 9.8, 9); // low 9 <= 10 활성화 → 라인 = 9+2 = 11, high 9.8 < 11 미체결
    expect(st.exitTrailPrice).toBe(11);
    st.processFills(8.5, 9.5, 7); // 라인 → min(11, 7+2=9) = 9, high 9.5 >= 9(trail)이고 low 7 <= 8(limit) → limit 8
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(4); // (8-12)*(-1) — trail 우선이었다면 (9-12)*(-1)=3
  });

  it("같은 id 재호출(매 바 표준 패턴)은 달성된 라인을 보존한다 (pine2py의 매 바 리셋 실버그 미추종)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2, 1);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.exit("X", "", NaN, NaN, undefined, 2, 1); // 재호출 — 라인 보존
    expect(st.exitTrailPrice).toBe(14);
    st.processFills(14.5, 14.6, 13.9); // 보존된 라인 14: low 13.9 <= 14 → 14 체결(리셋이었다면 라인 13.6, 미체결)
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2);
  });

  it("트레일링 축을 제거한 같은 id 수정은 라인을 파기하고, 재도입은 활성화부터 다시", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2, 1);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.exit("X", "", 20, NaN); // limit 전용으로 수정 — 트레일링 제거
    expect(st.exitTrailPrice).toBeNaN();
    st.processFills(14.5, 14.6, 13.9); // limit 20 미달, 구 라인 14가 남아있었다면 체결됐을 바
    expect(st.posSize).toBe(1);
    st.exit("X", "", NaN, NaN, undefined, 2, 1); // 트레일링 재도입 — 신선한 상태
    st.processFills(13.5, 13.8, 13.2); // high 13.8 < 활성화 14 → 미활성, 미체결
    expect(st.exitTrailPrice).toBeNaN();
    expect(st.posSize).toBe(1);
  });

  it("신규 등록은 이전 주문의 잔류 라인을 차단한다 (미활성에서 시작)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, 2, 1);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(13, 13.2, 12.8); // open 13 <= 14 → 체결, 주문 소비(잔류 라인 14는 미판독 상태)
    expect(st.posSize).toBe(0);
    st.entry("L2", "long", 1);
    st.processFills(20, 20.5, 19.5); // 롱 1 @ 20
    st.exit("X2", "", NaN, NaN, undefined, 2, 1); // 신규 등록 — 라인 리셋
    expect(st.exitTrailPrice).toBeNaN();
    st.processFills(20.5, 21, 19.8); // 활성화 22 미달 → 미체결
    expect(st.posSize).toBe(1);
  });

  it("qty= 부분 청산과 트레일링 결합 — 라인 체결가로 부분만 청산, 잔여 포지션/avg 유지", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(12); // 롱 2 @ 12
    st.exit("X", "", NaN, NaN, 1, 2, 1); // qty 1 부분
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(14.1, 14.1, 13.9); // low 13.9 <= 14 → 14 체결 qty 1
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(12);
    expect(st.realizedPnl).toBe(2); // (14-12)*1
    expect(st.exitPending).toBe(false); // 부분 체결도 주문 소진(C168 규칙 상속)
    expect(st.closedTrades).toBe(1);
  });

  it("na 가드: 셋 다 na면 주문 미발행, trail_offset 단독도 미발행, trail 단독은 유효", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, NaN);
    expect(st.exitPending).toBe(false);
    st.exit("X", "", NaN, NaN, undefined, NaN, 1); // 활성화 레벨 없는 오프셋 — 조건 없음으로 접음
    expect(st.exitPending).toBe(false);
    st.exit("X", "", NaN, NaN, undefined, 2); // 트레일링 단독은 유효한 청산 조건
    expect(st.exitPending).toBe(true);
  });
});

// ── C178: strategy.exit trail_price= 절대 가격 활성화 ──
// pine2py에 사용자 파라미터로 존재하지 않아(C170/C173이 이미 확인) 전부 hand-verified 설계
// (DIVERGENCES #79). exitFillPrice의 activation 산식만 posAvgPrice±trail_points에서 trail_price
// 절대값으로 바뀌고, 그 이후 래칫/체결 판정은 trail_points 경로와 완전히 동일한 코드를 공유한다 —
// 아래 테스트는 C170 트레일링 스위트의 각 시나리오를 trail_price 등가값(avg±trail_points와 같은
// 절대 가격)으로 재현해 "활성화 산식만 교체됐고 나머지 동작은 동형"임을 확인한다.
describe("StrategyState exit 트레일링 스톱 trail_price= (C178, hand-verified)", () => {
  function longAt12(): StrategyState {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    return st;
  }

  it("long: trail_price=14(=avg12+2) 활성화 후 유리 극값 래칫 → 라인 터치 시 라인 가격 체결", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14); // 활성화 14, 오프셋 1
    expect(st.exitPending).toBe(true);
    st.processFills(13, 13.5, 12.5); // high 13.5 < 14 — 미활성
    expect(st.exitTrailPrice).toBeNaN();
    st.processFills(14.5, 15, 14.2); // high 15 >= 14 활성화 → 라인 = 15-1 = 14, low 14.2 > 14 미체결
    expect(st.exitTrailPrice).toBe(14);
    st.processFills(14.8, 16.5, 14.6); // 라인 = max(14, 16.5-1) = 15.5, low 14.6 <= 15.5 → 15.5 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3.5); // (15.5-12)*1
  });

  it("long: 활성화 미달 바는 상태 없이 이월, 경계(>=)에서 활성화 (trail_price=17=avg12+5)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 17);
    st.processFills(13, 14, 12.5);
    st.processFills(14, 15, 13.5);
    expect(st.exitTrailPrice).toBeNaN(); // 두 바 모두 미활성 이월
    st.processFills(16, 17, 15.5); // high 17 >= 17(경계) → 라인 = 17-1 = 16, low 15.5 <= 16 → 16 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(4);
  });

  it("long: 넓은 바에서 같은 바 활성화+체결 (trail_price=14)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14);
    st.processFills(15.5, 16, 13.5); // 활성화(16>=14) → 라인 15, low 13.5 <= 15 → 같은 바 15 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(3);
  });

  it("long: 라인 아래 갭 다운 open은 open 체결 (trail_price=14)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(13, 13.2, 12.8); // open 13 <= 14 → open 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(1); // (13-12)*1
  });

  it("short: trail_price=10(=avg12-2) 활성화(low) → 최저가 래칫(min) → high 터치 시 라인 체결", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12); // 숏 1 @ 12
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 10); // 활성화 10, 오프셋 1
    st.processFills(10.5, 10.7, 9.8); // low 9.8 <= 10 활성화 → 라인 = 9.8+1 = 10.8, high 10.7 < 10.8 미체결
    expect(st.exitTrailPrice).toBe(10.8);
    st.processFills(10, 10.5, 9); // 라인 = min(10.8, 9+1) = 10, high 10.5 >= 10 → 10 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2); // (10-12)*(-1)
  });

  it("short: 라인 위 갭 업 open은 open 체결 (trail_price=10)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12);
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 10);
    st.processFills(10.5, 10.7, 9.8); // 라인 10.8
    st.processFills(11, 11.2, 10.9); // open 11 >= 10.8 → open 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(1); // (11-12)*(-1)
  });

  it("같은 id 재호출(매 바 표준 패턴)은 달성된 라인을 보존한다 (trail_price 버전)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14); // 재호출 — 라인 보존
    expect(st.exitTrailPrice).toBe(14);
    st.processFills(14.5, 14.6, 13.9); // 보존된 라인 14: low 13.9 <= 14 → 14 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2);
  });

  it("트레일링 축(trail_price)을 제거한 같은 id 수정은 라인을 파기하고, 재도입은 활성화부터 다시", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.exit("X", "", 20, NaN); // limit 전용으로 수정 — trail_points/trail_price 둘 다 미지정, 트레일링 제거
    expect(st.exitTrailPrice).toBeNaN();
    st.processFills(14.5, 14.6, 13.9); // limit 20 미달, 구 라인 14가 남아있었다면 체결됐을 바
    expect(st.posSize).toBe(1);
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14); // 트레일링 재도입 — 신선한 상태
    st.processFills(13.5, 13.8, 13.2); // high 13.8 < 활성화 14 → 미활성, 미체결
    expect(st.exitTrailPrice).toBeNaN();
    expect(st.posSize).toBe(1);
  });

  it("신규 등록은 이전 주문의 잔류 라인을 차단한다 (trail_price 버전, 미활성에서 시작)", () => {
    const st = longAt12();
    st.exit("X", "", NaN, NaN, undefined, NaN, 1, undefined, 14);
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(13, 13.2, 12.8); // open 13 <= 14 → 체결, 주문 소비
    expect(st.posSize).toBe(0);
    st.entry("L2", "long", 1);
    st.processFills(20, 20.5, 19.5); // 롱 1 @ 20
    st.exit("X2", "", NaN, NaN, undefined, NaN, 1, undefined, 22); // 신규 등록(활성화 22) — 라인 리셋
    expect(st.exitTrailPrice).toBeNaN();
    st.processFills(20.5, 21, 19.8); // 활성화 22 미달 → 미체결
    expect(st.posSize).toBe(1);
  });

  it("qty= 부분 청산과 trail_price 결합 — 라인 체결가로 부분만 청산, 잔여 포지션/avg 유지", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(12); // 롱 2 @ 12
    st.exit("X", "", NaN, NaN, 1, NaN, 1, undefined, 14); // qty 1 부분, 활성화 14
    st.processFills(14.5, 15, 14.2); // 라인 14
    st.processFills(14.1, 14.1, 13.9); // low 13.9 <= 14 → 14 체결 qty 1
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(12);
    expect(st.realizedPnl).toBe(2); // (14-12)*1
    expect(st.exitPending).toBe(false);
    expect(st.closedTrades).toBe(1);
  });
});

describe("strategy.exit 트레일링 analyzer validation (C170)", () => {
  it("accepts trail_points= as the sole exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", trail_points=2)')).toEqual([]);
  });

  it("accepts trail_points= + trail_offset= combined with limit=", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", limit=20, trail_points=2, trail_offset=1)'),
    ).toEqual([]);
  });

  // C723(배치37 지시 (1)): trail_offset 단독은 hasTrail=false로 완전 비활성(no-op) — 다른 청산
  // 조건(stop=)은 정상 작동하므로 하드 에러 제거.
  it("accepts trail_offset= without trail_points=/trail_price= (활성화 레벨 없어 트레일링만 비활성, C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", stop=9, trail_offset=1)')).toEqual([]);
  });

  it("rejects duplicate trail_points= kwarg", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", trail_points=2, trail_points=3)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'trail_points'"))).toBe(true);
  });
});

describe("strategy.exit 트레일링 codegen emission (C170)", () => {
  it("lowers trail_points= to the 6th slot, padding intermediates with undefined", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", trail_points=2)');
    expect(code).toContain('$.strategy.exit("X", undefined, undefined, undefined, undefined, 2);');
  });

  it("lowers trail_points=/trail_offset= to slots 6~7", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", trail_points=2, trail_offset=1)');
    expect(code).toContain('$.strategy.exit("X", undefined, undefined, undefined, undefined, 2, 1);');
  });

  it("combines limit= with trail_points= (중간 슬롯만 undefined)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", limit=15, trail_points=2)');
    expect(code).toContain('$.strategy.exit("X", undefined, 15, undefined, undefined, 2);');
  });

  it("keeps a positional from_entry alongside stop=/trail kwargs", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", "L", stop=9, trail_points=2, trail_offset=1)');
    expect(code).toContain('$.strategy.exit("X", "L", undefined, 9, undefined, 2, 1);');
  });

  // C178: trail_price=는 comment(slot 7)보다 뒤인 slot 8 — 기존 trail_points= 전용 출력 무변화(C129).
  it("lowers trail_price=/trail_offset= to slot 8 (past the comment slot)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", trail_price=14, trail_offset=1)');
    expect(code).toContain('$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, 1, undefined, 14);');
  });
});

describe("strategy.* E2E 여덟째 슬라이스 (hand-verified: 트레일링 래칫 → 라인 체결)", () => {
  // 손 계산 시나리오 (trail_points=2, trail_offset=1 — 매 바 재호출로 라인 보존):
  //   bar0: O=10 C=11 양봉&flat → entry("L",1) 큐잉. (ps=0, np=0)
  //   bar1: O=12 → 롱 1@12 체결(활성화 레벨 12+2=14). exit("X", trail_points=2, trail_offset=1)
  //         등록. (ps=1, np=0)
  //   bar2: O=14.5 H=15 L=14.2 → high 15>=14 활성화, 라인=15-1=14, low 14.2>14 미체결.
  //         exit 재호출(라인 14 보존). (ps=1, np=0)
  //   bar3: O=14.8 H=16.5 L=14.6 → 라인=max(14,16.5-1)=15.5, low 14.6<=15.5 → 15.5 체결
  //         (np=15.5-12=3.5). 음봉(C=14.7)이라 재진입 없음. (ps=0, np=3.5)
  //   bar4: 주문 없음. (ps=0, np=3.5)
  const data: OHLCVData = {
    open: [10, 12, 14.5, 14.8, 15],
    high: [12, 13, 15, 16.5, 15.5],
    low: [9, 11.5, 14.2, 14.6, 14.5],
    close: [11, 12.5, 14.8, 14.7, 15],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", trail_points=2, trail_offset=1)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("ratchets the trail line across bars and fills at the line", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 1, 1, 0, 0]);
  });

  it("realizes the trailing exit at the ratcheted line price (15.5)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 3.5, 3.5]);
  });
});

describe("strategy.* E2E 여덟째 슬라이스 (hand-verified: 라인 아래 갭 다운 open 체결)", () => {
  // 손 계산 시나리오 (trail_points=1, trail_offset=1 — bar3이 라인 아래로 갭 다운):
  //   bar0: O=10 C=11 양봉&flat → entry 큐잉. (ps=0, np=0)
  //   bar1: O=12 → 롱 1@12 체결(활성화 13). exit(trail_points=1, trail_offset=1) 등록. (ps=1, np=0)
  //   bar2: O=13.5 H=14 L=13.2 → 활성화(14>=13), 라인=14-1=13, low 13.2>13 미체결. 재호출 보존.
  //         (ps=1, np=0)
  //   bar3: O=12.5 → open 12.5 <= 라인 13 → open 12.5 체결(np=0.5 — 라인 13 체결이었다면 1).
  //         음봉이라 재진입 없음. (ps=0, np=0.5)
  //   bar4: 주문 없음. (ps=0, np=0.5)
  const data: OHLCVData = {
    open: [10, 12, 13.5, 12.5, 12],
    high: [12, 13, 14, 12.8, 12.5],
    low: [9, 11.5, 13.2, 12, 11.8],
    close: [11, 12.5, 13.8, 12.2, 12],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", trail_points=1, trail_offset=1)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("fills the gap-down at open, not at the stale trail line", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 1, 1, 0, 0]);
  });

  it("records the open fill price (12.5, not line 13) in netprofit", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 0.5, 0.5]);
  });
});

// C178 E2E: 위 "트레일링 래칫 → 라인 체결" 시나리오를 trail_price=14(=avg12+2와 동일한 절대가)로
// 재현 — 활성화 산식만 절대가 비교로 바뀌고 그 외 전 경로(래칫/체결/실현손익)는 동일해야 한다.
describe("strategy.* E2E trail_price= (C178, hand-verified: 트레일링 래칫 → 라인 체결과 동형)", () => {
  const data: OHLCVData = {
    open: [10, 12, 14.5, 14.8, 15],
    high: [12, 13, 15, 16.5, 15.5],
    low: [9, 11.5, 14.2, 14.6, 14.5],
    close: [11, 12.5, 14.8, 14.7, 15],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", trail_price=14, trail_offset=1)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("ratchets the trail line across bars and fills at the line (trail_price 활성화)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 1, 1, 0, 0]);
  });

  it("realizes the trailing exit at the ratcheted line price (15.5)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 3.5, 3.5]);
  });
});

// ── strategy.exit profit=/loss= (hand-verified, DIVERGENCES #98) ──
// pine2py exit()는 **kwargs로 받아 조용히 버리는 파라미터라(engine.py L141-153, C170/C173이 이미
// grep으로 확인) 대응 구현 자체가 없음 — trail_price=(C178)와 동일한 "오라클 불가, hand-verified"
// 축. limit=/stop=(절대가)의 포인트 단위 대안: profit=은 posAvgPrice에서 유리한 방향으로,
// loss=는 불리한 방향으로 이만큼 떨어진 가격을 익절/손절 레벨로 쓴다. trail_points의 activation
// 산식과 동일하게 exitFillPrice가 매 바 posAvgPrice로 다시 계산(콜타임 스냅샷 아님 — pyramiding으로
// avg가 바뀌어도 정합). 단위는 trail_points와 동일하게 가격 포인트(TV는 틱 단위로 알려져 있으나
// syminfo.mintick 미구현 — mintick=1 가정과 동치, #73 축 계승).
describe("StrategyState exit profit=/loss= (hand-verified, DIVERGENCES #98)", () => {
  function longAt12(): StrategyState {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    return st;
  }

  function shortAt12(): StrategyState {
    const st = new StrategyState();
    st.entry("S", "short", 1);
    st.processFills(12);
    return st;
  }

  it("long: profit= computes the limit target as posAvgPrice+profit — high touches it", () => {
    const st = longAt12();
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2); // target 12+2=14
    st.processFills(13, 15, 12.5); // high 15 >= 14 -> 14 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2); // (14-12)*1
    expect(st.winTrades).toBe(1);
  });

  it("long: loss= computes the stop target as posAvgPrice-loss — low touches it", () => {
    const st = longAt12();
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2); // target 12-2=10
    st.processFills(11, 11.5, 9); // low 9 <= 10 -> 10 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(-2); // (10-12)*1
    expect(st.lossTrades).toBe(1);
  });

  it("short: profit= computes the limit target as posAvgPrice-profit — low touches it", () => {
    const st = shortAt12();
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2); // target 12-2=10
    st.processFills(11, 11.2, 9.5); // low 9.5 <= 10 -> 10 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2); // (10-12)*(-1)
  });

  it("short: loss= computes the stop target as posAvgPrice+loss — high touches it", () => {
    const st = shortAt12();
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2); // target 12+2=14
    st.processFills(13, 14.5, 12.5); // high 14.5 >= 14 -> 14 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(-2); // (14-12)*(-1)
  });

  it("combines profit=/loss= as OCA-style independent axes — whichever touches first fills", () => {
    const st = longAt12();
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, 3); // profit target 14, loss target 9
    st.processFills(13, 14, 12.5); // high 14 >= 14(profit) -> fills at profit target
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(2);
  });

  it("same-id re-registration (매 바 재호출 표준 패턴) updates the profit/loss targets", () => {
    const st = longAt12();
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2); // target 14
    st.processFills(13, 13.5, 12.8); // 미달, 이월
    expect(st.posSize).toBe(1);
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 5); // 재호출 — target 17로 갱신
    st.processFills(14, 15.5, 13.5); // high 15.5 < 17 — 여전히 미달(옛 target 14였다면 체결됐을 바)
    expect(st.posSize).toBe(1);
  });

  it("recomputes the profit target against a pyramiding-updated posAvgPrice (동적 재계산, 콜타임 스냅샷 아님)", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2 — 동일 방향 추가 진입 1회 허용
    st.entry("L", "long", 1);
    st.processFills(12); // 롱 1 @ 12
    st.exit("X", "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2); // 등록 시점 target 14 — 단 avg는 매 바 재조회
    st.entry("L2", "long", 1);
    st.processFills(13, 13.2, 12.8); // exit 미달(limit 14 미도달) 이월, entry 체결 -> avg=(12*1+13*1)/2=12.5
    expect(st.posAvgPrice).toBe(12.5);
    expect(st.posSize).toBe(2);
    st.processFills(14, 14.5, 13.8); // 새 target = 12.5+2 = 14.5, high 14.5 >= 14.5 -> 14.5 체결
    expect(st.posSize).toBe(0);
    expect(st.realizedPnl).toBe(4); // (14.5-12.5)*2
  });

  it("qty= partial exit combines with profit= — 부분 청산 후 잔여 포지션/avg 유지", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(12); // 롱 2 @ 12
    st.exit("X", "", undefined, undefined, 1, undefined, undefined, undefined, undefined, 2); // qty 1 부분, target 14
    st.processFills(13.5, 15, 13.2); // open 13.5 < 14 미달, high 15 >= 14 -> 14 체결 qty 1
    expect(st.posSize).toBe(1);
    expect(st.posAvgPrice).toBe(12);
    expect(st.realizedPnl).toBe(2); // (14-12)*1
    expect(st.exitPending).toBe(false);
  });
});

describe("strategy.exit profit=/loss= analyzer validation (hand-verified, DIVERGENCES #98)", () => {
  it("accepts profit= as the sole exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", profit=2)')).toEqual([]);
  });

  it("accepts loss= as the sole exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", loss=2)')).toEqual([]);
  });

  it("accepts profit= combined with loss=", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", profit=2, loss=3)')).toEqual([]);
  });

  it("accepts profit= combined with trail_points= (different axis, no conflict)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", profit=2, trail_points=1)')).toEqual([]);
  });

  // C723(배치37 지시 (1)): exitFillPrice()가 이미 limit/stop을 profit/loss보다 우선하는 NaN-폴백
  // 순서라(runtime/strategy.ts L1630-1638) 동시 지정도 상충이 아니라 단순 우선순위 — 하드 에러 제거.
  it("accepts profit= combined with limit= (limit이 우선, C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, profit=2)')).toEqual([]);
  });

  it("accepts loss= combined with stop= (stop이 우선, C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", stop=9, loss=2)')).toEqual([]);
  });

  it("rejects duplicate profit= kwarg", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", profit=2, profit=3)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'profit'"))).toBe(true);
  });
});

describe("strategy.exit profit=/loss= codegen emission (hand-verified, DIVERGENCES #98)", () => {
  it("lowers profit= to the 9th slot (past trail_price)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2)');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2);',
    );
  });

  it("lowers loss= to the 10th slot (past profit)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", loss=3)');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 3);',
    );
  });

  it("combines profit=/loss= (slots 9~10, no gap between them)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2, loss=3)');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, 3);',
    );
  });
});

describe("strategy.* E2E profit=/loss= (hand-verified: 익절/손절 포인트 목표 반복 체결)", () => {
  // 손 계산 시나리오 (profit=2, loss=3 — 매 바 재호출 표준 패턴):
  //   bar0: O=10 C=11 양봉&flat -> entry("L") 큐잉. (ps=0, np=0)
  //   bar1: O=12 -> 롱 1@12 체결(avg=12). exit("X", profit=2, loss=3) 등록(target=14/9). (ps=1, np=0)
  //   bar2: O=13 H=14 L=12.5 -> high 14>=14(profit) -> 14 체결(np=2). 같은 바 양봉(C=13.5>O=13)이라
  //         flat 감지 후 재진입 entry("L2") 큐잉. (ps=0, np=2)
  //   bar3: O=14.5 -> 롱 1@14.5 체결(avg=14.5). exit 재등록(target=16.5/11.5). (ps=1, np=2)
  //   bar4: O=15 H=15.5 L=14.5 -> 둘 다 미달, 이월. (ps=1, np=2)
  const data: OHLCVData = {
    open: [10, 12, 13, 14.5, 15],
    high: [12, 13, 14, 15, 15.5],
    low: [9, 11.5, 12.5, 13.8, 14.5],
    close: [11, 12.5, 13.5, 14.7, 15],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", profit=2, loss=3)',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("tracks position_size across repeated profit-target fills and re-entries", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 1, 0, 1, 1]);
  });

  it("realizes the profit-target exit at the computed price (avg+2=14)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 2, 2, 2]);
  });
});

describe("StrategyState percent_of_equity 자동 수량 (C171 아홉째 슬라이스, hand-verified)", () => {
  // pine2py에는 상수(constants.py PERCENT_OF_EQUITY)만 있고 StrategyConfig에 default_qty_type
  // 필드 자체가 없어 소비 로직이 전무하다(C171 소스 확인) — 자동 수량 산식(equity 체결가 기준)/
  // 체결 시점 해석/qty= 명시 우선/파산 가드 전부 TV 실측 미검증 가설(DIVERGENCES #74).
  it("configure 4th arg sets qtyIsPercent (omitted → false — 기존 2/3-인자 호출 호환)", () => {
    const st = new StrategyState();
    expect(st.qtyIsPercent).toBe(false);
    st.configure(50, 1, 1000, true);
    expect(st.qtyIsPercent).toBe(true);
    const st2 = new StrategyState();
    st2.configure(2, 3);
    expect(st2.qtyIsPercent).toBe(false);
    const st3 = new StrategyState();
    st3.configure(2, 3, 50000);
    expect(st3.qtyIsPercent).toBe(false);
  });

  it("entry with omitted qty fills percent-of-equity contracts (1000 * 50% / 10 = 50)", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.entry("L", "long");
    expect(st.posSize).toBe(0); // 콜타임에는 미체결(수량도 미해석)
    st.processFills(10);
    expect(st.posSize).toBe(50);
    expect(st.posAvgPrice).toBe(10);
  });

  it("default_qty_value defaults to 1 → 1% of equity when type is percent", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000, true);
    st.entry("L", "long");
    st.processFills(10);
    expect(st.posSize).toBe(1); // 1000 * 1% / 10
  });

  it("explicit qty= overrides percent mode with fixed contracts", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.entry("L", "long", 2);
    st.processFills(10);
    expect(st.posSize).toBe(2);
  });

  it("resolves qty at FILL time — realized profit before the fill grows the auto qty", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.entry("A", "long", 10);
    st.processFills(10); // 롱 10@10 (고정 수량)
    st.close("A");
    st.processFills(20); // 청산 @20 — profit=(20-10)*10=100, equity=1100
    expect(st.realizedPnl).toBe(100);
    st.entry("B", "long");
    st.processFills(11); // equity(11)=1100 → qty=1100*0.5/11=50
    expect(st.posSize).toBe(50);
    expect(st.posAvgPrice).toBe(11);
  });

  it("reverse entry resolves qty with equity including the just-realized profit", () => {
    const st = new StrategyState();
    st.configure(100, 1, 1000, true);
    st.entry("L", "long");
    st.processFills(10); // equity=1000 → 롱 100@10
    expect(st.posSize).toBe(100);
    st.entry("S", "short");
    st.processFills(12); // 리버스 — 청산 (12-10)*100=200 실현, equity(12)=1200 → 숏 100@12
    expect(st.realizedPnl).toBe(200);
    expect(st.posSize).toBe(-100); // 1200*100%/12 = 100
    expect(st.posAvgPrice).toBe(12);
  });

  it("pyramiding add-on resolves qty with equity including unrealized open profit", () => {
    const st = new StrategyState();
    st.configure(50, 2, 1000, true);
    st.entry("A", "long");
    st.processFills(10); // equity=1000 → 롱 50@10 (count=1)
    expect(st.posSize).toBe(50);
    st.entry("A", "long");
    st.processFills(20); // equity(20)=1000+(20-10)*50=1500 → 추가 37.5@20 (count=2)
    expect(st.posSize).toBe(87.5); // 50 + 1500*0.5/20
    expect(st.entryCount).toBe(2);
  });

  it("consumes (does not fill or carry) an auto-qty order when equity <= 0", () => {
    const st = new StrategyState();
    st.configure(100, 1, 1000, true);
    st.realizedPnl = -1000; // 파산 시나리오 주입 — equity(any)=0
    st.entry("L", "long");
    st.processFills(10);
    expect(st.posSize).toBe(0);
    expect(st.entryPending).toBe(false); // 마켓 소진 규칙과 동일 — 이월 없음
    st.processFills(5);
    expect(st.posSize).toBe(0);
  });

  it("limit entry carried over resolves auto qty at the fill bar, not the call bar", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.entry("L", "long", undefined, 10); // limit 10
    st.processFills(12, 13, 11); // low 11 > 10 — 미체결 이월
    expect(st.posSize).toBe(0);
    expect(st.entryPending).toBe(true);
    st.processFills(10.5, 11, 9.5); // low <= 10 → limit 10 체결: qty=1000*0.5/10=50
    expect(st.posSize).toBe(50);
    expect(st.posAvgPrice).toBe(10);
  });

  it("same-id re-entry switches between fixed and auto qty (마지막 호출 기준)", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.entry("L", "long", 5);
    st.entry("L", "long"); // 같은 id 수정 — qty 생략이라 auto로 전환
    st.processFills(10);
    expect(st.posSize).toBe(50); // 5가 아니라 1000*0.5/10
    const st2 = new StrategyState();
    st2.configure(50, 1, 1000, true);
    st2.entry("L", "long");
    st2.entry("L", "long", 5); // 반대 방향 전환 — auto → 고정 5
    st2.processFills(10);
    expect(st2.posSize).toBe(5);
  });

  it("order() with omitted qty fills percent-of-equity contracts", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.order("O", "long");
    st.processFills(10);
    expect(st.posSize).toBe(50);
  });

  it("order() opposite-direction auto qty nets against the position (상쇄 후 잔여 반전)", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true);
    st.order("A", "long", 10);
    st.processFills(10); // 롱 10@10 (고정)
    st.order("B", "short");
    st.processFills(10); // equity(10)=1000 → qty=50: 10 상쇄(profit 0) + 잔여 40 숏
    expect(st.posSize).toBe(-40);
    expect(st.posAvgPrice).toBe(10);
  });

  it("order() auto qty is consumed without fill when equity <= 0", () => {
    const st = new StrategyState();
    st.configure(100, 1, 1000, true);
    st.realizedPnl = -1000;
    st.order("O", "long");
    st.processFills(10);
    expect(st.posSize).toBe(0);
    expect(st.orderPending).toBe(false);
  });

  it("fixed type (qtyIsPercent=false) keeps defaultQty as plain contracts (기존 동작 불변)", () => {
    const st = new StrategyState();
    st.configure(5, 1, 1000, false);
    st.entry("L", "long");
    st.processFills(10);
    expect(st.posSize).toBe(5);
  });

  it("cash type (qtyIsCash=true): entry() with omitted qty fills cashAmount/fillPrice contracts (C330)", () => {
    const st = new StrategyState();
    st.configure(500, 1, 1000, false, true);
    st.entry("L", "long");
    st.processFills(10); // qty = 500/10 = 50 (equity 무관 — percent_of_equity와 대조)
    expect(st.posSize).toBe(50);
  });

  it("cash type: qty= explicit overrides the cash auto-sizing (유형 무관 계약 수 그대로)", () => {
    const st = new StrategyState();
    st.configure(500, 1, 1000, false, true);
    st.entry("L", "long", 7);
    st.processFills(10);
    expect(st.posSize).toBe(7);
  });

  it("cash type: order() with omitted qty fills cashAmount/fillPrice contracts", () => {
    const st = new StrategyState();
    st.configure(500, 1, 1000, false, true);
    st.order("O", "long");
    st.processFills(10);
    expect(st.posSize).toBe(50);
  });

  it("cash type: pyramiding add-on re-derives qty at the new fill price (equity 무관 — 매 체결 고정 500/가격)", () => {
    const st = new StrategyState();
    st.configure(500, 2, 1000, false, true);
    st.entry("L", "long");
    st.processFills(10); // qty=50, avg=10, posSize=50
    st.entry("L", "long");
    st.processFills(20); // qty=25, avg=(10*50+20*25)/75, posSize=75
    expect(st.posSize).toBe(75);
    expect(st.posAvgPrice).toBeCloseTo((10 * 50 + 20 * 25) / 75, 9);
  });

  it("cash type: non-positive cash amount is consumed without fill (긍정형 가드, C91)", () => {
    const st = new StrategyState();
    st.configure(-100, 1, 1000, false, true);
    st.entry("L", "long");
    st.processFills(10); // qty = -100/10 = -10 <= 0
    expect(st.posSize).toBe(0);
    expect(st.entryPending).toBe(false);
  });
});

describe("strategy() default_qty_type analyzer validation (C171)", () => {
  it("accepts default_qty_type=strategy.percent_of_equity", () => {
    expect(
      transpile('strategy("s", default_qty_type=strategy.percent_of_equity)').ok,
    ).toBe(true);
  });

  it("accepts default_qty_type=strategy.fixed (기존 동작 유지)", () => {
    expect(transpile('strategy("s", default_qty_type=strategy.fixed)').ok).toBe(true);
  });

  it("accepts the equivalent string literal form", () => {
    expect(transpile('strategy("s", default_qty_type="percent_of_equity")').ok).toBe(true);
  });

  it("accepts default_qty_type=strategy.cash (C330)", () => {
    expect(transpile('strategy("s", default_qty_type=strategy.cash)').ok).toBe(true);
  });

  it("rejects a number literal for default_qty_type (컴파일타임 상수 강제)", () => {
    expect(
      transpileErrors('strategy("s", default_qty_type=1)').some((e) =>
        e.includes("'default_qty_type' argument only supports strategy.fixed/strategy.percent_of_equity/strategy.cash constants"),
      ),
    ).toBe(true);
  });

  it("rejects a non-strategy DotAccess value for default_qty_type", () => {
    expect(
      transpileErrors('strategy("s", default_qty_type=syminfo.ticker)').some((e) =>
        e.includes("'default_qty_type' argument"),
      ),
    ).toBe(true);
  });

  it("folds strategy.percent_of_equity as a general string constant after the declaration", () => {
    expect(transpile('strategy("s")\nx = strategy.percent_of_equity').ok).toBe(true);
  });

  it("folds strategy.cash as a general string constant after the declaration", () => {
    expect(transpile('strategy("s")\nx = strategy.cash').ok).toBe(true);
  });

  it("folds the qty-type constants even without a strategy() declaration (C771)", () => {
    expect(transpile('indicator("i")\nx = strategy.percent_of_equity').ok).toBe(true);
  });
});

describe("strategy() default_qty_type codegen emission (C171)", () => {
  it("emits configure with a 4th arg (true) and fills the capital slot with its default", () => {
    const code = transpileCode('strategy("s", default_qty_type=strategy.percent_of_equity)');
    expect(code).toContain("$.strategy.configure(1, 1, 100000, true);");
  });

  it("emits all four slots when value/capital are also specified", () => {
    const code = transpileCode(
      'strategy("s", default_qty_value=50, default_qty_type=strategy.percent_of_equity, initial_capital=25000)',
    );
    expect(code).toContain("$.strategy.configure(50, 1, 25000, true);");
  });

  it("emits no configure at all for a lone strategy.fixed (C129 — 기본 동작과 동일)", () => {
    const code = transpileCode('strategy("s", default_qty_type=strategy.fixed)');
    expect(code).not.toContain("$.strategy.configure");
  });

  it("keeps the legacy 2-arg form when fixed is combined with default_qty_value", () => {
    const code = transpileCode('strategy("s", default_qty_value=2, default_qty_type=strategy.fixed)');
    expect(code).toContain("$.strategy.configure(2, 1);");
  });

  it("treats the string literal form identically to the constant", () => {
    const code = transpileCode('strategy("s", default_qty_type="percent_of_equity")');
    expect(code).toContain("$.strategy.configure(1, 1, 100000, true);");
  });
});

describe("strategy() default_qty_type=cash codegen emission (C330)", () => {
  it("emits configure with a 5th arg (true) and fills the percent(4th)/capital(3rd) slots", () => {
    const code = transpileCode('strategy("s", default_qty_type=strategy.cash)');
    expect(code).toContain("$.strategy.configure(1, 1, 100000, false, true);");
  });

  it("emits all five slots when value/capital are also specified", () => {
    const code = transpileCode(
      'strategy("s", default_qty_value=500, default_qty_type=strategy.cash, initial_capital=25000)',
    );
    expect(code).toContain("$.strategy.configure(500, 1, 25000, false, true);");
  });

  it("treats the string literal form identically to the constant", () => {
    const code = transpileCode('strategy("s", default_qty_type="cash")');
    expect(code).toContain("$.strategy.configure(1, 1, 100000, false, true);");
  });
});

describe("strategy.* E2E 아홉째 슬라이스 (hand-verified: percent_of_equity 복리 수량)", () => {
  // 손 계산 시나리오 (default_qty_value=50%, initial_capital=1000 — 두 번째 진입이 커진 equity 반영):
  //   bar0: O=10 C=11 양봉&flat → entry 큐잉. (ps=0, np=0)
  //   bar1: O=10 → 체결: equity(10)=1000 → qty=1000*50%/10=50. 롱 50@10. (ps=50, np=0)
  //   bar2: O=12 C=11 음봉&ps>0 → close 큐잉. (ps=50, np=0)
  //   bar3: O=14 → 청산 @14: profit=(14-10)*50=200. 양봉&flat → entry 큐잉. (ps=0, np=200)
  //   bar4: O=10 → 체결: equity(10)=1200 → qty=1200*50%/10=60. 롱 60@10. (ps=60, np=200)
  const data: OHLCVData = {
    open: [10, 10, 12, 14, 10],
    high: [12, 13, 13, 16, 11],
    low: [9, 9.5, 11, 13, 9.5],
    close: [11, 12, 11, 15, 10.5],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", default_qty_value=50, default_qty_type=strategy.percent_of_equity, initial_capital=1000)',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long)',
    "if close < open and strategy.position_size > 0",
    '    strategy.close("L")',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("sizes each entry as 50% of fill-time equity (50 → 60 after +200 profit)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 50, 50, 0, 60]);
  });

  it("realizes profit from the auto-sized position ((14-10)*50 = 200)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 200, 200]);
  });

  it("explicit qty= keeps fixed contracts under percent mode (같은 데이터, qty=3)", () => {
    const srcFixed = src.replace('strategy.entry("L", strategy.long)', 'strategy.entry("L", strategy.long, 3)');
    const result = runPipeline(srcFixed, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 3, 3, 0, 3]);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 12, 12]);
  });
});

describe("strategy.* E2E — default_qty_type=cash (hand-verified, C330)", () => {
  // 손 계산 시나리오 (default_qty_value=500, initial_capital=1000 — percent_of_equity와 동일
  // 데이터로 대조: cash는 equity 무관 고정 금액이라 두 진입 모두 500/체결가로 동일 계약 수).
  //   bar0: O=10 C=11 양봉&flat → entry 큐잉. (ps=0, np=0)
  //   bar1: O=10 → 체결: qty=500/10=50. 롱 50@10. (ps=50, np=0)
  //   bar2: O=12 C=11 음봉&ps>0 → close 큐잉. (ps=50, np=0)
  //   bar3: O=14 → 청산 @14: profit=(14-10)*50=200. 양봉&flat → entry 큐잉. (ps=0, np=200)
  //   bar4: O=10 → 체결: qty=500/10=50(equity 1200이어도 불변 — percent_of_equity의 60과 대조). (ps=50, np=200)
  const data: OHLCVData = {
    open: [10, 10, 12, 14, 10],
    high: [12, 13, 13, 16, 11],
    low: [9, 9.5, 11, 13, 9.5],
    close: [11, 12, 11, 15, 10.5],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", default_qty_value=500, default_qty_type=strategy.cash, initial_capital=1000)',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long)',
    "if close < open and strategy.position_size > 0",
    '    strategy.close("L")',
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  it("sizes each entry as cashAmount/fillPrice regardless of accumulated profit (50 → 50, not 60)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 50, 50, 0, 50]);
  });

  it("realizes profit from the cash-sized position ((14-10)*50 = 200)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 200, 200]);
  });

  it("explicit qty= keeps fixed contracts under cash mode (같은 데이터, qty=3)", () => {
    const srcFixed = src.replace('strategy.entry("L", strategy.long)', 'strategy.entry("L", strategy.long, 3)');
    const result = runPipeline(srcFixed, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual([0, 3, 3, 0, 3]);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual([0, 0, 0, 12, 12]);
  });
});

describe("StrategyState.updateDrawdown (C172 열째 슬라이스: max_drawdown, hand-verified)", () => {
  // pine2py에 drawdown 구현이 전무하다(grep 0건, C171/C172 확인) — 표준 온라인 max-drawdown
  // 알고리즘(peak 갱신 → peak-현재 격차의 누적 최대)을 hand-verified로만 검증한다(DIVERGENCES #75).
  it("seeds peakEquity from initialCapital on the first call (flat position)", () => {
    const st = new StrategyState();
    st.updateDrawdown(123); // 플랫 — closePrice는 openProfit에 영향 없음
    expect(st.peakEquity).toBe(100000);
    expect(st.maxDrawdown).toBe(0);
  });

  it("seeds from a custom initial_capital set via configure()", () => {
    const st = new StrategyState();
    st.configure(1, 1, 50000);
    st.updateDrawdown(999);
    expect(st.peakEquity).toBe(50000);
    expect(st.maxDrawdown).toBe(0);
  });

  it("stays at 0 while equity only rises (no peak-to-trough gap yet)", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.updateDrawdown(10); // eq=1000
    st.updateDrawdown(20); // eq=1000, 아직 포지션 없음 -> 여전히 1000
    expect(st.maxDrawdown).toBe(0);
    expect(st.peakEquity).toBe(1000);
  });

  it("tracks peak-to-trough via unrealized (open) equity, and does not reset on recovery", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.entry("L", "long", 10);
    st.processFills(10); // 롱 10 @ 10
    st.updateDrawdown(10); // eq=1000 (avg=close) -> peak=1000, dd=0
    expect(st.maxDrawdown).toBe(0);
    st.updateDrawdown(12); // eq=1000+(12-10)*10=1020 -> 새 peak, dd=0
    expect(st.peakEquity).toBe(1020);
    expect(st.maxDrawdown).toBe(0);
    st.updateDrawdown(8); // eq=1000+(8-10)*10=980 -> peak 유지 1020, dd=40
    expect(st.peakEquity).toBe(1020);
    expect(st.maxDrawdown).toBe(40);
    st.updateDrawdown(15); // eq=1050 -> 새 peak(회복), dd=0이지만 maxDrawdown은 40 그대로(리셋 안 됨)
    expect(st.peakEquity).toBe(1050);
    expect(st.maxDrawdown).toBe(40);
    st.updateDrawdown(5); // eq=1000+(5-10)*10=950 -> dd=1050-950=100 > 40 -> maxDrawdown 갱신
    expect(st.maxDrawdown).toBe(100);
  });

  it("counts a realized loss toward the drawdown just like an unrealized one", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.entry("L", "long", 10);
    st.processFills(10); // 롱 10 @ 10
    st.updateDrawdown(10); // eq=1000, peak=1000
    st.close("L");
    st.processFills(7); // 청산 (7-10)*10 = -30 실현
    st.updateDrawdown(999); // flat -> eq=1000-30=970
    expect(st.realizedPnl).toBe(-30);
    expect(st.maxDrawdown).toBe(30);
  });
});

describe("strategy.max_drawdown analyzer/codegen (C172 열째 슬라이스)", () => {
  it("accepts strategy.max_drawdown after a strategy() declaration", () => {
    expect(transpile('strategy("s")\nx = strategy.max_drawdown').ok).toBe(true);
  });

  it("accepts strategy.max_drawdown without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.max_drawdown").ok).toBe(true);
  });

  it("emits a plain accumulator read (netprofit/closedtrades와 동일한 패턴 — 메서드 호출 아님)", () => {
    const code = transpileCode('strategy("s")\nvar float a = na\na := strategy.max_drawdown');
    expect(code).toContain("($.strategy.maxDrawdown)");
  });
});

describe("strategy.* E2E 열째 슬라이스 (hand-verified: max_drawdown, close 기준 unrealized 반영)", () => {
  // 손 계산 시나리오 (initial_capital=1000, 고정 qty=10 롱 진입 후 보유만 — close/exit 없음):
  //   bar0: O=10 C=11 양봉&flat -> entry 큐잉. 체결 전이라 flat: eq=1000, dd=0.
  //   bar1: O=10 -> 체결(롱 10@10). C=8 -> eq=1000+(8-10)*10=980 (peak 1000 유지) -> dd=20.
  //   bar2: O=14 C=15 -> eq=1000+(15-10)*10=1050 -> 새 peak(1050), dd=0(이지만 maxDrawdown은 20 유지).
  //   bar3: O=6 C=5 -> eq=1000+(5-10)*10=950 -> dd=1050-950=100(>20) -> maxDrawdown=100.
  //   bar4: O=11 C=12 -> eq=1000+(12-10)*10=1020 -> dd=1050-1020=30(<100) -> maxDrawdown 유지 100.
  const data: OHLCVData = {
    open: [10, 10, 14, 6, 11],
    high: [11, 10.5, 15.5, 6.5, 12.5],
    low: [9, 7.5, 13.5, 4.5, 10.5],
    close: [11, 8, 15, 5, 12],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", initial_capital=1000)',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 10)',
    "var float __obs_eq = na",
    "__obs_eq := strategy.equity",
    "var float __obs_dd = na",
    "__obs_dd := strategy.max_drawdown",
  ].join("\n");

  it("tracks the running equity exactly as strategy.equity resolves it per bar", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_eq"])).toEqual([1000, 980, 1050, 950, 1020]);
  });

  it("accumulates the max peak-to-trough gap and never decreases on recovery", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_dd"])).toEqual([0, 20, 20, 100, 100]);
  });
});

describe("strategy.default_qty_value/netprofit_percent/openprofit_percent/eventrades analyzer/codegen (C331 신규, next_hint(C330) 재조사)", () => {
  const cases: Array<[string, string]> = [
    ["default_qty_value", "$.strategy.defaultQty"],
    ["netprofit_percent", "$.strategy.realizedPnl / $.strategy.initialCapital * 100"],
    ["openprofit_percent", "$.strategy.openProfit($.close.get(0)) / $.strategy.initialCapital * 100"],
    ["eventrades", "$.strategy.evenTrades"],
  ];

  it.each(cases)("accepts strategy.%s after a strategy() declaration", (attr) => {
    expect(transpile(`strategy("s")\nx = strategy.${attr}`).ok).toBe(true);
  });

  it.each(cases)("accepts strategy.%s without a strategy() declaration (C771)", (attr) => {
    expect(transpile(`x = strategy.${attr}`).ok).toBe(true);
  });

  it.each(cases)("emits the exact runtime expression for strategy.%s", (attr, expr) => {
    const code = transpileCode(`strategy("s")\nvar float a = na\na := strategy.${attr}`);
    expect(code).toContain(`(${expr})`);
  });

  it("default_qty_value stays the raw configured value regardless of qtyIsPercent/qtyIsCash mode", () => {
    const st = new StrategyState();
    st.configure(50, 1, 100000, true); // qtyIsPercent 모드 -- defaultQty=50은 %지 계약 수 아님
    expect(st.defaultQty).toBe(50);
  });

  it("evenTrades counts profit===0 closes without touching wintrades/losstrades (DIVERGENCES #68 (c) gap)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10); // 진입가 10
    st.close("L");
    st.processFills(10); // 청산가도 10 -- profit=(10-10)*1=정확히 0
    expect(st.evenTrades).toBe(1);
    expect(st.winTrades).toBe(0);
    expect(st.lossTrades).toBe(0);
    expect(st.closedTrades).toBe(1);
  });
});

describe("StrategyState.updateDrawdown — peakEquityAtMaxDrawdown snapshot (C333, next_hint(C332) 1순위)", () => {
  // max_drawdown_percent = maxDrawdown / peakEquityAtMaxDrawdown * 100 (통화 절대값을 "그 최댓값이
  // 갱신된 시점의" peak 대비 %로 정규화 — 라이브 peakEquity로 나누면 이후 신고점 갱신 시 과거
  // 최대낙폭의 퍼센트가 조용히 줄어들어 틀린다).
  it("seeds peakEquityAtMaxDrawdown from initialCapital on the first call, alongside peakEquity", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.updateDrawdown(999); // flat, maxDrawdown은 0 그대로
    expect(st.maxDrawdown).toBe(0);
    expect(st.peakEquityAtMaxDrawdown).toBe(1000);
  });

  it("does not move on a new peak (recovery) that doesn't beat the existing maxDrawdown", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.entry("L", "long", 10);
    st.processFills(10); // 롱 10 @ 10
    st.updateDrawdown(10); // eq=1000, peak=1000, dd=0
    st.updateDrawdown(8); // eq=980 -> dd=20 -> maxDrawdown=20, snapshot peakEquity=1000
    expect(st.maxDrawdown).toBe(20);
    expect(st.peakEquityAtMaxDrawdown).toBe(1000);
    st.updateDrawdown(15); // eq=1050 -> 새 peak(회복), dd=0 -> maxDrawdown 갱신 없음
    expect(st.peakEquity).toBe(1050);
    expect(st.maxDrawdown).toBe(20);
    expect(st.peakEquityAtMaxDrawdown).toBe(1000); // 새 peak가 갱신을 안 트리거했으니 스냅샷도 그대로
  });

  it("re-snapshots peakEquityAtMaxDrawdown to the new (higher) peak once maxDrawdown itself updates again", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.entry("L", "long", 10);
    st.processFills(10);
    st.updateDrawdown(10); // eq=1000, peak=1000
    st.updateDrawdown(8); // dd=20 -> maxDrawdown=20, snapshot=1000
    st.updateDrawdown(15); // eq=1050 -> 새 peak, dd=0 (maxDrawdown 갱신 없음)
    st.updateDrawdown(5); // eq=950 -> dd=1050-950=100 > 20 -> maxDrawdown=100, snapshot=1050(새 peak)
    expect(st.maxDrawdown).toBe(100);
    expect(st.peakEquityAtMaxDrawdown).toBe(1050);
  });
});

describe("strategy.max_drawdown_percent analyzer/codegen (C333, next_hint(C332) 1순위)", () => {
  it("accepts strategy.max_drawdown_percent after a strategy() declaration", () => {
    expect(transpile('strategy("s")\nx = strategy.max_drawdown_percent').ok).toBe(true);
  });

  it("accepts strategy.max_drawdown_percent without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.max_drawdown_percent").ok).toBe(true);
  });

  it("emits the exact runtime expression (maxDrawdown / peakEquityAtMaxDrawdown * 100)", () => {
    const code = transpileCode('strategy("s")\nvar float a = na\na := strategy.max_drawdown_percent');
    expect(code).toContain("($.strategy.maxDrawdown / $.strategy.peakEquityAtMaxDrawdown * 100)");
  });
});

describe("strategy.* E2E (hand-verified: max_drawdown_percent, C333 — max_drawdown(C172) 시나리오 재사용)", () => {
  // 손 계산 (max_drawdown E2E 시나리오와 동일 데이터, initial_capital=1000):
  //   bar0: flat, eq=1000, maxDrawdown=0(peakEquityAtMaxDrawdown 시드=1000) -> pct=0.
  //   bar1: eq=980, dd=20>0 -> maxDrawdown=20, snapshot=peakEquity(1000) -> pct=20/1000*100=2.
  //   bar2: eq=1050 -> 새 peak, dd=0(maxDrawdown 갱신 없음) -> snapshot 그대로 1000 -> pct=2(불변).
  //   bar3: eq=950 -> dd=1050-950=100>20 -> maxDrawdown=100, snapshot=peakEquity(1050) -> pct=100/1050*100.
  //   bar4: eq=1020 -> dd=30<100(갱신 없음) -> pct 그대로.
  const data: OHLCVData = {
    open: [10, 10, 14, 6, 11],
    high: [11, 10.5, 15.5, 6.5, 12.5],
    low: [9, 7.5, 13.5, 4.5, 10.5],
    close: [11, 8, 15, 5, 12],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", initial_capital=1000)',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 10)',
    "var float __obs_ddp = na",
    "__obs_ddp := strategy.max_drawdown_percent",
  ].join("\n");

  it("normalizes max_drawdown by the peak equity snapshotted when that max was set, not the live peak", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ddp"])).toEqual([0, 2, 2, (100 / 1050) * 100, (100 / 1050) * 100]);
  });
});

describe("strategy.max_contracts_held_all/long/short analyzer/codegen (C334, next_hint(C333) 1순위)", () => {
  const cases: Array<[string, string]> = [
    ["max_contracts_held_all", "$.strategy.maxContractsHeldAll"],
    ["max_contracts_held_long", "$.strategy.maxContractsHeldLong"],
    ["max_contracts_held_short", "$.strategy.maxContractsHeldShort"],
  ];

  it.each(cases)("accepts strategy.%s after a strategy() declaration", (attr) => {
    expect(transpile(`strategy("s")\nx = strategy.${attr}`).ok).toBe(true);
  });

  it.each(cases)("accepts strategy.%s without a strategy() declaration (C771)", (attr) => {
    expect(transpile(`x = strategy.${attr}`).ok).toBe(true);
  });

  it.each(cases)("emits the exact runtime expression for strategy.%s", (attr, expr) => {
    const code = transpileCode(`strategy("s")\nvar float a = na\na := strategy.${attr}`);
    expect(code).toContain(`(${expr})`);
  });
});

describe("StrategyState.updateMaxContractsHeld — running max ratchet (C334, next_hint(C333) 1순위)", () => {
  // pine2py에 대응 구현이 전무해(grep 0건) hand-verified 설계: 지금까지 보유했던 |posSize|의 러닝
  // 최댓값(all=방향 무관, long/short=그 방향으로 보유했을 때만) — updateDrawdown과 동일하게 축소되지
  // 않는 단조 래칫이라 부분청산/리버스로 posSize가 줄어들어도 과거 피크는 유지돼야 한다.
  it("stays 0/0/0 while flat", () => {
    const st = new StrategyState();
    st.updateMaxContractsHeld();
    expect(st.maxContractsHeldAll).toBe(0);
    expect(st.maxContractsHeldLong).toBe(0);
    expect(st.maxContractsHeldShort).toBe(0);
  });

  it("ratchets all/long together on a long fill, leaving short at 0", () => {
    const st = new StrategyState();
    st.configure(1, 1);
    st.entry("L", "long", 5);
    st.processFills(10);
    st.updateMaxContractsHeld();
    expect(st.maxContractsHeldAll).toBe(5);
    expect(st.maxContractsHeldLong).toBe(5);
    expect(st.maxContractsHeldShort).toBe(0);
  });

  it("ratchets all/short together on a short fill, leaving long at 0", () => {
    const st = new StrategyState();
    st.configure(1, 1);
    st.entry("S", "short", 3);
    st.processFills(10);
    st.updateMaxContractsHeld();
    expect(st.maxContractsHeldAll).toBe(3);
    expect(st.maxContractsHeldShort).toBe(3);
    expect(st.maxContractsHeldLong).toBe(0);
  });

  it("tracks the pyramiding peak and retains it through a later partial close (never shrinks)", () => {
    const st = new StrategyState();
    st.configure(1, 2);
    st.entry("A", "long", 2);
    st.processFills(10); // posSize=2
    st.updateMaxContractsHeld();
    st.entry("B", "long", 3);
    st.processFills(11); // pyramiding 추가 -> posSize=5
    st.updateMaxContractsHeld();
    expect(st.maxContractsHeldAll).toBe(5);
    expect(st.maxContractsHeldLong).toBe(5);
    st.close("A", 4); // 부분 청산
    st.processFills(12); // posSize=1
    st.updateMaxContractsHeld();
    expect(st.posSize).toBe(1);
    expect(st.maxContractsHeldAll).toBe(5); // 축소돼도 과거 피크 유지
    expect(st.maxContractsHeldLong).toBe(5);
  });

  it("keeps the long peak intact after a reversal to short, and separately tracks the new short peak", () => {
    const st = new StrategyState();
    st.configure(1, 1);
    st.entry("L", "long", 5);
    st.processFills(10);
    st.updateMaxContractsHeld();
    st.entry("S", "short", 2);
    st.processFills(12); // 리버스: 청산 후 숏 2 진입
    st.updateMaxContractsHeld();
    expect(st.posSize).toBe(-2);
    expect(st.maxContractsHeldLong).toBe(5); // 그대로 유지
    expect(st.maxContractsHeldShort).toBe(2);
    expect(st.maxContractsHeldAll).toBe(5); // 롱 피크(5) > 숏 피크(2)라 all은 그대로
  });
});

describe("strategy.* E2E (hand-verified: max_contracts_held_all/long/short, C334)", () => {
  // 손 계산 시나리오 (바 6개, pyramiding=2, n 카운터로 결정적 제어):
  //   bar0(n=1): entry("A", long, 2) 큐잉. ps=0(아직 미체결).
  //   bar1(n=2): open 12에 A 체결 -> ps=2(피라미딩 1회). entry("B", long, 3) 큐잉.
  //   bar2(n=3): open 14에 B 추가 체결(피라미딩 2회) -> ps=2+3=5. close("A", qty=4) 큐잉.
  //   bar3(n=4): open 16에 부분 청산 4 -> ps=5-4=1(과거 피크 5는 유지돼야 함). entry("C", short, 6) 큐잉.
  //   bar4(n=5): open 18에 반대방향 entry -> 리버스(청산 후 숏 6 진입) -> ps=-6.
  //   bar5(n=6): 신규 주문 없음 -> ps=-6 그대로.
  // 기대: all=[0,2,5,5,6,6], long=[0,2,5,5,5,5], short=[0,0,0,0,6,6].
  const data: OHLCVData = {
    open: [10, 12, 14, 16, 18, 20],
    high: [12, 14, 16, 18, 20, 22],
    low: [9, 11, 13, 15, 17, 19],
    close: [11, 13, 15, 17, 19, 21],
    volume: [100, 100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", pyramiding=2)',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("A", strategy.long, 2)',
    "if n == 2",
    '    strategy.entry("B", strategy.long, 3)',
    "if n == 3",
    '    strategy.close("A", qty=4)',
    "if n == 4",
    '    strategy.entry("C", strategy.short, 6)',
    "var float __obs_all = na",
    "__obs_all := strategy.max_contracts_held_all",
    "var float __obs_long = na",
    "__obs_long := strategy.max_contracts_held_long",
    "var float __obs_short = na",
    "__obs_short := strategy.max_contracts_held_short",
  ].join("\n");

  it("tracks all/long/short running peaks across pyramiding, partial close, and reversal", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_all"])).toEqual([0, 2, 5, 5, 6, 6]);
    expect(result.bars.map((b) => b["var:__obs_long"])).toEqual([0, 2, 5, 5, 5, 5]);
    expect(result.bars.map((b) => b["var:__obs_short"])).toEqual([0, 0, 0, 0, 6, 6]);
  });
});

// strategy.<prop>[N] 히스토리 인덱싱(C339, wild "히스토리 인덱스는 식별자에만 지원" 클러스터
// 서브그룹 67건 — position_size 46/opentrades 10/netprofit 6/losstrades 3/closedtrades 2 최다).
// top-level var와 동일한 $.histSlots[]/record()/get() 메커니즘을 슬롯 키만 varSlot(number) 대신
// propName(string)으로 바꿔 재사용(index-access.ts analyzeIndexAccess 주석 참조) — GOAL.md
// Float64Array 히스토리 슬롯 설계와 충돌 없음('=' 로컬/UDF var 히스토리(ROADMAP 4순위, 사람 판단
// 보류)와 달리 STRATEGY_RUNTIME_PROPS는 항상 top-level 스코프의 고정 스칼라 JS 식).
describe("strategy.<prop>[N] historical indexing analyzer/codegen (C339)", () => {
  const wildProps = ["position_size", "opentrades", "netprofit", "losstrades", "closedtrades"];

  it.each(wildProps)("accepts strategy.%s[1] after a strategy() declaration", (attr) => {
    expect(transpile(`strategy("s")\nx = strategy.${attr}[1]`).ok).toBe(true);
  });

  it.each(wildProps)("accepts strategy.%s[1] without a strategy() declaration (C771)", (attr) => {
    expect(transpile(`x = strategy.${attr}[1]`).ok).toBe(true);
  });

  it("offset===0 codegens identically to the unindexed property (no history slot)", () => {
    const indexed = transpileCode('strategy("s")\nvar float a = na\na := strategy.position_size[0]');
    const bare = transpileCode('strategy("s")\nvar float a = na\na := strategy.position_size');
    expect(indexed).toBe(bare);
    expect(indexed).not.toContain("histSlots");
  });

  it("offset>=1 reads $.histSlots[N].get(offset) and records the raw runtime expression once per bar", () => {
    const code = transpileCode('strategy("s")\nvar float a = na\na := strategy.position_size[1]');
    expect(code).toContain("$.histSlots[0].get(1)");
    expect(code).toContain("$.histSlots[0].record($.strategy.posSize);");
  });

  it("two different literal offsets on the same prop share a single history slot (one record line, two get() reads)", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\nvar float b = na\na := strategy.position_size[1]\nb := strategy.position_size[2]',
    );
    expect(code).toContain("$.histSlots[0].get(1)");
    expect(code).toContain("$.histSlots[0].get(2)");
    // record() 호출은 슬롯당 정확히 1회만(바 끝 지점) — 두 번째 grep 매치가 없어야 함.
    expect(code.match(/\$\.histSlots\[0\]\.record\(/g)?.length).toBe(1);
  });

  it("no longer rejects a TA call result index (ta.highest(...)[1]) — CallExpr obj의 unconditional top-level 서브셋은 C340부터 지원(codegen.test.ts 'ta.<fn>(...)[N] historical indexing' 참조)", () => {
    expect(transpile('indicator("t")\nplot(ta.highest(high, 5)[1])').ok).toBe(true);
  });
});

describe("strategy.position_size[1]/opentrades[1] E2E (hand-verified, C339 — max_contracts_held(C334) 시나리오 재사용)", () => {
  // 손 계산 시나리오: bar_index==2에 롱 진입(2 계약), bar_index==5에 close.
  //   진입은 다음 바(3) open에 체결 -> posSize: bar0~2=0, bar3~5=2(다음 바 open 체결 반영은 바 3부터),
  //   close는 다음 바(6) open에 체결 -> posSize: bar6~9=0.
  // strategy.position_size[1]/opentrades[1]은 "이 바가 시작되기 전, 즉 직전 바가 끝난 시점"의 값을
  // 읽어야 하므로 위 posSize 시퀀스에서 한 바씩 밀려 관측된다(bar0은 히스토리가 없어 NaN).
  const n = 10;
  const data: OHLCVData = {
    open: new Array(n).fill(1),
    high: new Array(n).fill(1),
    low: new Array(n).fill(1),
    close: new Array(n).fill(1),
    volume: new Array(n).fill(1),
  };
  const src = [
    'strategy("s")',
    "if bar_index == 2",
    '    strategy.entry("L", strategy.long, 2)',
    "if bar_index == 5",
    '    strategy.close("L")',
    "var float __obs_ps1 = na",
    "__obs_ps1 := strategy.position_size[1]",
    "var float __obs_ot1 = na",
    "__obs_ot1 := strategy.opentrades[1]",
  ].join("\n");

  it("reads the previous bar's final position_size/opentrades, one bar behind the live values", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps1"])).toEqual([NaN, 0, 0, 0, 2, 2, 2, 0, 0, 0]);
    expect(result.bars.map((b) => b["var:__obs_ot1"])).toEqual([NaN, 0, 0, 0, 1, 1, 1, 0, 0, 0]);
  });
});

describe("strategy.account_currency analyzer/codegen (C332, next_hint(C331) 1순위)", () => {
  it("accepts strategy.account_currency after a strategy() declaration", () => {
    expect(transpile('strategy("s")\nx = strategy.account_currency').ok).toBe(true);
  });

  it("accepts strategy.account_currency without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.account_currency").ok).toBe(true);
  });

  it('defaults to "USD" (syminfo.currency의 고정 환경값과 동일, currency= 미지정 시)', () => {
    const code = transpileCode('strategy("s")\nvar string a = na\na := strategy.account_currency');
    expect(code).toContain('$.vars[0] = "USD";');
  });

  it("captures a currency.* DotAccess constant from strategy()'s currency= kwarg", () => {
    const code = transpileCode(
      'strategy("s", currency=currency.EUR)\nvar string a = na\na := strategy.account_currency',
    );
    expect(code).toContain('$.vars[0] = "EUR";');
  });

  it("captures a plain string literal from strategy()'s currency= kwarg", () => {
    const code = transpileCode('strategy("s", currency="EUR")\nvar string a = na\na := strategy.account_currency');
    expect(code).toContain('$.vars[0] = "EUR";');
  });

  it("folds currency.NONE to an empty string (CURRENCY_CONSTANTS 기존 매핑 재사용)", () => {
    const code = transpileCode(
      'strategy("s", currency=currency.NONE)\nvar string a = na\na := strategy.account_currency',
    );
    expect(code).toContain('$.vars[0] = "";');
  });

  it("silently discards a non-literal currency= argument and keeps the \"USD\" default (wild 46e92d206cfa.pine `currency = base_currency` 회귀 방지 — default_qty_value와 달리 하드 에러 아님, P&L 미관여 표시값)", () => {
    const result = transpile('base_currency = "EUR"\nstrategy("s", currency=base_currency)\nx = strategy.account_currency');
    expect(result.ok).toBe(true);
    const code = transpileCode(
      'base_currency = "EUR"\nstrategy("s", currency=base_currency)\nvar string a = na\na := strategy.account_currency',
    );
    expect(code).toContain('$.vars[0] = "USD";');
  });
});

describe("strategy.* E2E 신규(C331: netprofit_percent/openprofit_percent, hand-verified)", () => {
  // 손 계산 시나리오 (initial_capital=1000, 고정 qty=10 롱, bar0 진입 큐잉 -> bar1 체결 -> bar1
  // close() 큐잉 -> bar2 체결):
  //   bar0: entry 큐잉(체결 전) -> flat: realizedPnl=0, npp=0, openProfit=0, opp=0.
  //   bar1: O=10 체결(롱 10@10). close() 큐잉(체결 전). C=12 -> openProfit=(12-10)*10=20 ->
  //         opp=20/1000*100=2. realizedPnl 아직 0 -> npp=0.
  //   bar2: O=12 close 체결 -> profit=(12-10)*10=20 -> realizedPnl=20 -> npp=20/1000*100=2.
  //         posSize=0 -> openProfit=0 -> opp=0.
  const data: OHLCVData = {
    open: [10, 10, 12],
    high: [10.5, 12.5, 12.5],
    low: [9.5, 9.5, 11.5],
    close: [10, 12, 12],
    volume: [100, 100, 100],
  };
  const src = [
    'strategy("s", initial_capital=1000)',
    "if bar_index == 0",
    '    strategy.entry("L", strategy.long, 10)',
    "if bar_index == 1",
    '    strategy.close("L")',
    "var float __obs_npp = na",
    "__obs_npp := strategy.netprofit_percent",
    "var float __obs_opp = na",
    "__obs_opp := strategy.openprofit_percent",
  ].join("\n");

  it("netprofit_percent stays 0 until the trade actually closes, then reflects realized P&L / initial_capital", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_npp"])).toEqual([0, 0, 2]);
  });

  it("openprofit_percent tracks unrealized P&L while open and drops to 0 once flat", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_opp"])).toEqual([0, 2, 0]);
  });
});

describe("StrategyState 트레이드 comment 실소비 (C173 열한째 슬라이스, hand-verified)", () => {
  it("captures entry comment onto the position at fill time", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, undefined, "open1");
    expect(st.entryComment).toBe(""); // 체결 전 — pending 슬롯에만 있음
    st.processFills(10);
    expect(st.entryComment).toBe("open1");
  });

  it("defaults comment to empty string when omitted", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    expect(st.entryComment).toBe("");
  });

  it("preserves the first entry's comment through pyramiding add-ons (entryId와 동일 관례)", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2
    st.entry("A", "long", 1, undefined, undefined, "first");
    st.processFills(10);
    st.entry("B", "long", 1, undefined, undefined, "second");
    st.processFills(11); // 같은 방향 추가 진입 — entryComment는 "first" 유지
    expect(st.entryComment).toBe("first");
  });

  it("clears entryComment back to empty on a full close", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, undefined, "open1");
    st.processFills(10);
    st.close("L");
    st.processFills(11);
    expect(st.entryComment).toBe("");
  });

  it("close(comment=) becomes the closed trade's exit comment", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, undefined, "open1");
    st.processFills(10);
    st.close("L", undefined, "shut1");
    st.processFills(11);
    expect(st.closedTradeEntryComment(0)).toBe("open1");
    expect(st.closedTradeExitComment(0)).toBe("shut1");
  });

  it("close_all(comment=) becomes the closed trade's exit comment", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, undefined, "open1");
    st.processFills(10);
    st.close_all("bye");
    st.processFills(11);
    expect(st.closedTradeExitComment(0)).toBe("bye");
  });

  it("exit(comment=) bracket fill becomes the closed trade's exit comment", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, undefined, "open1");
    st.processFills(10);
    st.exit("X", null, 999, undefined, undefined, undefined, undefined, "tp");
    st.processFills(11, 1000, 11); // high가 limit 도달 -> 체결
    expect(st.closedTradeExitComment(0)).toBe("tp");
  });

  it("reversal close uses the triggering (new) entry's own comment, not the old entry's", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1, undefined, undefined, "long-open");
    st.processFills(10); // 롱 1 @ 10
    st.entry("B", "short", 1, undefined, undefined, "flip-to-short");
    st.processFills(12); // 리버스: 롱 청산(exit_comment는 "flip-to-short") 후 숏 1 진입
    expect(st.closedTradeEntryComment(0)).toBe("long-open");
    expect(st.closedTradeExitComment(0)).toBe("flip-to-short");
    expect(st.entryComment).toBe("flip-to-short"); // 새 숏 포지션의 entryComment
  });

  it("order() netting reduce uses the triggering order's own comment as exit comment", () => {
    const st = new StrategyState();
    st.order("A", "long", 2, undefined, undefined, "net-open");
    st.processFills(10); // 롱 2 @ 10
    st.order("B", "short", 1, undefined, undefined, "net-reduce");
    st.processFills(12); // 부분 상쇄 1 -> closedtrades 1건
    expect(st.closedTradeEntryComment(0)).toBe("net-open");
    expect(st.closedTradeExitComment(0)).toBe("net-reduce");
    expect(st.posSize).toBe(1); // 잔여 포지션은 그대로 열려 있음
  });

  it("throws for any closed-trade index other than the most recent (트레이드 히스토리 미보유)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1, undefined, undefined, "open1");
    st.processFills(10);
    st.close("L", undefined, "shut1");
    st.processFills(11); // closedTrades=1, 유효 index=0
    expect(() => st.closedTradeEntryComment(1)).toThrow(/index 1 is out of range/);
    expect(() => st.closedTradeExitComment(-1)).toThrow(/index -1 is out of range/);
  });

  it("returns empty string before any trade has closed (closedTrades=0 경계)", () => {
    const st = new StrategyState();
    expect(st.closedTradeEntryComment(-1)).toBe("");
    expect(st.closedTradeExitComment(-1)).toBe("");
  });
});

describe("strategy.closedtrades.entry_comment/exit_comment analyzer validation (C173)", () => {
  it("accepts after a strategy() declaration with exactly one arg", () => {
    expect(
      transpile('strategy("s")\nx = strategy.closedtrades.entry_comment(strategy.closedtrades - 1)').ok,
    ).toBe(true);
    expect(
      transpile('strategy("s")\nx = strategy.closedtrades.exit_comment(strategy.closedtrades - 1)').ok,
    ).toBe(true);
  });

  it("accepts without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.closedtrades.entry_comment(0)").ok).toBe(true);
  });

  it("rejects wrong arg count", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.closedtrades.entry_comment()');
    expect(errors.some((e) => e.includes("requires 1 (trade index)"))).toBe(true);
  });

  it("rejects kwargs (no keyword params supported)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.closedtrades.entry_comment(index=0)');
    expect(errors.some((e) => e.includes("keyword argument"))).toBe(true);
  });
});

describe("strategy.closedtrades.entry_comment/exit_comment codegen emission (C173)", () => {
  it("emits $.strategy.closedTradeEntryComment/closedTradeExitComment (flat method names)", () => {
    const code = transpileCode(
      'strategy("s")\nvar string a = na\na := strategy.closedtrades.entry_comment(0)\nvar string b = na\nb := strategy.closedtrades.exit_comment(0)',
    );
    expect(code).toContain("$.strategy.closedTradeEntryComment(0)");
    expect(code).toContain("$.strategy.closedTradeExitComment(0)");
  });
});

describe("strategy.* E2E 열한째 슬라이스 (hand-verified: entry/close comment= 실소비 + closedtrades.entry_comment/exit_comment)", () => {
  // 손 계산 시나리오(마켓 entry/close, 다음 바 open 체결):
  //   bar0(n=1): entry("L", comment="open1") 큐잉. closedtrades=0 -> ec/xc = ""/""
  //   bar1(n=2): open 12 체결(롱 1@12). closedtrades=0 -> ec/xc = ""/""
  //   bar2(n=3): close("L", comment="shut1") 큐잉. closedtrades=0 -> ec/xc = ""/""
  //   bar3(n=4): open 15 청산 체결 -> closedtrades=1, ec="open1"/xc="shut1"
  //   bar4(n=5): flat 유지 -> ec/xc 그대로("open1"/"shut1")
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L", strategy.long, 1, comment="open1")',
    "if n == 3",
    '    strategy.close("L", comment="shut1")',
    "var string __obs_ec = na",
    "__obs_ec := strategy.closedtrades.entry_comment(strategy.closedtrades - 1)",
    "var string __obs_xc = na",
    "__obs_xc := strategy.closedtrades.exit_comment(strategy.closedtrades - 1)",
  ].join("\n");

  it("tracks entry_comment per bar (트레이드 청산 전에는 빈 문자열)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ec"])).toEqual(["", "", "", "open1", "open1"]);
  });

  it("tracks exit_comment per bar (close(comment=)가 청산 시점에 반영)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_xc"])).toEqual(["", "", "", "shut1", "shut1"]);
  });
});

describe("strategy.* E2E (hand-verified: strategy.close 2번째 위치 인자(comment)도 comment= kwarg와 동형, C345)", () => {
  // 위 열한째 슬라이스 시나리오와 동일한 손 계산이되 close(comment=)가 아니라 위치 2번째 인자로
  // comment를 전달 — codegen 슬롯 재배치(qty 슬롯 건너뛰기)가 실제 실행에서도 정합하는지 확인.
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L", strategy.long, 1)',
    "if n == 3",
    '    strategy.close("L", "shut1")',
    "var string __obs_xc = na",
    "__obs_xc := strategy.closedtrades.exit_comment(strategy.closedtrades - 1)",
  ].join("\n");

  it("tracks exit_comment per bar (close(id, comment) 위치 인자 폼이 청산 시점에 반영)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_xc"])).toEqual(["", "", "", "shut1", "shut1"]);
  });
});

describe("StrategyState 트레이드 접근자 확장 (C308, hand-verified — entry_price/exit_price/entry_bar_index/exit_bar_index/entry_id/exit_id/profit/size)", () => {
  it("captures entry_bar_index at fill time and holds it through the position", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 5);
    expect(st.entryBarIndexOpen).toBe(5);
  });

  it("preserves the first entry's bar_index through pyramiding add-ons (entryId/entryComment와 동일 관례)", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 5);
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 6); // 같은 방향 추가 진입 — entryBarIndexOpen은 5 유지
    expect(st.entryBarIndexOpen).toBe(5);
  });

  it("snapshots entry_price/exit_price/entry_bar_index/exit_bar_index/entry_id/exit_id/profit/size on a full close", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 2);
    st.processFills(10, undefined, undefined, 3); // 롱 2 @ 10, bar 3
    st.close("L1");
    st.processFills(15, undefined, undefined, 7); // 청산 @ 15, bar 7
    expect(st.closedTradeEntryPrice(0)).toBe(10);
    expect(st.closedTradeExitPrice(0)).toBe(15);
    expect(st.closedTradeEntryBarIndex(0)).toBe(3);
    expect(st.closedTradeExitBarIndex(0)).toBe(7);
    expect(st.closedTradeEntryId(0)).toBe("L1");
    expect(st.closedTradeExitId(0)).toBe("L1"); // close()의 id
    expect(st.closedTradeProfit(0)).toBe(10); // (15-10)*2
    expect(st.closedTradeSize(0)).toBe(2); // 롱 — 양수
  });

  it("size/profit are signed for a closed short trade (음수 방향)", () => {
    const st = new StrategyState();
    st.entry("S1", "short", 3);
    st.processFills(20, undefined, undefined, 1);
    st.close("S1");
    st.processFills(18, undefined, undefined, 2); // 숏 청산 이익: (20-18)*3=6
    expect(st.closedTradeSize(0)).toBe(-3);
    expect(st.closedTradeProfit(0)).toBe(6);
  });

  it("exit bracket fill's own order id becomes the closed trade's exit_id", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.exit("X1", null, 999);
    st.processFills(11, 1000, 11, 4); // limit 도달(low<=999) -> 체결
    expect(st.closedTradeExitId(0)).toBe("X1");
  });

  it("reversal close's exit_id is the triggering (new) entry's own id, not the old entry's", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.entry("B", "short", 1);
    st.processFills(12, undefined, undefined, 1); // 리버스: 롱 청산 후 숏 1 진입
    expect(st.closedTradeEntryId(0)).toBe("A");
    expect(st.closedTradeExitId(0)).toBe("B");
  });

  it("order() netting reduce's exit_id is the triggering order's own id", () => {
    const st = new StrategyState();
    st.order("A", "long", 2);
    st.processFills(10, undefined, undefined, 0);
    st.order("B", "short", 1);
    st.processFills(12, undefined, undefined, 1); // 부분 상쇄 1 -> closedtrades 1건
    expect(st.closedTradeEntryId(0)).toBe("A");
    expect(st.closedTradeExitId(0)).toBe("B");
  });

  it("throws for any closed-trade index other than the most recent (트레이드 히스토리 미보유)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.close("L");
    st.processFills(11, undefined, undefined, 1); // closedTrades=1, 유효 index=0
    expect(() => st.closedTradeEntryPrice(1)).toThrow(/index 1 is out of range/);
    expect(() => st.closedTradeProfit(-1)).toThrow(/index -1 is out of range/);
  });

  it("returns na-ish defaults before any trade has closed (closedTrades=0 경계, entry_comment와 동일 관례)", () => {
    const st = new StrategyState();
    expect(Number.isNaN(st.closedTradeEntryPrice(-1))).toBe(true);
    expect(st.closedTradeEntryId(-1)).toBe("");
  });
});

describe("StrategyState.opentrades 접근자 (C308, hand-verified — 단일 가상 트레이드 index=0, 피라미딩도 이 모델로 압축)", () => {
  it("returns na (not a throw) when flat, regardless of index (C578 — eager and/or 관용구가 flat에서도 매 바 호출)", () => {
    const st = new StrategyState();
    expect(Number.isNaN(st.openTradeEntryPrice(0))).toBe(true);
    expect(Number.isNaN(st.openTradeEntryPrice(1))).toBe(true);
    expect(Number.isNaN(st.openTradeEntryPrice(-1))).toBe(true);
  });

  it("returns live entry_price/entry_bar_index/entry_id/size for the open position", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 3);
    st.processFills(10, undefined, undefined, 4);
    expect(st.openTradeEntryPrice(0)).toBe(10);
    expect(st.openTradeEntryBarIndex(0)).toBe(4);
    expect(st.openTradeEntryId(0)).toBe("L1");
    expect(st.openTradeSize(0)).toBe(3);
  });

  it("size is negative while short", () => {
    const st = new StrategyState();
    st.entry("S1", "short", 2);
    st.processFills(20, undefined, undefined, 0);
    expect(st.openTradeSize(0)).toBe(-2);
  });

  it("entry_price reflects the pyramided weighted-average, entry_bar_index keeps the first fill's bar", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.entry("B", "long", 1);
    st.processFills(20, undefined, undefined, 1);
    expect(st.openTradeEntryPrice(0)).toBe(15); // (10*1+20*1)/2
    expect(st.openTradeEntryBarIndex(0)).toBe(0); // 최초 진입 bar 유지(entryId/entryComment와 동일 lifecycle)
  });

  it("throws for any open-trade index other than 0", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    expect(() => st.openTradeEntryPrice(1)).toThrow(/index 1 is out of range/);
  });

  it("entry_bar_index/entry_id/size/commission all return na (not a throw) when flat (C578)", () => {
    const st = new StrategyState();
    expect(Number.isNaN(st.openTradeEntryBarIndex(0))).toBe(true);
    expect(st.openTradeEntryId(0)).toBe("");
    expect(Number.isNaN(st.openTradeSize(0))).toBe(true);
    expect(Number.isNaN(st.openTradeCommission(0))).toBe(true);
  });

  it("hand-verified E2E: `strategy.opentrades > 0 and strategy.opentrades.entry_bar_index(0) >= n` no longer crashes on bar 0 while flat (C578, wild 091dac8696a1.pine/0dd0fffbcfe8.pine pattern — TV eager `and` evaluates the right operand even while flat)", () => {
    const data: OHLCVData = {
      open: [10, 10, 10, 10, 10],
      high: [11, 11, 11, 11, 11],
      low: [9, 9, 9, 9, 9],
      close: [9.5, 9.5, 9.5, 9.5, 9.5], // 음봉 고정 -> entry 신호 없음, opentrades는 항상 0
      volume: [100, 100, 100, 100, 100],
    };
    const src = [
      'strategy("s")',
      "maxBars = 5",
      "closeFlag = strategy.opentrades > 0 and bar_index - strategy.opentrades.entry_bar_index(0) >= maxBars",
      "if closeFlag",
      '    strategy.close("L")',
      "var float __obs_flag = na",
      "__obs_flag := closeFlag ? 1.0 : 0.0",
    ].join("\n");
    const result = runPipeline(src, data);
    const flags = result.bars.map((b) => b["var:__obs_flag"]);
    expect(flags).toEqual([0, 0, 0, 0, 0]); // 크래시 없이 전 바 flat -> false
  });
});

describe("StrategyState.closedtrades/opentrades.max_drawdown/max_runup/profit_percent + opentrades.profit (C312, hand-verified)", () => {
  it("closedTradeProfitPercent matches pine2py Trade.profit_percent for a long win", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 2);
    st.processFills(10, undefined, undefined, 0); // avg=10
    st.close("L1");
    st.processFills(15, undefined, undefined, 1); // exit=15
    expect(st.closedTradeProfitPercent(0)).toBeCloseTo(50); // (15-10)/10*100
  });

  it("closedTradeProfitPercent matches pine2py Trade.profit_percent for a short win (부호 반전)", () => {
    const st = new StrategyState();
    st.entry("S1", "short", 3);
    st.processFills(20, undefined, undefined, 0);
    st.close("S1");
    st.processFills(18, undefined, undefined, 1); // 숏 이익: (20-18)/20*100
    expect(st.closedTradeProfitPercent(0)).toBeCloseTo(10);
  });

  it("closedTradeProfitPercent returns 0 when entry_price is 0 (division-by-zero 가드)", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 1);
    st.processFills(0, undefined, undefined, 0); // avg=0
    st.close("L1");
    st.processFills(5, undefined, undefined, 1);
    expect(st.closedTradeProfitPercent(0)).toBe(0);
  });

  it("openTradeProfit(closePrice)/openTradeProfitPercent match openProfit and its percent form while a position is live", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 2);
    st.processFills(10, undefined, undefined, 0); // avg=10
    expect(st.openTradeProfit(13, 0)).toBe(st.openProfit(13)); // (13-10)*2=6
    expect(st.openTradeProfitPercent(13, 0)).toBeCloseTo(30); // (13-10)/10*100
  });

  it("openTradeProfitPercent flips sign for a short position", () => {
    const st = new StrategyState();
    st.entry("S1", "short", 1);
    st.processFills(20, undefined, undefined, 0); // avg=20
    expect(st.openTradeProfitPercent(18, 0)).toBeCloseTo(10); // (20-18)/20*100
  });

  it("tracks running max_runup/max_drawdown across bars using bar high/low (직전-바 상태 기준, 진입 바 자체는 미반영)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(100, 100, 100, 0); // entry fill — 진입 바 자체는 excursion에 미반영(C312 단순화)
    st.processFills(105, 110, 104, 1); // pre-fill avg=100: high pnl=10, low pnl=4 -> runup=10, drawdown=0
    expect(st.openTradeMaxRunup(0)).toBe(10);
    expect(st.openTradeMaxDrawdown(0)).toBe(0);
    st.processFills(103, 105, 95, 2); // high pnl=5(runup 불변), low pnl=-5 -> drawdown=5
    expect(st.openTradeMaxRunup(0)).toBe(10);
    expect(st.openTradeMaxDrawdown(0)).toBe(5);
  });

  it("snapshots max_runup/max_drawdown into closedtrades at full close, then resets the running trackers for the next trade", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(100, 100, 100, 0);
    st.processFills(105, 110, 104, 1); // runup=10
    st.processFills(103, 105, 95, 2); // drawdown=5
    st.close("L");
    st.processFills(102, 103, 101, 3); // 청산 바 자신의 pre-fill excursion(고정 100 기준): 3/1 -- 기존 10/5 안 바꿈
    expect(st.closedTradeMaxRunup(0)).toBe(10);
    expect(st.closedTradeMaxDrawdown(0)).toBe(5);
    // 새 트레이드는 0에서 재시작
    st.entry("L2", "long", 1);
    st.processFills(50, 50, 50, 4);
    expect(st.openTradeMaxRunup(0)).toBe(0);
    expect(st.openTradeMaxDrawdown(0)).toBe(0);
  });

  it("partial close snapshots the running value without resetting it (잔여 포지션은 같은 트레이드로 계속 누적)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(100, 100, 100, 0);
    st.processFills(105, 110, 95, 1); // pre-fill avg=100,size=2: high pnl=20, low pnl=-10 -> runup=20, drawdown=10
    st.close("L", 1); // 부분 청산(qty=1, 잔여 1)
    st.processFills(103, 104, 102, 2);
    expect(st.closedTradeMaxRunup(0)).toBe(20); // 부분 청산도 스냅샷(다른 lastClosed* 필드와 동일 관례)
    expect(st.closedTradeMaxDrawdown(0)).toBe(10);
    expect(st.openTradeMaxRunup(0)).toBe(20); // 러닝값은 리셋 안 됨(포지션 존속)
    expect(st.openTradeMaxDrawdown(0)).toBe(10);
  });

  it("returns na for opentrades.profit/profit_percent/max_drawdown/max_runup when flat (C578), still throws at a wrong index while a trade is open", () => {
    const st = new StrategyState();
    expect(Number.isNaN(st.openTradeProfit(10, 0))).toBe(true);
    expect(Number.isNaN(st.openTradeProfitPercent(10, 0))).toBe(true);
    expect(Number.isNaN(st.openTradeMaxDrawdown(0))).toBe(true);
    expect(Number.isNaN(st.openTradeMaxRunup(0))).toBe(true);
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    expect(() => st.openTradeProfit(10, 1)).toThrow(/index 1 is out of range/);
    expect(() => st.openTradeMaxRunup(1)).toThrow(/index 1 is out of range/);
  });

  it("throws for closedtrades.profit_percent/max_drawdown/max_runup at a non-latest index", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.close("L");
    st.processFills(11, undefined, undefined, 1);
    expect(() => st.closedTradeProfitPercent(1)).toThrow(/index 1 is out of range/);
    expect(() => st.closedTradeMaxDrawdown(-1)).toThrow(/index -1 is out of range/);
  });
});

describe("StrategyState.closedtrades/opentrades.entry_time/exit_time/commission (C418, hand-verified — pine2py에 인덱스 접근자 자체가 없어 오라클 불가)", () => {
  it("captures entry_time at fill time and holds it through the position, snapshotting entry_time/exit_time into closedtrades on close", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0, 1000); // 진입 bar0 @ t=1000
    expect(st.openTradeEntryTime(0)).toBe(1000);
    st.close("L");
    st.processFills(15, undefined, undefined, 1, 2000); // 청산 bar1 @ t=2000
    expect(st.closedTradeEntryTime(0)).toBe(1000);
    expect(st.closedTradeExitTime(0)).toBe(2000);
  });

  it("preserves the first entry's time through pyramiding add-ons (entryBarIndexOpen과 동일 lifecycle)", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, 1000);
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 1, 2000); // 같은 방향 추가 진입 — entryTimeOpen은 1000 유지
    expect(st.openTradeEntryTime(0)).toBe(1000);
  });

  it("commission is always 0 (기존 commission 0 고정 결정 재사용), for both closedtrades and opentrades", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10, undefined, undefined, 0, 1000);
    expect(st.openTradeCommission(0)).toBe(0);
    st.close("L");
    st.processFills(15, undefined, undefined, 1, 2000);
    expect(st.closedTradeCommission(0)).toBe(0);
  });

  it("resets entryTimeOpen to NaN on flat, and a fresh entry captures a new entry_time", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 1);
    st.processFills(10, undefined, undefined, 0, 1000);
    st.close("L1");
    st.processFills(11, undefined, undefined, 1, 2000);
    expect(st.entryTimeOpen).toBe(NaN); // flat
    st.entry("L2", "long", 1);
    st.processFills(12, undefined, undefined, 2, 3000);
    expect(st.openTradeEntryTime(0)).toBe(3000); // 새 트레이드는 새 entry_time
  });

  it("throws for entry_time/exit_time/commission at a non-latest closed-trade index; open-trade index is na once flat (not a throw, C578)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0, 1000);
    st.close("L");
    st.processFills(11, undefined, undefined, 1, 2000);
    expect(() => st.closedTradeEntryTime(1)).toThrow(/index 1 is out of range/);
    expect(() => st.closedTradeExitTime(-1)).toThrow(/index -1 is out of range/);
    expect(() => st.closedTradeCommission(1)).toThrow(/index 1 is out of range/);
    expect(Number.isNaN(st.openTradeEntryTime(1))).toBe(true); // 이 시점 flat(posSize=0) — 잘못된 index가 아니라 "트레이드 없음"
  });

  it("without a barTimeMs channel (legacy call form) entry_time/exit_time stay NaN (기존 barIndex 생략 관례와 동일 — MEMORY.md C91 긍정형 가드가 자연히 흡수)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10); // barTimeMs 생략
    expect(Number.isNaN(st.openTradeEntryTime(0))).toBe(true);
    st.close("L");
    st.processFills(11);
    expect(Number.isNaN(st.closedTradeEntryTime(0))).toBe(true);
    expect(Number.isNaN(st.closedTradeExitTime(0))).toBe(true);
  });

  it("close(immediately=true)/close_all(immediately=true) also capture exit_time via the injected currentBarTimeMs (C418 threads it alongside currentClose/currentBarIndex)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, 1000);
    st.close("A", undefined, undefined, true, undefined, true, 13, 5, 4000); // 즉시 체결
    expect(st.closedTradeExitTime(0)).toBe(4000);

    const st2 = new StrategyState();
    st2.entry("B", "long", 1);
    st2.processFills(10, undefined, undefined, 0, 1000);
    st2.close_all("bye", true, true, 17, 9, 5000);
    expect(st2.closedTradeExitTime(0)).toBe(5000);
  });
});

describe("strategy.closedtrades/opentrades.entry_time/exit_time/commission analyzer validation (C418)", () => {
  it("accepts closedtrades.entry_time/exit_time/commission after strategy() with exactly one arg", () => {
    for (const m of ["entry_time", "exit_time", "commission"]) {
      expect(transpile(`strategy("s")\nx = strategy.closedtrades.${m}(strategy.closedtrades - 1)`).ok).toBe(true);
    }
  });

  it("accepts opentrades.entry_time/commission with exactly one arg", () => {
    for (const m of ["entry_time", "commission"]) {
      expect(transpile(`strategy("s")\nx = strategy.opentrades.${m}(0)`).ok).toBe(true);
    }
  });

  it("still rejects opentrades.exit_time (TV에 대응 함수 자체가 없음 — wild grep 0건)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.opentrades.exit_time(0)');
    expect(errors.some((e) => e.includes("unsupported call"))).toBe(true);
  });
});

describe("strategy.closedtrades/opentrades.entry_time/exit_time/commission codegen emission (C418)", () => {
  it("emits flat StrategyState method names, no implicit close-price injection (OPEN_TRADE_CLOSE_PRICE_METHODS 대상 아님)", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.closedtrades.entry_time(0)\nvar float b = na\nb := strategy.closedtrades.exit_time(0)\nvar float c = na\nc := strategy.closedtrades.commission(0)\nvar float d = na\nd := strategy.opentrades.entry_time(0)\nvar float e = na\ne := strategy.opentrades.commission(0)',
    );
    expect(code).toContain("$.strategy.closedTradeEntryTime(0)");
    expect(code).toContain("$.strategy.closedTradeExitTime(0)");
    expect(code).toContain("$.strategy.closedTradeCommission(0)");
    expect(code).toContain("$.strategy.openTradeEntryTime(0)");
    expect(code).toContain("$.strategy.openTradeCommission(0)");
  });
});

describe("strategy.closedtrades/opentrades 트레이드 접근자 확장 analyzer validation (C308)", () => {
  it("accepts all new closedtrades methods after strategy() with exactly one arg", () => {
    for (const m of ["entry_price", "exit_price", "entry_bar_index", "exit_bar_index", "entry_id", "exit_id", "profit", "size"]) {
      expect(transpile(`strategy("s")\nx = strategy.closedtrades.${m}(strategy.closedtrades - 1)`).ok).toBe(true);
    }
  });

  it("accepts all opentrades methods after strategy() with exactly one arg", () => {
    for (const m of ["entry_price", "entry_bar_index", "entry_id", "size"]) {
      expect(transpile(`strategy("s")\nx = strategy.opentrades.${m}(0)`).ok).toBe(true);
    }
  });

  it("accepts opentrades methods without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.opentrades.entry_price(0)").ok).toBe(true);
  });

  it("rejects wrong arg count for the new methods (both namespaces)", () => {
    const errors1 = transpileErrors('strategy("s")\nx = strategy.closedtrades.entry_price()');
    expect(errors1.some((e) => e.includes("requires 1 (trade index)"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nx = strategy.opentrades.size(0, 1)');
    expect(errors2.some((e) => e.includes("requires 1 (trade index)"))).toBe(true);
  });

  it("strategy.risk.max_drawdown is now implemented (C322) — no longer rejected as an unsupported call", () => {
    expect(transpile('strategy("s")\nstrategy.risk.max_drawdown(10, strategy.percent_of_equity)').ok).toBe(true);
  });
});

describe("strategy.closedtrades/opentrades.max_drawdown/max_runup/profit_percent + opentrades.profit analyzer validation (C312)", () => {
  it("accepts all 4 new closedtrades methods after strategy() with exactly one arg", () => {
    for (const m of ["profit_percent", "max_drawdown", "max_runup"]) {
      expect(transpile(`strategy("s")\nx = strategy.closedtrades.${m}(strategy.closedtrades - 1)`).ok).toBe(true);
    }
  });

  it("accepts all 4 new opentrades methods (profit/profit_percent/max_drawdown/max_runup) with exactly one user-facing arg", () => {
    for (const m of ["profit", "profit_percent", "max_drawdown", "max_runup"]) {
      expect(transpile(`strategy("s")\nx = strategy.opentrades.${m}(0)`).ok).toBe(true);
    }
  });
});

describe("strategy.closedtrades/opentrades.max_drawdown/max_runup/profit_percent + opentrades.profit codegen emission (C312)", () => {
  it("emits flat StrategyState method names for the new closedtrades accessors", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.closedtrades.profit_percent(0)\nvar float b = na\nb := strategy.closedtrades.max_drawdown(0)\nvar float c = na\nc := strategy.closedtrades.max_runup(0)',
    );
    expect(code).toContain("$.strategy.closedTradeProfitPercent(0)");
    expect(code).toContain("$.strategy.closedTradeMaxDrawdown(0)");
    expect(code).toContain("$.strategy.closedTradeMaxRunup(0)");
  });

  it("injects $.close.get(0) as the first arg for opentrades.profit/profit_percent only", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.opentrades.profit(0)\nvar float b = na\nb := strategy.opentrades.profit_percent(0)\nvar float c = na\nc := strategy.opentrades.max_drawdown(0)\nvar float d = na\nd := strategy.opentrades.max_runup(0)',
    );
    expect(code).toContain("$.strategy.openTradeProfit($.close.get(0), 0)");
    expect(code).toContain("$.strategy.openTradeProfitPercent($.close.get(0), 0)");
    expect(code).toContain("$.strategy.openTradeMaxDrawdown(0)");
    expect(code).toContain("$.strategy.openTradeMaxRunup(0)");
  });
});

describe("strategy.closedtrades/opentrades 트레이드 접근자 확장 codegen emission (C308)", () => {
  it("emits flat StrategyState method names for the new closedtrades accessors", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.closedtrades.entry_price(0)\nvar float b = na\nb := strategy.closedtrades.profit(0)\nvar string c = na\nc := strategy.closedtrades.exit_id(0)',
    );
    expect(code).toContain("$.strategy.closedTradeEntryPrice(0)");
    expect(code).toContain("$.strategy.closedTradeProfit(0)");
    expect(code).toContain("$.strategy.closedTradeExitId(0)");
  });

  it("emits flat StrategyState method names for the new opentrades accessors", () => {
    const code = transpileCode(
      'strategy("s")\nvar float a = na\na := strategy.opentrades.entry_price(0)\nvar float b = na\nb := strategy.opentrades.entry_bar_index(0)',
    );
    expect(code).toContain("$.strategy.openTradeEntryPrice(0)");
    expect(code).toContain("$.strategy.openTradeEntryBarIndex(0)");
  });
});

describe("strategy.* E2E 열두째 슬라이스 (hand-verified: closedtrades/opentrades 트레이드 접근자 확장)", () => {
  // 손 계산 시나리오(마켓 entry/close, 다음 바 open 체결, C173 E2E와 동일 데이터/타이밍):
  //   bar0(idx0,n=1): entry("L") 큐잉.
  //   bar1(idx1,n=2): open 12 체결(롱 1@12) -> opentrades 관측 가능(entry_bar_index=1).
  //   bar2(idx2,n=3): close("L") 큐잉.
  //   bar3(idx3,n=4): open 15 청산 체결(exit_bar_index=3) -> closedtrades 관측 가능, opentrades
  //     가드(`if strategy.opentrades > 0`)는 이제 false가 되어 그 안의 __obs_oep 등은 재대입되지
  //     않고 bar2의 마지막 값을 그대로 유지한다(var 시맨틱 — na로 리셋되지 않음).
  //   bar4(idx4,n=5): flat 유지 -> closedtrades/opentrades 관측 값 전부 그대로.
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L", strategy.long, 1)',
    "if n == 3",
    '    strategy.close("L")',
    "var float __obs_cep = na",
    "var float __obs_cxp = na",
    "var float __obs_ceb = na",
    "var float __obs_cxb = na",
    "var float __obs_cprofit = na",
    "var float __obs_csize = na",
    "if strategy.closedtrades > 0",
    "    __obs_cep := strategy.closedtrades.entry_price(strategy.closedtrades - 1)",
    "    __obs_cxp := strategy.closedtrades.exit_price(strategy.closedtrades - 1)",
    "    __obs_ceb := strategy.closedtrades.entry_bar_index(strategy.closedtrades - 1)",
    "    __obs_cxb := strategy.closedtrades.exit_bar_index(strategy.closedtrades - 1)",
    "    __obs_cprofit := strategy.closedtrades.profit(strategy.closedtrades - 1)",
    "    __obs_csize := strategy.closedtrades.size(strategy.closedtrades - 1)",
    "var float __obs_oep = na",
    "var float __obs_oeb = na",
    "var float __obs_osize = na",
    "if strategy.opentrades > 0",
    "    __obs_oep := strategy.opentrades.entry_price(strategy.opentrades - 1)",
    "    __obs_oeb := strategy.opentrades.entry_bar_index(strategy.opentrades - 1)",
    "    __obs_osize := strategy.opentrades.size(strategy.opentrades - 1)",
  ].join("\n");

  it("tracks closedtrades entry_price/exit_price/entry_bar_index/exit_bar_index/profit/size per bar", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_cep"])).toEqual([NaN, NaN, NaN, 12, 12]);
    expect(result.bars.map((b) => b["var:__obs_cxp"])).toEqual([NaN, NaN, NaN, 15, 15]);
    expect(result.bars.map((b) => b["var:__obs_ceb"])).toEqual([NaN, NaN, NaN, 1, 1]);
    expect(result.bars.map((b) => b["var:__obs_cxb"])).toEqual([NaN, NaN, NaN, 3, 3]);
    expect(result.bars.map((b) => b["var:__obs_cprofit"])).toEqual([NaN, NaN, NaN, 3, 3]);
    expect(result.bars.map((b) => b["var:__obs_csize"])).toEqual([NaN, NaN, NaN, 1, 1]);
  });

  it("tracks opentrades entry_price/entry_bar_index/size while open, and holds the last value afterward (var 미재대입 — 관측 가드 자체가 false가 되어도 이전 값 유지)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_oep"])).toEqual([NaN, 12, 12, 12, 12]);
    expect(result.bars.map((b) => b["var:__obs_oeb"])).toEqual([NaN, 1, 1, 1, 1]);
    expect(result.bars.map((b) => b["var:__obs_osize"])).toEqual([NaN, 1, 1, 1, 1]);
  });
});

describe("strategy.* E2E (hand-verified: closedtrades/opentrades.entry_time/exit_time/commission, C418)", () => {
  // C308 E2E와 동일한 5바 entry/close 시나리오 + time 채널(각 바 1000ms씩 증가)만 추가 — bar1 진입,
  // bar3 청산.
  const C418_TIMES = [1000, 2000, 3000, 4000, 5000];
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
    time: C418_TIMES,
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L", strategy.long, 1)',
    "if n == 3",
    '    strategy.close("L")',
    "var float __obs_cet = na",
    "var float __obs_cxt = na",
    "var float __obs_ccomm = na",
    "if strategy.closedtrades > 0",
    "    __obs_cet := strategy.closedtrades.entry_time(strategy.closedtrades - 1)",
    "    __obs_cxt := strategy.closedtrades.exit_time(strategy.closedtrades - 1)",
    "    __obs_ccomm := strategy.closedtrades.commission(strategy.closedtrades - 1)",
    "var float __obs_oet = na",
    "var float __obs_ocomm = na",
    "if strategy.opentrades > 0",
    "    __obs_oet := strategy.opentrades.entry_time(strategy.opentrades - 1)",
    "    __obs_ocomm := strategy.opentrades.commission(strategy.opentrades - 1)",
  ].join("\n");

  it("tracks closedtrades entry_time/exit_time/commission per bar", () => {
    const result = runPipeline(src, data);
    // 진입 bar1(t=2000) 체결, 청산 bar3(t=4000) 체결 — entry_bar_index/exit_bar_index E2E(C308 위
    // 블록)와 정확히 같은 타이밍의 time판.
    expect(result.bars.map((b) => b["var:__obs_cet"])).toEqual([NaN, NaN, NaN, 2000, 2000]);
    expect(result.bars.map((b) => b["var:__obs_cxt"])).toEqual([NaN, NaN, NaN, 4000, 4000]);
    expect(result.bars.map((b) => b["var:__obs_ccomm"])).toEqual([NaN, NaN, NaN, 0, 0]);
  });

  it("tracks opentrades entry_time/commission while open, and holds the last value afterward (var 미재대입)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_oet"])).toEqual([NaN, 2000, 2000, 2000, 2000]);
    expect(result.bars.map((b) => b["var:__obs_ocomm"])).toEqual([NaN, 0, 0, 0, 0]);
  });
});

// ── C193: P3 '패턴: strategy 시나리오(MACD cross/trailing stop/pyramiding)' ──
// 세 조각(ta.macd 기반 crossover/crossunder entry 신호, pyramiding=2 가중평균 누적, strategy.exit
// trail_points=/trail_offset= 트레일링 청산)은 전부 P2에서 개별 검증 완료된 빌드 블록이다 --
// ta.macd 자체는 oracle/cases/ta_macd.pine·e2e_macd.pine으로 오라클 검증됐고, pyramiding 가중평균과
// 트레일링 래칫/체결은 이 파일 위쪽 슬라이스(C164/C170/C178)가 hand-verified로 이미 확정했다. 이
// 시나리오는 그 세 조각을 하나의 실전형 스크립트로 "조합"했을 때 strategy 상태머신(entry/exit
// 판정 순서, pyramiding 게이트, 포지션 리셋)이 여전히 정확히 상호작용하는지가 목적 -- 개별 조각의
// 시맨틱 재검증이 아니다(파일 헤더 원칙: strategy 계열은 pine2py 당일-close 체결 버그 때문에 오라클
// 크로스체크 자체가 무효라 100% hand-verified).
//
// fast=2/slow=3/signal=2(ta_macd.pine과 동일 파라미터, 이미 오라클로 검증된 조합 재사용)로
// ta.crossover(macdLine,signalLine)이 true인 바에서만 strategy.entry(pyramiding=2) 진입, 매 바
// strategy.exit(trail_points=4, trail_offset=1)을 무조건 재호출(exit() 자체가 posSize===0일 때
// 콜타임에 no-op이라 별도 가드 불필요, C167 참조)한다. 16바 커스텀 데이터(realistic once가 아니라
// 크로스오버가 여러 번 재발하도록 미세 등락을 반복시킨 합성 시퀀스)로 실제 파이프라인을 먼저
// 실행해(scratch 탐색 스크립트, 삭제함) 크로스오버가 bar5/7/9/11에 정확히 4회 발화함을 확인한 뒤,
// 그 실측 트레이스를 아래처럼 손으로 재검증했다:
//   bar5: crossover(long) 발화 -> entry("L",1) 큐잉(1번째 진입 신호). 아직 flat(ps=0)
//   bar6: open 104 체결(신규 포지션, ps=1/ap=104/entryCount=1). exit 첫 등록(activation=104+4=108)
//   bar7: crossover(long) 재발화 -> entry("L",1) 큐잉(2번째 신호, 이월). ps=1/ap=104 그대로
//   bar8: open 105 체결 -> pyramiding 가중평균(entryCount 1<2 통과): ap=(104*1+105*1)/2=104.5,
//         ps=2, entryCount=2(게이트 소진). exit 재등록(activation=104.5+4=108.5로 갱신)
//   bar9: crossover(long) 재발화 -> entry("L",1) 큐잉(3번째 신호)
//   bar10: open 106에서 체결 시도하나 entryCount(2)>=pyramiding(2) -> 주문 소진(이월 없음). ps/ap
//         불변(2/104.5). high 107<activation 108.5라 트레일링도 미활성 -> 이중으로 불변 확인
//   bar11: crossover(long) 재발화 -> entry("L",1) 큐잉(4번째 신호). high 108<108.5라 트레일링
//         여전히 미활성(경계값 확인). ps/ap 불변(2/104.5)
//   bar12: **같은 processFills 호출 안에서 청산이 entry보다 먼저 판정된다**(C167 "청산 먼저" 순서
//         원칙) -- high 111>=activation 108.5로 트레일링 활성 + 라인=111-1=110으로 래칫, low
//         106<=110이라 즉시 110에 전량(2계약) 체결(profit=(110-104.5)*2=11, realizedPnl 0->11).
//         이 청산이 posSize를 0으로 리셋한 **바로 그 뒤**에 bar11이 큐잉해둔 4번째 entry 주문이
//         처리되는데, 이 시점 posSize===0이라 pyramiding 가중평균이 아니라 **완전히 새 포지션**으로
//         체결된다(open 107, ap=107/entryCount=1) -- 4번째 신호가 우연히 "게이트 차단"이 아니라
//         "청산 직후 신규 진입"이 된 것. 최종 ps=1/ap=107/np=11
//   bar13: 새 사이클의 exit는 bar12에서 이미 fresh 등록(activation=107+4=111)됐다 -- high 111이
//         activation과 정확히 일치(경계 포함 확인) -> 활성 + 라인=111-1=110 래칫, low 105<=110 ->
//         110에 전량(1계약) 체결(profit=(110-107)*1=3, realizedPnl 11->14). ps=0/ap=na/np=14
//   bar14/bar15: 신규 신호 없음(crossover 미발화) -> flat 유지, np=14 고정
describe("strategy.* E2E 열두째 슬라이스 (hand-verified: MACD crossover 진입 + pyramiding 가중평균 + trailing stop 청산 조합, C193)", () => {
  const close = [100, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 110, 106, 103, 101];
  const open = [99, 101, 102, 101, 103, 102, 104, 103, 105, 104, 106, 105, 107, 110, 106, 103];
  const high = close.map((c, i) => Math.max(c, open[i]!) + 1);
  const low = close.map((c, i) => Math.min(c, open[i]!) - 1);
  const volume = close.map(() => 100);
  const data: OHLCVData = { open, high, low, close, volume };
  const src = [
    'strategy("s", pyramiding=2)',
    "[macdLine, signalLine, histLine] = ta.macd(close, 2, 3, 2)",
    "longCond = ta.crossover(macdLine, signalLine)",
    "shortCond = ta.crossunder(macdLine, signalLine)",
    "if longCond",
    '    strategy.entry("L", strategy.long, 1)',
    'strategy.exit("X", trail_points=4, trail_offset=1)',
    "var float __obs_long = na",
    "__obs_long := longCond ? 1.0 : 0.0",
    "var float __obs_short = na",
    "__obs_short := shortCond ? 1.0 : 0.0",
    "var float __obs_ps = na",
    "__obs_ps := strategy.position_size",
    "var float __obs_ap = na",
    "__obs_ap := strategy.position_avg_price",
    "var float __obs_np = na",
    "__obs_np := strategy.netprofit",
  ].join("\n");

  const PS = [0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 1, 0, 0, 0];
  const NP = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11, 14, 14, 14];

  it("fires ta.crossover(macdLine, signalLine) exactly at bar5/7/9/11", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_long"])).toEqual([0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0]);
  });

  it("fires ta.crossunder(macdLine, signalLine) exactly at bar4/6/8/10/13", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_short"])).toEqual([0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0]);
  });

  it("tracks position_size through fresh entry -> pyramiding add -> gated block -> exit-then-reentry -> exit", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ps"])).toEqual(PS);
  });

  it("bar6 fresh entry fills at next-bar open (104)", () => {
    const result = runPipeline(src, data);
    expect(result.bars[6]!["var:__obs_ap"]).toBe(104);
  });

  it("bar8 pyramiding add-on computes the exact weighted-average price (104*1+105*1)/2=104.5", () => {
    const result = runPipeline(src, data);
    expect(result.bars[8]!["var:__obs_ap"]).toBe(104.5);
  });

  it("bar9/bar11 crossover signals while pyramiding is gated do not perturb position_size or avg price", () => {
    const result = runPipeline(src, data);
    for (const i of [8, 9, 10, 11]) {
      expect(result.bars[i]!["var:__obs_ps"]).toBe(2);
      expect(result.bars[i]!["var:__obs_ap"]).toBe(104.5);
    }
  });

  it("bar10 gated add-on is consumed without carrying over (not a pending order still waiting)", () => {
    const result = runPipeline(src, data);
    // bar11의 open(105)/high(108)도 이미 activation(108.5) 미만이라 트레일링과 무관하게
    // ps가 그대로임을 bar9->bar10->bar11 3바 연속으로 재확인(단일 우연 아님).
    expect(result.bars[9]!["var:__obs_ps"]).toBe(2);
    expect(result.bars[10]!["var:__obs_ps"]).toBe(2);
    expect(result.bars[11]!["var:__obs_ps"]).toBe(2);
  });

  it("trailing activation threshold is exact: bar11 high=108 < activation 108.5 stays inactive, bar12 high=111 >= 108.5 activates", () => {
    expect(high[11]).toBe(108);
    expect(high[12]).toBe(111);
    const result = runPipeline(src, data);
    expect(result.bars[11]!["var:__obs_ps"]).toBe(2); // 미활성 -> 청산 없음
    expect(result.bars[12]!["var:__obs_ps"]).toBe(1); // 활성+체결 -> 청산 후 재진입
  });

  it("bar12 realizes the full 2-lot trailing exit profit before the queued 4th entry re-fills as a brand-new position", () => {
    const result = runPipeline(src, data);
    // (110-104.5)*2 = 11 -- 청산이 같은 processFills 호출 안에서 entry보다 먼저 판정된다(C167).
    expect(result.bars[12]!["var:__obs_np"]).toBe(11);
    expect(result.bars[12]!["var:__obs_ps"]).toBe(1);
    expect(result.bars[12]!["var:__obs_ap"]).toBe(107); // pyramiding 가중평균이 아니라 신규 진입가 그대로
  });

  it("bar12's re-entry starts an independent trailing cycle (fresh avg=107, not the stale 104.5 cycle)", () => {
    const result = runPipeline(src, data);
    // bar13 활성화 임계값은 107+4=111(구 사이클의 104.5+4=108.5가 아님) -- high 111과 정확히 일치.
    expect(high[13]).toBe(111);
    expect(result.bars[13]!["var:__obs_ps"]).toBe(0);
  });

  it("bar13 exact-touch activation (high == activation threshold) still triggers the trailing exit", () => {
    const result = runPipeline(src, data);
    expect(result.bars[13]!["var:__obs_np"]).toBe(14); // (110-107)*1=3 추가, 11+3=14
  });

  it("tracks netprofit through both realized trailing exits and stays flat afterward", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_np"])).toEqual(NP);
  });

  it("netprofit is monotonically non-decreasing (both trades in this scenario are winners)", () => {
    const result = runPipeline(src, data);
    const np = result.bars.map((b) => b["var:__obs_np"] as number);
    for (let i = 1; i < np.length; i++) expect(np[i]!).toBeGreaterThanOrEqual(np[i - 1]!);
  });

  it("position_size stays within [0, 2] for the entire run (base + one pyramiding add, never more)", () => {
    const result = runPipeline(src, data);
    for (const b of result.bars) {
      const ps = b["var:__obs_ps"] as number;
      expect(ps).toBeGreaterThanOrEqual(0);
      expect(ps).toBeLessThanOrEqual(2);
    }
  });

  it("ends flat after both trailing exits with no residual position (bar14/bar15 see no new signal)", () => {
    const result = runPipeline(src, data);
    expect(result.bars[14]!["var:__obs_ps"]).toBe(0);
    expect(result.bars[15]!["var:__obs_ps"]).toBe(0);
    expect(Number.isNaN(result.bars[15]!["var:__obs_ap"] as number)).toBe(true);
  });

  it("is deterministic across repeated runs (same source + same data)", () => {
    const r1 = runPipeline(src, data);
    const r2 = runPipeline(src, data);
    expect(r1.bars.map((b) => b["var:__obs_ps"])).toEqual(r2.bars.map((b) => b["var:__obs_ps"]));
    expect(r1.bars.map((b) => b["var:__obs_np"])).toEqual(r2.bars.map((b) => b["var:__obs_np"]));
  });
});

// ── C309: wild next_hint 1순위 서브그룹 'strategy.risk.*' — strategy.risk.allow_entry_in(value)만
// 이번 슬라이스 범위(방향 제한, 4/18건이지만 wild 실제 활성 사용은 30+ 파일로 이 서브그룹 최다빈도).
// max_intraday_filled_orders/max_intraday_loss/max_drawdown 3종은 "거래일" 경계+정지 상태 설계가
// 필요한 별개 축이라 범위 밖(LIMITATIONS.md 참조). pine2py에 대응 구현이 전혀 없어(wavealgo/strategy
// 전체 grep 0건) **전부 hand-verified**: wild 코퍼스 자신에 포함된 TV 공식 문서 발췌(REMARKS:
// "it will be executed as a position-closing order instead of a reversal")를 근거로 채택했으나 이
// 세션은 웹 접근이 없어 1차 검증 불가 — DIVERGENCES에 "TV 미검증(가설)"로 등재.
describe("StrategyState.setAllowEntryIn/entry() 방향 게이트 (C309, hand-verified)", () => {
  it("defaults to unrestricted ('all') — entry() in either direction opens normally without calling setAllowEntryIn", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    expect(st.posSize).toBe(1);
  });

  it("setAllowEntryIn accepts 'all'/'long'/'short' and rejects any other value", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("all");
    st.setAllowEntryIn("long");
    st.setAllowEntryIn("short");
    expect(() => st.setAllowEntryIn("both")).toThrow(/unsupported value/);
  });

  it("a long entry from flat opens normally when only long is allowed", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("long");
    st.entry("L", "long", 1);
    st.processFills(10);
    expect(st.posSize).toBe(1);
  });

  it("a short entry from flat is ignored (no position opened) when only long is allowed", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("long");
    st.entry("S", "short", 1);
    st.processFills(10);
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(0); // 청산할 포지션 자체가 없었음 — close-only 분기도 안 탐
  });

  it("a forbidden-direction entry closes the existing opposite position instead of reversing into it (TV REMARKS 근거)", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("long");
    st.entry("L", "long", 2);
    st.processFills(10, undefined, undefined, 0); // 롱 2 @ 10
    st.entry("S", "short", 1); // qty는 무관 — 방향 자체가 금지
    st.processFills(15, undefined, undefined, 1); // 청산only: flat, 신규 숏 없음
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(1);
    expect(st.closedTradeProfit(0)).toBe(10); // (15-10)*2
    expect(st.closedTradeEntryId(0)).toBe("L");
    expect(st.closedTradeExitId(0)).toBe("S"); // 청산을 유발한 주문 자신의 id (entry 리버스 관례와 동일)
  });

  it("symmetric for short-only restriction", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("short");
    st.entry("L", "long", 1); // 금지 — 무시
    st.processFills(10);
    expect(st.posSize).toBe(0);
    st.entry("S", "short", 3);
    st.processFills(12, undefined, undefined, 1); // 허용 — 정상 진입
    expect(st.posSize).toBe(-3);
  });

  it("pyramiding add-ons in the allowed direction are unaffected by an active restriction", () => {
    const st = new StrategyState();
    st.configure(1, 2); // pyramiding=2
    st.setAllowEntryIn("long");
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.entry("B", "long", 1);
    st.processFills(20, undefined, undefined, 1);
    expect(st.posSize).toBe(2);
    expect(st.posAvgPrice).toBe(15); // (10+20)/2 — pyramiding 가중평균 정상 동작
  });

  it("switching allowedDirection is consumed at fill time, not call time (same-bar re-call reflects the latest setting)", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("long");
    st.setAllowEntryIn("all"); // 같은 바 안에서 재호출 — 최종값이 all
    st.entry("S", "short", 1);
    st.processFills(10);
    expect(st.posSize).toBe(-1); // all로 재설정됐으므로 숏 진입 정상 체결
  });

  it("order() netting is NOT gated by allow_entry_in — this restriction is documented as strategy.entry-specific only", () => {
    const st = new StrategyState();
    st.setAllowEntryIn("long");
    st.order("S", "short", 1);
    st.processFills(10);
    expect(st.posSize).toBe(-1); // entry()와 달리 order()는 이번 슬라이스에서 영향받지 않음(범위 밖 명시)
  });
});

describe("strategy.direction.*/strategy.risk.allow_entry_in analyzer validation (C309)", () => {
  it("folds strategy.direction.all/long/short to compile-time string constants", () => {
    for (const [m, expected] of [
      ["all", "all"],
      ["long", "long"],
      ["short", "short"],
    ] as const) {
      const code = transpileCode(`strategy("s")\nstrategy.risk.allow_entry_in(strategy.direction.${m})`);
      expect(code).toContain(`$.strategy.setAllowEntryIn("${expected}")`);
    }
  });

  it("accepts a runtime ternary expression built from strategy.direction.* constants (wild 실사용 패턴)", () => {
    const r = transpile(
      'strategy("s")\ndir = 1\nstrategy.risk.allow_entry_in(dir == 0 ? strategy.direction.all : (dir < 0 ? strategy.direction.short : strategy.direction.long))',
    );
    expect(r.ok).toBe(true);
  });

  it("accepts strategy.direction.* without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.direction.long").ok).toBe(true);
  });

  it("accepts strategy.risk.allow_entry_in without a strategy() declaration (C771)", () => {
    expect(transpile("strategy.risk.allow_entry_in(strategy.direction.long)").ok).toBe(true);
  });

  it("rejects value-position use (assignment) — void-returning bare statement only", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.risk.allow_entry_in(strategy.direction.long)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("rejects wrong arg count (0 or 2+)", () => {
    const errors0 = transpileErrors('strategy("s")\nstrategy.risk.allow_entry_in()');
    expect(errors0.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nstrategy.risk.allow_entry_in(strategy.direction.long, "msg")');
    expect(errors2.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
  });

  it("rejects kwargs (wild 실측 0건 — 위치 인자만 지원)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.risk.allow_entry_in(value = strategy.direction.long)');
    expect(errors.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
  });
});

describe("strategy.risk.allow_entry_in codegen emission (C309)", () => {
  it("emits $.strategy.setAllowEntryIn(...) with the folded direction constant", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.allow_entry_in(strategy.direction.short)');
    expect(code).toContain('$.strategy.setAllowEntryIn("short")');
  });

  it("emits a runtime ternary expression unchanged when value isn't a compile-time constant", () => {
    const code = transpileCode(
      'strategy("s")\ndir = 1\nstrategy.risk.allow_entry_in(dir == 0 ? strategy.direction.all : strategy.direction.long)',
    );
    // C812: '=='는 rt.pineEq로 방출된다(삼항 자체는 그대로 — 이 테스트의 요지인 "런타임 표현식을
    // 폴딩하지 않고 그대로 넘긴다"는 불변).
    expect(code).toContain('$.strategy.setAllowEntryIn((rt.pineEq(dir, 0) ? "all" : "long"))');
  });
});

describe("strategy.* E2E (hand-verified: strategy.risk.allow_entry_in 방향 게이트, C309)", () => {
  // 손 계산 시나리오(마켓 entry, 다음 바 open 체결):
  //   bar0(idx0,n=1): entry("L", long) 큐잉. 아직 flat.
  //   bar1(idx1,n=2): open 12 체결 -> 롱 1@12.
  //   bar2(idx2,n=3): entry("S", short) 큐잉(금지된 방향).
  //   bar3(idx3,n=4): open 15 체결 시도 -> 금지 -> 기존 롱만 청산(flat), 신규 숏 없음.
  //   bar4(idx4,n=5): 아무 것도 큐잉 안 됨 -> flat 유지.
  const data: OHLCVData = {
    open: [10, 12, 13, 15, 17],
    high: [12, 13, 15, 17, 18],
    low: [9, 10, 12, 14, 15],
    close: [11, 11, 14, 16, 16],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "strategy.risk.allow_entry_in(strategy.direction.long)",
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L", strategy.long, 1)',
    "if n == 3",
    '    strategy.entry("S", strategy.short, 1)',
    "var float __obs_pos = na",
    "__obs_pos := strategy.position_size",
    "var float __obs_closed = na",
    "__obs_closed := strategy.closedtrades",
  ].join("\n");

  it("never opens a short position — the forbidden entry only closes the existing long", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_pos"])).toEqual([0, 1, 1, 0, 0]);
    expect(result.bars.map((b) => b["var:__obs_closed"])).toEqual([0, 0, 0, 1, 1]);
  });
});

// ── C320: wild "지원하지 않는 호출" 클러스터 next_hint 2순위 서브그룹 —
// strategy.risk.max_intraday_filled_orders(count)만 이번 슬라이스 범위(9건). max_intraday_loss/
// max_drawdown 2종은 equity 문턱값+cash/percent 타입 해석이 추가로 필요한 별개 축이라 그 당시엔
// 범위 밖이었으나(LIMITATIONS.md C309), C322가 이어서 구현했다(아래 "StrategyState.setMaxDrawdown/
// setMaxIntradayLoss" 블록 참조). pine2py에 대응 구현이 전혀 없어(allow_entry_in과 동일 근거) **전부
// hand-verified**: wild 코퍼스 자신에 포함된 TV 공식 문서 발췌(86e04be3ab6c.pine DESCRIPTION::
// "stops new orders for the current day once the maximum allowed number of filled orders (count)
// is reached", REMARKS:: "A market order to exit a current open position is still allowed, even
// after the limit is reached.")를 근거로 채택했으나 이 세션은 웹 접근이 없어 1차 검증 불가 —
// DIVERGENCES에 "TV 미검증(가설)"로 등재. "거래일" 경계는 C299가 이미 채택한 UTC 고정 축을 그대로
// 연장한다(exchange 타임존 미구현, LIMITATIONS.md 동일 갭).
const C320_DAY1 = Date.UTC(2024, 0, 1);
const C320_DAY1_LATER = C320_DAY1 + 3_600_000;
const C320_DAY2 = Date.UTC(2024, 0, 2);

describe("StrategyState.setMaxIntradayFilledOrders/entry() 일일 체결 상한 게이트 (C320, hand-verified)", () => {
  it("defaults to unrestricted (NaN) — entry() fills normally without calling setMaxIntradayFilledOrders", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0, C320_DAY1);
    expect(st.posSize).toBe(1);
  });

  it("blocks a new entry once the daily fill count reaches the configured limit (pyramiding 여유로 그 게이트와 격리 확인)", () => {
    const st = new StrategyState();
    st.configure(1, 10); // pyramiding=10 — 상한이 pyramiding이 아니라 intraday 카운터임을 격리
    st.setMaxIntradayFilledOrders(2);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C320_DAY1); // 1번째 체결 — 허용
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 1, C320_DAY1_LATER); // 2번째 체결 — 허용(같은 날)
    expect(st.posSize).toBe(2);
    st.entry("C", "long", 1);
    st.processFills(12, undefined, undefined, 2, C320_DAY1_LATER); // 3번째 — 상한 도달, 차단
    expect(st.posSize).toBe(2); // 추가 진입 없음
    expect(st.entryCount).toBe(2);
  });

  it("still allows closing an existing position via strategy.close once the daily limit is reached", () => {
    const st = new StrategyState();
    st.setMaxIntradayFilledOrders(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C320_DAY1); // 1건 소진
    st.close("A");
    st.processFills(12, undefined, undefined, 1, C320_DAY1_LATER); // 청산은 게이트 대상 아님
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(1);
  });

  it("a limit-reached reversal closes the existing opposite position but does not reopen (REMARKS 근거, allow_entry_in과 동일 패턴)", () => {
    const st = new StrategyState();
    st.setMaxIntradayFilledOrders(1);
    st.entry("L", "long", 2);
    st.processFills(10, undefined, undefined, 0, C320_DAY1); // 1건 소진(롱 2@10)
    st.entry("S", "short", 1);
    st.processFills(15, undefined, undefined, 1, C320_DAY1_LATER); // 상한 도달 -> 청산only
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(1);
    expect(st.closedTradeProfit(0)).toBe(10); // (15-10)*2
  });

  it("pyramiding add-ons count towards the same daily limit", () => {
    const st = new StrategyState();
    st.configure(1, 5); // pyramiding=5(상한과 별개로 충분히 큼)
    st.setMaxIntradayFilledOrders(2);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C320_DAY1); // 1건
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 1, C320_DAY1_LATER); // 2건 — 상한 도달
    st.entry("C", "long", 1);
    st.processFills(12, undefined, undefined, 2, C320_DAY1_LATER); // 3번째 pyramiding 추가 — 차단
    expect(st.posSize).toBe(2); // A+B만 반영, C는 막힘
    expect(st.entryCount).toBe(2);
  });

  it("the daily counter resets at the UTC calendar day boundary, unblocking further entries", () => {
    const st = new StrategyState();
    st.configure(1, 5); // pyramiding=5 — 리셋 후 재진입이 pyramiding 게이트에 막히지 않도록 격리
    st.setMaxIntradayFilledOrders(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C320_DAY1); // day1 1건 소진
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 1, C320_DAY1_LATER); // 여전히 day1 -> 차단
    expect(st.posSize).toBe(1);
    st.entry("C", "long", 1);
    st.processFills(12, undefined, undefined, 2, C320_DAY2); // day2 -> 카운터 리셋, 신규 허용
    expect(st.posSize).toBe(2);
  });

  it("without a barTimeMs channel (legacy 4-arg call form) the daily reset never fires — count accumulates indefinitely", () => {
    const st = new StrategyState();
    st.setMaxIntradayFilledOrders(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0); // barTimeMs 생략(NaN) — day-key 갱신 스킵
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 1); // 여전히 차단(리셋 신호 자체가 없음)
    expect(st.posSize).toBe(1);
  });

  it("order() netting is NOT gated by max_intraday_filled_orders — this restriction is documented as strategy.entry-specific only", () => {
    const st = new StrategyState();
    st.setMaxIntradayFilledOrders(0); // 상한 0 — entry()라면 첫 체결부터 즉시 차단됐을 값
    st.order("S", "short", 1);
    st.processFills(10, undefined, undefined, 0, C320_DAY1);
    expect(st.posSize).toBe(-1); // entry()와 달리 order()는 영향받지 않음(범위 밖 명시)
  });
});

describe("strategy.risk.max_intraday_filled_orders analyzer validation (C320)", () => {
  it("accepts a positional count argument", () => {
    expect(transpile('strategy("s")\nstrategy.risk.max_intraday_filled_orders(3)').ok).toBe(true);
  });

  it("accepts a count= keyword argument (wild 실사용 패턴, 8830cf208b52.pine)", () => {
    expect(transpile('strategy("s")\nstrategy.risk.max_intraday_filled_orders(count = 3)').ok).toBe(true);
  });

  it("accepts strategy.risk.max_intraday_filled_orders without a strategy() declaration (C771)", () => {
    expect(transpile("strategy.risk.max_intraday_filled_orders(3)").ok).toBe(true);
  });

  it("rejects value-position use (assignment) — void-returning bare statement only", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.risk.max_intraday_filled_orders(3)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("rejects wrong arg count (0 or 2 positional)", () => {
    const errors0 = transpileErrors('strategy("s")\nstrategy.risk.max_intraday_filled_orders()');
    expect(errors0.some((e) => e.includes("requires 1 (count, positional or 'count=')"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nstrategy.risk.max_intraday_filled_orders(3, "msg")');
    expect(errors2.some((e) => e.includes("requires 1 (count, positional or 'count=')"))).toBe(true);
  });

  it("rejects keyword argument names other than count=", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.risk.max_intraday_filled_orders(alert_message = "hi")');
    expect(errors.some((e) => e.includes("requires 1 (count, positional or 'count=')"))).toBe(true);
  });

  it("rejects mixing a positional count with a count= keyword argument at once", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.risk.max_intraday_filled_orders(3, count = 4)');
    expect(errors.some((e) => e.includes("requires 1 (count, positional or 'count=')"))).toBe(true);
  });
});

describe("strategy.risk.max_intraday_filled_orders codegen emission (C320)", () => {
  it("emits $.strategy.setMaxIntradayFilledOrders(...) for a positional count", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_intraday_filled_orders(3)');
    expect(code).toContain("$.strategy.setMaxIntradayFilledOrders(3)");
  });

  it("emits the same call shape for a count= keyword argument", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_intraday_filled_orders(count = 5)');
    expect(code).toContain("$.strategy.setMaxIntradayFilledOrders(5)");
  });
});

describe("strategy.* E2E (hand-verified: strategy.risk.max_intraday_filled_orders 일일 상한, C320)", () => {
  // 손 계산 시나리오(마켓 entry, 다음 바 open 체결, pyramiding=5로 그 게이트와 격리):
  //   bar0(idx0,n=1,day D): entry("1", long) 큐잉. 아직 flat.
  //   bar1(idx1,n=2,day D): open 11 체결 -> 1번째 일일 체결(day D) -> 롱 1주. entry("2") 큐잉.
  //   bar2(idx2,n=3,day D): entry("2") 체결 시도 -> 같은 날 상한(1) 도달 -> 차단, posSize 불변. entry("3") 큐잉.
  //   bar3(idx3,n=4,day D+1): entry("3") 체결 시도 -> 새 날 -> 카운터 리셋 -> 체결(pyramiding 여유) -> 롱 2주. entry("4") 큐잉.
  //   bar4(idx4,n=5,day D+1): entry("4") 체결 시도 -> 같은 날(D+1) 상한 재도달 -> 차단, posSize 불변.
  const data: OHLCVData = {
    open: [10, 11, 12, 13, 14],
    high: [10.5, 11.5, 12.5, 13.5, 14.5],
    low: [9.5, 10.5, 11.5, 12.5, 13.5],
    close: [10, 11, 12, 13, 14],
    volume: [100, 100, 100, 100, 100],
    time: [C320_DAY1, C320_DAY1, C320_DAY1, C320_DAY2, C320_DAY2],
  };
  const src = [
    'strategy("s", pyramiding = 5)',
    "strategy.risk.max_intraday_filled_orders(1)",
    "var int n = 0",
    "n := n + 1",
    'strategy.entry(str.tostring(n), strategy.long, 1)',
    "var float __obs_pos = na",
    "__obs_pos := strategy.position_size",
  ].join("\n");

  it("blocks same-day repeat fills but unblocks again on the next UTC calendar day", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_pos"])).toEqual([0, 1, 1, 2, 2]);
  });
});

// ── C322: LIMITATIONS.md C309 착수 체크리스트 (a)~(d) 완료 — strategy.risk.max_drawdown(value, type)
// (영구 래치, 기존 peakEquity/updateDrawdown 인프라 재사용)/max_intraday_loss(value, type)(거래일
// 한정 래치, C320의 intradayDayKey 경계 채널 재사용). 둘 다 pine2py에 대응 구현이 전혀 없어 **전부
// hand-verified, "TV 미검증(가설)"**: "영구 vs 거래일 한정"은 함수 이름(intraday 유무)만을 근거로
// 판단했다(runtime/strategy.ts updateDrawdown 주석 참조) — 웹 접근 없는 이 세션은 1차 검증 불가,
// DIVERGENCES.md에 가설로 등재. "포지션 강제 청산"(외부 통설)은 이번 슬라이스 범위 밖(신규 진입
// 차단만 구현 — allow_entry_in/max_intraday_filled_orders와 동일 REMARKS 패턴 계승).
const C322_DAY1 = Date.UTC(2024, 0, 1);
const C322_DAY1_LATER = C322_DAY1 + 3_600_000;
const C322_DAY2 = Date.UTC(2024, 0, 2);

describe("StrategyState.setMaxDrawdown/entry() 영구 드로다운 게이트 (C322, hand-verified)", () => {
  it("defaults to unrestricted (NaN) — entry() fills normally without calling setMaxDrawdown", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    expect(st.posSize).toBe(1);
  });

  it("setMaxDrawdown accepts 'cash'/'percent_of_equity' and rejects any other type", () => {
    const st = new StrategyState();
    st.setMaxDrawdown(1000, "cash");
    st.setMaxDrawdown(10, "percent_of_equity");
    expect(() => st.setMaxDrawdown(10, "fixed")).toThrow(/unsupported type/);
  });

  it("cash type: blocks a new entry once peak-to-current equity drawdown reaches the threshold", () => {
    const st = new StrategyState(); // initialCapital=100000 기본값
    st.configure(1, 10); // pyramiding=10 — 상한이 pyramiding이 아니라 drawdown 게이트임을 격리
    st.setMaxDrawdown(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0); // 체결가 100, 포지션 100주
    // close=100 -> equity=100000(peak=100000). close=40 -> openProfit=(40-100)*100=-6000 -> equity=94000
    // -> drawdown = 100000-94000 = 6000 >= 5000 -> 래치.
    st.updateDrawdown(40);
    st.entry("B", "long", 1);
    st.processFills(41, undefined, undefined, 1); // 신규 진입 시도 -> 차단
    expect(st.posSize).toBe(100); // B 미체결
  });

  it("percent_of_equity type: threshold is evaluated against peak equity, not initial capital", () => {
    const st = new StrategyState();
    st.configure(1, 10); // pyramiding 격리
    st.setMaxDrawdown(5, "percent_of_equity"); // peak의 5%
    st.entry("A", "long", 1000);
    st.processFills(100, undefined, undefined, 0);
    st.updateDrawdown(200); // equity=100000+(200-100)*1000=200000 -> peak=200000
    st.updateDrawdown(190); // openProfit=(190-100)*1000=90000 -> equity=190000 -> drawdown=10000=5.0%(경계, 래치)
    st.entry("B", "long", 1);
    st.processFills(191, undefined, undefined, 1);
    expect(st.posSize).toBe(1000); // B 미체결 — 5% 경계 도달로 차단
  });

  it("is a permanent latch — stays blocked even after equity later recovers back above the drawdown threshold", () => {
    const st = new StrategyState();
    st.configure(1, 10); // pyramiding 격리
    st.setMaxDrawdown(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0);
    st.updateDrawdown(40); // drawdown=6000 -> 래치
    expect(st.drawdownLimitReached).toBe(true);
    st.updateDrawdown(1000); // 큰 폭 회복(peak 갱신까지 발생) — 그래도 래치는 영구
    expect(st.drawdownLimitReached).toBe(true);
    st.entry("B", "long", 1);
    st.processFills(1001, undefined, undefined, 1);
    expect(st.posSize).toBe(100); // 회복 후에도 신규 진입은 여전히 차단
  });

  it("still allows closing an existing position once the drawdown limit is reached", () => {
    const st = new StrategyState();
    st.setMaxDrawdown(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0);
    st.updateDrawdown(40); // 래치
    st.close("A");
    st.processFills(45, undefined, undefined, 1); // 청산은 게이트 대상 아님
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(1);
  });

  it("a limit-reached reversal closes the existing opposite position but does not reopen", () => {
    const st = new StrategyState();
    st.setMaxDrawdown(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0);
    st.updateDrawdown(40); // 래치
    st.entry("S", "short", 1);
    st.processFills(45, undefined, undefined, 1); // 청산only: flat, 신규 숏 없음
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(1);
  });

  it("order() netting is NOT gated by max_drawdown — this restriction is documented as strategy.entry-specific only", () => {
    const st = new StrategyState();
    st.setMaxDrawdown(1, "cash"); // 사실상 즉시 도달할 값 — entry()라면 첫 체결부터 차단됐을 상황
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0);
    st.updateDrawdown(40); // 래치
    st.order("S", "short", 1);
    st.processFills(45, undefined, undefined, 1);
    expect(st.posSize).toBe(99); // order()는 영향받지 않음(long 100 - short 1 상쇄)
  });
});

describe("StrategyState.setMaxIntradayLoss/entry() 일일 드로다운 게이트 (C322, hand-verified)", () => {
  it("defaults to unrestricted (NaN) — entry() fills normally without calling setMaxIntradayLoss", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0, C322_DAY1);
    expect(st.posSize).toBe(1);
  });

  it("setMaxIntradayLoss accepts 'cash'/'percent_of_equity' and rejects any other type", () => {
    const st = new StrategyState();
    st.setMaxIntradayLoss(1000, "cash");
    st.setMaxIntradayLoss(10, "percent_of_equity");
    expect(() => st.setMaxIntradayLoss(10, "both")).toThrow(/unsupported type/);
  });

  it("cash type: blocks further same-day entries once the intraday peak-to-current loss reaches the threshold", () => {
    const st = new StrategyState();
    st.configure(1, 10); // pyramiding=10 — 상한이 pyramiding이 아니라 intraday-loss 게이트임을 격리
    st.setMaxIntradayLoss(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0, C322_DAY1); // day1 첫 바 -> intradayPeakEquity NaN 리셋
    st.updateDrawdown(100); // day1 첫 관측 -> intraday peak 시드=equity(100)=100000(체결가와 동일해 손익 0)
    st.updateDrawdown(40); // equity=94000 -> intraday loss=100000-94000=6000 >= 5000 -> 래치
    st.entry("B", "long", 1);
    st.processFills(41, undefined, undefined, 1, C322_DAY1_LATER); // 같은 날 -> 차단
    expect(st.posSize).toBe(100);
  });

  it("resets at the UTC calendar day boundary, unblocking further entries", () => {
    const st = new StrategyState();
    st.configure(1, 10); // pyramiding 여유 — 리셋 후 재진입이 pyramiding에 안 막히도록
    st.setMaxIntradayLoss(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0, C322_DAY1);
    st.updateDrawdown(100); // day1 시드=100000
    st.updateDrawdown(40); // 래치(day1, loss=6000)
    st.entry("B", "long", 1);
    st.processFills(41, undefined, undefined, 1, C322_DAY1_LATER); // 여전히 day1 -> 차단
    expect(st.posSize).toBe(100);
    st.entry("C", "long", 1);
    st.processFills(42, undefined, undefined, 2, C322_DAY2); // day2 -> 리셋(peak+래치), 신규 허용
    expect(st.posSize).toBe(101);
  });

  it("does not stay latched within the same day if equity partially recovers (still recomputed, but latch itself only clears on day change)", () => {
    const st = new StrategyState();
    st.configure(1, 10); // pyramiding 격리
    st.setMaxIntradayLoss(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0, C322_DAY1);
    st.updateDrawdown(100); // day1 시드=100000
    st.updateDrawdown(40); // 래치(day1, intraday peak=100000)
    st.updateDrawdown(90); // 손실폭이 줄어도(1000) 래치는 그대로 유지 — 재계산으로 안 풀림
    expect(st.intradayLossLimitReached).toBe(true);
    st.entry("B", "long", 1);
    st.processFills(91, undefined, undefined, 1, C322_DAY1_LATER);
    expect(st.posSize).toBe(100); // 여전히 차단
  });

  it("still allows closing an existing position once the intraday loss limit is reached", () => {
    const st = new StrategyState();
    st.setMaxIntradayLoss(5000, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0, C322_DAY1);
    st.updateDrawdown(100); // day1 시드=100000
    st.updateDrawdown(40); // 래치
    st.close("A");
    st.processFills(45, undefined, undefined, 1, C322_DAY1_LATER);
    expect(st.posSize).toBe(0);
    expect(st.closedTrades).toBe(1);
  });

  it("order() netting is NOT gated by max_intraday_loss — this restriction is documented as strategy.entry-specific only", () => {
    const st = new StrategyState();
    st.setMaxIntradayLoss(1, "cash");
    st.entry("A", "long", 100);
    st.processFills(100, undefined, undefined, 0, C322_DAY1);
    st.updateDrawdown(100); // day1 시드=100000
    st.updateDrawdown(40); // 래치
    st.order("S", "short", 1);
    st.processFills(45, undefined, undefined, 1, C322_DAY1_LATER);
    expect(st.posSize).toBe(99);
  });
});

describe("strategy.risk.max_intraday_loss/max_drawdown analyzer validation (C322)", () => {
  const METHODS = ["max_intraday_loss", "max_drawdown"];

  it("accepts two positional arguments (value, type)", () => {
    for (const m of METHODS) {
      expect(transpile(`strategy("s")\nstrategy.risk.${m}(10, strategy.percent_of_equity)`).ok).toBe(true);
    }
  });

  it("accepts value=/type= keyword arguments", () => {
    for (const m of METHODS) {
      expect(transpile(`strategy("s")\nstrategy.risk.${m}(value = 10, type = strategy.cash)`).ok).toBe(true);
    }
  });

  it("accepts a mixed positional value + type= keyword argument (wild 실사용 패턴, C322)", () => {
    for (const m of METHODS) {
      expect(
        transpile(`strategy("s")\ncond = close > open\nstrategy.risk.${m}(cond ? 10 : 20, type = strategy.cash)`).ok,
      ).toBe(true);
    }
  });

  it("accepts the call without a strategy() declaration (C771)", () => {
    for (const m of METHODS) {
      expect(transpile(`strategy.risk.${m}(10, strategy.cash)`).ok).toBe(true);
    }
  });

  it("rejects value-position use (assignment) — void-returning bare statement only", () => {
    for (const m of METHODS) {
      const errors = transpileErrors(`strategy("s")\nx = strategy.risk.${m}(10, strategy.cash)`);
      expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
    }
  });

  it("rejects too many positional arguments (3)", () => {
    for (const m of METHODS) {
      const errors = transpileErrors(`strategy("s")\nstrategy.risk.${m}(10, strategy.cash, "extra")`);
      expect(errors.some((e) => e.includes("requires 2 (value, type)"))).toBe(true);
    }
  });

  it("rejects a call missing the type argument entirely", () => {
    for (const m of METHODS) {
      const errors = transpileErrors(`strategy("s")\nstrategy.risk.${m}(10)`);
      expect(errors.some((e) => e.includes("requires both value and type arguments"))).toBe(true);
    }
  });

  it("rejects unknown keyword argument names", () => {
    for (const m of METHODS) {
      const errors = transpileErrors(`strategy("s")\nstrategy.risk.${m}(value = 10, type = strategy.cash, alert_message = "hi")`);
      expect(errors.some((e) => e.includes("keyword arguments 'value='/'type='"))).toBe(true);
    }
  });

  it("rejects duplicate specification of value (positional + keyword at once)", () => {
    for (const m of METHODS) {
      const errors = transpileErrors(`strategy("s")\nstrategy.risk.${m}(10, strategy.cash, value = 20)`);
      expect(errors.some((e) => e.includes("specified both positionally and as a keyword"))).toBe(true);
    }
  });
});

describe("strategy.risk.max_intraday_loss/max_drawdown codegen emission (C322)", () => {
  it("emits $.strategy.setMaxDrawdown(...) for positional args", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_drawdown(10, strategy.percent_of_equity)');
    expect(code).toContain('$.strategy.setMaxDrawdown(10, "percent_of_equity")');
  });

  it("emits $.strategy.setMaxIntradayLoss(...) for value=/type= keyword args", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_intraday_loss(value = 5, type = strategy.cash)');
    expect(code).toContain('$.strategy.setMaxIntradayLoss(5, "cash")');
  });

  it("emits the same call shape for a mixed positional value + type= keyword argument", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_drawdown(7, type = strategy.cash)');
    expect(code).toContain('$.strategy.setMaxDrawdown(7, "cash")');
  });
});

describe("strategy.* E2E (hand-verified: strategy.risk.max_drawdown 영구 게이트, C322)", () => {
  // 손 계산: initial_capital=100000, entry qty=100.
  //   bar0(n=1): entry("1") 큐잉, flat.
  //   bar1(n=2): open=100 체결 -> 롱 100주. close=100 -> equity=100000(peak), drawdown=0.
  //   bar2(n=3): pending 없음(no-op). close=40 -> equity=94000 -> drawdown=6000>=5000 -> 영구 래치.
  //             entry("2") 큐잉(n>=3).
  //   bar3(n=4): entry("2") 체결 시도 -> 래치로 차단, 여전히 100주. entry("2") 재큐잉(n>=3).
  //   bar4(n=5): close=1000로 크게 회복(peak 갱신)해도 래치는 영구 — entry("2") 여전히 차단.
  const data: OHLCVData = {
    open: [10, 100, 41, 42, 1000],
    high: [10.5, 100.5, 41.5, 42.5, 1000.5],
    low: [9.5, 99.5, 40.5, 41.5, 999.5],
    close: [10, 100, 40, 41, 1000],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", initial_capital = 100000)',
    "strategy.risk.max_drawdown(5000, strategy.cash)",
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("1", strategy.long, 100)',
    "if n >= 3",
    '    strategy.entry("2", strategy.long, 1)',
    "var float __obs_pos = na",
    "__obs_pos := strategy.position_size",
  ].join("\n");

  it("blocks further entries permanently once the drawdown threshold is crossed, even as equity later recovers", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_pos"])).toEqual([0, 100, 100, 100, 100]);
  });
});

// ── C324: next_hint(C323) 저비용 후보 재평가 — strategy.risk.max_position_size(value)만 이번
// 슬라이스 범위(wild 2건, 둘 다 위치 인자 1개뿐). allow_entry_in(C309)/max_intraday_filled_orders
// (C320)/max_drawdown·max_intraday_loss(C322) 4형제와 달리 "전면 차단"이 아니라 "신규 진입/
// 피라미딩 수량 축소"(reduce) 게이트다 — pine2py에 대응 구현이 전혀 없어(wavealgo/strategy 전수
// grep 0건, PineTS docs/api-coverage도 Status 빈칸) **전부 hand-verified**: wild 코퍼스 자신에
// 포함된 TV 문서 발췌(86e04be3ab6c.pine DESCRIPTION:: "Limits the maximum total size of the
// position... quantity of new strategy.entry orders will be reduced if necessary to prevent
// exceeding this limit.")를 근거로 채택했으나 이 세션은 웹 접근이 없어 1차 검증 불가 —
// DIVERGENCES에 "TV 미검증(가설)"로 등재. qty_type(TV 시그니처의 2번째 인자)은 wild 실사용 0건이라
// 미지원(C283 큐레이션).
describe("StrategyState.setMaxPositionSize/entry() 수량 축소 게이트 (C324, hand-verified)", () => {
  it("defaults to unrestricted (NaN) — entry() fills the full requested qty without calling setMaxPositionSize", () => {
    const st = new StrategyState();
    st.entry("L", "long", 5);
    st.processFills(10, undefined, undefined, 0);
    expect(st.posSize).toBe(5);
  });

  it("reduces a fresh-open entry's qty so the resulting position exactly matches the cap", () => {
    const st = new StrategyState();
    st.setMaxPositionSize(3);
    st.entry("L", "long", 5);
    st.processFills(10, undefined, undefined, 0);
    expect(st.posSize).toBe(3); // 5주 요청했지만 한도(3)까지만 체결
  });

  it("passes an entry through unreduced when it stays within the cap", () => {
    const st = new StrategyState();
    st.setMaxPositionSize(10);
    st.entry("L", "long", 3);
    st.processFills(10, undefined, undefined, 0);
    expect(st.posSize).toBe(3);
  });

  it("reduces pyramiding add-ons so the total position never exceeds the cap", () => {
    const st = new StrategyState();
    st.configure(1, 5); // pyramiding=5 — 별개 게이트와 격리
    st.setMaxPositionSize(4);
    st.entry("A", "long", 3);
    st.processFills(10, undefined, undefined, 0); // 3주 오픈(한도 이내)
    expect(st.posSize).toBe(3);
    st.entry("B", "long", 3);
    st.processFills(11, undefined, undefined, 1); // 3주 요청 -> 여유 1주만 체결(3+1=4)
    expect(st.posSize).toBe(4);
    expect(st.entryCount).toBe(2);
    expect(st.posAvgPrice).toBeCloseTo((10 * 3 + 11 * 1) / 4, 10);
  });

  it("blocks a pyramiding add-on entirely once the position already sits at the cap", () => {
    const st = new StrategyState();
    st.configure(1, 5);
    st.setMaxPositionSize(3);
    st.entry("A", "long", 3);
    st.processFills(10, undefined, undefined, 0); // 한도까지 정확히 체결
    expect(st.posSize).toBe(3);
    st.entry("B", "long", 2);
    st.processFills(11, undefined, undefined, 1); // 여유 0 -> 완전 차단
    expect(st.posSize).toBe(3);
    expect(st.entryCount).toBe(1);
  });

  it("a reversal still fully closes the opposite position even when the new leg gets reduced by the cap", () => {
    const st = new StrategyState();
    st.setMaxPositionSize(2);
    st.entry("L", "long", 10);
    st.processFills(10, undefined, undefined, 0); // 한도(2)까지만 체결
    expect(st.posSize).toBe(2);
    st.entry("S", "short", 5);
    st.processFills(15, undefined, undefined, 1); // 롱 전량(2) 청산 -> 숏 신규 오픈, 5주 요청 -> 한도 2로 축소
    expect(st.posSize).toBe(-2);
    expect(st.closedTrades).toBe(1);
    expect(st.closedTradeProfit(0)).toBe(10); // (15-10)*2
  });

  it("caps to zero when maxPositionSizeValue itself is non-positive, blocking every new/pyramiding fill", () => {
    const st = new StrategyState();
    st.setMaxPositionSize(0);
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    expect(st.posSize).toBe(0);
  });

  it("order() netting is NOT capped by max_position_size — this restriction is documented as strategy.entry-specific only", () => {
    const st = new StrategyState();
    st.setMaxPositionSize(1); // entry()라면 즉시 축소됐을 값
    st.order("S", "short", 5);
    st.processFills(10, undefined, undefined, 0);
    expect(st.posSize).toBe(-5); // entry()와 달리 order()는 영향받지 않음(범위 밖 명시)
  });
});

describe("strategy.risk.max_position_size analyzer validation (C324)", () => {
  it("accepts a positional value argument", () => {
    expect(transpile('strategy("s")\nstrategy.risk.max_position_size(1000000)').ok).toBe(true);
  });

  it("accepts a non-literal (runtime-computed) value expression, matching wild usage (975a339fc540.pine)", () => {
    expect(
      transpile('strategy("s")\nsafety = true\nstrategy.risk.max_position_size(safety ? 10 : 9999999999999999)').ok,
    ).toBe(true);
  });

  it("accepts strategy.risk.max_position_size without a strategy() declaration (C771)", () => {
    expect(transpile("strategy.risk.max_position_size(1000)").ok).toBe(true);
  });

  it("rejects value-position use (assignment) — void-returning bare statement only", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.risk.max_position_size(1000)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("rejects wrong arg count (0 or 2 positional — qty_type unsupported)", () => {
    const errors0 = transpileErrors('strategy("s")\nstrategy.risk.max_position_size()');
    expect(errors0.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nstrategy.risk.max_position_size(1000, strategy.fixed)');
    expect(errors2.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
  });

  it("rejects a value= keyword argument (positional-only, unlike max_intraday_loss/max_drawdown)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.risk.max_position_size(value = 1000)');
    expect(errors.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
  });
});

describe("strategy.risk.max_position_size codegen emission (C324)", () => {
  it("emits $.strategy.setMaxPositionSize(...) for a positional value", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_position_size(1000000)');
    expect(code).toContain("$.strategy.setMaxPositionSize(1000000)");
  });
});

describe("strategy.* E2E (hand-verified: strategy.risk.max_position_size 수량 축소, C324)", () => {
  // 손 계산 시나리오(마켓 entry, 다음 바 open 체결, pyramiding=5로 그 게이트와 격리):
  //   bar0(n=1): entry("1", long, 3) 큐잉. 아직 flat.
  //   bar1(n=2): open 10 체결 -> 3주 요청, 한도(4) 이내라 그대로 3주. entry("2", long, 3) 큐잉.
  //   bar2(n=3): entry("2") 체결 시도 -> 3주 요청하나 여유 1주뿐(4-3=1) -> 1주만 추가 체결(총 4주).
  //   bar3(n=4): 신규 신호 없음 -> 4주 유지(이미 한도).
  const data: OHLCVData = {
    open: [10, 10, 11, 12],
    high: [10.5, 10.5, 11.5, 12.5],
    low: [9.5, 9.5, 10.5, 11.5],
    close: [10, 10, 11, 12],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s", pyramiding = 5)',
    "strategy.risk.max_position_size(4)",
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("1", strategy.long, 3)',
    "if n == 2",
    '    strategy.entry("2", strategy.long, 3)',
    "var float __obs_pos = na",
    "__obs_pos := strategy.position_size",
  ].join("\n");

  it("reduces pyramiding fills so the position never exceeds the configured cap", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_pos"])).toEqual([0, 3, 4, 4]);
  });
});

// ── C325: next_hint(C324) 신규 발견 — strategy.risk.max_cons_loss_days(count), strategy.risk.* 6종
// (allow_entry_in/max_intraday_filled_orders/max_drawdown/max_intraday_loss/max_position_size/
// max_cons_loss_days) 중 마지막 미구현 형제. pine2py에 대응 구현이 전혀 없어(형제들과 동일 근거)
// 전부 hand-verified 신규 설계, "TV 미검증(가설)": wild 코퍼스 자신에 포함된 TV 문서 발췌
// (86e04be3ab6c.pine DESCRIPTION:: "A strategy-wide rule that stops all trading (cancels pending
// orders, closes open positions) if the specified count of consecutive days end with a loss.")가
// 근거. max_drawdown(이름에 "intraday" 없음)과 동일 축으로 판단해 **영구** 래치(거래일 경계에서
// 리셋되지 않음) — max_intraday_loss류 "거래일마다 리셋"과 다르다. "거래일이 손실로 끝났는가"는
// 그 거래일이 끝나는(다음 거래일로 전환되는) 시점의 realizedPnl 변화량으로 판정한다(이 세션은
// 웹 접근이 없어 1차 검증 불가 — P3 TV 골든 실험 대상, DIVERGENCES 참조).
const C325_DAY1 = Date.UTC(2024, 0, 1);
const C325_DAY2 = Date.UTC(2024, 0, 2);
const C325_DAY3 = Date.UTC(2024, 0, 3);

describe("StrategyState.setMaxConsLossDays/entry() 연속 손실일 게이트 (C325, hand-verified)", () => {
  it("defaults to unrestricted (NaN) — entry() fills normally without calling setMaxConsLossDays", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10, undefined, undefined, 0, C325_DAY1);
    expect(st.posSize).toBe(1);
  });

  it("blocks a new entry once a single losing trading day reaches the configured streak (count=1)", () => {
    const st = new StrategyState();
    st.configure(1, 5); // pyramiding 여유로 그 게이트와 격리
    st.setMaxConsLossDays(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C325_DAY1); // day1 시드 + 롱 1주 오픈
    st.close("A");
    st.processFills(9, undefined, undefined, 1, C325_DAY1); // 같은 날 청산 -> 실현손실 -1
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 2, C325_DAY2); // day1->day2 전환: day1 pnl=-1<0 -> 스트릭 1>=1 -> 래치, B 차단
    expect(st.posSize).toBe(0);
    expect(st.entryCount).toBe(0);
  });

  it("does not trigger on a winning trading day — the streak resets instead of accumulating", () => {
    const st = new StrategyState();
    st.configure(1, 5);
    st.setMaxConsLossDays(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C325_DAY1); // day1 시드 + 롱 1주 오픈
    st.close("A");
    st.processFills(11, undefined, undefined, 1, C325_DAY1); // 같은 날 청산 -> 실현이익 +1
    st.entry("B", "long", 1);
    st.processFills(12, undefined, undefined, 2, C325_DAY2); // day1 pnl=+1>=0 -> 스트릭 리셋, B 정상 체결
    expect(st.posSize).toBe(1);
  });

  it("requires the configured number of CONSECUTIVE losing days before latching (count=2)", () => {
    const st = new StrategyState();
    st.configure(1, 5);
    st.setMaxConsLossDays(2);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C325_DAY1); // day1 시드 + 오픈
    st.close("A");
    st.processFills(9, undefined, undefined, 1, C325_DAY1); // day1 손실 -1
    st.entry("B", "long", 1);
    st.processFills(9, undefined, undefined, 2, C325_DAY2); // day1->day2: 스트릭 1(<2, 아직 차단 안 됨) -> B 체결
    expect(st.posSize).toBe(1);
    st.close("B");
    st.processFills(8, undefined, undefined, 3, C325_DAY2); // day2 손실 -1(같은 날)
    st.entry("C", "long", 1);
    st.processFills(7, undefined, undefined, 4, C325_DAY3); // day2->day3: 스트릭 2>=2 -> 래치, C 차단
    expect(st.posSize).toBe(0);
    expect(st.entryCount).toBe(0);
  });

  it("still allows closing an existing position once the limit is reached", () => {
    const st = new StrategyState();
    st.setMaxConsLossDays(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C325_DAY1); // day1 시드 + 오픈
    st.close("A");
    st.processFills(9, undefined, undefined, 1, C325_DAY1); // day1 손실 -1
    st.entry("B", "long", 1);
    st.processFills(9, undefined, undefined, 2, C325_DAY2); // day1->day2 전환 -> 래치, B 차단(reject)
    expect(st.posSize).toBe(0);
    // 래치 이후에도 청산(close)은 게이트 대상이 아니다 — 여기선 이미 flat이라 no-op 검증 대신
    // 별도 포지션으로 확인.
    const st2 = new StrategyState();
    st2.setMaxConsLossDays(1);
    st2.entry("A", "long", 1);
    st2.processFills(10, undefined, undefined, 0, C325_DAY1);
    st2.close("A");
    st2.processFills(9, undefined, undefined, 1, C325_DAY1); // 손실 -1, day1
    st2.entry("B", "long", 1);
    st2.processFills(9, undefined, undefined, 2, C325_DAY2); // 래치 -> B 차단(청산 전용만 허용)
    // 래치 후에도 order()로 직접 낸 넷팅 주문(entry 게이트 밖)은 정상 체결됨을 별도 확인
    st2.order("C", "long", 1);
    st2.processFills(9, undefined, undefined, 3, C325_DAY2);
    expect(st2.posSize).toBe(1); // order()는 이 게이트 영향 밖(아래 별도 테스트와 동일 원칙)
  });

  it("a limit-reached reversal closes the existing opposite position but does not reopen (REMARKS 근거, allow_entry_in과 동일 패턴)", () => {
    const st = new StrategyState();
    st.setMaxConsLossDays(1);
    st.entry("A", "long", 2);
    st.processFills(10, undefined, undefined, 0, C325_DAY1); // day1 시드 + 롱 2주 오픈
    st.close("A");
    st.processFills(9, undefined, undefined, 1, C325_DAY1); // day1 손실 -2
    st.entry("S", "short", 1);
    st.processFills(15, undefined, undefined, 2, C325_DAY2); // day1->day2 전환 -> 래치 -> 청산only(리버스 취소)
    expect(st.posSize).toBe(0);
  });

  it("without a barTimeMs channel (legacy call form) the day transition never fires — the streak never advances", () => {
    const st = new StrategyState();
    st.setMaxConsLossDays(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0); // barTimeMs 생략(NaN) — day-key 전환 자체가 없음
    st.close("A");
    st.processFills(9, undefined, undefined, 1); // 손실 발생하나 day 전환이 없어 스트릭 평가 자체가 없음
    st.entry("B", "long", 1);
    st.processFills(11, undefined, undefined, 2); // 래치가 걸릴 수 없음 -> 정상 체결
    expect(st.posSize).toBe(1);
  });

  it("order() netting is NOT gated by max_cons_loss_days — this restriction is documented as strategy.entry-specific only", () => {
    const st = new StrategyState();
    st.setMaxConsLossDays(1);
    st.entry("A", "long", 1);
    st.processFills(10, undefined, undefined, 0, C325_DAY1);
    st.close("A");
    st.processFills(9, undefined, undefined, 1, C325_DAY1); // day1 손실
    st.order("S", "short", 1);
    st.processFills(9, undefined, undefined, 2, C325_DAY2); // 래치가 걸려도 order()는 영향받지 않음
    expect(st.posSize).toBe(-1);
  });
});

describe("strategy.risk.max_cons_loss_days analyzer validation (C325)", () => {
  it("accepts a positional count argument", () => {
    expect(transpile('strategy("s")\nstrategy.risk.max_cons_loss_days(3)').ok).toBe(true);
  });

  it("accepts a non-literal (runtime-computed) value expression, matching wild usage (975a339fc540.pine)", () => {
    expect(
      transpile('strategy("s")\nsafety = true\nstrategy.risk.max_cons_loss_days(safety ? 3 : 9999999999999999)').ok,
    ).toBe(true);
  });

  it("accepts strategy.risk.max_cons_loss_days without a strategy() declaration (C771)", () => {
    expect(transpile("strategy.risk.max_cons_loss_days(3)").ok).toBe(true);
  });

  it("rejects value-position use (assignment) — void-returning bare statement only", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.risk.max_cons_loss_days(3)');
    expect(errors.some((e) => e.includes("only supported in statement position"))).toBe(true);
  });

  it("rejects wrong arg count (0 or 2 positional)", () => {
    const errors0 = transpileErrors('strategy("s")\nstrategy.risk.max_cons_loss_days()');
    expect(errors0.some((e) => e.includes("requires 1 (count, positional only)"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nstrategy.risk.max_cons_loss_days(3, "msg")');
    expect(errors2.some((e) => e.includes("requires 1 (count, positional only)"))).toBe(true);
  });

  it("rejects a count= keyword argument (positional-only, unlike max_intraday_filled_orders)", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.risk.max_cons_loss_days(count = 3)');
    expect(errors.some((e) => e.includes("requires 1 (count, positional only)"))).toBe(true);
  });
});

describe("strategy.risk.max_cons_loss_days codegen emission (C325)", () => {
  it("emits $.strategy.setMaxConsLossDays(...) for a positional count", () => {
    const code = transpileCode('strategy("s")\nstrategy.risk.max_cons_loss_days(3)');
    expect(code).toContain("$.strategy.setMaxConsLossDays(3)");
  });
});

describe("strategy.* E2E (hand-verified: strategy.risk.max_cons_loss_days 연속 손실일 게이트, C325)", () => {
  // 손 계산 시나리오(마켓 entry, 다음 바 open 체결, count=1 -> 한 번의 손실 거래일만으로 즉시 래치):
  //   bar0(idx0, day D1): entry("1", long, 1) 큐잉. 아직 flat.
  //   bar1(idx1, day D1): open 10 체결 -> 롱 1주 @10(day D1 시드는 이 전환에서 이미 완료).
  //                       같은 바에서 exit(loss=1) 큐잉.
  //   bar2(idx2, day D1): 손절 체결 @9 -> 실현손실 -1(같은 날, 아직 전환 없음). entry("2") 큐잉.
  //   bar3(idx3, day D2): day D1->D2 전환 -> day1 pnl=-1<0 -> 스트릭 1>=1 -> 래치. entry("2") 체결 시도 -> 차단.
  const data: OHLCVData = {
    open: [10, 10, 9, 11],
    high: [10.5, 10.5, 9.5, 11.5],
    low: [9.5, 9.5, 8.5, 10.5],
    close: [10, 10, 9, 11],
    volume: [100, 100, 100, 100],
    time: [C325_DAY1, C325_DAY1, C325_DAY1, C325_DAY2],
  };
  const src = [
    'strategy("s")',
    "strategy.risk.max_cons_loss_days(1)",
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("1", strategy.long, 1)',
    "if n == 2",
    '    strategy.close("1")',
    "if n == 3",
    '    strategy.entry("2", strategy.long, 1)',
    "var float __obs_pos = na",
    "__obs_pos := strategy.position_size",
  ].join("\n");

  it("latches after a single losing trading day and blocks the next day's new entry", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_pos"])).toEqual([0, 1, 0, 0]);
  });
});

// ── strategy.exit/close qty_percent= (hand-verified, C373) ──
// pine2py exit()/close() 둘 다 **kwargs로 받아 조용히 버리는 파라미터(engine.py L141-153/197-203,
// python 소스 확인) — trail_price=/profit=/loss=(C178/hand-verified)와 동일한 "오라클 불가,
// hand-verified" 축. TV 문서 규칙 "qty_percent 우선순위는 qty보다 낮음"을 그대로 이식: qty가
// 명시되면 qty_percent는 완전히 무시되고, qty 생략 시에만 이 호출 시점(콜타임)의
// |posSize|*percent/100을 절대 수량으로 계산해 기존 qty= 부분청산 슬롯(closeQty/exitQty, C168)에
// 그대로 태운다 — closeAt 등 하위 체결 로직은 절대값 qty만 보므로 변경 불필요.
describe("StrategyState exit/close qty_percent= (hand-verified, C373)", () => {
  it("exit: qty_percent= computes qty as |posSize|*percent/100 at call time", () => {
    const st = new StrategyState();
    st.entry("L", "long", 4);
    st.processFills(12); // 롱 4 @ 12
    st.exit("X", "", 15, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 50); // limit=15, qty_percent=50 -> qty=2
    st.processFills(13, 16, 12.5); // high 16 >= 15 -> 15 체결, qty 2(부분)
    expect(st.posSize).toBe(2); // 4-2 잔여
    expect(st.posAvgPrice).toBe(12); // 부분 청산은 잔여 포지션 avg 유지
    expect(st.realizedPnl).toBe(6); // (15-12)*2
  });

  it("exit: explicit qty= takes priority over qty_percent= (TV 우선순위 규칙, qty_percent 완전 무시)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 4);
    st.processFills(12);
    st.exit("X", "", 15, undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined, 50); // qty=1 우선
    st.processFills(13, 16, 12.5);
    expect(st.posSize).toBe(3); // 4-1
    expect(st.realizedPnl).toBe(3); // (15-12)*1
  });

  it("close: qty_percent= computes qty as |posSize|*percent/100 at call time", () => {
    const st = new StrategyState();
    st.entry("L", "long", 4);
    st.processFills(12); // 롱 4 @ 12
    st.close("L", undefined, undefined, undefined, 50); // qty_percent=50 -> qty=2(콜타임 posSize=4 기준)
    st.processFills(13); // 다음 바 open 13에서 청산 체결
    expect(st.posSize).toBe(2); // 4-2 잔여
    expect(st.posAvgPrice).toBe(12);
    expect(st.realizedPnl).toBe(2); // (13-12)*2
  });

  it("close: explicit qty= takes priority over qty_percent= (qty_percent 완전 무시)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 4);
    st.processFills(12);
    st.close("L", 1, undefined, undefined, 50); // qty=1 우선
    st.processFills(13);
    expect(st.posSize).toBe(3); // 4-1
    expect(st.realizedPnl).toBe(1); // (13-12)*1
  });
});

describe("strategy.exit/close qty_percent= analyzer validation (hand-verified, C373)", () => {
  it("accepts strategy.exit qty_percent= combined with a real exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, qty_percent=50)')).toEqual([]);
  });

  it("accepts strategy.close qty_percent=", () => {
    expect(transpileErrors('strategy("s")\nstrategy.close("L", qty_percent=50)')).toEqual([]);
  });

  it("rejects duplicate qty_percent= on strategy.exit", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, qty_percent=50, qty_percent=60)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'qty_percent'"))).toBe(true);
  });

  it("rejects duplicate qty_percent= on strategy.close", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.close("L", qty_percent=50, qty_percent=60)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'qty_percent'"))).toBe(true);
  });
});

describe("strategy.exit/close qty_percent= codegen emission (hand-verified, C373)", () => {
  it("lowers qty_percent= to the 12th slot on strategy.exit (past loss)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2, qty_percent=50)');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, undefined, 50);',
    );
  });

  it("lowers qty_percent= to the 5th slot on strategy.close (past when)", () => {
    const code = transpileCode('strategy("s")\nstrategy.close("L", qty_percent=50)');
    expect(code).toContain('$.strategy.close("L", undefined, undefined, undefined, 50);');
  });
});

// ── strategy.exit comment_loss=/comment_profit= (hand-verified, C375) ──
// wild named-list kwarg 클러스터 최다빈도(51건, comment_loss 25~26 + comment_profit 25~26) —
// 착수 전 pine2py wavealgo/strategy/engine.py exit()(L141-153) python 소스 확인: 이 두 이름은
// 시그니처에 없고 **kwargs로 조용히 버려진다(조건부 선택 로직 자체가 pine2py에 없음). TV 시그니처는
// comment=의 트리거별 오버라이드다: 이 청산이 stop=/loss=(또는 트레일링)로 발생하면 comment_loss=가,
// limit=/profit=로 발생하면 comment_profit=가 comment=보다 우선(둘 다 na=미지정이면 comment=로
// 폴백). alert_message(C374)와 달리 comment=는 이미 exitOrderComment/closedtrades.exit_comment
// (C173)로 실소비되는 값이라 순수 discard 대신 실제 조건부 선택을 구현한다(MEMORY C147 원칙).
// comment_trailing=(TV의 세 번째 축, 트레일링 전용 오버라이드)은 C673에서 별도 구현(아래
// "comment_trailing=" 전용 describe 블록 참조) — 이 블록의 테스트는 comment_trailing 미지정
// 시나리오만 다룬다.
describe("StrategyState exit comment_loss=/comment_profit= (hand-verified, C375)", () => {
  it("stop-triggered fill uses comment_loss over the base comment", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12); // 롱 1@12
    st.exit("X", "", undefined, 10, undefined, undefined, undefined, "base", undefined, undefined, undefined, undefined, "SL", "TP");
    st.processFills(11, 11.5, 9); // low 9<=10(stop) -> 10 체결
    expect(st.posSize).toBe(0);
    expect(st.lastClosedExitComment).toBe("SL");
  });

  it("limit-triggered fill uses comment_profit over the base comment", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    st.exit("X", "", 15, undefined, undefined, undefined, undefined, "base", undefined, undefined, undefined, undefined, "SL", "TP");
    st.processFills(13, 16, 12.5); // high 16>=15(limit) -> 15 체결
    expect(st.lastClosedExitComment).toBe("TP");
  });

  it("falls back to the base comment when comment_loss/comment_profit are not specified", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    st.exit("X", "", 15, 10, undefined, undefined, undefined, "base"); // comment_loss/profit 생략
    st.processFills(13, 16, 12.5); // limit 체결이지만 comment_profit 미지정 -> base로 폴백
    expect(st.lastClosedExitComment).toBe("base");
  });

  it("falls back to the base comment on a purely trailing-stop fill when comment_trailing is not specified", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    // trail_points=1(stop=/limit= 없음) — comment_loss가 지정돼도 순수 트레일링 체결엔 안 붙는다
    // (comment_trailing= 미지정이라 C673 오버라이드도 적용 안 됨 — 아래 별도 describe 참조).
    st.exit("X", "", undefined, undefined, undefined, 1, undefined, "base", undefined, undefined, undefined, undefined, "SL", "TP");
    st.processFills(13, 15, 14); // high 15 활성화(avg12+1=13<=15) -> 라인=15-1=14, low 14<=14 -> 트레일 체결
    expect(st.lastClosedExitComment).toBe("base");
  });

  it("same-id modify updates comment_loss/comment_profit (C170 재호출 관례와 동일)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    st.exit("X", "", 15, 10, undefined, undefined, undefined, "base", undefined, undefined, undefined, undefined, "SL1", "TP1");
    st.exit("X", "", 15, 10, undefined, undefined, undefined, "base", undefined, undefined, undefined, undefined, "SL2", "TP2"); // 같은 id 재호출 = 수정
    st.processFills(11, 11.5, 9); // stop 체결
    expect(st.lastClosedExitComment).toBe("SL2");
  });
});

describe("strategy.exit comment_loss=/comment_profit= analyzer validation (hand-verified, C375)", () => {
  it("accepts comment_loss= combined with a real exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", stop=10, comment_loss="SL")')).toEqual([]);
  });

  it("accepts comment_profit= combined with a real exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, comment_profit="TP")')).toEqual([]);
  });

  it("accepts comment=/comment_loss=/comment_profit= all combined", () => {
    expect(
      transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, stop=10, comment="base", comment_loss="SL", comment_profit="TP")'),
    ).toEqual([]);
  });

  // C723(배치37 지시 (1)): 청산 조건 0개 하드 에러 제거 — runtime no-op 가드로 안전하게 흡수.
  it("comment_loss=/comment_profit= alone accepted as a no-op exit call (C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", comment_loss="SL", comment_profit="TP")')).toEqual([]);
  });

  it("rejects duplicate comment_loss=", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", stop=10, comment_loss="a", comment_loss="b")');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'comment_loss'"))).toBe(true);
  });

  it("rejects duplicate comment_profit=", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, comment_profit="a", comment_profit="b")');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'comment_profit'"))).toBe(true);
  });
});

describe("strategy.exit comment_loss=/comment_profit= codegen emission (hand-verified, C375)", () => {
  it("lowers comment_loss= to the 12th slot (past qty_percent)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2, comment_loss="SL")');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, undefined, undefined, "SL");',
    );
  });

  it("lowers comment_profit= to the 13th slot (past comment_loss)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2, comment_profit="TP")');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, undefined, undefined, undefined, "TP");',
    );
  });

  it("combines comment_loss=/comment_profit= (slots 12~13, no gap between them)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2, comment_loss="SL", comment_profit="TP")');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, undefined, undefined, "SL", "TP");',
    );
  });
});

describe("strategy.* E2E comment_loss=/comment_profit= (hand-verified, C375: 전체 파이프라인 stop 트리거 선택)", () => {
  // 손 계산 시나리오 (limit=20/stop=10 브래킷, comment="base"/comment_loss="SL"/comment_profit="TP"):
  //   bar0: O=10 C=11 양봉&flat -> entry("L") 큐잉. closedTrades=0 -> xc=""
  //   bar1: O=12 -> 롱 1@12 체결(avg=12). exit 등록(limit=20/stop=10). closedTrades=0 -> xc=""
  //   bar2: O=11 H=11.5 L=9 -> low 9<=10(stop) -> 10 체결(loss 축) -> exit_comment="SL"
  //   bar3: flat 유지 -> xc 그대로("SL")
  const data: OHLCVData = {
    open: [10, 12, 11, 11],
    high: [12, 13, 11.5, 11.5],
    low: [9, 11, 9, 9],
    close: [11, 12.5, 10.5, 10.5],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", limit=20, stop=10, comment="base", comment_loss="SL", comment_profit="TP")',
    "var string __obs_xc = na",
    "__obs_xc := strategy.closedtrades.exit_comment(strategy.closedtrades - 1)",
  ].join("\n");

  it("stop-triggered exit picks comment_loss over the base comment through the full pipeline", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_xc"])).toEqual(["", "", "SL", "SL"]);
  });
});

// ── strategy.exit when= (hand-verified, C380) ──
// pine2py wavealgo/strategy/engine.py exit(..., when: bool=True, **kwargs)가 when을 실제 named
// parameter로 받아 `if not when: return`로 함수 최상단에서 게이팅함을 python 소스로 직접 확인
// (L167). entry/order(C372)/close(C293)/close_all(C378)에 이미 이식된 동일 게이트를 exit에 마저
// 적용 — 청산 조건(hasExitCondition)에는 포함되지 않는 독립 축.
describe("StrategyState exit when= gate (hand-verified, C380)", () => {
  it("exit registers no pending order when when=false", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10); // 롱 1@10
    st.exit(
      "X", "", 15, 10, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, false,
    );
    expect(st.exitPending).toBe(false);
    st.processFills(11, 20, 5); // stop=10/limit=15 둘 다 트리거 가능한 레인지지만 주문 자체가 없음
    expect(st.posSize).toBe(1); // 여전히 롱
  });

  it("exit fills normally when when=true (explicit and omitted are equivalent)", () => {
    const stExplicit = new StrategyState();
    stExplicit.entry("A", "long", 1);
    stExplicit.processFills(10);
    stExplicit.exit(
      "X", "", 15, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, true,
    );
    stExplicit.processFills(11, 16, 9); // high 16>=15(limit) -> 15 체결
    expect(stExplicit.posSize).toBe(0);

    const stOmitted = new StrategyState();
    stOmitted.entry("A", "long", 1);
    stOmitted.processFills(10);
    stOmitted.exit("X", "", 15); // when 생략 -> 기본값 true
    stOmitted.processFills(11, 16, 9);
    expect(stOmitted.posSize).toBe(0);
  });

  it("same-id modify with when=false still overwrites the pending order fields (C170 재호출 관례와 동일)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10);
    st.exit(
      "X", "", 15, 10, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, true,
    );
    st.exit(
      "X", "", 15, 10, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, false,
    ); // when=false는 최상단에서 조기 반환 -> 이 두 번째 호출 자체가 무시됨(수정 없음)
    st.processFills(11, 20, 5); // 첫 등록(when=true)이 그대로 살아있어 stop=10 체결
    expect(st.posSize).toBe(0);
  });
});

describe("strategy.exit when= analyzer validation (hand-verified, C380)", () => {
  it("accepts strategy.exit when= kwarg combined with a real exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, when=close>open)')).toEqual([]);
  });

  // C723(배치37 지시 (1)): 청산 조건 0개 하드 에러 제거 — runtime no-op 가드로 안전하게 흡수.
  it("when= alone accepted as a no-op exit call (C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", when=true)')).toEqual([]);
  });

  it("rejects duplicate when= on strategy.exit", () => {
    const errors = transpileErrors('strategy("s")\nstrategy.exit("X", limit=15, when=true, when=false)');
    expect(errors.some((e) => e.includes("duplicate keyword argument 'when'"))).toBe(true);
  });
});

describe("strategy.exit when= codegen emission (hand-verified, C380)", () => {
  it("lowers when= to the 14th slot on strategy.exit (past comment_profit)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", profit=2, when=true)');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 2, undefined, undefined, undefined, undefined, true);',
    );
  });
});

// ── strategy.exit comment_trailing= (hand-verified, C673) ──
// #146(C375)이 범위 밖으로 남겨둔 comment=의 세 번째 트리거별 오버라이드 축(next_hint(C672) —
// wild 12파일, hist-stateful 잔여 11건 중 4건이 이 갭 단독 차단). exitFillPrice()가 순수 트레일링
// 라인 체결(stop=/limit= 어느 쪽도 결정하지 않음)일 때 남기는 exitFillKind===null을 신호로,
// comment_loss=/comment_profit=와 완전히 동일한 "미지정(null)이면 comment=로 폴백" 규약 적용.
describe("StrategyState exit comment_trailing= (hand-verified, C673)", () => {
  it("pure trailing-stop fill uses comment_trailing over the base comment", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12); // 롱 1@12
    st.exit(
      "X", "", undefined, undefined, undefined, 1, undefined, "base", undefined,
      undefined, undefined, undefined, undefined, undefined, true, "TR",
    );
    st.processFills(13, 15, 14); // high 15 활성화(avg12+1=13<=15) -> 라인=15-1=14, low 14<=14 -> 트레일 체결
    expect(st.posSize).toBe(0);
    expect(st.lastClosedExitComment).toBe("TR");
  });

  it("does not apply to a stop-triggered fill (only exitFillKind===null, not the loss axis)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    st.exit(
      "X", "", undefined, 10, undefined, undefined, undefined, "base", undefined,
      undefined, undefined, undefined, undefined, undefined, true, "TR",
    );
    st.processFills(11, 11.5, 9); // low 9<=10(stop) -> 10 체결(loss 축, comment_trailing 무관)
    expect(st.lastClosedExitComment).toBe("base");
  });

  it("same-id modify updates comment_trailing (C170 재호출 관례와 동일)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(12);
    st.exit(
      "X", "", undefined, undefined, undefined, 1, undefined, "base", undefined,
      undefined, undefined, undefined, undefined, undefined, true, "TR1",
    );
    st.exit(
      "X", "", undefined, undefined, undefined, 1, undefined, "base", undefined,
      undefined, undefined, undefined, undefined, undefined, true, "TR2",
    ); // 같은 id 재호출 = 수정
    st.processFills(13, 15, 14); // 트레일 체결
    expect(st.lastClosedExitComment).toBe("TR2");
  });
});

describe("strategy.exit comment_trailing= analyzer validation (hand-verified, C673)", () => {
  it("accepts comment_trailing= combined with a real exit condition", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", trail_points=1, comment_trailing="TR")')).toEqual([]);
  });

  // C723(배치37 지시 (1)): 청산 조건 0개 하드 에러 제거 — runtime no-op 가드로 안전하게 흡수.
  it("comment_trailing= alone accepted as a no-op exit call (C723)", () => {
    expect(transpileErrors('strategy("s")\nstrategy.exit("X", comment_trailing="TR")')).toEqual([]);
  });

  it("rejects duplicate comment_trailing=", () => {
    const errors = transpileErrors(
      'strategy("s")\nstrategy.exit("X", trail_points=1, comment_trailing="a", comment_trailing="b")',
    );
    expect(errors.some((e) => e.includes("duplicate keyword argument 'comment_trailing'"))).toBe(true);
  });
});

describe("strategy.exit comment_trailing= codegen emission (hand-verified, C673)", () => {
  it("lowers comment_trailing= to the 15th slot on strategy.exit (past when=)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", trail_points=1, comment_trailing="TR")');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "TR");',
    );
  });

  it("combines comment_trailing= with when= (slots 14~15, no gap)", () => {
    const code = transpileCode('strategy("s")\nstrategy.exit("X", trail_points=1, when=true, comment_trailing="TR")');
    expect(code).toContain(
      '$.strategy.exit("X", undefined, undefined, undefined, undefined, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true, "TR");',
    );
  });
});

describe("strategy.* E2E comment_trailing= (hand-verified, C673: 전체 파이프라인 순수 트레일링 체결 선택)", () => {
  // 손 계산 시나리오(trail_points=1 단독, comment="base"/comment_trailing="TR"):
  //   bar0: O=10 C=11 양봉&flat -> entry("L") 큐잉. closedTrades=0 -> xc=""
  //   bar1: O=12 -> 롱 1@12 체결(avg=12). exit 등록(trail_points=1). closedTrades=0 -> xc=""
  //   bar2: O=13 H=15 L=14 -> high 15 활성화(avg12+1=13<=15) -> 라인=15-1=14, low 14<=14 -> 14 체결
  //         (exitFillKind=null, 순수 트레일링) -> exit_comment="TR"
  //   bar3: flat 유지 -> xc 그대로("TR")
  const data: OHLCVData = {
    open: [10, 12, 13, 13],
    high: [12, 13, 15, 15],
    low: [9, 11, 14, 14],
    close: [11, 12.5, 14.5, 14.5],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 1)',
    "if strategy.position_size > 0",
    '    strategy.exit("X", trail_points=1, comment="base", comment_trailing="TR")',
    "var string __obs_xc = na",
    "__obs_xc := strategy.closedtrades.exit_comment(strategy.closedtrades - 1)",
  ].join("\n");

  it("pure trailing exit picks comment_trailing over the base comment through the full pipeline", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_xc"])).toEqual(["", "", "TR", "TR"]);
  });
});

// ── C429: next_hint(C428) 최우선 3종(syminfo.ticker/strategy.default_entry_qty/ac.package) 실측 —
// ac.package는 dead-end(import boitoki/AwesomeColor as ac, 진짜 외부 library alias 축 C361 재발현).
// syminfo.ticker(sym)/strategy.default_entry_qty(price) 둘 다 pine2py에 대응 구현이 전혀 없는
// 진짜 갭(engine.py grep 0건)으로 확정됐으나 이번 슬라이스는 strategy.default_entry_qty만 착수
// (syminfo.ticker는 다음 사이클 후보로 next_hint 인계 — 서로 다른 메커니즘이라 묶지 않음, ROADMAP
// "소형 클러스터 묶음 규칙"은 동일 메커니즘 한정). entry/order/exit/close 계열(위 void 전용 분기)과
// 달리 이 콜은 **값을 반환**해 표현식 위치에서 쓰인다(wild 실사용: `qty = strategy.default_entry_qty(close)`
// / `qty1 * strategy.default_entry_qty(close) / qtySum`, 6de0a0bcfa4d.pine/79126db3910e.pine) —
// hand-verified 신규 설계, "TV 미검증(가설)": entry()/order()의 qty 생략 시 실제로 쓰일 기본 수량을
// 그대로 반환한다고 알려져 있다. qty_type이 percent_of_equity/cash면 price 인자로 환산(기존
// autoQtyAt/autoQtyCashAt 재사용 — entry/order 체결 시점의 qtyAuto 해석과 완전히 동일한 3-way
// 분류), fixed(기본)면 price 인자와 무관하게 defaultQty 그대로.
describe("StrategyState.defaultEntryQty (C429, hand-verified)", () => {
  it("fixed (default qty_type): returns defaultQty unchanged regardless of price", () => {
    const st = new StrategyState();
    st.configure(7, 1); // defaultQty=7, qtyIsPercent/qtyIsCash 기본 false
    expect(st.defaultEntryQty(10)).toBe(7);
    expect(st.defaultEntryQty(999)).toBe(7);
  });

  it("percent_of_equity: converts equity(price)*percent/100/price, matching autoQtyAt", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true, false); // defaultQty=50(%), initialCapital=1000, qtyIsPercent=true
    expect(st.defaultEntryQty(10)).toBeCloseTo((1000 * 50) / 100 / 10, 10); // = 50
  });

  it("percent_of_equity: reflects accumulated realized P&L in equity, not just initialCapital", () => {
    const st = new StrategyState();
    st.configure(50, 1, 1000, true, false);
    st.entry("A", "long", 10);
    st.processFills(10, undefined, undefined, 0); // bar0 open=10 -> 10주 체결
    st.close_all("", true);
    st.processFills(12, undefined, undefined, 1); // bar1 open=12 -> 전량 청산, realizedPnl += (12-10)*10 = 20
    expect(st.defaultEntryQty(10)).toBeCloseTo((1020 * 50) / 100 / 10, 10); // equity(10)=1000+20=1020 -> qty=51
  });

  it("cash: converts cashAmount/price, matching autoQtyCashAt", () => {
    const st = new StrategyState();
    st.configure(500, 1, 1000, false, true); // defaultQty=500(현금), qtyIsCash=true
    expect(st.defaultEntryQty(10)).toBe(50); // 500/10
    expect(st.defaultEntryQty(25)).toBe(20); // 500/25
  });
});

describe("strategy.default_entry_qty analyzer validation (hand-verified, C429)", () => {
  it("accepts a positional price argument in an assignment (value-returning, unlike entry/order/exit/close)", () => {
    expect(transpile('strategy("s")\nx = strategy.default_entry_qty(close)').ok).toBe(true);
  });

  it("accepts use inside an arithmetic expression, matching wild usage (79126db3910e.pine)", () => {
    expect(
      transpile(
        'strategy("s")\nqty1 = 10.0\nqtySum = 100.0\nx = qty1 * strategy.default_entry_qty(close) / qtySum',
      ).ok,
    ).toBe(true);
  });

  it("accepts strategy.default_entry_qty without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.default_entry_qty(close)").ok).toBe(true);
  });

  it("rejects wrong arg count (0 or 2 positional)", () => {
    const errors0 = transpileErrors('strategy("s")\nx = strategy.default_entry_qty()');
    expect(errors0.some((e) => e.includes("requires 1 (price, positional only)"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nx = strategy.default_entry_qty(close, open)');
    expect(errors2.some((e) => e.includes("requires 1 (price, positional only)"))).toBe(true);
  });

  it("rejects a price= keyword argument (positional-only)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.default_entry_qty(price = close)');
    expect(errors.some((e) => e.includes("requires 1 (price, positional only)"))).toBe(true);
  });
});

describe("strategy.default_entry_qty codegen emission (C429)", () => {
  it("emits $.strategy.defaultEntryQty(...) for a positional price argument", () => {
    const code = transpileCode('strategy("s")\nx = strategy.default_entry_qty(close)');
    expect(code).toContain("$.strategy.defaultEntryQty($.close.get(0))");
  });
});

describe("strategy.* E2E (hand-verified: strategy.default_entry_qty percent_of_equity, C429)", () => {
  const data: OHLCVData = {
    open: [10, 10, 10, 10],
    high: [10.5, 10.5, 10.5, 10.5],
    low: [9.5, 9.5, 9.5, 9.5],
    close: [10, 10, 10, 10],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s", default_qty_value = 50, default_qty_type = strategy.percent_of_equity, initial_capital = 1000)',
    "var float __obs_qty = na",
    "__obs_qty := strategy.default_entry_qty(close)",
  ].join("\n");

  it("computes equity(close)*50/100/close every bar with a flat position (equity == initialCapital)", () => {
    const result = runPipeline(src, data);
    // equity(10) = 1000(flat이라 손익 0) -> qty = 1000*50/100/10 = 50, 매 바 동일(포지션 미변화)
    expect(result.bars.map((b) => b["var:__obs_qty"])).toEqual([50, 50, 50, 50]);
  });
});

// strategy.convert_to_account/convert_to_symbol(value)(C763, wild "지원하지 않는 호출" 클러스터
// 조사 중 발견 — 71c737f124fa/a13576d18571/920ce88077b5.pine 3건 전부 currency= 없이 사용) —
// pine2py에 대응 구현이 없고 FX 레이트 데이터 자체가 없어 currency= 미지정(전략/계좌 통화 동일)
// 항등 단순화(hand-verified, 위 call-expr.ts 분기 주석 참조).
describe("strategy.convert_to_account/convert_to_symbol analyzer validation (hand-verified, C763)", () => {
  it("accepts a positional value argument in an assignment (value-returning like default_entry_qty)", () => {
    expect(transpile('strategy("s")\nx = strategy.convert_to_account(close)').ok).toBe(true);
    expect(transpile('strategy("s")\nx = strategy.convert_to_symbol(close)').ok).toBe(true);
  });

  it("accepts use inside an arithmetic expression, matching wild usage (71c737f124fa.pine)", () => {
    expect(
      transpile('strategy("s")\nbaseCapital = 1000.0\nriskPercent = 1.0\nx = strategy.convert_to_symbol(baseCapital * riskPercent)')
        .ok,
    ).toBe(true);
  });

  it("accepts strategy.convert_to_account/convert_to_symbol without a strategy() declaration (C771)", () => {
    expect(transpile("x = strategy.convert_to_account(close)").ok).toBe(true);
    expect(transpile("x = strategy.convert_to_symbol(close)").ok).toBe(true);
  });

  it("rejects wrong arg count (0 or 2 positional)", () => {
    const errors0 = transpileErrors('strategy("s")\nx = strategy.convert_to_account()');
    expect(errors0.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
    const errors2 = transpileErrors('strategy("s")\nx = strategy.convert_to_symbol(close, open)');
    expect(errors2.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
  });

  it("rejects a value= keyword argument (positional-only)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.convert_to_account(value = close)');
    expect(errors.some((e) => e.includes("requires 1 (value, positional only)"))).toBe(true);
  });
});

describe("strategy.convert_to_account/convert_to_symbol codegen emission (C763)", () => {
  it("emits the argument expression unchanged (identity passthrough, no runtime call)", () => {
    const codeAccount = transpileCode('strategy("s")\nx = strategy.convert_to_account(close)');
    expect(codeAccount).toContain("$.close.get(0)");
    expect(codeAccount).not.toContain("convert_to_account");
    const codeSymbol = transpileCode('strategy("s")\nx = strategy.convert_to_symbol(close)');
    expect(codeSymbol).toContain("$.close.get(0)");
    expect(codeSymbol).not.toContain("convert_to_symbol");
  });
});

describe("strategy.convert_to_account/convert_to_symbol E2E (hand-verified identity, C763)", () => {
  const data: OHLCVData = {
    open: [10, 20, 30],
    high: [10.5, 20.5, 30.5],
    low: [9.5, 19.5, 29.5],
    close: [10, 20, 30],
    volume: [100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var float __obs_a = na",
    "var float __obs_b = na",
    "__obs_a := strategy.convert_to_account(close)",
    "__obs_b := strategy.convert_to_symbol(close * 2)",
  ].join("\n");

  it("returns the input value unchanged every bar (currency= not specified, C763 simplification)", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_a"])).toEqual([10, 20, 30]);
    expect(result.bars.map((b) => b["var:__obs_b"])).toEqual([20, 40, 60]);
  });
});

describe("StrategyState.closedTradeRecords — trade_num 전 인덱스 지원 (C579, 배치28 (1) per-trade 이력 설계)", () => {
  it("keeps every closed trade retrievable by its own trade_num — index 0 stays the oldest even after later trades close", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 1);
    st.processFills(10, undefined, undefined, 0); // 트레이드 0: 롱 1 @ 10
    st.close("L1", undefined, "shut1");
    st.processFills(15, undefined, undefined, 1); // 청산 @ 15 (profit 5)
    st.entry("L2", "long", 1);
    st.processFills(20, undefined, undefined, 2); // 트레이드 1: 롱 1 @ 20
    st.close("L2", undefined, "shut2");
    st.processFills(18, undefined, undefined, 3); // 청산 @ 18 (profit -2)
    st.entry("L3", "short", 2);
    st.processFills(30, undefined, undefined, 4); // 트레이드 2: 숏 2 @ 30
    st.close("L3", undefined, "shut3");
    st.processFills(30, undefined, undefined, 5); // 청산 @ 30 (profit 0)

    expect(st.closedTrades).toBe(3);
    // trade_num 0 — 가장 오래된 트레이드, 이후 청산에도 값이 바뀌지 않는다(과거의 "최신 1건만"
    // 캐시였다면 이 시점엔 이미 트레이드 2로 덮어써져 있었을 것).
    expect(st.closedTradeEntryPrice(0)).toBe(10);
    expect(st.closedTradeExitPrice(0)).toBe(15);
    expect(st.closedTradeProfit(0)).toBe(5);
    expect(st.closedTradeExitComment(0)).toBe("shut1");
    // trade_num 1 — 중간 트레이드
    expect(st.closedTradeEntryPrice(1)).toBe(20);
    expect(st.closedTradeExitPrice(1)).toBe(18);
    expect(st.closedTradeProfit(1)).toBe(-2);
    expect(st.closedTradeSize(1)).toBe(1);
    // trade_num 2 — 가장 최근 트레이드(숏, size 음수)
    expect(st.closedTradeEntryPrice(2)).toBe(30);
    expect(st.closedTradeSize(2)).toBe(-2);
    expect(st.closedTradeProfit(2)).toBeCloseTo(0); // (30-30)*-1*2 can IEEE754 land on -0 (MEMORY.md C45), toBe(0) would fail Object.is
    expect(st.closedTradeExitComment(2)).toBe("shut3");
  });

  it("still throws outside [0, closedTrades) once history has grown past 1 trade", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.close("L1");
    st.processFills(11, undefined, undefined, 1);
    st.entry("L2", "long", 1);
    st.processFills(12, undefined, undefined, 2);
    st.close("L2");
    st.processFills(13, undefined, undefined, 3); // closedTrades=2, 유효 index는 0/1뿐
    expect(() => st.closedTradeProfit(2)).toThrow(/index 2 is out of range/);
    expect(() => st.closedTradeProfit(-1)).toThrow(/index -1 is out of range/);
  });

  it("closedTradeProfitPercent computes per-trade_num, not just the latest", () => {
    const st = new StrategyState();
    st.entry("L1", "long", 1);
    st.processFills(10, undefined, undefined, 0);
    st.close("L1");
    st.processFills(15, undefined, undefined, 1); // trade_num 0: +50%
    st.entry("L2", "long", 1);
    st.processFills(20, undefined, undefined, 2);
    st.close("L2");
    st.processFills(18, undefined, undefined, 3); // trade_num 1: -10%
    expect(st.closedTradeProfitPercent(0)).toBeCloseTo(50);
    expect(st.closedTradeProfitPercent(1)).toBeCloseTo(-10);
  });
});

describe("strategy.* E2E (hand-verified: `for i = 0 to strategy.closedtrades - 1` 전수 순회, C579 — wild 0d2164b01c94.pine 관용구)", () => {
  // wild 0d2164b01c94.pine의 실제 관용구를 그대로 재현: closedtrades > 0 가드 안에서
  // `for i = 0 to strategy.closedtrades - 1` 로 전 트레이드를 순회하며 profit(i) 부호로
  // wins/losses를 센다. 과거(최신 1건 캐시)에는 두 번째 트레이드가 청산되는 순간 이 루프가
  // index=0에서 하드 에러를 던졌다(closedTrades=2일 때 유효 index는 1뿐이었으므로).
  const data: OHLCVData = {
    open: [10, 12, 13, 20, 22, 18],
    high: [12, 13, 21, 22, 23, 19],
    low: [9, 10, 12, 19, 17, 17],
    close: [11, 11, 20, 21, 17, 18],
    volume: [100, 100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L1", strategy.long, 1)', // bar0 큐잉 -> bar1 open=12 체결
    "if n == 2",
    '    strategy.close("L1")', // bar1 큐잉 -> bar2 open=13 체결(profit=1, WIN)
    "if n == 3",
    '    strategy.entry("L2", strategy.long, 1)', // bar2 큐잉 -> bar3 open=20 체결
    "if n == 4",
    '    strategy.close("L2")', // bar3 큐잉 -> bar4 open=22 체결(profit=2, WIN)
    "var int wins = 0",
    "var int losses = 0",
    "if strategy.closedtrades > 0",
    "    wins := 0",
    "    losses := 0",
    "    for i = 0 to strategy.closedtrades - 1",
    "        if strategy.closedtrades.profit(i) > 0",
    "            wins += 1",
    "        else",
    "            losses += 1",
    "var float __obs_wins = na",
    "var float __obs_losses = na",
    "__obs_wins := wins",
    "__obs_losses := losses",
  ].join("\n");

  it("re-scans every closed trade each bar without crashing once a second trade closes, tallying wins/losses correctly", () => {
    const result = runPipeline(src, data);
    // bar0/1: closedtrades=0 -> 루프 진입 안 함(가드), wins/losses 그대로 0.
    // bar2부터: closedtrades=1(trade0 profit=13-12=1, WIN) -> wins=1,losses=0.
    // bar4부터: closedtrades=2(trade1 profit=22-20=2, WIN) -> wins=2,losses=0.
    expect(result.bars.map((b) => b["var:__obs_wins"])).toEqual([0, 0, 1, 1, 2, 2]);
    expect(result.bars.map((b) => b["var:__obs_losses"])).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

// strategy.avg_winning_trade/avg_losing_trade/avg_winning_trade_percent/avg_losing_trade_percent +
// position_entry_name + max_runup/max_runup_percent(C674, wild 배치34 7순위 'strategy속성'
// 클러스터 — pine2py에 대응 구현이 전무해 avg_*/max_runup*은 hand-verified 설계, position_entry_name만
// pine2py engine.py position_entry_name = position.entry_id(types.py 기본값 "")로 오라클 검증됨.
// strategy.oca.*(같은 클러스터 최다 서브그룹, wild 32건)는 이번 사이클 범위 밖 그대로 유지 — OCA
// 런타임 미구현이라 discard가 조용한 오답(analyzer.ts STRATEGY_RUNTIME_PROPS 주석 참조).
describe("StrategyState.closeAt — sumWinProfitPercent/sumLossProfitPercent accumulation (C674)", () => {
  it("accumulates profit_percent for a winning long trade using the same formula as closedTradeProfitPercent", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10); // 진입 10
    st.close("L");
    st.processFills(15); // 청산 15 -> profit_percent = (15-10)/10*100 = 50
    expect(st.sumWinProfitPercent).toBe(50);
    expect(st.sumLossProfitPercent).toBe(0);
  });

  it("accumulates profit_percent for a losing long trade (negative sum, mirrors grossLoss sign)", () => {
    const st = new StrategyState();
    st.entry("L", "long", 2);
    st.processFills(10);
    st.close("L");
    st.processFills(7); // profit_percent = (7-10)/10*100 = -30
    expect(st.sumLossProfitPercent).toBe(-30);
    expect(st.sumWinProfitPercent).toBe(0);
  });

  it("accumulates profit_percent for a winning short trade (direction-mirrored formula)", () => {
    const st = new StrategyState();
    st.entry("S", "short", 3);
    st.processFills(20); // 진입 20
    st.close("S");
    st.processFills(15); // profit_percent = (20-15)/20*100 = 25
    expect(st.sumWinProfitPercent).toBe(25);
  });

  it("sums percent across multiple trades (average is sum/count at the analyzer expression level)", () => {
    const st = new StrategyState();
    st.entry("A", "long", 1);
    st.processFills(10);
    st.close("A");
    st.processFills(20); // +100%
    st.entry("B", "long", 1);
    st.processFills(10);
    st.close("B");
    st.processFills(15); // +50%
    expect(st.winTrades).toBe(2);
    expect(st.sumWinProfitPercent).toBe(150);
  });

  it("does not touch either accumulator for a break-even (profit===0) trade", () => {
    const st = new StrategyState();
    st.entry("L", "long", 1);
    st.processFills(10);
    st.close("L");
    st.processFills(10);
    expect(st.evenTrades).toBe(1);
    expect(st.sumWinProfitPercent).toBe(0);
    expect(st.sumLossProfitPercent).toBe(0);
  });
});

describe("StrategyState.updateDrawdown — troughEquity/maxRunup/troughEquityAtMaxRunup mirror (C674)", () => {
  // max_drawdown의 peakEquity/peakEquityAtMaxDrawdown 스냅샷 로직을 그대로 뒤집은 대칭 축 — 위
  // "peakEquityAtMaxDrawdown snapshot (C333)" describe 블록의 시나리오를 그대로 재사용해 대칭성을 검증.
  it("seeds troughEquity/troughEquityAtMaxRunup from initialCapital on the first call", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.updateDrawdown(999); // flat, maxRunup은 0 그대로
    expect(st.maxRunup).toBe(0);
    expect(st.troughEquityAtMaxRunup).toBe(1000);
  });

  it("does not move on a new trough (further loss) that doesn't beat the existing maxRunup", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.entry("L", "long", 10);
    st.processFills(10); // 롱 10 @ 10
    st.updateDrawdown(10); // eq=1000, trough=1000, runup=0
    st.updateDrawdown(15); // eq=1050 -> runup=50 -> maxRunup=50, snapshot trough=1000
    expect(st.maxRunup).toBe(50);
    expect(st.troughEquityAtMaxRunup).toBe(1000);
    st.updateDrawdown(8); // eq=980 -> 새 trough(하락), runup=0 -> maxRunup 갱신 없음
    expect(st.troughEquity).toBe(980);
    expect(st.maxRunup).toBe(50);
    expect(st.troughEquityAtMaxRunup).toBe(1000); // 새 trough가 갱신을 안 트리거했으니 스냅샷도 그대로
  });

  it("re-snapshots troughEquityAtMaxRunup to the new (lower) trough once maxRunup itself updates again", () => {
    const st = new StrategyState();
    st.configure(1, 1, 1000);
    st.entry("L", "long", 10);
    st.processFills(10);
    st.updateDrawdown(10); // eq=1000, trough=1000
    st.updateDrawdown(15); // eq=1050 -> runup=50 -> maxRunup=50, snapshot=1000
    st.updateDrawdown(8); // eq=980 -> 새 trough, runup=0(maxRunup 갱신 없음)
    st.updateDrawdown(19); // eq=1090 -> runup=1090-980=110 > 50 -> maxRunup=110, snapshot=980(새 trough)
    expect(st.maxRunup).toBe(110);
    expect(st.troughEquityAtMaxRunup).toBe(980);
  });
});

describe("strategy.avg_winning_trade/avg_losing_trade/avg_winning_trade_percent/avg_losing_trade_percent/position_entry_name/max_runup/max_runup_percent analyzer/codegen (C674)", () => {
  const cases: Array<[string, string]> = [
    ["avg_winning_trade", "$.strategy.winTrades === 0 ? 0 : $.strategy.grossProfit / $.strategy.winTrades"],
    ["avg_losing_trade", "$.strategy.lossTrades === 0 ? 0 : $.strategy.grossLoss / $.strategy.lossTrades"],
    [
      "avg_winning_trade_percent",
      "$.strategy.winTrades === 0 ? 0 : $.strategy.sumWinProfitPercent / $.strategy.winTrades",
    ],
    [
      "avg_losing_trade_percent",
      "$.strategy.lossTrades === 0 ? 0 : $.strategy.sumLossProfitPercent / $.strategy.lossTrades",
    ],
    ["position_entry_name", '$.strategy.entryId ?? ""'],
    ["max_runup", "$.strategy.maxRunup"],
    ["max_runup_percent", "$.strategy.maxRunup / $.strategy.troughEquityAtMaxRunup * 100"],
  ];

  it.each(cases)("accepts strategy.%s after a strategy() declaration", (attr) => {
    expect(transpile(`strategy("s")\nx = strategy.${attr}`).ok).toBe(true);
  });

  it.each(cases)("accepts strategy.%s without a strategy() declaration (C771)", (attr) => {
    expect(transpile(`x = strategy.${attr}`).ok).toBe(true);
  });

  it.each(cases)("emits the exact runtime expression for strategy.%s", (attr, expr) => {
    const code = transpileCode(`strategy("s")\nvar float a = na\na := strategy.${attr}`);
    expect(code).toContain(`(${expr})`);
  });

  it("still rejects strategy.oca (out of scope — OCA 런타임 미구현, 값을 discard하면 조용한 오답)", () => {
    const errors = transpileErrors('strategy("s")\nx = strategy.oca');
    expect(errors.some((e) => e.includes("unsupported strategy property: 'strategy.oca'"))).toBe(true);
  });
});

describe("strategy.* E2E (hand-verified: avg_winning_trade/avg_losing_trade/avg_winning_trade_percent/avg_losing_trade_percent, C674)", () => {
  // 시나리오(C579 전수순회 E2E와 동일한 "신호 바 / 체결 바 분리" 관례로 트레이드마다 별도 바 사용):
  //   trade0: entry 신호 bar0 -> bar1 open(10)에 체결. close 신호 bar1 -> bar2 open(20)에 체결:
  //           profit=(20-10)*1=10(WIN), pct=(20-10)/10*100=100.
  //   trade1: entry 신호 bar2 -> bar3 open(20)에 체결. close 신호 bar3 -> bar4 open(22)에 체결:
  //           profit=(22-20)*1=2(WIN), pct=(22-20)/20*100=10.
  const data: OHLCVData = {
    open: [10, 10, 20, 20, 22, 22],
    high: [11, 11, 21, 21, 23, 23],
    low: [9, 9, 19, 19, 21, 21],
    close: [11, 11, 21, 21, 23, 23],
    volume: [100, 100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("L0", strategy.long, 1)',
    "if n == 2",
    '    strategy.close("L0")',
    "if n == 3",
    '    strategy.entry("L1", strategy.long, 1)',
    "if n == 4",
    '    strategy.close("L1")',
    "var float __obs_avgw = na",
    "__obs_avgw := strategy.avg_winning_trade",
    "var float __obs_avgl = na",
    "__obs_avgl := strategy.avg_losing_trade",
    "var float __obs_avgwp = na",
    "__obs_avgwp := strategy.avg_winning_trade_percent",
    "var float __obs_avglp = na",
    "__obs_avglp := strategy.avg_losing_trade_percent",
  ].join("\n");

  it("computes running avg_winning_trade/avg_losing_trade (currency + percent) across 2 winning trades", () => {
    const result = runPipeline(src, data);
    // bar2 open(20)에서 trade0 청산 체결 -> avgw=10, avgwp=100(그 바부터).
    // bar4 open(22)에서 trade1 청산 체결 -> avgw=(10+2)/2=6, avgwp=(100+10)/2=55(그 바부터).
    expect(result.bars.map((b) => b["var:__obs_avgw"])).toEqual([0, 0, 10, 10, 6, 6]);
    expect(result.bars.map((b) => b["var:__obs_avgwp"])).toEqual([0, 0, 100, 100, 55, 55]);
    // 손실 트레이드가 없으므로 avg_losing_trade*는 0-나눗셈 가드로 0 유지.
    expect(result.bars.map((b) => b["var:__obs_avgl"])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(result.bars.map((b) => b["var:__obs_avglp"])).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("strategy.position_entry_name E2E (오라클: pine2py engine.py position_entry_name, C674)", () => {
  const data: OHLCVData = {
    open: [10, 12, 14, 16],
    high: [11, 13, 15, 17],
    low: [9, 11, 13, 15],
    close: [11, 13, 15, 17],
    volume: [100, 100, 100, 100],
  };
  const src = [
    'strategy("s")',
    "var int n = 0",
    "n := n + 1",
    "if n == 1",
    '    strategy.entry("MyEntry", strategy.long, 1)',
    "if n == 3",
    '    strategy.close("MyEntry")',
    "var string __obs_name = na",
    "__obs_name := strategy.position_entry_name",
  ].join("\n");

  it("reports the open position's entry id, then reverts to empty string once flat (pine2py Position.entry_id default)", () => {
    const result = runPipeline(src, data);
    // bar0: flat(entry 아직 미체결) -> "". bar1: entry 체결(open 12) -> "MyEntry". bar2: 유지 -> "MyEntry".
    // bar3: close 체결(open 16) -> flat -> "".
    expect(result.bars.map((b) => b["var:__obs_name"])).toEqual(["", "MyEntry", "MyEntry", ""]);
  });
});

describe("strategy.max_runup/max_runup_percent E2E (hand-verified, C674 — max_drawdown E2E 시나리오 대칭 재사용)", () => {
  // max_drawdown_percent E2E와 동일 데이터(initial_capital=1000), 대칭 손 계산:
  //   bar0: flat, eq=1000, trough=1000(시드) -> runup=0.
  //   bar1: eq=980 -> 새 trough(하락), runup=0(갱신 없음).
  //   bar2: eq=1050 -> runup=1050-980=70>0 -> maxRunup=70, snapshot trough=980 -> pct=70/980*100.
  //   bar3: eq=950 -> 새 trough 아님(980이 이미 더 낮음) 대신 950<980이라 새 trough=950, runup=0(갱신없음).
  //   bar4: eq=1020 -> runup=1020-950=70(70과 동률, 갱신 없음 — strict > 비교).
  const data: OHLCVData = {
    open: [10, 10, 14, 6, 11],
    high: [11, 10.5, 15.5, 6.5, 12.5],
    low: [9, 7.5, 13.5, 4.5, 10.5],
    close: [11, 8, 15, 5, 12],
    volume: [100, 100, 100, 100, 100],
  };
  const src = [
    'strategy("s", initial_capital=1000)',
    "if close > open and strategy.position_size == 0",
    '    strategy.entry("L", strategy.long, 10)',
    "var float __obs_ru = na",
    "__obs_ru := strategy.max_runup",
    "var float __obs_rup = na",
    "__obs_rup := strategy.max_runup_percent",
  ].join("\n");

  it("normalizes max_runup by the trough equity snapshotted when that max was set, not the live trough", () => {
    const result = runPipeline(src, data);
    expect(result.bars.map((b) => b["var:__obs_ru"])).toEqual([0, 0, 70, 70, 70]);
    expect(result.bars.map((b) => b["var:__obs_rup"])).toEqual([0, 0, (70 / 980) * 100, (70 / 980) * 100, (70 / 980) * 100]);
  });
});
