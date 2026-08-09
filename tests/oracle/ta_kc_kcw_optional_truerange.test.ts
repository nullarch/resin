// oracle/cases/ta_kc_kcw_optional_truerange.pine: ta.kc/ta.kcw useTrueRange(4번째 인자) 생략형
// 검증(C227, ROADMAP P3 next_hint 1순위 — TA_REGISTRY.kc/kcw에 minArgCount:3 신설, corpus 20+건
// 실측 `ta.kc(source, length, mult)` 관용구). length=3/mult=2.0은 oracle/cases/ta_kc_kcw.pine의
// "T" 변형과 동일 파라미터라 tests/oracle/ta_kc_kcw.test.ts가 이미 확정해둔 hand-verified 배열을
// 그대로 재사용한다(DIVERGENCES.md #9 — useTrueRange=true는 atr 워밍업 off-by-one이 basis까지 새어
// 나가는 의도된 발산이라 golden 직접 비교 대신 hand-verified 값으로 검증, ta_kc_kcw.test.ts와 동일
// 이유). 이 케이스의 핵심 주장은 두 가지: (1) 생략형이 명시형(true)과 바이트 단위로 동일한 값을
// 내는가(콜사이트가 서로 다른 독립 상태인데도), (2) 그 값 자체가 여전히 기존에 검증된 실제 수치와
// 일치하는가(패딩이 우연히 다른 값을 만들어내지 않았는지).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_kc_kcw_optional_truerange";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

// tests/oracle/ta_kc_kcw.test.ts의 useTrueRange=true(length=3,mult=2.0) hand-verified 배열과 동일
// (동일 파라미터/동일 sample10.json 데이터이므로 값도 동일해야 함).
const EXPECTED: [number, number, number, number][] = [
  [NaN, NaN, NaN, NaN],
  [NaN, NaN, NaN, NaN],
  [102, 108, 96, 11.76470588235294],
  [102, 108, 96, 11.76470588235294],
  [103, 109, 97, 11.650485436893204],
  [104, 110, 98, 11.538461538461538],
  [105, 111, 99, 11.428571428571429],
  [105, 111, 99, 11.428571428571429],
  [106, 112, 100, 11.320754716981133],
  [107, 113, 101, 11.214953271028037],
];

function assertChannel(
  bars: Record<string, number>[],
  keys: { basis: string; upper: string; lower: string; kcw: string },
): void {
  for (let i = 0; i < EXPECTED.length; i++) {
    const [basis, upper, lower, kcw] = EXPECTED[i]!;
    const bar = bars[i]!;
    if (Number.isNaN(basis)) {
      expect(bar[keys.basis]).toBeNaN();
      expect(bar[keys.upper]).toBeNaN();
      expect(bar[keys.lower]).toBeNaN();
      expect(bar[keys.kcw]).toBeNaN();
    } else {
      expect(bar[keys.basis]).toBeCloseTo(basis, 9);
      expect(bar[keys.upper]).toBeCloseTo(upper, 9);
      expect(bar[keys.lower]).toBeCloseTo(lower, 9);
      expect(bar[keys.kcw]).toBeCloseTo(kcw, 9);
    }
  }
}

describe("oracle: ta_kc_kcw_optional_truerange", () => {
  it("explicit useTrueRange=true matches the previously hand-verified values", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    assertChannel(result.bars, {
      basis: "var:__obs_basis_explicit",
      upper: "var:__obs_upper_explicit",
      lower: "var:__obs_lower_explicit",
      kcw: "var:__obs_kcw_explicit",
    });
  });

  it("omitted useTrueRange (3-arg call) matches the same hand-verified values as explicit true", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    assertChannel(result.bars, {
      basis: "var:__obs_basis_default",
      upper: "var:__obs_upper_default",
      lower: "var:__obs_lower_default",
      kcw: "var:__obs_kcw_default",
    });
  });

  it("omitted and explicit-true channels are bar-by-bar identical (independent call sites, same resolved default)", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);
    const result = runPipeline(source, data);

    for (const bar of result.bars) {
      for (const field of ["basis", "upper", "lower", "kcw"] as const) {
        const explicit = bar[`var:__obs_${field}_explicit`];
        const dflt = bar[`var:__obs_${field}_default`];
        if (typeof explicit === "number" && Number.isNaN(explicit)) {
          expect(dflt).toBeNaN();
        } else {
          expect(dflt).toBe(explicit);
        }
      }
    }
  });
});
