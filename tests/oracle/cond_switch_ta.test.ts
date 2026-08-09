// oracle/cases/cond_switch_ta.pine: 조건부 stateful call — switch case 본문의 per-call 상태
// 전진 (ROADMAP P2 "조건부 stateful call 최종 시맨틱" switch 슬라이스, C65). cond_if_ta.test.ts
// (C64)의 if-body 검증을 switch case 본문으로 반복한다. cond_if_ta와 달리 divergence 제외 처리가
// 없다 — 두 채널 모두 순수 call-fed TA(ema 전용, __obs_m의 default 분기만 rma)를 쓰고 rma 쪽은
// 갭이 없어 pine2py 골든과 전 구간 바이트 단위 일치.
//
// 골든이 확정한 사실:
// - __obs_r bar4 = 103.5 = (103+104)/2: 갭 바(bar3, close=102<=102)에서 ta.ema 호출 자체가
//   없었다는 수치 증거(무조건 호출이었다면 bar1에서 이미 시드가 끝나 다른 궤적이 나왔을 것).
// - __obs_m(ema/rma, close>104 case/default): pine2py 골든과 전 구간 바이트 단위 일치.
// - **부수 발견(C65, 오라클 케이스 설계 시 재확인)**: rma.py의 인크리멘탈 초기화는
//   `source.get(length-1-i)`로 실제 바 히스토리를 백필한다(sma.py와 동일 메커니즘) — DIVERGENCES
//   #11이 "call-fed"로 뭉뚱그렸던 ema/rma 중 rma는 호출에 실제 갭이 있으면 sma류와 같은 divergence를
//   낸다(오라클 설계 초안에서 ta.rma로 __obs_r을 만들었다가 bar2=102.5(백필)로 실제 확인, ta.ema로
//   교체해 회피 — pine.pine 헤더 주석 참조). __obs_m의 rma 분기는 호출에 갭이 없어(bar0~4 연속)
//   문제가 드러나지 않는다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_switch_ta";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: cond_switch_ta (conditional stateful calls in switch case bodies)", () => {
  it("golden proves pine2py advances ema state only on matched case bars (bar4 = 103.5, gap bar3 skipped)", () => {
    const golden = loadGolden(CASE_NAME);
    // bar2(첫 호출, close=103)은 length=2 워밍업 1회차라 NaN, bar3(매치 안 됨)은 갭이라 호출 자체가
    // 없어 상태 불변, bar4(두 번째 호출, close=104)에서 시드 = (103+104)/2 = 103.5.
    expect(golden.bars[2]!["var:__obs_r"]).toBe("NaN");
    expect(golden.bars[4]!["var:__obs_r"]).toBe(103.5);
  });

  it("matches golden bar-for-bar on both channels with no exclusions (both are gap-safe call-fed TAs)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    for (let i = 0; i < golden.bars.length; i++) {
      const expectedR = decodeSentinel(golden.bars[i]!["var:__obs_r"]!);
      expect(
        nearlyEqual(result.bars[i]!["var:__obs_r"]!, expectedR),
        `bar ${i} __obs_r: actual=${result.bars[i]!["var:__obs_r"]} golden=${expectedR}`,
      ).toBe(true);
      const expectedM = decodeSentinel(golden.bars[i]!["var:__obs_m"]!);
      expect(
        nearlyEqual(result.bars[i]!["var:__obs_m"]!, expectedM),
        `bar ${i} __obs_m: actual=${result.bars[i]!["var:__obs_m"]} golden=${expectedM}`,
      ).toBe(true);
    }
  });

  it("advances the subject-less switch's single-case ema only on matched bars (hand-verified gap trace)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // close>102: bar0/1 F(no call), bar2 T(call1=NaN warmup), bar3 F(gap, no call), bar4~9 T
    // (call2 seeds at bar4, then Wilder smoothing).
    const expectedR = [NaN, NaN, NaN, NaN, 103.5, 104.5, 105.5, 105 + 1 / 6, 106.3888888889, 107.462962963];
    for (let i = 0; i < expectedR.length; i++) {
      const e = expectedR[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_r"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_r"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("advances the case/default branches independently (hand-verified ema/rma trace, both gap-free)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // rma(close,2) default 분기는 bar0~4에서만(close<=104): NaN(누적1) -> 시드 101.5 -> 102.25 ->
    // 102.125 -> 103.0625. ema(close,2) case 분기는 bar5~9에서만(close>104): NaN(누적1) -> 시드
    // 105.5 -> 105.1666... -> 106.3888... -> 107.462962963.
    const expectedM = [NaN, 101.5, 102.25, 102.125, 103.0625, NaN, 105.5, 105 + 1 / 6, 106.3888888889, 107.462962963];
    for (let i = 0; i < expectedM.length; i++) {
      const e = expectedM[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_m"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_m"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("matches golden finalVarState on both channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    expect(result.finalVarState["__obs_r"]).toBeCloseTo(decodeSentinel(golden.finalVarState["__obs_r"]!), 9);
    expect(result.finalVarState["__obs_m"]).toBeCloseTo(decodeSentinel(golden.finalVarState["__obs_m"]!), 9);
  });
});
