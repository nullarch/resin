// oracle/cases/ta_atr_tr.pine: ta.tr()/ta.atr(3) 검증(ROADMAP P2 "ta.* 44종" — atr/tr). ta.tr()는
// pine2py wavealgo/ta/atr.py의 tr()과 완전히 동일한 stateless 순수 함수라 골든과 바이트 단위로
// 일치한다. ta.atr(3)은 **의도적으로 골든과 다르다**(DIVERGENCES.md, runtime/ta.ts atr() 주석
// 참조) — pine2py atr.py는 매 호출 length+10폭까지 tr_values를 재스캔하는 독자 구현인데, 이
// 재스캔이 실제 필요한 워밍업(dataLen>=length)보다 한 바 항상 늦게(dataLen>=length+1) 첫 값을
// 낸다는 latent 버그를 golden 자체가 보여준다(바0~2 NaN, 바3부터 3.0 — scratch/probe_atr.mjs로
// 확인). pine2js는 GOAL.md "RSI/ATR는 RMA(Wilder)"를 그대로 따르는 O(1) 스트리밍 합성(rt.ta.tr +
// rt.ta.rma)이라 바2부터 유효값을 낸다 — 그래서 이 테스트는 __obs_tr 채널만 골든과 비교하고
// (compareToGolden onlyKeys), __obs_atr은 손 계산 기대값으로 직접 검증한다(sample10.json은
// high=close+1/low=close-2라 모든 TR=3이므로 SMA/Wilder 산식 자체는 이 데이터로 검증되지 않음 —
// 산식 정확성은 runtime.test.ts의 hand-computed/브루트포스 테스트가 별도로 커버).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_atr_tr";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_atr_tr", () => {
  it("matches the pine2py golden bar-by-bar for ta.tr (fully stateless, no divergence)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, ["var:__obs_tr"]);
  });

  it("ta.atr diverges from the golden by exactly one bar of warmup (documented divergence, hand-verified instead of golden-compared)", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    // golden: NaN at bar0-2, 3.0 from bar3 (pine2py's off-by-one re-scan requirement).
    expect(golden.bars[0]!["var:__obs_atr"]).toBe("NaN");
    expect(golden.bars[1]!["var:__obs_atr"]).toBe("NaN");
    expect(golden.bars[2]!["var:__obs_atr"]).toBe("NaN");
    expect(golden.bars[3]!["var:__obs_atr"]).toBe(3.0);

    // pine2js: NaN only at bar0-1, valid (3.0) from bar2 (RMA(TR,3) streaming composition).
    expect(result.bars[0]!["var:__obs_atr"]).toBeNaN();
    expect(result.bars[1]!["var:__obs_atr"]).toBeNaN();
    for (let i = 2; i < result.bars.length; i++) {
      expect(result.bars[i]!["var:__obs_atr"]).toBeCloseTo(3.0, 9);
    }
  });

  // C291: ta.tr(handle_na) — TV 공식 시그니처의 선택 인자. pine2py tr()엔 이 파라미터 자체가 없어
  // (OHLCV_INJECT["ta.tr"]가 user_arg_count>0이면 injection을 스킵, tr()이 인자 부족으로 그대로
  // 크래시) 오라클 골든이 존재할 수 없다 — 이 .pine 케이스 파일/골든은 건드리지 않고 별도 인라인
  // 소스로 hand-verified만 수행한다("TV 미검증(가설)", 이 세션 웹 접근 없음).
  it("hand-verified (no oracle possible): handle_na=false returns NaN on bar0, handle_na=true keeps the hl fallback (both agree from bar1 on)", () => {
    const source = [
      "var float __obs_tr_true = na",
      "var float __obs_tr_false = na",
      "__obs_tr_true := ta.tr(true)",
      "__obs_tr_false := ta.tr(false)",
    ].join("\n");
    const data = {
      open: [10, 14, 20],
      high: [10, 14, 20],
      low: [8, 9, 15],
      close: [9, 10, 18],
      volume: [1, 1, 1],
    };

    const result = runPipeline(source, data);

    // bar0: hl=10-8=2, prevClose 없음(NaN) -> handle_na=true는 2로 폴백, false는 NaN.
    expect(result.bars[0]!["var:__obs_tr_true"]).toBeCloseTo(2, 9);
    expect(result.bars[0]!["var:__obs_tr_false"]).toBeNaN();
    // bar1: prevClose=9(유한) -> hl=5, |14-9|=5, |9-9|=0 -> max=5, 두 채널 동일.
    expect(result.bars[1]!["var:__obs_tr_true"]).toBeCloseTo(5, 9);
    expect(result.bars[1]!["var:__obs_tr_false"]).toBeCloseTo(5, 9);
    // bar2: prevClose=10 -> hl=5, |20-10|=10, |15-10|=5 -> max=10, 두 채널 동일.
    expect(result.bars[2]!["var:__obs_tr_true"]).toBeCloseTo(10, 9);
    expect(result.bars[2]!["var:__obs_tr_false"]).toBeCloseTo(10, 9);
  });
});
