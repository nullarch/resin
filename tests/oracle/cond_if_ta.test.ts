// oracle/cases/cond_if_ta.pine: [hard] 조건부 stateful call — if 분기 본문의 per-call 상태 전진
// (ROADMAP P2 "조건부 stateful call 최종 시맨틱" (a)안, C64). 골든이 확정한 사실:
// - __obs_s bar4 = 103.5 = (103+104)/2: 조건이 false였던 bar3의 close(102)가 sma 창에 **없다** —
//   pine2py가 실제로 "호출된 바에서만 상태 전진"(per-call)임을 보여주는 스모킹 건(무조건 호출이었
//   다면 (102+104)/2 = 103이 나왔을 것).
// - __obs_m(ema/rma, if/else 양 분기): 전 구간 pine2js와 바이트 단위 일치 — pine2py ema/rma는
//   호출값 누적이라 per-call 시맨틱이 완전히 동형.
// - **의도적 divergence(DIVERGENCES.md #11)**: __obs_s bar2(첫 호출 바)만 골든 102.5 vs pine2js
//   NaN. pine2py sma.py는 **첫 호출에 한해** source.get(length-1-i)로 실제 바 히스토리를 백필
//   (bar1의 102가 끼어듦)하는데, 이는 같은 파일군의 ema/rma(호출값만 누적)와 자기모순인 pine2py
//   내부 비일관성이고(wpr C44류), pine2js 런타임은 scalar call-fed라 백필이 구조적으로 불가능하며
//   TV 실행 모델("함수 로컬 히스토리는 실행된 바 기준")과도 어긋난다 — pine2js는 균일 per-call
//   유지. 따라서 __obs_s는 compareToGolden을 bar2를 제외한 바에만 적용한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_if_ta";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: cond_if_ta (conditional stateful calls in if bodies)", () => {
  it("golden proves pine2py advances sma state only on called bars (bar4 = 103.5, not 103)", () => {
    const golden = loadGolden(CASE_NAME);
    // bar3(조건 false)의 close=102가 창에 있었다면 (102+104)/2 = 103. 103.5는 창=[103,104],
    // 즉 스킵된 바에서 상태가 전진하지 않았다는 수치 증거다.
    expect(golden.bars[4]!["var:__obs_s"]).toBe(103.5);
    // 첫 호출 바(bar2)는 pine2py sma의 히스토리 백필로 102.5 — pine2js와 갈리는 유일한 바
    // (아래 divergence 테스트 참조, DIVERGENCES.md #11).
    expect(golden.bars[2]!["var:__obs_s"]).toBe(102.5);
  });

  it("matches golden bar-for-bar on both channels except the documented sma first-call bar (DIVERGENCES.md #11)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    for (let i = 0; i < golden.bars.length; i++) {
      // __obs_m(ema/rma): 전 구간 골든과 일치 — pine2py ema/rma는 호출값 누적이라 per-call 동형.
      const expectedM = decodeSentinel(golden.bars[i]!["var:__obs_m"]!);
      expect(
        nearlyEqual(result.bars[i]!["var:__obs_m"]!, expectedM),
        `bar ${i} __obs_m: actual=${result.bars[i]!["var:__obs_m"]} golden=${expectedM}`,
      ).toBe(true);
      // __obs_s(sma): 첫 호출 바(bar2)만 divergence — 그 외 전 구간 골든과 일치.
      if (i === 2) continue;
      const expectedS = decodeSentinel(golden.bars[i]!["var:__obs_s"]!);
      expect(
        nearlyEqual(result.bars[i]!["var:__obs_s"]!, expectedS),
        `bar ${i} __obs_s: actual=${result.bars[i]!["var:__obs_s"]} golden=${expectedS}`,
      ).toBe(true);
    }
  });

  it("returns NaN on the sma's first called bar (uniform call-fed warmup; golden backfills 102.5 there)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // pine2js: 첫 호출(bar2)에서 창=[103] 하나뿐이라 워밍업 NaN. 전체 hand-verified 트레이스로
    // per-call 시맨틱을 바별로 못박는다(103.5가 divergence의 부산물이 아니라 창 내용의 결과임을 확인).
    const expectedS = [NaN, NaN, NaN, NaN, 103.5, 104.5, 105.5, 105.5, 106.0, 107.5];
    for (let i = 0; i < expectedS.length; i++) {
      const e = expectedS[i]!;
      if (Number.isNaN(e)) {
        expect(result.bars[i]!["var:__obs_s"], `bar ${i}`).toBeNaN();
      } else {
        expect(result.bars[i]!["var:__obs_s"], `bar ${i}`).toBeCloseTo(e, 9);
      }
    }
  });

  it("advances each of the if/else branch call sites independently (hand-verified ema/rma trace)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    // rma(close,2)는 bar0~4(else 분기)에서만: NaN(누적1) -> 시드 101.5 -> 102.25 -> 102.125 ->
    // 103.0625. ema(close,2)는 bar5~9(then 분기)에서만: NaN(누적1) -> 시드 105.5 -> alpha=2/3
    // 블렌드 105.1666... -> 106.3888... -> 107.46296....
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

  it("matches golden finalVarState (last bar is past the divergent first-call bar on both channels)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    expect(result.finalVarState["__obs_s"]).toBeCloseTo(decodeSentinel(golden.finalVarState["__obs_s"]!), 9);
    expect(result.finalVarState["__obs_m"]).toBeCloseTo(decodeSentinel(golden.finalVarState["__obs_m"]!), 9);
  });
});
