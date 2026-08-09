// oracle/cases/ta_pvt_wad.pine: ta.pvt()/ta.wad() 검증(ROADMAP P2 "ta.* 44종" — pvt/wad). 둘 다
// 인자 없음(close/volume 또는 high/low/close 암묵 사용), sample10.json 전 구간 관측. obv/accdist와
// 동일하게 워밍업 NaN 구간이 없어(runtime/ta.ts pvt()/wad() 주석 참조) 바0부터 즉시 유효한 값을 낸다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runPipeline } from "../helpers/pipeline";
import { compareToGolden, loadGolden, loadOracleData } from "../helpers/golden";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CASE_NAME = "ta_pvt_wad";

function loadCaseSource(name: string): string {
  return readFileSync(join(ROOT, "oracle", "cases", `${name}.pine`), "utf-8");
}

describe("oracle: ta_pvt_wad", () => {
  it("matches the pine2py golden bar-by-bar for ta.pvt/ta.wad", () => {
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
});
