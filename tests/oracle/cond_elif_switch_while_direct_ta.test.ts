// oracle/cases/cond_elif_switch_while_direct_ta.pine: elif 조건/switch case 값(subject 없음)/
// while 조건 위치의 **직접 호출**(and/or lazy 우변 밖) 신규 허용 (ROADMAP P4, C260 —
// analyzer/ta.ts firstForbiddenKind가 이제 "condition 스코프에 도달하기 전에 lazy-expr을 거쳤는가"
// 만 판정: 안 거쳤으면(직접 호출, and/or 좌변 포함) 허용, 거쳤으면(and/or 우변·삼항 분기) 여전히
// 거부).
//
// 오라클 유효 범위: 이 케이스의 네 채널 전부 and/or **우변**이나 삼항에 콜을 두지 않는다(elif2/
// while은 콜을 and **좌변**에 둔다 — genBinOp가 "and"를 `rt.pineAnd(L, R)` 함수 호출로 내리므로
// JS가 L/R 인자를 항상 둘 다 평가해 좌변 콜은 이 and 표현식이 평가될 때마다 무조건 실행된다,
// codegen.ts genBinOp 참조) — 즉 pine2py의 네이티브 elif/switch-if/while 체인과 갭 없이 완전히
// 동형이라 골든이 전 구간 유효하다(cond_if_condition_ta.pine의 __obs_direct 채널과 동일 원칙,
// and/or **우변** 콜처럼 pine2py Python 네이티브 lazy와 갈리는 hand-verified 축은 이 케이스에
// 해당 없음).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadGolden, loadOracleData, decodeSentinel, nearlyEqual } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "cond_elif_switch_while_direct_ta";
const OBS_KEYS = ["__obs_elif1", "__obs_elif2", "__obs_switch", "__obs_while"] as const;

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: cond_elif_switch_while_direct_ta (direct stateful calls in elif/switch-case/while condition positions, C260)", () => {
  it("matches golden bar-for-bar on all four channels", () => {
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

  it("matches golden finalVarState on all four channels", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    const golden = loadGolden(CASE_NAME);
    for (const key of OBS_KEYS) {
      expect(result.finalVarState[key]).toBeCloseTo(decodeSentinel(golden.finalVarState[key]!), 9);
    }
  });

  it("the while channel advances by exactly 3 every bar after warmup (bounded by the j<3 and-rhs guard)", () => {
    // 채널 4는 j<3(무상태, and 우변) 가드로 매 바 최대 3회 반복하도록 설계됐다 — 단 bar 0의 첫
    // 테스트는 ta.sma(close,2)가 콜사이트 통산 1회째 호출이라 윈도우가 아직 안 찼음(NaN, 워밍업)
    // → `NaN < close+100`이 false라 while이 즉시 종료돼(본문 0회) bar 0만 예외적으로 0이다.
    // bar 1부터는 윈도우가 이미 찼으므로(콜사이트 통산 2회째부터 매 호출이 유효값) 매 바 정확히
    // 3회 — 누적값이 정확히 `3*i`(0-based)로 떨어진다. 이 불변을 명시적으로 못박아 향후 회귀
    // (예: __whileLimit 안전장치가 잘못 트리거되는 변경)를 조기에 잡는다.
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);
    for (let i = 0; i < data.close.length; i++) {
      const expected = 3 * i;
      expect(result.bars[i]!["var:__obs_while"], `bar ${i}`).toBeCloseTo(expected, 9);
    }
  });
});
