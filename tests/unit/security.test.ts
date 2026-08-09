// request.security 첫 슬라이스(ROADMAP P2 [hard->분할]) 런타임 유닛 테스트 — src/runtime/security.ts.
// 전부 hand-verified다: pine2py의 SecurityManager는 오라클 대조 대상이 될 수 없다(DIVERGENCES.md
// 신규 항목 참조) — Runtime.execute()가 매 바 push_bar()로 OHLCV를 점진적으로 채우는데, SecurityManager
// 캐시(ctx.security, Context당 lazy singleton)는 request.security()의 **첫 호출 시점에 단 한 번만**
// 집계를 계산해 영구 캐싱한다. 그 첫 호출은 항상 bar 0에서 일어나므로(스크립트가 매 바 request.
// security를 호출하는 표준 패턴), 그 시점엔 아직 bar 0 하나만 push된 상태라 원본 배열의 나머지
// 바(1..N-1)는 전부 "범위 밖 -> 0" 기본값으로 집계되고, 그 오염된 스냅샷이 이후 모든 바에서 그대로
// 재사용된다(python 직접 실행으로 실측 확인: tf=D/다중일 데이터에서 bar 6 이후 값이 전부 0으로
// 얼어붙음). pine2js는 Context 생성 시 전체 배열을 이미 쥔 채 1회 정석 집계를 수행하므로(GOAL.md
// 배치 리플레이 철학) 이 latent 버그와 구조적으로 다르다 — GOAL.md "알려진 버그는 따르지 않는다".
import { describe, expect, it } from "vitest";
import { build, get, getFromArray } from "../../src/runtime/security";

// 2024-01-01 00:00 UTC부터 하루 안에 3바(00/08/16시), 그 다음 이틀도 동일 패턴, 마지막 날은 1바.
// day1=idx0-2, day2=idx3-5, day3=idx6-8, day4=idx9 — 실제 "여러 바가 한 HTF 바로 뭉치는" 집계
// 시나리오(1:1 트리비얼 매핑이 아님)를 검증하기 위한 설계.
const OPEN = [100, 102, 101, 105, 108, 106, 110, 113, 111, 115];
const HIGH = [103, 105, 102, 108, 110, 108, 112, 115, 113, 117];
const LOW = [99, 100, 100, 103, 106, 104, 108, 111, 109, 113];
const CLOSE = [102, 101, 103, 106, 107, 109, 111, 112, 114, 116];
const VOLUME = [1000, 1100, 1050, 1200, 1150, 1300, 1250, 1400, 1350, 1500];
const TIME_4_DAYS = [
  1704067200000, 1704096000000, 1704124800000, // 2024-01-01 00/08/16h
  1704153600000, 1704182400000, 1704211200000, // 2024-01-02 00/08/16h
  1704240000000, 1704268800000, 1704297600000, // 2024-01-03 00/08/16h
  1704326400000, // 2024-01-04 00h
];

describe("security.build (calendar D — has time channel)", () => {
  it("groups multi-bar days into 4 HTF bars with correct barMap", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    expect(Array.from(cache.barMap)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3]);
  });

  it("aggregates open=first/high=max/low=min/close=last/volume=sum within each day", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    expect(Array.from(cache.open)).toEqual([100, 105, 110, 115]);
    expect(Array.from(cache.high)).toEqual([105, 110, 115, 117]);
    expect(Array.from(cache.low)).toEqual([99, 103, 108, 113]);
    expect(Array.from(cache.close)).toEqual([103, 109, 114, 116]);
    expect(Array.from(cache.volume)).toEqual([3150, 3650, 4000, 1500]);
  });

  it("returns na for every bar within the still-forming first HTF period (htf_idx===0, intentional divergence)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    expect(get(cache, 0, "close", false, false)).toBeNaN();
    expect(get(cache, 1, "close", false, false)).toBeNaN();
    expect(get(cache, 2, "close", false, false)).toBeNaN();
  });

  it("returns the previous confirmed HTF bar once htf_idx advances (lookahead=off decrement)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    // day2 바들(idx3-5)은 day1(bars[0])을 봐야 한다.
    for (const i of [3, 4, 5]) {
      expect(get(cache, i, "close", false, false)).toBe(103);
      expect(get(cache, i, "open", false, false)).toBe(100);
      expect(get(cache, i, "high", false, false)).toBe(105);
      expect(get(cache, i, "low", false, false)).toBe(99);
      expect(get(cache, i, "volume", false, false)).toBe(3150);
    }
    // day3 바들(idx6-8)은 day2(bars[1])를 봐야 한다.
    for (const i of [6, 7, 8]) {
      expect(get(cache, i, "close", false, false)).toBe(109);
    }
    // day4(idx9)는 day3(bars[2])를 봐야 한다.
    expect(get(cache, 9, "close", false, false)).toBe(114);
  });
});

// C441: time/time_close/bar_index — wild "var-subst:undeclared" 최대 버킷(37건 중 32건이 이
// 3종을 bare로 참조)에서 발견된 request.security 표현식 신규 지원. time_close는 context.ts
// timeCloseMs와 동일한 "다음 (HTF) 바 open 시각 근사, 마지막 바는 직전 간격 외삽" 공식.
describe("security.get (time/time_close/bar_index fields, C441)", () => {
  it("returns the HTF bar's own open time (field='time') for the previous confirmed period, same htfIdx as close", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    for (const i of [3, 4, 5]) expect(get(cache, i, "time", false, false)).toBe(1704067200000);
    for (const i of [6, 7, 8]) expect(get(cache, i, "time", false, false)).toBe(1704153600000);
    expect(get(cache, 9, "time", false, false)).toBe(1704240000000);
  });

  it("derives time_close as the next HTF bar's open time (gapless approximation)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    for (const i of [3, 4, 5]) expect(get(cache, i, "time_close", false, false)).toBe(1704153600000);
    for (const i of [6, 7, 8]) expect(get(cache, i, "time_close", false, false)).toBe(1704240000000);
    expect(get(cache, 9, "time_close", false, false)).toBe(1704326400000);
  });

  it("extrapolates time_close for the last HTF bar using the previous bar's duration (bar_index=3, the still-forming period, is unreachable via get() — checked directly on the cache array)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    // bars[3](2024-01-04)이 마지막 HTF 바 — 다음 바가 없어 직전 간격(bars[2]->bars[3] = 1일)으로 외삽.
    expect(cache.timeClose[3]).toBe(1704326400000 + 86400000);
  });

  it("returns the HTF sequence position (field='bar_index') matching the same htfIdx as the OHLCV fields", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    for (const i of [3, 4, 5]) expect(get(cache, i, "bar_index", false, false)).toBe(0);
    for (const i of [6, 7, 8]) expect(get(cache, i, "bar_index", false, false)).toBe(1);
    expect(get(cache, 9, "bar_index", false, false)).toBe(2);
  });

  it("returns na for time/time_close/bar_index on the still-forming first HTF period, same na guard as close", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    expect(get(cache, 0, "time", false, false)).toBeNaN();
    expect(get(cache, 0, "time_close", false, false)).toBeNaN();
    expect(get(cache, 0, "bar_index", false, false)).toBeNaN();
  });

  it("time_close on a single-HTF-bar dataset equals its own open time (n<2, duration=0 fallback)", () => {
    const cache = build([100], [101], [99], [100], [500], [1704067200000], "D");
    expect(cache.timeOpen[0]).toBe(1704067200000);
    expect(cache.timeClose[0]).toBe(1704067200000);
  });
});

describe("security.build (calendar W/M — ISO week/month boundaries)", () => {
  it("groups by ISO week (Mon 2024-01-01 = W01, Mon 2024-01-08 = W02)", () => {
    // 2024-01-01은 월요일(ISO W01 첫날). idx0/1은 W01(01-05 금요일까지), idx2는 W02(01-08 월요일).
    const time = [
      Date.UTC(2024, 0, 1), // Mon W01
      Date.UTC(2024, 0, 5), // Fri W01
      Date.UTC(2024, 0, 8), // Mon W02
    ];
    const o = [1, 2, 3];
    const cache = build(o, o, o, o, o, time, "W");
    expect(Array.from(cache.barMap)).toEqual([0, 0, 1]);
  });

  it("groups by calendar month (2024-01-31 and 2024-02-01 fall in different months)", () => {
    const time = [Date.UTC(2024, 0, 31), Date.UTC(2024, 1, 1), Date.UTC(2024, 1, 2)];
    const o = [1, 2, 3];
    const cache = build(o, o, o, o, o, time, "M");
    expect(Array.from(cache.barMap)).toEqual([0, 1, 1]);
  });
});

describe("security.build (naive count fallback — no time channel)", () => {
  it("groups every N bars by index ratio when time is undefined (tf minutes as bar-count ratio)", () => {
    // tf="3" -> ratio=3 -> i%3===0에서 새 그룹(pine2py _aggregate_by_count literal port).
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, undefined, "3");
    expect(Array.from(cache.barMap)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3]);
    expect(Array.from(cache.close)).toEqual([103, 109, 114, 116]);
  });

  it("produces a single HTF bar spanning the whole dataset for a large ratio (tf=D, no time -> 1440)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, undefined, "D");
    expect(Array.from(cache.barMap)).toEqual(new Array(10).fill(0));
    // 유일한 HTF 바가 htf_idx===0이라 모든 바가 na(아직 확정된 이전 구간이 없음).
    for (let i = 0; i < 10; i++) expect(get(cache, i, "close", false, false)).toBeNaN();
  });
});

describe("security.get (field selection + edge cases)", () => {
  it("selects the correct OHLCV field independently", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    expect(get(cache, 9, "open", false, false)).toBe(110);
    expect(get(cache, 9, "high", false, false)).toBe(115);
    expect(get(cache, 9, "low", false, false)).toBe(108);
    expect(get(cache, 9, "close", false, false)).toBe(114);
    expect(get(cache, 9, "volume", false, false)).toBe(4000);
  });

  it("returns na for a single-bar dataset (htf_idx is always 0, no prior confirmed period)", () => {
    const cache = build([100], [101], [99], [100], [500], [1704067200000], "D");
    expect(get(cache, 0, "close", false, false)).toBeNaN();
  });
});

// ── gaps=/lookahead= 둘째 슬라이스(C177, ROADMAP P2 [hard->분할]) — security.py:126-146 literal
// port. barMap=[0,0,0,1,1,1,2,2,2,3](day1=idx0-2/day2=idx3-5/day3=idx6-8/day4=idx9),
// close=[103,109,114,116] — 위 TIME_4_DAYS 데이터셋과 동일 설계(security.test.ts 상단 주석 참조).
describe("security.get lookahead=on (no index adjustment, no htf_idx===0 na exception)", () => {
  it("returns the full aggregate of the still-forming current HTF bar (deliberate lookahead — leaks the period's eventual close)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    // lookahead=off라면 idx0-2는 na(htf_idx===0 예외)지만, lookahead=on은 그 예외가 적용되지 않아
    // day1의 최종(전체 스캔 완료) close=103을 idx0(그 구간의 첫 바)에서부터 그대로 본다.
    expect(get(cache, 0, "close", false, true)).toBe(103);
    expect(get(cache, 1, "close", false, true)).toBe(103);
    expect(get(cache, 2, "close", false, true)).toBe(103);
  });

  it("uses the current (not previous) HTF bar once htf_idx advances — same value on every bar of that period", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    for (const i of [3, 4, 5]) expect(get(cache, i, "close", false, true)).toBe(109);
    for (const i of [6, 7, 8]) expect(get(cache, i, "close", false, true)).toBe(114);
    expect(get(cache, 9, "close", false, true)).toBe(116);
  });
});

describe("security.get gaps=on (na unless bar_map[idx-1] differs from the reported htf_idx, security.py:139-143 literal port)", () => {
  it("lookahead=off: na on the first bar of each new period, the confirmed value repeated on the rest (comparison uses raw pre-adjustment bar_map[idx-1], TV-unverified hypothesis)", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    // idx0-2(day1, htf_idx<=0)는 gaps 여부와 무관하게 이미 na(첫 슬라이스 예외가 gaps 체크보다 먼저 반환).
    expect(get(cache, 0, "close", true, false)).toBeNaN();
    // idx3(day2 첫 바): bar_map[2]=0 === htf_idx(day1을 가리키는 0) -> na.
    expect(get(cache, 3, "close", true, false)).toBeNaN();
    // idx4/5(day2 나머지 바): bar_map[idx-1]=1(day2 자신) !== htf_idx(0) -> na 아님, day1 확정값 그대로.
    expect(get(cache, 4, "close", true, false)).toBe(103);
    expect(get(cache, 5, "close", true, false)).toBe(103);
    // idx6(day3 첫 바): bar_map[5]=1 === htf_idx(day2를 가리키는 1) -> na.
    expect(get(cache, 6, "close", true, false)).toBeNaN();
    expect(get(cache, 7, "close", true, false)).toBe(109);
    expect(get(cache, 8, "close", true, false)).toBe(109);
    // idx9(day4 첫 바이자 유일한 바): bar_map[8]=2 === htf_idx(day3을 가리키는 2) -> na.
    expect(get(cache, 9, "close", true, false)).toBeNaN();
  });

  it("lookahead=on: non-na exactly on the first bar of a new period (the period just changed), na on the rest (repeat) of that period", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    // idx0: gaps 체크는 idx>0에서만 -> na 아님(day1 자신의 완성값).
    expect(get(cache, 0, "close", true, true)).toBe(103);
    // idx1/2: bar_map[idx-1]도 여전히 day1(0) === htf_idx(0) -> na(반복 구간).
    expect(get(cache, 1, "close", true, true)).toBeNaN();
    expect(get(cache, 2, "close", true, true)).toBeNaN();
    // idx3(day2 첫 바): bar_map[2]=0 !== htf_idx(day2 자신=1) -> na 아님, day2 완성값(미래 누출).
    expect(get(cache, 3, "close", true, true)).toBe(109);
    expect(get(cache, 4, "close", true, true)).toBeNaN();
    expect(get(cache, 5, "close", true, true)).toBeNaN();
  });
});

// ── request.security 셋째 슬라이스 서브슬라이스 3c(C182, ROADMAP [hard->분할]) — getFromArray는
// get()과 동일한 barMap+gaps+lookahead 인덱스 해석(resolveHtfIndex, 내부 비공개)을 공유하고 필드
// 선택 대신 임의 배열(codegen HTF 프리패스가 만든 $.securityExprCache[slot])을 인덱싱한다. 아래는
// get(..., "close", ...)과 정확히 같은 인덱스가 나온다는 것을 cache.close 자신을 valueArr로 넘겨
// 확인(필드 분기 제거가 인덱스 해석 자체를 안 바꿨다는 회귀 확인)한 뒤, cache 필드와 무관한 별도
// 합성 배열로 "실제로 그 배열을 인덱싱한다"(단순히 cache.close를 재계산하는 게 아니다)는 것을 검증한다.
describe("security.getFromArray (C182, request.security third slice sub-slice 3c)", () => {
  it("matches get(cache, idx, 'close', gaps, lookahead) index-for-index when valueArr is cache.close itself", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    const valueArr = cache.close;
    for (const [gaps, lookahead] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      for (let i = 0; i < 10; i++) {
        const expected = get(cache, i, "close", gaps, lookahead);
        const actual = getFromArray(valueArr, cache, i, gaps, lookahead);
        if (Number.isNaN(expected)) expect(actual).toBeNaN();
        else expect(actual).toBe(expected);
      }
    }
  });

  it("indexes an arbitrary Float64Array unrelated to the cache's own OHLCV fields (HTF prepass result, not a cache field)", () => {
    // barMap=[0,0,1,1,2,2,3,3,3,3](tf=D naive-count 폴백이 아니라 실제 달력 집계 결과를 그대로
    // 재사용하지 않고, resolveHtfIndex만 공유한다는 것을 보이기 위해 cache.close와 다른 임의
    // 값을 가진 valueArr을 사용 — 4개의 HTF 행(day1..4) 각각에 대응하는 합성 sma 결과).
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    const syntheticSma = new Float64Array([NaN, 42, 43, 44]); // HTF 4행(day1..4) 전용 합성값
    // day2 바들(idx3-5)은 htf_idx=0(day1)을 봐야 하므로 syntheticSma[0]=NaN.
    for (const i of [3, 4, 5]) expect(getFromArray(syntheticSma, cache, i, false, false)).toBeNaN();
    // day3 바들(idx6-8)은 htf_idx=1(day2)을 봐야 하므로 syntheticSma[1]=42.
    for (const i of [6, 7, 8]) expect(getFromArray(syntheticSma, cache, i, false, false)).toBe(42);
    // day4(idx9)는 htf_idx=2(day3)를 봐야 하므로 syntheticSma[2]=43.
    expect(getFromArray(syntheticSma, cache, 9, false, false)).toBe(43);
  });

  it("returns na (not a crash) for the still-forming first HTF period, same as get()", () => {
    const cache = build(OPEN, HIGH, LOW, CLOSE, VOLUME, TIME_4_DAYS, "D");
    const valueArr = new Float64Array([1, 2, 3, 4]);
    expect(getFromArray(valueArr, cache, 0, false, false)).toBeNaN();
    expect(getFromArray(valueArr, cache, 1, false, false)).toBeNaN();
    expect(getFromArray(valueArr, cache, 2, false, false)).toBeNaN();
  });
});
