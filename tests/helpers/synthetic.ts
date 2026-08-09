// 결정론적 합성 OHLCV 생성기 (배치27 exec 게이트, ROADMAP P4 "(1) exec 게이트 인프라").
// scripts/corpus_scan.mjs --exec 워커와 vitest 테스트가 공유한다("데이터 생성기는 tests 헬퍼로
// 공유" 지시). 고정 시드 PRNG라 같은 (barCount, seed)면 언제나 같은 배열 — 실행 결과가 사이클 간
// 재현돼야 런타임 에러 클러스터의 증감 비교가 의미를 가진다.
//
// 데이터 형태: 현실적 가격 스케일(100 부근 랜덤워크, 전부 양수/유한), high >= max(open, close),
// low <= min(open, close), open[i] = close[i-1](연속 차트), volume은 양의 정수. time 채널은
// 1시간 봉(고정 기점 2020-01-01 UTC) — 500바 = 약 21일이라 request.security의 "D"/"W" 달력
// 집계가 실제로 여러 HTF 바를 만든다(security.ts _aggregate_by_time 경로 충족).

import type { OHLCVData } from "../../src/runtime/context";

export interface SyntheticOHLCV extends OHLCVData {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  time: number[];
}

export const SYNTHETIC_BAR_MS = 3_600_000; // 1시간 봉
export const SYNTHETIC_START_MS = Date.UTC(2020, 0, 1); // 고정 기점 (결정론 — 현재 시각 사용 금지)

// mulberry32 — 32bit 상태 하나짜리 결정론 PRNG(공개 도메인 알고리즘). rt의 math.random용
// xorshift32(C120)와 별개로 헬퍼 자체 완결로 둔다(런타임 상태와 얽히지 않게, 의존성 0).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSyntheticOHLCV(barCount = 500, seed = 1234): SyntheticOHLCV {
  const rand = mulberry32(seed);
  const open: number[] = new Array(barCount);
  const high: number[] = new Array(barCount);
  const low: number[] = new Array(barCount);
  const close: number[] = new Array(barCount);
  const volume: number[] = new Array(barCount);
  const time: number[] = new Array(barCount);

  let prevClose = 100;
  for (let i = 0; i < barCount; i++) {
    const o = prevClose;
    const c = o * (1 + (rand() - 0.5) * 0.02); // 바당 ±1% 랜덤워크
    const hi = Math.max(o, c) * (1 + rand() * 0.005);
    const lo = Math.min(o, c) * (1 - rand() * 0.005);
    open[i] = o;
    high[i] = hi;
    low[i] = lo;
    close[i] = c;
    volume[i] = 1000 + Math.floor(rand() * 9000); // 항상 양의 정수
    time[i] = SYNTHETIC_START_MS + i * SYNTHETIC_BAR_MS;
    prevClose = c;
  }

  return { open, high, low, close, volume, time };
}
