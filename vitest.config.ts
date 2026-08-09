import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    retry: 0,
    // C278: vitest 기본 testTimeout(5000ms)은 corpus 전량 스캔류 무거운 테스트가 전체 스위트
    // 병렬 워커 부하 아래서 단독 실행 대비 최대 ~7.5배까지 느려지는 것을 실측(corpus.test.ts,
    // C277이 corpus_diff.test.ts 1곳에서 먼저 관측). 개별 it()마다 나중에 패치하는 대신 전역
    // 기본값을 넉넉히 올려 같은 클래스의 재발을 구조적으로 막는다.
    // Fable 2026-07-30: wild transpile_ok가 늘수록 corpus 스캔 테스트가 정비례로 느려져
    // 30s를 실측 초과(corpus.test.ts 49s, corpus_diff 35s — 콜드 런) — 같은 원인의 재발이라
    // C278 원칙 그대로 여유를 다시 상향. 회귀 게이트 목적상 속도보다 비-flaky가 우선.
    testTimeout: 180000,
  },
});
