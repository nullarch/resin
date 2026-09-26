// oracle/cases/e2e_vwap.pine: TV 빌트인 "Volume Weighted Average Price" 인디케이터 E2E 재현
// (ROADMAP P2 "TV 빌트인 인디케이터 15종 E2E" 세 번째 슬라이스, 3종 중 3). ta.vwap 자체의
// 계산은 tests/oracle/ta_vwap.test.ts가 개별 검증한다 -- 이 테스트가 새로 검증하는 것은
// indicator()/input.source/plot()을 ta.vwap와 한 스크립트로 조합했을 때 (1) __obs 미러 채널이
// ta.vwap의 값인지, (2) 단일 plot() 슬롯이 정확히 배정되는지, (3) plot 채널 값이 같은 바의 __obs
// 미러 값과 정확히 같은지. The pine2py golden is NOT ground truth for the values (it never
// resets): on sample10.json's daily bars every bar starts a session, so the VWAP is the source
// (PyneCore lib/ta.py vwap, `anchor = session.isfirstbar`; tier 1 resin-harness ta_301_vwap).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "e2e_vwap";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: e2e_vwap (TV built-in Volume Weighted Average Price, full script)", () => {
  it("the composed script's vwap is the source (close) on every daily bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.bars).toHaveLength(data.close.length);
    for (let i = 0; i < data.close.length; i++) expect(result.bars[i]!["var:__obs_vwap"]).toBe(data.close[i]);
  });

  it("emits exactly 1 plot titled 'VWAP'", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);

    expect(result.plots.map((p) => p.title)).toEqual(["VWAP"]);
    expect(result.plots[0]!.values).toHaveLength(data.close.length);
  });

  it("plot values equal the __obs_vwap mirror values bar-by-bar", () => {
    const data = loadOracleData(CASE_NAME);
    const source = loadCaseSource(CASE_NAME);

    const result = runPipeline(source, data);
    const values = result.plots[0]!.values;

    for (let i = 0; i < data.close.length; i++) {
      expect(values[i]).toBe(result.bars[i]!["var:__obs_vwap"]);
    }
  });
});
