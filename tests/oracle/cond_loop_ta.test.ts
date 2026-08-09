// oracle/cases/cond_loop_ta.pine: 조건부 stateful call — loop 본문(for/while)의 per-call 상태
// 전진 (ROADMAP line 809 "loop·UDF 본문" 중 loop 슬라이스, C161). cond_if_ta(C64)/cond_switch_ta
// (C65)의 문장 레벨 조건부 검증을 반복문 본문으로 확장한다: 루프 안 ta 콜은 "반복마다 같은
// 콜사이트 상태가 1회씩 전진"이며, pine2py가 for/while을 Python 루프로 직결 트랜스파일(codegen.py
// _gen_for/_gen_while) + state_key가 codegen 시점 정적 콜사이트 카운터(_taN)라 정확히 동형 —
// 네 채널 전부 순수 call-fed인 ta.ema만 사용해(sma/rma는 첫 호출 히스토리 백필로 오라클 무효,
// DIVERGENCES.md #11) divergence 제외 구간 없이 pine2py 골든과 전 구간 일치한다.
// TV 실측은 미검증 가설(DIVERGENCES.md — VERIFIED_SEMANTICS의 조건부 per-call CONFIRMED를 루프에
// 외삽).
//
// 골든이 확정한 사실(스모킹 건):
// - __obs_a bar1 = 101.6667: ema(close,3)가 바당 2회 전진해 4번째 호출에서 시드
//   (101+101+102)/3=101.3333 뒤 한 스텝 더 나갔다는 수치 증거 — 바당 1회 전진이었다면 bar1은
//   아직 워밍업(호출 2회)이라 NaN이어야 한다.
// - __obs_d bar0 = 101.0: ema(close,2)가 한 바 안에서(2회 호출) 워밍업을 끝냈다는 증거 +
//   flag 교대에 따라 바마다 호출 횟수가 2,1,2,1,...로 달라져도 pine2js와 pine2py가 같은 속도로
//   전진한다는 가변 반복 횟수 검증.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_loop_ta";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

const CHANNELS = ["__obs_a", "__obs_b", "__obs_c", "__obs_d", "flag"] as const;

describe("oracle: cond_loop_ta (stateful calls in for/while loop bodies, per-call advance)", () => {
  it("golden proves pine2py advances ema state once per loop iteration (bar1 __obs_a seeded+stepped, bar0 __obs_d fully seeded)", () => {
    const golden = loadGolden(CASE_NAME);
    // ema(close,3) 2회/바: bar0은 호출 2회(워밍업 중) NaN, bar1 4번째 호출에서 시드 후 한 스텝
    // 더 — 바당 1회 전진이었다면 여기가 NaN이어야 한다(스모킹 건).
    expect(golden.bars[0]!["var:__obs_a"]).toBe("NaN");
    expect(decodeSentinel(golden.bars[1]!["var:__obs_a"]!)).toBeCloseTo(101.66666666666667, 9);
    // ema(close,2) 2회/바(bar0): 한 바 안에서 시드 (101+101)/2=101 완성.
    expect(decodeSentinel(golden.bars[0]!["var:__obs_d"]!)).toBe(101.0);
  });

  it("matches golden bar-for-bar on all four loop channels with no exclusions (all call-fed ema)", () => {
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

  it("advances a fixed 2-iteration for-loop ema exactly two steps per bar (hand-verified trace)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // ema(close,3), alpha=0.5, 바당 같은 close를 2회: bar0 호출 2회(누적 2<3) NaN,
    // bar1 3번째 호출 시드 (101+101+102)/3 후 4번째 호출 0.5*102+0.5*101.3333=101.6667,
    // 이후 바마다 두 스텝씩 전진(손 계산 전 구간).
    const expectedA = [
      NaN, 101.66666666666667, 102.66666666666667, 102.16666666666667, 103.54166666666667,
      104.63541666666667, 105.65885416666667, 105.16471354166667, 106.54117838541667, 107.63529459635417,
    ];
    for (let i = 0; i < expectedA.length; i++) {
      const e = expectedA[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_a"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_a"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("advances a variable-iteration for-loop ema at a different per-bar rate (hand-verified 2,1,2,1,... trace)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // ema(close,2), alpha=2/3, flag 교대로 호출 횟수 2,1,2,1,...: bar0(2회) 시드 101 완성,
    // 홀수 바는 한 스텝, 짝수 바는 두 스텝(손 계산 전 구간).
    const expectedD = [
      101.0, 101.66666666666667, 102.85185185185186, 102.28395061728395, 103.80932784636488,
      104.60310928212162, 105.84478992023574, 105.28159664007858, 106.80906629334206, 107.60302209778069,
    ];
    for (let i = 0; i < expectedD.length; i++) {
      expect(result.bars[i]!["var:__obs_d"], `bar ${i}`).toBeCloseTo(expectedD[i]!, 9);
    }
  });

  it("matches golden finalVarState on all channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    for (const ch of CHANNELS) {
      expect(result.finalVarState[ch], ch).toBeCloseTo(decodeSentinel(golden.finalVarState[ch]!), 9);
    }
  });
});
