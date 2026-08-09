// oracle/cases/ta_bare_implicit_calls.pine: 괄호 없는 ta.tr/ta.accdist/ta.wad/ta.wvad/ta.iii/
// ta.obv/ta.pvt/ta.nvi/ta.pvi 9종 검증(C248, ROADMAP P4 corpus 클러스터 "네임스페이스 접근은
// 호출식만 지원" 최다 하위패턴 20/35파일). 산식 자체는 ta_atr_tr/ta_obv_accdist/ta_pvt_wad/
// ta_nvi_pvi/ta_wvad_iii(명시 호출형)가 이미 골든 대조로 검증해뒀다 — 이 테스트는 파서가
// parsePostfix에서 desugar한 괄호 없는 문법이 명시 호출형과 완전히 동일한 값을 내는지만 확인.
// ta.atr과 달리 이 9종은 pine2py 쪽에도 재스캔 워밍업 latent 버그가 없어(runtime/ta.ts 각 함수
// 주석 참조) 전 채널이 바0부터 골든과 바이트 단위로 일치한다(hand-verified 분기 불필요).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_bare_implicit_calls";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_bare_implicit_calls", () => {
  it("matches the pine2py golden bar-by-bar for all 9 bare (no-parens) ta.* implicit calls", () => {
    const golden = loadGolden(CASE_NAME);
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(golden.bars.length);
    compareToGolden(result.bars, golden, [
      "var:__obs_tr",
      "var:__obs_accdist",
      "var:__obs_wad",
      "var:__obs_wvad",
      "var:__obs_iii",
      "var:__obs_obv",
      "var:__obs_pvt",
      "var:__obs_nvi",
      "var:__obs_pvi",
    ]);
  });
});
