// oracle/cases/ta_kc_kcw_optional_truerange.pine: ta.kc/ta.kcw useTrueRange(4번째 인자) 생략형
// 검증(C227, ROADMAP P3 next_hint 1순위 — TA_REGISTRY.kc/kcw에 minArgCount:3 신설, corpus 20+건
// 실측 `ta.kc(source, length, mult)` 관용구). length=3/mult=2.0은 oracle/cases/ta_kc_kcw.pine의
// "T" 변형과 동일 파라미터 — the expected values are the oracle's on sample10 (harness twin
// state/repros/kc-sample10.json: *_t for the explicit form, basis_d/upper_d/kcw_d for the 3-argument
// form). 이 케이스의 핵심 주장은 두 가지: (1) 생략형이 명시형(true)과 바이트 단위로 동일한 값을
// 내는가(콜사이트가 서로 다른 독립 상태인데도), (2) 그 값 자체가 오라클 수치와 일치하는가.

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

// The oracle's ta.kc/ta.kcw(close, 3, 2.0[, true]) on sample10 (twin kc-sample10 *_t, *_d): the
// range ema of ta.tr(false) seeds one bar after the basis.
const EXPECTED: [number, number, number, number][] = [
  [NaN, NaN, NaN, NaN],
  [NaN, NaN, NaN, NaN],
  [102, NaN, NaN, NaN],
  [102, 108, 96, 0.11764705882352941],
  [103, 109, 97, 0.11650485436893204],
  [104, 110, 98, 0.11538461538461539],
  [105, 111, 99, 0.11428571428571428],
  [105, 111, 99, 0.11428571428571428],
  [106, 112, 100, 0.11320754716981132],
  [107, 113, 101, 0.11214953271028037],
];

function assertChannel(
  bars: Record<string, number>[],
  keys: { basis: string; upper: string; lower: string; kcw: string },
): void {
  for (let i = 0; i < EXPECTED.length; i++) {
    const want = EXPECTED[i]!;
    const bar = bars[i]!;
    const got = [bar[keys.basis]!, bar[keys.upper]!, bar[keys.lower]!, bar[keys.kcw]!];
    for (let f = 0; f < 4; f++) {
      if (Number.isNaN(want[f]!)) expect(got[f]).toBeNaN();
      else expect(got[f]).toBeCloseTo(want[f]!, 9);
    }
  }
}

describe("oracle: ta_kc_kcw_optional_truerange", () => {
  it("explicit useTrueRange=true matches the oracle's values", () => {
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

  it("omitted useTrueRange (3-arg call) matches the same oracle values as explicit true", () => {
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
