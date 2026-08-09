// oracle/cases/cond_udf_ta.pine: 조건부 stateful call — UDF 본문 슬라이스 (ROADMAP line 809
// "loop·UDF 본문" 중 마지막 UDF 조각, C162). UDF 본문 안 ta 콜은 함수-상대 슬롯 + 콜사이트별
// __taBase 전파로 콜사이트마다 독립 상태를 갖되, 전진 자체는 다른 허용 위치와 동일한 per-call
// 모델이다. pine2py는 UDF 본문 안 ta 콜도 정적 _taN 하나(codegen.py _inject_stateful_kwargs의
// _ta_call_counter — 소스 재확인)라 **단일 콜사이트에서만** 동형 — 이 케이스의 네 UDF는 전부
// 콜사이트가 정확히 1개라 골든이 전 구간 유효하다(다중 콜사이트 독립성은 pine2py가 상태를
// 공유하는 버그라 오라클 무효 — tests/unit/codegen.test.ts hand-verified가 담당, DIVERGENCES.md
// #65). 채널은 전부 call-fed인 ta.ema(sma/rma는 첫 호출 히스토리 백필로 오라클 무효, #11).
// TV 실측은 미검증 가설(#65 — VERIFIED_SEMANTICS의 조건부 per-call CONFIRMED를 UDF 본문에 외삽).
//
// 골든이 확정한 사실(스모킹 건):
// - __obs_b bar4 = 103.5: if 분기 안 단일 콜사이트의 UDF 내부 ema(src,2)가 "호출된 바에서만"
//   전진한다는 수치 증거 — 호출은 close>102.5인 바(2,4,5,...)뿐이라 bar4가 두 번째 호출 = 시드
//   (103+104)/2. 매 바 전진이었다면 bar4는 이미 스무딩 구간이라 이 값이 나올 수 없다.
// - __obs_c bar1 = 101.6667: UDF 본문 안 for 루프의 ema(src,3)가 반복마다 전진해 바당 2스텝 —
//   cond_loop_ta __obs_a와 동일한 수치가 UDF 경유로 재현된다(바당 1회였다면 워밍업 NaN).
// - __obs_d: UDF 내부 var(acc, fnVars slotBase)와 ta 상태(taSlots __taBase)가 한 함수에 공존해도
//   두 분리 메커니즘이 서로를 깨뜨리지 않는다(누적 시퀀스 전 구간 일치). 골든의 "var:acc" 채널은
//   무시 — pine2js는 UDF 내부 var를 top-level var:<name> 채널에 노출하지 않는다(udf_single_var와
//   동일한 의도된 격리).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_udf_ta";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["__obs_a", "__obs_b", "__obs_c", "__obs_d"] as const;

describe("oracle: cond_udf_ta (stateful calls inside UDF bodies, per-call advance + per-call-site slots)", () => {
  it("golden proves pine2py advances the UDF-internal ema only when the single call site executes (bar4 __obs_b seed, bar1 __obs_c double-step)", () => {
    const golden = loadGolden(CASE_NAME);
    // if 분기 안 콜사이트: 첫 호출 bar2(워밍업 NaN), 두 번째 호출 bar4에서 시드 (103+104)/2.
    expect(golden.bars[2]!["var:__obs_b"]).toBe("NaN");
    expect(golden.bars[3]!["var:__obs_b"]).toBe("NaN");
    expect(decodeSentinel(golden.bars[4]!["var:__obs_b"]!)).toBe(103.5);
    // UDF 본문 for 루프: 바당 2스텝 — bar1에 이미 시드+한 스텝(바당 1회였다면 NaN).
    expect(decodeSentinel(golden.bars[1]!["var:__obs_c"]!)).toBeCloseTo(101.66666666666667, 9);
  });

  it("matches golden bar-for-bar on all four UDF channels with no exclusions (all call-fed ema, single call sites)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    for (let i = 0; i < golden.bars.length; i++) {
      for (const ch of CHANNELS) {
        const expected = decodeSentinel(golden.bars[i]![`var:${ch}`]!);
        expect(
          nearlyEqual(result.bars[i]![`var:${ch}`]!, expected),
          `bar ${i} ${ch}: actual=${result.bars[i]![`var:${ch}`]} golden=${expected}`,
        ).toBe(true);
      }
    }
  });

  it("advances the conditionally-called UDF's ema only on call bars (hand-verified trace, independent recurrence)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // scratch/probe_cond_udf_ta.mjs(골든 생성 전 독립 재계산)와 동일한 손 트레이스: 호출 바는
    // close>102.5인 2,4,5,6,7,8,9 — bar2 워밍업 NaN, bar4 시드 103.5, 이후 alpha=2/3 스무딩.
    const expectedB = [
      NaN, NaN, NaN, NaN, 103.5, 104.5, 105.5, 105.16666666666667, 106.38888888888889, 107.46296296296296,
    ];
    for (let i = 0; i < expectedB.length; i++) {
      const e = expectedB[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_b"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_b"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("keeps fnVars slotBase and taSlots taBase coexisting in one UDF (hand-verified cumulative trace)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // acc += nz(ema(close,2)) 누적(독립 재계산): bar0은 nz(NaN)=0, bar1부터 시드 101.5 누적.
    const expectedD = [
      0, 101.5, 204, 306.1666666666667, 409.55555555555554, 514.0185185185185, 619.5061728395061,
      724.6687242798354, 831.0562414266118, 938.5187471422039,
    ];
    for (let i = 0; i < expectedD.length; i++) {
      expect(result.bars[i]!["var:__obs_d"], `bar ${i}`).toBeCloseTo(expectedD[i]!, 9);
    }
  });

  it("matches golden finalVarState on all four observation channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    for (const ch of CHANNELS) {
      expect(result.finalVarState[ch], ch).toBeCloseTo(decodeSentinel(golden.finalVarState[ch]!), 9);
    }
  });
});
