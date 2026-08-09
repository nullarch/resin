// oracle/cases/ta_stdev_variance.pine: ta.stdev(close, 3)/ta.variance(close, 3) 검증(ROADMAP P2
// "ta.* 44종" — stdev/variance). pine2py wavealgo/ta/stdev.py 소스 대조 결과 population
// variance/stdev로 완전히 동일한 로직(가중치 없는 단순 윈도우, stdev만 sqrt 추가). 워밍업(바 0~1,
// data_len<3 -> NaN)과 정상 구간(바 2~9)을 모두 커버.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_stdev_variance";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_stdev_variance", () => {
  it("matches the pine2py golden bar-by-bar for ta.stdev/ta.variance", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden);
  });

  it("matches the pine2py golden final var state", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    for (const [key, expected] of Object.entries(golden.finalVarState)) {
      expect(result.finalVarState[key]).toBeCloseTo(expected as number, 6);
    }
  });

  // C296: ta.stdev/ta.variance의 3번째 위치 인자 biased(bool, 기본 true) — TV 공식 시그니처지만
  // pine2py wavealgo/ta/stdev.py의 variance(source, length, **kwargs)가 2-positional 고정이라
  // 3번째 위치 인자를 주면 pine2py 자신도 TypeError, 오라클 골든이 원천적으로 존재할 수 없다
  // (DIVERGENCES #110, "TV 미검증(가설)"). 이 .pine 케이스 파일/골든은 건드리지 않고 별도 인라인
  // 소스로 hand-verified만 수행한다(C291 ta.tr(handle_na) 선례와 동일 패턴).
  it("hand-verified (no oracle possible): biased=false applies Bessel's correction, biased=true(default) matches the existing 2-arg population formula", () => {
    const source = [
      "var float __obs_stdev_biased = na",
      "var float __obs_stdev_unbiased = na",
      "var float __obs_variance_biased = na",
      "__obs_stdev_biased := ta.stdev(close, 2, true)",
      "__obs_stdev_unbiased := ta.stdev(close, 2, false)",
      "__obs_variance_biased := ta.variance(close, 2)", // ta.variance stays 2-arg only (no wild evidence for a 3rd positional, C296) — sanity-checks the existing default-true path is untouched.
    ].join("\n");
    const data = { open: [10, 12, 14, 20], high: [10, 12, 14, 20], low: [10, 12, 14, 20], close: [10, 12, 14, 20], volume: [1, 1, 1, 1] };

    const result = runPipeline(source, data);

    // bar0: warmup, NaN.
    expect(result.bars[0]!["var:__obs_stdev_biased"]).toBeNaN();
    expect(result.bars[0]!["var:__obs_stdev_unbiased"]).toBeNaN();
    // bar1: window=[10,12], mean=11, population variance=1 -> biased stdev=1, unbiased variance=1*2/(2-1)=2 -> stdev=sqrt(2).
    expect(result.bars[1]!["var:__obs_stdev_biased"]).toBeCloseTo(1, 9);
    expect(result.bars[1]!["var:__obs_stdev_unbiased"]).toBeCloseTo(Math.sqrt(2), 9);
    expect(result.bars[1]!["var:__obs_variance_biased"]).toBeCloseTo(1, 9);
    // bar2: window=[12,14], mean=13, population variance=1 -> biased stdev=1, unbiased stdev=sqrt(2).
    expect(result.bars[2]!["var:__obs_stdev_biased"]).toBeCloseTo(1, 9);
    expect(result.bars[2]!["var:__obs_stdev_unbiased"]).toBeCloseTo(Math.sqrt(2), 9);
    // bar3: window=[14,20], mean=17, population variance=((14-17)^2+(20-17)^2)/2=9 -> biased stdev=3,
    // unbiased variance=9*2/(2-1)=18 -> stdev=sqrt(18).
    expect(result.bars[3]!["var:__obs_stdev_biased"]).toBeCloseTo(3, 9);
    expect(result.bars[3]!["var:__obs_stdev_unbiased"]).toBeCloseTo(Math.sqrt(18), 9);
  });
});
