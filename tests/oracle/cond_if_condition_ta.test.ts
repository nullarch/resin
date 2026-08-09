// oracle/cases/cond_if_condition_ta.pine: if 문의 "최초 조건"(elif 아님) 위치에서의 stateful 콜
// 허용 (ROADMAP P2 조건부 stateful call 항목의 남은 축, C246 — analyzer.ts analyzeIfStmt가
// 최초 if 조건에 더 이상 kind:"condition"을 push하지 않음).
//
// 오라클 유효 범위(케이스 파일 헤더 주석 참조): 직접 호출(and/or 밖, __obs_direct)은 pine2py의
// `if {cond}:`와 완전히 동형이라 갭이 없어 전 구간 유효하다. and/or 우변 호출(__obs_and/__obs_or)은
// 좌변을 상수로 고정해 pine2py의 Python 네이티브 lazy가 우연히 eager와 동치가 되는 구간만 골든
// 검증한다(DIVERGENCES.md #97, C66/#12와 동일 축). 조건이 실제로 갈리는 갭 시나리오
// (crossover or crossunder — 서로 배타적이라 좌변이 실제로 T/F를 오간다)는 이 파일의 hand-verified
// 트레이스가 별도로 검증한다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";
import { sma, crossover, crossunder } from "../../src/runtime/ta";
import type { SmaState, CrossState } from "../../src/runtime/ta";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_if_condition_ta";
const OBS_KEYS = ["__obs_direct", "__obs_and", "__obs_or"] as const;

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: cond_if_condition_ta (stateful calls directly in an if's primary condition, C246)", () => {
  it("matches golden bar-for-bar on all three channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);

    expect(result.bars).toHaveLength(golden.bars.length);
    for (let i = 0; i < golden.bars.length; i++) {
      for (const key of OBS_KEYS) {
        const expected = decodeSentinel(golden.bars[i]![`var:${key}`]!);
        expect(
          nearlyEqual(result.bars[i]![`var:${key}`]!, expected),
          `bar ${i} ${key}: actual=${result.bars[i]![`var:${key}`]} golden=${expected}`,
        ).toBe(true);
      }
    }
  });

  it("matches golden finalVarState on all three channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    for (const key of OBS_KEYS) {
      expect(result.finalVarState[key]).toBeCloseTo(decodeSentinel(golden.finalVarState[key]!), 9);
    }
  });

  // ── hand-verified: 실제로 갈리는 or 좌우변(DIVERGENCES.md #97 — 오라클 무효 구간) ──

  it("advances the or-rhs crossunder on EVERY bar even on bars where crossover(lhs) is true (eager, hand-verified)", () => {
    // `if ta.crossover(close, b) or ta.crossunder(close, b)`: 서로 배타적이라 crossover가 T인
    // 바에는 pine2py의 Python 네이티브 lazy `or`가 crossunder를 아예 평가하지 않아 그 내부 1바
    // 메모리가 전진하지 않는다(DIVERGENCES.md #97) — pine2js는 C66부터 or 우변을 문장 직전
    // eager 호이스팅하므로 매 바 무조건 둘 다 호출한다. 레퍼런스는 매 바 두 함수 모두 무조건
    // 호출한 트레이스(=pine2js가 내야 할 값).
    const data = loadOracleData(CASE_NAME);
    const result = runPipeline(
      [
        "b = ta.sma(close, 3)",
        "var int __obs = 0",
        "if ta.crossover(close, b) or ta.crossunder(close, b)",
        "    __obs := __obs + 1",
      ].join("\n"),
      data,
    );
    const stS = {} as SmaState;
    const stCo = {} as CrossState;
    const stCu = {} as CrossState;
    let expected = 0;
    for (let i = 0; i < data.close.length; i++) {
      const b = sma(stS, data.close[i]!, 3);
      const co = crossover(stCo, data.close[i]!, b); // 레퍼런스: 매 바 무조건 호출(eager)
      const cu = crossunder(stCu, data.close[i]!, b); // 레퍼런스: 매 바 무조건 호출(eager)
      if (co || cu) expected += 1;
      expect(result.bars[i]!["var:__obs"], `bar ${i}`).toBeCloseTo(expected, 9);
    }
    // 이 케이스는 crossover가 실제로 한 번 이상 T가 되는 데이터라야 갭이 드러난다(그렇지 않으면
    // eager와 lazy가 우연히 동치) — sample10에서 close vs sma(close,3)는 여러 차례 교차하므로
    // 최종 카운트가 0이 아님을 못박아 이 트레이스 자체가 무의미하게 통과하지 않게 한다.
    expect(expected).toBeGreaterThan(0);
  });
});
